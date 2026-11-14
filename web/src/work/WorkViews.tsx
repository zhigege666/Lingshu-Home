import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Copy, Play, Plus, Save, Search, Trash2, X } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { requestNavigation } from '../core/navigation'
import { useUnsavedChanges } from '../core/useUnsavedChanges'
import { newWorkId, workPath, type WorkProject, type WorkStatusDefinition } from '../core/work-types'
import type { WorkCatalogPage, WorkSavedView, WorkViewDefinition } from '../core/work-planning-types'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { ErrorMessage, Field, Loading, handleFormInvalid } from '../components/Shared'
import DiscardChangesDialog from '../components/DiscardChangesDialog'
import { WorkFieldChoices, WorkFilterFields, workFieldLabel } from './WorkFilters'
import { useWorkTheme } from './work-theme'
import './work-tools.css'

type Draft = Pick<WorkSavedView, 'name' | 'visibility' | 'definition'>
const normalized = (value: Draft): Draft => ({ name: value.name.trim(), visibility: value.visibility, definition: { ...value.definition, fields: [...value.definition.fields].sort(), filters: Object.fromEntries(Object.entries(value.definition.filters).filter(([, value]) => value !== undefined && value !== '' && !(Array.isArray(value) && !value.length))) } })
function ViewEditor({ spaceId, selected, current, projects, statuses, enabled, onApply, onSaved, onDeleted, onClose }: { spaceId: string; selected: { id: string; value?: WorkSavedView }; current: WorkViewDefinition; projects: WorkProject[]; statuses: WorkStatusDefinition[]; enabled: boolean; onApply: (value: WorkSavedView) => void; onSaved: (value: WorkSavedView) => void; onDeleted: () => void; onClose: () => void }) {
  const [base, setBase] = useState(selected.value || null), [draft, setDraft] = useState<Draft>(() => selected.value ? structuredClone(selected.value) : { name: '', visibility: 'private', definition: structuredClone(current) })
  const initial = useRef(draft), alive = useRef(true), pending = useRef(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [latest, setLatest] = useState<WorkSavedView | null>(null), [uncertain, setUncertain] = useState(false), [confirmDelete, setConfirmDelete] = useState(false)
  const canEdit = enabled && (!base || base.canEdit), dirty = JSON.stringify(normalized(draft)) !== JSON.stringify(normalized(base || initial.current)), guard = useUnsavedChanges(dirty, busy)
  const endpoint = `${workPath(spaceId)}/views`
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  function adopt(value: WorkSavedView) { setBase(value); setDraft(structuredClone(value)); setLatest(null); setUncertain(false); setConfirmDelete(false); setError('') }
  async function readLatest() {
    if (pending.current) return
    pending.current = true; setBusy(true)
    try {
      const result = await request<WorkCatalogPage<WorkSavedView>>(`${endpoint}?${new URLSearchParams({ id: selected.id })}`)
      if (!alive.current) return
      const value = result.items[0]
      if (!value) { if (confirmDelete) onDeleted(); else { setUncertain(false); setError(t('视图已不存在或不可访问，草稿保留。', 'The view is missing or unavailable; your draft is retained.')) }; return }
      if (!confirmDelete && uncertain && JSON.stringify(normalized(value)) === JSON.stringify(normalized(draft))) { adopt(value); onSaved(value) }
      else { setLatest(value); setError(t('最新配置已读取，草稿保留。', 'The latest configuration is available; your draft is retained.')) }
    } catch (cause) { if (alive.current) setError(messageOf(cause)) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (pending.current || !canEdit || uncertain || latest || !draft.name.trim()) return
    pending.current = true; setBusy(true); setError('')
    try {
      const value = await request<WorkSavedView>(base ? `${endpoint}/${base.id}` : endpoint, { method: base ? 'PATCH' : 'POST', body: base ? { expectedRevision: base.revision, ...normalized(draft) } : { id: selected.id, ...normalized(draft) } })
      if (alive.current) { adopt(value); onSaved(value) }
    } catch (cause) { if (alive.current) { setError(messageOf(cause)); if (!(cause instanceof ApiError) || cause.status >= 500 || cause.status === 409) setUncertain(true) } }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function remove() {
    if (!base || pending.current || !canEdit || uncertain || latest) return
    pending.current = true; setBusy(true); setError('')
    try { await request(`${endpoint}/${base.id}`, { method: 'DELETE', body: { expectedRevision: base.revision } }); if (alive.current) onDeleted() }
    catch (cause) { if (alive.current) { setError(messageOf(cause)); if (!(cause instanceof ApiError) || cause.status >= 500 || cause.status === 409) setUncertain(true) } }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  return <><form className="work-tool-editor" onSubmit={event => void save(event)} onInvalidCapture={event => handleFormInvalid(event, setError)}><header><h3>{base ? t('视图设置', 'View settings') : t('保存当前视图', 'Save current view')}</h3><Button type="button" size="icon-sm" variant="ghost" aria-label={t('关闭编辑', 'Close editor')} disabled={busy} onClick={() => guard.requestLeave(onClose)}><X size={16}/></Button></header><div className="work-tool-editor-body"><ErrorMessage error={error}/>{(uncertain || latest) && <section className="work-conflict"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void readLatest()}>{t('读取最新配置', 'Read latest configuration')}</Button>{latest && <><p>{latest.name} · {latest.visibility === 'private' ? t('私人', 'Private') : t('空间共享', 'Shared in space')}</p><dl><dt>{t('布局', 'Layout')}</dt><dd>{({ board: t('看板', 'Board'), list: t('清单', 'List'), calendar: t('日历', 'Calendar') })[latest.definition.layout]}</dd><dt>{t('筛选条件', 'Filters')}</dt><dd>{Object.keys(latest.definition.filters).length}</dd><dt>{t('显示字段', 'Visible fields')}</dt><dd>{latest.definition.fields.map(workFieldLabel).join(', ')}</dd></dl><div className="work-conflict-actions"><Button type="button" size="sm" variant="outline" onClick={() => adopt(latest)}>{t('使用最新配置', 'Use latest configuration')}</Button><Button type="button" size="sm" onClick={() => { const original = normalized(base || initial.current), intended = normalized(draft), merged = normalized(latest); for (const key of ['name', 'visibility', 'definition'] as const) if (JSON.stringify(original[key]) !== JSON.stringify(intended[key])) Object.assign(merged, { [key]: intended[key] }); setBase(latest); setDraft(merged); setLatest(null); setUncertain(false); setConfirmDelete(false); setError('') }}>{t('保留我的改动', 'Keep my changes')}</Button></div></>}</section>}
      <fieldset className="admin-plain-fieldset" disabled={!canEdit || busy}><Field label={t('视图名称', 'View name')}><Input data-view-name autoFocus required maxLength={80} value={draft.name} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))}/></Field><div className="work-fields-row"><Field label={t('可见范围', 'Visibility')}><select className="work-native-select" value={draft.visibility} onChange={event => setDraft(value => ({ ...value, visibility: event.target.value as Draft['visibility'] }))}><option value="private">{t('仅自己', 'Only me')}</option><option value="shared">{t('空间共享', 'Shared in space')}</option></select></Field><Field label={t('布局', 'Layout')}><select className="work-native-select" value={draft.definition.layout} onChange={event => setDraft(value => ({ ...value, definition: { ...value.definition, layout: event.target.value as WorkViewDefinition['layout'] } }))}><option value="board">{t('看板', 'Board')}</option><option value="list">{t('清单', 'List')}</option><option value="calendar">{t('日历', 'Calendar')}</option></select></Field></div>{draft.definition.layout === 'calendar' && <Field label={t('日历日期', 'Calendar date')}><select className="work-native-select" value={draft.definition.calendarBasis || 'businessDate'} onChange={event => setDraft(value => ({ ...value, definition: { ...value.definition, calendarBasis: event.target.value as 'businessDate' | 'dueAt' } }))}><option value="businessDate">{t('业务日期', 'Business date')}</option><option value="dueAt">{t('截止日期', 'Due date')}</option></select></Field>}
        <Button type="button" size="sm" variant="outline" onClick={() => setDraft(value => ({ ...value, definition: structuredClone(current) }))}><Copy size={13}/>{t('使用当前筛选与布局', 'Use current filters and layout')}</Button><WorkFilterFields spaceId={spaceId} projects={projects} statuses={statuses} value={draft.definition.filters} onChange={filters => setDraft(value => ({ ...value, definition: { ...value.definition, filters } }))}/><Field label={t('显示字段', 'Visible fields')}><WorkFieldChoices value={draft.definition.fields} onChange={fields => setDraft(value => ({ ...value, definition: { ...value.definition, fields } }))}/></Field>
      </fieldset>{confirmDelete && <div className="work-delete-confirm" role="alert"><span>{t('删除这个保存的视图？', 'Delete this saved view?')}</span><Button type="button" variant="outline" size="sm" disabled={busy || uncertain} onClick={() => setConfirmDelete(false)}>{t('取消', 'Cancel')}</Button><Button type="button" variant="destructive" size="sm" disabled={busy || uncertain} onClick={() => void remove()}>{t('删除', 'Delete')}</Button></div>}
    </div><footer className="work-detail-footer">{base && canEdit && <Button type="button" variant="ghost" size="icon-sm" disabled={busy || dirty || uncertain} aria-label={t('删除视图', 'Delete view')} onClick={() => setConfirmDelete(true)}><Trash2 size={15}/></Button>}<span className="grow"/>{base && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => guard.requestLeave(() => onApply(base))}><Play size={13}/>{t('打开视图', 'Open view')}</Button>}{canEdit && <Button type="submit" disabled={busy || !draft.name.trim() || (!!base && !dirty) || uncertain || !!latest}><Save size={14}/>{t('保存视图', 'Save view')}</Button>}</footer></form>{guard.blocked && <DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard}/>}</>
}

