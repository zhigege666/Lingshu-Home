import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Archive, ArchiveRestore, ArrowRight, BellDot, BookOpen, Check, Circle, Folder, GripVertical, Home, LayoutDashboard, List, LogOut, MoreHorizontal, Pencil, Plus, RefreshCw, Search, X } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { ApiError, messageOf, request } from '../core/api'
import { getLocale, t } from '../core/i18n'
import { requestNavigation } from '../core/navigation'
import type { Bootstrap, Dashboard } from '../core/types'
import { newWorkId, workPath, workStatuses, type WorkBoard, type WorkColumn, type WorkItem, type WorkPage, type WorkProject, type WorkSelection, type WorkStatus, type WorkSummary } from '../core/work-types'
import { ProjectLogo } from '../components/ProjectLogo'
import { SpacePreferenceMenu } from '../components/SpacePreferenceMenu'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { StyledSelect } from '../components/ui/select'
import { ErrorMessage, Loading } from '../components/Shared'
import WorkEditor, { workStatusLabel } from './WorkEditor'
import ProjectDialog from './ProjectDialog'
import './work.css'

type Props = { bootstrap: Bootstrap; dashboard: Dashboard; route: string; onHome: () => void; onLibrary: () => void; onLogin: () => void; onLogout: () => Promise<void>; onSpaceChange: (id: string) => void }
function Menu({ item, disabled, onMove, onArchive }: { item: WorkSummary; disabled: boolean; onMove: (status: WorkStatus) => void; onArchive: () => void }) {
  const later = useRef<(() => void) | null>(null)
  return <DropdownMenu.Root modal={false}><DropdownMenu.Trigger asChild><button type="button" className="work-card-menu-trigger" disabled={disabled} aria-label={t('事项操作：{title}', 'Item actions: {title}', { title: item.title })} onClick={event => event.stopPropagation()}><MoreHorizontal size={17}/></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="admin-ui work-menu" align="end" sideOffset={5} collisionPadding={10} onCloseAutoFocus={event => { const action = later.current; later.current = null; if (action) { event.preventDefault(); action() } }}>
    {!item.archived && <><DropdownMenu.Label>{t('移动到', 'Move to')}</DropdownMenu.Label>{workStatuses.map(status => <DropdownMenu.Item key={status} disabled={status === item.status} onSelect={() => { later.current = () => onMove(status) }}><span className={`work-status-dot ${status}`}/>{workStatusLabel(status)}{status === item.status && <Check size={13}/>}</DropdownMenu.Item>)}<DropdownMenu.Separator/></>}
    <DropdownMenu.Item onSelect={() => { later.current = onArchive }}>{item.archived ? <ArchiveRestore size={15}/> : <Archive size={15}/>}<span>{item.archived ? t('恢复事项', 'Restore item') : t('归档事项', 'Archive item')}</span></DropdownMenu.Item>
  </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
}
function routeSelection(route: string): WorkSelection | null {
  const query = new URLSearchParams(route.split('?')[1] || '')
  if (query.get('item')) return { id: query.get('item')! }
  if (query.get('new') !== '1') return null
  const kind = query.get('resourceKind'), id = query.get('resourceId')
  return { id: newWorkId(), create: true, reference: id && (kind === 'bookmark' || kind === 'document') ? { kind, id, title: query.get('title') || '', available: true } : undefined }
}

