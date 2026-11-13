import type { MouseEvent } from 'react'
import { BookOpen, Home, LayoutDashboard } from 'lucide-react'
import { t } from '../core/i18n'
import { requestNavigation } from '../core/navigation'
import type { Modules } from '../core/types'
import './module-nav.css'

type Module = 'home' | 'documents' | 'work'
type Props = {
  active?: Module
  modules?: Modules
  canViewWork: boolean
  spaceId?: string
  onHome?: () => void
  onLibrary?: () => void
  onWork?: () => void
}

export function ModuleNav({ active, modules, canViewWork, spaceId, onHome, onLibrary, onWork }: Props) {
  const space = spaceId ? `&space=${encodeURIComponent(spaceId)}` : ''
  const items = [
    { id: 'home' as const, label: t('导航', 'Home'), icon: Home, href: '#/', action: onHome },
    ...(modules?.documents !== false ? [{ id: 'documents' as const, label: t('资料库', 'Library'), icon: BookOpen, href: `#/library${spaceId ? `?space=${encodeURIComponent(spaceId)}` : ''}`, action: onLibrary }] : []),
    ...(modules?.work !== false && canViewWork ? [{ id: 'work' as const, label: t('事项', 'Work'), icon: LayoutDashboard, href: `#/library?view=board${space}`, action: onWork }] : []),
  ]
  function navigate(event: MouseEvent<HTMLAnchorElement>, href: string, action?: () => void) {
    if (event.button || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    requestNavigation(action || (() => { window.location.hash = href }))
  }
  return <nav className="lh-module-nav" aria-label={t('主要导航', 'Primary navigation')}>
    {items.map(({ id, label, icon: Icon, href, action }) => active === id
      ? <span key={id} aria-current="page" title={label}><Icon size={17} aria-hidden="true"/><span>{label}</span></span>
      : <a key={id} href={href} title={label} onClick={event => navigate(event, href, action)}><Icon size={17} aria-hidden="true"/><span>{label}</span></a>)}
  </nav>
}
