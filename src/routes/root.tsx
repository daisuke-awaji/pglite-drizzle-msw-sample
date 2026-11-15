import { OverlayHost } from '@ui-sdk/react/overlays'
import { Toast, ToastClose, ToastDescription, ToastRegion, ToastTitle } from '@ui-sdk/react/toast'
import { Toggle, ToggleIcon } from '@ui-sdk/react/toggle'
import { Drawer, DrawerBackdrop, DrawerClose, DrawerContent, DrawerTitle, DrawerTrigger } from '@ui-sdk/react/drawer'
import {
  ChevronLeftIcon,
  FolderKanbanIcon,
  LayoutDashboardIcon,
  MenuIcon,
  PanelLeftIcon,
  SettingsIcon,
  UsersIcon,
  WifiOffIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Link,
  NavLink,
  Outlet,
  useLoaderData,
  useLocation,
  useMatches,
  useNavigation,
  useRouteError,
} from 'react-router'
import { api } from '../api/client'
import { CommandPalette } from '../components/command-palette'
import { ConfirmDialog } from '../components/confirm'
import { ErrorView } from '../components/error-view'
import { ColorDot } from '../components/display'
import { ThemeMenu } from '../components/theme-menu'
import { useOnlineStatus } from '../lib/use-online-status'
import { usePreferences } from '../stores/preferences'
import { settle } from './lib'

// ルートの loader はサイドバーとコマンドパレットに出すプロジェクト一覧を読む。
// どの画面で action が成功しても React Router が自動で読み直すので、手で同期しなくてよい
// サイドバーの一覧は補助的な情報なので、読めなくてもアプリ全体は止めない（各画面のエラー表示に任せる）
export async function loader({ request }: { request: Request }) {
  const projects = await settle(api.listProjects({ status: 'active' }, request.signal))
  return { projects: projects.ok ? projects.value : [] }
}

export type RootData = Awaited<ReturnType<typeof loader>>

// 各ルートの handle.crumb がパンくずの項目を返す。文字列ならそのルート自身、配列なら複数の項目
// back: false は、狭い画面の「戻る」リンクの行き先にしない（開くと子の画面へ転送されるだけの項目など）
export type CrumbItem = { label: string; to?: string; back?: false }
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

type CrumbEntry = { key: string; label: string; to?: string; back?: false }

function useCrumbs(): CrumbEntry[] {
  return useMatches().flatMap((m) => {
    const c = (m.handle as Crumb | undefined)?.crumb?.(m.loaderData)
    if (!c) return []
    return typeof c === 'string' ? [{ key: m.id, label: c, to: m.pathname }] : c.map((x, i) => ({ key: `${m.id}-${i}`, ...x }))
  })
}

const APP_NAME = 'Starter Kit'

/**
 * 画面が変わったときの、見えない人・キーボードの人への配慮。
 * - タブのタイトルを「いまの画面 | Starter Kit」にする
 * - 別の画面へ移ったら、見出し（h1）へフォーカスを移し、画面名を読み上げる
 *   （SPA はページを読み込み直さないので、何もしないとフォーカスが押したリンクに残り、移動に気づけない）
 * - 検索条件やページ番号だけが変わったとき（同じ画面の中）は、入力中のフォーカスを奪わない
 */
function useRouteFocus(crumbs: CrumbEntry[]) {
  const { pathname } = useLocation()
  const [announcement, setAnnouncement] = useState('')
  const previous = useRef<string | null>(null)
  const title = crumbs.at(-1)?.label ?? 'ダッシュボード'

  // タイトルは毎回の描画後に合わせる。エラーを表示しているときは、パンくずよりエラーの見出しを優先する
  useEffect(() => {
    const errorHeading = document.querySelector('#main [role="alert"] h1')?.textContent?.trim()
    const heading = document.querySelector('#main h1')?.textContent?.trim()
    document.title = `${errorHeading || (crumbs.length > 0 ? title : heading) || title} | ${APP_NAME}`
  })

  useEffect(() => {
    const first = previous.current === null
    const changed = previous.current !== pathname
    previous.current = pathname
    if (first || !changed) return
    const heading = document.querySelector<HTMLElement>('#main h1')
    const target = heading ?? document.getElementById('main')
    if (target) {
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
      target.focus({ preventScroll: true })
    }
    window.scrollTo({ top: 0 })
    setAnnouncement(`${heading?.textContent?.trim() || title}を表示しました`)
  }, [pathname, title])

  return announcement
}

