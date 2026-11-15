import { sql } from 'drizzle-orm'
import type { DbInfo } from '../shared/types'
import type { Db } from './core'

const TABLES = ['members', 'projects', 'project_members', 'tasks', 'tags', 'task_tags', 'comments'] as const

export async function getDbInfo(db: Db): Promise<DbInfo> {
  const version = await db.execute<{ version: string }>(sql`select version()`)
  const migrations = await db.execute<DbInfo['migrations'][number]>(
    sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id`,
  )
  const counts = await db.execute<{ name: string; n: number }>(
    sql.raw(TABLES.map((t) => `select '${t}' as name, count(*)::int as n from ${t}`).join(' union all ')),
  )
  return {
    version: rowsOf<{ version: string }>(version)[0]?.version ?? '',
    migrations: rowsOf<DbInfo['migrations'][number]>(migrations),
    rows: Object.fromEntries(rowsOf<{ name: string; n: number }>(counts).map((r) => [r.name, r.n])),
  }
}

// db.execute の戻り値はドライバーによって配列か { rows } になる
function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows: T[] }).rows ?? [])
}
