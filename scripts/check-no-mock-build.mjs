// 本番向け（VITE_USE_MOCK=false）のビルドに、プロトタイプ専用の機能が残っていないかを確かめる。
// 残っていると、本番の API へ「全データの初期化」を送るボタンや、ブラウザ内 DB（PGlite 約 16 MB）が配信されてしまう
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const outDir = mkdtempSync(join(tmpdir(), 'no-mock-build-'))
execFileSync('npx', ['vite', 'build', '--outDir', outDir, '--logLevel', 'warn', '--emptyOutDir'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_USE_MOCK: 'false', VITE_API_BASE: 'https://api.example.com/api' },
})

/** ビルドに含まれてはいけないもの: [説明, ファイル名か中身に現れる目印] */
const FORBIDDEN = [
  ['MSW の Service Worker', /mockServiceWorker/],
  // index.html の説明文（meta description）に出てくる「PGlite」は対象外にする
  ['PGlite（ブラウザ内の PostgreSQL）', /@electric-sql|pglite[-.]|\/pglite\/|idb:\/\//],
  ['開発用のエンドポイント', /\/_reset|\/_debug/],
  ['障害シミュレーションの設定', /障害シミュレーション/],
  ['window.agent の公開', /Object\.assign\(window,\s*\{\s*agent/],
]

const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
  .filter((f) => f.isFile())
  .map((f) => join(f.parentPath, f.name))

const problems = []
for (const file of files) {
  const name = relative(outDir, file)
  const text = /\.(js|html|css|json)$/.test(name) ? readFileSync(file, 'utf8') : ''
  for (const [what, pattern] of FORBIDDEN) {
    if (pattern.test(name) || pattern.test(text)) problems.push(`${name}: ${what}`)
  }
}

if (problems.length > 0) {
  console.error('VITE_USE_MOCK=false のビルドに、プロトタイプ専用のものが残っています:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
process.stdout.write(`VITE_USE_MOCK=false のビルド（${files.length} ファイル）に、プロトタイプ専用のものは含まれていません\n`)
