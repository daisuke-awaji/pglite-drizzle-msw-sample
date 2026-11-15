import { id as idSchema } from '../shared/schemas'
import type { ApiErrorBody } from '../shared/types'
import { type Db, HttpError } from './core'

// HTTP の境界。Web 標準の Request / Response だけで書き、MSW にも Hono にも依存しない。
// MSW（src/mocks/handlers.ts）も本番のサーバーも、この関数を呼ぶだけにする。
// そうしておけば「パスの ID の検証」「JSON が壊れていたら 400」「POST は 201」などが、移行で抜け落ちない

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type Params = Readonly<Record<string, string | readonly string[] | undefined>>

export type RouteContext = {
  db: Db
  /** パスの数値 ID。正の int4 でなければ 400 */
  id: (name?: string) => number
  /** クエリ文字列。値の検証は各サーバー関数のスキーマで行う */
  query: Record<string, string>
  /** 本文の JSON。壊れていれば 400 */
  body: () => Promise<unknown>
}

export type Route = {
  method: Method
  /** API のベース（/api）より後ろのパス。`:id` の形で引数を書く（MSW と Hono で同じ書き方） */
  path: string
  handle: (ctx: RouteContext) => Promise<unknown>
}

export function parseId(params: Params, name = 'id'): number {
  const result = idSchema.safeParse(params[name])
  if (!result.success) throw new HttpError(400, `${name} が正しくありません`)
  return result.data
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown
  } catch {
    throw new HttpError(400, 'JSON の形式が正しくありません')
  }
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export const errorResponse = (status: number, error: string, fieldErrors?: ApiErrorBody['fieldErrors']) =>
  json({ error, fieldErrors } satisfies ApiErrorBody, status)

/**
 * ルートを 1 つ実行して Response にする。
 * - 戻り値が undefined なら 204、POST なら 201、それ以外は 200
 * - HttpError はその状態コードと { error, fieldErrors }
 * - 想定外の例外（DB につながらないなど）は 500。中身（SQL やスタックトレース）は利用者に見せず、ログにだけ残す
 */
export async function respond(
  route: Route,
  {
    db,
    request,
    params,
    onUnexpectedError = (e) => console.error(e),
  }: {
    db: Db | Promise<Db>
    request: Request
    params: Params
    /** 想定外の例外の記録先。既定はコンソール。本番のサーバーは構造化したログに出す（server/app.ts） */
    onUnexpectedError?: (e: unknown) => void
  },
): Promise<Response> {
  try {
    const result = await route.handle({
      // DB の取得（接続）の失敗も、想定外の例外として 500 にする
      db: await db,
      id: (name) => parseId(params, name),
      query: Object.fromEntries(new URL(request.url).searchParams),
      body: () => readJson(request),
    })
    if (result === undefined) return new Response(null, { status: 204 })
    return json(result, request.method === 'POST' ? 201 : 200)
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e.status, e.message, e.fieldErrors)
    onUnexpectedError(e)
    return errorResponse(500, 'サーバーでエラーが発生しました')
  }
}
