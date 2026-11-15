import { context, createClients, getParams, main, parseEnv, parseSha, type Clients, type Context } from './lib.ts'

// 画面のビルドに渡す環境変数（KEY=VALUE を 1 行ずつ）。GitHub Actions では >> "$GITHUB_ENV" に足す。
// 値は CDK が書いた SSM パラメーター（Auth・Monitoring のスタック）から読む。秘密の値は含まない

export async function webEnv({ clients, ctx, sha }: { clients: Clients; ctx: Context; sha: string }): Promise<Record<string, string>> {
  const p = await getParams(clients.ssm, ctx, ['auth/domain', 'auth/client-id', 'web/rum-app-monitor-id', 'web/site-domain'], ['web/site-domain'])
  const env: Record<string, string> = {
    VITE_USE_MOCK: 'false',
    VITE_APP_VERSION: sha,
    VITE_RUM_REGION: ctx.region,
  }
  if (p['web/rum-app-monitor-id']) env.VITE_RUM_APP_MONITOR_ID = p['web/rum-app-monitor-id']
  if (p['auth/domain'] && p['auth/client-id']) {
    env.VITE_AUTH_MODE = 'cognito'
    env.VITE_COGNITO_DOMAIN = p['auth/domain']
    env.VITE_COGNITO_CLIENT_ID = p['auth/client-id']
  }
  return env
}

export const toDotenv = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => {
      if (/[\r\n]/.test(v)) throw new Error(`${k} に改行があります`)
      return `${k}=${v}`
    })
    .join('\n')

// node scripts/deploy/web-env.ts <env> <SHA>
if (import.meta.main) {
  await main(async () => {
    const ctx = context(parseEnv(process.argv[2]))
    process.stdout.write(`${toDotenv(await webEnv({ clients: createClients(ctx.region), ctx, sha: parseSha(process.argv[3]) }))}\n`)
  })
}
