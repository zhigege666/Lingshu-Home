import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import { messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { workPath, type WorkItem, type WorkPage } from '../core/work-types'
import type { WorkAutomationPage, WorkExecutorDefinition, WorkExecutorResponse, WorkExecutionState } from '../core/work-automation-types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { ErrorMessage, Loading } from '../components/Shared'



export function WorkExecutorPicker({ spaceId, executorId, enabled, disabled, onChange }: { spaceId: string; executorId: string | null; enabled: boolean; disabled?: boolean; onChange: (value: WorkExecutorDefinition | null) => void }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [search, setSearch] = useState(''), [selected, setSelected] = useState<WorkExecutorDefinition | null>(null), [page, setPage] = useState<WorkAutomationPage<WorkExecutorDefinition> | null>(null), [loading, setLoading] = useState(false), [moreBusy, setMoreBusy] = useState(false), [error, setError] = useState('')
  const generation = useRef(0), alive = useRef(true), pending = useRef(false), base = `${workPath(spaceId)}/executors`
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    if (!enabled || !executorId) { setSelected(null); return }
    const abort = new AbortController(); setError('')
    request<WorkExecutorResponse>(`${base}/${encodeURIComponent(executorId)}`, { signal: abort.signal }).then(value => { if (!abort.signal.aborted) setSelected(value.executor) }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) })
    return () => abort.abort()
  }, [base, executorId, enabled])
  useEffect(() => {
    const token = ++generation.current
    if (!enabled || !open) return
    const abort = new AbortController(); setLoading(true); setError('')
    request<WorkAutomationPage<WorkExecutorDefinition>>(`${base}?${new URLSearchParams({ archived: 'false', q: search, limit: '30' })}`, { signal: abort.signal }).then(value => { if (!abort.signal.aborted && token === generation.current) setPage(value) }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [base, enabled, open, search])
  async function more() {
    if (!page?.nextCursor || pending.current) return
    pending.current = true; setMoreBusy(true); const token = generation.current
    try { const value = await request<WorkAutomationPage<WorkExecutorDefinition>>(`${base}?${new URLSearchParams({ archived: 'false', q: search, limit: '30', cursor: page.nextCursor })}`); if (alive.current && token === generation.current) setPage(old => old ? { ...value, items: [...old.items, ...value.items.filter(row => !old.items.some(item => item.id === row.id))] } : value) }
    catch (cause) { if (alive.current && token === generation.current) setError(messageOf(cause)) }
    finally { pending.current = false; if (alive.current) setMoreBusy(false) }
  }
  return <div className="work-executor-picker"><div className="work-selected-values"><Button type="button" variant="outline" size="sm" disabled={disabled || !enabled} aria-expanded={open} onClick={() => setOpen(value => !value)}>{selected?.name || (executorId ? t('读取执行器…', 'Loading executor…') : t('选择执行器', 'Choose executor'))}<ChevronDown size={13}/></Button>{executorId && <Button type="button" variant="ghost" size="icon-sm" disabled={disabled || !enabled} aria-label={t('移除执行器', 'Remove executor')} onClick={() => { onChange(null); setSelected(null) }}><X size={13}/></Button>}</div>{selected && <small className="work-inline-note">{selected.resourceKey} · {selected.enabled && !selected.archived ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}</small>}<ErrorMessage error={error}/>{open && <div className="work-picker-panel"><Input type="search" aria-label={t('搜索执行器', 'Search executors')} value={query} onChange={event => setQuery(event.target.value)}/>{loading ? <Loading/> : <div className="work-picker-options">{page?.items.map(row => <button type="button" key={row.id} onClick={() => { onChange(row); setSelected(row); setOpen(false) }}><span>{row.name}<small>{row.resourceKey}{!row.enabled ? ` · ${t('已停用', 'Disabled')}` : ''}</small></span>{row.id === executorId && <Check size={14}/>}</button>)}{page && !page.items.length && <p>{t('暂无执行器', 'No executors')}</p>}</div>}{page?.nextCursor && <Button type="button" variant="ghost" size="sm" disabled={moreBusy} onClick={() => void more()}>{t('加载更多', 'Load more')}</Button>}</div>}</div>
}

export function WorkItemSelector({ spaceId, enabled, value, disabled, onChange }: { spaceId: string; enabled: boolean; value: WorkItem | null; disabled?: boolean; onChange: (value: WorkItem | null) => void }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [page, setPage] = useState<WorkPage | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [reading, setReading] = useState(false)
  const generation = useRef(0), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])
  useEffect(() => {
    if (!open || !enabled) return
    const token = ++generation.current, abort = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true); setError(''); const params = new URLSearchParams({ archived: 'false', limit: '20' }), trimmed = query.trim()
      if (trimmed) params.set('q', trimmed)
      request<WorkPage>(`${workPath(spaceId)}/items?${params}`, { signal: abort.signal }).then(data => { if (!abort.signal.aborted && generation.current === token) setPage(data) }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    }, 200)
    return () => { clearTimeout(timer); abort.abort() }
  }, [spaceId, enabled, open, query])
  async function choose(id: string) {
    if (reading) return
    setReading(true); setError(''); const token = ++generation.current
    try { const item = await request<WorkItem>(`${workPath(spaceId)}/items/${encodeURIComponent(id)}`); if (alive.current && generation.current === token) { onChange(item); setOpen(false) } }
    catch (cause) { if (alive.current) setError(messageOf(cause)) }
    finally { if (alive.current) setReading(false) }
  }
  return <div><div className="work-selected-values"><Button type="button" variant="outline" size="sm" disabled={!enabled || disabled} aria-expanded={open} onClick={() => setOpen(current => !current)}>{value ? `${value.id} ${value.title}` : t('选择事项', 'Choose item')}<ChevronDown size={13}/></Button>{value && <Button type="button" size="icon-sm" variant="ghost" disabled={disabled} aria-label={t('清除事项', 'Clear item')} onClick={() => onChange(null)}><X size={13}/></Button>}</div><ErrorMessage error={error}/>{open && <div className="work-picker-panel"><label className="work-picker-search"><Search size={13}/><Input type="search" aria-label={t('搜索标题或事项编号', 'Search title or item ID')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('标题或 0000a', 'Title or 0000a')}/></label>{loading || reading ? <Loading/> : <div className="work-picker-options">{page?.items.map(row => <button type="button" key={row.id} onClick={() => void choose(row.id)}><small>{row.id}</small><span>{row.title}</span></button>)}{page && !page.items.length && <p>{t('没有匹配事项', 'No matching items')}</p>}{page?.nextCursor && <p>{t('请继续输入以缩小搜索范围。', 'Type more to narrow the search.')}</p>}</div>}</div>}</div>
}
