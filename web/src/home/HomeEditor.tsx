import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Dialog as DialogPrimitive, Tabs as TabsPrimitive } from 'radix-ui'
import { Activity, CalendarDays, CloudSun, BarChart3, Upload, RefreshCw, Undo2, Redo2, Bookmark, Check, ChevronRight, Eye, EyeOff, LayoutDashboard, LayoutTemplate, Layers3, LoaderCircle, LockKeyhole, PanelBottom, PanelLeft, PanelRight, PanelTop, Pencil, Plus, RotateCcw, Search, Settings2, Star, X } from 'lucide-react'
import { request } from '../core/api'
import { t } from '../core/i18n'
import { readPageChrome } from '../core/chrome'
import { validatePageChrome, type ChromeValidationIssue } from '../core/chrome-validation'
import { builtinPageThemes, switchPageTheme } from '../core/themes'
import type { Dataset, PageConfig, Placement, Space } from '../core/types'
import { ProjectLogo } from '../components/ProjectLogo'
import { FieldHelp } from '../components/FieldHelp'
import { HomeChromeInspector } from './HomeChromeInspector'
import { HomePanelInspector } from './HomePanelInspector'
import { ComposerButton, ComposerSelect } from './HomeEditorControls'
import { addDocumentActivityPanel, documentActivityPresets, addPagePanel, panelContracts, COMPOSER_PANEL_LIMIT, panelLocked, panelTitle, type ComposerSource, type HomeSelection } from './composition'
import './home-editor.css'
const WidgetImportDialog = lazy(() => import('../components/WidgetImportDialog'))
const DashboardPresetDialog = lazy(() => import('../components/DashboardPresetDialog'))

export type HomeEditorProps = {
  config: PageConfig; theme: 'light' | 'dark'; busy: boolean; dirty: boolean; narrow: boolean;
  selection: HomeSelection; onSelect: (selection: HomeSelection) => void; previewing: boolean; onPreviewChange: (preview: boolean) => void;
  onChange: (config: PageConfig) => void; onSave: () => void; onCancel: () => void; onRestore: () => void;
  historyBusy: boolean; canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void;
  children: ReactNode; notice?: ReactNode; pageName?: string; spaceId?: string; datasets?: Record<string, Dataset<unknown>>;
  sources?: ComposerSource[]; onSourcesChange?: (sources: ComposerSource[]) => void; space?: Space; canManageSources?: boolean
}
const panelIcons = { 'builtin/search': Search, 'builtin/category-navigation': PanelLeft, 'builtin/favorites': Star, 'builtin/navigation': Bookmark, 'builtin/github-traffic': Activity, 'builtin/calendar': CalendarDays, 'builtin/weather': CloudSun, 'builtin/metrics': BarChart3, 'builtin/status': Activity, 'builtin/document-activity': CalendarDays }
function slotName(position?: Placement) {
  if (!position || position.kind === 'hidden') return t('已隐藏', 'Hidden')
  return ({ top: t('顶部', 'Top'), left: t('左侧', 'Left'), main: t('主内容区', 'Main canvas'), right: t('右侧', 'Right'), bottom: t('底部', 'Bottom') })[position.region]
}
function useCompactEditor() {
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 1099px)').matches)
  useEffect(() => { const media = window.matchMedia('(max-width: 1099px)'), update = () => setCompact(media.matches); update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update) }, [])
  return compact
}

