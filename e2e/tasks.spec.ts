import { choose, expect, expectToast, isMobile, open, pick, test, waitForWrite } from './fixtures'

test('タスクを作る: 入力の誤りは項目の下に出し、直せば作成でき、リロードしても残る', async ({ page }) => {
  await open(page, '/projects/1/tasks')
  await page.getByRole('button', { name: '新しいタスク' }).click()
  const dialog = page.getByRole('dialog', { name: '新しいタスク' })
  await dialog.getByRole('button', { name: '作成' }).click()
  const title = dialog.getByRole('textbox', { name: 'タイトル' })
  await expect(title).toHaveAttribute('aria-invalid', 'true')
  await expect(dialog.getByText('タイトルを入力してください')).toBeVisible()

  await title.fill('e2e で作ったタスク')
  await dialog.getByRole('button', { name: '作成' }).click()
  await expect(dialog).toBeHidden()
  await expectToast(page, 'タスクを作成しました')
  await page.getByRole('searchbox', { name: 'タスクを検索' }).fill('e2e で作った')
  await expect(page.getByRole('link', { name: 'e2e で作ったタスク' })).toBeVisible()

  // ブラウザ内の PostgreSQL（IndexedDB）に保存されているので、読み込み直しても残る
  await page.reload()
  await expect(page.getByRole('link', { name: 'e2e で作ったタスク' })).toBeVisible({ timeout: 30_000 })
})

test('書きかけのタスクは、ダイアログを閉じても下書きとして残る', async ({ page }) => {
  await open(page, '/projects/1/tasks')
  await page.getByRole('button', { name: '新しいタスク' }).click()
  const dialog = page.getByRole('dialog', { name: '新しいタスク' })
  await dialog.getByRole('textbox', { name: 'タイトル' }).fill('あとで続きを書く')
  await dialog.getByRole('button', { name: '閉じる' }).click()
  await expect(page.getByRole('button', { name: /新しいタスク.*下書きあり/ })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: /新しいタスク/ }).click({ timeout: 30_000 })
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'タイトル' })).toHaveValue('あとで続きを書く')
})

test('完了のチェックはすぐ画面に反映され、保存される', async ({ page }) => {
  await open(page, '/projects/1/tasks')
  const checkbox = page.getByRole('checkbox', { name: '「ヘッダーとフッターの実装」を完了にする' })
  await expect(checkbox).not.toBeChecked()
  const saved = waitForWrite(page, /\/api\/tasks\/\d+$/)
  await checkbox.click()
  await expect(checkbox).toBeChecked()
  await saved
  await page.reload()
  await expect(page.getByRole('checkbox', { name: '「ヘッダーとフッターの実装」を完了にする' })).toBeChecked({ timeout: 30_000 })
})

test('絞り込みは URL に入るので、リロードや共有で同じ一覧になる', async ({ page }) => {
  await open(page, '/projects/1/tasks')
  if (isMobile(page)) await page.getByRole('button', { name: '絞り込み' }).click()
  await choose(page, '状態で絞り込む', '完了')
  await expect(page).toHaveURL(/status=done/)
  const rows = page.getByRole('checkbox', { name: /を完了にする/ })
  await expect(rows.first()).toBeChecked()
  for (const box of await rows.all()) await expect(box).toBeChecked()
  if (isMobile(page)) await expect(page.getByRole('button', { name: /絞り込み.*1.*件の条件/ })).toBeVisible()

  await page.reload()
  await expect(page.locator('main h1')).toBeVisible({ timeout: 30_000 })
  if (isMobile(page)) await page.getByRole('button', { name: /絞り込み/ }).click()
  await expect(page.getByRole('combobox', { name: '状態で絞り込む' })).toHaveText(/完了/)
})

test('タスクを削除する前に確認し、キャンセルすれば残る', async ({ page }) => {
  await open(page, '/projects/1/tasks')
  const menu = page.getByRole('button', { name: '「ヘッダーとフッターの実装」の操作' })
  await menu.click()
  await pick(page.getByRole('menuitem', { name: '削除' }))
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('「ヘッダーとフッターの実装」を削除しますか？')
  await confirm.getByRole('button', { name: 'キャンセル' }).click()
  await expect(page.getByRole('link', { name: 'ヘッダーとフッターの実装' })).toBeVisible()

  await menu.click()
  await pick(page.getByRole('menuitem', { name: '削除' }))
  await page.getByRole('alertdialog').getByRole('button', { name: 'タスクを削除' }).click()
  await expect(page.getByRole('link', { name: 'ヘッダーとフッターの実装' })).toBeHidden()
  await expectToast(page, 'タスクを削除しました')
})

test('タスク詳細: 保存していない変更があると、移動の前に確認する', async ({ page }) => {
  await open(page, '/tasks/1')
  const title = page.getByRole('textbox', { name: 'タイトル' })
  await title.fill('書き換え中のタイトル')
  const projectLink = page.locator('.side-project a')
  await projectLink.click()
  const confirm = page.getByRole('alertdialog', { name: '保存していない変更があります' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'キャンセル' }).click()
  await expect(title).toHaveValue('書き換え中のタイトル')

  // 保存すれば確認なしで移れる
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expectToast(page, '保存しました')
  await projectLink.click()
  await expect(page).toHaveURL(/\/projects\/\d+\/tasks$/)
})
