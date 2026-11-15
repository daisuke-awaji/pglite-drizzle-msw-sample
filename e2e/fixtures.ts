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

/**
 * 文字が箱からはみ出していない・ほかの文字と重なっていない・省略記号なしで切れていない。
 * 見えている文字（テキストノード）ごとに、祖先の箱に収まっているかを見る。横スクロールする箱の中は対象外
 */
export async function expectNoTextOverflow(page: Page) {
  const problems = await page.evaluate(() => {
    const out: string[] = []
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate の中はブラウザで動くので、外の関数を使えない
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.classList.length ? '.' + [...el.classList].join('.') : ''}`
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate の中はブラウザで動くので、外の関数を使えない
    const hidden = (el: Element) => {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e)
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0' || cs.clipPath === 'inset(50%)') return true
      }
      return false
    }
    const texts: { el: Element; text: string; rects: DOMRect[] }[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      const text = n.textContent?.trim() ?? ''
      if (!el || !text || el.closest('script, style, svg') || hidden(el)) continue
      const range = document.createRange()
      range.selectNodeContents(n)
      const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1)
      if (rects.length === 0) continue
      const left = Math.min(...rects.map((r) => r.left))
      const right = Math.max(...rects.map((r) => r.right))
      let scrolls = false
      for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a)
        if (cs.display === 'inline' || cs.display === 'contents') continue
        const box = a.getBoundingClientRect()
        if (right - box.right > 1.5 || box.left - left > 1.5) {
          if (cs.overflowX === 'visible') out.push(`はみ出し: ${name(el)} が ${name(a)} から ${Math.round(Math.max(right - box.right, box.left - left))}px「${text.slice(0, 20)}」`)
          else if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') scrolls = true
          else if (getComputedStyle(el).textOverflow !== 'ellipsis' && cs.textOverflow !== 'ellipsis' && cs.webkitLineClamp === 'none')
            out.push(`省略記号なしで切れている: ${name(el)}「${text.slice(0, 20)}」`)
          break
        }
        if (cs.overflowX !== 'visible') break
      }
      if (scrolls) continue
      // 省略記号で隠れた部分は見えないので、切り取る祖先の箱で切ってから重なりを見る
      let visible = rects.map((r) => new DOMRect(r.x, r.y, r.width, r.height))
      for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
        const cs = getComputedStyle(a)
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
        const box = a.getBoundingClientRect()
        visible = visible
          .map((r) => {
            const x = Math.max(r.left, box.left)
            const y = Math.max(r.top, box.top)
            return new DOMRect(x, y, Math.min(r.right, box.right) - x, Math.min(r.bottom, box.bottom) - y)
          })
          .filter((r) => r.width > 1 && r.height > 1)
      }
      if (visible.length) texts.push({ el, text, rects: visible })
    }
    // 文字どうしの重なり（前面のポップアップと後ろの画面、わざと重ねるアバターは比べない）
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate の中はブラウザで動くので、外の関数を使えない
    const layer = (e: Element) => e.closest('[role=dialog], [role=menu], [role=listbox], [data-slot=toast]')
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const A = texts[i]!
        const B = texts[j]!
        if (A.el === B.el || layer(A.el) !== layer(B.el) || (A.el.closest('.avatar-stack') && B.el.closest('.avatar-stack'))) continue
        const hit = A.rects.some((a) =>
          B.rects.some((b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 3),
        )
        if (hit) out.push(`重なり: ${name(A.el)}「${A.text.slice(0, 12)}」と ${name(B.el)}「${B.text.slice(0, 12)}」`)
      }
    }
    return [...new Set(out)]
  })
  expect(problems).toEqual([])
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
