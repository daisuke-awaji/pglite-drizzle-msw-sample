import { sendToRum } from './rum'

// 想定外のエラーを 1 か所に集める。コンソールに出し、本番のビルドでは CloudWatch RUM にも送る（src/lib/rum.ts）。
// 送り先を変えるときも、呼び出し側は変えなくてよい
export type ErrorContext = { source: 'route' | 'boot' | 'unhandled' | 'action'; [key: string]: unknown }

export function reportError(error: unknown, context: ErrorContext): void {
  console.error(`[${context.source}]`, error, context)
  sendToRum(error)
}
