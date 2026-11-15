import { z } from 'zod'
import {
  PRIORITIES,
  PROJECT_COLORS,
  PROJECT_STATUSES,
  TASK_SORTS,
  TASK_STATUSES,
} from './enums'

// 同じスキーマを 2 か所で使う。
// - サーバー層（src/server）: API に届いた JSON を検証する（クライアントは信用しない）
// - 画面（route の action）: 送信前に FormData を検証し、往復なしでエラーを出す
// FormData の値は文字列なので、数値・空文字・複数値を受け取れるよう前処理を入れている。

const text = (label: string, max: number) =>
  z
    .string({ error: `${label}を入力してください` })
    .trim()
    .max(max, `${label}は ${max} 文字以内で入力してください`)

const required = (label: string, max: number) => text(label, max).min(1, `${label}を入力してください`)

const id = z.coerce.number().int().positive()

const nullableId = z.preprocess(
  (v) => (v === '' || v === 'none' || v === undefined ? null : v),
  id.nullable(),
)

// FormData で「空の配列」を送るには、空文字を 1 つだけ送る（fd.append('tagIds', '')）
const idList = z.preprocess(
  (v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).filter((x) => x !== '')),
  z.array(id),
)

const nullableDate = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.iso.date('日付は YYYY-MM-DD の形式で入力してください').nullable(),
)

// 作成用（省略時は既定値）と更新用（送った項目だけ変える）を、同じ項目定義から作る。
// Zod 4 では .partial() しても .default() が効いてしまうので、既定値は作成用にだけ付ける
const projectFields = {
  name: required('プロジェクト名', 80),
  description: text('説明', 500),
  color: z.enum(PROJECT_COLORS),
}

export const projectInput = z.object({
  ...projectFields,
  description: projectFields.description.default(''),
  color: projectFields.color.default('gray'),
})

export const projectPatch = z
  .object({ ...projectFields, status: z.enum(PROJECT_STATUSES) })
  .partial()

export const projectMembersInput = z.object({ memberIds: idList })

const memberFields = {
  name: required('名前', 60),
  // 前後の空白と大文字小文字の違いで別人にならないよう、整えてから形式を確かめる
  email: z
    .string({ error: 'メールアドレスを入力してください' })
    .trim()
    .toLowerCase()
    .max(254, 'メールアドレスが長すぎます')
    .pipe(z.email('メールアドレスの形式が正しくありません')),
  title: text('役割', 60),
}

export const memberInput = z.object({ ...memberFields, title: memberFields.title.default('') })

export const memberPatch = z.object(memberFields).partial()

const taskFields = {
  title: required('タイトル', 200),
  description: text('説明', 2000),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(PRIORITIES),
  assigneeId: nullableId,
  dueDate: nullableDate,
  tagIds: idList,
}

export const taskInput = z.object({
  ...taskFields,
  description: taskFields.description.default(''),
  status: taskFields.status.default('todo'),
  priority: taskFields.priority.default('medium'),
  assigneeId: taskFields.assigneeId.default(null),
  dueDate: taskFields.dueDate.default(null),
  tagIds: taskFields.tagIds.default([]),
})

export const taskPatch = z.object(taskFields).partial()

export const commentInput = z.object({
  body: required('コメント', 1000),
  authorId: id,
})

export const tagInput = z.object({ name: required('タグ名', 30) })

// URL のクエリは利用者が手で書き換えられるので、おかしな値はエラーにせず既定値に戻す。
// 検索語だけは、長すぎても捨てずに先頭 100 文字で探す（捨てると全件が出て「絞り込めていない」ように見える）
export const SEARCH_MAX = 100
const searchText = z
  .string()
  .trim()
  .transform((s) => s.slice(0, SEARCH_MAX) || undefined)
  .optional()
  .catch(undefined)

export const projectListQuery = z.object({
  q: searchText,
  status: z.enum(PROJECT_STATUSES).optional().catch(undefined),
})

export const taskListQuery = z.object({
  q: searchText,
  status: z.enum(TASK_STATUSES).optional().catch(undefined),
  assignee: z.union([z.literal('none'), id]).optional().catch(undefined),
  tag: id.optional().catch(undefined),
  sort: z.enum(TASK_SORTS).default('updated').catch('updated'),
  page: z.coerce.number().int().min(1).default(1).catch(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10).catch(10),
})

export type ProjectInput = z.infer<typeof projectInput>
export type ProjectPatch = z.infer<typeof projectPatch>
export type MemberInput = z.infer<typeof memberInput>
export type MemberPatch = z.infer<typeof memberPatch>
export type TaskInput = z.infer<typeof taskInput>
export type TaskPatch = z.infer<typeof taskPatch>
export type CommentInput = z.infer<typeof commentInput>
export type TaskListQuery = z.infer<typeof taskListQuery>

export type FieldErrors = Record<string, string[] | undefined>

export function fieldErrorsOf(error: z.ZodError): FieldErrors {
  return z.flattenError(error).fieldErrors as FieldErrors
}

// FormData をプレーンなオブジェクトにする。arrayKeys に挙げたキーだけ複数値を配列で受け取る。
// 送られていないキーは入れない（更新では「送っていない項目は変えない」ため）
export function formToObject(form: FormData, arrayKeys: readonly string[] = []) {
  const out: Record<string, unknown> = {}
  for (const key of new Set(form.keys())) {
    const values = form.getAll(key).filter((v): v is string => typeof v === 'string')
    out[key] = arrayKeys.includes(key) ? values : values.at(-1)
  }
  return out
}
