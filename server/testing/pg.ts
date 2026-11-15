import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, type ClientConfig } from 'pg'
import { readJournal } from '../migrations'

// server/**/*.pg.test.ts 用。TEST_DATABASE_URL の PostgreSQL に、空の DB と利用者をテストごとに作って消す。
// 名前は t_ で始める（src/test/postgres-global-setup.ts が、残ったものを実行の前後に消す）

export const baseUrl = () => {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL が要ります')
  return url
}

export function urlFor(database: string, auth?: { user: string; password: string }): string {
  const url = new URL(baseUrl())
  url.pathname = `/${database}`
  if (auth) {
    url.username = encodeURIComponent(auth.user)
    url.password = encodeURIComponent(auth.password)
  }
  return url.toString()
}

let seq = 0
export const uniqueName = (prefix: string) => `t_${prefix}_${process.pid}_${Date.now().toString(36)}_${++seq}`

export async function adminQuery(sql: string, values?: unknown[], database?: string) {
  const client = new Client({ connectionString: database ? urlFor(database) : baseUrl() })
  await client.connect()
  try {
    return await client.query(sql, values)
  } finally {
    await client.end()
  }
}

export async function connect(url: string, options: ClientConfig = {}) {
  const client = new Client({ connectionString: url, ...options })
  await client.connect()
  return client
}

/** 空の DB を作る。drop() で消す（作った利用者も消す） */
export async function freshDatabase() {
  const name = uniqueName('db')
  const roles: string[] = []
  await adminQuery(`CREATE DATABASE "${name}"`)
  return {
    name,
    url: urlFor(name),
    /** この DB のテストで使う利用者。drop() で一緒に消す */
    async role(prefix: string, password = 'pw-' + Math.random().toString(36).slice(2), extra = '') {
      const role = uniqueName(prefix)
      await adminQuery(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' ${extra}`)
      roles.push(role)
      return { user: role, password }
    },
    track(role: string) {
      roles.push(role)
    },
    async drop() {
      await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      for (const r of roles.toReversed()) await adminQuery(`DROP ROLE IF EXISTS "${r}"`)
    },
  }
}

/** drizzle/ を一時フォルダーに写し、マイグレーション（と事前の SQL）を足す */
export function migrationsWith(extra: { tag: string; sql: string; pre?: string }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'))
  cpSync('./drizzle', dir, { recursive: true })
  const journal = readJournal(dir)
  let when = Math.max(...journal.entries.map((e) => e.when))
  for (const m of extra) {
    when += 1000
    journal.entries.push({ idx: journal.entries.length, version: '7', when, tag: m.tag, breakpoints: true } as (typeof journal.entries)[number])
    writeFileSync(join(dir, `${m.tag}.sql`), m.sql)
    if (m.pre) {
      mkdirSync(join(dir, 'pre'), { recursive: true })
      writeFileSync(join(dir, 'pre', `${m.tag}.sql`), m.pre)
    }
  }
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal, null, 2))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
