import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Search, UserRound, X } from 'lucide-react'
import { messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { workPath } from '../core/work-types'
import type { WorkCatalogPage, WorkLabel, WorkPlanningDraft, WorkPriority, WorkVersion } from '../core/work-planning-types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Field, ErrorMessage, Loading } from '../components/Shared'
import './work-planning.css'

export const priorityLabel = (value: string) => ({ low: t('低', 'Low'), normal: t('普通', 'Normal'), high: t('高', 'High'), urgent: t('紧急', 'Urgent') })[value] || t('未设置', 'Not set')
type CatalogEntry = WorkLabel | WorkVersion
type CatalogHint = Pick<WorkLabel, 'id' | 'name' | 'color' | 'archived'> | Pick<WorkVersion, 'id' | 'name' | 'archived' | 'projectId' | 'targetDate'>

/** Opening a picker is the only action that loads its directory. Selected IDs use one batch read. */
export function WorkCatalogPicker({ spaceId, kind, ids, hints = [], projectId, disabled = false, enabled = true, multiple = false, onChange }: { spaceId: string; kind: 'labels' | 'versions'; ids: string[]; hints?: CatalogHint[]; projectId?: string | null; disabled?: boolean; enabled?: boolean; multiple?: boolean; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [search, setSearch] = useState('')
  const [summaries, setSummaries] = useState<CatalogHint[]>(hints), [missing, setMissing] = useState<string[]>([]), [page, setPage] = useState<WorkCatalogPage<CatalogEntry> | null>(null)
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const token = useRef(0), pending = useRef(false), alive = useRef(true)
  const base = `${workPath(spaceId)}/${kind}`, idKey = [...ids].sort().join(','), hintKey = hints.map(value => `${value.id}:${value.name}:${value.archived}`).join('|')
  useEffect(() => { alive.current = true; return () => { alive.current = false; token.current++ } }, [])
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    if (!enabled) return
    const known = new Map([...summaries, ...(page?.items || []), ...hints].map(value => [value.id, value]))
    const selected = ids.flatMap(id => known.has(id) ? [known.get(id)!] : [])
    const absent = ids.filter(id => !known.has(id))
    setSummaries(selected); setMissing([])
    if (!absent.length) return
    const abort = new AbortController(), params = new URLSearchParams()
    absent.forEach(id => params.append('ids', id))
    request<WorkCatalogPage<CatalogEntry>>(`${base}?${params}`, { signal: abort.signal }).then(value => {
      if (!abort.signal.aborted) { setSummaries([...selected, ...value.items]); setMissing(value.missingIds || []) }
    }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) })
    return () => abort.abort()
  // Catalog hints are immutable snapshots from the item; only selected IDs and actual hint values matter.
  }, [base, idKey, hintKey, enabled])
  function params(cursor?: string) {
    const value = new URLSearchParams({ archived: 'false', limit: '30' })
    if (search) value.set('q', search)
    if (kind === 'versions' && projectId !== undefined) value.set('projectId', projectId || 'none')
    if (cursor) value.set('cursor', cursor)
    return value
  }
  useEffect(() => {
    const run = ++token.current
    if (!open || !enabled) return
    const abort = new AbortController(); setLoading(true); setError(''); setPage(null)
    request<WorkCatalogPage<CatalogEntry>>(`${base}?${params()}`, { signal: abort.signal }).then(value => { if (!abort.signal.aborted && token.current === run) setPage(value) })
      .catch(cause => { if (!abort.signal.aborted && token.current === run) setError(messageOf(cause)) })
      .finally(() => { if (!abort.signal.aborted && token.current === run) setLoading(false) })
    return () => abort.abort()
  }, [base, open, search, projectId, refresh, enabled])
  async function more() {
    if (!enabled || !page?.nextCursor || pending.current) return
    const run = token.current; pending.current = true; setBusy(true)
    try {
      const value = await request<WorkCatalogPage<CatalogEntry>>(`${base}?${params(page.nextCursor)}`)
      if (alive.current && run === token.current) setPage(current => current ? { ...value, items: [...current.items, ...value.items.filter(row => !current.items.some(old => old.id === row.id))] } : value)
    } catch (cause) { if (alive.current && run === token.current) setError(messageOf(cause)) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  function choose(entry: CatalogEntry) {
    setSummaries(current => [...current.filter(row => row.id !== entry.id), entry])
    onChange(multiple ? ids.includes(entry.id) ? ids.filter(id => id !== entry.id) : [...ids, entry.id] : [entry.id])
    if (!multiple) setOpen(false)
  }
  const label = kind === 'labels' ? t('标签', 'Labels') : t('版本', 'Version')
  return <div className="work-catalog-picker" data-work-picker={kind}>
    <div className="work-selected-values">{ids.map(id => {
      const entry = summaries.find(row => row.id === id) || page?.items.find(row => row.id === id)
      return <span className="work-value-chip" key={id}>{entry && 'color' in entry && <i style={{ backgroundColor: entry.color }}/>}<span title={entry?.name || id}>{entry?.name || (missing.includes(id) ? t('关联不可用', 'Unavailable reference') : id)}{entry?.archived ? t('（已归档）', ' (archived)') : ''}</span>{!disabled && <button type="button" aria-label={t('移除：{name}', 'Remove: {name}', { name: entry?.name || id })} onClick={() => onChange(ids.filter(value => value !== id))}><X size={12}/></button>}</span>
    })}<Button type="button" variant="outline" size="sm" disabled={disabled} aria-expanded={open} aria-label={t('选择{label}', 'Choose {label}', { label })} onClick={() => setOpen(value => !value)}>{ids.length ? t('更改', 'Change') : t('选择{label}', 'Choose {label}', { label })}<ChevronDown size={13}/></Button></div>
    {open && <div className="work-picker-panel"><label className="work-picker-search"><Search size={14}/><Input type="search" value={query} aria-label={t('搜索{label}', 'Search {label}', { label })} onChange={event => setQuery(event.target.value)}/></label><ErrorMessage error={error}/>{error && <Button type="button" variant="ghost" size="sm" onClick={() => setRefresh(value => value + 1)}>{t('重新读取', 'Reload')}</Button>}{loading ? <Loading/> : <div className="work-picker-options">{page?.items.map(row => <button key={row.id} type="button" aria-pressed={ids.includes(row.id)} onClick={() => choose(row)}>{'color' in row && <i style={{ backgroundColor: row.color }}/>}<span>{row.name}</span>{'targetDate' in row && row.targetDate && <small>{row.targetDate}</small>}{ids.includes(row.id) && <Check size={14}/>}</button>)}{page && !page.items.length && <p>{t('没有匹配结果', 'No matching results')}</p>}</div>}{page?.nextCursor && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void more()}>{t('加载更多', 'Load more')}</Button>}</div>}
    {!open && error && <ErrorMessage error={error}/>}
  </div>
}

