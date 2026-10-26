import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activityAddDays, activityCalendarDays, activityDateKey, activityDocumentHref,
  activityHeatLevel, activityMonthStart, activityMonthWindow, activityRecordedDate,
  activityTimezone, activityWindow, documentActivityQueryKey, readDocumentActivitySettings,
  validActivityDate,
} from '../web/src/core/document-activity.ts'
const sourceA = 'a'.repeat(32), sourceB = 'b'.repeat(32)

test('each presentation keeps independent normalized source settings without mutating the page draft', () => {
  const raw = { presentation: 'month', months: 12, sourceIds: [sourceB, sourceA, sourceB], recentLimit: 0, detailLayout: 'below', timezone: 'Asia/Shanghai' }
  const copy = structuredClone(raw), first = readDocumentActivitySettings(raw), second = readDocumentActivitySettings(raw)
  assert.deepEqual(raw, copy)
  assert.deepEqual(first.sourceIds, [sourceA, sourceB])
  first.sourceIds.push('c')
  assert.deepEqual(second.sourceIds, [sourceA, sourceB])
  assert.equal(first.presentation, 'month')
  assert.equal(first.months, 12)
  assert.equal(first.recentLimit, 0)
  assert.deepEqual(readDocumentActivitySettings({}), {
    presentation: 'heatmap', months: 6, perspective: 'mine', sourceIds: [],
    showSummary: true, recentLimit: 3, detailLayout: 'auto', timezone: 'local',
  })
})

test('invalid settings cannot become CSS values, infinite ranges or unusable timezone queries', () => {
  const value = readDocumentActivitySettings({ presentation: 'url(evil)', months: Infinity, perspective: 'other-user', sourceIds: [null, '', 1, 'x'.repeat(129)], recentLimit: 100000, detailLayout: {}, timezone: 'Wrong/Zone' })
  assert.equal(value.presentation, 'heatmap')
  assert.equal(value.months, 6)
  assert.equal(value.perspective, 'mine')
  assert.deepEqual(value.sourceIds, [])
  assert.equal(value.recentLimit, 3)
  assert.equal(value.timezone, 'local')
  assert.equal(activityTimezone('local', 'Asia/Shanghai'), 'Asia/Shanghai')
  assert.equal(activityTimezone('UTC', 'Asia/Shanghai'), 'UTC')
  assert.equal(activityTimezone('local', 'Wrong/Zone'), 'UTC')
  assert.equal(readDocumentActivitySettings({ timezone: '+08:00' }).timezone, 'local')
  assert.equal(readDocumentActivitySettings({ timezone: 'Local' }).timezone, 'local')
  assert.equal(readDocumentActivitySettings({ timezone: 'utc' }).timezone, 'UTC')
})

test('rolling month ranges are contiguous across December, leap February and shorter months', () => {
  for (const today of ['2026-10-26', '2024-02-29', '2026-01-31', '2026-03-31']) {
    for (const months of [3, 6, 12]) {
      const current = activityWindow(today, months), previous = activityWindow(today, months, -1)
      assert.equal(current.to, today)
      assert.equal(activityAddDays(previous.to, 1), current.from)
      const days = (Date.parse(current.to) - Date.parse(current.from)) / 86400000 + 1
      assert.ok(days <= 366 && days > 0)
    }
  }
  assert.deepEqual(activityWindow('2026-10-26', 6), { from: '2026-05-01', to: '2026-10-26' })
  assert.equal(activityMonthStart('2026-01-31', -1), '2025-12-01')
  assert.deepEqual(activityMonthWindow('2024-02-01', '2026-10-26'), { from: '2024-02-01', to: '2024-02-29' })
})

test('October 2026 calendar starts Monday September 28 and ends Sunday November 1', () => {
  const grid = activityCalendarDays('2026-10-01', '2026-10-31')
  assert.equal(grid.length, 35)
  assert.equal(grid[0], '2026-09-28')
  assert.equal(grid[3], '2026-10-01')
  assert.equal(grid[28], '2026-10-26')
  assert.equal(grid.at(-1), '2026-11-01')
  assert.equal(validActivityDate('2026-02-29'), false)
  assert.equal(validActivityDate('2024-02-29'), true)
  assert.equal(validActivityDate('2026-13-01'), false)
})

test('event timestamps and recording start use the viewer timezone, while calendar arithmetic survives DST', () => {
  const stamp = new Date('2026-10-25T16:30:00.000Z')
  assert.equal(activityDateKey(stamp, 'Asia/Shanghai'), '2026-10-26')
  assert.equal(activityDateKey(stamp, 'America/Los_Angeles'), '2026-10-25')
  assert.equal(activityRecordedDate('2026-10-25T16:30:00.000000000Z', 'Asia/Shanghai'), '2026-10-26')
  assert.equal(activityRecordedDate('', 'UTC'), null)
  assert.equal(activityRecordedDate('not-a-date', 'UTC'), null)
  assert.equal(activityAddDays('2026-03-08', 1), '2026-03-09')
  assert.equal(activityAddDays('2026-11-01', -1), '2026-10-31')
})

test('heat levels use fixed thresholds rather than the range maximum', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 6, 7, 800].map(activityHeatLevel), [0, 1, 2, 2, 3, 3, 4, 4])
})

test('canonical queries share only identical data requests; view filters and pagination remain distinct', () => {
  const query = { from: '2026-05-01', to: '2026-10-26', timezone: 'Asia/Shanghai', perspective: 'mine', sourceIds: ['b', 'a'], limit: 20 }
  const key = documentActivityQueryKey(query)
  assert.equal(key, documentActivityQueryKey({ ...query, sourceIds: ['a', 'b', 'a'] }))
  for (const override of [{ perspective: 'library' }, { timezone: 'UTC' }, { sourceIds: ['a'] }, { date: '2026-10-25' }, { offset: 20 }]) {
    assert.notEqual(key, documentActivityQueryKey({ ...query, ...override }))
  }
  const parsed = new URLSearchParams(key)
  assert.equal(parsed.get('sourceIds'), 'a,b')
  assert.equal(parsed.get('timezone'), 'Asia/Shanghai')
  assert.deepEqual(query.sourceIds, ['b', 'a'])
})

test('document deep links encode both document and space identities', () => {
  const href = activityDocumentHref('space-1', 'doc&other=1')
  const parsed = new URLSearchParams(href.split('?')[1])
  assert.equal(parsed.get('space'), 'space-1')
  assert.equal(parsed.get('document'), 'doc&other=1')
  assert.equal(parsed.has('other'), false)
})
