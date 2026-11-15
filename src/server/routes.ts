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
// エンドポイントを足すときは、ここに 1 行足すだけでよい
export const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/dashboard',
    handle: ({ db, query }) => getDashboard(db, parse(dashboardQuery, query).today ?? today()),
  },

  { method: 'GET', path: '/projects', handle: ({ db, query }) => listProjects(db, query) },
  { method: 'POST', path: '/projects', handle: async ({ db, body }) => createProject(db, await body()) },
  { method: 'GET', path: '/projects/:id', handle: ({ db, id }) => getProject(db, id()) },
  { method: 'PATCH', path: '/projects/:id', handle: async ({ db, id, body }) => updateProject(db, id(), await body()) },
  { method: 'DELETE', path: '/projects/:id', handle: ({ db, id }) => deleteProject(db, id()) },
  {
    method: 'PUT',
    path: '/projects/:id/members',
    handle: async ({ db, id, body }) => setProjectMembers(db, id(), await body()),
  },

  { method: 'GET', path: '/projects/:id/tasks', handle: ({ db, id, query }) => listTasks(db, id(), query) },
  { method: 'POST', path: '/projects/:id/tasks', handle: async ({ db, id, body }) => createTask(db, id(), await body()) },
  { method: 'GET', path: '/tasks/:id', handle: ({ db, id }) => getTask(db, id()) },
  { method: 'PATCH', path: '/tasks/:id', handle: async ({ db, id, body }) => updateTask(db, id(), await body()) },
  { method: 'DELETE', path: '/tasks/:id', handle: ({ db, id }) => deleteTask(db, id()) },

  { method: 'POST', path: '/tasks/:id/comments', handle: async ({ db, id, body }) => addComment(db, id(), await body()) },
  { method: 'DELETE', path: '/comments/:id', handle: ({ db, id }) => deleteComment(db, id()) },

  { method: 'GET', path: '/members', handle: ({ db }) => listMembers(db) },
  { method: 'POST', path: '/members', handle: async ({ db, body }) => createMember(db, await body()) },
  { method: 'PATCH', path: '/members/:id', handle: async ({ db, id, body }) => updateMember(db, id(), await body()) },
  { method: 'DELETE', path: '/members/:id', handle: ({ db, id }) => deleteMember(db, id()) },

  { method: 'GET', path: '/tags', handle: ({ db }) => listTags(db) },
  { method: 'POST', path: '/tags', handle: async ({ db, body }) => createTag(db, await body()) },
  { method: 'DELETE', path: '/tags/:id', handle: ({ db, id }) => deleteTag(db, id()) },
]
