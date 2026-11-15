import { DescribeAlarmsCommand, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { context, createClients, getParams, log, main, parseEnv, parseSha, sleep, type Clients, type Context } from './lib.ts'
import { assertPassed, smokeApi, type Check, type SmokeOptions } from './smoke.ts'
import { createRevision, getEndpoint, mainRevision, readApiSettings, setWeights } from './webfn.ts'

// いつものリリース（docs/production.md の 5・6）:
//   1. api/<SHA>.zip から revision を作る → 2. next に向けてスモークテスト（署名つき）
//   3. live を切り替える（prod は 10% を 10 分流し、アラームと新しいビルドの 5xx を見る）→ 4. next に 1 つ前の revision を残す
// 確認で失敗したら live は古いまま。カナリアの間に異常なら live を前の revision に戻して失敗にする

export type ReleaseOptions = {
  clients: Clients
  ctx: Context
  sha: string
  smoke?: (base: string, o: SmokeOptions) => Promise<Check[]>
  canary?: { percent: number; minutes: number; pollSeconds: number }
  wait?: typeof sleep
  now?: () => number
}

export type ReleaseResult = { ok: true; previous?: string; current: string; canary: boolean }

/** カナリアの間に見るアラーム（infra/lib/monitoring.ts） */
export const CANARY_ALARMS = ['api-5xx-rate', 'api-init-failure']

async function canaryProblem(clients: Clients, ctx: Context, sha: string, since: Date): Promise<string | undefined> {
  const alarms = await clients.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: CANARY_ALARMS.map((a) => ctx.name(a)) }))
  const firing = (alarms.MetricAlarms ?? []).filter((a) => a.StateValue === 'ALARM').map((a) => a.AlarmName)
  if (firing.length) return `アラーム: ${firing.join(', ')}`
  // Web Functions のメトリクスには revision の区別がないので、アプリのログから作った「ビルドごとの 5xx」を見る
  const data = await clients.cloudwatch.send(
    new GetMetricDataCommand({
      StartTime: since,
      EndTime: new Date(),
      MetricDataQueries: [{ Id: 'errors', MetricStat: { Metric: { Namespace: 'App/Api', MetricName: 'ServerErrors', Dimensions: [{ Name: 'Build', Value: sha }] }, Period: 60, Stat: 'Sum' } }],
    }),
  )
  const errors = (data.MetricDataResults?.[0]?.Values ?? []).reduce((n, v) => n + v, 0)
  return errors > 0 ? `新しいビルド（${sha}）の 5xx が ${errors} 件` : undefined
}

export async function release({ clients, ctx, sha, smoke = smokeApi, canary = { percent: 10, minutes: 10, pollSeconds: 30 }, wait = sleep, now = Date.now }: ReleaseOptions): Promise<ReleaseResult> {
  const settings = await readApiSettings(clients, ctx)
  const live = await getEndpoint(clients, settings.functionName, 'live')
  const previous = mainRevision(live.revisionWeights)
  const next = await getEndpoint(clients, settings.functionName, 'next')
  const nextDomain = next.domainName ?? (await getParams(clients.ssm, ctx, ['api/next-domain']))['api/next-domain']

  const current = await createRevision(clients, settings, sha)
  await setWeights(clients, settings, 'next', [{ revisionId: current, weight: 100 }])
  try {
    assertPassed(await smoke(`https://${nextDomain}`, { sign: { region: ctx.region }, expectBuild: sha, authMode: settings.auth.mode }))
  } catch (e) {
    // next を戻し先（いまの live）に向け直しておく（rollback の先が壊れた revision にならないように）
    if (previous) await setWeights(clients, settings, 'next', [{ revisionId: previous, weight: 100 }])
    throw e
  }

  const useCanary = settings.endpoint.canary && previous !== undefined && previous !== current
  if (useCanary) {
    await setWeights(clients, settings, 'live', [
      { revisionId: previous, weight: 100 - canary.percent },
      { revisionId: current, weight: canary.percent },
    ])
    const since = new Date(now())
    const until = now() + canary.minutes * 60_000
    log(`カナリア: live の ${canary.percent}% を ${canary.minutes} 分流します`)
    while (now() < until) {
      await wait(canary.pollSeconds * 1000)
      const problem = await canaryProblem(clients, ctx, sha, since)
      if (problem) {
        await setWeights(clients, settings, 'live', [{ revisionId: previous, weight: 100 }])
        await setWeights(clients, settings, 'next', [{ revisionId: previous, weight: 100 }])
        throw new Error(`カナリアで異常があったので、live を前の revision（${previous}）に戻しました: ${problem}`)
      }
    }
  }
  await setWeights(clients, settings, 'live', [{ revisionId: current, weight: 100 }])
  // 戻し先を残す（どの endpoint からも使われない古い revision は、50 個を超えると自動で消える）
  if (previous && previous !== current) await setWeights(clients, settings, 'next', [{ revisionId: previous, weight: 100 }])
  return { ok: true, previous, current, canary: useCanary }
}

// node scripts/deploy/release.ts <env> <SHA>
if (import.meta.main) {
  await main(async () => {
    const env = parseEnv(process.argv[2])
    const sha = parseSha(process.argv[3])
    const ctx = context(env)
    return release({ clients: createClients(ctx.region), ctx, sha })
  })
}
