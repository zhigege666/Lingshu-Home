import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DASHBOARD_PRESETS,
  matchingDashboardPresetSources,
  createDashboardPresetAssignments,
  compileDashboardPreset,
} from '../web/src/home/dashboard-presets.ts'

// Node 24 strips this dependency-free TypeScript module. All source metadata
// and page configs below are in-memory fixtures; no source, network or storage
// operation is performed by either the presets or this test suite.
const source = (number, schemaId, extra = {}) => {
  const id = number.toString(16).padStart(32, '0')
  return { id, datasetId: 'source:' + id, name: 'Fixture source ' + number, schemaId, schemaVersion: 1, enabled: true, ...extra }
}
const inventory = [
  source(1, 'weather.forecast'), source(2, 'calendar.events'), source(3, 'status.collection'),
  source(4, 'metrics.summary'), source(5, 'metrics.summary'), source(6, 'github.traffic'),
]
const bySchema = schema => inventory.find(item => item.schemaId === schema)
const declaration = id => DASHBOARD_PRESETS.find(item => item.id === id)
const placement = (x, y, w, h) => ({ base: { kind: 'grid', region: 'main', x, y, w, h, heightMode: 'content', locked: false } })
function page() {
  return {
    schemaVersion: 2, pageTheme: { id: 'builtin/ios' }, appearance: { colorMode: 'dark', density: 'compact' },
    chrome: {
      header: { enabled: true, left: [{ id: 'welcome', type: 'text', text: 'My existing header' }], center: [], right: [] },
      footer: { enabled: false, left: [], center: [], right: [{ id: 'footer-brand', type: 'branding' }] },
    },
    bindings: {
      navigation: { datasetId: 'local-navigation', space: 'current-page-space', query: {} },
      unused: { datasetId: source(99, 'metrics.summary').datasetId, space: 'current-page-space', query: {} },
    },
    views: [
      { id: 'categories', panel: { id: 'builtin/category-navigation' }, inputs: { collection: 'navigation' }, interactionScope: 'primary-navigation', settings: { displayMode: 'text', showCounts: false } },
      { id: 'search', panel: { id: 'builtin/search' }, inputs: {}, interactionScope: 'primary-navigation', settings: { title: 'Find my links' } },
      { id: 'old-favorites', panel: { id: 'builtin/favorites' }, inputs: { collection: 'navigation' }, interactionScope: 'primary-navigation', settings: { variant: 'directory' } },
      { id: 'old-navigation', panel: { id: 'builtin/navigation' }, inputs: { collection: 'navigation' }, interactionScope: 'primary-navigation', settings: { variant: 'directory', groupBy: 'category' } },
    ],
    layout: { mode: 'regions-grid', gap: 12, grid: { columns: 24 }, placements: {
      categories: { base: { kind: 'region', region: 'left', order: 1, sticky: true, locked: true }, overrides: { narrow: { kind: 'region', region: 'top', order: 1, locked: true } } },
      search: { base: { kind: 'region', region: 'top', order: 0, size: { widthPx: 320, maxWidthPx: 360 } } },
      'old-favorites': placement(0, 0, 24, 4), 'old-navigation': placement(0, 4, 24, 12),
    } },
  }
}
function assignments(id, sources = inventory, config = page()) {
  const values = createDashboardPresetAssignments(id, sources, config)
  for (const item of declaration(id).slots) {
    if (!item.local && !item.optional) values[item.id] = sources.find(value => value.schemaId === item.schema.id && value.schemaVersion === 1)?.datasetId
  }
  if (id === 'data-summary') values.secondary = sources.filter(value => value.schemaId === 'metrics.summary')[1]?.datasetId || values.overview
  return values
}
function compile(id = 'personal-overview', options = {}) {
  const config = options.config || page(), sources = options.sources || inventory
  return compileDashboardPreset({ presetId: id, config, sources, assignments: assignments(id, sources, config), language: 'en', ...options })
}
function compiled(id, options) {
  const result = compile(id, options)
  assert.equal(result.ok, true, JSON.stringify(result.issues))
  return result
}
const panel = (config, id) => config.views.find(item => item.id.includes('-' + id) && item.id.startsWith('preset-'))
const panelPosition = (config, id) => config.layout.placements[panel(config, id).id].base
function assertLinkedConfig(config) {
  assert.equal(config.schemaVersion, 2)
  assert.equal(config.layout.mode, 'regions-grid')
  assert.deepEqual(config.layout.grid, { columns: 24 })
  assert.equal(new Set(config.views.map(view => view.id)).size, config.views.length)
  assert.deepEqual(Object.keys(config.layout.placements).sort(), config.views.map(view => view.id).sort())
  assert.ok(config.views.length <= 32 && Object.keys(config.bindings).length <= 32)
  const used = new Set()
  for (const view of config.views) {
    assert.match(view.id, /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/)
    for (const alias of Object.values(view.inputs)) {
      assert.ok(Object.hasOwn(config.bindings, alias))
      used.add(alias)
    }
  }
  assert.deepEqual(Object.keys(config.bindings).sort(), [...used].sort(), 'No orphan bindings')
  for (const [alias, binding] of Object.entries(config.bindings)) {
    assert.match(alias, /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/)
    assert.match(binding.datasetId, /^(local-navigation|source:[0-9a-f]{32})$/)
    assert.equal(binding.space, 'current-page-space')
  }
  for (const narrow of [false, true]) {
    const rectangles = Object.values(config.layout.placements).map(item => narrow ? item.overrides?.narrow || item.base : item.base).filter(item => item.kind === 'grid')
    for (const [index, rect] of rectangles.entries()) {
      for (const key of ['x', 'y', 'w', 'h']) assert.ok(Number.isInteger(rect[key]))
      assert.ok(rect.x >= 0 && rect.x + rect.w <= 24 && rect.w >= 1 && rect.y >= 0 && rect.y <= 10000 && rect.h >= 1 && rect.h <= 1000)
      for (const other of rectangles.slice(index + 1)) assert.ok(!(rect.x < other.x + other.w && rect.x + rect.w > other.x && rect.y < other.y + other.h && rect.y + rect.h > other.y), 'Grid rectangles do not overlap')
    }
  }
}
function deepFreeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value) }
  return value
}

