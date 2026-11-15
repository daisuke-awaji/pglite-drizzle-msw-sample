import { InvokeCommand } from '@aws-sdk/client-lambda'
import { context, createClients, getParams, log, main, parseEnv, type Clients, type Context } from './lib.ts'

// マイグレーションを流す（docs/production.md「いつものリリース」の 4）。migrate 関数を同期で 1 回だけ呼ぶ。
// - SDK のやり直しはしない（lib.ts の LambdaClient。タイムアウトで 2 回流さない）
// - 関数のエラー（FunctionError）と、戻り値の ok を確かめる。失敗したらここで止まり、API も画面も古いまま

export type MigrateMode = 'pre' | 'migrate' | 'status'

export async function invokeJson(clients: Clients, functionName: string, payload: unknown): Promise<Record<string, unknown>> {
  const res = await clients.lambda.send(new InvokeCommand({ FunctionName: functionName, InvocationType: 'RequestResponse', Payload: new TextEncoder().encode(JSON.stringify(payload)) }))
  const text = res.Payload ? new TextDecoder().decode(res.Payload) : ''
  if (res.FunctionError) {
    let message = text
    try {
      const err = JSON.parse(text) as { errorType?: string; errorMessage?: string }
      message = `${err.errorType ?? 'Error'}: ${err.errorMessage ?? text}`
    } catch {
      // そのまま
    }
    throw new Error(`${functionName} が失敗しました（${res.FunctionError}）: ${message}`)
  }
  const body = JSON.parse(text || 'null') as Record<string, unknown> | null
  if (!body || body.ok !== true) throw new Error(`${functionName} の戻り値が ok ではありません: ${text}`)
  return body
}

export async function runMigrate({ clients, ctx, mode }: { clients: Clients; ctx: Context; mode: MigrateMode }) {
  const { 'migrate/function-name': fn } = await getParams(clients.ssm, ctx, ['migrate/function-name'])
  log(`${fn} を呼びます`, { mode })
  const result = await invokeJson(clients, fn!, { mode })
  log('終わりました', result)
  return result
}

// node scripts/deploy/migrate.ts <env> [pre|migrate|status]
if (import.meta.main) {
  await main(async () => {
    const ctx = context(parseEnv(process.argv[2]))
    const mode = (process.argv[3] ?? 'migrate') as MigrateMode
    if (!['pre', 'migrate', 'status'].includes(mode)) throw new Error(`mode は pre / migrate / status: ${mode}`)
    return runMigrate({ clients: createClients(ctx.region), ctx, mode })
  })
}
