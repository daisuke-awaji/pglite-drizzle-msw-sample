#!/usr/bin/env node
// 本番のサーバーをビルドして、Lambda に渡す zip を作る（docs/production.md「いつものリリース」の 1）。
//
//   dist-server/api/        Web Function（API）。zip のいちばん上の index.js をランタイムが読む
//   dist-server/migrate/    Lambda 関数（マイグレーションの実行役 index.mjs と、DB の利用者を作る bootstrap.mjs）と drizzle/
//   dist-server/api.zip, migrate.zip, manifest.json（sha256 と大きさ）
//
// - Node 24（nodejs24.x、Arm64）向けに esbuild で 1 ファイルにまとめる。AWS SDK も含める（Web Functions のランタイムにない）
// - zip は同じ中身なら同じバイト列（scripts/zip.mjs）。S3 のキーはコミット SHA にし、上書きしない
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createZip } from './zip.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'dist-server')

// Web Function の zip は展開して 512 MB、Lambda 関数（zip）は展開して 250 MB まで。大きくなりすぎたらここで止める
const LIMITS = { api: 50 * 1024 * 1024, migrate: 50 * 1024 * 1024 }

/** ESM のバンドルから CommonJS の依存（pg など）が require を使えるようにする */
const banner = {
  js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: 'linked',
  // 例外のスタックトレースを読めるように、名前は残す（大きさより調べやすさを優先する）
  minifySyntax: true,
  minifyWhitespace: true,
  keepNames: true,
  legalComments: 'none',
  banner,
  // pg のネイティブ版は使わない（JS だけの pg で動かす）
  external: ['pg-native'],
  logLevel: 'warning',
  absWorkingDir: root,
  metafile: true,
}

function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name))
}

function zipDir(dir) {
  const files = listFiles(dir).map((f) => ({ path: relative(dir, f).split('\\').join('/'), data: readFileSync(f) }))
  return { zip: createZip(files), files: files.length, unzipped: files.reduce((n, f) => n + f.data.length, 0) }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const inputs = (meta) => Object.keys(meta.metafile.inputs).length

export async function buildServer({ outDir = out } = {}) {
  rmSync(outDir, { recursive: true, force: true })
  const apiDir = join(outDir, 'api')
  const migrateDir = join(outDir, 'migrate')
  mkdirSync(apiDir, { recursive: true })
  mkdirSync(migrateDir, { recursive: true })

  const api = await build({ ...common, entryPoints: { index: 'server/index.ts' }, outdir: apiDir, outExtension: { '.js': '.js' } })
  const migrate = await build({
    ...common,
    entryPoints: { index: 'server/migrate.ts', bootstrap: 'server/bootstrap.ts' },
    outdir: migrateDir,
    outExtension: { '.js': '.mjs' },
  })

  // index.js を ESM として読ませる
  writeFileSync(join(apiDir, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`)
  for (const dir of [apiDir, migrateDir]) cpSync(join(root, 'server/certs'), join(dir, 'certs'), { recursive: true })
  // マイグレーション（SQL・journal・事前の SQL）。実行役は zip の中の drizzle/ を読む
  cpSync(join(root, 'drizzle'), join(migrateDir, 'drizzle'), { recursive: true })

  const manifest = {}
  for (const [name, dir] of [['api', apiDir], ['migrate', migrateDir]]) {
    const { zip, files, unzipped } = zipDir(dir)
    if (zip.length > LIMITS[name]) throw new Error(`${name}.zip が大きすぎます: ${zip.length} バイト`)
    writeFileSync(join(outDir, `${name}.zip`), zip)
    manifest[name] = { sha256: sha256(zip), bytes: zip.length, unzippedBytes: unzipped, files }
  }
  manifest.modules = { api: inputs(api), migrate: inputs(migrate) }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { outDir, manifest, entry: join(apiDir, 'index.js'), sizes: { api: statSync(join(apiDir, 'index.js')).size } }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { manifest } = await buildServer()
  for (const name of ['api', 'migrate']) {
    const m = manifest[name]
    process.stdout.write(`${name}.zip  ${(m.bytes / 1024).toFixed(0)} KiB（展開 ${(m.unzippedBytes / 1024).toFixed(0)} KiB、${m.files} ファイル）  sha256 ${m.sha256}\n`)
  }
}
