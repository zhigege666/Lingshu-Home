import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, ChevronLeft, ChevronRight, LoaderCircle, MoreHorizontal, Redo2, RefreshCw, Save, Search, Undo2, X } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { getLocale, t } from '../core/i18n'
import { beforeNavigationEvent } from '../core/navigation'
import type { Bootstrap, Category, Dashboard, Dataset, LinkInput, NavigationData, NavLink } from '../core/types'
import { buildBatchEdit, cacheInlineDraft, cachedInlineDraft, categoryDraft, clearInlineDrafts, committedInlineDataset, draftCount, draftNavigation, freshInlineDraft, inlineDraftEpoch, linkDraft, putDraft, readDraft, rebaseInlineDraft, resolveInlineConflict, type BatchEditResult, type CategoryDraft, type DraftChanges, type InlineConflict, type InlineDraft, type InlineError, type InlineKind, type LinkDraft } from '../core/navigation-inline'
import { FieldHelp } from '../components/FieldHelp'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Checkbox } from '../components/ui/checkbox'
import { StyledSelect } from '../components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Empty, Modal } from '../components/Shared'
import { CategoryEditor, LinkEditor } from './ContentForms'
import './navigation-inline.css'

type Props = { kind: InlineKind; identity: string; bootstrap: Bootstrap; dashboard: Dashboard; dataset: Dataset<NavigationData>; onKindChange: (kind: InlineKind) => void; onCommitted: (dataset: Dataset<NavigationData>) => void; onExit: () => void; onSessionChanged: () => Promise<void>; onNotice: (message: string) => void }
type Detail = { kind: InlineKind; id: string }
const fieldLabel = (field: string) => ({
  name: t('分类名称', 'Category name'), parentId: t('父分类', 'Parent category'), icon: t('图标', 'Icon'), sortOrder: t('排序', 'Sort order'), title: t('链接名称', 'Link name'), url: t('主入口 URL', 'Primary URL'), categoryId: t('分类', 'Category'), tags: t('标签', 'Tags'), isFavorite: t('收藏', 'Favorite'), description: t('描述', 'Description'), iconMode: t('图标模式', 'Icon mode'), endpoints: t('其他入口', 'Additional URLs'), $deleted: t('已删除的记录', 'Deleted record'),
} as Record<string, string>)[field] || field
function validationText(error: InlineError) {
  if (error.message) return error.message
  return ({
    name: t('名称须为 1–80 个字符。', 'Use 1–80 characters for the name.'),
    title: t('名称须为 1–160 个字符。', 'Use 1–160 characters for the name.'),
    url: t('请输入完整的 HTTP 或 HTTPS 网址。', 'Enter a complete HTTP or HTTPS URL.'),
    order: t('排序须为 −1000000 到 1000000 之间的整数。', 'Use an integer from −1000000 to 1000000.'),
    tags: t('最多 32 个标签，每个不超过 40 个字符。', 'Use up to 32 tags, each at most 40 characters.'),
    description: t('描述不能超过 2000 个字符。', 'Keep the description within 2000 characters.'),
    endpoints: t('其他入口无效，请在更多设置中检查。', 'Check the additional URLs in More settings.'),
    parent: t('父分类已不存在，请重新选择。', 'Choose an existing parent category.'),
    category: t('分类已不存在，请重新选择。', 'Choose an existing category.'),
    cycle: t('父分类不能指向自身或形成循环。', 'Parent categories cannot form a cycle.'),
    depth: t('分类层级不能超过 32 层。', 'Categories cannot exceed 32 levels.'),
    deleted: t('该记录已被删除，请重新读取。', 'This record was deleted. Reload the latest data.'),
    limit: t('每批最多修改 500 条记录，请先保存这一批。', 'Save this batch before changing more than 500 records.'),
  } as Record<string, string>)[error.code] || t('请检查此字段。', 'Check this field.')
}
function valueLabel(value: unknown, categories: Category[], field: string) {
  if (field === 'parentId' || field === 'categoryId') return value ? categories.find(row => row.id === value)?.name || String(value) : t('无', 'None')
  if (typeof value === 'boolean') return value ? t('是', 'Yes') : t('否', 'No')
  if (value === null || value === undefined || value === '') return t('空', 'Empty')
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join(', ') || t('空', 'Empty')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
export default function NavigationInlineEditor({ kind, identity, bootstrap, dashboard, dataset, onKindChange, onCommitted, onExit, onSessionChanged, onNotice }: Props) {
  const spaceId = dashboard.space.id
  const cacheEpoch = useRef(inlineDraftEpoch(identity, spaceId))
  const [seed] = useState(() => {
    const saved = cachedInlineDraft(identity, spaceId)
    if (!saved) return { draft: freshInlineDraft(dataset), conflicts: [] as InlineConflict[], needsRead: false, restored: false }
    if (saved.conflicts.length) return { ...saved, needsRead: saved.needsRead || saved.draft.base.revision !== dataset.revision, restored: true }
    const merged = saved.draft.base.revision === dataset.revision ? { draft: saved.draft, conflicts: [] as InlineConflict[] } : rebaseInlineDraft(saved.draft, dataset)
    return { ...merged, needsRead: saved.needsRead, restored: true }
  })
  const [draft, setDraft] = useState<InlineDraft>(seed.draft), [conflicts, setConflicts] = useState<InlineConflict[]>(seed.conflicts)
  const [needsRead, setNeedsRead] = useState(seed.needsRead), [query, setQuery] = useState(''), [onlyChanged, setOnlyChanged] = useState(false)
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(25), [saving, setSaving] = useState(false), [reading, setReading] = useState(false)
  const [error, setError] = useState(''), [errors, setErrors] = useState<InlineError[]>([]), [status, setStatus] = useState(seed.restored ? t('已恢复此账号在当前页面中的草稿。', 'Your draft in this page has been restored.') : '')
  const [detail, setDetail] = useState<Detail | null>(null), [leaveOpen, setLeaveOpen] = useState(false), [suspended, setSuspended] = useState(false)
  const draftRef = useRef(draft), conflictsRef = useRef(conflicts), needsReadRef = useRef(needsRead), pending = useRef<(() => void) | null>(null)
  const busyRef = useRef(false), mounted = useRef(true), table = useRef<HTMLDivElement | null>(null), readController = useRef<AbortController | null>(null)
  const history = useRef<{ past: DraftChanges[]; future: DraftChanges[]; group: string }>({ past: [], future: [], group: '' })
  const latest = useRef({ onCommitted, onExit, onSessionChanged, onKindChange, kind, detail }); latest.current = { onCommitted, onExit, onSessionChanged, onKindChange, kind, detail }
  const count = draftCount(draft), blocked = saving || reading || suspended
  function remember(next = draftRef.current, nextConflicts = conflictsRef.current, uncertain = needsReadRef.current) {
    cacheInlineDraft({ identity, spaceId, kind: latest.current.kind, draft: next, conflicts: nextConflicts, needsRead: uncertain }, cacheEpoch.current)
  }
  function install(next: InlineDraft, nextConflicts = conflictsRef.current, uncertain = needsReadRef.current) {
    draftRef.current = next; conflictsRef.current = nextConflicts; needsReadRef.current = uncertain
    remember(next, nextConflicts, uncertain)
    if (mounted.current) { setDraft(next); setConflicts(nextConflicts); setNeedsRead(uncertain) }
  }
  useEffect(() => {
    mounted.current = true
    const before = (event: Event) => {
      if (event.defaultPrevented) return
      if (busyRef.current) { event.preventDefault(); return }
      if (!draftCount(draftRef.current) && !needsReadRef.current && !conflictsRef.current.length && !latest.current.detail) return
      event.preventDefault()
      if (latest.current.detail) { setError(t('请先应用或取消更多设置中的修改。', 'Apply or cancel the changes in More settings first.')); return }
      pending.current = (event as CustomEvent<{ proceed: () => void }>).detail?.proceed || null
      setLeaveOpen(true)
    }
    const unload = (event: BeforeUnloadEvent) => {
      if (draftCount(draftRef.current) || needsReadRef.current || busyRef.current || latest.current.detail) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener(beforeNavigationEvent, before); window.addEventListener('beforeunload', unload)
    return () => { remember(); mounted.current = false; readController.current?.abort(); window.removeEventListener(beforeNavigationEvent, before); window.removeEventListener('beforeunload', unload) }
  }, [identity, spaceId])
  useEffect(() => { setQuery(''); setPage(1); history.current.group = ''; remember() }, [kind])
  const originalCategories = draft.base.data.categories
  const categoryOptions = useMemo(() => originalCategories.map(row => ({ value: row.id, label: draft.categories[row.id]?.name.trim() || row.name })), [originalCategories, draft.categories])
  const ordered = useMemo(() => {
    const rows = kind === 'categories' ? [...draft.base.data.categories] : [...draft.base.data.links]
    return rows.sort((a, b) => a.sortOrder - b.sortOrder || ('title' in a ? a.title : a.name).localeCompare('title' in b ? b.title : b.name, getLocale()))
  }, [draft.base, kind])
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase(getLocale())
    return ordered.filter(row => (!onlyChanged || Object.hasOwn(draft[kind], row.id)) && (!search || ('title' in row ? [row.title, row.url, row.description, ...(row.tags || [])].join(' ') : row.name).toLocaleLowerCase(getLocale()).includes(search)))
  }, [ordered, query, onlyChanged, draft.categories, draft.links, kind])
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize)), currentPage = Math.min(page, pages), visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  useEffect(() => { if (page > pages) setPage(pages) }, [page, pages])
  useEffect(() => { if (table.current) table.current.scrollTop = 0 }, [currentPage, pageSize, kind, query, onlyChanged])
  function changeRow(rowKind: InlineKind, id: string, value: CategoryDraft | LinkDraft, group: string) {
    if (busyRef.current || needsReadRef.current || conflictsRef.current.length || suspended) return
    const previous = draftRef.current
    if (!Object.hasOwn(previous[rowKind], id) && draftCount(previous) >= 500) { setError(validationText({ kind: rowKind, id, field: '', code: 'limit' })); return }
    const next = putDraft(previous, rowKind, id, value)
    if (JSON.stringify(previous[rowKind][id]) === JSON.stringify(next[rowKind][id])) return
    if (history.current.group !== group) {
      history.current.past = [...history.current.past.slice(-39), { categories: previous.categories, links: previous.links }]
      history.current.group = group
    }
    history.current.future = []; install(next); setStatus(''); setError(''); setErrors(previousErrors => previousErrors.filter(item => item.kind !== rowKind || item.id !== id))
  }
  function undo(redo = false) {
    if (blocked || needsRead || conflicts.length) return
    const from = redo ? history.current.future : history.current.past, snapshot = from.pop()
    if (!snapshot) return
    const into = redo ? history.current.past : history.current.future
    into.push({ categories: draftRef.current.categories, links: draftRef.current.links }); history.current.group = ''
    install({ ...draftRef.current, ...snapshot }); setErrors([]); setError(''); setStatus('')
  }
  function resetHistory() { history.current = { past: [], future: [], group: '' } }
  function finishLeave() { const proceed = pending.current; pending.current = null; setLeaveOpen(false); proceed?.() }
  function discard() {
    if (busyRef.current) return
    install(freshInlineDraft(draftRef.current.base), [], false); resetHistory()
    setError(''); setErrors([]); setStatus(''); finishLeave()
  }
  function cancelEditing() {
    if (!count && !needsRead && !conflicts.length) { onExit(); return }
    pending.current = onExit; setLeaveOpen(true)
  }
  function focusError(item: InlineError) {
    if (item.kind !== latest.current.kind) latest.current.onKindChange(item.kind)
    setOnlyChanged(false); setQuery('')
    const rows = [...draftRef.current.base.data[item.kind]].sort((a, b) => a.sortOrder - b.sortOrder || ('title' in a ? a.title : a.name).localeCompare('title' in b ? b.title : b.name, getLocale()))
    const index = rows.findIndex(row => row.id === item.id)
    if (index >= 0) setPage(Math.floor(index / pageSize) + 1)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const cell = Array.from(table.current?.querySelectorAll<HTMLElement>('[data-inline-cell]') || []).find(node => node.dataset.rowId === item.id && node.dataset.field === item.field)
      const control = cell?.querySelector<HTMLElement>('input,button,select,textarea'); control?.focus(); control?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }))
  }
  async function identityReadback(clear = false) {
    if (clear) clearInlineDrafts(identity, spaceId)
    setSuspended(true)
    try { await latest.current.onSessionChanged() } catch {}
    finally { if (mounted.current) setSuspended(false) }
  }
  async function save(leave = false) {
    if (busyRef.current || needsReadRef.current || conflictsRef.current.length || suspended) return
    const current = draftRef.current, validation = buildBatchEdit(current)
    if (validation.errors.length) { setErrors(validation.errors); setError(t('请先修正标出的字段。', 'Correct the highlighted fields first.')); setLeaveOpen(false); focusError(validation.errors[0]); return }
    if (!validation.body.categories.length && !validation.body.links.length) {
      install(freshInlineDraft(current.base), [], false); resetHistory(); setStatus(t('没有需要保存的变化。', 'There are no changes to save.'))
      if (leave) finishLeave(); return
    }
    busyRef.current = true; setSaving(true); setError(''); setErrors([])
    // If this component disappears during an in-flight request, recovery must
    // read the server before it can offer another write.
    needsReadRef.current = true; remember(current, [], true)
    try {
      const result = await request<BatchEditResult>('/spaces/' + encodeURIComponent(spaceId) + '/navigation/batch-edit', { method: 'POST', body: validation.body })
      if (!result || typeof result.revision !== 'string' || !Array.isArray(result.categories) || !Array.isArray(result.links) || typeof result.updatedCount !== 'number') throw new Error(t('保存结果尚未确认。', 'The save result is not confirmed.'))
      const committed = committedInlineDataset(current, result)
      install(freshInlineDraft(committed), [], false); resetHistory()
      if (mounted.current) {
        latest.current.onCommitted(committed)
        const message = t('已保存 {count} 条修改。', 'Saved {count} changed records.', { count: result.updatedCount })
        setStatus(message); onNotice(message); if (leave) finishLeave()
      }
    } catch (cause) {
      const knownRejection = cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && ![408,409,401,403,404].includes(cause.status)
      install(current, [], !knownRejection)
      if (!mounted.current) return
      setLeaveOpen(false)
      if (knownRejection) {
        setError(messageOf(cause))
        if (cause instanceof ApiError && typeof cause.details.id === 'string' && typeof cause.details.field === 'string') {
          const rowKind: InlineKind = String(cause.details.entity).startsWith('categor') ? 'categories' : 'links'
          const item = { kind: rowKind, id: cause.details.id, field: cause.details.field, code: 'server', message: cause.message }
          setErrors([item]); focusError(item)
        }
      } else {
        setError(cause instanceof ApiError && cause.status === 409
          ? t('列表已被其他操作更新。请读取最新内容，比较后再保存；你的输入已保留。', 'The list changed elsewhere. Read the latest data and review differences before saving. Your input is preserved.')
          : t('保存结果尚未确认。请读取最新内容核对，当前草稿已保留。', 'The save result is not confirmed. Read the latest data to check it. Your draft is preserved.'))
        if (cause instanceof ApiError && [401,403].includes(cause.status)) await identityReadback()
      }
    } finally { busyRef.current = false; if (mounted.current) setSaving(false) }
  }
  async function readLatest() {
    if (busyRef.current || conflictsRef.current.length) return
    busyRef.current = true; setReading(true); setError('')
    const controller = new AbortController(); readController.current = controller
    try {
      const value = await request<Dataset<NavigationData>>('/spaces/' + encodeURIComponent(spaceId) + '/navigation', { signal: controller.signal })
      if (controller.signal.aborted || !mounted.current) return
      const merged = rebaseInlineDraft(draftRef.current, value)
      install(merged.draft, merged.conflicts, false); resetHistory(); setErrors([]); latest.current.onCommitted(value)
      setStatus(merged.conflicts.length ? t('有 {count} 处冲突，请逐项选择。', 'Review {count} conflicting fields.', { count: merged.conflicts.length })
        : draftCount(merged.draft) ? t('已读取最新内容，你的修改已保留，可以继续保存。', 'The latest data is loaded. Your edits are preserved and ready to save.')
          : t('已按服务器最新内容确认，无需再次保存。', 'Confirmed against the latest server data. No further save is needed.'))
    } catch (cause) {
      if (controller.signal.aborted || !mounted.current) return
      setError(messageOf(cause))
      if (cause instanceof ApiError && [401,403,404].includes(cause.status)) await identityReadback(cause.status !== 401)
    } finally { busyRef.current = false; if (mounted.current) setReading(false) }
  }
  function resolve(conflict: InlineConflict, choice: 'mine' | 'server') {
    install(resolveInlineConflict(draftRef.current, conflict, choice), conflictsRef.current.filter(item => item !== conflict))
    resetHistory(); setErrors([])
  }
  function keydown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || blocked || detail || !(event.target instanceof HTMLElement) || !event.target.closest('[data-inline-cell]')) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.altKey) { event.preventDefault(); undo(event.shiftKey); return }
    if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey || !(event.target instanceof HTMLInputElement) || ['checkbox','radio','button','submit'].includes(event.target.type)) return
    const controls = Array.from(table.current?.querySelectorAll<HTMLElement>('[data-inline-cell] input:not([type=hidden]),[data-inline-cell] button[role=combobox],[data-inline-cell] button[role=checkbox]') || []).filter(node => !node.hasAttribute('disabled') && node.getAttribute('aria-hidden') !== 'true')
    const index = controls.indexOf(event.target), next = controls[index + (event.shiftKey ? -1 : 1)]
    event.preventDefault(); next?.focus()
  }
  function cell(id: string, field: string, children: ReactNode, rowKind = kind) {
    const problem = errors.find(item => item.kind === rowKind && item.id === id && item.field === field), errorId = 'inline-error-' + id + '-' + field
    return <div className={'inline-cell' + (problem ? ' inline-cell-invalid' : '')} data-inline-cell data-row-id={id} data-field={field} onFocusCapture={() => { history.current.group = '' }}>{children}{problem && <small id={errorId} className="inline-field-error">{validationText(problem)}</small>}</div>
  }
  const invalidProps = (id: string, field: string) => errors.some(item => item.kind === kind && item.id === id && item.field === field) ? { 'aria-invalid': true as const, 'aria-describedby': 'inline-error-' + id + '-' + field } : {}
  const label = (row: Category | NavLink, field: string) => fieldLabel(field) + ' · ' + ('title' in row ? row.title : row.name)
  function showDetail(row: Category | NavLink) {
    const invalid = buildBatchEdit(draftRef.current).errors.find(item => item.id === row.id && item.field === 'sortOrder')
    if (invalid) { setErrors([invalid]); focusError(invalid); return }
    setDetail({ kind, id: row.id })
  }
  const editingDisabled = blocked || needsRead || conflicts.length > 0
  const detailData = useMemo(() => draftNavigation(draft), [draft])
  const detailDashboard = { ...dashboard, datasets: { ...dashboard.datasets, navigation: { ...draft.base, data: detailData } } }
  if (suspended) return <div className="admin-loading" role="status"><LoaderCircle size={20} className="admin-spin"/>{t('正在核对登录与空间权限…', 'Checking login and space access…')}</div>
  return <section className="navigation-inline" aria-label={t('列表批量编辑', 'Inline batch editor')} onKeyDown={keydown}>
    <div className="inline-savebar">
      <strong className="inline-editing-label">{t('列表编辑', 'Edit list')}</strong>
      <span className="inline-draft-count" role="status">{t('{count} 条待保存', '{count} unsaved records', { count })}</span>
      <FieldHelp label={t('列表编辑帮助', 'List editing help')}>
        <p>{t('分类和链接的草稿可以跨页修改，一次最多保存 500 条。Tab 切换控件；输入框内按回车前进，Shift＋回车后退。', 'Edit categories and links across pages, up to 500 records per batch. Tab moves between controls; Enter moves forward in text inputs and Shift+Enter moves back.')}</p>
        <p>{t('筛选和排序在保存前保持稳定。“更多设置”先应用到草稿，统一保存后才更新记录。草稿仅保留在当前页面，刷新或关闭页面前请保存。', 'Filtering and ordering stay stable while editing. More settings apply to the draft before the batch is saved. Drafts live only in this page; save before reloading or closing it.')}</p>
      </FieldHelp>
      <span className="grow"/>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t('撤销修改', 'Undo edit')} title={t('撤销 · Ctrl/⌘ Z', 'Undo · Ctrl/⌘ Z')} disabled={editingDisabled || !history.current.past.length} onClick={() => undo()}><Undo2 size={17}/></Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t('重做修改', 'Redo edit')} title={t('重做 · Ctrl/⌘ Shift Z', 'Redo · Ctrl/⌘ Shift Z')} disabled={editingDisabled || !history.current.future.length} onClick={() => undo(true)}><Redo2 size={17}/></Button>
      <Button type="button" variant="outline" disabled={blocked} onClick={cancelEditing}><X size={15}/>{t('结束编辑', 'Finish editing')}</Button>
      <Button type="button" disabled={editingDisabled || !count} onClick={() => void save()}>{saving ? <LoaderCircle size={15} className="admin-spin"/> : <Save size={15}/>} {t('保存全部', 'Save all')}</Button>
    </div>
    {error && <div className="admin-error inline-notice" role="alert">{error}</div>}
    {status && <div className="inline-status" role="status"><Check size={14}/><span>{status}</span></div>}
    {needsRead && <div className="inline-recovery"><Button type="button" variant="outline" disabled={blocked || conflicts.length > 0} onClick={() => void readLatest()}>{reading ? <LoaderCircle size={15} className="admin-spin"/> : <RefreshCw size={15}/>} {t('读取最新内容并比较', 'Read latest and compare')}</Button></div>}
    {conflicts.length > 0 && <section className="inline-conflicts" aria-label={t('解决编辑冲突', 'Resolve edit conflicts')}>
      <h2>{t('选择要保留的内容', 'Choose what to keep')}</h2>
      {conflicts.map((conflict, index) => {
        const row = draft.base.data[conflict.kind].find(item => item.id === conflict.id)
        const rowName = row ? ('title' in row ? row.title : row.name) : t('已删除的记录', 'Deleted record')
        return <div className="inline-conflict" key={conflict.kind + conflict.id + conflict.field}>
          <strong>{rowName} · {fieldLabel(conflict.field)}</strong>
          {conflict.field === '$deleted' ? <><p>{t('该记录已被删除，不能覆盖恢复。请丢弃这条草稿；其他修改仍会保留。', 'This record was deleted and cannot be restored by an edit. Discard this row draft to keep working on the other changes.')}</p><Button type="button" variant="outline" size="sm" onClick={() => resolve(conflict, 'server')}>{t('丢弃此条草稿', 'Discard this row draft')}</Button></>
            : <><dl><div><dt>{t('编辑前', 'Before editing')}</dt><dd>{valueLabel(conflict.base, originalCategories, conflict.field)}</dd></div><div><dt>{t('我的草稿', 'My draft')}</dt><dd>{valueLabel(conflict.mine, originalCategories, conflict.field)}</dd></div><div><dt>{t('服务器最新', 'Latest on server')}</dt><dd>{valueLabel(conflict.server, originalCategories, conflict.field)}</dd></div></dl><div className="inline-conflict-actions"><Button type="button" size="sm" variant="outline" aria-label={t('冲突 {index}：保留我的修改', 'Conflict {index}: keep my change', { index: index + 1 })} onClick={() => resolve(conflict, 'mine')}>{t('保留我的修改', 'Keep my change')}</Button><Button type="button" size="sm" variant="outline" aria-label={t('冲突 {index}：使用服务器内容', 'Conflict {index}: use server value', { index: index + 1 })} onClick={() => resolve(conflict, 'server')}>{t('使用服务器内容', 'Use server value')}</Button></div></>}
        </div>
      })}
    </section>}
    <div className="inline-filterbar"><div className="admin-search"><Search size={16}/><Input type="search" value={query} disabled={blocked} onChange={event => { setQuery(event.target.value); setPage(1) }} placeholder={kind === 'links' ? t('搜索链接、标签、网址…', 'Search links, tags, URLs…') : t('搜索分类…', 'Search categories…')} aria-label={t('筛选编辑列表', 'Filter edit list')}/></div>
      <label className="inline-only-changed"><Checkbox checked={onlyChanged} disabled={blocked} onCheckedChange={value => { setOnlyChanged(value); setPage(1) }}/>{t('只看已修改', 'Changed only')}</label>
      <span className="grow"/><Button type="button" size="sm" variant="ghost" disabled={blocked || !!conflicts.length} onClick={() => void readLatest()}><RefreshCw size={14}/>{t('核对最新内容', 'Check latest data')}</Button>
    </div>
    {visible.length ? <div className="admin-table-scroll inline-table-scroll" ref={table} role="region" aria-label={kind === 'links' ? t('链接编辑表格', 'Link edit table') : t('分类编辑表格', 'Category edit table')}>
      <Table className={'inline-table ' + (kind === 'links' ? 'inline-link-table' : 'inline-category-table')}>
        <TableHeader><TableRow>{(kind === 'links' ? ['title','url','categoryId','tags','sortOrder','isFavorite'] : ['name','parentId','sortOrder']).map(field => <TableHead key={field} className={'inline-col-' + field}>{fieldLabel(field)}</TableHead>)}<TableHead className="inline-col-more">{t('更多', 'More')}</TableHead></TableRow></TableHeader>
        <TableBody>{visible.map(row => {
          const dirty = Object.hasOwn(draft[kind], row.id)
          if (kind === 'categories') {
            const value = readDraft(draft, 'categories', row.id)
            const change = (field: keyof CategoryDraft, next: string | null) => changeRow('categories', row.id, { ...value, [field]: next }, row.id + ':' + field)
            return <TableRow key={row.id} data-dirty={dirty} data-row-id={row.id}>
              <TableCell>{cell(row.id, 'name', <Input value={value.name} maxLength={80} disabled={editingDisabled} aria-label={label(row, 'name')} {...invalidProps(row.id, 'name')} onChange={event => change('name', event.target.value)}/>)}</TableCell>
              <TableCell>{cell(row.id, 'parentId', <StyledSelect tone="admin" value={value.parentId || ''} disabled={editingDisabled} aria-label={label(row, 'parentId')} {...invalidProps(row.id, 'parentId')} options={[{ value: '', label: t('顶层分类', 'Top level') }, ...categoryOptions.filter(item => item.value !== row.id)]} onValueChange={next => change('parentId', next || null)}/>)}</TableCell>
              <TableCell>{cell(row.id, 'sortOrder', <Input value={value.sortOrder} inputMode="numeric" disabled={editingDisabled} aria-label={label(row, 'sortOrder')} {...invalidProps(row.id, 'sortOrder')} onChange={event => change('sortOrder', event.target.value)}/>)}</TableCell>
              <TableCell><Button type="button" variant="ghost" size="icon-sm" disabled={editingDisabled} aria-label={t('{name} 更多设置', 'More settings for {name}', { name: 'name' in row ? row.name : '' })} onClick={() => showDetail(row)}><MoreHorizontal size={17}/></Button></TableCell>
            </TableRow>
          }
          const value = readDraft(draft, 'links', row.id)
          const change = (field: keyof LinkDraft, next: unknown) => changeRow('links', row.id, { ...value, [field]: next } as LinkDraft, row.id + ':' + field)
          return <TableRow key={row.id} data-dirty={dirty} data-row-id={row.id}>
            <TableCell>{cell(row.id, 'title', <Input value={value.title} maxLength={160} disabled={editingDisabled} aria-label={label(row, 'title')} {...invalidProps(row.id, 'title')} onChange={event => change('title', event.target.value)}/>)}</TableCell>
            <TableCell>{cell(row.id, 'url', <Input value={value.url} maxLength={2048} disabled={editingDisabled} aria-label={label(row, 'url')} {...invalidProps(row.id, 'url')} onChange={event => change('url', event.target.value)}/>)}</TableCell>
            <TableCell>{cell(row.id, 'categoryId', <StyledSelect tone="admin" value={value.categoryId || ''} disabled={editingDisabled} aria-label={label(row, 'categoryId')} {...invalidProps(row.id, 'categoryId')} options={[{ value: '', label: t('未分类', 'Uncategorized') }, ...categoryOptions]} onValueChange={next => change('categoryId', next || null)}/>)}</TableCell>
            <TableCell>{cell(row.id, 'tags', <Input value={value.tags} maxLength={1400} disabled={editingDisabled} aria-label={label(row, 'tags')} {...invalidProps(row.id, 'tags')} onChange={event => change('tags', event.target.value)}/>)}</TableCell>
            <TableCell>{cell(row.id, 'sortOrder', <Input value={value.sortOrder} inputMode="numeric" disabled={editingDisabled} aria-label={label(row, 'sortOrder')} {...invalidProps(row.id, 'sortOrder')} onChange={event => change('sortOrder', event.target.value)}/>)}</TableCell>
            <TableCell>{cell(row.id, 'isFavorite', <Checkbox checked={value.isFavorite} disabled={editingDisabled} aria-label={label(row, 'isFavorite')} onCheckedChange={next => change('isFavorite', next)}/>)}</TableCell>
            <TableCell><Button type="button" variant="ghost" size="icon-sm" disabled={editingDisabled} aria-label={t('{name} 更多设置', 'More settings for {name}', { name: 'title' in row ? row.title : '' })} onClick={() => showDetail(row)}><MoreHorizontal size={17}/></Button></TableCell>
          </TableRow>
        })}</TableBody>
      </Table>
    </div> : <Empty title={t('没有符合条件的记录', 'No matching records')} detail={onlyChanged ? t('修改记录后会显示在这里。', 'Changed records will appear here.') : undefined}/>}
    <nav className="admin-pagination inline-pagination" aria-label={t('编辑列表分页', 'Edit list pagination')}><span className="admin-pagination-total">{filtered.length ? t('{start}–{end} / {total} 条', '{start}–{end} / {total} records', { start: (currentPage - 1) * pageSize + 1, end: Math.min(currentPage * pageSize, filtered.length), total: filtered.length }) : t('0 条', '0 records')}</span><div className="admin-page-size"><StyledSelect value={String(pageSize)} disabled={blocked} aria-label={t('编辑列表每页条数', 'Edit records per page')} options={[25,50,100].map(size => ({ value: String(size), label: t('{size} 条 / 页', '{size} / page', { size }) }))} onValueChange={value => { setPageSize(Number(value)); setPage(1) }}/></div><div className="admin-pagination-buttons"><Button type="button" variant="outline" size="icon-sm" disabled={blocked || currentPage === 1} aria-label={t('编辑列表上一页', 'Previous edit page')} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16}/></Button><span className="admin-page-number">{currentPage} / {pages}</span><Button type="button" variant="outline" size="icon-sm" disabled={blocked || currentPage === pages} aria-label={t('编辑列表下一页', 'Next edit page')} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16}/></Button></div></nav>
    {detail?.kind === 'links' && <LinkEditor dashboard={detailDashboard} link={detailData.links.find(row => row.id === detail.id)!} autoFetchIcons={bootstrap.autoFetchIcons !== false} autoSelectEndpoint={bootstrap.autoSelectEndpoint !== false} onClose={() => setDetail(null)} onSaved={async () => {}} onApplyDraft={(input: LinkInput) => { const row = draft.base.data.links.find(item => item.id === detail.id)!; history.current.group = ''; changeRow('links', detail.id, linkDraft({ ...row, ...input }), detail.id + ':details'); setDetail(null) }}/>}
    {detail?.kind === 'categories' && <CategoryEditor dashboard={detailDashboard} category={detailData.categories.find(row => row.id === detail.id)!} onClose={() => setDetail(null)} onSaved={async () => {}} onApplyDraft={input => { const row = draft.base.data.categories.find(item => item.id === detail.id)!; history.current.group = ''; changeRow('categories', detail.id, categoryDraft({ ...row, ...input }), detail.id + ':details'); setDetail(null) }}/>}
    {leaveOpen && <Modal title={t('保存列表中的修改？', 'Save your list changes?')} busy={blocked} onClose={() => { pending.current = null; setLeaveOpen(false) }}>
      <p>{needsRead ? t('上次保存结果尚未确认。读取最新内容后可继续保存；丢弃草稿不会撤销可能已完成的保存。', 'The last save result is unconfirmed. Read the latest data before saving again. Discarding the draft does not undo a save that may have completed.') : t('当前有 {count} 条草稿。离开前可以统一保存，或丢弃本页草稿。', 'There are {count} draft records. Save them together or discard this page’s draft before leaving.', { count })}</p>
      <div className="admin-form-footer"><Button type="button" variant="outline" disabled={blocked} onClick={() => { pending.current = null; setLeaveOpen(false) }}>{t('继续编辑', 'Keep editing')}</Button><Button type="button" variant="ghost" disabled={blocked} onClick={discard}>{t('丢弃草稿并离开', 'Discard draft and leave')}</Button><Button type="button" disabled={blocked || needsRead || !!conflicts.length} onClick={() => void save(true)}>{saving ? t('正在保存…', 'Saving…') : t('保存并离开', 'Save and leave')}</Button></div>
    </Modal>}
  </section>
}
