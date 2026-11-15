import { describe, expect, test } from 'vitest'
import { ApiError } from '../api/client'
import { describeError } from './describe-error'

// ルートの ErrorBoundary に届くエラーの形ごとに、画面の出し分けが決まる。
// loader で throw data('…', { status }) すると、ErrorBoundary にはこの形（ErrorResponse）で届く
const routeError = (status: number, message: string) => ({ status, statusText: '', internal: false, data: message })

describe('describeError', () => {
  test('404 は「見つかりません」', async () => {
    expect(describeError(routeError(404, 'タスク 1 が見つかりません'))).toEqual({
      kind: 'not-found',
      status: 404,
      message: 'タスク 1 が見つかりません',
    })
  })

  test('403 などの HTTP エラーは、状態コードとサーバーの文言をそのまま出す', async () => {
    expect(describeError(routeError(403, '権限がありません'))).toMatchObject({ kind: 'http', status: 403 })
  })

  test('通信断と 5xx は「再試行」できる', () => {
    expect(describeError(new ApiError('network', 0, '接続できません'))).toEqual({
      kind: 'retryable',
      status: undefined,
      message: '接続できません',
    })
    expect(describeError(new ApiError('http', 503, '混雑'))).toMatchObject({ kind: 'retryable', status: 503 })
  })

  test('それ以外の例外は「想定外」にし、内部の文言は利用者に見せない', () => {
    const d = describeError(new TypeError('Cannot read properties of undefined'))
    expect(d.kind).toBe('unexpected')
    expect(d.message).not.toMatch(/Cannot read/)
    expect(describeError(new ApiError('parse', 200, '読めない')).kind).toBe('unexpected')
  })
})
