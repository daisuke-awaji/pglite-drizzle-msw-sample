import { http, HttpResponse } from 'msw/http'
import { getDb } from '../db/client.browser'
import { todos } from '../db/schema'
import { createTodo, deleteTodo, HttpError, listTodos, updateTodo } from '../server/todos'
import { API_BASE } from '../shared/api-path'

// MSW のハンドラーは「HTTP と server/ 層をつなぐだけ」にしておく。
// 本番では同じことを Lambda / Hono / Express などのルーティングで書けばよい。
async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof HttpError) return HttpResponse.json({ error: e.message }, { status: e.status })
    console.error(e)
    return HttpResponse.json({ error: 'internal error' }, { status: 500 })
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new HttpError(400, 'JSON の形式が正しくありません')
  }
}

function parseId(value: string | readonly string[] | undefined): number {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'id が正しくありません')
  return id
}

export const handlers = [
  http.get(`${API_BASE}/todos`, () =>
    handle(async () => HttpResponse.json(await listTodos(await getDb()))),
  ),

  http.post(`${API_BASE}/todos`, ({ request }) =>
    handle(async () => {
      const todo = await createTodo(await getDb(), await readJson(request))
      return HttpResponse.json(todo, { status: 201 })
    }),
  ),

  http.patch(`${API_BASE}/todos/:id`, ({ request, params }) =>
    handle(async () => {
      const todo = await updateTodo(await getDb(), parseId(params.id), await readJson(request))
      return HttpResponse.json(todo)
    }),
  ),

  http.delete(`${API_BASE}/todos/:id`, ({ params }) =>
    handle(async () => {
      await deleteTodo(await getDb(), parseId(params.id))
      return new HttpResponse(null, { status: 204 })
    }),
  ),

  // プロトタイプ専用: ブラウザ内のデータを空にする
  http.post(`${API_BASE}/_reset`, () =>
    handle(async () => {
      const db = await getDb()
      await db.delete(todos)
      return new HttpResponse(null, { status: 204 })
    }),
  ),

  // プロトタイプ専用: ブラウザ内 DB の状態（バージョンとマイグレーション履歴）を確認する
  http.get(`${API_BASE}/_debug`, () =>
    handle(async () => {
      const db = await getDb()
      const { rows } = await db.$client.query<{ version: string }>('select version()')
      const migrations = await db.$client.query(
        'select id, hash, created_at from drizzle.__drizzle_migrations order by id',
      )
      return HttpResponse.json({ version: rows[0]?.version, migrations: migrations.rows })
    }),
  ),
]
