import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { ApiError, request } from '../core/api'
import { sessionVerifiedEvent } from '../core/session-requests'
import { documentActivityQueryKey, isDocumentActivityData, type DocumentActivityData, type DocumentActivityQuery } from '../core/document-activity'
import { t } from '../core/i18n'

type Snapshot = { loading: boolean; data?: DocumentActivityData; error?: Error }
type Entry = { state: Snapshot; listeners: Set<() => void>; promise?: Promise<void>; abort?: AbortController; receivedAt?: number }
const emptySnapshot: Snapshot = { loading: false }

/** Owned by one authorized page identity, never shared between accounts or spaces. */
class ActivityStore {
  private entries = new Map<string, Entry>()
  private selected = new Map<string, string | null>()
  private selectionListeners = new Map<string, Set<() => void>>()
  private denied: Error | undefined
  constructor(readonly spaceId: string, readonly enabled: boolean) {}

  private entry(key: string): Entry {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { state: this.denied ? { loading: false, error: this.denied } : emptySnapshot, listeners: new Set() }
      this.entries.set(key, entry)
      if (this.entries.size > 128) {
        for (const [oldKey, old] of this.entries) {
          if (oldKey !== key && !old.listeners.size && !old.promise) { this.entries.delete(oldKey); break }
        }
      }
    }
    return entry
  }
  snapshot = (key: string): Snapshot => this.entry(key).state
  subscribe = (key: string, listener: () => void): (() => void) => {
    const entry = this.entry(key)
    entry.listeners.add(listener)
    return () => { entry.listeners.delete(listener) }
  }
  private notify(entry: Entry, state: Snapshot) {
    entry.state = state
    for (const listener of entry.listeners) listener()
  }
  load(key: string, force = false): Promise<void> {
    const entry = this.entry(key)
    if (!this.enabled) return Promise.resolve()
    if (entry.promise) return entry.promise
    if (this.denied && !force) return Promise.resolve()
    if (!force && entry.state.data && Date.now() - (entry.receivedAt || 0) < 60_000) return Promise.resolve()
    if (force) this.denied = undefined
    const abort = new AbortController()
    entry.abort = abort
    this.notify(entry, { loading: true, data: entry.state.data })
    entry.promise = request<unknown>(`/spaces/${encodeURIComponent(this.spaceId)}/document-activity?${key}`, { signal: abort.signal }).then(data => {
      if (abort.signal.aborted) return
      if (!isDocumentActivityData(data)) throw new Error(t('活动数据格式不匹配', 'The activity response is incompatible'))
      entry.receivedAt = Date.now()
      this.notify(entry, { loading: false, data })
    }).catch(error => {
      if (abort.signal.aborted) return
      const cause = error instanceof Error ? error : new Error(t('无法读取文档活动', 'Could not load document activity'))
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        this.denied = cause
        // A revoked working-document grant invalidates counts as well as row titles.
        for (const current of this.entries.values()) {
          if (current !== entry) current.abort?.abort()
          this.notify(current, { loading: false, error: cause })
        }
      } else this.notify(entry, { loading: false, error: cause })
    }).finally(() => { if (entry.abort === abort) { entry.promise = undefined; entry.abort = undefined } })
    return entry.promise
  }
  refreshActive = () => {
    if (this.denied) return
    for (const [key, entry] of this.entries) if (entry.listeners.size) void this.load(key, true)
  }
  refreshAll = () => {
    this.denied = undefined
    for (const entry of this.entries.values()) entry.receivedAt = 0
    this.refreshActive()
  }
  selectedDate = (group: string): string | null => this.selected.get(group) || null
  subscribeSelection = (group: string, listener: () => void): (() => void) => {
    let listeners = this.selectionListeners.get(group)
    if (!listeners) { listeners = new Set(); this.selectionListeners.set(group, listeners) }
    listeners.add(listener)
    return () => { listeners!.delete(listener) }
  }
  selectDate = (group: string, date: string | null) => {
    if (this.selectedDate(group) === date) return
    this.selected.set(group, date)
    for (const listener of this.selectionListeners.get(group) || []) listener()
  }
  dispose() {
    // Also safe for React's development setup/cleanup/setup cycle. The old
    // identity's store becomes unreachable rather than entering a global cache.
    for (const entry of this.entries.values()) {
      entry.abort?.abort(); entry.abort = undefined; entry.promise = undefined
      entry.state = entry.state.data ? { loading: false, data: entry.state.data } : emptySnapshot
    }
  }
}

type Scope = { store: ActivityStore; spaceId: string; userKey: string; enabled: boolean }
const ActivityContext = createContext<Scope | null>(null)

export function DocumentActivityProvider({ spaceId, userKey, enabled, children }: {
  spaceId: string; userKey: string; enabled: boolean; children: ReactNode
}) {
  const scope = useMemo<Scope>(() => ({ spaceId, userKey, enabled, store: new ActivityStore(spaceId, enabled) }), [spaceId, userKey, enabled])
  useEffect(() => {
    // App verifies the browser's current account before sharing a focus refresh.
    const onFocus = () => { if (document.visibilityState !== 'hidden') scope.store.refreshActive() }
    window.addEventListener(sessionVerifiedEvent, onFocus)
    return () => { window.removeEventListener(sessionVerifiedEvent, onFocus); scope.store.dispose() }
  }, [scope])
  return <ActivityContext.Provider value={scope}>{children}</ActivityContext.Provider>
}

export function useDocumentActivityScope() { return useContext(ActivityContext) }

export function useDocumentActivityQuery(query: DocumentActivityQuery | null): Snapshot & { refresh: () => void } {
  const scope = useDocumentActivityScope(), key = query ? documentActivityQueryKey(query) : ''
  const subscribe = useCallback((listener: () => void) => scope && key ? scope.store.subscribe(key, listener) : () => {}, [scope, key])
  const snapshot = useCallback(() => scope && key ? scope.store.snapshot(key) : emptySnapshot, [scope, key])
  const state = useSyncExternalStore(subscribe, snapshot, () => emptySnapshot)
  useEffect(() => { if (scope?.enabled && key) void scope.store.load(key) }, [scope, key])
  const refresh = useCallback(() => { if (scope && key) void scope.store.load(key, true) }, [scope, key])
  return { ...state, refresh }
}

export function useDocumentActivitySelection(viewId: string, interactionScope?: string) {
  const scope = useDocumentActivityScope()
  const group = interactionScope && !interactionScope.startsWith('independent:') ? `group:${interactionScope}` : `view:${viewId}`
  const subscribe = useCallback((listener: () => void) => scope ? scope.store.subscribeSelection(group, listener) : () => {}, [scope, group])
  const snapshot = useCallback(() => scope?.store.selectedDate(group) || null, [scope, group])
  const selected = useSyncExternalStore(subscribe, snapshot, () => null)
  const select = useCallback((date: string | null) => scope?.store.selectDate(group, date), [scope, group])
  return [selected, select] as const
}
