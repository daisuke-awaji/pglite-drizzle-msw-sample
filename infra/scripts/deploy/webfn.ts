import {
  CreateWebFunctionEndpointCommand,
  CreateWebFunctionRevisionCommand,
  GetWebFunctionEndpointCommand,
  GetWebFunctionRevisionCommand,
  ListWebFunctionEndpointsCommand,
  UpdateWebFunctionEndpointCommand,
  type RevisionWeight,
  type ServiceConfig,
} from '@aws-sdk/client-lambda-web'
import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { getParams, log, sleep, type Clients, type Context } from './lib.ts'

// Web Function の revision と endpoint を動かす（CDK では持たない。docs/production.md「設計の判断」）

export type EndpointName = 'live' | 'next'

export type ApiSettings = {
  functionName: string
  codeBucket: string
  revisionConfig: ServiceConfig
  endpoint: { authType: 'IamAuth'; endpointType: 'HomeRegion'; maxEnvironments: number; canary: boolean }
  auth: { mode: 'cognito'; userPoolId: string; clientId: string; adminGroup: string } | { mode: 'none' }
}

export async function readApiSettings(clients: Clients, ctx: Context): Promise<ApiSettings> {
  const p = await getParams(
    clients.ssm,
    ctx,
    ['api/function-name', 'code-bucket', 'api/revision-config', 'api/endpoint-config', 'auth/user-pool-id', 'auth/client-id', 'auth/admin-group'],
    ['api/function-name', 'code-bucket', 'api/revision-config', 'api/endpoint-config'],
  )
  const endpoint = JSON.parse(p['api/endpoint-config']!) as ApiSettings['endpoint']
  if (endpoint.authType !== 'IamAuth') throw new Error('endpoint は IamAuth にしてください（ApplicationManaged は誰でも呼べる）')
  return {
    functionName: p['api/function-name']!,
    codeBucket: p['code-bucket']!,
    revisionConfig: JSON.parse(p['api/revision-config']!) as ServiceConfig,
    endpoint,
    auth: p['auth/user-pool-id'] && p['auth/client-id'] ? { mode: 'cognito', userPoolId: p['auth/user-pool-id'], clientId: p['auth/client-id'], adminGroup: p['auth/admin-group'] ?? 'admin' } : { mode: 'none' },
  }
}

/**
 * revision の設定。新しい revision は前の設定を引き継がないので、いつも SSM の全体から作る（環境変数やタイムアウトを落とさない）。
 * ビルドの SHA と、認証（Cognito）の値をここで足す
 */
export function serviceConfigFor(settings: ApiSettings, sha: string): ServiceConfig {
  const auth: Record<string, string> =
    settings.auth.mode === 'cognito'
      ? { AUTH_MODE: 'cognito', COGNITO_USER_POOL_ID: settings.auth.userPoolId, COGNITO_CLIENT_ID: settings.auth.clientId, COGNITO_ADMIN_GROUP: settings.auth.adminGroup }
      : { AUTH_MODE: 'none' }
  return {
    ...settings.revisionConfig,
    environmentVariables: { ...settings.revisionConfig.environmentVariables, ...auth, BUILD_SHA: sha },
  }
}

/** S3 の api/<SHA>.zip から revision を作り、Active になるのを待つ。revision は起動に失敗しても Active になるので、必ず next で確かめる */
export async function createRevision(clients: Clients, settings: ApiSettings, sha: string, { pollMs = 5000, timeoutMs = 10 * 60_000 } = {}): Promise<string> {
  const key = `api/${sha}.zip`
  const head = await clients.s3.send(new HeadObjectCommand({ Bucket: settings.codeBucket, Key: key }))
  if (!head.VersionId) throw new Error(`s3://${settings.codeBucket}/${key} にバージョンがありません（バケットのバージョニング）`)
  const created = await clients.lambdaWeb.send(
    new CreateWebFunctionRevisionCommand({
      functionName: settings.functionName,
      description: `build ${sha}`,
      buildConfig: { codeConfig: { s3Object: { bucket: settings.codeBucket, key, versionId: head.VersionId } }, runtimeConfig: { runtime: 'nodejs24.x' } },
      serviceConfig: serviceConfigFor(settings, sha),
    }),
  )
  const revisionId = created.revisionId!
  log('revision を作りました', { revisionId, sha })
  const until = Date.now() + timeoutMs
  for (;;) {
    const r = await clients.lambdaWeb.send(new GetWebFunctionRevisionCommand({ functionName: settings.functionName, revisionId }))
    if (r.state === 'Active') return revisionId
    if (r.state === 'Failed') throw new Error(`revision ${revisionId} が Failed: ${r.stateReason ?? ''} ${JSON.stringify(r.errors ?? [])}`)
    if (Date.now() > until) throw new Error(`revision ${revisionId} が Active になりません（${r.state}）`)
    await sleep(pollMs)
  }
}

