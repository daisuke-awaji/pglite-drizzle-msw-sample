import { readFileSync } from 'node:fs'
import { CloudFrontClient } from '@aws-sdk/client-cloudfront'
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch'
import { LambdaClient } from '@aws-sdk/client-lambda'
import { LambdaWebClient } from '@aws-sdk/client-lambda-web'
import { S3Client } from '@aws-sdk/client-s3'
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm'
import { NodeHttpHandler } from '@smithy/node-http-handler'

// デプロイの手順（docs/production.md「いつものリリース」）が共通で使うもの。
// 値は CDK が書いた SSM パラメーター（/<app>/<env>/...）から読む。名前は infra/lib/config.ts の paramOf と同じ

export type EnvName = 'dev' | 'stg' | 'prod'

export type Context = {
  app: string
  env: EnvName
  region: string
  /** SSM パラメーターの名前 */
  param: (name: string) => string
  /** アラームなどの名前（<app>-<env>-<name>） */
  name: (name: string) => string
}

export type Clients = {
  lambdaWeb: LambdaWebClient
  lambda: LambdaClient
  s3: S3Client
  ssm: SSMClient
  cloudfront: CloudFrontClient
  cloudwatch: CloudWatchClient
}

export function parseEnv(value: string | undefined): EnvName {
  if (value === 'dev' || value === 'stg' || value === 'prod') return value
  throw new Error(`環境は dev / stg / prod のどれかにしてください: ${value ?? '(なし)'}`)
}

/** コミット SHA（S3 のキーと BUILD_SHA に使う）。短縮形でもよいが、英数字だけ */
export function parseSha(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{7,40}$/.test(value)) throw new Error(`コミット SHA が正しくありません: ${value ?? '(なし)'}`)
  return value
}

export function context(env: EnvName, app = appName(), region = 'ap-northeast-1'): Context {
  return { app, env, region, param: (n) => `/${app}/${env}/${n}`, name: (n) => `${app}-${env}-${n}` }
}

/** infra/cdk.json の context.app（既定は tasks） */
export function appName(): string {
  try {
    const cdk = JSON.parse(readFileSync(new URL('../../cdk.json', import.meta.url), 'utf8')) as { context?: { app?: string } }
    return cdk.context?.app ?? 'tasks'
  } catch {
    return 'tasks'
  }
}

export function createClients(region: string): Clients {
  return {
    lambdaWeb: new LambdaWebClient({ region }),
    // マイグレーションは同期で 1 回だけ呼ぶ。関数の最大（15 分）より長く待ち、SDK のやり直しは止める（2 回流さない）
    lambda: new LambdaClient({ region, maxAttempts: 1, requestHandler: new NodeHttpHandler({ requestTimeout: 16 * 60_000 }) }),
    s3: new S3Client({ region }),
    ssm: new SSMClient({ region }),
    cloudfront: new CloudFrontClient({ region: 'us-east-1' }),
    cloudwatch: new CloudWatchClient({ region }),
  }
}

/** SSM パラメーターをまとめて読む。ないものは undefined（required に入れたものがなければ止める） */
export async function getParams(ssm: SSMClient, ctx: Context, names: string[], required: string[] = names): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {}
  for (let i = 0; i < names.length; i += 10) {
    const batch = names.slice(i, i + 10)
    const res = await ssm.send(new GetParametersCommand({ Names: batch.map((n) => ctx.param(n)) }))
    for (const p of res.Parameters ?? []) out[p.Name!.slice(ctx.param('').length)] = p.Value
  }
  const missing = required.filter((n) => out[n] === undefined)
  if (missing.length) throw new Error(`SSM パラメーターがありません: ${missing.map((n) => ctx.param(n)).join(', ')}（CDK のスタックか bootstrap を先に流す）`)
  return out
}

export const log = (message: string, fields?: Record<string, unknown>) =>
  process.stderr.write(`[${new Date().toISOString()}] ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}\n`)

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** CLI の入口。失敗したら理由を出して終了コード 1 */
export async function main(run: () => Promise<unknown>) {
  try {
    const result = await run()
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (e) {
    log(`失敗: ${(e as Error).message}`)
    process.exitCode = 1
  }
}
