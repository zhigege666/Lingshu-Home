import { buildBatchEdit, categoryDraft, linkDraft, draftNavigation, freshInlineDraft, putDraft, readDraft, rebaseInlineDraft, resolveInlineConflict, type CategoryDraft, type InlineConflict, type InlineDraft, type InlineKind, type LinkDraft } from './navigation-inline.ts'
import type { Category, Dataset, NavigationData, NavLink } from './types'

export type ContentOrders = { categories: Record<string, string[]>; links: Record<string, string[]> }
export type ContentDraft = {
  fields: InlineDraft
  /** IDs added to the working dataset locally, never written before Save. */
  created: { categories: string[]; links: string[] }
  /** Existing bookmarks removed only when the whole draft is saved. */
  deletedLinkIds: string[]
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
  return { fields: freshInlineDraft(base), created: { categories: [], links: [] }, deletedLinkIds: [], orders: navigationOrders(base.data, locale), moved: { categories: [], links: [] }, locale }
}
export function newNavigationID(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}

function visibleContentData(draft: ContentDraft): NavigationData {
  const data = draftNavigation(draft.fields), deleted = new Set(draft.deletedLinkIds)
  return { ...data, links: data.links.filter(row => !deleted.has(row.id)) }
}

/** Keep the original row for conflict comparison; history restores its edits and position. */
export function deleteContentLink(draft: ContentDraft, id: string): ContentDraft {
  if (draft.deletedLinkIds.includes(id) || !draft.fields.base.data.links.some(row => row.id === id)) return draft
  const created = draft.created.links.includes(id), links = { ...draft.fields.links }
  delete links[id]
  return { ...draft,
    fields: { ...draft.fields, links, base: created ? { ...draft.fields.base, data: { ...draft.fields.base.data, links: draft.fields.base.data.links.filter(row => row.id !== id) } } : draft.fields.base },
    created: { ...draft.created, links: draft.created.links.filter(value => value !== id) },
    deletedLinkIds: created ? draft.deletedLinkIds : [...draft.deletedLinkIds, id],
    moved: { ...draft.moved, links: draft.moved.links.filter(value => value !== id) },
    orders: { ...draft.orders, links: Object.fromEntries(Object.entries(draft.orders.links).map(([group, ids]) => [group, ids.filter(value => value !== id)])) },
  }
}

