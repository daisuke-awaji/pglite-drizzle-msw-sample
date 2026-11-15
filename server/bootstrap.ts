import { Client } from 'pg'
import { type SslMode } from './config'
import { sslOptions } from './db'
import { consoleLogger } from './log'
import { cachedSecret, type DbSecret } from './secrets'

// DB の利用者を作る（環境ごとに 1 回。何度流しても同じ結果になる）。db-bootstrap 関数（Lambda 関数）のハンドラー。
// 管理者の秘密情報を読めるのは、この関数だけにする（docs/production.md「初回の構築」の 5）。
// - migrator: マイグレーションを流す（表を作る・変える）。app の権限は default privileges で付く
// - app: API が使う。読み書きだけで、DDL・TRUNCATE はできない
// - readonly: 調べ物用（CloudShell の VPC 環境から）。読むだけ
// 利用者がもうあれば、パスワードは変えない（ローテーションで変わったものを戻さない）

export type Users = { migrator: string; app: string; readonly?: string }
export type BootstrapInput = {
  database: string
  users: Users
  /** 新しく作るときだけ使うパスワード */
  passwords: Record<keyof Users, string | undefined>
}

export type BootstrapResult = { ok: true; created: string[]; existing: string[] }

/** 管理者でつないだ client に流す */
export async function bootstrapDatabase(client: Client, input: BootstrapInput): Promise<BootstrapResult> {
  const id = (name: string) => client.escapeIdentifier(name)
  const lit = (value: string) => client.escapeLiteral(value)
  const { migrator, app, readonly } = input.users
  const db = id(input.database)
  const created: string[] = []
  const existing: string[] = []

  for (const [key, name] of Object.entries(input.users) as [keyof Users, string | undefined][]) {
    if (!name) continue
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])
    if (rowCount) {
      existing.push(name)
      continue
    }
    const password = input.passwords[key]
    if (!password) throw new Error(`${name} のパスワードがありません`)
    await client.query(`CREATE ROLE ${id(name)} LOGIN PASSWORD ${lit(password)}`)
    created.push(name)
  }

  const statements = [
    `GRANT CONNECT ON DATABASE ${db} TO ${id(migrator)}, ${id(app)}`,
    // Drizzle は毎回 CREATE SCHEMA IF NOT EXISTS "drizzle" を流すので、スキーマがあっても要る
    `GRANT CREATE ON DATABASE ${db} TO ${id(migrator)}`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${id(migrator)}`,
    `GRANT USAGE ON SCHEMA public TO ${id(app)}`,
    // migrator が作る表・連番に、app が読み書きできるようにする（DDL はできない）
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${id(migrator)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${id(app)}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${id(migrator)} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${id(app)}`,
    // すでにある表にも付ける（default privileges より前に作られた表があっても同じ状態にする）
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${id(app)}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${id(app)}`,
    // リクエスト（30 秒）より先に SQL を止め、後片付けされなかった接続を消す（API は接続ごとにも同じ値を付ける）
    `ALTER ROLE ${id(app)} SET statement_timeout = '20s'`,
    `ALTER ROLE ${id(app)} SET idle_in_transaction_session_timeout = '30s'`,
    `ALTER ROLE ${id(app)} SET idle_session_timeout = '15min'`,
  ]
  if (readonly) {
    statements.push(
      `GRANT CONNECT ON DATABASE ${db} TO ${id(readonly)}`,
      `GRANT pg_read_all_data TO ${id(readonly)}`,
      `ALTER ROLE ${id(readonly)} SET default_transaction_read_only = on`,
      `ALTER ROLE ${id(readonly)} SET statement_timeout = '60s'`,
    )
  }
  for (const sql of statements) await client.query(sql)
  return { ok: true, created, existing }
}

type Env = Readonly<Record<string, string | undefined>>

async function read(arn: string | undefined): Promise<DbSecret | undefined> {
  return arn ? cachedSecret(arn, { ttlMs: 0 }).get() : undefined
}

export async function bootstrapFromEnv(env: Env): Promise<BootstrapResult> {
  const admin = await read(env.ADMIN_SECRET_ARN)
  const [migrator, app, readonly] = await Promise.all([read(env.MIGRATOR_SECRET_ARN), read(env.APP_SECRET_ARN), read(env.READONLY_SECRET_ARN)])
  if (!admin || !migrator || !app) throw new Error('ADMIN_SECRET_ARN・MIGRATOR_SECRET_ARN・APP_SECRET_ARN が要ります')
  const database = env.DB_NAME || app.dbname
  const client = new Client({
    host: admin.host,
    port: admin.port,
    user: admin.username,
    password: admin.password,
    database,
    application_name: 'db-bootstrap',
    ssl: sslOptions((env.DB_SSL ?? 'verify-full') as SslMode),
  })
  await client.connect()
  try {
    const result = await bootstrapDatabase(client, {
      database,
      users: { migrator: migrator.username, app: app.username, readonly: readonly?.username },
      passwords: { migrator: migrator.password, app: app.password, readonly: readonly?.password },
    })
    consoleLogger.info({ type: 'db-bootstrap', ...result })
    return result
  } finally {
    await client.end()
  }
}

/** Lambda 関数のハンドラー */
export const handler = async () => bootstrapFromEnv(process.env)
