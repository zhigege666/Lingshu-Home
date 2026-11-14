import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, RefreshCw } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { formatUpdated } from '../core/presentation'
import { workPath } from '../core/work-types'
import type { WorkFeatureSettings, WorkNotice, WorkNoticePage, WorkNoticeSummary } from '../core/work-planning-types'
import { Button } from '../components/ui/button'
import { ErrorMessage, Loading } from '../components/Shared'
import './work-tools.css'

const kindLabel = (value: string) => ({ assigned: t('负责人变更', 'Assignment changed'), work_assigned: t('负责人变更', 'Assignment changed'), mentioned: t('提及', 'Mentioned'), schedule_failed: t('定时生成失败', 'Recurring generation failed'), automation_failed: t('自动化失败', 'Automation failed'), execution_failed: t('执行失败', 'Execution failed'), execution_unknown: t('执行结果未知', 'Execution result unknown') })[value] || value

export default function WorkNotifications({ spaceId, enabled, onOpenItem, onOpenSubject, onNotice }: { spaceId: string; enabled: boolean; onOpenItem: (id: string) => void; onOpenSubject: (notice: WorkNotice) => void; onNotice: (message: string) => void }) {
  const [settings, setSettings] = useState<WorkFeatureSettings | null>(null), [page, setPage] = useState<WorkNoticePage | null>(null), [summary, setSummary] = useState<WorkNoticeSummary | null>(null)
  const [unread, setUnread] = useState(true), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [moreBusy, setMoreBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [settingsRefresh, setSettingsRefresh] = useState(0)
  const alive = useRef(true), pending = useRef(false), paging = useRef(false), generation = useRef(0), loadedAt = useRef('')
  const path = `${workPath(spaceId)}/notifications`
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])
  useEffect(() => {
    if (!enabled) { setLoading(false); return }
    const abort = new AbortController(); setLoading(true); setError('')
    request<WorkFeatureSettings>(`${path}/settings`, { signal: abort.signal }).then(value => { if (!abort.signal.aborted) setSettings(value) }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [path, enabled, settingsRefresh])
  function params(cursor?: string) { return new URLSearchParams({ unread: String(unread), limit: '30', ...(cursor ? { cursor } : {}) }) }
  useEffect(() => {
    const token = ++generation.current
    if (!enabled || !settings?.enabled) { setPage(null); return }
    const abort = new AbortController(); setLoading(true); setError(''); loadedAt.current = new Date().toISOString()
    Promise.all([request<WorkNoticePage>(`${path}?${params()}`, { signal: abort.signal }), request<WorkNoticeSummary>(`${path}/summary`, { signal: abort.signal })]).then(([items, counts]) => { if (!abort.signal.aborted && token === generation.current) { setPage(items); setSummary(counts) } }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [path, enabled, settings?.enabled, unread, refresh])
  async function toggle() {
    if (!enabled || !settings?.canEdit || pending.current) return
    const next = !settings.enabled; pending.current = true; setBusy(true); setError('')
    try {
      const value = await request<WorkFeatureSettings>(`${path}/settings`, { method: 'PATCH', body: { enabled: next, expectedRevision: settings.revision } })
      if (alive.current) { setSettings(value); onNotice(next ? t('站内通知已启用', 'In-app notifications enabled') : t('站内通知已关闭', 'In-app notifications disabled')) }
    } catch (cause) {
      if (!alive.current) return
      if (!(cause instanceof ApiError) || cause.status >= 500 || cause.status === 409) {
        try { const actual = await request<WorkFeatureSettings>(`${path}/settings`); if (alive.current) { setSettings(actual); setError(actual.enabled === next ? '' : t('设置已有变化，已显示当前值。', 'Settings changed; the current value is shown.')) } }
        catch (readError) { if (alive.current) setError(messageOf(readError)) }
      } else setError(messageOf(cause))
    } finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function more() {
    if (!page?.nextCursor || paging.current) return
    paging.current = true; setMoreBusy(true); const token = generation.current
    try { const value = await request<WorkNoticePage>(`${path}?${params(page.nextCursor)}`); if (alive.current && token === generation.current) setPage(old => old ? { ...value, items: [...old.items, ...value.items.filter(row => !old.items.some(item => item.id === row.id))] } : value) }
    catch (cause) { if (alive.current && token === generation.current) setError(messageOf(cause)) }
    finally { paging.current = false; if (alive.current) setMoreBusy(false) }
  }
  async function markRead(ids?: string[]) {
    if (!enabled || !settings?.canEdit || pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await request(`${path}/read`, { method: 'POST', body: ids ? { ids } : { allBefore: loadedAt.current } }); if (alive.current) setRefresh(value => value + 1) }
    catch (cause) { if (alive.current) setError(t('标记结果未确认，请刷新通知查看。{detail}', 'The read state is unconfirmed. Refresh notifications to verify. {detail}', { detail: messageOf(cause) })) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function inspectFailures() {
    if (!enabled || pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { const value = await request<WorkNoticeSummary>(`${path}/summary`); if (alive.current) setSummary(value) }
    catch (cause) { if (alive.current) setError(messageOf(cause)) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  return <section className="work-tools-page" aria-label={t('通知', 'Notifications')}><header><h2>{t('通知', 'Notifications')}{summary && settings?.enabled ? ` · ${summary.unreadCount}` : ''}</h2>{settings && <label className="work-feature-switch"><input data-work-notifications-enabled type="checkbox" checked={settings.enabled} disabled={!enabled || !settings.canEdit || busy} onChange={() => void toggle()}/>{t('站内通知', 'In-app notifications')}</label>}<Button type="button" variant="ghost" size="icon-sm" disabled={!enabled || loading || busy} aria-label={t('刷新通知', 'Refresh notifications')} onClick={() => { if (settings?.enabled) setRefresh(value => value + 1); else setSettingsRefresh(value => value + 1) }}><RefreshCw size={16}/></Button></header><ErrorMessage error={error}/>{!settings && loading ? <Loading/> : settings && <div className="work-tool-scroll">
    {settings.enabled ? <><div className="work-tool-subhead"><label className="work-feature-switch"><input type="checkbox" checked={unread} onChange={event => setUnread(event.target.checked)}/>{t('仅未读', 'Unread only')}</label><Button type="button" variant="ghost" size="sm" disabled={!settings.canEdit || busy || loading || !summary?.unreadCount} onClick={() => void markRead()}><Check size={14}/>{t('全部标为已读', 'Mark all read')}</Button></div>{loading ? <Loading/> : page?.items.map(notice => <article className={`work-notice ${notice.readAt ? 'is-read' : ''}`} data-notice-id={notice.id} key={notice.id}><i className="work-notice-dot"/><div><h4>{kindLabel(notice.kind)}{notice.count > 1 ? ` × ${notice.count}` : ''}</h4><p>{notice.message}</p><small><time dateTime={notice.lastAt}>{formatUpdated(notice.lastAt)}</time>{notice.code ? ` · ${notice.code}` : ''}</small></div><div className="work-notice-actions"><Button type="button" size="icon-sm" variant="ghost" aria-label={t('打开通知事项', 'Open notification subject')} onClick={() => notice.itemId ? onOpenItem(notice.itemId) : onOpenSubject(notice)}><ArrowUpRight size={15}/></Button>{!notice.readAt && settings.canEdit && <Button type="button" variant="ghost" size="icon-sm" disabled={busy} aria-label={t('标为已读', 'Mark read')} onClick={() => void markRead([notice.id])}><Check size={15}/></Button>}</div></article>)}{!loading && page?.total === 0 && <div className="work-tool-empty">{t('没有通知', 'No notifications')}</div>}{page?.nextCursor && <Button type="button" variant="ghost" size="sm" disabled={moreBusy || busy} onClick={() => void more()}>{t('加载更多', 'Load more')}</Button>}</> : <div className="work-tool-empty">{t('站内通知未启用', 'In-app notifications are off')}</div>}
    <section className="work-tool-section"><div className="work-tool-subhead"><h3>{t('空间故障', 'Space failures')}</h3><Button type="button" variant="outline" size="sm" disabled={!enabled || busy} onClick={() => void inspectFailures()}>{t('读取当前故障', 'Read current failures')}</Button></div>{summary && <div className="work-space-failures"><span>{t('定时生成：{count}', 'Recurring: {count}', { count: summary.spaceFailures.scheduleFailed })}</span><span>{t('自动化：{count}', 'Automation: {count}', { count: summary.spaceFailures.automationFailed })}</span><span>{t('执行失败：{count}', 'Failed executions: {count}', { count: summary.spaceFailures.executionFailed })}</span><span>{t('执行未知：{count}', 'Unknown executions: {count}', { count: summary.spaceFailures.executionUnknown })}</span></div>}</section>
  </div>}</section>
}