export default function HomeEditor({ config, busy, dirty, narrow, selection, onSelect, previewing, onPreviewChange, onChange, onSave, onCancel, onRestore, historyBusy, canUndo, canRedo, onUndo, onRedo, children, notice, pageName, spaceId, datasets, sources: providedSources, onSourcesChange, space, canManageSources = false }: HomeEditorProps) {
  const compact = useCompactEditor(), [libraryTab, setLibraryTab] = useState('layers')
  const [drawer, setDrawer] = useState<'library' | 'inspector' | null>(null)
  const [sources, setSources] = useState<ComposerSource[]>([]), [sourceError, setSourceError] = useState(false)
  const [importOpen, setImportOpen] = useState(false), [sourcesBusy, setSourcesBusy] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  const [error, setError] = useState(''), [chromeIssue, setChromeIssue] = useState<ChromeValidationIssue | null>(null)
  const sourceCallback = useRef(onSourcesChange), returnFocus = useRef<HTMLElement | null>(null)
  const previousSelection = useRef(selection)
  const pendingLibraryDialog = useRef<'preset' | 'import' | null>(null)
  sourceCallback.current = onSourcesChange
  useEffect(() => { setError(''); setChromeIssue(null) }, [config])
  const supplied = providedSources !== undefined
  useEffect(() => {
    if (supplied || !spaceId) return
    const controller = new AbortController()
    request<ComposerSource[]>(`/spaces/${encodeURIComponent(spaceId)}/sources`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setSources(value); setSourceError(false); sourceCallback.current?.(value) } })
      .catch(() => { if (!controller.signal.aborted) setSourceError(true) })
    return () => controller.abort()
  }, [spaceId, supplied])
  useEffect(() => {
    if (!compact || previewing) setDrawer(null)
    else if (previousSelection.current !== selection) {
      if (!drawer) returnFocus.current = document.activeElement as HTMLElement
      setDrawer('inspector')
    }
    previousSelection.current = selection
  }, [selection, compact, previewing])
  const allSources = useMemo(() => {
    const result = [...(providedSources || sources)]
    for (const dataset of Object.values(datasets || {})) if (dataset.datasetId.startsWith('source:') && !result.some(item => item.datasetId === dataset.datasetId)) {
      result.push({ id: dataset.datasetId.slice(7), datasetId: dataset.datasetId, schemaId: dataset.schemaId, schemaVersion: dataset.schemaVersion, enabled: dataset.meta.freshness !== 'disabled', name: dataset.schemaId === 'github.traffic' ? 'GitHub Traffic' : t('已有数据来源', 'Existing data source') })
    }
    return result
  }, [providedSources, sources, datasets])
  const chrome = readPageChrome(config.chrome)
  const selectedView = selection.kind === 'view' ? config.views.find(view => view.id === selection.id) : undefined
  const inspectorTitle = selectedView ? panelTitle(selectedView) : selection.kind === 'chrome' ? selection.area === 'header' ? t('页眉', 'Header') : t('页脚', 'Footer') : t('页面外观', 'Page appearance')
  const limit = config.views.length >= COMPOSER_PANEL_LIMIT, trafficSource = allSources.find(source => source.schemaId === 'github.traffic')
  const disabled = busy || previewing

  function change(next: PageConfig) { if (disabled) return; setError(''); setChromeIssue(null); onChange(next) }
  function edit(update: (next: PageConfig) => void) { const next = structuredClone(config); update(next); change(next) }
  function select(next: HomeSelection) { if (busy) return; onSelect(next); if (compact) { if (!drawer) returnFocus.current = document.activeElement as HTMLElement; setDrawer('inspector') } }
  function openLibrary(tab: string) { setLibraryTab(tab); if (compact) { returnFocus.current = document.activeElement as HTMLElement; setDrawer('library') } }
  function showLibraryDialog(kind: 'preset' | 'import') {
    if (kind === 'preset') setPresetOpen(true)
    else setImportOpen(true)
  }
  function requestLibraryDialog(kind: 'preset' | 'import') {
    if (compact && drawer !== null) {
      // Let the drawer release its focus trap before the dialog takes focus.
      pendingLibraryDialog.current = kind
      setDrawer(null)
    } else showLibraryDialog(kind)
  }
  function closeDrawerFocus(event: Event) {
    if (returnFocus.current?.isConnected) {
      event.preventDefault()
      returnFocus.current.focus({ preventScroll: true })
    }
    const pending = pendingLibraryDialog.current
    pendingLibraryDialog.current = null
    if (pending) showLibraryDialog(pending)
  }
  function add(panelId: string) {
    if (disabled) return
    try { const result = addPagePanel(config, panelId, panelContracts[panelId]?.schema !== 'navigation.collection' ? allSources.find(source => source.schemaId === panelContracts[panelId]?.schema) : undefined); change(result.config); select({ kind: 'view', id: result.id }); setLibraryTab('layers') }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('无法添加组件。', 'The component could not be added.')) }
  }
  function addActivity(presentation: 'heatmap' | 'split' | 'month') {
    if (disabled || limit) return
    try { const result = addDocumentActivityPanel(config, presentation); change(result.config); select({ kind: 'view', id: result.id }); setLibraryTab('layers') }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('无法添加组件。', 'The component could not be added.')) }
  }
  function save() {
    if (busy || !dirty) return
    const issue = validatePageChrome(config.chrome)
    if (issue) {
      setChromeIssue(issue); setError(issue.message); onPreviewChange(false); onSelect({ kind: 'chrome', area: issue.area, alignment: issue.alignment }); if (compact) setDrawer('inspector'); return
    }
    setError(''); setChromeIssue(null); onSave()
  }
  function restore() { if (busy) return; setError(''); setChromeIssue(null); onRestore() }

  const library = <div className="lh-composer-library"><TabsPrimitive.Root value={libraryTab} onValueChange={setLibraryTab}>
    <TabsPrimitive.List className="lh-composer-tabs" aria-label={t('组件面板', 'Component panel')}>
      <TabsPrimitive.Trigger value="layers"><Layers3 size={15} />{t('页面结构', 'Layers')}</TabsPrimitive.Trigger>
      <TabsPrimitive.Trigger value="library"><Plus size={15} />{t('添加组件', 'Add')}</TabsPrimitive.Trigger>
    </TabsPrimitive.List>
    <TabsPrimitive.Content value="layers" className="lh-composer-tab-body">
      <button type="button" className="lh-composer-layer is-page" aria-pressed={selection.kind === 'page'} onClick={() => select({ kind: 'page' })} disabled={disabled}>
        <LayoutDashboard size={17} /><span><strong>{pageName || t('首页', 'Homepage')}</strong><small>{t('主题与全局外观', 'Theme and appearance')}</small></span><ChevronRight size={14} />
      </button>
      <div className="lh-composer-layer-list" aria-label={t('页面组件列表', 'Page component list')}>
        <button type="button" className="lh-composer-layer" aria-pressed={selection.kind === 'chrome' && selection.area === 'header'} disabled={disabled} onClick={() => select({ kind: 'chrome', area: 'header', alignment: 'left' })}>
          <PanelTop size={17} /><span><strong>{t('页眉', 'Header')}</strong><small>{t('左 · 中 · 右', 'Left · Center · Right')}</small></span>{!chrome.header.enabled && <EyeOff size={13} />}
        </button>
        {config.views.map(view => { const Icon = panelIcons[view.panel.id as keyof typeof panelIcons] || Layers3, placement = config.layout.placements[view.id]?.base
          return <button type="button" key={view.id} className="lh-composer-layer" aria-pressed={selectedView?.id === view.id} disabled={disabled} data-composer-layer={view.id} onClick={() => select({ kind: 'view', id: view.id })}>
            <Icon size={17} /><span><strong>{panelTitle(view)}</strong><small>{slotName(placement)}</small></span>{placement?.kind === 'hidden' ? <EyeOff size={13} /> : panelLocked(config, view.id) ? <LockKeyhole size={13} /> : <span className="lh-composer-layer-dot" />}
          </button>
        })}
        <button type="button" className="lh-composer-layer" aria-pressed={selection.kind === 'chrome' && selection.area === 'footer'} disabled={disabled} onClick={() => select({ kind: 'chrome', area: 'footer', alignment: 'right' })}>
          <PanelBottom size={17} /><span><strong>{t('页脚', 'Footer')}</strong><small>{t('左 · 中 · 右', 'Left · Center · Right')}</small></span>{!chrome.footer.enabled && <EyeOff size={13} />}
        </button>
      </div>
      <ComposerButton className="lh-composer-add-button" disabled={disabled || limit} onClick={() => openLibrary('library')}><Plus size={15} />{t('添加组件', 'Add component')}</ComposerButton>
    </TabsPrimitive.Content>
    <TabsPrimitive.Content value="library" className="lh-composer-tab-body">
      <div className="lh-composer-library-heading"><div className="lh-composer-library-title"><h3>{t('内置组件', 'Built-in components')}</h3><FieldHelp label={t('内置组件', 'Built-in components')}>{t('组件显示本地快照。需要外部数据时，请先添加并启用数据来源。', 'Components display local snapshots. Add and enable a data source to collect external data.')}</FieldHelp></div><span>{config.views.length} / {COMPOSER_PANEL_LIMIT}</span></div>
      <div className="lh-composer-library-items">{Object.entries(panelIcons).filter(([panelId]) => panelId !== 'builtin/document-activity').map(([panelId, Icon]) => { const schema = panelContracts[panelId]?.schema; const unavailable = !!schema && schema !== 'navigation.collection' && !allSources.some(source => source.schemaId === schema)
        return <button type="button" key={panelId} className="lh-composer-library-item" disabled={disabled || limit || unavailable} title={unavailable ? t('先在管理中心添加兼容的数据来源', 'Add a compatible data source in admin first') : undefined} onClick={() => add(panelId)}>
          <span className="lh-composer-library-icon"><Icon size={20} /></span><span><strong>{panelTitle({ panel: { id: panelId }, settings: {} })}</strong>{unavailable && <small>{t('需要数据来源', 'Data source required')}</small>}</span><Plus size={15} />
        </button>
      })}</div>
      <div className="lh-composer-library-heading"><h3>{t('文档活动', 'Document activity')}</h3></div>
      <div className="lh-composer-library-items">{documentActivityPresets.map(preset => <button type="button" key={preset.id} className="lh-composer-library-item" data-activity-preset={preset.id} disabled={disabled || limit} onClick={() => addActivity(preset.id)}><span className="lh-composer-library-icon"><CalendarDays size={20}/></span><span><strong>{preset.name}</strong></span><Plus size={15}/></button>)}</div>
      {spaceId && <div className="lh-composer-mini-actions lh-composer-library-actions"><ComposerButton disabled={disabled} onClick={() => requestLibraryDialog('preset')}><LayoutDashboard size={14}/><span>{t('预置仪表板', 'Dashboard presets')}</span></ComposerButton><ComposerButton disabled={disabled || limit} onClick={() => requestLibraryDialog('import')}><Upload size={14} /><span>{t('导入模板', 'Import template')}</span></ComposerButton><ComposerButton disabled={disabled || sourcesBusy} aria-label={t('刷新来源', 'Refresh sources')} title={t('刷新来源', 'Refresh sources')} aria-busy={sourcesBusy} onClick={async () => { setSourcesBusy(true); try { const value = await request<ComposerSource[]>(`/spaces/${encodeURIComponent(spaceId)}/sources`); setSources(value); sourceCallback.current?.(value); setSourceError(false) } catch { setSourceError(true) } finally { setSourcesBusy(false) } }}><RefreshCw size={14} className={sourcesBusy ? 'admin-spin' : undefined} aria-hidden="true"/></ComposerButton></div>}
      {sourceError && <p className="lh-composer-hint">{t('外部来源暂未加载；现有绑定保留。', 'External sources are unavailable; existing bindings are retained.')}</p>}
      <div className="lh-composer-library-heading"><h3>{t('页面内容', 'Page content')}</h3></div>
      <div className="lh-composer-library-items">{(['header', 'footer'] as const).map(area => <button type="button" className="lh-composer-library-item" key={area} disabled={disabled} onClick={() => select({ kind: 'chrome', area, alignment: area === 'header' ? 'left' : 'right' })}>
        <span className="lh-composer-library-icon">{area === 'header' ? <PanelTop size={20} /> : <PanelBottom size={20} />}</span><span><strong>{area === 'header' ? t('页眉', 'Header') : t('页脚', 'Footer')}</strong></span><ChevronRight size={15} />
      </button>)}</div>
    </TabsPrimitive.Content>
  </TabsPrimitive.Root></div>

  const pageInspector = <div className="lh-composer-page-inspector">
    <div className="lh-composer-inspector-section"><h3>{t('首页主题', 'Homepage theme')}</h3>
      <div className="lh-composer-themes" role="group" aria-label={t('首页主题', 'Homepage theme')}>
        {builtinPageThemes.map(item => <button type="button" key={item.id} className="lh-composer-theme" disabled={disabled} aria-pressed={config.pageTheme.id === item.id} onClick={() => change(switchPageTheme(config, item.id))} style={{ '--hc-theme-accent': item.accent } as CSSProperties}>
          <span className={`lh-composer-theme-preview ${item.id === 'builtin/ios' ? 'is-ios' : ''}`} aria-hidden="true"><i />{Array.from({ length: 6 }, (_, index) => <b key={index} />)}</span><span>{item.name}{config.pageTheme.id === item.id && <Check size={13} />}</span>
        </button>)}
      </div>
    </div>
    <div className="lh-composer-inspector-section"><h3>{t('全局外观', 'Appearance')}</h3>
      <ComposerSelect label={t('配色', 'Color mode')} value={config.appearance.colorMode} disabled={disabled} options={[{ value: 'light', label: t('浅色', 'Light') }, { value: 'dark', label: t('深色', 'Dark') }, { value: 'system', label: t('跟随系统', 'System') }]} onChange={value => edit(next => { next.appearance.colorMode = value as PageConfig['appearance']['colorMode'] })} />
      <ComposerSelect label={t('内容密度', 'Content density')} value={config.appearance.density} disabled={disabled} options={[{ value: 'comfortable', label: t('舒适', 'Comfortable') }, { value: 'compact', label: t('紧凑', 'Compact') }]} onChange={value => edit(next => { next.appearance.density = value as PageConfig['appearance']['density'] })} />
      <ComposerSelect label={t('组件间距', 'Component spacing')} value={String(config.layout.gap)} disabled={disabled} options={[...new Set([8, 12, 16, 24, config.layout.gap])].sort((a, b) => a - b).map(value => ({ value: String(value), label: `${value} px` }))} onChange={value => edit(next => { next.layout.gap = Number(value) })} />
    </div>
    <div className="lh-composer-inspector-section"><h3>{t('页眉与页脚', 'Header and footer')}</h3>
      <ComposerButton onClick={() => select({ kind: 'chrome', area: 'header', alignment: 'left' })} disabled={disabled}><PanelTop size={15} />{t('编辑页眉', 'Edit header')}<ChevronRight size={14} /></ComposerButton>
      <ComposerButton onClick={() => select({ kind: 'chrome', area: 'footer', alignment: 'right' })} disabled={disabled}><PanelBottom size={15} />{t('编辑页脚', 'Edit footer')}<ChevronRight size={14} /></ComposerButton>
    </div>
  </div>
  const inspector = <div className="lh-composer-inspector">
    <div className="lh-composer-inspector-heading"><Settings2 size={16} /><h2>{inspectorTitle}</h2></div>
    {selectedView ? <HomePanelInspector key={selectedView.id} config={config} view={selectedView} sources={allSources} spaceId={spaceId} disabled={disabled} onChange={change} onSelect={select} onError={setError} />
      : selection.kind === 'chrome' ? <HomeChromeInspector key={selection.area} chrome={config.chrome} area={selection.area} alignment={selection.alignment} disabled={disabled} issue={chromeIssue} onSelect={select} onChange={next => edit(value => { value.chrome = next })} /> : pageInspector}
  </div>

  return <section className={`lh-composer${previewing ? ' is-previewing' : ''}`} aria-label={t('首页可视化编辑器', 'Visual homepage editor')} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save() } }}>
    <header className="lh-composer-toolbar">
      <div className="lh-composer-toolbar-title"><ProjectLogo size={26} /><strong>{t('编辑首页', 'Edit homepage')}</strong><span className="lh-composer-draft-status" role="status">{dirty ? t('未保存', 'Unsaved') : t('未修改', 'No changes')}</span></div>
      <div className="lh-composer-toolbar-tools">
        <div className="lh-composer-history" role="group" aria-label={t('编辑历史', 'Edit history')}>
          <ComposerButton kind="icon" aria-label={t('撤销', 'Undo')} title={t('撤销（Ctrl / ⌘ + Z）', 'Undo (Ctrl / ⌘ + Z)')} disabled={busy || previewing || historyBusy || !canUndo} onClick={() => { setError(''); setChromeIssue(null); onUndo() }}><Undo2 size={16}/></ComposerButton>
          <ComposerButton kind="icon" aria-label={t('重做', 'Redo')} title={t('重做（Ctrl / ⌘ + Shift + Z）', 'Redo (Ctrl / ⌘ + Shift + Z)')} disabled={busy || previewing || historyBusy || !canRedo} onClick={() => { setError(''); setChromeIssue(null); onRedo() }}><Redo2 size={16}/></ComposerButton>
        </div>
        <ComposerButton className="lh-composer-library-toggle" disabled={busy || previewing} aria-label={t('组件与页面结构', 'Components and layers')} aria-expanded={compact ? drawer === 'library' : undefined} onClick={() => openLibrary('library')}><Plus size={16} /><span>{t('添加组件', 'Add component')}</span></ComposerButton>
        <ComposerButton className="lh-composer-inspector-toggle" disabled={busy || previewing} aria-label={t('打开属性设置', 'Open properties')} aria-expanded={drawer === 'inspector'} onClick={() => { returnFocus.current = document.activeElement as HTMLElement; setDrawer('inspector') }}><PanelRight size={16} /><span>{t('属性', 'Properties')}</span></ComposerButton>
        <ComposerButton aria-pressed={previewing} disabled={busy} onClick={() => { onPreviewChange(!previewing); setDrawer(null) }}>{previewing ? <Pencil size={16} /> : <Eye size={16} />}<span>{previewing ? t('继续编辑', 'Keep editing') : t('预览', 'Preview')}</span></ComposerButton>
      </div>
      <div className="lh-composer-toolbar-actions">
        <ComposerButton className="lh-composer-restore" disabled={busy || !dirty} title={t('恢复本次编辑开始时的配置', 'Restore the configuration from the start of this edit')} onClick={restore}><RotateCcw size={15} /><span>{t('恢复', 'Restore')}</span></ComposerButton>
        <ComposerButton disabled={busy} onClick={onCancel}>{t('取消', 'Cancel')}</ComposerButton>
        <ComposerButton kind="primary" disabled={busy || !dirty} onClick={save}>{busy ? <LoaderCircle size={15} className="lh-spin" /> : <Check size={15} />}<span>{busy ? t('保存中', 'Saving') : t('保存页面', 'Save page')}</span></ComposerButton>
      </div>
    </header>
    {(notice || error) && <div className="lh-composer-feedback">{notice}{error && <p className="lh-composer-inline-error" role="alert">{error}</p>}</div>}
    <div className="lh-composer-workbench">
      {!previewing && !compact && <aside className="lh-composer-sidebar is-library" aria-label={t('组件与页面结构', 'Components and layers')}>{library}</aside>}
      <div className="lh-composer-stage">
        {!previewing && <div className="lh-composer-canvas-bar"><span><LayoutTemplate size={13} />{t('实时画布', 'Live canvas')}</span><small>{narrow ? t('窄屏布局', 'Narrow layout') : t('拖动组件标题可调整位置', 'Drag component headings to move')}</small></div>}
        <div className="lh-composer-canvas" id="home-composer-canvas">{children}</div>
      </div>
      {!previewing && !compact && <aside className="lh-composer-sidebar is-inspector" aria-label={t('组件属性', 'Component properties')}>{inspector}</aside>}
    </div>
    {importOpen && spaceId && <Suspense fallback={<p role="status">{t('正在加载导入工具…', 'Loading import tools…')}</p>}><WidgetImportDialog spaceId={spaceId} space={space} canCreateSource={canManageSources} config={config} sources={allSources}
      onSourcesChange={value => { setSources(value); sourceCallback.current?.(value); setSourceError(false) }} onClose={() => setImportOpen(false)}
      onApply={(next, id) => { change(next); select({ kind: 'view', id }); setLibraryTab('layers') }} /></Suspense>}
    {presetOpen && spaceId && <Suspense fallback={<p role="status">{t('正在加载仪表板预置…', 'Loading dashboard presets…')}</p>}><DashboardPresetDialog spaceId={spaceId} space={space} canCreateSource={canManageSources} config={config} sources={allSources}
      onSourcesChange={value => { setSources(value); sourceCallback.current?.(value); setSourceError(false) }} onClose={() => setPresetOpen(false)}
      onApply={next => { change(next); select({ kind: 'page' }); setLibraryTab('layers') }} /></Suspense>}
    <DialogPrimitive.Root open={compact && drawer !== null && !previewing} onOpenChange={open => { if (!open) setDrawer(null) }}>
      <DialogPrimitive.Portal><DialogPrimitive.Overlay className="lh-composer-drawer-overlay" />
        <DialogPrimitive.Content className="lh-composer-drawer lh-composer-chrome-ui" aria-describedby={undefined} onCloseAutoFocus={closeDrawerFocus}>
          <div className="lh-composer-drawer-header"><DialogPrimitive.Title>{drawer === 'library' ? t('组件与页面结构', 'Components and layers') : t('组件属性', 'Component properties')}</DialogPrimitive.Title><DialogPrimitive.Close asChild><ComposerButton kind="icon" aria-label={t('关闭面板', 'Close panel')}><X size={18} /></ComposerButton></DialogPrimitive.Close></div>
          <div className="lh-composer-drawer-body">{drawer === 'library' ? library : inspector}</div>
          <div className="lh-composer-drawer-footer"><DialogPrimitive.Close asChild><ComposerButton kind="primary">{t('返回画布', 'Back to canvas')}</ComposerButton></DialogPrimitive.Close></div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  </section>
}
