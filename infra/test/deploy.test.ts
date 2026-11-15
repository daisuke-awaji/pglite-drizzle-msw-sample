import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { CreateInvalidationCommand } from '@aws-sdk/client-cloudfront'
import { DescribeAlarmsCommand, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import {
  CreateWebFunctionEndpointCommand,
  CreateWebFunctionRevisionCommand,
  GetWebFunctionEndpointCommand,
  GetWebFunctionRevisionCommand,
  LambdaWebClient,
  ListWebFunctionEndpointsCommand,
  UpdateWebFunctionEndpointCommand,
} from '@aws-sdk/client-lambda-web'
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { GetParametersCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { CloudFrontClient } from '@aws-sdk/client-cloudfront'
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch'
import { mockClient } from 'aws-sdk-client-mock'
import { bootstrap } from '../scripts/deploy/bootstrap.ts'
import { context, createClients } from '../scripts/deploy/lib.ts'
import { invokeJson } from '../scripts/deploy/migrate.ts'
import { planWeb, publishWeb } from '../scripts/deploy/publish-web.ts'
import { release } from '../scripts/deploy/release.ts'
import { rollback } from '../scripts/deploy/rollback.ts'
import { smokeApi, smokeSite, type Check } from '../scripts/deploy/smoke.ts'
import { putOnce, uploadCode } from '../scripts/deploy/upload.ts'
import { toDotenv, webEnv } from '../scripts/deploy/web-env.ts'

// デプロイの手順を、AWS の呼び出しを置き換えて確かめる（呼んだ順番と中身）。AWS には触らない
const web = mockClient(LambdaWebClient)
const lambda = mockClient(LambdaClient)
const s3 = mockClient(S3Client)
const ssm = mockClient(SSMClient)
const cloudfront = mockClient(CloudFrontClient)
const cloudwatch = mockClient(CloudWatchClient)
const clients = createClients('ap-northeast-1')

const revisionConfig = {
  executionRoleArn: 'arn:aws:iam::111111111111:role/tasks-stg-api-execution',
  egressNetworkConnectorArn: 'arn:aws:lambda:ap-northeast-1:111111111111:network-connector:nc-1:3',
  timeoutSeconds: 30,
  maxConcurrencyPerEnvironment: 64,
  environmentVariables: { APP_ENV: 'stg', DB_SECRET_ARN: 'arn:secret', DB_POOL_MAX: '10' },
  telemetryConfig: { loggingConfig: { logGroup: '/aws/lambda/web/tasks-stg-api' } },
}

function params(env: 'stg' | 'prod', extra: Record<string, string> = {}) {
  const values: Record<string, string> = {
    'api/function-name': `tasks-${env}-api`,
    'code-bucket': `tasks-${env}-code-111111111111`,
    'api/revision-config': JSON.stringify(revisionConfig),
    'api/endpoint-config': JSON.stringify({ authType: 'IamAuth', endpointType: 'HomeRegion', maxEnvironments: env === 'prod' ? 20 : 5, canary: env === 'prod' }),
    'auth/user-pool-id': 'ap-northeast-1_pool',
    'auth/client-id': 'client-1',
    'auth/admin-group': 'admin',
    'api/next-domain': 'next.example',
    'migrate/function-name': `tasks-${env}-migrate`,
    'migrate/bootstrap-function-name': `tasks-${env}-db-bootstrap`,
    'web/site-bucket': `tasks-${env}-site-111111111111`,
    'web/distribution-id': 'E123',
    'web/site-domain': 'app.example.com',
    'web/rum-app-monitor-id': 'rum-1',
    'auth/domain': 'tasks-stg.auth.ap-northeast-1.amazoncognito.com',
    ...extra,
  }
  ssm.on(GetParametersCommand).callsFake((input: { Names: string[] }) => ({
    Parameters: input.Names.filter((n) => values[n.replace(`/tasks/${env}/`, '')] !== undefined).map((n) => ({ Name: n, Value: values[n.replace(`/tasks/${env}/`, '')] })),
  }))
}

/** endpoint の状態を持つ置き換え。UpdateWebFunctionEndpoint で重みが変わる */
function endpoints(initial: Record<string, { revisionId: string; weight: number }[] | undefined>) {
  const state = { ...initial }
  web.on(ListWebFunctionEndpointsCommand).callsFake(() => ({ endpoints: Object.keys(state).filter((k) => state[k]).map((endpointName) => ({ endpointName })) }))
  web.on(GetWebFunctionEndpointCommand).callsFake((i: { endpointName: string }) => ({ endpointName: i.endpointName, domainName: `${i.endpointName}.example`, state: 'Active', updateStatus: 'Successful', revisionWeights: state[i.endpointName] }))
  web.on(UpdateWebFunctionEndpointCommand).callsFake((i: { endpointName: string; revisionWeights: { revisionId: string; weight: number }[] }) => {
    state[i.endpointName] = i.revisionWeights
    return {}
  })
  web.on(CreateWebFunctionEndpointCommand).callsFake((i: { endpointName: string; revisionWeights: { revisionId: string; weight: number }[] }) => {
    state[i.endpointName] = i.revisionWeights
    return {}
  })
  return state
}

const updates = () => web.commandCalls(UpdateWebFunctionEndpointCommand).map((c) => `${c.args[0].input.endpointName}:${c.args[0].input.revisionWeights!.map((w) => `${w.revisionId}=${w.weight}`).join('+')}`)
const JWKS = '{"keys":[{"kid":"k1","kty":"RSA"}]}'
const jwks = async (url: string) => {
  assert.equal(url, 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_pool/.well-known/jwks.json')
  return JWKS
}
const passing = async (): Promise<Check[]> => [{ name: 'ok', ok: true, detail: '' }]
const failing = async (): Promise<Check[]> => [{ name: 'readyz', ok: false, detail: '500' }]

beforeEach(() => {
  for (const m of [web, lambda, s3, ssm, cloudfront, cloudwatch]) m.reset()
  s3.on(HeadObjectCommand).resolves({ VersionId: 'v1' })
  web.on(CreateWebFunctionRevisionCommand).resolves({ revisionId: 'rev-new' })
  web.on(GetWebFunctionRevisionCommand).resolves({ revisionId: 'rev-new', state: 'Active' })
  cloudwatch.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [{ AlarmName: 'tasks-prod-api-5xx-rate', StateValue: 'OK' }] })
  cloudwatch.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Values: [] }] })
})

