import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Check, LayoutDashboard, Plus, RefreshCw } from 'lucide-react'
import { messageOf, request } from '../core/api'
import { getLocale, t } from '../core/i18n'
import type { PageConfig, Space } from '../core/types'
import type { SourceInfo } from '../admin/IntegrationsPanel'
import type { ComposerSource } from '../home/composition'
import { DASHBOARD_PRESETS, compileDashboardPreset, createDashboardPresetAssignments, matchingDashboardPresetSources, type DashboardPresetAssignments, type DashboardPresetIssue, type DashboardPresetSlot, type DashboardPresetText } from '../home/dashboard-presets'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { StyledSelect } from './ui/select'
import { ErrorMessage, Field, Modal } from './Shared'
import './dashboard-presets-dialog.css'

const SourceDialog = lazy(() => import('../admin/SourceDialog'))
type Props = {
  spaceId: string; space?: Space; canCreateSource?: boolean; config: PageConfig; sources: ComposerSource[]
  onSourcesChange?: (sources: ComposerSource[]) => void; onApply: (config: PageConfig) => void; onClose: () => void
}
const label = (value: DashboardPresetText) => getLocale() === 'zh-CN' ? value.zh : value.en
const sourceName = (source: ComposerSource) => source.datasetId === 'local-navigation' ? t('本地书签', 'Local bookmarks') : source.name
function initialKind(schema: string) {
  return schema === 'calendar.events' ? 'calendar-ics' : schema === 'weather.forecast' ? 'weather-open-meteo'
    : schema === 'github.traffic' ? 'github-traffic' : schema === 'navigation.collection' ? 'external-push' : 'external-json'
}
function issueMessage(issue: DashboardPresetIssue, slots: readonly DashboardPresetSlot[]) {
  const names = issue.slotIds.map(id => { const slot = slots.find(item => item.id === id); return slot ? label(slot.title) : id }).join(t('、', ', '))
  switch (issue.code) {
    case 'source-required': return t('{names} 仍待绑定，请选择数据来源或取消勾选。', '{names} still needs a data source. Choose one or deselect the component.', { names })
    case 'source-unavailable': case 'ambiguous-source': return t('{names} 的来源不可用。请刷新列表并重新选择。', 'The source for {names} is unavailable. Refresh the list and choose again.', { names })
    case 'source-schema-mismatch': return t('{names} 的数据格式不匹配，请选择兼容来源。', 'The data format for {names} does not match. Choose a compatible source.', { names })
    case 'source-disabled': return t('{names} 的来源已停用，请先启用来源或取消勾选。', 'The source for {names} is disabled. Enable it first or deselect the component.', { names })
    case 'page-limit': case 'layout-limit': return t('所选组件超出页面支持的数量或尺寸，请减少选择后重试。', 'The selection exceeds the supported page count or size. Select fewer components and try again.')
    case 'unknown-preset': case 'unknown-slot': return t('此预置的组件配置已改变，请重新选择预置。', 'This preset’s component configuration has changed. Select the preset again.')
    default: return t('当前页面无法应用此预置。请保留草稿并检查页面配置。', 'This preset cannot be applied to the current page. Keep your draft and check its configuration.')
  }
}

