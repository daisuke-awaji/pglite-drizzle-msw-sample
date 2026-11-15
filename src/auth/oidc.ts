// OpenID Connect の認可コード + PKCE（RFC 7636）。Cognito のマネージドログインと話すための純粋な関数だけを置く。
// ブラウザで動く公開クライアントなので、クライアントの秘密は持たない（infra/lib/auth.ts の generateSecret: false）

export type OidcConfig = {
  /** Cognito のドメイン（<prefix>.auth.<region>.amazoncognito.com） */
  domain: string
  clientId: string
  redirectUri: string
  logoutUri: string
  scope?: string
}

export type Tokens = { idToken: string; refreshToken?: string; expiresAt: number }

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

/** 推測できない文字列（state と code_verifier）。43 文字以上（RFC 7636） */
export function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** code_challenge = BASE64URL(SHA-256(code_verifier)) */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

export function authorizeUrl(config: OidcConfig, { state, challenge }: { state: string; challenge: string }): string {
  const url = new URL(`https://${config.domain}/oauth2/authorize`)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scope ?? 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()
  return url.toString()
}

export function logoutUrl(config: OidcConfig): string {
  const url = new URL(`https://${config.domain}/logout`)
  url.search = new URLSearchParams({ client_id: config.clientId, logout_uri: config.logoutUri }).toString()
  return url.toString()
}

export const tokenEndpoint = (config: OidcConfig) => `https://${config.domain}/oauth2/token`

export function codeExchangeBody(config: OidcConfig, code: string, verifier: string): URLSearchParams {
  return new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId, code, redirect_uri: config.redirectUri, code_verifier: verifier })
}

export function refreshBody(config: OidcConfig, refreshToken: string): URLSearchParams {
  return new URLSearchParams({ grant_type: 'refresh_token', client_id: config.clientId, refresh_token: refreshToken })
}

/** トークンエンドポイントの応答。リフレッシュでは refresh_token が返らないので、前のものを使い続ける */
export function parseTokenResponse(body: unknown, now: number, previousRefresh?: string): Tokens {
  const b = body as { id_token?: unknown; refresh_token?: unknown; expires_in?: unknown } | null
  if (typeof b?.id_token !== 'string' || typeof b.expires_in !== 'number') throw new Error('トークンの応答が正しくありません')
  return {
    idToken: b.id_token,
    refreshToken: typeof b.refresh_token === 'string' ? b.refresh_token : previousRefresh,
    expiresAt: now + b.expires_in * 1000,
  }
}

/** 画面に名前を出すためだけに中身を読む（検証はしない。検証は API がする: server/auth.ts） */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1]
  if (!part) return {}
  try {
    const json = atob(part.replaceAll('-', '+').replaceAll('_', '/'))
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0)))) as Record<string, unknown>
  } catch {
    return {}
  }
}
