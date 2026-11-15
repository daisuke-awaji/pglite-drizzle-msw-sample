import { act, render, screen, waitFor } from '@testing-library/react'
import { createAgent } from '@ui-sdk/react/agent'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Page, ProjectDetail, TaskListItem } from '../shared/types'

const api = vi.hoisted(() => ({
  listTasks: vi.fn(),
  listTags: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
}))
vi.mock('../api/client', () => ({ api, ApiError: class extends Error {} }))

const { action, loader, Component } = await import('./project-tasks')

const agent = createAgent()

const member = (id: number, name: string) => ({ id, name, email: `${id}@example.com`, title: '', createdAt: '' })
const project: ProjectDetail = {
  id: 1,
  name: 'Web サイト刷新',
  description: '',
  color: 'blue',
  status: 'active',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  taskCount: 1,
  doneCount: 0,
  members: [member(1, '相沢 愛子'), member(3, '千葉 千夏')],
}
const task: TaskListItem = {
  id: 10,
  projectId: 1,
  title: 'ヘッダーの実装',
  status: 'todo',
  priority: 'medium',
  dueDate: null,
  updatedAt: '2026-11-01T00:00:00Z',
  assignee: null,
  tags: [],
  commentCount: 0,
}
const page = (items: TaskListItem[]): Page<TaskListItem> => ({ items, total: items.length, page: 1, pageSize: 10, pageCount: 1 })

function renderTasks() {
  const router = createMemoryRouter(
    [{ id: 'project', path: '/projects/:projectId', loader: () => project, children: [{ path: 'tasks', loader, action, Component }] }],
    { initialEntries: ['/projects/1/tasks'] },
  )
  render(<RouterProvider router={router} />)
  return router
}

beforeEach(() => {
  sessionStorage.clear()
  api.listTasks.mockResolvedValue(page([task]))
  api.listTags.mockResolvedValue([{ id: 1, name: 'UI', taskCount: 0 }])
  api.createTask.mockResolvedValue({ ...task, id: 11 })
  api.updateTask.mockResolvedValue(task)
})

describe('タスク一覧（エージェントから）', () => {
  test('すべての操作に名前があり、絞り込みは URL に入る', async () => {
    const router = renderTasks()
    await screen.findByRole('button', { name: '新しいタスク' })
    const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== 'more')
    for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy()
    const labels = entries.map((e) => e.label)
    for (const label of ['タスクを検索', '状態で絞り込む', '担当で絞り込む', 'タグで絞り込む', '並び順', '表示形式', '新しいタスク', '「ヘッダーの実装」を完了にする', '「ヘッダーの実装」の操作']) {
      expect(labels, `${label} is missing`).toContain(label)
    }

    let result!: Awaited<ReturnType<typeof agent.act>>
    await act(async () => {
      result = await agent.act({ steps: [{ ref: '状態で絞り込む', action: 'setValue', args: ['進行中'] }] })
    })
    expect(result.ok, result.error?.message).toBe(true)
    await waitFor(() => expect(router.state.location.search).toBe('?status=in_progress'))
    expect(api.listTasks).toHaveBeenLastCalledWith(1, expect.objectContaining({ status: 'in_progress' }), expect.anything())
  })

  test('新しいタスクを作り、完了のチェックを付けられる', async () => {
    renderTasks()
    await screen.findByRole('button', { name: '新しいタスク' })
    let result = await agent.act({
      steps: [
        { ref: '新しいタスク', action: 'press' },
        { ref: 'タイトル', action: 'setValue', args: ['エージェントのタスク'] },
        { ref: '優先度', action: 'setValue', args: ['高'] },
        { ref: '担当者', action: 'setValue', args: ['千葉 千夏'] },
        { ref: 'タグ', action: 'setValue', args: [['UI']] },
        { ref: '新しいタスク', action: 'press', args: ['作成'] },
      ],
    })
    expect(result.ok, result.error?.message).toBe(true)
    await waitFor(() => expect(api.createTask).toHaveBeenCalled())
    expect(api.createTask).toHaveBeenCalledWith(1, {
      title: 'エージェントのタスク',
      description: '',
      status: 'todo',
      priority: 'high',
      assigneeId: 3,
      dueDate: null,
      tagIds: [1],
    })

    result = await agent.act({ steps: [{ ref: '「ヘッダーの実装」を完了にする', action: 'toggle' }] })
    expect(result.ok, result.error?.message).toBe(true)
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(10, { status: 'done' }))
  })
})
