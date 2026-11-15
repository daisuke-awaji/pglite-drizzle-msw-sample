import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterEach, beforeEach } from 'vitest'
import * as schema from '../db/schema'
import { seed } from '../mocks/seed'
import type { Client } from 'pg'
import type { Db } from '../server/core'

/** テストの「今日」。シードの日付（期限切れの判定など）はこの日を基準に作る */
export const TEST_TODAY = '2026-11-15'
export const TEST_NOW = new Date(`${TEST_TODAY}T09:00:00`)

/**
 * テスト用の DB。src/server が受け取る Db に、後片付けと生の SQL を足したもの。
 * - `$close()`: 使い終わったら必ず呼ぶ（PGlite はメモリ、PostgreSQL は複製した DB を消す）
 * - `$exec(sql)`: 複数の文をそのまま流す（トリガーを仕込むなど、テストの準備だけに使う）
 */
export type TestDb = Db & { $close(): Promise<void>; $exec(sql: string): Promise<void> }

// テストは本物の PostgreSQL に、本番と同じマイグレーションを流して行う。
// - 既定: メモリ上の PGlite（ブラウザと同じ PostgreSQL 18.6 の WASM 版）
// - TEST_DATABASE_URL があるとき: その PostgreSQL（CI では Aurora と同じメジャーバージョンのサービスコンテナ）
// マイグレーションとシードはワーカーごとに 1 回だけ行い、テストごとにテンプレートを複製する。
// 毎回マイグレーションとシードからやり直すより、1 テストあたり 3 分の 1 ほどの時間で済む
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

export const usesExternalPostgres = Boolean(TEST_DATABASE_URL)

/** テンプレートを複製した DB を返す。使い終わったら `db.$close()` で閉じる（閉じないとメモリや DB が溜まる） */
export async function createTestDb({ withSeed = true } = {}): Promise<TestDb> {
  return TEST_DATABASE_URL ? createPostgresDb(TEST_DATABASE_URL, withSeed) : createPgliteDb(withSeed)
}

const pgliteTemplates = new Map<boolean, Promise<PGlite>>()

function pgliteTemplate(withSeed: boolean): Promise<PGlite> {
  let t = pgliteTemplates.get(withSeed)
  if (!t) {
    t = (async () => {
      const client = new PGlite()
      const db = drizzle({ client, schema })
      await migrate(db, { migrationsFolder: './drizzle' })
      if (withSeed) await seed(db, TEST_NOW)
      return client
    })()
    pgliteTemplates.set(withSeed, t)
  }
  return t
}

async function createPgliteDb(withSeed: boolean): Promise<TestDb> {
  const client = (await (await pgliteTemplate(withSeed)).clone()) as PGlite
  return Object.assign(drizzle({ client, schema }), {
    $close: () => client.close(),
    $exec: async (sql: string) => {
      await client.exec(sql)
    },
  })
}

// PostgreSQL では CREATE DATABASE ... TEMPLATE でテストごとの DB を作り、終わったら消す。
// DB の名前は「t_<ワーカー>_<連番>」。src/test/postgres-global-setup.ts が実行の前後に t_ で始まる DB を掃除する
// pg は TEST_DATABASE_URL のときだけ読み込む（PGlite だけのテストを遅くしない）
let pgModule: ReturnType<typeof loadPgModule> | undefined
const loadPgModule = () => import('pg')
const loadPg = () => (pgModule ??= loadPgModule())

const worker = `${process.pid}_${process.env.VITEST_POOL_ID ?? '0'}`
const pgTemplates = new Map<boolean, Promise<string>>()
let counter = 0

function urlFor(base: string, database: string): string {
  const url = new URL(base)
  url.pathname = `/${database}`
  return url.toString()
}

// 接続ごとに Aurora と同じ設定にそろえる（タイムゾーンは UTC。PGlite も UTC）
const SESSION_OPTIONS = '-c TimeZone=UTC'

async function withAdmin<T>(base: string, run: (client: Client) => Promise<T>): Promise<T> {
  const { default: pg } = await loadPg()
  const client = new pg.Client({ connectionString: base, options: SESSION_OPTIONS })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

function pgTemplate(base: string, withSeed: boolean): Promise<string> {
  let t = pgTemplates.get(withSeed)
  if (!t) {
    t = (async () => {
      const name = `t_${worker}_tmpl_${withSeed ? 'seed' : 'empty'}`
      await withAdmin(base, async (c) => {
        await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
        await c.query(`CREATE DATABASE "${name}"`)
      })
      const [{ default: pg }, { drizzle: drizzlePg }, { migrate: migratePg }] = await Promise.all([
        loadPg(),
        import('drizzle-orm/node-postgres'),
        import('drizzle-orm/node-postgres/migrator'),
      ])
      // テンプレートにする DB は、複製するときに接続が残っていてはいけないので、使い終わったら閉じる
      const pool = new pg.Pool({ connectionString: urlFor(base, name), max: 1, options: SESSION_OPTIONS })
      try {
        const db = drizzlePg(pool, { schema })
        await migratePg(db, { migrationsFolder: './drizzle' })
        if (withSeed) await seed(db, TEST_NOW)
      } finally {
        await pool.end()
      }
      return name
    })()
    pgTemplates.set(withSeed, t)
  }
  return t
}

async function createPostgresDb(base: string, withSeed: boolean): Promise<TestDb> {
  const template = await pgTemplate(base, withSeed)
  const name = `t_${worker}_${++counter}`
  await withAdmin(base, (c) => c.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`))
  const [{ default: pg }, { drizzle: drizzlePg }] = await Promise.all([loadPg(), import('drizzle-orm/node-postgres')])
  const pool = new pg.Pool({ connectionString: urlFor(base, name), max: 5, options: SESSION_OPTIONS })
  // 待機中の接続が DB 側から切られても、テストのプロセスを落とさない
  pool.on('error', () => {})
  let closed = false
  return Object.assign(drizzlePg(pool, { schema }), {
    $close: async () => {
      if (closed) return
      closed = true
      await pool.end()
      await withAdmin(base, (c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`))
    },
    $exec: async (sql: string) => {
      // 値を渡さない query は単純問い合わせのプロトコルで送られ、複数の文をそのまま流せる
      await pool.query(sql)
    },
  })
}

/**
 * テストごとに新しい DB を用意し、終わったら閉じる。
 * 返り値の `.db` は beforeEach のあとで読むこと（describe の直下で分割代入しない）
 */
export function setupTestDb(options: { withSeed?: boolean } = {}) {
  const ctx = {} as { db: TestDb }
  beforeEach(async () => {
    ctx.db = await createTestDb(options)
  })
  afterEach(async () => {
    await ctx.db.$close()
  })
  return ctx
}
