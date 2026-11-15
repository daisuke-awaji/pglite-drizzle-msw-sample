import { toast } from '@ui-sdk/react/toast'
import { data, type Params } from 'react-router'
import type { z } from 'zod'
import { ApiError } from '../api/client'
import { fieldErrorsOf, formToObject, type FieldErrors } from '../shared/schemas'

// route の loader / action で共通に使う小さな道具

export type ActionResult =
  | { ok: true; intent: string; id?: number }
  | { ok: false; intent: string; error: string; fieldErrors?: FieldErrors; retryable?: boolean }

export function idParam(params: Params, key: string): number {
  const id = Number(params[key])
  if (!Number.isInteger(id) || id <= 0) throw data('ページが見つかりません', { status: 404 })
  return id
}

// loader で API のエラーをルートのエラーにする（ErrorBoundary が表示する）。
// - 404 などやり直しても変わらないエラーは、状態コード付きのルートのエラーにする
// - 通信断や 5xx など、やり直せば直りうるエラーは ApiError のまま投げ、画面に「再試行」を出す
export async function load<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (e) {
    if (e instanceof ApiError && e.kind === 'http' && !e.retryable) throw data(e.message, { status: e.status })
    throw e
  }
}

/** 失敗しても画面の一部だけをエラー表示にしたいときに使う（設定画面など） */
export async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: ApiError }> {
  try {
    return { ok: true, value: await promise }
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e }
    throw e
  }
}

// 送信前の検証。サーバー層と同じ Zod スキーマを使うので、往復せずに同じエラーを出せる
export function validate<S extends z.ZodType>(
  intent: string,
  schema: S,
  form: FormData,
  arrayKeys: string[] = [],
): { ok: true; value: z.output<S>; raw: Record<string, unknown> } | { ok: false; result: ReturnType<typeof fail> } {
  const raw = formToObject(form, arrayKeys)
  const parsed = schema.safeParse(raw)
  if (parsed.success) return { ok: true, value: parsed.data, raw }
  return {
    ok: false,
    result: fail(intent, '入力内容を確認してください', 400, fieldErrorsOf(parsed.error)),
  }
}

export function fail(intent: string, error: string, status = 400, fieldErrors?: FieldErrors, retryable?: boolean) {
  return data<ActionResult>({ ok: false, intent, error, fieldErrors, retryable }, { status })
}

// API を呼び、成功ならトーストを出す。失敗は画面に返してフォームに表示する。
// 項目ごとのエラーがないとき（通信断・権限・競合など）は、フォームの外でも気づけるようトーストも出す
export async function run(
  intent: string,
  fn: () => Promise<unknown>,
  success?: string | ((value: unknown) => string),
): Promise<ActionResult | ReturnType<typeof fail>> {
  try {
    const value = await fn()
    if (success) toast.success(typeof success === 'function' ? success(value) : success)
    const id = (value as { id?: unknown } | undefined)?.id
    return { ok: true, intent, id: typeof id === 'number' ? id : undefined }
  } catch (e) {
    if (e instanceof ApiError) {
      if (!e.fieldErrors) toast.error(e.message)
      // 通信断のときは状態コードがないので、「一時的に使えない」の 503 として返す
      return fail(intent, e.message, e.status || 503, e.fieldErrors, e.retryable)
    }
    throw e
  }
}

export const intentOf = (form: FormData) => String(form.get('intent') ?? '')

export function unknownIntent(intent: string) {
  return fail(intent, `不明な操作です: ${intent}`)
}

export function errorsFor(result: unknown, intent: string): FieldErrors {
  const r = result as ActionResult | undefined
  return r && !r.ok && r.intent === intent ? (r.fieldErrors ?? {}) : {}
}
