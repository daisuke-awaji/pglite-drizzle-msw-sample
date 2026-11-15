import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Match } from 'aws-cdk-lib/assertions'
import { auroraMaxConnections, connectionBudget, defaultConfig, validate } from '../lib/config.ts'
import { SPA_REWRITE } from '../lib/edge.ts'
import { only, resources, synth } from './helpers.ts'

// docs/production.md に書いた決まりを、合成したテンプレートで確かめる（AWS にはデプロイしない）
const dev = synth('dev')
const stg = synth('stg')
const prod = synth('prod')

describe('Network', () => {
  test('インターネットへの出口（NAT・Internet Gateway）を置かない。外に出るのは Secrets Manager の VPC endpoint だけ', () => {
    const t = prod.template('network')
    t.resourceCountIs('AWS::EC2::NatGateway', 0)
    t.resourceCountIs('AWS::EC2::InternetGateway', 0)
    const endpoints = Object.values(resources(t, 'AWS::EC2::VPCEndpoint'))
    assert.equal(endpoints.length, 1)
    assert.match(JSON.stringify(endpoints[0]!.ServiceName), /secretsmanager/)
  })

  test('DB に入れるのは Network Connector と migrate などの関数のセキュリティグループからの 5432 だけ', () => {
    const t = prod.template('network')
    const ingress = Object.values(resources(t, 'AWS::EC2::SecurityGroupIngress')).filter((r) => r.ToPort === 5432)
    assert.equal(ingress.length, 2)
    for (const r of ingress) assert.ok(r.SourceSecurityGroupId, '送り元はセキュリティグループ（CIDR ではない）')
    assert.equal(Object.values(resources(t, 'AWS::EC2::SecurityGroup')).filter((g) => JSON.stringify(g.SecurityGroupIngress ?? []).includes('0.0.0.0/0')).length, 0)
  })
})

describe('Data（Aurora PostgreSQL 18）', () => {
  test('ブラウザの PGlite と同じ 18.6。暗号化し、TLS を強制し、管理者のパスワードは RDS が管理する', () => {
    const cluster = only(resources(prod.template('data'), 'AWS::RDS::DBCluster'))
    assert.equal(cluster.Engine, 'aurora-postgresql')
    assert.equal(cluster.EngineVersion, '18.6')
    assert.equal(cluster.StorageEncrypted, true)
    assert.equal(cluster.ManageMasterUserPassword, true)
    assert.equal(cluster.MasterUserPassword, undefined)
    const params = only(resources(prod.template('data'), 'AWS::RDS::DBClusterParameterGroup')).Parameters as Record<string, string>
    assert.equal(params['rds.force_ssl'], '1')
  })

  test('環境ごとの ACU・Reader・削除保護・バックアップ（docs/production.md「環境」の表）', () => {
    const c = (s: typeof dev) => only(resources(s.template('data'), 'AWS::RDS::DBCluster'))
    assert.deepEqual(c(dev).ServerlessV2ScalingConfiguration, { MinCapacity: 0, MaxCapacity: 4, SecondsUntilAutoPause: 600 })
    assert.deepEqual(c(stg).ServerlessV2ScalingConfiguration, { MinCapacity: 0, MaxCapacity: 8, SecondsUntilAutoPause: 1800 })
    assert.deepEqual(c(prod).ServerlessV2ScalingConfiguration, { MinCapacity: 1, MaxCapacity: 16 })
    assert.equal(c(dev).DeletionProtection, false)
    assert.equal(c(stg).DeletionProtection, true)
    assert.equal(c(prod).DeletionProtection, true)
    assert.deepEqual([c(dev), c(stg), c(prod)].map((x) => x.BackupRetentionPeriod), [1, 7, 35])
    dev.template('data').resourceCountIs('AWS::RDS::DBInstance', 1)
    prod.template('data').resourceCountIs('AWS::RDS::DBInstance', 2)
    dev.template('data').resourceCountIs('AWS::Backup::BackupPlan', 0)
    prod.template('data').hasResourceProperties('AWS::Backup::BackupPlan', {
      BackupPlan: { BackupPlanRule: [Match.objectLike({ Lifecycle: { DeleteAfterDays: 365 } })] },
    })
  })

  test('app・migrator・readonly の秘密情報を作り、ローテーションする（app と migrator は交互に使う方式）', () => {
    const t = prod.template('data')
    // テンプレートは Aurora の endpoint を含むので Fn::Join になる。username だけを取り出す
    const secrets = Object.values(resources(t, 'AWS::SecretsManager::Secret')).map((s) => /\\"username\\":\\"(\w+)\\"/.exec(JSON.stringify(s.GenerateSecretString))?.[1])
    assert.deepEqual(secrets.toSorted(), ['app', 'migrator', 'readonly'])
    const rotations = Object.values(resources(t, 'AWS::SecretsManager::RotationSchedule')).map((r) => (r.HostedRotationLambda as { RotationType: string }).RotationType)
    assert.deepEqual(rotations.toSorted(), ['PostgreSQLMultiUser', 'PostgreSQLMultiUser', 'PostgreSQLSingleUser'])
  })
})

