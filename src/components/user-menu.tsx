import { Menu, MenuContent, MenuGroupLabel, MenuItem, MenuItemIcon, MenuTrigger } from '@ui-sdk/react/menu'
import { LogOutIcon, UserRoundIcon } from 'lucide-react'
import { currentUser, logout } from '../auth/session'

// ログインしている人と、ログアウト（VITE_AUTH_MODE=cognito のビルドだけ。src/routes/root.tsx が USES_AUTH で出し分ける）
export function UserMenu() {
  const user = currentUser()
  const label = user?.name ?? user?.email ?? 'ログイン中'
  return (
    <Menu presentation="auto">
      <MenuTrigger aria-label={`アカウント（${label}）`} data-variant="ghost">
        <UserRoundIcon aria-hidden="true" />
      </MenuTrigger>
      <MenuContent>
        <MenuGroupLabel>{label}</MenuGroupLabel>
        <MenuItem value="logout" onSelect={logout}>
          <MenuItemIcon>
            <LogOutIcon />
          </MenuItemIcon>
          ログアウト
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
