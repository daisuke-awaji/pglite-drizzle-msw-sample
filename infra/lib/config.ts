// 環境ごとの値（docs/production.md「環境」の表）。案件ごとに変える値（ドメイン・通知先・IP の制限など）は
// cdk.json の context（または -c）で渡す。値は最初の目安で、負荷試験（scripts/load-test.mjs）のあとで見直す

export type EnvName = 'dev' | 'stg' | 'prod'

export type EnvConfig = {
  name: EnvName
  account: string
  region: string
  /** GitHub Environments の名前（OIDC の信頼ポリシーの sub に入る） */
  githubEnvironment: string
  aurora: {
    minAcu: number
    maxAcu: number
    /** 別の AZ に置く Reader（フェイルオーバー先）の数 */
    readers: number
    /** 0 ACU で一時停止するまで（minAcu が 0 のとき） */
    autoPauseMinutes?: number
    backupRetentionDays: number
    /** AWS Backup で月に 1 回とり、1 年残す */
    monthlyBackup: boolean
  }
  api: {
    /** Web Function の実行環境の上限（endpoint の scalingConfig.maxEnvironments） */
    maxEnvironments: number
    /** 1 つの実行環境あたりの接続プールの上限 */
    poolMax: number
    timeoutSeconds: number
    maxConcurrencyPerEnvironment: number
  }
  /** prod: live の 10% を 10 分流してから 100% にする */
  canary: boolean
  deletionProtection: boolean
  logRetentionDays: number
  waf: {
    /** count: 数えるだけ（最初の 2 週間、誤検知を見る）。block: 止める */
    mode: 'count' | 'block'
    /** IP ごとの 5 分間のリクエスト数の上限 */
    ratePer5Minutes: number
    /** 指定したら、この CIDR 以外からのアクセスを止める（認証の前に本番のデータを載せるとき） */
    allowedCidrs: string[]
  }
  /** 独自ドメイン。なければ CloudFront のドメイン（*.cloudfront.net）で配る */
  domain?: { name: string; hostedZoneId: string; hostedZoneName: string }
  monitoring: {
    /** アラームを送るメール（任意） */
    alarmEmail?: string
    /** Amazon Q Developer in chat applications（Slack）。ワークスペースの登録は先にコンソールで済ませる */
    slack?: { workspaceId: string; channelId: string }
    /** AWS Budgets の月の予算（USD） */
    monthlyBudgetUsd: number
  }
  auth: {
    /** none は dev だけ（prod では作れない） */
    mode: 'cognito' | 'none'
    /** Cognito のドメインの接頭辞（<prefix>.auth.<region>.amazoncognito.com）。アカウントをまたいで一意にする */
    domainPrefix: string
    /** 自分で登録できるか（既定は管理者が招待する） */
    selfSignUp: boolean
    /** MFA を必須にするか */
    mfaRequired: boolean
  }
}

export type AppConfig = {
  /** 名前の頭に付ける（同じアカウントに複数のアプリを置くとき） */
  app: string
  /** owner/repo。OIDC で、このリポジトリの GitHub Actions だけがデプロイできるようにする */
  githubRepository: string
  /** すでにアカウントにある GitHub の OIDC ID プロバイダーの ARN（1 アカウントに 1 つしか作れない） */
  githubOidcProviderArn?: string
  envs: Record<EnvName, EnvConfig>
}

const base = (name: EnvName, account: string): Pick<EnvConfig, 'name' | 'account' | 'region'> => ({ name, account, region: 'ap-northeast-1' })

/**
 * 既定の値。account は context（-c account.dev=111122223333）から渡す。
 * 渡さないと 000000000000 になり、synth とテストはできるが deploy はできない
 */
