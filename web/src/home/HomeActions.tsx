import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { DropdownMenu } from 'radix-ui'
import { BarChart3, BookOpen, Check, LayoutGrid, List, Moon, MoreHorizontal, Pencil, RefreshCw, Settings2, Sun } from 'lucide-react'
import { t } from '../core/i18n'
import './home-actions.css'

export type HomeActionsProps = {
  theme: 'light' | 'dark'
  variant: 'cards' | 'directory'
  canEdit: boolean
  canViewStats: boolean
  preview: boolean
  editing: boolean
  contentEditing: boolean
  busy: boolean
  loadingContent: boolean
  refreshing: boolean
  hasExternalPanels: boolean
  managementLabel: string
  onEdit: () => void
  onLayout: () => void
  onRefresh: () => void
  onStatistics: () => void
  onVariantChange: (variant: 'cards' | 'directory') => void
  onThemeChange: (theme: 'light' | 'dark') => void
  /** The host supplies the unsaved-draft guard before changing the route. */
  onNavigate: (href: '#/library' | '#/admin') => void
}

/** The header keeps its primary action visible; secondary actions share one menu. */
export function HomeActions({ theme, variant, canEdit, canViewStats, preview, editing, contentEditing, busy, loadingContent, refreshing, hasExternalPanels,
  managementLabel, onEdit, onLayout, onRefresh, onStatistics, onVariantChange, onThemeChange, onNavigate }: HomeActionsProps) {
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
  function navigate(event: MouseEvent<HTMLAnchorElement>, href: '#/library' | '#/admin') {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    closeThen(() => onNavigate(href))
  }

  if (editing) return null
  return <>
    {maintenance && canEdit && !contentEditing && <button type="button" className="lh-quiet-button lh-edit-trigger" title={t('编辑分类与链接', 'Edit categories and links')} aria-label={t('编辑', 'Edit')} disabled={busy || loadingContent} onClick={onEdit}>
      <Pencil size={14} aria-hidden="true"/><span>{loadingContent ? t('正在读取…', 'Loading…') : t('编辑', 'Edit')}</span>
    </button>}
    <DropdownMenu.Root open={open} modal={false} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild><button ref={trigger} type="button" className="lh-quiet-button lh-more-trigger" aria-label={t('更多', 'More')} title={t('更多操作', 'More actions')}
        onPointerDownCapture={event => {
          keyboardOpen.current = false
          // Move focus into an embedded preview before Radix opens its menu.
          // Otherwise that first focus transfer blurs the parent window and
          // its window-blur listener immediately dismisses the new menu.
          if (event.currentTarget.ownerDocument !== document && event.button === 0 && !event.ctrlKey) event.currentTarget.focus({ preventScroll: true })
        }} onKeyDownCapture={event => {
          if (['Enter', ' ', 'ArrowDown'].includes(event.key)) keyboardOpen.current = true
        }}>
        <MoreHorizontal size={17} aria-hidden="true"/><span>{t('更多', 'More')}</span>
      </button></DropdownMenu.Trigger>
      <DropdownMenu.Portal container={trigger.current?.ownerDocument.body}>
        <DropdownMenu.Content className="lh-home-actions-menu" aria-label={t('首页更多操作', 'More home actions')} data-theme={theme} style={palette} align="end" sideOffset={8} collisionPadding={12}
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
          {maintenance && <>
            <DropdownMenu.Label className="lh-home-actions-label">{t('访问', 'Explore')}</DropdownMenu.Label>
            <DropdownMenu.Item className="lh-home-actions-item" asChild><a href="#/library" onClick={event => navigate(event, '#/library')}><BookOpen size={16} aria-hidden="true"/><span>{t('资料库', 'Library')}</span></a></DropdownMenu.Item>
            {canViewStats && !contentEditing && <DropdownMenu.Item className="lh-home-actions-item lh-click-stats-trigger" onSelect={() => closeThen(onStatistics)}><BarChart3 size={16} aria-hidden="true"/><span>{t('点击统计', 'Click statistics')}</span></DropdownMenu.Item>}
            <DropdownMenu.Separator className="lh-home-actions-separator"/>
            <DropdownMenu.Label className="lh-home-actions-label">{t('页面', 'Page')}</DropdownMenu.Label>
            {canEdit && <DropdownMenu.Item className="lh-home-actions-item" disabled={busy || loadingContent} onSelect={() => closeThen(onLayout)}><LayoutGrid size={16} aria-hidden="true"/><span>{t('调整布局', 'Adjust layout')}</span></DropdownMenu.Item>}
            {!contentEditing && <DropdownMenu.Item className="lh-home-actions-item" disabled={refreshing} aria-label={hasExternalPanels ? t('读取最新组件快照', 'Read latest component snapshots') : t('刷新内容', 'Refresh content')} title={t('读取已保存内容，不触发外部获取', 'Read saved content without starting external requests')} onSelect={() => closeThen(onRefresh)}><RefreshCw size={16} className={refreshing ? 'lh-spin' : undefined} aria-hidden="true"/><span>{hasExternalPanels ? t('更新数据', 'Refresh data') : t('刷新内容', 'Refresh content')}</span></DropdownMenu.Item>}
            <DropdownMenu.Item className="lh-home-actions-item" asChild><a href="#/admin" aria-label={managementLabel} onClick={event => navigate(event, '#/admin')}><Settings2 size={16} aria-hidden="true"/><span>{managementLabel}</span></a></DropdownMenu.Item>
          </>}
          {browsing && <>
            {maintenance && <DropdownMenu.Separator className="lh-home-actions-separator"/>}
            <DropdownMenu.Label className="lh-home-actions-label">{t('显示', 'Display')}</DropdownMenu.Label>
            <DropdownMenu.RadioGroup value={variant} aria-label={t('链接展示方式', 'Link presentation')} onValueChange={value => onVariantChange(value as 'cards' | 'directory')}>
              <DropdownMenu.RadioItem className="lh-home-actions-item" value="cards" onSelect={event => event.preventDefault()}><LayoutGrid size={16} aria-hidden="true"/><span>{t('卡片模式', 'Card view')}</span><DropdownMenu.ItemIndicator className="lh-home-actions-check"><Check size={15} aria-hidden="true"/></DropdownMenu.ItemIndicator></DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem className="lh-home-actions-item" value="directory" onSelect={event => event.preventDefault()}><List size={16} aria-hidden="true"/><span>{t('目录模式', 'Directory view')}</span><DropdownMenu.ItemIndicator className="lh-home-actions-check"><Check size={15} aria-hidden="true"/></DropdownMenu.ItemIndicator></DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
            <DropdownMenu.Item className="lh-home-actions-item" aria-label={t('切换深浅色', 'Toggle light or dark')} onSelect={event => { event.preventDefault(); onThemeChange(theme === 'dark' ? 'light' : 'dark') }}>
              {theme === 'dark' ? <Sun size={16} aria-hidden="true"/> : <Moon size={16} aria-hidden="true"/>}<span>{t('切换深浅色', 'Toggle light or dark')}</span><small>{theme === 'dark' ? t('深色', 'Dark') : t('浅色', 'Light')}</small>
            </DropdownMenu.Item>
          </>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  </>
}
