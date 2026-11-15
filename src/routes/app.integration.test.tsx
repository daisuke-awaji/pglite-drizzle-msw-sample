import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { createAgent } from '@ui-sdk/react/agent'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { API_BASE } from '../shared/api-path'
import { usePreferences } from '../stores/preferences'
import { setupTestApi } from '../test/api'
import { allowConsole } from '../test/console'
import { TEST_NOW } from '../test/db'
import { renderApp } from '../test/render-app'

// 画面の結合テスト。本物のルート定義を、本物の API・DB（PGlite）につないで描画し、エージェント API で操作する。
// e2e より速く、失敗したときに原因の場所が分かりやすい。ブラウザでしか分からないこと（見た目・フォーカス・
// Service Worker・IndexedDB）は e2e/ で確かめる
const ctx = setupTestApi()
const agent = createAgent()

beforeEach(() => {
  // 期限切れなどの表示がシードの日付とずれないよう、「今日」をシードと同じ日に固定する（タイマーは本物のまま）
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(TEST_NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

async function run(...steps: Parameters<typeof agent.act>[0]['steps']) {
  let result!: Awaited<ReturnType<typeof agent.act>>
  await act(async () => {
    result = await agent.act({ steps })
  })
  expect(result.ok, result.error?.message).toBe(true)
}

const heading = () => screen.getByRole('heading', { level: 1 })

describe('ダッシュボード', () => {
  test('シードの集計と期限が近いタスクを出す', async () => {
    await renderApp('/')
    expect(heading()).toHaveTextContent('ダッシュボード')
    const summary = screen.getByRole('region', { name: '概要' })
    expect(within(summary).getByText('未完了のタスク').closest('.metric')).toHaveTextContent('17')
    expect(within(summary).getByText('期限切れ').closest('.metric')).toHaveTextContent('1')
    expect(screen.getByRole('heading', { name: '期限が近いタスク' })).toBeTruthy()
  })
})

describe('プロジェクト', () => {
  test('作成すると、そのプロジェクトの画面へ移る。名前が空なら項目の下にエラーを出す', async () => {
    const { router } = await renderApp('/projects')
    await run({ ref: '新しいプロジェクト', action: 'press' }, { ref: '新しいプロジェクト', action: 'press', args: ['作成'] })
    expect(await screen.findByText('プロジェクト名を入力してください')).toBeTruthy()

    await run(
      { ref: 'プロジェクト名', action: 'setValue', args: ['結合テストのプロジェクト'] },
      { ref: '新しいプロジェクト', action: 'press', args: ['作成'] },
    )
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/projects\/\d+\/tasks$/))
    expect(await screen.findByRole('heading', { level: 1, name: /結合テストのプロジェクト/ })).toBeTruthy()
    expect(screen.getByText('タスクはまだありません')).toBeTruthy()
  })

  test('絞り込み（アーカイブ）は URL に入り、該当がなければ空の表示にする', async () => {
    const { router } = await renderApp('/projects?status=archived')
    expect(await screen.findAllByText('アーカイブ')).not.toHaveLength(0)
    await act(() => router.navigate('/projects?q=存在しない名前'))
    expect(await screen.findByText('プロジェクトがありません')).toBeTruthy()
  })
})

describe('タスク詳細', () => {
  test('タイトルを保存し、コメントを投稿して消せる', async () => {
    await renderApp('/tasks/1')
    const title = screen.getByRole('textbox', { name: 'タイトル' })
    fireEvent.change(title, { target: { value: '結合テストで直したタイトル' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(async () => expect((await ctx.db.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, 1) }))?.title).toBe('結合テストで直したタイトル'))

    fireEvent.change(screen.getByRole('textbox', { name: 'コメント' }), { target: { value: '結合テストのコメント' } })
    fireEvent.click(screen.getByRole('button', { name: 'コメントする' }))
    expect(await screen.findByText('結合テストのコメント')).toBeTruthy()
    // 投稿できたらフォームは空に戻る
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'コメント' })).toHaveValue(''))

    fireEvent.click(screen.getByRole('button', { name: /のコメント（.*）を削除/ }))
    await waitFor(() => expect(screen.queryByText('結合テストのコメント')).toBeNull())
  })

  test('属性（ステータス）は変えたらすぐ保存する', async () => {
    await renderApp('/tasks/1')
    await run({ ref: 'ステータス', action: 'setValue', args: ['進行中'] })
    await waitFor(async () => expect((await ctx.db.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, 1) }))?.status).toBe('in_progress'))
  })

  test('存在しないタスクは 404 の画面にする', async () => {
    await renderApp('/tasks/9999')
    expect(heading()).toHaveTextContent('ページが見つかりません')
    expect(screen.getByText('タスク 9999 が見つかりません')).toBeTruthy()
  })
})

