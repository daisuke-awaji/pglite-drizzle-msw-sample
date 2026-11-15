import { delay, http, HttpResponse } from 'msw'
import type { Db } from '../server/core'
import { errorResponse, respond, type Params, type Route } from '../server/http'
import { routes } from '../server/routes'
import { API_BASE } from '../shared/api-path'
import { usePreferences, type Fault } from '../stores/preferences'
import { getDbInfo } from './admin'
import { resetData } from './seed'

// MSW のハンドラーは「src/server のルート表を MSW に登録するだけ」。
// HTTP の決まり（ID の検証・JSON の読み取り・状態コード）は src/server/http.ts の respond にある。
// 本番では同じルート表を Hono などに登録する（README の「本番の PostgreSQL に移行する」）

export type HandlerOptions = {
  /** DB の取得方法。ブラウザでは IndexedDB の PGlite、テストではメモリ上の PGlite を渡す */
  getDb: () => Promise<Db>
  /** 設定画面の「API の遅延」と「障害シミュレーション」。既定では端末の設定（Zustand）を読む */
  getLatency?: () => number
  getFault?: () => Fault
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// プロトタイプ専用: ブラウザ内 DB の状態確認と、サンプルデータへの初期化。
// 本番のバックエンドには作らない（routes.ts ではなくここに置き、障害シミュレーションの対象にもしない）
export const devRoutes: readonly Route[] = [
  { method: 'GET', path: '/_debug', handle: ({ db }) => getDbInfo(db) },
  {
    method: 'POST',
    path: '/_reset',
    handle: async ({ db }) => {
      await resetData(db)
    },
  },
]

const register = {
  GET: http.get,
  POST: http.post,
  PUT: http.put,
  PATCH: http.patch,
  DELETE: http.delete,
} as const

export function createHandlers({
  getDb,
  getLatency = () => usePreferences.getState().latency,
  getFault = () => usePreferences.getState().fault,
}: HandlerOptions) {
  const handler =
    (route: Route, { simulateFaults }: { simulateFaults: boolean }) =>
    async ({ request, params }: { request: Request; params: Params }) => {
      // ローディング表示や楽観的更新を確かめるための遅延
      await delay(getLatency())
      if (simulateFaults) {
        const fault = getFault()
        if (fault === 'offline') return HttpResponse.error()
        if (fault === 'error-all' || (fault === 'error-writes' && WRITE_METHODS.has(request.method))) {
          return errorResponse(503, '障害シミュレーション中です（設定画面で解除できます）')
        }
      }
      return respond(route, { db: getDb(), request, params })
    }

  return [
    ...routes.map((r) => register[r.method](`${API_BASE}${r.path}`, handler(r, { simulateFaults: true }))),
    ...devRoutes.map((r) => register[r.method](`${API_BASE}${r.path}`, handler(r, { simulateFaults: false }))),
  ]
}
