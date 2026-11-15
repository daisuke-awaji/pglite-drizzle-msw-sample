import { expect, isMobile, open, test, type Page } from './fixtures'

// axe が見ない「文字以外のコントラスト」（WCAG 1.4.11）と、強制カラー（Windows のハイコントラスト）での見え方。
// 色はブラウザが実際に塗った値（canvas に描いて読み戻した sRGB）で比べる

type Rgb = [number, number, number]

/** 要素（または擬似要素）の色を、ブラウザが解決した sRGB で返す。透明なら祖先の背景をたどる */
function readColors(page: Page, selector: string, pseudo?: '::before' | '::after') {
  return page.locator(selector).first().evaluate(
    (el, pseudoElement) => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
      const toRgb = (color: string): [number, number, number, number] => {
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = color
        ctx.fillRect(0, 0, 1, 1)
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
        return [r!, g!, b!, a!]
      }
      const backgroundOf = (start: Element | null): [number, number, number] => {
        for (let node = start; node; node = node.parentElement) {
          const c = toRgb(getComputedStyle(node).backgroundColor)
          if (c[3] > 0) return [c[0], c[1], c[2]]
        }
        return [255, 255, 255]
      }
      const style = getComputedStyle(el, pseudoElement ?? null)
      const own = toRgb(style.backgroundColor)
      return {
        border: toRgb(style.borderTopColor).slice(0, 3) as [number, number, number],
        background: own[3] > 0 ? (own.slice(0, 3) as [number, number, number]) : backgroundOf(el.parentElement),
        surroundings: backgroundOf(el.parentElement),
      }
    },
    pseudo,
  )
}

const channel = (v: number) => {
  const s = v / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)

/** WCAG のコントラスト比 */
function contrast(x: Rgb, y: Rgb): number {
  const [hi, lo] = [luminance(x), luminance(y)].toSorted((p, q) => q - p) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** 入力欄などの枠が、中の背景と外の背景の両方に対して 3:1 以上あること */
async function expectBoundary(page: Page, name: string, selector: string) {
  const c = await readColors(page, selector)
  const worst = Math.min(contrast(c.border, c.background), contrast(c.border, c.surroundings))
  expect(worst, `${name} の枠のコントラスト`).toBeGreaterThanOrEqual(3)
}

for (const scheme of ['light', 'dark'] as const) {
  test(`入力欄・チェックボックス・スイッチの枠は 3:1 以上（${scheme}）`, async ({ page }) => {
    // 絞り込みはスマートフォンでは開閉式で、色の決まりは同じなのでデスクトップだけで確かめる
    test.skip(isMobile(page), 'デスクトップで確かめる')
    await page.emulateMedia({ colorScheme: scheme })
    await open(page, '/projects/1/tasks')
    await expectBoundary(page, '検索欄', '.search-input input')
    await expectBoundary(page, '絞り込みの Select', '[data-slot="select-trigger"]')
    await expectBoundary(page, '未完了のチェックボックス', '[data-slot="checkbox"]:not([data-checked])')
    await open(page, '/projects/1/settings')
    await expectBoundary(page, 'オフのスイッチ', '[data-slot="switch"]:not([data-checked])')
  })
}

test('強制カラーでも、チェックボックス・スイッチ・割り当ての選択が見分けられる', async ({ page }) => {
  test.skip(isMobile(page), '強制カラーはデスクトップ（Windows）の機能')
  await page.emulateMedia({ forcedColors: 'active' })

  await open(page, '/projects/1/tasks')
  const checked = await readColors(page, '[data-slot="checkbox"][data-checked]')
  const unchecked = await readColors(page, '[data-slot="checkbox"]:not([data-checked])')
  const mark = await readColors(page, '[data-slot="checkbox"][data-checked] [data-slot="checkbox-indicator"]', '::before')
  expect(checked.background, 'オンとオフのチェックボックスの塗り').not.toEqual(unchecked.background)
  expect(contrast(mark.background, checked.background), 'チェック印と箱').toBeGreaterThanOrEqual(3)

  await open(page, '/projects/1/settings')
  const track = await readColors(page, '[data-slot="switch"]')
  const thumb = await readColors(page, '[data-slot="switch-thumb"]')
  expect(contrast(thumb.background, track.background), 'スイッチのつまみと土台').toBeGreaterThanOrEqual(3)
  await page.getByRole('switch', { name: 'アーカイブする' }).click()
  const trackOn = await readColors(page, '[data-slot="switch"][data-checked]')
  const thumbOn = await readColors(page, '[data-slot="switch-thumb"][data-checked]')
  expect(trackOn.background, 'オンとオフのスイッチの塗り').not.toEqual(track.background)
  expect(contrast(thumbOn.background, trackOn.background), 'オンのつまみと土台').toBeGreaterThanOrEqual(3)

  await open(page, '/projects/1/members')
  const option = page.locator('.transfer-list [role="option"]').first()
  await option.click()
  await expect(option).toHaveAttribute('data-selected', /.*/)
  const selected = await readColors(page, '.transfer-list [role="option"][data-selected]')
  const others = await readColors(page, '.transfer-list [role="option"]:not([data-selected])')
  expect(contrast(selected.background, others.background), '選んだ項目と選んでいない項目').toBeGreaterThanOrEqual(3)
})