describe('release', () => {
  test('revision を作り、next で確かめてから live を切り替え、next に 1 つ前を残す', async () => {
    params('stg')
    endpoints({ live: [{ revisionId: 'rev-old', weight: 100 }], next: [{ revisionId: 'rev-old', weight: 100 }] })
    const smokes: unknown[] = []
    const result = await release({ clients, ctx: context('stg', 'tasks'), sha: 'abc1234', jwks, smoke: async (base, o) => (smokes.push({ base, ...o }), passing()) })
    assert.deepEqual(result, { ok: true, previous: 'rev-old', current: 'rev-new', canary: false })
    assert.deepEqual(updates(), ['next:rev-new=100', 'live:rev-new=100', 'next:rev-old=100'])
    assert.deepEqual(smokes, [{ base: 'https://next.example', sign: { region: 'ap-northeast-1' }, expectBuild: 'abc1234', authMode: 'cognito' }])

    // revision は S3 のオブジェクトのバージョンを指し、設定は SSM の全体にビルドの SHA と認証を足したもの
    const input = web.commandCalls(CreateWebFunctionRevisionCommand)[0]!.args[0].input
    assert.deepEqual(input.buildConfig, { codeConfig: { s3Object: { bucket: 'tasks-stg-code-111111111111', key: 'api/abc1234.zip', versionId: 'v1' } }, runtimeConfig: { runtime: 'nodejs24.x' } })
    assert.deepEqual(input.serviceConfig!.environmentVariables, {
      ...revisionConfig.environmentVariables,
      AUTH_MODE: 'cognito',
      COGNITO_USER_POOL_ID: 'ap-northeast-1_pool',
      COGNITO_CLIENT_ID: 'client-1',
      COGNITO_ADMIN_GROUP: 'admin',
      COGNITO_JWKS: JWKS,
      BUILD_SHA: 'abc1234',
    })
    assert.equal(input.serviceConfig!.egressNetworkConnectorArn, revisionConfig.egressNetworkConnectorArn)
    // 実行環境の上限は、切り替えのたびに CDK の値にそろえる
    assert.ok(web.commandCalls(UpdateWebFunctionEndpointCommand).every((c) => c.args[0].input.scalingConfig?.maxEnvironments === 5))
  })

  test('next の確認で失敗したら live に触らず、next を戻し先に向け直して止まる', async () => {
    params('stg')
    const state = endpoints({ live: [{ revisionId: 'rev-old', weight: 100 }], next: [{ revisionId: 'rev-old', weight: 100 }] })
    await assert.rejects(release({ clients, ctx: context('stg', 'tasks'), sha: 'abc1234', jwks, smoke: failing }), /スモークテストに失敗しました: readyz/)
    assert.deepEqual(updates(), ['next:rev-new=100', 'next:rev-old=100'])
    assert.deepEqual(state.live, [{ revisionId: 'rev-old', weight: 100 }])
  })

  test('revision が Failed なら endpoint を変えない', async () => {
    params('stg')
    endpoints({ live: [{ revisionId: 'rev-old', weight: 100 }], next: [{ revisionId: 'rev-old', weight: 100 }] })
    web.on(GetWebFunctionRevisionCommand).resolves({ state: 'Failed', stateReason: 'code not found' })
    await assert.rejects(release({ clients, ctx: context('stg', 'tasks'), sha: 'abc1234', jwks, smoke: passing }), /Failed: code not found/)
    assert.deepEqual(updates(), [])
  })

  test('prod は 10% を流してアラームを見てから 100% にする', async () => {
    params('prod')
    endpoints({ live: [{ revisionId: 'rev-old', weight: 100 }], next: [{ revisionId: 'rev-old', weight: 100 }] })
    let t = 0
    const waits: number[] = []
    const result = await release({
      clients,
      ctx: context('prod', 'tasks'),
      sha: 'abc1234',
      smoke: passing,
      jwks,
      now: () => t,
      wait: async (ms) => {
        waits.push(ms)
        t += ms
      },
    })
    assert.equal(result.canary, true)
    assert.deepEqual(updates(), ['next:rev-new=100', 'live:rev-old=90+rev-new=10', 'live:rev-new=100', 'next:rev-old=100'])
    assert.equal(waits.length, 20) // 10 分を 30 秒ごと
    assert.equal(cloudwatch.commandCalls(DescribeAlarmsCommand).length, 20)
    assert.deepEqual(cloudwatch.commandCalls(DescribeAlarmsCommand)[0]!.args[0].input.AlarmNames, ['tasks-prod-api-5xx-rate', 'tasks-prod-api-init-failure'])
    assert.deepEqual(cloudwatch.commandCalls(GetMetricDataCommand)[0]!.args[0].input.MetricDataQueries![0]!.MetricStat!.Metric!.Dimensions, [{ Name: 'Build', Value: 'abc1234' }])
  })

  for (const [what, arrange, message] of [
    ['5xx のアラームが鳴った', () => cloudwatch.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [{ AlarmName: 'tasks-prod-api-5xx-rate', StateValue: 'ALARM' }] }), /アラーム: tasks-prod-api-5xx-rate/],
    ['新しいビルドだけの 5xx が出た', () => cloudwatch.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Values: [0, 2] }] }), /新しいビルド（abc1234）の 5xx が 2 件/],
  ] as const) {
    test(`カナリアの間に${what}ら、live を前の revision に戻して失敗にする`, async () => {
      params('prod')
      const state = endpoints({ live: [{ revisionId: 'rev-old', weight: 100 }], next: [{ revisionId: 'rev-old', weight: 100 }] })
      arrange()
      let t = 0
      await assert.rejects(release({ clients, ctx: context('prod', 'tasks'), sha: 'abc1234', jwks, smoke: passing, now: () => t, wait: async (ms) => void (t += ms) }), message)
      assert.deepEqual(updates(), ['next:rev-new=100', 'live:rev-old=90+rev-new=10', 'live:rev-old=100', 'next:rev-old=100'])
      assert.deepEqual(state.live, [{ revisionId: 'rev-old', weight: 100 }])
    })
  }

  test('endpoint の設定が IamAuth でなければ止める（誰でも呼べる endpoint を作らない）', async () => {
    params('stg', { 'api/endpoint-config': JSON.stringify({ authType: 'ApplicationManaged', endpointType: 'HomeRegion', maxEnvironments: 5, canary: false }) })
    endpoints({ live: [{ revisionId: 'rev-old', weight: 100 }], next: [{ revisionId: 'rev-old', weight: 100 }] })
    await assert.rejects(release({ clients, ctx: context('stg', 'tasks'), sha: 'abc1234', jwks, smoke: passing }), /IamAuth/)
    assert.equal(web.commandCalls(CreateWebFunctionRevisionCommand).length, 0)
  })
})

