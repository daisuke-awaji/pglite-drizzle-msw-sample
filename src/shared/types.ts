import type { Priority, ProjectColor, ProjectStatus, TaskStatus } from './enums'
import type { FieldErrors } from './schemas'

// API がやり取りする形（DTO）。日時は ISO 文字列、日付は YYYY-MM-DD。
// DB の行の型をそのまま画面に出さず、ここで「画面が必要とする形」を決めておく。

export type MemberRef = { id: number; name: string }

export type Member = MemberRef & {
  email: string
  title: string
  createdAt: string
}

export type MemberListItem = Member & {
  projectCount: number
  openTaskCount: number
}

export type Tag = { id: number; name: string }

export type TagListItem = Tag & { taskCount: number }

export type ProjectListItem = {
  id: number
  name: string
  description: string
  color: ProjectColor
  status: ProjectStatus
  updatedAt: string
  taskCount: number
  doneCount: number
  members: MemberRef[]
}

export type ProjectDetail = ProjectListItem & {
  createdAt: string
  members: Member[]
}

export type TaskListItem = {
  id: number
  projectId: number
  title: string
  status: TaskStatus
  priority: Priority
  dueDate: string | null
  updatedAt: string
  assignee: MemberRef | null
  tags: Tag[]
  commentCount: number
}

export type Page<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
  pageCount: number
}

export type Comment = {
  id: number
  body: string
  createdAt: string
  author: MemberRef | null
}

export type TaskDetail = Omit<TaskListItem, 'commentCount'> & {
  description: string
  createdAt: string
  project: { id: number; name: string; color: ProjectColor; members: MemberRef[] }
  comments: Comment[]
}

export type Dashboard = {
  counts: { projects: number; openTasks: number; overdue: number; members: number }
  byStatus: Record<TaskStatus, number>
  projects: Pick<ProjectListItem, 'id' | 'name' | 'color' | 'taskCount' | 'doneCount'>[]
  upcoming: (Pick<TaskListItem, 'id' | 'title' | 'dueDate' | 'status' | 'assignee'> & {
    project: { id: number; name: string }
  })[]
}

export type DbInfo = {
  version: string
  migrations: { id: number; hash: string; created_at: string }[]
  rows: Record<string, number>
}

export type ApiErrorBody = {
  error: string
  fieldErrors?: FieldErrors
}