test('catalog contains exactly three immutable layout declarations with no runtime data or connections', () => {
  assert.deepEqual(DASHBOARD_PRESETS.map(item => item.id), ['personal-overview', 'service-operations', 'data-summary'])
  const contracts = {
    'builtin/weather': ['weather.forecast', 'weather'], 'builtin/calendar': ['calendar.events', 'events'],
    'builtin/status': ['status.collection', 'status'], 'builtin/metrics': ['metrics.summary', 'metrics'],
    'builtin/github-traffic': ['github.traffic', 'traffic'], 'builtin/favorites': ['navigation.collection', 'collection'],
    'builtin/navigation': ['navigation.collection', 'collection'],
  }
  for (const preset of DASHBOARD_PRESETS) {
    assert.ok(Object.isFrozen(preset) && Object.isFrozen(preset.slots))
    assert.deepEqual(Object.keys(preset).sort(), ['description', 'id', 'slots', 'title'])
    for (const item of preset.slots) {
      assert.ok(Object.isFrozen(item) && Object.isFrozen(item.defaultSettings) && Object.isFrozen(item.layout))
      assert.deepEqual([item.schema.id, item.input], contracts[item.renderer])
      assert.equal(item.schema.version, 1)
      assert.ok(item.title.zh && item.title.en)
      assert.ok(Object.keys(item).every(key => ['id', 'title', 'renderer', 'schema', 'input', 'layout', 'defaultSettings', 'optional', 'local'].includes(key)))
    }
  }
  assert.doesNotMatch(JSON.stringify(DASHBOARD_PRESETS), /https?:|datasetId|credential|bearerToken|sourceUrl|"data"/)
})

