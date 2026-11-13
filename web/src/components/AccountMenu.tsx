import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { DropdownMenu } from 'radix-ui'
import { Check, ChevronDown, LogOut, Moon, Settings2, UserRound } from 'lucide-react'
import type { User } from '../core/types'
import { t } from '../core/i18n'
import './account-profile.css'

export function accountInitials(user: User) {
  return Array.from(user.displayName.trim() || user.username).slice(0, 2).join('').toUpperCase()
}
/** Keep all account surfaces in sync, with initials when an image is unavailable. */
export function AccountAvatar({ user, className = 'home-account-avatar' }: { user: User; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const url = user.avatarUrl || ''
  return <span className={className} aria-hidden="true">{url && failedUrl !== url
    ? <img src={url} alt="" onError={() => setFailedUrl(url)}/>
    : accountInitials(user)}</span>
}
export default function AccountMenu({ user, onProfile, onLogout, onAdmin, theme = 'light', onThemeChange }: {
  user: User
  onProfile: () => void
  onLogout: () => void
  onAdmin?: () => void
  theme?: 'light' | 'dark'
  onThemeChange?: (theme: 'light' | 'dark') => void
}) {
  const name = user.displayName || user.username
  const [open, setOpen] = useState(false)
  const [palette, setPalette] = useState<CSSProperties>({})
  const trigger = useRef<HTMLButtonElement>(null)
  const afterClose = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const header = trigger.current?.closest<HTMLElement>('.app-header')
    const owner = header?.ownerDocument.defaultView
    if (!header || !owner) return
    const computed = owner.getComputedStyle(header), values: Record<string, string> = {}
    for (const key of ['surface', 'ink', 'muted', 'line', 'soft', 'accent', 'tint']) values[`--account-${key}`] = computed.getPropertyValue(key === 'surface' ? '--header-menu-surface' : `--header-${key}`)
    setPalette(values as CSSProperties)
  }, [open, theme])
  function closeThen(action: () => void) { afterClose.current = action; setOpen(false) }
  return <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}><DropdownMenu.Trigger asChild>
    <button ref={trigger} type="button" className="home-account-trigger" title={name} aria-label={t('账号菜单：{name}', 'Account menu: {name}', { name })}>
      <AccountAvatar user={user}/><span className="home-account-name">{name}</span><ChevronDown size={14} aria-hidden="true"/>
    </button>
  </DropdownMenu.Trigger><DropdownMenu.Portal container={trigger.current?.ownerDocument.body}><DropdownMenu.Content className="home-account-menu" data-theme={theme} style={palette} align="end" sideOffset={8} collisionPadding={12}
    onCloseAutoFocus={event => {
      const action = afterClose.current
      afterClose.current = null
      if (!action) return
      event.preventDefault()
      if (!trigger.current?.isConnected) return
      trigger.current.focus({ preventScroll: true })
      action()
    }}>
    <DropdownMenu.Label className="home-account-menu-identity"><strong>{name}</strong><span>@{user.username}</span></DropdownMenu.Label>
    <DropdownMenu.Separator className="home-account-menu-separator"/>
    <DropdownMenu.Item className="home-account-menu-item" onSelect={() => closeThen(onProfile)}><UserRound size={16} aria-hidden="true"/>{t('我的资料', 'My profile')}</DropdownMenu.Item>
    {onAdmin && <DropdownMenu.Item className="home-account-menu-item" asChild><a href="#/admin" onClick={event => {
      if (event.button || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      event.preventDefault(); closeThen(onAdmin)
    }}><Settings2 size={16} aria-hidden="true"/>{t('管理中心', 'Admin')}</a></DropdownMenu.Item>}
    {onThemeChange && <DropdownMenu.CheckboxItem className="home-account-menu-item" checked={theme === 'dark'} aria-label={t('切换深浅色', 'Toggle light or dark')}
      onSelect={event => event.preventDefault()} onCheckedChange={checked => onThemeChange(checked ? 'dark' : 'light')}>
      <Moon size={16} aria-hidden="true"/>{t('深色外观', 'Dark appearance')}<DropdownMenu.ItemIndicator className="home-account-menu-check"><Check size={15} aria-hidden="true"/></DropdownMenu.ItemIndicator>
    </DropdownMenu.CheckboxItem>}
    <DropdownMenu.Separator className="home-account-menu-separator"/>
    <DropdownMenu.Item className="home-account-menu-item home-account-menu-logout" onSelect={() => closeThen(onLogout)}><LogOut size={16} aria-hidden="true"/>{t('退出登录', 'Sign out')}</DropdownMenu.Item>
  </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
}
