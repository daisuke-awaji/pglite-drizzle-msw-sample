import { delay, http, HttpResponse } from 'msw'
import { getDb } from '../db/client.browser'
import { getDbInfo } from '../server/admin'
import { HttpError } from '../server/core'
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
import { usePreferences } from '../stores/preferences'

// MSW のハンドラーは「HTTP と src/server をつなぐだけ」。
// 本番では同じことを Hono / Express / Lambda などのルーティングで書けばよい。

type Params = Record<string, string | readonly string[] | undefined>
type Ctx = { request: Request; params: Params; db: Awaited<ReturnType<typeof getDb>> }

function route(handler: (ctx: Ctx) => Promise<unknown>) {
  return async ({ request, params }: { request: Request; params: Params }) => {
    try {
      // 設定画面の「API の遅延」。ローディング表示や楽観的更新を確かめるため
      await delay(usePreferences.getState().latency)
      const result = await handler({ request, params, db: await getDb() })
      if (result === undefined) return new HttpResponse(null, { status: 204 })
      return HttpResponse.json(result as object, { status: request.method === 'POST' ? 201 : 200 })
    } catch (e) {
      if (e instanceof HttpError) {
        return HttpResponse.json<ApiErrorBody>(
          { error: e.message, fieldErrors: e.fieldErrors },
          { status: e.status },
        )
      }
      console.error(e)
      return HttpResponse.json<ApiErrorBody>({ error: 'サーバーでエラーが発生しました' }, { status: 500 })
    }
  }
}

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

export const handlers = [
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
  http.get(api('/_debug'), route(({ db }) => getDbInfo(db))),
  http.post(
    api('/_reset'),
    route(async ({ db }) => {
      await resetData(db)
    }),
  ),
]
