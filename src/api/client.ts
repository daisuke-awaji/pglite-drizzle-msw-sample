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
export class ApiError extends Error {
  readonly status: number
  readonly fieldErrors?: FieldErrors
  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.error ?? `HTTP ${status}`)
    this.status = status
    this.fieldErrors = body?.fieldErrors
  }
}

type Search = Record<string, string | number | undefined | null>

async function request<T>(path: string, init?: Omit<RequestInit, 'signal'> & { search?: Search; signal?: AbortSignal }) {
  const url = new URL(`${API_BASE}${path}`, location.origin)
  for (const [k, v] of Object.entries(init?.search ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null)) as ApiErrorBody | null)
  return (res.status === 204 ? undefined : await res.json()) as T
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

  dbInfo: (signal?: AbortSignal) => request<DbInfo>('/_debug', { signal }),
  reset: () => request<void>('/_reset', { method: 'POST' }),
}
