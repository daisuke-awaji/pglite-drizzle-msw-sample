import './agent'
import { toast } from '@ui-sdk/react/toast'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router/dom'
import { isAbortError } from './api/client'
import { renderBootError } from './boot-error'
import { reportError } from './lib/report-error'
import { createRouter } from './router'
import './index.css'

const root = document.getElementById('root')!

// どこでも捕まえられなかった Promise の失敗。黙って消えると「押しても何も起きない」に見えるので、利用者にも知らせる
window.addEventListener('unhandledrejection', (event) => {
  if (isAbortError(event.reason)) return
  reportError(event.reason, { source: 'unhandled' })
  toast.error('予期しないエラーが起きました。操作をやり直してください')
})

async function main() {
  // 既定ではモック API（MSW + PGlite）をブラウザ内で起動する。
  // 本番の API につなぐときは VITE_USE_MOCK=false でビルドすると、PGlite もバンドルに含まれない。
  // src/lib/env.ts の USES_MOCK_API と同じ判定だが、ここは import.meta.env を直接書く。
  // 別ファイルの定数を通すと、条件は消えても動的 import の先（PGlite・MSW の約 16 MB）がビルドに出力されてしまう
  if (import.meta.env.VITE_USE_MOCK !== 'false') {
    const { startMockApi } = await import('./mocks/browser')
    await startMockApi()
  }
  // ルーターの loader は作った時点で走り始めるので、モック API の起動を待ってから作る
  const router = createRouter()
  createRoot(root, {
    // React が描画中のエラーを捕まえたとき（ErrorBoundary が表示する）にも記録に残す
    onCaughtError: (error, info) => reportError(error, { source: 'route', componentStack: info.componentStack }),
  }).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  )
}

main().catch((e: unknown) => renderBootError(root, e))
