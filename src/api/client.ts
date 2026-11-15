import { API_BASE } from '../shared/api-path'
import type { ApiError, Todo } from '../shared/types'

// UI が使うのはこの fetch だけ。相手が MSW でも本番の API でもコードは変わらない。
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null
    throw new Error(body?.error ?? `HTTP ${res.status}`)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

export const api = {
  listTodos: () => request<Todo[]>('/todos'),
  createTodo: (title: string) =>
    request<Todo>('/todos', { method: 'POST', body: JSON.stringify({ title }) }),
  updateTodo: (id: number, patch: Partial<Pick<Todo, 'title' | 'done'>>) =>
    request<Todo>(`/todos/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteTodo: (id: number) => request<void>(`/todos/${id}`, { method: 'DELETE' }),
  reset: () => request<void>('/_reset', { method: 'POST' }),
  debug: () => request<{ version: string; migrations: unknown[] }>('/_debug'),
}
