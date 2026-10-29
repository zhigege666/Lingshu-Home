import assert from 'node:assert/strict';
import test from 'node:test';
import { isLinkActivation, clickDateRange } from '../web/src/core/link-clicks.ts';

test('count primary, keyboard and native middle activation exactly once', () => {
  assert(isLinkActivation({ type: 'click', button: 0, defaultPrevented: false }));
  assert(isLinkActivation({ type: 'auxclick', button: 1, defaultPrevented: false }));
  for (const event of [
    { type: 'pointerdown', button: 0 }, { type: 'keydown', button: 0 },
    { type: 'click', button: 1 }, { type: 'auxclick', button: 0 }, { type: 'auxclick', button: 2 },
    { type: 'contextmenu', button: 2 }, { type: 'mouseenter', button: 0 }
  ]) assert.equal(isLinkActivation({ ...event, defaultPrevented: false }), false, JSON.stringify(event));
  assert.equal(isLinkActivation({ type: 'click', button: 0, defaultPrevented: true }), false);
});
test('UTC inclusive date range handles leap day and local timezone boundaries', () => {
  assert.deepEqual(clickDateRange(7, new Date('2024-03-01T00:30:00Z')), { from: '2024-02-24', to: '2024-03-01' });
  assert.deepEqual(clickDateRange(30, new Date('2026-01-01T00:05:00+08:00')), { from: '2025-12-02', to: '2025-12-31' });
});
