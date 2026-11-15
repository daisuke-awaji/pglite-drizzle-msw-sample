import { asc, eq } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import * as schema from '../db/schema'
import type { Todo } from '../shared/types'

// ここが「本番のバックエンドにそのまま持っていく層」。
// HTTP（MSW）にも PGlite にも依存せず、PostgreSQL 用の Drizzle インスタンスを受け取るだけ。
// node-postgres / postgres.js / PGlite のどれで作った db でも渡せる。
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const { todos } = schema

function toDto(row: schema.TodoRow): Todo {
  return { ...row, createdAt: row.createdAt.toISOString() }
}

function parseTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'title は 1 文字以上の文字列で指定してください')
  }
  const title = value.trim()
  if (title.length > 200) throw new HttpError(400, 'title は 200 文字以内で指定してください')
  return title
}

export async function listTodos(db: Db): Promise<Todo[]> {
  const rows = await db.select().from(todos).orderBy(asc(todos.id))
  return rows.map(toDto)
}

export async function createTodo(db: Db, body: unknown): Promise<Todo> {
  const title = parseTitle((body as { title?: unknown } | null)?.title)
  const [row] = await db.insert(todos).values({ title }).returning()
  return toDto(row!)
}

export async function updateTodo(db: Db, id: number, body: unknown): Promise<Todo> {
  const input = (body ?? {}) as { title?: unknown; done?: unknown }
  const patch: Partial<Pick<schema.TodoRow, 'title' | 'done'>> = {}
  if (input.title !== undefined) patch.title = parseTitle(input.title)
  if (input.done !== undefined) {
    if (typeof input.done !== 'boolean') throw new HttpError(400, 'done は boolean で指定してください')
    patch.done = input.done
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, '更新する項目がありません')

  const [row] = await db.update(todos).set(patch).where(eq(todos.id, id)).returning()
  if (!row) throw new HttpError(404, `todo ${id} が見つかりません`)
  return toDto(row)
}

export async function deleteTodo(db: Db, id: number): Promise<void> {
  const deleted = await db.delete(todos).where(eq(todos.id, id)).returning({ id: todos.id })
  if (deleted.length === 0) throw new HttpError(404, `todo ${id} が見つかりません`)
}
