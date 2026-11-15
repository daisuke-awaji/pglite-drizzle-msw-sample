import { CognitoJwtVerifier } from 'aws-jwt-verify'
import type { Jwks } from 'aws-jwt-verify/jwk'
import { ALL, type Access, type Principal } from '../src/server/access'
import { HttpError } from '../src/server/core'
import type { AuthConfig } from './config'

// ログイン（Phase 4）。画面は Cognito の ID トークンを Authorization: Bearer で送る（src/auth）。
// CloudFront の OAC（always-amz-auth）は利用者の Authorization をそのまま渡し、Lambda は AWS の署名（AWS4-）だけを外す。
// - ID トークン（token_use=id）だけを受け付け、発行元（User Pool）と宛先（クライアント ID）と期限を確かめる
// - メールアドレスが確認済みであること（メンバーとはメールアドレスでつなぐ。src/server/access.ts）
// - 署名の鍵（JWKS）はデプロイのときに読んで環境変数で渡す（Web Function の外向きの通信は VPC を通り、インターネットに出ない）

/** 誰でもよい（AUTH_MODE=none。dev とローカルだけ）か、ログインした人か */
export type Authenticated = { kind: 'all' } | { kind: 'principal'; principal: Principal }

export type Authenticator = (request: Request) => Promise<Authenticated>

export const unauthorized = (message = 'ログインが必要です') => new HttpError(401, message)

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization')
  const match = header ? /^Bearer\s+([A-Za-z0-9_\-.]+)$/.exec(header.trim()) : null
  return match?.[1]
}

export function createAuthenticator(auth: AuthConfig & { jwks?: string }): Authenticator {
  if (auth.mode === 'none') return async () => ({ kind: 'all' })
  const verifier = CognitoJwtVerifier.create({ userPoolId: auth.userPoolId, clientId: auth.clientId, tokenUse: 'id' })
  if (auth.jwks) verifier.cacheJwks(JSON.parse(auth.jwks) as Jwks)
  return async (request) => {
    const token = bearerToken(request)
    if (!token) throw unauthorized()
    let payload: Awaited<ReturnType<typeof verifier.verify>>
    try {
      payload = await verifier.verify(token)
    } catch {
      // 期限切れ・別の User Pool・別のクライアント・アクセストークン・改ざん。中身は返さない
      throw unauthorized('ログインし直してください')
    }
    const email = payload.email
    if (typeof email !== 'string' || email === '') throw unauthorized('ログインし直してください')
    if (payload.email_verified !== true) throw new HttpError(403, 'メールアドレスが確認されていません')
    const groups = Array.isArray(payload['cognito:groups']) ? (payload['cognito:groups'] as unknown[]) : []
    return { kind: 'principal', principal: { email, admin: groups.includes(auth.adminGroup) } }
  }
}

/** 認証の結果を、サーバー層の Access にする（メンバーとのつなぎは DB を読む） */
export async function accessFor(authenticated: Authenticated, resolve: (p: Principal) => Promise<Access>): Promise<Access> {
  return authenticated.kind === 'all' ? ALL : resolve(authenticated.principal)
}
