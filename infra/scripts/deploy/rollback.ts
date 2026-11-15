import { context, createClients, log, main, parseEnv, type Clients, type Context } from './lib.ts'
import { getEndpoint, mainRevision, readApiSettings, setWeights } from './webfn.ts'

// API を 1 つ前の revision に戻す（docs/production.md「戻すとき」）。作り直さないので数秒で終わる。
// live を next にある revision（1 つ前）に 100% で向け、next には戻す前の live を残す（調べられるように。もう一度流すと元に戻る）

export async function rollback({ clients, ctx }: { clients: Clients; ctx: Context }) {
  // 戻すだけなので鍵は読まない（revision の設定は作り直さない）
  const settings = await readApiSettings(clients, ctx, { jwks: async () => '' })
  const live = await getEndpoint(clients, settings.functionName, 'live')
  const next = await getEndpoint(clients, settings.functionName, 'next')
  const from = mainRevision(live.revisionWeights)
  const to = mainRevision(next.revisionWeights)
  if (!to) throw new Error('next に revision がありません')
  if (from === to && (live.revisionWeights?.length ?? 0) === 1) throw new Error(`live と next が同じ revision（${to}）なので、戻し先がありません。2 つ以上前に戻すときは、その SHA で release を流す`)
  await setWeights(clients, settings, 'live', [{ revisionId: to, weight: 100 }])
  if (from && from !== to) await setWeights(clients, settings, 'next', [{ revisionId: from, weight: 100 }])
  log('live を戻しました', { from, to })
  return { ok: true, from, to }
}

// node scripts/deploy/rollback.ts <env>
if (import.meta.main) {
  await main(async () => {
    const ctx = context(parseEnv(process.argv[2]))
    return rollback({ clients: createClients(ctx.region), ctx })
  })
}
