import { createContext, useContext, useEffect, useState } from 'react'
import type { Bootstrap, Dashboard } from '../core/types'

export type WorkTheme = 'light' | 'dark'
export const WorkThemeContext = createContext<WorkTheme>('light')
export const useWorkTheme = () => useContext(WorkThemeContext)

function readColor(key: string): WorkTheme | null {
  try { const value = localStorage.getItem(key); return value === 'light' || value === 'dark' ? value : null }
  catch { return null }
}

/** Shares the homepage's account/access-mode preference without changing page config. */
export function useBoardTheme(bootstrap: Bootstrap, dashboard: Dashboard) {
  const key = `lingshu-home:color:${bootstrap.user?.id || 'visitor'}:${bootstrap.mode}`
  const [preference, setPreference] = useState(() => ({ key, color: readColor(key) }))
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    setPreference({ key, color: readColor(key) })
    const media = matchMedia('(prefers-color-scheme: dark)')
    const changed = () => setSystemDark(media.matches)
    const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) setPreference({ key, color: readColor(key) }) }
    media.addEventListener('change', changed); window.addEventListener('storage', storage)
    return () => { media.removeEventListener('change', changed); window.removeEventListener('storage', storage) }
  }, [key])
  const configured = dashboard.page.config.appearance.colorMode
  const preferred = preference.key === key ? preference.color : readColor(key)
  const theme: WorkTheme = preferred || (configured === 'system' ? systemDark ? 'dark' : 'light' : configured)
  function setTheme(color: WorkTheme) {
    setPreference({ key, color })
    try { localStorage.setItem(key, color) } catch { /* The preference still works in this tab. */ }
  }
  return { theme, setTheme }
}
