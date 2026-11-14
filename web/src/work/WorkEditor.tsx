import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Archive, ArchiveRestore, ArrowUpRight, Crosshair, FileText, Link2, Plus, Save, X } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { requestNavigation } from '../core/navigation'
import { safeHref, formatUpdated } from '../core/presentation'
import { useUnsavedChanges } from '../core/useUnsavedChanges'
import { changedWorkFields, normalizeWorkDraft, workDraft, workItemHref, workLibraryHref, workPath, type WorkCollaborationSummary, type WorkStatusCatalog, type WorkStatusDefinition, type WorkDraft, type WorkItem, type WorkProject, type WorkReference, type WorkSelection, type WorkStatus } from '../core/work-types'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { StyledSelect } from '../components/ui/select'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'
import { ErrorMessage, Field, handleFormInvalid, Loading } from '../components/Shared'
import DiscardChangesDialog from '../components/DiscardChangesDialog'
import ResourcePicker from './ResourcePicker'
import { useWorkTheme } from './work-theme'
import WorkActivity from './WorkActivity'
import WorkCollaboration, { isWorkClaimError, useWorkCollaboration } from './WorkCollaboration'

export const workStatusLabel = (status: WorkStatus, statuses: WorkStatusDefinition[]) => statuses.find(item => item.id === status)?.name || status
const fieldLabel = (key: keyof WorkDraft) => ({ title: t('事项标题', 'Item title'), projectId: t('项目', 'Project'), status: t('状态', 'Status'), description: t('说明', 'Description'), nextStep: t('下一步', 'Next step'), result: t('结果', 'Result'), needsAttention: t('待我处理', 'Needs my attention'), bookmarkIds: t('关联书签', 'Linked bookmarks'), documentIds: t('关联文档', 'Linked documents') })[key]
function editorMessageOf(cause: unknown): string {
  if (cause instanceof ApiError && cause.code === 'module_disabled') {
    const detail = cause.details.details
    return detail && typeof detail === 'object' && 'module' in detail && detail.module === 'documents'
      ? t('资料库已关闭，草稿和关联修改已保留。重新开启后再保存。', 'Library is disabled. Your draft and link changes are retained. Re-enable it before saving.')
      : t('事项已关闭，草稿已保留。重新开启后再保存。', 'Work is disabled. Your draft is retained. Re-enable it before saving.')
  }
  return messageOf(cause)
}
function useWideEditor() {
  const [wide, setWide] = useState(() => matchMedia('(min-width: 2200px)').matches)
  useEffect(() => { const media = matchMedia('(min-width: 2200px)'), changed = () => setWide(media.matches); media.addEventListener('change', changed); return () => media.removeEventListener('change', changed) }, [])
  return wide
}

