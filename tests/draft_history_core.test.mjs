import test from 'node:test'
import assert from 'node:assert/strict'
import { createDraftHistory, recordDraft, undoDraft, redoDraft, DRAFT_HISTORY_LIMIT, inputHistoryGroup } from '../web/src/core/draft-history.ts'

test('undo and redo restore complete immutable page snapshots', () => {
  const original = { name: 'Home', config: { views: [{ id: 'nav', title: 'Links' }], positions: { nav: { x: 0, w: 24 } } } }
  let history = createDraftHistory(original)
  original.config.views[0].title = 'external mutation'
  assert.equal(history.present.config.views[0].title, 'Links')
  const edited = structuredClone(history.present)
  edited.name = 'Dashboard'; edited.config.views.push({ id: 'favorites', title: 'Favorites' }); edited.config.positions.nav = { x: 8, w: 16 }
  history = recordDraft(history, edited)
  edited.config.positions.nav.w = 2
  assert.equal(history.present.config.positions.nav.w, 16)
  const undone = undoDraft(history)
  assert.equal(undone.present.name, 'Home')
  assert.equal(undone.present.config.views.length, 1)
  assert.equal(undone.present.config.positions.nav.w, 24)
  assert.deepEqual(redoDraft(undone).present, history.present)
})

test('no-op keeps history and redo; a real edit after undo starts a new branch', () => {
  const initial = createDraftHistory({ gap: 8 })
  assert.equal(undoDraft(initial), initial)
  assert.equal(redoDraft(initial), initial)
  let history = recordDraft(initial, { gap: 12 })
  history = undoDraft(recordDraft(history, { gap: 16 }))
  assert.equal(recordDraft(history, { gap: 12 }), history)
  assert.equal(history.future.length, 1)
  history = recordDraft(history, { gap: 24 })
  assert.equal(history.future.length, 0)
  assert.deepEqual(undoDraft(history).present, { gap: 12 })
})

test('typing coalesces only the same control within a pause, with no pending timer', () => {
  const title = {}, description = {}
  let history = createDraftHistory('')
  history = recordDraft(history, 'a', title, 100)
  history = recordDraft(history, 'ab', title, 200)
  assert.equal(history.past.length, 1)
  history = recordDraft(history, 'abc', title, 1000)
  assert.equal(history.past.length, 2)
  history = recordDraft(history, 'abcd', description, 1100)
  assert.equal(history.past.length, 3)
  history = recordDraft(history, 'abcde', undefined, 1150)
  assert.equal(history.past.length, 4)
  history = recordDraft(undoDraft(history), 'branch', title, 1200)
  assert.equal(history.future.length, 0)
  assert.equal(undoDraft(history).present, 'abcd')
})

test('history is bounded to 60 steps and saved/reloaded baselines clear both stacks', () => {
  let history = createDraftHistory(0)
  for (let i = 1; i <= 100; i++) history = recordDraft(history, i)
  assert.equal(history.past.length, DRAFT_HISTORY_LIMIT)
  for (let i = 0; i < 100; i++) history = undoDraft(history)
  assert.equal(history.present, 40)
  assert.equal(history.future.length, DRAFT_HISTORY_LIMIT)
  for (let i = 0; i < 100; i++) history = redoDraft(history)
  assert.equal(history.present, 100)
  const saved = createDraftHistory(history.present)
  assert.equal(saved.past.length, 0)
  assert.equal(saved.future.length, 0)
})

test('only text-like inputs supply a typing group', () => {
  let blurred
  const input = { tagName: 'INPUT', type: 'text', addEventListener: (_name, callback) => { blurred = callback } }
  const group = inputHistoryGroup({ activeElement: input })
  assert.equal(inputHistoryGroup({ activeElement: input }), group)
  blurred()
  assert.notEqual(inputHistoryGroup({ activeElement: input }), group, 'returning to the same field after blur starts a new group')
  for (const target of [null, { tagName: 'BUTTON' }, { tagName: 'SELECT' }, { tagName: 'INPUT', type: 'checkbox' }, { tagName: 'INPUT', type: 'file' }]) {
    assert.equal(inputHistoryGroup({ activeElement: target }), undefined)
  }
})
