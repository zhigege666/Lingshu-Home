import { useEffect, useState, type ReactNode } from 'react'
import { Activity, ArrowUpRight, CalendarDays, Check, ChevronLeft, ChevronRight, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Clock3, MapPin, Moon, Sun, Wind } from 'lucide-react'
import { getLocale, t } from '../core/i18n'
import { safeHref } from '../core/presentation'
import type { CalendarData, CalendarEvent, Dataset, MetricsData, StatusData, View, WeatherData } from '../core/types'
import { useHomeEnvironment } from './HomeEnvironment'
import './data-panels.css'

type Props = { view: View; dataset?: Dataset<unknown>; loading?: boolean; failed?: boolean }
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const stamp = (value: unknown): value is number => numeric(value) && Math.abs(value) < 8640000000000
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
const number = (value: number) => new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(value)
function timezone(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true } catch { return false }
}
function dateKey(value: Date, zone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value)
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)?.value).join('-')
}
function addDays(value: string, amount: number) { const day = new Date(value + 'T12:00:00Z'); day.setUTCDate(day.getUTCDate() + amount); return day.toISOString().slice(0, 10) }
function dayLabel(value: string, weekday = true) { return new Date(value + 'T12:00:00Z').toLocaleDateString(getLocale(), { timeZone: 'UTC', month: 'short', day: 'numeric', ...(weekday ? { weekday: 'short' as const } : {}) }) }
function updated(value: unknown, timeZone?: string) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone }) : t('尚未更新', 'Not updated yet') }
function datasetState(dataset: Dataset<unknown> | undefined) {
  const freshness = dataset?.meta?.freshness
  if (freshness === 'disabled') return t('已停用 · 保留快照', 'Disabled · Saved snapshot')
  if (freshness === 'error' || dataset?.meta?.lastError) return t('更新失败 · 保留快照', 'Update failed · Saved snapshot')
  if (freshness && freshness !== 'fresh') return t('快照已过期', 'Snapshot is stale')
  return t('已更新', 'Updated')
}
function Frame({ view, dataset, icon, children, empty, loading, failed, invalid, footer, timeZone }: Props & { icon: ReactNode; children?: ReactNode; empty?: string; invalid?: boolean; footer?: ReactNode; timeZone?: string }) {
  const titles: Record<string, string> = { 'builtin/calendar': t('日程', 'Calendar'), 'builtin/weather': t('天气', 'Weather'), 'builtin/metrics': t('统计指标', 'Metrics'), 'builtin/status': t('服务状态', 'Service status') }
  const usable = !!children && !invalid
  const state = usable ? datasetState(dataset) : loading ? t('正在读取', 'Loading') : failed ? t('读取失败', 'Could not load') : invalid ? t('数据格式不匹配', 'Data format mismatch') : t('等待数据', 'Awaiting data')
  return <section className={`lh-panel lh-data-panel lh-${view.panel.id.slice(8)}-panel`} aria-busy={loading || undefined}>
    <div className="lh-panel-heading">{icon}<h2>{typeof view.settings.title === 'string' && view.settings.title.trim() || titles[view.panel.id]}</h2><span className={`lh-data-state${!usable || dataset?.meta?.freshness !== 'fresh' ? ' is-pending' : ''}`}>{state}</span></div>
    {usable ? children : <div className="lh-data-empty" role="status">{icon}<strong>{loading ? t('正在读取已保存数据…', 'Loading the saved data…') : failed ? t('暂时无法读取此组件', 'This component could not be loaded') : invalid ? t('此组件需要兼容的数据格式', 'This component needs a compatible data format') : empty || t('数据尚未就绪', 'Data is not ready')}</strong><p>{loading ? t('其他组件可继续使用。', 'Other components remain available.') : invalid ? t('请检查绑定的数据来源和格式版本。', 'Check the bound source and its data format version.') : t('在管理中心检查数据来源、启用状态与最近更新。', 'Check the data source, enabled state and last update in admin.')}</p></div>}
    <footer className="lh-data-footer"><span><Clock3 size={12} />{t('更新于 {time}', 'Updated {time}', { time: updated(dataset?.meta?.lastSuccessAt || dataset?.meta?.receivedAt, timeZone) })}</span>{footer}</footer>
  </section>
}
function isCalendar(value: unknown): value is CalendarData {
  return object(value) && timezone(value.timezone) && stamp(value.windowStart) && stamp(value.windowEnd) && value.windowEnd > value.windowStart && Array.isArray(value.events) && value.events.every(event => object(event) && typeof event.id === 'string' && typeof event.title === 'string' && stamp(event.startAt) && stamp(event.endAt) && event.endAt >= event.startAt && typeof event.allDay === 'boolean' && (!event.allDay || date(event.startDate) && date(event.endDate)))
}
function CalendarPanel(props: Props) {
  const { preview } = useHomeEnvironment()
  const { view, dataset } = props
  const [mode, setMode] = useState<'day' | 'week' | null>(null), [offset, setOffset] = useState(0)
  useEffect(() => { setMode(null); setOffset(0) }, [view.settings.viewMode, dataset?.datasetId])
  const currentMode = mode || (view.settings.viewMode === 'day' ? 'day' : 'week')
  const valid = dataset?.schemaId === 'calendar.events' && dataset.schemaVersion === 1 && isCalendar(dataset.data)
  const data = valid ? dataset.data as CalendarData : null
  const zone = data?.timezone || 'UTC', today = dateKey(new Date(), zone)
  const weekDay = new Date(today + 'T12:00:00Z').getUTCDay()
  const first = addDays(today, offset - (currentMode === 'week' ? (weekDay + 6) % 7 : 0))
  const days = Array.from({ length: currentMode === 'week' ? 7 : 1 }, (_, index) => addDays(first, index))
  const final = days[days.length - 1]!
  const starts = data ? dateKey(new Date(data.windowStart * 1000), zone) : first
  const ends = data ? dateKey(new Date((data.windowEnd - 1) * 1000), zone) : final
  const eventsFor = (day: string) => data!.events.filter(event => event.allDay ? event.startDate! <= day && day < event.endDate! : dateKey(new Date(event.startAt * 1000), zone) <= day && dateKey(new Date(Math.max(event.startAt, event.endAt - 1) * 1000), zone) >= day).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startAt - b.startAt)
  const eventTime = (event: CalendarEvent, day: string) => {
    if (event.allDay) return t('全天', 'All day')
    const startDate = dateKey(new Date(event.startAt * 1000), zone), endDate = dateKey(new Date(Math.max(event.startAt, event.endAt - 1) * 1000), zone)
    const format = (value: number) => new Date(value * 1000).toLocaleTimeString(getLocale(), { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false })
    return `${startDate < day ? t('延续', 'Continues') : format(event.startAt)} – ${endDate > day ? t('次日', 'Next day') : format(event.endAt)}`
  }
  return <Frame {...props} timeZone={data?.timezone} icon={<CalendarDays size={18} />} invalid={!!dataset?.data && !valid} empty={t('还没有日程快照', 'No calendar snapshot yet')} footer={data && <span title={t('显示时区', 'Display time zone')}>{zone}</span>}>
    {data && <>
      <div className="lh-calendar-toolbar"><div className="lh-segmented" role="group" aria-label={t('日程视图', 'Calendar view')}>{(['day', 'week'] as const).map(value => <button type="button" key={value} aria-pressed={currentMode === value} onClick={() => { setMode(value); setOffset(0) }}>{value === 'day' ? t('日', 'Day') : t('周', 'Week')}</button>)}</div>
        <div className="lh-calendar-paging"><button type="button" className="lh-icon-button" disabled={first <= starts} aria-label={t('上一段日程', 'Previous period')} onClick={() => setOffset(value => value - days.length)}><ChevronLeft size={16} /></button><button type="button" className="lh-calendar-today" onClick={() => setOffset(0)}>{t('今天', 'Today')}</button><button type="button" className="lh-icon-button" disabled={final >= ends} aria-label={t('下一段日程', 'Next period')} onClick={() => setOffset(value => value + days.length)}><ChevronRight size={16} /></button></div>
      </div>
      <div className="lh-calendar-period"><strong>{dayLabel(first, false)}{days.length > 1 && ` – ${dayLabel(final, false)}`}</strong><span>{t('已同步 {start} – {end}', 'Synced {start} – {end}', { start: starts, end: ends })}</span></div>
      <div className="lh-calendar-agenda">{days.map(day => {
        const events = eventsFor(day)
        return <section key={day} className={`lh-calendar-day${day === today ? ' is-today' : ''}`} aria-label={dayLabel(day)}><h3><span>{dayLabel(day)}</span>{day === today && <small>{t('今天', 'Today')}</small>}</h3>
          {day < starts || day > ends ? <p className="lh-calendar-clear">{t('此日期不在已同步范围内', 'This date is outside the synced range')}</p> : events.length ? <ul>{events.map(event => <li key={event.id} className={event.status === 'cancelled' ? 'is-cancelled' : undefined}><time>{eventTime(event, day)}</time><div>
            {safeHref(event.url || '') && !preview ? <a href={safeHref(event.url!)} target="_blank" rel="noopener noreferrer">{event.title}<ArrowUpRight size={12} /></a> : <strong>{event.title}</strong>}
            {event.status === 'cancelled' && <span className="lh-event-status">{t('已取消', 'Cancelled')}</span>}{event.status === 'tentative' && <span className="lh-event-status">{t('待定', 'Tentative')}</span>}
            {event.allDay && event.startDate && event.endDate && addDays(event.startDate, 1) < event.endDate && <small>{t('跨天 · {start} – {end}', 'Multi-day · {start} – {end}', { start: event.startDate, end: addDays(event.endDate, -1) })}</small>}
            {event.location && <small><MapPin size={11} />{event.location}</small>}{event.description && <p className="lh-event-description">{event.description}</p>}
          </div></li>)}</ul> : <p className="lh-calendar-clear"><Check size={13} />{t('暂无安排', 'No events')}</p>}
        </section>
      })}</div>
    </>}
  </Frame>
}

