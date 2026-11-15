import { authorizeUrl, codeExchangeBody, decodeJwtPayload, logoutUrl, parseTokenResponse, pkceChallenge, randomString, refreshBody, tokenEndpoint, type OidcConfig, type Tokens } from './oidc'

// ログインの状態（VITE_AUTH_MODE=cognito のビルドだけ。src/main.tsx と src/api/client.ts から使う）。
// - トークンはタブの sessionStorage に置く（タブを閉じれば消える。localStorage より盗まれたときの影響が小さい）
// - ID トークンの期限の 1 分前になったら、リフレッシュトークンで取り直す（同時に何本のリクエストが来ても 1 回）
// - 取り直せなければ、ログインの画面へ移る

const TOKENS = 'auth.tokens'
const PENDING = 'auth.pending'
export const CALLBACK_PATH = '/auth/callback'

type Pending = { state: string; verifier: string; returnTo: string }

export function oidcConfig(): OidcConfig {
  const domain = import.meta.env.VITE_COGNITO_DOMAIN
  const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID
  if (!domain || !clientId) throw new Error('VITE_COGNITO_DOMAIN と VITE_COGNITO_CLIENT_ID が要ります')
  return { domain, clientId, redirectUri: `${location.origin}${CALLBACK_PATH}`, logoutUri: `${location.origin}/` }
}

function read<T>(key: string): T | undefined {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : undefined
  } catch {
    return undefined
  }
}

const saveTokens = (t: Tokens) => sessionStorage.setItem(TOKENS, JSON.stringify(t))

let redirecting = false

/** ログインの画面へ移る。戻ってきたら returnTo を開く。同時に何度呼ばれても（401 が重なっても）移るのは 1 回 */
export async function login(returnTo = `${location.pathname}${location.search}`): Promise<void> {
  if (redirecting) return
  redirecting = true
  const config = oidcConfig()
  // 戻り先は自分のサイトのパスだけ（//other.example のような別のサイトにしない）
  const safe = returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.startsWith(CALLBACK_PATH) ? returnTo : '/'
  const pending: Pending = { state: randomString(), verifier: randomString(48), returnTo: safe }
  sessionStorage.setItem(PENDING, JSON.stringify(pending))
  location.assign(authorizeUrl(config, { state: pending.state, challenge: await pkceChallenge(pending.verifier) }))
}

async function postToken(config: OidcConfig, body: URLSearchParams) {
  const res = await fetch(tokenEndpoint(config), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  if (!res.ok) throw new Error(`トークンを取得できませんでした（HTTP ${res.status}）`)
  return res.json() as Promise<unknown>
}

/** /auth/callback に戻ってきたとき。state を確かめてコードをトークンに替え、開きたかった画面のパスを返す */
export async function handleCallback(url: URL = new URL(location.href)): Promise<string> {
  const pending = read<Pending>(PENDING)
  sessionStorage.removeItem(PENDING)
  const error = url.searchParams.get('error')
  if (error) throw new Error(`ログインできませんでした（${url.searchParams.get('error_description') ?? error}）`)
  const code = url.searchParams.get('code')
  // 別のタブや攻撃者が始めたログインの結果を受け取らない（CSRF）
  if (!pending || !code || url.searchParams.get('state') !== pending.state) throw new Error('ログインの手続きが正しくありません。もう一度ログインしてください')
  const config = oidcConfig()
  saveTokens(parseTokenResponse(await postToken(config, codeExchangeBody(config, code, pending.verifier)), Date.now()))
  return pending.returnTo
}

let refreshing: Promise<string | undefined> | undefined

/** API に付ける ID トークン。期限が近ければ取り直す。ログインしていなければ undefined */
export async function getIdToken(now = Date.now()): Promise<string | undefined> {
  const tokens = read<Tokens>(TOKENS)
  if (!tokens) return undefined
  if (tokens.expiresAt - 60_000 > now) return tokens.idToken
  if (!tokens.refreshToken) return undefined
  refreshing ??= (async () => {
    try {
      const config = oidcConfig()
      const next = parseTokenResponse(await postToken(config, refreshBody(config, tokens.refreshToken!)), Date.now(), tokens.refreshToken)
      saveTokens(next)
      return next.idToken
    } catch {
      sessionStorage.removeItem(TOKENS)
      return undefined
    } finally {
      refreshing = undefined
    }
  })()
  return refreshing
}

/** 起動のとき（src/main.tsx）。ログインできていれば true。ログインの画面へ移るときは false（画面は作らない） */
export async function ensureSession(): Promise<boolean> {
  if (location.pathname === CALLBACK_PATH) {
    const returnTo = await handleCallback()
    history.replaceState(null, '', returnTo)
    return true
  }
  if (await getIdToken()) return true
  await login()
  return false
}

export function logout(): void {
  const config = oidcConfig()
  sessionStorage.removeItem(TOKENS)
  location.assign(logoutUrl(config))
}

/** 画面の右上に出す（検証しない。表示だけ） */
export function currentUser(): { email?: string; name?: string } | undefined {
  const tokens = read<Tokens>(TOKENS)
  if (!tokens) return undefined
  const p = decodeJwtPayload(tokens.idToken)
  return { email: typeof p.email === 'string' ? p.email : undefined, name: typeof p.name === 'string' ? p.name : undefined }
}
