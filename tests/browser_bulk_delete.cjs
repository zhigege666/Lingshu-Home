#!/usr/bin/env node
'use strict';
// Disposable fixtures only. Start with --language zh-CN/en on ports 5212/5213.
// BASE_URL=http://127.0.0.1:5212 node tests/browser_bulk_delete.cjs --allow-fixture-write
// Creation and ID-scoped cleanup use the API; every batch deletion uses the UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
const base = new URL(process.env.BASE_URL || '');
assert.ok(process.argv.includes('--allow-fixture-write'), 'Pass --allow-fixture-write for this disposable test');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', '10.233.233.61'].includes(base.hostname)
  && ['5212', '5213'].includes(base.port) && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password,
  'Only dedicated bulk-delete fixture ports 5212/5213 are allowed');
const run = randomUUID().slice(0, 8), prefix = 'Bulk delete ' + run;
const out = path.resolve(process.env.OUTPUT_DIR || path.join(require('node:os').tmpdir(), 'bulk-delete-' + base.port + '-' + run));
fs.mkdirSync(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), origin: base.origin, run, checks: [], screenshots: [], requests: [], expectedFailures: [], pageErrors: [], consoleErrors: [], blocked: [], cleanup: [] };
const links = new Map(), categories = new Map();
let browser, context, page, boot, csrf, space, category, sentinel, originalNavigation, originalPage, armed, approved = false, phase = 'preflight';
const l = (zh, en) => boot.language === 'en' ? en : zh;
const button = (scope, zh, en) => scope.getByRole('button', { name: l(zh, en), exact: true });
const filter = () => page.getByRole('searchbox', { name: l('搜索链接列表', 'Search links'), exact: true });
const toolbar = () => page.locator('.admin-bulk-toolbar');
const relative = suffix => '/spaces/' + space.id + suffix;
const apiURL = suffix => base.origin + '/api/v1' + suffix;
const sort = values => [...values].sort();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const records = nav => ({ categories: [...nav.data.categories].sort((a, b) => a.id.localeCompare(b.id)), links: [...nav.data.links].sort((a, b) => a.id.localeCompare(b.id)) });
// Dataset receivedAt/lastSuccessAt describe this read and intentionally change.
const snapshot = nav => ({ revision: nav.revision, data: records(nav) });

