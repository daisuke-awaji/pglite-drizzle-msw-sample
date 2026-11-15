import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandItemIcon,
  CommandList,
} from '@ui-sdk/react/command'
import { Dialog, DialogBackdrop, DialogContent, DialogShortcut, DialogTitle, DialogTrigger } from '@ui-sdk/react/dialog'
import {
  FolderKanbanIcon,
  LayoutDashboardIcon,
  MonitorIcon,
  MoonIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  UsersIcon,
} from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useRouteLoaderData } from 'react-router'
import type { RootData } from '../routes/root'
import { usePreferences, type Theme } from '../stores/preferences'
import { ColorDot } from './display'

const PAGES = [
  { value: 'page:/', label: 'ダッシュボード', icon: LayoutDashboardIcon },
  { value: 'page:/projects', label: 'プロジェクト', icon: FolderKanbanIcon },
  { value: 'page:/members', label: 'メンバー', icon: UsersIcon },
  { value: 'page:/settings', label: '設定', icon: SettingsIcon },
]

const THEMES = [
  { value: 'theme:light', label: 'ライトテーマにする', icon: SunIcon },
  { value: 'theme:dark', label: 'ダークテーマにする', icon: MoonIcon },
  { value: 'theme:system', label: 'システムのテーマに合わせる', icon: MonitorIcon },
]

// ⌘K / Ctrl+K で開くコマンドパレット。ページ移動・プロジェクト・テーマ切り替えをまとめる
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const setTheme = usePreferences((s) => s.setTheme)
  const projects = (useRouteLoaderData('root') as RootData | undefined)?.projects ?? []

  const run = (value: string) => {
    const [kind, arg] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)]
    if (kind === 'page') navigate(arg)
    if (kind === 'project') navigate(`/projects/${arg}`)
    if (kind === 'theme') setTheme(arg as Theme)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger shortcut="mod+k" className="search-trigger">
        <SearchIcon aria-hidden="true" />
        <span>検索</span>
        <DialogShortcut />
      </DialogTrigger>
      <DialogBackdrop />
      <DialogContent className="palette">
        <DialogTitle className="sr-only">コマンドパレット</DialogTitle>
        <Command onAction={run}>
          <div className="palette-input">
            <SearchIcon aria-hidden="true" />
            <CommandInput aria-label="コマンドを検索" placeholder="ページやプロジェクトを検索…" />
          </div>
          <CommandEmpty>見つかりません</CommandEmpty>
          <CommandList>
            <CommandGroup>
              <CommandGroupLabel>ページ</CommandGroupLabel>
              {PAGES.map(({ value, label, icon: Icon }) => (
                <CommandItem key={value} value={value}>
                  <CommandItemIcon>
                    <Icon />
                  </CommandItemIcon>
                  {label}
                </CommandItem>
              ))}
            </CommandGroup>
            {projects.length > 0 && (
              <CommandGroup>
                <CommandGroupLabel>プロジェクト</CommandGroupLabel>
                {projects.map((p) => (
                  <CommandItem key={p.id} value={`project:${p.id}`} keywords={[p.description]}>
                    <CommandItemIcon>
                      <ColorDot color={p.color} />
                    </CommandItemIcon>
                    {p.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup>
              <CommandGroupLabel>テーマ</CommandGroupLabel>
              {THEMES.map(({ value, label, icon: Icon }) => (
                <CommandItem key={value} value={value}>
                  <CommandItemIcon>
                    <Icon />
                  </CommandItemIcon>
                  {label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