describe('rollback', () => {
  test('live を next の revision に向け、next には戻す前の live を残す（数秒。作り直さない）', async () => {
    params('stg')
    const state = endpoints({ live: [{ revisionId: 'rev-bad', weight: 100 }], next: [{ revisionId: 'rev-good', weight: 100 }] })
    assert.deepEqual(await rollback({ clients, ctx: context('stg', 'tasks') }), { ok: true, from: 'rev-bad', to: 'rev-good' })
    assert.deepEqual(state, { live: [{ revisionId: 'rev-good', weight: 100 }], next: [{ revisionId: 'rev-bad', weight: 100 }] })
    assert.equal(web.commandCalls(CreateWebFunctionRevisionCommand).length, 0)
  })

  test('カナリアの途中（90/10）でも、戻し先に 100% で戻す', async () => {
    params('prod')
    const state = endpoints({ live: [{ revisionId: 'rev-good', weight: 90 }, { revisionId: 'rev-bad', weight: 10 }], next: [{ revisionId: 'rev-bad', weight: 100 }] })
    await rollback({ clients, ctx: context('prod', 'tasks') })
    assert.deepEqual(state.live, [{ revisionId: 'rev-bad', weight: 100 }])
  })

  test('戻し先がなければ何もしない', async () => {
    params('stg')
    endpoints({ live: [{ revisionId: 'rev-1', weight: 100 }], next: [{ revisionId: 'rev-1', weight: 100 }] })
    await assert.rejects(rollback({ clients, ctx: context('stg', 'tasks') }), /戻し先がありません/)
    assert.deepEqual(updates(), [])
  })
})

