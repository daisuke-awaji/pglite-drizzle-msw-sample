/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API のベース URL。未指定ならサイトと同じ場所の /api（= MSW が受ける） */
  readonly VITE_API_BASE?: string
  /** "false" にするとモック（MSW + PGlite）を起動せず、本物の API に直接つなぐ */
  readonly VITE_USE_MOCK?: string
  /** CloudWatch RUM のアプリモニター。あるときだけ画面のエラーを送る（src/lib/rum.ts） */
  readonly VITE_RUM_APP_MONITOR_ID?: string
  readonly VITE_RUM_REGION?: string
  /** ビルドしたコミット（RUM とサーバーのログを突き合わせる） */
  readonly VITE_APP_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