test('defaults keep missing required slots selected, local navigation ready and optional traffic omitted', () => {
  assert.deepEqual(createDashboardPresetAssignments('personal-overview', []), {
    weather: undefined, calendar: undefined, favorites: 'local-navigation', navigation: 'local-navigation',
  })
  const data = createDashboardPresetAssignments('data-summary', inventory)
  assert.equal(data.overview, undefined, 'Multiple metric sources require an explicit choice')
  assert.equal(data.secondary, undefined)
  assert.equal(data.traffic, null, 'Even an existing traffic source does not enable the optional widget')
  assert.equal(createDashboardPresetAssignments('service-operations', inventory).services, bySchema('status.collection').datasetId)
  assert.deepEqual(createDashboardPresetAssignments('unknown', inventory), {})
})

test('candidate inventory requires canonical real IDs, exact schema@1 and an enabled source', () => {
  const item = declaration('service-operations').slots[1]
  const good = source(30, 'metrics.summary', { connection: { url: 'https://private.example/' }, secret: 'must-not-copy' })
  const candidates = [
    good, source(31, 'metrics.summary', { schemaVersion: 2 }), source(32, 'metrics.summary', { schemaVersion: undefined }),
    source(33, 'metrics.summary', { enabled: false }), source(34, 'status.collection'), source(35, 'metrics.summary', { datasetId: 'source:invented' }),
  ]
  const matches = matchingDashboardPresetSources(item, candidates)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].datasetId, good.datasetId)
  assert.equal('connection' in matches[0], false)
  assert.equal('secret' in matches[0], false)
  assert.deepEqual(matchingDashboardPresetSources(item, [good, good]), [], 'Ambiguous inventory does not guess')
  const local = matchingDashboardPresetSources(declaration('personal-overview').slots[3], [{ ...good, datasetId: 'local-navigation', schemaId: 'metrics.summary' }])
  assert.equal(local.length, 1)
  assert.equal(local[0].schemaId, 'navigation.collection', 'Built-in local schema cannot be spoofed by supplied metadata')
  assert.equal(local[0].schemaVersion, 1)
})

test('personal preset compiles correct binding inputs, exact desktop footprints and narrow flow', () => {
  const { config } = compiled('personal-overview', { language: 'zh-CN' })
  assertLinkedConfig(config)
  assert.deepEqual(['weather', 'calendar', 'favorites', 'navigation'].map(id => {
    const value = panelPosition(config, id)
    return [value.x, value.y, value.w, value.h]
  }), [[0, 0, 8, 8], [8, 0, 16, 8], [0, 8, 24, 4], [0, 12, 24, 12]])
  for (const [index, item] of declaration('personal-overview').slots.entries()) {
    const view = panel(config, item.id), position = config.layout.placements[view.id]
    assert.deepEqual(Object.keys(view.inputs), [item.input])
    assert.equal(view.settings.title, item.title.zh)
    assert.equal(position.base.heightMode, 'content')
    assert.equal(position.base.locked, false)
    assert.deepEqual(position.overrides.narrow, { kind: 'flow', region: 'main', order: index })
  }
  assert.equal(panel(config, 'favorites').inputs.collection, 'navigation')
  assert.equal(panel(config, 'navigation').inputs.collection, 'navigation')
  assert.deepEqual(Object.keys(config.bindings).sort(), ['navigation', 'preset-calendar', 'preset-weather'])
})

test('service and data presets produce built-in schema-compatible views with no placeholder renderer', () => {
  for (const id of ['service-operations', 'data-summary']) {
    const selected = assignments(id)
    if (id === 'data-summary') selected.traffic = bySchema('github.traffic').datasetId
    const { config } = compiled(id, { assignments: selected })
    assertLinkedConfig(config)
    for (const item of declaration(id).slots) {
      const view = panel(config, item.id), binding = config.bindings[view.inputs[item.input]]
      assert.equal(view.panel.id, item.renderer)
      assert.equal(binding.datasetId, selected[item.id])
      assert.deepEqual(binding.query, {})
      assert.equal(view.template, undefined)
      assert.equal(view.settings.title, item.title.en)
    }
  }
})

