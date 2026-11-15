import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { checkMigrations, checkPreSql } from './check-migrations.mjs'

/** @param {[string, number, string][]} list [tag, when, sql] */
function set(list) {
  return {
    journal: { entries: list.map(([tag, when], idx) => ({ idx, when, tag })) },
    sql: new Map(list.map(([tag, , sql]) => [tag, sql])),
  }
}
const files = (s) => [...s.sql.keys()].map((t) => `${t}.sql`)
const INIT = ['0000_init', 1000, 'CREATE TABLE "tasks" ("id" serial PRIMARY KEY, "title" text NOT NULL);']

describe('履歴の誤り（失敗にする）', () => {
  test('このリポジトリの drizzle/ は通り、警告も出ない', () => {
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
    const names = readdirSync('drizzle').filter((f) => f.endsWith('.sql'))
    const sql = new Map(names.map((f) => [f.replace(/\.sql$/, ''), readFileSync(`drizzle/${f}`, 'utf8')]))
    expect(checkMigrations({ journal, sql }, null, names)).toEqual({ errors: [], warnings: [] })
  })

  test('when が前より新しくないと失敗する（本番で黙って飛ばされるため）', () => {
    const current = set([INIT, ['0001_b', 3000, 'SELECT 1;'], ['0002_a', 2000, 'SELECT 1;']])
    const { errors } = checkMigrations(current, null, files(current))
    expect(errors).toEqual([expect.objectContaining({ tag: '0002_a', message: expect.stringContaining('飛ばされる') })])
  })

  test('idx の抜け・SQL のないエントリー・journal にない SQL を見つける', () => {
    const current = set([INIT, ['0001_a', 2000, 'SELECT 1;']])
    current.journal.entries[1].idx = 2
    current.sql.delete('0001_a')
    const { errors } = checkMigrations(current, null, ['0000_init.sql', '0009_orphan.sql'])
    expect(errors.map((e) => e.tag)).toEqual(['0001_a', '0001_a', '0009_orphan'])
  })

  test('基準のブランチにあるマイグレーションを書き換える・消すと失敗する', () => {
    const base = set([INIT, ['0001_a', 2000, 'ALTER TABLE "tasks" ADD COLUMN "a" text;']])
    const edited = set([INIT, ['0001_a', 2000, 'ALTER TABLE "tasks" ADD COLUMN "a" varchar(10);']])
    expect(checkMigrations(edited, base, files(edited)).errors).toEqual([expect.objectContaining({ tag: '0001_a', message: expect.stringContaining('書き換わっている') })])

    const removed = set([INIT])
    expect(checkMigrations(removed, base, files(removed)).errors).toEqual([expect.objectContaining({ tag: '0001_a', message: expect.stringContaining('消えた') })])
  })

  test('基準のあとに足したものは通る', () => {
    const base = set([INIT])
    const current = set([INIT, ['0001_a', 2000, 'ALTER TABLE "tasks" ADD COLUMN "a" text;']])
    expect(checkMigrations(current, base, files(current))).toEqual({ errors: [], warnings: [] })
  })

  test('CONCURRENTLY は失敗にする（トランザクションの中では使えない）', () => {
    const current = set([INIT, ['0001_idx', 2000, 'CREATE INDEX CONCURRENTLY "tasks_title_idx" ON "tasks" ("title");']])
    expect(checkMigrations(current, null, files(current)).errors).toEqual([expect.objectContaining({ tag: '0001_idx', message: expect.stringContaining('CONCURRENTLY') })])
  })
})

/** INIT のあとに 1 本足したときの警告（理由の部分だけ） */
function warn(sql, created = '') {
  const current = set([INIT, ['0001_x', 2000, `${created}${sql}`]])
  return checkMigrations(current, set([INIT]), files(current)).warnings.map((w) => w.message.split('（')[0])
}

