import { buildBatchEdit, draftNavigation, freshInlineDraft, putDraft, readDraft, rebaseInlineDraft, resolveInlineConflict, type CategoryDraft, type InlineConflict, type InlineDraft, type InlineKind, type LinkDraft } from './navigation-inline.ts'
import type { Category, Dataset, NavigationData, NavLink } from './types'

export type ContentOrders = { categories: Record<string, string[]>; links: Record<string, string[]> }
export type ContentDraft = {
  fields: InlineDraft
  orders: ContentOrders
  moved: { categories: string[]; links: string[] }
  locale: string
}
export type ContentSelection = { kind: InlineKind; id: string } | null
export type OrderConflict = { kind: InlineKind; ids: string[] }
const key = (id: string | null) => id || ''
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const parent = (row: Category | NavLink) => 'parentId' in row ? row.parentId : row.categoryId
function ordered<T extends Category | NavLink>(rows: T[], locale: string): T[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || ('name' in a ? a.name : a.title).localeCompare('name' in b ? b.name : b.title, locale) || a.id.localeCompare(b.id))
}
export function navigationOrders(data: NavigationData, locale = 'zh-CN'): ContentOrders {
  const orders: ContentOrders = { categories: {}, links: {} }
  for (const kind of ['categories', 'links'] as const) for (const row of ordered<Category | NavLink>(data[kind], locale)) {
    const group = key(parent(row)); (orders[kind][group] ||= []).push(row.id)
  }
  return orders
}
export function freshContentDraft(base: Dataset<NavigationData>, locale = 'zh-CN'): ContentDraft {
  return { fields: freshInlineDraft(base), orders: navigationOrders(base.data, locale), moved: { categories: [], links: [] }, locale }
}
/** Changes stay in one account/space draft; no layout or external-source data enters it. */
export function changeContentField(draft: ContentDraft, kind: InlineKind, id: string, patch: Partial<CategoryDraft & LinkDraft>): ContentDraft {
  if (!draft.fields.base.data[kind].some(row => row.id === id)) return draft
  const previous = kind === 'categories' ? readDraft(draft.fields, 'categories', id) : readDraft(draft.fields, 'links', id)
  let next = { ...draft, fields: putDraft(draft.fields, kind, id, { ...previous, ...patch }) }
  const before = parent(draftNavigation(draft.fields)[kind].find(row => row.id === id)!)
  const after = parent(draftNavigation(next.fields)[kind].find(row => row.id === id)!)
  if (before !== after) next = moveContent(next, kind, id, after, null)
  // A legacy group can share one sortOrder. A rename must not silently move
  // the record on save just because the tie-breaker changed.
  if (Object.hasOwn(patch, kind === 'categories' ? 'name' : 'title')) next = { ...next, moved: { ...next.moved, [kind]: [...new Set([...next.moved[kind], id])] } }
  return next
}
/** Move a single ID in the full sequence. Hidden and paginated siblings keep their relative order. */
export function moveContent(draft: ContentDraft, kind: InlineKind, id: string, target: string | null, beforeId: string | null): ContentDraft {
  const data = draftNavigation(draft.fields), row = data[kind].find(item => item.id === id)
  if (!row || id === beforeId) return draft
  if (target && !data.categories.some(item => item.id === target)) return draft
  if (kind === 'categories' && parent(row) !== target) return draft
  const anchor = beforeId ? data[kind].find(item => item.id === beforeId) : null
  if (beforeId && (!anchor || parent(anchor) !== target)) return draft
  const groups = Object.fromEntries(Object.entries(draft.orders[kind]).map(([group, ids]) => [group, ids.filter(value => value !== id)]))
  const list = groups[key(target)] ||= []
  const position = beforeId ? list.indexOf(beforeId) : list.length
  if (position < 0) return draft
  list.splice(position, 0, id)
  const fields = kind === 'links' ? putDraft(draft.fields, 'links', id, { ...readDraft(draft.fields, 'links', id), categoryId: target }) : draft.fields
  if (same(groups, draft.orders[kind]) && same(fields, draft.fields)) return draft
  return { ...draft, fields, orders: { ...draft.orders, [kind]: groups }, moved: { ...draft.moved, [kind]: [...new Set([...draft.moved[kind], id])] } }
}
export function contentNavigation(draft: ContentDraft): NavigationData {
  const data = draftNavigation(draft.fields)
  const original = navigationOrders(data, draft.locale)
  const ranked = <T extends Category | NavLink>(kind: InlineKind, rows: T[]): T[] => {
    // Match server normalization only for groups whose sequence changed.
    // Unmodified sortOrder values also determine a binding's global limit.
    const ranks = new Map(Object.entries(draft.orders[kind]).filter(([group, ids]) => !same(ids, original[kind][group] || [])).flatMap(([, ids]) => ids.map((id, rank) => [id, rank] as const)))
    return rows.map(row => ({ ...row, sortOrder: ranks.get(row.id) ?? row.sortOrder }))
  }
  return { categories: ranked('categories', data.categories), links: ranked('links', data.links) }
}