test('an unbound selected slot blocks the entire draft and does not invent a source', () => {
  const config = page(), before = structuredClone(config)
  const result = compile('personal-overview', { config, sources: [], assignments: createDashboardPresetAssignments('personal-overview', []) })
  assert.equal(result.ok, false)
  assert.equal('config' in result, false)
  assert.deepEqual(result.issues.map(item => [item.code, ...item.slotIds]), [['source-required', 'weather'], ['source-required', 'calendar']])
  assert.deepEqual(config, before)
})

test('unknown, incompatible, future-version, disabled and ambiguous assignments fail before draft output', () => {
  const weather = bySchema('weather.forecast')
  const cases = [
    { sources: [], value: weather.datasetId, code: 'source-unavailable' },
    { sources: inventory, value: bySchema('calendar.events').datasetId, code: 'source-schema-mismatch' },
    { sources: [{ ...weather, schemaVersion: 2 }], value: weather.datasetId, code: 'source-schema-mismatch' },
    { sources: [{ ...weather, schemaVersion: undefined }], value: weather.datasetId, code: 'source-schema-mismatch' },
    { sources: [{ ...weather, enabled: false }], value: weather.datasetId, code: 'source-disabled' },
    { sources: [weather, weather], value: weather.datasetId, code: 'ambiguous-source' },
    { sources: [{ ...weather, datasetId: 'source:not-an-id' }], value: 'source:not-an-id', code: 'source-unavailable' },
    { sources: inventory, value: 'local-navigation', code: 'source-schema-mismatch' },
  ]
  for (const item of cases) {
    const result = compile('personal-overview', { sources: item.sources, assignments: { weather: item.value, calendar: null, favorites: null, navigation: null } })
    assert.equal(result.ok, false)
    assert.equal('config' in result, false)
    assert.deepEqual(result.issues, [{ code: item.code, slotIds: ['weather'], datasetId: item.value }])
  }
})

test('unknown preset and unknown slot keys are rejected instead of being silently ignored', () => {
  const input = { config: page(), sources: inventory, assignments: {} }
  assert.equal(compileDashboardPreset({ ...input, presetId: 'future-preset' }).issues[0].code, 'unknown-preset')
  const result = compile('personal-overview', { assignments: { ...assignments('personal-overview'), 'remote-widget': null } })
  assert.equal(result.ok, false)
  assert.deepEqual(result.issues, [{ code: 'unknown-slot', slotIds: ['remote-widget'] }])
})

test('omitted optional traffic leaves no view, binding or placement and removes its empty row', () => {
  const { config } = compiled('data-summary')
  assertLinkedConfig(config)
  assert.equal(config.views.some(view => view.panel.id === 'builtin/github-traffic'), false)
  assert.equal(Object.keys(config.layout.placements).some(id => id.endsWith('-traffic')), false)
  assert.equal(Object.values(config.bindings).some(binding => binding.datasetId === bySchema('github.traffic').datasetId), false)
  assert.equal(panelPosition(config, 'navigation').y, 6)
  const selected = { ...assignments('data-summary'), traffic: undefined }
  assert.deepEqual(compile('data-summary', { assignments: selected }).issues, [{ code: 'source-required', slotIds: ['traffic'] }], 'A newly checked optional slot also needs a real source')
})

