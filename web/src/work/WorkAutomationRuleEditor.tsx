import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Archive, ArchiveRestore, Save, X } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { useUnsavedChanges } from '../core/useUnsavedChanges'
import { workDraft, workPath, type WorkProject, type WorkReference, type WorkStatusDefinition } from '../core/work-types'
import { normalizePlanning, omitEmptyPlanning, planningDraft } from '../core/work-planning-types'
import type { WorkScheduleTemplate } from '../core/work-schedule-types'
import type { WorkAutomationRule, WorkAutomationRuleResponse } from '../core/work-automation-types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { ErrorMessage, Field, Loading, handleFormInvalid } from '../components/Shared'
import DiscardChangesDialog from '../components/DiscardChangesDialog'
import WorkReferences from './WorkReferences'
import WorkPlanningFields from './WorkPlanningFields'
import WorkToolDetail from './WorkToolDetail'
import { WorkExecutorPicker } from './WorkExecutionControls'

type Draft = Pick<WorkAutomationRule, 'name' | 'eventType' | 'projectId' | 'statusId' | 'template' | 'executorId' | 'enabled'>
const normalized = (value: Draft): Draft => ({ name: value.name.trim(), eventType: value.eventType.trim(), projectId: value.projectId, statusId: value.statusId, executorId: value.executorId, enabled: value.enabled, template: { ...value.template, ...normalizePlanning(planningDraft(value.template)), title: value.template.title.trim(), bookmarkIds: [...new Set(value.template.bookmarkIds)].sort(), documentIds: [...new Set(value.template.documentIds)].sort() } })
function changes(before: Draft, after: Draft): Record<string, unknown> {
  const old = normalized(before), next = normalized(after), patch: Record<string, unknown> = {}
  for (const key of Object.keys(next) as (keyof Draft)[]) {
    if (key === 'template') { const template = Object.fromEntries(Object.entries(next.template).filter(([key, value]) => JSON.stringify(old.template[key as keyof WorkScheduleTemplate]) !== JSON.stringify(value))); if (Object.keys(template).length) patch.template = template }
    else if (JSON.stringify(old[key]) !== JSON.stringify(next[key])) patch[key] = next[key]
  }
  return patch
}
import { workEventTypeLabel } from './work-automation-presentation'

