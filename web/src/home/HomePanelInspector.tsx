import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, LockKeyhole, Plus, Trash2, UnlockKeyhole, X } from 'lucide-react'
import { Input } from '../components/ui/input'
import { NavigationContentFields } from '../components/NavigationContentFields'
import { t } from '../core/i18n'
import { readCategoryNavigationSettings, viewId } from '../core/presentation'
import type { PageConfig, Slot, View } from '../core/types'
import { ComposerButton, ComposerCheck, ComposerField, ComposerSelect } from './HomeEditorControls'
import { bindPagePanel, panelContracts, duplicatePagePanel, movePagePanel, panelLocked, panelNeighbor, removePagePanel, reorderPagePanel, resizePagePanel, setPanelLock, type ComposerSource, type HomeSelection } from './composition'

const localSource: ComposerSource = { id: '', get name() { return t('本地书签', 'Local bookmarks') }, datasetId: 'local-navigation', schemaId: 'navigation.collection' }
const linkingPanels = ['builtin/search', 'builtin/category-navigation', 'builtin/favorites', 'builtin/navigation']

function InteractionGroup({ view, views, disabled, onChange }: { view: View; views: View[]; disabled: boolean; onChange: (scope: string) => void }) {
  const [creating, setCreating] = useState(false), [name, setName] = useState(''), [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const scope = view.interactionScope || view.id
  const members = views.filter(item => (item.interactionScope || item.id) === scope)
  const independent = members.length === 1 && (!view.interactionScope || scope === view.id || scope.startsWith('independent:'))
  const groups = [...new Set(['primary-navigation', ...views.filter(item => linkingPanels.includes(item.panel.id)).map(item => item.interactionScope || item.id)])].filter(value => {
    const list = views.filter(item => (item.interactionScope || item.id) === value)
    return value === 'primary-navigation' || !(list.length === 1 && (value === list[0]!.id || value.startsWith('independent:')))
  })
  useEffect(() => { if (creating) input.current?.focus() }, [creating])
  function create() {
    const cleaned = name.trim()
    if (!cleaned || cleaned.length > 75 || /[\u0000-\u001f\u007f]/.test(cleaned)) { setError(t('填写 1–75 个字符的分组名称。', 'Enter a group name of 1–75 characters.')); return }
    onChange('user:' + cleaned); setCreating(false); setName(''); setError('')
  }
  return <div className="lh-composer-interaction-group">
    <ComposerSelect label={t('搜索与分类联动', 'Search and category linking')} value={independent ? 'independent' : 'scope:' + scope} disabled={disabled}
      onChange={value => { onChange(value === 'independent' ? 'independent:' + viewId() : value.slice(6)); setCreating(false); setError('') }}
      options={[
        ...groups.map((value, index) => ({ value: 'scope:' + value, label: value === 'primary-navigation' ? t('主导航', 'Main navigation') : value.startsWith('user:') ? value.slice(5) : t('已有分组 {number}', 'Existing group {number}', { number: index }) })),
        { value: 'independent', label: t('独立使用', 'Use independently') }
      ]} />
    {!creating ? <ComposerButton className="lh-composer-text-action" disabled={disabled} onClick={() => setCreating(true)}><Plus size={13} />{t('新建联动分组', 'New linking group')}</ComposerButton>
      : <div className="lh-composer-new-group">
        <ComposerField label={t('分组名称', 'Group name')}><Input className="lh-composer-input" ref={input} maxLength={75} value={name} disabled={disabled}
          onChange={event => { setName(event.target.value); setError('') }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); create() } }} /></ComposerField>
        {error && <p className="lh-composer-inline-error" role="alert">{error}</p>}
        <div className="lh-composer-mini-actions"><ComposerButton disabled={disabled} onClick={create}>{t('创建', 'Create')}</ComposerButton><ComposerButton kind="icon" disabled={disabled} aria-label={t('取消新建分组', 'Cancel new group')} onClick={() => { setCreating(false); setError('') }}><X size={14} /></ComposerButton></div>
      </div>}
  </div>
}

