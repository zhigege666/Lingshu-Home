import { useEffect, useRef, useState } from 'react'
import { ArrowRightLeft, ChevronDown, Clock3, RefreshCw, ShieldCheck, Users } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { formatUpdated } from '../core/presentation'
import { newWorkId, workPath, type WorkCollaborationSummary, type WorkEvent, type WorkEventPage, type WorkHandoff, type WorkItem } from '../core/work-types'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Textarea } from '../components/ui/textarea'
import { StyledSelect } from '../components/ui/select'
import { ErrorMessage, Field, Loading, Modal } from '../components/Shared'
import { useWorkTheme } from './work-theme'
import './work-collaboration.css'

export const shortWorkSession = (id: string) => id.slice(-8)
export const isWorkClaimError = (cause: unknown) => cause instanceof ApiError && /^work_(claim|session|collaboration|recovery_required)/.test(cause.code)
export function collaborationLabel(value: WorkCollaborationSummary, terminal = false): string {
  if (value.state === 'expired') return t('执行确认已过期', 'Execution confirmation expired')
  if (value.state === 'released') {
    if (value.unresolved) return t('交接待核实', 'Handoff needs verification')
    if (terminal) return t('执行已结束', 'Execution ended')
    return value.latestHandoff ? t('已交接，可接手', 'Handed off, available to take over') : t('认领已解除', 'Claim released')
  }
  if (value.state === 'active') return t('正在执行', 'Executing')
  return t('未认领', 'Unclaimed')
}
export function WorkExecutor({ value, terminal = false }: { value?: WorkCollaborationSummary; terminal?: boolean }) {
  if (!value || value.state === 'unclaimed' || terminal && value.state === 'released' && !value.unresolved) return null
  return <div className={`work-executor${value.state === 'expired' || value.unresolved && value.state === 'released' ? ' work-executor-warning' : ''}`} data-work-collaboration data-collaboration-state={value.state}>
    {value.state === 'active' ? <Users size={12} aria-hidden="true"/> : value.state === 'expired' ? <Clock3 size={12} aria-hidden="true"/> : <ArrowRightLeft size={12} aria-hidden="true"/>}
    <span className="work-executor-label">{value.state === 'active' ? value.session?.agentName || t('执行会话', 'Execution session') : collaborationLabel(value, terminal)}</span>
    {value.state === 'active' && value.session && <code title={t('会话 {id}', 'Session {id}', { id: value.session.id })}>{shortWorkSession(value.session.id)}</code>}
  </div>
}

