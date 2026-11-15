import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

// 端末ごとの好み。サーバーに送る必要がないので localStorage に置く（タブを閉じても残る）
export type Theme = 'system' | 'light' | 'dark'
export type TaskView = 'table' | 'board'
export type Latency = 0 | 300 | 1000
/** モック API の障害シミュレーション。エラー表示や再試行を、本物の障害を待たずに確かめるため */
export type Fault = 'none' | 'error-writes' | 'error-all' | 'offline'

type Preferences = {
  theme: Theme
  sidebarCollapsed: boolean
  taskView: TaskView
  latency: Latency
  fault: Fault
  setTheme: (theme: Theme) => void
  toggleSidebar: () => void
  setTaskView: (view: TaskView) => void
  setLatency: (latency: Latency) => void
  setFault: (fault: Fault) => void
}

export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      theme: 'system',
      sidebarCollapsed: false,
      taskView: 'table',
      latency: 0,
      fault: 'none',
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setTaskView: (taskView) => set({ taskView }),
      setLatency: (latency) => set({ latency }),
      setFault: (fault) => set({ fault }),
    }),
    {
      name: 'starter-kit:preferences',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // 障害シミュレーション（fault）は保存しない。リロードすれば必ず正常に戻れるようにするため
      partialize: ({ theme, sidebarCollapsed, taskView, latency }) => ({ theme, sidebarCollapsed, taskView, latency }),
    },
  ),
)
