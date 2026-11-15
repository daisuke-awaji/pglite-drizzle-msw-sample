import type { App } from 'aws-cdk-lib'
import { ApiStack } from './api.ts'
import { AuthStack } from './auth.ts'
import { CiStack } from './ci.ts'
import { bucketOf, type AppConfig, type EnvConfig } from './config.ts'
import { DataStack } from './data.ts'
import { EdgeGlobalStack } from './edge-global.ts'
import { EdgeStack } from './edge.ts'
import { MigrateStack } from './migrate.ts'
import { EdgeAlarmsStack, MonitoringStack } from './monitoring.ts'
import { acknowledgeNagFindings } from './nag.ts'
import { NetworkStack } from './network.ts'

/** スタックの名前（<app>-<env>-<Name>）。cdk deploy で指定する */
export const stackName = (config: AppConfig, env: EnvConfig, name: string) => `${config.app}-${env.name}-${name}`

/**
 * 1 つの環境のスタック。初回のデプロイの順番（docs/production.md「初回の構築」）:
 * Network → Data → Api → Migrate →（db-bootstrap を呼ぶ・endpoint を作る: infra/scripts/deploy/bootstrap.ts）
 * → EdgeGlobal（us-east-1）→ Edge → Auth → EdgeAlarms（us-east-1）→ Monitoring → Ci
 */
export function buildEnvironment(app: App, config: AppConfig, stage: EnvConfig, { buildSha }: { buildSha: string }) {
  const name = (n: string) => stackName(config, stage, n)
  const home = { account: stage.account, region: stage.region }
  const usEast1 = { account: stage.account, region: 'us-east-1' }
  const base = { config, stage, crossRegionReferences: true, terminationProtection: stage.deletionProtection }

  const network = new NetworkStack(app, name('Network'), { ...base, env: home })
  const data = new DataStack(app, name('Data'), { ...base, env: home, network })
  const api = new ApiStack(app, name('Api'), { ...base, env: home, network, data })
  const migrate = new MigrateStack(app, name('Migrate'), { ...base, env: home, network, data, api, buildSha, terminationProtection: false })
  const edgeGlobal = new EdgeGlobalStack(app, name('EdgeGlobal'), { ...base, env: usEast1 })
  const edge = new EdgeStack(app, name('Edge'), { ...base, env: home, api, webAclArn: edgeGlobal.webAclArn, certificate: edgeGlobal.certificate })
  const auth = stage.auth.mode === 'cognito' ? new AuthStack(app, name('Auth'), { ...base, env: home, siteDomain: edge.siteDomain }) : undefined
  const edgeAlarms = new EdgeAlarmsStack(app, name('EdgeAlarms'), { ...base, env: usEast1, distributionId: edge.distribution.distributionId })
  const monitoring = new MonitoringStack(app, name('Monitoring'), {
    ...base,
    env: home,
    functionName: api.functionName,
    logGroup: api.logGroup,
    migrateFunctionName: migrate.migrateFunction.functionName,
    cluster: data.cluster,
    key: data.key,
    siteDomain: edge.siteDomain,
    extraTopics: [edgeAlarms.topic],
  })
  const ci = new CiStack(app, name('Ci'), {
    ...base,
    env: home,
    functionName: api.functionName,
    codeBucketArn: `arn:aws:s3:::${bucketOf(config, stage, 'code')}`,
    siteBucketArn: `arn:aws:s3:::${bucketOf(config, stage, 'site')}`,
    distributionArn: `arn:aws:cloudfront::${stage.account}:distribution/${edge.distribution.distributionId}`,
    migrateFunctionArn: migrate.migrateFunction.functionArn,
    bootstrapFunctionArn: migrate.bootstrapFunction.functionArn,
    executionRoleArn: api.executionRole.roleArn,
  })
  const stacks = { Network: network, Data: data, Api: api, Migrate: migrate, EdgeGlobal: edgeGlobal, Edge: edge, EdgeAlarms: edgeAlarms, Monitoring: monitoring, Ci: ci, ...(auth ? { Auth: auth } : {}) }
  acknowledgeNagFindings(stacks, stage)
  return { network, data, api, migrate, edgeGlobal, edge, auth, edgeAlarms, monitoring, ci }
}
