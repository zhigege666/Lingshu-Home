import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { AlertCircle, Archive, ArchiveRestore, ArrowRight, BellDot, BookOpen, Check, Crosshair, Folder, GripVertical, LayoutDashboard, List, LogOut, MoreHorizontal, Moon, Pencil, Plus, RefreshCw, Search, Settings2, Sun, X } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { ApiError, messageOf, request } from '../core/api'
import { getLocale, t } from '../core/i18n'
import { notifyRouteCommitted, requestNavigation } from '../core/navigation'
import type { Bootstrap, Dashboard } from '../core/types'
import { newWorkId, workPath, type WorkStatusContext, type WorkStatusDefinition, type WorkBoard, type WorkColumn, type WorkItem, type WorkPage, type WorkProject, type WorkSelection, type WorkStatus, type WorkSummary } from '../core/work-types'
import { ProjectLogo } from '../components/ProjectLogo'
import { ModuleNav } from '../components/ModuleNav'
import { WorkUpdatedTime } from './WorkUpdatedTime'
import { SpacePreferenceMenu } from '../components/SpacePreferenceMenu'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { StyledSelect } from '../components/ui/select'
import { ErrorMessage, Loading } from '../components/Shared'
import WorkEditor, { workStatusLabel } from './WorkEditor'
import ProjectDialog from './ProjectDialog'
import StatusManager from './StatusManager'
import { useBoardTheme, useWorkTheme, WorkThemeContext } from './work-theme'
import './work.css'

type Props = { bootstrap: Bootstrap; dashboard: Dashboard; route: string; onHome: () => void; onLibrary: () => void; onLogin: () => void; onLogout: () => Promise<void>; onSpaceChange: (id: string) => void; onNotice: (message: string) => void }
function Menu({ item, statuses, disabled, onMove, onArchive }: { item: WorkSummary; statuses: WorkStatusDefinition[]; disabled: boolean; onMove: (status: WorkStatus) => void; onArchive: () => void }) {
  const theme = useWorkTheme()
  const later = useRef<(() => void) | null>(null)
  return <DropdownMenu.Root modal={false}><DropdownMenu.Trigger asChild><button type="button" className="work-card-menu-trigger" disabled={disabled} aria-label={t('事项操作：{title}', 'Item actions: {title}', { title: item.title })} onClick={event => event.stopPropagation()}><MoreHorizontal size={17}/></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className={`admin-ui work-theme work-theme-${theme} work-menu`} data-theme={theme} align="end" sideOffset={5} collisionPadding={10} onCloseAutoFocus={event => { const action = later.current; later.current = null; if (action) { event.preventDefault(); action() } }}>
    {!item.archived && <><DropdownMenu.Label>{t('移动到', 'Move to')}</DropdownMenu.Label>{statuses.map(status => <DropdownMenu.Item key={status.id} disabled={status.id === item.status} title={status.description} onSelect={() => { later.current = () => onMove(status.id) }}><span className="work-status-dot" style={{ backgroundColor: status.color }}/>{status.name}{status.id === item.status && <Check size={13}/>}</DropdownMenu.Item>)}<DropdownMenu.Separator/></>}
    <DropdownMenu.Item onSelect={() => { later.current = onArchive }}>{item.archived ? <ArchiveRestore size={15}/> : <Archive size={15}/>}<span>{item.archived ? t('恢复事项', 'Restore item') : t('归档事项', 'Archive item')}</span></DropdownMenu.Item>
  </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
}
function BoardMenu({ disabled, onManage, onReload }: { disabled: boolean; onManage: () => void; onReload: () => void }) {
  const theme = useWorkTheme(), later = useRef<(() => void) | null>(null)
  return <DropdownMenu.Root modal={false}><DropdownMenu.Trigger asChild><Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={t('看板操作', 'Board actions')}><MoreHorizontal size={19}/></Button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className={`admin-ui work-theme work-theme-${theme} work-menu`} data-theme={theme} align="end" sideOffset={6} collisionPadding={12} onCloseAutoFocus={event => { const action = later.current; later.current = null; if (action) { event.preventDefault(); action() } }}><DropdownMenu.Item onSelect={() => { later.current = onManage }}><Settings2 size={16}/>{t('管理状态', 'Manage statuses')}</DropdownMenu.Item><DropdownMenu.Item onSelect={() => { later.current = onReload }}><RefreshCw size={16}/>{t('重新读取', 'Reload')}</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
}
function routeSelection(route: string): WorkSelection | null {
  const query = new URLSearchParams(route.split('?')[1] || '')
  if (query.get('item')) return { id: query.get('item')! }
  if (query.get('new') !== '1') return null
  const kind = query.get('resourceKind'), id = query.get('resourceId')
  return { id: newWorkId(), create: true, reference: id && (kind === 'bookmark' || kind === 'document') ? { kind, id, title: query.get('title') || '', available: true } : undefined }
}

