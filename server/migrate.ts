import { fileURLToPath, pathToFileURL } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Client } from 'pg'
import { type SslMode } from './config'
import { sslOptions } from './db'
import { consoleLogger } from './log'
import { pendingTags, readJournal, withMigrationLock, type RunOptions } from './migrations'
import { runPreSql } from './pre-sql'
import { cachedSecret } from './secrets'

// マイグレーションの実行役（Lambda 関数のハンドラー。ローカルと Fargate の RunTask では CLI として動かす）。
// アプリの起動時には流さない（実行環境が同時にいくつも起動すると同時に流れる）。デプロイの手順から 1 回だけ同期で呼ぶ。
// docs/production.md「流し方（実行役）」

export type MigrateResult = { ok: true; applied: string[]; attempts: number; durationMs: number }

export async function runMigrations(options: RunOptions): Promise<MigrateResult> {
  const started = Date.now()
  const journal = readJournal(options.migrationsFolder)
  const { result, attempts } = await withMigrationLock(options, async (client) => {
    const pending = await pendingTags(client, journal)
    // 未適用のものを 1 つのトランザクションで流す（Drizzle の性質。2 本目が失敗すると 1 本目も戻る）
    await migrate(drizzle(client), { migrationsFolder: options.migrationsFolder })
    return pending
  })
  options.log?.({ type: 'migrate.done', applied: result, attempts, durationMs: Date.now() - started })
  return { ok: true, applied: result, attempts, durationMs: Date.now() - started }
}

type Env = Readonly<Record<string, string | undefined>>

/** migrator の接続。MIGRATOR_DATABASE_URL（ローカル）か MIGRATOR_SECRET_ARN（AWS）から作る。host を渡すと、そのクラスターにつなぐ（復元の練習） */
export function migratorConnector(env: Env, { host }: { host?: string } = {}): () => Promise<Client> {
  const ssl = (env.DB_SSL ?? (env.MIGRATOR_DATABASE_URL ? 'disable' : 'verify-full')) as SslMode
  const common = { application_name: 'migrate', connectionTimeoutMillis: 30_000, ssl: sslOptions(ssl) }
  if (env.MIGRATOR_DATABASE_URL) {
    const url = env.MIGRATOR_DATABASE_URL
    return async () => {
      const client = new Client({ ...common, connectionString: url })
      await client.connect()
      return client
    }
  }
  if (!env.MIGRATOR_SECRET_ARN) throw new Error('MIGRATOR_DATABASE_URL か MIGRATOR_SECRET_ARN が要ります')
  const secret = cachedSecret(env.MIGRATOR_SECRET_ARN, { ttlMs: 0 })
  return async () => {
    const s = await secret.get()
    const client = new Client({ ...common, host: host ?? s.host, port: s.port, user: s.username, password: s.password, database: s.dbname })
    await client.connect()
    return client
  }
}

/** zip の中の drizzle/（バンドルと同じフォルダー）。MIGRATIONS_FOLDER で差し替えられる */
export const defaultMigrationsFolder = (env: Env) => env.MIGRATIONS_FOLDER ?? fileURLToPath(new URL('./drizzle', import.meta.url))

export type MigrateEvent = {
  mode?: 'migrate' | 'pre' | 'status' | 'verify'
  /** verify だけ: 確かめるクラスターの endpoint（復元の練習で作ったクラスター。infra/scripts/ops/restore-drill.ts） */
  host?: string
}

/** 復元したクラスターが使えるか（読むだけ）: 未適用のマイグレーションと、主な表の行数 */
export async function verifyDatabase(connect: () => Promise<Client>, migrationsFolder: string) {
  const client = await connect()
  try {
    await client.query('SET default_transaction_read_only = on')
    const pending = await pendingTags(client, readJournal(migrationsFolder))
    const counts: Record<string, number> = {}
    for (const table of ['members', 'projects', 'tasks', 'comments']) {
      const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${client.escapeIdentifier(table)}`)
      counts[table] = rows[0]!.n
    }
    const { rows } = await client.query<{ latest: string | null }>('SELECT max(updated_at)::text AS latest FROM tasks')
    return { ok: true as const, pending, counts, latestTaskUpdate: rows[0]?.latest ?? null }
  } finally {
    await client.end()
  }
}
type LambdaContext = { getRemainingTimeInMillis(): number }

const log = (fields: Record<string, unknown>) => consoleLogger.info({ type: 'migrate', ...fields })

export async function runMode(mode: MigrateEvent['mode'], env: Env, deadline: number, event: MigrateEvent = {}) {
  if (mode === 'verify') {
    if (!event.host) throw new Error('verify には host（確かめるクラスターの endpoint）が要ります')
    return verifyDatabase(migratorConnector(env, { host: event.host }), defaultMigrationsFolder(env))
  }
  const options: RunOptions = {
    connect: migratorConnector(env),
    migrationsFolder: defaultMigrationsFolder(env),
    deadline,
    role: env.MIGRATOR_ROLE || undefined,
    // Fargate の RunTask（15 分を超えるもの）では、1 文の上限を延ばす（例: MIGRATE_STATEMENT_TIMEOUT=2h）
    ...(env.MIGRATE_STATEMENT_TIMEOUT ? { statementTimeout: env.MIGRATE_STATEMENT_TIMEOUT, statementBudgetMs: 0 } : {}),
    log,
  }
  if (mode === 'pre') return runPreSql(options)
  if (mode === 'status') {
    // 何が未適用かだけを返す（変更しない）
    const client = await options.connect()
    try {
      return { ok: true as const, pending: await pendingTags(client, readJournal(options.migrationsFolder)) }
    } finally {
      await client.end()
    }
  }
  return runMigrations(options)
}

/** Lambda 関数のハンドラー。失敗は例外にして返す（呼び出し側は FunctionError で分かる） */
export const handler = async (event: MigrateEvent = {}, context?: LambdaContext) =>
  runMode(event.mode ?? 'migrate', process.env, Date.now() + (context?.getRemainingTimeInMillis() ?? 15 * 60_000), event)

// CLI: node migrate/index.mjs [migrate|pre|status]（ローカルと、15 分を超えるときの Fargate の RunTask）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = (process.argv[2] ?? 'migrate') as MigrateEvent['mode']
  runMode(mode, process.env, Date.now() + Number(process.env.MIGRATE_DEADLINE_MS ?? 6 * 60 * 60_000)).then(
    (r) => process.stdout.write(`${JSON.stringify(r)}\n`),
    (e: unknown) => {
      console.error(e)
      process.exitCode = 1
    },
  )
}
