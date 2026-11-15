import { describe, expect, test } from 'vitest'
import { createZip, readZip } from './zip.mjs'

describe('再現できる zip', () => {
  const files = [
    { path: 'index.js', data: Buffer.from('console.log(1)') },
    { path: 'certs/ca.pem', data: Buffer.from('x'.repeat(10_000)) },
    { path: '日本語.txt', data: Buffer.from('こんにちは') },
  ]

  test('中身を読み戻せる（CRC も確かめる）', () => {
    const out = readZip(createZip(files))
    expect([...out.keys()]).toEqual(['certs/ca.pem', 'index.js', '日本語.txt'])
    expect(out.get('日本語.txt').toString()).toBe('こんにちは')
  })

  test('渡す順番が違っても同じバイト列になる（S3 のキーと sha256 がビルドした場所で変わらない）', () => {
    expect(createZip(files).equals(createZip(files.toReversed()))).toBe(true)
  })

  test('同じパス・外に出るパスは作らない', () => {
    expect(() => createZip([files[0], files[0]])).toThrow(/同じパス/)
    expect(() => createZip([{ path: '../x', data: Buffer.from('') }])).toThrow(/パスが正しくありません/)
  })
})
