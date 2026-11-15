import { setupWorker } from 'msw/browser'
import { getDb } from '../db/client.browser'
import { createHandlers } from './handlers'
import { seedIfEmpty } from './seed'

let seeded: Promise<void> | undefined

// 初めて開いたときだけサンプルデータを入れる。失敗したら次の呼び出しでやり直す
async function getSeededDb() {
  const db = await getDb()
  seeded ??= seedIfEmpty(db).then(
    () => undefined,
    (e: unknown) => {
      seeded = undefined
      throw e
    },
  )
  await seeded
  return db
}

export async function startMockApi(): Promise<void> {
  const worker = setupWorker(...createHandlers({ getDb: getSeededDb }))
  await worker.start({
    // サブパス（/<リポジトリ名>/）で配信しても動くよう、BASE_URL を基準に Service Worker を登録する
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    onUnhandledFrame: 'bypass',
    quiet: true,
  })
  // DB の準備（WASM の読み込み・マイグレーション・サンプルデータ）を先に済ませ、失敗したら起動の失敗として扱う
  await getSeededDb()
}