describe('プロジェクトのメンバーと設定', () => {
  test('メンバーを外すと、そのプロジェクトで担当していたタスクは未割り当てになる', async () => {
    await renderApp('/projects/1/members')
    const [project] = await ctx.db.query.projects.findMany({ where: (p, { eq }) => eq(p.id, 1), with: { projectMembers: { with: { member: true } } } })
    const assigned = project!.projectMembers.map((m) => m.member.name)
    expect(assigned.length).toBeGreaterThan(0)
    await run({ ref: 'プロジェクトメンバーの割り当て', action: 'unassign', args: [assigned] })
    await waitFor(async () => expect(await ctx.db.query.projectMembers.findMany({ where: (pm, { eq }) => eq(pm.projectId, 1) })).toEqual([]))
    const assignedTasks = await ctx.db.query.tasks.findMany({ where: (t, { and, eq, isNotNull }) => and(eq(t.projectId, 1), isNotNull(t.assigneeId)) })
    expect(assignedTasks).toEqual([])
  })

  test('名前を空にして保存すると項目の下にエラー、アーカイブすると一覧から外れる', async () => {
    await renderApp('/projects/1/settings')
    fireEvent.change(screen.getByRole('textbox', { name: 'プロジェクト名' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('プロジェクト名を入力してください')).toBeTruthy()

    fireEvent.change(screen.getByRole('textbox', { name: 'プロジェクト名' }), { target: { value: '名前を変えたプロジェクト' } })
    await run({ ref: 'アーカイブする', action: 'toggle' })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(async () =>
      expect(await ctx.db.query.projects.findFirst({ where: (p, { eq }) => eq(p.id, 1) })).toMatchObject({
        name: '名前を変えたプロジェクト',
        status: 'archived',
      }),
    )
    // サイドバーの「進行中」から外れる（action のあとで root の loader も読み直される）
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: '進行中のプロジェクト' })).not.toHaveTextContent('名前を変えたプロジェクト'),
    )
  })

  test('削除は確認のあとで行い、プロジェクト一覧へ戻る', async () => {
    const { router } = await renderApp('/projects/1/settings')
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクトを削除' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(/タスク \d+ 件と、そのコメントもすべて削除します/)
    fireEvent.click(within(dialog).getByRole('button', { name: '完全に削除する' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'))
    expect(await ctx.db.query.projects.findFirst({ where: (p, { eq }) => eq(p.id, 1) })).toBeUndefined()
  })
})

describe('メンバーの編集と削除', () => {
  test('編集ダイアログに今の値が入っていて、保存できる', async () => {
    await renderApp('/members')
    const [first] = await ctx.db.query.members.findMany({ orderBy: (m, { asc }) => asc(m.name), limit: 1 })
    fireEvent.click(screen.getByRole('button', { name: `${first!.name}さんの操作` }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '編集' }))
    const dialog = await screen.findByRole('dialog', { name: `${first!.name}さんを編集` })
    expect(within(dialog).getByRole('textbox', { name: 'メールアドレス' })).toHaveValue(first!.email)
    fireEvent.change(within(dialog).getByRole('textbox', { name: '役割' }), { target: { value: 'テックリード' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(async () => expect((await ctx.db.query.members.findFirst({ where: (m, { eq }) => eq(m.id, first!.id) }))?.title).toBe('テックリード'))
  })

  test('削除の確認には、未割り当てになるタスクの件数を出す', async () => {
    await renderApp('/members')
    const busy = (await ctx.db.query.tasks.findMany({ where: (t, { isNotNull, ne, and }) => and(isNotNull(t.assigneeId), ne(t.status, 'done')) }))[0]!
    const member = (await ctx.db.query.members.findFirst({ where: (m, { eq }) => eq(m.id, busy.assigneeId!) }))!
    fireEvent.click(screen.getByRole('button', { name: `${member.name}さんの操作` }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '削除' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(/担当中のタスク \d+ 件は未割り当てになり/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'メンバーを削除' }))
    await waitFor(async () => expect(await ctx.db.query.members.findFirst({ where: (m, { eq }) => eq(m.id, member.id) })).toBeUndefined())
  })
})

describe('保存していない変更', () => {
  test('タスク詳細でタイトルを変えたまま移動しようとすると確認し、キャンセルなら留まる', async () => {
    const { router } = await renderApp('/tasks/1')
    fireEvent.change(screen.getByRole('textbox', { name: 'タイトル' }), { target: { value: '書きかけ' } })
    await act(() => router.navigate('/members'))
    const dialog = await screen.findByRole('alertdialog', { name: '保存していない変更があります' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(router.state.location.pathname).toBe('/tasks/1')

    await act(() => router.navigate('/members'))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '破棄して移動' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/members'))
  })
})

describe('メンバー', () => {
  test('メールアドレスの重複は、ダイアログの項目の下に出す', async () => {
    await renderApp('/members')
    const [first] = await ctx.db.query.members.findMany({ limit: 1 })
    await run(
      { ref: 'メンバーを追加', action: 'press' },
      { ref: '名前', action: 'setValue', args: ['重複する人'] },
      { ref: 'メールアドレス', action: 'setValue', args: [first!.email.toUpperCase()] },
      { ref: 'メンバーを追加', action: 'press', args: ['追加'] },
    )
    expect(await screen.findByText('このメールアドレスは既に使われています')).toBeTruthy()
  })
})

describe('設定', () => {
  test('タグを追加・削除できる', async () => {
    await renderApp('/settings')
    await run({ ref: '新しいタグ', action: 'setValue', args: ['結合テストのタグ'] })
    fireEvent.click(screen.getByRole('button', { name: '追加' }))
    expect(await screen.findByText('結合テストのタグ')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'タグ「結合テストのタグ」を削除' }))
    await waitFor(() => expect(screen.queryByText('結合テストのタグ')).toBeNull())
  })

  test('障害シミュレーションを選ぶと、端末の設定に入る（保存はしない）', async () => {
    await renderApp('/settings')
    await run({ ref: '障害シミュレーション', action: 'setValue', args: ['保存だけ失敗させる（503）'] })
    expect(usePreferences.getState().fault).toBe('error-writes')
    expect(localStorage.getItem('starter-kit:preferences')).not.toContain('fault')
  })

  test('API が失敗しても設定画面は開け、失敗した部分だけをエラー表示にする', async () => {
    usePreferences.getState().setFault('error-all')
    await renderApp('/settings')
    expect(heading()).toHaveTextContent('設定')
    expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('障害シミュレーション中です'))).toBe(true)
    expect(screen.getByRole('combobox', { name: '障害シミュレーション' })).toBeTruthy()
  })
})

describe('エラーの表示', () => {
  test('読み込みに失敗したら「再試行」を出し、押して成功すれば画面に戻る', async () => {
    let fail = true
    ctx.server.use(
      http.get(`${API_BASE}/members`, () => (fail ? HttpResponse.json({ error: '一時的に使えません' }, { status: 503 }) : undefined)),
    )
    await renderApp('/members')
    expect(heading()).toHaveTextContent('データを読み込めませんでした')
    expect(screen.getByText('一時的に使えません')).toBeTruthy()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '再試行' }))
    await waitFor(() => expect(heading()).toHaveTextContent('メンバー'))
  })

  test('やり直しても変わらないエラー（403 など）には「再試行」を出さない', async () => {
    ctx.server.use(http.get(`${API_BASE}/members`, () => HttpResponse.json({ error: '権限がありません' }, { status: 403 })))
    await renderApp('/members')
    expect(heading()).toHaveTextContent('このページを表示できません')
    expect(screen.queryByRole('button', { name: '再試行' })).toBeNull()
  })

  test('描画中の想定外の例外は「問題が発生しました」にし、記録に残す', async () => {
    // React と React Router は、ErrorBoundary が受け止めた例外もコンソールに出す
    allowConsole(/members\.map is not a function/)
    ctx.server.use(http.get(`${API_BASE}/members`, () => HttpResponse.json({ not: 'a list' })))
    await renderApp('/members')
    expect(heading()).toHaveTextContent('問題が発生しました')
    expect(screen.getByRole('button', { name: 'ページを読み込み直す' })).toBeTruthy()
  })

  test('保存の失敗（通信断）はフォームに残し、入力を消さない', async () => {
    await renderApp('/settings')
    usePreferences.getState().setFault('offline')
    await run({ ref: '新しいタグ', action: 'setValue', args: ['送れないタグ'] })
    fireEvent.click(screen.getByRole('button', { name: '追加' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '追加' })).not.toHaveAttribute('aria-disabled', 'true'))
    expect(screen.getByRole('textbox', { name: '新しいタグ' })).toHaveValue('送れないタグ')
  })

  test('存在しない URL は 404 にする', async () => {
    await renderApp('/no-such-page')
    expect(heading()).toHaveTextContent('ページが見つかりません')
    expect(screen.getByRole('link', { name: 'ダッシュボードへ戻る' })).toBeTruthy()
  })
})
