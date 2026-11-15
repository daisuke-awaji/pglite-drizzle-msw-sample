import react from '@vitejs/plugin-react'
import { msw } from 'msw/vite'
import { defineConfig } from 'vite'

// GitHub Pages（プロジェクトサイト）は https://<user>.github.io/<repo>/ で配信されるので、
// ビルド時に BASE_PATH=/<repo>/ を渡す（.github/workflows/deploy.yml で自動設定）。
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [
    react(),
    // mockServiceWorker.js を dev サーバーで配信し、ビルド成果物にも出力する
    msw({ mode: 'worker-only' }),
  ],
  // PGlite は WASM とデータファイルを自前で読み込むため、依存の事前バンドルから外す
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
})