test('omitted required components compact rows and a remaining row component fills the 24-column width', () => {
  const { config } = compiled('personal-overview', { assignments: { weather: null, calendar: bySchema('calendar.events').datasetId, favorites: null, navigation: 'local-navigation' } })
  assertLinkedConfig(config)
  assert.deepEqual(panelPosition(config, 'calendar'), { kind: 'grid', region: 'main', x: 0, y: 0, w: 24, h: 8, heightMode: 'content', locked: false })
  assert.equal(panelPosition(config, 'navigation').y, 8)
  assert.equal(config.views.some(view => view.panel.id === 'builtin/weather' || view.panel.id === 'builtin/favorites'), false)
  const onlyNavigation = compiled('data-summary', { assignments: { overview: null, secondary: null, traffic: null, navigation: 'local-navigation' } }).config
  assert.equal(panelPosition(onlyNavigation, 'navigation').y, 0)
})

test('current theme, appearance, header, footer, spacing and search/category controls survive replacement', () => {
  const original = page()
  original.bindings.categorySubset = { datasetId: 'local-navigation', space: 'current-page-space', query: { categoryIds: ['a'.repeat(32)] } }
  original.views[0].inputs.collection = 'categorySubset'
  const result = compiled('service-operations', { config: original })
  for (const key of ['pageTheme', 'appearance', 'chrome']) assert.deepEqual(result.config[key], original[key])
  assert.equal(result.config.layout.gap, 12)
  for (const view of original.views.slice(0, 2)) {
    assert.deepEqual(result.config.views.find(item => item.id === view.id), view)
    assert.deepEqual(result.config.layout.placements[view.id], original.layout.placements[view.id])
  }
  assert.deepEqual(result.config.bindings.categorySubset, original.bindings.categorySubset)
  assert.deepEqual(result.config.bindings.navigation.query, {}, 'New full collection must not reuse a filtered control binding')
  assert.deepEqual(result.replacedViewIds, ['old-favorites', 'old-navigation'])
  assert.equal('unused' in result.config.bindings, false)
  assertLinkedConfig(result.config)
})

test('same-dataset navigation keeps its existing filtered collection and interaction group', () => {
  const current = page()
  current.bindings.navigation.query = { tags: ['ops'], limit: 5, search: 'server', sort: 'title', favoritesOnly: false }
  for (const view of current.views) view.interactionScope = 'ops'
  const before = structuredClone(current)
  const { config } = compiled('personal-overview', { config: deepFreeze(current) })
  for (const id of ['favorites', 'navigation']) {
    const view = panel(config, id)
    assert.equal(view.interactionScope, 'ops')
    assert.deepEqual(config.bindings[view.inputs.collection].query, before.bindings.navigation.query)
    assert.equal(view.inputs.collection, 'navigation', 'Existing control and same-query views share the real filtered binding')
  }
  assert.deepEqual(current, before)
  config.bindings.navigation.query.tags.push('later-draft')
  assert.deepEqual(current.bindings.navigation.query.tags, ['ops'])
})

test('corresponding navigation and favorites references win over another panel using the same dataset', () => {
  const current = page()
  current.bindings.navigation.query = { tags: ['navigation'], limit: 5 }
  current.bindings.favorites = { datasetId: 'local-navigation', space: 'current-page-space', query: { tags: ['favorites'], favoritesOnly: true } }
  current.views[2].inputs.collection = 'favorites'; current.views[2].interactionScope = 'favorites-group'
  current.views[3].interactionScope = 'navigation-group'
  const { config } = compiled('personal-overview', { config: current })
  for (const [id, query, scope] of [['favorites', current.bindings.favorites.query, 'favorites-group'], ['navigation', current.bindings.navigation.query, 'navigation-group']]) {
    const view = panel(config, id)
    assert.deepEqual(config.bindings[view.inputs.collection].query, query)
    assert.equal(view.interactionScope, scope)
  }
  assert.notEqual(panel(config, 'favorites').inputs.collection, panel(config, 'navigation').inputs.collection)
})