export type ContentMove = { kind: 'category' | 'link'; id: string; beforeId: string | null; categoryId?: string | null }
/** Fields are applied first on the server, then the final-position moves, right to left. */
export function buildContentEdit(draft: ContentDraft) {
  const built = buildBatchEdit(draft.fields)
  const simulated = navigationOrders(draftNavigation(draft.fields), draft.locale)
  const moves: ContentMove[] = []
  for (const kind of ['categories', 'links'] as const) {
    const touched = new Set(draft.moved[kind])
    for (const [group, wanted] of Object.entries(draft.orders[kind])) {
      const current = simulated[kind][group] ||= []
      for (let index = wanted.length - 1; index >= 0; index--) {
        const id = wanted[index]!, beforeId = wanted[index + 1] || null
        if (!touched.has(id)) continue
        const at = current.indexOf(id)
        if (at >= 0 && (current[at + 1] || null) === beforeId) continue
        if (at >= 0) current.splice(at, 1)
        const anchor = beforeId ? current.indexOf(beforeId) : current.length
        if (anchor < 0) continue
        current.splice(anchor, 0, id)
        moves.push({ kind: kind === 'categories' ? 'category' : 'link', id, beforeId, ...(kind === 'links' ? { categoryId: group || null } : {}) })
      }
    }
  }
  const total = built.body.categories.length + built.body.links.length + moves.length
  if (total > 500 && !built.errors.some(error => error.code === 'limit')) built.errors.push({ kind: 'links', id: '', field: '', code: 'limit' })
  return { body: { ...built.body, ...(moves.length ? { moves } : {}) }, errors: built.errors, count: new Set([...built.body.categories.map(row => 'c:' + row.id), ...built.body.links.map(row => 'l:' + row.id), ...moves.map(row => row.kind[0] + ':' + row.id)]).size }
}
/** A page binding is a projection, never the authority for a write or a full reorder. */
export function projectContentNavigation(data: NavigationData, query: Record<string, unknown>): NavigationData {
  const categoryIds = Array.isArray(query.categoryIds) ? query.categoryIds : []
  const tags = Array.isArray(query.tags) ? query.tags : []
  const search = typeof query.search === 'string' ? query.search.trim().toLowerCase() : ''
  let links = data.links.filter(link => (!query.favoritesOnly || link.isFavorite)
    && (!categoryIds.length || categoryIds.includes(link.categoryId))
    && tags.every(tag => link.tags.includes(String(tag)))
    && (!search || [link.title, link.url, link.description, ...link.tags].join(' ').toLowerCase().includes(search)))
  links = [...links].sort((a, b) => query.sort === 'title' ? a.title.toLowerCase().localeCompare(b.title.toLowerCase()) : query.sort === 'updatedAt' ? b.updatedAt.localeCompare(a.updatedAt) : a.sortOrder - b.sortOrder)
  if (typeof query.limit === 'number' && query.limit > 0) links = links.slice(0, query.limit)
  return { categories: data.categories, links }
}

export function rebaseContentDraft(draft: ContentDraft, latest: Dataset<NavigationData>) {
  const merged = rebaseInlineDraft(draft.fields, latest)
  let next = { ...freshContentDraft(latest, draft.locale), fields: merged.draft }
  const conflicts: OrderConflict[] = []
  const originalOrders = navigationOrders(draft.fields.base.data, draft.locale)
  const serverOrders = navigationOrders(latest.data, draft.locale)
  // Reconstruct final memberships from the rebased fields before reapplying order.
  next.orders = navigationOrders(draftNavigation(merged.draft), draft.locale)
  for (const kind of ['categories', 'links'] as const) {
    const ids = draft.moved[kind].filter(id => latest.data[kind].some(row => row.id === id))
    if (!ids.length) continue
    const groups = new Set<string>()
    for (const id of ids) for (const source of [originalOrders[kind], draft.orders[kind]]) for (const [group, values] of Object.entries(source)) if (values.includes(id)) groups.add(group)
    const changed = [...groups].some(group => !same(originalOrders[kind][group] || [], serverOrders[kind][group] || []))
    const committed = [...groups].every(group => same(draft.orders[kind][group] || [], serverOrders[kind][group] || []))
    if (committed && [...groups].every(group => same(draft.orders[kind][group] || [], next.orders[kind][group] || []))) continue
    if (changed && !committed) conflicts.push({ kind, ids })
    for (const [group, wanted] of Object.entries(draft.orders[kind])) for (let i = wanted.length - 1; i >= 0; i--) {
      const id = wanted[i]!
      if (!ids.includes(id)) continue
      const existing = draftNavigation(next.fields)[kind]
      const row = existing.find(item => item.id === id)
      if (!row || parent(row) !== (group || null)) continue
      const beforeId = wanted.slice(i + 1).find(candidate => existing.some(item => item.id === candidate && parent(item) === parent(row))) || null
      next = moveContent(next, kind, id, group || null, beforeId)
    }
  }
  return { draft: next, conflicts: merged.conflicts, orderConflicts: conflicts }
}
export function resolveContentField(draft: ContentDraft, conflict: InlineConflict, choice: 'mine' | 'server'): ContentDraft {
  const fields = resolveInlineConflict(draft.fields, conflict, choice)
  if (conflict.field === '$deleted') {
    const groups = Object.fromEntries(Object.entries(draft.orders[conflict.kind]).map(([group, ids]) => [group, ids.filter(id => id !== conflict.id)]))
    return { ...draft, fields, orders: { ...draft.orders, [conflict.kind]: groups }, moved: { ...draft.moved, [conflict.kind]: draft.moved[conflict.kind].filter(id => id !== conflict.id) } }
  }
  const value = draftNavigation(fields)[conflict.kind].find(row => row.id === conflict.id)
  if (value && ['categoryId', 'parentId'].includes(conflict.field)) {
    const next = { ...draft, fields }
    return moveContent(next, conflict.kind, conflict.id, parent(value), null)
  }
  return { ...draft, fields }
}
export function discardContentOrder(draft: ContentDraft, kind: InlineKind): ContentDraft {
  return { ...draft, orders: { ...draft.orders, [kind]: navigationOrders(draftNavigation(draft.fields), draft.locale)[kind] }, moved: { ...draft.moved, [kind]: [] } }
}
