import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Archive, ArchiveRestore, Plus, Save, Search, X } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { requestNavigation } from '../core/navigation'
import { useUnsavedChanges } from '../core/useUnsavedChanges'
import { newWorkId, workPath, type WorkProject } from '../core/work-types'
import type { WorkCatalogPage, WorkLabel, WorkVersion } from '../core/work-planning-types'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { ErrorMessage, Field, Loading, handleFormInvalid } from '../components/Shared'
import DiscardChangesDialog from '../components/DiscardChangesDialog'
import { useWorkTheme } from './work-theme'
import './work-tools.css'

type Kind = 'labels' | 'versions'
type Entry = WorkLabel | WorkVersion
type Draft = { name: string; color: string; projectId: string | null; targetDate: string; description: string }
const draftOf = (entry?: Entry): Draft => ({ name: entry?.name || '', color: entry && 'color' in entry ? entry.color : '#739d87', projectId: entry && 'projectId' in entry ? entry.projectId : null, targetDate: entry && 'targetDate' in entry ? entry.targetDate || '' : '', description: entry && 'description' in entry ? entry.description : '' })
const payload = (kind: Kind, value: Draft) => kind === 'labels' ? { name: value.name.trim(), color: value.color } : { name: value.name.trim(), projectId: value.projectId, targetDate: value.targetDate, description: value.description.trim() }

