import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// ログインの状態（sessionStorage・トークンの交換と取り直し）。Cognito には問い合わせず、fetch を置き換える
const assign = vi.fn()
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'auth.example.com')
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'client-1')
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('location', { ...window.location, origin: 'https://app.example.com', pathname: '/projects/3', search: '?q=x', href: 'https://app.example.com/projects/3?q=x', assign })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
  assign.mockReset()
  fetchMock.mockReset()
})

const load = () => import('./session')
const tokenResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function loginAndCallback(code = 'code-1') {
  const s = await load()
  await s.login()
  const authorize = new URL(assign.mock.calls[0]![0] as string)
  const state = authorize.searchParams.get('state')!
  fetchMock.mockResolvedValueOnce(tokenResponse({ id_token: 'id-1', refresh_token: 'refresh-1', expires_in: 3600 }))
  const returnTo = await s.handleCallback(new URL(`https://app.example.com/auth/callback?code=${code}&state=${state}`))
  return { s, authorize, returnTo }
}

describe('ログイン', () => {
  test('ログインの画面へ移り、戻ってきたらコードをトークンに替えて、開きたかった画面に戻る', async () => {
    const { s, authorize, returnTo } = await loginAndCallback()
    expect(authorize.hostname).toBe('auth.example.com')
    expect(returnTo).toBe('/projects/3?q=x')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://auth.example.com/oauth2/token')
    const body = new URLSearchParams(init!.body as URLSearchParams)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    expect(await s.getIdToken()).toBe('id-1')
  })

  test('state が違う戻り（別のタブや、攻撃者が始めたログイン）は受け取らない', async () => {
    const s = await load()
    await s.login()
    await expect(s.handleCallback(new URL('https://app.example.com/auth/callback?code=c&state=forged'))).rejects.toThrow(/正しくありません/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await s.getIdToken()).toBeUndefined()
  })

  test('Cognito がエラーを返したら、その理由を出す', async () => {
    const s = await load()
    await expect(s.handleCallback(new URL('https://app.example.com/auth/callback?error=access_denied&error_description=User+is+disabled'))).rejects.toThrow(/User is disabled/)
  })

  test('戻り先は自分のサイトのパスだけ（別のサイトの URL にしない）', async () => {
    const s = await load()
    for (const evil of ['//evil.example/x', 'https://evil.example/', '/auth/callback?code=x']) {
      assign.mockReset()
      await s.login(evil)
      const state = new URL(assign.mock.calls[0]![0] as string).searchParams.get('state')!
      fetchMock.mockResolvedValueOnce(tokenResponse({ id_token: 'i', expires_in: 3600 }))
      expect(await s.handleCallback(new URL(`https://app.example.com/auth/callback?code=c&state=${state}`))).toBe('/')
    }
  })
})

describe('トークンの取り直し', () => {
  test('期限の 1 分前を過ぎたら、リフレッシュトークンで 1 回だけ取り直す（同時に呼んでも）', async () => {
    const { s } = await loginAndCallback()
    fetchMock.mockResolvedValueOnce(tokenResponse({ id_token: 'id-2', expires_in: 3600 }))
    const later = Date.now() + 3600_000 - 30_000
    const [a, b] = await Promise.all([s.getIdToken(later), s.getIdToken(later)])
    expect([a, b]).toEqual(['id-2', 'id-2'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new URLSearchParams(fetchMock.mock.calls[1]![1]!.body as URLSearchParams).get('refresh_token')).toBe('refresh-1')
  })

  test('取り直せなければ（リフレッシュトークンの期限切れ）ログインしていない扱いにする', async () => {
    const { s } = await loginAndCallback()
    fetchMock.mockResolvedValueOnce(tokenResponse({ error: 'invalid_grant' }, 400))
    expect(await s.getIdToken(Date.now() + 2 * 3600_000)).toBeUndefined()
    expect(sessionStorage.getItem('auth.tokens')).toBeNull()
  })

  test('ログアウトはトークンを消して Cognito の /logout へ移る', async () => {
    const { s } = await loginAndCallback()
    assign.mockReset()
    s.logout()
    expect(sessionStorage.getItem('auth.tokens')).toBeNull()
    expect(assign.mock.calls[0]![0]).toBe('https://auth.example.com/logout?client_id=client-1&logout_uri=https%3A%2F%2Fapp.example.com%2F')
  })
})
