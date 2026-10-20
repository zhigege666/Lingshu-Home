import type { Binding, PageConfig, Placement, View } from '../core/types'
import type { ComposerSource } from './composition'

export type DashboardPresetId = 'personal-overview' | 'service-operations' | 'data-summary'
export type DashboardPresetText = Readonly<{ zh: string; en: string }>
export type DashboardPresetSlot = Readonly<{
  id: string
  title: DashboardPresetText
  renderer: string
  schema: Readonly<{ id: string; version: 1 }>
  input: string
  layout: Readonly<{ x: number; y: number; w: number; h: number }>
  defaultSettings: Readonly<Record<string, string | number | boolean>>
  optional?: boolean
  local?: boolean
}>
export type DashboardPreset = Readonly<{
  id: DashboardPresetId
  title: DashboardPresetText
  description: DashboardPresetText
  slots: readonly DashboardPresetSlot[]
}>

/** undefined means selected and awaiting a source; null explicitly omits a slot. */
export type DashboardPresetAssignments = Record<string, string | null | undefined>
export type DashboardPresetIssue = {
  code: 'unknown-preset' | 'unknown-slot' | 'source-required' | 'source-unavailable'
    | 'source-schema-mismatch' | 'source-disabled' | 'ambiguous-source'
    | 'page-limit' | 'layout-limit' | 'invalid-page'
  slotIds: string[]
  datasetId?: string
}
export type DashboardPresetWarning = {
  code: 'duplicate-metrics-source'
  slotIds: string[]
  datasetId: string
}
export type DashboardPresetCompileResult =
  | { ok: true; config: PageConfig; issues: []; warnings: DashboardPresetWarning[]; replacedViewIds: string[] }
  | { ok: false; issues: DashboardPresetIssue[]; warnings: DashboardPresetWarning[] }

const text = (zh: string, en: string): DashboardPresetText => Object.freeze({ zh, en })
function slot(value: DashboardPresetSlot): DashboardPresetSlot {
  return Object.freeze({ ...value, schema: Object.freeze(value.schema), layout: Object.freeze(value.layout), defaultSettings: Object.freeze(value.defaultSettings) })
}
function preset(value: DashboardPreset): DashboardPreset {
  return Object.freeze({ ...value, slots: Object.freeze(value.slots.map(slot)) })
}
const favorites = (y: number): DashboardPresetSlot => ({
  id: 'favorites', title: text('常用收藏', 'Favorites'), renderer: 'builtin/favorites',
  schema: { id: 'navigation.collection', version: 1 }, input: 'collection', local: true,
  layout: { x: 0, y, w: 24, h: 4 }, defaultSettings: { variant: 'cards' },
})
const navigation = (y: number, h: number): DashboardPresetSlot => ({
  id: 'navigation', title: text('书签导航', 'Bookmarks'), renderer: 'builtin/navigation',
  schema: { id: 'navigation.collection', version: 1 }, input: 'collection', local: true,
  layout: { x: 0, y, w: 24, h }, defaultSettings: { variant: 'cards', groupBy: 'category' },
})

/** Bundled layout declarations only: no datasets, endpoints, credentials or executable templates. */
export const DASHBOARD_PRESETS: readonly DashboardPreset[] = Object.freeze([
  preset({
    id: 'personal-overview', title: text('个人概览', 'Personal overview'),
    description: text('天气、日程与常用书签，适合每天打开的个人首页。', 'Weather, calendar and favorite bookmarks for a personal start page.'),
    slots: [
      { id: 'weather', title: text('天气', 'Weather'), renderer: 'builtin/weather', schema: { id: 'weather.forecast', version: 1 }, input: 'weather',
        layout: { x: 0, y: 0, w: 8, h: 8 }, defaultSettings: { forecastDays: 5 } },
      { id: 'calendar', title: text('日程', 'Calendar'), renderer: 'builtin/calendar', schema: { id: 'calendar.events', version: 1 }, input: 'events',
        layout: { x: 8, y: 0, w: 16, h: 8 }, defaultSettings: { viewMode: 'week' } },
      favorites(8), navigation(12, 12),
    ],
  }),
  preset({
    id: 'service-operations', title: text('服务运行', 'Service operations'),
    description: text('集中查看服务状态、资源指标与服务入口。', 'Service status, resource metrics and links in one place.'),
    slots: [
      { id: 'services', title: text('服务状态', 'Service status'), renderer: 'builtin/status', schema: { id: 'status.collection', version: 1 }, input: 'status',
        layout: { x: 0, y: 0, w: 16, h: 10 }, defaultSettings: { showLatency: true } },
      { id: 'resources', title: text('资源概览', 'Resource summary'), renderer: 'builtin/metrics', schema: { id: 'metrics.summary', version: 1 }, input: 'metrics',
        layout: { x: 16, y: 0, w: 8, h: 10 }, defaultSettings: { showBars: true } },
      navigation(10, 12),
    ],
  }),
  preset({
    id: 'data-summary', title: text('数据统计', 'Data summary'),
    description: text('并排查看两组统计指标，可选接入仓库访问数据。', 'Two sets of metrics side by side, with optional repository traffic.'),
    slots: [
      { id: 'overview', title: text('核心指标', 'Key metrics'), renderer: 'builtin/metrics', schema: { id: 'metrics.summary', version: 1 }, input: 'metrics',
        layout: { x: 0, y: 0, w: 12, h: 6 }, defaultSettings: { showBars: false } },
      { id: 'secondary', title: text('补充指标', 'Additional metrics'), renderer: 'builtin/metrics', schema: { id: 'metrics.summary', version: 1 }, input: 'metrics',
        layout: { x: 12, y: 0, w: 12, h: 6 }, defaultSettings: { showBars: true } },
      { id: 'traffic', title: text('仓库访问', 'Repository traffic'), renderer: 'builtin/github-traffic', schema: { id: 'github.traffic', version: 1 }, input: 'traffic', optional: true,
        layout: { x: 0, y: 6, w: 24, h: 12 }, defaultSettings: {} },
      navigation(18, 10),
    ],
  }),
])

