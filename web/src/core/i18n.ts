export type AppLanguage = 'zh-CN' | 'en'

// One language belongs to the running instance. No browser preference or UI
// switch overrides the server's startup configuration.
let language: AppLanguage = typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('en') ? 'en' : 'zh-CN'

export function configureLanguage(value: string | undefined): void {
  language = value === 'en' ? 'en' : 'zh-CN'
  if (typeof document !== 'undefined') document.documentElement.lang = language
}

export function getLocale(): AppLanguage { return language }

export function t(chinese: string, english: string, values: Record<string, string | number> = {}): string {
  const text = language === 'en' ? english : chinese
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match)
}
