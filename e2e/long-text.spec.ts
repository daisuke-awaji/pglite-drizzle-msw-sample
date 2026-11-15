import { expect, expectNoHorizontalOverflow, expectNoTextOverflow, isMobile, open, setPreferences, test, type Page } from './fixtures'

// 入力できる最大の長さの名前・タイトル・説明・コメントを入れても、どの画面も崩れない。
// 日本語（どこでも折り返せる）と、空白のない英数字・URL（折り返せる場所がない）の両方で確かめる
const repeat = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n)
const ja = (n: number) => repeat('とても長い名前が入ったときの表示確認用テキスト', n)
const en = (n: number) => repeat('Supercalifragilisticexpialidocious', n)
// メールアドレスは 254 文字まで（ローカル部 64 文字・ラベル 63 文字まで）
const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`

async function fillWithLongText(page: Page) {
  await open(page, '/')
  const failed = await page.evaluate(
    async (v) => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate の中はブラウザで動くので、外の関数を使えない
      const call = async (method: string, path: string, body: unknown) => {
        const res = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        return { path, status: res.status, json: res.ok ? await res.json() : await res.text() }
      }
      const results = [
        await call('PATCH', '/projects/1', { name: v.ja80, description: v.ja500 }),
        await call('PATCH', '/projects/2', { name: v.en80, description: v.en500 }),
        await call('PATCH', '/members/1', { name: v.ja60, title: v.ja60 }),
        await call('PATCH', '/members/2', { name: v.en60, title: v.en60, email: v.email }),
      ]
      const tagEn = await call('POST', '/tags', { name: v.en30 })
      const tagJa = await call('POST', '/tags', { name: v.ja30 })
      const tagIds = [tagEn.json.id, tagJa.json.id, 1, 2, 3, 4, 5, 6]
      results.push(
        tagEn,
        tagJa,
        await call('PATCH', '/tasks/1', { title: v.ja200, description: v.description, tagIds, assigneeId: 2 }),
        await call('PATCH', '/tasks/2', { title: v.en200, tagIds, assigneeId: 1 }),
        await call('POST', '/tasks/1/comments', { body: v.en1000, authorId: 2 }),
        await call('POST', '/tasks/1/comments', { body: v.description.slice(0, 1000), authorId: 1 }),
      )
      return results.filter((r) => r.status >= 400).map((r) => `${r.path} ${r.status} ${r.json}`)
    },
    {
      ja30: ja(30), en30: en(30), ja60: ja(60), en60: en(60), ja80: ja(80), en80: en(80), ja200: ja(200), en200: en(200),
      ja500: ja(500), en500: en(500), en1000: en(1000), email,
      description: `${ja(300)}\nhttps://example.com/${en(400)}\n${en(1200)}`.slice(0, 2000),
    },
  )
  expect(failed).toEqual([])
}

const PAGES = [
  { path: '/', heading: 'ダッシュボード' },
  { path: '/projects', heading: 'プロジェクト' },
  { path: '/projects/1/tasks', heading: ja(80) },
  { path: '/projects/2/tasks', heading: en(80) },
  { path: '/projects/2/tasks', heading: en(80), board: true },
  { path: '/projects/1/members', heading: ja(80) },
  { path: '/projects/2/settings', heading: en(80) },
  { path: '/tasks/1', heading: ja(200) },
  { path: '/tasks/2', heading: en(200) },
  { path: '/members', heading: 'メンバー' },
  { path: '/settings', heading: '設定' },
]

for (const { path, heading, board } of PAGES) {
  test(`長い文字列でも ${path}${board ? '（ボード）' : ''} が崩れない`, async ({ page }) => {
    if (board) await setPreferences(page, { taskView: 'board' })
    await fillWithLongText(page)
    await open(page, path, heading)
    await expectNoHorizontalOverflow(page)
    await expectNoTextOverflow(page)
    // 表が横にスクロールし始めるタブレットの幅でも
    if (!isMobile(page)) {
      await page.setViewportSize({ width: 820, height: 1180 })
      await expectNoHorizontalOverflow(page)
      await expectNoTextOverflow(page)
    }
  })
}
