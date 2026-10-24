import { lazy, Suspense, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, Eye, EyeOff, Layers, LockKeyhole, Plus, Redo2, Trash2, Undo2 } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { useUnsavedChanges } from '../core/useUnsavedChanges'
import { createDraftHistory, inputHistoryGroup, recordDraft, redoDraft, undoDraft } from '../core/draft-history'
import { useHistoryShortcuts } from '../core/useHistoryShortcuts'
import { builtinPageThemes, switchPageTheme, type BuiltinPageThemeId } from '../core/themes'
import { categoryPosition, panelTypes, presetConfig, readCategoryNavigationSettings, setCategoryPosition, viewId } from '../core/presentation'
import type { Bootstrap, Dashboard, Page, PageConfig, Placement, Region, View } from '../core/types'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Input } from '../components/ui/input'
import { StyledSelect } from '../components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Empty, ErrorMessage, Field, handleFormInvalid, Modal } from '../components/Shared'
import { InteractionScopeEditor } from './InteractionScopeEditor'
import { PageChromeEditor, validatePageChrome, type ChromeValidationIssue } from './PageChromeEditor'
import { PagePreview } from './PagePreview'
import { addPagePanel, bindPagePanel, panelContracts, panelTitle } from '../home/composition'
const DiscardChangesDialog = lazy(() => import('../components/DiscardChangesDialog'))

type Source = { id: string; name: string; datasetId: string; schemaId: string }
type Preset = 'grouped-cards' | 'dense-directory'
const clone = <T,>(value: T): T => structuredClone(value)
const linkingPanels = ['builtin/search', 'builtin/category-navigation', 'builtin/navigation', 'builtin/favorites']
function regionOptions() {
  return [
    { value: 'top', label: t('顶部区域', 'Top region') },
    { value: 'left', label: t('左侧区域', 'Left region') },
    { value: 'main', label: t('主体栅格', 'Main grid') },
    { value: 'right', label: t('右侧区域', 'Right region') },
    { value: 'bottom', label: t('底部区域', 'Bottom region') },
    { value: 'hidden', label: t('隐藏', 'Hidden') }
  ]
}
function panelName(view: Pick<View, 'panel'>) {
  const names: Record<string, string> = {
    'builtin/category-navigation': t('分类导航', 'Category navigation'),
    'builtin/search': t('搜索框', 'Search'),
    'builtin/favorites': t('常用收藏', 'Favorites'),
    'builtin/navigation': t('导航链接', 'Navigation links'),
    'builtin/github-traffic': t('GitHub Traffic', 'GitHub Traffic')
  }
  return names[view.panel.id] || panelTitle({ panel: view.panel, settings: {} })
}
function bottom(config: PageConfig) {
  return Math.max(0, ...Object.values(config.layout.placements).map(placement => placement.base.kind === 'grid' ? placement.base.y + placement.base.h : 0))
}
function positionName(placement: Placement) { return placement.kind === 'hidden' ? 'hidden' : placement.region }
function collectionBinding(config: PageConfig, datasetId: string) {
  const existing = Object.entries(config.bindings).find(([, binding]) => binding.datasetId === datasetId && !Object.keys(binding.query).length)
  if (existing) return existing[0]
  const preferred = datasetId === 'local-navigation' ? 'navigation' : 'source-' + datasetId.replace(/^source:/, '')
  const alias = config.bindings[preferred] ? 'binding-' + viewId() : preferred
  config.bindings[alias] = { datasetId, space: 'current-page-space', query: {} }
  return alias
}
function neighbor(config: PageConfig, id: string, direction: number): string | null {
  const placement = config.layout.placements[id]?.base
  if (!placement || placement.kind === 'hidden' || placement.locked) return null
  const siblings = config.views.filter(view => {
    const next = config.layout.placements[view.id]?.base
    return next && next.kind === placement.kind && next.region === placement.region
  }).sort((left, right) => {
    const a = config.layout.placements[left.id]!.base, b = config.layout.placements[right.id]!.base
    return a.kind === 'grid' && b.kind === 'grid' ? a.y - b.y || a.x - b.x : 'order' in a && 'order' in b ? a.order - b.order : 0
  })
  const target = siblings[siblings.findIndex(view => view.id === id) + direction]
  const targetPosition = target && config.layout.placements[target.id]?.base
  return target && targetPosition && targetPosition.kind !== 'hidden' && !targetPosition.locked ? target.id : null
}