const eventLabel = (kind: string) => ({
  note: t('补充说明', 'Note'), question: t('提问', 'Question'), review: t('审查意见', 'Review'), decision: t('决定', 'Decision'), progress: t('进展', 'Progress'),
  claim_acquired: t('认领事项', 'Claimed item'), claim_released: t('交接事项', 'Handed off item'), claim_resolved: t('核实并解除认领', 'Verified and released claim'),
  claim_recovered: t('核实后重新认领', 'Claimed after verification'), item_completed: t('完成并释放认领', 'Completed and released claim'), item_canceled: t('取消并释放认领', 'Canceled and released claim'), item_archived: t('归档并释放认领', 'Archived and released claim'),
  acquired: t('认领事项', 'Claimed item'), released: t('交接事项', 'Handed off item'), resolved: t('核实并解除认领', 'Verified and released claim'),
} as Record<string, string>)[kind] || kind
const originLabel = (origin: WorkEvent['origin']) => origin === 'mcp' ? 'MCP' : origin === 'api' ? 'API' : t('网页', 'Web')
function Handoff({ value }: { value: WorkHandoff }) {
  return <dl className="work-handoff">{([
    ['completed', t('已完成', 'Completed')], ['workspace', t('工作位置', 'Workspace')],
    ['nextStep', t('下一步', 'Next step')], ['unknowns', t('待核实', 'Unconfirmed')],
  ] as const).filter(([key]) => value[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{value[key]}</dd></div>)}</dl>
}
type NoteRequest = { operationId: string; kind: string; body: string; after: string }
type ResolveRequest = { operationId: string; expectedGeneration: string; reason: string; externalOperationsStopped: true; after: string }
type PendingState = { dirty: boolean; busy: boolean; discard: () => void }
type Props = {
  spaceId: string; item: WorkItem | null; canEdit: boolean; disabled: boolean;
  onItem: (item: WorkItem, resolved: boolean) => void; onPendingChange: (state: PendingState) => void; onNotice: (message: string) => void;
}

// Keep drafts, operation receipts and in-flight requests at the stable editor
// level. Switching between the wide pane and the drawer only remounts the view.
export function useWorkCollaboration({ spaceId, item, canEdit, disabled, onItem, onPendingChange, onNotice }: Props) {
  const theme = useWorkTheme(), path = `${workPath(spaceId)}/items/${encodeURIComponent(item?.id || '')}`
  const [snapshot, setSnapshot] = useState(item?.collaboration), [expanded, setExpanded] = useState(false)
  const [page, setPage] = useState<WorkEventPage | null>(null), [reading, setReading] = useState(false), [error, setError] = useState('')
  const [body, setBody] = useState(''), [kind, setKind] = useState('note'), [pendingNote, setPendingNote] = useState<NoteRequest | null>(null)
  const [resolving, setResolving] = useState(false), [resolveGeneration, setResolveGeneration] = useState(''), [reason, setReason] = useState(''), [stopped, setStopped] = useState(false)
  const [pendingResolve, setPendingResolve] = useState<ResolveRequest | null>(null), [resolveError, setResolveError] = useState(''), [mutating, setMutating] = useState(false)
  const alive = useRef(true), readingRef = useRef(false), working = useRef(false), pageRef = useRef(page), expandedRef = useRef(expanded)
  const callbacks = useRef({ onItem, onPendingChange, onNotice }); callbacks.current = { onItem, onPendingChange, onNotice }
  pageRef.current = page; expandedRef.current = expanded
  useEffect(() => { setSnapshot(item?.collaboration) }, [item?.collaboration])
  const discard = () => { setBody(''); setPendingNote(null); setReason(''); setStopped(false); setResolving(false); setPendingResolve(null); setResolveError('') }
  useEffect(() => {
    callbacks.current.onPendingChange({ dirty: !!body.trim() || !!pendingNote || !!reason.trim() || stopped || !!pendingResolve, busy: mutating, discard })
  }, [body, pendingNote, reason, stopped, pendingResolve, mutating])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; callbacks.current.onPendingChange({ dirty: false, busy: false, discard: () => {} }) }
  }, [])
  function mergePage(value: WorkEventPage) {
    setPage(previous => {
      const byId = new Map((previous?.items || []).map(event => [event.id, event]))
      value.items.forEach(event => byId.set(event.id, event))
      return { ...value, items: [...byId.values()].sort((left, right) => BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1) }
    })
  }
  async function readItem(resolved = false, signal?: AbortSignal) {
    const latest = await request<WorkItem>(path, { signal })
    if (alive.current && !signal?.aborted) { setSnapshot(latest.collaboration); callbacks.current.onItem(latest, resolved) }
    return latest
  }
  async function readEvents(mode: 'refresh' | 'more' = 'refresh', signal?: AbortSignal) {
    if (readingRef.current) return
    const current = pageRef.current
    if (mode === 'refresh' && current?.nextCursor) return
    readingRef.current = true; setReading(true)
    const query = new URLSearchParams({ limit: '30' })
    if (mode === 'more' && current?.nextCursor) query.set('cursor', current.nextCursor)
    else if (current?.nextAfter) query.set('after', current.nextAfter)
    try {
      const value = await request<WorkEventPage>(`${path}/events?${query}`, { signal })
      if (alive.current && !signal?.aborted) { mergePage(value); setError('') }
    } catch (cause) { if (alive.current && !signal?.aborted) setError(messageOf(cause)) }
    finally { readingRef.current = false; if (alive.current && !signal?.aborted) setReading(false) }
  }
  useEffect(() => {
    if (expanded && !pageRef.current) void readEvents()
  }, [expanded])
  useEffect(() => {
    if (!item?.collaboration) return
    const abort = new AbortController()
    let checking = false
    const refresh = async () => {
      if (checking || working.current || document.visibilityState !== 'visible') return
      checking = true
      try {
        const reads: Promise<unknown>[] = [readItem(false, abort.signal)]
        if (expandedRef.current && pageRef.current) reads.push(readEvents('refresh', abort.signal))
        const results = await Promise.allSettled(reads)
        if (!abort.signal.aborted && alive.current && results[0].status === 'rejected') setError(t('协作信息暂未刷新，正在显示上次读取结果。', 'Collaboration details could not be refreshed. Showing the last read result.'))
      } finally { checking = false }
    }
    const interval = window.setInterval(() => void refresh(), 15000)
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible)
    return () => { abort.abort(); clearInterval(interval); window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible) }
  }, [path, !!item?.collaboration])

  // A lost response keeps its original identifier and payload. Look for the
  // receipt before offering an exact replay; never create a replacement event.
  async function findOperation(operationId: string, after: string): Promise<WorkEvent | undefined> {
    let query = new URLSearchParams({ limit: '100', ...(after ? { after } : {}) })
    for (let count = 0; count < 10; count++) {
      const value = await request<WorkEventPage>(`${path}/events?${query}`)
      const found = value.items.find(event => event.operationId === operationId)
      if (found || !value.nextCursor) return found
      query = new URLSearchParams({ limit: '100', cursor: value.nextCursor })
    }
    return undefined
  }
  function noteSaved(event: WorkEvent) {
    setPage(previous => previous ? { ...previous, items: previous.items.some(old => old.id === event.id) ? previous.items : [...previous.items, event].sort((left, right) => BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1) } : previous)
    setBody(''); setPendingNote(null); setError(''); callbacks.current.onNotice(t('协作记录已添加', 'Collaboration record added'))
  }
  async function saveNote(retry = false) {
    if (working.current || disabled || !canEdit || !body.trim() || [...body.trim()].length > 4000) return
    const payload = retry ? pendingNote : { operationId: newWorkId(), kind, body: body.trim(), after: pageRef.current?.highWatermark || '' }
    if (!payload) return
    working.current = true; setMutating(true); setError(''); setPendingNote(payload)
    try {
      if (retry) { const known = await findOperation(payload.operationId, payload.after); if (known) { if (alive.current) noteSaved(known); return } }
      const { after: _after, ...input } = payload
      const event = await request<WorkEvent>(`${path}/events`, { method: 'POST', body: input })
      if (alive.current) noteSaved(event)
    } catch (cause) {
      if (!alive.current) return
      if (cause instanceof ApiError && cause.status < 500) { setPendingNote(null); setError(messageOf(cause)) }
      else {
        try { const known = await findOperation(payload.operationId, payload.after); if (known && alive.current) { noteSaved(known); return } } catch { /* The original request remains available for an exact replay. */ }
        if (alive.current) setError(t('添加结果尚未确认，内容与创建标识已保留。先重新核对，再重试同次提交。', 'The add result is unconfirmed. The content and operation ID are retained. Read again before retrying the same submission.'))
      }
    } finally { working.current = false; if (alive.current) setMutating(false) }
  }
  async function verifyNote() {
    if (!pendingNote || working.current) return
    working.current = true; setMutating(true)
    try { const known = await findOperation(pendingNote.operationId, pendingNote.after); if (alive.current) { if (known) noteSaved(known); else setError(t('暂未查询到这次提交；可以按原标识重试，避免重复记录。', 'This submission has not been found. Retry with its original ID to avoid duplicate records.')) } }
    catch (cause) { if (alive.current) setError(messageOf(cause)) }
    finally { working.current = false; if (alive.current) setMutating(false) }
  }
  async function resolveClaim(retry = false) {
    if (working.current || disabled || !canEdit || (!retry && (!snapshot?.canResolve || !stopped || !reason.trim()))) return
    const payload: ResolveRequest | null = retry ? pendingResolve : { operationId: newWorkId(), expectedGeneration: resolveGeneration, reason: reason.trim(), externalOperationsStopped: true, after: pageRef.current?.highWatermark || '' }
    if (!payload) return
    working.current = true; setMutating(true); setResolveError(''); setPendingResolve(payload)
    try {
      const known = retry ? await findOperation(payload.operationId, payload.after) : undefined
      if (!known) {
        const { after: _after, ...input } = payload
        await request(`${path}/claim/resolve`, { method: 'POST', body: input })
      }
      await readItem(true)
      if (alive.current) { setPendingResolve(null); setResolving(false); setReason(''); setStopped(false); callbacks.current.onNotice(t('认领已解除，已重新读取当前事项', 'Claim released; the current item has been read again')); void readEvents() }
    } catch (cause) {
      if (!alive.current) return
      if (cause instanceof ApiError && cause.status < 500) { setPendingResolve(null); setStopped(false); setResolveError(messageOf(cause)); try { await readItem() } catch {} }
      else {
        try {
          const known = await findOperation(payload.operationId, payload.after)
          if (known) { await readItem(true); if (alive.current) { setPendingResolve(null); setResolving(false); setReason(''); setStopped(false); callbacks.current.onNotice(t('已核实认领解除记录', 'Claim release record verified')); void readEvents() }; return }
        } catch { /* Keep the original request until its result can be verified. */ }
        if (alive.current) setResolveError(t('解除结果尚未确认。原原因和标识已保留，请重新核对并重试同次操作。', 'The release result is unconfirmed. The reason and operation ID are retained; check again and retry the same operation.'))
      }
    } finally { working.current = false; if (alive.current) setMutating(false) }
  }
  return {
    theme, item, canEdit, disabled, snapshot, expanded, setExpanded, page, reading, error, setError,
    body, setBody, kind, setKind, pendingNote, resolving, setResolving, resolveGeneration, setResolveGeneration,
    reason, setReason, stopped, setStopped, pendingResolve, resolveError, setResolveError, mutating,
    readItem, readEvents, verifyNote, saveNote, resolveClaim,
  }
}

