import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { bootstrapDatabase } from './bootstrap'
import { runMigrations } from './migrate'
import { adminQuery, connect, freshDatabase, uniqueName, urlFor } from './testing/pg'

// DB の利用者（docs/production.md「初回の構築」の 5）の権限を、本物の PostgreSQL で確かめる

let db: Awaited<ReturnType<typeof freshDatabase>>
let users: { migrator: string; app: string; readonly: string }
const passwords = { migrator: 'migrator-pw', app: 'app-pw', readonly: 'readonly-pw' }

beforeEach(async () => {
  db = await freshDatabase()
  users = { migrator: uniqueName('migrator'), app: uniqueName('app'), readonly: uniqueName('ro') }
  for (const u of Object.values(users)) db.track(u)
})
afterEach(async () => {
  await db.drop()
})

const asUser = (key: keyof typeof users, password = passwords[key]) => connect(urlFor(db.name, { user: users[key], password }))

async function bootstrap(pw = passwords) {
  const admin = await connect(db.url)
  try {
    return await bootstrapDatabase(admin, { database: db.name, users, passwords: pw })
  } finally {
    await admin.end()
  }
}

const migrateAs = (role: string, user: keyof typeof users = 'migrator') =>
  runMigrations({ connect: () => asUser(user), migrationsFolder: './drizzle', deadline: Date.now() + 60_000, role })

async function denied(client: Awaited<ReturnType<typeof asUser>>, statement: string) {
  return client.query(statement).then(
    () => 'allowed',
    (e: { code?: string }) => e.code,
  )
}

describe('DB の利用者', () => {
  test('migrator はマイグレーションを流せ、app は読み書きだけ、readonly は読むだけ', async () => {
    expect(await bootstrap()).toMatchObject({ ok: true, created: Object.values(users), existing: [] })
    await migrateAs(users.migrator)

    const app = await asUser('app')
    await app.query(`INSERT INTO projects (name) VALUES ('p')`)
    await app.query(`UPDATE projects SET name = 'q'`)
    expect((await app.query('SELECT name FROM projects')).rows).toEqual([{ name: 'q' }])
    // DDL と TRUNCATE はできない（42501 = 権限がない。持ち主でないので ALTER・DROP もできない）
    expect(await denied(app, 'DROP TABLE comments')).toBe('42501')
    expect(await denied(app, 'ALTER TABLE projects ADD COLUMN x int')).toBe('42501')
    expect(await denied(app, 'TRUNCATE projects')).toBe('42501')
    expect(await denied(app, 'CREATE TABLE evil (id int)')).toBe('42501')
    expect((await app.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('20s')
    await app.end()

    const ro = await asUser('readonly')
    expect((await ro.query('SELECT count(*)::int AS n FROM projects')).rows[0].n).toBe(1)
    // 25006 = 読み取り専用のトランザクション
    expect(await denied(ro, `INSERT INTO projects (name) VALUES ('x')`)).toBe('25006')
    await ro.end()
  })

  test('何度流しても同じ。2 回目はパスワードを変えない（ローテーションで変わったものを戻さない）', async () => {
    await bootstrap()
    const again = await bootstrap({ migrator: 'other', app: 'other', readonly: 'other' })
    expect(again).toMatchObject({ created: [], existing: Object.values(users) })
    const app = await asUser('app')
    expect((await app.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }])
    await app.end()
  })

  test('migrator がない権限（CREATE ON DATABASE）だと、drizzle スキーマがあっても失敗する', async () => {
    await bootstrap()
    await migrateAs(users.migrator)
    await adminQuery(`REVOKE CREATE ON DATABASE "${db.name}" FROM "${users.migrator}"`)
    await expect(migrateAs(users.migrator)).rejects.toMatchObject({ cause: { code: '42501' } })
  })

  test('ローテーションで複製された利用者（交互に使う方式）でも、SET ROLE で表の持ち主がそろい、app の権限が付く', async () => {
    await bootstrap()
    // 交互に使う方式のローテーションは「元の利用者のメンバー」の複製を作る
    const clone = uniqueName('migrator_clone')
    db.track(clone)
    await adminQuery(`CREATE ROLE "${clone}" LOGIN PASSWORD 'clone-pw' IN ROLE "${users.migrator}"`)
    await runMigrations({
      connect: () => connect(urlFor(db.name, { user: clone, password: 'clone-pw' })),
      migrationsFolder: './drizzle',
      deadline: Date.now() + 60_000,
      role: users.migrator,
    })
    const { rows } = await adminQuery(`SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'`, [], db.name)
    expect(rows).toEqual([{ tableowner: users.migrator }])
    const app = await asUser('app')
    await expect(app.query(`INSERT INTO members (name, email) VALUES ('a', 'a@example.com')`)).resolves.toBeDefined()
    await app.end()
  })
})
