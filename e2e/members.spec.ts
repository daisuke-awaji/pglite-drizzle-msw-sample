import { expect, open, test } from './fixtures'

test('メンバーを追加する: メールアドレスの重複は項目の下に出す', async ({ page, allowConsoleErrors }) => {
  allowConsoleErrors(/status of 409/)
  await open(page, '/members', 'メンバー')
  const existing = (await page.locator('td[data-label="メール"]').first().textContent())!.trim()

  await page.getByRole('button', { name: 'メンバーを追加' }).click()
  const dialog = page.getByRole('dialog', { name: 'メンバーを追加' })
  await dialog.getByRole('textbox', { name: '名前' }).fill('重複する人')
  // 大文字と前後の空白は整えてから比べるので、同じアドレスとして扱う
  await dialog.getByRole('textbox', { name: 'メールアドレス' }).fill(`  ${existing.toUpperCase()} `)
  await dialog.getByRole('button', { name: '追加' }).click()
  await expect(dialog.getByText('このメールアドレスは既に使われています')).toBeVisible()

  await dialog.getByRole('textbox', { name: 'メールアドレス' }).fill('someone-new@example.com')
  await dialog.getByRole('button', { name: '追加' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('cell', { name: '重複する人', exact: true })).toBeVisible()
})
