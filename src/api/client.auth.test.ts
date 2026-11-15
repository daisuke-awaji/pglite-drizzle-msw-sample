import { afterEach, describe, expect, test, vi } from 'vitest'

// ログインするビルド（VITE_AUTH_MODE=cognito）の API クライアント。ID トークンを付け、401 ならログインし直す
const getIdToken = vi.fn<() => Promise<string | undefined>>()
const login = vi.fn<() => Promise<void>>()
vi.mock('../auth/session', () => ({ getIdToken, login }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
  getIdToken.mockReset()
  login.mockReset()
})

async function clientWith(mode: string | undefined, response: Response) {
  if (mode) vi.stubEnv('VITE_AUTH_MODE', mode)
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  const { api } = await import('./client')
  return { api, fetchMock }
}

describe('ログインするビルドの API クライアント', () => {
  test('ID トークンを Authorization: Bearer で付ける', async () => {
    getIdToken.mockResolvedValue('id-token-1')
    const { api, fetchMock } = await clientWith('cognito', Response.json([]))
    await api.listTags()
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer id-token-1')
  })

  test('401 が返ったらログインし直す（いまの画面に戻る）', async () => {
    getIdToken.mockResolvedValue('expired')
    const { api } = await clientWith('cognito', Response.json({ error: 'ログインし直してください' }, { status: 401 }))
    await expect(api.listTags()).rejects.toMatchObject({ status: 401, message: 'ログインし直してください' })
    expect(login).toHaveBeenCalledTimes(1)
  })

  test('モックのビルドでは何も付けない（ログインもしない）', async () => {
    const { api, fetchMock } = await clientWith(undefined, Response.json({ error: 'x' }, { status: 401 }))
    await expect(api.listTags()).rejects.toMatchObject({ status: 401 })
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBeUndefined()
    expect(getIdToken).not.toHaveBeenCalled()
    expect(login).not.toHaveBeenCalled()
  })
})
