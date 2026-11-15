import { API_BASE } from '../shared/api-path'
import type { FieldErrors, ProjectInput, ProjectPatch, TaskPatch } from '../shared/schemas'
import type {
  ApiErrorBody,
  Comment,
  Dashboard,
  DbInfo,
  Member,
  MemberListItem,
  Page,
  ProjectDetail,
  ProjectListItem,
  Tag,
  TagListItem,
  TaskDetail,
  TaskListItem,
} from '../shared/types'

// 画面が使うのはこの fetch だけ。相手が MSW でも本番の API でもコードは変わらない。

/**
 * - `http`: サーバーが応答した（4xx / 5xx）。`status` と、あれば項目ごとのエラーを持つ
 * - `network`: サーバーに届かなかった（オフライン、DNS、CORS など）。`status` は 0
 * - `parse`: 応答は来たが JSON として読めなかった
 */
export type ApiErrorKind = 'http' | 'network' | 'parse'

export class ApiError extends Error {
  override readonly name = 'ApiError'
  readonly kind: ApiErrorKind
  readonly status: number
  readonly fieldErrors?: FieldErrors
  /** 時間をおいて同じ操作をやり直せば成功しうるか（通信断・混雑・一時的な障害） */
  readonly retryable: boolean
  constructor(kind: ApiErrorKind, status: number, message: string, fieldErrors?: FieldErrors) {
    super(message)
    this.kind = kind
    this.status = status
    this.fieldErrors = fieldErrors
    this.retryable = kind === 'network' || RETRYABLE_STATUS.has(status)
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

// サーバーが本文を返さなかったときの文言。利用者が次に何をすればよいかが分かるように書く
export function messageForStatus(status: number): string {
  if (status === 400) return '入力内容を確認してください'
  if (status === 401) return 'ログインが必要です'
  if (status === 403) return 'この操作を行う権限がありません'
  if (status === 404) return '見つかりませんでした。削除された可能性があります'
  if (status === 409) return 'ほかの変更と競合しました。画面を読み込み直してください'
  if (status === 413) return 'データが大きすぎます'
  if (status === 429) return 'リクエストが多すぎます。しばらく待ってからやり直してください'
  if (status >= 500) return 'サーバーで問題が起きました。しばらく待ってからやり直してください'
  return `通信に失敗しました（HTTP ${status}）`
}

export const NETWORK_ERROR_MESSAGE = 'サーバーに接続できません。通信環境を確認してからやり直してください'

export const isAbortError = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

type Search = Record<string, string | number | undefined | null>
type RequestOptions = Omit<RequestInit, 'signal'> & { search?: Search; signal?: AbortSignal }

async function request<T>(path: string, init?: RequestOptions): Promise<T> {
  const url = new URL(`${API_BASE}${path}`, location.origin)
  for (const [k, v] of Object.entries(init?.search ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      headers: { accept: 'application/json', 'content-type': 'application/json', ...init?.headers },
    })
  } catch (e) {
    // 呼び出し側の中断（画面遷移など）はエラーとして扱わず、そのまま投げ直す
    if (isAbortError(e) || init?.signal?.aborted) throw e
    throw new ApiError('network', 0, NETWORK_ERROR_MESSAGE)
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null
    throw new ApiError('http', res.status, body?.error || messageForStatus(res.status), body?.fieldErrors)
  }
  if (res.status === 204) return undefined as T
  try {
    return (await res.json()) as T
  } catch (e) {
    if (isAbortError(e)) throw e
    throw new ApiError('parse', res.status, 'サーバーの応答を読み取れませんでした')
  }
}

const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) })

export const api = {
  dashboard: (today: string, signal?: AbortSignal) => request<Dashboard>('/dashboard', { search: { today }, signal }),

  listProjects: (search: Search = {}, signal?: AbortSignal) =>
    request<ProjectListItem[]>('/projects', { search, signal }),
  getProject: (id: number, signal?: AbortSignal) => request<ProjectDetail>(`/projects/${id}`, { signal }),
  createProject: (input: Partial<ProjectInput>) => request<ProjectDetail>('/projects', json('POST', input)),
  updateProject: (id: number, patch: ProjectPatch) => request<ProjectDetail>(`/projects/${id}`, json('PATCH', patch)),
  deleteProject: (id: number) => request<void>(`/projects/${id}`, { method: 'DELETE' }),
  setProjectMembers: (id: number, memberIds: number[]) =>
    request<{ project: ProjectDetail; unassignedTaskCount: number }>(
      `/projects/${id}/members`,
      json('PUT', { memberIds }),
    ),

  listTasks: (projectId: number, search: Search, signal?: AbortSignal) =>
    request<Page<TaskListItem>>(`/projects/${projectId}/tasks`, { search, signal }),
  createTask: (projectId: number, input: unknown) =>
    request<TaskDetail>(`/projects/${projectId}/tasks`, json('POST', input)),
  getTask: (id: number, signal?: AbortSignal) => request<TaskDetail>(`/tasks/${id}`, { signal }),
  updateTask: (id: number, patch: TaskPatch) => request<TaskDetail>(`/tasks/${id}`, json('PATCH', patch)),
  deleteTask: (id: number) => request<void>(`/tasks/${id}`, { method: 'DELETE' }),
  addComment: (taskId: number, input: unknown) => request<Comment>(`/tasks/${taskId}/comments`, json('POST', input)),
  deleteComment: (id: number) => request<void>(`/comments/${id}`, { method: 'DELETE' }),

  listMembers: (signal?: AbortSignal) => request<MemberListItem[]>('/members', { signal }),
  createMember: (input: unknown) => request<Member>('/members', json('POST', input)),
  updateMember: (id: number, input: unknown) => request<Member>(`/members/${id}`, json('PATCH', input)),
  deleteMember: (id: number) => request<void>(`/members/${id}`, { method: 'DELETE' }),

  listTags: (signal?: AbortSignal) => request<TagListItem[]>('/tags', { signal }),
  createTag: (input: unknown) => request<Tag>('/tags', json('POST', input)),
  deleteTag: (id: number) => request<void>(`/tags/${id}`, { method: 'DELETE' }),
}

/**
 * モック API にだけある開発用のエンドポイント（src/mocks/handlers.ts の devRoutes）。
 * 本番の API にはないので、呼ぶ側は USES_MOCK_API で囲むこと（囲めば VITE_USE_MOCK=false のビルドから消える）
 */
export const devApi = {
  dbInfo: (signal?: AbortSignal) => request<DbInfo>('/_debug', { signal }),
  reset: () => request<void>('/_reset', { method: 'POST' }),
}
