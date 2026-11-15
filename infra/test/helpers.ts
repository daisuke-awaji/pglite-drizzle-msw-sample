import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { defaultConfig, validate, type EnvName } from '../lib/config.ts'
import { buildEnvironment } from '../lib/environment.ts'

/** 1 つの環境を合成する（資格情報も lookup も使わない） */
export function synth(env: EnvName, context: Record<string, unknown> = {}) {
  const app = new App({ context: { '@aws-cdk/core:defaultCrossStackReferences': 'strong', 'account.dev': '111111111111', 'account.stg': '222222222222', 'account.prod': '333333333333', ...context } })
  const config = defaultConfig((k) => app.node.tryGetContext(k))
  validate(config)
  const stacks = buildEnvironment(app, config, config.envs[env], { buildSha: 'abc1234' })
  const cache = new Map<string, Template>()
  const template = (name: keyof typeof stacks) => {
    const stack = stacks[name]
    if (!stack) throw new Error(`${name} がありません`)
    if (!cache.has(name)) cache.set(name, Template.fromStack(stack))
    return cache.get(name)!
  }
  return { app, config, stacks, template }
}

/** テンプレートの中の、その種類の資源（論理 ID → Properties） */
export function resources(t: Template, type: string): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(t.findResources(type)).map(([k, v]) => [k, (v as { Properties: Record<string, unknown> }).Properties ?? {}]))
}

export const only = <T,>(record: Record<string, T>): T => {
  const values = Object.values(record)
  if (values.length !== 1) throw new Error(`1 つのはずが ${values.length} 個あります`)
  return values[0]!
}