function Breadcrumbs({ crumbs }: { crumbs: CrumbEntry[] }) {
  const parent = crumbs.slice(0, -1).findLast((c) => c.to && c.back !== false)
  return (
    <>
      <nav aria-label="パンくずリスト" className="breadcrumbs">
        <ol>
          {crumbs.map((c, i) => (
            <li key={c.key}>
              {i < crumbs.length - 1 && c.to ? (
                <Link to={c.to}>{c.label}</Link>
              ) : (
                <span aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.label}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      {/* 狭い画面ではパンくずの代わりに「1 つ上へ戻る」リンクだけを出す */}
      {parent?.to && (
        <Link to={parent.to} className="back-link">
          <ChevronLeftIcon aria-hidden="true" />
          <span className="sr-only">戻る: </span>
          {parent.label}
        </Link>
      )}
    </>
  )
}

function MainNav({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  return (
    <>
      <nav aria-label="メイン">
        <ul className="nav-list">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink to={to} end={end} className="nav-link" title={collapsed ? label : undefined} onClick={onNavigate}>
                <Icon aria-hidden="true" />
                <span className="label">{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <SidebarProjects collapsed={collapsed} onNavigate={onNavigate} />
    </>
  )
}

// 狭い画面では、サイドバーを左から出るドロワーにする
function MobileNav() {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  return (
    <Drawer side="left" open={open} onOpenChange={setOpen}>
      <DrawerTrigger className="menu-trigger" data-variant="ghost" aria-label="メニューを開く">
        <MenuIcon aria-hidden="true" />
      </DrawerTrigger>
      <DrawerBackdrop className="drawer-backdrop" />
      <DrawerContent className="drawer">
        <div className="drawer-head">
          <DrawerTitle className="brand">
            <span className="brand-mark" aria-hidden="true" />
            {APP_NAME}
          </DrawerTitle>
          <DrawerClose data-variant="ghost" aria-label="メニューを閉じる">
            <XIcon aria-hidden="true" />
          </DrawerClose>
        </div>
        <MainNav onNavigate={close} />
      </DrawerContent>
    </Drawer>
  )
}

function Shell({ children }: { children: ReactNode }) {
  useThemeSync()
  const collapsed = usePreferences((s) => s.sidebarCollapsed)
  const toggleSidebar = usePreferences((s) => s.toggleSidebar)
  const navigation = useNavigation()
  const online = useOnlineStatus()
  const crumbs = useCrumbs()
  const announcement = useRouteFocus(crumbs)

  return (
    <div className="shell" data-collapsed={collapsed ? '' : undefined}>
      <a href="#main" className="skip-link">
        メインコンテンツへ移動
      </a>
      <div className="nav-progress" data-active={navigation.state !== 'idle' ? '' : undefined} aria-hidden="true" />
      <aside className="sidebar" aria-label="サイドバー">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="label">{APP_NAME}</span>
        </div>
        <MainNav collapsed={collapsed} />
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
          <MobileNav />
          <Breadcrumbs crumbs={crumbs} />
          <div className="row topbar-actions">
            <CommandPalette />
            <ThemeMenu />
          </div>
        </header>
        {!online && (
          <p className="offline-banner" role="status">
            <WifiOffIcon aria-hidden="true" />
            オフラインです。つながるまで保存できないことがあります
          </p>
        )}
        <main id="main" className="content" tabIndex={-1}>
          {children}
        </main>
      </div>
      {/* 画面の移動を読み上げる。中身が変わったときだけ読まれる */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <ToastRegion data-agent-hidden side="bottom" align="end" aria-label="通知">
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

function SidebarProjects({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { projects } = useLoaderData<RootData>()
  if (projects.length === 0) return null
  return (
    <nav aria-label="進行中のプロジェクト" className="sidebar-section">
      <p className="sidebar-heading label" aria-hidden="true">
        進行中
      </p>
      <ul className="nav-list">
        {projects.map((p) => (
          <li key={p.id}>
            <NavLink to={`/projects/${p.id}`} className="nav-link" title={collapsed ? p.name : undefined} onClick={onNavigate}>
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

// どの子ルートで投げられたエラーでも、シェル（サイドバー）は残したまま中身だけ差し替える。
// サイドバーから別の画面（設定の障害シミュレーションなど）へ移れるので、行き止まりにならない
export function RouteError() {
  return <ErrorView error={useRouteError()} />
}

// シェル自体の描画に失敗したとき（最後の砦）。サイドバーも出せないので、全面に出す
export function RootError() {
  return (
    <main className="root-error">
      <ErrorView error={useRouteError()} home={false} />
    </main>
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
