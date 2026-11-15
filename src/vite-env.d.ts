/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API のベース URL。未指定ならサイトと同じ場所の /api（= MSW が受ける） */
  readonly VITE_API_BASE?: string
  /** "false" にするとモック（MSW + PGlite）を起動せず、本物の API に直接つなぐ */
  readonly VITE_USE_MOCK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
