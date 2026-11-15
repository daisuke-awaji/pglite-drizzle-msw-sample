import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

// 本番のサーバー（server/）が読み込んでよいもの。画面・モック・ブラウザ専用の DB を持ち込まない
// （src/ の中の決まりは src/architecture.test.ts）
const IMPORT = /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm

const files = readdirSync('server', { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile() && d.name.endsWith('.ts') && !d.name.endsWith('.test.ts') && !d.parentPath.includes('testing'))
  .map((d) => join(d.parentPath, d.name))

const imports = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(IMPORT)].map((m) => ({ file: f, spec: (m[1] ?? m[2])! })))

describe('server/ の依存', () => {
  test('ファイルと import を読めている', () => {
    expect(files).toContain(join('server', 'index.ts'))
    expect(imports.some((i) => i.spec === '../src/server/routes')).toBe(true)
  })

  test('src/ から読むのは src/server・src/db/schema・src/shared だけ', () => {
    const bad = imports.filter((i) => i.spec.startsWith('../src/') && !/^\.\.\/src\/(server\/|db\/schema$|shared\/)/.test(i.spec))
    expect(bad.map((i) => `${i.file} → ${i.spec}`)).toEqual([])
  })

  test('画面・モック・ブラウザの DB のライブラリを読まない', () => {
    const bad = imports.filter((i) => /^(react|react-dom|react-router|msw|@ui-sdk|zustand|lucide-react|@electric-sql\/pglite|aws-rum-web)/.test(i.spec))
    expect(bad.map((i) => `${i.file} → ${i.spec}`)).toEqual([])
  })
})
