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

  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
  beforeEach(async () => {
    ctx.db = await createTestDb()
    server.resetHandlers(...createHandlers({ getDb: async () => ctx.db, getLatency: () => 0 }))
  })
  afterEach(async () => {
    server.resetHandlers()
    await ctx.db.$client.close()
  })
  afterAll(() => server.close())
  return ctx
}
