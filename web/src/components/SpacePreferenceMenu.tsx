import { useEffect, useId, useRef, useState } from 'react'
import { Settings2, X } from 'lucide-react'
import { Popover } from 'radix-ui'
import { t } from '../core/i18n'
import { browserSpaceStorage, readSpacePreferences, setDefaultSpace, spacePreferenceKey, type SpaceBootstrap } from '../core/space-selection'
import './space-preference.css'

type Props = {
  bootstrap: SpaceBootstrap
  disabled?: boolean
  theme?: 'light' | 'dark'
}

/** This browser's account preference; changing it does not navigate away. */
export function SpacePreferenceMenu({ bootstrap, disabled = false, theme = 'light' }: Props) {
  const id = useId(), content = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false), [defaultId, setDefaultId] = useState('')
  const [status, setStatus] = useState(''), [error, setError] = useState('')
  const key = spacePreferenceKey(bootstrap)
  const refresh = () => setDefaultId(readSpacePreferences(bootstrap, browserSpaceStorage('local')).defaultSpaceId)

  useEffect(() => { setOpen(false); setStatus(''); setError('') }, [key])
  useEffect(() => {
    if (!open) return
    refresh()
    const changed = (event: StorageEvent) => { if (event.key === key || event.key === null) { refresh(); setStatus(''); setError('') } }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [open, key, bootstrap])

  if (!bootstrap.initialized || !bootstrap.user || !bootstrap.spaces.length) return null
  function choose(value: string) {
    setStatus(''); setError('')
    if (setDefaultSpace(bootstrap, value, browserSpaceStorage('local'))) {
      setDefaultId(value)
      setStatus(t('已保存到此浏览器。', 'Saved in this browser.'))
    } else setError(t('浏览器不允许保存偏好，仍可正常切换空间。', 'The browser could not save this preference. You can still switch spaces.'))
  }
  const title = t('默认打开空间', 'Default opening space')
  return <Popover.Root open={open} modal={false} onOpenChange={next => { if (next) { refresh(); setStatus(''); setError('') } setOpen(next) }}>
    <Popover.Trigger asChild><button type="button" className="lh-space-preference-trigger" disabled={disabled} aria-label={title} title={title} data-theme={theme}><Settings2 size={16}/></button></Popover.Trigger>
    <Popover.Portal>
      <Popover.Content ref={content} className="lh-space-preference-menu" data-theme={theme} side="bottom" align="end" sideOffset={8} collisionPadding={12} sticky="always" hideWhenDetached
        aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
        onOpenAutoFocus={event => { event.preventDefault(); content.current?.querySelector<HTMLInputElement>('input:checked')?.focus({ preventScroll: true }) }}>
        <div className="lh-space-preference-heading"><h2 id={`${id}-title`}>{title}</h2><Popover.Close asChild><button type="button" className="lh-space-preference-close" aria-label={t('关闭默认空间设置', 'Close default space settings')}><X size={16}/></button></Popover.Close></div>
        <p id={`${id}-description`} className="lh-space-preference-description">{t('仅用于此浏览器中的当前账号。新开页面或重新登录时使用；当前标签页已手动选择的空间优先。', 'Applies to this account in this browser. Used for a new page or sign-in; a space chosen in the current tab takes priority.')}</p>
        <fieldset className="lh-space-preference-options"><legend className="lh-space-preference-sr-only">{title}</legend>
          <label className="lh-space-preference-option" data-selected={defaultId === '' || undefined}>
            <input type="radio" name={`${id}-default`} value="" checked={defaultId === ''} onChange={() => choose('')} aria-label={t('记住上次空间', 'Remember last space')}/>
            <span><strong>{t('记住上次空间', 'Remember last space')}</strong><small>{t('打开上次成功访问的空间', 'Open the last space successfully visited')}</small></span>
          </label>
          {bootstrap.spaces.map(space => <label key={space.id} className="lh-space-preference-option" data-selected={defaultId === space.id || undefined}>
            <input type="radio" name={`${id}-default`} value={space.id} checked={defaultId === space.id} onChange={() => choose(space.id)} aria-label={space.name}/>
            <span><strong>{space.name}</strong><small>{space.kind === 'personal' ? t('私人空间', 'Personal space') : t('共享空间', 'Shared space')}</small></span>
          </label>)}
        </fieldset>
        {error ? <p className="lh-space-preference-error" role="alert">{error}</p> : status ? <p className="lh-space-preference-status" role="status">{status}</p> : null}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}
