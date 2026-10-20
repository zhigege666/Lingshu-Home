import type { Bootstrap } from './types'

type SpaceBootstrap = Pick<Bootstrap, 'initialized' | 'user' | 'spaces' | 'defaultSpaceId'>
type SelectionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

// sessionStorage is already scoped to this origin and tab. Keep accounts and
// anonymous browsing separate, and store only an accessible space identifier.
export function spaceSelectionKey(value: Pick<Bootstrap, 'user'>): string {
  return `lingshu-home:space:v1:${value.user ? `user:${value.user.id}` : 'anonymous'}`
}

function accessible(value: SpaceBootstrap, id: string | null | undefined): id is string {
  return value.initialized && !!id && value.spaces.some(space => space.id === id)
}

export function selectAccessibleSpace(value: SpaceBootstrap, options: {
  currentId?: string | null
  rememberedId?: string | null
  preferShared?: boolean
} = {}): string {
  if (!value.initialized) return ''
  if (options.preferShared) {
    const shared = value.spaces.find(space => space.kind === 'shared')
    if (shared) return shared.id
  }
  return [options.currentId, options.rememberedId, value.defaultSpaceId, value.spaces[0]?.id]
    .find(id => accessible(value, id)) || ''
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
