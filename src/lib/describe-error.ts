import { isRouteErrorResponse } from 'react-router'
import { ApiError } from '../api/client'

// ルートのエラーを、画面に出す種類に分ける。
// 404 と「やり直せば直りうるエラー」と「想定外のエラー」で、文言と出すボタンを変える
export type ErrorKind = 'not-found' | 'retryable' | 'unexpected' | 'http'

export function describeError(error: unknown): { kind: ErrorKind; status?: number; message: string } {
  if (isRouteErrorResponse(error)) {
    return { kind: error.status === 404 ? 'not-found' : 'http', status: error.status, message: String(error.data) }
  }
  if (error instanceof ApiError && error.retryable) return { kind: 'retryable', status: error.status || undefined, message: error.message }
  return { kind: 'unexpected', message: '画面を表示できませんでした。ページを読み込み直してください。' }
}

