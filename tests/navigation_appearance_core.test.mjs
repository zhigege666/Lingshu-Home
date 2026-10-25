import test from 'node:test'
import assert from 'node:assert/strict'
import { readNavigationAppearanceSettings } from '../web/src/core/navigation-appearance.ts'

test('omitted view content settings preserve the historical rendering contract', () => {
  const input = { variant: 'cards', linkAppearance: 'app-icons', title: 'Personal links' }
  const before = structuredClone(input)
  assert.deepEqual(readNavigationAppearanceSettings(input), {
    maxColumns: 0, urlDisplay: 'fallback', descriptionLines: 1, showTags: null,
    showEndpoints: true, showGroupTitles: true, showCounts: true, density: 'inherit',
  })
  assert.deepEqual(input, before)
})

test('explicit visibility overrides are independent and survive JSON serialization', () => {
  const input = { maxColumns: 3, urlDisplay: 'hidden', descriptionLines: 0, showTags: true,
    showEndpoints: false, showGroupTitles: false, showCounts: false, density: 'compact' }
  assert.deepEqual(readNavigationAppearanceSettings(JSON.parse(JSON.stringify(input))), input)
  const inherited = { ...input }; delete inherited.showTags
  assert.equal(readNavigationAppearanceSettings(inherited).showTags, null)
  assert.equal(readNavigationAppearanceSettings({ ...inherited, showTags: false }).showTags, false)
})

test('untrusted or incomplete client drafts do not generate unbounded CSS values', () => {
  for (const value of [-1, 9, 1.5, Infinity, NaN, null, '8', {}, true]) {
    assert.equal(readNavigationAppearanceSettings({ maxColumns: value }).maxColumns, 0)
  }
  for (const value of [-1, 4, 1.5, Infinity, NaN, null, '3']) {
    assert.equal(readNavigationAppearanceSettings({ descriptionLines: value }).descriptionLines, 1)
  }
  for (const maxColumns of [0, 1, 8]) assert.equal(readNavigationAppearanceSettings({ maxColumns }).maxColumns, maxColumns)
  for (const descriptionLines of [0, 1, 3]) assert.equal(readNavigationAppearanceSettings({ descriptionLines }).descriptionLines, descriptionLines)
  assert.equal(readNavigationAppearanceSettings({ urlDisplay: 'javascript:alert(1)' }).urlDisplay, 'fallback')
  assert.equal(readNavigationAppearanceSettings({ density: 'calc(1px)' }).density, 'inherit')
})