async function api(method, suffix, data, expected = 200) {
  const response = await context.request.fetch(apiURL(suffix), { method, data, headers: { 'X-CSRF-TOKEN': csrf || '' }, maxRedirects: 0, timeout: 15_000 });
  assert.equal(response.status(), expected, `${method} ${suffix}: unexpected HTTP ${response.status()}`);
  return expected === 204 ? null : response.json();
}
const navigation = () => api('GET', relative('/navigation'));
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function step(name, action) {
  phase = name; console.log(JSON.stringify({ event: 'step', name }));
  const start = Date.now(); await action(); report.checks.push({ name, status: 'passed', durationMs: Date.now() - start });
}
async function capture(name) { await settle(); const file = path.join(out, boot.language + '-' + name + '.png'); await page.screenshot({ path: file, fullPage: false }); report.screenshots.push(file); }
async function within(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 15_000); })]); }
  finally { clearTimeout(timer); }
}
async function createLink(suffix, sortOrder = 0) {
  const input = { title: prefix + ' ' + suffix, url: 'https://example.invalid/bulk-delete/' + run + '/' + encodeURIComponent(suffix),
    description: 'Disposable batch-deletion fixture', categoryId: category.id, icon: 'lucide:link', iconMode: 'manual',
    tags: ['fixture'], isFavorite: false, sortOrder, endpoints: [] };
  const record = await api('POST', relative('/links'), input, 201);
  assert.match(record.id, /^[0-9a-f]{32}$/); assert.equal(record.title, input.title); links.set(record.id, record); return record;
}
async function admin(query) {
  const destination = base.origin + '/#/admin?tab=links';
  // Navigating to the identical hash URL can be same-document navigation, leaving
  // the admin's cached navigation snapshot unchanged after API fixture creation.
  if (page.url() === destination) await page.reload({ waitUntil: 'domcontentloaded' });
  else await page.goto(destination, { waitUntil: 'domcontentloaded' });
  await filter().waitFor(); await filter().fill(query); await settle();
}
async function selectionCleared() {
  await settle(); assert.equal(await page.locator('.admin-links-table tr[data-selected="true"]').count(), 0);
  assert.equal(await button(toolbar(), '批量删除', 'Delete selected').count(), 0);
  const count = page.locator('.admin-selection-count');
  if (await count.count()) assert.equal((await count.innerText()).trim(), l('已选 0 个', '0 selected'));
}
async function selectAll(count) {
  await button(toolbar(), `选择全部筛选结果（${count}）`, `Select all results (${count})`).click();
  await settle(); assert.equal((await page.locator('.admin-selection-count').innerText()).trim(), l(`已选 ${count} 个`, `${count} selected`));
}
async function openDelete(count) {
  await button(toolbar(), '批量删除', 'Delete selected').click();
  const dialog = page.getByRole('dialog', { name: l('批量删除链接', 'Delete selected links'), exact: true });
  await dialog.waitFor(); await button(dialog, `删除 ${count} 个链接`, `Delete ${count} links`).waitFor();
  assert.ok(await dialog.getByRole('note').isVisible());
  assert.equal(await dialog.getAttribute('data-confirm-kind'), 'bulk-links');
  assert.ok((await dialog.getAttribute('class')).includes('lh-confirm-popover'));
  assert.equal(await page.locator('[data-slot="dialog-overlay"]:visible').count(), 0, 'Confirmation must not cover the page with a modal overlay');
  return dialog;
}
async function assertFocus(control) {
  await control.waitFor(); await page.waitForFunction(element => element === document.activeElement, await control.elementHandle());
}
async function assertAnchored(dialog, action) {
  const popover = await dialog.boundingBox(), anchor = await action.boundingBox();
  assert.ok(popover && anchor);
  const gap = Math.min(Math.abs(popover.y - anchor.y - anchor.height), Math.abs(anchor.y - popover.y - popover.height));
  assert.ok(gap <= 24 && popover.x < anchor.x + anchor.width && popover.x + popover.width > anchor.x, 'The confirmation stays next to its action button');
}
async function protectExisting(nav = undefined) {
  nav ||= await navigation();
  const untouched = { ...nav, data: { ...nav.data, links: nav.data.links.filter(link => !links.has(link.id)), categories: nav.data.categories.filter(item => !categories.has(item.id)) } };
  assert.equal(digest(records(untouched)), digest(records(originalNavigation)), 'Every original navigation field must remain unchanged');
  assert.deepEqual(nav.data.categories.find(item => item.id === category.id), category, 'The selected links’ category is preserved');
  assert.deepEqual(nav.data.links.find(item => item.id === sentinel.id), sentinel, 'The unselected sentinel is preserved');
}
async function assertDeleted(ids) {
  const nav = await navigation(); for (const id of ids) assert.ok(!nav.data.links.some(link => link.id === id), 'Selected link still exists: ' + id);
  await protectExisting(nav); return nav;
}
async function deleteThroughUI(dialog, ids, expectedRevision, { status = 200, checkBusy = false, refreshFails = false } = {}) {
  assert.ok(!armed, 'Only one deletion can be armed');
  let received, release;
  const reached = new Promise(resolve => { received = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const requestState = { ids: sort(ids), revision: expectedRevision, attempts: 0, received, gate: checkBusy ? gate : Promise.resolve() };
  armed = requestState;
  const responsePromise = page.waitForResponse(response => response.url() === apiURL(relative('/links/batch')) && response.request().method() === 'POST');
  responsePromise.catch(() => {});
  try {
    await button(dialog, `删除 ${ids.length} 个链接`, `Delete ${ids.length} links`).click(); await within(reached, 'the UI batch-delete request');
    if (checkBusy) {
      const busy = button(dialog, '正在删除…', 'Deleting…'); await busy.waitFor(); assert.ok(await busy.isDisabled());
      assert.ok(await button(dialog, '取消', 'Cancel').isDisabled());
      await page.keyboard.press('Escape');
      const outside = await page.locator('.admin-page-heading h1').boundingBox();
      await page.mouse.click(outside.x + outside.width / 2, outside.y + outside.height / 2); await settle();
      assert.ok(await dialog.isVisible(), 'A pending deletion cannot be dismissed with Escape or an outside click');
      assert.equal(await dialog.getAttribute('aria-busy'), 'true');
      const before = await navigation(); for (const id of ids) assert.ok(before.data.links.some(link => link.id === id), 'The held request has not committed');
      // Native repeat submit events exercise the in-flight guard even if a caller
      // bypasses the disabled button. They must not send a second request.
      await dialog.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); }); await settle();
      assert.equal(requestState.attempts, 1); release();
    }
    const response = await responsePromise; assert.equal(response.status(), status);
    const result = await response.json();
    if (status === 200) {
      assert.equal(result.selectedCount, ids.length); assert.equal(result.updatedCount, 0); assert.equal(result.deletedCount, ids.length);
      assert.equal(typeof result.revision, 'string'); assert.notEqual(result.revision, expectedRevision);
      await dialog.waitFor({ state: 'hidden' });
      await assertFocus(refreshFails ? page.locator('#main-content') : button(page.locator('.admin-content-toolbar'), '刷新列表', 'Refresh list'));
    } else report.expectedFailures.push({ phase, status });
    assert.equal(requestState.attempts, 1); return result;
  } finally { release(); armed = null; }
}

