import { asc, eq } from 'drizzle-orm'
import { tags, taskTags } from '../db/schema'
import { tagInput } from '../shared/schemas'
import type { Tag, TagListItem } from '../shared/types'
import { ALL, type Access, requireAdmin } from './access'
import { type Db, HttpError, isUniqueViolation, notFound, parse } from './core'

export async function listTags(db: Db): Promise<TagListItem[]> {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      taskCount: db.$count(taskTags, eq(taskTags.tagId, tags.id)),
    })
    .from(tags)
    .orderBy(asc(tags.name))
}

export async function createTag(db: Db, body: unknown): Promise<Tag> {
  const input = parse(tagInput, body)
  try {
    const [row] = await db.insert(tags).values(input).returning()
    return row!
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new HttpError(409, 'このタグは既にあります', { name: ['このタグは既にあります'] })
    }
    throw e
  }
}

// タスクとの紐付け（task_tags）は CASCADE で消える。タスク自体は残る。
// タグはプロジェクトをまたいで使うので、消すのは管理者だけ（作るのは誰でもよい）
export async function deleteTag(db: Db, id: number, access: Access = ALL): Promise<void> {
  requireAdmin(access)
  const deleted = await db.delete(tags).where(eq(tags.id, id)).returning({ id: tags.id })
  if (deleted.length === 0) throw notFound('タグ', id)
}
