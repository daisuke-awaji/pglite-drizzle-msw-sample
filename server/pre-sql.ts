import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type pg from 'pg'
import { concurrentIndexNames, pendingTags, preSqlTags, readJournal, splitStatements, withMigrationLock, type RunOptions } from './migrations'

// 事前の SQL（drizzle/pre/<タグ>.sql）。CREATE INDEX CONCURRENTLY のように、Drizzle の 1 つのトランザクションの中では
// 流せないものを、マイグレーションの前にトランザクションの外で 1 文ずつ流す（docs/production.md「索引を足す（既存の表）」）。
// - 流すのは、まだ適用していないマイグレーションのタグのものだけ（適用済みのタグの事前の SQL は流し直さない）
// - 文は何度流しても同じになるように書く（IF NOT EXISTS）。check:migrations が確かめる
// - CONCURRENTLY が途中で失敗すると使えない索引（INVALID）が残り、IF NOT EXISTS はそれを「ある」とみなすので、
//   流す前に、これから作る名前の INVALID な索引を消す

export type PreSqlResult = { ok: true; ran: { tag: string; statements: number; droppedInvalid: string[] }[]; attempts: number; durationMs: number }

async function dropInvalidIndexes(client: pg.Client, names: string[]): Promise<string[]> {
  if (names.length === 0) return []
  const { rows } = await client.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE NOT i.indisvalid AND c.relname = ANY($1::text[])`,
    [names],
  )
  for (const { name } of rows) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${client.escapeIdentifier(name)}`)
  return rows.map((r) => r.name)
}

export async function runPreSql(options: RunOptions): Promise<PreSqlResult> {
  const started = Date.now()
  const journal = readJournal(options.migrationsFolder)
  const available = preSqlTags(options.migrationsFolder)
  const { result, attempts } = await withMigrationLock(options, async (client) => {
    const tags = (await pendingTags(client, journal)).filter((t) => available.has(t))
    const ran: PreSqlResult['ran'] = []
    for (const tag of tags) {
      const sql = readFileSync(join(options.migrationsFolder, 'pre', `${tag}.sql`), 'utf8')
      const droppedInvalid = await dropInvalidIndexes(client, concurrentIndexNames(sql))
      const statements = splitStatements(sql)
      for (const statement of statements) await client.query(statement)
      ran.push({ tag, statements: statements.length, droppedInvalid })
      options.log?.({ type: 'migrate.pre-sql', tag, statements: statements.length, droppedInvalid })
    }
    return ran
  })
  return { ok: true, ran: result, attempts, durationMs: Date.now() - started }
}
