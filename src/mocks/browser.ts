import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'

export async function startMockApi(): Promise<void> {
  const worker = setupWorker(...handlers)
  await worker.start({
    // サブパス（/<リポジトリ名>/）で配信しても動くよう、BASE_URL を基準に Service Worker を登録する
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    onUnhandledFrame: 'bypass',
  })
}
