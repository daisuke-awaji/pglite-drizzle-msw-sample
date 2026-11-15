import { describe, expect, test } from 'vitest'
import { createHandlers } from '../mocks/handlers'
import { API_BASE } from '../shared/api-path'
import { usePreferences } from '../stores/preferences'
import { setupTestApi } from '../test/api'
import { allowConsole } from '../test/console'
import { TEST_TODAY } from '../test/db'
import { api, ApiError } from './client'

// API クライアント → MSW ハンドラー → src/server → PGlite を本物のままつないで確かめる。
// 最後のテストで「すべてのハンドラーにケースがあるか」を確かめるので、エンドポイントを足したらここにも足す
const ctx = setupTestApi()

const covered = new Set<string>()
function endpoint(name: string, fn: () => Promise<void>) {
  covered.add(name)
  // oxlint-disable-next-line vitest/valid-title, vitest/expect-expect -- 名前と本体は呼び出し側が渡す
  test(name, fn)
}

const raw = (path: string, init?: RequestInit) => fetch(new URL(`${API_BASE}${path}`, location.origin), init)

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const e = await promise.then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(ApiError)
  return e as ApiError
}

const firstProject = async () => (await api.listProjects())[0]!
const firstTask = async () => (await api.listTasks((await firstProject()).id, {})).items[0]!

