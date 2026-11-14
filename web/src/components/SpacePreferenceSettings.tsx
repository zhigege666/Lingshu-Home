import { useEffect, useId, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { t } from '../core/i18n'
import { browserSpaceStorage, readSpacePreferences, setDefaultSpace, spacePreferenceKey, type SpaceBootstrap } from '../core/space-selection'
import './space-preference.css'

/** This browser's account preference; changing it does not navigate away. */
export function SpacePreferenceSettings({ bootstrap, disabled = false }: {
  bootstrap: SpaceBootstrap
  disabled?: boolean
}) {
  const id = useId(), key = spacePreferenceKey(bootstrap)
  const [defaultId, setDefaultId] = useState(() => readSpacePreferences(bootstrap, browserSpaceStorage('local')).defaultSpaceId)
  const [status, setStatus] = useState(''), [error, setError] = useState('')

  useEffect(() => {
    const refresh = () => setDefaultId(readSpacePreferences(bootstrap, browserSpaceStorage('local')).defaultSpaceId)
    refresh(); setStatus(''); setError('')
    const changed = (event: StorageEvent) => {
      if (event.key === key || event.key === null) { refresh(); setStatus(''); setError('') }
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [key, bootstrap])
  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(''), 3000)
    return () => window.clearTimeout(timer)
  }, [status, defaultId])

  if (!bootstrap.initialized || !bootstrap.user || !bootstrap.spaces.length) return null
  function choose(value: string) {
    setStatus(''); setError('')
    if (setDefaultSpace(bootstrap, value, browserSpaceStorage('local'))) {
      setDefaultId(value)
      setStatus(t('已保存', 'Saved'))
    } else setError(t('浏览器不允许保存偏好，仍可正常切换空间。', 'The browser could not save this preference. You can still switch spaces.'))
  }

  return <section className="profile-card profile-preferences" aria-labelledby={`${id}-heading`}>
    <header className="profile-card-heading"><Settings2 size={20} aria-hidden="true"/><h2 id={`${id}-heading`}>{t('浏览偏好', 'Browsing preferences')}</h2></header>
    <fieldset className="lh-space-preference-settings" disabled={disabled} aria-describedby={`${id}-description`}>
      <legend>{t('默认打开空间', 'Default opening space')}</legend>
      <p id={`${id}-description`} className="lh-space-preference-description">{t('新开页面或重新登录时使用，仅影响此浏览器中的当前账号；当前标签页的手动选择优先。', 'Used for new pages or sign-in, for this account in this browser. A space chosen in the current tab takes priority.')}</p>
      <div className="lh-space-preference-options">
        <label className="lh-space-preference-option" data-selected={defaultId === '' || undefined}>
          <input type="radio" name={`${id}-default`} value="" checked={defaultId === ''} onChange={() => choose('')} aria-label={t('记住上次空间', 'Remember last space')}/>
          <span><strong>{t('记住上次空间', 'Remember last space')}</strong><small>{t('打开上次成功访问的空间', 'Open the last space successfully visited')}</small></span>
        </label>
        {bootstrap.spaces.map(space => <label key={space.id} className="lh-space-preference-option" data-selected={defaultId === space.id || undefined}>
          <input type="radio" name={`${id}-default`} value={space.id} checked={defaultId === space.id} onChange={() => choose(space.id)} aria-label={space.name}/>
          <span><strong>{space.name}</strong><small>{space.kind === 'personal' ? t('私人空间', 'Personal space') : t('共享空间', 'Shared space')}</small></span>
        </label>)}
      </div>
    </fieldset>
    <div className="lh-space-preference-feedback">
      {error ? <p className="lh-space-preference-error" role="alert">{error}</p> : <p className="lh-space-preference-status" role="status" aria-live="polite">{status}</p>}
    </div>
  </section>
}
