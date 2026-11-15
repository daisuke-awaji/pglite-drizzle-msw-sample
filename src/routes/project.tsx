import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs'
import { NavLink, Outlet, redirect, useLoaderData, useLocation, type Params } from 'react-router'
import { api } from '../api/client'
import { ColorDot } from '../components/display'
import type { ProjectDetail } from '../shared/types'
import { idParam, load } from './lib'

export const handle = {
  crumb: (data: unknown) => {
    const project = data as ProjectDetail | undefined
    return project && [{ label: 'プロジェクト', to: '/projects' }, { label: project.name, to: `/projects/${project.id}` }]
  },
}

// 子ルート（タスク・メンバー・設定）は useRouteLoaderData('project') でこのデータを共有する
export async function loader({ params, request }: { params: Params; request: Request }) {
  return load(api.getProject(idParam(params, 'projectId'), request.signal))
}

export function indexLoader({ params }: { params: Params }) {
  return redirect(`/projects/${idParam(params, 'projectId')}/tasks`)
}

const TABS = [
  { value: 'tasks', label: 'タスク' },
  { value: 'members', label: 'メンバー' },
  { value: 'settings', label: '設定' },
]

export function Component() {
  const project = useLoaderData<typeof loader>()
  const { pathname } = useLocation()
  const current = TABS.find((t) => pathname.endsWith(`/${t.value}`))?.value ?? 'tasks'

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="with-dot">
            <ColorDot color={project.color} />
            {project.name}
            {project.status === 'archived' && <span className="badge">アーカイブ</span>}
          </h1>
          {project.description && <p className="muted">{project.description}</p>}
        </div>
      </header>
      {/* タブはルートへのリンク。選択中のタブは URL から決まるので、onValueChange は要らない */}
      <Tabs value={current}>
        <TabsList aria-label="プロジェクトの表示" className="tabs-list">
          {TABS.map((t) => (
            <TabsTab key={t.value} value={t.value} render={<NavLink to={`/projects/${project.id}/${t.value}`} />}>
              {t.label}
            </TabsTab>
          ))}
          <TabsIndicator />
        </TabsList>
        {TABS.map((t) => (
          <TabsPanel key={t.value} value={t.value} className="tab-panel">
            {t.value === current && <Outlet />}
          </TabsPanel>
        ))}
      </Tabs>
    </div>
  )
}
