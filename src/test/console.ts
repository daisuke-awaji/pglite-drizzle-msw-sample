import { afterEach, beforeEach, vi } from 'vitest'

// テスト中の console.error / console.warn は「見落とした不具合」のことが多い
// （React の act 警告、key の重複、未処理の Promise、MSW の未定義リクエストなど）。
// 黙って流さず、そのテストを失敗にする。わざと出すテストでは allowConsole() で許可する

type Level = 'error' | 'warn'
let allowed: { level: Level | 'any'; pattern: RegExp }[] = []
let calls: { level: Level; text: string }[] = []

/** このテストの中で、pattern に合う console 出力を許す（テストが終わると元に戻る） */
export function allowConsole(pattern: RegExp, level: Level | 'any' = 'any') {
  allowed.push({ level, pattern })
}

const format = (args: unknown[]) =>
  args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : safeJson(a))).join(' ')

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function installConsoleGuard() {
  beforeEach(() => {
    allowed = []
    calls = []
    for (const level of ['error', 'warn'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        calls.push({ level, text: format(args) })
      })
    }
  })
  afterEach(() => {
    vi.mocked(console.error).mockRestore()
    vi.mocked(console.warn).mockRestore()
    const unexpected = calls.filter(
      (c) => !allowed.some((a) => (a.level === 'any' || a.level === c.level) && a.pattern.test(c.text)),
    )
    if (unexpected.length > 0) {
      throw new Error(
        `想定外の console 出力が ${unexpected.length} 件ありました（意図したものなら allowConsole() で許可する）:\n` +
          unexpected.map((c) => `  console.${c.level}: ${c.text.slice(0, 500)}`).join('\n'),
      )
    }
  })
}