export default function WorkViews({ spaceId, current, projects, statuses, enabled, activeId, onClose, onApply, onNotice }: { spaceId: string; current: WorkViewDefinition; projects: WorkProject[]; statuses: WorkStatusDefinition[]; enabled: boolean; activeId?: string; onClose: () => void; onApply: (value: WorkSavedView) => void; onNotice: (message: string) => void }) {
  const theme = useWorkTheme(), [page, setPage] = useState<WorkCatalogPage<WorkSavedView> | null>(null), [selected, setSelected] = useState<{ id: string; value?: WorkSavedView } | null>(null), [query, setQuery] = useState(''), [search, setSearch] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const alive = useRef(true), run = useRef(0), pending = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false; run.current++ } }, [])
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    const token = ++run.current, abort = new AbortController(); setError(''); setPage(null)
    if (!enabled) { setLoading(false); return }
    setLoading(true)
    request<WorkCatalogPage<WorkSavedView>>(`${workPath(spaceId)}/views?${new URLSearchParams({ q: search, limit: '30' })}`, { signal: abort.signal }).then(value => { if (!abort.signal.aborted && run.current === token) setPage(value) }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [spaceId, search, enabled, refresh])
  async function more() {
    if (!page?.nextCursor || pending.current) return
    pending.current = true; setBusy(true); const token = run.current
    try { const value = await request<WorkCatalogPage<WorkSavedView>>(`${workPath(spaceId)}/views?${new URLSearchParams({ q: search, limit: '30', cursor: page.nextCursor })}`); if (alive.current && token === run.current) setPage(old => old ? { ...value, items: [...old.items, ...value.items.filter(row => !old.items.some(item => item.id === row.id))] } : value) }
    catch (cause) { if (alive.current) setError(messageOf(cause)) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  return <Dialog open onOpenChange={value => { if (!value) requestNavigation(onClose) }}><DialogContent className={`admin-ui work-theme work-theme-${theme} work-manager-dialog`} data-theme={theme} showCloseButton={false} aria-describedby={undefined}><header className="work-tools-heading"><DialogTitle>{t('保存的视图', 'Saved views')}</DialogTitle><Button type="button" variant="ghost" size="icon" aria-label={t('关闭', 'Close')} onClick={() => requestNavigation(onClose)}><X size={18}/></Button></header><div className="work-manager-layout"><section className="work-directory"><div className="work-directory-tools"><label><Search size={14}/><Input type="search" aria-label={t('搜索视图', 'Search views')} value={query} onChange={event => setQuery(event.target.value)}/></label><Button type="button" size="icon-sm" variant="ghost" disabled={!enabled} aria-label={t('保存新视图', 'Save new view')} onClick={() => requestNavigation(() => setSelected({ id: newWorkId() }))}><Plus size={16}/></Button></div><ErrorMessage error={error}/>{loading ? <Loading/> : <div className="work-directory-items">{page?.items.map(value => <div className={`work-view-row ${value.id === activeId ? 'is-current' : ''}`} key={value.id}><button type="button" data-view-id={value.id} onClick={() => requestNavigation(() => onApply(value))}><span>{value.name}<small>{value.visibility === 'private' ? t('私人', 'Private') : t('共享', 'Shared')}</small></span><Play size={12}/></button><button type="button" aria-label={t('设置视图：{name}', 'View settings: {name}', { name: value.name })} onClick={() => requestNavigation(() => setSelected({ id: value.id, value }))}>···</button></div>)}{page && !page.items.length && <p>{t('暂无保存的视图', 'No saved views')}</p>}{page?.nextCursor && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void more()}>{t('加载更多', 'Load more')}</Button>}</div>}</section>{selected ? <ViewEditor key={selected.id} spaceId={spaceId} selected={selected} current={current} projects={projects} statuses={statuses} enabled={enabled} onApply={onApply} onSaved={value => { setSelected({ id: value.id, value }); setRefresh(old => old + 1); onNotice(t('视图已保存', 'View saved')) }} onDeleted={() => { setSelected(null); setRefresh(value => value + 1); onNotice(t('视图已删除', 'View deleted')) }} onClose={() => setSelected(null)}/> : <div className="work-tool-placeholder"><Button type="button" variant="outline" disabled={!enabled} onClick={() => setSelected({ id: newWorkId() })}><Plus size={15}/>{t('保存当前视图', 'Save current view')}</Button></div>}</div></DialogContent></Dialog>
}