test('changing navigation source does not copy old filters and joins the retained main control group', () => {
  const current = page(), remote = source(43, 'navigation.collection')
  current.bindings.navigation.query = { tags: ['only-old-source'], categoryIds: ['old-category'], limit: 5 }
  current.views[0].interactionScope = 'ops'; current.views[1].interactionScope = 'ops'
  const selected = { ...assignments('personal-overview'), navigation: remote.datasetId }
  const { config } = compiled('personal-overview', { config: current, sources: [...inventory, remote], assignments: selected })
  const changed = panel(config, 'navigation'), unchanged = panel(config, 'favorites')
  assert.deepEqual(config.bindings[changed.inputs.collection], { datasetId: remote.datasetId, space: 'current-page-space', query: {} })
  assert.equal(changed.interactionScope, 'ops')
  assert.deepEqual(config.bindings[unchanged.inputs.collection].query, current.bindings.navigation.query)
  for (const view of config.views.filter(view => ['builtin/calendar', 'builtin/weather'].includes(view.panel.id))) {
    assert.deepEqual(config.bindings[Object.values(view.inputs)[0]].query, {})
    assert.equal('interactionScope' in view, false)
  }
})

test('a borrowed same-dataset reference retains its effective independent scope; without a reference only controls supply the group', () => {
  const current = page()
  current.views = current.views.filter(view => view.panel.id !== 'builtin/navigation')
  delete current.layout.placements['old-navigation']
  delete current.views.find(view => view.panel.id === 'builtin/favorites').interactionScope
  current.bindings.navigation.query = { limit: 3 }
  const borrowed = compiled('service-operations', { config: current }).config
  assert.equal(panel(borrowed, 'navigation').interactionScope, 'old-favorites')
  assert.deepEqual(borrowed.bindings[panel(borrowed, 'navigation').inputs.collection].query, { limit: 3 })
  current.views = current.views.filter(view => view.panel.id !== 'builtin/favorites')
  delete current.layout.placements['old-favorites']
  for (const view of current.views) view.interactionScope = 'custom-controls'
  const fresh = compiled('service-operations', { config: current }).config
  const newNavigation = panel(fresh, 'navigation')
  assert.equal(newNavigation.interactionScope, 'custom-controls')
  assert.deepEqual(fresh.bindings[newNavigation.inputs.collection].query, {}, 'A category control alone is not a navigation query reference')
})

test('invalid existing navigation queries are rejected instead of silently broadening the displayed collection', () => {
  for (const query of [{ tags: ['duplicate', 'duplicate'] }, { tags: [' leading-space'] }, { tags: ['alpha\nbeta'] }, { categoryIds: [42] }, { search: 'alpha\u000bbeta' }, { limit: 0 }, { unknownField: true }]) {
    const current = page(); current.bindings.navigation.query = query
    const result = compile('service-operations', { config: current })
    assert.equal(result.ok, false)
    assert.deepEqual(result.issues, [{ code: 'invalid-page', slotIds: ['navigation'] }])
  }
})

test('navigation search preserves the newline, tab and carriage return accepted by the server', () => {
  const current = page(), query = { search: 'alpha\nbeta\tgamma\rdelta' }
  current.bindings.navigation.query = query
  const { config } = compiled('service-operations', { config: current })
  assert.deepEqual(config.bindings[panel(config, 'navigation').inputs.collection].query, query)
})

test('navigation defaults preserve compatible existing navigation/favorites data and fall back to local only when unavailable', () => {
  const remote = source(40, 'navigation.collection'), other = source(41, 'navigation.collection')
  const current = page()
  current.bindings.remote = { datasetId: remote.datasetId, space: 'current-page-space', query: {} }
  current.bindings.other = { datasetId: other.datasetId, space: 'current-page-space', query: {} }
  current.views[2].inputs.collection = 'other'
  current.views[3].inputs.collection = 'remote'
  const selected = createDashboardPresetAssignments('personal-overview', [...inventory, remote, other], current)
  assert.equal(selected.navigation, remote.datasetId)
  assert.equal(selected.favorites, other.datasetId)
  const result = compiled('personal-overview', { config: current, sources: [...inventory, remote, other], assignments: selected })
  assert.equal(result.config.bindings[panel(result.config, 'navigation').inputs.collection].datasetId, remote.datasetId)
  current.views = current.views.filter(view => view.panel.id !== 'builtin/favorites')
  assert.equal(createDashboardPresetAssignments('personal-overview', [remote], current).favorites, remote.datasetId, 'A newly added favorites view can use the existing bookmark collection')
  for (const sources of [[], [{ ...remote, enabled: false }], [{ ...remote, schemaVersion: 2 }]]) {
    assert.equal(createDashboardPresetAssignments('service-operations', sources, current).navigation, 'local-navigation')
  }
})

