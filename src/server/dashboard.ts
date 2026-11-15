import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm'
import { members, projects, tasks } from '../db/schema'
import { TASK_STATUSES } from '../shared/enums'
import type { Dashboard } from '../shared/types'
import type { Db } from './core'

const count = sql<number>`count(*)`.mapWith(Number)

export async function getDashboard(db: Db, today: string): Promise<Dashboard> {
  const [[projectCount], [memberCount], [overdue], statusRows, progress, upcoming] = await Promise.all([
    db.select({ n: count }).from(projects).where(eq(projects.status, 'active')),
    db.select({ n: count }).from(members),
    db
      .select({ n: count })
      .from(tasks)
      .where(and(ne(tasks.status, 'done'), sql`${tasks.dueDate} < ${today}`)),
    db.select({ status: tasks.status, n: count }).from(tasks).groupBy(tasks.status),
    db
      .select({
        id: projects.id,
        name: projects.name,
        color: projects.color,
        // LEFT JOIN なので、タスクのないプロジェクトは count(tasks.id) が 0 になる
        taskCount: sql<number>`count(${tasks.id})`.mapWith(Number),
        doneCount: sql<number>`count(*) filter (where ${tasks.status} = 'done')`.mapWith(Number),
      })
      .from(projects)
      .leftJoin(tasks, eq(tasks.projectId, projects.id))
      .where(eq(projects.status, 'active'))
      .groupBy(projects.id)
      .orderBy(asc(projects.name)),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        dueDate: tasks.dueDate,
        status: tasks.status,
        assigneeId: members.id,
        assigneeName: members.name,
        projectId: projects.id,
        projectName: projects.name,
      })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .leftJoin(members, eq(members.id, tasks.assigneeId))
      .where(and(ne(tasks.status, 'done'), isNotNull(tasks.dueDate), eq(projects.status, 'active')))
      .orderBy(asc(tasks.dueDate), asc(tasks.id))
      .limit(6),
  ])

  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Dashboard['byStatus']
  for (const row of statusRows) byStatus[row.status] = row.n

  return {
    counts: {
      projects: projectCount?.n ?? 0,
      openTasks: byStatus.todo + byStatus.in_progress,
      overdue: overdue?.n ?? 0,
      members: memberCount?.n ?? 0,
    },
    byStatus,
    projects: progress,
    upcoming: upcoming.map((t) => ({
      id: t.id,
      title: t.title,
      dueDate: t.dueDate,
      status: t.status,
      assignee: t.assigneeId ? { id: t.assigneeId, name: t.assigneeName! } : null,
      project: { id: t.projectId, name: t.projectName },
    })),
  }
}
