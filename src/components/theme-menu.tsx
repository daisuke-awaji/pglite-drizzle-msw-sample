import {
  Menu,
  MenuContent,
  MenuGroupLabel,
  MenuItemIcon,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from '@ui-sdk/react/menu'
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { usePreferences, type Theme } from '../stores/preferences'

const THEMES: { value: Theme; label: string; icon: typeof SunIcon }[] = [
  { value: 'system', label: 'システムに合わせる', icon: MonitorIcon },
  { value: 'light', label: 'ライト', icon: SunIcon },
  { value: 'dark', label: 'ダーク', icon: MoonIcon },
]

export function ThemeMenu() {
  const theme = usePreferences((s) => s.theme)
  const setTheme = usePreferences((s) => s.setTheme)
  const Current = THEMES.find((t) => t.value === theme)?.icon ?? MonitorIcon
  return (
    <Menu>
      <MenuTrigger aria-label="テーマ" data-variant="ghost">
        <Current aria-hidden="true" />
      </MenuTrigger>
      <MenuContent>
        <MenuRadioGroup value={theme} onValueChange={(value) => value && setTheme(value as Theme)}>
          <MenuGroupLabel>テーマ</MenuGroupLabel>
          {THEMES.map(({ value, label, icon: Icon }) => (
            <MenuRadioItem key={value} value={value}>
              <MenuItemIcon>
                <Icon />
              </MenuItemIcon>
              {label}
              <MenuItemIndicator />
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  )
}
