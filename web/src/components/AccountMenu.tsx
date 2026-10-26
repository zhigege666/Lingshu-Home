import { DropdownMenu } from 'radix-ui'
import { ChevronDown, LogOut, UserRound } from 'lucide-react'
import type { User } from '../core/types'
import { t } from '../core/i18n'
import './account-profile.css'

export function accountInitials(user: User) {
  return Array.from(user.displayName.trim() || user.username).slice(0, 2).join('').toUpperCase()
}
export default function AccountMenu({ user, onProfile, onLogout }: { user: User; onProfile: () => void; onLogout: () => void }) {
  const name = user.displayName || user.username
  return <DropdownMenu.Root><DropdownMenu.Trigger asChild>
    <button type="button" className="home-account-trigger" aria-label={t('账号菜单：{name}', 'Account menu: {name}', { name })}>
      <span className="home-account-avatar" aria-hidden="true">{accountInitials(user)}</span><span className="home-account-name">{name}</span><ChevronDown size={14} aria-hidden="true"/>
    </button>
  </DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="home-account-menu" align="end" sideOffset={8} collisionPadding={12}>
    <DropdownMenu.Label className="home-account-menu-identity"><strong>{name}</strong><span>@{user.username}</span></DropdownMenu.Label>
    <DropdownMenu.Separator className="home-account-menu-separator"/>
    <DropdownMenu.Item className="home-account-menu-item" onSelect={onProfile}><UserRound size={16}/>{t('我的资料', 'My profile')}</DropdownMenu.Item>
    <DropdownMenu.Separator className="home-account-menu-separator"/>
    <DropdownMenu.Item className="home-account-menu-item home-account-menu-logout" onSelect={onLogout}><LogOut size={16}/>{t('退出登录', 'Sign out')}</DropdownMenu.Item>
  </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
}
