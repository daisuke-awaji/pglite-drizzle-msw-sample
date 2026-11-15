import { describe, expect, test } from 'vitest'
import { authorizeUrl, codeExchangeBody, decodeJwtPayload, logoutUrl, parseTokenResponse, pkceChallenge, randomString } from './oidc'

const config = { domain: 'tasks-stg.auth.ap-northeast-1.amazoncognito.com', clientId: 'client-1', redirectUri: 'https://app.example.com/auth/callback', logoutUri: 'https://app.example.com/' }

describe('PKCE', () => {
  test('RFC 7636 の付録 B の例と同じ code_challenge になる', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  test('ランダムな値は 43 文字以上で、毎回違う（URL に使える文字だけ）', () => {
    const a = randomString()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    expect(randomString()).not.toBe(a)
  })
})

describe('URL と本文', () => {
  test('認可の URL は認可コード + S256。スコープは openid email profile', () => {
    const url = new URL(authorizeUrl(config, { state: 's1', challenge: 'c1' }))
    expect(url.origin + url.pathname).toBe('https://tasks-stg.auth.ap-northeast-1.amazoncognito.com/oauth2/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: 'https://app.example.com/auth/callback',
      scope: 'openid email profile',
      state: 's1',
      code_challenge: 'c1',
      code_challenge_method: 'S256',
    })
  })

  test('コードの交換には code_verifier を付け、クライアントの秘密は送らない', () => {
    expect(Object.fromEntries(codeExchangeBody(config, 'code-1', 'v1'))).toEqual({ grant_type: 'authorization_code', client_id: 'client-1', code: 'code-1', redirect_uri: 'https://app.example.com/auth/callback', code_verifier: 'v1' })
  })

  test('ログアウトは Cognito の /logout に、戻り先を付けて移る', () => {
    expect(logoutUrl(config)).toBe('https://tasks-stg.auth.ap-northeast-1.amazoncognito.com/logout?client_id=client-1&logout_uri=https%3A%2F%2Fapp.example.com%2F')
  })
})

describe('トークン', () => {
  test('期限は受け取った時刻 + expires_in。リフレッシュでは前のリフレッシュトークンを使い続ける', () => {
    expect(parseTokenResponse({ id_token: 'i', refresh_token: 'r', expires_in: 3600 }, 1000)).toEqual({ idToken: 'i', refreshToken: 'r', expiresAt: 3_601_000 })
    expect(parseTokenResponse({ id_token: 'i2', expires_in: 60 }, 0, 'r')).toEqual({ idToken: 'i2', refreshToken: 'r', expiresAt: 60_000 })
    expect(() => parseTokenResponse({ error: 'invalid_grant' }, 0)).toThrow(/正しくありません/)
  })

  test('表示用に中身を読む（日本語の名前も）。壊れていたら空', () => {
    const payload = Buffer.from(JSON.stringify({ email: 'a@example.com', name: '山田 花子' })).toString('base64url')
    expect(decodeJwtPayload(`h.${payload}.s`)).toEqual({ email: 'a@example.com', name: '山田 花子' })
    expect(decodeJwtPayload('broken')).toEqual({})
  })
})
