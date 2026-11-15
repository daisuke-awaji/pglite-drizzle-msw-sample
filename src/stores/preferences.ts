import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

// 端末ごとの好み。サーバーに送る必要がないので localStorage に置く（タブを閉じても残る）
export type Theme = 'system' | 'light' | 'dark'
export type TaskView = 'table' | 'board'
export type Latency = 0 | 300 | 1000

type Preferences = {
  theme: Theme
  sidebarCollapsed: boolean
  taskView: TaskView
  latency: Latency
  setTheme: (theme: Theme) => void
  toggleSidebar: () => void
  setTaskView: (view: TaskView) => void
  setLatency: (latency: Latency) => void
}

export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      theme: 'system',
      sidebarCollapsed: false,
      taskView: 'table',
      latency: 0,
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setTaskView: (taskView) => set({ taskView }),
      setLatency: (latency) => set({ latency }),
    }),
    {
      name: 'starter-kit:preferences',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: ({ theme, sidebarCollapsed, taskView, latency }) => ({ theme, sidebarCollapsed, taskView, latency }),
    },
  ),
)
