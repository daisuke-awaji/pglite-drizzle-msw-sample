import { dashboardQuery } from '../shared/schemas'
import { today } from '../shared/dates'
import { parse } from './core'
import { getDashboard } from './dashboard'
import type { Route } from './http'
import { createMember, deleteMember, listMembers, updateMember } from './members'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  setProjectMembers,
  updateProject,
} from './projects'
import { createTag, deleteTag, listTags } from './tags'
import { addComment, createTask, deleteComment, deleteTask, getTask, listTasks, updateTask } from './tasks'

// API の一覧。MSW（src/mocks/handlers.ts）も本番のサーバー（README の Hono の例）も、この表を読んで登録する。
// エンドポイントを足すときは、ここに 1 行足すだけでよい。読み書きの制限（access）は各サーバー関数が受け持つ（src/server/access.ts）
export const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/dashboard',
    handle: ({ db, query, access }) => getDashboard(db, parse(dashboardQuery, query).today ?? today(), access),
  },

  { method: 'GET', path: '/projects', handle: ({ db, query, access }) => listProjects(db, query, access) },
  { method: 'POST', path: '/projects', handle: async ({ db, body, access }) => createProject(db, await body(), access) },
  { method: 'GET', path: '/projects/:id', handle: ({ db, id, access }) => getProject(db, id(), access) },
  { method: 'PATCH', path: '/projects/:id', handle: async ({ db, id, body, access }) => updateProject(db, id(), await body(), access) },
  { method: 'DELETE', path: '/projects/:id', handle: ({ db, id, access }) => deleteProject(db, id(), access) },
  {
    method: 'PUT',
    path: '/projects/:id/members',
    handle: async ({ db, id, body, access }) => setProjectMembers(db, id(), await body(), access),
  },

  { method: 'GET', path: '/projects/:id/tasks', handle: ({ db, id, query, access }) => listTasks(db, id(), query, access) },
  { method: 'POST', path: '/projects/:id/tasks', handle: async ({ db, id, body, access }) => createTask(db, id(), await body(), access) },
  { method: 'GET', path: '/tasks/:id', handle: ({ db, id, access }) => getTask(db, id(), access) },
  { method: 'PATCH', path: '/tasks/:id', handle: async ({ db, id, body, access }) => updateTask(db, id(), await body(), access) },
  { method: 'DELETE', path: '/tasks/:id', handle: ({ db, id, access }) => deleteTask(db, id(), access) },

  { method: 'POST', path: '/tasks/:id/comments', handle: async ({ db, id, body, access }) => addComment(db, id(), await body(), access) },
  { method: 'DELETE', path: '/comments/:id', handle: ({ db, id, access }) => deleteComment(db, id(), access) },

  { method: 'GET', path: '/members', handle: ({ db }) => listMembers(db) },
  { method: 'POST', path: '/members', handle: async ({ db, body, access }) => createMember(db, await body(), access) },
  { method: 'PATCH', path: '/members/:id', handle: async ({ db, id, body, access }) => updateMember(db, id(), await body(), access) },
  { method: 'DELETE', path: '/members/:id', handle: ({ db, id, access }) => deleteMember(db, id(), access) },

  { method: 'GET', path: '/tags', handle: ({ db }) => listTags(db) },
  { method: 'POST', path: '/tags', handle: async ({ db, body }) => createTag(db, await body()) },
  { method: 'DELETE', path: '/tags/:id', handle: ({ db, id, access }) => deleteTag(db, id(), access) },
]
