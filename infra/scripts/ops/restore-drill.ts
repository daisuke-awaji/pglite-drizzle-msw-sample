import {
  CreateDBInstanceCommand,
  DeleteDBClusterCommand,
  DeleteDBInstanceCommand,
  DescribeDBClustersCommand,
  RDSClient,
  RestoreDBClusterToPointInTimeCommand,
  waitUntilDBClusterAvailable,
  waitUntilDBInstanceAvailable,
} from '@aws-sdk/client-rds'
import { context, createClients, getParams, log, main, parseEnv, type Clients, type Context } from '../deploy/lib.ts'
import { invokeJson } from '../deploy/migrate.ts'

// 復元の練習（docs/production.md「バックアップと復旧」。3 か月に 1 回、stg で）。
// 1. PITR で「新しいクラスター」に復元する（本番のクラスターは上書きしない）
// 2. Writer を 1 台足し、使えるようになるまでの時間を測る（RTO の見直しに使う）
// 3. migrate 関数の verify で、復元したクラスターの中身を読む（読むだけ。未適用のマイグレーションと主な表の行数）
// 4. 消す（--keep なら残す。調べ終わったら同じスクリプトの --delete <ID> で消す）

export type DrillOptions = {
  clients: Clients
  rds: RDSClient
  ctx: Context
  /** この時刻に戻す（ISO 8601）。なければ戻せるいちばん新しい時刻 */
  restoreTime?: Date
  keep?: boolean
  now?: () => Date
  waitSeconds?: number
}

const minutes = (ms: number) => Math.round(ms / 6000) / 10
const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 12)

export async function restoreDrill({ clients, rds, ctx, restoreTime, keep = false, now = () => new Date(), waitSeconds = 3 * 60 * 60 }: DrillOptions) {
  const source = ctx.name('db')
  const { DBClusters } = await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: source }))
  const src = DBClusters?.[0]
  if (!src) throw new Error(`クラスター ${source} がありません`)
  const drillId = `${ctx.name('drill')}-${stamp(now())}`
  const started = now()
  log('復元を始めます', { source, drillId, restoreTime: restoreTime?.toISOString() ?? 'latest' })

  await rds.send(
    new RestoreDBClusterToPointInTimeCommand({
      DBClusterIdentifier: drillId,
      SourceDBClusterIdentifier: source,
      ...(restoreTime ? { RestoreToTime: restoreTime } : { UseLatestRestorableTime: true }),
      DBSubnetGroupName: src.DBSubnetGroup,
      VpcSecurityGroupIds: src.VpcSecurityGroups?.map((g) => g.VpcSecurityGroupId!),
      KmsKeyId: src.KmsKeyId,
      DBClusterParameterGroupName: src.DBClusterParameterGroup,
      ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: src.ServerlessV2ScalingConfiguration?.MaxCapacity ?? 4 },
      DeletionProtection: false,
      CopyTagsToSnapshot: false,
      Tags: [
        { Key: 'purpose', Value: 'restore-drill' },
        { Key: 'source', Value: source },
      ],
    }),
  )
  const result: Record<string, unknown> = { drillId, source }
  try {
    await waitUntilDBClusterAvailable({ client: rds, maxWaitTime: waitSeconds, minDelay: 15 }, { DBClusterIdentifier: drillId })
    const clusterReady = now()
    await rds.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: `${drillId}-writer`, DBClusterIdentifier: drillId, DBInstanceClass: 'db.serverless', Engine: src.Engine, PubliclyAccessible: false }))
    await waitUntilDBInstanceAvailable({ client: rds, maxWaitTime: waitSeconds, minDelay: 15 }, { DBInstanceIdentifier: `${drillId}-writer` })
    const ready = now()
    const { DBClusters: restored } = await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: drillId }))
    const host = restored?.[0]?.Endpoint
    if (!host) throw new Error('復元したクラスターの endpoint がありません')

    const { 'migrate/function-name': fn } = await getParams(clients.ssm, ctx, ['migrate/function-name'])
    const verify = await invokeJson(clients, fn!, { mode: 'verify', host })
    Object.assign(result, {
      ok: true,
      restoredTo: restoreTime?.toISOString() ?? 'latest',
      minutesUntilClusterAvailable: minutes(clusterReady.getTime() - started.getTime()),
      minutesUntilWriterAvailable: minutes(ready.getTime() - started.getTime()),
      verify,
    })
    log('復元したクラスターを確かめました', result)
    return result
  } finally {
    if (!keep) await deleteDrill(rds, drillId)
    else log(`残しました。調べ終わったら消す: node scripts/ops/restore-drill.ts ${ctx.env} --delete ${drillId}`)
  }
}

export async function deleteDrill(rds: RDSClient, drillId: string) {
  if (!/-drill-\d{12}$/.test(drillId)) throw new Error(`練習のクラスター（<app>-<env>-drill-<時刻>）だけを消します: ${drillId}`)
  await rds.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: `${drillId}-writer`, SkipFinalSnapshot: true })).catch((e: { name?: string }) => {
    if (e.name !== 'DBInstanceNotFoundFault') throw e
  })
  await rds.send(new DeleteDBClusterCommand({ DBClusterIdentifier: drillId, SkipFinalSnapshot: true }))
  log('練習のクラスターを消しました（消し終わるまで数分かかる）', { drillId })
}

// node scripts/ops/restore-drill.ts <env> [--time 2026-11-15T09:00:00Z] [--keep]
// node scripts/ops/restore-drill.ts <env> --delete <drillId>
if (import.meta.main) {
  await main(async () => {
    const args = process.argv.slice(2)
    const ctx = context(parseEnv(args[0]))
    const value = (name: string) => {
      const i = args.indexOf(`--${name}`)
      return i >= 0 ? args[i + 1] : undefined
    }
    const rds = new RDSClient({ region: ctx.region })
    const del = value('delete')
    if (del) return deleteDrill(rds, del)
    const time = value('time')
    return restoreDrill({ clients: createClients(ctx.region), rds, ctx, restoreTime: time ? new Date(time) : undefined, keep: args.includes('--keep') })
  })
}
