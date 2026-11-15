// @vitest-environment node
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { comments, members, projectMembers, tasks, taskTags } from '../db/schema'
import { createTestDb, type TestDb } from '../test/db'
import { getDashboard } from './dashboard'
import { deleteMember, listMembers } from './members'
import { listTags } from './tags'
import { deleteProject, getProject, listProjects, setProjectMembers } from './projects'
import { addComment, createTask, getTask, listTasks, updateTask } from './tasks'

let db: TestDb

beforeEach(async () => {
  db = await createTestDb()
})
afterEach(async () => {
  await db.$close()
})

const projectNamed = async (name: string) => (await listProjects(db)).find((p) => p.name === name)!
const memberNamed = async (name: string) => (await listMembers(db)).find((m) => m.name === name)!

describe('リレーション', () => {
  test('プロジェクトを消すと、タスク・タグの紐付け・コメントも消える（CASCADE）', async () => {
    const web = await projectNamed('Web サイト刷新')
    const ids = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, web.id))).map((t) => t.id)
    expect(ids.length).toBe(12)

    await deleteProject(db, web.id)

    expect(await db.select().from(tasks).where(eq(tasks.projectId, web.id))).toEqual([])
    const leftTags = await db.select().from(taskTags)
    expect(leftTags.some((t) => ids.includes(t.taskId))).toBe(false)
    const leftComments = await db.select().from(comments)
    expect(leftComments.some((c) => ids.includes(c.taskId))).toBe(false)
    expect(await db.select().from(projectMembers).where(eq(projectMembers.projectId, web.id))).toEqual([])
  })

  test('メンバーを消すと、担当タスクは未割り当てになり、コメントは投稿者なしで残る（SET NULL）', async () => {
    const bunta = await memberNamed('馬場 文太')
    const before = await db.select().from(tasks).where(eq(tasks.assigneeId, bunta.id))
    const commentCount = (await db.select().from(comments).where(eq(comments.authorId, bunta.id))).length
    expect(before.length).toBeGreaterThan(0)
    expect(commentCount).toBeGreaterThan(0)

    await deleteMember(db, bunta.id)

    for (const t of before) {
      const [row] = await db.select().from(tasks).where(eq(tasks.id, t.id))
      expect(row!.assigneeId).toBeNull()
    }
    const orphaned = await db.select().from(comments).where(eq(comments.body, '了解です。モバイルのハンバーガーメニューも合わせて対応します。'))
    expect(orphaned[0]!.authorId).toBeNull()
    expect(await db.select().from(members).where(eq(members.id, bunta.id))).toEqual([])
  })

  test('プロジェクトから外したメンバーの担当タスクは、そのプロジェクト内だけ未割り当てに戻る', async () => {
    const web = await projectNamed('Web サイト刷新')
    const mobile = await projectNamed('モバイルアプリ v2')
    const bunta = await memberNamed('馬場 文太')
    const mobileBefore = (await listTasks(db, mobile.id, { assignee: bunta.id })).total

    const keep = (await getProject(db, web.id)).members.map((m) => m.id).filter((id) => id !== bunta.id)
    const { project, unassignedTaskCount } = await setProjectMembers(db, web.id, { memberIds: keep })

    expect(project.members.map((m) => m.id)).not.toContain(bunta.id)
    expect(unassignedTaskCount).toBe(3)
    expect((await listTasks(db, web.id, { assignee: bunta.id })).total).toBe(0)
    expect((await listTasks(db, mobile.id, { assignee: bunta.id })).total).toBe(mobileBefore)
  })

  test('一部の項目だけを更新しても、ほかの項目（担当者など）は消えない', async () => {
    const web = await projectNamed('Web サイト刷新')
    const target = (await listTasks(db, web.id, { q: 'ヘッダー' })).items[0]!
    const updated = await updateTask(db, target.id, { status: 'done' })
    expect(updated.assignee?.name).toBe('馬場 文太')
    expect(updated.tags.map((t) => t.name)).toEqual(['UI'])
    expect(updated.dueDate).toBe(target.dueDate)
  })

  test('担当者はプロジェクトのメンバーに限る', async () => {
    const infra = await projectNamed('社内ツール基盤')
    const aiko = await memberNamed('相沢 愛子')
    await expect(createTask(db, infra.id, { title: 'x', assigneeId: aiko.id })).rejects.toMatchObject({
      status: 400,
      fieldErrors: { assigneeId: [expect.any(String)] },
    })
  })

  test('タスク詳細はプロジェクト・担当者・タグ・コメントを一度に返す', async () => {
    const web = await projectNamed('Web サイト刷新')
    const page = await listTasks(db, web.id, { q: 'ヘッダー' })
    const task = await getTask(db, page.items[0]!.id)
    expect(task.project.name).toBe('Web サイト刷新')
    expect(task.project.members).toHaveLength(4)
    expect(task.assignee?.name).toBe('馬場 文太')
    expect(task.tags.map((t) => t.name)).toEqual(['UI'])
    expect(task.comments.map((c) => c.author?.name)).toEqual(['相沢 愛子', '馬場 文太'])
  })
})

