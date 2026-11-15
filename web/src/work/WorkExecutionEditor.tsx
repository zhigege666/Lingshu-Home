import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUpRight, Check, Play, RefreshCw, X } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { formatUpdated } from '../core/presentation'
import { useUnsavedChanges } from '../core/useUnsavedChanges'
import { workPath, type WorkItem } from '../core/work-types'
import type { WorkExecution, WorkExecutionResponse, WorkExecutorDefinition } from '../core/work-automation-types'
import { Button } from '../components/ui/button'
import { Textarea } from '../components/ui/textarea'
import { ErrorMessage, Field, Loading, handleFormInvalid } from '../components/Shared'
import DiscardChangesDialog from '../components/DiscardChangesDialog'
import WorkToolDetail from './WorkToolDetail'
import { executionStateLabel } from './work-automation-presentation'
import { WorkExecutorPicker, WorkItemSelector } from './WorkExecutionControls'

const activeStates = new Set(['queued', 'dispatching', 'running'])
export default function WorkExecutionEditor({ spaceId, selection, initialItem, enabled, canExecute, onClose, onSaved, onOpenItem }: { spaceId: string; selection: { id: string; create?: boolean }; initialItem?: WorkItem; enabled: boolean; canExecute: boolean; onClose: () => void; onSaved: (value: WorkExecution) => void; onOpenItem: (id: string) => void }) {
  const [creating, setCreating] = useState(!!selection.create), [item, setItem] = useState<WorkItem | null>(initialItem || null), [executor, setExecutor] = useState<WorkExecutorDefinition | null>(null), [response, setResponse] = useState<WorkExecutionResponse | null>(null)
  const [loading, setLoading] = useState(!selection.create), [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false), [refresh, setRefresh] = useState(0)
  const [resolving, setResolving] = useState(false), [outcome, setOutcome] = useState<'succeeded' | 'failed'>('failed'), [note, setNote] = useState(''), [confirmed, setConfirmed] = useState(false)
  const alive = useRef(true), pending = useRef(false), initialStart = useRef<{ id: string; itemId: string; expectedItemRevision: string; executorId: string } | null>(null)
  const dirty = creating ? !!executor || (!!item && !initialItem) : !!note || confirmed
  const guard = useUnsavedChanges(dirty, busy), path = `${workPath(spaceId)}/executions/${selection.id}`
  const value = response?.execution, editable = enabled && (response?.canExecute ?? canExecute)
  const itemClaimed = item?.collaboration && (item.collaboration.state === 'active' || item.collaboration.state === 'expired' || item.collaboration.unresolved)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!enabled || creating) return
    const abort = new AbortController(); if (!response) setLoading(true)
    request<WorkExecutionResponse>(path, { signal: abort.signal }).then(data => { if (!abort.signal.aborted) { setResponse(data); setUncertain(false); setError('') } }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [path, enabled, creating, refresh])
  useEffect(() => {
    if (!enabled || busy || error || !value || !(activeStates.has(value.state) || (value.state === 'unknown' && !!value.nextPollAt))) return
    const timer = setTimeout(() => { if (document.visibilityState === 'visible') setRefresh(old => old + 1) }, 5000)
    const visible = () => { if (document.visibilityState === 'visible') setRefresh(old => old + 1) }
    document.addEventListener('visibilitychange', visible)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [response, enabled, busy, error])
  function adopt(data: WorkExecutionResponse) { setResponse(data); setCreating(false); setError(''); setUncertain(false); onSaved(data.execution) }
  async function readLatest() {
    if (pending.current || !enabled) return
    pending.current = true; setBusy(true)
    try { const data = await request<WorkExecutionResponse>(path); if (alive.current) adopt(data) }
    catch (cause) { if (alive.current) { if (cause instanceof ApiError && cause.status === 404 && creating) { setUncertain(false); setError(t('尚未查到执行记录；保留同一请求编号，可再次提交。', 'No execution record was found. The same request ID is retained for another submission.')) } else setError(messageOf(cause)) } }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function start(event: FormEvent) {
    event.preventDefault()
    if (!creating || !item || !executor || !editable || pending.current || uncertain || itemClaimed || item.archived) return
    const input = initialStart.current || { id: selection.id, itemId: item.id, expectedItemRevision: item.revision, executorId: executor.id }
    initialStart.current = input; pending.current = true; setBusy(true); setError('')
    try { const data = await request<WorkExecutionResponse>(`${workPath(spaceId)}/executions`, { method: 'POST', body: input }); if (alive.current) adopt(data) }
    catch (cause) { if (alive.current) { if (!(cause instanceof ApiError) || cause.status >= 500) { setUncertain(true); setError(t('派发请求的结果未确认。先读取此编号的记录，不会自动重发。', 'The dispatch request is unconfirmed. Read this request’s record first; it will not be resent automatically.')) } else { setError(messageOf(cause)); if (cause.code !== 'work_execution_id_conflict') initialStart.current = null; else setUncertain(true) } } }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function act(action: 'reconcile' | 'resolve') {
    if (!value || !editable || pending.current || uncertain) return
    if (action === 'resolve' && (!response?.canResolve || !note.trim() || (value.state === 'unknown' && !confirmed))) return
    pending.current = true; setBusy(true); setError('')
    try {
      const body = action === 'reconcile' ? { expectedRevision: value.revision } : { expectedRevision: value.revision, outcome: value.state === 'queued' ? 'canceled' : outcome, note: note.trim(), ...(value.state === 'unknown' ? { externalStoppedConfirmed: true } : {}) }
      const data = await request<WorkExecutionResponse>(`${path}/${action}`, { method: 'POST', body })
      if (alive.current) { adopt(data); if (action === 'resolve') { setNote(''); setConfirmed(false); setResolving(false) } }
    } catch (cause) { if (alive.current) { setError(messageOf(cause)); if (!(cause instanceof ApiError) || cause.status >= 500 || cause.status === 409) setUncertain(true) } }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  const close = () => guard.requestLeave(onClose)
  return <><WorkToolDetail title={creating ? t('新建执行', 'New execution') : t('执行记录', 'Execution record')} busy={busy} onClose={close}><header className="work-detail-heading"><h2>{creating ? t('新建执行', 'New execution') : t('执行记录', 'Execution record')}</h2><Button type="button" size="icon" variant="ghost" disabled={busy} aria-label={t('关闭执行记录', 'Close execution record')} onClick={close}><X size={18}/></Button></header>{loading ? <Loading/> : <form className="work-detail-form" onSubmit={event => { if (creating) void start(event); else { event.preventDefault(); void act('resolve') } }} onInvalidCapture={event => handleFormInvalid(event, setError)}><div className="work-detail-body"><ErrorMessage error={error}/>{uncertain && <Button type="button" size="sm" variant="outline" disabled={busy || !enabled} onClick={() => void readLatest()}>{t('读取当前记录', 'Read current record')}</Button>}
    {creating ? <><Field label={t('事项', 'Item')}>{initialItem ? <div className="work-execution-item"><strong>{item?.id} {item?.title}</strong><small>{t('当前已保存的内容', 'Current saved content')}</small></div> : <WorkItemSelector spaceId={spaceId} enabled={enabled} value={item} disabled={busy || uncertain || !!initialStart.current} onChange={setItem}/>}</Field><Field label={t('执行器', 'Executor')}><WorkExecutorPicker spaceId={spaceId} enabled={enabled} executorId={executor?.id || null} disabled={busy || uncertain || !!initialStart.current || !canExecute} onChange={setExecutor}/></Field>{executor && <div className="work-execution-resource"><span>{t('资源', 'Resource')}</span><code>{executor.resourceKey}</code><small>{executor.endpoint}</small></div>}{itemClaimed && <p className="work-inline-note">{t('事项仍被认领，核实解除认领后再派发。', 'This item is still claimed. Verify and release the claim before dispatching.')}</p>}{item?.archived && <p className="work-inline-note">{t('先恢复事项再执行。', 'Restore the item before executing it.')}</p>}<p className="work-inline-note">{t('执行结果独立保存，事项状态由你确认后更新。', 'Execution results are stored separately. Update the item status after reviewing the result.')}</p></> : value && <>
      <div className="work-execution-summary"><span className={`work-run-state is-${value.state}`} data-execution-state={value.state}>{executionStateLabel(value.state)}</span>{value.manualResolution && <small>{t('人工确认', 'Manually resolved')}</small>}<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => guard.requestLeave(() => onOpenItem(value.itemId))}>{t('打开事项', 'Open item')}<ArrowUpRight size={13}/></Button></div>
      <dl className="work-execution-facts"><dt>{t('执行器', 'Executor')}</dt><dd>{value.executorName}</dd><dt>{t('资源', 'Resource')}</dt><dd><code>{value.resourceKey}</code></dd><dt>{t('请求编号', 'Request ID')}</dt><dd><code>{value.id}</code></dd><dt>{t('创建时间', 'Created')}</dt><dd>{formatUpdated(value.createdAt)}</dd>{value.startedAt && <><dt>{t('开始时间', 'Started')}</dt><dd>{formatUpdated(value.startedAt)}</dd></>}{value.finishedAt && <><dt>{t('结束时间', 'Finished')}</dt><dd>{formatUpdated(value.finishedAt)}</dd></>}{value.deadlineAt && <><dt>{t('核验期限', 'Verification deadline')}</dt><dd>{formatUpdated(value.deadlineAt)}</dd></>}</dl>
      {value.code && <small className="work-result-code">{value.code}</small>}{value.message && <p className="work-execution-message">{value.message}</p>}{value.result && <section className="work-execution-result"><h3>{t('执行结果', 'Execution result')}</h3><pre>{value.result}</pre></section>}
      {value.state === 'unknown' && <div className="work-unknown-execution" role="status">{t('外部结果尚未确认，资源仍被占用。', 'The external result is unconfirmed; the resource remains occupied.')}</div>}
      {resolving && response?.canResolve && (value.state === 'queued' || value.state === 'unknown') && <section className="work-manual-resolution"><h3>{value.state === 'queued' ? t('取消排队', 'Cancel queued execution') : t('人工确认结果', 'Resolve manually')}</h3>{value.state === 'unknown' && <Field label={t('确认结果', 'Verified outcome')}><select className="work-native-select" value={outcome} disabled={busy} onChange={event => setOutcome(event.target.value as typeof outcome)}><option value="failed">{t('已失败', 'Failed')}</option><option value="succeeded">{t('已成功', 'Succeeded')}</option></select></Field>}<Field label={t('核实说明', 'Verification note')}><Textarea data-execution-resolution-note required maxLength={1000} rows={3} disabled={busy} value={note} onChange={event => setNote(event.target.value)}/></Field>{value.state === 'unknown' && <label className="work-resolution-confirm"><input data-execution-stopped type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/>{t('已核实外部进程结束，可以解除资源占用', 'I verified that external work has ended and the resource can be released')}</label>}<Button type="submit" disabled={busy || uncertain || !enabled || !note.trim() || (value.state === 'unknown' && !confirmed)}><Check size={14}/>{value.state === 'queued' ? t('确认取消', 'Confirm cancellation') : t('确认并解除占用', 'Confirm and release resource')}</Button></section>}
    </>}
    </div><footer className="work-detail-footer"><span className="grow"/>{creating ? <Button type="submit" disabled={busy || uncertain || !editable || !item || !executor || !executor.enabled || executor.archived || !executor.credentialConfigured || !!itemClaimed || item.archived}><Play size={14}/>{t('开始执行', 'Start execution')}</Button> : value && <><Button type="button" variant="outline" size="sm" disabled={busy || !enabled} onClick={() => void readLatest()}><RefreshCw size={14}/>{t('刷新', 'Refresh')}</Button>{value.state === 'unknown' && editable && <Button type="button" variant="outline" size="sm" disabled={busy || uncertain || !!value.nextPollAt} onClick={() => void act('reconcile')}>{t('核验回执', 'Reconcile receipt')}</Button>}{response?.canResolve && (value.state === 'queued' || value.state === 'unknown') && <Button type="button" variant="outline" size="sm" disabled={busy || !enabled || uncertain} onClick={() => setResolving(current => !current)}>{value.state === 'queued' ? t('取消排队', 'Cancel queue') : t('人工确认', 'Resolve manually')}</Button>}</>}</footer></form>}</WorkToolDetail>{guard.blocked && <DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard}/>}</>
}
