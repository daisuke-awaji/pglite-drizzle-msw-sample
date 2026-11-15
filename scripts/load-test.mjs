#!/usr/bin/env node
// 負荷試験（docs/production.md「進め方」の Phase 5。maxEnvironments と接続プールの上限を決める）。依存なし（Node 24 の fetch）。
//
//   node scripts/load-test.mjs <API のベース URL> [--concurrency 64] [--duration 30] [--prepare] [--read-only] [--json]
//     例（stg の CloudFront 経由）: LOAD_TEST_TOKEN=<ID トークン> node scripts/load-test.mjs https://stg.example.com --concurrency 128 --duration 300
//     例（手元）: node scripts/load-test.mjs http://127.0.0.1:3000 --prepare
//
// - 操作の割合: プロジェクト一覧 40%・タスク一覧 30%・タスク詳細 10%・ダッシュボード 10%・タスクの作成 10%（--read-only で作成をしない）
// - --prepare: 試験用のプロジェクト（loadtest-*）とタスクを API で作ってから流す
// - 結果: 秒あたりのリクエスト数、応答時間の p50 / p95 / p99、状態コードごとの数。5xx が出たら終了コード 1
// 本番（prod）では流さない。stg で、prod と同じ maxEnvironments・プールの上限にして流す

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

const round = (n) => Math.round(n * 10) / 10
const any = (list) => list[Math.floor(Math.random() * list.length)]

export function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

/** 重みつきで操作を選ぶ（r は 0 以上 1 未満） */
export function pick(operations, r) {
  const total = operations.reduce((n, o) => n + o.weight, 0)
  let x = r * total
  for (const o of operations) {
    if ((x -= o.weight) < 0) return o
  }
  return operations.at(-1)
}

export function summarize(samples, seconds) {
  const latencies = samples.map((s) => s.ms).toSorted((a, b) => a - b)
  const byStatus = {}
  const byOperation = {}
  for (const s of samples) {
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1
    const o = (byOperation[s.name] ??= { count: 0, ms: [] })
    o.count++
    o.ms.push(s.ms)
  }
  return {
    requests: samples.length,
    rps: round(samples.length / seconds),
    latencyMs: { p50: round(percentile(latencies, 50)), p95: round(percentile(latencies, 95)), p99: round(percentile(latencies, 99)), max: round(latencies.at(-1) ?? 0) },
    byStatus,
    byOperation: Object.fromEntries(
      Object.entries(byOperation).map(([k, v]) => [k, { count: v.count, p95: round(percentile(v.ms.toSorted((a, b) => a - b), 95)) }]),
    ),
    serverErrors: samples.filter((s) => s.status >= 500 || s.status === 0).length,
  }
}

async function main() {
  const base = args.find((a) => /^https?:\/\//.test(a))
  if (!base) throw new Error('API のベース URL を渡してください（例: http://127.0.0.1:3000）')
  const concurrency = Number(value('concurrency', '64'))
  const duration = Number(value('duration', '30'))
  const token = process.env.LOAD_TEST_TOKEN
  const headers = { accept: 'application/json', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
  const call = async (method, path, body) => {
    const res = await fetch(new URL(`/api${path}`, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35_000) })
    const text = await res.text()
    return { status: res.status, json: text ? JSON.parse(text) : undefined }
  }

  if (flag('prepare')) {
    for (let i = 0; i < 5; i++) {
      const p = await call('POST', '/projects', { name: `loadtest-${Date.now().toString(36)}-${i}` })
      if (p.status !== 201) throw new Error(`プロジェクトを作れません: ${p.status} ${JSON.stringify(p.json)}`)
      for (let t = 0; t < 40; t++) await call('POST', `/projects/${p.json.id}/tasks`, { title: `タスク ${t}`, priority: ['low', 'medium', 'high'][t % 3] })
    }
  }
  const projects = (await call('GET', '/projects')).json
  if (!Array.isArray(projects) || projects.length === 0) throw new Error('プロジェクトがありません（--prepare を付ける）')
  const projectIds = projects.map((p) => p.id)
  const taskIds = []
  for (const id of projectIds.slice(0, 5)) taskIds.push(...((await call('GET', `/projects/${id}/tasks?pageSize=50`)).json?.items ?? []).map((t) => t.id))

  const operations = [
    { name: 'プロジェクト一覧', weight: 40, run: () => call('GET', '/projects') },
    { name: 'タスク一覧', weight: 30, run: () => call('GET', `/projects/${any(projectIds)}/tasks?sort=priority&page=1`) },
    { name: 'タスク詳細', weight: 10, run: () => call('GET', `/tasks/${any(taskIds.length ? taskIds : [1])}`) },
    { name: 'ダッシュボード', weight: 10, run: () => call('GET', '/dashboard') },
    ...(flag('read-only') ? [] : [{ name: 'タスクの作成', weight: 10, run: () => call('POST', `/projects/${any(projectIds)}/tasks`, { title: `負荷試験 ${Date.now()}` }) }]),
  ]

  const samples = []
  const until = performance.now() + duration * 1000
  const started = performance.now()
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < until) {
        const op = pick(operations, Math.random())
        const t0 = performance.now()
        let status = 0
        try {
          status = (await op.run()).status
        } catch {
          status = 0 // 通信の失敗・タイムアウト
        }
        samples.push({ name: op.name, status, ms: performance.now() - t0 })
      }
    }),
  )
  const result = { base, concurrency, durationSeconds: duration, ...summarize(samples, (performance.now() - started) / 1000) }
  if (flag('json')) process.stdout.write(`${JSON.stringify(result)}\n`)
  else {
    process.stdout.write(`同時 ${concurrency} 本 × ${duration} 秒: ${result.requests} 件（${result.rps} 件/秒）\n`)
    process.stdout.write(`応答時間 p50 ${result.latencyMs.p50} ms / p95 ${result.latencyMs.p95} ms / p99 ${result.latencyMs.p99} ms / 最大 ${result.latencyMs.max} ms\n`)
    process.stdout.write(`状態コード ${JSON.stringify(result.byStatus)}\n`)
    for (const [name, o] of Object.entries(result.byOperation)) process.stdout.write(`  ${name}: ${o.count} 件、p95 ${o.p95} ms\n`)
  }
  if (result.serverErrors > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
}