describe('Api（Web Function）', () => {
  test('関数の入れ物だけを持ち、revision と endpoint は CloudFormation で持たない（重みはデプロイの手順で動かす）', () => {
    const t = prod.template('api')
    t.resourceCountIs('AWS::Lambda::WebFunction', 1)
    t.resourceCountIs('AWS::Lambda::WebFunctionEndpoint', 0)
    t.resourceCountIs('AWS::Lambda::WebFunctionRevision', 0)
  })

  test('Network Connector は Web Function 用の IPv4 で、app サブネットに置く', () => {
    const nc = only(resources(prod.template('api'), 'AWS::Lambda::NetworkConnector'))
    const egress = (nc.Configuration as { VpcEgressConfiguration: Record<string, unknown> }).VpcEgressConfiguration
    assert.deepEqual(egress.AssociatedComputeResourceTypes, ['WebFunction'])
    assert.equal(egress.NetworkProtocol, 'IPv4')
    assert.equal((egress.SubnetIds as unknown[]).length, 3)
  })

  test('revision の設定に秘密情報の値を入れない（ARN だけ）。プールの上限は環境の表のとおり', () => {
    const params = resources(prod.template('api'), 'AWS::SSM::Parameter')
    const config = Object.values(params).find((p) => p.Name === '/tasks/prod/api/revision-config')!
    const text = JSON.stringify(config.Value)
    assert.match(text, /DB_SECRET_ARN/)
    assert.match(text, /\\"DB_POOL_MAX\\":\\"10\\"/)
    assert.doesNotMatch(text, /password/i)
    const endpoint = JSON.parse(Object.values(params).find((p) => p.Name === '/tasks/prod/api/endpoint-config')!.Value as string)
    assert.deepEqual(endpoint, { authType: 'IamAuth', endpointType: 'HomeRegion', maxEnvironments: 20, canary: true })
  })

  test('実行ロールは app の秘密情報を読むこととログを書くことだけ', () => {
    const t = prod.template('api')
    const policies = Object.entries(resources(t, 'AWS::IAM::Policy')).filter(([id]) => id.startsWith('ExecutionRole'))
    const actions = policies.flatMap(([, p]) => (p.PolicyDocument as { Statement: { Action: string | string[] }[] }).Statement.flatMap((s) => [s.Action].flat()))
    assert.deepEqual(actions.toSorted(), ['kms:Decrypt', 'logs:CreateLogStream', 'logs:PutLogEvents', 'secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'])
  })

  test('コード用のバケットはバージョニングあり・公開なし', () => {
    prod.template('api').hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'tasks-prod-code-333333333333',
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    })
  })
})

