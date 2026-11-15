import { createSign, generateKeyPairSync } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { createAuthenticator } from './auth'

// ID トークンの検証を、手元で作った鍵（JWKS）で確かめる（Cognito には問い合わせない）
const userPoolId = 'ap-northeast-1_TestPool1'
const clientId = 'client-abc'
const issuer = `https://cognito-idp.ap-northeast-1.amazonaws.com/${userPoolId}`

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const kid = 'test-key-1'
const jwks = JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] })

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
function sign(claims: Record<string, unknown>, { key = privateKey, keyId = kid } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const body = `${b64({ alg: 'RS256', kid: keyId, typ: 'JWT' })}.${b64({ iss: issuer, aud: clientId, token_use: 'id', sub: 'u-1', email: 'Yamada@Example.com', email_verified: true, iat: now, exp: now + 3600, auth_time: now, ...claims })}`
  return `${body}.${createSign('RSA-SHA256').update(body).sign(key).toString('base64url')}`
}

const auth = createAuthenticator({ mode: 'cognito', userPoolId, clientId, adminGroup: 'admin', jwks })
const call = (token?: string, scheme = 'Bearer') => auth(new Request('https://api.test/api/projects', { headers: token ? { authorization: `${scheme} ${token}` } : {} }))
const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status)

describe('ID トークンの検証', () => {
  test('正しい ID トークンなら、メールアドレスと管理者かどうかを返す', async () => {
    expect(await call(sign({}))).toEqual({ kind: 'principal', principal: { email: 'Yamada@Example.com', admin: false } })
    expect(await call(sign({ 'cognito:groups': ['admin'] }))).toEqual({ kind: 'principal', principal: { email: 'Yamada@Example.com', admin: true } })
  })

  test.each([
    ['ヘッダーがない', () => call()],
    ['Bearer でない', () => call(sign({}), 'Basic')],
    ['期限切れ', () => call(sign({ exp: Math.floor(Date.now() / 1000) - 60 }))],
    ['別のクライアント向け', () => call(sign({ aud: 'other-client' }))],
    ['別の User Pool が発行した', () => call(sign({ iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_Other' }))],
    ['アクセストークン（ID トークンだけを受け付ける）', () => call(sign({ token_use: 'access', client_id: clientId }))],
    ['知らない鍵で署名した', () => call(sign({}, { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }))],
    ['中身を書き換えた', () => {
      const [h, , s] = sign({}).split('.')
      return call(`${h}.${b64({ iss: issuer, aud: clientId, token_use: 'id', email: 'admin@example.com', email_verified: true, exp: 9e9, 'cognito:groups': ['admin'] })}.${s}`)
    }],
    ['メールアドレスがない', () => call(sign({ email: undefined }))],
  ])('%s → 401', async (_, run) => {
    expect(await status(run())).toBe(401)
  })

  test('メールアドレスが確認されていなければ 403', async () => {
    expect(await status(call(sign({ email_verified: false })))).toBe(403)
  })

  test('AUTH_MODE=none は誰でもよい（dev とローカルだけ。prod では設定で止める）', async () => {
    expect(await createAuthenticator({ mode: 'none' })(new Request('https://api.test/'))).toEqual({ kind: 'all' })
  })
})
