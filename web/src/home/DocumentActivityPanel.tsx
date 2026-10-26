import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { Activity, ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, FileText, Folder, LoaderCircle, LockKeyhole, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { Dialog, Tooltip } from 'radix-ui'
import { ApiError } from '../core/api'
import { getLocale, t } from '../core/i18n'
import {
  activityAddDays, activityCalendarDays, activityDateKey, activityDocumentHref, activityHeatLevel,
  activityMonthStart, activityMonthWindow, activityRecordedDate, activityTimezone, activityWindow,
  readDocumentActivitySettings, type ActivityDay, type ActivityDocument, type ActivityPerspective,
  type DocumentActivityData, type DocumentActivityQuery,
} from '../core/document-activity'
import type { View } from '../core/types'
import { useHomeEnvironment } from './HomeEnvironment'
import { useDocumentActivityQuery, useDocumentActivityScope, useDocumentActivitySelection } from './DocumentActivityProvider'
import './document-activity.css'

const dayLabel = (value: string, weekday = true, year = false) => new Date(value + 'T12:00:00Z').toLocaleDateString(getLocale(), { timeZone: 'UTC', month: 'short', day: 'numeric', ...(weekday ? { weekday: 'short' as const } : {}), ...(year ? { year: 'numeric' as const } : {}) })
const monthLabel = (value: string) => new Date(value + 'T12:00:00Z').toLocaleDateString(getLocale(), { timeZone: 'UTC', year: 'numeric', month: 'long' })
const shortMonth = (value: string) => new Date(value + 'T12:00:00Z').toLocaleDateString(getLocale(), { timeZone: 'UTC', month: 'short' })
const countLabel = (count: number) => t('{count} 篇', '{count} documents', { count })
function originLabel(origins: string[]) {
  const labels: Record<string, string> = { web: t('网页', 'Web'), api: 'API', mcp: 'MCP', external: t('外部检测', 'External') }
  return origins.map(value => labels[value] || value).join(' / ')
}
function actionLabel(actions: string[]) {
  const labels: Record<string, string> = { create: t('新建', 'Created'), update: t('更新', 'Updated'), restore: t('恢复', 'Restored'), rename: t('重命名', 'Renamed'), delete: t('删除', 'Deleted'), metadata: t('整理', 'Organized') }
  return actions.map(value => labels[value] || value).join(' · ')
}
function themeVariables(element: HTMLElement | null): CSSProperties {
  if (!element) return {}
  const computed = element.ownerDocument.defaultView!.getComputedStyle(element)
  const values: Record<string, string> = {}
  for (const name of ['bg', 'surface', 'ink', 'muted', 'line', 'accent', 'soft', 'tint', 'hover']) values[`--lh-${name}`] = computed.getPropertyValue(`--lh-${name}`)
  return values as CSSProperties
}
function State({ icon, children, action }: { icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return <div className="lh-activity-state" role="status">{icon}<span>{children}</span>{action}</div>
}
function ErrorState({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const forbidden = error instanceof ApiError && (error.status === 401 || error.status === 403)
  return <State icon={forbidden ? <LockKeyhole size={21}/> : <TriangleAlert size={21}/>} action={!forbidden && <button type="button" className="lh-activity-text-button" onClick={onRetry}>{t('重试', 'Retry')}</button>}>
    {forbidden ? t('当前账户无法查看活动记录', 'Activity is not available to this account') : t('活动记录加载失败', 'Could not load activity')}
  </State>
}

function DocumentRows({ items, timezone, compact = false }: { items: ActivityDocument[]; timezone: string; compact?: boolean }) {
  const scope = useDocumentActivityScope(), { preview } = useHomeEnvironment()
  return <ul className={`lh-activity-documents${compact ? ' is-compact' : ''}`}>
    {items.map(item => {
      const date = new Date(item.lastAt), ready = item.status === 'ready'
      const stamp = Number.isFinite(date.getTime()) ? date.toLocaleString(getLocale(), { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : item.date
      const contents = <><FileText size={18}/><span className="lh-activity-document-name"><strong>{item.title || item.relativePath}</strong><small title={`${item.sourceName} / ${item.relativePath}`}><Folder size={11}/>{item.sourceName} / {item.relativePath}</small></span></>
      return <li key={`${item.date}:${item.documentId}`} data-activity-document={item.documentId}>
        {ready && !preview && scope ? <a className="lh-activity-document-link" href={activityDocumentHref(scope.spaceId, item.documentId)} title={item.relativePath}>{contents}<ArrowUpRight size={13} className="lh-activity-open"/></a>
          : <span className="lh-activity-document-link is-unavailable">{contents}</span>}
        <span className="lh-activity-document-meta"><time dateTime={item.lastAt} title={stamp}>{stamp}</time><small title={`${actionLabel(item.actions)} · ${t('{count} 次变更', '{count} changes', { count: item.count })}`}>{ready ? originLabel(item.origins) : item.status === 'missing' ? t('已删除', 'Deleted') : t('暂不可用', 'Unavailable')}</small></span>
      </li>
    })}
  </ul>
}

function ActivityDetails({ query, title, onAll }: { query: DocumentActivityQuery; title?: string; onAll?: () => void }) {
  const [offset, setOffset] = useState(0)
  const result = useDocumentActivityQuery({ ...query, limit: 20, offset })
  const data = result.data
  return <section className="lh-activity-details" aria-label={title || t('活动记录', 'Activity records')} aria-busy={result.loading || undefined}>
    <header><h3>{title || t('活动记录', 'Activity records')}</h3>{onAll && <button type="button" className="lh-activity-text-button" onClick={onAll}>{t('全部记录', 'All records')}<ArrowUpRight size={12}/></button>}</header>
    {result.error ? <ErrorState error={result.error} onRetry={result.refresh}/> : !data ? <State icon={<LoaderCircle size={20} className="lh-spin"/>}>{t('正在读取…', 'Loading…')}</State>
      : data.items.length ? <DocumentRows items={data.items} timezone={query.timezone}/>
      : <State>{query.date && (!data.recordedFrom || query.date < (activityRecordedDate(data.recordedFrom, query.timezone) || query.date)) ? t('该日期尚未开始记录', 'Recording had not started on this date') : t('暂无活动记录', 'No activity recorded')}</State>}
    {data && (offset > 0 || data.hasMore) && <div className="lh-activity-pagination"><span>{Math.min(offset + 1, data.total)}–{Math.min(offset + data.items.length, data.total)} / {data.total}</span><button type="button" aria-label={t('上一页记录', 'Previous records')} disabled={!offset || result.loading} onClick={() => setOffset(value => Math.max(0, value - 20))}><ChevronLeft size={16}/></button><button type="button" aria-label={t('下一页记录', 'Next records')} disabled={!data.hasMore || result.loading} onClick={() => setOffset(value => value + 20)}><ChevronRight size={16}/></button></div>}
  </section>
}

function DayCell({ date, day, column, selected, today, recordedFrom, month, disabled, focused, onFocus, onChoose, onKeyDown, tooltipStyle, portal }: {
  date: string; day?: ActivityDay; selected: boolean; today: string; recordedFrom: string | null; month: boolean; disabled: boolean
  column: number
  focused: boolean; onFocus: () => void; onChoose: (element: HTMLButtonElement) => void; onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  tooltipStyle: CSSProperties; portal?: HTMLElement
}) {
  const unrecorded = !recordedFrom || date < recordedFrom
  const description = disabled ? t('未来日期', 'Future date') : unrecorded ? t('尚未记录', 'Not recorded') : countLabel(day?.count || 0)
  return <Tooltip.Root><Tooltip.Trigger asChild><button type="button" role="gridcell" data-date={date} data-level={activityHeatLevel(day?.count || 0)}
    className={`lh-activity-day${month ? ' is-month' : ''}${selected ? ' is-selected' : ''}${date === today ? ' is-today' : ''}${unrecorded ? ' is-unrecorded' : ''}`}
    disabled={disabled} tabIndex={focused && !disabled ? 0 : -1} aria-colindex={column} aria-selected={selected} aria-current={date === today ? 'date' : undefined}
    aria-label={`${dayLabel(date)}, ${description}`} onFocus={onFocus} onClick={event => onChoose(event.currentTarget)} onKeyDown={onKeyDown}>
    {month && <><span>{Number(date.slice(-2))}</span>{!disabled && !unrecorded && !!day?.count && <small>{countLabel(day.count)}</small>}</>}
  </button></Tooltip.Trigger><Tooltip.Portal container={portal}><Tooltip.Content className="lh-activity-tooltip" style={tooltipStyle} sideOffset={7} collisionPadding={12}><strong>{dayLabel(date)}</strong><span>{description}</span>{!unrecorded && !disabled && !!day?.count && <small>{t('新建 {created} · 更新 {updated}', 'Created {created} · Updated {updated}', { created: day.created || 0, updated: day.updated || 0 })}</small>}<Tooltip.Arrow className="lh-activity-tooltip-arrow"/></Tooltip.Content></Tooltip.Portal></Tooltip.Root>
}

function ActivityChart({ data, from, to, today, selected, month, onChoose, timezone, tooltipStyle, portal }: {
  data: DocumentActivityData; from: string; to: string; today: string; selected: string | null; month: boolean
  onChoose: (date: string, element: HTMLButtonElement) => void; timezone: string; tooltipStyle: CSSProperties; portal?: HTMLElement
}) {
  const grid = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null)
  const [focusDate, setFocusDate] = useState<string | null>(null)
  const monthEnd = activityAddDays(activityMonthStart(from, 1), -1)
  const days = useMemo(() => activityCalendarDays(from, month ? monthEnd : to), [from, to, month, monthEnd])
  const values = useMemo(() => new Map(data.days.map(day => [day.date, day])), [data.days])
  const recordedFrom = activityRecordedDate(data.recordedFrom, timezone)
  const focus = focusDate && focusDate >= from && focusDate <= to ? focusDate : selected && selected >= from && selected <= to ? selected : to
  const weeks = Math.ceil(days.length / 7)
  // DOM rows follow the visual rows: calendar weeks, or heatmap weekdays.
  // Date lookup and movement stay date-based, independent of the wrappers.
  const rows = month ? Array.from({ length: weeks }, (_, week) => days.slice(week * 7, week * 7 + 7))
    : Array.from({ length: 7 }, (_, weekday) => Array.from({ length: weeks }, (_, week) => days[week * 7 + weekday]!))
  useEffect(() => { if (!month && scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth }, [from, to, month])
  function move(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const movements: Record<string, number> = month ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } : { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }
    let target = ''
    if (Object.hasOwn(movements, event.key)) target = activityAddDays(date, movements[event.key]!)
    if (event.key === 'Home') target = from
    if (event.key === 'End') target = to
    if (!target) return
    event.preventDefault()
    if (target < from || target > to) return
    grid.current?.querySelector<HTMLButtonElement>(`button[data-date="${target}"]`)?.focus({ preventScroll: true })
    grid.current?.querySelector<HTMLButtonElement>(`button[data-date="${target}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  const weekdays = getLocale() === 'en' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['一', '二', '三', '四', '五', '六', '日']
  return <div className={`lh-activity-chart${month ? ' is-calendar' : ''}`}>
    {month ? <div className="lh-activity-month-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div> : <div className="lh-activity-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>}
    <div className="lh-activity-chart-scroll" ref={scroll}>
      {!month && <div className="lh-activity-month-labels" style={{ '--activity-weeks': weeks } as CSSProperties} aria-hidden="true">{Array.from({ length: weeks }, (_, index) => {
        const day = days[index * 7]!, end = activityAddDays(day, 6), labelDate = end < to ? end : to
        const previousEnd = index ? activityAddDays(days[(index - 1) * 7]!, 6) : ''
        return <span key={day}>{index === 0 || labelDate.slice(0, 7) !== previousEnd.slice(0, 7) ? shortMonth(labelDate) : ''}</span>
      })}</div>}
      <div ref={grid} className={`lh-activity-grid ${month ? 'is-month' : 'is-heatmap'}`} style={{ '--activity-weeks': weeks } as CSSProperties} role="grid" aria-rowcount={rows.length} aria-colcount={month ? 7 : weeks} aria-label={month ? monthLabel(from) : t('文档编辑热力图', 'Document activity heatmap')}>
        {rows.map((row, rowIndex) => <div key={rowIndex} role="row" aria-rowindex={rowIndex + 1} className="lh-activity-grid-row">
          {row.map((date, columnIndex) => date < from || date > (month ? monthEnd : to) ? <span key={date} className="lh-activity-day-placeholder" aria-hidden="true"/> : <DayCell key={date} date={date} day={values.get(date)} column={columnIndex + 1} selected={date === selected} today={today} recordedFrom={recordedFrom} month={month} disabled={date > today} focused={date === focus} onFocus={() => setFocusDate(date)} onChoose={element => onChoose(date, element)} onKeyDown={event => move(event, date)} tooltipStyle={tooltipStyle} portal={portal}/>)}
        </div>)}
      </div>
    </div>
    <div className="lh-activity-legend" aria-label={t('每天编辑的不同文档篇数', 'Different documents edited per day')}><span>{t('少', 'Less')}</span>{['0', '1', '2–3', '4–6', '7+'].map((label, index) => <span key={label} className="lh-activity-legend-item" title={t('{count} 篇', '{count} documents', { count: label })}><i data-level={index}/><small>{label}</small></span>)}<span>{t('多', 'More')}</span></div>
  </div>
}

export default function DocumentActivityPanel({ view }: { view: View }) {
  const scope = useDocumentActivityScope(), environment = useHomeEnvironment()
  const settings = readDocumentActivitySettings(view.settings)
  const timezone = activityTimezone(settings.timezone), today = activityDateKey(new Date(), timezone)
  const [offset, setOffset] = useState(0), [month, setMonth] = useState(activityMonthStart(today))
  const [perspectiveOverride, setPerspective] = useState<ActivityPerspective | null>(null)
  const [drawer, setDrawer] = useState<{ date?: string } | null>(null)
  const [selected, selectDate] = useDocumentActivitySelection(view.id, view.interactionScope)
  const root = useRef<HTMLElement>(null), opener = useRef<HTMLElement | null>(null)
  const presetKey = JSON.stringify([view.id, settings.presentation, settings.months, settings.perspective, settings.sourceIds, timezone])
  useEffect(() => { setOffset(0); setMonth(activityMonthStart(today)); setPerspective(null); setDrawer(null) }, [presetKey])
  const isMonth = settings.presentation === 'month'
  const range = isMonth ? activityMonthWindow(month, today) : activityWindow(today, settings.months, offset)
  const crossYear = range.from.slice(0, 4) !== range.to.slice(0, 4)
  const perspective = perspectiveOverride || settings.perspective
  const query: DocumentActivityQuery = { ...range, timezone, perspective, sourceIds: settings.sourceIds, limit: 20 }
  const result = useDocumentActivityQuery(scope?.enabled ? query : null), data = result.data
  const periodKey = JSON.stringify([range.from, range.to, timezone, perspective, settings.sourceIds])
  const effectiveDate = selected && selected >= range.from && selected <= range.to ? selected : data?.days.filter(day => day.count > 0).at(-1)?.date || range.to
  const title = typeof view.settings.title === 'string' && view.settings.title.trim() ? view.settings.title : t('文档活动', 'Document activity')
  const style = themeVariables(root.current), portal = environment.viewportWindow?.document.body
  function openRecords(element: HTMLElement, date?: string) { opener.current = element; setDrawer({ date }) }
  function chooseDate(date: string, element: HTMLButtonElement) {
    selectDate(date)
    if (settings.presentation !== 'split') openRecords(element, date)
  }
  function navigate(direction: number) {
    if (isMonth) setMonth(value => activityMonthStart(value, direction))
    else setOffset(value => Math.min(0, value + direction))
  }
  const nextDisabled = isMonth ? month >= activityMonthStart(today) : offset >= 0
  const recent = data ? data.items.filter((item, index, all) => all.findIndex(other => other.documentId === item.documentId) === index).slice(0, settings.recentLimit) : []
  const unhealthy = data?.sources.filter(source => ['offline', 'error', 'missing', 'suspect'].includes(source.status)) || []
  return <Tooltip.Provider delayDuration={180}><section ref={root} className={`lh-panel lh-document-activity lh-activity-${settings.presentation}`} data-activity-view={view.id} data-activity-presentation={settings.presentation} data-detail-layout={settings.detailLayout} aria-busy={result.loading || undefined}>
    <header className="lh-activity-heading"><div>{isMonth ? <CalendarDays size={18}/> : <Activity size={18}/>}<h2>{title}</h2></div>{scope?.enabled && <button type="button" className="lh-activity-icon-button" disabled={result.loading} aria-label={t('刷新文档活动', 'Refresh document activity')} onClick={() => scope.store.refreshAll()}><RefreshCw size={15} className={result.loading ? 'lh-spin' : undefined}/></button>}</header>
    {!scope?.enabled ? <State icon={<LockKeyhole size={24}/>}>{!scope || !scope.userKey || scope.userKey === 'visitor' ? t('登录后查看文档活动', 'Sign in to view document activity') : t('当前账户无法查看活动记录', 'Activity is not available to this account')}</State>
      : <>
        <div className="lh-activity-toolbar"><div className="lh-activity-perspective" role="group" aria-label={t('活动范围', 'Activity perspective')}>{(['mine', 'library'] as const).map(value => <button type="button" key={value} aria-pressed={perspective === value} onClick={() => { setPerspective(value); setDrawer(null) }}>{value === 'mine' ? t('我的编辑', 'My edits') : t('文档库变更', 'Library changes')}</button>)}</div><div className="lh-activity-period"><button type="button" className="lh-activity-icon-button" aria-label={isMonth ? t('上个月', 'Previous month') : t('上一时段', 'Previous period')} onClick={() => navigate(-1)}><ChevronLeft size={15}/></button><strong>{isMonth ? monthLabel(month) : `${dayLabel(range.from, false, crossYear)} – ${dayLabel(range.to, false, crossYear)}`}</strong><button type="button" className="lh-activity-icon-button" disabled={nextDisabled} aria-label={isMonth ? t('下个月', 'Next month') : t('下一时段', 'Next period')} onClick={() => navigate(1)}><ChevronRight size={15}/></button>{!nextDisabled && <button type="button" className="lh-activity-text-button" onClick={() => { setOffset(0); setMonth(activityMonthStart(today)) }}>{t('今天', 'Today')}</button>}</div></div>
        <div className="lh-activity-body">{result.error ? <ErrorState error={result.error} onRetry={result.refresh}/> : !data ? <State icon={<LoaderCircle size={23} className="lh-spin"/>}>{t('正在读取…', 'Loading…')}</State>
          : <>
            {settings.showSummary && <div className="lh-activity-summary" title={t('统计范围内去重文档数；同一篇跨天编辑只计一篇。', 'Distinct documents in this period; a document edited on several days counts once.')}><span><strong>{data.summary.documents}</strong> {t('篇文档', 'documents')}</span><span><strong>{data.summary.activeDays}</strong> {t('个活跃日', 'active days')}</span></div>}
            <div className="lh-activity-content"><ActivityChart data={data} from={range.from} to={range.to} today={today} selected={settings.presentation === 'split' ? effectiveDate : selected} month={isMonth} onChoose={chooseDate} timezone={timezone} tooltipStyle={style} portal={portal}/>
              {settings.presentation === 'split' && <ActivityDetails key={`${periodKey}:${effectiveDate}`} query={{ ...query, date: effectiveDate }} title={dayLabel(effectiveDate)} onAll={() => openRecords(root.current!.querySelector<HTMLButtonElement>('.lh-activity-footer button') || root.current!)}/>}
            </div>
            {settings.presentation !== 'split' && settings.recentLimit > 0 && <section className="lh-activity-recent"><h3>{t('最近记录', 'Recent records')}</h3>{recent.length ? <DocumentRows items={recent} timezone={timezone} compact/> : <p>{t('暂无活动记录', 'No activity recorded')}</p>}</section>}
            <footer className="lh-activity-footer"><span>{unhealthy.length ? <span className="lh-activity-source-warning" title={unhealthy.map(source => source.name).join('、')}><TriangleAlert size={13}/>{t('部分目录未同步', 'Some directories are not synced')}</span> : data.recordedFrom ? <span title={timezone}>{t('记录始于 {date}', 'Recording since {date}', { date: activityRecordedDate(data.recordedFrom, timezone) || data.recordedFrom })}</span> : <span>{t('等待首次记录', 'Awaiting the first record')}</span>}</span><button type="button" className="lh-activity-text-button" onClick={event => openRecords(event.currentTarget)}>{t('全部记录', 'All records')}<ArrowUpRight size={13}/></button></footer>
          </>}</div>
      </>}
    <Dialog.Root open={drawer !== null} onOpenChange={open => { if (!open) setDrawer(null) }}><Dialog.Portal container={portal}><Dialog.Overlay className="lh-activity-drawer-overlay"/><Dialog.Content className="lh-activity-drawer" style={style} aria-describedby={undefined} onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus({ preventScroll: true }) }}>
      <header className="lh-activity-drawer-heading"><div><Dialog.Title>{drawer?.date ? dayLabel(drawer.date) : t('活动记录', 'Activity records')}</Dialog.Title><span>{drawer?.date ? countLabel(data?.days.find(day => day.date === drawer.date)?.count || 0) : `${range.from} – ${range.to}`}</span></div><Dialog.Close asChild><button type="button" className="lh-activity-icon-button" aria-label={t('关闭活动记录', 'Close activity records')}><X size={21}/></button></Dialog.Close></header>
      <div className="lh-activity-drawer-body">{drawer && <ActivityDetails key={`${periodKey}:${drawer.date || 'all'}`} query={{ ...query, date: drawer.date }} title={drawer.date ? t('当天文档', 'Documents on this day') : t('最近记录', 'Recent records')} onAll={drawer.date ? () => setDrawer({}) : undefined}/>}</div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </section></Tooltip.Provider>
}