describe('Migrate', () => {
  test('Node 24・Arm64・VPC の中・15 分・同時に 1 つだけ。コードはコミット SHA の zip', () => {
    const t = prod.template('migrate')
    const fn = Object.values(resources(t, 'AWS::Lambda::Function')).find((f) => f.Handler === 'index.handler')!
    assert.equal(fn.Runtime, 'nodejs24.x')
    assert.deepEqual(fn.Architectures, ['arm64'])
    assert.equal(fn.Timeout, 900)
    assert.equal(fn.ReservedConcurrentExecutions, 1)
    assert.ok(fn.VpcConfig)
    assert.equal((fn.Code as { S3Key: string }).S3Key, 'migrate/abc1234.zip')
    assert.equal(((fn.Environment as { Variables: Record<string, unknown> }).Variables).MIGRATOR_ROLE, 'migrator')
  })

  test('migrate は migrator の秘密情報だけ、db-bootstrap だけが管理者の秘密情報を読める', () => {
    const t = prod.template('migrate')
    const secretsOf = (prefix: string) =>
      Object.entries(resources(t, 'AWS::IAM::Policy'))
        .filter(([id]) => id.startsWith(prefix))
        .flatMap(([, p]) => (p.PolicyDocument as { Statement: { Action: string | string[]; Resource: unknown }[] }).Statement)
        .filter((s) => [s.Action].flat().includes('secretsmanager:GetSecretValue'))
        .flatMap((s) => [s.Resource].flat())
    assert.equal(secretsOf('MigrateServiceRole').length, 1)
    assert.match(JSON.stringify(secretsOf('MigrateServiceRole')), /MigratorSecret/)
    assert.match(JSON.stringify(secretsOf('DbBootstrapServiceRole')), /MasterUserSecret/)
    assert.doesNotMatch(JSON.stringify(secretsOf('MigrateServiceRole')), /MasterUserSecret/)
  })
})

