import { and, asc, eq, ne } from 'drizzle-orm'
import { members, projectMembers, tasks } from '../db/schema'
import { memberInput, memberPatch } from '../shared/schemas'
import type { Member, MemberListItem } from '../shared/types'
import { type Db, HttpError, isUniqueViolation, iso, notFound, parse } from './core'

const toMember = (row: typeof members.$inferSelect): Member => ({
  ...row,
  createdAt: iso(row.createdAt),
})

export async function listMembers(db: Db): Promise<MemberListItem[]> {
  const rows = await db
    .select({
      member: members,
      // 相関サブクエリは db.$count で書く（列が必ず "表"."列" で出力される。下の注意を参照）
      projectCount: db.$count(projectMembers, eq(projectMembers.memberId, members.id)),
      openTaskCount: db.$count(tasks, and(eq(tasks.assigneeId, members.id), ne(tasks.status, 'done'))),
    })
    .from(members)
    .orderBy(asc(members.name))
  return rows.map((r) => ({ ...toMember(r.member), projectCount: r.projectCount, openTaskCount: r.openTaskCount }))
}

export async function createMember(db: Db, body: unknown): Promise<Member> {
  const input = parse(memberInput, body)
  try {
    const [row] = await db.insert(members).values(input).returning()
    return toMember(row!)
  } catch (e) {
    if (isUniqueViolation(e)) throw emailTaken()
    throw e
  }
}

export async function updateMember(db: Db, id: number, body: unknown): Promise<Member> {
  const input = parse(memberPatch, body)
  if (Object.keys(input).length === 0) throw new HttpError(400, '更新する項目がありません')
  try {
    const [row] = await db.update(members).set(input).where(eq(members.id, id)).returning()
    if (!row) throw notFound('メンバー', id)
    return toMember(row)
  } catch (e) {
    if (isUniqueViolation(e)) throw emailTaken()
    throw e
  }
}

// 担当タスクは assignee_id が SET NULL で未割り当てに、所属は CASCADE で消え、コメントは残る
export async function deleteMember(db: Db, id: number): Promise<void> {
  const deleted = await db.delete(members).where(eq(members.id, id)).returning({ id: members.id })
  if (deleted.length === 0) throw notFound('メンバー', id)
}

const emailTaken = () =>
  new HttpError(409, 'このメールアドレスは既に使われています', {
    email: ['このメールアドレスは既に使われています'],
  })
