import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { DropdownMenu } from 'radix-ui'
import { BarChart3, BookOpen, Check, ChevronDown, LayoutDashboard, LayoutGrid, List, LogOut, Moon, Pencil, Settings2, SlidersHorizontal, Sun } from 'lucide-react'
import { t } from '../core/i18n'
import type { User } from '../core/types'
import { AccountAvatar } from '../components/AccountMenu'
import './home-actions.css'

export type HomeActionsProps = {
  theme: 'light' | 'dark'
  variant: 'cards' | 'directory'
  canEdit: boolean
  canViewStats: boolean
  canViewWork: boolean
  preview: boolean
  editing: boolean
  contentEditing: boolean
  busy: boolean
  loadingContent: boolean
  user: User | null
  onProfile?: () => void
  onLogout?: () => void
  managementLabel: string
  onEdit: () => void
  onLayout: () => void
  onStatistics: () => void
  onVariantChange: (variant: 'cards' | 'directory') => void
  onThemeChange: (theme: 'light' | 'dark') => void
  /** The host supplies the unsaved-draft guard before changing the route. */
  onNavigate: (href: '#/library' | '#/library?view=board' | '#/admin') => void
}

/** Navigation stays visible; account and page options share one themed menu. */
export function HomeActions({ theme, variant, canEdit, canViewStats, canViewWork, preview, editing, contentEditing, busy, loadingContent, user, onProfile, onLogout,
  managementLabel, onEdit, onLayout, onStatistics, onVariantChange, onThemeChange, onNavigate }: HomeActionsProps) {
  const [open, setOpen] = useState(false)
  const [palette, setPalette] = useState<CSSProperties>({})
  const trigger = useRef<HTMLButtonElement>(null)
  const afterClose = useRef<(() => void) | null>(null)
  const keyboardOpen = useRef(false)
  const dismissedByBlur = useRef(false)
  const maintenance = !preview && !editing
  const browsing = !editing && !contentEditing

  useLayoutEffect(() => {
    if (!open) return
    const home = trigger.current?.closest<HTMLElement>('.lh-home'), ownerWindow = home?.ownerDocument.defaultView
    if (!home || !ownerWindow) return
    const read = () => {
      const computed = ownerWindow.getComputedStyle(home), style: Record<string, string> = {}
      for (const name of ['surface', 'soft', 'ink', 'muted', 'line', 'accent', 'tint', 'scroll-thumb']) style[`--lh-${name}`] = computed.getPropertyValue(`--lh-${name}`)
      setPalette(style as CSSProperties)
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(home, { attributes: true, attributeFilter: ['data-theme', 'data-page-theme', 'style'] })
    const embedded = home.ownerDocument !== document
    const closeOnBlur = () => { dismissedByBlur.current = true; setOpen(false) }
    if (embedded) ownerWindow.addEventListener('blur', closeOnBlur)
    return () => {
      observer.disconnect()
      if (embedded) ownerWindow.removeEventListener('blur', closeOnBlur)
    }
  }, [open, theme])

  // Dialogs and guarded navigation start after the menu releases its focus
  // scope. The still-visible trigger is also a reliable dialog return target.
  function closeThen(action: () => void) {
    afterClose.current = action
    setOpen(false)
  }
  function navigate(event: MouseEvent<HTMLAnchorElement>, href: '#/library' | '#/library?view=board' | '#/admin') {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    closeThen(() => onNavigate(href))
  }

  function navigateDirect(event: MouseEvent<HTMLAnchorElement>, href: '#/library' | '#/library?view=board') {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    onNavigate(href)
  }

  if (editing) return null
  const account = maintenance ? user : null
  const accountName = account?.displayName || account?.username || ''
  return <>
    {maintenance && <nav className="lh-header-navigation" aria-label={t('常用入口', 'Quick navigation')}>
      <a className="lh-nav-link" href="#/library" aria-label={t('资料库', 'Library')} title={t('资料库', 'Library')} onClick={event => navigateDirect(event, '#/library')}><BookOpen size={17} aria-hidden="true"/><span>{t('资料库', 'Library')}</span></a>
      {canViewWork && <a className="lh-nav-link" href="#/library?view=board" aria-label={t('事项看板', 'Work board')} title={t('事项看板', 'Work board')} onClick={event => navigateDirect(event, '#/library?view=board')}><LayoutDashboard size={17} aria-hidden="true"/><span>{t('看板', 'Board')}</span></a>}
    </nav>}
    {maintenance && canEdit && !contentEditing && <button type="button" className="lh-quiet-button lh-edit-trigger" title={t('编辑分类与链接', 'Edit categories and links')} aria-label={t('编辑', 'Edit')} disabled={busy || loadingContent} onClick={onEdit}>
      <Pencil size={14} aria-hidden="true"/><span>{loadingContent ? t('正在读取…', 'Loading…') : t('编辑', 'Edit')}</span>
    </button>}
    {browsing && <button type="button" className="lh-icon-button lh-theme-trigger" aria-label={t('切换深浅色', 'Toggle light or dark')} aria-pressed={theme === 'dark'} title={theme === 'dark' ? t('切换为浅色', 'Switch to light mode') : t('切换为深色', 'Switch to dark mode')} onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}>
      {theme === 'dark' ? <Sun size={18} aria-hidden="true"/> : <Moon size={18} aria-hidden="true"/>}
    </button>}
    <DropdownMenu.Root open={open} modal={false} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild><button ref={trigger} type="button" className={account ? 'home-account-trigger lh-home-menu-trigger' : 'lh-icon-button lh-page-menu-trigger lh-home-menu-trigger'} aria-label={account ? t('账号菜单：{name}', 'Account menu: {name}', { name: accountName }) : t('页面设置', 'Page options')} title={account ? accountName : t('页面设置', 'Page options')}
        onPointerDownCapture={event => {
          keyboardOpen.current = false
          // Move focus into an embedded preview before Radix opens its menu.
          // Otherwise that first focus transfer blurs the parent window and
          // its window-blur listener immediately dismisses the new menu.
          if (event.currentTarget.ownerDocument !== document && event.button === 0 && !event.ctrlKey) event.currentTarget.focus({ preventScroll: true })
        }} onKeyDownCapture={event => {
          if (['Enter', ' ', 'ArrowDown'].includes(event.key)) keyboardOpen.current = true
        }}>
        {account ? <><AccountAvatar user={account}/><span className="home-account-name">{accountName}</span><ChevronDown size={14} aria-hidden="true"/></> : <SlidersHorizontal size={18} aria-hidden="true"/>}
      </button></DropdownMenu.Trigger>
      <DropdownMenu.Portal container={trigger.current?.ownerDocument.body}>
        <DropdownMenu.Content className="lh-home-actions-menu" aria-label={account ? t('账号与页面设置', 'Account and page options') : t('页面设置', 'Page options')} data-theme={theme} style={palette} align="end" sideOffset={8} collisionPadding={12}
          onFocusCapture={event => {
            const menu = event.currentTarget
            if (menu.ownerDocument === document || event.target !== menu || !keyboardOpen.current) return
            keyboardOpen.current = false
            event.stopPropagation()
            menu.querySelector<HTMLElement>('[role^="menuitem"]:not([data-disabled])')?.focus({ preventScroll: true })
          }}
          onKeyDownCapture={event => {
            const menu = event.currentTarget
            // Radix's roving focus still reads the parent document. Keep its
            // normal behavior outside previews, and use the actual iframe
            // document for the preview's arrow/Home/End navigation.
            if (menu.ownerDocument === document || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return
            const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([data-disabled])')]
            if (!items.length) return
            const current = items.indexOf(menu.ownerDocument.activeElement as HTMLElement)
            const next = ['Home', 'PageUp'].includes(event.key) ? 0 : ['End', 'PageDown'].includes(event.key) ? items.length - 1
              : event.key === 'ArrowDown' ? Math.min(current + 1, items.length - 1) : current < 0 ? items.length - 1 : Math.max(current - 1, 0)
            event.preventDefault(); event.stopPropagation(); items[next]?.focus({ preventScroll: true })
          }}
          onCloseAutoFocus={event => {
            // A user who moved into the parent editor keeps that new focus.
            // Returning to the iframe trigger here would steal input focus.
            if (dismissedByBlur.current) { dismissedByBlur.current = false; event.preventDefault() }
            const action = afterClose.current
            afterClose.current = null
            if (!action) return
            event.preventDefault()
            if (!trigger.current?.isConnected) return
            trigger.current.focus({ preventScroll: true })
            action()
          }}>
          {account && onProfile && <>
            <DropdownMenu.Item className="lh-home-actions-item lh-account-profile" aria-label={t('我的资料', 'My profile')} onSelect={() => closeThen(onProfile)}>
              <AccountAvatar user={account}/><span><strong>{accountName}</strong><small>{t('我的资料', 'My profile')}</small></span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="lh-home-actions-separator"/>
          </>}
          {maintenance && <>
            {canViewStats && !contentEditing && <DropdownMenu.Item className="lh-home-actions-item lh-click-stats-trigger" onSelect={() => closeThen(onStatistics)}><BarChart3 size={16} aria-hidden="true"/><span>{t('点击统计', 'Click statistics')}</span></DropdownMenu.Item>}
            {canEdit && <DropdownMenu.Item className="lh-home-actions-item" disabled={busy || loadingContent} onSelect={() => closeThen(onLayout)}><LayoutGrid size={16} aria-hidden="true"/><span>{t('调整布局', 'Adjust layout')}</span></DropdownMenu.Item>}
            <DropdownMenu.Item className="lh-home-actions-item" asChild><a href="#/admin" aria-label={managementLabel} onClick={event => navigate(event, '#/admin')}><Settings2 size={16} aria-hidden="true"/><span>{managementLabel}</span></a></DropdownMenu.Item>
          </>}
          {browsing && <>
            {maintenance && <DropdownMenu.Separator className="lh-home-actions-separator"/>}
            <DropdownMenu.RadioGroup value={variant} aria-label={t('链接展示方式', 'Link presentation')} onValueChange={value => onVariantChange(value as 'cards' | 'directory')}>
              <DropdownMenu.RadioItem className="lh-home-actions-item" value="cards" onSelect={event => event.preventDefault()}><LayoutGrid size={16} aria-hidden="true"/><span>{t('卡片模式', 'Card view')}</span><DropdownMenu.ItemIndicator className="lh-home-actions-check"><Check size={15} aria-hidden="true"/></DropdownMenu.ItemIndicator></DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem className="lh-home-actions-item" value="directory" onSelect={event => event.preventDefault()}><List size={16} aria-hidden="true"/><span>{t('目录模式', 'Directory view')}</span><DropdownMenu.ItemIndicator className="lh-home-actions-check"><Check size={15} aria-hidden="true"/></DropdownMenu.ItemIndicator></DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
          </>}
          {account && onLogout && <>
            <DropdownMenu.Separator className="lh-home-actions-separator"/>
            <DropdownMenu.Item className="lh-home-actions-item lh-account-logout" onSelect={() => closeThen(onLogout)}><LogOut size={16} aria-hidden="true"/><span>{t('退出登录', 'Sign out')}</span></DropdownMenu.Item>
          </>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  </>
}