export default function WorkEditor({ spaceId, selection, projects, statuses, defaultStatus, canEdit, documentsEnabled, onClose, onSaved, onStatusesChanged, onReveal, onNotice, onCollaborationChanged }: { spaceId: string; selection: WorkSelection; projects: WorkProject[]; statuses: WorkStatusDefinition[]; defaultStatus: WorkStatus; canEdit: boolean; documentsEnabled: boolean; onClose: () => void; onSaved: (item: WorkItem, notice: string, created: boolean) => void; onStatusesChanged: (catalog: WorkStatusCatalog) => void; onReveal: (item: WorkItem) => void; onNotice: (message: string) => void; onCollaborationChanged: () => void }) {
  const theme = useWorkTheme()
  const initial = useRef(selection), alive = useRef(true), running = useRef(false), returningTo = useRef<HTMLElement | null>(document.activeElement as HTMLElement)
  const [creating, setCreating] = useState(!!selection.create), [baseline, setBaseline] = useState<WorkItem | null>(null)
  const initialDraft = useRef(workDraft({ title: selection.reference?.title || '', status: selection.status || defaultStatus, projectId: selection.projectId || null, needsAttention: selection.needsAttention || false, bookmarkIds: selection.reference?.kind === 'bookmark' ? [selection.reference.id] : [], documentIds: selection.reference?.kind === 'document' ? [selection.reference.id] : [] }))
  const initialReferences = useRef<WorkReference[]>(selection.reference ? [selection.reference] : [])
  const [draft, setDraft] = useState<WorkDraft>(() => workDraft(initialDraft.current))
  const [references, setReferences] = useState<WorkReference[]>(() => [...initialReferences.current])
  const [loading, setLoading] = useState(!selection.create), [saving, setBusy] = useState(false), [error, setError] = useState(''), [linkError, setLinkError] = useState('')
  const [remote, setRemote] = useState<WorkItem | null>(null), [conflict, setConflict] = useState(false), [uncertain, setUncertain] = useState(false), [picker, setPicker] = useState(false)
  const [statusesStale, setStatusesStale] = useState(false)
  const [collaboration, setCollaboration] = useState<WorkCollaborationSummary | undefined>()
  const [collaborationPending, setCollaborationPending] = useState({ dirty: false, busy: false, discard: () => {} })
  const [externalRevision, setExternalRevision] = useState('')
  const busy = saving || collaborationPending.busy
  const claimBlocked = !!collaboration && (collaboration.state === 'active' || collaboration.state === 'expired' || collaboration.unresolved)
  const wide = useWideEditor()
  const dirty = (creating || !!baseline) && Object.keys(changedWorkFields(creating ? initialDraft.current : workDraft(baseline || undefined), draft)).length > 0
  const guard = useUnsavedChanges(dirty || collaborationPending.dirty, busy, () => { collaborationPending.discard(); setDraft(workDraft(baseline || initialDraft.current)); setReferences([...(baseline?.references || initialReferences.current)]); setPicker(false) })
  const path = `${workPath(spaceId)}/items/${encodeURIComponent(selection.id)}`
  useEffect(() => {
    alive.current = true
    if (initial.current.create) return () => { alive.current = false }
    const abort = new AbortController()
    request<WorkItem>(path, { signal: abort.signal }).then(item => { if (alive.current) { setBaseline(item); setCollaboration(item.collaboration); setExternalRevision(''); setDraft(workDraft(item)); setReferences(item.references || []) } })
      .catch(cause => { if (!abort.signal.aborted && alive.current) setError(editorMessageOf(cause)) }).finally(() => { if (alive.current && !abort.signal.aborted) setLoading(false) })
    return () => { alive.current = false; abort.abort() }
  }, [path])
  useEffect(() => {
    if (!wide || loading) return
    const title = document.querySelector<HTMLInputElement>('.work-detail [data-work-title]')
    title?.focus({ preventScroll: true })
  }, [wide, loading])
  function close() { guard.requestLeave(() => { onClose(); requestAnimationFrame(() => { const target = returningTo.current?.isConnected ? returningTo.current : document.querySelector<HTMLElement>(`[data-work-id="${CSS.escape(selection.id)}"] .work-card-title, [data-work-id="${CSS.escape(selection.id)}"] .work-list-title`) || document.querySelector<HTMLElement>('[data-work-new]'); target?.focus({ preventScroll: true }) }) }) }
  function adopt(item: WorkItem, message: string) {
    if (!alive.current) return
    setCreating(false); setBaseline(item); setCollaboration(item.collaboration); setExternalRevision(''); setDraft(workDraft(item)); setReferences(item.references || []); setConflict(false); setRemote(null); setUncertain(false); setError(''); setLinkError(''); setPicker(false)
    onSaved(item, message, creating)
  }
  async function readLatest() {
    if (running.current || collaborationPending.busy) return
    running.current = true; setBusy(true)
    try {
      const item = await request<WorkItem>(path)
      if (!alive.current) return
      setCollaboration(item.collaboration)
      const intended = normalizeWorkDraft(draft), changes = creating ? intended : changedWorkFields(workDraft(baseline || undefined), intended)
      const actual = normalizeWorkDraft(workDraft(item))
      const matches = Object.entries(changes).every(([key, value]) => JSON.stringify(actual[key as keyof WorkDraft]) === JSON.stringify(value))
      if (uncertain && matches) adopt(item, t('已读到与当前草稿一致的内容。', 'The current record matches your draft.'))
      else { setRemote(item); setConflict(true); setError(t('已有其他更新。草稿保留在表单中，请比较后选择。', 'The item has other updates. Your draft is retained; compare the changes below.')) }
    } catch (cause) { if (alive.current) { setError(cause instanceof ApiError && cause.status === 404 ? t('暂未读到该事项，草稿已保留。可以重新读取后再决定。', 'The item was not found. Your draft is retained; read it again before deciding what to do.') : editorMessageOf(cause)); if (cause instanceof ApiError && cause.status === 404 && creating) setUncertain(false) } }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function loadStatuses() {
    try {
      const catalog = await request<WorkStatusCatalog>(`${workPath(spaceId)}/statuses`)
      if (alive.current) { onStatusesChanged(catalog); setStatusesStale(false); setError(t('状态配置已更新，草稿已保留。请选择可用状态后保存。', 'Statuses have changed. Your draft is retained; choose an available status before saving.')) }
    } catch { if (alive.current) { setStatusesStale(true); setError(t('该状态已不可用，草稿已保留。请重新读取状态后选择。', 'This status is unavailable. Your draft is retained; reload the statuses before choosing another.')) } }
  }
  async function readStatuses() {
    if (running.current || collaborationPending.busy) return
    running.current = true; setBusy(true)
    try { await loadStatuses() } finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function save(event?: FormEvent, against?: string) {
    event?.preventDefault()
    if (running.current || collaborationPending.busy || !canEdit || loading || (uncertain && !against)) return
    if (!creating && claimBlocked) { setError(t('当前事项仍有执行认领，草稿已保留。请先查看执行记录并核实解除认领。', 'This item has an execution claim. Your draft is retained. Review the execution records and verify before releasing it.')); return }
    const intended = normalizeWorkDraft(draft)
    if (!statuses.some(status => status.id === intended.status)) { setError(t('该状态已不可用，请选择当前空间中的状态。', 'This status is unavailable. Choose a current status in this space.')); return }
    if (!intended.title) { setError(t('请填写事项标题。', 'Enter an item title.')); return }
    for (const [key, max] of [['title', 160], ['description', 4000], ['nextStep', 1000], ['result', 4000]] as const) if ([...intended[key]].length > max) { setError(t('{field}最多允许 {count} 个字符。', '{field} allows at most {count} characters.', { field: fieldLabel(key), count: max })); return }
    const changes: Partial<WorkDraft> = creating ? { ...intended } : changedWorkFields(workDraft(baseline || undefined), intended)
    if (!documentsEnabled && (creating ? intended.documentIds.length > 0 : Object.hasOwn(changes, 'documentIds'))) {
      setError(t('资料库已关闭，文档关联修改和其他草稿已保留。重新开启后再保存。', 'Library is disabled. Document-link edits and the rest of your draft are retained. Re-enable it before saving.'))
      return
    }
    // A disabled library keeps its existing associations. Do not send an empty
    // document list as part of an otherwise unrelated create or edit.
    if (!documentsEnabled) delete changes.documentIds
    if (!creating && !Object.keys(changes).length) return
    running.current = true; setBusy(true); setError('')
    try {
      const item = await request<WorkItem>(creating ? `${workPath(spaceId)}/items` : path, { method: creating ? 'POST' : 'PATCH', body: creating ? { id: selection.id, ...changes, placement: 'start' } : { expectedRevision: against || baseline?.revision, ...changes } })
      adopt(item, creating ? t('事项已创建', 'Item created') : t('事项已保存', 'Item saved'))
    } catch (cause) {
      if (!alive.current) return
      const definite = cause instanceof ApiError && cause.status < 500
      if (cause instanceof ApiError && cause.code === 'work_status_unavailable') await loadStatuses()
      else if (isWorkClaimError(cause)) { setError(t('执行认领已变化，草稿已保留。请查看协作记录并核实后继续。', 'Execution ownership changed. Your draft is retained. Review the collaboration records and verify before continuing.')); try { const item = await request<WorkItem>(path); if (alive.current) setCollaboration(item.collaboration) } catch {} }
      else if (cause instanceof ApiError && cause.status === 409) { setConflict(true); setError(t('事项已被更新，当前草稿已保留。读取最新版本后比较。', 'This item changed elsewhere. Your draft is retained. Read the latest version to compare.')) }
      else if (!definite) {
        setUncertain(true); setError(t('保存结果尚未确认。正在读取现有记录，草稿会保留。', 'The save result is unconfirmed. Reading the current record; your draft is retained.'))
        try {
          const item = await request<WorkItem>(path)
          if (!alive.current) return
          const actual = normalizeWorkDraft(workDraft(item)), matches = Object.entries(changes).every(([key, value]) => JSON.stringify(actual[key as keyof WorkDraft]) === JSON.stringify(value))
          if (matches) adopt(item, t('已读到与当前草稿一致的内容。', 'The current record matches your draft.'))
          else { setRemote(item); setConflict(true); setError(t('当前记录与草稿不同，保存结果尚未确认。请比较后选择。', 'The current record differs from your draft; the save is unconfirmed. Compare before continuing.')) }
        } catch { if (alive.current) setError(t('无法确认保存结果，草稿已保留。请先重新读取。', 'The save could not be confirmed. Your draft is retained. Read the record again first.')) }
      } else setError(editorMessageOf(cause))
    } finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function toggleArchive() {
    if (!baseline || running.current || collaborationPending.busy || !canEdit) return
    if (claimBlocked) { setError(t('归档前请先查看执行记录并核实解除认领。', 'Review the execution records and verify the claim release before archiving.')); return }
    const intended = !baseline.archived
    running.current = true; setBusy(true); setError('')
    try { const item = await request<WorkItem>(path, { method: 'PATCH', body: { expectedRevision: baseline.revision, archived: intended } }); adopt(item, intended ? t('事项已归档', 'Item archived') : t('事项已恢复', 'Item restored')) }
    catch (cause) { if (alive.current) { if (cause instanceof ApiError && cause.code === 'module_disabled') setError(editorMessageOf(cause)); else if (isWorkClaimError(cause)) { setError(editorMessageOf(cause)); try { const item = await request<WorkItem>(path); if (alive.current) setCollaboration(item.collaboration) } catch {} } else { setError(cause instanceof ApiError && cause.status === 409 ? t('事项已更新，请读取最新版本后操作。', 'The item changed. Read its latest version before continuing.') : t('操作结果未确认，请重新读取。', 'The result is unconfirmed. Read the latest record.')); setConflict(true) } } }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  function toggleReference(item: WorkReference) {
    const key = item.kind === 'bookmark' ? 'bookmarkIds' : 'documentIds', present = draft[key].includes(item.id)
    setDraft(current => ({ ...current, [key]: present ? current[key].filter(id => id !== item.id) : [...current[key], item.id] }))
    setReferences(current => present ? current.filter(value => value.kind !== item.kind || value.id !== item.id) : [...current, item])
  }
  async function copyLink() {
    if (!baseline) return
    setLinkError('')
    try { await navigator.clipboard.writeText(new URL(workItemHref(spaceId, baseline.id), window.location.href).href); onNotice(t('事项链接已复制', 'Item link copied')) }
    catch { setLinkError(t('无法复制链接，请使用地址栏中的事项链接。', 'The link could not be copied. Use the item link in the address bar.')) }
  }
  function receiveCollaboration(item: WorkItem, resolved: boolean) {
    setCollaboration(item.collaboration)
    if (baseline && item.revision !== baseline.revision) {
      setExternalRevision(item.revision)
      if (resolved) { setRemote(item); setConflict(true); setError(t('认领已解除，事项也有其他更新。当前草稿已保留，请比较后保存。', 'The claim was released and the item has other updates. Your draft is retained; compare before saving.')) }
    }
    if (resolved) onCollaborationChanged()
  }
  const collaborationModel = useWorkCollaboration({ spaceId, item: baseline ? { ...baseline, collaboration } : null, canEdit, disabled: saving, onItem: receiveCollaboration, onPendingChange: setCollaborationPending, onNotice })
  const projectOptions = [{ value: '', label: t('未分组', 'No project') }, ...projects.filter(project => !project.archived || project.id === draft.projectId).map(project => ({ value: project.id, label: project.name + (project.archived ? t('（已归档）', ' (archived)') : '') }))]
  const comparison = remote ? Object.keys(changedWorkFields(workDraft(remote), draft)) as (keyof WorkDraft)[] : []
  function displayValue(key: keyof WorkDraft, value: WorkDraft) {
    if (key === 'projectId') return projects.find(item => item.id === value.projectId)?.name || t('未分组', 'No project')
    if (key === 'status') return workStatusLabel(value.status, statuses)
    if (key === 'needsAttention') return value.needsAttention ? t('是', 'Yes') : t('否', 'No')
    if (key === 'bookmarkIds' || key === 'documentIds') return t('{count} 项', '{count} items', { count: value[key].length })
    return value[key] || t('空', 'Empty')
  }
  const content = <>
    <header className="work-detail-heading"><div><h2 id="work-editor-title">{creating ? t('新建事项', 'New item') : t('事项详情', 'Item details')}</h2>{baseline?.archived && <span className="work-archived-label">{t('已归档', 'Archived')}</span>}</div><div className="work-detail-actions">{baseline && <><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onReveal(baseline)} aria-label={t('定位事项', 'Locate item')} title={t('清除筛选并定位此事项', 'Clear filters and locate this item')}><Crosshair size={16}/><span>{t('定位', 'Locate')}</span></Button><Button type="button" variant="ghost" size="icon-sm" disabled={busy} onClick={() => void copyLink()} aria-label={t('复制事项链接', 'Copy item link')} title={t('复制事项链接', 'Copy item link')}><Link2 size={16}/></Button></>}<Button type="button" variant="ghost" size="icon" disabled={busy} onClick={close} aria-label={t('关闭事项', 'Close item')}><X size={19}/></Button></div></header>
    {loading ? <Loading/> : !creating && !baseline ? <div className="work-detail-body"><ErrorMessage error={error}/><Button onClick={close}>{t('关闭', 'Close')}</Button></div> : <form className="work-detail-form" onSubmit={event => void save(event)} onInvalidCapture={event => handleFormInvalid(event, setError)} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault() }}>
      <div className="work-detail-body">
        <ErrorMessage error={error}/><ErrorMessage error={linkError}/>{statusesStale && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void readStatuses()}>{t('读取最新状态', 'Reload statuses')}</Button>}
        {(conflict || uncertain) && <section className="work-conflict"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void readLatest()}>{t('读取最新版本', 'Read latest version')}</Button>{remote && <><dl>{comparison.map(key => <div key={key}><dt>{fieldLabel(key)}</dt><dd><span>{t('最新', 'Latest')}</span><pre>{displayValue(key, workDraft(remote))}</pre></dd><dd><span>{t('草稿', 'Draft')}</span><pre>{displayValue(key, draft)}</pre></dd></div>)}</dl><div className="work-conflict-actions"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => adopt(remote, t('已使用最新版本', 'Using the latest version'))}>{t('使用最新版本', 'Use latest version')}</Button>{!creating && <Button type="button" size="sm" disabled={busy} onClick={() => void save(undefined, remote.revision)}>{t('保存草稿中的改动', 'Save my draft changes')}</Button>}</div></>}</section>}
        {externalRevision && !conflict && <div className="work-collaboration-updated"><span>{t('事项已有其他更新，当前草稿已保留。', 'The item has other updates. Your draft is retained.')}</span><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void readLatest()}>{t('读取最新版本', 'Read latest version')}</Button></div>}
        {baseline && <WorkCollaboration model={collaborationModel}/>}
        {claimBlocked && dirty && <p className="work-collaboration-draft">{t('保存前需核实并解除认领，草稿已保留。', 'Verify and release the claim before saving. Your draft is retained.')}</p>}
        <fieldset disabled={busy || !canEdit} className="admin-plain-fieldset">
          <Field label={t('事项标题', 'Item title')}><Input data-work-title autoFocus={creating} required maxLength={320} value={draft.title} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}/></Field>
          <div className="work-fields-row"><Field label={t('状态', 'Status')}><StyledSelect value={draft.status} onValueChange={value => setDraft(current => ({ ...current, status: value as WorkStatus }))} disabled={busy || !canEdit} tone="home" theme={theme} options={[...statuses.map(status => ({ value: status.id, label: status.name, title: status.description })), ...(!statuses.some(status => status.id === draft.status) ? [{ value: draft.status, label: t('{name}（已不可用）', '{name} (unavailable)', { name: baseline?.statusDefinition?.name || draft.status }), disabled: true }] : [])]}/></Field><Field label={t('项目', 'Project')}><StyledSelect value={draft.projectId || ''} onValueChange={value => setDraft(current => ({ ...current, projectId: value || null }))} disabled={busy || !canEdit} tone="home" theme={theme} options={projectOptions}/></Field></div>
          <label className="work-attention-check"><Checkbox checked={draft.needsAttention} disabled={busy || !canEdit} onCheckedChange={value => setDraft(current => ({ ...current, needsAttention: !!value }))}/><span>{t('待我处理', 'Needs my attention')}</span></label>
          <Field label={t('下一步', 'Next step')}><Textarea rows={2} maxLength={2000} value={draft.nextStep} onChange={event => setDraft(current => ({ ...current, nextStep: event.target.value }))} placeholder={statuses.find(status => status.id === draft.status)?.type === 'waiting' ? t('在等待什么？', 'What are you waiting for?') : ''}/></Field>
          <Field label={t('说明', 'Description')}><Textarea rows={3} maxLength={8000} value={draft.description} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))}/></Field>
          <Field label={t('结果', 'Result')}><Textarea rows={3} maxLength={8000} value={draft.result} onChange={event => setDraft(current => ({ ...current, result: event.target.value }))}/></Field>
        </fieldset>
        <section className="work-reference-section"><header><h3>{t('关联资料', 'Linked resources')}</h3>{canEdit && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setPicker(value => !value)}><Plus size={14}/>{t('关联资料', 'Link resources')}</Button>}</header>
          <div className="work-references">{references.map(item => {
            const available = item.available && (item.kind !== 'document' || documentsEnabled)
            const direct = !documentsEnabled && item.kind === 'bookmark'
            const href = available ? direct ? safeHref(item.url || '') : workLibraryHref(spaceId, item) : undefined
            return <div key={`${item.kind}:${item.id}`} className={!available ? 'unavailable' : ''}>
              {item.kind === 'document' ? <FileText size={16}/> : <Link2 size={16}/>}
              {href ? <a href={href} target={direct ? '_blank' : undefined} rel={direct ? 'noopener noreferrer' : undefined} onClick={event => {
                if (direct || event.button || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
                event.preventDefault(); requestNavigation(() => { window.location.hash = href })
              }} title={item.title}>{item.title}</a> : <span className="work-reference-unavailable">{available ? item.title : t('资料暂不可用', 'Resource unavailable')}</span>}
              {documentsEnabled && item.kind === 'bookmark' && available && item.url && <a href={safeHref(item.url)} target="_blank" rel="noopener noreferrer" aria-label={t('打开书签：{title}', 'Open bookmark: {title}', { title: item.title })}><ArrowUpRight size={14}/></a>}
              {canEdit && (item.kind !== 'document' || documentsEnabled) && <Button type="button" variant="ghost" size="icon-sm" disabled={busy} aria-label={t('取消关联：{title}', 'Unlink: {title}', { title: item.title })} onClick={() => toggleReference(item)}><X size={13}/></Button>}
            </div>
          })}</div>
          {picker && <ResourcePicker spaceId={spaceId} selected={references} disabled={busy} documentsEnabled={documentsEnabled} onToggle={toggleReference} onClose={() => setPicker(false)}/>}
        </section>
        {baseline && <div className="work-item-times">{baseline.createdAt && <time className="work-updated" dateTime={baseline.createdAt}>{t('创建于 {time}', 'Created {time}', { time: formatUpdated(baseline.createdAt) })}</time>}<time className="work-updated" dateTime={baseline.updatedAt}>{t('更新于 {time}', 'Updated {time}', { time: formatUpdated(baseline.updatedAt) })}</time></div>}
        {baseline && <WorkActivity spaceId={spaceId} itemId={baseline.id} revision={baseline.revision}/>}
      </div>
      <footer className="work-detail-footer">{baseline && canEdit && <Button type="button" variant="ghost" disabled={busy || claimBlocked} onClick={() => guard.requestLeave(() => void toggleArchive())}>{baseline.archived ? <ArchiveRestore size={16}/> : <Archive size={16}/>}<span>{baseline.archived ? t('恢复事项', 'Restore item') : t('归档事项', 'Archive item')}</span></Button>}<span className="grow"/><Button type="button" variant="outline" disabled={busy} onClick={close}>{t('关闭', 'Close')}</Button>{canEdit && <Button type="submit" disabled={busy || claimBlocked || !draft.title.trim() || (!creating && !dirty) || uncertain || conflict}><Save size={15}/>{saving ? t('正在保存…', 'Saving…') : creating ? t('创建事项', 'Create item') : t('保存事项', 'Save item')}</Button>}</footer>
    </form>}
  </>
  return <>{wide ? <aside className="work-detail" aria-labelledby="work-editor-title" data-work-detail-id={selection.id}>{content}</aside> : <Dialog open onOpenChange={value => { if (!value && !busy) close() }}><DialogContent className={`admin-ui work-theme work-theme-${theme} work-drawer`} data-theme={theme} showCloseButton={false} aria-describedby={undefined} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onPointerDownOutside={event => { if (busy) event.preventDefault() }} onCloseAutoFocus={event => { if (!returningTo.current?.isConnected) { event.preventDefault(); document.querySelector<HTMLElement>('[data-work-new]')?.focus() } }}><DialogTitle className="sr-only">{creating ? t('新建事项', 'New item') : t('事项详情', 'Item details')}</DialogTitle><div className="work-detail" data-work-detail-id={selection.id}>{content}</div></DialogContent></Dialog>}{guard.blocked && <DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard}/>}</>
}