export default function WorkCollaboration({ model }: { model: ReturnType<typeof useWorkCollaboration> }) {
  const {
    theme, item, canEdit, disabled, snapshot, expanded, setExpanded, page, reading, error, setError,
    body, setBody, kind, setKind, pendingNote, resolving, setResolving, resolveGeneration, setResolveGeneration,
    reason, setReason, stopped, setStopped, pendingResolve, resolveError, setResolveError, mutating,
    readItem, readEvents, verifyNote, saveNote, resolveClaim,
  } = model
  if (!snapshot || !item) return null
  const terminal = item.archived || item.statusDefinition?.type === 'done' || item.statusDefinition?.type === 'canceled'
  const session = snapshot.session, flagged = snapshot.state === 'expired' || snapshot.state === 'released' && snapshot.unresolved
  const resolveChanged = resolving && snapshot.generation !== resolveGeneration && !pendingResolve
  return <section className="work-collaboration" data-work-collaboration data-collaboration-state={snapshot.state} aria-label={t('协作', 'Collaboration')}>
    <header><h3><Users size={15} aria-hidden="true"/>{t('协作', 'Collaboration')}</h3><span className={`work-collaboration-status${flagged ? ' is-warning' : ''}`}>{collaborationLabel(snapshot, terminal)}</span></header>
    {session && <dl className="work-collaboration-facts">
      <div><dt>{t('授权用户', 'Authorized user')}</dt><dd>{session.actor?.name || t('未记录', 'Not recorded')}</dd></div>
      <div><dt>{t('Agent 声明', 'Agent declaration')}</dt><dd>{session.agentName}<span>{[session.clientName, session.role].filter(Boolean).join(' · ')}</span></dd></div>
      <div><dt>{t('会话', 'Session')}</dt><dd><code title={session.id}>{shortWorkSession(session.id)}</code></dd></div>
      {snapshot.lastSeenAt && <div><dt>{t('最近联系', 'Last contact')}</dt><dd><time dateTime={snapshot.lastSeenAt}>{formatUpdated(snapshot.lastSeenAt)}</time></dd></div>}
      {snapshot.lastProgressAt && <div><dt>{t('最近进展', 'Last progress')}</dt><dd><time dateTime={snapshot.lastProgressAt}>{formatUpdated(snapshot.lastProgressAt)}</time></dd></div>}
    </dl>}
    {flagged && <p className="work-collaboration-caution">{snapshot.state === 'expired' ? t('需要先核实外部操作是否仍在运行，再决定接手。', 'Check whether external operations are still running before taking over.') : t('交接仍有待核实操作，请确认后再接手。', 'The handoff includes unconfirmed operations. Verify them before taking over.')}</p>}
    {snapshot.latestHandoff && <Handoff value={snapshot.latestHandoff}/>}
    <div className="work-collaboration-actions"><Button type="button" size="sm" variant="ghost" aria-expanded={expanded} aria-controls={`work-events-${item.id}`} onClick={() => setExpanded(value => !value)}><ChevronDown size={14} className={expanded ? 'is-open' : ''}/>{t('执行记录', 'Execution records')}{page && <span>{page.items.length}{page.nextCursor ? '+' : ''}</span>}</Button>
      {canEdit && snapshot.canResolve && (snapshot.unresolved || snapshot.state === 'active' || snapshot.state === 'expired') && <Button type="button" variant="outline" size="sm" disabled={disabled || mutating} data-work-resolve-claim onClick={() => { setResolveGeneration(snapshot.generation); setResolveError(''); setResolving(true) }}><ShieldCheck size={14}/>{t('核实并解除认领', 'Verify and release claim')}</Button>}
    </div>
    {error && !expanded && <ErrorMessage error={error}/>}
    {expanded && <div id={`work-events-${item.id}`} className="work-events">
      <header><h4>{t('协作记录', 'Collaboration records')}</h4><Button type="button" variant="ghost" size="icon-sm" disabled={reading || !!page?.nextCursor} onClick={() => { void readItem().catch(cause => setError(messageOf(cause))); void readEvents() }} aria-label={t('刷新协作记录', 'Refresh collaboration records')}><RefreshCw size={14}/></Button></header>
      <ErrorMessage error={error}/>
      {reading && !page ? <Loading/> : page && <><ol>{page.items.map(event => <li key={event.id} data-work-event-id={event.id}>
        <div className="work-event-heading"><strong>{eventLabel(event.kind)}</strong><time dateTime={event.occurredAt}>{formatUpdated(event.occurredAt)}</time></div>
        <p className="work-event-attribution">{event.actor?.name || t('操作者未记录', 'Actor not recorded')} · {originLabel(event.origin)}{event.session && <span>{event.session.agentName} · <code title={event.session.id}>{shortWorkSession(event.session.id)}</code></span>}</p>
        {event.body && <p className="work-event-body">{event.body}</p>}{event.handoff && <Handoff value={event.handoff}/>}
      </li>)}</ol>{!page.items.length && <p className="work-collaboration-empty">{t('暂无协作记录', 'No collaboration records yet')}</p>}
      {page.nextCursor && <Button type="button" variant="ghost" size="sm" disabled={reading} onClick={() => void readEvents('more')}>{reading ? t('正在读取…', 'Loading…') : t('继续读取后续记录', 'Read subsequent records')}</Button>}</>}
      {canEdit && <div className="work-event-composer">
        <Field label={t('补充协作记录', 'Add a collaboration record')}><Textarea data-work-collaboration-note aria-label={t('补充协作记录', 'Add a collaboration record')} rows={2} maxLength={8000} disabled={disabled || mutating || !!pendingNote} value={body} onChange={event => setBody(event.target.value)}/></Field>
        <div className="work-event-composer-actions"><StyledSelect aria-label={t('记录类型', 'Record type')} value={kind} onValueChange={setKind} disabled={disabled || mutating || !!pendingNote} tone="home" theme={theme} options={['note', 'question', 'review', 'decision', 'progress'].map(value => ({ value, label: eventLabel(value) }))}/>
          {pendingNote ? <><Button type="button" variant="outline" size="sm" disabled={disabled || mutating} onClick={() => void verifyNote()}>{t('重新核对', 'Verify again')}</Button><Button type="button" size="sm" disabled={disabled || mutating} onClick={() => void saveNote(true)}>{t('重试同次提交', 'Retry same submission')}</Button></> : <Button type="button" size="sm" disabled={disabled || mutating || !body.trim() || [...body.trim()].length > 4000} onClick={() => void saveNote()}>{t('添加记录', 'Add record')}</Button>}
        </div>{[...body.trim()].length > 4000 && <ErrorMessage error={t('记录最多允许 4000 个字符。', 'A record allows at most 4,000 characters.')}/>}
      </div>}
    </div>}
    {resolving && <Modal title={t('核实并解除认领', 'Verify and release claim')} className={`work-theme work-theme-${theme} work-resolve-dialog`} busy={mutating} onClose={() => { setResolving(false); setResolveError('') }}>
      <p className="work-resolve-context">{session?.agentName || t('执行会话', 'Execution session')} · <code title={session?.id}>{session ? shortWorkSession(session.id) : '—'}</code></p>
      <p className="work-collaboration-caution">{t('解除认领不会停止外部命令。先核实原会话的外部操作已停止，再解除其写入权限。', 'Releasing a claim does not stop external commands. Verify that the original session’s external operations have stopped before removing its write ownership.')}</p>
      <ErrorMessage error={resolveError}/>{resolveChanged && <ErrorMessage error={t('认领已变化，请取消后重新查看执行记录并核实。', 'The claim changed. Cancel, review the current execution records, and verify again.')}/>}
      <Field label={t('核实情况与解除原因', 'Verification and release reason')}><Textarea aria-label={t('核实情况与解除原因', 'Verification and release reason')} autoFocus rows={3} maxLength={2000} value={reason} disabled={mutating || !!pendingResolve} onChange={event => setReason(event.target.value)}/></Field>
      <label className="work-resolve-check"><Checkbox checked={stopped} disabled={mutating || !!pendingResolve} onCheckedChange={setStopped}/><span>{t('已核实相关外部操作已停止', 'I verified that the related external operations have stopped')}</span></label>
      <div className="admin-form-footer"><Button type="button" variant="outline" disabled={mutating} onClick={() => { setResolving(false); setResolveError('') }}>{t('返回查看', 'Back to review')}</Button><Button type="button" disabled={mutating || resolveChanged || !reason.trim() || !stopped} onClick={() => void resolveClaim(!!pendingResolve)}>{mutating ? t('正在核实…', 'Verifying…') : pendingResolve ? t('重新核对并重试', 'Verify and retry') : t('解除认领', 'Release claim')}</Button></div>
    </Modal>}
  </section>
}
