import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from 'react'
import { ChevronLeft, ChevronRight, LoaderCircle, MousePointer2, RefreshCw, X } from 'lucide-react'
import { request } from '../core/api'
import { getLocale, t } from '../core/i18n'
import { clickDateRange, type LinkClickStats as ClickStats } from '../core/link-clicks'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { StyledSelect } from '../components/ui/select'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import '../components/modal-layout.css'
import './link-click-stats.css'

type Filters = { from: string; to: string; categoryId: string | null; sort: 'clicks' | 'lastClicked'; offset: number }
type StatsRequest = { key: string; data: ClickStats | null; failed: boolean }
type Palette = { theme: 'light' | 'dark'; style: CSSProperties }
const PAGE_SIZE = 20, ALL_CATEGORIES = '__all__', DAY = 86400000

function useStats(spaceId: string, query: string) {
  const [attempt, setAttempt] = useState(0), [result, setResult] = useState<StatsRequest | null>(null)
  const path = `/spaces/${encodeURIComponent(spaceId)}/navigation/click-stats?${query}`, key = `${path}\n${attempt}`
  useEffect(() => {
    const controller = new AbortController()
    // The key also gates rendering: a previous link or space is hidden before
    // this effect runs, even if its response arrives during a prop change.
    void request<ClickStats>(path, { signal: controller.signal }).then(data => {
      if (!data?.summary || !Array.isArray(data.items) || !Array.isArray(data.categories) || !Array.isArray(data.days)) throw new Error('Unavailable statistics')
      if (!controller.signal.aborted) setResult({ key, data, failed: false })
    }).catch(() => { if (!controller.signal.aborted) setResult({ key, data: null, failed: true }) })
    return () => controller.abort()
  }, [path, key])
  const current = result?.key === key ? result : null
  return { data: current?.data || null, loading: !current, failed: !!current?.failed, retry: () => setAttempt(value => value + 1) }
}

