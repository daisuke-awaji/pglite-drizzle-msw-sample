import { Sha256 } from '@aws-crypto/sha256-js'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { SignatureV4 } from '@smithy/signature-v4'
import type { AwsCredentialIdentityProvider } from '@smithy/types'
import { log, main } from './lib.ts'

// スモークテスト（docs/production.md「いつものリリース」の 5 と 8）。データを変えないリクエストだけを送る。
// - endpoint: next（確認用）の endpoint に、SigV4（サービス名 lambda）で署名して直接送る。
//   IamAuth の endpoint は X-Amz-Content-SHA256 ヘッダーがないと 403 を返す
// - site: CloudFront 経由（OAC が署名する）。画面・SPA の書き換え・API・WAF を通ることを確かめる

export type AuthMode = 'cognito' | 'none'

export type SmokeOptions = {
  /** endpoint に直接送るときの署名（site のときは付けない） */
  sign?: { region: string; credentials?: AwsCredentialIdentityProvider }
  /** /api/readyz が返すビルドの SHA（新しい revision に当たっているか） */
  expectBuild?: string
  authMode: AuthMode
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type Check = { name: string; ok: boolean; detail: string }

async function request(base: string, path: string, init: { method?: string; body?: string; headers?: Record<string, string> }, o: SmokeOptions) {
  const url = new URL(path, base)
  const headers: Record<string, string> = { accept: 'application/json', ...init.headers }
  if (o.sign) {
    const signer = new SignatureV4({ service: 'lambda', region: o.sign.region, credentials: o.sign.credentials ?? fromNodeProviderChain(), sha256: Sha256 })
    // 本文は署名に含めない（Lambda は本文を確かめない）。ヘッダーそのものは必須
    headers['x-amz-content-sha256'] = 'UNSIGNED-PAYLOAD'
    const signed = await signer.sign({
      method: init.method ?? 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...headers, host: url.host },
      body: init.body,
    })
    Object.assign(headers, signed.headers)
    delete headers.host
  }
  const res = await (o.fetchImpl ?? fetch)(url, { method: init.method ?? 'GET', headers, body: init.body, signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) })
  const text = await res.text()
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', text }
}

function check(checks: Check[], name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail })
  log(`${ok ? '✓' : '✗'} ${name}`, { detail })
}

/** API だけ（next の endpoint）。DB まで届くか、ルートが登録されているか、認証が効いているか */
export async function smokeApi(base: string, o: SmokeOptions): Promise<Check[]> {
  const checks: Check[] = []
  // 実行環境が 0 からの起動と、一時停止した Aurora の再開（15 秒ほど）を待つ
  const ready = await request(base, '/api/readyz', {}, { ...o, timeoutMs: o.timeoutMs ?? 40_000 })
  const build = ready.status === 200 ? (JSON.parse(ready.text) as { build?: string }).build : undefined
  check(checks, 'GET /api/readyz が 200', ready.status === 200, `${ready.status} ${ready.text.slice(0, 200)}`)
  if (o.expectBuild) check(checks, '新しいビルドに当たっている', build === o.expectBuild, `build=${build} expected=${o.expectBuild}`)
  const missing = await request(base, '/api/__smoke__/missing', {}, o)
  check(checks, 'ない API は JSON の 404', missing.status === 404 && missing.contentType.includes('application/json'), `${missing.status} ${missing.contentType}`)
  const list = await request(base, '/api/projects', {}, o)
  const expected = o.authMode === 'cognito' ? 401 : 200
  check(checks, `GET /api/projects が ${expected}（${o.authMode === 'cognito' ? 'ログインなしは断る' : '認証なし'}）`, list.status === expected, `${list.status}`)
  return checks
}

/** CloudFront 経由。画面・SPA の書き換え・API（OAC の署名）・POST が通るか */
export async function smokeSite(base: string, o: SmokeOptions): Promise<Check[]> {
  const checks = await smokeApi(base, o)
  const index = await request(base, '/', { headers: { accept: 'text/html' } }, o)
  check(checks, 'GET / が index.html', index.status === 200 && index.contentType.includes('text/html'), `${index.status} ${index.contentType}`)
  const deep = await request(base, '/projects/1', { headers: { accept: 'text/html' } }, o)
  check(checks, '画面の URL（/projects/1）も index.html', deep.status === 200 && deep.text.includes('<div id="root">'), `${deep.status}`)
  const asset = await request(base, '/assets/__smoke__-missing.js', {}, o)
  check(checks, 'ない JS は index.html にしない', asset.status !== 200 || !asset.text.includes('<div id="root">'), `${asset.status}`)
  if (o.authMode === 'cognito') {
    // 本文のある POST が OAC（UNSIGNED-PAYLOAD）を通って API まで届き、ログインなしで断られる（データは変わらない）
    const post = await request(base, '/api/tags', { method: 'POST', body: JSON.stringify({ name: 'smoke' }), headers: { 'content-type': 'application/json' } }, o)
    check(checks, 'POST も API まで届く（ログインなしは 401）', post.status === 401, `${post.status}`)
  }
  return checks
}

export function assertPassed(checks: Check[]) {
  const failed = checks.filter((c) => !c.ok)
  if (failed.length) throw new Error(`スモークテストに失敗しました: ${failed.map((c) => `${c.name}（${c.detail}）`).join(' / ')}`)
}

// node scripts/deploy/smoke.ts <URL> [--signed] [--site] [--auth cognito|none] [--build <SHA>] [--region ap-northeast-1]
if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string) => args.includes(`--${name}`)
  const value = (name: string) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const base = args.find((a) => /^https?:\/\//.test(a))
  await main(async () => {
    if (!base) throw new Error('URL を渡してください')
    const o: SmokeOptions = {
      authMode: (value('auth') as AuthMode | undefined) ?? 'cognito',
      expectBuild: value('build'),
      sign: flag('signed') ? { region: value('region') ?? 'ap-northeast-1' } : undefined,
    }
    const checks = flag('site') ? await smokeSite(base, o) : await smokeApi(base, o)
    assertPassed(checks)
    return { ok: true, checks: checks.length }
  })
}
