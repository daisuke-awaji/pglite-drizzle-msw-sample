import { and, asc, desc, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { comments, members, projectMembers, projects, tags, tasks, taskTags } from '../db/schema'
import {
  commentBody,
  commentInput,
  taskInput,
  taskListQuery,
  taskPatch,
  type TaskListQuery,
} from '../shared/schemas'
import type { Comment, Page, Tag, TaskDetail, TaskListItem } from '../shared/types'
import { ALL, type Access, assertProjectAccess, assertTaskAccess, canSeeProject, forbidden, requireMember } from './access'
import { containsPattern, type Db, HttpError, iso, notFound, parse } from './core'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

const priorityRank = sql`case ${tasks.priority} when 'high' then 0 when 'medium' then 1 else 2 end`

const orderBy: Record<TaskListQuery['sort'], SQL[]> = {
  updated: [desc(tasks.updatedAt), desc(tasks.id)],
  due: [sql`${tasks.dueDate} asc nulls last`, desc(tasks.id)],
  priority: [asc(priorityRank), sql`${tasks.dueDate} asc nulls last`, desc(tasks.id)],
  title: [asc(tasks.title), asc(tasks.id)],
}

async function tagsByTask(db: Db | Tx, taskIds: number[]) {
  const byTask = new Map<number, Tag[]>()
  if (taskIds.length === 0) return byTask
  const rows = await db
    .select({ taskId: taskTags.taskId, id: tags.id, name: tags.name })
    .from(taskTags)
    .innerJoin(tags, eq(tags.id, taskTags.tagId))
    .where(inArray(taskTags.taskId, taskIds))
    .orderBy(asc(tags.name))
  for (const { taskId, ...tag } of rows) byTask.set(taskId, [...(byTask.get(taskId) ?? []), tag])
  return byTask
}

export async function listTasks(db: Db, projectId: number, rawQuery: unknown, access: Access = ALL): Promise<Page<TaskListItem>> {
  const query = taskListQuery.parse(rawQuery)
  // 存在しないプロジェクトは「0 件」ではなく 404 にする（URL の打ち間違いや削除済みに気づけるように）
  if ((await db.$count(projects, eq(projects.id, projectId))) === 0) throw notFound('プロジェクト', projectId)
  await assertProjectAccess(db, projectId, access)
  const where = and(
    eq(tasks.projectId, projectId),
    query.status ? eq(tasks.status, query.status) : undefined,
    query.assignee === 'none'
      ? isNull(tasks.assigneeId)
      : query.assignee
        ? eq(tasks.assigneeId, query.assignee)
        : undefined,
    query.tag
      ? inArray(tasks.id, db.select({ id: taskTags.taskId }).from(taskTags).where(eq(taskTags.tagId, query.tag)))
      : undefined,
    query.q ? ilike(tasks.title, containsPattern(query.q)) : undefined,
  )

  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(tasks)
    .where(where)
  const pageCount = Math.max(1, Math.ceil(total / query.pageSize))
  const page = Math.min(query.page, pageCount)

  const rows = await db
    .select({
      task: tasks,
      assignee: { id: members.id, name: members.name },
      commentCount: db.$count(comments, eq(comments.taskId, tasks.id)),
    })
    .from(tasks)
    .leftJoin(members, eq(members.id, tasks.assigneeId))
    .where(where)
    .orderBy(...orderBy[query.sort])
    .limit(query.pageSize)
    .offset((page - 1) * query.pageSize)

  const tagsOf = await tagsByTask(db, rows.map((r) => r.task.id))
  return {
    items: rows.map(({ task, assignee, commentCount }) => ({
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate,
      updatedAt: iso(task.updatedAt),
      assignee: assignee?.id ? assignee : null,
      tags: tagsOf.get(task.id) ?? [],
      commentCount,
    })),
    total,
    page,
    pageSize: query.pageSize,
    pageCount,
  }
}

// 関連をたどる取得は Drizzle のリレーショナルクエリ（db.query + with）で 1 回に書ける
export async function getTask(db: Db, id: number, access: Access = ALL): Promise<TaskDetail> {
  if (access.kind === 'user') await assertTaskAccess(db, id, access)
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
    with: {
      project: {
        columns: { id: true, name: true, color: true },
        with: { projectMembers: { with: { member: { columns: { id: true, name: true } } } } },
      },
      assignee: { columns: { id: true, name: true } },
      taskTags: { with: { tag: true } },
      comments: {
        orderBy: [asc(comments.createdAt), asc(comments.id)],
        with: { author: { columns: { id: true, name: true } } },
      },
    },
  })
  if (!task) throw notFound('タスク', id)
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate,
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
    assignee: task.assignee,
    tags: task.taskTags.map((t) => t.tag).toSorted((a, b) => a.name.localeCompare(b.name)),
    project: {
      id: task.project.id,
      name: task.project.name,
      color: task.project.color,
      members: task.project.projectMembers.map((pm) => pm.member),
    },
    comments: task.comments.map(toComment),
  }
}

const toComment = (c: { id: number; body: string; createdAt: Date; author: Comment['author'] }): Comment => ({
  id: c.id,
  body: c.body,
  createdAt: iso(c.createdAt),
  author: c.author,
})

