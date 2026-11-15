import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

async function main() {
  // 既定ではモック API（MSW + PGlite）をブラウザ内で起動する。
  // 本番の API につなぐときは VITE_USE_MOCK=false でビルドすると、PGlite もバンドルに含まれない。
  if (import.meta.env.VITE_USE_MOCK !== 'false') {
    const { startMockApi } = await import('./mocks/browser')
    await startMockApi()
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

main().catch((e: unknown) => {
  console.error(e)
  document.getElementById('root')!.textContent = `起動に失敗しました: ${String(e)}`
})