export default function BoardView({ bootstrap, dashboard, route, onHome, onLibrary, onLogin, onLogout, onSpaceChange }: Props) {
  const space = dashboard.space, identity = `${bootstrap.user?.id || 'visitor'}:${space.id}`
  const authorized = !!bootstrap.user && space.canEdit
  const [projects, setProjects] = useState<WorkProject[]>([]), [projectId, setProjectId] = useState(''), [projectSearch, setProjectSearch] = useState(''), [projectLimit, setProjectLimit] = useState(40)
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [attention, setAttention] = useState(false), [archived, setArchived] = useState(false), [view, setView] = useState<'board' | 'list'>('board')
  const [board, setBoard] = useState<WorkBoard | null>(null), [list, setList] = useState<WorkPage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const [selection, setSelection] = useState<WorkSelection | null>(() => authorized ? routeSelection(route) : null), [projectEditor, setProjectEditor] = useState<{ project: WorkProject | null } | null>(null)
  const [notice, setNotice] = useState<{ text: string; itemId?: string } | null>(null), [busy, setBusy] = useState(false), [loadingMore, setLoadingMore] = useState<string[]>([]), [dragId, setDragId] = useState(''), [dropBefore, setDropBefore] = useState('')
  const generation = useRef(0), alive = useRef(true), mutating = useRef(false), paging = useRef(new Set<string>()), dragging = useRef<WorkSummary | null>(null), previousRoute = useRef(route)
  const path = workPath(space.id), canEdit = authorized && (board?.canEdit ?? list?.canEdit ?? false)
  const reload = useCallback(() => setRefresh(value => value + 1), [])
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer) }, [query])
  useEffect(() => { if (previousRoute.current !== route) { previousRoute.current = route; setSelection(authorized ? routeSelection(route) : null) } }, [route, authorized])
  function parameters(status?: WorkStatus, cursor?: string) {
    const result = new URLSearchParams({ limit: '30', archived: String(archived) })
    if (projectId) result.set('projectId', projectId)
    if (search) result.set('q', search)
    if (attention) result.set('attention', 'true')
    if (status) result.set('status', status)
    if (cursor) result.set('cursor', cursor)
    return result
  }
  useEffect(() => {
    const abort = new AbortController(), token = ++generation.current
    setLoading(true); setError(''); setBoard(null); setList(null); paging.current.clear(); setLoadingMore([])
    if (!authorized) { setLoading(false); return () => abort.abort() }
    const endpoint = view === 'board' ? '/board' : '/items'
    Promise.all([
      request<WorkBoard | WorkPage>(`${path}${endpoint}?${parameters()}`, { signal: abort.signal }),
      request<{ items: WorkProject[] }>(`${path}/projects`, { signal: abort.signal })
    ]).then(([data, projectData]) => {
      if (token !== generation.current || abort.signal.aborted) return
      if (view === 'board') setBoard(data as WorkBoard); else setList(data as WorkPage)
      setProjects(projectData.items)
    }).catch(cause => { if (!abort.signal.aborted && token === generation.current) setError(messageOf(cause)) })
      .finally(() => { if (!abort.signal.aborted && token === generation.current) setLoading(false) })
    return () => abort.abort()
  }, [identity, authorized, path, projectId, search, attention, archived, view, refresh])
  async function more(column?: WorkColumn) {
    const key = column?.status || 'list', cursor = column?.nextCursor || (!column ? list?.nextCursor : null)
    if (!cursor || paging.current.has(key)) return
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
  function open(item: WorkSummary) { requestNavigation(() => setSelection({ id: item.id })) }
  function create(status: WorkStatus = 'todo') {
    const project = projects.find(item => item.id === projectId)
    requestNavigation(() => setSelection({ id: newWorkId(), create: true, status, projectId: project && !project.archived ? project.id : null }))
  }
  function editProject(project: WorkProject | null) { requestNavigation(() => { setSelection(null); setProjectEditor({ project }) }) }
  function changeArchive(item: WorkSummary) {
    requestNavigation(() => { setSelection(null); void mutate(item, { expectedRevision: item.revision, archived: !item.archived }, false) })
  }
  function move(item: WorkSummary, status: WorkStatus, beforeId: string | null) {
    if (beforeId === item.id || mutating.current || !canEdit || item.archived) return
    const revision = board?.revision || list?.revision
    if (!revision) return
    requestNavigation(() => { setSelection(null); void mutate(item, { expectedRevision: item.revision, expectedBoardRevision: revision, status, beforeId }, true) })
  }
  async function mutate(item: WorkSummary, body: Record<string, unknown>, isMove: boolean) {
    if (mutating.current) return
    mutating.current = true; setBusy(true); setError(''); setNotice(null)
    try {
      const result = await request<WorkItem>(`${path}/items/${encodeURIComponent(item.id)}${isMove ? '/move' : ''}`, { method: isMove ? 'POST' : 'PATCH', body })
      if (!alive.current) return
      setNotice({ text: isMove ? t('已移至{status}', 'Moved to {status}', { status: workStatusLabel(result.status) }) : result.archived ? t('事项已归档', 'Item archived') : t('事项已恢复', 'Item restored'), itemId: result.id }); reload()
    } catch (cause) {
      if (!alive.current) return
      if (cause instanceof ApiError && cause.status < 500) setError(cause.status === 409 ? t('事项或顺序已在其他地方更新，请刷新后再操作。', 'The item or order changed elsewhere. Refresh before continuing.') : messageOf(cause))
      else {
        try { await request<WorkItem>(`${path}/items/${encodeURIComponent(item.id)}`) } catch {}
        if (!alive.current) return
        setNotice({ text: t('操作结果尚未确认，正在重新读取看板。请核对当前状态与位置。', 'The result is unconfirmed. Reloading the board; check the current status and position.'), itemId: item.id }); reload()
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
      <div className="work-card-top"><button type="button" className="work-card-title" onClick={() => open(item)} aria-label={t('打开事项：{title}', 'Open item: {title}', { title: item.title })}>{item.title}</button>{canEdit && <Menu item={item} disabled={busy} onMove={status => move(item, status, null)} onArchive={() => changeArchive(item)}/>}</div>
      {item.nextStep && <p className="work-card-next" title={item.nextStep}>{item.nextStep}</p>}
      {(item.projectName || item.needsAttention || item.referenceCount > 0) && <footer>{item.projectName && <span className="work-project-badge" title={item.projectName}><Folder size={12}/>{item.projectName}</span>}{item.needsAttention && <span className="work-attention-badge" title={t('待我处理', 'Needs my attention')}><BellDot size={13}/></span>}{item.referenceCount > 0 && <span className="work-reference-count" aria-label={t('{count} 个关联资料', '{count} linked resources', { count: item.referenceCount })}><BookOpen size={13}/>{item.referenceCount}</span>}</footer>}
      {canEdit && !item.archived && <span className="work-drag-cue" aria-hidden="true"><GripVertical size={12}/></span>}
    </article>
  }
  const filteredProjects = useMemo(() => projects.filter(project => project.name.toLocaleLowerCase(getLocale()).includes(projectSearch.toLocaleLowerCase(getLocale()))), [projects, projectSearch])
  const total = board ? board.columns.reduce((sum, column) => sum + column.total, 0) : list?.total || 0
  const project = projects.find(item => item.id === projectId)
  const title = archived ? t('已归档事项', 'Archived items') : project?.name || t('事项看板', 'Work board')
  return <div className={`admin-ui work-shell ${selection ? 'has-detail' : ''}`} data-work-view={view}>
    <header className="work-topbar"><a className="work-brand" href="#/" onClick={event => { event.preventDefault(); requestNavigation(onHome) }}><ProjectLogo size={32}/><strong>{bootstrap.siteName || 'Lingshu-Home'}</strong></a><nav aria-label={t('主要导航', 'Primary navigation')}><button onClick={() => requestNavigation(onHome)}><Home size={17}/><span>{t('导航', 'Home')}</span></button><button onClick={() => requestNavigation(onLibrary)}><BookOpen size={17}/><span>{t('资料库', 'Library')}</span></button><span aria-current="page"><LayoutDashboard size={17}/>{t('事项', 'Work')}</span></nav><div className="work-account"><StyledSelect value={space.id} aria-label={t('选择空间', 'Choose a space')} onValueChange={id => requestNavigation(() => onSpaceChange(id))} options={bootstrap.spaces.map(item => ({ value: item.id, label: item.name }))}/><SpacePreferenceMenu bootstrap={bootstrap}/>{bootstrap.user && <Button variant="ghost" size="icon" aria-label={t('退出登录', 'Sign out')} onClick={() => requestNavigation(() => void onLogout())}><LogOut size={17}/></Button>}</div></header>
    {authorized ? <>
      <aside className="work-sidebar" aria-label={t('事项筛选', 'Work filters')}><nav className="work-quick-filters"><button className={!projectId && !archived && !attention ? 'active' : ''} onClick={() => { setProjectId(''); setAttention(false); setArchived(false) }}><LayoutDashboard size={18}/>{t('全部事项', 'All items')}</button><button className={attention ? 'active' : ''} aria-pressed={attention} onClick={() => { setAttention(value => !value); setArchived(false) }}><BellDot size={18}/>{t('待我处理', 'Needs my attention')}</button></nav><div className="work-project-heading"><h2>{t('项目', 'Projects')}</h2><Button type="button" variant="ghost" size="icon-sm" disabled={!canEdit || busy} aria-label={t('新建项目', 'New project')} onClick={() => editProject(null)}><Plus size={15}/></Button></div>{projects.length > 12 && <Input className="work-project-search" value={projectSearch} onChange={event => { setProjectSearch(event.target.value); setProjectLimit(40) }} placeholder={t('查找项目', 'Find projects')} aria-label={t('查找项目', 'Find projects')}/>}<div className="work-projects">{filteredProjects.slice(0, projectLimit).map(item => <div key={item.id} className={`${projectId === item.id ? 'active' : ''} ${item.archived ? 'archived' : ''}`} data-work-project-id={item.id}><button onClick={() => setProjectId(item.id)} title={item.name + (item.archived ? t('（已归档）', ' (archived)') : '')}><Folder size={16}/><span>{item.name}</span>{item.archived && <Archive size={12}/>}</button>{canEdit && <button className="work-project-edit" aria-label={t('编辑项目：{name}', 'Edit project: {name}', { name: item.name })} onClick={() => editProject(item)}><Pencil size={13}/></button>}</div>)}{filteredProjects.length > projectLimit && <Button variant="ghost" size="sm" onClick={() => setProjectLimit(value => value + 40)}>{t('更多项目', 'More projects')}</Button>}</div><footer><button className={archived ? 'active' : ''} onClick={() => setArchived(value => !value)} aria-pressed={archived}><Archive size={17}/>{t('已归档', 'Archived')}</button></footer></aside>
      <main className="work-main" id="main-content"><div className="work-heading"><div><h1>{title}</h1>{!loading && <span className="work-total" aria-label={t('共 {count} 个事项', '{count} items total', { count: total })}>{total}</span>}{attention && <span className="work-filter-badge">{t('待我处理', 'Needs my attention')}<button aria-label={t('清除待我处理筛选', 'Clear attention filter')} onClick={() => setAttention(false)}><X size={12}/></button></span>}</div><div className="work-heading-actions"><Button variant="ghost" size="icon" disabled={loading || busy} aria-label={t('刷新看板', 'Refresh board')} onClick={reload}><RefreshCw size={17}/></Button><Button data-work-new disabled={!canEdit || busy} onClick={() => create()}><Plus size={16}/>{t('新建事项', 'New item')}</Button></div></div>
        <div className="work-toolbar"><label className="work-search"><Search size={17}/><Input type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label={t('搜索事项', 'Search items')} placeholder={t('搜索事项', 'Search items')}/></label><div className="work-mobile-project"><StyledSelect aria-label={t('筛选项目', 'Filter projects')} value={projectId} onValueChange={setProjectId} options={[{ value: '', label: t('全部项目', 'All projects') }, ...projects.map(item => ({ value: item.id, label: item.name + (item.archived ? t('（已归档）', ' (archived)') : '') }))]}/></div>{projectId && <button className="work-clear-project" onClick={() => setProjectId('')}>{t('全部项目', 'All projects')}<X size={13}/></button>}<div className="work-mobile-tools"><Button variant="ghost" size="icon-sm" aria-label={t('待我处理', 'Needs my attention')} aria-pressed={attention} onClick={() => setAttention(value => !value)}><BellDot size={16}/></Button><Button variant="ghost" size="icon-sm" aria-label={t('已归档', 'Archived')} aria-pressed={archived} onClick={() => setArchived(value => !value)}><Archive size={16}/></Button><Button variant="ghost" size="icon-sm" disabled={!canEdit || busy} aria-label={t('新建项目', 'New project')} onClick={() => editProject(null)}><Plus size={16}/></Button></div><div className="work-view-toggle" role="group" aria-label={t('事项视图', 'Work view')}><button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}><LayoutDashboard size={15}/>{t('看板', 'Board')}</button><button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={15}/>{t('列表', 'List')}</button></div></div>
        <ErrorMessage error={error}/>{error && <Button className="work-error-refresh" variant="outline" size="sm" onClick={reload}>{t('重新读取看板', 'Reload board')}</Button>}{notice && <div className="work-feedback" role="status"><Check size={16}/><span>{notice.text}</span>{notice.itemId && <button onClick={() => requestNavigation(() => setSelection({ id: notice.itemId! }))}>{t('打开事项', 'Open item')}<ArrowRight size={13}/></button>}<button aria-label={t('关闭提示', 'Dismiss notice')} onClick={() => setNotice(null)}><X size={14}/></button></div>}
        {loading ? <Loading text={t('正在读取事项…', 'Loading items…')}/> : view === 'board' && board ? <div className="work-board" aria-label={t('事项看板', 'Work board')}>{workStatuses.map(status => { const column = board.columns.find(item => item.status === status) || { status, total: 0, items: [], nextCursor: null }; return <section key={status} className={`work-lane ${dropBefore === status ? 'drop-end' : ''}`} data-work-status={status} aria-labelledby={`work-status-${status}`} onDragOver={event => dragOver(event, status)} onDrop={event => acceptDrop(event, status, null)}><header><h2 id={`work-status-${status}`}><span className={`work-status-dot ${status}`}/>{workStatusLabel(status)}<span className="work-column-count">{column.total}</span></h2>{canEdit && !archived && <button aria-label={t('新建{status}事项', 'New {status} item', { status: workStatusLabel(status) })} onClick={() => create(status)}><Plus size={16}/></button>}</header><div className="work-lane-body">{column.items.map(card)}{!column.items.length && <div className="work-lane-empty"><Circle size={22}/><span>{t('暂无事项', 'No items')}</span></div>}{column.nextCursor && <button className="work-load-more" disabled={loadingMore.includes(status)} onClick={() => void more(column)}>{loadingMore.includes(status) ? t('正在加载…', 'Loading…') : t('加载更多（{shown}/{total}）', 'Load more ({shown}/{total})', { shown: column.items.length, total: column.total })}</button>}<div className="work-drop-tail" aria-hidden="true"/></div></section> })}</div> : list ? <div className="work-list-scroll"><table className="work-table"><thead><tr><th>{t('事项', 'Item')}</th><th>{t('状态', 'Status')}</th><th>{t('项目', 'Project')}</th><th>{t('下一步', 'Next step')}</th><th><span className="sr-only">{t('操作', 'Actions')}</span></th></tr></thead><tbody>{list.items.map(item => <tr key={item.id} data-work-id={item.id} data-work-status={item.status}><td><button className="work-list-title" onClick={() => open(item)}>{item.needsAttention && <BellDot size={15}/>}<span>{item.title}</span>{item.referenceCount > 0 && <small><BookOpen size={12}/>{item.referenceCount}</small>}</button></td><td><span className="work-list-status"><span className={`work-status-dot ${item.status}`}/>{workStatusLabel(item.status)}</span></td><td className="work-table-project">{item.projectName || '—'}</td><td className="work-table-next">{item.nextStep || '—'}</td><td>{canEdit && <Menu item={item} disabled={busy} onMove={status => move(item, status, null)} onArchive={() => changeArchive(item)}/>}</td></tr>)}</tbody></table>{!list.items.length && <div className="work-list-empty">{t('没有匹配的事项', 'No matching items')}</div>}{list.nextCursor && <button className="work-load-more" disabled={loadingMore.includes('list')} onClick={() => void more()}>{loadingMore.includes('list') ? t('正在加载…', 'Loading…') : t('加载更多（{shown}/{total}）', 'Load more ({shown}/{total})', { shown: list.items.length, total: list.total })}</button>}</div> : null}
      </main>
      {selection && <WorkEditor key={selection.id} spaceId={space.id} selection={selection} projects={projects} canEdit={canEdit} onClose={() => setSelection(null)} onSaved={(item, message) => { setNotice({ text: message, itemId: item.id }); reload() }}/>}
      {projectEditor && <ProjectDialog spaceId={space.id} project={projectEditor.project} onClose={() => setProjectEditor(null)} onSaved={(item, created) => { setProjectEditor(null); if (created) setProjectId(item.id); setNotice({ text: created ? t('项目已创建', 'Project created') : t('项目已保存', 'Project saved') }); reload() }}/> }
    </> : <main className="work-access-message" id="main-content"><LayoutDashboard size={36}/><h1>{bootstrap.user ? t('当前空间不可访问事项', 'Work items are not available in this space') : t('登录后查看事项', 'Sign in to view work items')}</h1><div><Button onClick={bootstrap.user ? onLibrary : onLogin}>{bootstrap.user ? t('打开资料库', 'Open library') : t('登录', 'Sign in')}</Button><Button variant="outline" onClick={onHome}>{t('返回首页', 'Return home')}</Button></div></main>}
  </div>
}
