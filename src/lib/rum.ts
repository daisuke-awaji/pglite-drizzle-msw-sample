import type { AwsRum } from 'aws-rum-web'

// 画面のエラーを CloudWatch RUM に送る（本番のビルドで VITE_RUM_APP_MONITOR_ID を渡したときだけ）。
// - アプリモニターのリソースポリシーで、署名なしの送信を許す（Cognito の ID プールを作らない。infra/lib/monitoring.ts）
// - 読み込むのは最初のエラーのときだけ。モックのビルド（VITE_USE_MOCK）や設定のないビルドには入らない
// - クッキーを使わず、利用者を見分ける ID も残さない（セッションはタブを閉じるまで）
//
// import.meta.env はこのファイルで直接読む（別の定数を通すと、条件は消えても動的 import の先がビルドに出力される）

let rum: Promise<AwsRum | undefined> | undefined

async function load(): Promise<AwsRum | undefined> {
  const appMonitorId = import.meta.env.VITE_RUM_APP_MONITOR_ID
  if (!appMonitorId) return undefined
  const region = import.meta.env.VITE_RUM_REGION ?? 'ap-northeast-1'
  const { AwsRum } = await import('aws-rum-web')
  return new AwsRum(appMonitorId, import.meta.env.VITE_APP_VERSION ?? 'unknown', region, {
    signing: false,
    endpoint: `https://dataplane.rum.${region}.amazonaws.com`,
    telemetries: ['errors'],
    allowCookies: false,
    sessionSampleRate: 1,
    // URL のクエリ文字列（検索語など）は送らない
    pageIdFormat: 'PATH',
  })
}

async function record(error: unknown) {
  try {
    rum ??= load()
    ;(await rum)?.recordError(error)
  } catch {
    // 読み込みや送信に失敗しても何もしない（監視の失敗で画面を止めない）。次のエラーで読み込み直す
    rum = undefined
  }
}

export function sendToRum(error: unknown): void {
  if (!import.meta.env.VITE_RUM_APP_MONITOR_ID) return
  void record(error)
}
