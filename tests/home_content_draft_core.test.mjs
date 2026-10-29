import test from 'node:test'
import assert from 'node:assert/strict'
import { freshContentDraft, moveContent, changeContentField, buildContentEdit, contentNavigation, rebaseContentDraft, resolveContentField, discardContentOrder, projectContentNavigation } from '../web/src/core/home-content-draft.ts'
import { createDraftHistory, recordDraft, undoDraft, redoDraft } from '../web/src/core/draft-history.ts'

const category = (id, sortOrder = 0, parentId = null) => ({ id, name: id, spaceId: 's', parentId, sortOrder, icon: 'lucide:folder' })
const link = (id, sortOrder, categoryId = 'one') => ({ id, title: id, spaceId: 's', categoryId, sortOrder, url: 'https://example.invalid/' + id, description: 'description', icon: 'lucide:link', iconMode: 'manual', tags: ['dev'], isFavorite: false, endpoints: [{ label: 'Internal', url: 'http://nas.invalid', route: 'internal' }], contextMarkdown: 'Agent notes', updatedAt: '2026-10-28T00:00:00Z' })
const base = () => ({ datasetId: 'local-navigation', revision: '10', schemaId: 'navigation.collection', schemaVersion: 1, meta: {}, data: { categories: [category('one', 0), category('two', 1), category('child', 0, 'one')], links: ['a', 'b', 'c', 'd', 'e'].map((id, index) => link(id, index)) } })

