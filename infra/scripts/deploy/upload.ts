import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { context, createClients, getParams, log, main, parseEnv, parseSha, type Clients, type Context } from './lib.ts'

// サーバーの zip（scripts/build-server.mjs が作る dist-server/api.zip・migrate.zip）を S3 に置く（docs/production.md の 2）。
// キーは api/<SHA>.zip。同じキーには上書きしない（If-None-Match: *）。同じ中身で流し直したとき（ジョブのやり直し）だけは通す

export const isPreconditionFailed = (e: unknown) => {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } }
  return err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412
}

export async function putOnce(clients: Clients, bucket: string, key: string, body: Buffer, extra: { ContentType?: string; CacheControl?: string } = {}) {
  const checksum = createHash('sha256').update(body).digest('base64')
  try {
    await clients.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256', ChecksumSHA256: checksum, ...extra }))
    return 'uploaded' as const
  } catch (e) {
    if (!isPreconditionFailed(e)) throw e
    const head = await clients.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }))
    if (head.ChecksumSHA256 === checksum) return 'unchanged' as const
    throw new Error(`s3://${bucket}/${key} は別の中身ですでにあります。上書きしません（同じ SHA で違うビルドができている）`, { cause: e })
  }
}

export async function uploadCode({ clients, ctx, sha, distDir }: { clients: Clients; ctx: Context; sha: string; distDir: string }) {
  const { 'code-bucket': bucket } = await getParams(clients.ssm, ctx, ['code-bucket'])
  const result: Record<string, string> = {}
  for (const name of ['api', 'migrate'] as const) {
    const key = `${name}/${sha}.zip`
    result[key] = await putOnce(clients, bucket!, key, readFileSync(join(distDir, `${name}.zip`)), { ContentType: 'application/zip' })
    log(`s3://${bucket}/${key}: ${result[key]}`)
  }
  return { ok: true, bucket, objects: result }
}

// node scripts/deploy/upload.ts <env> <SHA> [dist-server のフォルダー]
if (import.meta.main) {
  await main(async () => {
    const ctx = context(parseEnv(process.argv[2]))
    return uploadCode({ clients: createClients(ctx.region), ctx, sha: parseSha(process.argv[3]), distDir: process.argv[4] ?? '../dist-server' })
  })
}