async function main() {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'], ignoreDefaultArgs: ['--hide-scrollbars'] });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 }); context.setDefaultTimeout(15_000);
  boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken;
  assert.ok(['zh-CN', 'en'].includes(boot.language)); assert.equal(boot.languageSelectionRequired, false);
  const fixtureName = 'Bulk delete fixture ' + boot.language;
  if (!boot.initialized) { await api('POST', '/setup', { siteName: fixtureName, mode: 'open_edit', seedDemo: false }, 201); boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken; }
  assert.equal(boot.siteName, fixtureName, 'Refusing to write to an unrelated instance'); assert.equal(boot.mode, 'open_edit'); assert.equal(boot.user, null);
  space = boot.spaces.find(item => item.kind === 'shared'); assert.ok(space?.canEdit);
  originalNavigation = await navigation(); originalPage = await api('GET', relative('/page')); approved = true; report.language = boot.language;
  category = await api('POST', relative('/categories'), { name: prefix + ' category', icon: 'lucide:folder', parentId: null, sortOrder: 0 }, 201);
  assert.match(category.id, /^[0-9a-f]{32}$/); categories.set(category.id, category);
  sentinel = await createLink('sentinel', 9999);
  // Leave 26 results after deleting one page, so "all filtered" must cross a page boundary.
  const batch = []; for (let index = 1; index <= 51; index++) batch.push(await createLink('batch ' + String(index).padStart(2, '0'), index));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base.origin && !['data:', 'blob:'].includes(url.protocol)) {
      report.blocked.push({ method: route.request().method(), origin: url.origin, pathname: url.pathname, reason: 'outside fixture origin' });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  // Reject unexpected IDs before a UI bug could delete an existing fixture row.
  await context.route(apiURL(relative('/links/batch')), async route => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    const body = request.postDataJSON(), current = armed;
    const allowed = approved && current && body.operation === 'delete' && Array.isArray(body.linkIds)
      && digest(sort(Object.keys(body))) === digest(['expectedRevision', 'linkIds', 'operation'])
      && digest(sort(body.linkIds)) === digest(current.ids) && body.expectedRevision === current.revision
      && body.linkIds.every(id => links.has(id));
    if (current) current.attempts++;
    if (!allowed || current.attempts !== 1) {
      report.blocked.push({ phase, reason: 'unexpected or repeated batch-delete mutation' });
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'fixture_guard', message: 'Unexpected batch deletion blocked by the acceptance fixture.' }) });
    }
    report.requests.push({ phase, operation: body.operation, linkIds: body.linkIds, expectedRevision: body.expectedRevision });
    current.received(); await current.gate; return route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push({ phase, message: error.message }));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if ((phase === 'stale revisions reject the entire selection until refresh and reselection' && /409/.test(text))
      || (phase === 'successful deletion stays committed when the following list refresh fails' && /503/.test(text))) return;
    report.consoleErrors.push({ phase, message: text.slice(0, 300) });
  });
  await admin(prefix + ' batch');
  let pageIds, dialog;
  await step('selecting the current page and canceling deletes nothing', async () => {
    assert.equal(await page.locator('.admin-links-table tbody tr').count(), 25);
    const titles = await page.locator('.admin-links-table tbody .admin-link-title strong').allTextContents();
    pageIds = titles.map(title => batch.find(record => record.title === title)?.id); assert.ok(pageIds.every(Boolean));
    await page.getByRole('checkbox', { name: l('选择本页链接', 'Select links on this page'), exact: true }).click();
    assert.equal((await page.locator('.admin-selection-count').innerText()).trim(), l('已选 25 个', '25 selected'));
    const before = await navigation(); dialog = await openDelete(25); await settle();
    assert.ok(await button(dialog, '取消', 'Cancel').evaluate(element => element === document.activeElement), 'Cancellation receives initial focus');
    await button(dialog, '取消', 'Cancel').click(); await dialog.waitFor({ state: 'hidden' });
    await assertFocus(button(toolbar(), '批量删除', 'Delete selected'));
    assert.equal(digest(snapshot(await navigation())), digest(snapshot(before))); assert.equal(report.requests.length, 0);
  });
  await step('Escape and outside clicks dismiss the anchored confirmation without a mutation', async () => {
    const before = await navigation(); dialog = await openDelete(25);
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    await assertFocus(button(toolbar(), '批量删除', 'Delete selected'));
    dialog = await openDelete(25); await page.locator('.admin-page-heading h1').click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(digest(snapshot(await navigation())), digest(snapshot(before))); assert.equal(report.requests.length, 0);
  });
  await step('danger actions and the confirmation fit all four desktop viewports', async () => {
    for (const [width, height] of [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080]]) {
      await page.setViewportSize({ width, height });
      const action = button(toolbar(), '批量删除', 'Delete selected'); await action.click({ trial: true });
      const actionBox = await action.boundingBox(); assert.ok(actionBox && actionBox.x >= 0 && actionBox.x + actionBox.width <= width + 1 && actionBox.y + actionBox.height <= height + 1);
      dialog = await openDelete(25); await settle();
      await assertAnchored(dialog, action);
      const box = await dialog.boundingBox(); assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const confirm = button(dialog, '删除 25 个链接', 'Delete 25 links'); await confirm.click({ trial: true });
      const confirmBox = await confirm.boundingBox(); assert.ok(confirmBox && confirmBox.y >= 0 && confirmBox.y + confirmBox.height <= height + 1);
      await capture(`confirm-${width}x${height}`); report.checks.push({ name: `viewport ${width}x${height}`, status: 'passed' });
      await button(dialog, '取消', 'Cancel').click(); await dialog.waitFor({ state: 'hidden' });
    }
  });
  await step('one request deletes only the selected page and rejects repeat submits while busy', async () => {
    const before = await navigation(); dialog = await openDelete(25);
    await deleteThroughUI(dialog, pageIds, before.revision, { checkBusy: true });
    const after = await assertDeleted(pageIds); assert.equal(after.data.links.filter(link => batch.some(item => item.id === link.id)).length, 26);
    await selectionCleared(); await page.reload({ waitUntil: 'domcontentloaded' }); await filter().waitFor(); await assertDeleted(pageIds);
    await filter().fill(prefix + ' batch');
  });
  await step('all filtered results delete exactly the remaining selection and retain the sentinel category', async () => {
    const remaining = batch.filter(item => !pageIds.includes(item.id)).map(item => item.id);
    assert.equal(await page.locator('.admin-links-table tbody tr').count(), 25);
    await selectAll(26); dialog = await openDelete(26); const before = await navigation();
    await deleteThroughUI(dialog, remaining, before.revision); await assertDeleted(batch.map(item => item.id)); await selectionCleared();
  });
  await step('refresh clears the selection without changing links', async () => {
    await filter().fill(sentinel.title); await selectAll(1); const before = await navigation();
    await button(page.locator('.admin-content-toolbar'), '刷新列表', 'Refresh list').click(); await selectionCleared();
    assert.equal(digest(snapshot(await navigation())), digest(snapshot(before))); await protectExisting();
  });
  await step('stale revisions reject the entire selection until refresh and reselection', async () => {
    const conflict = []; for (let index = 1; index <= 3; index++) conflict.push(await createLink('conflict ' + index, index));
    await admin(prefix + ' conflict'); await selectAll(3); dialog = await openDelete(3); const staleRevision = (await navigation()).revision;
    await createLink('concurrent revision change', 100); const before = await navigation();
    await deleteThroughUI(dialog, conflict.map(item => item.id), staleRevision, { status: 409 });
    const alert = dialog.getByRole('alert'); await alert.waitFor();
    assert.equal((await alert.innerText()).trim(), l('列表已发生变化，本次没有删除任何链接。请刷新列表并重新选择。', 'The list changed. No links were deleted by this request. Refresh the list and select again.'));
    assert.equal(digest(snapshot(await navigation())), digest(snapshot(before)), 'A conflict cannot partially delete the batch');
    assert.equal(await button(dialog, '删除 3 个链接', 'Delete 3 links').count(), 0);
    await capture('stale-revision'); await button(dialog, '刷新并重新选择', 'Refresh and select again').click();
    await dialog.waitFor({ state: 'hidden' }); await selectionCleared(); await selectAll(3); dialog = await openDelete(3);
    await deleteThroughUI(dialog, conflict.map(item => item.id), (await navigation()).revision);
    await assertDeleted(conflict.map(item => item.id)); await selectionCleared();
  });
  await step('successful deletion stays committed when the following list refresh fails', async () => {
    const selected = [await createLink('refresh failure 1'), await createLink('refresh failure 2')];
    await admin(prefix + ' refresh failure'); await selectAll(2); dialog = await openDelete(2);
    let failures = 0;
    const rejectRefresh = route => { failures++; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'fixture_unavailable', message: 'Fixture navigation refresh unavailable.' }) }); };
    const target = apiURL(relative('/navigation')); await context.route(target, rejectRefresh);
    const requestsBefore = report.requests.length;
    try {
      await deleteThroughUI(dialog, selected.map(item => item.id), (await navigation()).revision, { refreshFails: true });
      await page.getByText(l('删除已经完成，但页面刷新失败。请点击“重新读取”或“刷新列表”查看结果。', 'Deletion completed, but refreshing failed. Choose Reload or Refresh list to see the result.'), { exact: true }).waitFor();
      assert.ok(failures > 0); assert.equal(report.requests.length, requestsBefore + 1); await selectionCleared();
      await assertDeleted(selected.map(item => item.id)); await capture('committed-refresh-failure'); report.expectedFailures.push({ phase, status: 503, count: failures });
    } finally { await context.unroute(target, rejectRefresh); }
    await button(page.locator('.admin-empty'), '重新读取', 'Reload').click(); await filter().waitFor(); await assertDeleted(selected.map(item => item.id));
    await selectionCleared(); assert.equal(report.requests.length, requestsBefore + 1, 'Reloading the committed result cannot repeat deletion');
  });
  assert.deepEqual(report.blocked, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
}

