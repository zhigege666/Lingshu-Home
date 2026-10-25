import test from 'node:test'
import assert from 'node:assert/strict'
import { clearRememberedSpace, forgetSpacePreference, readRememberedSpace, readSpacePreferences, rememberSpace, rememberSuccessfulSpace, selectAccessibleSpace, setDefaultSpace, spacePreferenceKey, spaceSelectionKey } from '../web/src/core/space-selection.ts'

// Node 24 strips the dependency-free TypeScript module. All storage below is
// in memory: these tests neither open an instance nor save browser data.
const personal = '1'.repeat(32), shared = '2'.repeat(32), other = '3'.repeat(32)
const owner = { id: 'a'.repeat(32), username: 'owner', role: 'Owner' }
const member = { id: 'b'.repeat(32), username: 'member', role: 'Member' }
const fixture = (overrides = {}) => ({ initialized: true, user: owner, defaultSpaceId: personal, spaces: [{ id: personal, kind: 'personal' }, { id: shared, kind: 'shared' }], ...overrides })
function memory() {
  const values = new Map()
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}

test('the API default remains personal unless setup explicitly chooses a shared landing', () => {
  const boot = fixture()
  assert.equal(selectAccessibleSpace(boot), personal)
  assert.equal(selectAccessibleSpace(boot, { preferShared: true, currentId: personal, rememberedId: personal }), shared)
  assert.equal(boot.defaultSpaceId, personal)
})

test('a chosen setup or manual space survives a fresh document selection', () => {
  const boot = fixture(), storage = memory()
  assert.equal(rememberSpace(boot, shared, storage), true)
  assert.equal(selectAccessibleSpace(boot, { rememberedId: readRememberedSpace(boot, storage) }), shared)
  assert.equal(rememberSpace(boot, personal, storage), true)
  assert.equal(selectAccessibleSpace(boot, { rememberedId: readRememberedSpace(boot, storage) }), personal)
  assert.deepEqual([...storage.values.values()], [personal])
})

test('anonymous, owner and member selections cannot override one another', () => {
  const storage = memory(), owned = fixture()
  const guest = fixture({ user: null, spaces: [{ id: shared, kind: 'shared' }], defaultSpaceId: shared })
  const membership = fixture({ user: member, spaces: [{ id: other, kind: 'personal' }, { id: shared, kind: 'shared' }], defaultSpaceId: other })
  assert.equal(rememberSpace(owned, personal, storage), true)
  assert.equal(rememberSpace(guest, shared, storage), true)
  assert.equal(readRememberedSpace(membership, storage), '')
  assert.equal(selectAccessibleSpace(membership, { rememberedId: readRememberedSpace(membership, storage) }), other)
  assert.equal(rememberSpace(membership, shared, storage), true)
  assert.equal(readRememberedSpace(owned, storage), personal)
  assert.equal(readRememberedSpace(guest, storage), shared)
  assert.equal(new Set([spaceSelectionKey(owned), spaceSelectionKey(guest), spaceSelectionKey(membership)]).size, 3)
})

test('revoked, deleted and forged identifiers are removed and never become a request target', () => {
  const storage = memory(), boot = fixture({ spaces: [{ id: shared, kind: 'shared' }], defaultSpaceId: shared })
  for (const id of [personal, other, 'https://outside.invalid/private', '{"spaceId":"private"}']) {
    storage.setItem(spaceSelectionKey(boot), id)
    assert.equal(readRememberedSpace(boot, storage), '')
    assert.equal(storage.getItem(spaceSelectionKey(boot)), null)
    assert.equal(rememberSpace(boot, id, storage), false)
    assert.equal(selectAccessibleSpace(boot, { currentId: id, rememberedId: id }), shared)
  }
})

test('a missing shared space or stale server default falls back only to accessible inventory', () => {
  assert.equal(selectAccessibleSpace(fixture({ spaces: [{ id: personal, kind: 'personal' }] }), { preferShared: true }), personal)
  assert.equal(selectAccessibleSpace(fixture({ defaultSpaceId: other })), personal)
  assert.equal(selectAccessibleSpace(fixture({ spaces: [], defaultSpaceId: personal })), '')
  assert.equal(selectAccessibleSpace(fixture({ initialized: false }), { preferShared: true, currentId: personal }), '')
})

