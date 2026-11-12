import { useEffect, useRef, useState } from 'react'
import { Check, FileText, Link2, Search, X } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { workPath, type WorkReference } from '../core/work-types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { ErrorMessage, Loading } from '../components/Shared'

type Page = { items: WorkReference[]; nextCursor: string | null }
export default function ResourcePicker({ spaceId, selected, disabled, onToggle, onClose }: { spaceId: string; selected: WorkReference[]; disabled: boolean; onToggle: (item: WorkReference) => void; onClose: () => void }) {
  const [kind, setKind] = useState<'bookmark' | 'document'>('bookmark'), [query, setQuery] = useState(''), [search, setSearch] = useState('')
  const [page, setPage] = useState<Page>({ items: [], nextCursor: null }), [loading, setLoading] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const generation = useRef(0), active = useRef(true), loadingMore = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++ } }, [])
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    const abort = new AbortController(), token = ++generation.current
    setLoading(true); setError(''); setPage({ items: [], nextCursor: null }); loadingMore.current = false
    const parameters = new URLSearchParams({ kind, q: search, limit: '20' })
    request<Page>(`${workPath(spaceId)}/resources?${parameters}`, { signal: abort.signal }).then(value => { if (token === generation.current) setPage(value) })
      .catch(cause => { if (!abort.signal.aborted && token === generation.current) setError(messageOf(cause)) })
      .finally(() => { if (!abort.signal.aborted && token === generation.current) setLoading(false) })
    return () => abort.abort()
  }, [spaceId, kind, search, refresh])
  async function more() {
    if (!page.nextCursor || loadingMore.current) return
    const token = generation.current
    loadingMore.current = true; setLoading(true); setError('')
    try {
      const parameters = new URLSearchParams({ kind, q: search, limit: '20', cursor: page.nextCursor })
      const value = await request<Page>(`${workPath(spaceId)}/resources?${parameters}`)
      if (active.current && token === generation.current) setPage(previous => ({ ...value, items: [...previous.items, ...value.items.filter(item => !previous.items.some(old => old.id === item.id))] }))
    } catch (cause) { if (active.current && token === generation.current) setError(cause instanceof ApiError && cause.status === 409 ? t('资料已更新，请刷新搜索结果。', 'Resources changed. Refresh these results.') : messageOf(cause)) }
    finally { if (active.current && token === generation.current) { loadingMore.current = false; setLoading(false) } }
  }
  return <section className="work-resource-picker" aria-label={t('选择关联资料', 'Choose linked resources')}>
    <header><div className="work-view-toggle" role="group" aria-label={t('资料类型', 'Resource type')}><button type="button" aria-pressed={kind === 'bookmark'} onClick={() => setKind('bookmark')}><Link2 size={14}/>{t('书签', 'Bookmarks')}</button><button type="button" aria-pressed={kind === 'document'} onClick={() => setKind('document')}><FileText size={14}/>{t('文档', 'Documents')}</button></div><Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('关闭资料选择', 'Close resource picker')}><X size={15}/></Button></header>
    <label className="work-search"><Search size={16}/><Input type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label={t('搜索关联资料', 'Search linked resources')} placeholder={t('搜索标题', 'Search titles')}/></label>
    <ErrorMessage error={error}/>{error && <Button type="button" size="sm" variant="outline" onClick={() => setRefresh(value => value + 1)}>{t('刷新结果', 'Refresh results')}</Button>}
    <div className="work-resource-results">{page.items.map(item => { const checked = selected.some(value => value.kind === item.kind && value.id === item.id); return <button key={item.id} type="button" className={checked ? 'selected' : ''} aria-pressed={checked} disabled={disabled || (!checked && selected.filter(value => value.kind === item.kind).length >= 20)} onClick={() => onToggle(item)} data-work-resource-id={item.id}><span className="work-resource-check">{checked && <Check size={13}/>}</span>{kind === 'bookmark' ? <Link2 size={16}/> : <FileText size={16}/>}<span><strong>{item.title}</strong>{item.subtitle && <small>{item.subtitle}</small>}</span></button> })}{!loading && !page.items.length && !error && <p>{t('没有找到资料', 'No resources found')}</p>}</div>
    {loading && <Loading/>}{page.nextCursor && <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void more()}>{t('加载更多资料', 'Load more resources')}</Button>}
  </section>
}
