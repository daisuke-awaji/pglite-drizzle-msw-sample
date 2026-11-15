import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterEach, beforeEach } from 'vitest'
import * as schema from '../db/schema'
import { seed } from '../server/seed'

/** テストの「今日」。シードの日付（期限切れの判定など）はこの日を基準に作る */
export const TEST_TODAY = '2026-11-15'
export const TEST_NOW = new Date(`${TEST_TODAY}T09:00:00`)

export type TestDb = Awaited<ReturnType<typeof createTestDb>>

// テストは本物の PostgreSQL（メモリ上の PGlite）に、本番と同じマイグレーションを流して行う。
// マイグレーションとシードはワーカーごとに 1 回だけ行い、テストごとに clone() で複製する。
// 毎回マイグレーションとシードからやり直すより、1 テストあたり 3 分の 1 ほどの時間で済む
const templates = new Map<boolean, Promise<PGlite>>()

function template(withSeed: boolean): Promise<PGlite> {
  let t = templates.get(withSeed)
  if (!t) {
    t = (async () => {
      const client = new PGlite()
      const db = drizzle({ client, schema })
      await migrate(db, { migrationsFolder: './drizzle' })
      if (withSeed) await seed(db, TEST_NOW)
      return client
    })()
    templates.set(withSeed, t)
  }
  return t
}

/** テンプレートを複製した DB を返す。使い終わったら `db.$client.close()` で閉じる（閉じないとメモリが溜まる） */
export async function createTestDb({ withSeed = true } = {}) {
  const client = (await (await template(withSeed)).clone()) as PGlite
  return drizzle({ client, schema })
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
    await ctx.db.$client.close()
  })
  return ctx
}