function CatalogEditor({ spaceId, kind, selected, projects, canEdit, onSaved, onClose }: { spaceId: string; kind: Kind; selected: { id: string; entry?: Entry }; projects: WorkProject[]; canEdit: boolean; onSaved: (value: Entry) => void; onClose: () => void }) {
  const [base, setBase] = useState(selected.entry || null), [draft, setDraft] = useState(() => draftOf(selected.entry)), [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false), [latest, setLatest] = useState<Entry | null>(null)
  const initial = useRef(draftOf(selected.entry)), alive = useRef(true), pending = useRef(false), intent = useRef<Record<string, unknown> | null>(null)
  const dirty = JSON.stringify(payload(kind, draft)) !== JSON.stringify(payload(kind, base ? draftOf(base) : initial.current))
  const guard = useUnsavedChanges(dirty, busy)
  const endpoint = `${workPath(spaceId)}/${kind}`
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  function adopt(value: Entry) { setBase(value); setDraft(draftOf(value)); setLatest(null); setUncertain(false); setError(''); onSaved(value) }
  async function readLatest() {
    if (pending.current) return
    pending.current = true; setBusy(true)
    try {
      const value = await request<WorkCatalogPage<Entry>>(`${endpoint}?${new URLSearchParams({ ids: selected.id })}`)
      if (!alive.current) return
      const actual = value.items[0]
      if (!actual) { setUncertain(false); setError(t('此记录尚不存在，草稿已保留。', 'This record does not exist; your draft is retained.')); return }
      if (uncertain && intent.current && Object.entries(intent.current).every(([key, value]) => JSON.stringify(actual[key as keyof Entry]) === JSON.stringify(value))) adopt(actual)
      else { setLatest(actual); setError(t('已读取最新记录，草稿已保留。', 'The latest record is available; your draft is retained.')) }
    } catch (cause) { if (alive.current) setError(messageOf(cause)) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function save(event?: FormEvent, archive?: boolean) {
    event?.preventDefault()
    if (pending.current || !canEdit || uncertain || latest || !draft.name.trim()) return
    const next = payload(kind, draft), previous = payload(kind, base ? draftOf(base) : initial.current)
    const changes = base ? Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key as keyof typeof previous]))) : next
    intent.current = { ...changes, ...(archive === undefined ? {} : { archived: archive }) }
    pending.current = true; setBusy(true); setError('')
    try {
      const value = await request<Entry>(base ? `${endpoint}/${selected.id}` : endpoint, { method: base ? 'PATCH' : 'POST', body: base ? { expectedRevision: base.revision, ...changes, ...(archive === undefined ? {} : { archived: archive }) } : { id: selected.id, ...next } })
      if (alive.current) adopt(value)
    } catch (cause) { if (alive.current) { setError(messageOf(cause)); if (!(cause instanceof ApiError) || cause.status >= 500 || cause.status === 409) { setUncertain(true); setError(t('保存结果未确认或记录已更新。草稿保留，请先读取最新记录。', 'The save is unconfirmed or the record changed. Your draft is retained; read the latest record first.')) } } }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  return <><form className="work-tool-editor" onSubmit={event => void save(event)} onInvalidCapture={event => handleFormInvalid(event, setError)}>
    <header><h3>{base ? kind === 'labels' ? t('编辑标签', 'Edit label') : t('编辑版本', 'Edit version') : kind === 'labels' ? t('新建标签', 'New label') : t('新建版本', 'New version')}</h3>{base?.archived && <small>{t('已归档', 'Archived')}</small>}<Button type="button" size="icon-sm" variant="ghost" disabled={busy} aria-label={t('关闭编辑', 'Close editor')} onClick={() => guard.requestLeave(onClose)}><X size={16}/></Button></header>
    <div className="work-tool-editor-body"><ErrorMessage error={error}/>{(uncertain || latest) && <section className="work-conflict"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void readLatest()}>{t('读取最新记录', 'Read latest record')}</Button>{latest && <><dl>{Object.entries(payload(kind, draftOf(latest))).map(([key, value]) => <div key={key}><dt>{({ name: t('名称', 'Name'), color: t('颜色', 'Color'), projectId: t('项目', 'Project'), targetDate: t('目标日期', 'Target date'), description: t('说明', 'Description') })[key]}</dt><dd>{key === 'projectId' ? projects.find(project => project.id === value)?.name || t('空间通用', 'Space-wide') : String(value || '—')}</dd></div>)}</dl><div className="work-conflict-actions"><Button type="button" size="sm" variant="outline" onClick={() => adopt(latest)}>{t('使用最新记录', 'Use latest record')}</Button><Button type="button" size="sm" onClick={() => { const original = base ? draftOf(base) : initial.current, merged = draftOf(latest); for (const key of Object.keys(draft) as (keyof Draft)[]) if (draft[key] !== original[key]) Object.assign(merged, { [key]: draft[key] }); setBase(latest); setDraft(merged); setLatest(null); setUncertain(false); setError('') }}>{t('保留我的改动', 'Keep my changes')}</Button></div></>}</section>}
      <fieldset className="admin-plain-fieldset" disabled={!canEdit || busy}><Field label={t('名称', 'Name')}><Input data-catalog-name autoFocus required maxLength={80} value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}/></Field>{kind === 'labels' ? <Field label={t('颜色', 'Color')}><input type="color" aria-label={t('标签颜色', 'Label color')} value={draft.color} onChange={event => setDraft(current => ({ ...current, color: event.target.value }))}/></Field> : <><Field label={t('所属项目', 'Project')}><select className="work-native-select" value={draft.projectId || ''} onChange={event => setDraft(current => ({ ...current, projectId: event.target.value || null }))}><option value="">{t('空间通用', 'Space-wide')}</option>{projects.filter(row => !row.archived || row.id === draft.projectId).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field><Field label={t('目标日期', 'Target date')}><Input type="date" value={draft.targetDate} onChange={event => setDraft(current => ({ ...current, targetDate: event.target.value }))}/></Field><Field label={t('说明', 'Description')}><Textarea rows={5} maxLength={4000} value={draft.description} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))}/></Field></>}</fieldset>
    </div><footer className="work-detail-footer">{base && canEdit && <Button type="button" variant="ghost" size="sm" disabled={busy || uncertain || !!latest || dirty} onClick={() => void save(undefined, !base.archived)}>{base.archived ? <ArchiveRestore size={15}/> : <Archive size={15}/>}<span>{base.archived ? t('恢复', 'Restore') : t('归档', 'Archive')}</span></Button>}<span className="grow"/><Button type="submit" disabled={!canEdit || busy || !draft.name.trim() || (!!base && !dirty) || uncertain || !!latest}><Save size={15}/>{t('保存', 'Save')}</Button></footer>
  </form>{guard.blocked && <DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard}/>}</>
}