const localSource: Readonly<ComposerSource> = Object.freeze({
  id: '', name: 'Local bookmarks', datasetId: 'local-navigation', schemaId: 'navigation.collection', schemaVersion: 1, enabled: true,
})
const validSource = (source: ComposerSource) => /^[0-9a-f]{32}$/.test(source.id) && source.datasetId === 'source:' + source.id
const findPreset = (id: string) => DASHBOARD_PRESETS.find(value => value.id === id)
const controlPanel = (view: View) => view.panel.id === 'builtin/search' || view.panel.id === 'builtin/category-navigation'
const navigationPanel = (view: View) => view.panel.id === 'builtin/navigation' || view.panel.id === 'builtin/favorites'
const effectiveScope = (view: View) => view.interactionScope || view.id
const queryKey = (query: Record<string, unknown>) => JSON.stringify(Object.keys(query).sort().map(key => [key, query[key]]))
const compatible = (source: ComposerSource, item: DashboardPresetSlot) => source.schemaId === item.schema.id && source.schemaVersion === item.schema.version
const metadata = (source: ComposerSource): ComposerSource => ({
  id: source.id, name: source.name, datasetId: source.datasetId, schemaId: source.schemaId,
  schemaVersion: source.schemaVersion, enabled: source.enabled,
})

/** The caller supplies the authorized current-space inventory, not arbitrary source objects from a template. */
export function matchingDashboardPresetSources(item: DashboardPresetSlot, sources: readonly ComposerSource[]): ComposerSource[] {
  const counts = new Map<string, number>()
  for (const source of sources) counts.set(source.datasetId, (counts.get(source.datasetId) || 0) + 1)
  const matches = sources.filter(source => validSource(source) && counts.get(source.datasetId) === 1
    && compatible(source, item) && source.enabled !== false).map(metadata)
  return compatible(localSource, item) ? [metadata(localSource), ...matches] : matches
}

/** Defaults never create a source. An unresolved required slot stays checked until chosen or explicitly omitted. */
export function createDashboardPresetAssignments(presetId: string, sources: readonly ComposerSource[], config?: PageConfig): DashboardPresetAssignments {
  const declaration = findPreset(presetId)
  if (!declaration) return {}
  return Object.fromEntries(declaration.slots.map(item => {
    if (item.optional) return [item.id, null]
    const matches = matchingDashboardPresetSources(item, sources)
    if (item.local) {
      const preferred = [item.renderer, 'builtin/navigation', 'builtin/favorites']
        .flatMap(renderer => config?.views.filter(view => view.panel.id === renderer) || [])
        .map(view => config?.bindings[view.inputs.collection || '']?.datasetId)
        .find(datasetId => matches.some(source => source.datasetId === datasetId))
      return [item.id, preferred || localSource.datasetId]
    }
    return [item.id, matches.length === 1 ? matches[0]!.datasetId : undefined]
  }))
}

function uniqueIdentifier(preferred: string, used: Set<string>): string {
  let result = preferred, suffix = 2
  while (used.has(result)) result = preferred.slice(0, 58) + '-' + suffix++
  used.add(result)
  return result
}

