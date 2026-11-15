import { OverlayHost } from '@ui-sdk/react/overlays'
import { Toast, ToastClose, ToastDescription, ToastRegion, ToastTitle } from '@ui-sdk/react/toast'
import { Toggle, ToggleIcon } from '@ui-sdk/react/toggle'
import {
  FolderKanbanIcon,
  LayoutDashboardIcon,
  PanelLeftIcon,
  SettingsIcon,
  UsersIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import {
  isRouteErrorResponse,
  Link,
  NavLink,
  Outlet,
  useLoaderData,
  useMatches,
  useNavigation,
  useRouteError,
} from 'react-router'
import { api } from '../api/client'
import { CommandPalette } from '../components/command-palette'
import { ConfirmDialog } from '../components/confirm'
import { ColorDot } from '../components/display'
import { ThemeMenu } from '../components/theme-menu'
import { usePreferences } from '../stores/preferences'
import { load } from './lib'

// ルートの loader はサイドバーとコマンドパレットに出すプロジェクト一覧を読む。
// どの画面で action が成功しても React Router が自動で読み直すので、手で同期しなくてよい
export async function loader({ request }: { request: Request }) {
  return { projects: await load(api.listProjects({ status: 'active' }, request.signal)) }
}

export type RootData = Awaited<ReturnType<typeof loader>>

// 各ルートの handle.crumb がパンくずの項目を返す。文字列ならそのルート自身、配列なら複数の項目
export type CrumbItem = { label: string; to?: string }
export type Crumb = { crumb?: (data: unknown) => string | CrumbItem[] | undefined }

const NAV: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: '/', label: 'ダッシュボード', icon: LayoutDashboardIcon, end: true },
  { to: '/projects', label: 'プロジェクト', icon: FolderKanbanIcon },
  { to: '/members', label: 'メンバー', icon: UsersIcon },
  { to: '/settings', label: '設定', icon: SettingsIcon },
]

function useThemeSync() {
  const theme = usePreferences((s) => s.theme)
  useEffect(() => {
    // web.css の色は light-dark() で書かれているので、color-scheme を切り替えるだけでテーマが変わる
    const root = document.documentElement
    if (theme === 'system') root.style.removeProperty('color-scheme')
    else root.style.colorScheme = theme
    root.dataset.theme = theme
  }, [theme])
}

function Breadcrumbs() {
  const crumbs = useMatches().flatMap((m) => {
    const c = (m.handle as Crumb | undefined)?.crumb?.(m.loaderData)
    if (!c) return []
    return typeof c === 'string' ? [{ key: m.id, label: c, to: m.pathname }] : c.map((x, i) => ({ key: `${m.id}-${i}`, ...x }))
  })
  return (
    <nav aria-label="パンくずリスト" className="breadcrumbs">
      <ol>
        {crumbs.map((c, i) => (
          <li key={c.key}>
            {i < crumbs.length - 1 && c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  )
}

function Shell({ children }: { children: ReactNode }) {
  useThemeSync()
  const collapsed = usePreferences((s) => s.sidebarCollapsed)
  const toggleSidebar = usePreferences((s) => s.toggleSidebar)
  const navigation = useNavigation()

  return (
    <div className="shell" data-collapsed={collapsed ? '' : undefined}>
      <div className="nav-progress" data-active={navigation.state !== 'idle' ? '' : undefined} aria-hidden="true" />
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="label">Starter Kit</span>
        </div>
        <nav aria-label="メイン">
          <ul className="nav-list">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <NavLink to={to} end={end} className="nav-link" title={collapsed ? label : undefined}>
                  <Icon aria-hidden="true" />
                  <span className="label">{label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <SidebarProjects />
        <div className="sidebar-footer">
          <Toggle
            aria-label="サイドバーを折りたたむ"
            data-variant="ghost"
            pressed={collapsed}
            onPressedChange={toggleSidebar}
          >
            <ToggleIcon>
              <PanelLeftIcon />
            </ToggleIcon>
          </Toggle>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <Breadcrumbs />
          <div className="row">
            <CommandPalette />
            <ThemeMenu />
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
      <ToastRegion data-agent-hidden side="bottom" align="end">
        {() => (
          <Toast>
            <div className="toast-body">
              <ToastTitle />
              <ToastDescription />
            </div>
            <ToastClose aria-label="通知を閉じる" data-variant="ghost">
              <XIcon aria-hidden="true" />
            </ToastClose>
          </Toast>
        )}
      </ToastRegion>
      <ConfirmDialog />
      <OverlayHost />
    </div>
  )
}

function SidebarProjects() {
  const { projects } = useLoaderData<RootData>()
  if (projects.length === 0) return null
  return (
    <nav aria-label="進行中のプロジェクト" className="sidebar-section">
      <p className="sidebar-heading label">進行中</p>
      <ul className="nav-list">
        {projects.map((p) => (
          <li key={p.id}>
            <NavLink to={`/projects/${p.id}`} className="nav-link" title={p.name}>
              <ColorDot color={p.color} />
              <span className="label">{p.name}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function Component() {
  return (
    <Shell>
      <Outlet />
    </Shell>
  )
}

// どの子ルートで投げられたエラーでも、シェル（サイドバー）は残したまま中身だけ差し替える
export function RouteError() {
  const error = useRouteError()
  const status = isRouteErrorResponse(error) ? error.status : 500
  const message = isRouteErrorResponse(error)
    ? String(error.data)
    : error instanceof Error
      ? error.message
      : String(error)
  return (
    <div className="error-page">
      <p className="error-code">{status}</p>
      <h1>{status === 404 ? 'ページが見つかりません' : 'エラーが発生しました'}</h1>
      <p className="muted">{message}</p>
      <Link to="/">ダッシュボードへ戻る</Link>
    </div>
  )
}

export function HydrateFallback() {
  return (
    <div className="boot" role="status">
      <span className="spinner" aria-hidden="true" />
      ブラウザ内の PostgreSQL を準備しています…
    </div>
  )
}