describe('エンドポイント', () => {
  endpoint('GET /dashboard', async () => {
    const d = await api.dashboard(TEST_TODAY)
    expect(d.counts).toEqual({ projects: 3, openTasks: 17, overdue: 1, members: 8 })
  })

  endpoint('GET /projects', async () => {
    expect((await api.listProjects()).map((p) => p.name)).toContain('Web サイト刷新')
    expect(await api.listProjects({ status: 'archived' })).toHaveLength(1)
    expect((await api.listProjects({ q: 'モバイル' })).map((p) => p.name)).toEqual(['モバイルアプリ v2'])
  })

  endpoint('POST /projects', async () => {
    const created = await api.createProject({ name: '  新規  ', color: 'green' })
    expect(created).toMatchObject({ name: '新規', color: 'green', status: 'active', members: [] })
    const e = await apiError(api.createProject({ name: '' }))
    expect(e).toMatchObject({ kind: 'http', status: 400, retryable: false, fieldErrors: { name: [expect.any(String)] } })
  })

  endpoint('GET /projects/:id', async () => {
    const first = await firstProject()
    expect((await api.getProject(first.id)).id).toBe(first.id)
    expect(await apiError(api.getProject(9999))).toMatchObject({ status: 404, retryable: false })
  })

  endpoint('PATCH /projects/:id', async () => {
    const first = await firstProject()
    expect(await api.updateProject(first.id, { status: 'archived' })).toMatchObject({ status: 'archived', name: first.name })
    expect(await apiError(api.updateProject(9999, { name: 'x' }))).toMatchObject({ status: 404 })
  })

  endpoint('DELETE /projects/:id', async () => {
    const first = await firstProject()
    await expect(api.deleteProject(first.id)).resolves.toBeUndefined()
    expect(await apiError(api.getProject(first.id))).toMatchObject({ status: 404 })
    expect(await apiError(api.deleteProject(first.id))).toMatchObject({ status: 404 })
  })

  endpoint('PUT /projects/:id/members', async () => {
    const first = await firstProject()
    const result = await api.setProjectMembers(first.id, [])
    expect(result.project.members).toEqual([])
    expect(result.unassignedTaskCount).toBeGreaterThan(0)
    expect(await apiError(api.setProjectMembers(first.id, [99999]))).toMatchObject({ status: 400 })
  })

  endpoint('GET /projects/:id/tasks', async () => {
    const first = await firstProject()
    const page = await api.listTasks(first.id, { pageSize: 5, status: 'todo' })
    expect(page.pageSize).toBe(5)
    expect(page.items.every((t) => t.status === 'todo')).toBe(true)
    // 存在しないプロジェクトは「0 件」ではなく 404（URL の打ち間違いや削除済みに気づけるように）
    expect(await apiError(api.listTasks(9999, {}))).toMatchObject({ status: 404 })
  })

  endpoint('POST /projects/:id/tasks', async () => {
    const first = await firstProject()
    const created = await api.createTask(first.id, { title: 'API から作る', priority: 'low' })
    expect(created).toMatchObject({ title: 'API から作る', priority: 'low', status: 'todo' })
    const e = await apiError(api.createTask(first.id, { title: 'x'.repeat(201) }))
    expect(e.fieldErrors?.title?.[0]).toMatch(/200 文字以内/)
    expect(await apiError(api.createTask(9999, { title: 'x' }))).toMatchObject({ status: 404 })
  })

  endpoint('GET /tasks/:id', async () => {
    const task = await firstTask()
    expect((await api.getTask(task.id)).project.id).toBe(task.projectId)
    expect(await apiError(api.getTask(9999))).toMatchObject({ status: 404 })
  })

  endpoint('PATCH /tasks/:id', async () => {
    const task = await firstTask()
    expect(await api.updateTask(task.id, { status: 'done' })).toMatchObject({ status: 'done', title: task.title })
    expect(await apiError(api.updateTask(task.id, { status: 'nope' as never }))).toMatchObject({ status: 400 })
    expect(await apiError(api.updateTask(9999, { status: 'done' }))).toMatchObject({ status: 404 })
  })

  endpoint('DELETE /tasks/:id', async () => {
    const task = await firstTask()
    await api.deleteTask(task.id)
    expect(await apiError(api.getTask(task.id))).toMatchObject({ status: 404 })
    expect(await apiError(api.deleteTask(task.id))).toMatchObject({ status: 404 })
  })

  endpoint('POST /tasks/:id/comments', async () => {
    const task = await firstTask()
    const c = await api.addComment(task.id, { body: 'こんにちは', authorId: 1 })
    expect(c).toMatchObject({ body: 'こんにちは', author: { id: 1 } })
    expect(await apiError(api.addComment(task.id, { body: '', authorId: 1 }))).toMatchObject({ status: 400 })
    expect(await apiError(api.addComment(9999, { body: 'x', authorId: 1 }))).toMatchObject({ status: 404 })
  })

  endpoint('DELETE /comments/:id', async () => {
    const task = await firstTask()
    const c = await api.addComment(task.id, { body: '消す', authorId: 1 })
    await api.deleteComment(c.id)
    expect((await api.getTask(task.id)).comments.map((x) => x.id)).not.toContain(c.id)
    expect(await apiError(api.deleteComment(c.id))).toMatchObject({ status: 404 })
  })

  endpoint('GET /members', async () => {
    expect(await api.listMembers()).toHaveLength(8)
  })

  endpoint('POST /members', async () => {
    // 前後の空白と大文字小文字を整えてから形式を確かめ、同じアドレスは重複として扱う
    const m = await api.createMember({ name: '新人', email: ' NEW@Example.com ' })
    expect(m).toMatchObject({ name: '新人', email: 'new@example.com', title: '' })
    const dup = await apiError(api.createMember({ name: '重複', email: 'New@example.com' }))
    expect(dup).toMatchObject({ status: 409, fieldErrors: { email: [expect.any(String)] } })
    const bad = await apiError(api.createMember({ name: '誤り', email: 'not-an-email' }))
    expect(bad.fieldErrors?.email?.[0]).toMatch(/形式/)
  })

  endpoint('PATCH /members/:id', async () => {
    const [first, second] = await api.listMembers()
    expect(await api.updateMember(first!.id, { title: 'リーダー' })).toMatchObject({ title: 'リーダー', name: first!.name })
    expect(await apiError(api.updateMember(first!.id, { email: second!.email.toUpperCase() }))).toMatchObject({ status: 409 })
    expect(await apiError(api.updateMember(9999, { title: 'x' }))).toMatchObject({ status: 404 })
  })

  endpoint('DELETE /members/:id', async () => {
    const [first] = await api.listMembers()
    await api.deleteMember(first!.id)
    expect((await api.listMembers()).map((m) => m.id)).not.toContain(first!.id)
    expect(await apiError(api.deleteMember(first!.id))).toMatchObject({ status: 404 })
  })

  endpoint('GET /tags', async () => {
    expect((await api.listTags()).map((t) => t.name)).toContain('UI')
  })

  endpoint('POST /tags', async () => {
    expect(await api.createTag({ name: '新タグ' })).toMatchObject({ name: '新タグ' })
    expect(await apiError(api.createTag({ name: '新タグ' }))).toMatchObject({ status: 409 })
    expect(await apiError(api.createTag({ name: '' }))).toMatchObject({ status: 400 })
  })

  endpoint('DELETE /tags/:id', async () => {
    const tag = await api.createTag({ name: '消すタグ' })
    await api.deleteTag(tag.id)
    expect((await api.listTags()).map((t) => t.id)).not.toContain(tag.id)
    expect(await apiError(api.deleteTag(tag.id))).toMatchObject({ status: 404 })
  })

  endpoint('GET /_debug', async () => {
    const info = await api.dbInfo()
    expect(info.version).toMatch(/PostgreSQL/)
    expect(info.migrations.length).toBeGreaterThan(0)
    expect(info.rows.tasks).toBe(24)
  })

  endpoint('POST /_reset', async () => {
    await api.deleteProject((await firstProject()).id)
    await api.reset()
    expect(await api.listProjects()).toHaveLength(4)
  })
})

