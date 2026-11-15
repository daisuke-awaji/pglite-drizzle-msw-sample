import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { Priority, TaskStatus } from '../shared/enums'

// 書きかけのフォーム。リロードしても消えないが、タブを閉じたら消えてよいので sessionStorage に置く
export type TaskDraft = {
  title: string
  description: string
  status: TaskStatus
  priority: Priority
  assigneeId: string | null
  dueDate: string | null
  tagIds: string[]
}

export const emptyTaskDraft: TaskDraft = {
  title: '',
  description: '',
  status: 'todo',
  priority: 'medium',
  assigneeId: null,
  dueDate: null,
  tagIds: [],
}

type Drafts = {
  tasks: Record<string, TaskDraft>
  updateTask: (projectId: number, patch: Partial<TaskDraft>) => void
  clearTask: (projectId: number) => void
}

export const useDrafts = create<Drafts>()(
  persist(
    (set) => ({
      tasks: {},
      updateTask: (projectId, patch) =>
        set((s) => ({
          tasks: { ...s.tasks, [projectId]: { ...(s.tasks[projectId] ?? emptyTaskDraft), ...patch } },
        })),
      clearTask: (projectId) =>
        set((s) => {
          const { [projectId]: _removed, ...rest } = s.tasks
          return { tasks: rest }
        }),
    }),
    {
      name: 'starter-kit:drafts',
      storage: createJSONStorage(() => sessionStorage),
      partialize: ({ tasks }) => ({ tasks }),
    },
  ),
)

export const useTaskDraft = (projectId: number) =>
  useDrafts((s) => s.tasks[projectId] ?? emptyTaskDraft)

export const hasDraft = (draft: TaskDraft) =>
  draft.title !== '' || draft.description !== '' || draft.tagIds.length > 0