test('blocked storage does not interrupt navigation or sign-in', () => {
  const blocked = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() { throw new Error('blocked') } }
  assert.equal(readRememberedSpace(fixture(), blocked), '')
  assert.equal(rememberSpace(fixture(), shared, blocked), false)
  assert.equal(readRememberedSpace(fixture(), null), '')
  assert.equal(rememberSpace(fixture(), shared, null), false)
  assert.equal(selectAccessibleSpace(fixture(), { rememberedId: readRememberedSpace(fixture(), blocked) }), personal)
})

test('an active accessible selection takes precedence over an older stored choice', () => {
  assert.equal(selectAccessibleSpace(fixture(), { currentId: personal, rememberedId: shared }), personal)
  assert.equal(selectAccessibleSpace(fixture(), { currentId: other, rememberedId: shared }), shared)
})

test('persistent success survives a new tab while fixed and manual choices have explicit precedence', () => {
  const boot = fixture({ spaces: [...fixture().spaces, { id: other, kind: 'shared' }] }), local = memory()
  rememberSuccessfulSpace(boot, shared, local)
  let preferences = readSpacePreferences(boot, local)
  assert.equal(readRememberedSpace(boot, memory()), '', 'a new tab has no manual choice')
  assert.equal(selectAccessibleSpace(boot, { rememberedId: preferences.lastSpaceId }), shared)
  assert.equal(setDefaultSpace(boot, other, local), true)
  preferences = readSpacePreferences(boot, local)
  assert.equal(selectAccessibleSpace(boot, { fixedId: preferences.defaultSpaceId, rememberedId: preferences.lastSpaceId }), other)
  assert.equal(selectAccessibleSpace(boot, { currentId: personal, fixedId: other, rememberedId: shared }), personal)
  assert.equal(selectAccessibleSpace(boot, { currentId: personal, fixedId: other, rememberedId: personal, preferShared: true }), shared)
  assert.equal(boot.defaultSpaceId, personal, 'the API default is not modified')
})

test('remember-last clears only the fixed default and success updates do not replace it', () => {
  const boot = fixture(), local = memory()
  setDefaultSpace(boot, personal, local)
  rememberSuccessfulSpace(boot, shared, local)
  assert.deepEqual(readSpacePreferences(boot, local), { lastSpaceId: shared, defaultSpaceId: personal })
  assert.equal(setDefaultSpace(boot, '', local), true)
  assert.deepEqual(readSpacePreferences(boot, local), { lastSpaceId: shared, defaultSpaceId: '' })
  assert.equal(setDefaultSpace(boot, other, local), false)
  assert.deepEqual(readSpacePreferences(boot, local), { lastSpaceId: shared, defaultSpaceId: '' })
})

test('persistent preferences are isolated by account and by browser origin storage', () => {
  const firstOrigin = memory(), secondOrigin = memory(), owned = fixture(), membership = fixture({ user: member }), guest = fixture({ user: null })
  rememberSuccessfulSpace(owned, shared, firstOrigin)
  setDefaultSpace(owned, shared, firstOrigin)
  rememberSuccessfulSpace(membership, personal, firstOrigin)
  setDefaultSpace(membership, personal, firstOrigin)
  assert.deepEqual(readSpacePreferences(owned, firstOrigin), { lastSpaceId: shared, defaultSpaceId: shared })
  assert.deepEqual(readSpacePreferences(membership, firstOrigin), { lastSpaceId: personal, defaultSpaceId: personal })
  assert.deepEqual(readSpacePreferences(guest, firstOrigin), { lastSpaceId: '', defaultSpaceId: '' })
  assert.deepEqual(readSpacePreferences(owned, secondOrigin), { lastSpaceId: '', defaultSpaceId: '' })
  assert.notEqual(spacePreferenceKey(owned), spacePreferenceKey(membership))
  assert.notEqual(spacePreferenceKey(owned), spaceSelectionKey(owned))
})

test('valid legacy session choice migrates only after a successful read', () => {
  const boot = fixture(), tab = memory(), local = memory()
  rememberSpace(boot, shared, tab)
  const target = selectAccessibleSpace(boot, { currentId: readRememberedSpace(boot, tab) })
  assert.equal(target, shared)
  assert.deepEqual(readSpacePreferences(boot, local), { lastSpaceId: '', defaultSpaceId: '' }, 'selection itself does not persist a possibly failed request')
  rememberSuccessfulSpace(boot, target, local)
  assert.deepEqual(readSpacePreferences(boot, local), { lastSpaceId: shared, defaultSpaceId: '' })
  clearRememberedSpace(boot, tab)
  assert.equal(readRememberedSpace(boot, tab), '')
  assert.equal(readSpacePreferences(boot, local).lastSpaceId, shared, 'sign-out clears the tab override but preserves account preference')
})