describe('Edge（CloudFront）', () => {
  const t = prod.template('edge')
  const dist = () => only(resources(t, 'AWS::CloudFront::Distribution')).DistributionConfig as Record<string, unknown>

  test('/api/* のオリジンに Lambda 用の OAC（always-amz-auth・sigv4）を付ける', () => {
    const oacs = Object.values(resources(t, 'AWS::CloudFront::OriginAccessControl')).map((o) => o.OriginAccessControlConfig as Record<string, string>)
    // S3 用（画面）と Lambda 用（API）の 2 つ
    assert.deepEqual(oacs.map((o) => o.OriginAccessControlOriginType).toSorted(), ['lambda', 's3'])
    const oac = oacs.find((o) => o.OriginAccessControlOriginType === 'lambda')!
    assert.deepEqual([oac.OriginAccessControlOriginType, oac.SigningBehavior, oac.SigningProtocol], ['lambda', 'always-amz-auth', 'sigv4'])
    const origins = dist().Origins as { Id: string; DomainName: unknown; OriginAccessControlId?: unknown; CustomOriginConfig?: unknown }[]
    const apiOrigin = origins[1]!
    assert.ok(apiOrigin.CustomOriginConfig, '2 つ目が Web Function のオリジン')
    // オリジンのドメインは、bootstrap が SSM に書いた live endpoint のドメイン（deploy のときに解決される）
    const ref = (apiOrigin.DomainName as { Ref: string }).Ref
    assert.equal((t.toJSON().Parameters[ref] as { Default: string }).Default, '/tasks/prod/api/live-domain')
    assert.ok(apiOrigin.OriginAccessControlId)
  })

  test('/api/* は Host を除いて送り、Authorization を渡す（キャッシュはしない）。カスタムエラーレスポンスは使わない', () => {
    const behaviors = dist().CacheBehaviors as Record<string, unknown>[]
    const api = behaviors.find((b) => b.PathPattern === '/api/*')!
    // マネージドの AllViewerExceptHostHeader
    assert.equal(api.OriginRequestPolicyId, 'b689b0a8-53d0-40ab-baf2-68738e2966ac')
    assert.deepEqual(api.AllowedMethods, ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'])
    const cache = only(resources(t, 'AWS::CloudFront::CachePolicy')).CachePolicyConfig as Record<string, unknown>
    assert.equal(cache.MaxTTL, 1)
    assert.deepEqual((cache.ParametersInCacheKeyAndForwardedToOrigin as { HeadersConfig: unknown }).HeadersConfig, { HeaderBehavior: 'whitelist', Headers: ['Authorization'] })
    assert.equal(dist().CustomErrorResponses, undefined)
    assert.ok(dist().WebACLId)
  })

  test('Web Function のリソースポリシーは、このディストリビューションから live を呼ぶことだけを許す', () => {
    const policy = only(resources(t, 'AWS::Lambda::ResourcePolicy')).PolicyDocument as { Statement: Record<string, unknown>[] }
    assert.equal(policy.Statement.length, 1)
    const s = policy.Statement[0]!
    assert.deepEqual(s.Principal, { Service: 'cloudfront.amazonaws.com' })
    assert.equal(s.Action, 'lambda:InvokeWebFunctionEndpoint')
    assert.match(JSON.stringify(s.Resource), /\/endpoint\/live/)
    assert.match(JSON.stringify(s.Condition), /aws:SourceArn.*distribution/)
  })

  test('SPA の書き換え: ファイル名のないパスだけ index.html にする', () => {
    const handler = new Function(`${SPA_REWRITE}; return handler`)() as (e: { request: { uri: string } }) => { uri: string }
    const rewrite = (uri: string) => handler({ request: { uri } }).uri
    assert.equal(rewrite('/projects/1'), '/index.html')
    assert.equal(rewrite('/'), '/index.html')
    assert.equal(rewrite('/assets/index-abc.js'), '/assets/index-abc.js')
    assert.equal(rewrite('/favicon.svg'), '/favicon.svg')
    assert.equal(rewrite('/v1.2/tasks'), '/index.html')
  })
})

const rules = (s: ReturnType<typeof synth>) => only(resources(s.template('edgeGlobal'), 'AWS::WAFv2::WebACL')).Rules as Record<string, unknown>[]

describe('EdgeGlobal（WAF）', () => {

  test('最初は数えるだけ（count）。-c wafMode.prod=block で止める', () => {
    const managed = rules(prod).filter((r) => r.OverrideAction)
    assert.equal(managed.length, 3)
    assert.ok(managed.every((r) => JSON.stringify(r.OverrideAction) === '{"Count":{}}'))
    const blocking = synth('prod', { 'wafMode.prod': 'block' })
    assert.ok(rules(blocking).filter((r) => r.OverrideAction).every((r) => JSON.stringify(r.OverrideAction) === '{"None":{}}'))
    assert.deepEqual(rules(blocking).find((r) => r.Name === 'RatePerIp')!.Action, { Block: {} })
  })

  test('許可する CIDR を渡すと、それ以外を必ず止める（数えるだけにしない）', () => {
    const limited = synth('prod', { 'allowedCidrs.prod': '203.0.113.0/24,2001:db8::/32' })
    const allow = rules(limited).find((r) => r.Name === 'AllowListOnly')!
    assert.deepEqual(allow.Action, { Block: {} })
    assert.equal(allow.Priority, 0)
    limited.template('edgeGlobal').resourceCountIs('AWS::WAFv2::IPSet', 2)
  })
})

const pool = (s: ReturnType<typeof synth>) => only(resources(s.template('auth'), 'AWS::Cognito::UserPool'))

describe('Auth（Cognito）', () => {
  test('自分では登録できない。prod は MFA 必須。公開クライアントは秘密を持たず、認可コードだけ', () => {
    assert.equal(pool(prod).MfaConfiguration, 'ON')
    assert.equal(pool(stg).MfaConfiguration, 'OPTIONAL')
    assert.deepEqual(pool(prod).AdminCreateUserConfig, { AllowAdminCreateUserOnly: true })
    const client = only(resources(prod.template('auth'), 'AWS::Cognito::UserPoolClient'))
    assert.equal(client.GenerateSecret, false)
    assert.deepEqual(client.AllowedOAuthFlows, ['code'])
    assert.match(JSON.stringify(client.CallbackURLs), /\/auth\/callback/)
    assert.doesNotMatch(JSON.stringify(client.CallbackURLs), /localhost/)
    assert.match(JSON.stringify(only(resources(dev.template('auth'), 'AWS::Cognito::UserPoolClient')).CallbackURLs), /localhost:5173/)
  })

  test('dev で -c authMode.dev=none なら Auth のスタックを作らない（prod ではできない）', () => {
    assert.equal(synth('dev', { 'authMode.dev': 'none' }).stacks.auth, undefined)
  })
})

describe('Ci（GitHub OIDC）', () => {
  const t = prod.template('ci')
  test('このリポジトリの production 環境のジョブだけが引き受けられる', () => {
    const role = Object.values(resources(t, 'AWS::IAM::Role')).find((r) => r.RoleName === 'tasks-prod-github-deploy')!
    const cond = JSON.stringify((role.AssumeRolePolicyDocument as { Statement: { Condition: unknown }[] }).Statement[0]!.Condition)
    assert.match(cond, /repo:daisuke-awaji\/pglite-drizzle-msw-sample:environment:production/)
    assert.match(cond, /sts\.amazonaws\.com/)
  })

  test('操作の * を使わない。live は呼べず next だけ。endpoint は IamAuth しか作れない', () => {
    const statements = Object.values(resources(t, 'AWS::IAM::Policy')).flatMap((p) => (p.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement)
    const actions = statements.flatMap((s) => [s.Action].flat() as string[])
    assert.ok(actions.every((a) => !a.endsWith(':*') && a !== '*'), actions.join(','))
    const invoke = statements.find((s) => [s.Action].flat().includes('lambda:InvokeWebFunctionEndpoint'))!
    assert.match(JSON.stringify(invoke.Resource), /endpoint\/next/)
    assert.doesNotMatch(JSON.stringify(invoke.Resource), /endpoint\/live/)
    const create = statements.find((s) => [s.Action].flat().includes('lambda:CreateWebFunctionEndpoint'))!
    assert.match(JSON.stringify(create.Condition), /IamAuth/)
  })
})

describe('Monitoring', () => {
  const t = prod.template('monitoring')
  test('docs/production.md の表のアラームがある', () => {
    const names = Object.values(resources(t, 'AWS::CloudWatch::Alarm')).map((a) => a.AlarmName)
    for (const n of ['api-5xx-rate', 'api-latency-p95', 'api-init-failure', 'api-throttles', 'api-environments-high', 'api-memory-high', 'db-acu-high', 'db-connections-high', 'db-deadlocks', 'migrate-failed', 'api-unexpected-errors', 'web-js-errors']) {
      assert.ok(names.includes(`tasks-prod-${n}`), n)
    }
    prod.template('edgeAlarms').hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'tasks-prod-edge-5xx-rate', MetricName: '5xxErrorRate' })
  })

  test('疎なメトリクス（5xx・スロットリング）は、データがないときは正常', () => {
    for (const a of Object.values(resources(t, 'AWS::CloudWatch::Alarm'))) assert.equal(a.TreatMissingData, 'notBreaching', String(a.AlarmName))
  })

  test('ログのメトリクスは Lambda の JSON の形（message の中）に合わせる', () => {
    const patterns = Object.values(resources(t, 'AWS::Logs::MetricFilter')).map((f) => f.FilterPattern as string)
    assert.ok(patterns.includes('{ $.message.type = "request" }'))
    assert.ok(patterns.includes('{ $.type = "platform.initReport" && $.record.status = "failure" }'))
  })

  test('接続数のアラームは、max_connections の 8 割', () => {
    const alarm = Object.values(resources(t, 'AWS::CloudWatch::Alarm')).find((a) => a.AlarmName === 'tasks-prod-db-connections-high')!
    assert.equal(alarm.Threshold, Math.floor(auroraMaxConnections(16) * 0.8))
  })
})

describe('設定の検査', () => {
  test('実行環境の上限 × プールの上限が max_connections の 8 割を超えたら合成しない', () => {
    const config = defaultConfig((k) => ({ 'account.dev': '111111111111', 'account.stg': '222222222222', 'account.prod': '333333333333' })[k])
    assert.doesNotThrow(() => validate(config))
    assert.deepEqual(connectionBudget(config.envs.prod), { used: 206, limit: Math.floor(auroraMaxConnections(16) * 0.8), ok: true })
    config.envs.dev.api.maxEnvironments = 200
    assert.throws(() => validate(config), /dev: 接続数 1006/)
  })

  test('account を渡さないと 000000000000 になる（synth はできるが deploy はできない）', () => {
    assert.equal(defaultConfig().envs.prod.account, '000000000000')
  })
})