const payload = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))

describe('migrate（関数を同期で 1 回）', () => {
  test('関数のエラーは理由を付けて失敗にする', async () => {
    lambda.on(InvokeCommand).resolves({ FunctionError: 'Unhandled', Payload: payload({ errorType: 'DrizzleQueryError', errorMessage: 'lock timeout' }) as never })
    await assert.rejects(invokeJson(clients, 'tasks-stg-migrate', { mode: 'migrate' }), /DrizzleQueryError: lock timeout/)
  })
  test('戻り値が ok でなければ失敗にする。ok なら結果を返す', async () => {
    lambda.on(InvokeCommand).resolves({ Payload: payload({ ok: false }) as never })
    await assert.rejects(invokeJson(clients, 'fn', {}), /ok ではありません/)
    lambda.on(InvokeCommand).resolves({ Payload: payload({ ok: true, applied: ['0001_x'] }) as never })
    assert.deepEqual(await invokeJson(clients, 'fn', { mode: 'migrate' }), { ok: true, applied: ['0001_x'] })
    assert.deepEqual(JSON.parse(new TextDecoder().decode(lambda.commandCalls(InvokeCommand).at(-1)!.args[0].input.Payload as Uint8Array)), { mode: 'migrate' })
    assert.equal(lambda.commandCalls(InvokeCommand).at(-1)!.args[0].input.InvocationType, 'RequestResponse')
  })
  test('SDK のやり直しをしない（タイムアウトで 2 回流さない）', async () => {
    assert.equal(await clients.lambda.config.maxAttempts(), 1)
  })
})