/** Seed a locally editable row with its final stable ID. The captured revision is unchanged. */
export function addContentRow(draft: ContentDraft, kind: InlineKind, id: string, spaceId: string, parentId: string | null): ContentDraft {
  const data = draftNavigation(draft.fields)
  if (!/^[0-9a-f]{32}$/.test(id) || data.links.some(row => row.id === id) || data.categories.some(row => row.id === id)
    || parentId && !data.categories.some(row => row.id === parentId)) return draft
  const group = key(parentId), siblings = draft.orders[kind][group] || []
  const sortOrder = Math.min(1000000, data[kind].reduce((max, row) => parent(row) === parentId ? Math.max(max, row.sortOrder) : max, -1) + 1)
  const base = draft.fields.base
  const rows = kind === 'categories'
    ? { ...base.data, categories: [...base.data.categories, { id, spaceId, parentId, name: '', icon: 'lucide:folder', sortOrder }] }
    : { ...base.data, links: [...base.data.links, { id, spaceId, categoryId: parentId, title: '', url: '', description: '', icon: 'lucide:link', iconMode: 'auto' as const, tags: [], isFavorite: false, sortOrder, endpoints: [], updatedAt: '' }] }
  return { ...draft, fields: { ...draft.fields, base: { ...base, data: rows } },
    created: { ...draft.created, [kind]: [...draft.created[kind], id] },
    moved: { ...draft.moved, [kind]: [...new Set([...draft.moved[kind], id])] },
    orders: { ...draft.orders, [kind]: { ...draft.orders[kind], [group]: [...siblings, id] } } }
}
/** Changes stay in one account/space draft; no layout or external-source data enters it. */
export function changeContentField(draft: ContentDraft, kind: InlineKind, id: string, patch: Partial<CategoryDraft & LinkDraft>): ContentDraft {
  if (kind === 'links' && draft.deletedLinkIds.includes(id)) return draft
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
  const data = visibleContentData(draft), row = data[kind].find(item => item.id === id)
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
  const data = visibleContentData(draft)
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
  const data = visibleContentData(draft), newCategories = new Set(draft.created.categories), newLinks = new Set(draft.created.links)
  // Validate even untouched empty fields in newly inserted rows.
  const fields = { ...draft.fields, categories: { ...draft.fields.categories }, links: { ...draft.fields.links } }
  for (const row of data.categories) if (newCategories.has(row.id)) fields.categories[row.id] ??= categoryDraft(row)
  for (const row of data.links) if (newLinks.has(row.id)) fields.links[row.id] ??= linkDraft(row)
  const built = buildBatchEdit(fields)
  const categories = built.body.categories.filter(row => !newCategories.has(row.id)), links = built.body.links.filter(row => !newLinks.has(row.id))
  const additions = new Map(data.categories.filter(row => newCategories.has(row.id)).map(row => [row.id, row]))
  const seen = new Set<string>(), createCategories: Omit<Category, 'spaceId'>[] = []
  function addParentFirst(row: Category) {
    if (seen.has(row.id)) return
    seen.add(row.id)
    const ancestor = row.parentId && additions.get(row.parentId)
    if (ancestor) addParentFirst(ancestor)
    createCategories.push({ id: row.id, name: row.name.trim(), icon: row.icon, parentId: row.parentId, sortOrder: row.sortOrder })
  }
  for (const row of additions.values()) addParentFirst(row)
  const createLinks = data.links.filter(row => newLinks.has(row.id)).map(row => ({
    id: row.id, categoryId: row.categoryId, title: row.title.trim(), url: row.url.trim(), description: row.description.trim(),
    icon: row.icon, iconMode: row.iconMode, tags: row.tags, isFavorite: row.isFavorite, sortOrder: row.sortOrder, endpoints: row.endpoints,
  }))
  const simulated = navigationOrders(data, draft.locale)
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
  const total = categories.length + links.length + createCategories.length + createLinks.length + moves.length + draft.deletedLinkIds.length
  if (total > 500 && !built.errors.some(error => error.code === 'limit')) built.errors.push({ kind: 'links', id: '', field: '', code: 'limit' })
  return { body: { expectedRevision: fields.base.revision, categories, links, ...(createCategories.length ? { createCategories } : {}),
    ...(createLinks.length ? { createLinks } : {}), ...(moves.length ? { moves } : {}), ...(draft.deletedLinkIds.length ? { deleteLinkIds: draft.deletedLinkIds } : {}) }, errors: built.errors,
    count: new Set([...categories, ...createCategories].map(row => 'c:' + row.id).concat([...links, ...createLinks].map(row => 'l:' + row.id), moves.map(row => row.kind[0] + ':' + row.id), draft.deletedLinkIds.map(id => 'l:' + id))).size }

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
  // A fresh GET can confirm an earlier atomic save whose response never arrived.
  // Only missing, never-observed creation IDs are carried forward as local rows.
  const localBase = draft.fields.base.data
  const candidates = { categories: localBase.categories.filter(row => draft.created.categories.includes(row.id)), links: localBase.links.filter(row => draft.created.links.includes(row.id)) }
  const latestIDs = { categories: new Set(latest.data.categories.map(row => row.id)), links: new Set(latest.data.links.map(row => row.id)) }
  const observed = candidates.categories.some(row => latestIDs.categories.has(row.id)) || candidates.links.some(row => latestIDs.links.has(row.id))
  const pending = { categories: observed ? [] : candidates.categories, links: observed ? [] : candidates.links }
  const working = { ...latest, data: { categories: [...latest.data.categories, ...pending.categories], links: [...latest.data.links, ...pending.links] } }
  const merged = rebaseInlineDraft(draft.fields, working)
  let next: ContentDraft = { ...freshContentDraft(working, draft.locale), fields: merged.draft,
    created: { categories: pending.categories.map(row => row.id), links: pending.links.map(row => row.id) } }
  for (const id of draft.deletedLinkIds) {
    const before = localBase.links.find(row => row.id === id), server = latest.data.links.find(row => row.id === id)
    // A missing row confirms a previous deletion without replaying a write.
    if (!server) continue
    next = deleteContentLink(next, id)
    if (!same(before, server)) merged.conflicts.push({ kind: 'links', id, field: '$delete', base: before, mine: null, server })
  }
  const conflicts: OrderConflict[] = []
  const withoutDeleted = (data: NavigationData) => ({ ...data, links: data.links.filter(row => !draft.deletedLinkIds.includes(row.id)) })
  const originalOrders = navigationOrders(withoutDeleted(draft.fields.base.data), draft.locale)
  const serverOrders = navigationOrders(withoutDeleted(latest.data), draft.locale)
  // Reconstruct final memberships from the rebased fields before reapplying order.
  next.orders = navigationOrders(visibleContentData(next), draft.locale)
  const moves = buildContentEdit(draft).body.moves || []
  for (const kind of ['categories', 'links'] as const) {
    // A rename is marked as potentially moving to preserve legacy ties. If it
    // produced no move, a new sibling on the server cannot be an order conflict.
    const ids = moves.filter(m => m.kind === (kind === 'links' ? 'link' : 'category') && working.data[kind].some(row => row.id === m.id)).map(m => m.id)

    if (!ids.length) continue
    const groups = new Set<string>()
    for (const id of ids) for (const source of [originalOrders[kind], draft.orders[kind]]) for (const [group, values] of Object.entries(source)) if (values.includes(id)) groups.add(group)
    const changed = [...groups].some(group => {
      const before = originalOrders[kind][group] || [], after = serverOrders[kind][group] || []
      const old = new Set(before), remote = new Set(after)
      // Concurrent additions do not reorder existing siblings. A moved row
      // that changed groups or a removed drop anchor still needs explicit review.
      return ids.some(id => old.has(id) !== remote.has(id) && !draft.created[kind].includes(id))
        || moves.some(move => ids.includes(move.id) && move.beforeId && old.has(move.beforeId) && !remote.has(move.beforeId))
        || moves.filter(m => ids.includes(m.id)).some(m => [m.id, m.beforeId].some(target => {
          if (!target || !old.has(target) || !remote.has(target)) return false
          const oldBefore = new Set(before.slice(0, before.indexOf(target))), serverBefore = new Set(after.slice(0, after.indexOf(target)))
          return before.some(sibling => remote.has(sibling) && oldBefore.has(sibling) !== serverBefore.has(sibling))
        }))
    })
    const committed = [...groups].every(group => same(draft.orders[kind][group] || [], serverOrders[kind][group] || []))
    if (committed && [...groups].every(group => same(draft.orders[kind][group] || [], next.orders[kind][group] || []))) continue
    if (changed && !committed) conflicts.push({ kind, ids })
    for (const [group, wanted] of Object.entries(draft.orders[kind])) for (let i = wanted.length - 1; i >= 0; i--) {
      const id = wanted[i]!
      if (!ids.includes(id)) continue
      const existing = visibleContentData(next)[kind]
      const row = existing.find(item => item.id === id)
      if (!row || parent(row) !== (group || null)) continue
      const beforeId = wanted.slice(i + 1).find(candidate => existing.some(item => item.id === candidate && parent(item) === parent(row))) || null
      next = moveContent(next, kind, id, group || null, beforeId)
    }
  }
  return { draft: next, conflicts: merged.conflicts, orderConflicts: conflicts }
}
export function resolveContentField(draft: ContentDraft, conflict: InlineConflict, choice: 'mine' | 'server'): ContentDraft {
  if (conflict.field === '$delete') {
    if (choice === 'mine') return draft
    const next = { ...draft, deletedLinkIds: draft.deletedLinkIds.filter(id => id !== conflict.id) }
    const row = next.fields.base.data.links.find(item => item.id === conflict.id)
    if (!row) return next
    const group = key(row.categoryId), canonical = navigationOrders(visibleContentData(next), next.locale).links[group] || []
    const ids = [...(next.orders.links[group] || [])]
    const anchor = canonical.slice(canonical.indexOf(row.id) + 1).find(id => ids.includes(id))
    ids.splice(anchor ? ids.indexOf(anchor) : ids.length, 0, row.id)
    return { ...next, orders: { ...next.orders, links: { ...next.orders.links, [group]: ids } } }
  }
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
  return { ...draft, orders: { ...draft.orders, [kind]: navigationOrders(visibleContentData(draft), draft.locale)[kind] }, moved: { ...draft.moved, [kind]: [] } }
}