export default function DashboardPresetDialog({ spaceId, space, canCreateSource = false, config, sources, onSourcesChange, onApply, onClose }: Props) {
  const [presetId, setPresetId] = useState<string>(DASHBOARD_PRESETS[0]!.id)
  const [inventory, setInventory] = useState<ComposerSource[]>(sources)
  const [assignments, setAssignments] = useState<DashboardPresetAssignments>(() => createDashboardPresetAssignments(DASHBOARD_PRESETS[0]!.id, sources, config))
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [sourceNotice, setSourceNotice] = useState('')
  const [creatingFor, setCreatingFor] = useState<string | null>(null)
  const pending = useRef<AbortController | null>(null), mounted = useRef(true)
  const sourceCallback = useRef(onSourcesChange); sourceCallback.current = onSourcesChange
  const preset = DASHBOARD_PRESETS.find(item => item.id === presetId) || DASHBOARD_PRESETS[0]!
  const selectedCount = preset.slots.filter(slot => assignments[slot.id] !== null).length
  const compiled = useMemo(() => compileDashboardPreset({ presetId, config, sources: inventory, assignments, language: getLocale() }), [presetId, config, inventory, assignments])
  const creatingSlot = preset.slots.find(slot => slot.id === creatingFor)

  async function loadSources(resetDefaults = false) {
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller
    setLoading(true); setError(''); setSourceNotice('')
    try {
      const value = await request<ComposerSource[]>('/spaces/' + encodeURIComponent(spaceId) + '/sources', { signal: controller.signal })
      if (!mounted.current || controller.signal.aborted) return
      setInventory(value); sourceCallback.current?.(value)
      if (resetDefaults) setAssignments(createDashboardPresetAssignments(presetId, value, config))
    } catch (cause) { if (mounted.current && !controller.signal.aborted) setError(messageOf(cause)) }
    finally { if (mounted.current && !controller.signal.aborted) { setLoading(false); pending.current = null } }
  }
  useEffect(() => {
    mounted.current = true; void loadSources(true)
    return () => { mounted.current = false; pending.current?.abort() }
  }, [spaceId])
  function choosePreset(id: string) {
    if (loading || id === presetId) return
    setPresetId(id); setAssignments(createDashboardPresetAssignments(id, inventory, config)); setSourceNotice('')
  }
  function toggleSlot(slot: DashboardPresetSlot, checked: boolean) {
    if (loading) return
    const defaults = createDashboardPresetAssignments(presetId, inventory, config)
    const matching = matchingDashboardPresetSources(slot, inventory)
    setAssignments(current => ({ ...current, [slot.id]: !checked ? null : defaults[slot.id] || (matching.length === 1 ? matching[0]!.datasetId : undefined) }))
  }
  function sourceSaved(value: SourceInfo) {
    const item: ComposerSource = { id: value.id, name: value.name, datasetId: value.datasetId, schemaId: value.schemaId, schemaVersion: value.schemaVersion, enabled: value.enabled }
    const next = [...inventory.filter(source => source.datasetId !== item.datasetId), item]
    setInventory(next); sourceCallback.current?.(next); setError('')
    const matching = creatingSlot && matchingDashboardPresetSources(creatingSlot, [item]).some(source => source.datasetId === item.datasetId)
    if (creatingSlot && matching) setAssignments(current => current[creatingSlot.id] === null ? current : { ...current, [creatingSlot.id]: item.datasetId })
    setSourceNotice(matching
      ? t('来源已保存并选中；预置仍未应用，页面仍需显式保存。', 'Source saved and selected. The preset has not been applied, and the page still needs an explicit save.')
      : t('来源已保存，但尚未启用或格式不兼容；请先启用兼容来源再绑定。', 'Source saved, but it is disabled or its format is incompatible. Enable a compatible source before binding it.'))
  }
  if (creatingSlot && space && canCreateSource) return <Suspense fallback={<Modal title={t('添加数据来源', 'Add data source')} onClose={() => setCreatingFor(null)}><p role="status">{t('正在加载来源表单…', 'Loading the source form…')}</p></Modal>}>
    <SourceDialog space={space} source={null} initialKind={initialKind(creatingSlot.schema.id)} requiredSchema={creatingSlot.schema.id}
      contextNote={t('来源会立即保存到此空间；返回后保留本次预置选择，应用布局和保存页面仍由你确认。', 'The source is saved to this space immediately. Your preset choices are kept when you return; applying the layout and saving the page remain separate actions.')}
      onSaved={sourceSaved} onClose={() => setCreatingFor(null)} />
  </Suspense>

  return <Modal wide title={t('预置仪表板', 'Dashboard presets')} onClose={onClose}
    description={t('选择起始布局，连接自己的来源。所有组件都由 Home 内置提供。', 'Choose a starting layout and connect your sources. Every component is bundled with Home.')}>
    <div className="dashboard-presets-dialog">
      <div className="dashboard-preset-gallery" aria-label={t('预置布局', 'Preset layouts')}>
        {DASHBOARD_PRESETS.map(item => {
          const rows = Math.max(...item.slots.map(slot => slot.layout.y + slot.layout.h))
          return <button key={item.id} type="button" className="dashboard-preset-card" data-preset={item.id} aria-label={label(item.title)} aria-pressed={presetId === item.id} disabled={loading} onClick={() => choosePreset(item.id)}>
            <span className="dashboard-preset-thumb" aria-hidden="true" style={{ gridTemplateRows: 'repeat(' + rows + ', minmax(0,1fr))' }}>
              {item.slots.map(slot => <span key={slot.id} data-renderer={slot.renderer} style={{ gridColumn: (slot.layout.x + 1) + ' / span ' + slot.layout.w, gridRow: (slot.layout.y + 1) + ' / span ' + slot.layout.h } as CSSProperties}>{label(slot.title)}</span>)}
            </span>
            <span className="dashboard-preset-card-title"><strong>{label(item.title)}</strong>{presetId === item.id && <Check size={16}/>}</span>
            <span className="dashboard-preset-description">{label(item.description)}</span>
          </button>
        })}
      </div>
      <section className="dashboard-preset-bindings" aria-label={t('组件与数据来源', 'Components and data sources')}>
        <div className="dashboard-preset-section-heading"><h3><LayoutDashboard size={18}/>{label(preset.title)}</h3><Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => { void loadSources() }}><RefreshCw size={14}/>{t('刷新数据来源', 'Refresh data sources')}</Button></div>
        <p className="dashboard-preset-note">{t('勾选的组件必须绑定已启用且格式匹配的真实来源；未勾选的组件不会加入页面。书签和收藏优先沿用当前合法来源，未设置时使用本地书签。', 'Selected components need an enabled source with the matching format. Unselected components are omitted. Bookmarks and favorites retain their current valid source, falling back to local bookmarks when none is configured.')}</p>
        {loading && <p className="dashboard-preset-note" role="status">{t('正在读取来源列表…', 'Loading data sources…')}</p>}
        <ErrorMessage error={error}/>
        {preset.slots.map(slot => {
          const included = assignments[slot.id] !== null, choices = matchingDashboardPresetSources(slot, inventory)
          const selected = choices.find(source => source.datasetId === assignments[slot.id])
          return <section className="dashboard-preset-slot" data-slot={slot.id} data-state={!included ? 'omitted' : selected ? 'bound' : 'pending'} key={slot.id}>
            <div className="dashboard-preset-slot-heading">
              <label className="dashboard-preset-check"><Checkbox checked={included} disabled={loading} onCheckedChange={checked => toggleSlot(slot, checked)} aria-label={t('加入 {name}', 'Include {name}', { name: label(slot.title) })}/><strong>{label(slot.title)}</strong>{slot.optional && <small>{t('可选', 'Optional')}</small>}</label>
              <span className="dashboard-preset-slot-state">{!included ? t('未加入', 'Omitted') : selected ? t('已绑定', 'Bound') : t('待绑定', 'Needs a source')}</span>
            </div>
            {included && <>
              <Field label={t('{name}的数据来源', 'Data source for {name}', { name: label(slot.title) })} hint={slot.schema.id + '@' + slot.schema.version}>
                <StyledSelect value={selected?.datasetId || ''} disabled={loading} onValueChange={value => setAssignments(current => ({ ...current, [slot.id]: value || undefined }))}
                  options={[{ value: '', label: t('选择兼容来源', 'Choose a compatible source') }, ...choices.map(source => ({ value: source.datasetId, label: sourceName(source) }))]}/>
              </Field>
              {selected ? <p className="dashboard-preset-note">{t('将显示：{name}', 'Will display: {name}', { name: sourceName(selected) })}{selected.datasetId !== 'local-navigation' && t('。尚无快照时，会等待该来源的首次数据。', '. If no snapshot exists, the component waits for the source’s first data.')}</p>
                : <p className="dashboard-preset-note">{choices.length ? t('请选择一个来源，或取消勾选此组件。', 'Choose a source or deselect this component.') : t('还没有已启用的兼容来源。可创建来源、启用已有来源后刷新，或取消勾选。', 'No enabled compatible source is available. Create one, enable an existing source and refresh, or deselect this component.')}</p>}
              {canCreateSource && space && <div className="dashboard-preset-source-action"><Button type="button" variant="outline" size="sm" disabled={loading} aria-label={t('为 {name} 创建兼容来源', 'Create a compatible source for {name}', { name: label(slot.title) })} onClick={() => setCreatingFor(slot.id)}><Plus size={14}/>{t('创建兼容来源', 'Create a compatible source')}</Button></div>}
              {!canCreateSource && !selected && <p className="dashboard-preset-note">{t('创建来源需要登录有编辑权限的账号；也可以暂时取消勾选此组件。', 'Creating a source requires a signed-in account with edit access. You can deselect this component for now.')}</p>}
            </>}
          </section>
        })}
      </section>
      {sourceNotice && <p className="admin-info" role="status">{sourceNotice}</p>}
      {!!compiled.warnings.length && <div className="dashboard-preset-warning" role="status">{compiled.warnings.map(warning => <p key={warning.code + warning.datasetId}>{t('两个统计组件绑定了同一来源，会各自显示同一整组指标。若要比较不同数据，请选择不同来源；此预置不会自动拆分或筛选指标。', 'Both metrics components use the same source and will each show the entire metric set. Choose different sources to compare different data; this preset does not split or filter metrics automatically.')}</p>)}</div>}
      {!compiled.ok && !loading && <div className="dashboard-preset-issues" role="status">{compiled.issues.map((issue, index) => <p key={issue.code + index}>{issueMessage(issue, preset.slots)}</p>)}</div>}
      <p className="dashboard-preset-apply-note">{t('将用所选 {count} 个组件替换当前草稿中的组件布局。保留主题、配色、页眉页脚、搜索和分类导航；不会修改书签或来源数据。应用后仍需“保存页面”。', 'Replaces the current draft’s component layout with {count} selected components. Keeps the theme, appearance, header, footer, search and category navigation. Bookmark and source data stay intact. Choose Save page afterward to persist the layout.', { count: selectedCount })}</p>
      <div className="dashboard-preset-actions"><Button type="button" variant="outline" onClick={onClose}>{t('取消', 'Cancel')}</Button><Button type="button" disabled={loading || !compiled.ok} onClick={() => { if (!loading && compiled.ok) { onApply(compiled.config); onClose() } }}>{t('替换当前草稿布局', 'Replace draft layout')}</Button></div>
    </div>
  </Modal>
}