export default function WorkAutomationRuleEditor({ spaceId, selection, enabled, canEdit, canExecute, documentsEnabled, projects, statuses, defaultStatus, onClose, onSaved }: { spaceId: string; selection: { id: string; create?: boolean }; enabled: boolean; canEdit: boolean; canExecute: boolean; documentsEnabled: boolean; projects: WorkProject[]; statuses: WorkStatusDefinition[]; defaultStatus: string; onClose: () => void; onSaved: (value: WorkAutomationRule) => void }) {
  const seed = (): Draft => { const work = workDraft({ status: defaultStatus }); const { title, projectId, status, description, nextStep, needsAttention, bookmarkIds, documentIds } = work; return { name: '', eventType: 'work.created', projectId: null, statusId: '', executorId: null, enabled: false, template: { ...planningDraft(), title, projectId, status, description, nextStep, needsAttention, bookmarkIds, documentIds } } }
  const initial = useRef(seed()), [draft, setDraft] = useState<Draft>(initial.current), [response, setResponse] = useState<WorkAutomationRuleResponse | null>(null), [creating, setCreating] = useState(!!selection.create)
  const [references, setReferences] = useState<WorkReference[]>([]), [picker, setPicker] = useState(false), [loading, setLoading] = useState(!selection.create), [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false), [latest, setLatest] = useState<WorkAutomationRuleResponse | null>(null)
  const alive = useRef(true), loaded = useRef(false), pending = useRef(false), intendedMutation = useRef<Record<string, unknown> | null>(null)
  const base = response?.rule, dirty = Object.keys(changes(base || initial.current, draft)).length > 0
  const editable = enabled && (response?.canEdit ?? canEdit) && (!base?.executorId || (response?.canExecute ?? canExecute))
  const executeAllowed = response?.canExecute ?? canExecute, guard = useUnsavedChanges(dirty, busy), path = `${workPath(spaceId)}/automation/rules/${selection.id}`
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  function adopt(data: WorkAutomationRuleResponse) { loaded.current = true; setResponse(data); setDraft(normalized(data.rule)); setReferences(data.rule.references); setCreating(false); setError(''); setUncertain(false); setLatest(null); intendedMutation.current = null }
  useEffect(() => {
    if (!enabled || selection.create || loaded.current) return
    const abort = new AbortController(); setLoading(true)
    request<WorkAutomationRuleResponse>(path, { signal: abort.signal }).then(data => { if (!abort.signal.aborted) adopt(data) }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [path, enabled])
  async function readLatest() {
    if (pending.current) return
    pending.current = true; setBusy(true)
    try {
      const data = await request<WorkAutomationRuleResponse>(path)
      if (!alive.current) return
      const intended = intendedMutation.current
      const matches = intended && Object.entries(intended).every(([key, value]) => key === 'template' ? Object.entries(value as Record<string, unknown>).every(([field, intendedValue]) => JSON.stringify(normalized(data.rule).template[field as keyof WorkScheduleTemplate]) === JSON.stringify(intendedValue)) : JSON.stringify(data.rule[key as keyof WorkAutomationRule]) === JSON.stringify(value))
      if (uncertain && matches) { adopt(data); onSaved(data.rule) }
      else { setLatest(data); setError(t('规则已有更新，草稿保留。', 'The rule changed; your draft is retained.')) }
    } catch (cause) { if (alive.current) { if (creating && cause instanceof ApiError && cause.status === 404) setUncertain(false); setError(messageOf(cause)) } }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function mutate(patch: Record<string, unknown>) {
    if (!editable || pending.current || uncertain || latest) return
    pending.current = true; setBusy(true); setError(''); intendedMutation.current = structuredClone(patch)
    try {
      const value = await request<WorkAutomationRuleResponse>(creating ? `${workPath(spaceId)}/automation/rules` : path, { method: creating ? 'POST' : 'PATCH', body: creating ? { id: selection.id, ...patch } : { expectedRevision: base?.revision, ...patch } })
      if (alive.current) { adopt(value); onSaved(value.rule) }
    } catch (cause) { if (alive.current) { setError(messageOf(cause)); if (!(cause instanceof ApiError) || cause.status >= 500 || cause.status === 409) setUncertain(true) } }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  function save(event: FormEvent) {
    event.preventDefault()
    const value = normalized(draft), patch: Record<string, unknown> = creating ? { ...value, template: omitEmptyPlanning(value.template) } : changes(base || initial.current, value)
    if (!documentsEnabled && (creating ? value.template.documentIds.length > 0 : JSON.stringify(value.template.documentIds) !== JSON.stringify(base?.template.documentIds))) { setError(t('资料库已关闭，文档关联草稿保留。重新开启后再保存。', 'Library is disabled. Document-link edits are retained; re-enable it before saving.')); return }
    if (!documentsEnabled && patch.template) delete (patch.template as Record<string, unknown>).documentIds
    void mutate(patch)
  }
  function toggleReference(value: WorkReference) {
    const key = value.kind === 'bookmark' ? 'bookmarkIds' : 'documentIds', exists = draft.template[key].includes(value.id)
    setDraft(current => ({ ...current, template: { ...current.template, [key]: exists ? current.template[key].filter(id => id !== value.id) : [...current.template[key], value.id] } })); setReferences(current => exists ? current.filter(row => row.kind !== value.kind || row.id !== value.id) : [...current, value])
  }
  function mergeLatest() {
    if (!latest) return
    const patch = changes(base || initial.current, draft), merged = normalized(latest.rule)
    for (const [key, value] of Object.entries(patch)) { if (key === 'template') merged.template = { ...merged.template, ...value as Partial<WorkScheduleTemplate> }; else Object.assign(merged, { [key]: value }) }
    setResponse(latest); setDraft(merged); setReferences(current => [...latest.rule.references, ...current.filter(row => !latest.rule.references.some(old => old.kind === row.kind && old.id === row.id))]); setLatest(null); setUncertain(false); setError('')
  }
  const close = () => guard.requestLeave(onClose)
  return <><WorkToolDetail title={creating ? t('新建事件规则', 'New event rule') : t('事件规则', 'Event rule')} busy={busy} onClose={close}><header className="work-detail-heading"><h2>{creating ? t('新建事件规则', 'New event rule') : t('事件规则', 'Event rule')}</h2><Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={t('关闭规则', 'Close rule')} onClick={close}><X size={18}/></Button></header>{loading ? <Loading/> : !creating && !base ? <div className="work-detail-body"><ErrorMessage error={error}/></div> : <form className="work-detail-form" onSubmit={save} onInvalidCapture={event => handleFormInvalid(event, setError)}><div className="work-detail-body"><ErrorMessage error={error}/>{(uncertain || latest) && <section className="work-conflict"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void readLatest()}>{t('读取最新规则', 'Read latest rule')}</Button>{latest && <><dl><dt>{t('最新名称', 'Latest name')}</dt><dd>{latest.rule.name}</dd><dt>{t('事件类型', 'Event type')}</dt><dd>{workEventTypeLabel(latest.rule.eventType)}</dd><dt>{t('事项标题', 'Item title')}</dt><dd>{latest.rule.template.title}</dd><dt>{t('启用', 'Enabled')}</dt><dd>{latest.rule.enabled ? t('是', 'Yes') : t('否', 'No')}</dd></dl><div className="work-conflict-actions"><Button type="button" variant="outline" size="sm" onClick={() => adopt(latest)}>{t('使用最新规则', 'Use latest rule')}</Button><Button type="button" size="sm" onClick={mergeLatest}>{t('保留我的改动', 'Keep my changes')}</Button></div></>}</section>}
    <fieldset className="admin-plain-fieldset" disabled={busy || !editable}><Field label={t('规则名称', 'Rule name')}><Input data-auto-rule-name required maxLength={160} autoFocus={creating} value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}/></Field><div className="work-auto-event-types">{['work.created', 'work.status_changed', 'work.completed'].map(type => <button type="button" key={type} aria-pressed={draft.eventType === type} onClick={() => setDraft(current => ({ ...current, eventType: type }))}>{workEventTypeLabel(type)}</button>)}</div><Field label={t('事件类型', 'Event type')}><Input data-auto-event-type required pattern="[a-z][a-z0-9_.\-]{0,79}" maxLength={80} value={draft.eventType} onChange={event => setDraft(current => ({ ...current, eventType: event.target.value }))}/></Field><div className="work-fields-row"><Field label={t('事件项目', 'Event project')}><select className="work-native-select" value={draft.projectId || ''} onChange={event => setDraft(current => ({ ...current, projectId: event.target.value || null }))}><option value="">{t('全部项目', 'All projects')}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field><Field label={t('事件状态', 'Event status')}><select className="work-native-select" value={draft.statusId} onChange={event => setDraft(current => ({ ...current, statusId: event.target.value }))}><option value="">{t('全部状态', 'All statuses')}</option>{statuses.map(status => <option key={status.id} value={status.id}>{status.name}</option>)}</select></Field></div><label className="work-feature-switch"><input data-auto-rule-enabled type="checkbox" checked={draft.enabled} onChange={event => setDraft(current => ({ ...current, enabled: event.target.checked }))}/>{t('启用规则', 'Enable rule')}</label>
      <h3 className="work-auto-template-heading">{t('生成事项', 'Created item')}</h3><Field label={t('事项标题', 'Item title')}><Input data-auto-template-title required maxLength={160} value={draft.template.title} onChange={event => setDraft(current => ({ ...current, template: { ...current.template, title: event.target.value } }))}/></Field><div className="work-fields-row"><Field label={t('项目', 'Project')}><select className="work-native-select" value={draft.template.projectId || ''} onChange={event => setDraft(current => ({ ...current, template: { ...current.template, projectId: event.target.value || null } }))}><option value="">{t('未分组', 'No project')}</option>{projects.filter(project => !project.archived || project.id === draft.template.projectId).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field><Field label={t('初始状态', 'Initial status')}><select className="work-native-select" value={draft.template.status} onChange={event => setDraft(current => ({ ...current, template: { ...current.template, status: event.target.value } }))}>{statuses.filter(status => status.type !== 'done' && status.type !== 'canceled').map(status => <option key={status.id} value={status.id}>{status.name}</option>)}{!statuses.some(status => status.id === draft.template.status && status.type !== 'done' && status.type !== 'canceled') && <option value={draft.template.status} disabled>{t('状态不可用，请重选', 'Status unavailable; choose another')}</option>}</select></Field></div><WorkPlanningFields spaceId={spaceId} projectId={draft.template.projectId} value={planningDraft(draft.template)} enabled={enabled} disabled={busy || !editable} onChange={patch => setDraft(current => ({ ...current, template: { ...current.template, ...patch } }))}/><Field label={t('下一步', 'Next step')}><Textarea rows={2} maxLength={1000} value={draft.template.nextStep} onChange={event => setDraft(current => ({ ...current, template: { ...current.template, nextStep: event.target.value } }))}/></Field><Field label={t('说明', 'Description')}><Textarea rows={4} maxLength={4000} value={draft.template.description} onChange={event => setDraft(current => ({ ...current, template: { ...current.template, description: event.target.value } }))}/></Field><label className="work-feature-switch"><input type="checkbox" checked={draft.template.needsAttention} onChange={event => setDraft(current => ({ ...current, template: { ...current.template, needsAttention: event.target.checked } }))}/>{t('待我处理', 'Needs my attention')}</label>
      <Field label={t('生成后执行', 'Execute after creation')}><WorkExecutorPicker spaceId={spaceId} executorId={draft.executorId} enabled={enabled} disabled={busy || !editable || !executeAllowed} onChange={executor => setDraft(current => ({ ...current, executorId: executor?.id || null }))}/></Field>
    </fieldset><WorkReferences spaceId={spaceId} references={references.filter(row => draft.template[row.kind === 'bookmark' ? 'bookmarkIds' : 'documentIds'].includes(row.id))} documentsEnabled={documentsEnabled} editable={editable} busy={busy} picker={picker} onPickerChange={setPicker} onToggle={toggleReference}/></div><footer className="work-detail-footer">{base && editable && <Button type="button" variant="ghost" size="sm" disabled={busy || uncertain || !!latest} onClick={() => guard.requestLeave(() => void mutate({ archived: !base.archived }))}>{base.archived ? <ArchiveRestore size={14}/> : <Archive size={14}/>}<span>{base.archived ? t('恢复', 'Restore') : t('归档', 'Archive')}</span></Button>}<span className="grow"/><Button type="button" variant="outline" size="sm" disabled={busy} onClick={close}>{t('关闭', 'Close')}</Button><Button type="submit" disabled={!editable || busy || !draft.name.trim() || !draft.template.title.trim() || (!creating && !dirty) || uncertain || !!latest}><Save size={14}/>{t('保存规则', 'Save rule')}</Button></footer></form>}</WorkToolDetail>{guard.blocked && <DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard}/>}</>
}
