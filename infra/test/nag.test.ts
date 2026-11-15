import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { App, Stack, Validations } from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { AwsSolutionsChecks } from 'cdk-nag'
import { defaultConfig, type EnvName } from '../lib/config.ts'
import { buildEnvironment } from '../lib/environment.ts'

// cdk-nag（AWS Solutions）の指摘が、認めたもの（lib/nag.ts に理由つき）以外に残っていないこと
function nagReport(build: (app: App) => void) {
  const outdir = mkdtempSync(join(tmpdir(), 'nag-'))
  const app = new App({ outdir, context: { '@aws-cdk/core:defaultCrossStackReferences': 'strong' } })
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app))
  build(app)
  let failed = false
  try {
    app.synth()
  } catch {
    failed = true
  }
  const report = JSON.parse(readFileSync(join(outdir, 'validation-report.json'), 'utf8')) as {
    pluginReports: { pluginName: string; violations: { ruleName: string; severity: string; violatingConstructs?: { constructPath: string }[]; violatingResources?: { resourceLogicalId?: string }[] }[] }[]
  }
  rmSync(outdir, { recursive: true, force: true })
  // cdk-nag は警告も含めて全部。CloudFormation の検査（cfn-lint の規則）は誤りだけ（W3010 などの警告は lib/network.ts のとおり）
  const violations = report.pluginReports.flatMap((r) =>
    r.violations
      .filter((v) => r.pluginName === 'AwsSolutions' || v.severity === 'error' || v.severity === 'fatal')
      .map((v) => `${r.pluginName}: ${v.ruleName} ${(v.violatingConstructs ?? v.violatingResources ?? []).map((x) => ('constructPath' in x ? x.constructPath : x.resourceLogicalId)).join(',')}`),
  )
  return { failed, violations }
}

describe('cdk-nag', () => {
  test('わざと指摘を出すと、合成が失敗して報告に載る（このテストが効いていることの確かめ）', () => {
    const { failed, violations } = nagReport((app) => new s3.Bucket(new Stack(app, 'Bad'), 'Bucket'))
    assert.equal(failed, true)
    assert.ok(violations.some((v) => v.startsWith('AwsSolutions: AwsSolutions-S1')), violations.join('\n'))
  })

  for (const env of ['dev', 'stg', 'prod'] as EnvName[]) {
    test(`${env}: 認めたもの以外の指摘がない`, () => {
      const { failed, violations } = nagReport((app) => {
        const config = defaultConfig((k) => ({ 'account.dev': '111111111111', 'account.stg': '222222222222', 'account.prod': '333333333333' })[k])
        buildEnvironment(app, config, config.envs[env], { buildSha: 'abc1234' })
      })
      assert.deepEqual(violations, [])
      assert.equal(failed, false)
    })
  }
})
