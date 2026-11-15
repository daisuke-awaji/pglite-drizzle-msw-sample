import { and, asc, desc, eq, ilike, inArray, notInArray, sql, type SQL } from 'drizzle-orm'
import { members, projectMembers, projects, tasks } from '../db/schema'
import { projectInput, projectListQuery, projectMembersInput, projectPatch } from '../shared/schemas'
import type { Member, ProjectDetail, ProjectListItem } from '../shared/types'
import { type Db, HttpError, iso, notFound, parse } from './core'

// 注意: 1 つの表だけを select するとき、Drizzle は列名を表名なしで出力する（"id" など）。
// sql`` で相関サブクエリを書くと "id" が内側の表の列と解釈されてしまうので、db.$count を使う
async function selectProjects(db: Db, where?: SQL) {
  return db
    .select({
      project: projects,
      taskCount: db.$count(tasks, eq(tasks.projectId, projects.id)),
      doneCount: db.$count(tasks, and(eq(tasks.projectId, projects.id), eq(tasks.status, 'done'))),
    })
    .from(projects)
    .where(where)
    .orderBy(asc(projects.status), desc(projects.updatedAt))
}

// N:N の相手（メンバー）は、プロジェクトごとに問い合わせず 1 回のクエリでまとめて取る
async function membersByProject(db: Db, projectIds: number[]) {
  const byProject = new Map<number, Member[]>()
  if (projectIds.length === 0) return byProject
  const rows = await db
    .select({ projectId: projectMembers.projectId, member: members })
    .from(projectMembers)
    .innerJoin(members, eq(members.id, projectMembers.memberId))
    .where(inArray(projectMembers.projectId, projectIds))
    .orderBy(asc(projectMembers.joinedAt), asc(members.id))
  for (const { projectId, member } of rows) {
    const list = byProject.get(projectId) ?? []
    list.push({ ...member, createdAt: iso(member.createdAt) })
    byProject.set(projectId, list)
  }
  return byProject
}

export async function listProjects(db: Db, rawQuery: unknown = {}): Promise<ProjectListItem[]> {
  const filter = projectListQuery.parse(rawQuery)
  const rows = await selectProjects(
    db,
    and(
      filter.q ? ilike(projects.name, `%${filter.q}%`) : undefined,
      filter.status ? eq(projects.status, filter.status) : undefined,
    ),
  )
  const membersOf = await membersByProject(db, rows.map((r) => r.project.id))
  return rows.map(({ project, ...counts }) => ({
    ...project,
    ...counts,
    updatedAt: iso(project.updatedAt),
    members: (membersOf.get(project.id) ?? []).map(({ id, name }) => ({ id, name })),
  }))
}

export async function getProject(db: Db, id: number): Promise<ProjectDetail> {
  const [row] = await selectProjects(db, eq(projects.id, id))
  if (!row) throw notFound('プロジェクト', id)
  const membersOf = await membersByProject(db, [id])
  return {
    ...row.project,
    taskCount: row.taskCount,
    doneCount: row.doneCount,
    createdAt: iso(row.project.createdAt),
    updatedAt: iso(row.project.updatedAt),
    members: membersOf.get(id) ?? [],
  }
}

export async function createProject(db: Db, body: unknown): Promise<ProjectDetail> {
  const input = parse(projectInput, body)
  const [row] = await db.insert(projects).values(input).returning({ id: projects.id })
  return getProject(db, row!.id)
}

export async function updateProject(db: Db, id: number, body: unknown): Promise<ProjectDetail> {
  const input = parse(projectPatch, body)
  if (Object.keys(input).length === 0) throw new HttpError(400, '更新する項目がありません')
  const updated = await db.update(projects).set(input).where(eq(projects.id, id)).returning({ id: projects.id })
  if (updated.length === 0) throw notFound('プロジェクト', id)
  return getProject(db, id)
}

// タスク・タスクのタグ・コメント・所属はすべて CASCADE で一緒に消える
export async function deleteProject(db: Db, id: number): Promise<void> {
  const deleted = await db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id })
  if (deleted.length === 0) throw notFound('プロジェクト', id)
}

// 所属メンバーを丸ごと置き換える。外れたメンバーが担当していたタスクは未割り当てに戻す
export async function setProjectMembers(
  db: Db,
  id: number,
  body: unknown,
): Promise<{ project: ProjectDetail; unassignedTaskCount: number }> {
  const { memberIds } = parse(projectMembersInput, body)
  const ids = [...new Set(memberIds)]

  const unassignedTaskCount = await db.transaction(async (tx) => {
    const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, id))
    if (!project) throw notFound('プロジェクト', id)

    if (ids.length > 0) {
      const found = await tx.select({ id: members.id }).from(members).where(inArray(members.id, ids))
      if (found.length !== ids.length) throw new HttpError(400, '存在しないメンバーが含まれています')
    }

    const keep = ids.length > 0 ? notInArray(projectMembers.memberId, ids) : undefined
    await tx.delete(projectMembers).where(and(eq(projectMembers.projectId, id), keep))
    if (ids.length > 0) {
      await tx
        .insert(projectMembers)
        .values(ids.map((memberId) => ({ projectId: id, memberId })))
        .onConflictDoNothing()
    }

    const unassigned = await tx
      .update(tasks)
      .set({ assigneeId: null })
      .where(
        and(
          eq(tasks.projectId, id),
          ids.length > 0 ? notInArray(tasks.assigneeId, ids) : sql`${tasks.assigneeId} is not null`,
        ),
      )
      .returning({ id: tasks.id })
    await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id))
    return unassigned.length
  })

  return { project: await getProject(db, id), unassignedTaskCount }
}
