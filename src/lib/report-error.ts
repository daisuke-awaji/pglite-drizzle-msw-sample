// 想定外のエラーを 1 か所に集める。いまはコンソールに出すだけだが、本番では
// Sentry や CloudWatch RUM などの監視サービスへ送る処理をここに足す（呼び出し側は変えなくてよい）
export type ErrorContext = { source: 'route' | 'boot' | 'unhandled' | 'action'; [key: string]: unknown }

export function reportError(error: unknown, context: ErrorContext): void {
  console.error(`[${context.source}]`, error, context)
}
