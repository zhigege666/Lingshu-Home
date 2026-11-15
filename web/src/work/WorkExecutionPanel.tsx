import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ChevronDown, Play, Plus, RefreshCw } from 'lucide-react'
import { messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { formatUpdated } from '../core/presentation'
import { requestNavigation } from '../core/navigation'
import { newWorkId, workPath, type WorkItem } from '../core/work-types'
import type { WorkAutomationPage, WorkExecution } from '../core/work-automation-types'
import { Button } from '../components/ui/button'
import { ErrorMessage, Loading } from '../components/Shared'
import { executionStateLabel } from './work-automation-presentation'
import './work-automation.css'
import './work-tools.css'
const WorkExecutionEditor = lazy(() => import('./WorkExecutionEditor'))

export default function WorkExecutionPanel({ spaceId, item, enabled, disabled, itemDirty, onOpenItem }: { spaceId: string; item: WorkItem; enabled: boolean; disabled: boolean; itemDirty: boolean; onOpenItem: (id: string) => void }) {
  const [open, setOpen] = useState(false), [page, setPage] = useState<WorkAutomationPage<WorkExecution> | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [moreBusy, setMoreBusy] = useState(false), [selection, setSelection] = useState<{ id: string; create?: boolean } | null>(null)
  const token = useRef(0), pending = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; token.current++ } }, [])
  useEffect(() => {
    const run = ++token.current
    if (!open || !enabled) return
    const abort = new AbortController(); setLoading(true); setError('')
    request<WorkAutomationPage<WorkExecution>>(`${workPath(spaceId)}/executions?${new URLSearchParams({ itemId: item.id, limit: '20' })}`, { signal: abort.signal }).then(value => { if (!abort.signal.aborted && run === token.current) setPage(value) }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [spaceId, item.id, open, enabled, refresh])
  async function more() {
    if (!page?.nextCursor || pending.current) return
    const run = token.current; pending.current = true; setMoreBusy(true)
    try { const value = await request<WorkAutomationPage<WorkExecution>>(`${workPath(spaceId)}/executions?${new URLSearchParams({ itemId: item.id, limit: '20', cursor: page.nextCursor })}`); if (alive.current && run === token.current) setPage(old => old ? { ...value, items: [...old.items, ...value.items.filter(row => !old.items.some(item => item.id === row.id))] } : value) }
    catch (cause) { if (alive.current && run === token.current) setError(messageOf(cause)) }
    finally { pending.current = false; if (alive.current) setMoreBusy(false) }
  }
  return <section className="work-execution-panel"><button type="button" className="work-section-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}><Play size={15}/><span>{t('执行记录', 'Executions')}</span><ChevronDown size={15}/></button>{open && <div className="work-execution-panel-body"><div className="work-tool-subhead">{itemDirty && <small>{t('保存事项后可派发', 'Save the item before dispatching')}</small>}<span className="grow"/><Button type="button" variant="ghost" size="icon-sm" disabled={!enabled || loading} aria-label={t('刷新执行记录', 'Refresh executions')} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13}/></Button><Button type="button" variant="outline" size="sm" disabled={!enabled || disabled || itemDirty || !page?.canExecute || item.archived} onClick={() => requestNavigation(() => setSelection({ id: newWorkId(), create: true }))}><Plus size={13}/>{t('新建执行', 'New execution')}</Button></div><ErrorMessage error={error}/>{loading ? <Loading/> : <div className="work-inline-executions">{page?.items.map(value => <button type="button" key={value.id} onClick={() => setSelection({ id: value.id })}><span><strong>{value.executorName}</strong><small>{formatUpdated(value.createdAt)}</small></span><span className={`work-run-state is-${value.state}`}>{executionStateLabel(value.state)}</span></button>)}{page && !page.items.length && <p className="work-inline-note">{t('暂无执行记录', 'No execution records')}</p>}{page?.nextCursor && <Button type="button" variant="ghost" size="sm" disabled={moreBusy} onClick={() => void more()}>{t('加载更多', 'Load more')}</Button>}</div>}</div>}{selection && <Suspense fallback={<Loading/>}><WorkExecutionEditor key={selection.id} spaceId={spaceId} selection={selection} initialItem={item} enabled={enabled} canExecute={!!page?.canExecute} onClose={() => { setSelection(null); setRefresh(value => value + 1) }} onSaved={() => setRefresh(value => value + 1)} onOpenItem={id => { setSelection(null); onOpenItem(id) }}/></Suspense>}</section>
}