test('revocation removes only invalid preference fields and rejected IDs cannot be persisted', () => {
  const boot = fixture(), local = memory()
  for (const id of [other, 'https://outside.invalid/private', { spaceId: shared }, 123]) {
    local.setItem(spacePreferenceKey(boot), JSON.stringify({ lastSpaceId: shared, defaultSpaceId: id }))
    assert.deepEqual(readSpacePreferences(boot, local), { lastSpaceId: shared, defaultSpaceId: '' })
    assert.deepEqual(JSON.parse(local.getItem(spacePreferenceKey(boot))), { lastSpaceId: shared, defaultSpaceId: '' })
  }
  assert.equal(rememberSuccessfulSpace(boot, other, local), false)
  const revoked = fixture({ spaces: [{ id: personal, kind: 'personal' }] })
  assert.deepEqual(readSpacePreferences(revoked, local), { lastSpaceId: '', defaultSpaceId: '' })
  assert.equal(local.getItem(spacePreferenceKey(boot)), null)
  assert.equal(selectAccessibleSpace(revoked, { currentId: shared, fixedId: shared, rememberedId: shared }), personal)
})

test('403 or 404 cleanup invalidates the failed target even with stale bootstrap inventory', () => {
  const boot = fixture(), local = memory(), tab = memory()
  rememberSpace(boot, shared, tab)
  rememberSuccessfulSpace(boot, shared, local)
  setDefaultSpace(boot, shared, local)
  clearRememberedSpace(boot, tab, personal)
  assert.equal(readRememberedSpace(boot, tab), shared, 'cleanup for another target does not remove a valid manual choice')
  clearRememberedSpace(boot, tab, shared)
  forgetSpacePreference(boot, shared, local)
  assert.equal(readRememberedSpace(boot, tab), '')
  assert.deepEqual(readSpacePreferences(boot, local), { lastSpaceId: '', defaultSpaceId: '' })
  assert.equal(selectAccessibleSpace(boot, { currentId: shared, fixedId: shared, rememberedId: shared, excludedIds: [shared] }), personal)
  assert.equal(selectAccessibleSpace(boot, { excludedIds: [personal, shared] }), '')
})

test('malformed preference records are removed without changing unrelated browser data', () => {
  const boot = fixture(), local = memory()
  local.setItem('other-feature', 'keep')
  for (const raw of ['not-json', 'null', '[]', '123', '"shared"', '{"lastSpaceId":{},"defaultSpaceId":true}']) {
    local.setItem(spacePreferenceKey(boot), raw)
    assert.deepEqual(readSpacePreferences(boot, local), { lastSpaceId: '', defaultSpaceId: '' })
    assert.equal(local.getItem(spacePreferenceKey(boot)), null)
    assert.equal(local.getItem('other-feature'), 'keep')
  }
})

test('denied and read-only storage never blocks selection or loses a readable valid field', () => {
  const boot = fixture()
  const blocked = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() { throw new Error('blocked') } }
  for (const storage of [blocked, null]) {
    assert.deepEqual(readSpacePreferences(boot, storage), { lastSpaceId: '', defaultSpaceId: '' })
    assert.equal(rememberSuccessfulSpace(boot, shared, storage), false)
    assert.equal(setDefaultSpace(boot, personal, storage), false)
    assert.doesNotThrow(() => forgetSpacePreference(boot, shared, storage))
    assert.doesNotThrow(() => clearRememberedSpace(boot, storage))
    assert.equal(selectAccessibleSpace(boot, { currentId: shared }), shared)
  }
  const readOnly = { ...blocked, getItem: () => JSON.stringify({ lastSpaceId: shared, defaultSpaceId: other }) }
  assert.deepEqual(readSpacePreferences(boot, readOnly), { lastSpaceId: shared, defaultSpaceId: '' })
  assert.equal(rememberSuccessfulSpace(boot, personal, readOnly), false)
})

test('uninitialized bootstrap cannot read or write any account preference', () => {
  const local = memory(), boot = fixture()
  setDefaultSpace(boot, shared, local)
  const original = local.getItem(spacePreferenceKey(boot)), notReady = fixture({ initialized: false })
  assert.deepEqual(readSpacePreferences(notReady, local), { lastSpaceId: '', defaultSpaceId: '' })
  assert.equal(rememberSuccessfulSpace(notReady, shared, local), false)
  assert.equal(setDefaultSpace(notReady, '', local), false)
  assert.equal(local.getItem(spacePreferenceKey(boot)), original)
})
