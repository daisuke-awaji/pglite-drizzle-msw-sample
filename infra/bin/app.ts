import { App, Tags, Validations } from 'aws-cdk-lib'
import { AwsSolutionsChecks } from 'cdk-nag'
import { defaultConfig, validate, type EnvName } from '../lib/config.ts'
import { buildEnvironment } from '../lib/environment.ts'

// 環境（dev / stg / prod）ごとにスタックを並べる。値は lib/config.ts、案件ごとの値は cdk.json の context か -c で渡す。
//   npx cdk deploy tasks-stg-Network tasks-stg-Data ...（順番は docs/production.md「初回の構築」）
//   -c env=stg で 1 つの環境だけを合成する（CI の synth とデプロイはこちら）
const app = new App()
const config = defaultConfig((key) => app.node.tryGetContext(key))
validate(config)

const only = app.node.tryGetContext('env') as EnvName | undefined
const buildSha = (app.node.tryGetContext('buildSha') as string | undefined) ?? 'unset'
for (const env of Object.values(config.envs)) {
  if (only && env.name !== only) continue
  buildEnvironment(app, config, env, { buildSha })
}

Tags.of(app).add('app', config.app)
// AWS Solutions のルール（cdk-nag）で確かめる。認めたものは理由を付けて lib/nag.ts に書く
if (app.node.tryGetContext('nag') !== 'off') {
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }))
}
