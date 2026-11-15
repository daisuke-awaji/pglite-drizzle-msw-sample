import { choose, expect, expectToast, isMobile, open, test, type Page } from './fixtures'

// 設定画面の「障害シミュレーション」で、モック API をわざと失敗させて確かめる
async function setFault(page: Page, label: string) {
  if (!page.url().endsWith('/settings')) await open(page, '/settings', '設定')
  await choose(page, '障害シミュレーション', label)
  await expect(page.getByRole('combobox', { name: '障害シミュレーション' })).toHaveText(new RegExp(label.slice(0, 4)))
}

async function goTo(page: Page, name: string) {
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'メニューを開く' }).click()
    await page.getByRole('dialog').getByRole('link', { name, exact: true }).click()
    // ドロワーが閉じきるまで待つ（閉じる途中の背景が次の操作を受け止めてしまわないように）
    await expect(page.getByRole('dialog')).toBeHidden()
  } else {
    await page.getByRole('navigation', { name: 'メイン' }).getByRole('link', { name, exact: true }).click()
  }
}

test('読み込みに失敗したら「再試行」を出し、直れば同じ画面に戻れる', async ({ page, allowConsoleErrors }) => {
  allowConsoleErrors(/status of 503/)
  await setFault(page, 'すべて失敗させる（503）')
  await goTo(page, 'メンバー')
  const heading = page.getByRole('heading', { level: 1, name: 'データを読み込めませんでした' })
  await expect(heading).toBeVisible()
  await expect(heading).toBeFocused()
  await expect(page).toHaveTitle('データを読み込めませんでした | Starter Kit')
  await expect(page.getByText('障害シミュレーション中です')).toBeVisible()

  // サイドバーは残るので、設定へ行って障害を止められる（行き止まりにならない）
  await setFault(page, 'なし（正常）')
  await goTo(page, 'メンバー')
  await expect(page.getByRole('heading', { level: 1, name: 'メンバー' })).toBeVisible()
})

test('「再試行」は読み直している間は押せず、失敗が続けばエラーのまま表示する', async ({ page, allowConsoleErrors }) => {
  allowConsoleErrors(/status of 503/)
  await open(page, '/settings', '設定')
  await choose(page, 'API の遅延', '1 秒')
  await setFault(page, 'すべて失敗させる（503）')
  await goTo(page, 'プロジェクト')
  const heading = page.getByRole('heading', { level: 1, name: 'データを読み込めませんでした' })
  await expect(heading).toBeVisible()
  const retry = page.getByRole('button', { name: '再試行' })
  await retry.click()
  await expect(retry).toBeDisabled()
  await expect(retry).toBeEnabled()
  await expect(heading).toBeVisible()
})

test('オフラインでは「接続できません」と出す', async ({ page, allowConsoleErrors }) => {
  // 通信できないリクエストは、ブラウザが net::ERR_FAILED としてコンソールに出す
  allowConsoleErrors(/net::ERR_FAILED/)
  await open(page, '/')
  await setFault(page, 'サーバーにつながらない')
  await goTo(page, 'プロジェクト')
  await expect(page.getByRole('heading', { level: 1, name: 'データを読み込めませんでした' })).toBeVisible()
  await expect(page.getByText('サーバーに接続できません')).toBeVisible()
  await expect(page.getByRole('button', { name: '再試行' })).toBeVisible()
})

test('保存に失敗したら、トーストで知らせ、入力は消さない', async ({ page, allowConsoleErrors }) => {
  allowConsoleErrors(/status of 503/)
  await setFault(page, '保存だけ失敗させる（503）')
  await goTo(page, 'メンバー')
  await page.getByRole('button', { name: 'メンバーを追加' }).click()
  const dialog = page.getByRole('dialog', { name: 'メンバーを追加' })
  await dialog.getByRole('textbox', { name: '名前' }).fill('新しい人')
  await dialog.getByRole('textbox', { name: 'メールアドレス' }).fill('new@example.com')
  await dialog.getByRole('button', { name: '追加' }).click()
  await expectToast(page, '障害シミュレーション中です')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: '名前' })).toHaveValue('新しい人')
})

test('ブラウザ内の DB を使えないときは、理由と対処を出す', async ({ page, allowConsoleErrors }) => {
  allowConsoleErrors(/\[boot\]/)
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: undefined })
  })
  await page.goto('/')
  const heading = page.getByRole('heading', { level: 1, name: 'アプリを起動できませんでした' })
  await expect(heading).toBeVisible({ timeout: 30_000 })
  await expect(heading).toBeFocused()
  await expect(page.getByText('IndexedDB を使えない')).toBeVisible()
  await expect(page.getByRole('button', { name: '読み込み直す', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'このアプリのデータを消して読み込み直す' })).toBeVisible()
})