async function cleanup() {
  if (!approved || !context || !space) return;
  for (const [kind, created] of [['links', links], ['categories', categories]]) for (const [id, own] of [...created].reverse()) {
    const actual = (await navigation()).data[kind].find(record => record.id === id); if (!actual) continue;
    const key = kind === 'links' ? 'title' : 'name'; assert.equal(actual[key], own[key]); assert.ok(actual[key].startsWith(prefix));
    await api('DELETE', relative('/' + kind + '/' + id), undefined, 204); report.cleanup.push({ kind, id, status: 'deleted' });
  }
  assert.equal(digest(records(await navigation())), digest(records(originalNavigation)), 'Existing navigation is preserved after cleanup');
  assert.equal(digest(await api('GET', relative('/page'))), digest(originalPage), 'The page and its revision are unchanged');
}
(async () => {
  try { await main(); report.status = 'passed'; }
  catch (error) { report.status = 'failed'; report.failure = { phase, message: error.message, stack: error.stack }; process.exitCode = 1; await capture('failure').catch(() => {}); }
  finally {
    if (armed) armed = null;
    try { await cleanup(); } catch (error) { report.status = 'failed'; report.cleanupError = error.message; process.exitCode = 1; }
    await browser?.close(); report.finishedAt = new Date().toISOString(); const file = path.join(out, 'report.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, language: report.language, checks: report.checks.length, deleteRequests: report.requests.length, report: file, failure: report.failure?.message, cleanupError: report.cleanupError }));
  }
})();
