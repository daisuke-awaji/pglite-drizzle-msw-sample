import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { CreateInvalidationCommand } from '@aws-sdk/client-cloudfront'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { context, createClients, getParams, log, main, parseEnv, type Clients, type Context } from './lib.ts'
import { putOnce } from './upload.ts'

// 画面を置く（docs/production.md「いつものリリース」の 7）。
// 1. ファイル名にハッシュが付いた JS・CSS（assets/）を先に置く。1 年キャッシュし、同じ名前は上書きしない
// 2. そのほかのファイル（favicon など）
// 3. 最後に index.html（キャッシュさせない）→ index.html のキャッシュだけを消す
// 古い JS・CSS は消さない（開いたままの画面が、後から読み込む JS を読みに来る）

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
}

/** GitHub Pages 用のファイル（直接開いた URL の 404.html）は置かない。CloudFront Function が index.html に書き換える */
const SKIP = new Set(['404.html'])

export type PublishPlan = { key: string; file: string; cacheControl: string; contentType: string; once: boolean }[]

export function planWeb(distDir: string): PublishPlan {
  const files = readdirSync(distDir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(distDir, join(d.parentPath, d.name)).split('\\').join('/'))
    .filter((k) => !SKIP.has(k))
  if (!files.includes('index.html')) throw new Error(`${distDir} に index.html がありません（VITE_USE_MOCK=false npm run build）`)
  const item = (key: string, cacheControl: string, once = false) => ({ key, file: join(distDir, key), cacheControl, contentType: TYPES[extname(key)] ?? 'application/octet-stream', once })
  const assets = files.filter((k) => k.startsWith('assets/')).toSorted().map((k) => item(k, 'public, max-age=31536000, immutable', true))
  const others = files.filter((k) => !k.startsWith('assets/') && k !== 'index.html').toSorted().map((k) => item(k, 'public, max-age=300'))
  return [...assets, ...others, item('index.html', 'no-cache')]
}

export async function publishWeb({ clients, ctx, distDir }: { clients: Clients; ctx: Context; distDir: string }) {
  const p = await getParams(clients.ssm, ctx, ['web/site-bucket', 'web/distribution-id'])
  const bucket = p['web/site-bucket']!
  const plan = planWeb(distDir)
  const counts = { uploaded: 0, unchanged: 0 }
  for (const f of plan) {
    const body = readFileSync(f.file)
    if (f.once) {
      counts[await putOnce(clients, bucket, f.key, body, { ContentType: f.contentType, CacheControl: f.cacheControl })]++
    } else {
      await clients.s3.send(new PutObjectCommand({ Bucket: bucket, Key: f.key, Body: body, ContentType: f.contentType, CacheControl: f.cacheControl }))
      counts.uploaded++
    }
  }
  const invalidation = await clients.cloudfront.send(
    new CreateInvalidationCommand({
      DistributionId: p['web/distribution-id'],
      InvalidationBatch: { CallerReference: `${ctx.name('web')}-${Date.now()}`, Paths: { Quantity: 1, Items: ['/index.html'] } },
    }),
  )
  log('画面を置きました', { ...counts, invalidation: invalidation.Invalidation?.Id })
  return { ok: true, files: plan.length, ...counts, invalidation: invalidation.Invalidation?.Id }
}

// node scripts/deploy/publish-web.ts <env> [dist のフォルダー]
if (import.meta.main) {
  await main(async () => {
    const ctx = context(parseEnv(process.argv[2]))
    return publishWeb({ clients: createClients(ctx.region), ctx, distDir: process.argv[3] ?? '../dist' })
  })
}
