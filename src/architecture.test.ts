// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'vitest'

// 構造のテスト。「どの層がどの層を知ってよいか」をコードで固定し、レビューで見落としても CI で止める。
// 本番に移るとき src/server をそのままバックエンドに持っていけるのは、この決まりが守られているから

const SRC = join(import.meta.dirname)

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

const sources = files(SRC).map((path) => ({
  path: relative(SRC, path).replaceAll('\\', '/'),
  imports: [...readFileSync(path, 'utf8').matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map(
    (m) => m[1]!,
  ),
}))

const isTest = (path: string) => /\.test\.tsx?$/.test(path) || path.startsWith('test/')
const prod = sources.filter((s) => !isTest(s.path))

function violations(layer: RegExp, forbidden: RegExp) {
  return prod
    .filter((s) => layer.test(s.path))
    .flatMap((s) => s.imports.filter((i) => forbidden.test(i)).map((i) => `${s.path} → ${i}`))
}

describe('層の依存', () => {
  test('src/server は HTTP・画面・ブラウザ専用の DB を知らない（本番のバックエンドにそのまま移せる）', () => {
    expect(
      violations(/^server\//, /^(react|react-dom|react-router|msw|@ui-sdk|lucide-react|zustand|@electric-sql\/pglite)|\.\.\/(api|routes|components|stores|mocks)\/|client\.browser/),
    ).toEqual([])
  })

  test('src/shared は Zod 以外に依存しない（サーバーと画面の両方から使う）', () => {
    expect(violations(/^shared\//, /^(?!zod$|\.\/)/)).toEqual([])
  })

  test('画面（routes・components）は DB とサーバー層を直接呼ばず、API クライアントを通す', () => {
    expect(violations(/^(routes|components)\//, /\.\.\/(server|db|mocks)\/|^drizzle-orm|^@electric-sql/)).toEqual([])
  })

  test('API クライアントは fetch だけで話し、サーバーの実装を知らない', () => {
    expect(violations(/^api\//, /\.\.\/(server|db|mocks|routes|stores)\/|^drizzle-orm|^msw/)).toEqual([])
  })

  test('本番のコードはテスト用のコードを読み込まない', () => {
    expect(violations(/./, /(^|\/)test\/|\.test$/)).toEqual([])
  })

  test('アイコンは lucide-react だけを使う', () => {
    const others = prod.flatMap((s) =>
      s.imports.filter((i) => /icon|heroicons|fontawesome|react-icons/i.test(i) && i !== 'lucide-react').map((i) => `${s.path} → ${i}`),
    )
    expect(others).toEqual([])
  })
})

describe('テストの置き場所', () => {
  test('DB を使うテストは *.integration.test.* に置く（unit は速いまま保つ）', () => {
    const slow = sources.filter(
      (s) =>
        /\.test\.tsx?$/.test(s.path) &&
        !/\.integration\.test\.tsx?$/.test(s.path) &&
        s.imports.some((i) => /test\/(db|api)$|^@electric-sql\/pglite|^msw\/node/.test(i)),
    )
    expect(slow.map((s) => s.path)).toEqual([])
  })
})