// 担当者はそのプロジェクトのメンバーに限る（DB の外部キーだけでは表せない業務ルール）
async function assertAssignable(tx: Tx, projectId: number, assigneeId: number | null | undefined) {
  if (assigneeId == null) return
  const [row] = await tx
    .select({ memberId: projectMembers.memberId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.memberId, assigneeId)))
  if (!row) {
    throw new HttpError(400, '担当者はプロジェクトのメンバーから選んでください', {
      assigneeId: ['担当者はプロジェクトのメンバーから選んでください'],
    })
  }
}

async function replaceTags(tx: Tx, taskId: number, tagIds: number[]) {
  const ids = [...new Set(tagIds)]
  if (ids.length > 0) {
    const found = await tx.select({ id: tags.id }).from(tags).where(inArray(tags.id, ids))
    if (found.length !== ids.length) {
      throw new HttpError(400, '存在しないタグが含まれています', { tagIds: ['存在しないタグが含まれています'] })
    }
  }
  await tx.delete(taskTags).where(eq(taskTags.taskId, taskId))
  if (ids.length > 0) await tx.insert(taskTags).values(ids.map((tagId) => ({ taskId, tagId })))
}

const touchProject = (tx: Tx, projectId: number) =>
  tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId))

export async function createTask(db: Db, projectId: number, body: unknown, access: Access = ALL): Promise<TaskDetail> {
  const { tagIds, ...input } = parse(taskInput, body)
  const id = await db.transaction(async (tx) => {
    const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))
    if (!project) throw notFound('プロジェクト', projectId)
    await assertProjectAccess(tx, projectId, access)
    await assertAssignable(tx, projectId, input.assigneeId)
    const [row] = await tx.insert(tasks).values({ ...input, projectId }).returning({ id: tasks.id })
    await replaceTags(tx, row!.id, tagIds)
    await touchProject(tx, projectId)
    return row!.id
  })
  return getTask(db, id, access)
}

export async function updateTask(db: Db, id: number, body: unknown, access: Access = ALL): Promise<TaskDetail> {
  const { tagIds, ...input } = parse(taskPatch, body)
  if (Object.keys(input).length === 0 && tagIds === undefined) {
    throw new HttpError(400, '更新する項目がありません')
  }
  await db.transaction(async (tx) => {
    const [task] = await tx.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, id))
    if (!task || !(await canSeeProject(tx, task.projectId, access))) throw notFound('タスク', id)
    await assertAssignable(tx, task.projectId, input.assigneeId)
    // タグだけを変えたときも更新日時を進める
    await tx.update(tasks).set({ ...input, updatedAt: new Date() }).where(eq(tasks.id, id))
    if (tagIds !== undefined) await replaceTags(tx, id, tagIds)
    await touchProject(tx, task.projectId)
  })
  return getTask(db, id, access)
}

export async function deleteTask(db: Db, id: number, access: Access = ALL): Promise<void> {
  await db.transaction(async (tx) => {
    if (access.kind === 'user') await assertTaskAccess(tx, id, access)
    const [deleted] = await tx.delete(tasks).where(eq(tasks.id, id)).returning({ projectId: tasks.projectId })
    if (!deleted) throw notFound('タスク', id)
    await touchProject(tx, deleted.projectId)
  })
}

// 投稿者は、そのタスクのプロジェクトのメンバーに限る（担当者と同じ業務ルール）。
// ログインしているときは、投稿者をクライアントから受け取らず、ログイン中の利用者にする
export async function addComment(db: Db, taskId: number, body: unknown, access: Access = ALL): Promise<Comment> {
  const me = requireMember(access)
  const input = me === undefined ? parse(commentInput, body) : { ...parse(commentBody, body), authorId: me }
  return db.transaction(async (tx) => {
    const [task] = await tx.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))
    if (!task || !(await canSeeProject(tx, task.projectId, access))) throw notFound('タスク', taskId)
    const [author] = await tx
      .select({ id: members.id, name: members.name })
      .from(projectMembers)
      .innerJoin(members, eq(members.id, projectMembers.memberId))
      .where(and(eq(projectMembers.projectId, task.projectId), eq(projectMembers.memberId, input.authorId)))
    if (!author) {
      throw new HttpError(400, '投稿者はプロジェクトのメンバーから選んでください', {
        authorId: ['投稿者はプロジェクトのメンバーから選んでください'],
      })
    }
    const [row] = await tx.insert(comments).values({ ...input, taskId }).returning()
    return toComment({ ...row!, author })
  })
}

// ログインしているときは、自分のコメントだけを消せる（投稿者が削除されたコメントは、プロジェクトのメンバーなら消せる）。管理者は消せる
export async function deleteComment(db: Db, id: number, access: Access = ALL): Promise<void> {
  if (access.kind === 'user') {
    const [comment] = await db
      .select({ authorId: comments.authorId, projectId: tasks.projectId })
      .from(comments)
      .innerJoin(tasks, eq(tasks.id, comments.taskId))
      .where(eq(comments.id, id))
    if (!comment || !(await canSeeProject(db, comment.projectId, access))) throw notFound('コメント', id)
    if (comment.authorId !== null && comment.authorId !== access.memberId && !access.admin) throw forbidden('ほかの人のコメントは消せません')
  }
  const deleted = await db.delete(comments).where(eq(comments.id, id)).returning({ id: comments.id })
  if (deleted.length === 0) throw notFound('コメント', id)
}