export function WorkAccountSelector({ spaceId, value, disabled, onChange, accountsOnly = false }: { spaceId: string; value: WorkPlanningDraft['assignee']; disabled: boolean; accountsOnly?: boolean; onChange: (value: WorkPlanningDraft['assignee']) => void }) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState(''), [people, setPeople] = useState<{ id: string; name: string }[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const generation = useRef(0), alive = useRef(true), pending = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])
  useEffect(() => {
    if (!open || disabled) return
    const abort = new AbortController(), run = ++generation.current
    const timer = setTimeout(() => {
      setBusy(true); setError('')
      request<{ items: { id: string; name: string }[]; nextCursor: string | null }>(`${workPath(spaceId)}/assignees?${new URLSearchParams({ q: search, limit: '20' })}`, { signal: abort.signal }).then(data => { if (!abort.signal.aborted && run === generation.current) { setPeople(data.items); setNextCursor(data.nextCursor) } }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setBusy(false) })
    }, 200)
    return () => { clearTimeout(timer); abort.abort() }
  }, [spaceId, open, search, disabled])
  async function more() {
    if (!nextCursor || pending.current) return
    pending.current = true; setBusy(true); const run = generation.current
    try { const data = await request<{ items: { id: string; name: string }[]; nextCursor: string | null }>(`${workPath(spaceId)}/assignees?${new URLSearchParams({ q: search, limit: '20', cursor: nextCursor })}`); if (alive.current && run === generation.current) { setPeople(current => [...current, ...data.items.filter(row => !current.some(old => old.id === row.id))]); setNextCursor(data.nextCursor) } }
    catch (cause) { if (alive.current && run === generation.current) setError(messageOf(cause)) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  return <div className="work-assignee-field"><div className="work-input-action"><Input value={value?.name || ''} readOnly={accountsOnly} disabled={disabled} maxLength={80} aria-label={t('负责人姓名', 'Assignee name')} onChange={event => onChange(event.target.value ? { name: event.target.value } : null)} placeholder={t('输入姓名', 'Enter a name')}/>{accountsOnly && value && <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={t('清除负责人', 'Clear assignee')} onClick={() => onChange(null)}><X size={13}/></Button>}<Button type="button" variant="outline" size="icon" disabled={disabled} aria-expanded={open} aria-label={t('选择账号', 'Choose account')} onClick={() => setOpen(current => !current)}><UserRound size={15}/></Button></div>{value?.userId && <small className="work-bound-account"><UserRound size={11}/>{t('已关联账号', 'Account linked')}</small>}{open && <div className="work-picker-panel"><Input type="search" aria-label={t('搜索账号', 'Search accounts')} value={search} onChange={event => setSearch(event.target.value)}/><ErrorMessage error={error}/><div className="work-picker-options">{people.map(person => <button type="button" key={person.id} onClick={() => { onChange({ name: person.name, userId: person.id }); setOpen(false) }}><UserRound size={13}/><span>{person.name}</span>{value?.userId === person.id && <Check size={13}/>}</button>)}</div>{busy && <Loading/>}{nextCursor && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void more()}>{t('加载更多', 'Load more')}</Button>}</div>}</div>
}

