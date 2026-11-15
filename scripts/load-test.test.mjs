import { describe, expect, test } from 'vitest'
import { percentile, pick, summarize } from './load-test.mjs'

describe('負荷試験の集計', () => {
  test('百分位は「その値以下が p% になる最小の値」', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1)
    expect([percentile(sorted, 50), percentile(sorted, 95), percentile(sorted, 99), percentile([], 95)]).toEqual([50, 95, 99, 0])
  })

  test('重みつきで操作を選ぶ', () => {
    const ops = [{ name: 'a', weight: 3 }, { name: 'b', weight: 1 }]
    expect([0, 0.5, 0.74, 0.75, 0.99].map((r) => pick(ops, r).name)).toEqual(['a', 'a', 'a', 'b', 'b'])
  })

  test('5xx と通信の失敗（0）を数える', () => {
    const r = summarize([{ name: 'x', status: 200, ms: 10 }, { name: 'x', status: 503, ms: 20 }, { name: 'y', status: 0, ms: 30 }], 2)
    expect(r).toMatchObject({ requests: 3, rps: 1.5, serverErrors: 2, byStatus: { 0: 1, 200: 1, 503: 1 } })
  })
})
