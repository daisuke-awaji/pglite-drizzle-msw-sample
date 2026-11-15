import { expect, expectNoA11yViolations, expectNoHorizontalOverflow, open, test } from './fixtures'

// すべての画面を開き、見出し・タブのタイトル・はみ出し・アクセシビリティ（axe）を確かめる。
// desktop と mobile の両方で走る（playwright.config.ts の projects）
const PAGES = [
  { path: '/', heading: 'ダッシュボード', title: 'ダッシュボード' },
  { path: '/projects', heading: 'プロジェクト', title: 'プロジェクト' },
  { path: '/projects/1/tasks', heading: 'Web サイト刷新', title: 'タスク' },
  { path: '/projects/1/members', heading: 'Web サイト刷新', title: 'メンバー' },
  { path: '/projects/1/settings', heading: 'Web サイト刷新', title: '設定' },
  { path: '/tasks/1', heading: /.+/, title: /.+/ },
  { path: '/members', heading: 'メンバー', title: 'メンバー' },
  { path: '/settings', heading: '設定', title: '設定' },
]

for (const { path, heading, title } of PAGES) {
  test(`${path} を表示できる`, async ({ page }) => {
    await open(page, path, heading)
    await expect(page).toHaveTitle(typeof title === 'string' ? `${title} | Starter Kit` : / \| Starter Kit$/)
    await expectNoHorizontalOverflow(page)
    await expectNoA11yViolations(page)
  })
}

test('ダークテーマでもコントラストが足りている', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  for (const path of ['/', '/projects/1/tasks', '/settings']) {
    await open(page, path)
    await expectNoA11yViolations(page)
  }
})

test('存在しない URL は 404 の画面になり、ダッシュボードへ戻れる', async ({ page }) => {
  await open(page, '/no-such-page', 'ページが見つかりません')
  await expect(page).toHaveTitle('ページが見つかりません | Starter Kit')
  await expectNoA11yViolations(page)
  await page.getByRole('link', { name: 'ダッシュボードへ戻る' }).click()
  await expect(page.locator('main h1')).toHaveText('ダッシュボード')
})

test('存在しないプロジェクト・タスクも 404 になる', async ({ page, allowConsoleErrors }) => {
  // API の 404 はブラウザが「Failed to load resource」としてコンソールに出す（アプリの不具合ではない）
  allowConsoleErrors(/status of 404/)
  await open(page, '/projects/9999/tasks', 'ページが見つかりません')
  await expect(page.getByText('プロジェクト 9999 が見つかりません')).toBeVisible()
  await open(page, '/tasks/abc', 'ページが見つかりません')
})
