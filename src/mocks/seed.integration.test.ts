import { sql } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { members, tags, tasks } from '../db/schema'
import { setupTestDb, TEST_NOW } from '../test/db'
import { resetData, seedIfEmpty } from './seed'

// サンプルデータ（プロトタイプ専用）の投入と初期化
describe('初めて開いたときだけサンプルデータを入れる', () => {
  const empty = setupTestDb({ withSeed: false })

  test('空の DB には入れる。2 回目は入れない', async () => {
    expect(await seedIfEmpty(empty.db, TEST_NOW)).toBe(true)
    expect(await empty.db.$count(members)).toBe(8)
    expect(await seedIfEmpty(empty.db, TEST_NOW)).toBe(false)
    expect(await empty.db.$count(members)).toBe(8)
  })
})

describe('利用者がデータを消したあと', () => {
  const ctx = setupTestDb()

  test('メンバーを全員消してから開き直しても、起動に失敗しない（サンプルデータも入れ直さない）', async () => {
    await ctx.db.delete(members)
    // 以前は members だけを見て「空」と判定し、タグの一意制約違反で起動できなくなっていた
    await expect(seedIfEmpty(ctx.db, TEST_NOW)).resolves.toBe(false)
    expect(await ctx.db.$count(members)).toBe(0)
    expect(await ctx.db.$count(tags)).toBeGreaterThan(0)
  })

  test('サンプルデータに戻すと、追加・削除したものが元に戻る', async () => {
    const before = await ctx.db.$count(tasks)
    await ctx.db.delete(tasks)
    await ctx.db.insert(tags).values({ name: '追加したタグ' })
    await resetData(ctx.db, TEST_NOW)
    expect(await ctx.db.$count(tasks)).toBe(before)
    expect(await ctx.db.$count(tags, sql`${tags.name} = '追加したタグ'`)).toBe(0)
  })

  test('サンプルデータに戻す途中で失敗したら、何も消えない（空の DB を残さない）', async () => {
    const counts = async () => [await ctx.db.$count(members), await ctx.db.$count(tags), await ctx.db.$count(tasks)]
    const before = await counts()
    expect(before.every((n) => n > 0)).toBe(true)
    // サンプルデータのタグを入れるところで失敗させる（メンバーを入れたあと、タスクを入れる前）
    await ctx.db.$exec(`
      create function fail_seed() returns trigger language plpgsql as $$ begin raise exception 'seed failed'; end $$;
      create trigger fail_seed before insert on tags for each row execute function fail_seed();
    `)
    await expect(resetData(ctx.db, TEST_NOW)).rejects.toThrow(/Failed query/)
    expect(await counts()).toEqual(before)
  })
})
