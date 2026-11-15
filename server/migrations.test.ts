import { describe, expect, test } from 'vitest'
import { concurrentIndexNames, readJournal, splitStatements } from './migrations'

describe('事前の SQL の読み方', () => {
  test('drizzle-kit と同じ区切りで文に分け、コメントだけの文は捨てる', () => {
    const sql = `-- 期限での並べ替え用
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_due_date_idx" ON "tasks" ("due_date");
--> statement-breakpoint
-- なにもしない
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS tags_lower_name_idx ON tags (lower(name));`
    expect(splitStatements(sql)).toEqual([
      '-- 期限での並べ替え用\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_due_date_idx" ON "tasks" ("due_date");',
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS tags_lower_name_idx ON tags (lower(name));',
    ])
    expect(concurrentIndexNames(sql)).toEqual(['tasks_due_date_idx', 'tags_lower_name_idx'])
  })

  test('リポジトリの journal を読める', () => {
    const journal = readJournal('./drizzle')
    expect(journal.entries[0]).toMatchObject({ idx: 0, tag: '0000_init' })
  })
})
