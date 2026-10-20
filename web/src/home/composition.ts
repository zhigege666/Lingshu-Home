import { t } from '../core/i18n'
import { defaultCategoryNavigationSettings, viewId } from '../core/presentation'
import type { PageConfig, Placement, Region, Slot, View } from '../core/types'

export type ChromeAreaName = 'header' | 'footer'
export type ChromeAlignment = 'left' | 'center' | 'right'
export type HomeSelection = { kind: 'page' } | { kind: 'view'; id: string } | { kind: 'chrome'; area: ChromeAreaName; alignment?: ChromeAlignment }
export type ComposerSource = { id: string; name: string; datasetId: string; schemaId: string; schemaVersion?: number; enabled?: boolean }
export const COMPOSER_PANEL_LIMIT = 32
export const panelContracts: Record<string, { schema: string; input: string }> = {
  'builtin/category-navigation': { schema: 'navigation.collection', input: 'collection' },
  'builtin/favorites': { schema: 'navigation.collection', input: 'collection' },
  'builtin/navigation': { schema: 'navigation.collection', input: 'collection' },
  'builtin/github-traffic': { schema: 'github.traffic', input: 'traffic' },
  'builtin/calendar': { schema: 'calendar.events', input: 'events' },
  'builtin/weather': { schema: 'weather.forecast', input: 'weather' },
  'builtin/metrics': { schema: 'metrics.summary', input: 'metrics' },
  'builtin/status': { schema: 'status.collection', input: 'status' }
}
const panelIds = ['builtin/search', ...Object.keys(panelContracts)]
const localSource = { id: '', name: '', datasetId: 'local-navigation', schemaId: 'navigation.collection' }
export const panelTitle = (view: Pick<View, 'panel' | 'settings'>): string => typeof view.settings.title === 'string' && view.settings.title.trim()
  ? view.settings.title : ({
    'builtin/search': t('搜索', 'Search'), 'builtin/category-navigation': t('分类导航', 'Categories'),
    'builtin/favorites': t('常用收藏', 'Favorites'), 'builtin/navigation': t('书签导航', 'Bookmarks'),
    'builtin/github-traffic': 'GitHub Traffic', 'builtin/calendar': t('日程', 'Calendar'),
    'builtin/weather': t('天气', 'Weather'), 'builtin/metrics': t('统计指标', 'Metrics'), 'builtin/status': t('服务状态', 'Service status')
  } as Record<string, string>)[view.panel.id] || view.panel.id

/** Locks apply to the whole placement entry, including an explicit narrow override. */
export function panelLocked(config: PageConfig, id: string): boolean {
  const entry = config.layout.placements[id]
  return !!entry && [entry.base, entry.overrides?.narrow].some(value => value && value.kind !== 'hidden' && value.locked)
}

function bindingFor(config: PageConfig, source: ComposerSource): string {
  const matching = Object.entries(config.bindings).find(([, binding]) => binding.datasetId === source.datasetId && !Object.keys(binding.query).length)
  if (matching) return matching[0]
  if (Object.keys(config.bindings).length >= 32) throw new Error(t('数据绑定已达到上限，请在管理中心整理后重试。', 'The data binding limit has been reached. Review bindings in admin before trying again.'))
  const preferred = source.datasetId === 'local-navigation' ? 'navigation' : 'binding-' + viewId()
  const alias = config.bindings[preferred] ? 'binding-' + viewId() : preferred
  config.bindings[alias] = { datasetId: source.datasetId, space: 'current-page-space', query: {} }
  return alias
}

function gridBottom(config: PageConfig): number {
  return Math.max(0, ...Object.values(config.layout.placements).map(entry => entry.base.kind === 'grid' ? entry.base.y + entry.base.h : 0))
}

function nextOrder(config: PageConfig, region: Region): number {
  return Math.min(10000, 1 + Math.max(-1, ...Object.values(config.layout.placements).map(entry =>
    (entry.base.kind === 'region' || entry.base.kind === 'flow') && entry.base.region === region ? entry.base.order : -1)))
}

