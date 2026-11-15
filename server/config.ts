// 環境変数からサーバーの設定を読む。読み方を 1 か所に集め、足りない・おかしい値は起動時に分かるようにする。
// 値そのもの（パスワードなど）は環境変数に置かない。Secrets Manager の ARN だけを置く（docs/production.md「設計の判断」）

export type AuthConfig =
  | { mode: 'none' }
  | { mode: 'cognito'; userPoolId: string; clientId: string; adminGroup: string }

export type DbConfig =
  /** ローカルとテスト: 接続文字列をそのまま使う */
  | { kind: 'url'; url: string; ssl: SslMode }
  /** AWS: Secrets Manager の秘密情報（RDS の形式: username / password / host / port / dbname）から作る */
  | { kind: 'secret'; secretArn: string; ssl: SslMode }

/** verify-full: RDS の CA で証明書とホスト名を確かめる。disable: 暗号化しない（ローカルだけ） */
export type SslMode = 'verify-full' | 'disable'

export type ServerConfig = {
  /** dev / stg / prod / local。prod では認証なしを許さない */
  appEnv: string
  /** Lambda が渡す listen 先（host:port）。ローカルでは 127.0.0.1:3000 */
  listen: { hostname: string; port: number }
  buildSha: string
  db: DbConfig & {
    poolMax: number
    /** 自動で一時停止した Aurora は戻るまで 15 秒ほどかかるので、それより長くする */
    connectTimeoutMs: number
    /** 使っていない接続を閉じるまで */
    idleTimeoutMs: number
  }
  auth: AuthConfig
  /** 1 つのリクエストの本文の上限（バイト） */
  bodyLimitBytes: number
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

type Env = Readonly<Record<string, string | undefined>>

/** `host:port`。IPv6 は `[::1]:8080` の形で来る */
export function parseListen(value: string | undefined): { hostname: string; port: number } {
  const raw = value?.trim() || '127.0.0.1:3000'
  const i = raw.lastIndexOf(':')
  const host = i > 0 ? raw.slice(0, i) : ''
  const port = Number(raw.slice(i + 1))
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`AWS_LAMBDA_HTTP_ENDPOINT が host:port の形ではありません: ${raw}`)
  }
  return { hostname: host.replace(/^\[(.*)\]$/, '$1'), port }
}

function int(env: Env, name: string, fallback: number, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} は ${min}〜${max} の整数にしてください: ${raw}`)
  return n
}

function sslMode(env: Env, fallback: SslMode): SslMode {
  const raw = env.DB_SSL ?? fallback
  if (raw !== 'verify-full' && raw !== 'disable') throw new ConfigError(`DB_SSL は verify-full か disable にしてください: ${raw}`)
  return raw
}

export function readAuthConfig(env: Env, appEnv: string): AuthConfig {
  const mode = env.AUTH_MODE ?? (appEnv === 'local' ? 'none' : 'cognito')
  if (mode === 'none') {
    // 認証なしで本番のデータを公開しない（docs/production.md「設計の判断」の注意）
    if (appEnv === 'prod') throw new ConfigError('prod では AUTH_MODE=none にできません')
    return { mode: 'none' }
  }
  if (mode !== 'cognito') throw new ConfigError(`AUTH_MODE は none か cognito にしてください: ${mode}`)
  const userPoolId = env.COGNITO_USER_POOL_ID
  const clientId = env.COGNITO_CLIENT_ID
  if (!userPoolId || !clientId) throw new ConfigError('AUTH_MODE=cognito には COGNITO_USER_POOL_ID と COGNITO_CLIENT_ID が要ります')
  return { mode: 'cognito', userPoolId, clientId, adminGroup: env.COGNITO_ADMIN_GROUP || 'admin' }
}

export function readConfig(env: Env): ServerConfig {
  const appEnv = env.APP_ENV || 'local'
  let db: DbConfig
  if (env.DATABASE_URL) {
    db = { kind: 'url', url: env.DATABASE_URL, ssl: sslMode(env, 'disable') }
  } else if (env.DB_SECRET_ARN) {
    db = { kind: 'secret', secretArn: env.DB_SECRET_ARN, ssl: sslMode(env, 'verify-full') }
  } else {
    throw new ConfigError('DATABASE_URL（ローカル）か DB_SECRET_ARN（AWS）のどちらかが要ります')
  }
  if (appEnv !== 'local' && db.ssl === 'disable') throw new ConfigError(`${appEnv} では DB_SSL=disable にできません`)
  return {
    appEnv,
    listen: parseListen(env.AWS_LAMBDA_HTTP_ENDPOINT),
    buildSha: env.BUILD_SHA || 'local',
    db: {
      ...db,
      poolMax: int(env, 'DB_POOL_MAX', 10, { max: 100 }),
      connectTimeoutMs: int(env, 'DB_CONNECT_TIMEOUT_MS', 20_000, { min: 1000, max: 60_000 }),
      idleTimeoutMs: int(env, 'DB_IDLE_TIMEOUT_MS', 30_000, { min: 1000 }),
    },
    auth: readAuthConfig(env, appEnv),
    bodyLimitBytes: int(env, 'BODY_LIMIT_BYTES', 1024 * 1024, { min: 1024 }),
  }
}