describe('upload（上書きしない）', () => {
  const precondition = Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } })
  test('If-None-Match: * で置き、sha256 を付ける', async () => {
    s3.on(PutObjectCommand).resolves({})
    assert.equal(await putOnce(clients, 'b', 'api/abc.zip', Buffer.from('zip')), 'uploaded')
    const input = s3.commandCalls(PutObjectCommand)[0]!.args[0].input
    assert.equal(input.IfNoneMatch, '*')
    assert.equal(input.ChecksumSHA256, 'SnD+mqZDbgLC3qNA+9HjUuTvLYzmylKtJdS5VHH8i/I=')
  })
  test('同じ中身がすでにあれば何もしない（ジョブのやり直し）。違う中身なら止める', async () => {
    s3.on(PutObjectCommand).rejects(precondition)
    s3.on(HeadObjectCommand).resolves({ ChecksumSHA256: 'SnD+mqZDbgLC3qNA+9HjUuTvLYzmylKtJdS5VHH8i/I=' })
    assert.equal(await putOnce(clients, 'b', 'api/abc.zip', Buffer.from('zip')), 'unchanged')
    s3.on(HeadObjectCommand).resolves({ ChecksumSHA256: 'other' })
    await assert.rejects(putOnce(clients, 'b', 'api/abc.zip', Buffer.from('zip')), /上書きしません/)
  })
  test('api と migrate の 2 つを、SHA のキーで置く', async () => {
    params('stg')
    s3.on(PutObjectCommand).resolves({})
    const dir = mkdtempSync(join(tmpdir(), 'dist-server-'))
    writeFileSync(join(dir, 'api.zip'), 'a')
    writeFileSync(join(dir, 'migrate.zip'), 'm')
    await uploadCode({ clients, ctx: context('stg', 'tasks'), sha: 'abc1234', distDir: dir })
    assert.deepEqual(s3.commandCalls(PutObjectCommand).map((c) => `${c.args[0].input.Bucket}/${c.args[0].input.Key}`), ['tasks-stg-code-111111111111/api/abc1234.zip', 'tasks-stg-code-111111111111/migrate/abc1234.zip'])
  })
})

function dist() {
  const dir = mkdtempSync(join(tmpdir(), 'dist-'))
  mkdirSync(join(dir, 'assets'))
  for (const f of ['index.html', '404.html', 'favicon.svg', 'assets/index-abc.js', 'assets/sheet-def.js', 'assets/index-abc.css']) writeFileSync(join(dir, f), f)
  return dir
}

