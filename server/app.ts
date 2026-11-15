import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { resolveAccess } from '../src/server/access'
import { errorResponse, respond, type Route } from '../src/server/http'
import { routes as apiRoutes } from '../src/server/routes'
import { accessFor, type Authenticator } from './auth'
import type { DbProvider } from './db'
import { describeError, type Logger } from './log'

// 本番の API。src/server/routes.ts のルート表を Hono に登録するだけで、HTTP の決まり（ID の検証・状態コードなど）は
// MSW と同じ src/server/http.ts の respond が受け持つ（README「本番の PostgreSQL に移行する」の例と同じ）。
// CloudFront は /api/* だけをここに送る。画面（index.html・JS）は S3 から配る

/** 画面の API の向き先（VITE_API_BASE の既定値と同じ） */
export const API_PREFIX = '/api'

export type AppOptions = {
  db: DbProvider
  log: Logger
  buildSha: string
  bodyLimitBytes?: number
  routes?: readonly Route[]
  /** /api/readyz が DB を待つ上限。Aurora の一時停止からの再開（15 秒ほど）より長くする */
  readyTimeoutMs?: number
  /** ログイン（server/auth.ts）。既定は誰でもよい（ローカルとテスト） */
  authenticate?: Authenticator
}

type Env = { Variables: { route: string } }

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${ms} ms で応答がありません`)), ms).unref())])

export function createApp({ db, log, buildSha, bodyLimitBytes = 1024 * 1024, routes = apiRoutes, readyTimeoutMs = 25_000, authenticate = async () => ({ kind: 'all' }) }: AppOptions) {
  const app = new Hono<Env>()

  // 1 リクエスト 1 行。ルートは形（/api/projects/:id）で出し、実際の ID やクエリ文字列は出さない
  app.use('*', async (c, next) => {
    const started = performance.now()
    await next()
    // API の応答は保存させない（利用者ごとのデータ）。ブラウザに中身の型を推測させない
    c.header('cache-control', 'no-store')
    c.header('x-content-type-options', 'nosniff')
    log.info({
      type: 'request',
      method: c.req.method,
      route: c.get('route') ?? 'unmatched',
      status: c.res.status,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
      build: buildSha,
    })
  })

  app.use(
    `${API_PREFIX}/*`,
    bodyLimit({ maxSize: bodyLimitBytes, onError: () => errorResponse(413, 'データが大きすぎます') }),
  )

  // デプロイの確認（next への smoke）と監視が呼ぶ。DB まで届くかを返す（認証はいらない。中身は返さない）
  app.get(`${API_PREFIX}/readyz`, async (c) => {
    c.set('route', `${API_PREFIX}/readyz`)
    try {
      await withTimeout(db.ping(), readyTimeoutMs)
      return c.json({ status: 'ok', build: buildSha })
    } catch (e) {
      log.warn({ type: 'readyz.failed', ...describeError(e), stack: undefined })
      return errorResponse(503, 'DB に接続できません')
    }
  })

  for (const route of routes) {
    const path = `${API_PREFIX}${route.path}`
    app.on(route.method, path, (c) => {
      c.set('route', path)
      // 認証（401）とメンバーへのつなぎ（403）の失敗は、respond が状態コードにする
      const access = (async () => accessFor(await authenticate(c.req.raw), async (p) => resolveAccess(await db.get(), p)))()
      // DB の準備に先に失敗して respond が access を待たなかったときに、捕まえられない失敗にしない
      access.catch(() => {})
      return respond(route, {
        db: db.get(),
        request: c.req.raw,
        params: c.req.param(),
        access,
        // 利用者には中身を見せず、ログにだけ残す（アラームは request の status で数える）
        onUnexpectedError: (e) => log.error({ type: 'route.error', route: path, ...describeError(e) }),
      })
    })
  }

  app.notFound(() => errorResponse(404, 'API が見つかりません'))
  app.onError((e) => {
    log.error({ type: 'unhandled', ...describeError(e) })
    return errorResponse(500, 'サーバーでエラーが発生しました')
  })
  return app
}