function validNavigationQuery(query: Record<string, unknown>): boolean {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return false
  const boundedText = (value: unknown, limit: number): value is string => typeof value === 'string' && [...value].length <= limit && !/\p{Cc}/u.test(value)
  for (const [key, value] of Object.entries(query)) {
    if (key === 'categoryIds' || key === 'tags') {
      if (!Array.isArray(value) || value.length > 100 || new Set(value).size !== value.length
        || value.some(item => !boundedText(item, key === 'tags' ? 40 : 256) || !item.length || /^\p{White_Space}|\p{White_Space}$/u.test(item))) return false
    } else if (key === 'favoritesOnly') { if (typeof value !== 'boolean') return false }
    else if (key === 'search') {
      // Server bounded() permits these three whitespace controls in search;
      // required() still rejects every control character in tags/category IDs.
      if (typeof value !== 'string' || [...value].length > 160 || /\p{Cc}/u.test(value.replace(/[\n\r\t]/g, ''))) return false
    }
    else if (key === 'sort') { if (!['sortOrder', 'title', 'updatedAt'].includes(value as string)) return false }
    else if (key === 'limit') { if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10000) return false }
    else return false
  }
  return true
}

function mainControlScope(views: readonly View[]): string {
  const groups = new Map<string, { count: number; search: boolean }>()
  for (const view of views) {
    const scope = effectiveScope(view), prior = groups.get(scope)
    groups.set(scope, { count: (prior?.count || 0) + 1, search: !!prior?.search || view.panel.id === 'builtin/search' })
  }
  // Preserve the most-connected controls. Ties prefer the customary primary
  // group, then a search group, then existing page order.
  return [...groups].sort(([left, a], [right, b]) => b.count - a.count
    || Number(right === 'primary-navigation') - Number(left === 'primary-navigation') || Number(b.search) - Number(a.search))[0]?.[0] || 'primary-navigation'
}

/**
 * Replaces component views with a new page draft; it never saves or edits source data.
 * Existing search/category controls, theme, appearance, chrome and gap are retained.
 * Existing same-dataset navigation filters/scopes survive. A changed navigation
 * source and all data components use query {}, not inferred metric projections.
 * The existing PageConfig is a current editor/server config; server validation remains authoritative.
 */