describe('publish-web', () => {
  test('JS・CSS を先に（上書きせず 1 年キャッシュ）、index.html を最後に（キャッシュさせない）。404.html は置かない', () => {
    const plan = planWeb(dist())
    assert.deepEqual(plan.map((p) => p.key), ['assets/index-abc.css', 'assets/index-abc.js', 'assets/sheet-def.js', 'favicon.svg', 'index.html'])
    assert.deepEqual(plan.map((p) => p.cacheControl), ['public, max-age=31536000, immutable', 'public, max-age=31536000, immutable', 'public, max-age=31536000, immutable', 'public, max-age=300', 'no-cache'])
    assert.equal(plan.at(-1)!.contentType, 'text/html; charset=utf-8')
  })

  test('置いたあとに index.html のキャッシュだけを消す。古い JS は消さない', async () => {
    params('stg')
    s3.on(PutObjectCommand).resolves({})
    cloudfront.on(CreateInvalidationCommand).resolves({ Invalidation: { Id: 'I1', Status: 'InProgress', CreateTime: new Date(), InvalidationBatch: { CallerReference: 'x', Paths: { Quantity: 1, Items: ['/index.html'] } } } })
    const result = await publishWeb({ clients, ctx: context('stg', 'tasks'), distDir: dist() })
    assert.equal(result.invalidation, 'I1')
    assert.deepEqual(cloudfront.commandCalls(CreateInvalidationCommand)[0]!.args[0].input.InvalidationBatch!.Paths, { Quantity: 1, Items: ['/index.html'] })
    assert.equal(s3.commandCalls(PutObjectCommand).at(-1)!.args[0].input.Key, 'index.html')
  })
})

describe('bootstrap（環境ごとに 1 回）', () => {
  beforeEach(() => {
    lambda.on(InvokeCommand).callsFake(() => ({ Payload: new TextEncoder().encode(JSON.stringify({ ok: true, created: ['migrator', 'app', 'readonly'] })) }))
    ssm.on(PutParameterCommand).resolves({})
  })

  test('DB の利用者 → マイグレーション → revision → next（確かめる）→ live を作り、ドメインを SSM に書く', async () => {
    params('stg')
    endpoints({})
    let smoked = 0
    const result = await bootstrap({ clients, ctx: context('stg', 'tasks'), sha: 'abc1234', jwks, smoke: async () => (smoked++, passing()) })
    assert.deepEqual(lambda.commandCalls(InvokeCommand).map((c) => [c.args[0].input.FunctionName, new TextDecoder().decode(c.args[0].input.Payload as Uint8Array)]), [
      ['tasks-stg-db-bootstrap', '{}'],
      ['tasks-stg-migrate', '{"mode":"pre"}'],
      ['tasks-stg-migrate', '{"mode":"migrate"}'],
    ])
    const created = web.commandCalls(CreateWebFunctionEndpointCommand).map((c) => c.args[0].input)
    assert.deepEqual(created.map((c) => [c.endpointName, c.authType, c.endpointType, c.autoDeploymentMode]), [
      ['next', 'IamAuth', 'HomeRegion', 'Disabled'],
      ['live', 'IamAuth', 'HomeRegion', 'Disabled'],
    ])
    assert.equal(smoked, 1)
    assert.deepEqual(ssm.commandCalls(PutParameterCommand).map((c) => [c.args[0].input.Name, c.args[0].input.Value]), [
      ['/tasks/stg/api/live-domain', 'live.example'],
      ['/tasks/stg/api/next-domain', 'next.example'],
    ])
    assert.equal(result.createdRevision, 'rev-new')
  })

  test('もう endpoint があれば作らない（何度流しても同じ）', async () => {
    params('stg')
    endpoints({ live: [{ revisionId: 'r', weight: 100 }], next: [{ revisionId: 'r', weight: 100 }] })
    await bootstrap({ clients, ctx: context('stg', 'tasks'), sha: 'abc1234', jwks, smoke: passing })
    assert.equal(web.commandCalls(CreateWebFunctionEndpointCommand).length, 0)
    assert.equal(web.commandCalls(CreateWebFunctionRevisionCommand).length, 0)
    assert.equal(ssm.commandCalls(PutParameterCommand).length, 2)
  })
})