describe('レビューが要る ALTER（警告にする）', () => {

  test.each([
    ['ALTER TABLE "tasks" ALTER COLUMN "id" SET DATA TYPE bigint;', '列の型の変更'],
    ['ALTER TABLE "tasks" ALTER COLUMN "title" TYPE varchar(500);', '列の型の変更'],
    ['ALTER TABLE "tasks" ALTER COLUMN "title" SET NOT NULL;', 'SET NOT NULL'],
    ['ALTER TABLE "tasks" ADD COLUMN "token" uuid DEFAULT gen_random_uuid() NOT NULL;', '毎回違う値'],
    ['ALTER TABLE "tasks" DROP COLUMN "title";', '消す・名前を変える'],
    ['ALTER TABLE "tasks" RENAME COLUMN "title" TO "name";', '消す・名前を変える'],
    ['DROP TABLE "tasks";', '消す・名前を変える'],
    [`ALTER TYPE "public"."task_status" ADD VALUE 'blocked';`, 'enum に足した値'],
    ['ALTER TABLE "tasks" ADD CONSTRAINT "tasks_p_fk" FOREIGN KEY ("p") REFERENCES "public"."projects"("id");', '既存の表に制約'],
    ['ALTER TABLE "tasks" ADD CONSTRAINT "tasks_title_unique" UNIQUE("title");', '既存の表に UNIQUE'],
    ['CREATE INDEX "tasks_title_idx" ON "tasks" USING btree ("title");', '既存の表に索引'],
  ])('%s', (sql, expected) => {
    expect(warn(sql)).toEqual([expect.stringContaining(expected)])
  })

  test.each([
    ['定数の DEFAULT 付きの ADD COLUMN（書き直さない）', 'ALTER TABLE "tasks" ADD COLUMN "priority" text DEFAULT \'medium\' NOT NULL;'],
    ['NOT VALID で足す制約', 'ALTER TABLE "tasks" ADD CONSTRAINT "tasks_p_fk" FOREIGN KEY ("p") REFERENCES "projects"("id") NOT VALID;'],
    ['事前に CONCURRENTLY で作った索引を IF NOT EXISTS で書く', 'CREATE INDEX IF NOT EXISTS "tasks_title_idx" ON "tasks" ("title");'],
    ['-- のコメントの中', '-- DROP TABLE "tasks";\nSELECT 1;'],
  ])('警告しない: %s', (_, sql) => {
    expect(warn(sql)).toEqual([])
  })

  test('同じファイルで作った表への外部キー・索引は警告しない（drizzle-kit はこの形で出す）', () => {
    const created = 'CREATE TABLE "labels" ("id" serial PRIMARY KEY, "task_id" integer);\n--> statement-breakpoint\n'
    const sql = 'ALTER TABLE "labels" ADD CONSTRAINT "labels_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade;\n--> statement-breakpoint\nCREATE INDEX "labels_task_idx" ON "labels" USING btree ("task_id");'
    expect(warn(sql, created)).toEqual([])
  })

  test('基準のブランチにある（適用済みの）マイグレーションには警告しない', () => {
    const old = ['0001_old', 2000, 'ALTER TABLE "tasks" DROP COLUMN "title";']
    const current = set([INIT, old])
    expect(checkMigrations(current, set([INIT, old]), files(current)).warnings).toEqual([])
  })
})

describe('事前の SQL（drizzle/pre）', () => {
  const current = set([INIT, ['0001_idx', 2000, 'CREATE INDEX IF NOT EXISTS "tasks_title_idx" ON "tasks" USING btree ("title");']])

  test('CONCURRENTLY IF NOT EXISTS の索引で、マイグレーションにも IF NOT EXISTS があれば何も言わない', () => {
    const pre = new Map([['0001_idx', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_title_idx" ON "tasks" ("title");']])
    expect(checkPreSql(current, pre)).toEqual({ errors: [], warnings: [] })
  })

  test('タグがない・何度流すと失敗する文は失敗にする', () => {
    const pre = new Map([
      ['0009_missing', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "x" ON "tasks" ("title");'],
      ['0001_idx', 'CREATE INDEX CONCURRENTLY "tasks_title_idx" ON "tasks" ("title");\n--> statement-breakpoint\nUPDATE tasks SET title = lower(title);'],
    ])
    const { errors } = checkPreSql(current, pre)
    expect(errors.map((e) => e.tag)).toEqual(['0009_missing', '0001_idx', '0001_idx'])
    expect(errors[1].message).toMatch(/CONCURRENTLY IF NOT EXISTS/)
  })

  test('マイグレーションに同じ名前の索引がなければ警告する（PGlite とテストの DB に索引ができない）', () => {
    const pre = new Map([['0001_idx', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "other_idx" ON "tasks" ("title");']])
    expect(checkPreSql(current, pre).warnings).toHaveLength(1)
  })
})
