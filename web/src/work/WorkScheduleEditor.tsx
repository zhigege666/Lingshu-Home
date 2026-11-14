import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Archive, ArchiveRestore, ArrowUpRight, Pause, Play, RefreshCw, Save, X } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { requestNavigation } from '../core/navigation'
import { useUnsavedChanges } from '../core/useUnsavedChanges'
import { workPath, type WorkProject, type WorkReference, type WorkStatusDefinition } from '../core/work-types'
import { mergeScheduleDraft, normalizeSchedule, scheduleChanges, scheduleDraft, type WorkSchedule, type WorkScheduleDraft, type WorkScheduleOccurrence, type WorkScheduleOccurrences, type WorkSchedulePreview, type WorkScheduleResponse, type WorkScheduleRule, type WorkScheduleSelection } from '../core/work-schedule-types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { Checkbox } from '../components/ui/checkbox'
import { StyledSelect } from '../components/ui/select'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'
import { ErrorMessage, Field, Loading, handleFormInvalid } from '../components/Shared'
import DiscardChangesDialog from '../components/DiscardChangesDialog'
import WorkReferences from './WorkReferences'
import WorkPlanningFields from './WorkPlanningFields'
import { planningDraft, omitEmptyPlanning } from '../core/work-planning-types'
import { useWorkTheme } from './work-theme'
import { workToday } from './work-dates'
import { occurrenceLabel, scheduleRuleLabel, scheduleTime } from './work-schedule-presentation'