function useHomePalette(origin: RefObject<HTMLSpanElement | null>, trigger: RefObject<HTMLElement | null>): Palette {
  const [palette, setPalette] = useState<Palette>({ theme: 'light', style: {} })
  useLayoutEffect(() => {
    const home = origin.current?.closest<HTMLElement>('.lh-home') || trigger.current?.closest<HTMLElement>('.lh-home'), hostWindow = home?.ownerDocument.defaultView
    if (!home || !hostWindow) return
    const read = () => {
      const computed = hostWindow.getComputedStyle(home), style: Record<string, string> = {}
      for (const name of ['bg', 'surface', 'soft', 'ink', 'muted', 'line', 'accent', 'tint', 'hover', 'scroll-thumb']) style[`--lh-${name}`] = computed.getPropertyValue(`--lh-${name}`)
      setPalette({ theme: home.dataset.theme === 'dark' ? 'dark' : 'light', style: style as CSSProperties })
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(home, { attributes: true, attributeFilter: ['data-theme', 'data-page-theme', 'style'] })
    return () => observer.disconnect()
  }, [origin, trigger])
  return palette
}

function rangeError(from: string, to: string) {
  const parse = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN
    const stamp = Date.parse(value + 'T00:00:00Z')
    return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp : NaN
  }
  const start = parse(from), end = parse(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return t('请选择开始和结束日期。', 'Choose a start and end date.')
  if (start > end) return t('结束日期不能早于开始日期。', 'The end date cannot be before the start date.')
  if ((end - start) / DAY >= 366) return t('日期范围最多为 366 天。', 'Choose a range of at most 366 days.')
  return ''
}

function clickedAt(value: string | null | undefined, locale: string) {
  if (!value) return null
  const stamp = new Date(value)
  if (!Number.isFinite(stamp.getTime())) return null
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(stamp)
}

function LastClick({ value, locale }: { value: string | null | undefined; locale: string }) {
  const formatted = clickedAt(value, locale)
  return formatted ? <time dateTime={value!} title={`${formatted} UTC`}>{formatted}</time> : <span className="lh-click-stats-muted" title={t('尚无点击记录', 'No clicks recorded')}>—</span>
}

function LinkClickStatsDialog({ spaceId, spaceName, onClose }: { spaceId: string; spaceName: string; onClose: () => void }) {
  const locale = getLocale(), format = useMemo(() => new Intl.NumberFormat(locale), [locale]), id = useId()
  const origin = useRef<HTMLSpanElement>(null)
  const returnFocus = useRef<HTMLElement | null>(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const palette = useHomePalette(origin, returnFocus)
  const [filters, setFilters] = useState<Filters>(() => ({ ...clickDateRange(30), categoryId: null, sort: 'clicks', offset: 0 }))
  const [dates, setDates] = useState(() => ({ from: filters.from, to: filters.to })), [validation, setValidation] = useState('')
  const [categories, setCategories] = useState<ClickStats['categories']>([])
  const table = useRef<HTMLDivElement>(null)
  const query = new URLSearchParams({ from: filters.from, to: filters.to, limit: String(PAGE_SIZE), offset: String(filters.offset), sort: filters.sort })
  if (filters.categoryId !== null) query.set('categoryId', filters.categoryId)
  const stats = useStats(spaceId, query.toString()), data = stats.data
  useEffect(() => {
    // The endpoint groups the filtered rows. Retain the unfiltered category
    // choices so selecting one category never removes the other choices.
    if (data && filters.categoryId === null) setCategories(data.categories)
  }, [data, filters.categoryId])
  useEffect(() => { if (table.current) table.current.scrollTop = 0 }, [filters.from, filters.to, filters.categoryId, filters.sort, filters.offset])
  useEffect(() => {
    if (data && filters.offset > 0 && !data.items.length) setFilters(value => ({ ...value, offset: Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1) * PAGE_SIZE }))
  }, [data, filters.offset])
  const choices = useMemo(() => [
    { value: ALL_CATEGORIES, label: t('全部分类', 'All categories') },
    { value: '', label: t('未分类', 'Uncategorized') },
    ...categories.filter(category => category.categoryId).slice().sort((a, b) => a.categoryName.localeCompare(b.categoryName, locale)).map(category => ({ value: category.categoryId!, label: category.categoryName }))
  ], [categories, locale])
  function quickRange(days: number) {
    const range = clickDateRange(days); setDates(range); setValidation(''); setFilters(value => ({ ...value, ...range, offset: 0 })); stats.retry()
  }
  function applyRange(event: FormEvent) {
    event.preventDefault()
    const error = rangeError(dates.from, dates.to); setValidation(error)
    if (!error) { setFilters(value => ({ ...value, ...dates, offset: 0 })); stats.retry() }
  }
  const recorded = clickedAt(data?.recordedFrom, locale)
  // A zero is meaningful only when the server observed at least one day in
  // this range. Future days and days before installation are both untracked.
  const untrackedRange = !!data && !data.days.some(day => day.tracked)
  const beforeTracking = untrackedRange && !!data?.recordedFrom && data.to < data.recordedFrom.slice(0, 10)
  const rangeNote = !untrackedRange ? '' : beforeTracking
    ? t('所选日期早于开始记录时间。', 'This range is before recording began.')
    : t('所选日期尚未记录。', 'This range has not been recorded yet.')
  const metric = (value: number | undefined) => value === undefined ? '—' : format.format(value)
  const page = data ? Math.floor(data.offset / data.limit) + 1 : Math.floor(filters.offset / PAGE_SIZE) + 1
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : null
  return <><span ref={origin} hidden/><Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent showCloseButton={false} className="admin-ui admin-dialog lh-click-stats-dialog" style={palette.style} data-theme={palette.theme} onCloseAutoFocus={event => {
      event.preventDefault()
      if (returnFocus.current?.isConnected && returnFocus.current !== document.body) returnFocus.current.focus({ preventScroll: true })
      else { const main = document.getElementById('main-content'); if (main) { main.tabIndex = -1; main.focus({ preventScroll: true }) } }
    }}>
      <DialogHeader><DialogTitle>{t('点击统计', 'Click statistics')}</DialogTitle><DialogDescription>{spaceName}</DialogDescription></DialogHeader>
      <DialogClose asChild><Button type="button" variant="ghost" size="icon-sm" className="cn-dialog-close" aria-label={t('关闭点击统计', 'Close click statistics')}><X size={19} aria-hidden="true"/></Button></DialogClose>
      <div className="admin-dialog-body lh-click-stats-body">
        <div className="lh-click-stats-controls">
          <div className="lh-click-stats-range">
            <div className="lh-click-stats-presets" role="group" aria-label={t('日期范围', 'Date range')}>{[7, 30, 90].map(days => {
              const range = clickDateRange(days), selected = range.from === filters.from && range.to === filters.to && dates.from === filters.from && dates.to === filters.to
              return <button key={days} type="button" aria-pressed={selected} aria-label={t('最近 {days} 天', 'Last {days} days', { days })} onClick={() => quickRange(days)}>{t('{days} 天', '{days} days', { days })}</button>
            })}</div>
            <form className="lh-click-stats-dates" noValidate onSubmit={applyRange}>
              <label htmlFor={`${id}-from`}>{t('开始', 'From')}</label><Input id={`${id}-from`} name="click-stats-from" type="date" min="0001-01-01" max="9999-12-31" value={dates.from} aria-invalid={!!validation || undefined} aria-describedby={validation ? `${id}-validation` : undefined} onChange={event => { setDates(value => ({ ...value, from: event.target.value })); setValidation('') }}/>
              <label htmlFor={`${id}-to`}>{t('结束', 'To')}</label><Input id={`${id}-to`} name="click-stats-to" type="date" min="0001-01-01" max="9999-12-31" value={dates.to} aria-invalid={!!validation || undefined} aria-describedby={validation ? `${id}-validation` : undefined} onChange={event => { setDates(value => ({ ...value, to: event.target.value })); setValidation('') }}/>
              <Button type="submit" variant="outline" size="sm">{t('应用', 'Apply')}</Button>
            </form>
          </div>
          {validation && <p id={`${id}-validation`} className="lh-click-stats-validation" role="alert">{validation}</p>}
          <div className="lh-click-stats-options">
            <label className="lh-click-stats-category"><span>{t('分类', 'Category')}</span><StyledSelect aria-label={t('分类', 'Category')} value={filters.categoryId === null ? ALL_CATEGORIES : filters.categoryId} options={choices} tone="home" theme={palette.theme} onValueChange={value => setFilters(current => ({ ...current, categoryId: value === ALL_CATEGORIES ? null : value, offset: 0 }))}/></label>
            <label className="lh-click-stats-sort"><span>{t('排序', 'Sort')}</span><StyledSelect aria-label={t('排序', 'Sort')} value={filters.sort} tone="home" theme={palette.theme} options={[{ value: 'clicks', label: t('区间点击次数', 'Clicks in range') }, { value: 'lastClicked', label: t('最近点击', 'Most recent click') }]} onValueChange={value => setFilters(current => ({ ...current, sort: value as Filters['sort'], offset: 0 }))}/></label>
            <span className="lh-click-stats-period">{filters.from} — {filters.to}<span>UTC</span></span>
          </div>
        </div>
        <dl className="lh-click-stats-summary" aria-label={t('点击概览', 'Click overview')} aria-busy={stats.loading}>
          <div><dt>{t('区间点击', 'Clicks in range')}</dt><dd data-stat="periodClicks">{untrackedRange ? '—' : metric(data?.summary.periodClicks)}</dd></div>
          <div><dt>{t('活跃链接', 'Active links')}</dt><dd data-stat="activeLinks">{untrackedRange ? '—' : metric(data?.summary.activeLinks)}</dd></div>
          <div><dt>{t('从未点击', 'Never clicked')}</dt><dd data-stat="neverClickedLinks">{metric(data?.summary.neverClickedLinks)}</dd></div>
        </dl>
        <div className="lh-click-stats-table-wrap" ref={table} role="region" aria-label={t('点击排行列表', 'Click ranking list')} tabIndex={data?.items.length ? 0 : -1} aria-busy={stats.loading}>
          {stats.loading ? <div className="lh-click-stats-state" role="status"><LoaderCircle className="lh-click-stats-spin" size={22} aria-hidden="true"/><p>{t('正在读取点击统计…', 'Loading click statistics…')}</p></div> : stats.failed ? <div className="lh-click-stats-state"><p role="alert">{t('暂时无法读取点击统计。', 'Click statistics could not be loaded.')}</p><Button type="button" variant="outline" size="sm" onClick={stats.retry}><RefreshCw size={14} aria-hidden="true"/>{t('重试', 'Retry')}</Button></div> : data && !data.items.length ? <div className="lh-click-stats-state"><MousePointer2 size={25} aria-hidden="true"/><p>{filters.categoryId === null ? t('此空间暂无链接', 'No links in this space') : t('此分类暂无链接', 'No links in this category')}</p></div> : data && <table className="lh-click-stats-table" aria-label={t('链接点击排行', 'Link click ranking')}>
            <colgroup><col className="lh-click-stats-col-title"/><col className="lh-click-stats-col-category"/><col className="lh-click-stats-col-count"/><col className="lh-click-stats-col-count"/><col className="lh-click-stats-col-date"/></colgroup>
            <thead><tr><th scope="col">{t('名称', 'Name')}</th><th scope="col">{t('分类', 'Category')}</th><th scope="col" className="is-number">{t('区间次数', 'In range')}</th><th scope="col" className="is-number">{t('累计次数', 'All time')}</th><th scope="col">{t('最近点击', 'Last clicked')}</th></tr></thead>
            <tbody>{data.items.map(item => <tr key={item.linkId} data-link-id={item.linkId}>
              <td data-stat="title"><strong title={item.title}>{item.title}</strong><small title={item.url}>{item.url}</small></td>
              <td data-stat="category"><span title={item.categoryName || t('未分类', 'Uncategorized')}>{item.categoryName || t('未分类', 'Uncategorized')}</span></td>
              <td data-stat="periodClicks" className="is-number">{untrackedRange ? '—' : format.format(item.periodClicks)}</td><td data-stat="totalClicks" className="is-number">{format.format(item.totalClicks)}</td>
              <td data-stat="lastClickedAt"><LastClick value={item.lastClickedAt} locale={locale}/></td>
            </tr>)}</tbody>
          </table>}
        </div>
        <footer className="lh-click-stats-footer">
          <div className="lh-click-stats-recording">{recorded ? <span title={`${recorded} UTC`}>{t('自 {date} 起记录 · UTC', 'Recorded since {date} · UTC', { date: recorded })}</span> : <span>UTC</span>}{rangeNote && <small>{rangeNote}</small>}</div>
          <nav className="lh-click-stats-pagination" aria-label={t('点击统计分页', 'Click statistics pagination')}>
            <span aria-live="polite">{data ? t('{count} 个链接 · {page} / {pages}', '{count} links · {page} / {pages}', { count: format.format(data.total), page, pages: pages! }) : '—'}</span>
            <button type="button" aria-label={t('上一页统计', 'Previous statistics page')} disabled={stats.loading || stats.failed || filters.offset <= 0} onClick={() => setFilters(value => ({ ...value, offset: Math.max(0, value.offset - PAGE_SIZE) }))}><ChevronLeft size={18} aria-hidden="true"/></button>
            <button type="button" aria-label={t('下一页统计', 'Next statistics page')} disabled={stats.loading || stats.failed || !data?.hasMore} onClick={() => setFilters(value => ({ ...value, offset: value.offset + PAGE_SIZE }))}><ChevronRight size={18} aria-hidden="true"/></button>
          </nav>
        </footer>
      </div>
    </DialogContent>
  </Dialog></>
}

export default function LinkClickStats(props: { spaceId: string; spaceName: string; onClose: () => void }) {
  // A space change resets its filter choices as well as its response. A former
  // space's category ID must not become a query in the newly selected space.
  return <LinkClickStatsDialog key={props.spaceId} {...props}/>
}

export function LinkClickSummary({ spaceId, linkId }: { spaceId: string; linkId: string }) {
  const locale = getLocale(), query = new URLSearchParams({ ...clickDateRange(30), linkId, limit: '1' })
  const stats = useStats(spaceId, query.toString()), item = stats.data?.items.find(row => row.linkId === linkId)
  return <section className="lh-link-click-summary" data-link-id={linkId} aria-label={t('链接点击统计', 'Link click statistics')} aria-busy={stats.loading}>
    {stats.loading ? <span className="lh-link-click-summary-status" role="status"><LoaderCircle className="lh-click-stats-spin" size={14} aria-hidden="true"/>{t('正在读取点击统计…', 'Loading click statistics…')}</span> : stats.failed || !item ? <div className="lh-link-click-summary-status"><span role="alert">{t('点击统计暂不可用', 'Click statistics unavailable')}</span><button type="button" onClick={stats.retry}>{t('重试', 'Retry')}</button></div> : <dl>
      <div><dt>{t('累计点击', 'All-time clicks')}</dt><dd data-stat="totalClicks">{new Intl.NumberFormat(locale).format(item.totalClicks)}</dd></div>
      <div><dt>{t('最近点击', 'Last clicked')}<small>UTC</small></dt><dd data-stat="lastClickedAt"><LastClick value={item.lastClickedAt} locale={locale}/></dd></div>
    </dl>}
  </section>
}
