// @vitest-environment node
import { and, eq, notInArray } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { comments, members, projectMembers, projects, tags, tasks } from '../db/schema'
import { createTestDb, TEST_TODAY, type TestDb } from '../test/db'
import { ALL, resolveAccess, type Access } from './access'
import { HttpError } from './core'
import { getDashboard } from './dashboard'
import { createMember, deleteMember, listMembers, updateMember } from './members'
import { createProject, deleteProject, getProject, listProjects, setProjectMembers, updateProject } from './projects'
import { createTag, deleteTag } from './tags'
import { addComment, createTask, deleteComment, deleteTask, getTask, listTasks, updateTask } from './tasks'

// 認可（Phase 4）の表。ログインした人が読み書きできるのは、自分がメンバーのプロジェクトだけ。
// 見えないものは「ない」（404）として返し、管理者だけができることは 403 にする

let db: TestDb
let me: { id: number; email: string }
let other: { id: number; email: string }
let mine: number
let theirs: number
let user: Access
let admin: Access

beforeEach(async () => {
  db = await createTestDb()
  // シードから「自分がメンバーのプロジェクト」と「メンバーでないプロジェクト」がある人を選ぶ
  const all = await db.select().from(members)
  for (const m of all) {
    const joined = (await db.select({ id: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.memberId, m.id))).map((r) => r.id)
    const outside = await db.select({ id: projects.id }).from(projects).where(joined.length ? notInArray(projects.id, joined) : undefined)
    const outsideTask = outside.length ? (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, outside[0]!.id)))[0] : undefined
    if (joined.length && outsideTask) {
      me = { id: m.id, email: m.email }
      mine = joined[0]!
      theirs = outside[0]!.id
      break
    }
  }
  other = all.find((m) => m.id !== me.id)!
  user = await resolveAccess(db, { email: me.email.toUpperCase(), admin: false })
  admin = await resolveAccess(db, { email: me.email, admin: true })
})
afterEach(async () => {
  await db.$close()
})

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: unknown) => {
      if (e instanceof HttpError) return e.status
      throw e
    },
  )
const taskIn = async (projectId: number) => (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, projectId)))[0]!.id

describe('ログインした人をメンバーにつなぐ', () => {
  test('メールアドレスの大文字・小文字は区別しない', () => {
    expect(user).toEqual({ kind: 'user', memberId: me.id, admin: false, email: me.email.toLowerCase() })
  })

  test('メンバーとして登録されていない人は 403。管理者は自分を登録するために入れる（メンバーではない）', async () => {
    await expect(resolveAccess(db, { email: 'stranger@example.com', admin: false })).rejects.toMatchObject({ status: 403 })
    expect(await resolveAccess(db, { email: 'stranger@example.com', admin: true })).toMatchObject({ kind: 'user', memberId: null, admin: true })
  })
})

describe('プロジェクト', () => {
  test('一覧は自分がメンバーのものだけ（ALL は全部）', async () => {
    const visible = (await listProjects(db, {}, user)).map((p) => p.id)
    const joined = (await db.select({ id: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.memberId, me.id))).map((r) => r.id)
    expect(visible.toSorted()).toEqual(joined.toSorted())
    expect(visible).not.toContain(theirs)
    expect((await listProjects(db, {}, ALL)).length).toBe(await db.$count(projects))
  })

  test('メンバーでないプロジェクトは、ないプロジェクトと同じ 404（あることを知らせない）', async () => {
    const hidden = await getProject(db, theirs, user).catch((e: HttpError) => e)
    const missing = await getProject(db, 99_999, user).catch((e: HttpError) => e)
    expect(hidden).toMatchObject({ status: 404 })
    expect((hidden as HttpError).message).toBe(`プロジェクト ${theirs} が見つかりません`)
    expect(missing).toMatchObject({ status: 404 })
    expect(await status(getProject(db, mine, user))).toBe(200)
  })

  test('メンバーでないプロジェクトは変更も削除もできず、DB は変わらない', async () => {
    const before = await db.select().from(projects).where(eq(projects.id, theirs))
    expect(await status(updateProject(db, theirs, { name: '乗っ取り' }, user))).toBe(404)
    expect(await status(deleteProject(db, theirs, user))).toBe(404)
    expect(await status(setProjectMembers(db, theirs, { memberIds: [me.id] }, user))).toBe(404)
    expect(await db.select().from(projects).where(eq(projects.id, theirs))).toEqual(before)
    expect(await db.$count(projectMembers, and(eq(projectMembers.projectId, theirs), eq(projectMembers.memberId, me.id)))).toBe(0)
  })

  test('作ったプロジェクトには自分が入る（入らないと自分で見えなくなる）', async () => {
    const created = await createProject(db, { name: '新しいプロジェクト' }, user)
    expect(created.members.map((m) => m.id)).toEqual([me.id])
    expect((await listProjects(db, {}, user)).map((p) => p.id)).toContain(created.id)
  })

  test('メンバーとして登録されていない管理者は、プロジェクトを作れない（作っても見えない）', async () => {
    const outsider = await resolveAccess(db, { email: 'admin-only@example.com', admin: true })
    expect(await status(createProject(db, { name: 'x' }, outsider))).toBe(403)
    expect(await listProjects(db, {}, outsider)).toEqual([])
  })

  test('自分をメンバーから外すことはできない（外すと戻せなくなる）', async () => {
    const result = await setProjectMembers(db, mine, { memberIds: [other.id] }, user).catch((e: HttpError) => e)
    expect(result).toMatchObject({ status: 400, fieldErrors: { memberIds: [expect.stringMatching(/自分/)] } })
    expect(await status(setProjectMembers(db, mine, { memberIds: [me.id, other.id] }, user))).toBe(200)
  })
})

