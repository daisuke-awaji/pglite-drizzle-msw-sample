import { describe, expect, test, vi } from 'vitest'
import { cachedSecret, parseDbSecret } from './secrets'

const raw = (password: string) => JSON.stringify({ username: 'app', password, host: 'db.example', port: 5432, dbname: 'app' })

describe('秘密情報', () => {
  test('RDS の形を読む。dbname がなければ app', () => {
    expect(parseDbSecret(JSON.stringify({ username: 'u', password: 'p', host: 'h' }), 'arn')).toEqual({ username: 'u', password: 'p', host: 'h', port: 5432, dbname: 'app' })
    expect(() => parseDbSecret('{"username":"u"}', 'arn')).toThrow(/username \/ password \/ host/)
    expect(() => parseDbSecret('not json', 'arn')).toThrow(/JSON ではありません/)
  })

  test('同時に読みに来ても 1 回だけ読み、決めた時間は使い回す', async () => {
    let now = 0
    const source = vi.fn(async () => raw('p1'))
    const secret = cachedSecret('arn', { source, ttlMs: 1000, now: () => now })
    const [a, b] = await Promise.all([secret.get(), secret.get()])
    expect(a.password).toBe('p1')
    expect(b).toBe(a)
    expect(source).toHaveBeenCalledTimes(1)
    now = 999
    await secret.get()
    expect(source).toHaveBeenCalledTimes(1)
    now = 1001
    await secret.get()
    expect(source).toHaveBeenCalledTimes(2)
  })

  test('invalidate すると次は読み直す（ローテーションのあと）', async () => {
    const values = ['old', 'new']
    const secret = cachedSecret('arn', { source: async () => raw(values.shift()!) })
    expect((await secret.get()).password).toBe('old')
    secret.invalidate()
    expect((await secret.get()).password).toBe('new')
  })

  test('読み取りに失敗したら使い回さない', async () => {
    const source = vi.fn<(arn: string) => Promise<string>>().mockRejectedValueOnce(new Error('throttled')).mockResolvedValue(raw('p'))
    const secret = cachedSecret('arn', { source })
    await expect(secret.get()).rejects.toThrow('throttled')
    expect((await secret.get()).password).toBe('p')
  })
})
