import test from 'node:test'
import assert from 'node:assert/strict'
import { readRememberedSpace, rememberSpace, selectAccessibleSpace, spaceSelectionKey } from '../web/src/core/space-selection.ts'

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
