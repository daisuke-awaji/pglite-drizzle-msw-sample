import react from '@vitejs/plugin-react'
import { msw } from 'msw/vite'
import { defineConfig, loadEnv } from 'vite'

// GitHub Pages（プロジェクトサイト）は https://<user>.github.io/<repo>/ で配信されるので、
// ビルド時に BASE_PATH=/<repo>/ を渡す（.github/workflows/ci.yml で自動設定）。
export default defineConfig(({ mode }) => {
  // src/lib/env.ts の USES_MOCK_API と同じ判定。.env ファイルの値も読む
  const usesMockApi = loadEnv(mode, process.cwd(), 'VITE_').VITE_USE_MOCK !== 'false'
  return {
    base: process.env.BASE_PATH ?? '/',
    plugins: [
      react(),
      // mockServiceWorker.js を dev サーバーで配信し、ビルド成果物にも出力する（モック API を使うときだけ）
      usesMockApi && msw({ mode: 'worker-only' }),
    ],
    // PGlite は WASM とデータファイルを自前で読み込むため、依存の事前バンドルから外す
    optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  }
})
