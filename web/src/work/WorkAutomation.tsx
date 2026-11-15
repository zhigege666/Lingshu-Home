import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Archive, ChevronRight, CirclePlay, ClipboardList, Radio, RefreshCw, Search, Server, Workflow, Plus } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { formatUpdated } from '../core/presentation'
import { notifyRouteCommitted, requestNavigation } from '../core/navigation'
import { newWorkId, workPath, type WorkProject, type WorkStatusDefinition } from '../core/work-types'
import type { WorkFeatureSettings } from '../core/work-planning-types'
import type { WorkAutomationTab, WorkAutomationRule, WorkAutomationEvent, WorkExecutorDefinition, WorkExecution, WorkAutomationPage } from '../core/work-automation-types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { ErrorMessage, Loading } from '../components/Shared'
import { workEventTypeLabel, automationEventStateLabel, executionStateLabel } from './work-automation-presentation'
import './work-automation.css'
import './work-tools.css'

const WorkAutomationRuleEditor = lazy(() => import('./WorkAutomationRuleEditor'))
const WorkAutomationEventEditor = lazy(() => import('./WorkAutomationEventEditor'))
const WorkExecutorEditor = lazy(() => import('./WorkExecutorEditor'))
const WorkExecutionEditor = lazy(() => import('./WorkExecutionEditor'))
type Entry = WorkAutomationRule | WorkAutomationEvent | WorkExecutorDefinition | WorkExecution
function readRoute(route: string) {
  const query = new URLSearchParams(route.split('?')[1] || ''), value = query.get('automation'), tab: WorkAutomationTab = value === 'events' || value === 'executors' || value === 'executions' ? value : 'rules'
  return { tab, selection: query.get('automationId') ? { id: query.get('automationId')! } : null }
}
export default function WorkAutomation({ spaceId, route, enabled, documentsEnabled, projects, statuses, defaultStatus, refresh: outerRefresh, onOpenItem, onNotice }: { spaceId: string; route: string; enabled: boolean; documentsEnabled: boolean; projects: WorkProject[]; statuses: WorkStatusDefinition[]; defaultStatus: string; refresh: number; onOpenItem: (id: string) => void; onNotice: (message: string) => void }) {
  const initial = useRef(readRoute(route)), [tab, setTab] = useState<WorkAutomationTab>(initial.current.tab), [selection, setSelection] = useState<{ id: string; create?: boolean } | null>(initial.current.selection)
  const [settings, setSettings] = useState<WorkFeatureSettings | null>(null), [page, setPage] = useState<WorkAutomationPage<Entry> | null>(null), [settingsBusy, setSettingsBusy] = useState(false), [loading, setLoading] = useState(false), [moreBusy, setMoreBusy] = useState(false)
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [archived, setArchived] = useState(false), [state, setState] = useState(''), [error, setError] = useState(''), [settingsError, setSettingsError] = useState(''), [refresh, setRefresh] = useState(0), [settingsRefresh, setSettingsRefresh] = useState(0)
  const generation = useRef(0), alive = useRef(true), paging = useRef(false), settingsPending = useRef(false), previousRoute = useRef(route), previousQuery = useRef('')
  const base = workPath(spaceId), endpoint = `${base}/${tab === 'rules' || tab === 'events' ? 'automation/' : ''}${tab}`
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    if (previousRoute.current === route) return
    previousRoute.current = route; const next = readRoute(route)
    if (next.tab !== tab) { setPage(null); setQuery(''); setSearch(''); setState(''); setArchived(false) }
    setTab(next.tab); setSelection(next.selection)
  }, [route])
  function navigate(nextTab: WorkAutomationTab, next: { id: string; create?: boolean } | null = null) {
    if (nextTab !== tab) { setPage(null); setQuery(''); setSearch(''); setState(''); setArchived(false) }
    setTab(nextTab); setSelection(next)
    const query = new URLSearchParams(window.location.hash.split('?')[1] || ''); query.set('view', 'board'); query.set('space', spaceId); query.set('tab', 'automation'); query.set('automation', nextTab); query.delete('item'); query.delete('schedule'); query.delete('new')
    if (next && !next.create) query.set('automationId', next.id); else query.delete('automationId')
    const nextRoute = `/library?${query}`; previousRoute.current = nextRoute
    if (window.location.hash !== `#${nextRoute}`) { window.history.replaceState(null, '', window.location.pathname + window.location.search + '#' + nextRoute); notifyRouteCommitted() }
  }
  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController(); setSettingsError('')
    request<WorkFeatureSettings>(`${base}/automation/settings`, { signal: abort.signal }).then(value => { if (!abort.signal.aborted) setSettings(value) }).catch(cause => { if (!abort.signal.aborted) setSettingsError(messageOf(cause)) })
    return () => abort.abort()
  }, [base, enabled, settingsRefresh, outerRefresh])
  function params(cursor?: string) {
    const query = new URLSearchParams({ limit: '30' })
    if (tab === 'rules' || tab === 'executors') { query.set('archived', String(archived)); if (search) query.set('q', search) }
    else { if (state) query.set('state', state); if (search) query.set(tab === 'events' ? 'eventType' : 'itemId', search) }
    if (cursor) query.set('cursor', cursor)
    return query
  }
  useEffect(() => {
    const token = ++generation.current
    if (!enabled) { setLoading(false); return }
    const abort = new AbortController(), key = `${endpoint}?${params()}`, changed = previousQuery.current !== key
    previousQuery.current = key
    if (changed) setPage(null)
    setLoading(true); setError('')
    request<WorkAutomationPage<Entry>>(key, { signal: abort.signal }).then(value => { if (!abort.signal.aborted && token === generation.current) setPage(value) }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [endpoint, enabled, archived, search, state, refresh, outerRefresh])
  useEffect(() => {
    if (!enabled || selection || error || loading || !page || page.items.length > 30) return
    const active = tab === 'executions' && page.items.some(row => 'state' in row && ['queued', 'dispatching', 'running'].includes(row.state)) || tab === 'events' && settings?.enabled && page.items.some(row => 'state' in row && row.state === 'queued')
    if (!active) return
    const timer = setTimeout(() => { if (document.visibilityState === 'visible') setRefresh(value => value + 1) }, 5000)
    const visible = () => { if (document.visibilityState === 'visible') setRefresh(value => value + 1) }
    document.addEventListener('visibilitychange', visible)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [page, enabled, tab, settings?.enabled, selection, loading, error])
  async function toggleSettings() {
    if (!settings?.canEdit || !enabled || settingsPending.current) return
    const intended = !settings.enabled; settingsPending.current = true; setSettingsBusy(true); setSettingsError('')
    try { const value = await request<WorkFeatureSettings>(`${base}/automation/settings`, { method: 'PATCH', body: { expectedRevision: settings.revision, enabled: intended } }); if (alive.current) { setSettings(value); onNotice(intended ? t('事件规则已启用', 'Event rules enabled') : t('事件规则已关闭', 'Event rules disabled')) } }
    catch (cause) {
      if (!alive.current) return
      if (!(cause instanceof ApiError) || cause.status >= 500 || cause.status === 409) {
        try { const value = await request<WorkFeatureSettings>(`${base}/automation/settings`); if (alive.current) { setSettings(value); if (value.enabled !== intended) setSettingsError(t('设置已有变化，已显示当前值。', 'Settings changed; the current value is shown.')) } }
        catch (readError) { if (alive.current) setSettingsError(messageOf(readError)) }
      } else setSettingsError(messageOf(cause))
    } finally { settingsPending.current = false; if (alive.current) setSettingsBusy(false) }
  }
  async function more() {
    if (!page?.nextCursor || paging.current) return
    const token = generation.current; paging.current = true; setMoreBusy(true)
    try { const data = await request<WorkAutomationPage<Entry>>(`${endpoint}?${params(page.nextCursor)}`); if (alive.current && token === generation.current) setPage(old => old ? { ...data, items: [...old.items, ...data.items.filter(row => !old.items.some(value => value.id === row.id))] } : data) }
    catch (cause) { if (alive.current && token === generation.current) setError(messageOf(cause)) }
    finally { paging.current = false; if (alive.current) setMoreBusy(false) }
  }
  function saved(value: Entry) { navigate(tab, { id: value.id }); setRefresh(current => current + 1) }
  const tabs: { id: WorkAutomationTab; name: string; icon: typeof Workflow }[] = [{ id: 'rules', name: t('规则', 'Rules'), icon: Workflow }, { id: 'events', name: t('事件', 'Events'), icon: Radio }, { id: 'executors', name: t('执行器', 'Executors'), icon: Server }, { id: 'executions', name: t('执行记录', 'Executions'), icon: ClipboardList }]
  const createLabel = ({ rules: t('新建规则', 'New rule'), events: t('发布事件', 'Publish event'), executors: t('新建执行器', 'New executor'), executions: t('新建执行', 'New execution') })[tab]
  const canCreate = enabled && !settingsBusy && (tab === 'executions' ? !!page?.canExecute : tab === 'events' ? !!page?.canEdit && !!settings?.enabled : !!page?.canEdit && (tab !== 'rules' || (!!defaultStatus && statuses.length > 0)))
  function row(entry: Entry) {
    if (tab === 'rules') { const value = entry as WorkAutomationRule; return <><Workflow size={17}/><div><strong>{value.name}</strong><small>{workEventTypeLabel(value.eventType)}{value.executorId ? ` · ${t('生成并执行', 'Create and execute')}` : ''}</small></div><span className={`work-run-state ${value.enabled && !value.archived ? 'is-enabled' : ''}`}>{value.archived ? t('已归档', 'Archived') : value.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}</span></> }
    if (tab === 'events') { const value = entry as WorkAutomationEvent; return <><Radio size={17}/><div><strong>{value.payload.summary}</strong><small>{workEventTypeLabel(value.eventType)} · {formatUpdated(value.createdAt)}</small></div><span className={`work-run-state is-${value.state}`}>{automationEventStateLabel(value.state)}</span></> }
    if (tab === 'executors') { const value = entry as WorkExecutorDefinition; return <><Server size={17}/><div><strong>{value.name}</strong><small>{value.resourceKey} · {value.endpoint}</small></div><span className={`work-run-state ${value.enabled && !value.archived ? 'is-enabled' : ''}`}>{value.archived ? t('已归档', 'Archived') : value.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}</span></> }
    const value = entry as WorkExecution; return <><CirclePlay size={17}/><div><strong>{value.executorName}</strong><small>{value.resourceKey} · {formatUpdated(value.createdAt)}</small>{value.message && <small className="work-auto-row-message">{value.message}</small>}</div><span className={`work-run-state is-${value.state}`}>{executionStateLabel(value.state)}</span></>
  }
  return <section className="work-automation" aria-label={t('自动化', 'Automation')}><header className="work-auto-heading"><h2>{t('自动化', 'Automation')}</h2><span className="grow"/>{settings && <label className="work-feature-switch"><input data-auto-enabled type="checkbox" checked={settings.enabled} disabled={!enabled || !settings.canEdit || settingsBusy} onChange={() => void toggleSettings()}/>{t('事件规则', 'Event rules')}</label>}<Button type="button" variant="ghost" size="icon-sm" disabled={!enabled || loading || settingsBusy} aria-label={t('刷新自动化', 'Refresh automation')} onClick={() => { setRefresh(value => value + 1); setSettingsRefresh(value => value + 1) }}><RefreshCw size={16}/></Button></header><ErrorMessage error={settingsError}/><div className="work-auto-tabs" role="group" aria-label={t('自动化页面', 'Automation sections')}>{tabs.map(value => <button type="button" key={value.id} data-automation-tab={value.id} aria-pressed={tab === value.id} onClick={() => requestNavigation(() => navigate(value.id))}><value.icon size={15}/>{value.name}</button>)}</div><div className="work-auto-layout"><section className="work-auto-list"><div className="work-auto-toolbar"><label className="work-auto-search"><Search size={14}/><Input type="search" value={query} aria-label={tab === 'events' ? t('筛选事件类型', 'Filter event type') : tab === 'executions' ? t('筛选事项编号', 'Filter item key') : t('搜索名称', 'Search name')} placeholder={tab === 'events' ? 'sync.requested' : tab === 'executions' ? 'W-123' : t('搜索名称', 'Search name')} onChange={event => setQuery(event.target.value)}/></label>{tab === 'rules' || tab === 'executors' ? <label className="work-feature-switch"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)}/><Archive size={14}/>{t('已归档', 'Archived')}</label> : <select className="work-native-select" aria-label={t('筛选处理状态', 'Filter processing state')} value={state} onChange={event => setState(event.target.value)}><option value="">{t('全部状态', 'All states')}</option>{(tab === 'events' ? ['queued', 'processed', 'failed', 'skipped'] : ['queued', 'dispatching', 'running', 'succeeded', 'failed', 'unknown', 'canceled']).map(value => <option key={value} value={value}>{tab === 'events' ? automationEventStateLabel(value as WorkAutomationEvent['state']) : executionStateLabel(value as WorkExecution['state'])}</option>)}</select>}<span className="grow"/><Button type="button" size="sm" disabled={!canCreate} onClick={() => requestNavigation(() => navigate(tab, { id: newWorkId(), create: true }))}><Plus size={14}/>{createLabel}</Button></div><ErrorMessage error={error}/><div className="work-auto-rows">{!page && loading ? <Loading/> : page?.items.map(entry => <button type="button" key={entry.id} data-automation-id={entry.id} className={selection?.id === entry.id ? 'is-selected' : ''} onClick={() => requestNavigation(() => navigate(tab, { id: entry.id }))}>{row(entry)}<ChevronRight size={14}/></button>)}{!loading && page && !page.items.length && <div className="work-tool-empty">{t('暂无记录', 'No records')}</div>}{page?.nextCursor && <Button type="button" variant="ghost" size="sm" disabled={moreBusy} onClick={() => void more()}>{t('加载更多', 'Load more')}</Button>}</div></section>{selection && <Suspense fallback={<Loading/>}>{tab === 'rules' ? <WorkAutomationRuleEditor key={selection.id} spaceId={spaceId} selection={selection} enabled={enabled} canEdit={!!page?.canEdit} canExecute={!!page?.canExecute} documentsEnabled={documentsEnabled} projects={projects} statuses={statuses} defaultStatus={defaultStatus} onClose={() => navigate(tab)} onSaved={saved}/> : tab === 'events' ? <WorkAutomationEventEditor key={selection.id} spaceId={spaceId} selection={selection} enabled={enabled} automationEnabled={!!settings?.enabled} canEdit={!!page?.canEdit} projects={projects} statuses={statuses} onClose={() => navigate(tab)} onSaved={saved} onOpenItem={id => requestNavigation(() => onOpenItem(id))} onOpenRule={id => requestNavigation(() => navigate('rules', { id }))} onOpenExecution={id => requestNavigation(() => navigate('executions', { id }))}/> : tab === 'executors' ? <WorkExecutorEditor key={selection.id} spaceId={spaceId} selection={selection} enabled={enabled} canEdit={!!page?.canEdit} onClose={() => navigate(tab)} onSaved={saved}/> : <WorkExecutionEditor key={selection.id} spaceId={spaceId} selection={selection} enabled={enabled} canExecute={!!page?.canExecute} onClose={() => navigate(tab)} onSaved={saved} onOpenItem={id => requestNavigation(() => onOpenItem(id))}/>}</Suspense>}</div></section>
}
