import type { MouseEvent, ReactNode } from 'react'
import { t } from '../core/i18n'
import { requestNavigation } from '../core/navigation'
import { ProjectLogo } from './ProjectLogo'
import './app-header.css'

type Props = {
  siteName: string
  className?: string
  brandClassName?: string
  onHome?: () => void
  brandDisabled?: boolean
  navigation?: ReactNode
  context?: ReactNode
  search?: ReactNode
  searchClassName?: string
  actions?: ReactNode
  actionsClassName?: string
  utilities?: ReactNode
  theme?: 'light' | 'dark'
}

/** Shared chrome only. Each page retains its own permissions and draft guards. */
export function AppHeader({ siteName, className = '', brandClassName = '', onHome, brandDisabled,
  navigation, context, search, searchClassName = '', actions, actionsClassName = '', utilities, theme = 'light' }: Props) {
  const name = siteName || 'Lingshu-Home'
  function goHome(event: MouseEvent<HTMLAnchorElement>) {
    if (brandDisabled || event.button || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    requestNavigation(onHome || (() => { window.location.hash = '/' }))
  }
  return <header className={`app-header ${className}`} data-theme={theme}>
    <div className="app-header-row">
      <div className="app-header-leading">
        <a className={`app-header-brand ${brandClassName}`} href={brandDisabled ? undefined : '#/'} aria-label={t('{name} 首页', '{name} home', { name })} aria-disabled={brandDisabled || undefined} onClick={goHome} title={name}>
          <ProjectLogo size={32}/><strong>{name}</strong>
        </a>
        {navigation}
        {context && <div className="app-header-context">{context}</div>}
      </div>
      <div className="app-header-tools">
        {search && <div className={`app-header-search ${searchClassName}`}>{search}</div>}
        {actions && <div className={`app-header-actions ${actionsClassName}`}>{actions}</div>}
        {utilities && <div className="app-header-utilities">{utilities}</div>}
      </div>
    </div>
  </header>
}
