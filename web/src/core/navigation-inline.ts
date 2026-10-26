import type { Category, Dataset, Endpoint, LinkInput, NavigationData, NavLink } from './types'

export type InlineKind = 'categories' | 'links'
export type CategoryDraft = { name: string; parentId: string | null; icon: string; sortOrder: string }
export type LinkDraft = Omit<LinkInput, 'tags' | 'sortOrder'> & { tags: string; sortOrder: string }
export type DraftChanges = { categories: Record<string, CategoryDraft>; links: Record<string, LinkDraft> }
export type InlineDraft = DraftChanges & { base: Dataset<NavigationData> }
export type InlineError = { kind: InlineKind; id: string; field: string; code: string; message?: string }
export type InlineConflict = { kind: InlineKind; id: string; field: string; base: unknown; mine: unknown; server: unknown }
export type BatchEditBody = { expectedRevision: string; categories: { id: string; patch: Partial<Omit<Category, 'id' | 'spaceId'>> }[]; links: { id: string; patch: Partial<LinkInput> }[] }
export type BatchEditResult = { updatedCount: number; revision: string; categories: Category[]; links: NavLink[] }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export const categoryDraft = (row: Category): CategoryDraft => ({ name: row.name, parentId: row.parentId || null, icon: row.icon, sortOrder: String(row.sortOrder) })
export const linkDraft = (row: NavLink): LinkDraft => ({ title: row.title, url: row.url, categoryId: row.categoryId || null, description: row.description, icon: row.icon, iconMode: row.iconMode || 'manual', tags: (row.tags || []).join(', '), sortOrder: String(row.sortOrder), isFavorite: row.isFavorite, endpoints: structuredClone(row.endpoints || []) })
export const freshInlineDraft = (base: Dataset<NavigationData>): InlineDraft => ({ base, categories: {}, links: {} })
export const draftCount = (draft: DraftChanges) => Object.keys(draft.categories).length + Object.keys(draft.links).length
export function readDraft(draft: InlineDraft, kind: 'categories', id: string): CategoryDraft
export function readDraft(draft: InlineDraft, kind: 'links', id: string): LinkDraft
export function readDraft(draft: InlineDraft, kind: InlineKind, id: string): CategoryDraft | LinkDraft {
  if (kind === 'categories') return draft.categories[id] || categoryDraft(draft.base.data.categories.find(row => row.id === id)!)
  return draft.links[id] || linkDraft(draft.base.data.links.find(row => row.id === id)!)
}
export function putDraft(draft: InlineDraft, kind: InlineKind, id: string, value: CategoryDraft | LinkDraft): InlineDraft {
  const original = kind === 'categories' ? draft.base.data.categories.find(row => row.id === id) : draft.base.data.links.find(row => row.id === id)
  if (!original) return draft
  const initial = kind === 'categories' ? categoryDraft(original as Category) : linkDraft(original as NavLink)
  const changes = { ...draft[kind] } as Record<string, CategoryDraft | LinkDraft>
  if (equal(value, initial)) delete changes[id]; else changes[id] = value
  return { ...draft, [kind]: changes }
}
const tags = (value: string) => [...new Set(value.split(/[,，]/).map(item => item.trim()).filter(Boolean))]
function order(value: string) { return /^-?\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) && Math.abs(Number(value)) <= 1000000 }
function validURL(value: string) { try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname } catch { return false } }
function normalized(kind: InlineKind, value: CategoryDraft | LinkDraft): Record<string, unknown> {
  if (kind === 'categories') { const row = value as CategoryDraft; return { ...row, name: row.name.trim(), sortOrder: Number(row.sortOrder) } }
  const row = value as LinkDraft
  return { ...row, title: row.title.trim(), url: row.url.trim(), description: row.description.trim(), tags: tags(row.tags), sortOrder: Number(row.sortOrder), iconMode: row.iconMode || 'manual' }
}
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(after).filter(key => !equal(before[key], after[key])).map(key => [key, after[key]]))
}
export function buildBatchEdit(draft: InlineDraft): { body: BatchEditBody; errors: InlineError[] } {
  const errors: InlineError[] = [], body: BatchEditBody = { expectedRevision: draft.base.revision, categories: [], links: [] }
  const add = (kind: InlineKind, id: string, field: string, code: string) => { errors.push({ kind, id, field, code }) }
  for (const [id, value] of Object.entries(draft.categories)) {
    const row = draft.base.data.categories.find(item => item.id === id)
    if (!row) { add('categories', id, 'name', 'deleted'); continue }
    if (!value.name.trim() || [...value.name.trim()].length > 80) add('categories', id, 'name', 'name')
    if (!order(value.sortOrder)) add('categories', id, 'sortOrder', 'order')
    if (value.parentId && !draft.base.data.categories.some(item => item.id === value.parentId)) add('categories', id, 'parentId', 'parent')
    const patch = changedFields(normalized('categories', categoryDraft(row)), normalized('categories', value))
    if (Object.keys(patch).length) body.categories.push({ id, patch })
  }
  for (const [id, value] of Object.entries(draft.links)) {
    const row = draft.base.data.links.find(item => item.id === id)
    if (!row) { add('links', id, 'title', 'deleted'); continue }
    if (!value.title.trim() || [...value.title.trim()].length > 160) add('links', id, 'title', 'title')
    if (!validURL(value.url.trim()) || value.url.trim().length > 2048) add('links', id, 'url', 'url')
    if (!order(value.sortOrder)) add('links', id, 'sortOrder', 'order')
    const values = tags(value.tags)
    if (values.length > 32 || values.some(item => [...item].length > 40)) add('links', id, 'tags', 'tags')
    if ([...value.description].length > 2000) add('links', id, 'description', 'description')
    if (value.categoryId && !draft.base.data.categories.some(item => item.id === value.categoryId)) add('links', id, 'categoryId', 'category')
    if (value.endpoints.length > 12 || value.endpoints.some(item => !validURL(item.url) || !item.label.trim())) add('links', id, 'endpoints', 'endpoints')
    const patch = changedFields(normalized('links', linkDraft(row)), normalized('links', value))
    if (Object.keys(patch).length) body.links.push({ id, patch })
  }
  const parents = new Map(draft.base.data.categories.map(row => [row.id, draft.categories[row.id]?.parentId ?? row.parentId]))
  // An explicit null means top-level, so null must not fall back to the old parent.
  for (const [id, value] of Object.entries(draft.categories)) parents.set(id, value.parentId)
  for (const id of parents.keys()) {
    let current: string | null | undefined = id
    const seen = new Set<string>()
    while (current) {
      if (seen.has(current) || seen.size >= 32) {
        const changed = [...seen].find(item => draft.categories[item]) || id
        add('categories', changed, 'parentId', seen.has(current) ? 'cycle' : 'depth'); break
      }
      seen.add(current); current = parents.get(current)
    }
  }
  if (body.categories.length + body.links.length > 500) add('links', '', '', 'limit')
  return { body, errors: errors.filter((error, index, all) => all.findIndex(item => item.kind === error.kind && item.id === error.id && item.field === error.field && item.code === error.code) === index) }
}
export function draftNavigation(draft: InlineDraft): NavigationData {
  return {
    categories: draft.base.data.categories.map(row => draft.categories[row.id] ? { ...row, ...draft.categories[row.id], sortOrder: Number(draft.categories[row.id].sortOrder) || 0 } : row),
    links: draft.base.data.links.map(row => { const value = draft.links[row.id]; return value ? { ...row, ...value, tags: tags(value.tags), sortOrder: Number(value.sortOrder) || 0 } : row }),
  }
}
function comparable(field: string, value: unknown) {
  if (field === 'tags' && typeof value === 'string') return tags(value)
  if (field === 'sortOrder' && typeof value === 'string' && order(value)) return Number(value)
  if (['name', 'title', 'url', 'description'].includes(field) && typeof value === 'string') return value.trim()
  return value
}
/** Rebase only fields the user touched; a read never silently wins a true conflict. */
export function rebaseInlineDraft(draft: InlineDraft, latest: Dataset<NavigationData>): { draft: InlineDraft; conflicts: InlineConflict[] } {
  let next = freshInlineDraft(latest)
  const conflicts: InlineConflict[] = []
  for (const kind of ['categories', 'links'] as const) {
    for (const [id, mine] of Object.entries(draft[kind])) {
      const oldRow = draft.base.data[kind].find(row => row.id === id), serverRow = latest.data[kind].find(row => row.id === id)
      if (!oldRow) continue
      const toDraft = (row: Category | NavLink) => kind === 'categories' ? categoryDraft(row as Category) : linkDraft(row as NavLink)
      const base = toDraft(oldRow)
      if (!serverRow) {
        conflicts.push({ kind, id, field: '$deleted', base, mine, server: null })
        next = { ...next, [kind]: { ...next[kind], [id]: mine } }; continue
      }
      const server = toDraft(serverRow), merged = { ...server } as Record<string, unknown>
      for (const field of Object.keys(mine)) {
        const before = (base as unknown as Record<string, unknown>)[field], value = (mine as unknown as Record<string, unknown>)[field], remote = (server as unknown as Record<string, unknown>)[field]
        if (equal(comparable(field, value), comparable(field, before)) || equal(comparable(field, value), comparable(field, remote))) continue
        merged[field] = value
        if (!equal(comparable(field, remote), comparable(field, before))) conflicts.push({ kind, id, field, base: before, mine: value, server: remote })
      }
      next = putDraft(next, kind, id, merged as unknown as CategoryDraft | LinkDraft)
    }
  }
  return { draft: next, conflicts }
}
export function resolveInlineConflict(draft: InlineDraft, conflict: InlineConflict, choice: 'mine' | 'server'): InlineDraft {
  if (conflict.field === '$deleted') {
    const rows = { ...draft[conflict.kind] }; delete rows[conflict.id]
    return { ...draft, [conflict.kind]: rows }
  }
  const current = (draft[conflict.kind] as Record<string, CategoryDraft | LinkDraft>)[conflict.id]
  if (!current) return draft
  return putDraft(draft, conflict.kind, conflict.id, { ...current, [conflict.field]: choice === 'mine' ? conflict.mine : conflict.server })
}
export function committedInlineDataset(draft: InlineDraft, result: BatchEditResult): Dataset<NavigationData> {
  const categories = new Map(result.categories.map(row => [row.id, row])), links = new Map(result.links.map(row => [row.id, row]))
  return { ...draft.base, revision: result.revision, data: { categories: draft.base.data.categories.map(row => categories.get(row.id) || row), links: draft.base.data.links.map(row => links.get(row.id) || row) } }
}
export function endpointsForDraft(endpoints: Endpoint[]) { return structuredClone(endpoints) }

