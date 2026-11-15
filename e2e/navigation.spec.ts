import { expect, isMobile, open, test } from './fixtures'

test('画面を移ると、見出しにフォーカスが移り、移動したことが読み上げられる', async ({ page }) => {
  await open(page, '/')
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'メニューを開く' }).click()
    await page.getByRole('dialog').getByRole('link', { name: 'メンバー' }).click()
    // ドロワーは移動すると閉じる
    await expect(page.getByRole('dialog')).toBeHidden()
  } else {
    await page.getByRole('navigation', { name: 'メイン' }).getByRole('link', { name: 'メンバー' }).click()
  }
  const h1 = page.locator('main h1')
  await expect(h1).toHaveText('メンバー')
  await expect(h1).toBeFocused()
  await expect(page.getByRole('status').filter({ hasText: 'メンバーを表示しました' })).toBeAttached()
  await expect(page).toHaveTitle('メンバー | Starter Kit')
})

test('検索条件を変えても、入力中の欄からフォーカスを奪わない', async ({ page }) => {
  await open(page, '/projects/1/tasks')
  const search = page.getByRole('searchbox', { name: 'タスクを検索' })
  await search.fill('ヘッダー')
  await expect(page).toHaveURL(/q=%E3%83%98/)
  await expect(search).toBeFocused()
})

test('最初の Tab で「メインコンテンツへ移動」が出て、本文へ飛べる', async ({ page }) => {
  test.skip(isMobile(page), 'キーボード操作はデスクトップで確かめる')
  await open(page, '/')
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'メインコンテンツへ移動' })
  await expect(skip).toBeFocused()
  await expect(skip).toBeInViewport()
  await page.keyboard.press('Enter')
  await expect(page.locator('#main')).toBeFocused()
})

test('スマートフォンでは、メニューはドロワーで開き、Esc で閉じるとボタンにフォーカスが戻る', async ({ page }) => {
  test.skip(!isMobile(page), 'スマートフォンの表示だけ')
  await open(page, '/')
  await expect(page.getByRole('complementary', { name: 'サイドバー' })).toBeHidden()
  const trigger = page.getByRole('button', { name: 'メニューを開く' })
  await trigger.click()
  const drawer = page.getByRole('dialog')
  await expect(drawer.getByRole('link', { name: 'プロジェクト', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('スマートフォンでは、パンくずの代わりに 1 つ上へ戻るリンクを出す', async ({ page }) => {
  test.skip(!isMobile(page), 'スマートフォンの表示だけ')
  await open(page, '/projects/1/tasks')
  await expect(page.getByRole('navigation', { name: 'パンくずリスト' })).toBeHidden()
  await page.getByRole('link', { name: '戻る: プロジェクト' }).click()
  await expect(page).toHaveURL(/\/projects$/)
  await open(page, '/tasks/1')
  await page.getByRole('link', { name: /^戻る: / }).click()
  await expect(page).toHaveURL(/\/projects\/\d+\/tasks$/)
})

test('押せる部品は指で押しやすい大きさ（44px 以上）になっている', async ({ page }) => {
  test.skip(!isMobile(page), 'タッチ端末だけ')
  await open(page, '/projects/1/tasks')
  const small = await page.evaluate(() => {
    const selector = 'main button, main a[href], main [role="checkbox"], main input, header button'
    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((el) => el.checkVisibility())
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      // 見えない入力（チェックボックスの中の input など）は対象外
      .filter(({ rect }) => rect.width > 2 && rect.height > 2)
      .filter(({ el, rect }) => {
        // 文中のリンク（タスク名など）は WCAG 2.5.8 の例外なので、高さだけ見る
        if (el.tagName === 'A') return rect.height < 24
        // チェックボックスは見た目 24px + 周りの押せる範囲（::after）で 44px にしている
        if (el.matches('[data-slot="checkbox"]')) {
          const hit = getComputedStyle(el, '::after')
          return rect.height < 24 || rect.height - 2 * parseFloat(hit.top) < 44
        }
        return rect.height < 44 || rect.width < 44
      })
      .map(({ el, rect }) => `${el.tagName} ${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20)} ${Math.round(rect.width)}x${Math.round(rect.height)}`)
  })
  expect(small).toEqual([])
})
