import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ChevronDown, ChevronRight, Clock3, FileText, Folder, FolderOpen, Home, Link2, LockKeyhole, LogOut, Plus, RefreshCw, Search, Settings2, Star, X } from 'lucide-react'
import { messageOf, request } from '../core/api'
import { getLocale, t } from '../core/i18n'
import { requestNavigation } from '../core/navigation'
import { formatUpdated } from '../core/presentation'
import type { Bootstrap, Dashboard, Dataset, NavigationData } from '../core/types'
import type { DocumentPage, DocumentSource, DocumentSourceList, LibraryBookmark, LibraryDocument, LibraryItem } from '../core/library-types'
import { ProjectLogo } from '../components/ProjectLogo'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { StyledSelect } from '../components/ui/select'
import { SpacePreferenceMenu } from '../components/SpacePreferenceMenu'
import { Empty, ErrorMessage, Loading } from '../components/Shared'
import { BookmarkPanel, DocumentPanel, NewDocumentDialog } from './Panels'
import './library.css'

type Props = { bootstrap: Bootstrap; dashboard: Dashboard; documentId?: string; onHome: () => void; onManage: () => void; onLogin: () => void; onLogout: () => Promise<void>; onSpaceChange: (id: string) => void }
type Selection = { kind: 'bookmark' | 'document'; id: string }
type FolderNode = { path: string; name: string; children: Map<string, FolderNode> }
function folderTree(documents: LibraryDocument[], sourceId: string): FolderNode[] {
  const root: FolderNode = { name: '', path: '', children: new Map() }
  for (const document of documents.filter(item => item.sourceId === sourceId)) {
    let cursor = root, path = ''
    for (const segment of document.relativePath.split('/').slice(0, -1)) {
      path = path ? `${path}/${segment}` : segment
      if (!cursor.children.has(segment)) cursor.children.set(segment, { name: segment, path, children: new Map() })
      cursor = cursor.children.get(segment)!
    }
  }
  return [...root.children.values()]
}
function FolderBranch({ nodes, active, onSelect, depth = 0 }: { nodes: FolderNode[]; active: string; onSelect: (path: string) => void; depth?: number }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  return <ul className="library-folder-tree">{nodes.sort((a, b) => a.name.localeCompare(b.name, getLocale())).map(node => <li key={node.path}>
    <div className={`library-tree-line ${active === node.path ? 'active' : ''}`} style={{ paddingLeft: Math.min(depth, 8) * 12 }}>
      {node.children.size > 0 ? <button type="button" className="library-tree-toggle" aria-expanded={expanded.has(node.path)} aria-label={t('展开或收起 {name}', 'Expand or collapse {name}', { name: node.name })} onClick={() => setExpanded(current => { const next = new Set(current); next.has(node.path) ? next.delete(node.path) : next.add(node.path); return next })}>{expanded.has(node.path) ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button> : <span className="library-tree-spacer"/>}
      <button type="button" onClick={() => onSelect(node.path)} aria-current={active === node.path ? 'true' : undefined}><Folder size={15}/><span title={node.path}>{node.name}</span></button>
    </div>
    {expanded.has(node.path) && <FolderBranch nodes={[...node.children.values()]} active={active} onSelect={onSelect} depth={depth + 1}/>}
  </li>)}</ul>
}

export default function LibraryView({ bootstrap, dashboard, documentId, onHome, onManage, onLogin, onLogout, onSpaceChange }: Props) {
  const space = dashboard.space, identity = `${bootstrap.user?.id || 'visitor'}:${space.id}`
  const [sources, setSources] = useState<DocumentSource[]>([]), [bookmarks, setBookmarks] = useState<LibraryBookmark[]>([])
  const [documents, setDocuments] = useState<LibraryDocument[]>([]), [total, setTotal] = useState(0)
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [kind, setKind] = useState<'all' | 'bookmark' | 'document'>('all')
  const [section, setSection] = useState<'all' | 'recent' | 'favorites'>('all'), [sourceId, setSourceId] = useState(''), [folder, setFolder] = useState('')
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set())
  const [selection, setSelection] = useState<Selection | null>(documentId ? { kind: 'document', id: documentId } : null), [expandedPreview, setExpandedPreview] = useState(false)
  const [newDocument, setNewDocument] = useState(false), [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [refreshKey, setRefreshKey] = useState(0)
  const requestGeneration = useRef(0)
  const canWrite = !!bootstrap.user && space.canEdit
  const canManage = bootstrap.user?.role === 'Owner'
  useEffect(() => {
    if (documentId) { setSelection({ kind: 'document', id: documentId }); setExpandedPreview(false) }
  }, [documentId])
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer) }, [query])
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6500); return () => clearTimeout(timer) }, [notice])
  useEffect(() => {
    const abort = new AbortController()
    request<Dataset<NavigationData>>(`/spaces/${space.id}/navigation`, { signal: abort.signal }).then(value => setBookmarks(value.data.links)).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) })
    if (bootstrap.user) request<DocumentSourceList>(`/spaces/${space.id}/document-sources`, { signal: abort.signal }).then(value => setSources(value.items)).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) })
    return () => abort.abort()
  }, [identity, refreshKey])
  useEffect(() => {
    const abort = new AbortController(), generation = ++requestGeneration.current
    setLoading(true); setError(''); setLoadingMore(false)
    const parameters = new URLSearchParams({ q: search, limit: '500', offset: '0' })
    if (sourceId) parameters.set('sourceId', sourceId)
    request<DocumentPage>(`/spaces/${space.id}/documents?${parameters}`, { signal: abort.signal }).then(value => {
      if (generation === requestGeneration.current) { setDocuments(value.items); setTotal(value.total) }
    }).catch(cause => { if (!abort.signal.aborted) { setDocuments([]); setTotal(0); setError(messageOf(cause)) } }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [identity, sourceId, search, refreshKey])
  async function loadMore() {
    if (loadingMore || documents.length >= total) return
    const generation = requestGeneration.current
    setLoadingMore(true); setError('')
    const parameters = new URLSearchParams({ q: search, limit: '500', offset: String(documents.length) })
    if (sourceId) parameters.set('sourceId', sourceId)
    try {
      const value = await request<DocumentPage>(`/spaces/${space.id}/documents?${parameters}`)
      if (generation === requestGeneration.current) { setDocuments(current => [...current, ...value.items.filter(item => !current.some(old => old.id === item.id))]); setTotal(value.total) }
    } catch (cause) { if (generation === requestGeneration.current) setError(messageOf(cause)) }
    finally { if (generation === requestGeneration.current) setLoadingMore(false) }
  }
  const filteredBookmarks = useMemo(() => {
    const normalized = search.toLocaleLowerCase(getLocale())
    return bookmarks.filter(item => !normalized || `${item.title} ${item.url} ${item.description} ${item.contextMarkdown || ''} ${item.tags.join(' ')}`.toLocaleLowerCase(getLocale()).includes(normalized))
      .filter(item => section !== 'favorites' || item.isFavorite)
  }, [bookmarks, search, section])
  const items = useMemo(() => {
    const result: LibraryItem[] = []
    if (kind !== 'document' && !sourceId) result.push(...filteredBookmarks.map(bookmark => ({ kind: 'bookmark' as const, bookmark })))
    if (kind !== 'bookmark' && section !== 'favorites') result.push(...documents.filter(item => !folder || item.relativePath.startsWith(`${folder}/`)).map(document => ({ kind: 'document' as const, document })))
    return result.sort((a, b) => {
      const left = a.kind === 'document' ? a.document : a.bookmark, right = b.kind === 'document' ? b.document : b.bookmark
      return (right.updatedAt || '').localeCompare(left.updatedAt || '') || left.title.localeCompare(right.title, getLocale())
    })
  }, [documents, filteredBookmarks, kind, section, sourceId, folder])
  const selectedBookmark = selection?.kind === 'bookmark' ? bookmarks.find(item => item.id === selection.id) : undefined
  const source = sources.find(item => item.id === sourceId), defaultSource = sources.find(item => item.defaultWrite && item.enabled)
  const refresh = useCallback(() => setRefreshKey(current => current + 1), [])
  const select = (next: Selection | null) => requestNavigation(() => { setSelection(next); setExpandedPreview(false) })
  function pickSection(next: typeof section) { setSection(next); setSourceId(''); setFolder(''); if (next === 'favorites') setKind('bookmark') }
  function pickSource(id: string, path = '') { setSourceId(id); setFolder(path); setSection('all'); setKind('document') }
  async function openDocumentLink(id: string, path: string) {
    try {
      const parameters = new URLSearchParams({ sourceId: id, relativePath: path, limit: '1' })
      const value = await request<DocumentPage>(`/spaces/${space.id}/documents?${parameters}`)
      if (!value.items.length) throw new Error(t('链接的文档不存在，或当前账号没有访问权限。', 'The linked document does not exist or is not accessible to this account.'))
      select({ kind: 'document', id: value.items[0]!.id })
    } catch (cause) { setError(messageOf(cause)) }
  }
  const visibleSources = sources.filter(item => item.enabled && item.status !== 'detached')
  return <div className={`admin-ui library-shell ${selection ? 'has-preview' : ''} ${expandedPreview ? 'preview-expanded' : ''}`}>
    <header className="library-topbar">
      <a className="library-brand" href="#/" onClick={event => { event.preventDefault(); onHome() }}><ProjectLogo size={33}/><strong>{bootstrap.siteName || 'Lingshu-Home'}</strong></a>
      <nav className="library-primary-nav" aria-label={t('主要导航', 'Primary navigation')}><button onClick={onHome}><Home size={18}/><span>{t('导航', 'Home')}</span></button><span aria-current="page"><BookOpen size={18}/>{t('资料库', 'Library')}</span></nav>
      <label className="library-search"><Search size={18}/><Input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜索书签、文档与说明', 'Search bookmarks, documents and notes')} aria-label={t('搜索资料库', 'Search library')}/></label>
      <div className="library-account"><div className="library-space"><StyledSelect value={space.id} onValueChange={id => requestNavigation(() => onSpaceChange(id))} aria-label={t('选择空间', 'Choose a space')} options={bootstrap.spaces.map(item => ({ value: item.id, label: item.name }))}/><SpacePreferenceMenu bootstrap={bootstrap}/></div>{bootstrap.user ? <Button variant="ghost" size="icon" title={t('退出登录', 'Sign out')} aria-label={t('退出登录', 'Sign out')} onClick={() => requestNavigation(() => { void onLogout() })}><span className="library-avatar">{(bootstrap.user.displayName || bootstrap.user.username).slice(0, 1).toUpperCase()}</span><LogOut size={13}/></Button> : <Button variant="outline" onClick={onLogin}>{t('登录', 'Sign in')}</Button>}<Button variant="ghost" size="icon" aria-label={t('管理面板', 'Administration')} title={t('管理面板', 'Administration')} onClick={onManage}><Settings2 size={19}/></Button></div>
    </header>
    <aside className="library-sidebar" aria-label={t('资料库筛选', 'Library filters')}>
      <nav className="library-sections">
        <button className={section === 'all' && !sourceId ? 'active' : ''} onClick={() => pickSection('all')}><FolderOpen size={19}/>{t('全部资料', 'All resources')}</button>
        <button className={section === 'recent' ? 'active' : ''} onClick={() => { pickSection('recent'); setKind('all') }}><Clock3 size={19}/>{t('最近更新', 'Recently updated')}</button>
        <button className={section === 'favorites' ? 'active' : ''} onClick={() => pickSection('favorites')}><Star size={19}/>{t('收藏书签', 'Favorite bookmarks')}</button>
      </nav>
      <div className="library-sources-heading"><h2>{t('文档目录', 'Document directories')}</h2>{canManage && <button aria-label={t('管理目录', 'Manage directories')} title={t('管理目录', 'Manage directories')} onClick={onManage}><Settings2 size={15}/></button>}</div>
      {visibleSources.map(item => <div className="library-source" key={item.id}>
        <div className={`library-source-line ${sourceId === item.id && !folder ? 'active' : ''}`}><button className="library-tree-toggle" aria-label={t('展开或收起 {name}', 'Expand or collapse {name}', { name: item.name })} aria-expanded={expandedSources.has(item.id)} onClick={() => setExpandedSources(current => { const next = new Set(current); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next })}>{expandedSources.has(item.id) ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button><button className="library-source-select" onClick={() => pickSource(item.id)}><Folder size={18}/><span title={item.name}>{item.name}</span><small className={item.readOnly ? 'is-readonly' : ''}>{item.readOnly ? t('只读', 'Read only') : t('读写', 'Writable')}</small></button></div>
        {expandedSources.has(item.id) && <FolderBranch nodes={folderTree(documents, item.id)} active={sourceId === item.id ? folder : ''} onSelect={path => pickSource(item.id, path)}/>}
        {['offline', 'error'].includes(item.status) && <p className="library-source-warning">{t('目录暂不可用', 'Directory unavailable')}</p>}
      </div>)}
      {!visibleSources.length && <p className="library-sidebar-hint">{bootstrap.user ? t('接入已有 Markdown 目录，让书签和文档一起管理。', 'Connect Markdown directories to manage documents alongside bookmarks.') : t('这里展示已发布的共享文档。', 'Published shared documents appear here.')}</p>}
      <footer><LockKeyhole size={14}/>{space.kind === 'personal' ? t('仅当前账号可见', 'Visible only to this account') : t('文档需单独发布', 'Documents are published individually')}</footer>
    </aside>
    <main className="library-content" id="main-content">
      <div className="library-heading"><div><h1>{source?.name || t('资料库', 'Library')}</h1><p>{folder || (section === 'favorites' ? t('常用书签，随时查阅说明。', 'Your favorite bookmarks and their usage notes.') : t('书签与原始 Markdown，集中查阅与维护。', 'Browse and maintain bookmarks and original Markdown files.'))}</p></div><div className="library-create-actions">{canWrite && <Button onClick={() => requestNavigation(() => setNewDocument(true))}><Plus size={16}/>{t('新建文档', 'New document')}</Button>}{canManage && <Button variant="outline" onClick={onManage}><Folder size={16}/>{t('管理目录', 'Manage directories')}</Button>}<Button variant="ghost" size="icon" disabled={loading} onClick={refresh} aria-label={t('刷新资料库', 'Refresh library')}><RefreshCw size={17}/></Button>{canWrite && <small>{defaultSource ? t('默认保存：{name}', 'Default directory: {name}', { name: defaultSource.name }) : t('新建时选择保存目录', 'Choose a directory when creating')}</small>}</div></div>
      <div className="library-filters"><div role="group" aria-label={t('资料类型', 'Resource type')}>{(['all', 'bookmark', 'document'] as const).map(value => <button key={value} type="button" className={kind === value ? 'active' : ''} onClick={() => { setKind(value); if (value !== 'document') { setSourceId(''); setFolder('') }; if (value !== 'bookmark' && section === 'favorites') setSection('all') }}>{value === 'all' ? t('全部', 'All') : value === 'bookmark' ? t('书签', 'Bookmarks') : t('文档', 'Documents')}</button>)}</div><span>{t('按更新时间排序', 'Sorted by last update')}</span>{!!visibleSources.length && <label className="library-mobile-source"><span>{t('目录', 'Directory')}</span><StyledSelect aria-label={t('筛选文档目录', 'Filter document directory')} value={sourceId || 'all'} onValueChange={value => { if (value === 'all') { setSourceId(''); setFolder('') } else pickSource(value) }} options={[{ value: 'all', label: t('全部目录', 'All directories') }, ...visibleSources.map(item => ({ value: item.id, label: item.name }))]}/></label>}{sourceId && <button className="library-clear-filter" onClick={() => { setSourceId(''); setFolder('') }}>{t('清除目录筛选', 'Clear directory filter')}<X size={13}/></button>}</div>
      <ErrorMessage error={error}/>{notice && <p className="admin-info" role="status">{notice}</p>}
      {loading ? <Loading text={t('正在读取资料库…', 'Loading library…')}/> : items.length ? <div className="library-list-scroll" role="region" aria-label={t('资料列表', 'Resources')} tabIndex={0}><table className="library-table"><thead><tr><th>{t('名称', 'Name')}</th><th>{t('来源', 'Source')}</th><th>{t('更新', 'Updated')}</th></tr></thead><tbody>{items.map(item => {
        const value = item.kind === 'document' ? item.document : item.bookmark, active = selection?.kind === item.kind && selection.id === value.id
        return <tr key={`${item.kind}:${value.id}`} className={active ? 'active' : ''} onClick={() => select({ kind: item.kind, id: value.id })}><td><button className="library-row-title" type="button" data-resource-id={value.id} aria-pressed={active} onClick={event => { event.stopPropagation(); select({ kind: item.kind, id: value.id }) }}><span className={`library-item-icon ${item.kind}`}>{item.kind === 'document' ? <FileText size={20}/> : <Link2 size={20}/>}</span><span><strong>{value.title}{item.kind === 'bookmark' && item.bookmark.isFavorite && <Star size={12}/>}</strong><small title={item.kind === 'document' ? item.document.relativePath : item.bookmark.description || item.bookmark.url}>{item.kind === 'document' ? item.document.relativePath : item.bookmark.description || item.bookmark.url}</small></span></button></td><td><span className={`library-source-badge ${item.kind}`}>{item.kind === 'document' ? item.document.sourceName : t('本地书签', 'Bookmark')}</span>{item.kind === 'document' && item.document.readOnly && <small className="library-readonly">{t('只读', 'Read only')}</small>}{item.kind === 'document' && item.document.status === 'missing' && <small className="library-missing">{t('文件缺失', 'Missing file')}</small>}</td><td><time dateTime={value.updatedAt} title={formatUpdated(value.updatedAt)}>{value.updatedAt ? new Date(value.updatedAt).toLocaleDateString(getLocale()) : '—'}</time></td></tr>
      })}</tbody></table></div> : <Empty title={search || sourceId ? t('没有找到匹配的资料', 'No matching resources') : t('资料库还没有内容', 'Your library is empty')} detail={search ? t('换个关键词，或清除目录和类型筛选。', 'Try another keyword or clear the directory and type filters.') : t('保留原始文件的目录接入后，文档会出现在这里。', 'Documents appear here after connecting their original directories.')}>{canManage && <Button variant="outline" onClick={onManage}>{t('接入文档目录', 'Connect a directory')}</Button>}</Empty>}
      <footer className="library-list-footer"><span>{t('已显示 {count} 项', '{count} items shown', { count: items.length })}{kind !== 'bookmark' && section !== 'favorites' && total > documents.length ? t(' · 文档已加载 {loaded}/{total}', ' · Documents loaded: {loaded}/{total}', { loaded: documents.length, total }) : ''}</span>{kind !== 'bookmark' && section !== 'favorites' && total > documents.length && <Button variant="outline" size="sm" disabled={loadingMore} onClick={loadMore}>{loadingMore ? t('正在加载…', 'Loading…') : t('加载更多文档', 'Load more documents')}</Button>}</footer>
    </main>
    {selection && <aside className="library-preview" aria-label={t('资料预览', 'Resource preview')}>{selection.kind === 'document' ? <DocumentPanel key={selection.id} space={space} bootstrap={bootstrap} documentId={selection.id} refreshToken={refreshKey} bookmarks={bookmarks} onClose={() => select(null)} expanded={expandedPreview} onExpand={() => setExpandedPreview(value => !value)} onChanged={refresh} onDeleted={() => { setSelection(null); refresh() }} onDocumentLink={openDocumentLink} onNotice={setNotice}/> : selectedBookmark ? <BookmarkPanel key={selectedBookmark.id} bookmark={selectedBookmark} space={space} bootstrap={bootstrap} onClose={() => select(null)} expanded={expandedPreview} onExpand={() => setExpandedPreview(value => !value)} onReload={refresh} onSaved={value => { setBookmarks(current => current.map(item => item.id === value.id ? value : item)); setNotice(t('使用说明已保存', 'Usage notes saved')) }} onDocumentLink={id => select({ kind: 'document', id })}/> : <Empty title={t('该书签已不存在', 'This bookmark no longer exists')}><Button onClick={() => select(null)}>{t('关闭', 'Close')}</Button></Empty>}</aside>}
    {newDocument && <NewDocumentDialog spaceId={space.id} sources={sources} preferredSourceId={sourceId} onClose={() => setNewDocument(false)} onManage={() => { setNewDocument(false); onManage() }} onCreated={value => { setNewDocument(false); setSelection({ kind: 'document', id: value.id }); setNotice(t('文档已保存到原始目录', 'Document saved to its directory')); refresh() }}/>}
  </div>
}
