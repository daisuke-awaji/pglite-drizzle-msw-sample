import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTestDb, type TestDb } from '../src/test/db'
import { members } from '../src/db/schema'
import { HttpError } from '../src/server/core'
import { createApp } from './app'
import type { Authenticator } from './auth'
import type { DbProvider } from './db'
import { memoryLogger } from './log'

// 本番の入口（Hono）を、メモリ上の PGlite につないで確かめる。
// ルートの中身は src/server の結合テストで確かめてあるので、ここでは「HTTP サーバーとして」の決まりを見る

let db: TestDb
beforeEach(async () => {
  db = await createTestDb()
})
afterEach(async () => {
  await db.$close()
})

const providerOf = (get: () => Promise<TestDb>): DbProvider => ({
  get,
  ping: async () => {
    await (await get()).execute('select 1')
  },
  close: async () => {},
})

function setup(provider: DbProvider = providerOf(async () => db)) {
  const { logger, lines } = memoryLogger()
  const app = createApp({ db: provider, log: logger, buildSha: 'abc1234', bodyLimitBytes: 2048, readyTimeoutMs: 200 })
  const call = (path: string, init?: RequestInit) => app.request(`http://api.test${path}`, init)
  return { app, call, lines }
}

describe('ルート', () => {
  test('src/server のルート表がそのまま /api の下に載る', async () => {
    const { call } = setup()
    const res = await call('/api/projects')
    expect(res.status).toBe(200)
    const projects = (await res.json()) as { name: string }[]
    expect(projects.length).toBeGreaterThan(0)

    const created = await call('/api/tags', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '新しいタグ' }) })
    expect(created.status).toBe(201)
  })

  test('ない API は JSON の 404。パスの ID が数字でなければ 400（MSW と同じ）', async () => {
    const { call } = setup()
    const missing = await call('/api/nothing')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'API が見つかりません' })
    expect((await call('/api/projects/abc')).status).toBe(400)
  })

  test('応答は保存させない。中身の型を推測させない', async () => {
    const { call } = setup()
    const res = await call('/api/tags')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('本文が上限を超えたら 413（大きな本文でメモリを使い切らない）', async () => {
    const { call } = setup()
    const res = await call('/api/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(4096) }),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'データが大きすぎます' })
  })
})

describe('ログ', () => {
  test('1 リクエスト 1 行。ルートは形で出し、ID やクエリ文字列は出さない', async () => {
    const { call, lines } = setup()
    await call('/api/projects/1?q=秘密の検索語')
    const line = lines.find((l) => l.type === 'request')!
    expect(line).toMatchObject({ level: 'info', method: 'GET', route: '/api/projects/:id', status: 200, build: 'abc1234' })
    expect(typeof line.durationMs).toBe('number')
    expect(JSON.stringify(lines)).not.toContain('秘密の検索語')
  })

  test('どのルートにも当たらないものは unmatched', async () => {
    const { call, lines } = setup()
    await call('/api/nothing/123')
    expect(lines.find((l) => l.type === 'request')).toMatchObject({ route: 'unmatched', status: 404 })
  })
})

describe('DB につながらないとき', () => {
  const broken = providerOf(() => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:5432')))

  test('readyz は 503。API は中身を隠した 500', async () => {
    const { call, lines } = setup(broken)
    const ready = await call('/api/readyz')
    expect(ready.status).toBe(503)
    expect(await ready.json()).toEqual({ error: 'DB に接続できません' })

    const res = await call('/api/projects')
    expect(res.status).toBe(500)
    const body = JSON.stringify(await res.json())
    expect(body).not.toContain('10.0.0.1')
    expect(lines.find((l) => l.type === 'readyz.failed')).toMatchObject({ level: 'warn', message: expect.stringContaining('ECONNREFUSED') })
    // 想定外の例外は、ルートの形とスタックトレースを付けてサーバーのログにだけ残す
    expect(lines.find((l) => l.type === 'route.error')).toMatchObject({ level: 'error', route: '/api/projects', stack: expect.any(String) })
  })

  test('readyz は DB を待ちすぎない（決めた時間で 503）', async () => {
    const hanging = providerOf(() => new Promise(() => {}))
    const { call } = setup(hanging)
    const started = Date.now()
    expect((await call('/api/readyz')).status).toBe(503)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('つながれば readyz は 200 とビルドの SHA', async () => {
    const { call } = setup()
    const res = await call('/api/readyz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', build: 'abc1234' })
  })
})

// 本物の検証は server/auth.test.ts。ここでは「Bearer の値をメールアドレスとみなす」置き換えで、サーバー層へのつなぎ方を確かめる
const fakeAuthenticator: Authenticator = async (request) => {
  const email = request.headers.get('authorization')?.replace(/^Bearer /, '')
  if (!email) throw new HttpError(401, 'ログインが必要です')
  return { kind: 'principal', principal: { email, admin: false } }
}

function authApp() {
  const app = createApp({ db: providerOf(async () => db), log: memoryLogger().logger, buildSha: 'abc1234', authenticate: fakeAuthenticator })
  return (path: string, email?: string) => app.request(`http://api.test${path}`, { headers: email ? { authorization: `Bearer ${email}` } : {} })
}

describe('ログイン（Phase 4）', () => {
  test('トークンがなければ 401。readyz はログインなしで呼べる（デプロイの確認と監視）', async () => {
    const call = authApp()
    const res = await call('/api/projects')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'ログインが必要です' })
    expect((await call('/api/readyz')).status).toBe(200)
  })

  test('メンバーとして登録されていないメールアドレスは 403', async () => {
    expect((await authApp()('/api/projects', 'stranger@example.com')).status).toBe(403)
  })

  test('メンバーは自分のプロジェクトだけが見える。ほかのプロジェクトは 404', async () => {
    const [member] = await db.select().from(members).limit(1)
    const call = authApp()
    const mine = (await (await call('/api/projects', member!.email)).json()) as { id: number }[]
    const all = (await (await setup().call('/api/projects')).json()) as { id: number }[]
    expect(mine.length).toBeLessThan(all.length)
    const hidden = all.find((p) => !mine.some((m) => m.id === p.id))!
    expect((await call(`/api/projects/${hidden.id}`, member!.email)).status).toBe(404)
  })
})