export function compileDashboardPreset(input: {
  presetId: string
  config: PageConfig
  sources: readonly ComposerSource[]
  assignments: Readonly<DashboardPresetAssignments>
  language?: 'zh-CN' | 'en'
}): DashboardPresetCompileResult {
  const { config, sources, assignments } = input
  const declaration = findPreset(input.presetId)
  const issues: DashboardPresetIssue[] = [], warnings: DashboardPresetWarning[] = []
  const fail = (code: DashboardPresetIssue['code'], slotIds: string[] = [], datasetId?: string) => {
    issues.push({ code, slotIds, ...(datasetId === undefined ? {} : { datasetId }) })
  }
  if (!declaration) return { ok: false, issues: [{ code: 'unknown-preset', slotIds: [] }], warnings }
  if (config.schemaVersion !== 2 || config.layout.mode !== 'regions-grid' || config.layout.grid.columns !== 24
    || !Number.isInteger(config.layout.gap) || config.layout.gap < 8 || config.layout.gap > 24) {
    return { ok: false, issues: [{ code: 'invalid-page', slotIds: [] }], warnings }
  }
  for (const id of Object.keys(assignments)) if (!declaration.slots.some(item => item.id === id)) fail('unknown-slot', [id])
  const selected: { item: DashboardPresetSlot; datasetId: string }[] = []
  for (const item of declaration.slots) {
    const datasetId = assignments[item.id]
    if (datasetId === null) continue
    if (typeof datasetId !== 'string' || !datasetId) { fail('source-required', [item.id]); continue }
    const matches = datasetId === localSource.datasetId ? [localSource] : sources.filter(source => source.datasetId === datasetId)
    if (matches.length > 1) { fail('ambiguous-source', [item.id], datasetId); continue }
    const source = matches[0]
    if (!source || datasetId !== localSource.datasetId && !validSource(source)) { fail('source-unavailable', [item.id], datasetId); continue }
    if (!compatible(source, item)) { fail('source-schema-mismatch', [item.id], datasetId); continue }
    if (source.enabled === false) { fail('source-disabled', [item.id], datasetId); continue }
    selected.push({ item, datasetId })
  }
  const metricGroups = new Map<string, string[]>()
  for (const { item, datasetId } of selected) if (item.schema.id === 'metrics.summary') {
    metricGroups.set(datasetId, [...(metricGroups.get(datasetId) || []), item.id])
  }
  for (const [datasetId, slotIds] of metricGroups) if (slotIds.length > 1) warnings.push({ code: 'duplicate-metrics-source', slotIds, datasetId })
  const retained = config.views.filter(controlPanel)
  if (retained.length + selected.length > 32) fail('page-limit')
  if (issues.length) return { ok: false, issues, warnings }

  const views = structuredClone(retained), bindings: Record<string, Binding> = {}, placements: PageConfig['layout']['placements'] = {}
  for (const view of views) {
    const position = config.layout.placements[view.id]
    if (!position) { fail('invalid-page'); continue }
    placements[view.id] = structuredClone(position)
    for (const alias of Object.values(view.inputs)) {
      const binding = config.bindings[alias]
      if (!binding) { fail('invalid-page'); continue }
      bindings[alias] = structuredClone(binding)
    }
  }
  if (issues.length) return { ok: false, issues, warnings }
  const usedViewIds = new Set(views.map(view => view.id)), usedAliases = new Set(Object.keys(bindings))
  const ensureBinding = (datasetId: string, item: DashboardPresetSlot, query: Record<string, unknown>) => {
    const existing = Object.entries(bindings).find(([, binding]) => binding.datasetId === datasetId
      && binding.space === 'current-page-space' && queryKey(binding.query) === queryKey(query))
    if (existing) return existing[0]
    const alias = uniqueIdentifier(datasetId === localSource.datasetId ? 'navigation' : 'preset-' + item.id, usedAliases)
    bindings[alias] = { datasetId, space: 'current-page-space', query: structuredClone(query) }
    return alias
  }
  const navigationReference = (item: DashboardPresetSlot, datasetId: string) => {
    if (item.schema.id !== 'navigation.collection') return undefined
    const candidates = config.views.filter(navigationPanel)
    return [...candidates.filter(view => view.panel.id === item.renderer), ...candidates.filter(view => view.panel.id !== item.renderer)]
      .map(view => ({ view, binding: config.bindings[view.inputs.collection || ''] }))
      .find(({ binding }) => binding?.datasetId === datasetId && binding.space === 'current-page-space')
  }
  const fallbackScope = mainControlScope(retained)

  // A search control can itself live in the main grid. Keep its footprint and
  // start new rows below it, instead of introducing an overlap in an unusual page.
  let y = Math.max(0, ...Object.values(placements).map(entry => entry.base.kind === 'grid' ? entry.base.y + entry.base.h : 0))
  let narrowOrder = Math.max(-1, ...Object.values(placements).map(entry => {
    const position = entry.overrides?.narrow || entry.base
    return position.kind !== 'hidden' && position.region === 'main' && 'order' in position ? position.order : -1
  })) + 1
  const rows = [...new Set(selected.map(value => value.item.layout.y))].sort((a, b) => a - b)
  for (const row of rows) {
    const items = selected.filter(value => value.item.layout.y === row).sort((a, b) => a.item.layout.x - b.item.layout.x)
    const height = Math.max(...items.map(value => value.item.layout.h))
    for (const { item, datasetId } of items) {
      if (y > 10000 || narrowOrder > 10000) { fail('layout-limit', [item.id]); continue }
      const reference = navigationReference(item, datasetId), query = reference ? reference.binding.query : {}
      if (!validNavigationQuery(query)) { fail('invalid-page', [item.id]); continue }
      const id = uniqueIdentifier('preset-' + declaration.id + '-' + item.id, usedViewIds)
      const alias = ensureBinding(datasetId, item, query)
      views.push({
        id, panel: { id: item.renderer }, inputs: { [item.input]: alias },
        ...(item.schema.id === 'navigation.collection' ? { interactionScope: reference ? effectiveScope(reference.view) : fallbackScope } : {}),
        settings: { ...item.defaultSettings, title: input.language === 'zh-CN' ? item.title.zh : item.title.en },
      })
      const base: Placement = { kind: 'grid', region: 'main', x: items.length === 1 ? 0 : item.layout.x,
        y, w: items.length === 1 ? 24 : item.layout.w, h: item.layout.h, heightMode: 'content', locked: false }
      placements[id] = { base, overrides: { narrow: { kind: 'flow', region: 'main', order: narrowOrder++ } } }
    }
    y += height
  }
  if (Object.keys(bindings).length > 32) fail('page-limit')
  if (issues.length) return { ok: false, issues, warnings }
  const next: PageConfig = {
    schemaVersion: 2, pageTheme: structuredClone(config.pageTheme), appearance: structuredClone(config.appearance),
    ...(config.chrome === undefined ? {} : { chrome: structuredClone(config.chrome) }),
    bindings, views, layout: { mode: 'regions-grid', gap: config.layout.gap, grid: { columns: 24 }, placements },
  }
  // encoding/json.Marshal escapes HTML-sensitive characters and both Unicode
  // line separators. Match the server's 64 KiB accounting, not just JSON.stringify.
  const encoded = JSON.stringify(next).replace(/[<>&\u2028\u2029]/g, value => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0'))
  if (new TextEncoder().encode(encoded).length > 64 * 1024) {
    return { ok: false, issues: [{ code: 'page-limit', slotIds: [] }], warnings }
  }
  return { ok: true, config: next, issues: [], warnings, replacedViewIds: config.views.filter(view => !controlPanel(view)).map(view => view.id) }
}
