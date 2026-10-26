import test from 'node:test'
import assert from 'node:assert/strict'
import { accessibleLibrarySpace, readLibraryTarget } from '../web/src/core/library-navigation.ts'

const shared = 'a'.repeat(32), personal = 'b'.repeat(32)

test('document deep links preserve exact document and space parameters independently', () => {
  assert.deepEqual(readLibraryTarget(`#/library?document=notes%2Fone&space=${shared}`), { documentId: 'notes/one', spaceId: shared })
  assert.deepEqual(readLibraryTarget('/library'), { documentId: '', spaceId: '' })
  assert.equal(readLibraryTarget('/library-other?document=one'), null)
  assert.equal(readLibraryTarget('/admin?space=one'), null)
})

test('deep links can select only spaces in the authenticated accessible inventory', () => {
  const spaces = [{ id: shared }]
  assert.equal(accessibleLibrarySpace(readLibraryTarget(`/library?space=${shared}&document=one`), spaces), shared)
  for (const target of [personal, 'https://outside.invalid', '../admin', '']) {
    assert.equal(accessibleLibrarySpace(readLibraryTarget(`/library?space=${encodeURIComponent(target)}`), spaces), '')
  }
  assert.equal(accessibleLibrarySpace(readLibraryTarget(`/library?space=${shared}`), []), '')
  assert.equal(accessibleLibrarySpace(null, spaces), '')
})