function weatherDescription(code: number) {
  if (code === 0) return { label: t('晴', 'Clear'), Icon: Sun }
  if (code === 1 || code === 2) return { label: t('晴间多云', 'Partly cloudy'), Icon: CloudSun }
  if (code === 3) return { label: t('多云', 'Overcast'), Icon: Cloud }
  if (code === 45 || code === 48) return { label: t('雾', 'Fog'), Icon: CloudFog }
  if (code >= 51 && code <= 57) return { label: t('毛毛雨', 'Drizzle'), Icon: CloudDrizzle }
  if (code >= 71 && code <= 77 || code === 85 || code === 86) return { label: t('雪', 'Snow'), Icon: CloudSnow }
  if ([95, 96, 99].includes(code)) return { label: t('雷雨', 'Thunderstorm'), Icon: CloudLightning }
  if (code >= 61 && code <= 67 || code >= 80 && code <= 82) return { label: t('雨', 'Rain'), Icon: CloudRain }
  return { label: t('天气未知', 'Unknown conditions'), Icon: Cloud }
}
function isWeather(value: unknown): value is WeatherData {
  return object(value) && timezone(value.timezone) && numeric(value.latitude) && numeric(value.longitude) && Array.isArray(value.daily) && value.daily.every(day => object(day) && date(day.date) && numeric(day.weatherCode) && numeric(day.temperatureMin) && numeric(day.temperatureMax)) && (!value.current || object(value.current) && stamp(value.current.time) && numeric(value.current.temperature) && numeric(value.current.weatherCode) && typeof value.current.isDay === 'boolean')
}
function WeatherPanel(props: Props) {
  const { preview } = useHomeEnvironment(), { view, dataset } = props
  const valid = dataset?.schemaId === 'weather.forecast' && dataset.schemaVersion === 1 && isWeather(dataset.data)
  const data = valid ? dataset.data as WeatherData : null
  const current = data?.current, description = current ? weatherDescription(current.weatherCode) : null
  const Icon = current && !current.isDay && current.weatherCode === 0 ? Moon : description?.Icon || CloudSun
  const count = [3, 5, 7].includes(Number(view.settings.forecastDays)) ? Number(view.settings.forecastDays) : 5
  const daily = data?.daily.slice(0, count) || []
  const rawAttribution = dataset?.meta?.attribution
  const attribution = object(rawAttribution) && typeof rawAttribution.name === 'string' ? rawAttribution : null
  return <Frame {...props} timeZone={data?.timezone} icon={<CloudSun size={18} />} invalid={!!dataset?.data && !valid} empty={t('还没有天气快照', 'No weather snapshot yet')} footer={data && <span>{data.timezone}</span>}>
    {data && <>
      <div className="lh-weather-location"><MapPin size={14} /><strong>{data.locationName || `${number(data.latitude)}°, ${number(data.longitude)}°`}</strong><span>{t('设定地点', 'Selected location')}</span></div>
      {current ? <div className="lh-weather-now"><Icon size={52} strokeWidth={1.4} aria-hidden="true" /><div><strong>{number(current.temperature)}<span>°C</span></strong><p>{description!.label}</p></div><dl>{numeric(current.apparentTemperature) && <div><dt>{t('体感', 'Feels like')}</dt><dd>{number(current.apparentTemperature)}°</dd></div>}{numeric(current.humidity) && <div><dt>{t('湿度', 'Humidity')}</dt><dd>{number(current.humidity)}%</dd></div>}{numeric(current.windSpeed) && <div><dt><Wind size={12} />{t('风速', 'Wind')}</dt><dd>{number(current.windSpeed)} km/h</dd></div>}</dl></div> : <p className="lh-data-muted">{t('当前天气未提供，显示已保存的预报。', 'Current conditions are unavailable. Showing the saved forecast.')}</p>}
      {daily.length ? <div className="lh-weather-days" aria-label={t('天气预报', 'Weather forecast')}>{daily.map(day => { const weather = weatherDescription(day.weatherCode); return <div key={day.date}><time dateTime={day.date}>{dayLabel(day.date)}</time><weather.Icon size={25} strokeWidth={1.6} aria-hidden="true" /><span>{weather.label}</span><strong>{number(day.temperatureMax)}° <small>{number(day.temperatureMin)}°</small></strong>{numeric(day.precipitationProbability) && <small>{t('降水 {value}%', 'Rain {value}%', { value: number(day.precipitationProbability) })}</small>}</div> })}</div> : <p className="lh-data-muted">{t('暂无逐日预报', 'No daily forecast')}</p>}
      <p className="lh-weather-credit">{t('天气数据：', 'Weather data: ')}{attribution ? <>{!preview && typeof attribution.url === 'string' && safeHref(attribution.url) ? <a href={safeHref(attribution.url)} target="_blank" rel="noopener noreferrer">{String(attribution.name)}</a> : <span>{String(attribution.name)}</span>}{typeof attribution.license === 'string' && <><span> · </span>{!preview && typeof attribution.licenseUrl === 'string' && safeHref(attribution.licenseUrl) ? <a href={safeHref(attribution.licenseUrl)} target="_blank" rel="noopener noreferrer">{attribution.license}</a> : <span>{attribution.license}</span>}</>}</> : t('已连接的数据来源', 'Connected data source')}</p>
    </>}
  </Frame>
}
function isMetrics(value: unknown): value is MetricsData { return object(value) && Array.isArray(value.metrics) && value.metrics.every(item => object(item) && typeof item.id === 'string' && typeof item.label === 'string' && (item.value === null || numeric(item.value))) }
function MetricsPanel(props: Props) {
  const { view, dataset } = props
  const valid = dataset?.schemaId === 'metrics.summary' && dataset.schemaVersion === 1 && isMetrics(dataset.data)
  const data = valid ? dataset.data as MetricsData : null
  const stateName = { ok: t('正常', 'Normal'), warning: t('注意', 'Warning'), critical: t('异常', 'Critical'), unknown: t('未知', 'Unknown') }
  return <Frame {...props} icon={<Activity size={18} />} invalid={!!dataset?.data && !valid} empty={t('还没有指标快照', 'No metrics snapshot yet')}>
    {data && (data.metrics.length ? <div className="lh-metrics-grid">{data.metrics.map(item => {
      const measurable = numeric(item.value) && numeric(item.max) && numeric(item.min ?? 0) && item.max > (item.min ?? 0)
      const ratio = measurable ? Math.min(100, Math.max(0, (item.value! - (item.min ?? 0)) / (item.max! - (item.min ?? 0)) * 100)) : 0
      const status = item.status && Object.hasOwn(stateName, item.status) ? item.status : 'unknown'
      return <div className={`lh-metric is-${status}`} key={item.id}><span>{item.label}</span><strong>{item.value === null ? '—' : number(item.value)}{item.unit && <small>{item.unit}</small>}</strong>{item.value === null ? <small>{t('尚无数值', 'No value reported')}</small> : item.status && <small className="lh-metric-status">{stateName[status]}</small>}{view.settings.showBars !== false && measurable && <div className="lh-metric-track" role="meter" aria-label={item.label} aria-valuemin={item.min ?? 0} aria-valuemax={item.max} aria-valuenow={item.value!}><i style={{ width: `${ratio}%` }} /></div>}</div>
    })}</div> : <p className="lh-data-muted">{t('来源已连接，暂未提供指标。', 'The source is connected; no metrics were reported.')}</p>)}
  </Frame>
}
function isStatus(value: unknown): value is StatusData { return object(value) && Array.isArray(value.items) && value.items.every(item => object(item) && typeof item.id === 'string' && typeof item.label === 'string' && ['up', 'degraded', 'down', 'unknown'].includes(String(item.status))) }
function StatusPanel(props: Props) {
  const { preview } = useHomeEnvironment(), { view, dataset } = props
  const valid = dataset?.schemaId === 'status.collection' && dataset.schemaVersion === 1 && isStatus(dataset.data)
  const data = valid ? dataset.data as StatusData : null
  const labels = { up: t('正常', 'Operational'), degraded: t('性能下降', 'Degraded'), down: t('不可用', 'Unavailable'), unknown: t('未知', 'Unknown') }
  return <Frame {...props} icon={<Activity size={18} />} invalid={!!dataset?.data && !valid} empty={t('还没有服务状态快照', 'No service status snapshot yet')}>
    {data && (data.items.length ? <ul className="lh-status-list">{data.items.map(item => <li key={item.id} className={`is-${item.status}`}><i aria-hidden="true" /><div>{safeHref(item.url || '') && !preview ? <a href={safeHref(item.url!)} target="_blank" rel="noopener noreferrer">{item.label}<ArrowUpRight size={12} /></a> : <strong>{item.label}</strong>}{item.message && <p>{item.message}</p>}</div><span><strong>{labels[item.status]}</strong>{view.settings.showLatency !== false && numeric(item.latencyMs) && <small>{number(item.latencyMs)} ms</small>}</span></li>)}</ul> : <p className="lh-data-muted">{t('来源已连接，暂未提供服务状态。', 'The source is connected; no service statuses were reported.')}</p>)}
  </Frame>
}
/** Data is provided by the authorized dashboard projection. Components do not fetch or poll. */
export default function DataPanel(props: Props) {
  if (props.view.panel.id === 'builtin/calendar') return <CalendarPanel {...props} />
  if (props.view.panel.id === 'builtin/weather') return <WeatherPanel {...props} />
  if (props.view.panel.id === 'builtin/metrics') return <MetricsPanel {...props} />
  return <StatusPanel {...props} />
}