describe('検索語はそのままの文字として探す', () => {
  test('% と _ と \\ はワイルドカードにならない', async () => {
    const project = await firstProject()
    await api.createTask(project.id, { title: '進捗 100% の確認' })
    await api.createTask(project.id, { title: 'snake_case の変換' })
    await api.createTask(project.id, { title: 'C:\\temp の掃除' })
    const titles = async (q: string) => (await api.listTasks(project.id, { q, pageSize: 50 })).items.map((t) => t.title)
    expect(await titles('%')).toEqual(['進捗 100% の確認'])
    expect(await titles('_')).toEqual(['snake_case の変換'])
    expect(await titles('\\')).toEqual(['C:\\temp の掃除'])
    expect((await api.listProjects({ q: '%' })).map((p) => p.name)).toEqual([])
  })
})

describe('HTTP としての振る舞い', () => {
  test('壊れた JSON は 400、id が正の整数でなければ 400', async () => {
    const bad = await raw('/projects', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'JSON の形式が正しくありません' })
    for (const id of ['abc', '0', '-1', '1.5']) expect((await raw(`/projects/${id}`)).status).toBe(400)
  })

  test('作成は 201、削除は 204（本文なし）', async () => {
    const res = await raw('/tags', { method: 'POST', body: JSON.stringify({ name: 'x' }) })
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: number }
    const del = await raw(`/tags/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)
    expect(await del.text()).toBe('')
  })

  test('サーバー層の想定外の例外は 500 にして、中身は返さない', async () => {
    allowConsole(/boom/)
    ctx.server.use(...createHandlers({ getDb: () => Promise.reject(new Error('boom: connection refused')), getLatency: () => 0 }))
    const res = await raw('/members')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'サーバーでエラーが発生しました' })
    expect(await apiError(api.listMembers())).toMatchObject({ kind: 'http', status: 500, retryable: true })
  })

  test('本文のないエラー応答には、状態コードに合った文言を付ける', async () => {
    const { http, HttpResponse } = await import('msw')
    ctx.server.use(http.get(`${API_BASE}/tags`, () => new HttpResponse(null, { status: 429 })))
    const e = await apiError(api.listTags())
    expect(e).toMatchObject({ kind: 'http', status: 429, retryable: true })
    expect(e.message).toMatch(/しばらく待って/)
  })

  test('JSON でない成功応答は parse エラーにする', async () => {
    const { http, HttpResponse } = await import('msw')
    ctx.server.use(http.get(`${API_BASE}/tags`, () => new HttpResponse('<html>', { status: 200 })))
    expect(await apiError(api.listTags())).toMatchObject({ kind: 'parse', retryable: false })
  })
})

describe('障害シミュレーション（設定画面）', () => {
  test('保存だけ失敗させる', async () => {
    usePreferences.getState().setFault('error-writes')
    await expect(api.listMembers()).resolves.toHaveLength(8)
    expect(await apiError(api.createTag({ name: 'x' }))).toMatchObject({ kind: 'http', status: 503, retryable: true })
  })

  test('すべて失敗させる（_debug と _reset は対象外なので、設定画面から戻せる）', async () => {
    usePreferences.getState().setFault('error-all')
    expect(await apiError(api.listMembers())).toMatchObject({ status: 503 })
    await expect(api.dbInfo()).resolves.toMatchObject({ rows: expect.any(Object) })
    await expect(api.reset()).resolves.toBeUndefined()
  })

  test('ネットワークにつながらない', async () => {
    usePreferences.getState().setFault('offline')
    const e = await apiError(api.listMembers())
    expect(e).toMatchObject({ kind: 'network', status: 0, retryable: true })
    expect(e.message).toMatch(/接続できません/)
  })

  test('API の遅延を設定すると、その分だけ待ってから応答する', async () => {
    ctx.server.use(...createHandlers({ getDb: async () => ctx.db, getLatency: () => 300 }))
    const started = performance.now()
    await api.listTags()
    expect(performance.now() - started).toBeGreaterThanOrEqual(280)
  })

  test('呼び出し側が中断したら、ApiError にせず AbortError のまま投げる', async () => {
    ctx.server.use(...createHandlers({ getDb: async () => ctx.db, getLatency: () => 500 }))
    const controller = new AbortController()
    const pending = api.listTags(controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

test('すべてのハンドラーに、上のケースがある', () => {
  const routes = createHandlers({ getDb: () => Promise.reject(new Error('unused')) }).map((h) => {
    const { method, path } = h.info as { method: string; path: string }
    return `${method} ${String(path).slice(API_BASE.length)}`
  })
  expect(routes.toSorted()).toEqual([...covered].toSorted())
})
