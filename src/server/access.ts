import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { members, projectMembers, projects, tasks } from '../db/schema'
import { type Db, HttpError, notFound } from './core'

// 「誰が呼んだか」と、その人ができること（Phase 4。docs/production.md「認証」）。
// - all: 制限なし。プロトタイプ（MSW + ブラウザの PGlite）・テスト・認証なしの dev で使う
// - user: ログインした人。読み書きできるのは、自分がメンバーのプロジェクト（とそのタスク・コメント）だけ。
//   メンバーの登録・変更・削除と、タグの削除は管理者（Cognito の admin グループ）だけ
// 見えないプロジェクト・タスクは「ない」（404）として返す（あることを知らせない）
export type Access = { kind: 'all' } | { kind: 'user'; memberId: number | null; admin: boolean; email: string }

export const ALL: Access = { kind: 'all' }

/** 認証で分かったこと（server/auth.ts が ID トークンから作る） */
export type Principal = { email: string; admin: boolean }

export const forbidden = (message = 'この操作を行う権限がありません') => new HttpError(403, message)

/**
 * ログインした人を、メールアドレスでメンバーにつなぐ。
 * メンバーとして登録されていない人は使えない（管理者だけは、自分を登録するために入れる）
 */
export async function resolveAccess(db: Db, principal: Principal): Promise<Access> {
  const email = principal.email.trim().toLowerCase()
  const [member] = await db.select({ id: members.id }).from(members).where(sql`lower(${members.email}) = ${email}`)
  if (!member && !principal.admin) throw forbidden('メンバーとして登録されていません。管理者に連絡してください')
  return { kind: 'user', memberId: member?.id ?? null, admin: principal.admin, email }
}

export function requireAdmin(access: Access): void {
  if (access.kind === 'user' && !access.admin) throw forbidden()
}

/** 自分のメンバーの ID（プロジェクトを作る・コメントを書くとき）。管理者でもメンバーとして登録されていなければできない */
export function requireMember(access: Access): number | undefined {
  if (access.kind === 'all') return undefined
  if (access.memberId === null) throw forbidden('メンバーとして登録してから操作してください')
  return access.memberId
}

/** 一覧の絞り込み: 自分がメンバーのプロジェクトだけ（all なら絞らない） */
export function visibleProjects(db: Db, access: Access): SQL | undefined {
  if (access.kind === 'all') return undefined
  if (access.memberId === null) return sql`false`
  return inArray(projects.id, db.select({ id: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.memberId, access.memberId)))
}

type Queryable = Pick<Db, 'select'>

export async function canSeeProject(db: Queryable, projectId: number, access: Access): Promise<boolean> {
  if (access.kind === 'all') return true
  if (access.memberId === null) return false
  const [row] = await db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.memberId, access.memberId)))
  return Boolean(row)
}

/** そのプロジェクトのメンバーでなければ 404（あるかどうかも見せない） */
export async function assertProjectAccess(db: Queryable, projectId: number, access: Access): Promise<void> {
  if (!(await canSeeProject(db, projectId, access))) throw notFound('プロジェクト', projectId)
}

/** タスクのプロジェクトのメンバーでなければ、タスクを 404 にする。ないタスクも 404 */
export async function assertTaskAccess(db: Queryable, taskId: number, access: Access): Promise<number> {
  const [task] = await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))
  if (!task || !(await canSeeProject(db, task.projectId, access))) throw notFound('タスク', taskId)
  return task.projectId
}
