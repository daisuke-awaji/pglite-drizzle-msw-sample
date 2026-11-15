import { serve } from '@hono/node-server'
import { createApp } from './app'
import { readConfig } from './config'
import { API_SESSION_SETTINGS, createDbProvider } from './db'
import { consoleLogger, describeError } from './log'

// Lambda Web Function の入口（zip の index.js）。ローカルでも同じものを動かす（npm run server）。
// - AWS_LAMBDA_HTTP_ENDPOINT の host:port で listen する（10 秒以内。DB はまだ待たない）
// - SIGTERM のあと 1 秒で終わる（接続プールは 0.5 秒だけ待って閉じる）
// docs/production.md「サーバーで気をつけること」

const log = consoleLogger
const config = readConfig(process.env)
const db = createDbProvider({ ...config.db, applicationName: 'api', sessionSettings: API_SESSION_SETTINGS, log })
const app = createApp({ db, log, buildSha: config.buildSha, bodyLimitBytes: config.bodyLimitBytes })

const server = serve({ fetch: app.fetch, hostname: config.listen.hostname, port: config.listen.port }, (info) =>
  log.info({ type: 'listening', address: info.address, port: info.port, build: config.buildSha, appEnv: config.appEnv }),
)

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  log.info({ type: 'shutdown', signal })
  server.close()
  // 1 秒の決まりに収めるため、プールの後片付けは 0.5 秒で打ち切る（残った接続は DB の idle_session_timeout が消す）
  await Promise.race([db.close().catch(() => {}), new Promise((r) => setTimeout(r, 500))])
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
// どこでも捕まえられなかった失敗は記録して続ける（1 つのリクエストの失敗で、同時に処理中のほかのリクエストを落とさない）
process.on('unhandledRejection', (e) => log.error({ type: 'unhandled-rejection', ...describeError(e) }))
