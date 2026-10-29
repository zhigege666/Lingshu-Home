import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, messageOf, request } from '../core/api'
import { beforeNavigationEvent } from '../core/navigation'
import { getLocale, t } from '../core/i18n'
import { createDraftHistory, inputHistoryGroup, recordDraft, redoDraft, undoDraft, type DraftHistory } from '../core/draft-history'
import { useHistoryShortcuts } from '../core/useHistoryShortcuts'
import { inlineDraftEpoch, committedInlineDataset, type BatchEditResult, type CategoryDraft, type InlineConflict, type InlineError, type InlineKind, type LinkDraft } from '../core/navigation-inline'
import { buildContentEdit, changeContentField, contentNavigation, discardContentOrder, freshContentDraft, moveContent, rebaseContentDraft, resolveContentField, type ContentDraft, type ContentSelection, type OrderConflict } from '../core/home-content-draft'
import type { Dataset, NavigationData } from '../core/types'
import type { NavigationEditor } from './navigation-editor-types'

type Session = { context: string; identity: string; spaceId: string; epoch: string; history: DraftHistory<ContentDraft>; needsRead: boolean; conflicts: InlineConflict[]; orderConflicts: OrderConflict[] }
const drafts = new Map<string, Session>()
const cacheKey = (identity: string, spaceId: string) => identity + '/' + spaceId
let cacheGeneration = 0
const scopeGenerations = new Map<string, number>()
const contentEpoch = (identity: string, spaceId: string) => `${inlineDraftEpoch(identity, spaceId)}:${cacheGeneration}:${scopeGenerations.get(cacheKey(identity, spaceId)) || 0}`
export function clearHomeContentDrafts() { cacheGeneration++; drafts.clear() }
export function retainAccessibleHomeContentDrafts(identity: string, spaces: string[]) {
  for (const [key, value] of drafts) if (value.identity !== identity || !spaces.includes(value.spaceId)) {
    drafts.delete(key); scopeGenerations.set(key, (scopeGenerations.get(key) || 0) + 1)
  }
}
function remember(session: Session | null) {
  if (!session) return
  const key = cacheKey(session.identity, session.spaceId)
  if (session.epoch !== contentEpoch(session.identity, session.spaceId)) { drafts.delete(key); return }
  if (buildContentEdit(session.history.present).count || session.needsRead || session.conflicts.length || session.orderConflicts.length) drafts.set(key, session)
  else drafts.delete(key)
}
export function homeContentDraftResume(identity: string) {
  for (const [key, session] of drafts) {
    if (session.epoch !== contentEpoch(session.identity, session.spaceId)) { drafts.delete(key); continue }
    if (session.identity === identity) return { spaceId: session.spaceId }
  }
  return null
}
export type HomeContentController = ReturnType<typeof useHomeContentEditor>
export function useHomeContentEditor({ identity, spaceId, pageId, enabled, onRefresh, onSessionChanged, onCommitted }: {
  identity: string; spaceId: string; pageId: string; enabled: boolean; onRefresh: () => Promise<void>; onSessionChanged?: () => Promise<void>; onCommitted?: (data: Dataset<NavigationData>) => void
}) {
  const context = `${identity}:${spaceId}:${pageId}`
  const current = useRef({ context, identity, spaceId, enabled, onRefresh, onSessionChanged, onCommitted }); current.current = { context, identity, spaceId, enabled, onRefresh, onSessionChanged, onCommitted }
  const [session, setSession] = useState<Session | null>(null), state = useRef(session)
  const [selection, setSelection] = useState<ContentSelection>(null)
  const [busy, setBusy] = useState(false), busyRef = useRef(false)
  const [error, setError] = useState(''), [errors, setErrors] = useState<InlineError[]>([]), [status, setStatus] = useState('')
  const [refreshNeeded, setRefreshNeeded] = useState(false)
  const [pending, setPending] = useState<{ run: () => void } | null>(null), pendingRef = useRef(pending); pendingRef.current = pending
  const mounted = useRef(true), readAbort = useRef<AbortController | null>(null), returnFocus = useRef<HTMLElement | null>(null)
  const active = enabled && session?.context === context ? session : null
  const draft = active?.history.present || null
  const navigation = useMemo(() => draft ? contentNavigation(draft) : null, [draft])
  const changeCount = useMemo(() => draft ? buildContentEdit(draft).count : 0, [draft])
  const dirty = changeCount > 0 || !!active?.needsRead || !!active?.conflicts.length || !!active?.orderConflicts.length
  const blocked = busy || !!active?.needsRead || !!active?.conflicts.length || !!active?.orderConflicts.length
  function install(next: Session | null) { state.current = next; remember(next); if (mounted.current) setSession(next) }
  function valid(expected: Session) { return mounted.current && current.current.enabled && current.current.context === expected.context && expected.epoch === contentEpoch(expected.identity, expected.spaceId) }
  function reset() {
    const value = state.current
    if (value) drafts.delete(cacheKey(value.identity, value.spaceId))
    state.current = null; setSession(null); setSelection(null); setError(''); setErrors([]); setStatus(''); setRefreshNeeded(false)
  }
  useEffect(() => {
    mounted.current = true
    return () => { remember(state.current); mounted.current = false; readAbort.current?.abort() }
  }, [])
  useEffect(() => {
    readAbort.current?.abort(); busyRef.current = false; setBusy(false); setSelection(null); setError(''); setErrors([]); setPending(null); setRefreshNeeded(false)
    const saved = drafts.get(cacheKey(identity, spaceId))
    if (enabled && saved && saved.epoch === contentEpoch(identity, spaceId)) {
      install({ ...saved, context, needsRead: true })
      setStatus(t('草稿已保留，请读取最新内容后继续。', 'Your draft is preserved. Read the latest data to continue.'))
    } else install(null)
  }, [context, enabled])
  useEffect(() => {
    if (!active) return
    const before = (event: Event) => {
      if (event.defaultPrevented) return
      if (busyRef.current) { event.preventDefault(); return }
      const value = state.current
      if (!value || !(buildContentEdit(value.history.present).count || value.needsRead || value.conflicts.length || value.orderConflicts.length)) return
      event.preventDefault(); setPending({ run: (event as CustomEvent<{ proceed: () => void }>).detail.proceed })
    }
    const unload = (event: BeforeUnloadEvent) => {
      const value = state.current
      if (busyRef.current || value && (buildContentEdit(value.history.present).count || value.needsRead || value.conflicts.length || value.orderConflicts.length)) { event.preventDefault(); event.returnValue = '' }
    }
    const keyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.isComposing) { event.preventDefault(); void save() }
    }
    window.addEventListener(beforeNavigationEvent, before); window.addEventListener('beforeunload', unload); window.addEventListener('keydown', keyboard)
    return () => { window.removeEventListener(beforeNavigationEvent, before); window.removeEventListener('beforeunload', unload); window.removeEventListener('keydown', keyboard) }
  }, [!!active])
  async function start() {
    if (!current.current.enabled || busyRef.current || state.current?.context === context) return
    const captured = current.current, epoch = contentEpoch(identity, spaceId)
    busyRef.current = true; setBusy(true); setError(''); setStatus('')
    const controller = new AbortController(); readAbort.current = controller
    try {
      const base = await request<Dataset<NavigationData>>(`/spaces/${encodeURIComponent(spaceId)}/navigation`, { signal: controller.signal })
      if (controller.signal.aborted || current.current.context !== captured.context || !current.current.enabled || epoch !== contentEpoch(identity, spaceId)) return
      if (base.datasetId !== 'local-navigation' || !Array.isArray(base.data?.categories) || !Array.isArray(base.data?.links)) throw new Error(t('导航数据不可用。', 'Navigation data is unavailable.'))
      install({ context, identity, spaceId, epoch, history: createDraftHistory(freshContentDraft(base, getLocale())), needsRead: false, conflicts: [], orderConflicts: [] })
    } catch (cause) {
      if (!controller.signal.aborted && current.current.context === captured.context) { setError(messageOf(cause)); if (cause instanceof ApiError && [401, 403].includes(cause.status)) void current.current.onSessionChanged?.() }
    } finally { if (readAbort.current === controller) { busyRef.current = false; if (mounted.current) setBusy(false) } }
  }
  function edit(update: (draft: ContentDraft) => ContentDraft, group?: object) {
    const value = state.current
    if (!value || !valid(value) || busyRef.current || value.needsRead || value.conflicts.length || value.orderConflicts.length) return
    const next = update(value.history.present)
    const built = buildContentEdit(next)
    if (built.errors.some(item => item.code === 'limit')) { setError(t('这批修改已达到 500 项，请先保存。', 'This batch reached 500 operations. Save it first.')); return }
    install({ ...value, history: recordDraft(value.history, next, group) }); setError(''); setErrors([]); setStatus('')
  }
  function change(kind: InlineKind, id: string, patch: Partial<CategoryDraft & LinkDraft>) { edit(value => changeContentField(value, kind, id, patch), inputHistoryGroup()) }
  function moveLink(id: string, categoryId: string | null, beforeId: string | null) { edit(value => moveContent(value, 'links', id, categoryId, beforeId)) }
  function moveCategory(id: string, beforeId: string | null) {
    edit(value => { const row = contentNavigation(value).categories.find(item => item.id === id); return row ? moveContent(value, 'categories', id, row.parentId, beforeId) : value })
  }
  function history(redo = false) {
    const value = state.current
    if (!value || !valid(value) || busyRef.current || value.needsRead || value.conflicts.length || value.orderConflicts.length) return
    install({ ...value, history: redo ? redoDraft(value.history) : undoDraft(value.history) }); setError(''); setErrors([])
  }
  const canUndo = !!active?.history.past.length, canRedo = !!active?.history.future.length
  useHistoryShortcuts({ enabled: !!active && !blocked, undo: () => history(), redo: () => history(true), canUndo, canRedo, allowNonModalDialogs: true })
  function select(kind: InlineKind, id: string) {
    if (!state.current || busyRef.current) return
    if (!selection) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSelection({ kind, id })
  }
  function closeDetails() {
    setSelection(null)
    requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }) })
  }
  function requestLeave(run: () => void) {
    if (busyRef.current) return
    const value = state.current
    if (value && (buildContentEdit(value.history.present).count || value.needsRead || value.conflicts.length || value.orderConflicts.length)) setPending({ run })
    else { reset(); run() }
  }
  function discard() { if (busyRef.current) return; const action = pendingRef.current; setPending(null); pendingRef.current = null; reset(); action?.run() }
  async function save(leave = false) {
    const value = state.current
    if (!value || !valid(value) || busyRef.current || value.needsRead || value.conflicts.length || value.orderConflicts.length) return
    const built = buildContentEdit(value.history.present)
    if (built.errors.length) {
      setErrors(built.errors); setError(t('请修正标出的字段。', 'Correct the highlighted fields.')); setPending(null)
      const first = built.errors.find(item => item.id)
      if (first) setSelection({ kind: first.kind, id: first.id })
      return
    }
    if (!built.count) { const action = leave ? pendingRef.current : null; setPending(null); reset(); action?.run(); return }
    busyRef.current = true; setBusy(true); setError(''); setErrors([])
    install({ ...value, needsRead: true })
    try {
      const result = await request<BatchEditResult>(`/spaces/${encodeURIComponent(spaceId)}/navigation/batch-edit`, { method: 'POST', body: built.body })
      if (!valid(value)) return
      if (!result || typeof result.revision !== 'string' || typeof result.updatedCount !== 'number' || !Array.isArray(result.categories) || !Array.isArray(result.links)) throw new Error('Unconfirmed save result')
      const base = committedInlineDataset(value.history.present.fields, result)
      install({ ...value, history: createDraftHistory(freshContentDraft(base, value.history.present.locale)), needsRead: false, conflicts: [], orderConflicts: [] })
      current.current.onCommitted?.(base)
      // A committed POST must never be repeated because the following GET failed.
      try {
        await current.current.onRefresh()
        if (!valid(value)) return
        const action = leave ? pendingRef.current : null; setPending(null); pendingRef.current = null; reset(); action?.run()
      } catch {
        if (valid(value)) { setPending(null); setRefreshNeeded(true); setStatus(t('修改已保存，首页刷新失败。可再次读取内容。', 'Changes were saved, but the homepage could not refresh. Read the data again.')) }
      }
    } catch (cause) {
      if (!valid(value)) return
      const rejection = cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && ![408, 409, 401, 403, 404].includes(cause.status)
      install({ ...value, needsRead: !rejection }); setPending(null)
      setError(rejection ? messageOf(cause) : cause instanceof ApiError && cause.status === 409
        ? t('内容已被其他操作更新。请读取最新内容并比较，草稿已保留。', 'Content changed elsewhere. Read the latest data and compare; your draft is preserved.')
        : t('保存结果尚未确认。请读取最新内容核对，草稿已保留。', 'The save result is not confirmed. Read the latest data to check; your draft is preserved.'))
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) void current.current.onSessionChanged?.()
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  async function readLatest() {
    const value = state.current
    if (!value || !valid(value) || busyRef.current) return
    busyRef.current = true; setBusy(true); setError('')
    const controller = new AbortController(); readAbort.current = controller
    try {
      const latest = await request<Dataset<NavigationData>>(`/spaces/${encodeURIComponent(spaceId)}/navigation`, { signal: controller.signal })
      if (!valid(value) || controller.signal.aborted) return
      const merged = rebaseContentDraft(value.history.present, latest)
      install({ ...value, history: createDraftHistory(merged.draft), conflicts: merged.conflicts, orderConflicts: merged.orderConflicts, needsRead: false })
      setErrors([]); setStatus(merged.conflicts.length || merged.orderConflicts.length ? t('请选择需要保留的修改。', 'Choose which changes to keep.') : t('已核对最新内容。', 'Checked against the latest data.'))
      if (!merged.conflicts.length && !merged.orderConflicts.length && !buildContentEdit(merged.draft).count) {
        current.current.onCommitted?.(latest)
        setRefreshNeeded(true)
        await current.current.onRefresh()
        if (valid(value)) reset()
      }
    } catch (cause) {
      if (valid(value) && !controller.signal.aborted) { setError(messageOf(cause)); if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) void current.current.onSessionChanged?.() }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  function resolve(conflict: InlineConflict, choice: 'mine' | 'server') {
    const value = state.current
    if (!value || !valid(value) || busyRef.current) return
    install({ ...value, history: createDraftHistory(resolveContentField(value.history.present, conflict, choice)), conflicts: value.conflicts.filter(item => item !== conflict) }); setErrors([])
    if (conflict.field === '$deleted' && selection?.id === conflict.id) setSelection(null)
  }
  function resolveOrder(conflict: OrderConflict, choice: 'mine' | 'server') {
    const value = state.current
    if (!value || !valid(value) || busyRef.current) return
    install({ ...value, history: createDraftHistory(choice === 'server' ? discardContentOrder(value.history.present, conflict.kind) : value.history.present), orderConflicts: value.orderConflicts.filter(item => item !== conflict) })
  }
  const editor: NavigationEditor | undefined = active && navigation ? {
    spaceId, navigation, selectedLinkId: selection?.kind === 'links' ? selection.id : undefined, selectedCategoryId: selection?.kind === 'categories' ? selection.id : undefined,
    busy: blocked, onEditLink: id => select('links', id), onEditCategory: id => select('categories', id), onRenameCategory: (id, name) => change('categories', id, { name }), onMoveLink: moveLink, onMoveCategory: moveCategory,
  } : undefined
  return { active: !!active, draft, navigation, editor, selection, changeCount, dirty, busy, blocked, canUndo, canRedo, error, errors, status,
    needsRead: !!active?.needsRead, refreshNeeded, conflicts: active?.conflicts || [], orderConflicts: active?.orderConflicts || [], leaveOpen: !!pending,
    start, change, moveLink, moveCategory, undo: () => history(), redo: () => history(true), save, readLatest, resolve, resolveOrder, closeDetails,
    exit: () => requestLeave(() => {}), requestLeave, discard, keep: () => setPending(null) }
}