export default function BoardView({ bootstrap, dashboard, route, onHome, onLibrary, onLogin, onLogout, onSpaceChange, onNotice }: Props) {
  const { theme, setTheme } = useBoardTheme(bootstrap, dashboard)
  const space = dashboard.space, identity = `${bootstrap.user?.id || 'visitor'}:${space.id}`
  const moduleEnabled = bootstrap.modules?.work !== false
  const authorized = !!bootstrap.user && space.canEdit
  const [projects, setProjects] = useState<WorkProject[]>([]), [projectId, setProjectId] = useState(''), [projectSearch, setProjectSearch] = useState(''), [projectLimit, setProjectLimit] = useState(40)
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [attention, setAttention] = useState(false), [archived, setArchived] = useState(false), [view, setView] = useState<'board' | 'list'>('board')
  const [board, setBoard] = useState<WorkBoard | null>(null), [list, setList] = useState<WorkPage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const [selection, setSelection] = useState<WorkSelection | null>(() => authorized ? routeSelection(route) : null), [projectEditor, setProjectEditor] = useState<{ project: WorkProject | null } | null>(null)
  const [statusContext, setStatusContext] = useState<WorkStatusContext>({ statuses: [], statusRevision: '', defaultStatus: '' }), [statusEditor, setStatusEditor] = useState<{ focusId?: string } | null>(null)
  const [updatesAvailable, setUpdatesAvailable] = useState(false), [syncError, setSyncError] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; itemId?: string } | null>(null), [busy, setBusy] = useState(false), [loadingMore, setLoadingMore] = useState<string[]>([]), [dragId, setDragId] = useState(''), [dropBefore, setDropBefore] = useState('')
  const [focusedItem, setFocusedItem] = useState<{ id: string; title: string } | null>(null), [revealId, setRevealId] = useState('')
  const generation = useRef(0), alive = useRef(true), mutating = useRef(false), paging = useRef(new Set<string>()), dragging = useRef<WorkSummary | null>(null), previousRoute = useRef(route), previousIdentity = useRef(identity), previousQuery = useRef('')
  const path = workPath(space.id), canEdit = authorized && moduleEnabled && (board?.canEdit ?? list?.canEdit ?? false)
  const statuses = statusContext.statuses
  const project = projects.find(item => item.id === projectId)
  const createUnavailable = archived ? t('请返回未归档事项后新建。', 'Return to active items to create an item.') : project?.archived ? t('请先恢复项目，再新建事项。', 'Restore this project before creating an item.') : projectId && !project ? t('正在读取所选项目，请稍候。', 'The selected project is loading. Please wait.') : ''
  const canCreate = canEdit && !busy && statuses.length > 0 && !createUnavailable
  const reload = useCallback(() => { setUpdatesAvailable(false); setRefresh(value => value + 1) }, [])
  const pauseSync = !!selection || !!projectEditor || !!statusEditor || busy || !!dragId || loadingMore.length > 0
  const hasExtraPages = !!board?.columns.some(column => column.items.length > 30) || (list?.items.length || 0) > 30
  const syncSnapshot = useRef({ revision: '', statusRevision: '', blocked: false, hasExtraPages: false })
  syncSnapshot.current = { revision: board?.revision || list?.revision || '', statusRevision: statusContext.statusRevision, blocked: pauseSync || loading, hasExtraPages }
  useEffect(() => {
    if (previousIdentity.current === identity) return
    previousIdentity.current = identity
    setProjects([]); setProjectId(''); setProjectSearch(''); setAttention(false); setArchived(false); setSelection(null); setProjectEditor(null); setStatusEditor(null); setFeedback(null); setFocusedItem(null); setRevealId(''); setUpdatesAvailable(false); setSyncError(false)
    setStatusContext({ statuses: [], statusRevision: '', defaultStatus: '' })
  }, [identity])
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer) }, [query])
  useEffect(() => { if (previousRoute.current !== route) { previousRoute.current = route; setSelection(authorized ? routeSelection(route) : null) } }, [route, authorized])
  function parameters(status?: WorkStatus, cursor?: string) {
    const result = new URLSearchParams({ limit: '30', archived: String(archived) })
    if (projectId) result.set('projectId', projectId)
    if (search) result.set('q', search)
    if (attention) result.set('attention', 'true')
    if (focusedItem) result.set('itemId', focusedItem.id)
    if (status) result.set('status', status)
    if (cursor) result.set('cursor', cursor)
    return result
  }
  useEffect(() => {
    const abort = new AbortController(), token = ++generation.current
    const queryKey = JSON.stringify([identity, projectId, search, attention, archived, view, focusedItem?.id])
    const quiet = previousQuery.current === queryKey && !!syncSnapshot.current.revision
    previousQuery.current = queryKey
    if (!quiet) { setLoading(true); setBoard(null); setList(null) }
    setError(''); paging.current.clear(); setLoadingMore([])
    if (!authorized || !moduleEnabled) { setLoading(false); return () => abort.abort() }
    const endpoint = view === 'board' ? '/board' : '/items'
    Promise.all([
      request<WorkBoard | WorkPage>(`${path}${endpoint}?${parameters()}`, { signal: abort.signal }),
      request<{ items: WorkProject[] }>(`${path}/projects`, { signal: abort.signal })
    ]).then(([data, projectData]) => {
      if (token !== generation.current || abort.signal.aborted) return
      if (view === 'board') setBoard(data as WorkBoard); else setList(data as WorkPage)
      setProjects(projectData.items); setStatusContext({ statuses: data.statuses, statusRevision: data.statusRevision, defaultStatus: data.defaultStatus }); setSyncError(false)
    }).catch(cause => { if (!abort.signal.aborted && token === generation.current) setError(messageOf(cause)) })
      .finally(() => { if (!abort.signal.aborted && token === generation.current) setLoading(false) })
    return () => abort.abort()
  }, [identity, authorized, moduleEnabled, path, projectId, search, attention, archived, view, focusedItem?.id, refresh])
  useEffect(() => {
    if (!revealId || loading) return
    const visible = view === 'board' ? board?.columns.some(column => column.items.some(item => item.id === revealId)) : list?.items.some(item => item.id === revealId)
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-work-id="${CSS.escape(revealId)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      setRevealId('')
    })
    return () => cancelAnimationFrame(frame)
  }, [revealId, loading, view, board, list])
  useEffect(() => {
    if (!authorized || !moduleEnabled) return
    let checking = false, stopped = false
    const abort = new AbortController()
    async function check() {
      if (checking || document.visibilityState !== 'visible' || !syncSnapshot.current.revision) return
      checking = true
      const token = generation.current
      try {
        const value = await request<{ revision: string; statusRevision: string }>(`${path}/revision`, { signal: abort.signal })
        if (stopped || token !== generation.current) return
        setSyncError(false)
        const current = syncSnapshot.current
        if (value.revision !== current.revision || value.statusRevision !== current.statusRevision) setUpdatesAvailable(true)
      } catch { if (!stopped && token === generation.current) setSyncError(true) }
      finally { checking = false }
    }
    const visible = () => { if (document.visibilityState === 'visible') void check() }
    const timer = window.setInterval(() => void check(), 15000)
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible)
    return () => { stopped = true; abort.abort(); window.clearInterval(timer); window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible) }
  }, [authorized, moduleEnabled, path])
  useEffect(() => { if (updatesAvailable && !pauseSync && !hasExtraPages && !loading) reload() }, [updatesAvailable, pauseSync, hasExtraPages, loading, reload])
  async function more(column?: WorkColumn) {
    const key = column?.status || 'list', cursor = column?.nextCursor || (!column ? list?.nextCursor : null)
    if (!moduleEnabled || !cursor || paging.current.has(key)) return
    const token = generation.current
    paging.current.add(key); setLoadingMore([...paging.current]); setError('')
    try {
      const value = await request<WorkPage>(`${path}/items?${parameters(column?.status, cursor)}`)
      if (!alive.current || token !== generation.current) return
      if (column) setBoard(previous => previous && ({ ...previous, revision: value.revision, columns: previous.columns.map(item => item.status === column.status ? { ...item, total: value.total, nextCursor: value.nextCursor, items: [...item.items, ...value.items.filter(next => !item.items.some(old => old.id === next.id))] } : item) }))
      else setList(previous => previous && ({ ...value, items: [...previous.items, ...value.items.filter(item => !previous.items.some(old => old.id === item.id))] }))
    } catch (cause) { if (alive.current && token === generation.current) setError(cause instanceof ApiError && cause.status === 409 ? t('事项已更新，请刷新后继续加载。', 'Items changed. Refresh before loading more.') : messageOf(cause)) }
    finally { if (alive.current && token === generation.current) { paging.current.delete(key); setLoadingMore([...paging.current]) } }
  }
  function replaceItemRoute(itemId?: string) {
    const query = new URLSearchParams({ view: 'board', space: space.id })
    if (itemId) query.set('item', itemId)
    const next = `/library?${query}`
    // This navigation has already been approved or follows a confirmed save.
    previousRoute.current = next
    if (window.location.hash === `#${next}`) return
    window.history.replaceState(null, '', window.location.pathname + window.location.search + '#' + next)
    notifyRouteCommitted()
  }
  function selectItem(next: WorkSelection | null) { setSelection(next); replaceItemRoute(next && !next.create ? next.id : undefined) }
  function open(item: Pick<WorkSummary, 'id'>) { requestNavigation(() => selectItem({ id: item.id })) }
  function changeScope(change: () => void) {
    requestNavigation(() => { selectItem(null); setFocusedItem(null); setRevealId(''); setFeedback(null); change() })
  }
  function changeProject(id: string) { if (id !== projectId || focusedItem) changeScope(() => setProjectId(id)) }
  function reveal(item: WorkItem) {
    setProjectId(item.projectId || ''); setArchived(item.archived); setAttention(false); setQuery(''); setSearch('')
    setFocusedItem({ id: item.id, title: item.title }); setRevealId(item.id); setFeedback(null); reload()
  }
  function saved(item: WorkItem, message: string, created: boolean) {
    setFeedback(null); selectItem({ id: item.id }); onNotice(message)
    if (created) {
      setProjectId(item.projectId || ''); setArchived(item.archived); setAttention(value => value && item.needsAttention); setQuery(''); setSearch('')
      // A list is ordered by status first; a new item in a later status can be beyond its first page.
      setFocusedItem(view === 'list' ? { id: item.id, title: item.title } : null)
    } else setFocusedItem(current => current?.id === item.id ? { id: item.id, title: item.title } : current)
    setRevealId(item.id); reload()
  }
  function create(status: WorkStatus = statusContext.defaultStatus) {
    if (!statuses.some(item => item.id === status)) return
    if (createUnavailable) { setError(createUnavailable); return }
    if (!canCreate) return
    requestNavigation(() => selectItem({ id: newWorkId(), create: true, status, projectId: projectId || null, needsAttention: attention }))
  }
  function manageStatuses(focusId?: string) { requestNavigation(() => { selectItem(null); setProjectEditor(null); setStatusEditor({ focusId }) }) }
  function editProject(project: WorkProject | null) { requestNavigation(() => { selectItem(null); setProjectEditor({ project }) }) }
  function changeArchive(item: WorkSummary) {
    requestNavigation(() => { selectItem(null); void mutate(item, { expectedRevision: item.revision, archived: !item.archived }, false) })
  }
  function move(item: WorkSummary, status: WorkStatus, beforeId: string | null) {
    if (beforeId === item.id || mutating.current || !canEdit || item.archived) return
    const revision = board?.revision || list?.revision
    if (!revision) return
    requestNavigation(() => { selectItem(null); void mutate(item, { expectedRevision: item.revision, expectedBoardRevision: revision, status, beforeId }, true) })
  }
  async function mutate(item: WorkSummary, body: Record<string, unknown>, isMove: boolean) {
    if (mutating.current) return
    mutating.current = true; setBusy(true); setError(''); setFeedback(null)
    try {
      const result = await request<WorkItem>(`${path}/items/${encodeURIComponent(item.id)}${isMove ? '/move' : ''}`, { method: isMove ? 'POST' : 'PATCH', body })
      if (!alive.current) return
      onNotice(isMove ? t('已移至{status}', 'Moved to {status}', { status: workStatusLabel(result.status, statuses) }) : result.archived ? t('事项已归档', 'Item archived') : t('事项已恢复', 'Item restored')); reload()
    } catch (cause) {
      if (!alive.current) return
      if (cause instanceof ApiError && cause.status < 500) setError(cause.status === 409 ? t('事项或顺序已在其他地方更新，请刷新后再操作。', 'The item or order changed elsewhere. Refresh before continuing.') : messageOf(cause))
      else {
        try { await request<WorkItem>(`${path}/items/${encodeURIComponent(item.id)}`) } catch {}
        if (!alive.current) return
        setFeedback({ text: t('操作结果尚未确认，正在重新读取看板。请核对当前状态与位置。', 'The result is unconfirmed. Reloading the board; check the current status and position.'), itemId: item.id }); reload()
      }
    } finally { mutating.current = false; if (alive.current) { setBusy(false); setDragId(''); setDropBefore('') } }
  }
  function dragStart(event: DragEvent, item: WorkSummary) {
    if (!canEdit || busy || item.archived) { event.preventDefault(); return }
    if ((event.target as HTMLElement).closest('.work-card-menu-trigger')) { event.preventDefault(); return }
    dragging.current = item; setDragId(item.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-lingshu-work', item.id)
  }
  function acceptDrop(event: DragEvent, status: WorkStatus, beforeId: string | null) {
    event.preventDefault(); event.stopPropagation()
    const item = dragging.current
    dragging.current = null; setDragId(''); setDropBefore('')
    if (item && event.dataTransfer.getData('application/x-lingshu-work') === item.id) move(item, status, beforeId)
  }
  function dragOver(event: DragEvent, beforeId: string) {
    if (!dragging.current || !canEdit || busy) return
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropBefore(beforeId)
    const lane = (event.currentTarget as HTMLElement).closest<HTMLElement>('.work-lane-body') || (event.currentTarget as HTMLElement).querySelector<HTMLElement>('.work-lane-body')
    if (lane) { const bounds = lane.getBoundingClientRect(); if (event.clientY < bounds.top + 42) lane.scrollTop -= 18; else if (event.clientY > bounds.bottom - 42) lane.scrollTop += 18 }
  }
  function card(item: WorkSummary) {
    return <article key={item.id} className={`work-card ${selection?.id === item.id ? 'selected' : ''} ${dragId === item.id ? 'dragging' : ''} ${dropBefore === item.id ? 'drop-before' : ''}`} data-work-id={item.id} data-work-status={item.status} draggable={canEdit && !busy && !item.archived} onDragStart={event => dragStart(event, item)} onDragEnd={() => { dragging.current = null; setDragId(''); setDropBefore('') }} onDragOver={event => dragOver(event, item.id)} onDrop={event => acceptDrop(event, item.status, item.id)}>
      <div className="work-card-top"><button type="button" className="work-card-title" onClick={() => open(item)} aria-label={t('打开事项：{title}', 'Open item: {title}', { title: item.title })}>{item.title}</button>{canEdit && <Menu item={item} statuses={statuses} disabled={busy} onMove={status => move(item, status, null)} onArchive={() => changeArchive(item)}/>}</div>
      {item.nextStep && <p className="work-card-next" title={item.nextStep}>{item.nextStep}</p>}
      <footer>{item.projectName && <span className="work-project-badge" title={item.projectName}><Folder size={12}/>{item.projectName}</span>}{item.needsAttention && <span className="work-attention-badge" title={t('待我处理', 'Needs my attention')}><BellDot size={13}/></span>}{item.referenceCount > 0 && <span className="work-reference-count" aria-label={t('{count} 个关联资料', '{count} linked resources', { count: item.referenceCount })}><BookOpen size={13}/>{item.referenceCount}</span>}<WorkUpdatedTime value={item.updatedAt}/></footer>
      {canEdit && !item.archived && <span className="work-drag-cue" aria-hidden="true"><GripVertical size={12}/></span>}
    </article>
  }
  const filteredProjects = useMemo(() => projects.filter(project => project.name.toLocaleLowerCase(getLocale()).includes(projectSearch.toLocaleLowerCase(getLocale()))), [projects, projectSearch])
  const total = board ? board.columns.reduce((sum, column) => sum + column.total, 0) : list?.total || 0
  const title = archived ? t('已归档事项', 'Archived items') : project?.name || (projectId ? t('正在读取项目…', 'Loading project…') : t('全部事项', 'All items'))
  return <WorkThemeContext.Provider value={theme}><div className={`admin-ui work-theme work-theme-${theme} work-shell ${selection ? 'has-detail' : ''}`} data-work-view={view} data-theme={theme}>
    <header className="work-topbar">
      <a className="work-brand" href="#/" onClick={event => { event.preventDefault(); requestNavigation(onHome) }}><ProjectLogo size={30}/><strong>{bootstrap.siteName || 'Lingshu-Home'}</strong></a>
      <ModuleNav active="work" modules={bootstrap.modules} canViewWork={authorized} spaceId={space.id} onHome={onHome} onLibrary={onLibrary}/>
      {authorized && <>
        <div className="work-context-heading"><h1 title={title}>{title}</h1>{!loading && total > 0 && <span className="work-total" aria-label={t('共 {count} 个事项', '{count} items total', { count: total })}>{total}</span>}</div>
        <div className="work-page-actions">
          <label className="work-search"><Search size={17}/><Input type="search" value={query} onChange={event => { setFocusedItem(null); setRevealId(''); setQuery(event.target.value) }} aria-label={t('搜索事项', 'Search items')} placeholder={t('搜索事项', 'Search items')}/></label>
          <div className="work-view-toggle" role="group" aria-label={t('事项视图', 'Work view')}><button type="button" aria-pressed={view === 'board'} aria-label={t('看板', 'Board')} onClick={() => setView('board')}><LayoutDashboard size={15}/><span>{t('看板', 'Board')}</span></button><button type="button" aria-pressed={view === 'list'} aria-label={t('列表', 'List')} onClick={() => setView('list')}><List size={15}/><span>{t('列表', 'List')}</span></button></div>
          <Button data-work-new disabled={!canCreate} title={createUnavailable || undefined} aria-label={t('新建事项', 'New item')} onClick={() => create()}><Plus size={16}/><span>{t('新建事项', 'New item')}</span></Button>
          <BoardMenu disabled={!canEdit || busy} onManage={() => manageStatuses()} onReload={() => requestNavigation(reload)}/>
        </div>
      </>}
      <div className="work-account"><StyledSelect value={space.id} tone="home" theme={theme} disabled={busy} aria-label={t('选择空间', 'Choose a space')} onValueChange={id => requestNavigation(() => onSpaceChange(id))} options={bootstrap.spaces.map(item => ({ value: item.id, label: item.name }))}/><Button variant="ghost" size="icon" aria-label={t('切换深浅色', 'Toggle light or dark')} aria-pressed={theme === 'dark'} title={theme === 'dark' ? t('切换为浅色', 'Switch to light mode') : t('切换为深色', 'Switch to dark mode')} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18}/> : <Moon size={18}/>}</Button><SpacePreferenceMenu bootstrap={bootstrap} theme={theme} disabled={busy}/>{bootstrap.user && <Button variant="ghost" size="icon" aria-label={t('退出登录', 'Sign out')} onClick={() => requestNavigation(() => void onLogout())}><LogOut size={17}/></Button>}</div>
    </header>
    {authorized ? <>
      <aside className="work-sidebar" aria-label={t('事项筛选', 'Work filters')}>
        <nav className="work-quick-filters"><button className={!projectId && !archived && !attention && !focusedItem ? 'active' : ''} onClick={() => changeScope(() => { setProjectId(''); setAttention(false); setArchived(false) })}><LayoutDashboard size={18}/>{t('全部事项', 'All items')}</button><button className={attention ? 'active' : ''} aria-pressed={attention} onClick={() => changeScope(() => { setAttention(value => !value); setArchived(false) })}><BellDot size={18}/>{t('待我处理', 'Needs my attention')}</button></nav>
        <div className="work-project-heading"><h2>{t('项目', 'Projects')}</h2><Button type="button" variant="ghost" size="icon-sm" disabled={!canEdit || busy} aria-label={t('新建项目', 'New project')} onClick={() => editProject(null)}><Plus size={15}/></Button></div>
        {projects.length > 12 && <Input className="work-project-search" value={projectSearch} onChange={event => { setProjectSearch(event.target.value); setProjectLimit(40) }} placeholder={t('查找项目', 'Find projects')} aria-label={t('查找项目', 'Find projects')}/>}
        <div className="work-projects">{filteredProjects.slice(0, projectLimit).map(item => <div key={item.id} className={`${projectId === item.id ? 'active' : ''} ${item.archived ? 'archived' : ''}`} data-work-project-id={item.id}><button onClick={() => changeProject(item.id)} title={item.name + (item.archived ? t('（已归档）', ' (archived)') : '')}><Folder size={16}/><span>{item.name}</span>{item.archived && <Archive size={12}/>}</button>{canEdit && <button className="work-project-edit" aria-label={t('编辑项目：{name}', 'Edit project: {name}', { name: item.name })} onClick={() => editProject(item)}><Pencil size={13}/></button>}</div>)}{filteredProjects.length > projectLimit && <Button variant="ghost" size="sm" onClick={() => setProjectLimit(value => value + 40)}>{t('更多项目', 'More projects')}</Button>}</div>
        <footer><button className={archived ? 'active' : ''} onClick={() => changeScope(() => setArchived(value => !value))} aria-pressed={archived}><Archive size={17}/>{t('已归档', 'Archived')}</button></footer>
      </aside>
      <main className="work-main" id="main-content">
        {!moduleEnabled && <div className="work-feedback" role="status"><span>{t('事项已关闭。当前页面与草稿保留，重新开启后可继续保存。', 'Work is disabled. This page and its draft are retained; re-enable Work to save changes.')}</span></div>}
        <div className={`work-toolbar ${focusedItem || updatesAvailable || syncError ? 'has-controls' : ''}`}>
          <div className="work-mobile-project"><StyledSelect tone="home" theme={theme} aria-label={t('筛选项目', 'Filter projects')} value={projectId} onValueChange={changeProject} options={[{ value: '', label: t('全部项目', 'All projects') }, ...projects.map(item => ({ value: item.id, label: item.name + (item.archived ? t('（已归档）', ' (archived)') : '') }))]}/></div>
          {focusedItem && <span className="work-focus-filter"><Crosshair size={14}/><span title={focusedItem.title}>{t('定位：{title}', 'Located: {title}', { title: focusedItem.title })}</span><button aria-label={t('清除事项定位', 'Clear item focus')} onClick={() => { setFocusedItem(null); setRevealId('') }}><X size={13}/></button></span>}
          <div className="work-mobile-tools"><Button variant="ghost" size="icon-sm" aria-label={t('待我处理', 'Needs my attention')} aria-pressed={attention} onClick={() => changeScope(() => { setAttention(value => !value); setArchived(false) })}><BellDot size={16}/></Button><Button variant="ghost" size="icon-sm" aria-label={t('已归档', 'Archived')} aria-pressed={archived} onClick={() => changeScope(() => setArchived(value => !value))}><Archive size={16}/></Button><Button variant="ghost" size="icon-sm" disabled={!canEdit || busy} aria-label={t('新建项目', 'New project')} onClick={() => editProject(null)}><Plus size={16}/></Button></div>
          {(updatesAvailable || syncError) && <Button className="work-sync-action" variant="ghost" size="sm" disabled={busy || loading} onClick={() => requestNavigation(reload)}><RefreshCw size={14}/>{syncError ? t('同步失败，重试', 'Sync failed, retry') : t('有更新', 'Updates available')}</Button>}
        </div>
        <ErrorMessage error={error}/>{error && <Button className="work-error-refresh" variant="outline" size="sm" onClick={reload}>{t('重新读取看板', 'Reload board')}</Button>}
        {feedback && <div className="work-feedback" role="status"><AlertCircle size={16}/><span>{feedback.text}</span>{feedback.itemId && <button onClick={() => open({ id: feedback.itemId! })}>{t('打开事项', 'Open item')}<ArrowRight size={13}/></button>}<button aria-label={t('关闭提示', 'Dismiss notice')} onClick={() => setFeedback(null)}><X size={14}/></button></div>}
        {loading ? <Loading text={t('正在读取事项…', 'Loading items…')}/> : view === 'board' && board ? <div className="work-board" style={{ gridTemplateColumns: `repeat(${statuses.length}, minmax(var(--work-lane-min), 1fr))` }} aria-label={t('事项看板', 'Work board')}>
          {statuses.map(status => {
            const column = board.columns.find(item => item.status === status.id) || { status: status.id, total: 0, items: [], nextCursor: null }
            return <section key={status.id} className={`work-lane ${dropBefore === status.id ? 'drop-end' : ''}`} data-work-status={status.id} aria-labelledby={`work-status-${status.id}`} onDragOver={event => dragOver(event, status.id)} onDrop={event => acceptDrop(event, status.id, null)}>
              <header><h2 id={`work-status-${status.id}`} title={status.description || status.name}><span className="work-status-dot" style={{ backgroundColor: status.color }}/><span className="work-status-name">{status.name}</span><span className="work-column-count">{column.total}</span></h2><div className="work-lane-actions">{canEdit && !archived && <button disabled={!canCreate} title={createUnavailable || undefined} aria-label={t('新建{status}事项', 'New {status} item', { status: status.name })} onClick={() => create(status.id)}><Plus size={16}/></button>}{canEdit && <button className="work-lane-settings" aria-label={t('编辑状态：{name}', 'Edit status: {name}', { name: status.name })} onClick={() => manageStatuses(status.id)}><MoreHorizontal size={16}/></button>}</div></header>
              <div className="work-lane-body">{column.items.map(card)}{!column.items.length && <div className="work-lane-empty">{total === 0 && status.id === statusContext.defaultStatus && canCreate && !search ? <button type="button" className="work-empty-add" onClick={() => create(status.id)}><Plus size={16}/>{t('添加事项', 'Add item')}</button> : <span>{t('暂无事项', 'No items')}</span>}</div>}{column.nextCursor && <button className="work-load-more" disabled={loadingMore.includes(status.id)} onClick={() => void more(column)}>{loadingMore.includes(status.id) ? t('正在加载…', 'Loading…') : t('加载更多（{shown}/{total}）', 'Load more ({shown}/{total})', { shown: column.items.length, total: column.total })}</button>}<div className="work-drop-tail" aria-hidden="true"/></div>
            </section>
          })}
        </div> : list ? <div className="work-list-scroll"><table className="work-table"><thead><tr><th>{t('事项', 'Item')}</th><th>{t('状态', 'Status')}</th><th>{t('项目', 'Project')}</th><th>{t('下一步', 'Next step')}</th><th>{t('更新时间', 'Updated')}</th><th><span className="sr-only">{t('操作', 'Actions')}</span></th></tr></thead><tbody>{list.items.map(item => <tr key={item.id} data-work-id={item.id} data-work-status={item.status}><td><button className="work-list-title" onClick={() => open(item)}>{item.needsAttention && <BellDot size={15}/>}<span>{item.title}</span>{item.referenceCount > 0 && <small><BookOpen size={12}/>{item.referenceCount}</small>}</button></td><td><span className="work-list-status"><span className="work-status-dot" style={{ backgroundColor: statuses.find(status => status.id === item.status)?.color }}/>{workStatusLabel(item.status, statuses)}</span></td><td className="work-table-project">{item.projectName || '—'}</td><td className="work-table-next">{item.nextStep || '—'}</td><td className="work-table-updated"><WorkUpdatedTime value={item.updatedAt} label={false}/></td><td>{canEdit && <Menu item={item} statuses={statuses} disabled={busy} onMove={status => move(item, status, null)} onArchive={() => changeArchive(item)}/>}</td></tr>)}</tbody></table>{!list.items.length && <div className="work-list-empty">{t('没有匹配的事项', 'No matching items')}</div>}{list.nextCursor && <button className="work-load-more" disabled={loadingMore.includes('list')} onClick={() => void more()}>{loadingMore.includes('list') ? t('正在加载…', 'Loading…') : t('加载更多（{shown}/{total}）', 'Load more ({shown}/{total})', { shown: list.items.length, total: list.total })}</button>}</div> : null}
      </main>
      {selection && statuses.length > 0 && <WorkEditor key={selection.id} spaceId={space.id} selection={selection} projects={projects} statuses={statuses} defaultStatus={statusContext.defaultStatus} canEdit={canEdit} documentsEnabled={bootstrap.modules?.documents !== false} onClose={() => selectItem(null)} onStatusesChanged={catalog => setStatusContext({ statuses: catalog.items, statusRevision: catalog.revision, defaultStatus: catalog.defaultStatus })} onSaved={saved} onReveal={reveal} onNotice={onNotice}/>}
      {projectEditor && <ProjectDialog spaceId={space.id} project={projectEditor.project} onClose={() => setProjectEditor(null)} onSaved={(item, created) => { generation.current++; setProjectEditor(null); setProjects(current => current.some(project => project.id === item.id) ? current.map(project => project.id === item.id ? item : project) : [...current, item]); if (created) { setProjectId(item.id); setArchived(false); setFocusedItem(null) } onNotice(created ? t('项目已创建', 'Project created') : t('项目已保存', 'Project saved')); reload() }}/>}
      {statusEditor && <StatusManager spaceId={space.id} focusId={statusEditor.focusId} onClose={() => setStatusEditor(null)} onSaved={catalog => { setStatusContext({ statuses: catalog.items, statusRevision: catalog.revision, defaultStatus: catalog.defaultStatus }); setStatusEditor(null); onNotice(t('状态已更新', 'Statuses updated')); reload() }}/>}
    </> : <main className="work-access-message" id="main-content"><LayoutDashboard size={36}/><h1>{bootstrap.user ? t('当前空间不可访问事项', 'Work items are not available in this space') : t('登录后查看事项', 'Sign in to view work items')}</h1><div><Button onClick={bootstrap.user ? onLibrary : onLogin}>{bootstrap.user ? t('打开资料库', 'Open library') : t('登录', 'Sign in')}</Button><Button variant="outline" onClick={onHome}>{t('返回首页', 'Return home')}</Button></div></main>}
  </div></WorkThemeContext.Provider>
}