function defaultPlacement(config: PageConfig, view: View, region?: Region): PageConfig['layout']['placements'][string] {
  const search = view.panel.id === 'builtin/search', category = view.panel.id === 'builtin/category-navigation'
  const target = region || (search || category ? 'top' : 'main')
  if (target === 'main') {
    const dataPanelIds = ['builtin/calendar', 'builtin/weather', 'builtin/metrics', 'builtin/status']
    const dataPanel = dataPanelIds.includes(view.panel.id)
    let y = gridBottom(config), x = 0
    if (dataPanel) {
      // Pair a new data card beside the last compatible half-width card,
      // without moving existing panels or leaving every second column empty.
      const neighbor = [...config.views].reverse().find(item => {
        const position = config.layout.placements[item.id]?.base
        return dataPanelIds.includes(item.panel.id) && position?.kind === 'grid' && position.x === 0 && position.w <= 12
      })
      const position = neighbor && config.layout.placements[neighbor.id]?.base
      if (position?.kind === 'grid' && !Object.values(config.layout.placements).some(entry => {
        const other = entry.base
        return other.kind === 'grid' && 12 < other.x + other.w && 24 > other.x && position.y < other.y + other.h && position.y + 3 > other.y
      })) { x = 12; y = position.y }
    }
    if (y > 10000) throw new Error(t('页面栅格已达到高度上限，请先整理现有组件。', 'The page grid has reached its height limit. Arrange the existing components first.'))
    return { base: { kind: 'grid', region: 'main', x, y, w: dataPanel ? 12 : 24, h: 3, heightMode: 'content', locked: false },
      overrides: { narrow: { kind: 'flow', region: 'main', order: Math.min(10000, config.views.length) } } }
  }
  const order = nextOrder(config, target)
  return { base: { kind: 'region', region: target, order, ...(search ? { size: { widthPx: 340, maxWidthPx: 360 } } : {}) },
    overrides: { narrow: { kind: 'region', region: target === 'left' || target === 'right' ? 'top' : target, order } } }
}

function requireSource(panelId: string, source: ComposerSource): void {
  const schema = panelContracts[panelId]?.schema
  if (source.schemaId !== schema) throw new Error(t('请选择与组件匹配的数据来源。', 'Choose a data source compatible with this component.'))
}

/** These operations only return page drafts. They never write or remove source data. */
export function addPagePanel(config: PageConfig, panelId: string, source: ComposerSource = localSource, id = viewId()): { config: PageConfig; id: string } {
  if (!panelIds.includes(panelId)) throw new Error(t('此组件暂不支持。', 'This component is not supported.'))
  if (config.views.length >= COMPOSER_PANEL_LIMIT) throw new Error(t('每页最多 32 个组件。', 'Each page supports up to 32 components.'))
  if (config.views.some(view => view.id === id)) throw new Error(t('组件标识重复，请重试。', 'The component identifier already exists. Try again.'))
  const next = structuredClone(config), search = panelId === 'builtin/search', category = panelId === 'builtin/category-navigation'
  if (!search) requireSource(panelId, source)
  const alias = search ? '' : bindingFor(next, source)
  const view: View = {
    id, panel: { id: panelId }, inputs: search ? {} : { [panelContracts[panelId]!.input]: alias },
    ...(search || source.schemaId === 'navigation.collection' ? { interactionScope: 'primary-navigation' } : {}),
    settings: category ? { ...defaultCategoryNavigationSettings } : panelId === 'builtin/navigation' ? { variant: 'cards', groupBy: 'category' }
      : panelId === 'builtin/favorites' ? { variant: 'cards' }
      : panelId === 'builtin/calendar' ? { viewMode: 'week' } : panelId === 'builtin/weather' ? { forecastDays: 5 }
      : panelId === 'builtin/metrics' ? { showBars: true } : panelId === 'builtin/status' ? { showLatency: true } : {}
  }
  next.layout.placements[id] = defaultPlacement(next, view)
  next.views.push(view)
  return { config: next, id }
}

export function removePagePanel(config: PageConfig, id: string): PageConfig {
  if (panelLocked(config, id) || !config.views.some(view => view.id === id)) return config
  const next = structuredClone(config)
  next.views = next.views.filter(view => view.id !== id)
  delete next.layout.placements[id]
  return next
}

export function duplicatePagePanel(config: PageConfig, id: string, newId = viewId()): { config: PageConfig; id: string } | null {
  const view = config.views.find(item => item.id === id)
  if (!view || panelLocked(config, id)) return null
  if (config.views.length >= COMPOSER_PANEL_LIMIT) throw new Error(t('每页最多 32 个组件。', 'Each page supports up to 32 components.'))
  if (config.views.some(item => item.id === newId)) throw new Error(t('组件标识重复，请重试。', 'The component identifier already exists. Try again.'))
  const next = structuredClone(config), copy = { ...structuredClone(view), id: newId }
  const previous = config.layout.placements[id]?.base
  const region = previous && previous.kind !== 'hidden' ? previous.region : undefined
  next.layout.placements[newId] = defaultPlacement(next, copy, region)
  if (previous?.kind === 'grid') next.layout.placements[newId]!.base = { ...previous, x: 0, y: gridBottom(config), locked: false }
  if (previous?.kind === 'hidden') next.layout.placements[newId] = { base: { kind: 'hidden' } }
  next.views.splice(next.views.findIndex(item => item.id === id) + 1, 0, copy)
  return { config: next, id: newId }
}

