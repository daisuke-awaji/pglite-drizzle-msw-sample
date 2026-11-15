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

// PostgreSQL の文字列は NUL（\u0000）を保存できない。そのまま渡すと 500 になるので、入力の段階で断る
const hasNul = (s: string) => s.includes('\u0000')
const NUL_MESSAGE = '使えない文字（NUL）が含まれています'

const text = (label: string, max: number) =>
  z
    .string({ error: `${label}を入力してください` })
    .trim()
    .max(max, `${label}は ${max} 文字以内で入力してください`)
    .refine((s) => !hasNul(s), NUL_MESSAGE)

const required = (label: string, max: number) => text(label, max).min(1, `${label}を入力してください`)

/** PostgreSQL の integer（int4）の上限。これを超える ID は DB に渡すと 500 になるので、検証で弾く */
export const INT4_MAX = 2_147_483_647

// ID は数値か、数字だけの文字列（FormData・URL から来る）だけを受け付ける。
// z.coerce.number() は true → 1、[2] → 2、' 1e0 ' → 1 も通してしまうので使わない
export const id = z.preprocess(
  (v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v),
  z.number({ error: 'ID が正しくありません' }).int().positive().max(INT4_MAX),
)

const nullableId = z.preprocess(
  (v) => (v === '' || v === 'none' || v === undefined ? null : v),
  id.nullable(),
)

// FormData で「空の配列」を送るには、空文字を 1 つだけ送る（fd.append('tagIds', '')）
const idList = z.preprocess(
  (v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).filter((x) => x !== '')),
  z.array(id),
)

// z.iso.date() は 0000 年なども通すが、PostgreSQL の date は 0 年を受け付けない（500 になる）。
// 業務アプリで意味のある範囲に絞る
const date = z.iso
  .date('日付は YYYY-MM-DD の形式で入力してください')
  .refine((d) => Number(d.slice(0, 4)) >= 1900, '日付は 1900 年以降で入力してください')

const nullableDate = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  date.nullable(),
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
    .refine((s) => !hasNul(s), NUL_MESSAGE)
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

export const commentBody = z.object({ body: required('コメント', 1000) })

/** 投稿者を選んで書く（プロトタイプ）。ログインしているときは本文だけ（投稿者はログイン中の利用者） */
export const commentInput = commentBody.extend({ authorId: id })

export const tagInput = z.object({ name: required('タグ名', 30) })

// URL のクエリは利用者が手で書き換えられるので、おかしな値はエラーにせず既定値に戻す。
// 検索語だけは、長すぎても捨てずに先頭 100 文字で探す（捨てると全件が出て「絞り込めていない」ように見える）
export const SEARCH_MAX = 100
const searchText = z
  .string()
  .transform((s) => s.replaceAll('\u0000', '').trim().slice(0, SEARCH_MAX) || undefined)
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

// ダッシュボードの「今日」。画面の端末の日付を送ってもらう（期限切れの判定を利用者の暦に合わせるため）。
// おかしな値は捨てて、サーバーの今日を使う
export const dashboardQuery = z.object({ today: date.optional().catch(undefined) })

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
