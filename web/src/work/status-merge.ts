import type { WorkStatusCatalog, WorkStatusDefinition } from '../core/work-types'

export const editableStatusFields = ['name', 'type', 'color', 'description'] as const
export function statusValues(row: WorkStatusDefinition) {
  return { name: row.name.trim(), type: row.type, color: row.color.toLowerCase(), description: row.description.trim() }
}

type MergeResult = { rows: WorkStatusDefinition[]; defaultStatus: string; deletions: Record<string, string> } | { error: 'removed' | 'id-conflict' | 'target-removed' | 'too-many'; name: string }

/** Reapply only the user's edits to the latest catalog; never revive a retired ID. */
export function mergeStatusDraft(baseline: WorkStatusCatalog, rows: WorkStatusDefinition[], deletions: Record<string, string>, defaultStatus: string, latest: WorkStatusCatalog): MergeResult {
  const oldById = new Map(baseline.items.map(row => [row.id, row]))
  const latestById = new Map(latest.items.map(row => [row.id, row]))
  const draftById = new Map(rows.map(row => [row.id, row]))
  const active = rows.filter(row => !(row.id in deletions))
  const draftExisting = active.filter(row => oldById.has(row.id)).map(row => row.id)
  const oldExisting = baseline.items.filter(row => draftExisting.includes(row.id)).map(row => row.id)
  const reordered = draftExisting.some((id, index) => id !== oldExisting[index])
  const defaultChanged = defaultStatus !== baseline.defaultStatus
  const edits = new Map<string, Partial<ReturnType<typeof statusValues>>>()

  for (const row of rows) {
    const old = oldById.get(row.id)
    if (!old) {
      if (latestById.has(row.id)) return { error: 'id-conflict', name: row.name }
      continue
    }
    const before = statusValues(old), after = statusValues(row)
    const changes = Object.fromEntries(editableStatusFields.filter(key => before[key] !== after[key]).map(key => [key, after[key]]))
    if (!latestById.has(row.id)) {
      if (Object.keys(changes).length || row.id in deletions || (defaultChanged && defaultStatus === row.id) || reordered) return { error: 'removed', name: row.name || old.name }
      continue
    }
    edits.set(row.id, changes)
  }
  for (const target of Object.values(deletions)) {
    if (target && ((!latestById.has(target) && oldById.has(target)) || !draftById.has(target) || target in deletions)) return { error: 'target-removed', name: draftById.get(target)?.name || oldById.get(target)?.name || target }
  }

  const mergedById = new Map(latest.items.map(row => [row.id, { ...row, ...edits.get(row.id) }]))
  const merged = latest.items.filter(row => !(row.id in deletions)).map(row => mergedById.get(row.id)!)
  if (reordered) {
    // Keep concurrently added columns in their slots while reordering known columns.
    const ordered = draftExisting.filter(id => mergedById.has(id))
    let index = 0
    for (let slot = 0; slot < merged.length; slot++) if (ordered.includes(merged[slot].id)) merged[slot] = mergedById.get(ordered[index++])!
  }
  for (let index = 0; index < active.length; index++) {
    const row = active[index]
    if (oldById.has(row.id)) continue
    const previous = active.slice(0, index).reverse().find(value => merged.some(item => item.id === value.id))
    const following = active.slice(index + 1).find(value => merged.some(item => item.id === value.id))
    const at = previous ? merged.findIndex(item => item.id === previous.id) + 1 : following ? merged.findIndex(item => item.id === following.id) : merged.length
    merged.splice(at, 0, { ...row })
  }
  if (merged.length > 64) return { error: 'too-many', name: '' }
  const nextDefault = defaultChanged ? defaultStatus : latest.defaultStatus
  const survivingDefault = merged.some(row => row.id === nextDefault) ? nextDefault : ''
  const removed = Object.keys(deletions).map(id => mergedById.get(id)!).filter(Boolean)
  return { rows: [...merged, ...removed].map((row, position) => ({ ...row, position, isDefault: row.id === survivingDefault })), defaultStatus: survivingDefault, deletions: { ...deletions } }
}
