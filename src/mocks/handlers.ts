import { delay, http, HttpResponse } from 'msw'
import { getDbInfo } from '../server/admin'
import { type Db, HttpError } from '../server/core'
import { getDashboard } from '../server/dashboard'
import { createMember, deleteMember, listMembers, updateMember } from '../server/members'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  setProjectMembers,
  updateProject,
} from '../server/projects'
import { resetData } from '../server/seed'
import { createTag, deleteTag, listTags } from '../server/tags'
import {
  addComment,
  createTask,
  deleteComment,
  deleteTask,
  getTask,
  listTasks,
  updateTask,
} from '../server/tasks'
import { API_BASE } from '../shared/api-path'
import { today } from '../shared/dates'
import type { ApiErrorBody } from '../shared/types'
import { usePreferences, type Fault } from '../stores/preferences'

// MSW のハンドラーは「HTTP と src/server をつなぐだけ」。
// 本番では同じことを Hono / Express / Lambda などのルーティングで書けばよい。

type Params = Record<string, string | readonly string[] | undefined>
type Ctx = { request: Request; params: Params; db: Db }

export type HandlerOptions = {
  /** DB の取得方法。ブラウザでは IndexedDB の PGlite、テストではメモリ上の PGlite を渡す */
  getDb: () => Promise<Db>
  /** 設定画面の「API の遅延」と「障害シミュレーション」。既定では端末の設定（Zustand）を読む */
  getLatency?: () => number
  getFault?: () => Fault
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const errorJson = (status: number, error: string) => HttpResponse.json<ApiErrorBody>({ error }, { status })

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new HttpError(400, 'JSON の形式が正しくありません')
  }
}

function id(params: Params, key = 'id'): number {
  const value = Number(params[key])
  if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, 'id が正しくありません')
  return value
}

const query = (request: Request) => Object.fromEntries(new URL(request.url).searchParams)

const api = (path: string) => `${API_BASE}${path}`

export function createHandlers({
  getDb,
  getLatency = () => usePreferences.getState().latency,
  getFault = () => usePreferences.getState().fault,
}: HandlerOptions) {
  function route(handler: (ctx: Ctx) => Promise<unknown>, { simulateFaults = true } = {}) {
    return async ({ request, params }: { request: Request; params: Params }) => {
      // ローディング表示や楽観的更新を確かめるための遅延
      await delay(getLatency())
      if (simulateFaults) {
        const fault = getFault()
        if (fault === 'offline') return HttpResponse.error()
        if (fault === 'error-all' || (fault === 'error-writes' && WRITE_METHODS.has(request.method))) {
          return errorJson(503, '障害シミュレーション中です（設定画面で解除できます）')
        }
      }
      try {
        const result = await handler({ request, params, db: await getDb() })
        if (result === undefined) return new HttpResponse(null, { status: 204 })
        return HttpResponse.json(result as object, { status: request.method === 'POST' ? 201 : 200 })
      } catch (e) {
        if (e instanceof HttpError) {
          return HttpResponse.json<ApiErrorBody>({ error: e.message, fieldErrors: e.fieldErrors }, { status: e.status })
        }
        // 想定外の例外は中身（SQL やスタックトレース）を利用者に見せず、ログにだけ残す
        console.error(e)
        return errorJson(500, 'サーバーでエラーが発生しました')
      }
    }
  }
  return [
    http.get(api('/dashboard'), route(({ db, request }) => getDashboard(db, query(request).today ?? today()))),

    http.get(api('/projects'), route(({ db, request }) => listProjects(db, query(request)))),
    http.post(api('/projects'), route(async ({ db, request }) => createProject(db, await body(request)))),
    http.get(api('/projects/:id'), route(({ db, params }) => getProject(db, id(params)))),
    http.patch(api('/projects/:id'), route(async ({ db, params, request }) => updateProject(db, id(params), await body(request)))),
    http.delete(api('/projects/:id'), route(({ db, params }) => deleteProject(db, id(params)))),
    http.put(
      api('/projects/:id/members'),
      route(async ({ db, params, request }) => setProjectMembers(db, id(params), await body(request))),
    ),

    http.get(api('/projects/:id/tasks'), route(({ db, params, request }) => listTasks(db, id(params), query(request)))),
    http.post(api('/projects/:id/tasks'), route(async ({ db, params, request }) => createTask(db, id(params), await body(request)))),
    http.get(api('/tasks/:id'), route(({ db, params }) => getTask(db, id(params)))),
    http.patch(api('/tasks/:id'), route(async ({ db, params, request }) => updateTask(db, id(params), await body(request)))),
    http.delete(api('/tasks/:id'), route(({ db, params }) => deleteTask(db, id(params)))),

    http.post(api('/tasks/:id/comments'), route(async ({ db, params, request }) => addComment(db, id(params), await body(request)))),
    http.delete(api('/comments/:id'), route(({ db, params }) => deleteComment(db, id(params)))),

    http.get(api('/members'), route(({ db }) => listMembers(db))),
    http.post(api('/members'), route(async ({ db, request }) => createMember(db, await body(request)))),
    http.patch(api('/members/:id'), route(async ({ db, params, request }) => updateMember(db, id(params), await body(request)))),
    http.delete(api('/members/:id'), route(({ db, params }) => deleteMember(db, id(params)))),

    http.get(api('/tags'), route(({ db }) => listTags(db))),
    http.post(api('/tags'), route(async ({ db, request }) => createTag(db, await body(request)))),
    http.delete(api('/tags/:id'), route(({ db, params }) => deleteTag(db, id(params)))),

    // プロトタイプ専用: ブラウザ内 DB の状態確認と、サンプルデータへの初期化
    http.get(api('/_debug'), route(({ db }) => getDbInfo(db), { simulateFaults: false })),
    http.post(
      api('/_reset'),
      route(
        async ({ db }) => {
          await resetData(db)
        },
        { simulateFaults: false },
      ),
    ),
  ]
}