export function movePagePanel(config: PageConfig, id: string, slot: Slot): PageConfig {
  const view = config.views.find(item => item.id === id), current = config.layout.placements[id]?.base
  if (!view || panelLocked(config, id) || view.panel.id === 'builtin/category-navigation' && slot === 'main') return config
  if (current && (current.kind === 'hidden' ? slot === 'hidden' : current.region === slot)) return config
  const next = structuredClone(config)
  next.layout.placements[id] = slot === 'hidden' ? { base: { kind: 'hidden' } } : defaultPlacement(next, view, slot)
  return next
}

export function setPanelLock(config: PageConfig, id: string, locked: boolean): PageConfig {
  const entry = config.layout.placements[id]
  if (!entry || entry.base.kind === 'hidden') return config
  const next = structuredClone(config), placement = next.layout.placements[id]!
  if (placement.base.kind !== 'hidden') placement.base.locked = locked
  if (placement.overrides?.narrow && placement.overrides.narrow.kind !== 'hidden') placement.overrides.narrow.locked = locked
  return next
}

export function panelNeighbor(config: PageConfig, id: string, direction: -1 | 1): string | null {
  const current = config.layout.placements[id]?.base
  if (!current || current.kind === 'hidden' || panelLocked(config, id)) return null
  const siblings = config.views.filter(view => {
    const position = config.layout.placements[view.id]?.base
    return position && position.kind === current.kind && position.region === current.region
  }).sort((left, right) => {
    const a = config.layout.placements[left.id]!.base, b = config.layout.placements[right.id]!.base
    return a.kind === 'grid' && b.kind === 'grid' ? a.y - b.y || a.x - b.x : 'order' in a && 'order' in b ? a.order - b.order : 0
  })
  const neighbor = siblings[siblings.findIndex(view => view.id === id) + direction]
  return neighbor && !panelLocked(config, neighbor.id) ? neighbor.id : null
}

export function reorderPagePanel(config: PageConfig, id: string, direction: -1 | 1): PageConfig {
  const targetId = panelNeighbor(config, id, direction)
  if (!targetId) return config
  const next = structuredClone(config), current = next.layout.placements[id]!, target = next.layout.placements[targetId]!
  const a = current.base, b = target.base
  // Swap complete footprints so differently sized neighbors remain non-overlapping.
  if (a.kind === 'grid' && b.kind === 'grid') {
    const footprint = { x: a.x, y: a.y, w: a.w, h: a.h }
    Object.assign(a, { x: b.x, y: b.y, w: b.w, h: b.h }); Object.assign(b, footprint)
  } else if ('order' in a && 'order' in b) [a.order, b.order] = [b.order, a.order]
  const na = current.overrides?.narrow, nb = target.overrides?.narrow
  if (na && nb && 'order' in na && 'order' in nb && na.region === nb.region) [na.order, nb.order] = [nb.order, na.order]
  const index = next.views.findIndex(view => view.id === id), other = next.views.findIndex(view => view.id === targetId)
  ;[next.views[index], next.views[other]] = [next.views[other]!, next.views[index]!]
  return next
}

export function bindPagePanel(config: PageConfig, id: string, source: ComposerSource): PageConfig {
  const view = config.views.find(item => item.id === id)
  if (!view || view.panel.id === 'builtin/search') return config
  requireSource(view.panel.id, source)
  const next = structuredClone(config), alias = bindingFor(next, source)
  next.views.find(item => item.id === id)!.inputs = { [panelContracts[view.panel.id]!.input]: alias }
  return next
}

export function resizePagePanel(config: PageConfig, id: string, value: Partial<Pick<Extract<Placement, { kind: 'grid' }>, 'w' | 'h' | 'heightMode'>>): PageConfig {
  const position = config.layout.placements[id]?.base
  if (!position || position.kind !== 'grid' || panelLocked(config, id)) return config
  const w = value.w ?? position.w, h = value.h ?? position.h
  if (!Number.isInteger(w) || w < 1 || w > 24 || !Number.isInteger(h) || h < 1 || h > 1000) return config
  const x = Math.min(position.x, 24 - w)
  let y = position.y
  // Width/height controls have the same no-overlap guarantee as canvas dragging.
  const obstacles = Object.entries(config.layout.placements).filter(([key, entry]) => key !== id && entry.base.kind === 'grid').map(([, entry]) => entry.base as Extract<Placement, { kind: 'grid' }>)
  for (let iteration = 0; iteration <= obstacles.length; iteration++) {
    const hits = obstacles.filter(other => x < other.x + other.w && x + w > other.x && y < other.y + other.h && y + h > other.y)
    if (!hits.length) break
    y = Math.max(...hits.map(other => other.y + other.h))
  }
  if (y > 10000) throw new Error(t('组件尺寸超出了页面栅格范围。', 'The component size exceeds the page grid bounds.'))
  const next = structuredClone(config)
  next.layout.placements[id]!.base = { ...position, ...value, x, y, w, h }
  return next
}