test('two metrics slots bound to the same source share one complete binding and return an explicit warning', () => {
  const shared = bySchema('metrics.summary').datasetId
  const result = compiled('data-summary', { assignments: { overview: shared, secondary: shared, traffic: null, navigation: 'local-navigation' } })
  assertLinkedConfig(result.config)
  const views = result.config.views.filter(view => view.panel.id === 'builtin/metrics')
  assert.equal(views.length, 2)
  assert.equal(views[0].inputs.metrics, views[1].inputs.metrics)
  assert.deepEqual(result.config.bindings[views[0].inputs.metrics].query, {})
  assert.deepEqual(views.map(view => view.settings.showBars), [false, true])
  assert.deepEqual(result.warnings, [{ code: 'duplicate-metrics-source', slotIds: ['overview', 'secondary'], datasetId: shared }])
  assert.deepEqual(compiled('data-summary').warnings, [], 'Different sources are not described as duplicates')
})

test('generated IDs and aliases cannot collide with retained controls or filtered bindings', () => {
  const current = page(), collision = 'preset-personal-overview-weather'
  current.views[1].id = collision
  current.layout.placements[collision] = current.layout.placements.search
  delete current.layout.placements.search
  current.views[0].inputs.collection = 'preset-weather'
  current.bindings['preset-weather'] = current.bindings.navigation
  const result = compiled('personal-overview', { config: current })
  assertLinkedConfig(result.config)
  assert.equal(result.config.views.find(view => view.panel.id === 'builtin/weather').id, collision + '-2')
  const weather = result.config.views.find(view => view.panel.id === 'builtin/weather')
  assert.equal(weather.inputs.weather, 'preset-weather-2')
  assert.equal(result.config.bindings['preset-weather'].datasetId, 'local-navigation')
})

test('an existing search footprint in the main grid remains non-overlapping and narrow order follows retained controls', () => {
  const current = page()
  current.layout.placements.search = { ...placement(0, 5, 24, 3), overrides: { narrow: { kind: 'flow', region: 'main', order: 10 } } }
  const { config } = compiled('personal-overview', { config: current })
  assertLinkedConfig(config)
  assert.equal(panelPosition(config, 'weather').y, 8)
  assert.equal(config.layout.placements[panel(config, 'weather').id].overrides.narrow.order, 11)
})

test('all slots can be explicitly omitted without leaving phantom components or source bindings', () => {
  const selected = Object.fromEntries(declaration('personal-overview').slots.map(item => [item.id, null]))
  const { config } = compiled('personal-overview', { sources: [], assignments: selected })
  assertLinkedConfig(config)
  assert.deepEqual(config.views.map(view => view.id), ['categories', 'search'])
  assert.deepEqual(Object.keys(config.bindings), ['navigation'])
})