describe('タスク', () => {
  test('作成時に Zod の検証エラーを項目ごとに返す', async () => {
    const web = await projectNamed('Web サイト刷新')
    await expect(createTask(db, web.id, { title: '  ', dueDate: '2026/01/01' })).rejects.toMatchObject({
      status: 400,
      fieldErrors: { title: [expect.any(String)], dueDate: [expect.any(String)] },
    })
  })

  test('FormData 由来の文字列（空の担当者・複数タグ）も受け取れる', async () => {
    const web = await projectNamed('Web サイト刷新')
    const created = await createTask(db, web.id, {
      title: '新しいタスク',
      assigneeId: '',
      dueDate: '',
      tagIds: ['1', '2'],
      priority: 'high',
    })
    expect(created.assignee).toBeNull()
    expect(created.dueDate).toBeNull()
    expect(created.tags).toHaveLength(2)

    const updated = await updateTask(db, created.id, { tagIds: [], status: 'done' })
    expect(updated.tags).toEqual([])
    expect(updated.status).toBe('done')
    // 送っていない項目は変わらない
    expect(updated.priority).toBe('high')
    expect(updated.title).toBe('新しいタスク')
  })

  test('絞り込み・並べ替え・ページングは URL のクエリをそのまま受け取る', async () => {
    const web = await projectNamed('Web サイト刷新')
    const all = await listTasks(db, web.id, { pageSize: '5', page: '3' })
    expect(all).toMatchObject({ total: 12, page: 3, pageCount: 3 })
    expect(all.items).toHaveLength(2)

    const unassigned = await listTasks(db, web.id, { assignee: 'none' })
    expect(unassigned.items.every((t) => t.assignee === null)).toBe(true)

    const byPriority = await listTasks(db, web.id, { sort: 'priority', status: 'todo' })
    expect(byPriority.items[0]!.priority).toBe('high')
    expect(byPriority.items.every((t) => t.status === 'todo')).toBe(true)

    const bugs = await listTasks(db, web.id, { tag: '3' })
    expect(bugs.items.map((t) => t.title)).toEqual(['Safari でメニューが閉じない'])

    const broken = await listTasks(db, web.id, { sort: 'nope', page: '-1', status: 'zzz' })
    expect(broken).toMatchObject({ total: 12, page: 1 })
  })

  test('コメントの投稿者は存在するメンバーに限る', async () => {
    const web = await projectNamed('Web サイト刷新')
    const taskId = (await listTasks(db, web.id, {})).items[0]!.id
    await expect(addComment(db, taskId, { body: 'hi', authorId: 9999 })).rejects.toMatchObject({ status: 400 })
    const c = await addComment(db, taskId, { body: 'hi', authorId: 1 })
    expect(c.author?.name).toBe('相沢 愛子')
  })
})

test('一覧の件数（相関サブクエリ）が行ごとに正しい', async () => {
  const counts = Object.fromEntries((await listMembers(db)).map((m) => [m.name, [m.projectCount, m.openTaskCount]]))
  expect(counts['馬場 文太']).toEqual([2, 5])
  expect(counts['千葉 千夏']).toEqual([1, 0])
  const web = await projectNamed('Web サイト刷新')
  expect([web.taskCount, web.doneCount]).toEqual([12, 3])
  const tags = Object.fromEntries((await listTags(db)).map((t) => [t.name, t.taskCount]))
  expect(tags['UI']).toBe(8)
})

test('ダッシュボードの集計', async () => {
  const d = await getDashboard(db, '2026-11-15')
  expect(d.counts).toEqual({ projects: 3, openTasks: 17, overdue: 1, members: 8 })
  expect(d.projects.map((p) => [p.name, p.taskCount, p.doneCount])).toEqual([
    ['Web サイト刷新', 12, 3],
    ['モバイルアプリ v2', 6, 1],
    ['社内ツール基盤', 4, 1],
  ])
  expect(d.upcoming[0]!.title).toBe('Safari でメニューが閉じない')
})
