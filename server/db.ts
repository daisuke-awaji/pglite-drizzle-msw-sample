import { readFileSync } from 'node:fs'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Client, Pool, type ClientConfig, type PoolConfig } from 'pg'
import * as schema from '../src/db/schema'
import type { Db } from '../src/server/core'
import type { ServerConfig } from './config'
import { describeError, type Logger } from './log'
import { cachedSecret, readFromSecretsManager, type SecretSource } from './secrets'

// API の DB 接続。docs/production.md「サーバーで気をつけること」の決まりをここで守る。
// - 最初のリクエストでつなぐ（listen の前に DB を待つと、10 秒の起動の決まりと Aurora の一時停止が重なって起動に失敗する）
// - 同時に来た最初のリクエストが何本あっても準備は 1 回。失敗したら次のリクエストでやり直す
// - 認証に失敗したら（28P01、ローテーションのあと）秘密情報を読み直し、プールを作り直す
// - 待機中の接続が切れても（フェイルオーバー）プロセスを落とさない

export type DbProvider = {
  /** src/server に渡す Drizzle。respond は Promise<Db> を受け取れるので、待たずに渡してよい */
  get(): Promise<Db>
  /** /api/readyz 用。DB に SELECT 1 を送る */
  ping(): Promise<void>
  /** SIGTERM のとき。プールを閉じる */
  close(): Promise<void>
}

type PoolOptions = ServerConfig['db'] & {
  applicationName: string
  /** 接続ごとに付ける設定（statement_timeout など）。DB の利用者の設定（ALTER ROLE）と同じ値を、ローテーションの複製の利用者にも効かせる */
  sessionSettings: Record<string, string>
  log: Logger
  secretSource?: SecretSource
}

/** API（app 利用者）の接続ごとの設定。リクエスト（30 秒）より先に SQL を止め、放置された接続を消す */
export const API_SESSION_SETTINGS = {
  statement_timeout: '20s',
  idle_in_transaction_session_timeout: '30s',
  idle_session_timeout: '15min',
  TimeZone: 'UTC',
}

let rdsCa: string | undefined
/** RDS の CA（server/certs/rds-global-bundle.pem。ビルドで zip の certs/ に入る） */
export function rdsCaBundle(): string {
  rdsCa ??= readFileSync(new URL('./certs/rds-global-bundle.pem', import.meta.url), 'utf8')
  return rdsCa
}

export function sslOptions(mode: 'verify-full' | 'disable'): ClientConfig['ssl'] {
  // verify-full: 証明書の発行元（RDS の CA）とホスト名を確かめる。ホスト名は host から自動で確かめられる
  return mode === 'verify-full' ? { ca: rdsCaBundle(), rejectUnauthorized: true } : false
}

const toOptions = (settings: Record<string, string>) =>
  Object.entries(settings)
    .map(([k, v]) => `-c ${k}=${v.replace(/\s/g, '\\ ')}`)
    .join(' ')

export const errorCode = (e: unknown): string | undefined => {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | null
  const code = err?.code ?? err?.cause?.code
  return typeof code === 'string' ? code : undefined
}

/** 接続の失敗を知らせる Client。pg-pool は connect(callback) で呼ぶので、両方の形を受ける */
function clientWithConnectHook(onConnectError: (e: unknown) => void) {
  class HookedClient extends Client {
    override connect(): Promise<Client>
    override connect(callback: (err: Error) => void): void
    override connect(callback?: (err: Error) => void): Promise<Client> | void {
      if (!callback) {
        return super.connect().catch((e: unknown) => {
          onConnectError(e)
          throw e
        })
      }
      super.connect((err: Error) => {
        if (err) onConnectError(err)
        callback(err)
      })
    }
  }
  return HookedClient
}

/** プールの設定を作る（秘密情報を読むのはここだけ） */
export async function poolConfig(options: PoolOptions, onConnectError: (e: unknown) => void, secret?: ReturnType<typeof cachedSecret>): Promise<PoolConfig> {
  const common: PoolConfig = {
    max: options.poolMax,
    connectionTimeoutMillis: options.connectTimeoutMs,
    idleTimeoutMillis: options.idleTimeoutMs,
    application_name: options.applicationName,
    options: toOptions(options.sessionSettings),
    ssl: sslOptions(options.ssl),
    Client: clientWithConnectHook(onConnectError) as unknown as PoolConfig['Client'],
  }
  if (options.kind === 'url') return { ...common, connectionString: options.url }
  const s = await secret!.get()
  return { ...common, host: s.host, port: s.port, user: s.username, password: s.password, database: s.dbname }
}

export function createDbProvider(options: PoolOptions): DbProvider {
  const { log } = options
  const secret = options.kind === 'secret' ? cachedSecret(options.secretArn, { source: options.secretSource ?? readFromSecretsManager }) : undefined
  let current: Promise<{ pool: Pool; db: Db }> | undefined
  let currentPool: Pool | undefined

  // プールを捨てる（使用中の接続は返されたときに閉じる）。次の get() で作り直す
  function retire(pool: Pool, reason: string) {
    if (currentPool !== pool) return
    current = undefined
    currentPool = undefined
    log.warn({ type: 'db.pool-retired', reason })
    pool.end().catch(() => {})
  }

  function build() {
    const attempt = (async () => {
      let pool: Pool | undefined
      const onConnectError = (e: unknown) => {
        const code = errorCode(e)
        log.warn({ type: 'db.connect-failed', code, message: (e as Error | null)?.message })
        // 28P01: パスワードが違う。ローテーションで変わったので、読み直して作り直す
        if (code === '28P01') {
          secret?.invalidate()
          if (pool) retire(pool, 'auth-failed')
        }
      }
      pool = new Pool(await poolConfig(options, onConnectError, secret))
      currentPool = pool
      // 待機中の接続が DB 側から切られたとき（フェイルオーバー・idle_session_timeout）。付けないとプロセスが落ちる
      pool.on('error', (e) => log.warn({ type: 'db.idle-client-error', ...describeError(e), stack: undefined }))
      return { pool, db: drizzle(pool, { schema }) as unknown as Db }
    })()
    // 準備（秘密情報の読み取りなど）に失敗したら、次のリクエストでやり直す
    attempt.catch((e: unknown) => {
      if (current === attempt) current = undefined
      log.error({ type: 'db.setup-failed', ...describeError(e) })
    })
    return attempt
  }

  return {
    async get() {
      current ??= build()
      return (await current).db
    },
    async ping() {
      current ??= build()
      const { pool } = await current
      await pool.query('SELECT 1')
    },
    async close() {
      const c = current
      current = undefined
      currentPool = undefined
      if (c) await (await c.catch(() => undefined))?.pool.end()
    },
  }
}