type Props = {
  spaceId: string; selection: WorkScheduleSelection; projects: WorkProject[]; statuses: WorkStatusDefinition[]; defaultStatus: string;
  enabled: boolean; canEdit: boolean; documentsEnabled: boolean; onClose: () => void;
  onSaved: (schedule: WorkSchedule, created: boolean, notify?: boolean) => void; onOpenItem: (id: string) => void; onGenerated: () => void; onNotice: (text: string) => void
}
function useWideSchedule() {
  const [wide, setWide] = useState(() => matchMedia('(min-width:2200px)').matches)
  useEffect(() => { const media = matchMedia('(min-width:2200px)'), change = () => setWide(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change) }, [])
  return wide
}
function scheduleMessage(cause: unknown): string {
  return cause instanceof ApiError && cause.code === 'module_disabled' ? t('模块已关闭，草稿保留。重新开启后继续。', 'The module is disabled. Your draft is retained; continue after enabling it.') : messageOf(cause)
}
export default function WorkScheduleEditor({ spaceId, selection, projects, statuses, defaultStatus, enabled, canEdit, documentsEnabled, onClose, onSaved, onOpenItem, onGenerated, onNotice }: Props) {
  const theme = useWorkTheme(), wide = useWideSchedule()
  const initial = useRef(scheduleDraft(undefined, selection.source, selection.projectId, selection.source && statuses.some(status => status.id === selection.source!.status && status.type !== 'done' && status.type !== 'canceled') ? selection.source.status : defaultStatus)), initialReferences = useRef(selection.source?.references || [])
  const [draft, setDraft] = useState<WorkScheduleDraft>(() => structuredClone(initial.current)), [baseline, setBaseline] = useState<WorkSchedule | null>(null), [remote, setRemote] = useState<WorkSchedule | null>(null)
  const [references, setReferences] = useState<WorkReference[]>(initialReferences.current), [picker, setPicker] = useState(false)
  const [loading, setLoading] = useState(!selection.create), [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [uncertain, setUncertain] = useState(false)
  const [tab, setTab] = useState<'settings' | 'history'>('settings'), [preview, setPreview] = useState<WorkSchedulePreview | null>(null), [previewError, setPreviewError] = useState(''), [previewBusy, setPreviewBusy] = useState(false)
  const [history, setHistory] = useState<WorkScheduleOccurrences | null>(null), [historyError, setHistoryError] = useState(''), [historyBusy, setHistoryBusy] = useState(false), [historyVersion, setHistoryVersion] = useState(0)
  const [generationDate, setGenerationDate] = useState(() => workToday()), [generationResult, setGenerationResult] = useState<{ occurrence: WorkScheduleOccurrence; replayed: boolean } | null>(null)
  const alive = useRef(true), running = useRef(false), historyRun = useRef(false), historyGeneration = useRef(0), historyPageAbort = useRef<AbortController | null>(null), returningTo = useRef<HTMLElement | null>(document.activeElement as HTMLElement)
  const path = `${workPath(spaceId)}/schedules/${encodeURIComponent(selection.id)}`, creating = !baseline && !!selection.create
  const baseDraft = baseline ? scheduleDraft(baseline) : initial.current
  const dirty = Object.keys(scheduleChanges(baseDraft, draft)).length > 0
  const guard = useUnsavedChanges(dirty, busy, () => { setDraft(structuredClone(baseDraft)); setReferences(baseline?.references || initialReferences.current); setPicker(false) })
  const editable = canEdit && enabled && !baseline?.archived
  const previewKey = JSON.stringify(draft.rule)
  useEffect(() => { alive.current = true; return () => { alive.current = false; historyPageAbort.current?.abort() } }, [])
  useEffect(() => {
    if (selection.create || baseline || !enabled) { if (!enabled) setLoading(false); return }
    const abort = new AbortController()
    setLoading(true)
    request<WorkScheduleResponse>(path, { signal: abort.signal }).then(value => {
      if (!abort.signal.aborted) { setBaseline(value.schedule); setDraft(scheduleDraft(value.schedule)); setReferences(value.schedule.references || []); setGenerationDate(workToday(value.schedule.rule.timezone)) }
    }).catch(cause => { if (!abort.signal.aborted) setError(scheduleMessage(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [path, enabled])
  useEffect(() => {
    if (wide && !loading) document.querySelector<HTMLInputElement>('[data-work-schedule-detail] [data-schedule-name]')?.focus({ preventScroll: true })
  }, [wide, loading])
  useEffect(() => {
    if (loading || !enabled || tab !== 'settings') return
    const rule = JSON.parse(previewKey) as WorkScheduleRule
    const abort = new AbortController()
    setPreviewBusy(true); setPreviewError('')
    const timer = window.setTimeout(() => {
      request<WorkSchedulePreview>(`${workPath(spaceId)}/schedules/preview`, { method: 'POST', body: { rule, limit: 5 }, signal: abort.signal }).then(value => {
        if (!abort.signal.aborted) setPreview(value)
      }).catch(cause => { if (!abort.signal.aborted) { setPreview(null); setPreviewError(scheduleMessage(cause)) } }).finally(() => { if (!abort.signal.aborted) setPreviewBusy(false) })
    }, 350)
    return () => { abort.abort(); window.clearTimeout(timer) }
  }, [previewKey, spaceId, loading, tab, enabled])
  useEffect(() => {
    if (!baseline || tab !== 'history' || !enabled) return
    const abort = new AbortController(), token = ++historyGeneration.current
    setHistoryBusy(true); setHistoryError(''); historyRun.current = true
    request<WorkScheduleOccurrences>(`${path}/occurrences?limit=30`, { signal: abort.signal }).then(value => {
      if (!abort.signal.aborted && token === historyGeneration.current) setHistory(value)
    }).catch(cause => { if (!abort.signal.aborted) setHistoryError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted && token === historyGeneration.current) { setHistoryBusy(false); historyRun.current = false } })
    return () => { abort.abort(); historyPageAbort.current?.abort(); historyGeneration.current++; historyRun.current = false }
  }, [path, tab, enabled, historyVersion, baseline?.id])
  function close() {
    guard.requestLeave(() => { onClose(); requestAnimationFrame(() => { (returningTo.current?.isConnected ? returningTo.current : document.querySelector<HTMLElement>('[data-work-new-schedule]'))?.focus({ preventScroll: true }) }) })
  }
  function adopt(schedule: WorkSchedule, notify = true) {
    if (!alive.current) return
    const wasCreating = creating
    setBaseline(schedule); setDraft(scheduleDraft(schedule)); setReferences(schedule.references || []); setConflict(false); setUncertain(false); setRemote(null); setError('')
    onSaved(schedule, wasCreating, notify)
  }
  async function readLatest() {
    if (running.current) return
    running.current = true; setBusy(true)
    try { const value = await request<WorkScheduleResponse>(path); if (alive.current) { setRemote(value.schedule); setConflict(true); setError(t('当前草稿已保留，请比较最新配置后选择。', 'Your draft is retained. Compare the latest settings before choosing.')) } }
    catch (cause) { if (alive.current) { if (cause instanceof ApiError && cause.status === 404 && creating) { setUncertain(false); setConflict(false); setError(t('尚未找到规则，可使用原标识重试创建。', 'The schedule was not found. You can retry creation with the same ID.')) } else setError(scheduleMessage(cause)) } }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  function wireChanges(changes: Record<string, unknown>): Record<string, unknown> {
    if (!changes.template) return changes
    const template = creating ? omitEmptyPlanning({ ...(changes.template as Record<string, unknown>) }) as Record<string, unknown> : { ...(changes.template as Record<string, unknown>) }
    // A replacement template need not rewrite references the user did not edit.
    if (!creating) for (const key of ['bookmarkIds', 'documentIds'] as const) {
      if (JSON.stringify(template[key]) === JSON.stringify([...baseDraft.template[key]].sort())) delete template[key]
    }
    if (!documentsEnabled) delete template.documentIds
    return { ...changes, template }
  }
  async function mutate(changes: Record<string, unknown>, expectedRevision?: string) {
    if (running.current || !canEdit || !enabled) return
    running.current = true; setBusy(true); setError(''); setGenerationResult(null)
    try {
      const value = await request<WorkScheduleResponse>(creating ? `${workPath(spaceId)}/schedules` : path, { method: creating ? 'POST' : 'PATCH', body: creating ? { id: selection.id, ...wireChanges(changes) } : { expectedRevision: expectedRevision || baseline?.revision, ...wireChanges(changes) } })
      adopt(value.schedule)
    } catch (cause) {
      if (!alive.current) return
      if (cause instanceof ApiError && cause.status === 409) { setConflict(true); setError(t('规则已被更新，草稿保留。请读取最新版本后比较。', 'This schedule changed. Your draft is retained. Read the latest version to compare.')) }
      else if (!(cause instanceof ApiError) || cause.status >= 500) { setUncertain(true); setError(t('保存结果尚未确认，草稿保留。请先读取最新版本。', 'The save result is unconfirmed. Your draft is retained. Read the latest version first.')) }
      else setError(scheduleMessage(cause))
    } finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function save(event?: FormEvent, latest?: WorkSchedule) {
    event?.preventDefault()
    if (!editable || (uncertain && !latest) || (conflict && !latest)) return
    const intended = latest ? mergeScheduleDraft(baseDraft, draft, scheduleDraft(latest)) : normalizeSchedule(draft)
    if (!intended.name || !intended.template.title) { setError(t('填写模板名称和事项标题。', 'Enter a schedule name and item title.')); return }
    if (!statuses.some(status => status.id === intended.template.status && status.type !== 'done' && status.type !== 'canceled')) { setError(t('请选择当前空间中的有效初始状态。', 'Choose an available initial status in this space.')); return }
    if (intended.rule.frequency === 'weekly' && !intended.rule.weekdays?.length) { setError(t('至少选择一个每周生成日。', 'Choose at least one day of the week.')); return }
    if (!documentsEnabled && (creating ? intended.template.documentIds.length > 0 : JSON.stringify(intended.template.documentIds) !== JSON.stringify(baseDraft.template.documentIds))) { setError(t('资料库已关闭，文档关联草稿保留。重新开启后再保存。', 'Library is disabled. Document-link changes are retained; enable it before saving.')); return }
    const changes = creating ? intended : scheduleChanges(latest ? scheduleDraft(latest) : baseDraft, intended)
    if (!creating && !Object.keys(changes).length) { if (latest) adopt(latest, false); return }
    await mutate(changes, latest?.revision)
  }
  function ruleChange(change: Partial<WorkScheduleRule>) { setDraft(value => ({ ...value, rule: { ...value.rule, ...change } })) }
  function changeFrequency(frequency: WorkScheduleRule['frequency']) {
    setDraft(value => {
      const rule = { ...value.rule, frequency }; delete rule.weekdays; delete rule.monthDay; delete rule.monthPolicy
      if (frequency === 'weekly') rule.weekdays = [1]
      if (frequency === 'monthly') { rule.monthDay = 1; rule.monthPolicy = 'skip' }
      return { ...value, rule }
    })
  }
  function toggleReference(reference: WorkReference) {
    const key = reference.kind === 'bookmark' ? 'bookmarkIds' : 'documentIds', present = draft.template[key].includes(reference.id)
    setDraft(value => ({ ...value, template: { ...value.template, [key]: present ? value.template[key].filter(id => id !== reference.id) : [...value.template[key], reference.id] } }))
    setReferences(value => present ? value.filter(item => item.kind !== reference.kind || item.id !== reference.id) : [...value, reference])
  }
  async function generate() {
    if (!baseline || running.current || !editable || !generationDate) return
    running.current = true; setBusy(true); setError(''); setGenerationResult(null)
    try {
      const result = await request<{ occurrence: WorkScheduleOccurrence; replayed: boolean }>(`${path}/generate`, { method: 'POST', body: { businessDate: generationDate, expectedRevision: baseline.revision } })
      if (!alive.current) return
      setGenerationResult(result); setHistoryVersion(value => value + 1); onGenerated()
      if (result.occurrence.result === 'created') onNotice(result.replayed ? t('本期事项已存在', 'This occurrence already exists') : t('本期事项已生成', 'Occurrence created'))
      else setError(result.occurrence.reason || occurrenceLabel(result.occurrence.result))
    } catch (cause) {
      if (!alive.current) return
      if (cause instanceof ApiError && cause.status === 409) { setConflict(true); setError(t('规则已更新。请读取最新配置后再生成。', 'The schedule changed. Read its latest settings before generating.')) }
      else setError(cause instanceof ApiError && cause.status < 500 ? scheduleMessage(cause) : t('生成结果未确认。请查看生成记录，重试时保留同一业务日期。', 'The generation result is unconfirmed. Check history and retain the same business date when retrying.'))
    } finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function moreHistory() {
    if (!history?.nextCursor || historyRun.current || !enabled) return
    const token = historyGeneration.current, abort = new AbortController()
    historyPageAbort.current = abort
    historyRun.current = true; setHistoryBusy(true); setHistoryError('')
    try { const value = await request<WorkScheduleOccurrences>(`${path}/occurrences?limit=30&cursor=${encodeURIComponent(history.nextCursor)}`, { signal: abort.signal }); if (alive.current && token === historyGeneration.current) setHistory(current => current && ({ ...value, items: [...current.items, ...value.items] })) }
    catch (cause) { if (alive.current && token === historyGeneration.current) setHistoryError(messageOf(cause)) }
    finally { if (alive.current && token === historyGeneration.current) { historyRun.current = false; setHistoryBusy(false) } }
  }
  const weekNames = [t('一', 'Mon'), t('二', 'Tue'), t('三', 'Wed'), t('四', 'Thu'), t('五', 'Fri'), t('六', 'Sat'), t('日', 'Sun')]
  const projectOptions = [{ value: '', label: t('未分组', 'No project') }, ...projects.filter(project => !project.archived || project.id === draft.template.projectId).map(project => ({ value: project.id, label: project.name + (project.archived ? t('（已归档）', ' (archived)') : '') }))]
  const dueMode = draft.rule.dueAfterMinutes !== undefined ? 'after' : draft.rule.dueTime ? 'time' : 'none'
  const terminal = new Set(['done', 'canceled'])
  function comparisonRows(value: WorkScheduleDraft): [string, string][] {
    return [[t('优先级', 'Priority'), value.template.priority || '—'], [t('负责人', 'Assignee'), value.template.assignee?.name || '—'], [t('标签', 'Labels'), (value.template.labelIds || []).join(', ') || '—'], [t('版本', 'Version'), value.template.versionId || '—'], [t('模板名称', 'Name'), value.name], [t('事项标题', 'Item title'), value.template.title], [t('项目', 'Project'), projects.find(project => project.id === value.template.projectId)?.name || t('未分组', 'No project')], [t('初始状态', 'Initial status'), statuses.find(status => status.id === value.template.status)?.name || value.template.status], [t('说明', 'Description'), value.template.description], [t('下一步', 'Next step'), value.template.nextStep], [t('关联书签', 'Bookmarks'), value.template.bookmarkIds.map(id => references.find(item => item.kind === 'bookmark' && item.id === id)?.title || remote?.references?.find(item => item.kind === 'bookmark' && item.id === id)?.title || id).join('、')], [t('关联文档', 'Documents'), value.template.documentIds.map(id => references.find(item => item.kind === 'document' && item.id === id)?.title || remote?.references?.find(item => item.kind === 'document' && item.id === id)?.title || id).join('、')], [t('重复安排', 'Schedule'), scheduleRuleLabel(value.rule)], [t('时区', 'Timezone'), value.rule.timezone], [t('开始日期', 'Start date'), value.rule.startDate], [t('结束日期', 'End date'), value.rule.endDate || '—'], [t('截止时间', 'Due time'), value.rule.dueAfterMinutes ? t('生成后 {count} 分钟', '{count} minutes after creation', { count: value.rule.dueAfterMinutes }) : value.rule.dueTime ? `${value.rule.dueDayOffset || 0}d ${value.rule.dueTime}` : '—'], [t('缺失日期', 'Missing month day'), value.rule.frequency === 'monthly' ? value.rule.monthPolicy === 'last_day' ? t('使用最后一天', 'Use last day') : t('跳过', 'Skip') : '—'], [t('待我处理', 'Needs my attention'), value.template.needsAttention ? t('是', 'Yes') : t('否', 'No')], [t('启用', 'Enabled'), value.enabled ? t('是', 'Yes') : t('否', 'No')], [t('停机后', 'Missed occurrences'), ({ latest: t('只补最近一期', 'Latest only'), all: t('补最近 7 期', 'Up to 7 occurrences'), skip: t('跳过遗漏期次', 'Skip missed') })[value.missedPolicy]], [t('上期未完成', 'Previous incomplete'), value.overlapPolicy === 'create' ? t('照常生成', 'Create as scheduled') : t('跳过本期', 'Skip occurrence')]]
  }
  const latestComparison = remote ? comparisonRows(scheduleDraft(remote)) : []
  const comparison = remote ? comparisonRows(draft).map((entry, index) => ({ name: entry[0], mine: entry[1], latest: latestComparison[index][1] })).filter(row => row.mine !== row.latest) : []
  const content = <>
    <header className="work-detail-heading"><div><h2 id="work-schedule-editor-title">{creating ? t('新建定时事项', 'New recurring item') : t('定时事项详情', 'Recurring item')}</h2>{baseline?.archived && <span className="work-archived-label">{t('已归档', 'Archived')}</span>}</div><Button type="button" variant="ghost" size="icon" disabled={busy} onClick={close} aria-label={t('关闭定时事项', 'Close recurring item')}><X size={19}/></Button></header>
    {baseline && <div className="work-schedule-tabs" role="group" aria-label={t('定时事项详情视图', 'Recurring item detail view')}><button type="button" aria-pressed={tab === 'settings'} onClick={() => setTab('settings')}>{t('配置', 'Settings')}</button><button type="button" aria-pressed={tab === 'history'} onClick={() => setTab('history')}>{t('生成记录', 'Creation history')}</button></div>}
    {loading ? <Loading/> : !creating && !baseline ? <div className="work-detail-body"><ErrorMessage error={error}/></div> : <form className="work-detail-form" onSubmit={event => void save(event)} onInvalidCapture={event => handleFormInvalid(event, setError)} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault() }}>
      <div className="work-detail-body">
        {!enabled && <ErrorMessage error={t('事项模块已关闭，当前草稿保留。', 'Work is disabled. Your current draft is retained.')}/>}<ErrorMessage error={error}/>
        {(conflict || uncertain) && <section className="work-conflict"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void readLatest()}>{t('读取最新版本', 'Read latest version')}</Button>{remote && <><dl>{comparison.map(row => <div key={row.name}><dt>{row.name}</dt><dd><span>{t('最新', 'Latest')}</span><pre>{row.latest || '—'}</pre></dd><dd><span>{t('草稿', 'Draft')}</span><pre>{row.mine || '—'}</pre></dd></div>)}</dl>{remote.archived && <p>{t('该规则已归档。', 'This schedule is archived.')}</p>}<div className="work-conflict-actions"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => adopt(remote, false)}>{t('使用最新版本', 'Use latest version')}</Button>{baseline && !remote.archived && <Button type="button" size="sm" disabled={busy || !canEdit || !enabled} onClick={() => void save(undefined, remote)}>{t('保存草稿中的改动', 'Save my draft changes')}</Button>}</div></>}</section>}
        {tab === 'settings' ? <>
          <fieldset disabled={busy || !editable} className="admin-plain-fieldset">
            <Field label={t('模板名称', 'Schedule name')}><Input required maxLength={160} data-schedule-name autoFocus={creating} value={draft.name} onChange={event => setDraft(value => ({ ...value, name: event.target.value, template: { ...value.template, title: creating && (!value.template.title || value.template.title === value.name) ? event.target.value : value.template.title } }))}/></Field>
            <Field label={t('事项标题', 'Item title')}><Input required maxLength={160} data-schedule-item-title value={draft.template.title} onChange={event => setDraft(value => ({ ...value, template: { ...value.template, title: event.target.value } }))}/></Field>
            <div className="work-fields-row"><Field label={t('项目', 'Project')}><StyledSelect tone="home" theme={theme} value={draft.template.projectId || ''} options={projectOptions} disabled={busy || !editable} onValueChange={value => setDraft(current => ({ ...current, template: { ...current.template, projectId: value || null } }))}/></Field><Field label={t('初始状态', 'Initial status')}><StyledSelect tone="home" theme={theme} value={draft.template.status} options={[...statuses.filter(status => !terminal.has(status.type)).map(status => ({ value: status.id, label: status.name })), ...(!statuses.some(status => status.id === draft.template.status && !terminal.has(status.type)) ? [{ value: draft.template.status, label: t('状态不可用，请重选', 'Unavailable; choose another'), disabled: true }] : [])]} disabled={busy || !editable} onValueChange={value => setDraft(current => ({ ...current, template: { ...current.template, status: value } }))}/></Field></div>
            <div className="work-fields-row"><Field label={t('重复周期', 'Repeat')}><StyledSelect tone="home" theme={theme} value={draft.rule.frequency} options={[{ value: 'daily', label: t('每天', 'Every day') }, { value: 'weekdays', label: t('周一至周五', 'Monday to Friday') }, { value: 'weekly', label: t('每周', 'Every week') }, { value: 'monthly', label: t('每月', 'Every month') }]} disabled={busy || !editable} onValueChange={value => changeFrequency(value as WorkScheduleRule['frequency'])}/></Field><Field label={t('生成时间', 'Creation time')}><Input required type="time" data-schedule-time value={draft.rule.time} onChange={event => ruleChange({ time: event.target.value })}/></Field></div>
            {draft.rule.frequency === 'weekly' && <div className="work-schedule-weekdays" role="group" aria-label={t('每周生成日', 'Days of the week')}>{weekNames.map((name, index) => <button type="button" key={index} aria-pressed={draft.rule.weekdays?.includes(index + 1) || false} onClick={() => ruleChange({ weekdays: draft.rule.weekdays?.includes(index + 1) ? draft.rule.weekdays.filter(day => day !== index + 1) : [...(draft.rule.weekdays || []), index + 1] })}>{name}</button>)}</div>}
            {draft.rule.frequency === 'monthly' && <div className="work-fields-row"><Field label={t('每月几日', 'Day of month')}><Input type="number" min={1} max={31} required value={draft.rule.monthDay ?? 1} onChange={event => ruleChange({ monthDay: Number(event.target.value) })}/></Field><Field label={t('当月没有此日', 'When day is missing')}><StyledSelect tone="home" theme={theme} value={draft.rule.monthPolicy || 'skip'} disabled={busy || !editable} options={[{ value: 'skip', label: t('跳过本月', 'Skip this month') }, { value: 'last_day', label: t('使用当月最后一天', 'Use last day of month') }]} onValueChange={value => ruleChange({ monthPolicy: value as 'skip' | 'last_day' })}/></Field></div>}
            <div className="work-fields-row"><Field label={t('开始日期', 'Start date')}><Input type="date" required value={draft.rule.startDate} onChange={event => ruleChange({ startDate: event.target.value })}/></Field><Field label={t('结束日期', 'End date')}><Input type="date" min={draft.rule.startDate} value={draft.rule.endDate || ''} onChange={event => ruleChange({ endDate: event.target.value })}/></Field></div>
            <Field label={t('时区', 'Timezone')}><Input required value={draft.rule.timezone} list="work-schedule-timezones" onChange={event => ruleChange({ timezone: event.target.value })}/><datalist id="work-schedule-timezones">{['Asia/Shanghai', 'UTC', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'America/Los_Angeles'].map(zone => <option key={zone} value={zone}/>)}</datalist></Field>
            <Field label={t('完成期限', 'Due time')}><StyledSelect tone="home" theme={theme} value={dueMode} disabled={busy || !editable} options={[{ value: 'none', label: t('不设置', 'No due time') }, { value: 'time', label: t('指定时刻', 'At a specific time') }, { value: 'after', label: t('生成后', 'After creation') }]} onValueChange={value => { const rule = { ...draft.rule }; delete rule.dueAfterMinutes; delete rule.dueTime; delete rule.dueDayOffset; if (value === 'after') rule.dueAfterMinutes = 120; if (value === 'time') { rule.dueTime = '18:00'; rule.dueDayOffset = 0 } setDraft(current => ({ ...current, rule })) }}/></Field>
            {dueMode === 'time' && <div className="work-fields-row"><Field label={t('截止日期', 'Due day')}><StyledSelect tone="home" theme={theme} value={String(draft.rule.dueDayOffset || 0)} disabled={busy || !editable} options={Array.from({ length: 8 }, (_, day) => ({ value: String(day), label: day === 0 ? t('当天', 'Same day') : t('{count} 天后', '{count} days later', { count: day }) }))} onValueChange={value => ruleChange({ dueDayOffset: Number(value) })}/></Field><Field label={t('截止时刻', 'Due at')}><Input type="time" required value={draft.rule.dueTime || ''} onChange={event => ruleChange({ dueTime: event.target.value })}/></Field></div>}
            {dueMode === 'after' && <Field label={t('多少分钟后截止', 'Minutes until due')}><Input type="number" min={1} max={10080} required value={draft.rule.dueAfterMinutes ?? 120} onChange={event => ruleChange({ dueAfterMinutes: Number(event.target.value) })}/></Field>}
            <details className="work-schedule-advanced"><summary>{t('更多规则', 'More rules')}</summary><div><Field label={t('上期未完成', 'Previous occurrence incomplete')}><StyledSelect tone="home" theme={theme} value={draft.overlapPolicy} disabled={busy || !editable} options={[{ value: 'create', label: t('照常生成', 'Create as scheduled') }, { value: 'skip', label: t('跳过本期并记录原因', 'Skip and record the reason') }]} onValueChange={value => setDraft(current => ({ ...current, overlapPolicy: value as 'create' | 'skip' }))}/></Field><Field label={t('服务停机后', 'After downtime')}><StyledSelect tone="home" theme={theme} value={draft.missedPolicy} disabled={busy || !editable} options={[{ value: 'latest', label: t('只补最近一期', 'Create the latest occurrence') }, { value: 'all', label: t('补最近 7 期', 'Create up to 7 missed occurrences') }, { value: 'skip', label: t('跳过遗漏期次', 'Skip missed occurrences') }]} onValueChange={value => setDraft(current => ({ ...current, missedPolicy: value as WorkScheduleDraft['missedPolicy'] }))}/></Field><label className="work-attention-check"><Checkbox checked={draft.template.needsAttention} disabled={busy || !editable} onCheckedChange={value => setDraft(current => ({ ...current, template: { ...current.template, needsAttention: !!value } }))}/>{t('生成后标为待我处理', 'Mark new items as needing my attention')}</label></div></details>
            <WorkPlanningFields spaceId={spaceId} projectId={draft.template.projectId} value={planningDraft(draft.template)} enabled={enabled} disabled={busy || !editable} onChange={patch => setDraft(current => ({ ...current, template: { ...current.template, ...patch } }))}/>
            <Field label={t('下一步', 'Next step')}><Textarea rows={2} maxLength={1000} value={draft.template.nextStep} onChange={event => setDraft(current => ({ ...current, template: { ...current.template, nextStep: event.target.value } }))}/></Field>
            <Field label={t('说明与验收要求', 'Description and acceptance criteria')}><Textarea rows={3} maxLength={4000} value={draft.template.description} onChange={event => setDraft(current => ({ ...current, template: { ...current.template, description: event.target.value } }))}/></Field>
            {creating && <label className="work-schedule-enabled"><Checkbox checked={draft.enabled} disabled={busy || !editable} onCheckedChange={value => setDraft(current => ({ ...current, enabled: !!value }))}/>{t('保存后启用', 'Enable after saving')}</label>}
          </fieldset>
          <WorkReferences spaceId={spaceId} references={references} documentsEnabled={documentsEnabled} editable={editable} busy={busy} picker={picker} onPickerChange={setPicker} onToggle={toggleReference}/>
          <section className="work-schedule-preview" aria-label={t('未来生成预览', 'Upcoming occurrences')}><header><h3>{t('接下来 5 次', 'Next 5 occurrences')}</h3>{previewBusy && <span>{t('计算中…', 'Calculating…')}</span>}</header><ErrorMessage error={previewError}/>{preview && <ol>{preview.items.map(item => <li key={item.businessDate} data-business-date={item.businessDate}><div><time dateTime={item.scheduledAt}>{scheduleTime(item.scheduledAt, preview.timezone)}</time><strong>{draft.template.title}</strong></div>{item.dueAt && <small>{t('{date} 截止', 'Due {date}', { date: scheduleTime(item.dueAt, preview.timezone) })}</small>}</li>)}</ol>}{preview && !preview.items.length && <p>{t('此规则没有后续生成日期。', 'This schedule has no upcoming occurrences.')}</p>}</section>
          {baseline && <section className="work-schedule-manual"><h3>{t('生成指定期次', 'Generate an occurrence')}</h3><div><Input type="date" value={generationDate} disabled={busy || !editable} aria-label={t('生成业务日期', 'Occurrence business date')} onChange={event => setGenerationDate(event.target.value)}/><Button type="button" variant="outline" size="sm" disabled={busy || !editable || dirty || conflict || uncertain || !generationDate} onClick={() => void generate()}><Play size={14}/>{t('生成本期', 'Generate')}</Button></div>{generationResult && <p role="status">{occurrenceLabel(generationResult.occurrence.result)}{generationResult.replayed && <span>{t('（已有记录）', ' (existing record)')}</span>}{generationResult.occurrence.itemId && <button type="button" onClick={() => requestNavigation(() => onOpenItem(generationResult.occurrence.itemId!))}>{t('打开事项', 'Open item')}<ArrowUpRight size={13}/></button>}</p>}</section>}
        </> : <section className="work-schedule-history"><header><h3>{t('生成记录', 'Creation history')}</h3><Button type="button" variant="ghost" size="sm" disabled={historyBusy || !enabled} onClick={() => setHistoryVersion(value => value + 1)}><RefreshCw size={14}/>{t('重新读取', 'Reload')}</Button></header><ErrorMessage error={historyError}/>{historyBusy && !history ? <Loading/> : history && <><ol>{history.items.map((item, index) => <li key={`${item.businessDate}:${index}`}><div><strong>{item.businessDate}</strong><span className={item.result === 'failed' ? 'work-schedule-failed' : ''}>{occurrenceLabel(item.result)}</span></div>{item.reason && <p>{item.reason}</p>}<time dateTime={item.occurredAt}>{scheduleTime(item.occurredAt, baseline?.rule.timezone)}</time>{item.itemId && <Button type="button" variant="ghost" size="sm" onClick={() => requestNavigation(() => onOpenItem(item.itemId!))}>{t('打开事项', 'Open item')}<ArrowUpRight size={13}/></Button>}</li>)}</ol>{!history.items.length && <p>{t('尚无生成记录', 'No occurrences yet')}</p>}{history.nextCursor && <Button type="button" variant="outline" size="sm" disabled={historyBusy} onClick={() => void moreHistory()}>{historyBusy ? t('正在加载…', 'Loading…') : t('加载更多', 'Load more')}</Button>}</>}</section>}
      </div>
      <footer className="work-detail-footer">{baseline && canEdit && <><Button type="button" variant="ghost" size="sm" disabled={busy || !enabled || conflict || uncertain} onClick={() => guard.requestLeave(() => void mutate({ archived: !baseline.archived }))}>{baseline.archived ? <ArchiveRestore size={15}/> : <Archive size={15}/>}<span>{baseline.archived ? t('恢复', 'Restore') : t('归档', 'Archive')}</span></Button>{!baseline.archived && <Button type="button" variant="outline" size="sm" disabled={busy || !enabled || conflict || uncertain} onClick={() => guard.requestLeave(() => void mutate({ enabled: !baseline.enabled }))}>{baseline.enabled ? <Pause size={14}/> : <Play size={14}/>}<span>{baseline.enabled ? t('暂停', 'Pause') : t('启用', 'Enable')}</span></Button>}</>}<span className="grow"/><Button type="button" variant="outline" size="sm" disabled={busy} onClick={close}>{t('关闭', 'Close')}</Button>{editable && <Button type="submit" size="sm" disabled={busy || !draft.name.trim() || !draft.template.title.trim() || (!creating && !dirty) || conflict || uncertain}><Save size={14}/>{busy ? t('正在保存…', 'Saving…') : creating ? t('创建规则', 'Create schedule') : t('保存规则', 'Save schedule')}</Button>}</footer>
    </form>}
  </>
  return <>{wide ? <aside className="work-detail work-schedule-detail" aria-labelledby="work-schedule-editor-title" data-work-schedule-detail={selection.id}>{content}</aside> : <Dialog open onOpenChange={value => { if (!value && !busy) close() }}><DialogContent className={`admin-ui work-theme work-theme-${theme} work-drawer work-schedule-drawer`} data-theme={theme} showCloseButton={false} aria-describedby={undefined} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onPointerDownOutside={event => { if (busy) event.preventDefault() }}><DialogTitle className="sr-only">{creating ? t('新建定时事项', 'New recurring item') : t('定时事项详情', 'Recurring item')}</DialogTitle><div className="work-detail work-schedule-detail" data-work-schedule-detail={selection.id}>{content}</div></DialogContent></Dialog>}{guard.blocked && <DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard}/>}</>
}
