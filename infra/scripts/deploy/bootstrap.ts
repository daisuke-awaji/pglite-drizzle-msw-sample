import { PutParameterCommand } from '@aws-sdk/client-ssm'
import { context, createClients, getParams, log, main, parseEnv, parseSha, type Clients, type Context } from './lib.ts'
import { invokeJson, runMigrate } from './migrate.ts'
import { assertPassed, smokeApi, type Check, type SmokeOptions } from './smoke.ts'
import { createEndpoint, createRevision, getEndpoint, listEndpointNames, readApiSettings } from './webfn.ts'

// 環境ごとに 1 回だけ（docs/production.md「初回の構築」の 5〜7）。何度流しても同じ結果になる。
//   Network・Data・Api・Migrate のスタックを deploy したあと、Edge より前に流す
// 1. DB の利用者を作る（db-bootstrap 関数。既存の利用者のパスワードは変えない）
// 2. マイグレーション（事前の SQL → 本体）
// 3. 最初の revision を作り、live と next の endpoint を作る（どちらも HomeRegion・IamAuth・自動デプロイなし）
// 4. endpoint のドメインを SSM に書く（Edge のスタックが live を CloudFront のオリジンにする）

export async function bootstrap({ clients, ctx, sha, smoke = smokeApi }: { clients: Clients; ctx: Context; sha: string; smoke?: (b: string, o: SmokeOptions) => Promise<Check[]> }) {
  const { 'migrate/bootstrap-function-name': bootstrapFn } = await getParams(clients.ssm, ctx, ['migrate/bootstrap-function-name'])
  const users = await invokeJson(clients, bootstrapFn!, {})
  log('DB の利用者', users)
  await runMigrate({ clients, ctx, mode: 'pre' })
  await runMigrate({ clients, ctx, mode: 'migrate' })

  const settings = await readApiSettings(clients, ctx)
  const existing = new Set(await listEndpointNames(clients, settings.functionName))
  const domains: Record<'live' | 'next', string> = { live: '', next: '' }
  let revisionId: string | undefined
  for (const name of ['next', 'live'] as const) {
    if (existing.has(name)) {
      domains[name] = (await getEndpoint(clients, settings.functionName, name)).domainName!
      continue
    }
    revisionId ??= await createRevision(clients, settings, sha)
    domains[name] = await createEndpoint(clients, settings, name, revisionId)
    log(`${name} を作りました`, { domain: domains[name] })
    // live を作る前に、next で動くことを確かめる
    if (name === 'next') assertPassed(await smoke(`https://${domains.next}`, { sign: { region: ctx.region }, expectBuild: sha, authMode: settings.auth.mode }))
  }
  for (const name of ['live', 'next'] as const) {
    await clients.ssm.send(new PutParameterCommand({ Name: ctx.param(`api/${name}-domain`), Value: domains[name], Type: 'String', Overwrite: true, Description: `Web Function endpoint ${name}` }))
  }
  return { ok: true, users, domains, createdRevision: revisionId }
}

// node scripts/deploy/bootstrap.ts <env> <SHA>（api/<SHA>.zip と migrate/<SHA>.zip を先に置き、Migrate を deploy しておく）
if (import.meta.main) {
  await main(async () => {
    const ctx = context(parseEnv(process.argv[2]))
    return bootstrap({ clients: createClients(ctx.region), ctx, sha: parseSha(process.argv[3]) })
  })
}
