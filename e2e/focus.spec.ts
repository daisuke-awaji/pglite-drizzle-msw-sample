import { expect, expectToast, open, pick, test, type Page } from './fixtures'

// 行を消したあとのフォーカスの戻り先（WCAG 2.4.3）。
// 行の中にあったフォーカスが body に落ちると、キーボードの利用者は先頭からやり直しになる。
// 次の行 → 前の行 → ページの見出し、の順に移ることを確かめる

/** 一覧の i 番目の行の「戻り先になる要素」（data-row-focus） */
const rowFocus = (page: Page, rows: string, i: number) => page.locator(rows).nth(i).locator('[data-row-focus]')

test('タスクの行を消すと、次の行の操作ボタンへ移る', async ({ page }) => {
  await open(page, '/projects/1/tasks')
  const rows = 'tbody tr'
  const nextName = await rowFocus(page, rows, 1).getAttribute('aria-label')
  await rowFocus(page, rows, 0).click()
  await pick(page.getByRole('menuitem', { name: '削除' }))
  await page.getByRole('alertdialog').getByRole('button', { name: 'タスクを削除' }).click()
  await expectToast(page, 'タスクを削除しました')
  await expect(page.getByRole('button', { name: nextName! })).toBeFocused()
})

test('最後の行を消すと、前の行の操作ボタンへ移る', async ({ page }) => {
  await open(page, '/projects/1/tasks')
  const rows = 'tbody tr'
  const count = await page.locator(rows).count()
  const previousName = await rowFocus(page, rows, count - 2).getAttribute('aria-label')
  await rowFocus(page, rows, count - 1).click()
  await pick(page.getByRole('menuitem', { name: '削除' }))
  await page.getByRole('alertdialog').getByRole('button', { name: 'タスクを削除' }).click()
  await expectToast(page, 'タスクを削除しました')
  await expect(page.getByRole('button', { name: previousName! })).toBeFocused()
})

test('一覧の 1 行だけを消すと、ページの見出しへ移る', async ({ page }) => {
  await open(page, `/projects/1/tasks?q=${encodeURIComponent('ヘッダーとフッターの実装')}`)
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await page.getByRole('button', { name: '「ヘッダーとフッターの実装」の操作' }).click()
  await pick(page.getByRole('menuitem', { name: '削除' }))
  await page.getByRole('alertdialog').getByRole('button', { name: 'タスクを削除' }).click()
  await expectToast(page, 'タスクを削除しました')
  await expect(page.locator('main h1').first()).toBeFocused()
})

test('削除をキャンセルすると、フォーカスは操作ボタンに戻る（勝手に動かさない）', async ({ page }) => {
  await open(page, '/projects/1/tasks')
  const trigger = rowFocus(page, 'tbody tr', 0)
  await trigger.click()
  await pick(page.getByRole('menuitem', { name: '削除' }))
  await page.getByRole('alertdialog').getByRole('button', { name: 'キャンセル' }).click()
  await expect(trigger).toBeFocused()
})

test('メンバーを消すと、次の行の操作ボタンへ移る', async ({ page }) => {
  await open(page, '/members', 'メンバー')
  const rows = 'tbody tr'
  const nextName = await rowFocus(page, rows, 1).getAttribute('aria-label')
  await rowFocus(page, rows, 0).click()
  await pick(page.getByRole('menuitem', { name: '削除' }))
  await page.getByRole('alertdialog').getByRole('button', { name: 'メンバーを削除' }).click()
  await expectToast(page, 'メンバーを削除しました')
  await expect(page.getByRole('button', { name: nextName! })).toBeFocused()
})

test('タグを消すと、次のタグの削除ボタンへ移る', async ({ page }) => {
  await open(page, '/settings', '設定')
  const rows = '.tag-admin li'
  const nextName = await rowFocus(page, rows, 1).getAttribute('aria-label')
  await rowFocus(page, rows, 0).click()
  await expectToast(page, 'タグを削除しました')
  await expect(page.getByRole('button', { name: nextName! })).toBeFocused()
})

test('コメントを消すと、次のコメントの削除ボタンへ移る', async ({ page }) => {
  await open(page, '/tasks/1')
  const rows = 'li.comment'
  const before = await page.locator(rows).count()
  for (const [i, body] of ['1 件目', '2 件目'].entries()) {
    await page.getByRole('textbox', { name: 'コメント' }).fill(body)
    await page.getByRole('button', { name: 'コメントする' }).click()
    // 投稿が終わるとフォームが空に作り直されるので、それを待ってから次を書く
    await expect(page.locator(rows)).toHaveCount(before + i + 1)
  }
  const nextName = await rowFocus(page, rows, 1).getAttribute('aria-label')
  await rowFocus(page, rows, 0).click()
  await expectToast(page, 'コメントを削除しました')
  await expect(page.getByRole('button', { name: nextName! })).toBeFocused()
})