export default function LayoutEditor({ bootstrap, dashboard, onSaved }: { bootstrap: Bootstrap; dashboard: Dashboard; onSaved: (message: string) => Promise<void> }) {
  const [history, setHistory] = useState(() => createDraftHistory({ name: dashboard.page.name, config: dashboard.page.config }))
  const { name, config } = history.present
  const [baseline, setBaseline] = useState(() => clone(dashboard.page))
  const [revision, setRevision] = useState(dashboard.page.revision)
  const [sources, setSources] = useState<Source[]>([])
  const [sourceError, setSourceError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [latest, setLatest] = useState<Page | null>(null)
  const [preset, setPreset] = useState<Preset | null>(null)
  const [addType, setAddType] = useState('builtin/navigation')
  const [selectedId, setSelectedId] = useState(dashboard.page.config.views[0]?.id || '')
  const [activeTab, setActiveTab] = useState('page')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [chromeIssue, setChromeIssue] = useState<ChromeValidationIssue | null>(null)
  const form = useRef<HTMLFormElement>(null), saving = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const previewId = useId()
  const canEdit = dashboard.space.canEdit && bootstrap.spaces.some(space => space.id === dashboard.space.id && space.canEdit), disabled = !canEdit || busy
  const regions = regionOptions()
  const categoryLocked = config.views.some(view => {
    const placement = config.layout.placements[view.id]?.base
    return view.panel.id === 'builtin/category-navigation' && placement && placement.kind !== 'hidden' && placement.locked
  })
  const selected = config.views.find(view => view.id === selectedId) || config.views[0]
  const placement = (selected && config.layout.placements[selected.id]?.base) || { kind: 'hidden' } as Placement
  const locked = placement.kind !== 'hidden' && !!placement.locked
  const traffic = selected?.panel.id === 'builtin/github-traffic'
  const alias = selected && Object.values(selected.inputs)[0] || 'navigation'
  const datasetId = config.bindings[alias]?.datasetId || 'local-navigation'
  const categorySettings = readCategoryNavigationSettings(selected?.settings || {})
  const dirty = name !== baseline.name || JSON.stringify(config) !== JSON.stringify(baseline.config)
  const leaveGuard = useUnsavedChanges(dirty, busy, () => loadPage(baseline))
  const canUndo = history.past.length > 0, canRedo = history.future.length > 0
  function historyAction(redo: boolean) {
    if (disabled || saving.current) return
    setHistory(redo ? redoDraft : undoDraft); setChromeIssue(null)
    if (!conflict) setError('')
  }
  useHistoryShortcuts({ enabled: !disabled, undo: () => historyAction(false), redo: () => historyAction(true), canUndo, canRedo })
  function setName(value: string) {
    if (disabled || saving.current) return
    const group = inputHistoryGroup()
    setHistory(previous => recordDraft(previous, { ...previous.present, name: value }, group))
  }
  function setConfig(value: PageConfig | ((previous: PageConfig) => PageConfig)) {
    if (disabled || saving.current) return
    const group = inputHistoryGroup()
    setHistory(previous => recordDraft(previous, { ...previous.present, config: typeof value === 'function' ? value(previous.present.config) : value }, group))
  }

  useEffect(() => {
    const pending = new AbortController()
    request<Source[]>('/spaces/' + encodeURIComponent(dashboard.space.id) + '/sources', { signal: pending.signal })
      .then(value => { if (!pending.signal.aborted) setSources(value) })
      .catch(cause => { if (!pending.signal.aborted) setSourceError(messageOf(cause)) })
    return () => pending.abort()
  }, [dashboard.space.id])

  function edit(change: (value: PageConfig) => void) {
    setConfig(previous => { const next = clone(previous); change(next); return next })
    setChromeIssue(null)
  }
  function updatePlacement(id: string, value: Placement) {
    edit(next => { next.layout.placements[id] = { ...next.layout.placements[id], base: value } })
  }
  function updateSettings(id: string, values: Record<string, unknown>) {
    edit(next => { Object.assign(next.views.find(view => view.id === id)!.settings, values) })
  }
  function moveTo(view: View, region: string) {
    edit(next => {
      const current = next.layout.placements[view.id]?.base
      if (current && current.kind !== 'hidden' && current.locked) return
      const order = next.views.findIndex(item => item.id === view.id)
      next.layout.placements[view.id] = region === 'hidden' ? { base: { kind: 'hidden' } }
        : region === 'main' ? {
          base: { kind: 'grid', region: 'main', x: 0, y: bottom(next), w: 24, h: 6, heightMode: 'content', locked: false },
          overrides: { narrow: { kind: 'flow', region: 'main', order } }
        } : {
          base: { kind: 'region', region: region as Region, order, ...(view.panel.id === 'builtin/search' ? { size: { widthPx: 340, maxWidthPx: 360 } } : {}) },
          overrides: { narrow: { kind: 'region', region: region === 'left' || region === 'right' ? 'top' : region as Region, order } }
        }
    })
  }
  function addView() {
    try {
      const schema = panelContracts[addType]?.schema
      const source = schema && schema !== 'navigation.collection' ? sources.find(item => item.schemaId === schema) : undefined
      if (schema && schema !== 'navigation.collection' && !source) { setError(t('请先添加兼容的数据来源。', 'Add a compatible data source first.')); return }
      const added = addPagePanel(config, addType, source)
      setConfig(added.config); setSelectedId(added.id); setError('')
    } catch (cause) { setError(messageOf(cause)) }
  }
  function removeView(view: View) {
    if (locked) return
    const index = config.views.findIndex(item => item.id === view.id)
    setSelectedId(config.views[index + 1]?.id || config.views[index - 1]?.id || '')
    edit(next => { next.views = next.views.filter(item => item.id !== view.id); delete next.layout.placements[view.id] })
  }
  function bindSource(view: View, value: string) {
    const source = value === 'local-navigation' ? { id: '', name: t('本地书签', 'Local bookmarks'), datasetId: value, schemaId: 'navigation.collection' } : sources.find(item => item.datasetId === value)
    if (!source) return
    try { setConfig(bindPagePanel(config, view.id, source)); setError('') } catch (cause) { setError(messageOf(cause)) }
  }
  function reorder(id: string, delta: number) {
    edit(next => {
      const targetId = neighbor(next, id, delta)
      if (!targetId) return
      const current = next.layout.placements[id]!, target = next.layout.placements[targetId]!, a = current.base, b = target.base
      if (a.kind === 'grid' && b.kind === 'grid') {
        const first = { x: a.x, y: a.y, w: a.w, h: a.h }
        Object.assign(a, { x: b.x, y: b.y, w: b.w, h: b.h }); Object.assign(b, first)
      } else if ('order' in a && 'order' in b) { const order = a.order; a.order = b.order; b.order = order }
      const na = current.overrides?.narrow, nb = target.overrides?.narrow
      if (na && nb && 'order' in na && 'order' in nb && na.region === nb.region && !na.locked && !nb.locked) {
        const order = na.order; na.order = nb.order; nb.order = order
      }
      const index = next.views.findIndex(view => view.id === id), other = next.views.findIndex(view => view.id === targetId), first = next.views[index]!
      next.views[index] = next.views[other]!; next.views[other] = first
    })
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (disabled || saving.current || !dirty) return
    const issue = validatePageChrome(config.chrome)
    if (issue) { setChromeIssue(issue); setActiveTab('chrome'); setError(issue.message); return }
    saving.current = true; setBusy(true); setError(''); setConflict(false)
    try {
      const saved = await request<Page>('/spaces/' + encodeURIComponent(dashboard.space.id) + '/page', {
        method: 'PUT', body: { name: name.trim(), config, expectedRevision: revision }
      })
      if (!mounted.current) return
      setRevision(saved.revision); setBaseline(clone(saved)); setHistory(createDraftHistory({ name: saved.name, config: saved.config }))
      try { await onSaved(t('页面布局已保存', 'Page layout saved')) }
      catch { if (mounted.current) setError(t('页面已经保存，但重新加载失败。已保存的内容仍然保留，可稍后刷新。', 'The page was saved, but reloading failed. Your saved content is still here; refresh later.')) }
    } catch (cause) {
      if (!mounted.current) return
      setError(messageOf(cause))
      if (cause instanceof ApiError && cause.code === 'page_version_conflict') setConflict(true)
    } finally { saving.current = false; if (mounted.current) setBusy(false) }
  }
  async function inspectLatest() {
    setBusy(true)
    try { const data = await request<Dashboard>('/dashboard?spaceId=' + encodeURIComponent(dashboard.space.id)); if (mounted.current) setLatest(data.page) }
    catch (cause) { if (mounted.current) setError(messageOf(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  function loadPage(page: Page) {
    setHistory(createDraftHistory({ name: page.name, config: page.config })); setBaseline(clone(page)); setRevision(page.revision)
    setSelectedId(page.config.views[0]?.id || ''); setLatest(null); setConflict(false); setError(''); setChromeIssue(null)
  }
  function downloadDraft() {
    const href = URL.createObjectURL(new Blob([JSON.stringify({ name, config, expectedRevision: revision }, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = href; anchor.download = 'Lingshu-Home-layout-draft.json'; anchor.click()
    setTimeout(() => URL.revokeObjectURL(href), 1000)
  }
  function applyPreset(kind: Preset) {
    const next = presetConfig(kind)
    next.pageTheme = { ...config.pageTheme }
    next.appearance = { ...config.appearance }
    if (config.chrome) next.chrome = clone(config.chrome)
    setConfig(next); setSelectedId(next.views[0]?.id || ''); setPreset(null); setChromeIssue(null)
  }

  return <form ref={form} className="admin-layout-form" onSubmit={save} onInvalidCapture={event => handleFormInvalid(event, setError)}>
    <div className={'admin-layout-workspace' + (previewOpen ? ' has-preview' : '')}>
      <Tabs value={activeTab} onValueChange={setActiveTab} className="admin-layout-tabs">
          <div className="admin-layout-tabbar">
            <TabsList variant="line" aria-label={t('布局设置', 'Layout settings')}>
              <TabsTrigger value="page">{t('页面与外观', 'Page and appearance')}</TabsTrigger>
              <TabsTrigger value="panels">{t('积木与数据绑定', 'Panels and data')} <span className="admin-tab-count">{config.views.length}</span></TabsTrigger>
              <TabsTrigger value="chrome">{t('页眉与页脚', 'Header and footer')}</TabsTrigger>
            </TabsList>
            <Button type="button" variant={previewOpen ? 'secondary' : 'outline'} size="sm"
              aria-expanded={previewOpen} aria-controls={previewId} onClick={() => setPreviewOpen(value => !value)}>
              {previewOpen ? <EyeOff size={15} /> : <Eye size={15} />}{previewOpen ? t('收起预览', 'Hide preview') : t('预览首页', 'Preview homepage')}
            </Button>
          </div>
          <fieldset className="admin-plain-fieldset admin-layout-fields" disabled={disabled}>
          <TabsContent value="page" className="admin-layout-page-tab">
            <div className="admin-page-settings-grid">
              <section className="admin-settings-section admin-page-general">
                <h3>{t('页面设置', 'Page settings')}</h3>
                <div className="admin-form-row equal">
                  <Field label={t('页面名称', 'Page name')}><Input required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></Field>
                  <Field label={t('当前主题', 'Current theme')}><StyledSelect aria-label={t('当前主题', 'Current theme')} disabled={disabled} value={config.pageTheme.id} onValueChange={value => setConfig(previous => switchPageTheme(previous, value as BuiltinPageThemeId))} options={builtinPageThemes.map(theme => ({ value: theme.id, label: theme.name }))} /></Field>
                </div>
                <div className="admin-form-row equal">
                  <Field label={t('配色', 'Color mode')}><StyledSelect aria-label={t('配色', 'Color mode')} disabled={disabled} value={config.appearance.colorMode}
                    onValueChange={value => edit(next => { next.appearance.colorMode = value as 'light' | 'dark' | 'system' })}
                    options={[{ value: 'light', label: t('浅色', 'Light') }, { value: 'dark', label: t('深色', 'Dark') }, { value: 'system', label: t('跟随系统', 'System') }]} /></Field>
                  <Field label={t('内容密度', 'Content density')}><StyledSelect aria-label={t('内容密度', 'Content density')} disabled={disabled} value={config.appearance.density}
                    onValueChange={value => edit(next => { next.appearance.density = value as 'comfortable' | 'compact' })}
                    options={[{ value: 'comfortable', label: t('舒适', 'Comfortable') }, { value: 'compact', label: t('紧凑', 'Compact') }]} /></Field>
                  <Field label={t('组件间距', 'Panel spacing')}><StyledSelect aria-label={t('组件间距', 'Panel spacing')} disabled={disabled} value={String(config.layout.gap)}
                    onValueChange={value => edit(next => { next.layout.gap = Number(value) })}
                    options={[8, 12, 16, 24].map(value => ({ value: String(value), label: t('{value} px', '{value} px', { value }) }))} /></Field>
                </div>
              </section>
              <section className="admin-settings-section admin-page-presets">
                <h3>{t('布局预设', 'Layout presets')}</h3>
                <div className="admin-presets">{(['grouped-cards', 'dense-directory'] as const).map(kind => <Button key={kind} type="button" variant="outline" className="admin-preset" onClick={() => setPreset(kind)}>
                  <span className={'admin-preset-preview ' + (kind === 'grouped-cards' ? 'cards' : 'directory')} aria-hidden="true"><i /><span>{Array.from({ length: kind === 'grouped-cards' ? 6 : 12 }, (_, index) => <b key={index} />)}</span></span>
                  <strong>{kind === 'grouped-cards' ? t('分组卡片', 'Grouped cards') : t('紧凑目录', 'Compact directory')}</strong>
                </Button>)}</div>
                <p className="admin-hint">{t('应用预设会替换积木与布局，链接、分类及页眉页脚内容保留。', 'Presets replace panels and layout. Links, categories, header and footer content are retained.')}</p>
              </section>
              <section className="admin-settings-section admin-category-position">
                <h3>{t('分类导航位置', 'Category navigation position')}</h3>
                <div className="admin-position-options" role="group" aria-label={t('分类导航位置', 'Category navigation position')}>
                  {[
                    { id: 'top', title: t('顶部', 'Top'), label: t('分类导航顶部', 'Category navigation at top') },
                    { id: 'left', title: t('左侧', 'Left'), label: t('分类导航左侧', 'Category navigation at left') },
                    { id: 'right', title: t('右侧', 'Right'), label: t('分类导航右侧', 'Category navigation at right') },
                    { id: 'bottom', title: t('底部', 'Bottom'), label: t('分类导航底部', 'Category navigation at bottom') },
                    { id: 'hidden', title: t('隐藏', 'Hidden'), label: t('分类导航隐藏', 'Hide category navigation') }
                  ].map(({ id, title, label }) => <button key={id} type="button" className={categoryPosition(config) === id ? 'selected' : ''}
                    aria-pressed={categoryPosition(config) === id} aria-label={label} disabled={disabled || !!categoryLocked}
                    onClick={() => setConfig(previous => setCategoryPosition(previous, id as 'top' | 'left' | 'right' | 'bottom' | 'hidden'))}>
                    <span className={'admin-position-glyph ' + id} aria-hidden="true" /><span>{title}</span>
                  </button>)}
                </div>
                <p className="admin-hint">{t('外观、折叠和层级在「积木与数据绑定 → 分类导航」中设置。锁定后需先解锁才能移动。', 'Configure appearance, collapse and hierarchy under Panels and data → Category navigation. Unlock a locked panel before moving it.')}</p>
              </section>
            </div>
          </TabsContent>
          <TabsContent value="panels" className="admin-layout-panels-tab">
            <div className="admin-content-toolbar admin-composition-toolbar">
              <h3>{t('页面积木', 'Page panels')}</h3>
              <div className="admin-inline-controls">
                <StyledSelect aria-label={t('要添加的积木', 'Panel to add')} value={addType} onValueChange={setAddType} disabled={disabled || config.views.length >= 32}
                  options={panelTypes.map(panel => ({ value: panel.id, label: panelName({ panel }) }))} />
                <Button type="button" disabled={disabled || config.views.length >= 32} onClick={addView}><Plus size={16} />{t('添加积木', 'Add panel')}</Button>
              </div>
            </div>
            {sourceError && <p className="admin-info">{t('外部数据源列表暂时无法读取，现有绑定保留。', 'External sources are temporarily unavailable. Existing bindings are retained.')}</p>}
            {selected ? <div className="admin-composition-editor">
              <aside className="admin-component-list" aria-label={t('页面积木列表', 'Page panel list')}>
                <ul>{config.views.map((view, index) => {
                  const itemPlacement = config.layout.placements[view.id]?.base || { kind: 'hidden' } as Placement
                  return <li key={view.id}><button type="button" className={'admin-component-item ' + (selected.id === view.id ? 'selected' : '')}
                    aria-pressed={selected.id === view.id} aria-label={t('配置 {panel} {count}', 'Configure {panel} {count}', { panel: panelName(view), count: index + 1 })}
                    onClick={() => setSelectedId(view.id)}><Layers size={17} /><span><strong>{String(view.settings.title || panelName(view))}</strong>
                      <small>{regions.find(option => option.value === positionName(itemPlacement))?.label}</small></span>
                    {itemPlacement.kind === 'hidden' ? <EyeOff size={14} /> : itemPlacement.locked ? <LockKeyhole size={14} /> : null}
                  </button></li>
                })}</ul>
              </aside>
              <section className="admin-view-card admin-view-inspector" key={selected.id} aria-label={t('{panel}设置', '{panel} settings', { panel: panelName(selected) })}>
                <header><h3>{panelName(selected)}</h3><span className="grow" />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t('在当前区域上移积木', 'Move panel up within this region')} disabled={disabled || !neighbor(config, selected.id, -1)} onClick={() => reorder(selected.id, -1)}><ArrowUp size={15} /></Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t('在当前区域下移积木', 'Move panel down within this region')} disabled={disabled || !neighbor(config, selected.id, 1)} onClick={() => reorder(selected.id, 1)}><ArrowDown size={15} /></Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t('移除积木', 'Remove panel')} disabled={disabled || locked} onClick={() => removeView(selected)}><Trash2 size={15} /></Button>
                </header>
                <div className="admin-inspector-body" tabIndex={0} role="region" aria-label={t('所选积木配置', 'Selected panel settings')}>
                  <div className="admin-form-row equal">
                    <Field label={t('积木标题', 'Panel title')} hint={t('选填', 'Optional')}><Input maxLength={80} value={String(selected.settings.title || '')} onChange={event => updateSettings(selected.id, { title: event.target.value })} /></Field>
                    <Field label={t('位置', 'Position')}><StyledSelect aria-label={t('位置', 'Position')} value={positionName(placement)} disabled={disabled || locked}
                      onValueChange={value => moveTo(selected, value)} options={regions.filter(option => selected.panel.id !== 'builtin/category-navigation' || option.value !== 'main')} /></Field>
                  </div>
                  <div className="admin-form-row equal">
                    {selected.panel.id !== 'builtin/search' && <Field label={t('数据来源', 'Data source')}><StyledSelect aria-label={t('数据来源', 'Data source')} disabled={disabled} value={datasetId}
                      onValueChange={value => bindSource(selected, value)} options={[
                        ...(panelContracts[selected.panel.id]?.schema === 'navigation.collection' ? [{ value: 'local-navigation', label: t('当前空间 · 本地导航', 'Current space · Local navigation') }] : []),
                        ...sources.filter(source => source.schemaId === panelContracts[selected.panel.id]?.schema).map(source => ({ value: source.datasetId, label: source.name })),
                        ...(datasetId !== 'local-navigation' && !sources.some(source => source.datasetId === datasetId) ? [{ value: datasetId, label: t('已绑定的数据源（{id}）', 'Bound source ({id})', { id: datasetId }) }] : [])
                      ]} /></Field>}
                    {['builtin/navigation', 'builtin/favorites'].includes(selected.panel.id) && <Field label={t('展示变体', 'Display variant')}><StyledSelect aria-label={t('展示变体', 'Display variant')} disabled={disabled}
                      value={String(selected.settings.variant || 'cards')} onValueChange={value => updateSettings(selected.id, { variant: value })}
                      options={[{ value: 'cards', label: t('卡片', 'Cards') }, { value: 'directory', label: t('目录', 'Directory') }]} /></Field>}
                  </div>
                  {['builtin/navigation', 'builtin/favorites'].includes(selected.panel.id) && <Field label={t('链接外观', 'Link appearance')}><StyledSelect aria-label={t('链接外观', 'Link appearance')} disabled={disabled}
                    value={String(selected.settings.linkAppearance || 'theme')} onValueChange={value => edit(next => { const settings = next.views.find(view => view.id === selected.id)!.settings; if (value === 'theme') delete settings.linkAppearance; else settings.linkAppearance = value })}
                    options={[{ value: 'theme', label: t('跟随主题', 'Follow theme') }, { value: 'icon-text', label: t('图标 + 文字', 'Icon + text') }, { value: 'minimal', label: t('简约文字', 'Minimal text') }, { value: 'app-icons', label: t('应用图标', 'App icons') }]} /></Field>}
                  {selected.panel.id === 'builtin/calendar' && <Field label={t('默认日程视图', 'Default calendar view')}><StyledSelect value={selected.settings.viewMode === 'day' ? 'day' : 'week'} disabled={disabled} onValueChange={value => updateSettings(selected.id, { viewMode: value })} options={[{ value: 'day', label: t('日', 'Day') }, { value: 'week', label: t('周', 'Week') }]} /></Field>}
                  {selected.panel.id === 'builtin/weather' && <Field label={t('显示预报天数', 'Forecast days to show')}><StyledSelect value={String(selected.settings.forecastDays || 5)} disabled={disabled} onValueChange={value => updateSettings(selected.id, { forecastDays: Number(value) })} options={[3, 5, 7].map(value => ({ value: String(value), label: t('{value} 天', '{value} days', { value }) }))} /></Field>}
                  {selected.panel.id === 'builtin/metrics' && <label className="admin-check-line"><Checkbox checked={selected.settings.showBars !== false} disabled={disabled} onCheckedChange={value => updateSettings(selected.id, { showBars: value })} />{t('显示已定义量程的进度条', 'Show bars for defined metric ranges')}</label>}
                  {selected.panel.id === 'builtin/status' && <label className="admin-check-line"><Checkbox checked={selected.settings.showLatency !== false} disabled={disabled} onCheckedChange={value => updateSettings(selected.id, { showLatency: value })} />{t('显示响应时间', 'Show response times')}</label>}
                  {linkingPanels.includes(selected.panel.id) && <InteractionScopeEditor view={selected} views={config.views.filter(view => linkingPanels.includes(view.panel.id))} disabled={disabled}
                    onChange={scope => edit(next => { next.views.find(view => view.id === selected.id)!.interactionScope = scope })} />}
                  {selected.panel.id === 'builtin/category-navigation' && <section className="admin-inspector-section">
                    <h4>{t('分类导航外观', 'Category navigation appearance')}</h4>
                    <div className="admin-form-row equal">
                      <Field label={t('显示模式', 'Display mode')}><StyledSelect aria-label={t('分类显示模式', 'Category display mode')} disabled={disabled} value={categorySettings.displayMode}
                        onValueChange={value => updateSettings(selected.id, { displayMode: value })}
                        options={[{ value: 'icon-text', label: t('图标 + 文字', 'Icon + text') }, { value: 'icons', label: t('纯图标', 'Icons only') }, { value: 'text', label: t('纯文字', 'Text only') }]} /></Field>
                      <Field label={t('分类层级', 'Category hierarchy')}><StyledSelect aria-label={t('分类层级', 'Category hierarchy')} disabled={disabled} value={categorySettings.hierarchyMode}
                        onValueChange={value => updateSettings(selected.id, { hierarchyMode: value })}
                        options={[{ value: 'tree', label: t('树形层级', 'Tree hierarchy') }, { value: 'flat', label: t('平铺分类', 'Flat categories') }]} /></Field>
                    </div>
                    <div className="admin-check-options">
                      <label className="admin-check-line"><Checkbox checked={categorySettings.showCounts} disabled={disabled} onCheckedChange={value => updateSettings(selected.id, { showCounts: value })} />{t('显示链接数量', 'Show link counts')}</label>
                      <label className="admin-check-line"><Checkbox checked={categorySettings.collapsible} disabled={disabled || categorySettings.displayMode === 'icons'} onCheckedChange={value => updateSettings(selected.id, { collapsible: value })} />{t('允许收起为图标', 'Allow collapsing to icons')}</label>
                      <label className="admin-check-line"><Checkbox checked={categorySettings.defaultCollapsed} disabled={disabled || !categorySettings.collapsible || categorySettings.displayMode === 'icons'} onCheckedChange={value => updateSettings(selected.id, { defaultCollapsed: value })} />{t('默认收起为图标', 'Collapsed to icons by default')}</label>
                    </div>
                    {categorySettings.displayMode === 'icons' && <p className="admin-hint">{t('纯图标模式始终使用图标栏；切换为文字模式后可设置整栏收起。', 'Icons-only mode always uses an icon rail. Switch to a text mode to configure whole-panel collapsing.')}</p>}
                  </section>}
                  {placement.kind !== 'hidden' && <label className="admin-check-line admin-placement-lock"><Checkbox checked={locked} disabled={disabled} onCheckedChange={value => updatePlacement(selected.id, { ...placement, locked: value })} />
                    <LockKeyhole size={15} />{placement.kind === 'grid' ? t('锁定位置与尺寸', 'Lock position and size') : t('锁定位置', 'Lock position')}</label>}
                  <details className="admin-advanced-settings"><summary>{t('高级配置', 'Advanced settings')}<ChevronDown size={15} /></summary><div className="admin-advanced-body">
                    {placement.kind === 'grid' && <>
                      <div className="admin-form-row admin-grid-coordinates">{(['x', 'y', 'w', 'h'] as const).map(key => <Field key={key} label={{
                        x: t('起始列 X', 'Starting column X'), y: t('起始行 Y', 'Starting row Y'), w: t('宽度（列）', 'Width (columns)'), h: t('高度（行）', 'Height (rows)')
                      }[key]}><Input type="number" value={placement[key]} min={key === 'w' || key === 'h' ? 1 : 0}
                        max={{ x: 23, y: 10000, w: 24, h: 1000 }[key]} disabled={disabled || locked}
                        onChange={event => updatePlacement(selected.id, { ...placement, [key]: Number(event.target.value) })} /></Field>)}</div>
                      <Field label={t('内容高度', 'Content height')}><StyledSelect aria-label={t('内容高度', 'Content height')} value={placement.heightMode} disabled={disabled || locked}
                        onValueChange={value => updatePlacement(selected.id, { ...placement, heightMode: value as 'content' | 'fixed' })}
                        options={[{ value: 'content', label: t('随内容增长', 'Grow with content') }, { value: 'fixed', label: t('固定高度，内部滚动', 'Fixed height, scroll inside') }]} /></Field>
                      <p className="admin-hint">{t('主体为 24 列栅格。也可在首页编辑布局时拖动和调整尺寸。', 'The main area uses a 24-column grid. You can also drag and resize panels while editing the homepage.')}</p>
                    </>}
                    {(placement.kind === 'region' || placement.kind === 'flow') && <div className="admin-form-row equal">
                      <Field label={t('区域内排序', 'Order within region')}><Input type="number" min={0} max={1000} disabled={disabled || locked} value={placement.order}
                        onChange={event => updatePlacement(selected.id, { ...placement, order: Number(event.target.value) })} /></Field>
                      {placement.kind === 'region' && <label className="admin-check-line"><Checkbox checked={placement.sticky || false} disabled={disabled || locked}
                        onCheckedChange={value => updatePlacement(selected.id, { ...placement, sticky: value })} />{t('滚动时保留可见', 'Keep visible while scrolling')}</label>}
                    </div>}
                    {placement.kind === 'hidden' && <p className="admin-hint">{t('选择显示位置后可配置排序和尺寸。', 'Choose a visible position to configure order and dimensions.')}</p>}
                  </div></details>
                </div>
              </section>
            </div> : <Empty title={t('暂无积木', 'No panels yet')} detail={t('添加积木后选择数据来源和位置。移除积木不会删除链接或分类。', 'Add a panel, then choose its source and position. Removing a panel retains its links and categories.')} />}
          </TabsContent>
          <TabsContent value="chrome" className="admin-layout-chrome-tab">
            <PageChromeEditor chrome={config.chrome} disabled={disabled} issue={chromeIssue} onChange={chrome => edit(next => { next.chrome = chrome })} />
          </TabsContent>
          </fieldset>
      </Tabs>
      {previewOpen && <div id={previewId} className="admin-layout-preview-container">
        <PagePreview bootstrap={bootstrap} dashboard={dashboard} name={name} config={config} sources={sources}
          dirty={dirty} busy={busy} canSave={canEdit} onSave={() => form.current?.requestSubmit()}
          onCancel={() => leaveGuard.requestLeave(() => loadPage(dashboard.page))} onClose={() => setPreviewOpen(false)} />
      </div>}
    </div>
    <div className="admin-layout-feedback">
      {!canEdit && <p className="admin-info">{t('当前空间只读，布局由空间维护者管理。', 'This space is read-only. Its maintainer manages the layout.')}</p>}
      <ErrorMessage error={error} />
      {conflict && <div className="admin-conflict">
        <p>{t('页面已被其他操作更新，你当前的编辑草稿已保留。', 'The page was updated elsewhere. Your current draft has been retained.')}</p>
        <div className="admin-button-row">
          <Button type="button" variant="outline" onClick={downloadDraft}>{t('下载当前草稿', 'Download current draft')}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={inspectLatest}>{t('查看服务器版本', 'Inspect server version')}</Button>
        </div>
        {latest && <div className="admin-conflict-comparison">
          <p>{t('服务器：{name} · {count} 个积木 · 版本 {revision}', 'Server: {name} · {count} panels · revision {revision}', { name: latest.name, count: latest.config.views.length, revision: latest.revision })}<br />
            {t('当前草稿：{name} · 基于版本 {revision}', 'Current draft: {name} · based on revision {revision}', { name, revision })}</p>
          <Button type="button" variant="secondary" onClick={() => loadPage(latest)}>{t('载入服务器版本，替换当前草稿', 'Load server version and replace current draft')}</Button>
        </div>}
      </div>}
    </div>
    <div className="admin-form-footer admin-layout-savebar">
      <span className="admin-draft-status" role="status">{dirty ? t('有未保存的更改', 'Unsaved changes') : t('已保存', 'Saved')}</span>
      <div className="admin-layout-history" role="group" aria-label={t('编辑历史', 'Edit history')}>
        <Button type="button" variant="outline" size="sm" aria-label={t('撤销', 'Undo')} title={t('撤销（Ctrl / ⌘ + Z）', 'Undo (Ctrl / ⌘ + Z)')} disabled={disabled || !canUndo} onClick={() => historyAction(false)}><Undo2 size={15}/>{t('撤销', 'Undo')}</Button>
        <Button type="button" variant="outline" size="sm" aria-label={t('重做', 'Redo')} title={t('重做（Ctrl / ⌘ + Shift + Z）', 'Redo (Ctrl / ⌘ + Shift + Z)')} disabled={disabled || !canRedo} onClick={() => historyAction(true)}><Redo2 size={15}/>{t('重做', 'Redo')}</Button>
      </div>
      <Button type="button" variant="outline" disabled={busy || !dirty} onClick={() => leaveGuard.requestLeave(() => loadPage(baseline))}>{t('取消更改', 'Cancel changes')}</Button>
      <Button type="submit" disabled={disabled || !dirty}>{busy ? t('正在保存…', 'Saving…') : t('保存页面', 'Save page')}</Button>
    </div>
    {preset && <Modal title={t('应用页面预设？', 'Apply page preset?')} onClose={() => setPreset(null)}>
      <p>{t('这会替换当前积木和布局配置。链接、分类、外部数据源及页眉页脚内容保留。', 'This replaces the current panels and layout. Links, categories, external sources, header and footer content are retained.')}</p>
      <div className="admin-form-footer">
        <Button type="button" variant="outline" onClick={() => setPreset(null)}>{t('保留当前布局', 'Keep current layout')}</Button>
        <Button type="button" onClick={() => applyPreset(preset)}>{t('应用预设', 'Apply preset')}</Button>
      </div>
    </Modal>}
    {leaveGuard.blocked && <Suspense fallback={null}><DiscardChangesDialog onKeep={leaveGuard.keep} onDiscard={leaveGuard.discard} /></Suspense>}
  </form>
}
