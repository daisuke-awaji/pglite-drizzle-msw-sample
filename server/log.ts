// 1 行 1 イベントのログ。Lambda Web Functions は console に渡したオブジェクトを、そのまま JSON の message に入れ、
// requestId・endpointName・region を足して CloudWatch Logs に送る（文字列にすると中の項目を検索できなくなる）。
// 本文・クエリ文字列の検索語・メールアドレスは出さない（docs/production.md「ログ」）

export type LogFields = { type: string } & Record<string, unknown>

export type Logger = {
  info(fields: LogFields): void
  warn(fields: LogFields): void
  error(fields: LogFields): void
}

export const consoleLogger: Logger = {
  // oxlint-disable-next-line no-console -- ログの出口はここだけ。Lambda が INFO として集める
  info: (fields) => console.info(fields),
  warn: (fields) => console.warn(fields),
  error: (fields) => console.error(fields),
}

/** テストで出力を確かめるためのロガー */
export function memoryLogger() {
  const lines: (LogFields & { level: 'info' | 'warn' | 'error' })[] = []
  const logger: Logger = {
    info: (f) => lines.push({ level: 'info', ...f }),
    warn: (f) => lines.push({ level: 'warn', ...f }),
    error: (f) => lines.push({ level: 'error', ...f }),
  }
  return { logger, lines }
}

/** 例外を、ログに出してよい形にする（SQL の値やスタックトレースはサーバーのログにだけ残す） */
export function describeError(e: unknown): { name: string; message: string; code?: string; stack?: string } {
  const err = e instanceof Error ? e : new Error(String(e))
  const code = (err as { code?: unknown }).code ?? (err as { cause?: { code?: unknown } }).cause?.code
  return { name: err.name, message: err.message, ...(typeof code === 'string' ? { code } : {}), stack: err.stack }
}
