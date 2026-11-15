import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { createHandlers } from '../mocks/handlers'
import { createTestDb, type TestDb } from './db'

/**
 * 本物の API クライアント（fetch）→ MSW のハンドラー → src/server → PGlite を、そのままつないだ環境を作る。
 * テストごとに DB を複製し直すので、ほかのテストの書き込みは見えない。
 *
 * - `ctx.db` で DB を直接読める（API を通さずに状態を確かめたいとき）
 * - `ctx.server.use(...)` で、そのテストだけ応答を差し替えられる（終わると元に戻る）
 */
export function setupTestApi() {
  const server = setupServer()
  const ctx = { server } as { server: typeof server; db: TestDb }

  // 処理中のリクエストを数える。テストの最後に画面を外しても、送信済みのリクエストは走り続けるので、
  // 終わるのを待ってから DB を閉じる（待たないと、次のテストで「閉じた DB への問い合わせ」が失敗して見える）
  const inFlight = { count: 0 }
  server.events.on('request:start', () => {
    inFlight.count++
  })
  server.events.on('request:end', () => {
    inFlight.count--
  })
  async function drain(timeout = 5000) {
    const until = Date.now() + timeout
    while (inFlight.count > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
  }

  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
  beforeEach(async () => {
    ctx.db = await createTestDb()
    server.resetHandlers(...createHandlers({ getDb: async () => ctx.db, getLatency: () => 0 }))
  })
  afterEach(async () => {
    await drain()
    server.resetHandlers()
    await ctx.db.$client.close()
  })
  afterAll(() => server.close())
  return ctx
}
