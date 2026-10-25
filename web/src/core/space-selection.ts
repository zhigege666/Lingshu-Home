import type { Bootstrap } from './types'

export type SpaceBootstrap = Pick<Bootstrap, 'initialized' | 'user' | 'spaces' | 'defaultSpaceId'>
export type SelectionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type SpacePreferences = { lastSpaceId: string; defaultSpaceId: string }

// Browser storage is already scoped to this origin. The existing v1 key stays
// tab-local for an explicit selection; the separate preference record survives
// new tabs and sign-ins without sharing a choice between accounts.
export function spaceSelectionKey(value: Pick<Bootstrap, 'user'>): string {
  return `lingshu-home:space:v1:${value.user ? `user:${value.user.id}` : 'anonymous'}`
}

export function spacePreferenceKey(value: Pick<Bootstrap, 'user'>): string {
  return `lingshu-home:space-preferences:v1:${value.user ? `user:${value.user.id}` : 'anonymous'}`
}

export function browserSpaceStorage(kind: 'local' | 'session'): SelectionStorage | null {
  try { return typeof window === 'undefined' ? null : kind === 'local' ? window.localStorage : window.sessionStorage }
  catch { return null }
}

function accessible(value: SpaceBootstrap, id: string | null | undefined): id is string {
  return value.initialized && !!id && value.spaces.some(space => space.id === id)
}

export function selectAccessibleSpace(value: SpaceBootstrap, options: {
  currentId?: string | null
  fixedId?: string | null
  rememberedId?: string | null
  preferShared?: boolean
  excludedIds?: readonly string[]
} = {}): string {
  if (!value.initialized) return ''
  const allowed = (id: string | null | undefined): id is string => accessible(value, id) && !options.excludedIds?.includes(id)
  if (options.preferShared) {
    const shared = value.spaces.find(space => space.kind === 'shared' && allowed(space.id))
    if (shared) return shared.id
  }
  return [options.currentId, options.fixedId, options.rememberedId, value.defaultSpaceId, ...value.spaces.map(space => space.id)]
    .find(allowed) || ''
}

export function readRememberedSpace(value: SpaceBootstrap, storage: SelectionStorage | null): string {
  if (!value.initialized || !storage) return ''
  try {
    const key = spaceSelectionKey(value), id = storage.getItem(key)
    if (accessible(value, id)) return id
    if (id !== null) storage.removeItem(key)
  } catch {
    // Blocked browser storage must not prevent sign-in or navigation.
  }
  return ''
}

export function rememberSpace(value: SpaceBootstrap, id: string, storage: SelectionStorage | null): boolean {
  if (!accessible(value, id) || !storage) return false
  try {
    storage.setItem(spaceSelectionKey(value), id)
    return true
  } catch {
    return false
  }
}

export function clearRememberedSpace(value: Pick<Bootstrap, 'user'>, storage: SelectionStorage | null, id?: string): void {
  try {
    if (storage && (id === undefined || storage.getItem(spaceSelectionKey(value)) === id)) storage.removeItem(spaceSelectionKey(value))
  } catch { /* A denied storage operation never blocks account changes. */ }
}

export function readSpacePreferences(value: SpaceBootstrap, storage: SelectionStorage | null): SpacePreferences {
  const empty = { lastSpaceId: '', defaultSpaceId: '' }
  if (!value.initialized || !storage) return empty
  try {
    const key = spacePreferenceKey(value), raw = storage.getItem(key)
    if (raw === null) return empty
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { storage.removeItem(key); return empty }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { storage.removeItem(key); return empty }
    const record = parsed as Record<string, unknown>
    const preferences = {
      lastSpaceId: typeof record.lastSpaceId === 'string' && accessible(value, record.lastSpaceId) ? record.lastSpaceId : '',
      defaultSpaceId: typeof record.defaultSpaceId === 'string' && accessible(value, record.defaultSpaceId) ? record.defaultSpaceId : '',
    }
    // Revocation/deletion is checked against fresh bootstrap inventory on each
    // read. Invalid values are never allowed to become dashboard request URLs.
    if (preferences.lastSpaceId !== record.lastSpaceId || preferences.defaultSpaceId !== record.defaultSpaceId) {
      // Read-only storage may still contain a valid remaining preference.
      // Failure to clean the stale field must not discard that usable value.
      writeSpacePreferences(value, preferences, storage)
    }
    return preferences
  } catch { return empty }
}

function writeSpacePreferences(value: SpaceBootstrap, preferences: SpacePreferences, storage: SelectionStorage | null): boolean {
  if (!value.initialized || !storage) return false
  try {
    if (preferences.lastSpaceId || preferences.defaultSpaceId) storage.setItem(spacePreferenceKey(value), JSON.stringify(preferences))
    else storage.removeItem(spacePreferenceKey(value))
    return true
  } catch { return false }
}

// Call only after a dashboard response for this account and space succeeds.
// Legacy tab selections are migrated here, never before the first real read.
export function rememberSuccessfulSpace(value: SpaceBootstrap, id: string, storage: SelectionStorage | null): boolean {
  if (!accessible(value, id)) return false
  return writeSpacePreferences(value, { ...readSpacePreferences(value, storage), lastSpaceId: id }, storage)
}

export function setDefaultSpace(value: SpaceBootstrap, id: string, storage: SelectionStorage | null): boolean {
  if (id !== '' && !accessible(value, id)) return false
  return writeSpacePreferences(value, { ...readSpacePreferences(value, storage), defaultSpaceId: id }, storage)
}

export function forgetSpacePreference(value: SpaceBootstrap, id: string, storage: SelectionStorage | null): void {
  const current = readSpacePreferences(value, storage)
  if (current.lastSpaceId !== id && current.defaultSpaceId !== id) return
  writeSpacePreferences(value, {
    lastSpaceId: current.lastSpaceId === id ? '' : current.lastSpaceId,
    defaultSpaceId: current.defaultSpaceId === id ? '' : current.defaultSpaceId,
  }, storage)
}