export default function WorkCatalogManager({ spaceId, initialKind = 'labels', projects, enabled, onClose, onNotice }: { spaceId: string; initialKind?: Kind; projects: WorkProject[]; enabled: boolean; onClose: () => void; onNotice: (message: string) => void }) {
  const theme = useWorkTheme(), [kind, setKind] = useState<Kind>(initialKind), [page, setPage] = useState<WorkCatalogPage<Entry> | null>(null), [selection, setSelection] = useState<{ id: string; entry?: Entry } | null>(null)
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [archived, setArchived] = useState(false), [loading, setLoading] = useState(true), [moreBusy, setMoreBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const run = useRef(0), pending = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; run.current++ } }, [])
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer) }, [query])
  function params(cursor?: string) { return new URLSearchParams({ q: search, archived: String(archived), limit: '30', ...(cursor ? { cursor } : {}) }) }
  useEffect(() => {
    const token = ++run.current, abort = new AbortController(); setPage(null); setError('')
    if (!enabled) { setLoading(false); return }
    setLoading(true)
    request<WorkCatalogPage<Entry>>(`${workPath(spaceId)}/${kind}?${params()}`, { signal: abort.signal }).then(value => { if (!abort.signal.aborted && run.current === token) setPage(value) }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [spaceId, kind, search, archived, enabled, refresh])
  async function more() {
    if (!page?.nextCursor || pending.current) return
    pending.current = true; setMoreBusy(true); const token = run.current
    try { const value = await request<WorkCatalogPage<Entry>>(`${workPath(spaceId)}/${kind}?${params(page.nextCursor)}`); if (alive.current && token === run.current) setPage(current => current ? { ...value, items: [...current.items, ...value.items.filter(row => !current.items.some(old => old.id === row.id))] } : value) }
    catch (cause) { if (alive.current && token === run.current) setError(messageOf(cause)) }
    finally { pending.current = false; if (alive.current) setMoreBusy(false) }
  }
  return <Dialog open onOpenChange={value => { if (!value) requestNavigation(onClose) }}><DialogContent className={`admin-ui work-theme work-theme-${theme} work-manager-dialog`} data-theme={theme} showCloseButton={false} aria-describedby={undefined}><header className="work-tools-heading"><DialogTitle>{t('标签与版本', 'Labels and versions')}</DialogTitle><Button type="button" variant="ghost" size="icon" aria-label={t('关闭', 'Close')} onClick={() => requestNavigation(onClose)}><X size={18}/></Button></header><div className="work-manager-layout"><section className="work-directory"><div className="work-tabs"><button type="button" aria-pressed={kind === 'labels'} onClick={() => requestNavigation(() => { setKind('labels'); setSelection(null) })}>{t('标签', 'Labels')}</button><button type="button" aria-pressed={kind === 'versions'} onClick={() => requestNavigation(() => { setKind('versions'); setSelection(null) })}>{t('版本', 'Versions')}</button></div><div className="work-directory-tools"><label><Search size={14}/><Input type="search" aria-label={t('搜索目录', 'Search directory')} value={query} onChange={event => setQuery(event.target.value)}/></label><Button type="button" size="icon-sm" variant="ghost" disabled={!enabled || !page?.canEdit} aria-label={kind === 'labels' ? t('新建标签', 'New label') : t('新建版本', 'New version')} onClick={() => requestNavigation(() => setSelection({ id: newWorkId() }))}><Plus size={16}/></Button></div><label className="work-directory-archive"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)}/>{t('已归档', 'Archived')}</label><ErrorMessage error={error}/>{loading ? <Loading/> : <div className="work-directory-items">{page?.items.map(entry => <button type="button" key={entry.id} data-catalog-id={entry.id} className={selection?.id === entry.id ? 'active' : ''} onClick={() => requestNavigation(() => setSelection({ id: entry.id, entry }))}>{'color' in entry && <i style={{ backgroundColor: entry.color }}/>}<span>{entry.name}{'targetDate' in entry && entry.targetDate && <small>{entry.targetDate}</small>}</span>{entry.archived && <Archive size={12}/>}</button>)}{page && !page.items.length && <p>{t('暂无记录', 'No records')}</p>}{page?.nextCursor && <Button type="button" variant="ghost" size="sm" disabled={moreBusy} onClick={() => void more()}>{t('加载更多', 'Load more')}</Button>}</div>}</section>{selection ? <CatalogEditor key={`${kind}:${selection.id}`} spaceId={spaceId} kind={kind} selected={selection} projects={projects} canEdit={enabled && !!page?.canEdit} onClose={() => setSelection(null)} onSaved={value => { setSelection({ id: value.id, entry: value }); setRefresh(current => current + 1); onNotice(t('目录已保存', 'Catalog saved')) }}/> : <div className="work-tool-placeholder">{t('选择记录或新建', 'Choose a record or create one')}</div>}</div></DialogContent></Dialog>
}
