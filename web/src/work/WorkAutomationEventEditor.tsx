import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUpRight, RefreshCw, Send, X } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { formatUpdated } from '../core/presentation'
import { useUnsavedChanges } from '../core/useUnsavedChanges'
import { workPath, type WorkItem, type WorkProject, type WorkStatusDefinition } from '../core/work-types'
import type { WorkAutomationEvent, WorkAutomationEventResponse, WorkAutomationReceipt, WorkAutomationRuleResponse } from '../core/work-automation-types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { ErrorMessage, Field, Loading, handleFormInvalid } from '../components/Shared'
import DiscardChangesDialog from '../components/DiscardChangesDialog'
import WorkToolDetail from './WorkToolDetail'
import { WorkItemSelector } from './WorkExecutionControls'
import { workEventTypeLabel, automationEventStateLabel } from './work-automation-presentation'


const receiptLabel = (state: WorkAutomationReceipt['result']) => ({ created: t('已生成', 'Created'), failed: t('失败', 'Failed'), skipped: t('已跳过', 'Skipped') })[state]
type Publish = { id: string; type: string; summary: string; details: string; url: string; projectId: string | null; statusId: string; sourceItemId: string | null }

export default function WorkAutomationEventEditor({ spaceId, selection, enabled, automationEnabled, canEdit, projects, statuses, onClose, onSaved, onOpenItem, onOpenExecution, onOpenRule }: { spaceId: string; selection: { id: string; create?: boolean }; enabled: boolean; automationEnabled: boolean; canEdit: boolean; projects: WorkProject[]; statuses: WorkStatusDefinition[]; onClose: () => void; onSaved: (value: WorkAutomationEvent) => void; onOpenItem: (id: string) => void; onOpenExecution: (id: string) => void; onOpenRule: (id: string) => void }) {
  const [creating, setCreating] = useState(!!selection.create), [response, setResponse] = useState<WorkAutomationEventResponse | null>(null), [draft, setDraft] = useState({ type: '', summary: '', details: '', url: '', projectId: null as string | null, statusId: '' }), [sourceItem, setSourceItem] = useState<WorkItem | null>(null)
  const [loading, setLoading] = useState(!selection.create), [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false), [refresh, setRefresh] = useState(0), [retry, setRetry] = useState<{ receipt: WorkAutomationReceipt; rule: WorkAutomationRuleResponse } | null>(null)
  const alive = useRef(true), pending = useRef(false), publication = useRef<Publish | null>(null)
  const dirty = creating && (!!draft.type || !!draft.summary || !!draft.details || !!draft.url || !!sourceItem), guard = useUnsavedChanges(dirty, busy), value = response?.event
  const path = `${workPath(spaceId)}/automation/events/${selection.id}`, editable = enabled && automationEnabled && (response?.canEdit ?? canEdit)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  function adopt(data: WorkAutomationEventResponse) { setResponse(data); setCreating(false); setError(''); setUncertain(false); setRetry(null); onSaved(data.event) }
  useEffect(() => {
    if (!enabled || creating) return
    const abort = new AbortController(); if (!response) setLoading(true)
    request<WorkAutomationEventResponse>(path, { signal: abort.signal }).then(data => { if (!abort.signal.aborted) { setResponse(data); setError(''); setUncertain(false) } }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [path, enabled, creating, refresh])
  useEffect(() => {
    if (!enabled || busy || error || value?.state !== 'queued') return
    const timer = setTimeout(() => { if (document.visibilityState === 'visible') setRefresh(old => old + 1) }, 3000)
    const visible = () => { if (document.visibilityState === 'visible') setRefresh(old => old + 1) }
    document.addEventListener('visibilitychange', visible)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [response, enabled, busy, error])
  async function readLatest() {
    if (pending.current || !enabled) return
    pending.current = true; setBusy(true)
    try { const data = await request<WorkAutomationEventResponse>(path); if (alive.current) adopt(data) }
    catch (cause) { if (alive.current) { if (creating && cause instanceof ApiError && cause.status === 404) setUncertain(false); setError(messageOf(cause)) } }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function publish(event: FormEvent) {
    event.preventDefault()
    if (!editable || pending.current || uncertain) return
    if (draft.type.startsWith('work.')) { setError(t('work.* 仅用于真实事项活动，请使用自定义类型。', 'work.* is reserved for actual item activity. Use a custom event type.')); return }
    const body = publication.current || { id: selection.id, ...draft, type: draft.type.trim(), summary: draft.summary.trim(), url: draft.url.trim(), sourceItemId: sourceItem?.id || null }
    publication.current = body; pending.current = true; setBusy(true); setError('')
    try { const data = await request<WorkAutomationEventResponse>(`${workPath(spaceId)}/automation/events`, { method: 'POST', body }); if (alive.current) adopt(data) }
    catch (cause) { if (alive.current) { setError(messageOf(cause)); if (!(cause instanceof ApiError) || cause.status >= 500 || (cause instanceof ApiError && cause.code === 'work_automation_event_id_conflict')) setUncertain(true); else publication.current = null } }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function prepareRetry(receipt: WorkAutomationReceipt) {
    if (!editable || pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { const rule = await request<WorkAutomationRuleResponse>(`${workPath(spaceId)}/automation/rules/${receipt.ruleId}`); if (alive.current) setRetry({ receipt, rule }) }
    catch (cause) { if (alive.current) setError(messageOf(cause)) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function retryEvent() {
    if (!value || !editable || pending.current || uncertain) return
    pending.current = true; setBusy(true); setError('')
    try {
      const data = await request<WorkAutomationEventResponse>(`${path}/retry`, { method: 'POST', body: { expectedRevision: value.revision, ...(retry ? { ruleId: retry.rule.rule.id, expectedRuleRevision: retry.rule.rule.revision } : {}) } })
      if (alive.current) adopt(data)
    } catch (cause) { if (alive.current) { setError(messageOf(cause)); if (!(cause instanceof ApiError) || cause.status >= 500 || cause.status === 409) setUncertain(true) } }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  const close = () => guard.requestLeave(onClose)
  return <><WorkToolDetail title={creating ? t('发布事件', 'Publish event') : t('事件回执', 'Event receipt')} busy={busy} onClose={close}><header className="work-detail-heading"><h2>{creating ? t('发布事件', 'Publish event') : t('事件回执', 'Event receipt')}</h2><Button type="button" size="icon" variant="ghost" disabled={busy} aria-label={t('关闭事件', 'Close event')} onClick={close}><X size={18}/></Button></header>{loading ? <Loading/> : <form className="work-detail-form" onSubmit={event => { if (creating) void publish(event); else event.preventDefault() }} onInvalidCapture={event => handleFormInvalid(event, setError)}><div className="work-detail-body"><ErrorMessage error={error}/>{uncertain && <Button type="button" variant="outline" size="sm" disabled={busy || !enabled} onClick={() => void readLatest()}>{t('读取当前事件', 'Read current event')}</Button>}{creating ? <fieldset className="admin-plain-fieldset" disabled={!editable || busy || uncertain || !!publication.current}><Field label={t('自定义事件类型', 'Custom event type')}><Input data-event-type required pattern="[a-z][a-z0-9_.\-]{0,79}" maxLength={80} placeholder="sync.requested" value={draft.type} onChange={event => setDraft(current => ({ ...current, type: event.target.value }))}/></Field><Field label={t('摘要', 'Summary')}><Input data-event-summary required maxLength={160} value={draft.summary} onChange={event => setDraft(current => ({ ...current, summary: event.target.value }))}/></Field><Field label={t('详情', 'Details')}><Textarea rows={4} maxLength={4000} value={draft.details} onChange={event => setDraft(current => ({ ...current, details: event.target.value }))}/></Field><Field label={t('链接', 'Link')}><Input type="url" maxLength={1000} value={draft.url} onChange={event => setDraft(current => ({ ...current, url: event.target.value }))}/></Field><div className="work-fields-row"><Field label={t('事件项目', 'Event project')}><select className="work-native-select" value={draft.projectId || ''} onChange={event => setDraft(current => ({ ...current, projectId: event.target.value || null }))}><option value="">{t('不指定', 'Not specified')}</option>{projects.filter(row => !row.archived).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field><Field label={t('事件状态', 'Event status')}><select className="work-native-select" value={draft.statusId} onChange={event => setDraft(current => ({ ...current, statusId: event.target.value }))}><option value="">{t('不指定', 'Not specified')}</option>{statuses.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field></div><Field label={t('来源事项', 'Source item')}><WorkItemSelector spaceId={spaceId} value={sourceItem} enabled={enabled} disabled={busy || !editable} onChange={setSourceItem}/></Field></fieldset> : value && <>
      <div className="work-execution-summary"><span className={`work-run-state is-${value.state}`}>{automationEventStateLabel(value.state)}</span><small>{value.origin === 'work' ? t('事项活动', 'Item activity') : t('外部事件', 'External event')}</small></div><h3 className="work-event-summary">{value.payload.summary}</h3><dl className="work-execution-facts"><dt>{t('事件类型', 'Event type')}</dt><dd>{workEventTypeLabel(value.eventType)}</dd><dt>{t('发生时间', 'Created')}</dt><dd>{formatUpdated(value.createdAt)}</dd>{value.processedAt && <><dt>{t('处理时间', 'Processed')}</dt><dd>{formatUpdated(value.processedAt)}</dd></>}{value.projectId && <><dt>{t('项目', 'Project')}</dt><dd>{projects.find(row => row.id === value.projectId)?.name || value.projectId}</dd></>}{value.statusId && <><dt>{t('状态', 'Status')}</dt><dd>{statuses.find(row => row.id === value.statusId)?.name || value.statusId}</dd></>}</dl>{value.payload.details && <pre className="work-event-details">{value.payload.details}</pre>}{value.payload.url && <a href={value.payload.url} target="_blank" rel="noopener noreferrer" className="work-event-link">{t('打开事件链接', 'Open event link')}<ArrowUpRight size={13}/></a>}{value.sourceItemId && <Button type="button" variant="outline" size="sm" onClick={() => onOpenItem(value.sourceItemId!)}>{t('打开来源事项', 'Open source item')}</Button>}{value.message && <p className="work-execution-message">{value.message}</p>}{value.code && <small className="work-result-code">{value.code}</small>}
      <section className="work-event-receipts"><h3>{t('规则回执', 'Rule receipts')}</h3>{response?.receipts.map(receipt => <article key={receipt.ruleId} data-receipt-rule={receipt.ruleId}><header><button type="button" onClick={() => onOpenRule(receipt.ruleId)}>{t('查看规则', 'Open rule')}<ArrowUpRight size={12}/></button><span className={`work-run-state is-${receipt.result}`}>{receiptLabel(receipt.result)}</span></header>{receipt.message && <p>{receipt.message}</p>}{receipt.code && <small>{receipt.code}</small>}<div>{receipt.itemId && <Button type="button" size="sm" variant="outline" onClick={() => onOpenItem(receipt.itemId!)}>{t('打开生成事项', 'Open created item')}</Button>}{receipt.executionId && <Button type="button" size="sm" variant="outline" onClick={() => onOpenExecution(receipt.executionId!)}>{t('查看执行', 'Open execution')}</Button>}{receipt.result === 'failed' && <Button type="button" size="sm" variant="outline" disabled={!editable || busy || uncertain} onClick={() => void prepareRetry(receipt)}>{t('重试此规则', 'Retry this rule')}</Button>}</div></article>)}{response?.receipts.length === 0 && <p className="work-inline-note">{t('暂无规则回执', 'No rule receipts')}</p>}</section>
      {retry && <section className="work-retry-confirm"><h3>{t('按当前规则重试', 'Retry with the current rule')}</h3><p>{retry.rule.rule.name}</p><p>{retry.rule.rule.template.title}</p>{(!retry.rule.rule.enabled || retry.rule.rule.archived) && <ErrorMessage error={t('先恢复并启用此规则。', 'Restore and enable this rule first.')}/>}<div><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setRetry(null)}>{t('取消', 'Cancel')}</Button><Button type="button" size="sm" disabled={busy || uncertain || !editable || !retry.rule.rule.enabled || retry.rule.rule.archived || (!!retry.rule.rule.executorId && !response?.canExecute)} onClick={() => void retryEvent()}>{t('确认重试', 'Confirm retry')}</Button></div></section>}
    </>}</div><footer className="work-detail-footer"><span className="grow"/>{creating ? <Button type="submit" disabled={!editable || busy || uncertain || !draft.type.trim() || !draft.summary.trim()}><Send size={14}/>{t('发布事件', 'Publish event')}</Button> : <><Button type="button" size="sm" variant="outline" disabled={!enabled || busy} onClick={() => void readLatest()}><RefreshCw size={14}/>{t('刷新', 'Refresh')}</Button>{value?.state === 'failed' && response?.receipts.length === 0 && <Button type="button" size="sm" disabled={!editable || busy || uncertain} onClick={() => void retryEvent()}>{t('重试事件', 'Retry event')}</Button>}</>}</footer></form>}</WorkToolDetail>{guard.blocked && <DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard}/>}</>
}
