import { t } from './i18n'
import type { PageConfig, Region } from './types'

export type BuiltinPageThemeId = 'builtin/dashboard' | 'builtin/ios'
export type LinkAppearance = 'icon-text' | 'minimal' | 'app-icons'

export type BuiltinPageTheme = {
  readonly id: BuiltinPageThemeId
  readonly name: string
  readonly description: string
  readonly accent: string
  readonly schemaVersions: readonly number[]
  readonly colorModes: readonly PageConfig['appearance']['colorMode'][]
  readonly regions: readonly Region[]
  readonly panelIds: readonly string[]
  readonly chromeRegions: readonly ('header' | 'footer')[]
  readonly chromeAlignments: readonly ('left' | 'center' | 'right')[]
  readonly defaultLinkAppearance: LinkAppearance
}

const sharedCapabilities = {
  schemaVersions: [2],
  colorModes: ['light', 'dark', 'system'],
  regions: ['top', 'left', 'main', 'right', 'bottom'],
  panelIds: ['builtin/category-navigation', 'builtin/search', 'builtin/favorites', 'builtin/navigation', 'builtin/github-traffic', 'builtin/calendar', 'builtin/weather', 'builtin/metrics', 'builtin/status'],
  chromeRegions: ['header', 'footer'],
  chromeAlignments: ['left', 'center', 'right'],
} as const

/** Trusted, bundled page skins. This registry never loads executable theme URLs. */
export const builtinPageThemes: readonly BuiltinPageTheme[] = [
  {
    id: 'builtin/dashboard',
    get name() { return t('经典导航', 'Classic') },
    get description() { return t('清晰分组、紧凑卡片与玉绿色点缀。', 'Clear groups, compact cards and jade accents.') },
    accent: '#36785c',
    defaultLinkAppearance: 'icon-text',
    ...sharedCapabilities,
  },
  {
    id: 'builtin/ios',
    get name() { return t('iOS 风格', 'iOS inspired') },
    get description() { return t('圆角图标、轻盈层次与柔和背景。', 'Rounded app icons, light layers and a soft backdrop.') },
    accent: '#125fc6',
    defaultLinkAppearance: 'app-icons',
    ...sharedCapabilities,
  },
]

export function getPageTheme(id: string): BuiltinPageTheme | undefined {
  return builtinPageThemes.find(theme => theme.id === id)
}

/** A theme switch changes presentation only; it is not a layout preset reset. */
export function switchPageTheme(config: PageConfig, id: BuiltinPageThemeId): PageConfig {
  if (!getPageTheme(id)) throw new Error('Unsupported page theme.')
  return config.pageTheme.id === id ? config : { ...config, pageTheme: { id } }
}

/** Omitted setting follows the theme; an explicit per-panel choice survives switches. */
export function readLinkAppearance(settings: Record<string, unknown>, pageThemeId: string): LinkAppearance {
  const value = settings.linkAppearance
  return value === 'icon-text' || value === 'minimal' || value === 'app-icons'
    ? value
    : getPageTheme(pageThemeId)?.defaultLinkAppearance || 'icon-text'
}