export function HomePanelInspector({ config, view, sources, disabled, onChange, onSelect, onError }: {
  config: PageConfig; view: View; sources: ComposerSource[]; disabled: boolean;
  onChange: (config: PageConfig) => void; onSelect: (selection: HomeSelection) => void; onError: (message: string) => void
}) {
  const placement = config.layout.placements[view.id]?.base || { kind: 'hidden' }
  const locked = panelLocked(config, view.id), hidden = placement.kind === 'hidden'
  const category = view.panel.id === 'builtin/category-navigation', search = view.panel.id === 'builtin/search'
  const traffic = view.panel.id === 'builtin/github-traffic', links = ['builtin/navigation', 'builtin/favorites'].includes(view.panel.id)
  const alias = Object.values(view.inputs)[0], binding = alias ? config.bindings[alias] : undefined
  const compatible = [localSource, ...sources].filter((source, index, all) => all.findIndex(item => item.datasetId === source.datasetId) === index && source.schemaId === panelContracts[view.panel.id]?.schema)
  const categorySettings = readCategoryNavigationSettings(view.settings)

  const change = (operation: () => PageConfig) => { if (disabled) return; try { onChange(operation()) } catch (error) { onError(error instanceof Error ? error.message : t('无法修改此组件。', 'This component could not be updated.')) } }
  const editView = (update: (next: View) => void) => change(() => { const next = structuredClone(config); update(next.views.find(item => item.id === view.id)!); return next })
  const settings = (values: Record<string, unknown>) => editView(next => { Object.assign(next.settings, values) })
  const positions = [
    { value: 'top', label: t('顶部', 'Top') }, { value: 'left', label: t('左侧', 'Left') },
    ...(!category ? [{ value: 'main', label: t('主内容区', 'Main canvas') }] : []),
    { value: 'right', label: t('右侧', 'Right') }, { value: 'bottom', label: t('底部', 'Bottom') }, { value: 'hidden', label: t('隐藏', 'Hidden') }
  ]
  function duplicate() {
    if (disabled) return
    try { const result = duplicatePagePanel(config, view.id); if (result) { onChange(result.config); onSelect({ kind: 'view', id: result.id }) } }
    catch (error) { onError(error instanceof Error ? error.message : t('无法复制组件。', 'The component could not be duplicated.')) }
  }
  return <div className="lh-composer-panel-inspector">
    <div className="lh-composer-inspector-section">
      <ComposerField label={t('组件标题', 'Component title')}><Input className="lh-composer-input" value={typeof view.settings.title === 'string' ? view.settings.title : ''} maxLength={80}
        placeholder={t('使用默认标题', 'Use the default title')} disabled={disabled} onChange={event => settings({ title: event.target.value })} /></ComposerField>
      <ComposerSelect label={t('显示位置', 'Position')} value={hidden ? 'hidden' : placement.region} options={positions} disabled={disabled || locked} onChange={value => change(() => movePagePanel(config, view.id, value as Slot))} />
      <div className="lh-composer-panel-actions">
        <ComposerButton disabled={disabled || !panelNeighbor(config, view.id, -1)} title={t('在当前区域上移', 'Move up in this region')} onClick={() => change(() => reorderPagePanel(config, view.id, -1))}><ArrowUp size={14} />{t('上移', 'Up')}</ComposerButton>
        <ComposerButton disabled={disabled || !panelNeighbor(config, view.id, 1)} title={t('在当前区域下移', 'Move down in this region')} onClick={() => change(() => reorderPagePanel(config, view.id, 1))}><ArrowDown size={14} />{t('下移', 'Down')}</ComposerButton>
        <ComposerButton disabled={disabled || locked} onClick={() => change(() => movePagePanel(config, view.id, hidden ? category || search ? 'top' : 'main' : 'hidden'))}>{hidden ? <Eye size={14} /> : <EyeOff size={14} />}{hidden ? t('显示', 'Show') : t('隐藏', 'Hide')}</ComposerButton>
      </div>
      {!hidden && <ComposerCheck label={t('锁定位置与尺寸', 'Lock position and size')} checked={locked} disabled={disabled} onChange={value => change(() => setPanelLock(config, view.id, value))} />}
      {locked && <p className="lh-composer-hint"><LockKeyhole size={13} />{t('解锁后可移动、复制或移除。', 'Unlock to move, duplicate or remove.')}</p>}
    </div>
    {placement.kind === 'grid' && <div className="lh-composer-inspector-section">
      <h3>{t('尺寸', 'Size')}</h3>
      <ComposerSelect label={t('宽度', 'Width')} value={String(placement.w)} disabled={disabled || locked} options={[...new Set([4, 6, 8, 12, 16, 24, placement.w])].sort((a, b) => a - b).map(value => ({ value: String(value), label: value === 24 ? t('整行 · 24 列', 'Full width · 24 columns') : t('{value} 列', '{value} columns', { value }) }))}
        onChange={value => change(() => resizePagePanel(config, view.id, { w: Number(value) }))} />
      <ComposerSelect label={t('高度', 'Height')} value={placement.heightMode} disabled={disabled || locked} options={[{ value: 'content', label: t('适应内容', 'Fit content') }, { value: 'fixed', label: t('固定高度', 'Fixed height') }]}
        onChange={value => change(() => resizePagePanel(config, view.id, { heightMode: value as 'fixed' | 'content', ...(value === 'content' ? { h: 3 } : {}) }))} />
      {placement.heightMode === 'fixed' && <ComposerSelect label={t('高度行数', 'Height in rows')} value={String(placement.h)} disabled={disabled || locked}
        options={[...new Set([3, 4, 6, 8, 12, 16, 24, 32, 48, placement.h])].sort((a, b) => a - b).map(value => ({ value: String(value), label: t('{value} 行', '{value} rows', { value }) }))}
        onChange={value => change(() => resizePagePanel(config, view.id, { h: Number(value) }))} />}
    </div>}
    {search && placement.kind === 'region' && <div className="lh-composer-inspector-section">
      <ComposerSelect label={t('搜索框宽度', 'Search width')} value={String(placement.size?.widthPx || 340)} disabled={disabled || locked}
        options={[...new Set([200, 260, 300, 340, 360, placement.size?.widthPx || 340])].sort((a, b) => a - b).map(value => ({ value: String(value), label: `${value} px` }))}
        onChange={value => change(() => { const next = structuredClone(config); next.layout.placements[view.id]!.base = { ...placement, size: { widthPx: Number(value), maxWidthPx: 360 } }; return next })} />
    </div>}
    {category && <div className="lh-composer-inspector-section">
      <h3>{t('分类样式', 'Category style')}</h3>
      <ComposerSelect label={t('显示模式', 'Display mode')} value={categorySettings.displayMode} disabled={disabled} onChange={value => settings({ displayMode: value })}
        options={[{ value: 'icon-text', label: t('图标与文字', 'Icon + text') }, { value: 'icons', label: t('纯图标', 'Icons only') }, { value: 'text', label: t('纯文字', 'Text only') }]} />
      <ComposerSelect label={t('分类层级', 'Category hierarchy')} value={categorySettings.hierarchyMode} disabled={disabled} onChange={value => settings({ hierarchyMode: value })}
        options={[{ value: 'tree', label: t('树形层级', 'Tree hierarchy') }, { value: 'flat', label: t('平铺分类', 'Flat categories') }]} />
      <ComposerCheck label={t('显示链接数量', 'Show link counts')} checked={categorySettings.showCounts} disabled={disabled} onChange={value => settings({ showCounts: value })} />
      <ComposerCheck label={t('允许展开与收起', 'Allow expanding and collapsing')} checked={categorySettings.collapsible} disabled={disabled || categorySettings.displayMode === 'icons'} onChange={value => settings({ collapsible: value })} />
      <ComposerCheck label={t('默认收起', 'Collapsed by default')} checked={categorySettings.defaultCollapsed} disabled={disabled || !categorySettings.collapsible || categorySettings.displayMode === 'icons'} onChange={value => settings({ defaultCollapsed: value })} />
    </div>}
    {links && <div className="lh-composer-inspector-section">
      <h3>{t('链接样式', 'Link style')}</h3>
      <ComposerSelect label={t('排列方式', 'Presentation')} value={view.settings.variant === 'directory' ? 'directory' : 'cards'} disabled={disabled} onChange={value => settings({ variant: value })}
        options={[{ value: 'cards', label: t('卡片', 'Cards') }, { value: 'directory', label: t('目录', 'Directory') }]} />
      <ComposerSelect label={t('图标与文字', 'Icons and text')} value={typeof view.settings.linkAppearance === 'string' ? view.settings.linkAppearance : ''} disabled={disabled}
        onChange={value => editView(next => { if (!value) delete next.settings.linkAppearance; else next.settings.linkAppearance = value })}
        options={[{ value: '', label: t('跟随主题', 'Theme default') }, { value: 'icon-text', label: t('图标与文字', 'Icon + text') }, { value: 'minimal', label: t('简约文字', 'Minimal text') }, { value: 'app-icons', label: t('应用图标', 'App icons') }]} />
    </div>}
    {links && <section className="lh-composer-inspector-section" data-navigation-content-settings>
      <h3>{t('组件内容', 'Component content')}</h3>
      <NavigationContentFields settings={view.settings} disabled={disabled} SelectControl={ComposerSelect} CheckControl={ComposerCheck}
        onChange={(key, value) => editView(next => { if (value === undefined) delete next.settings[key]; else next.settings[key] = value })}/>
    </section>}
    {view.panel.id === 'builtin/calendar' && <div className="lh-composer-inspector-section"><ComposerSelect label={t('默认日程视图', 'Default calendar view')} value={view.settings.viewMode === 'day' ? 'day' : 'week'} disabled={disabled} onChange={value => settings({ viewMode: value })} options={[{ value: 'day', label: t('日', 'Day') }, { value: 'week', label: t('周', 'Week') }]} /><p className="lh-composer-hint">{t('按来源时区展示全天和跨天日程。', 'Displays all-day and multi-day events in the source time zone.')}</p></div>}
    {view.panel.id === 'builtin/weather' && <div className="lh-composer-inspector-section"><ComposerSelect label={t('显示预报天数', 'Forecast days to show')} value={String(view.settings.forecastDays || 5)} disabled={disabled} onChange={value => settings({ forecastDays: Number(value) })} options={[3, 5, 7].map(value => ({ value: String(value), label: t('{value} 天', '{value} days', { value }) }))} /><p className="lh-composer-hint">{t('地点与采集范围在数据来源中配置。', 'Configure the location and collected range in the data source.')}</p></div>}
    {view.panel.id === 'builtin/metrics' && <div className="lh-composer-inspector-section"><ComposerCheck label={t('显示已定义量程的进度条', 'Show bars for defined metric ranges')} checked={view.settings.showBars !== false} disabled={disabled} onChange={value => settings({ showBars: value })} /></div>}
    {view.panel.id === 'builtin/status' && <div className="lh-composer-inspector-section"><ComposerCheck label={t('显示响应时间', 'Show response times')} checked={view.settings.showLatency !== false} disabled={disabled} onChange={value => settings({ showLatency: value })} /></div>}
    <div className="lh-composer-inspector-section">
      <h3>{t('数据与联动', 'Data and linking')}</h3>
      {!search && <ComposerSelect label={t('数据来源', 'Data source')} value={binding?.datasetId || ''} disabled={disabled}
        hint={binding && Object.keys(binding.query).length ? t('当前来源包含已保存的筛选条件。', 'This source includes saved filters.') : undefined}
        options={[
          ...compatible.map(source => ({ value: source.datasetId, label: source.name })),
          ...(binding && !compatible.some(source => source.datasetId === binding.datasetId) ? [{ value: binding.datasetId, label: t('已绑定的来源', 'Current source') }] : []),
          ...(!binding ? [{ value: '', label: t('请选择数据来源', 'Choose a data source'), disabled: true }] : [])
        ]} onChange={value => { const source = compatible.find(item => item.datasetId === value); if (source) change(() => bindPagePanel(config, view.id, source)) }} />}
      {linkingPanels.includes(view.panel.id) && <InteractionGroup key={view.id} view={view} views={config.views} disabled={disabled} onChange={value => editView(next => { next.interactionScope = value })} />}
    </div>
    <div className="lh-composer-inspector-section lh-composer-delete-actions">
      <ComposerButton disabled={disabled || locked || config.views.length >= 32} onClick={duplicate}><Copy size={15} />{t('复制组件', 'Duplicate component')}</ComposerButton>
      <ComposerButton kind="danger" disabled={disabled || locked} onClick={() => { if (disabled || locked) return; onChange(removePagePanel(config, view.id)); onSelect({ kind: 'page' }) }}><Trash2 size={15} />{t('移除组件', 'Remove component')}</ComposerButton>
    </div>
  </div>
}