export default function WorkPlanningFields({ spaceId, projectId, value, hints, disabled = false, enabled = true, onChange }: { spaceId: string; projectId: string | null; value: WorkPlanningDraft; hints?: { labels?: CatalogHint[]; version?: CatalogHint }; disabled?: boolean; enabled?: boolean; onChange: (patch: Partial<WorkPlanningDraft>) => void }) {
  return <section className="work-planning-fields" aria-label={t('规划', 'Planning')}>
    <div className="work-fields-row"><Field label={t('优先级', 'Priority')}><select className="work-native-select" data-work-priority value={value.priority} disabled={disabled} onChange={event => onChange({ priority: event.target.value as WorkPriority })}>{(['', 'low', 'normal', 'high', 'urgent'] as const).map(priority => <option key={priority} value={priority}>{priorityLabel(priority)}</option>)}</select></Field><Field label={t('负责人', 'Assignee')}><WorkAccountSelector spaceId={spaceId} value={value.assignee} disabled={disabled || !enabled} onChange={assignee => onChange({ assignee })}/></Field></div>
    <Field label={t('标签', 'Labels')}><WorkCatalogPicker spaceId={spaceId} kind="labels" ids={value.labelIds} hints={hints?.labels} enabled={enabled} disabled={disabled || !enabled} multiple onChange={labelIds => onChange({ labelIds })}/></Field>
    <Field label={t('版本', 'Version')}><WorkCatalogPicker spaceId={spaceId} kind="versions" ids={value.versionId ? [value.versionId] : []} hints={hints?.version ? [hints.version] : []} projectId={projectId} enabled={enabled} disabled={disabled || !enabled} onChange={ids => onChange({ versionId: ids[0] || null })}/></Field>
  </section>
}
