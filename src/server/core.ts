import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { z } from 'zod'
import type * as schema from '../db/schema'
import { fieldErrorsOf, type FieldErrors } from '../shared/schemas'

// src/server は「本番のバックエンドにそのまま持っていく層」。
// HTTP（MSW）にも PGlite にも依存せず、PostgreSQL 用の Drizzle インスタンスを受け取るだけ。
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

export class HttpError extends Error {
  readonly status: number
  readonly fieldErrors?: FieldErrors
  constructor(status: number, message: string, fieldErrors?: FieldErrors) {
    super(message)
    this.status = status
    this.fieldErrors = fieldErrors
  }
}

export const notFound = (what: string, id: number) =>
  new HttpError(404, `${what} ${id} が見つかりません`)

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new HttpError(400, '入力内容を確認してください', fieldErrorsOf(result.error))
  }
  return result.data
}

export const iso = (d: Date) => d.toISOString()

// PostgreSQL の一意制約違反（23505）を 409 に変換する
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null
  return err?.code === '23505' || err?.cause?.code === '23505'
}

/** ILIKE で「この文字列を含む」を探すためのパターン。% と _ と \ は文字そのものとして扱う */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}
