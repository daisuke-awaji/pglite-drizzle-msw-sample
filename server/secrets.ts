import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'

/** RDS が使う形の秘密情報（Aurora の管理者も、CDK が作るアプリ用・マイグレーション用も同じ形） */
export type DbSecret = { username: string; password: string; host: string; port: number; dbname: string }

export type SecretSource = (secretArn: string) => Promise<string>

let client: SecretsManagerClient | undefined

/** 既定の読み方。Lambda の中では実行ロールの資格情報で、VPC endpoint を通って読む */
export const readFromSecretsManager: SecretSource = async (secretArn) => {
  client ??= new SecretsManagerClient({})
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretArn }))
  if (!out.SecretString) throw new Error(`秘密情報に文字列がありません: ${secretArn}`)
  return out.SecretString
}

export function parseDbSecret(raw: string, secretArn: string): DbSecret {
  let v: Partial<Record<keyof DbSecret, unknown>>
  try {
    v = JSON.parse(raw) as typeof v
  } catch {
    throw new Error(`秘密情報が JSON ではありません: ${secretArn}`)
  }
  const port = Number(v.port ?? 5432)
  if (typeof v.username !== 'string' || typeof v.password !== 'string' || typeof v.host !== 'string' || !Number.isInteger(port)) {
    throw new Error(`秘密情報に username / password / host / port がありません: ${secretArn}`)
  }
  return { username: v.username, password: v.password, host: v.host, port, dbname: typeof v.dbname === 'string' ? v.dbname : 'app' }
}

/**
 * 秘密情報を一定時間だけ使い回す。
 * - 実行環境ごとに 1 回読めばよく、毎回の接続で Secrets Manager を呼ばない（呼び出しの数と遅さを抑える）
 * - ローテーションのあとは、認証の失敗（28P01）で invalidate() を呼んで読み直す（docs/production.md「秘密情報のローテーション」）
 * - 同時に何本の接続が読みに来ても、読むのは 1 回にする
 */
export function cachedSecret(secretArn: string, { source = readFromSecretsManager, ttlMs = 60 * 60 * 1000, now = Date.now } = {}) {
  let cached: { value: Promise<DbSecret>; at: number } | undefined
  return {
    get(): Promise<DbSecret> {
      if (!cached || now() - cached.at > ttlMs) {
        const value = source(secretArn).then((raw) => parseDbSecret(raw, secretArn))
        cached = { value, at: now() }
        // 失敗した読み取りは使い回さない（次の接続で読み直す）
        value.catch(() => {
          if (cached?.value === value) cached = undefined
        })
      }
      return cached.value
    },
    invalidate() {
      cached = undefined
    },
  }
}