describe('タスクとコメント', () => {
  test('メンバーでないプロジェクトのタスクは、一覧・作成・取得・変更・削除のどれも 404', async () => {
    const task = await taskIn(theirs)
    const before = await db.select().from(tasks).where(eq(tasks.id, task))
    expect(await status(listTasks(db, theirs, {}, user))).toBe(404)
    expect(await status(createTask(db, theirs, { title: 'x' }, user))).toBe(404)
    expect(await status(getTask(db, task, user))).toBe(404)
    expect(await status(updateTask(db, task, { title: '乗っ取り' }, user))).toBe(404)
    expect(await status(deleteTask(db, task, user))).toBe(404)
    expect(await status(addComment(db, task, { body: 'x' }, user))).toBe(404)
    expect(await db.select().from(tasks).where(eq(tasks.id, task))).toEqual(before)
  })

  test('自分のプロジェクトのタスクは読み書きできる', async () => {
    const task = await taskIn(mine)
    expect(await status(listTasks(db, mine, {}, user))).toBe(200)
    expect((await updateTask(db, task, { title: '更新した' }, user)).title).toBe('更新した')
    const created = await createTask(db, mine, { title: '新しいタスク' }, user)
    expect(await status(deleteTask(db, created.id, user))).toBe(200)
  })

  test('コメントの投稿者はログイン中の利用者になる（送られてきた authorId は使わない）', async () => {
    const c = await addComment(db, await taskIn(mine), { body: 'こんにちは', authorId: other.id }, user)
    expect(c.author?.id).toBe(me.id)
  })

  test('ほかの人のコメントは消せない（403）。自分のコメントと、管理者は消せる', async () => {
    const task = await taskIn(mine)
    const [theirsComment] = await db.insert(comments).values({ taskId: task, authorId: other.id, body: 'ほかの人' }).returning()
    const mineComment = await addComment(db, task, { body: '自分' }, user)
    expect(await status(deleteComment(db, theirsComment!.id, user))).toBe(403)
    expect(await status(deleteComment(db, mineComment.id, user))).toBe(200)
    expect(await status(deleteComment(db, theirsComment!.id, admin))).toBe(200)
  })

  test('メンバーでないプロジェクトのコメントは 404', async () => {
    const [c] = await db.insert(comments).values({ taskId: await taskIn(theirs), authorId: other.id, body: 'x' }).returning()
    expect(await status(deleteComment(db, c!.id, user))).toBe(404)
    expect(await status(deleteComment(db, c!.id, admin))).toBe(404)
    expect(await db.$count(comments, eq(comments.id, c!.id))).toBe(1)
  })
})

describe('メンバーとタグ（管理者）', () => {
  test('メンバーの一覧は誰でも見られる。登録と削除は管理者だけ', async () => {
    expect(await status(listMembers(db))).toBe(200)
    expect(await status(createMember(db, { name: 'x', email: 'x@example.com' }, user))).toBe(403)
    expect(await status(deleteMember(db, other.id, user))).toBe(403)
    expect(await db.$count(members, eq(members.id, other.id))).toBe(1)
    const created = await createMember(db, { name: 'x', email: 'x@example.com' }, admin)
    expect(await status(deleteMember(db, created.id, admin))).toBe(200)
  })

  test('本人は名前と肩書きを変えられるが、メールアドレスと他人は変えられない', async () => {
    expect((await updateMember(db, me.id, { name: '新しい名前' }, user)).name).toBe('新しい名前')
    expect(await status(updateMember(db, me.id, { email: 'new@example.com' }, user))).toBe(403)
    expect(await status(updateMember(db, me.id, { email: me.email.toUpperCase() }, user))).toBe(200)
    expect(await status(updateMember(db, other.id, { name: '乗っ取り' }, user))).toBe(403)
    expect(await status(updateMember(db, other.id, { email: 'other@example.com' }, admin))).toBe(200)
  })

  test('タグは誰でも作れ、消すのは管理者だけ', async () => {
    const tag = await createTag(db, { name: '新しいタグ' })
    expect(await status(deleteTag(db, tag.id, user))).toBe(403)
    expect(await db.$count(tags, eq(tags.id, tag.id))).toBe(1)
    expect(await status(deleteTag(db, tag.id, admin))).toBe(200)
  })
})

describe('ダッシュボード', () => {
  test('数えるのは自分がメンバーのプロジェクトとそのタスクだけ（メンバーの数は全体）', async () => {
    const all = await getDashboard(db, TEST_TODAY, ALL)
    const mineOnly = await getDashboard(db, TEST_TODAY, user)
    const visibleIds = new Set((await listProjects(db, { status: 'active' }, user)).map((p) => p.id))
    expect(mineOnly.projects.map((p) => p.id).every((id) => visibleIds.has(id))).toBe(true)
    expect(mineOnly.counts.projects).toBe(visibleIds.size)
    expect(mineOnly.counts.members).toBe(all.counts.members)
    expect(mineOnly.upcoming.every((t) => visibleIds.has(t.project.id))).toBe(true)
    const visibleTaskCount = Object.values(mineOnly.byStatus).reduce((n, v) => n + v, 0)
    const expected = (await Promise.all([...(await listProjects(db, {}, user))].map((p) => db.$count(tasks, eq(tasks.projectId, p.id))))).reduce((n, v) => n + v, 0)
    expect(visibleTaskCount).toBe(expected)
    expect(visibleTaskCount).toBeLessThan(Object.values(all.byStatus).reduce((n, v) => n + v, 0))
  })
})
