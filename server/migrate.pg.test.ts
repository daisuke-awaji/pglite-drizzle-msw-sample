import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runMigrations } from './migrate'
import { LOCK_ID, type RunOptions } from './migrations'
import { runPreSql } from './pre-sql'
import { adminQuery, connect, freshDatabase, migrationsWith } from './testing/pg'

// マイグレーションの実行役を本物の PostgreSQL で確かめる（docs/production.md「流し方（実行役）」の表のとおりか）

let db: Awaited<ReturnType<typeof freshDatabase>>
const cleanups: (() => void)[] = []
beforeEach(async () => {
  db = await freshDatabase()
})
afterEach(async () => {
  await db.drop()
  while (cleanups.length) cleanups.pop()!()
})

const options = (over: Partial<RunOptions> = {}): RunOptions => ({
  connect: () => connect(db.url),
  migrationsFolder: './drizzle',
  deadline: Date.now() + 15 * 60_000,
  retryDelayMs: 200,
  ...over,
})

const folder = (extra: Parameters<typeof migrationsWith>[0]) => {
  const m = migrationsWith(extra)
  cleanups.push(m.cleanup)
  return m.dir
}

const columns = async (table: string) =>
  (await adminQuery(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table], db.name)).rows.map((r) => r.column_name as string)

describe('流す', () => {
  test('空の DB に流し、2 回目は何もしない（何度呼んでも同じ）', async () => {
    const first = await runMigrations(options())
    expect(first).toMatchObject({ ok: true, applied: ['0000_init'], attempts: 1 })
    expect(await columns('tasks')).toContain('due_date')
    expect(await runMigrations(options())).toMatchObject({ ok: true, applied: [] })
  })

  test('同時に 2 つ流しても、片方が待つので壊れない（Drizzle だけだと duplicate key で失敗する）', async () => {
    const [a, b] = await Promise.all([runMigrations(options()), runMigrations(options())])
    expect([...a.applied, ...b.applied]).toEqual(['0000_init'])
    const { rows } = await adminQuery('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations', [], db.name)
    expect(rows[0].n).toBe(1)
  })
})

async function holdTasksLock() {
  // 長い読み取りのトランザクション（集計や閉じ忘れ）が tasks を読んでいる状態
  const holder = await connect(db.url)
  await holder.query('BEGIN')
  await holder.query('SELECT count(*) FROM tasks')
  return holder
}

describe('ロックの待ち（lock_timeout）', () => {
  const addColumn = [{ tag: '0001_add_estimate', sql: 'ALTER TABLE "tasks" ADD COLUMN "estimate" integer;' }]

  test('待たされたら、全部戻してやり直し、ロックが外れたあとに通る', async () => {
    await runMigrations(options())
    const holder = await holdTasksLock()
    setTimeout(() => void holder.query('COMMIT').then(() => holder.end()), 1200)
    const logs: Record<string, unknown>[] = []
    const result = await runMigrations(options({ migrationsFolder: folder(addColumn), lockTimeout: '300ms', log: (f) => logs.push(f) }))
    expect(result.applied).toEqual(['0001_add_estimate'])
    expect(result.attempts).toBeGreaterThan(1)
    expect(logs.filter((l) => l.type === 'migrate.attempt-failed').every((l) => l.code === '55P03' && l.retry === true)).toBe(true)
    expect(await columns('tasks')).toContain('estimate')
  })

  test('待っている間も、ほかの SELECT は止まらない（ALTER が 300ms であきらめる）', async () => {
    await runMigrations(options())
    const holder = await holdTasksLock()
    const run = runMigrations(options({ migrationsFolder: folder(addColumn), lockTimeout: '300ms', maxAttempts: 1 })).catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 50))
    const reader = await connect(db.url)
    const started = Date.now()
    await reader.query(`SET statement_timeout = '3s'`)
    await reader.query('SELECT count(*) FROM tasks')
    expect(Date.now() - started).toBeLessThan(1000)
    await reader.end()
    expect(await run).toMatchObject({ cause: { code: '55P03' } })
    await holder.query('ROLLBACK')
    await holder.end()
  })

  test('残り時間が足りなければやり直さずに失敗し、何も変わらない', async () => {
    await runMigrations(options())
    const holder = await holdTasksLock()
    // 締め切りまで 1 分。1 文に見込む 11 分が残っていないので、やり直さない
    const error = await runMigrations(options({ migrationsFolder: folder(addColumn), lockTimeout: '300ms', deadline: Date.now() + 60_000, statementBudgetMs: 11 * 60_000 })).catch((e: unknown) => e)
    expect(error).toMatchObject({ cause: { code: '55P03' } })
    expect(await columns('tasks')).not.toContain('estimate')
    await holder.query('ROLLBACK')
    await holder.end()
  })

  test('advisory lock は終わったら外れている（次のデプロイが待たされない）', async () => {
    await runMigrations(options())
    const { rows } = await adminQuery('SELECT count(*)::int AS n FROM pg_locks WHERE locktype = $1 AND objid = $2', ['advisory', LOCK_ID], db.name)
    expect(rows[0].n).toBe(0)
  })
})

const indexState = async () =>
  (await adminQuery(`SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'tasks_due_date_idx'`, [], db.name)).rows

describe('事前の SQL（CREATE INDEX CONCURRENTLY）', () => {
  const withIndex = [
    {
      tag: '0001_tasks_due_date_idx',
      // マイグレーションは IF NOT EXISTS。本番では事前の SQL で作られているので何もしない
      sql: 'CREATE INDEX IF NOT EXISTS "tasks_due_date_idx" ON "tasks" USING btree ("due_date");',
      pre: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_due_date_idx" ON "tasks" ("due_date");',
    },
  ]
  test('まだ流していないタグの分だけ流し、マイグレーションのあとは流さない', async () => {
    await runMigrations(options())
    const dir = folder(withIndex)
    expect(await runPreSql(options({ migrationsFolder: dir }))).toMatchObject({ ok: true, ran: [{ tag: '0001_tasks_due_date_idx', statements: 1, droppedInvalid: [] }] })
    expect(await indexState()).toEqual([{ valid: true }])
    expect(await runMigrations(options({ migrationsFolder: dir }))).toMatchObject({ applied: ['0001_tasks_due_date_idx'] })
    expect(await runPreSql(options({ migrationsFolder: dir }))).toMatchObject({ ran: [] })
  })

  test('途中で失敗して残った使えない索引（INVALID）は、消してから作り直す', async () => {
    await runMigrations(options())
    // 同じ名前で一意の索引を作ろうとして失敗させると、INVALID な索引が残る（project_id は重複している）
    await adminQuery(`INSERT INTO projects (name) VALUES ('a')`, [], db.name)
    await adminQuery(`INSERT INTO tasks (project_id, title) SELECT id, 't' FROM projects UNION ALL SELECT id, 't' FROM projects`, [], db.name)
    await expect(adminQuery('CREATE UNIQUE INDEX CONCURRENTLY "tasks_due_date_idx" ON "tasks" ("project_id")', [], db.name)).rejects.toThrow(/could not create unique index/)
    expect(await indexState()).toEqual([{ valid: false }])

    const result = await runPreSql(options({ migrationsFolder: folder(withIndex) }))
    expect(result.ran[0]!.droppedInvalid).toEqual(['tasks_due_date_idx'])
    expect(await indexState()).toEqual([{ valid: true }])
  })
})