test('compilation is detached from every input and does not copy connection metadata or invent snapshots', () => {
  const config = deepFreeze(page()), sources = deepFreeze(inventory.map(item => ({ ...item, connection: { url: 'https://service.example/private' }, secret: { password: 'fixture-secret' }, lastSuccessAt: null, revision: '0' })))
  const selected = deepFreeze(assignments('personal-overview', sources, config))
  const before = JSON.stringify({ config, sources, selected, catalog: DASHBOARD_PRESETS })
  const result = compiled('personal-overview', { config, sources, assignments: selected })
  assert.equal(result.ok, true, 'A real configured source can await its first snapshot')
  const serialized = JSON.stringify(result.config)
  assert.doesNotMatch(serialized, /fixture-secret|service\.example|lastSuccessAt|"revision"|"datasets"|"data"/)
  result.config.chrome.header.left[0].text = 'Changed in a later draft'
  result.config.views[0].settings.showCounts = true
  result.config.layout.placements.categories.base.sticky = false
  result.config.bindings.navigation.query.test = true
  panel(result.config, 'weather').settings.forecastDays = 7
  assert.equal(JSON.stringify({ config, sources, selected, catalog: DASHBOARD_PRESETS }), before)
  assert.notEqual(compiled('personal-overview').config.views[0].settings.showCounts, true)
})

test('page view, layout and serialized-size limits return errors instead of invalid drafts', () => {
  const crowded = page()
  for (let index = 0; index < 28; index++) {
    const id = 'extra-search-' + index
    crowded.views.push({ id, panel: { id: 'builtin/search' }, inputs: {}, settings: {} })
    crowded.layout.placements[id] = { base: { kind: 'hidden' } }
  }
  assert.equal(compile('personal-overview', { config: crowded }).issues[0].code, 'page-limit')
  for (const position of [placement(0, 10000, 24, 3), { base: { kind: 'flow', region: 'main', order: 10000 } }]) {
    const current = page()
    current.layout.placements.search = position
    assert.equal(compile('personal-overview', { config: current }).issues[0].code, 'layout-limit')
  }
  const oversized = page()
  oversized.chrome.header.left[0].text = '字'.repeat(23000)
  const result = compile('personal-overview', { config: oversized })
  assert.equal(result.ok, false)
  assert.equal(result.issues[0].code, 'page-limit')
})

test('64 KiB accounting includes Go JSON HTML escaping instead of trusting a much smaller browser JSON size', () => {
  const goBytes = value => Buffer.byteLength(JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')))
  const current = page()
  current.bindings.navigation.query = { categoryIds: Array.from({ length: 100 }, (_, index) => '&'.repeat(105) + index) }
  assert.ok(goBytes(current) <= 65536, 'Existing fixture config remains below the server limit: ' + goBytes(current))
  const result = compile('personal-overview', { config: current })
  assert.equal(result.ok, false, 'Additional components must not produce a server-rejected page')
  assert.deepEqual(result.issues, [{ code: 'page-limit', slotIds: [] }])
  const plain = structuredClone(current)
  plain.bindings.navigation.query.categoryIds = plain.bindings.navigation.query.categoryIds.map(value => value.replaceAll('&', 'a'))
  const accepted = compiled('personal-overview', { config: plain }).config
  for (const binding of Object.values(accepted.bindings)) if (binding.query.categoryIds) binding.query.categoryIds = current.bindings.navigation.query.categoryIds
  assert.ok(Buffer.byteLength(JSON.stringify(accepted)) < 65536, 'The old browser-only byte check would have incorrectly accepted this config')
  assert.ok(goBytes(accepted) > 65536, 'Go encoding/json expands the same config past its limit')
})

test('unsupported page schema and grid variants are not silently rewritten', () => {
  for (const mutate of [value => { value.schemaVersion = 3 }, value => { value.layout.grid.columns = 12 }, value => { value.layout.mode = 'unknown' }, value => { value.layout.gap = 25 }]) {
    const config = page(); mutate(config)
    const result = compile('personal-overview', { config })
    assert.equal(result.ok, false)
    assert.equal(result.issues[0].code, 'invalid-page')
  }
})

test('legacy pages without chrome remain without a synthesized header or footer', () => {
  const config = page(); delete config.chrome
  const result = compiled('service-operations', { config })
  assert.equal('chrome' in result.config, false)
})
