import { t, getLocale } from '../core/i18n'
import { notifyRouteCommitted, requestNavigation, routeCommittedEvent } from '../core/navigation'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Compass, Download, Folder, KeyRound, Layers, Link2, LogOut, Network, Pencil, Plus, RefreshCw, Search, Shield, Star, Trash2, Upload, Users } from 'lucide-react'
import { downloadExport, messageOf, request } from '../core/api'
import { safeHref } from '../core/presentation'
import type { Bootstrap, Category, Dashboard, Dataset, NavigationData, NavLink } from '../core/types'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Input } from '../components/ui/input'
import { StyledSelect } from '../components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { BuiltinIcon, Empty, ErrorMessage, Field, handleFormInvalid, Loading, Modal } from '../components/Shared'
import { BookmarkImporter, CategoryEditor, LinkEditor } from './ContentForms'
import { AccessSettings, MembersPanel } from './Accounts'
import LayoutEditor from './LayoutEditor'
import { ProjectLogo } from '../components/ProjectLogo'
import IntegrationsPanel from './IntegrationsPanel'
import NetworkSettings from './NetworkSettings'
import { BulkLinkDialog, type BulkLinkAction, type BulkLinkResult } from './BulkLinkDialog'
import './bulk-links.css'

type Props = { bootstrap: Bootstrap; dashboard: Dashboard | null; onHome: () => void; onLogin: () => void; onLogout: () => Promise<void>; onRefresh: () => Promise<void>; onSwitchSpace: (id: string) => void; onSessionChanged: () => Promise<void>; onNotice: (message: string) => void }
const standardMenu = () => [
  { id: 'links', name: t("链接管理", "Link management"), icon: Link2 },
  { id: 'categories', name: t("分类管理", "Category management"), icon: Folder },
  { id: 'appearance', name: t("布局与主题", "Layout and theme"), icon: Layers },
  { id: 'bookmarks', name: t("导入与导出", "Import and export"), icon: Upload },
  { id: 'integrations', name: t("数据源与 MCP", "Sources and MCP"), icon: KeyRound }
]
const pageSizes = () => [25, 50, 100].map(value => ({ value: String(value), label: t("{count} 条 / 页", "{count} / page", { count: value }) }))
function initialTab() { return new URLSearchParams(window.location.hash.split('?')[1] || '').get('tab') || 'links' }
type ContentIntent = { hash: string; action: string; spaceId: string; valid: boolean }
function readContentIntent(): ContentIntent | null {
  if (window.location.hash.split('?')[0] !== '#/admin') return null
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '')
  const action = params.get('action')
  if (action === null) return null
  const spaceId = params.get('spaceId') || ''
  return { hash: window.location.hash, action, spaceId, valid: params.getAll('action').length === 1 && params.getAll('spaceId').length === 1 && !!spaceId && ['add-link', 'import-bookmarks'].includes(action) }
}

