// DB の enum・Zod のスキーマ・画面の選択肢が、すべてここを参照する
export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const
export const PRIORITIES = ['low', 'medium', 'high'] as const
export const PROJECT_STATUSES = ['active', 'archived'] as const
export const PROJECT_COLORS = ['gray', 'blue', 'green', 'amber', 'red', 'violet'] as const
export const TASK_SORTS = ['updated', 'due', 'priority', 'title'] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]
export type Priority = (typeof PRIORITIES)[number]
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]
export type ProjectColor = (typeof PROJECT_COLORS)[number]
export type TaskSort = (typeof TASK_SORTS)[number]

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '未着手',
  in_progress: '進行中',
  done: '完了',
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  low: '低',
  medium: '中',
  high: '高',
}

export const COLOR_LABEL: Record<ProjectColor, string> = {
  gray: 'グレー',
  blue: 'ブルー',
  green: 'グリーン',
  amber: 'アンバー',
  red: 'レッド',
  violet: 'バイオレット',
}

export const COLOR_ITEMS = PROJECT_COLORS.map((value) => ({ value, label: COLOR_LABEL[value] }))

export const SORT_LABEL: Record<TaskSort, string> = {
  updated: '更新が新しい順',
  due: '期限が近い順',
  priority: '優先度が高い順',
  title: 'タイトル順',
}