export async function getEndpoint(clients: Clients, functionName: string, endpointName: EndpointName) {
  return clients.lambdaWeb.send(new GetWebFunctionEndpointCommand({ functionName, endpointName }))
}

export async function listEndpointNames(clients: Clients, functionName: string): Promise<string[]> {
  const res = await clients.lambdaWeb.send(new ListWebFunctionEndpointsCommand({ functionName }))
  return (res.endpoints ?? []).map((e) => e.endpointName!).filter(Boolean)
}

/** いちばん重い revision（live が 1 つのときは、その revision） */
export const mainRevision = (weights: RevisionWeight[] | undefined) => weights?.toSorted((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0]?.revisionId

/** endpoint の重みを変え、更新が終わるのを待つ（非同期なので待たないと次の変更が重なる） */
export async function setWeights(
  clients: Clients,
  settings: ApiSettings,
  endpointName: EndpointName,
  weights: RevisionWeight[],
  { pollMs = 3000, timeoutMs = 5 * 60_000 } = {},
): Promise<void> {
  const total = weights.reduce((n, w) => n + (w.weight ?? 0), 0)
  if (total !== 100) throw new Error(`重みの合計が 100 ではありません: ${JSON.stringify(weights)}`)
  await clients.lambdaWeb.send(
    new UpdateWebFunctionEndpointCommand({
      functionName: settings.functionName,
      endpointName,
      revisionWeights: weights,
      scalingConfig: { maxEnvironments: settings.endpoint.maxEnvironments },
    }),
  )
  const until = Date.now() + timeoutMs
  for (;;) {
    const e = await getEndpoint(clients, settings.functionName, endpointName)
    if (e.updateStatus === 'Successful' || (e.updateStatus === undefined && e.state === 'Active')) break
    if (e.updateStatus === 'Failed') throw new Error(`${endpointName} の更新に失敗しました: ${e.updateStatusReason ?? ''}`)
    if (Date.now() > until) throw new Error(`${endpointName} の更新が終わりません（${e.updateStatus}）`)
    await sleep(pollMs)
  }
  log(`${endpointName} を切り替えました`, { weights })
}

/** 最初の endpoint（live と next）。HomeRegion（Network Connector を使うため）・IamAuth・自動デプロイなし */
export async function createEndpoint(clients: Clients, settings: ApiSettings, endpointName: EndpointName, revisionId: string, { pollMs = 5000, timeoutMs = 10 * 60_000 } = {}) {
  await clients.lambdaWeb.send(
    new CreateWebFunctionEndpointCommand({
      functionName: settings.functionName,
      endpointName,
      description: endpointName === 'live' ? 'CloudFront だけが呼ぶ（リソースポリシー）' : 'デプロイの確認用（GitHub Actions のロールだけが呼ぶ）',
      endpointType: 'HomeRegion',
      authType: 'IamAuth',
      autoDeploymentMode: 'Disabled',
      revisionWeights: [{ revisionId, weight: 100 }],
      scalingConfig: { maxEnvironments: settings.endpoint.maxEnvironments },
    }),
  )
  const until = Date.now() + timeoutMs
  for (;;) {
    const e = await getEndpoint(clients, settings.functionName, endpointName)
    if (e.state === 'Active') return e.domainName!
    if (e.state === 'Failed') throw new Error(`${endpointName} の作成に失敗しました: ${e.stateReason ?? ''}`)
    if (Date.now() > until) throw new Error(`${endpointName} が Active になりません（${e.state}）`)
    await sleep(pollMs)
  }
}