function Pagination({ total, page, pageSize, onPage, onPageSize, label }: { total: number; page: number; pageSize: number; onPage: (page: number) => void; onPageSize: (size: number) => void; label: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return <nav className="admin-pagination" aria-label={t("{label}分页", "{label} pagination", { label })}>
    <span className="admin-pagination-total" role="status">{total ? t("{start}–{end} / {total} 条", "{start}–{end} / {total} items", { start: (page - 1) * pageSize + 1, end: Math.min(page * pageSize, total), total }) : t("0 条", "0 items")}</span>
    <div className="admin-page-size"><StyledSelect aria-label={t("{label}每页条数", "{label} per page", { label })} value={String(pageSize)} onValueChange={value => onPageSize(Number(value))} options={pageSizes()}/></div>
    <div className="admin-pagination-buttons">
      <Button variant="ghost" size="icon-sm" aria-label={t("{label}第一页", "{label}: first page", { label })} disabled={page === 1} onClick={() => onPage(1)}><ChevronsLeft size={16}/></Button>
      <Button variant="outline" size="icon-sm" aria-label={t("{label}上一页", "{label}: previous page", { label })} disabled={page === 1} onClick={() => onPage(page - 1)}><ChevronLeft size={16}/></Button>
      <span className="admin-page-number" aria-live="polite">{page} / {pages}</span>
      <Button variant="outline" size="icon-sm" aria-label={t("{label}下一页", "{label}: next page", { label })} disabled={page === pages} onClick={() => onPage(page + 1)}><ChevronRight size={16}/></Button>
      <Button variant="ghost" size="icon-sm" aria-label={t("{label}最后一页", "{label}: last page", { label })} disabled={page === pages} onClick={() => onPage(pages)}><ChevronsRight size={16}/></Button>
    </div>
  </nav>
}

export default function AdminView({ bootstrap, dashboard, onHome, onLogin, onLogout, onRefresh, onSwitchSpace, onSessionChanged, onNotice }: Props) {
  const [tab, setTab] = useState(initialTab), [query, setQuery] = useState(''), [page, setPage] = useState(1), [pageSize, setPageSize] = useState(25)
  const [contentIntent, setContentIntent] = useState(readContentIntent)
  const switchingIntent = useRef<string | null>(null)
  const identity = `${bootstrap.user?.id || 'visitor'}:${bootstrap.mode}`
  const [localSnapshot, setLocalSnapshot] = useState<{ spaceId: string; identity: string; dataset: Dataset<NavigationData> } | null>(null)
  const [linkSelection, setLinkSelection] = useState<{ snapshot: Dataset<NavigationData>; query: string; ids: Set<string> } | null>(null)
  const [bulkAction, setBulkAction] = useState<BulkLinkAction | null>(null)
  const navigationRequest = useRef<AbortController | null>(null), tableScroll = useRef<HTMLDivElement | null>(null)
  const spaceId = dashboard?.space.id, currentSpaceId = useRef(spaceId); currentSpaceId.current = spaceId
  const localData = localSnapshot && localSnapshot.spaceId === spaceId && localSnapshot.identity === identity ? localSnapshot.dataset : null
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [editor, setEditor] = useState<'link' | 'category' | 'import' | null>(null)
  const [editingLink, setEditingLink] = useState<NavLink | null>(null), [editingCategory, setEditingCategory] = useState<Category | null>(null)
  const [deleting, setDeleting] = useState<{ type: 'links' | 'categories'; id: string; title: string } | null>(null), [deleteError, setDeleteError] = useState(''), [busy, setBusy] = useState(false)
  const siteManager = bootstrap.user?.role === 'Owner' || bootstrap.mode === 'open_edit'
  const menu = useMemo(() => [...standardMenu(),
    ...(siteManager ? [{ id: 'network', name: t('网络设置', 'Network settings'), icon: Network }, { id: 'access', name: t("访问与账号", "Access and accounts"), icon: Shield }] : []),
    ...(bootstrap.user?.role === 'Owner' && bootstrap.mode === 'private_multi' ? [{ id: 'members', name: t("成员管理", "Member management"), icon: Users }] : []),
    { id: 'about', name: t("关于 Home", "About Home"), icon: Compass }
  ], [siteManager, bootstrap.user?.role, bootstrap.mode])
  const current = menu.find(item => item.id === tab) || menu[0]!
  const localDashboard: Dashboard | null = dashboard && localData ? { ...dashboard, datasets: { ...dashboard.datasets, navigation: localData } } : null
  const canEditContent = !!localDashboard?.space.canEdit && bootstrap.spaces.some(space => space.id === spaceId && space.canEdit)
  const categories = useMemo(() => [...(localData?.data.categories || [])].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, getLocale())), [localData])
  const categoryById = useMemo(() => new Map(categories.map(category => [category.id, category])), [categories])
  const categoryLabels = useMemo(() => new Map(categories.map(category => {
    const names = [category.name], seen = new Set([category.id]); let parentId = category.parentId
    while (parentId && !seen.has(parentId)) { seen.add(parentId); const parent = categoryById.get(parentId); if (!parent) break; names.unshift(parent.name); parentId = parent.parentId }
    return [category.id, names.join(' / ')]
  })), [categories, categoryById])
  const categoryCounts = useMemo(() => { const counts = new Map<string, number>(); for (const link of localData?.data.links || []) if (link.categoryId) counts.set(link.categoryId, (counts.get(link.categoryId) || 0) + 1); return counts }, [localData])
  const sortedLinks = useMemo(() => [...(localData?.data.links || [])].sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, getLocale())), [localData])
  const normalizedQuery = query.trim().toLocaleLowerCase(getLocale())
  const links = useMemo(() => normalizedQuery ? sortedLinks.filter(link => `${link.title} ${link.url} ${link.description} ${(link.tags || []).join(' ')}`.toLocaleLowerCase(getLocale()).includes(normalizedQuery)) : sortedLinks, [sortedLinks, normalizedQuery])
  const filteredCategories = useMemo(() => normalizedQuery ? categories.filter(category => categoryLabels.get(category.id)!.toLocaleLowerCase(getLocale()).includes(normalizedQuery)) : categories, [categories, categoryLabels, normalizedQuery])
  const total = current.id === 'categories' ? filteredCategories.length : links.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize)), currentPage = Math.min(page, pageCount), pageStart = (currentPage - 1) * pageSize

  const selectedIds = canEditContent && !loading && current.id === 'links' && linkSelection?.snapshot === localData && linkSelection.query === normalizedQuery ? linkSelection.ids : new Set<string>()
  const pageLinks = links.slice(pageStart, pageStart + pageSize)
  const pageSelected = pageLinks.filter(link => selectedIds.has(link.id)).length
  const selectedLinks = sortedLinks.filter(link => selectedIds.has(link.id))
  function selectLinks(ids: string[], checked: boolean) {
    if (!canEditContent || !localData || loading) return
    const next = new Set(selectedIds)
    for (const id of ids) { if (checked) next.add(id); else next.delete(id) }
    if (next.size > 500) { setError(t('一次最多选择 500 个链接，请缩小筛选范围。', 'Select at most 500 links at a time. Narrow your search.')); return }
    setLinkSelection({ snapshot: localData, query: normalizedQuery, ids: next })
  }
  function clearSelection() { setLinkSelection(null); setBulkAction(null) }

  const loadNavigation = useCallback(async () => {
    if (spaceId !== currentSpaceId.current) return
    navigationRequest.current?.abort(); setLinkSelection(null); setBulkAction(null)
    if (!spaceId) { setLocalSnapshot(null); setLoading(false); return }
    const pending = new AbortController(); navigationRequest.current = pending; setLoading(true); setError('')
    try {
      const dataset = await request<Dataset<NavigationData>>(`/spaces/${spaceId}/navigation`, { signal: pending.signal })
      if (!pending.signal.aborted && navigationRequest.current === pending && currentSpaceId.current === spaceId) setLocalSnapshot({ spaceId, identity, dataset })
    } catch (cause) {
      if (!pending.signal.aborted && navigationRequest.current === pending && currentSpaceId.current === spaceId) { setLocalSnapshot(null); setError(messageOf(cause)) }
    } finally { if (!pending.signal.aborted && navigationRequest.current === pending && currentSpaceId.current === spaceId) setLoading(false) }
  }, [spaceId, identity])
  useEffect(() => {
    setLocalSnapshot(null); setEditor(null); setDeleting(null); setEditingLink(null); setEditingCategory(null); setDeleteError(''); setQuery(''); setPage(1)
    void loadNavigation(); return () => navigationRequest.current?.abort()
  }, [loadNavigation])
  useEffect(() => { if (!menu.some(item => item.id === tab)) setTab('links') }, [menu, tab])
  useEffect(() => {
    // The app's router restores blocked hash changes before this listener runs.
    // Approved replaceState changes use the same route-committed event.
    const changed = () => { setLinkSelection(null); setBulkAction(null); setTab(initialTab()); setContentIntent(readContentIntent()); setQuery(''); setPage(1) }
    window.addEventListener('hashchange', changed); window.addEventListener(routeCommittedEvent, changed)
    return () => { window.removeEventListener('hashchange', changed); window.removeEventListener(routeCommittedEvent, changed) }
  }, [])
  useEffect(() => {
    if (!contentIntent) { switchingIntent.current = null; return }
    if (window.location.hash !== contentIntent.hash) { setContentIntent(null); return }
    const consume = (destination?: string) => {
      // Remove the one-shot command before opening a dialog: refreshes and
      // subsequent data renders must not recreate it after the user closes it.
      setContentIntent(null); switchingIntent.current = null
      const params = new URLSearchParams(window.location.hash.split('?')[1] || '')
      params.delete('action'); params.delete('spaceId')
      if (destination) params.set('tab', destination)
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/admin${params.size ? '?' + params.toString() : ''}`)
      notifyRouteCommitted()
    }
    const target = bootstrap.spaces.find(space => space.id === contentIntent.spaceId)
    if (!contentIntent.valid || !target?.canEdit) {
      consume(); setError(t('此操作需要指定一个可维护的空间。没有打开编辑表单。', 'This action requires an accessible, editable space. No editor was opened.')); return
    }
    if (editor || deleting || bulkAction) {
      consume(); setError(t('请先完成或关闭当前表单，再添加或导入链接。当前输入已保留。', 'Finish or close the current form before adding or importing links. Your entries have been preserved.')); return
    }
    const destination = contentIntent.action === 'add-link' ? 'links' : 'bookmarks'
    setTab(destination)
    if (spaceId !== target.id) {
      if (switchingIntent.current !== contentIntent.hash) { switchingIntent.current = contentIntent.hash; onSwitchSpace(target.id) }
      return
    }
    if (!dashboard?.space.canEdit) {
      consume(destination); setError(t('当前空间已变为只读。没有打开编辑表单。', 'This space is now read-only. No editor was opened.')); return
    }
    if (!localData) {
      if (!loading && error) consume(destination)
      return
    }
    if (localData.datasetId !== 'local-navigation' || localData.schemaId !== 'navigation.collection' || localData.schemaVersion !== 1) {
      consume(destination); setError(t('本地导航尚未就绪。请刷新列表后重试。', 'Local bookmarks are unavailable. Refresh the list and try again.')); return
    }
    consume(destination); setEditingLink(null); setEditor(contentIntent.action === 'add-link' ? 'link' : 'import')
  }, [contentIntent, bootstrap.spaces, dashboard, spaceId, localData, loading, error, editor, deleting, bulkAction, onSwitchSpace])
  useEffect(() => {
    if (!dashboard?.space.canEdit || !bootstrap.spaces.some(space => space.id === spaceId && space.canEdit)) { setEditor(null); setDeleting(null); setLinkSelection(null); setBulkAction(null) }
  }, [dashboard?.space.canEdit, bootstrap.spaces, spaceId])
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [page, pageCount])
  useEffect(() => { if (tableScroll.current) tableScroll.current.scrollTop = 0 }, [current.id, currentPage, pageSize, normalizedQuery])

  function selectTab(id: string) { if (id === tab) return; requestNavigation(() => { clearSelection(); setTab(id); setQuery(''); setPage(1); window.history.replaceState(null, '', `#/admin?tab=${id}`); notifyRouteCommitted() }) }
  function changeQuery(value: string) { clearSelection(); setQuery(value); setPage(1) }
  function changePageSize(value: number) { setPageSize(value); setPage(1) }
  async function bulkSaved(result: BulkLinkResult) {
    clearSelection()
    onNotice(t('已处理 {selected} 个链接，修改了 {updated} 个。', 'Processed {selected} links; updated {updated}.', { selected: result.selectedCount, updated: result.updatedCount }))
    const results = await Promise.allSettled([onRefresh(), loadNavigation()])
    if (results.some(result => result.status === 'rejected')) setError(t('批量修改已经保存，但页面刷新失败。请刷新列表查看结果。', 'The batch changes were saved, but refreshing failed. Reload the list to see the result.'))
  }
  async function saved(message: string) {
    setEditor(null); onNotice(message)
    const results = await Promise.allSettled([onRefresh(), loadNavigation()])
    if (results.some(result => result.status === 'rejected')) setError(t('内容已经保存，但页面刷新失败。请刷新列表查看结果。', 'The content was saved, but refreshing failed. Reload the list to see the result.'))
  }
  async function remove() {
    if (!dashboard || !deleting) return
    setBusy(true); setDeleteError('')
    try { await request(`/spaces/${dashboard.space.id}/${deleting.type}/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); await saved(deleting.type === 'links' ? t("链接已删除", "Link deleted") : t("分类已删除", "Category deleted")) }
    catch (cause) { setDeleteError(messageOf(cause)) } finally { setBusy(false) }
  }
  async function exportData(format: 'html' | 'json') { if (!dashboard) return; setError(''); try { await downloadExport(dashboard.space.id, format); onNotice(t("导出文件已准备好", "Export file is ready")) } catch (cause) { setError(messageOf(cause)) } }
  function newLink() { if (!canEditContent) return; setEditingLink(null); setEditor('link') }
  function newCategory() { if (!canEditContent) return; setEditingCategory(null); setEditor('category') }
  function importBookmarks() { if (canEditContent) setEditor('import') }
  function askDelete(type: 'links' | 'categories', id: string, title: string) { if (!canEditContent) return; setDeleteError(''); setDeleting({ type, id, title }) }
  const contentTab = ['links', 'categories', 'bookmarks'].includes(current.id)
  const listTab = ['links', 'categories'].includes(current.id)

  return <div className="admin-ui admin-shell">
    <header className="admin-topbar">
      <a className="admin-brand" href="#/" onClick={event => { event.preventDefault(); onHome() }}><span className="admin-brand-mark"><ProjectLogo size={39}/></span><span>Lingshu<span className="admin-brand-light"> / Home</span></span></a>
      <span className="admin-top-label">{t("管理面板", "Administration")}</span><span className="grow"/>
      <Button variant="ghost" onClick={onHome}>{t("返回导航", "Back to Home")}<ArrowUpRight size={16}/></Button>
      {bootstrap.user ? <Button variant="ghost" aria-label={t('退出登录', 'Sign out')} title={t('退出登录', 'Sign out')} onClick={() => requestNavigation(() => { void onLogout() })}><span className="admin-avatar small">{(bootstrap.user.displayName || bootstrap.user.username).slice(0, 1).toUpperCase()}</span><span className="admin-account-name">{bootstrap.user.displayName}</span><LogOut size={15}/></Button> : <Button variant="outline" size="sm" onClick={onLogin}>{t("管理员登录", "Administrator sign-in")}</Button>}
    </header>
    <aside className="admin-sidebar">
      <nav aria-label={t("管理菜单", "Administration menu")}>{menu.map(item => <button key={item.id} className={`admin-nav-item ${current.id === item.id ? 'active' : ''}`} aria-current={current.id === item.id ? 'page' : undefined} onClick={() => selectTab(item.id)}><item.icon size={18}/><span>{item.name}</span></button>)}</nav>
      <footer>Lingshu-Home <small>{bootstrap.version}</small></footer>
    </aside>
    <main className="admin-main" id="main-content">
      <div className="admin-page-heading"><h1>{current.name}</h1>{dashboard && standardMenu().some(item => item.id === current.id) && <Field label={t("当前空间", "Current space")} className="admin-space-picker"><StyledSelect aria-label={t("当前空间", "Current space")} value={dashboard.space.id} onValueChange={id => { if (id !== dashboard.space.id) requestNavigation(() => onSwitchSpace(id)) }} options={bootstrap.spaces.map(space => ({ value: space.id, label: `${space.name} · ${space.kind === 'personal' ? t('个人', 'Personal') : t('共享', 'Shared')}` }))}/></Field>}</div>
      <ErrorMessage error={error}/>
      <div className={`admin-page-body ${listTab ? 'admin-page-body-list' : current.id === 'appearance' ? 'admin-page-body-layout' : 'admin-page-body-scroll'}`} key={current.id}>
        {contentTab && loading && !localDashboard ? <Loading text={t("正在读取本地导航…", "Loading local bookmarks…")}/> : contentTab && !localDashboard ? <Empty title={error ? t("无法读取当前空间内容", "Unable to load this space") : t("当前没有可访问的导航空间", "No accessible bookmark space")} detail={t("登录后可进入个人空间；管理员也可以维护共享内容。", "Sign in to access your personal space. Administrators can also manage shared content.")}><Button variant="outline" onClick={loadNavigation}>{t("重新读取", "Reload")}</Button>{!bootstrap.user && <Button onClick={onLogin}>{t("登录", "Sign in")}</Button>}</Empty> : current.id === 'links' && localDashboard ? <>
          <div className="admin-content-toolbar"><div className="admin-search"><Search size={17}/><Input type="search" value={query} onChange={event => changeQuery(event.target.value)} placeholder={t("搜索链接、标签、网址…", "Search links, tags, URLs…")} aria-label={t("搜索链接列表", "Search links")}/></div><span className="admin-muted admin-count">{t("{count} 个链接", "{count} links", { count: links.length })}</span><span className="grow"/><Button variant="outline" disabled={loading} onClick={() => { void loadNavigation() }} aria-label={t('刷新列表', 'Refresh list')}><RefreshCw size={15} className={loading ? 'admin-spin' : undefined}/>{t('刷新列表', 'Refresh list')}</Button>{localDashboard.space.canEdit && <><Button variant="outline" onClick={importBookmarks}><Upload size={16}/>{t("导入", "Import")}</Button><Button onClick={newLink}><Plus size={16}/>{t("添加链接", "Add link")}</Button></>}</div>
          {!localDashboard.space.canEdit && <p className="admin-info">{t("当前共享空间只读。", "This shared space is read-only. ")}{bootstrap.user ? t("切换到个人空间可维护自己的导航。", "Switch to a personal space to manage your bookmarks.") : t("管理员登录后可以维护共享内容。", "Administrators can sign in to manage shared content.")}</p>}
          {canEditContent && links.length > 0 && <div className="admin-bulk-toolbar" aria-label={t('批量整理链接', 'Organize selected links')}>
            <span className="admin-selection-count" role="status">{t('已选 {count} 个', '{count} selected', { count: selectedIds.size })}</span>
            <Button variant="ghost" size="sm" disabled={loading || links.length > 500 || selectedIds.size === links.length} onClick={() => selectLinks(links.map(link => link.id), true)}>{t('选择全部筛选结果（{count}）', 'Select all results ({count})', { count: links.length })}</Button>
            {links.length > 500 && <span className="admin-hint">{t('每批最多 500 个，请先筛选', 'Filter to 500 or fewer per batch')}</span>}
            {selectedIds.size > 0 && <>
              <span className="admin-bulk-divider"/>
              <Button variant="outline" size="sm" onClick={() => setBulkAction('move')}><Folder size={15}/>{t('移动分类', 'Move category')}</Button>
              <Button variant="outline" size="sm" onClick={() => setBulkAction('tags')}>{t('维护标签', 'Edit tags')}</Button>
              <Button variant="outline" size="sm" onClick={() => setBulkAction('favorite')}><Star size={15}/>{t('设置收藏', 'Set favorites')}</Button>
              <Button variant="ghost" size="sm" onClick={clearSelection}>{t('清除选择', 'Clear selection')}</Button>
            </>}
          </div>}
          {links.length ? <div className="admin-table-scroll" ref={tableScroll} tabIndex={0} role="region" aria-label={t("链接列表", "Links")}><Table className={'admin-links-table' + (canEditContent ? ' has-selection' : '')}><TableHeader><TableRow>{canEditContent && <TableHead className="admin-selection-cell"><Checkbox aria-label={t('选择本页链接', 'Select links on this page')} checked={pageSelected === pageLinks.length && pageLinks.length > 0 ? true : pageSelected ? 'indeterminate' : false} disabled={loading} onCheckedChange={checked => selectLinks(pageLinks.map(link => link.id), checked)}/></TableHead>}<TableHead>{t("链接 / 主入口", "Link / Primary URL")}</TableHead><TableHead>{t("分类", "Categories")}</TableHead><TableHead>{t("其他入口", "Additional URLs")}</TableHead><TableHead>{t("排序", "Sort order")}</TableHead><TableHead className="admin-actions-cell">{t("操作", "Actions")}</TableHead></TableRow></TableHeader><TableBody>{pageLinks.map(link => <TableRow key={link.id} data-selected={selectedIds.has(link.id) || undefined}>
            {canEditContent && <TableCell className="admin-selection-cell"><Checkbox aria-label={t('选择 {name}', 'Select {name}', { name: link.title })} checked={selectedIds.has(link.id)} disabled={loading} onCheckedChange={checked => selectLinks([link.id], checked)}/></TableCell>}
            <TableCell><div className="admin-table-link"><span className="admin-link-icon"><BuiltinIcon name={link.icon}/></span><span><div className="admin-link-title"><a href={safeHref(link.url)} target="_blank" rel="noopener noreferrer"><strong title={link.title}>{link.title}</strong>{link.isFavorite && <Star size={12} className="admin-star"/>}</a>{!!link.tags?.length && <span className="admin-tags" title={link.tags.join(' · ')}>{link.tags.slice(0, 2).map(tag => <span key={tag}>{tag}</span>)}{link.tags.length > 2 && <span>+{link.tags.length - 2}</span>}</span>}</div><small title={link.url}>{link.url}</small></span></div></TableCell>
            <TableCell><span className="admin-category-name" title={link.categoryId ? categoryLabels.get(link.categoryId) : undefined}>{link.categoryId ? categoryById.get(link.categoryId)?.name || t("未分类", "Uncategorized") : t("未分类", "Uncategorized")}</span></TableCell>
            <TableCell><div className="admin-endpoint-links">{(link.endpoints || []).slice(0, 2).map((endpoint, index) => <a href={safeHref(endpoint.url)} key={index} target="_blank" rel="noopener noreferrer" title={endpoint.url}>{endpoint.label}<ArrowUpRight size={11}/></a>)}{(link.endpoints?.length || 0) > 2 && <span className="admin-endpoint-overflow" title={link.endpoints!.slice(2).map(endpoint => `${endpoint.label}: ${endpoint.url}`).join('\n')}>+{link.endpoints!.length - 2}</span>}{!link.endpoints?.length && <span className="admin-muted">—</span>}</div></TableCell>
            <TableCell>{link.sortOrder}</TableCell><TableCell className="admin-actions-cell">{localDashboard.space.canEdit ? <div className="admin-button-row"><Button variant="ghost" size="icon-sm" aria-label={t("编辑 {name}", "Edit {name}", { name: link.title })} onClick={() => { setEditingLink(link); setEditor('link') }}><Pencil size={15}/></Button><Button variant="ghost" size="icon-sm" aria-label={t("删除 {name}", "Delete {name}", { name: link.title })} onClick={() => askDelete('links', link.id, link.title)}><Trash2 size={15}/></Button></div> : <a href={safeHref(link.url)} target="_blank" rel="noopener noreferrer" aria-label={t("打开 {name}", "Open {name}", { name: link.title })}><ArrowUpRight size={16}/></a>}</TableCell>
          </TableRow>)}</TableBody></Table></div> : <Empty title={query ? t("没有找到匹配的链接", "No matching links") : t("暂无链接", "No links yet")} detail={query ? t("试试其他关键词。", "Try different keywords.") : canEditContent ? t("添加链接或导入浏览器书签。", "Add a link or import browser bookmarks.") : undefined}/>}
          <Pagination total={links.length} page={currentPage} pageSize={pageSize} onPage={setPage} onPageSize={changePageSize} label={t("链接", "Links")}/>
        </> : current.id === 'categories' && localDashboard ? <>
          <div className="admin-content-toolbar"><div className="admin-search"><Search size={17}/><Input type="search" value={query} onChange={event => changeQuery(event.target.value)} placeholder={t("搜索分类…", "Search categories…")} aria-label={t("搜索分类列表", "Search categories")}/></div><span className="admin-muted admin-count">{t("{count} 个分类", "{count} categories", { count: filteredCategories.length })}</span><span className="grow"/>{localDashboard.space.canEdit && <Button onClick={newCategory}><Plus size={16}/>{t("添加分类", "Add category")}</Button>}</div>
          {filteredCategories.length ? <div className="admin-table-scroll" ref={tableScroll} tabIndex={0} role="region" aria-label={t("分类列表", "Categories")}><Table className="admin-categories-table"><TableHeader><TableRow><TableHead>{t("分类", "Categories")}</TableHead><TableHead>{t("链接数", "Links")}</TableHead><TableHead>{t("排序", "Sort order")}</TableHead><TableHead className="admin-actions-cell">{t("操作", "Actions")}</TableHead></TableRow></TableHeader><TableBody>{filteredCategories.slice(pageStart, pageStart + pageSize).map(category => <TableRow key={category.id}>
            <TableCell><div className="admin-table-link"><span className="admin-link-icon"><BuiltinIcon name={category.icon}/></span><strong className="admin-category-path" title={categoryLabels.get(category.id)}>{categoryLabels.get(category.id)}</strong></div></TableCell><TableCell>{categoryCounts.get(category.id) || 0}</TableCell><TableCell>{category.sortOrder}</TableCell>
            <TableCell className="admin-actions-cell">{localDashboard.space.canEdit && <div className="admin-button-row"><Button variant="ghost" size="icon-sm" aria-label={t("编辑分类 {name}", "Edit category {name}", { name: category.name })} onClick={() => { setEditingCategory(category); setEditor('category') }}><Pencil size={15}/></Button><Button variant="ghost" size="icon-sm" aria-label={t("删除分类 {name}", "Delete category {name}", { name: category.name })} onClick={() => askDelete('categories', category.id, category.name)}><Trash2 size={15}/></Button></div>}</TableCell>
          </TableRow>)}</TableBody></Table></div> : <Empty title={query ? t("没有找到匹配的分类", "No matching categories") : t("暂无分类", "No categories yet")} detail={query ? t("试试其他关键词。", "Try different keywords.") : undefined}/>}
          <Pagination total={filteredCategories.length} page={currentPage} pageSize={pageSize} onPage={setPage} onPageSize={changePageSize} label={t("分类", "Categories")}/>
          <p className="admin-list-hint">{t("有链接或子分类的分类需先移出内容再删除；排序数字越小越靠前。", "Move a category's links and subcategories before deleting it. Lower sort values appear first.")}</p>
        </> : current.id === 'appearance' && dashboard ? <div className="admin-card admin-layout-card"><LayoutEditor key={`${dashboard.page.id}:${identity}:${dashboard.space.canEdit && bootstrap.spaces.some(space => space.id === dashboard.space.id && space.canEdit)}`} bootstrap={bootstrap} dashboard={dashboard} onSaved={async message => { onNotice(message); await onRefresh() }}/></div> : current.id === 'bookmarks' && localDashboard ? <>
          <div className="admin-transfer-grid"><section className="admin-card admin-transfer-card"><span className="admin-feature-icon"><Upload size={24}/></span><h2>{t("导入浏览器书签", "Import browser bookmarks")}</h2><p>{t("导入前预览文件夹层级，选择是否跳过重复网址。", "Preview the folder hierarchy and choose whether to skip duplicate URLs before importing.")}</p><Button disabled={!localDashboard.space.canEdit} onClick={importBookmarks}>{t("选择书签文件", "Choose bookmark file")}</Button></section><section className="admin-card admin-transfer-card"><span className="admin-feature-icon"><Download size={24}/></span><h2>{t("导出当前空间", "Export current space")}</h2><p>{t("HTML 用于浏览器；JSON 包含本地导航和页面配置。完整备份按部署文档操作。", "HTML is for browsers; JSON includes local bookmarks and page configuration. Follow the deployment guide for a full backup.")}</p><div className="admin-button-row"><Button variant="outline" onClick={() => exportData('html')}>{t("导出 HTML", "Export HTML")}</Button><Button variant="outline" onClick={() => exportData('json')}>{t("导出 JSON", "Export JSON")}</Button></div></section></div>
          {localDashboard.space.canEdit && <SpaceSettings key={localDashboard.space.id} dashboard={localDashboard} bootstrap={bootstrap} onSaved={onSessionChanged} onNotice={onNotice}/>}
        </> : current.id === 'integrations' && dashboard ? <div className="admin-card"><IntegrationsPanel key={dashboard.space.id} bootstrap={bootstrap} dashboard={dashboard} onNotice={onNotice} onLogin={onLogin} onOpenAccounts={() => selectTab('access')} onRefresh={onRefresh}/></div> : current.id === 'network' && siteManager ? <NetworkSettings bootstrap={bootstrap} onSettingsSaved={onSessionChanged} onNotice={onNotice} onOpenAccounts={() => selectTab('access')}/> : current.id === 'access' && siteManager ? <div className="admin-card admin-narrow-card"><AccessSettings bootstrap={bootstrap} onLogin={onLogin} onSaved={async () => { onNotice(t("访问设置已保存", "Access settings saved")); await onSessionChanged() }}/></div> : current.id === 'members' && bootstrap.user?.role === 'Owner' && bootstrap.mode === 'private_multi' ? <div className="admin-card"><MembersPanel onNotice={onNotice}/></div> : current.id === 'about' ? <section className="admin-card admin-about"><span className="admin-brand-mark large"><ProjectLogo size={66}/></span><h2>Lingshu-Home</h2><dl><div><dt>{t("版本", "Version")}</dt><dd>{bootstrap.version}</dd></div><div><dt>{t("前端构建", "Frontend build")}</dt><dd>{__APP_VERSION__}</dd></div><div><dt>{t("管理组件", "Admin components")}</dt><dd>{t("REUI 公开组件 · MIT", "REUI public components · MIT")}</dd></div><div><dt>{t("项目许可证", "Project license")}</dt><dd>Apache-2.0</dd></div></dl><a href="https://github.com/zhigege666/Lingshu-Home" target="_blank" rel="noopener noreferrer" className="admin-project-link"><BookOpen size={16}/>{t("项目仓库", "Project repository")}<ArrowUpRight size={14}/></a></section> : <Empty title={t("当前没有可用的空间", "No space available")} detail={t("登录后进入自己的空间，再配置页面和数据源。", "Sign in to your space to configure its page and data sources.")}/>}
      </div>
    </main>
    {bulkAction && canEditContent && localData && selectedLinks.length > 0 && dashboard && <BulkLinkDialog action={bulkAction} spaceId={dashboard.space.id} spaceName={dashboard.space.name} revision={localData.revision} links={selectedLinks} categories={categories} categoryLabels={categoryLabels} onClose={() => setBulkAction(null)} onReload={() => { clearSelection(); void loadNavigation() }} onSaved={bulkSaved}/>}
    {editor === 'link' && localDashboard && canEditContent && <LinkEditor dashboard={localDashboard} autoFetchIcons={bootstrap.autoFetchIcons !== false} autoSelectEndpoint={bootstrap.autoSelectEndpoint !== false} link={editingLink} onClose={() => setEditor(null)} onSaved={saved}/>}
    {editor === 'category' && localDashboard && canEditContent && <CategoryEditor dashboard={localDashboard} category={editingCategory} onClose={() => setEditor(null)} onSaved={saved}/>}
    {editor === 'import' && localDashboard && canEditContent && <BookmarkImporter dashboard={localDashboard} autoFetchIcons={bootstrap.autoFetchIcons !== false} onClose={() => setEditor(null)} onSaved={saved}/>}
    {deleting && <Modal title={deleting.type === 'links' ? t("删除这个链接？", "Delete this link?") : t("删除这个分类？", "Delete this category?")} busy={busy} onClose={() => setDeleting(null)}><p>{t("即将删除「{name}」。", "Delete “{name}”. ", { name: deleting.title })}{deleting.type === 'links' ? t("该链接及其他入口会从当前空间移除。", "The link and its additional URLs will be removed from this space.") : t("请先移动分类中的链接和子分类。", "Move this category's links and subcategories first.")}</p><ErrorMessage error={deleteError}/><div className="admin-form-footer"><Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>{t("保留", "Keep")}</Button><Button variant="destructive" disabled={busy} onClick={remove}>{busy ? t("正在删除…", "Deleting…") : t("确认删除", "Confirm deletion")}</Button></div></Modal>}
  </div>
}

function SpaceSettings({ dashboard, bootstrap, onSaved, onNotice }: { dashboard: Dashboard; bootstrap: Bootstrap; onSaved: () => Promise<void>; onNotice: (message: string) => void }) {
  const [name, setName] = useState(dashboard.space.name), [published, setPublished] = useState(dashboard.space.published), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function save(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { await request(`/spaces/${dashboard.space.id}`, { method: 'PUT', body: { name: name.trim(), published } }); onNotice(t("空间设置已保存", "Space settings saved")); await onSaved() } catch (cause) { setError(messageOf(cause)) } finally { setBusy(false) } }
  return <section className="admin-card admin-space-settings"><h2>{t("空间设置", "Space settings")}</h2><form onSubmit={save} onInvalidCapture={event => handleFormInvalid(event, setError)}><Field label={t("空间名称", "Space name")}><Input required disabled={busy} maxLength={80} value={name} onChange={event => setName(event.target.value)}/></Field>{dashboard.space.kind === 'shared' && bootstrap.user?.role === 'Owner' && <label className="admin-check-line"><Checkbox checked={published} onCheckedChange={setPublished} disabled={busy}/>{t("在公开模式下允许免登录浏览此共享空间", "Allow visitors to browse this shared space in public modes")}</label>}<p className="admin-hint">{dashboard.space.kind === 'personal' ? t("个人空间只对自己的账号可见。", "A personal space is visible only to its own account.") : t("登录模式下，访问共享空间仍需要登录。", "Shared spaces still require sign-in in private modes.")}</p><ErrorMessage error={error}/><Button type="submit" variant="outline" disabled={busy}>{busy ? t("正在保存…", "Saving…") : t("保存空间设置", "Save space settings")}</Button></form></section>
}
