import { createBrowserRouter, data } from 'react-router'
import * as dashboard from './routes/dashboard'
import * as members from './routes/members'
import * as project from './routes/project'
import * as projectMembers from './routes/project-members'
import * as projectSettings from './routes/project-settings'
import * as projectTasks from './routes/project-tasks'
import * as projects from './routes/projects'
import * as root from './routes/root'
import * as settings from './routes/settings'
import * as task from './routes/task'

// ルートごとに loader（読む）・action（書く）・Component をまとめたモジュールを並べる。
// action が成功すると、表示中のルートの loader を React Router が自動で読み直す。
export function createRouter() {
  return createBrowserRouter(
    [
      {
        id: 'root',
        path: '/',
        loader: root.loader,
        Component: root.Component,
        HydrateFallback: root.HydrateFallback,
        children: [
          {
            // エラーはここで受け止めて、サイドバーを残したまま中身だけ差し替える
            ErrorBoundary: root.RouteError,
            children: [
              { index: true, loader: dashboard.loader, Component: dashboard.Component },
              { path: 'projects', ...projects, handle: projects.handle },
              {
                id: 'project',
                path: 'projects/:projectId',
                loader: project.loader,
                Component: project.Component,
                handle: project.handle,
                children: [
                  { index: true, loader: project.indexLoader },
                  { path: 'tasks', ...projectTasks },
                  { path: 'members', ...projectMembers },
                  { path: 'settings', ...projectSettings },
                ],
              },
              { path: 'tasks/:taskId', ...task },
              { path: 'members', ...members },
              { path: 'settings', ...settings },
              {
                path: '*',
                loader: () => {
                  throw data('お探しのページは存在しません', { status: 404 })
                },
              },
            ],
          },
        ],
      },
    ],
    { basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' },
  )
}
