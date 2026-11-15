import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { projects } from '../src/db/schema'
import { API_SESSION_SETTINGS, createDbProvider, type DbProvider } from './db'
import { memoryLogger } from './log'
import { runMigrations } from './migrate'
import { adminQuery, connect, freshDatabase } from './testing/pg'

// API の接続プールを本物の PostgreSQL で確かめる（docs/production.md「サーバーで気をつけること」）

let db: Awaited<ReturnType<typeof freshDatabase>>
let active: DbProvider | undefined
beforeEach(async () => {
  db = await freshDatabase()
  await runMigrations({ connect: () => connect(db.url), migrationsFolder: './drizzle', deadline: Date.now() + 60_000 })
})
afterEach(async () => {
  await active?.close()
  active = undefined
  await db.drop()
})

const appName = () => `api-${Math.random().toString(36).slice(2, 8)}`

function urlProvider(over: { poolMax?: number; applicationName?: string } = {}) {
  const { logger, lines } = memoryLogger()
  active = createDbProvider({
    kind: 'url',
    url: db.url,
    ssl: 'disable',
    poolMax: over.poolMax ?? 5,
    connectTimeoutMs: 5000,
    idleTimeoutMs: 30_000,
    applicationName: over.applicationName ?? appName(),
    sessionSettings: API_SESSION_SETTINGS,
    log: logger,
  })
  return { provider: active, lines }
}

const connections = async (applicationName: string) =>
  (await adminQuery('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1', [applicationName])).rows[0].n as number

describe('接続プール', () => {
  test('同時に何本来ても、上限を超えて接続しない', async () => {
    const name = appName()
    const { provider } = urlProvider({ poolMax: 4, applicationName: name })
    let peak = 0
    const watcher = setInterval(() => void connections(name).then((n) => (peak = Math.max(peak, n))), 20)
    await Promise.all(Array.from({ length: 40 }, async () => (await provider.get()).execute(sql`select pg_sleep(0.02)`)))
    clearInterval(watcher)
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThanOrEqual(4)
  })

  test('接続ごとに statement_timeout などを付ける（ローテーションの複製の利用者にも効かせる）', async () => {
    const { provider } = urlProvider()
    const d = await provider.get()
    const show = async (name: string) => ((await d.execute(sql.raw(`show ${name}`))) as unknown as { rows: Record<string, string>[] }).rows[0]![name]
    expect(await show('statement_timeout')).toBe('20s')
    expect(await show('idle_in_transaction_session_timeout')).toBe('30s')
    expect(await show('idle_session_timeout')).toBe('15min')
    expect(await show('TimeZone')).toBe('UTC')
  })

  test('DB 側から待機中の接続を全部切っても（フェイルオーバーの代わり）、プロセスは落ちず次のリクエストは通る', async () => {
    const name = appName()
    const { provider, lines } = urlProvider({ applicationName: name })
    const d = await provider.get()
    await Promise.all(Array.from({ length: 5 }, () => d.select().from(projects)))
    await adminQuery('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [name])
    await vi.waitFor(() => expect(lines.some((l) => l.type === 'db.idle-client-error')).toBe(true))
    await expect(d.select().from(projects)).resolves.toEqual([])
  })
})

async function secretProvider(source: (arn: string) => Promise<string>) {
  const { logger, lines } = memoryLogger()
  active = createDbProvider({
    kind: 'secret',
    secretArn: 'arn:aws:secretsmanager:ap-northeast-1:111122223333:secret:app',
    ssl: 'disable',
    poolMax: 3,
    connectTimeoutMs: 5000,
    idleTimeoutMs: 30_000,
    applicationName: appName(),
    sessionSettings: API_SESSION_SETTINGS,
    log: logger,
    secretSource: source,
  })
  return { provider: active, lines }
}

const secretFor = (user: string, password: string) => {
  const u = new URL(db.url)
  return JSON.stringify({ username: user, password, host: u.hostname, port: Number(u.port), dbname: db.name })
}

describe('秘密情報から作る接続', () => {
  test('最初のリクエストが同時に 20 本来ても、秘密情報を読むのは 1 回', async () => {
    const r = await db.role('app')
    await adminQuery(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${r.user}"`, [], db.name)
    const source = vi.fn(async () => secretFor(r.user, r.password))
    const { provider } = await secretProvider(source)
    await Promise.all(Array.from({ length: 20 }, async () => (await provider.get()).select().from(projects)))
    expect(source).toHaveBeenCalledTimes(1)
  })

  test('秘密情報を読めなかったら、次のリクエストでやり直す', async () => {
    const r = await db.role('app')
    const source = vi.fn<(arn: string) => Promise<string>>().mockRejectedValueOnce(new Error('AccessDenied')).mockResolvedValue(secretFor(r.user, r.password))
    const { provider, lines } = await secretProvider(source)
    await expect(provider.get()).rejects.toThrow('AccessDenied')
    expect(lines.find((l) => l.type === 'db.setup-failed')).toMatchObject({ level: 'error' })
    await expect(provider.ping()).resolves.toBeUndefined()
  })

  test('ローテーションでパスワードが変わったら、失敗した次のリクエストから新しいパスワードでつなぐ', async () => {
    const r = await db.role('app', 'old-password')
    let current = 'old-password'
    const source = vi.fn(async () => secretFor(r.user, current))
    const { provider, lines } = await secretProvider(source)
    await provider.ping()

    // ローテーション: DB のパスワードと秘密情報が新しくなり、古い接続は（フェイルオーバーなどで）切れた
    await adminQuery(`ALTER ROLE "${r.user}" PASSWORD 'new-password'`)
    current = 'new-password'
    await adminQuery('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1', [r.user])

    // 使い回していた古いパスワードで失敗する 1 本は 500 になる
    await expect(provider.ping()).rejects.toMatchObject({ code: '28P01' })
    expect(lines.find((l) => l.type === 'db.pool-retired')).toMatchObject({ reason: 'auth-failed' })
    // 次からは読み直したパスワードで通る
    await expect(provider.ping()).resolves.toBeUndefined()
    expect(source).toHaveBeenCalledTimes(2)
  })
})
