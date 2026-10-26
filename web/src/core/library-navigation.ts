export type LibraryTarget = { spaceId: string; documentId: string }

/** A route may select a document only after its space is confirmed accessible. */
export function readLibraryTarget(route: string): LibraryTarget | null {
  const normalized = route.replace(/^#/, '')
  const queryAt = normalized.indexOf('?')
  if ((queryAt < 0 ? normalized : normalized.slice(0, queryAt)) !== '/library') return null
  const query = new URLSearchParams(queryAt < 0 ? '' : normalized.slice(queryAt + 1))
  return { spaceId: query.get('space') || '', documentId: query.get('document') || '' }
}

export function accessibleLibrarySpace(target: LibraryTarget | null, spaces: readonly { id: string }[]): string {
  return target?.spaceId && spaces.some(space => space.id === target.spaceId) ? target.spaceId : ''
}
