import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, ChevronDown, GitBranch, Save } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { workItemHref, workPath, type WorkItem } from '../core/work-types'
import type { WorkRelations } from '../core/work-planning-types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { ErrorMessage, Field, Loading } from '../components/Shared'

type Draft = { parentId: string; predecessorId: string; blockers: string }
const draftOf = (value: WorkRelations): Draft => ({ parentId: value.parent?.id || '', predecessorId: value.predecessor?.id || '', blockers: value.blockedBy.map(row => row.id).join('\n') })
const normalized = (value: Draft) => ({ parentId: value.parentId.trim() || null, predecessorId: value.predecessorId.trim() || null, blockedByIds: [...new Set(value.blockers.split(/[\s,，]+/).filter(Boolean))].sort() })
type Pending = { dirty: boolean; busy: boolean; discard: () => void }

export default function WorkRelationsEditor({ spaceId, item, enabled, disabled, itemDirty, onSaved, onPendingChange }: { spaceId: string; item: WorkItem; enabled: boolean; disabled: boolean; itemDirty: boolean; onSaved: (item: WorkItem) => void; onPendingChange: (value: Pending) => void }) {
  const [open, setOpen] = useState(false), [value, setValue] = useState<WorkRelations | null>(null), [draft, setDraft] = useState<Draft>({ parentId: '', predecessorId: '', blockers: '' })
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [latest, setLatest] = useState<WorkRelations | null>(null), [uncertain, setUncertain] = useState(false), [refresh, setRefresh] = useState(0)
  const alive = useRef(true), pending = useRef(false)
  const dirty = !!value && JSON.stringify(normalized(draft)) !== JSON.stringify(normalized(draftOf(value)))
  const path = `${workPath(spaceId)}/items/${encodeURIComponent(item.id)}/relations`
  useEffect(() => { alive.current = true; return () => { alive.current = false; onPendingChange({ dirty: false, busy: false, discard: () => {} }) } }, [])
  useEffect(() => { onPendingChange({ dirty, busy, discard: () => { if (value) setDraft(draftOf(value)); setLatest(null); setUncertain(false) } }) }, [dirty, busy, value])
  useEffect(() => {
    if (!enabled || !open || dirty || busy) return
    const abort = new AbortController(); setLoading(true); setError('')
    request<WorkRelations>(path, { signal: abort.signal }).then(data => { if (!abort.signal.aborted) { setValue(data); setDraft(draftOf(data)) } }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [path, open, item.revision, refresh, enabled])
  async function readLatest() {
    if (pending.current) return
    pending.current = true; setBusy(true)
    try {
      const data = await request<WorkRelations>(path)
      if (!alive.current) return
      if (uncertain && JSON.stringify(normalized(draftOf(data))) === JSON.stringify(normalized(draft))) {
        const actual = await request<WorkItem>(`${workPath(spaceId)}/items/${encodeURIComponent(item.id)}`)
        if (!alive.current) return
        setValue(data); setDraft(draftOf(data)); setLatest(null); setUncertain(false); setError(''); onSaved(actual)
      } else { setLatest(data); setError(t('关系已有更新，草稿已保留。', 'Relations changed; your draft is retained.')) }
    } catch (cause) { if (alive.current) setError(messageOf(cause)) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function save() {
    if (!value || pending.current || disabled || itemDirty || !dirty || uncertain || latest) return
    const changes = normalized(draft), before = normalized(draftOf(value))
    if (changes.blockedByIds.length > 50) { setError(t('最多关联 50 个前置依赖。', 'At most 50 blocking dependencies are allowed.')); return }
    const patch = Object.fromEntries(Object.entries(changes).filter(([key, data]) => JSON.stringify(data) !== JSON.stringify(before[key as keyof typeof before])))
    pending.current = true; setBusy(true); setError('')
    try {
      const updated = await request<WorkItem>(path, { method: 'PATCH', body: { expectedRevision: value.revision, ...patch } })
      if (!alive.current) return
      const actual = await request<WorkRelations>(path)
      if (!alive.current) return
      setValue(actual); setDraft(draftOf(actual)); setLatest(null); setUncertain(false); onSaved(updated)
    } catch (cause) { if (alive.current) { setError(messageOf(cause)); if (!(cause instanceof ApiError) || cause.status >= 500) { setUncertain(true); setError(t('保存结果未确认，草稿已保留。先读取最新关系。', 'The save is unconfirmed; your draft is retained. Read the latest relations first.')) } else if (cause.code === 'work_item_version_conflict') setUncertain(true) } }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  return <section className="work-relations" data-work-relations>
    <button type="button" className="work-section-toggle" aria-expanded={open} disabled={busy || dirty} onClick={() => setOpen(current => !current)}><GitBranch size={16}/><span>{t('事项关系', 'Relations')}</span>{item.relations?.isBlocked && <small>{t('{count} 项阻塞', '{count} blockers', { count: item.relations.blockedCount })}</small>}<ChevronDown size={15}/></button>
    {open && <div className="work-relations-body"><ErrorMessage error={error}/>{loading ? <Loading/> : value ? <>
      {itemDirty && <p className="work-inline-note">{t('先保存事项草稿，再修改关系。', 'Save the item draft before changing relations.')}</p>}
      {(uncertain || latest) && <div className="work-conflict"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void readLatest()}>{t('读取最新关系', 'Read latest relations')}</Button>{latest && <><dl><dt>{t('最新关系', 'Latest relations')}</dt><dd>{t('父项', 'Parent')}: {latest.parent?.id || '—'}</dd><dd>{t('前一事项', 'Previous item')}: {latest.predecessor?.id || '—'}</dd><dd>{t('前置依赖', 'Blocking dependencies')}: {latest.blockedBy.map(row => row.id).join(', ') || '—'}</dd></dl><div className="work-conflict-actions"><Button type="button" size="sm" variant="outline" onClick={() => { setValue(latest); setDraft(draftOf(latest)); setLatest(null); setUncertain(false); setError('') }}>{t('使用最新关系', 'Use latest relations')}</Button><Button type="button" size="sm" onClick={() => {
        const before = normalized(draftOf(value)), intended = normalized(draft), fresh = draftOf(latest)
        if (intended.parentId !== before.parentId) fresh.parentId = draft.parentId
        if (intended.predecessorId !== before.predecessorId) fresh.predecessorId = draft.predecessorId
        if (JSON.stringify(intended.blockedByIds) !== JSON.stringify(before.blockedByIds)) fresh.blockers = draft.blockers
        setValue(latest); setDraft(fresh); setLatest(null); setUncertain(false); setError('')
      }}>{t('保留我的改动', 'Keep my changes')}</Button></div></>}</div>}
      <fieldset disabled={disabled || busy || itemDirty} className="admin-plain-fieldset"><div className="work-fields-row"><Field label={t('父事项', 'Parent item')}><Input data-work-parent placeholder="0000a" value={draft.parentId} onChange={event => setDraft(current => ({ ...current, parentId: event.target.value }))}/></Field><Field label={t('前一事项', 'Previous item')}><Input data-work-predecessor placeholder="00009" value={draft.predecessorId} onChange={event => setDraft(current => ({ ...current, predecessorId: event.target.value }))}/></Field></div><Field label={t('前置依赖', 'Blocking dependencies')} hint={t('每行一个事项编号', 'One item ID per line')}><Textarea data-work-blockers rows={3} value={draft.blockers} onChange={event => setDraft(current => ({ ...current, blockers: event.target.value }))}/></Field></fieldset>
      <div className="work-relation-links">{[value.parent, value.predecessor, ...value.blockedBy].filter(row => !!row).map((row, index) => <a key={`${row!.id}:${index}`} href={workItemHref(spaceId, row!.id)}><span>{row!.id}</span><span>{row!.title}</span><ArrowUpRight size={12}/></a>)}</div>
      <div className="work-relation-footer">{value.childrenCount > 0 && <a href={`#/library?${new URLSearchParams({ view: 'board', space: spaceId, parentId: item.id })}`}>{t('{count} 个子事项', '{count} child items', { count: value.childrenCount })}</a>}<span className="grow"/>{dirty && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setDraft(draftOf(value)); setLatest(null); setUncertain(false); setError('') }}>{t('撤销改动', 'Discard changes')}</Button>}<Button type="button" size="sm" disabled={disabled || busy || itemDirty || !dirty || !!latest || uncertain} onClick={() => void save()}><Save size={13}/>{t('保存关系', 'Save relations')}</Button></div>
    </> : <Button type="button" variant="outline" onClick={() => setRefresh(current => current + 1)}>{t('重新读取', 'Reload')}</Button>}</div>}
  </section>
}