// Deliberately memory-only: passwords, session tokens and private edits are never
// persisted to browser storage. Expiry may hide the editor without losing input.
type CachedDraft = { identity: string; spaceId: string; kind: InlineKind; draft: InlineDraft; conflicts: InlineConflict[]; needsRead: boolean }
const memoryDrafts = new Map<string, CachedDraft>()
let cacheGeneration = 0
const scopeGenerations = new Map<string, number>()
const cacheKey = (identity: string, spaceId: string) => identity + '/' + spaceId
export function inlineDraftEpoch(identity: string, spaceId: string) { return cacheGeneration + ':' + (scopeGenerations.get(cacheKey(identity, spaceId)) || 0) }
export function cacheInlineDraft(entry: CachedDraft, epoch?: string) {
  if (epoch !== undefined && epoch !== inlineDraftEpoch(entry.identity, entry.spaceId)) return
  const key = cacheKey(entry.identity, entry.spaceId)
  if (draftCount(entry.draft) || entry.conflicts.length || entry.needsRead) memoryDrafts.set(key, entry)
  else memoryDrafts.delete(key)
}
export function cachedInlineDraft(identity: string, spaceId: string) { return memoryDrafts.get(cacheKey(identity, spaceId)) }
export function clearInlineDrafts(identity?: string, spaceId?: string) {
  if (!identity && !spaceId) cacheGeneration++
  for (const [key, entry] of memoryDrafts) if ((!identity || entry.identity === identity) && (!spaceId || entry.spaceId === spaceId)) { memoryDrafts.delete(key); scopeGenerations.set(key, (scopeGenerations.get(key) || 0) + 1) }
}
export function retainAccessibleInlineDrafts(identity: string, readableSpaces: string[]) {
  for (const [key, entry] of memoryDrafts) if (entry.identity !== identity || !readableSpaces.includes(entry.spaceId)) { memoryDrafts.delete(key); scopeGenerations.set(key, (scopeGenerations.get(key) || 0) + 1) }
}
export function inlineDraftResume(identity: string) {
  const value = [...memoryDrafts.values()].find(entry => entry.identity === identity)
  return value ? { spaceId: value.spaceId, kind: value.kind } : null
}
