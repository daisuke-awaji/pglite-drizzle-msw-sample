import { AxeBuilder } from '@axe-core/playwright'
import { test as base, expect, type Locator, type Page } from '@playwright/test'

// すべての e2e で共通に確かめること:
// - コンソールのエラーと、捕まえられなかった例外が 1 件もない（わざと起こすテストは allowConsoleErrors で許す）
type Fixtures = {
  allowConsoleErrors: (pattern: RegExp) => void
}

export const test = base.extend<Fixtures>({
  allowConsoleErrors: [
    async ({ page }, use, testInfo) => {
      const allowed: RegExp[] = []
      const problems: string[] = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`)
      })
      page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
      await use((pattern) => allowed.push(pattern))
      const unexpected = problems.filter((p) => !allowed.some((a) => a.test(p)))
      if (testInfo.status === 'passed') expect(unexpected, 'ブラウザのコンソールにエラーが出ました').toEqual([])
    },
    { auto: true },
  ],
})

export { expect, type Page }

export const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 720

/** アプリの起動（Service Worker・PGlite の準備）を待ってから、その画面の見出しが出るまで待つ */
export async function open(page: Page, path: string, heading?: string | RegExp) {
  await page.goto(path)
  const h1 = page.locator('main h1').first()
  await expect(h1).toBeVisible({ timeout: 30_000 })
  if (heading) await expect(h1).toHaveText(heading)
}

/** WCAG 2.2 AA の自動チェック（axe-core）。重大・深刻な違反が 0 件であること */
export async function expectNoA11yViolations(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  const serious = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(
    serious.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')})`),
  ).toEqual([])
}

/** 横スクロールが出ていない（狭い画面で表やツールバーがはみ出していない） */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

/** 端末の設定（Zustand の persist）を、起動前に localStorage へ入れておく */
export async function setPreferences(page: Page, prefs: Record<string, unknown>) {
  await page.addInitScript((value) => {
    localStorage.setItem('starter-kit:preferences', JSON.stringify({ state: value, version: 1 }))
  }, prefs)
}

/**
 * ポップアップの中の項目を押す。スマートフォンでは Select や Menu が画面下からのシートになり、
 * 開くときに下からせり上がるので、画面内に収まるのを待ってから押す
 */
export async function pick(item: Locator) {
  await expect(item).toBeInViewport({ ratio: 1 })
  await item.click()
}

/** 名前で Select を開き、項目を選ぶ */
export async function choose(page: Page, combobox: string, option: string) {
  await page.getByRole('combobox', { name: combobox }).click()
  await pick(page.getByRole('option', { name: option, exact: true }))
}

/** API の書き込みが終わるまで待つ（楽観的更新で画面は先に変わるので、リロードの前などに使う） */
export function waitForWrite(page: Page, path: RegExp) {
  return page.waitForResponse((r) => path.test(new URL(r.url()).pathname) && r.request().method() !== 'GET')
}

/** トーストが出たこと（読み上げ用の複製ではなく、画面の通知の領域を見る） */
export async function expectToast(page: Page, text: string) {
  await expect(page.getByRole('region', { name: '通知' }).getByText(text)).toBeVisible()
}