export function defaultConfig(ctx: (key: string) => unknown = () => undefined): AppConfig {
  const str = (key: string) => {
    const v = ctx(key)
    return typeof v === 'string' && v !== '' ? v : undefined
  }
  const list = (key: string) => {
    const v = ctx(key)
    if (Array.isArray(v)) return v.map(String)
    return typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []
  }
  const domain = (env: EnvName) => {
    const name = str(`domain.${env}`)
    if (!name) return undefined
    const hostedZoneId = str(`hostedZoneId.${env}`)
    const hostedZoneName = str(`hostedZoneName.${env}`)
    if (!hostedZoneId || !hostedZoneName) throw new Error(`domain.${env} には hostedZoneId.${env} と hostedZoneName.${env} も要ります`)
    return { name, hostedZoneId, hostedZoneName }
  }
  const slack = (env: EnvName) => {
    const workspaceId = str(`slackWorkspaceId.${env}`) ?? str('slackWorkspaceId')
    const channelId = str(`slackChannelId.${env}`)
    return workspaceId && channelId ? { workspaceId, channelId } : undefined
  }
  const account = (env: EnvName) => str(`account.${env}`) ?? '000000000000'
  const app = str('app') ?? 'tasks'
  const monitoring = (env: EnvName, monthlyBudgetUsd: number) => ({ alarmEmail: str(`alarmEmail.${env}`), slack: slack(env), monthlyBudgetUsd })

  return {
    app,
    githubRepository: str('githubRepository') ?? 'daisuke-awaji/pglite-drizzle-msw-sample',
    githubOidcProviderArn: str('githubOidcProviderArn'),
    envs: {
      dev: {
        ...base('dev', account('dev')),
        githubEnvironment: 'development',
        aurora: { minAcu: 0, maxAcu: 4, readers: 0, autoPauseMinutes: 10, backupRetentionDays: 1, monthlyBackup: false },
        api: { maxEnvironments: 2, poolMax: 5, timeoutSeconds: 30, maxConcurrencyPerEnvironment: 64 },
        canary: false,
        deletionProtection: false,
        logRetentionDays: 7,
        waf: { mode: 'count', ratePer5Minutes: 2000, allowedCidrs: list('allowedCidrs.dev') },
        domain: domain('dev'),
        monitoring: monitoring('dev', 100),
        auth: { mode: str('authMode.dev') === 'none' ? 'none' : 'cognito', domainPrefix: str('cognitoDomainPrefix.dev') ?? `${app}-dev-${account('dev')}`, selfSignUp: false, mfaRequired: false },
      },
      stg: {
        ...base('stg', account('stg')),
        githubEnvironment: 'staging',
        aurora: { minAcu: 0, maxAcu: 8, readers: 0, autoPauseMinutes: 30, backupRetentionDays: 7, monthlyBackup: false },
        api: { maxEnvironments: 5, poolMax: 10, timeoutSeconds: 30, maxConcurrencyPerEnvironment: 64 },
        canary: false,
        deletionProtection: true,
        logRetentionDays: 30,
        waf: { mode: 'count', ratePer5Minutes: 2000, allowedCidrs: list('allowedCidrs.stg') },
        domain: domain('stg'),
        monitoring: monitoring('stg', 300),
        auth: { mode: 'cognito', domainPrefix: str('cognitoDomainPrefix.stg') ?? `${app}-stg-${account('stg')}`, selfSignUp: false, mfaRequired: false },
      },
      prod: {
        ...base('prod', account('prod')),
        githubEnvironment: 'production',
        aurora: { minAcu: 1, maxAcu: 16, readers: 1, backupRetentionDays: 35, monthlyBackup: true },
        api: { maxEnvironments: 20, poolMax: 10, timeoutSeconds: 30, maxConcurrencyPerEnvironment: 64 },
        canary: true,
        deletionProtection: true,
        logRetentionDays: 90,
        // 最初の 2 週間は数えるだけにして誤検知を見る。見終わったら -c wafMode.prod=block にする
        waf: { mode: str('wafMode.prod') === 'block' ? 'block' : 'count', ratePer5Minutes: 2000, allowedCidrs: list('allowedCidrs.prod') },
        domain: domain('prod'),
        monitoring: monitoring('prod', 1000),
        auth: { mode: 'cognito', domainPrefix: str('cognitoDomainPrefix.prod') ?? `${app}-prod-${account('prod')}`, selfSignUp: false, mfaRequired: true },
      },
    },
  }
}

/**
 * Aurora Serverless v2 の max_connections の目安。最大 ACU（1 ACU = 2 GiB）のメモリから決まる
 * （LEAST(DBInstanceClassMemory / 9531392, 5000)）。構築したら SHOW max_connections で確かめる
 */
export const auroraMaxConnections = (maxAcu: number) => Math.min(Math.floor((maxAcu * 2 * 1024 ** 3) / 9531392), 5000)

/** migrate（1）と運用（調べ物・ローテーション）に残しておく接続 */
export const RESERVED_CONNECTIONS = 6

/** 実行環境の上限 × プールの上限 + 予備が、max_connections の 8 割を超えないこと（docs/production.md「環境」） */
export function connectionBudget(env: EnvConfig) {
  const used = env.api.maxEnvironments * env.api.poolMax + RESERVED_CONNECTIONS
  const limit = Math.floor(auroraMaxConnections(env.aurora.maxAcu) * 0.8)
  return { used, limit, ok: used <= limit }
}

export function validate(config: AppConfig): void {
  for (const env of Object.values(config.envs)) {
    const budget = connectionBudget(env)
    if (!budget.ok) {
      throw new Error(`${env.name}: 接続数 ${budget.used}（maxEnvironments × poolMax + ${RESERVED_CONNECTIONS}）が max_connections の 8 割（${budget.limit}）を超えます`)
    }
    if (env.name === 'prod' && env.auth.mode === 'none') throw new Error('prod では認証なしにできません')
    if (env.name === 'prod' && (!env.deletionProtection || env.aurora.readers < 1)) throw new Error('prod は削除保護と Reader（別 AZ）が要ります')
    if (env.aurora.minAcu === 0 && env.aurora.autoPauseMinutes === undefined) throw new Error(`${env.name}: minAcu 0 には autoPauseMinutes が要ります`)
    if (!/^\d{12}$/.test(env.account)) throw new Error(`${env.name}: account は 12 桁にしてください`)
    for (const cidr of env.waf.allowedCidrs) if (!/^[\d.]+\/\d{1,2}$|^[\da-f:]+\/\d{1,3}$/i.test(cidr)) throw new Error(`${env.name}: CIDR が正しくありません: ${cidr}`)
  }
}

/** リソースの名前（<app>-<env>-<name>） */
export const nameOf = (config: AppConfig, env: EnvConfig, name: string) => `${config.app}-${env.name}-${name}`

/** SSM パラメーターの名前（デプロイのスクリプトと共有する。scripts/deploy の lib.ts と同じ） */
export const paramOf = (config: AppConfig, env: EnvConfig, name: string) => `/${config.app}/${env.name}/${name}`

/** バケットの名前（世界で一意にするため、アカウントを付ける）。CI のロールとスクリプトが同じ名前を使う */
export const bucketOf = (config: AppConfig, env: EnvConfig, name: 'code' | 'site' | 'logs') => `${config.app}-${env.name}-${name}-${env.account}`