describe('web-env', () => {
  test('画面のビルドに渡す値（認証・RUM・ビルドの SHA）。秘密の値はない', async () => {
    params('stg')
    const env = await webEnv({ clients, ctx: context('stg', 'tasks'), sha: 'abc1234' })
    assert.deepEqual(env, {
      VITE_USE_MOCK: 'false',
      VITE_APP_VERSION: 'abc1234',
      VITE_RUM_REGION: 'ap-northeast-1',
      VITE_RUM_APP_MONITOR_ID: 'rum-1',
      VITE_AUTH_MODE: 'cognito',
      VITE_COGNITO_DOMAIN: 'tasks-stg.auth.ap-northeast-1.amazoncognito.com',
      VITE_COGNITO_CLIENT_ID: 'client-1',
    })
    assert.throws(() => toDotenv({ A: 'x\ny' }), /改行/)
  })
})

async function serve(handler: (req: { method?: string; url?: string; headers: Record<string, unknown> }) => { status: number; type?: string; body: string }) {
  const seen: { method?: string; url?: string; headers: Record<string, unknown> }[] = []
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers })
    const r = handler(req)
    res.writeHead(r.status, { 'content-type': r.type ?? 'application/json' }).end(r.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) }
}
const api = (req: { url?: string }) => {
  if (req.url === '/api/readyz') return { status: 200, body: JSON.stringify({ status: 'ok', build: 'abc1234' }) }
  if (req.url === '/api/projects') return { status: 401, body: '{"error":"ログインが必要です"}' }
  if (req.url?.startsWith('/api/')) return { status: req.url === '/api/tags' ? 401 : 404, body: '{"error":"x"}' }
  if (req.url?.startsWith('/assets/')) return { status: 403, type: 'application/xml', body: '<Error/>' }
  return { status: 200, type: 'text/html', body: '<!doctype html><div id="root"></div>' }
}

describe('smoke（本物の HTTP で）', () => {
  test('next には SigV4（サービス名 lambda）で署名し、X-Amz-Content-SHA256 を付ける', async () => {
    const s = await serve(api)
    const checks = await smokeApi(s.base, { authMode: 'cognito', expectBuild: 'abc1234', sign: { region: 'ap-northeast-1', credentials: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }) } })
    await s.close()
    assert.ok(checks.every((c) => c.ok), JSON.stringify(checks))
    const h = s.seen[0]!.headers
    assert.match(String(h.authorization), /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-northeast-1\/lambda\/aws4_request, SignedHeaders=.*host.*x-amz-content-sha256/)
    assert.equal(h['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD')
  })

  test('古いビルドに当たっていたら失敗にする', async () => {
    const s = await serve(api)
    const checks = await smokeApi(s.base, { authMode: 'cognito', expectBuild: 'fff0000' })
    await s.close()
    assert.deepEqual(checks.filter((c) => !c.ok).map((c) => c.name), ['新しいビルドに当たっている'])
  })

  test('CloudFront 経由: 画面の URL は index.html、ない JS は index.html にしない、POST も API まで届く', async () => {
    const s = await serve(api)
    const checks = await smokeSite(s.base, { authMode: 'cognito' })
    await s.close()
    assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)))
    assert.ok(s.seen.some((r) => r.method === 'POST' && r.url === '/api/tags'))
    assert.ok(s.seen.every((r) => !r.headers.authorization), '署名しない（OAC が付ける）')
  })

  test('SPA の書き換えが効いていなければ失敗にする', async () => {
    const s = await serve((req) => (req.url === '/projects/1' ? { status: 403, type: 'application/xml', body: '<Error/>' } : api(req)))
    const checks = await smokeSite(s.base, { authMode: 'cognito' })
    await s.close()
    assert.deepEqual(checks.filter((c) => !c.ok).map((c) => c.name), ['画面の URL（/projects/1）も index.html'])
  })
})
