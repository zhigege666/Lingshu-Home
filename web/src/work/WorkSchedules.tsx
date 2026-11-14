import { useEffect, useRef, useState } from 'react'
import { CalendarClock, Pause, Play, RefreshCw } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { requestNavigation } from '../core/navigation'
import { workPath, type WorkProject, type WorkStatusDefinition } from '../core/work-types'
import type { WorkSchedule, WorkScheduleResponse, WorkSchedulePage, WorkScheduleSelection } from '../core/work-schedule-types'
import { Button } from '../components/ui/button'
import { ErrorMessage, Loading } from '../components/Shared'
import ScheduleEditor from './WorkScheduleEditor'
import { scheduleTime, scheduleRuleLabel, occurrenceLabel } from './work-schedule-presentation'
import './work-schedules.css'


type Props = {
  spaceId: string; projects: WorkProject[]; statuses: WorkStatusDefinition[]; defaultStatus: string;
  enabled: boolean; canEdit: boolean; documentsEnabled: boolean; search: string; archived: boolean;
  selection: WorkScheduleSelection | null; onSelect: (selection: WorkScheduleSelection | null) => void;
  onOpenItem: (id: string) => void; onNotice: (text: string) => void; refresh: number
}
export default function WorkSchedules(props: Props) {
  const { spaceId, enabled, search, archived, selection, onSelect, refresh } = props
  const [page, setPage] = useState<WorkSchedulePage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [version, setVersion] = useState(0), [paging, setPaging] = useState(false), [changing, setChanging] = useState('')
  const generation = useRef(0), pagingRef = useRef(false), pagingAbort = useRef<AbortController | null>(null), alive = useRef(true), changingRef = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false; pagingAbort.current?.abort() } }, [])
  const base = `${workPath(spaceId)}/schedules`
  const query = new URLSearchParams({ q: search, archived: String(archived), limit: '30' }).toString()
  useEffect(() => {
    const abort = new AbortController(), current = ++generation.current
    if (!enabled) { setLoading(false); return () => abort.abort() }
    setLoading(true); setError(''); setPaging(false); pagingRef.current = false
    request<WorkSchedulePage>(`${base}?${query}`, { signal: abort.signal }).then(value => {
      if (!abort.signal.aborted && current === generation.current) setPage(value)
    }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => { generation.current++; abort.abort(); pagingAbort.current?.abort() }
  }, [base, query, enabled, refresh, version])
  // Only a visible schedule page owns this timer. Paused/empty schedules add none.
  useEffect(() => {
    if (!enabled || selection || loading || document.visibilityState !== 'visible') return
    const future = (page?.items || []).filter(item => item.enabled && !item.archived && item.nextRunAt).map(item => Date.parse(item.nextRunAt)).filter(time => time > Date.now())
    if (!future.length) return
    const delay = Math.min(...future) - Date.now() + 500
    if (delay > 2147483647) return
    const timer = window.setTimeout(() => { if (document.visibilityState === 'visible') setVersion(value => value + 1) }, delay)
    return () => window.clearTimeout(timer)
  }, [enabled, page, selection, loading])
  useEffect(() => {
    if (!enabled) return
    const visible = () => { if (document.visibilityState === 'visible' && !selection) setVersion(value => value + 1) }
    document.addEventListener('visibilitychange', visible)
    return () => document.removeEventListener('visibilitychange', visible)
  }, [enabled, selection])
  async function more() {
    if (!page?.nextCursor || pagingRef.current || !enabled) return
    const token = generation.current, abort = new AbortController()
    pagingAbort.current = abort
    pagingRef.current = true; setPaging(true); setError('')
    try {
      const value = await request<WorkSchedulePage>(`${base}?${query}&cursor=${encodeURIComponent(page.nextCursor)}`, { signal: abort.signal })
      if (token === generation.current) setPage(current => current && ({ ...value, items: [...current.items, ...value.items] }))
    } catch (cause) { if (token === generation.current) setError(cause instanceof ApiError && cause.status === 409 ? t('规则已更新，请重新读取后继续。', 'Schedules changed. Reload before continuing.') : messageOf(cause)) }
    finally { if (token === generation.current) { pagingRef.current = false; setPaging(false) } }
  }
  async function toggle(item: WorkSchedule) {
    if (changingRef.current || !enabled || !page?.canEdit) return
    changingRef.current = true; setChanging(item.id); setError('')
    const token = generation.current
    try {
      const value = await request<WorkScheduleResponse>(`${base}/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { expectedRevision: item.revision, enabled: !item.enabled } })
      if (alive.current && token === generation.current) { setPage(current => current && ({ ...current, items: current.items.map(old => old.id === item.id ? value.schedule : old) })); if (selection?.id === item.id) onSelect(null); props.onNotice(value.schedule.enabled ? t('规则已启用', 'Schedule enabled') : t('规则已暂停', 'Schedule paused')) }
    } catch (cause) {
      if (alive.current && token === generation.current) setError(cause instanceof ApiError && cause.status < 500 ? cause.status === 409 ? t('规则已更新，请重新读取。', 'The schedule changed. Reload it first.') : messageOf(cause) : t('操作结果未确认，请重新读取规则后核对状态。', 'The result is unconfirmed. Reload and check the schedule state.'))
    } finally { changingRef.current = false; if (alive.current) setChanging('') }
  }
  return <div className={`work-schedule-shell ${selection ? 'has-selection' : ''}`}>
    <section className="work-schedule-list" aria-label={t('定时事项', 'Recurring items')}>
      <div className="work-schedule-list-heading"><span>{page ? t('{count} 条规则', '{count} schedules', { count: page.total }) : ''}</span><Button variant="ghost" size="sm" disabled={loading || !enabled} onClick={() => setVersion(value => value + 1)}><RefreshCw size={14}/>{t('重新读取', 'Reload')}</Button></div>
      <ErrorMessage error={error}/>
      {loading ? <Loading/> : page && <div className="work-schedule-table-scroll"><table className="work-schedule-table"><thead><tr><th>{t('名称', 'Name')}</th><th>{t('重复安排', 'Schedule')}</th><th>{t('下次生成', 'Next creation')}</th><th>{t('最近结果', 'Last result')}</th><th>{t('状态', 'State')}</th></tr></thead><tbody>
        {page.items.map(item => <tr key={item.id} data-work-schedule-id={item.id} className={selection?.id === item.id ? 'selected' : ''}><td><button type="button" className="work-schedule-name" onClick={() => requestNavigation(() => onSelect({ id: item.id }))}><CalendarClock size={16}/><span>{item.name}</span></button></td><td><span>{scheduleRuleLabel(item.rule)}</span><small>{item.rule.timezone}</small></td><td><time dateTime={item.nextRunAt || undefined}>{scheduleTime(item.nextRunAt, item.rule.timezone)}</time></td><td><span className={item.lastResult === 'failed' ? 'work-schedule-failed' : ''}>{occurrenceLabel(item.lastResult)}</span>{item.lastError && <small className="work-schedule-failed">{item.lastError}</small>}{item.lastRunAt && <small>{scheduleTime(item.lastRunAt, item.rule.timezone)}</small>}</td><td>{item.archived ? t('已归档', 'Archived') : <button type="button" className="work-schedule-state" aria-label={item.enabled ? t('暂停：{name}', 'Pause: {name}', { name: item.name }) : t('启用：{name}', 'Enable: {name}', { name: item.name })} disabled={!enabled || !props.canEdit || !page.canEdit || !!changing} onClick={() => requestNavigation(() => void toggle(item))}>{item.enabled ? <Pause size={12}/> : <Play size={12}/>}<span>{item.enabled ? t('已启用', 'Enabled') : t('已暂停', 'Paused')}</span></button>}</td></tr>)}
      </tbody></table>{!page.items.length && <div className="work-schedule-empty"><CalendarClock size={26}/><span>{search ? t('没有匹配的规则', 'No matching schedules') : archived ? t('没有已归档的规则', 'No archived schedules') : t('尚未创建定时事项', 'No recurring items yet')}</span></div>}{page.nextCursor && <button className="work-load-more" disabled={paging} onClick={() => void more()}>{paging ? t('正在加载…', 'Loading…') : t('加载更多', 'Load more')}</button>}</div>}
    </section>
    {selection && <ScheduleEditor key={`${spaceId}:${selection.id}`} {...props} canEdit={props.canEdit && (page?.canEdit ?? true)} selection={selection} onGenerated={() => setVersion(value => value + 1)} onClose={() => { onSelect(null); if (page?.items.some(item => item.enabled && item.nextRunAt && Date.parse(item.nextRunAt) <= Date.now())) setVersion(value => value + 1) }} onSaved={(schedule, created, notify = true) => { onSelect({ id: schedule.id }); setVersion(value => value + 1); if (notify) props.onNotice(created ? t('定时事项已创建', 'Recurring item created') : t('定时事项已保存', 'Recurring item saved')) }}/> }
  </div>
}
