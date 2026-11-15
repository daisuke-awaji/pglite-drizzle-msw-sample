import { setupWorker } from 'msw/browser'
import { getDb } from '../db/client.browser'
import { createHandlers } from './handlers'

export async function startMockApi(): Promise<void> {
  const worker = setupWorker(...createHandlers({ getDb }))
  await worker.start({
    // サブパス（/<リポジトリ名>/）で配信しても動くよう、BASE_URL を基準に Service Worker を登録する
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    onUnhandledFrame: 'bypass',
    quiet: true,
  })
  // DB の準備（WASM の読み込み・マイグレーション）を先に済ませ、失敗したら起動の失敗として扱う
  await getDb()
}
