import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
// @ts-expect-error -- JS のビルドスクリプト（型はない）
import { buildServer } from '../scripts/build-server.mjs'
// @ts-expect-error -- JS のビルドスクリプト（型はない）
import { readZip } from '../scripts/zip.mjs'
import { adminQuery, freshDatabase } from './testing/pg'

// ビルドした zip を展開して、その中身を Node 24 でそのまま動かす（Lambda Web Functions の決まりどおりに動くか）。
// docs/production.md「server/index.ts の試作」の表を、リポジトリのコードで確かめ直す

let work: string
let apiDir: string
let migrateDir: string
let db: Awaited<ReturnType<typeof freshDatabase>>
const children: ChildProcess[] = []

function extract(zipPath: string, to: string) {
  for (const [path, data] of readZip(readFileSync(zipPath)) as Map<string, Buffer>) {
    mkdirSync(dirname(join(to, path)), { recursive: true })
    writeFileSync(join(to, path), data)
  }
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'bundle-'))
  const { outDir } = await buildServer({ outDir: join(work, 'dist') })
  apiDir = join(work, 'api')
  migrateDir = join(work, 'migrate')
  extract(join(outDir, 'api.zip'), apiDir)
  extract(join(outDir, 'migrate.zip'), migrateDir)
  db = await freshDatabase()
}, 120_000)

// テストは乱数順で走るので、API を動かす前に必ずマイグレーションを済ませておく（何度流しても同じ）
async function migrated() {
  const proc = run([join(migrateDir, 'index.mjs'), 'migrate'], { MIGRATOR_DATABASE_URL: db.url })
  if ((await proc.exited) !== 0) throw new Error(proc.output())
  return proc
}

afterAll(async () => {
  for (const c of children) c.kill('SIGKILL')
  await db?.drop()
  rmSync(work, { recursive: true, force: true })
})

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

function run(cmd: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, cmd, { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let output = ''
  child.stdout.on('data', (d: Buffer) => (output += d.toString()))
  child.stderr.on('data', (d: Buffer) => (output += d.toString()))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  return { child, exited, output: () => output }
}

async function startApi(env: Record<string, string>) {
  const port = await freePort()
  const started = performance.now()
  const proc = run([join(apiDir, 'index.js')], { AWS_LAMBDA_HTTP_ENDPOINT: `127.0.0.1:${port}`, BUILD_SHA: 'bundle-test', ...env })
  const base = `http://127.0.0.1:${port}`
  for (;;) {
    try {
      await fetch(`${base}/api/nothing`)
      break
    } catch {
      if (performance.now() - started > 10_000) throw new Error(`10 秒以内に listen しませんでした:\n${proc.output()}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return { ...proc, base, listenMs: performance.now() - started }
}

const connections = async () =>
  (await adminQuery(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'api'`, [db.name])).rows[0].n as number

describe('migrate.zip', () => {
  test('CLI として流せ、status で未適用がないことを確かめられる', async () => {
    const env = { MIGRATOR_DATABASE_URL: db.url }
    const first = await migrated()
    expect(JSON.parse(first.output().trim().split('\n').at(-1)!)).toMatchObject({ ok: true })
    const status = run([join(migrateDir, 'index.mjs'), 'status'], env)
    expect(await status.exited).toBe(0)
    expect(JSON.parse(status.output().trim().split('\n').at(-1)!)).toEqual({ ok: true, pending: [] })
  })
})

describe('api.zip（index.js）', () => {
  test('すぐに listen し、64 本を同時に受けても 5xx を出さず、接続はプールの上限まで。SIGTERM で 1 秒以内に終わる', async () => {
    await migrated()
    const api = await startApi({ DATABASE_URL: db.url, DB_POOL_MAX: '10' })
    // 決まりは 10 秒以内。DB にはまだつながない
    expect(api.listenMs).toBeLessThan(2000)
    expect(await connections()).toBe(0)
    const ready = await fetch(`${api.base}/api/readyz`)
    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({ status: 'ok', build: 'bundle-test' })

    let peak = 0
    const watcher = setInterval(() => void connections().then((n) => (peak = Math.max(peak, n))), 10)
    const statuses = await Promise.all(
      Array.from({ length: 64 }, (_, i) =>
        (i % 2
          ? fetch(`${api.base}/api/tags`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `tag-${i}` }) })
          : fetch(`${api.base}/api/projects`)
        ).then((r) => r.status),
      ),
    )
    clearInterval(watcher)
    expect(statuses.filter((s) => s >= 500)).toEqual([])
    expect(statuses.filter((s) => s === 201)).toHaveLength(32)
    expect(peak).toBeLessThanOrEqual(10)

    const stopping = performance.now()
    api.child.kill('SIGTERM')
    expect(await api.exited).toBe(0)
    expect(performance.now() - stopping).toBeLessThan(1000)
    expect(await connections()).toBe(0)
    // 1 行 1 JSON のログ（ルートの形と状態コード）
    expect(api.output()).toContain("route: '/api/tags'")
  })

  test('DB につながらなくても listen はでき、readyz は 503、API は中身を隠した 500', async () => {
    const api = await startApi({ DATABASE_URL: 'postgres://app:pw@127.0.0.1:1/app', DB_CONNECT_TIMEOUT_MS: '1000' })
    const ready = await fetch(`${api.base}/api/readyz`)
    expect(ready.status).toBe(503)
    const res = await fetch(`${api.base}/api/projects`)
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('127.0.0.1')
    api.child.kill('SIGTERM')
    expect(await api.exited).toBe(0)
  })
})