test('hidden rows retain relative order and a move submits one stable ID', () => {
  const draft = moveContent(freshContentDraft(base()), 'links', 'e', 'one', 'c')
  assert.deepEqual(draft.orders.links.one, ['a', 'b', 'e', 'c', 'd'])
  const built = buildContentEdit(draft)
  assert.deepEqual(built.body.moves, [{ kind: 'link', id: 'e', categoryId: 'one', beforeId: 'c' }])
  assert.deepEqual(built.body.links, [])
  assert.equal(built.count, 1)
})
test('moving one row in 1001 siblings does not become 1001 patches', () => {
  const data = base(); data.data.links = Array.from({ length: 1001 }, (_, index) => link('link-' + index, index))
  const draft = moveContent(freshContentDraft(data), 'links', 'link-1000', 'one', 'link-0')
  const built = buildContentEdit(draft)
  assert.equal(built.body.moves.length, 1); assert.equal(built.body.links.length, 0); assert.deepEqual(built.errors, [])
  assert.equal(draft.orders.links.one.length, 1001)
})
test('cross-category move retains URLs, endpoints, notes and the origin siblings', () => {
  const data = base(); data.data.links.push(link('x', 0, 'two'), link('y', 1, 'two'))
  const draft = moveContent(freshContentDraft(data), 'links', 'b', 'two', 'y')
  assert.deepEqual(draft.orders.links.one, ['a', 'c', 'd', 'e'])
  assert.deepEqual(draft.orders.links.two, ['x', 'b', 'y'])
  const row = contentNavigation(draft).links.find(item => item.id === 'b')
  assert.equal(row.categoryId, 'two'); assert.equal(row.contextMarkdown, 'Agent notes'); assert.deepEqual(row.endpoints, data.data.links[1].endpoints)
  const patch = buildContentEdit(draft).body.links[0].patch
  assert.deepEqual(patch, { categoryId: 'two' })
})
test('empty category and uncategorized receive a row at the end', () => {
  let draft = moveContent(freshContentDraft(base()), 'links', 'a', 'two', null)
  assert.deepEqual(draft.orders.links.two, ['a'])
  draft = moveContent(draft, 'links', 'b', null, null)
  assert.deepEqual(draft.orders.links[''], ['b']); assert.equal(contentNavigation(draft).links.find(item => item.id === 'b').categoryId, null)
})
test('invalid, foreign, cross-level and self-drop anchors leave the draft unchanged', () => {
  const draft = freshContentDraft(base())
  assert.equal(moveContent(draft, 'links', 'a', 'one', 'a'), draft)
  assert.equal(moveContent(draft, 'links', 'a', 'foreign', null), draft)
  assert.equal(moveContent(draft, 'links', 'a', 'two', 'c'), draft)
  assert.equal(moveContent(draft, 'categories', 'one', 'child', null), draft)
  assert.equal(moveContent(draft, 'categories', 'one', null, 'child'), draft)
})
test('category order does not rewrite hierarchy or child order', () => {
  const draft = moveContent(freshContentDraft(base()), 'categories', 'two', null, 'one')
  assert.deepEqual(draft.orders.categories[''], ['two', 'one']); assert.deepEqual(draft.orders.categories.one, ['child'])
  assert.deepEqual(buildContentEdit(draft).body.moves, [{ kind: 'category', id: 'two', beforeId: 'one' }])
  assert.equal(contentNavigation(draft).categories.find(item => item.id === 'child').parentId, 'one')
})
test('changing the category field appends without immediate persistence', () => {
  const data = base(); data.data.links.push(link('x', 0, 'two'))
  const draft = changeContentField(freshContentDraft(data), 'links', 'a', { categoryId: 'two', title: 'Changed' })
  assert.deepEqual(draft.orders.links.two, ['x', 'a']); assert.equal(data.data.links[0].categoryId, 'one')
  assert.deepEqual(buildContentEdit(draft).body.links[0].patch, { title: 'Changed', categoryId: 'two' })
})
test('parent selection appends the category and invalid cycles are still validated', () => {
  let draft = changeContentField(freshContentDraft(base()), 'categories', 'child', { parentId: null })
  assert.deepEqual(draft.orders.categories[''], ['one', 'two', 'child'])
  draft = changeContentField(draft, 'categories', 'one', { parentId: 'one' })
  assert(buildContentEdit(draft).errors.some(error => error.code === 'cycle'))
})
test('a returned-to-original move is a no-op and a drag is one undo step', () => {
  const initial = freshContentDraft(base())
  const moved = moveContent(initial, 'links', 'e', 'one', 'a')
  const history = recordDraft(createDraftHistory(initial), moved)
  assert.deepEqual(undoDraft(history).present, initial); assert.deepEqual(redoDraft(undoDraft(history)).present, moved)
  assert.equal(buildContentEdit(moveContent(moved, 'links', 'e', 'one', null)).count, 0)
})
test('multiple moved IDs compile into the final order with right-to-left anchors', () => {
  let draft = moveContent(freshContentDraft(base()), 'links', 'e', 'one', 'a')
  draft = moveContent(draft, 'links', 'd', 'one', 'e')
  draft = moveContent(draft, 'links', 'b', 'one', 'e')
  const ids = ['a', 'b', 'c', 'd', 'e']
  for (const move of buildContentEdit(draft).body.moves) { ids.splice(ids.indexOf(move.id), 1); ids.splice(move.beforeId ? ids.indexOf(move.beforeId) : ids.length, 0, move.id) }
  assert.deepEqual(ids, draft.orders.links.one)
})
test('readback merges untouched fields and recognizes an already committed order', () => {
  const original = base(), draft = changeContentField(moveContent(freshContentDraft(original), 'links', 'e', 'one', 'a'), 'links', 'a', { title: 'Mine' })
  const latest = structuredClone(original); latest.revision = '11'; latest.data.links[1].description = 'Remote'
  const merged = rebaseContentDraft(draft, latest)
  assert.deepEqual(merged.conflicts, []); assert.deepEqual(merged.orderConflicts, []); assert.equal(contentNavigation(merged.draft).links[1].description, 'Remote')
  latest.data = contentNavigation(draft); latest.revision = '12'
  const committed = rebaseContentDraft(draft, latest)
  assert.equal(buildContentEdit(committed.draft).count, 0); assert.deepEqual(committed.orderConflicts, [])
})
test('concurrent order and field conflicts need an explicit choice', () => {
  const original = base(), draft = changeContentField(moveContent(freshContentDraft(original), 'links', 'e', 'one', 'a'), 'links', 'a', { title: 'Mine' })
  const latest = structuredClone(original); latest.revision = '11'; latest.data.links[0].title = 'Theirs'; latest.data.links[1].sortOrder = -1
  const merged = rebaseContentDraft(draft, latest)
  assert.equal(merged.conflicts.length, 1); assert.equal(merged.orderConflicts.length, 1)
  let resolved = resolveContentField(merged.draft, merged.conflicts[0], 'server')
  resolved = discardContentOrder(resolved, 'links')
  assert.equal(buildContentEdit(resolved).count, 0)
})
test('deleted records are not silently recreated on readback', () => {
  const original = base(), draft = changeContentField(freshContentDraft(original), 'links', 'a', { title: 'Mine' })
  const latest = structuredClone(original); latest.data.links.shift(); latest.revision = '11'
  const merged = rebaseContentDraft(draft, latest)
  assert.equal(merged.conflicts[0].field, '$deleted')
  const resolved = resolveContentField(merged.draft, merged.conflicts[0], 'server')
  assert.equal(buildContentEdit(resolved).count, 0); assert(!contentNavigation(resolved).links.some(row => row.id === 'a'))
})
test('filtered component projections do not expand to private or out-of-query entries', () => {
  const data = base().data; data.links.push({ ...link('other', 0, 'two'), tags: ['ops'], isFavorite: true })
  const projected = projectContentNavigation(data, { categoryIds: ['one'], tags: ['dev'], search: 'b', limit: 1 })
  assert.deepEqual(projected.links.map(row => row.id), ['b'])
  assert.deepEqual(projectContentNavigation(data, { favoritesOnly: true }).links.map(row => row.id), ['other'])
  assert.equal(data.links.length, 6)
})
test('renaming tied records preserves the visible position on save and readback', () => {
  const source = base(); source.data.categories[0].name = 'Alpha'; source.data.categories[1].name = 'Bravo'; source.data.categories[1].sortOrder = 0
  source.data.links[1].sortOrder = 0
  let draft = changeContentField(freshContentDraft(source, 'en'), 'categories', 'one', { name: 'Zulu' })
  draft = changeContentField(draft, 'links', 'a', { title: 'Zulu' })
  assert.deepEqual(buildContentEdit(draft).body.moves, [
    { kind: 'category', id: 'one', beforeId: 'two' },
    { kind: 'link', id: 'a', beforeId: 'b', categoryId: 'one' }
  ])
  const sameServer = rebaseContentDraft(draft, source)
  assert.deepEqual(sameServer.orderConflicts, [])
  assert.deepEqual(buildContentEdit(sameServer.draft).body.moves, buildContentEdit(draft).body.moves)
  const saved = { ...source, revision: '11', data: contentNavigation(draft) }
  assert.equal(buildContentEdit(rebaseContentDraft(draft, saved).draft).count, 0)
})
test('entering edit preserves sort values and membership in limited components', () => {
  const source = base(); source.data.links = [link('a', 100), link('b', 101), link('x', 0, 'two'), link('y', 1, 'two')]
  const draft = freshContentDraft(source)
  assert.deepEqual(contentNavigation(draft), source.data)
  assert.deepEqual(projectContentNavigation(contentNavigation(draft), { limit: 2 }).links.map(row => row.id), ['x', 'y'])
  const changed = changeContentField(draft, 'links', 'a', { title: 'Changed' })
  assert.deepEqual(projectContentNavigation(contentNavigation(changed), { limit: 2 }).links.map(row => row.id), ['x', 'y'])
})
