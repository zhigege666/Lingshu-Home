import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, RefreshCw } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { getLocale, t } from '../core/i18n'
import { workPath, type WorkStatusDefinition } from '../core/work-types'
import { workFilterParams, type WorkCalendarBasis, type WorkCalendarPage, type WorkDisplayField, type WorkFilters } from '../core/work-planning-types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { ErrorMessage, Loading } from '../components/Shared'
import { workToday, workTimezone } from './work-dates'
import WorkPlanningSummary from './WorkPlanningSummary'
import './work-calendar.css'

const shiftDate = (value: string, days: number) => { const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10) }
function nextMonth(value: string, offset: number) { const [year, month] = value.split('-').map(Number); return new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 7) }

export default function WorkCalendar({ spaceId, enabled, filters, fields, basis, statuses, canCreate, refresh, onBasisChange, onOpenItem, onCreate }: { spaceId: string; enabled: boolean; filters: WorkFilters; fields: WorkDisplayField[]; basis: WorkCalendarBasis; statuses: WorkStatusDefinition[]; canCreate: boolean; refresh: number; onBasisChange: (value: WorkCalendarBasis) => void; onOpenItem: (id: string) => void; onCreate: (date: string) => void }) {
  const [month, setMonth] = useState(() => workToday().slice(0, 7)), [selectedDay, setSelectedDay] = useState(() => workToday()), [page, setPage] = useState<WorkCalendarPage | null>(null), [agenda, setAgenda] = useState<WorkCalendarPage | null>(null)
  const [loading, setLoading] = useState(false), [agendaLoading, setAgendaLoading] = useState(false), [moreBusy, setMoreBusy] = useState(false), [error, setError] = useState(''), [agendaError, setAgendaError] = useState(''), [reload, setReload] = useState(0)
  const generation = useRef(0), alive = useRef(true), pending = useRef(false), timezone = filters.timezone || workTimezone()
  const query = useMemo(() => workFilterParams(filters, fields).toString(), [JSON.stringify(filters), fields.join(',')])
  const start = `${month}-01`, end = `${nextMonth(month, 1)}-01`
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])
  function params(from: string, to: string, cursor?: string) { const value = new URLSearchParams(query); value.set('from', from); value.set('to', to); value.set('timezone', timezone); value.set('basis', basis); value.set('limit', '100'); if (cursor) value.set('cursor', cursor); return value }
  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController(); setLoading(true); setError(''); setPage(null)
    request<WorkCalendarPage>(`${workPath(spaceId)}/calendar?${params(start, end)}`, { signal: abort.signal }).then(value => { if (!abort.signal.aborted) setPage(value) }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [spaceId, enabled, start, end, query, basis, timezone, refresh, reload])
  useEffect(() => {
    const token = ++generation.current
    if (!enabled || !selectedDay) return
    const abort = new AbortController(); setAgendaLoading(true); setAgendaError(''); setAgenda(null)
    request<WorkCalendarPage>(`${workPath(spaceId)}/calendar?${params(selectedDay, shiftDate(selectedDay, 1))}`, { signal: abort.signal }).then(value => { if (!abort.signal.aborted && token === generation.current) setAgenda(value) }).catch(cause => { if (!abort.signal.aborted) setAgendaError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setAgendaLoading(false) })
    return () => abort.abort()
  }, [spaceId, enabled, selectedDay, query, basis, timezone, refresh, reload])
  async function more() {
    if (!agenda?.nextCursor || pending.current) return
    pending.current = true; setMoreBusy(true); const token = generation.current
    try { const value = await request<WorkCalendarPage>(`${workPath(spaceId)}/calendar?${params(selectedDay, shiftDate(selectedDay, 1), agenda.nextCursor)}`); if (alive.current && token === generation.current) setAgenda(old => old ? { ...value, items: [...old.items, ...value.items.filter(row => !old.items.some(item => item.id === row.id))] } : value) }
    catch (cause) { if (alive.current && token === generation.current) setAgendaError(cause instanceof ApiError && cause.status === 409 ? t('日历已更新，请重新读取该日期。', 'The calendar changed; reload this date.') : messageOf(cause)) }
    finally { pending.current = false; if (alive.current) setMoreBusy(false) }
  }
  function chooseMonth(value: string) { if (!/^\d{4}-\d{2}$/.test(value)) return; setMonth(value); setSelectedDay(`${value}-01`) }
  function today() { try { const value = workToday(timezone); setMonth(value.slice(0, 7)); setSelectedDay(value) } catch { setError(t('时区无效，请在筛选中修改。', 'The timezone is invalid. Change it in filters.')) } }
  const leading = (new Date(`${start}T12:00:00Z`).getUTCDay() + 6) % 7, count = Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86400000)
  const monthLabel = new Intl.DateTimeFormat(getLocale(), { timeZone: 'UTC', year: 'numeric', month: 'long' }).format(new Date(`${start}T12:00:00Z`))
  return <section className="work-calendar" aria-label={t('事项日历', 'Work calendar')}><header><div className="work-calendar-month"><Button type="button" variant="ghost" size="icon-sm" aria-label={t('上个月', 'Previous month')} onClick={() => chooseMonth(nextMonth(month, -1))}><ChevronLeft size={17}/></Button><label><strong>{monthLabel}</strong><Input type="month" aria-label={t('选择月份', 'Choose month')} value={month} onChange={event => chooseMonth(event.target.value)}/></label><Button type="button" variant="ghost" size="icon-sm" aria-label={t('下个月', 'Next month')} onClick={() => chooseMonth(nextMonth(month, 1))}><ChevronRight size={17}/></Button><Button type="button" variant="outline" size="sm" onClick={today}>{t('今天', 'Today')}</Button></div><span className="grow"/><select className="work-native-select" aria-label={t('日历日期依据', 'Calendar date basis')} value={basis} onChange={event => onBasisChange(event.target.value as WorkCalendarBasis)}><option value="businessDate">{t('业务日期', 'Business date')}</option><option value="dueAt">{t('截止日期', 'Due date')}</option></select><Button type="button" variant="ghost" size="icon-sm" disabled={!enabled || loading || agendaLoading} aria-label={t('刷新日历', 'Refresh calendar')} onClick={() => setReload(value => value + 1)}><RefreshCw size={16}/></Button></header><ErrorMessage error={error}/><div className="work-calendar-layout"><div className="work-calendar-month-body"><div className="work-calendar-weekdays">{[t('周一', 'Mon'), t('周二', 'Tue'), t('周三', 'Wed'), t('周四', 'Thu'), t('周五', 'Fri'), t('周六', 'Sat'), t('周日', 'Sun')].map(day => <span key={day}>{day}</span>)}</div>{loading ? <Loading/> : <div className="work-calendar-grid" style={{ gridTemplateRows: `repeat(${Math.ceil((count + leading) / 7)},minmax(95px,1fr))` }}>{Array.from({ length: leading }, (_, index) => <div className="work-calendar-blank" key={`blank:${index}`}/>)}{Array.from({ length: count }, (_, index) => {
      const date = shiftDate(start, index), total = page?.days.find(day => day.date === date)?.total || 0, items = page?.items.filter(item => item.calendarDate === date).slice(0, 2) || []
      return <button type="button" data-calendar-date={date} key={date} className={`work-calendar-day ${selectedDay === date ? 'is-selected' : ''}`} aria-pressed={selectedDay === date} aria-label={t('{date}，{count} 个事项', '{date}, {count} items', { date, count: total })} onClick={() => setSelectedDay(date)}><span className="work-calendar-date">{index + 1}{total > 0 && <small>{total}</small>}</span><div>{items.map(item => <span className="work-calendar-item" key={item.id}><i style={{ backgroundColor: statuses.find(status => status.id === item.status)?.color }}/><span>{item.title}</span></span>)}{total > items.length && <small className="work-calendar-remaining">{t('另有 {count} 项', '{count} more', { count: total - items.length })}</small>}</div></button>
    })}</div>}</div><aside className="work-calendar-agenda"><header><h3>{selectedDay}</h3>{agenda && <span>{agenda.total}</span>}<span className="grow"/>{canCreate && <Button type="button" size="icon-sm" variant="ghost" aria-label={t('在 {date} 新建事项', 'Create item on {date}', { date: selectedDay })} onClick={() => onCreate(selectedDay)}><Plus size={16}/></Button>}</header><ErrorMessage error={agendaError}/>{agendaError && <Button type="button" variant="outline" size="sm" onClick={() => setReload(value => value + 1)}>{t('重新读取', 'Reload')}</Button>}<div className="work-calendar-agenda-items">{agendaLoading ? <Loading/> : agenda?.items.map(item => <button type="button" data-calendar-item={item.id} key={item.id} onClick={() => onOpenItem(item.id)}><strong>{item.title}</strong><span className="work-calendar-agenda-status"><i style={{ backgroundColor: statuses.find(status => status.id === item.status)?.color }}/>{statuses.find(status => status.id === item.status)?.name || item.status}</span><WorkPlanningSummary item={item} fields={fields}/></button>)}{!agendaLoading && agenda?.total === 0 && <div className="work-tool-empty">{t('当天没有匹配事项', 'No matching items on this date')}</div>}{agenda?.nextCursor && <Button type="button" variant="ghost" size="sm" disabled={moreBusy} onClick={() => void more()}>{t('加载更多（{shown}/{total}）', 'Load more ({shown}/{total})', { shown: agenda.items.length, total: agenda.total })}</Button>}</div></aside></div></section>
}
