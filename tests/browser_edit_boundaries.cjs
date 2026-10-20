#!/usr/bin/env node
'use strict';
/**
 * Remaining editor-boundary checks for the isolated English clone only.
 * BASE_URL=http://10.233.233.61:5183 node tests/browser_edit_boundaries.cjs --phase validation
 * BASE_URL=http://10.233.233.61:5183 node tests/browser_edit_boundaries.cjs --phase grid --allow-demo-write
 * grid: actual mouse resize/drag, one UI Save, latest-own-revision API cleanup.
 * validation: unsaved chrome drafts in unmounted/disabled areas; HomeEditor Restore.
 * No setup, sign-in, business-record writes, or bookmark destination visits.
 * Optional: LINGSHU_PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE, REPORT_PATH, SCREENSHOT_DIR.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const STEP = 12_000, args = process.argv.slice(2), runId = randomUUID().slice(0, 12);
const phaseIndex = args.indexOf('--phase');
const phase = args.find(value => value.startsWith('--phase='))?.slice(8) || (phaseIndex >= 0 ? args[phaseIndex + 1] : 'validation');
let browser, context, page, base, bootstrap, space, originalPage, originalNavigation, lastSavedRevision, approved = false, putBudget = 0;
let assertions = 0, currentStep = 'preflight';
const attempts = [], commits = [], blocked = [], routeErrors = [], pageErrors = [], consoleErrors = [], dialogs = [], cleanups = [], screenshots = [];
const details = {};
const reportPath = path.resolve(process.env.REPORT_PATH || path.join(os.tmpdir(), `lingshu-edit-boundaries-${runId}.json`));
const check = (value, message) => { assert.ok(value, message); assertions++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const step = value => { currentStep = value; emit({ event: 'step', phase, label: value, assertions }); };
const endpoint = relative => base.origin + '/api/v1' + relative;
const pagePath = () => '/api/v1/spaces/' + encodeURIComponent(space.id) + '/page';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const records = dataset => ({ categories: [...dataset.data.categories].sort((a, b) => a.id.localeCompare(b.id)), links: [...dataset.data.links].sort((a, b) => a.id.localeCompare(b.id)) });
function differences(before, after, at = '') {
  if (isDeepStrictEqual(before, after)) return [];
  if (Array.isArray(before) || Array.isArray(after) || !before || !after || typeof before !== 'object' || typeof after !== 'object') return [at || '/'];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => differences(before[key], after[key], at + '/' + key));
}
async function read(relative) {
  const response = await context.request.get(endpoint(relative), { timeout: STEP, maxRedirects: 0 });
  check(response.ok(), `GET ${relative}: HTTP ${response.status()}`); return response.json();
}
const readPage = () => read('/spaces/' + encodeURIComponent(space.id) + '/page');
const readNavigation = () => read('/spaces/' + encodeURIComponent(space.id) + '/navigation');
async function capture(name) {
  if (!process.env.SCREENSHOT_DIR || !page) return;
  const directory = path.resolve(process.env.SCREENSHOT_DIR); fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `edit-boundaries-${phase}-${name}-${runId}.png`);
  await page.screenshot({ path: target, fullPage: false, animations: 'allow', timeout: STEP }); screenshots.push(target);
}
async function choose(control, label) {
  await control.click(); await page.getByRole('listbox').waitFor({ state: 'visible', timeout: STEP });
  await page.getByRole('option', { name: label, exact: true }).click();
  await page.getByRole('listbox').waitFor({ state: 'hidden', timeout: STEP });
  check((await control.textContent()).includes(label), `Visible selection retains ${label}`);
}
async function settle() {
  const token = randomUUID();
  await page.waitForFunction(token => {
    const home = document.querySelector('.lh-home');
    if (!home || document.fonts.status !== 'loaded' || home.querySelector('.react-draggable-dragging,.resizing,.react-grid-placeholder')) return false;
    const geometry = [home, ...home.querySelectorAll('.react-grid-item,.lh-side-region')].map(node => {
      const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(value => Math.round(value * 10));
    });
    const signature = JSON.stringify([document.documentElement.scrollWidth, document.documentElement.scrollHeight, geometry]);
    const previous = window.__editBoundaryGeometry;
    if (!previous || previous.token !== token || previous.signature !== signature) { window.__editBoundaryGeometry = { token, signature, frames: 0, changedAt: performance.now() }; return false; }
    previous.frames++;
    return previous.frames >= 8 && performance.now() - previous.changedAt >= 180;
  }, token, { timeout: STEP, polling: 'raf' });
}
async function home() {
  await page.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded', timeout: STEP });
  await page.locator('.lh-home-heading h1').waitFor({ state: 'visible', timeout: STEP });
  await page.waitForFunction(() => document.querySelectorAll('.lh-bookmark').length > 0, null, { timeout: STEP }); await settle();
}
async function editor() {
  await page.getByRole('button', { name: 'Edit page', exact: true }).click();
  const root = page.locator('.lh-page-editor[aria-label="Edit homepage"]');
  await root.locator('.lh-editor-controls').waitFor({ state: 'visible', timeout: STEP }); await settle(); return root;
}
async function mouseGesture(handle, dx, dy = 0) {
  await handle.scrollIntoViewIfNeeded({ timeout: STEP });
  const box = await handle.boundingBox(); check(!!box && box.width > 0 && box.height > 0, 'The real mouse handle has a visible hit target');
  const x = box.x + Math.min(box.width / 2, 70), y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  try { await page.mouse.move(x + dx, y + dy, { steps: 12 }); } finally { await page.mouse.up(); }
  await settle();
}
async function saveGrid(root) {
  const start = attempts.length; putBudget = 1;
  try {
    const [response] = await Promise.all([
      page.waitForResponse(value => value.request().method() === 'PUT' && new URL(value.url()).pathname === pagePath(), { timeout: STEP }),
      root.getByRole('button', { name: 'Save layout', exact: true }).click()
    ]);
    check(response.ok(), `The actual homepage Save succeeds: HTTP ${response.status()}`);
    equal(attempts.length, start + 1, 'One Save action sends exactly one page PUT'); equal(commits.length, 1, 'Exactly one real page save is confirmed');
    const saved = await response.json(); equal(await readPage(), saved, 'Saved response equals the complete persisted page');
    await root.waitFor({ state: 'hidden', timeout: STEP }); return saved;
  } finally { putBudget = 0; }
}
async function gridPhase() {
  const favorites = originalPage.config.views.filter(view => view.panel.id === 'builtin/favorites' && originalPage.config.bindings[view.inputs.collection]?.datasetId === 'local-navigation');
  equal(favorites.length, 1, 'The English clone has one local favorites panel');
  const view = favorites[0], original = originalPage.config.layout.placements[view.id].base;
  check(original.kind === 'grid' && !original.locked && original.w >= 8, 'The favorites grid is unlocked and wide enough for a meaningful resize');
  step('Mouse resize through the new homepage editor'); await home(); const root = await editor();
  const frame = page.locator(`.lh-grid-frame[data-panel-id=${JSON.stringify(view.id)}]`);
  const item = page.locator('.lh-home-grid .react-grid-item').filter({ has: frame });
  equal(await frame.count(), 1, 'The favorites frame is unique'); equal(await item.count(), 1, 'The frame belongs to one actual React grid item');
  const gridBox = await page.locator('.lh-home-grid').boundingBox(); check(!!gridBox, 'The grid container is measurable');
  const column = (gridBox.width + originalPage.config.layout.gap) / 24, desiredWidth = Math.max(4, Math.floor(original.w / 2));
  const resize = item.locator('.react-resizable-handle-se'); equal(await resize.count(), 1, 'The real southeast resize handle is available');
  await mouseGesture(resize, (desiredWidth - original.w) * column);
  const widthMatch = (await frame.locator('.lh-grid-handle small').textContent()).match(/^(\d+)\s+columns/);
  check(!!widthMatch, 'The visible editor reports grid columns in English'); equal(Number(widthMatch[1]), desiredWidth, 'The mouse resize snaps to the intended column width');
  check(await frame.evaluate(node => node.classList.contains('is-fixed')), 'An explicit resize selects fixed height behavior');
  step('Mouse drag the resized panel and save once');
  const resized = await item.boundingBox(), currentGrid = await page.locator('.lh-home-grid').boundingBox();
  check(!!resized && !!currentGrid, 'The resized item and its grid remain measurable');
  const currentX = Math.round((resized.x - currentGrid.x) / column), desiredX = 24 - desiredWidth;
  check(desiredX > currentX, 'The resized item has room to move right');
  await mouseGesture(frame.locator('.lh-grid-handle:not(.is-locked)'), (desiredX - currentX) * column);
  const moved = await item.boundingBox(); check(!!moved && moved.x > resized.x + column / 2, 'The actual mouse drag moves the panel right');
  equal(attempts, [], 'Mouse gestures remain unsaved and send no requests'); equal(await readPage(), originalPage, 'Mouse gestures preserve the original persisted page');
  const saved = await saveGrid(root), placement = saved.config.layout.placements[view.id].base;
  equal(placement.kind, 'grid', 'The saved panel remains a grid panel'); equal(placement.w, desiredWidth, 'The saved width matches the resize'); equal(placement.x, desiredX, 'The saved position matches the drag');
  equal(placement.heightMode, 'fixed', 'The explicit resize height mode persists'); equal(placement.locked, false, 'Mouse editing retains the lock state');
  check(placement.h >= 3 && placement.x + placement.w <= 24, 'The saved footprint stays within the supported grid'); check(saved.revision !== originalPage.revision, 'Saving advances revision');
  const withoutPlacements = value => { const copy = structuredClone(value); delete copy.layout.placements; return copy; };
  equal(withoutPlacements(saved.config), withoutPlacements(originalPage.config), 'Mouse editing changes only placements, including preserving an absent chrome field');
  equal(saved.name, originalPage.name, 'Mouse editing retains the page name');
  for (const [id, old] of Object.entries(originalPage.config.layout.placements)) {
    if (old.base.kind !== 'grid' || old.base.locked) equal(saved.config.layout.placements[id], old, `Region or locked placement ${id} remains exact`);
    else equal(saved.config.layout.placements[id].overrides, old.overrides, `Narrow overrides for ${id} remain exact`);
  }
  await home(); equal(await readPage(), saved, 'Reload retains the saved mouse layout');
  const geometry = await page.evaluate(() => {
    const panels = [...document.querySelectorAll('.react-grid-item:not(.react-grid-placeholder)')].map(node => { const r = node.getBoundingClientRect(); return { id: node.querySelector('[data-panel-id]')?.getAttribute('data-panel-id'), x: r.x, y: r.y, width: r.width, height: r.height }; });
    const overlaps = [];
    for (let i = 0; i < panels.length; i++) for (let j = i + 1; j < panels.length; j++) { const a = panels[i], b = panels[j]; if (Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1) overlaps.push([a.id, b.id]); }
    return { panels, overlaps, clientWidth: document.documentElement.clientWidth, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) };
  });
  equal(geometry.overlaps, [], 'Saved grid panels do not overlap'); check(geometry.scrollWidth <= geometry.clientWidth + 1, 'Saved layout introduces no horizontal document overflow');
  equal(attempts.length, 1, 'The grid phase performs exactly one UI page PUT');
  details.grid = { viewId: view.id, original, saved: placement, geometry }; await capture('mouse-saved');
}
async function expectChromeIssue(chrome, value, enabled, label) {
  const url = chrome.getByRole('textbox', { name: 'Link URL', exact: true }); await url.waitFor({ state: 'visible', timeout: STEP });
  const handle = await url.elementHandle();
  await page.waitForFunction(node => node === document.activeElement && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0, handle, { timeout: STEP });
  equal(await url.inputValue(), value, `${label}: the invalid draft value is preserved`);
  equal(await chrome.getByRole('tab', { name: 'Header', exact: true }).getAttribute('aria-selected'), 'true', `${label}: validation returns to Header`);
  equal(await chrome.locator('.admin-chrome-alignments > button').first().getAttribute('aria-pressed'), 'true', `${label}: validation returns to the Left slot`);
  equal(await chrome.getByRole('checkbox', { name: 'Show header content', exact: true }).getAttribute('aria-checked'), String(enabled), `${label}: validation preserves the area's visibility preference`);
  const feedback = page.locator('.admin-layout-feedback [role="alert"]');
  check((await feedback.textContent()).includes('Header / Left') && (await feedback.textContent()).includes('HTTP or HTTPS URL'), `${label}: the visible error names the hidden slot and URL problem`);
  equal(attempts, [], `${label}: invalid configuration never reaches the page API`); equal(await readPage(), originalPage, `${label}: the server page and revision remain exact`);
  return url;
}
async function retainAfterBlur(control, value, label) {
  await control.fill(value); equal(await control.inputValue(), value, `${label}: the corrected value is retained`); await page.keyboard.press('Tab');
  await page.waitForFunction(node => node !== document.activeElement, await control.elementHandle(), { timeout: STEP });
  equal(await control.inputValue(), value, `${label}: blur does not restore an old value`);
}
async function restoreDraftCheck() {
  step('HomeEditor Restore discards only the unsaved draft'); await home(); const root = await editor();
  const state = () => root.getByRole('combobox').evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute('aria-label'), text: node.textContent })));
  const before = await state(), appearance = await page.locator('.lh-home').evaluate(node => ({ theme: node.dataset.theme, density: node.dataset.density, gap: node.style.getPropertyValue('--lh-gap') }));
  await choose(root.getByRole('combobox', { name: 'Color', exact: true }), originalPage.config.appearance.colorMode === 'dark' ? 'Light' : 'Dark');
  await choose(root.getByRole('combobox', { name: 'Density', exact: true }), originalPage.config.appearance.density === 'compact' ? 'Comfortable' : 'Compact');
  equal(await root.locator('.lh-editor-status').textContent(), 'Unsaved changes', 'Appearance changes create an unsaved draft');
  await root.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.lh-editor-status')?.textContent === 'No changes', null, { timeout: STEP });
  equal(await state(), before, 'Restore returns every visible editor control to its original value');
  equal(await page.locator('.lh-home').evaluate(node => ({ theme: node.dataset.theme, density: node.dataset.density, gap: node.style.getPropertyValue('--lh-gap') })), appearance, 'Restore returns the rendered appearance to its original state');
  check(await root.getByRole('button', { name: 'Save layout', exact: true }).isDisabled(), 'A restored clean draft cannot be saved again');
  equal(attempts, [], 'Restore sends no PUT'); equal(await readPage(), originalPage, 'Restore never changes the server page');
  await root.getByRole('button', { name: 'Cancel', exact: true }).click(); await root.waitFor({ state: 'hidden', timeout: STEP });
  equal(attempts, [], 'Cancel after Restore also sends no PUT');
}
async function validationPhase() {
  check((originalPage.config.chrome?.header.left.length || 0) < 8, 'The demo Header/Left slot has room for one temporary unsaved link');
  step('Build an invalid chrome draft, then leave its slot');
  await page.goto(base.origin + '/#/admin?tab=appearance', { waitUntil: 'domcontentloaded', timeout: STEP });
  await page.locator('.admin-layout-savebar').waitFor({ state: 'visible', timeout: STEP });
  await page.locator('.admin-layout-tabbar').getByRole('tab', { name: 'Header and footer', exact: true }).click();
  const chrome = page.locator('.admin-chrome-editor'); await chrome.waitFor({ state: 'visible', timeout: STEP });
  await chrome.getByRole('tab', { name: 'Header', exact: true }).click(); await chrome.locator('.admin-chrome-alignments > button').first().click();
  const enabled = chrome.getByRole('checkbox', { name: 'Show header content', exact: true }); if (await enabled.getAttribute('aria-checked') !== 'true') await enabled.click();
  await choose(chrome.getByRole('combobox', { name: 'Header or footer item to add', exact: true }), 'Link'); await chrome.getByRole('button', { name: 'Add item', exact: true }).click();
  const title = `Boundary draft ${runId}`, corrected = `https://example.com/boundary/${runId}`;
  await chrome.getByRole('textbox', { name: 'Link text', exact: true }).fill(title);
  await chrome.getByRole('textbox', { name: 'Link URL', exact: true }).fill('not-a-valid-url');
  await chrome.locator('.admin-chrome-alignments > button').nth(2).click();
  check(await chrome.getByRole('textbox', { name: 'Link URL', exact: true }).evaluateAll(nodes => nodes.every(node => node.value !== 'not-a-valid-url')), 'The invalid new link field is unmounted after changing slot');
  const save = page.locator('.admin-layout-savebar').getByRole('button', { name: 'Save page', exact: true });
  await save.click(); let url = await expectChromeIssue(chrome, 'not-a-valid-url', true, 'Different slot'); await capture('invalid-unmounted-slot');
  await retainAfterBlur(url, corrected, 'Correcting the unmounted-slot error');

  step('Close the invalid area, then save from the other area');
  await url.fill('https://user@example.com/');
  await enabled.click(); equal(await enabled.getAttribute('aria-checked'), 'false', 'The header is disabled in the draft');
  await chrome.getByRole('tab', { name: 'Footer', exact: true }).click(); await chrome.locator('.admin-chrome-alignments > button').nth(2).click();
  await save.click(); url = await expectChromeIssue(chrome, 'https://user@example.com/', false, 'Disabled area'); await capture('invalid-disabled-area');
  await retainAfterBlur(url, corrected, 'Correcting the disabled-area error');
  await chrome.getByRole('tab', { name: 'Footer', exact: true }).click(); await chrome.getByRole('tab', { name: 'Header', exact: true }).click(); await chrome.locator('.admin-chrome-alignments > button').first().click();
  const selected = chrome.getByRole('button', { name: `Edit Link ${(originalPage.config.chrome?.header.left.length || 0) + 1}`, exact: true }); await selected.click();
  equal(await chrome.getByRole('textbox', { name: 'Link URL', exact: true }).inputValue(), corrected, 'The corrected URL survives switching away and back');
  await page.locator('.admin-layout-savebar').getByRole('button', { name: 'Cancel changes', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.admin-draft-status')?.textContent === 'Saved', null, { timeout: STEP });
  equal(await readPage(), originalPage, 'Cancelling chrome edits preserves the exact original server page'); equal(attempts, [], 'All invalid saves and chrome cancellation remain read-only');
  await restoreDraftCheck(); details.validation = { unmountedSlotRejected: true, disabledAreaRejected: true, visibleErrorFocus: true, correctedValuesRetained: true, restoreDraftVerified: true, pagePuts: 0 };
}
async function restoreOriginal() {
  const current = await readPage(), diff = differences({ name: originalPage.name, config: originalPage.config }, { name: current.name, config: current.config });
  cleanups.push({ action: 'inspect', revision: current.revision, lastSavedRevision, differences: diff });
  if (diff.length) {
    check(phase === 'grid' && commits.length === 1 && current.revision === lastSavedRevision, 'Cleanup requires the latest revision confirmed from this run; another writer is never overwritten');
    const response = await context.request.put(endpoint('/spaces/' + encodeURIComponent(space.id) + '/page'), { timeout: STEP, maxRedirects: 0,
      headers: { 'X-CSRF-TOKEN': bootstrap.csrfToken }, data: { name: originalPage.name, config: originalPage.config, expectedRevision: current.revision } });
    cleanups.push({ action: 'restore-original-name-and-full-config', expectedRevision: current.revision, status: response.status(), classification: 'cleanup API request, not an admin UI save' });
    check(response.ok(), `Original page restoration: HTTP ${response.status()}`); const restored = await response.json(); const persisted = await readPage();
    equal(persisted, restored, 'The cleanup response matches its readback'); equal({ name: persisted.name, config: persisted.config }, { name: originalPage.name, config: originalPage.config }, 'Original name and full config are restored, including absent fields');
    cleanups.push({ action: 'restored', revision: persisted.revision, differences: [] });
  } else { equal(current, originalPage, 'The read-only phase retains the original complete page and revision'); cleanups.push({ action: 'not-needed', revision: current.revision, differences: [] }); }
}
(async () => {
  let failure;
  try {
    check(['grid', 'validation'].includes(phase), 'Use --phase grid or validation'); if (phase === 'grid') check(args.includes('--allow-demo-write'), 'Grid save requires --allow-demo-write');
    check(!!process.env.BASE_URL, 'Explicit BASE_URL is required'); base = new URL(process.env.BASE_URL);
    check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Use a plain instance root');
    equal(base.hostname, '10.233.233.61', 'Only the designated demo host is allowed'); equal(base.port, '5183', 'Only the English clone on port 5183 is allowed');
    const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, timeout: STEP, ignoreDefaultArgs: ['--hide-scrollbars'], args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'] });
    context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light', reducedMotion: 'no-preference' }); context.setDefaultTimeout(STEP); context.setDefaultNavigationTimeout(STEP);
    bootstrap = await read('/bootstrap'); const settings = await read('/settings');
    equal(bootstrap.initialized, true, 'The clone is initialized'); equal(bootstrap.language, 'en', 'The clone runs English'); equal(bootstrap.mode, 'open_edit', 'Bootstrap confirms open_edit'); equal(settings.mode, 'open_edit', 'Settings confirm open_edit'); equal(settings.hasOwner, false, 'An owner-bearing instance is refused'); check(bootstrap.user == null, 'No account is signed in');
    space = bootstrap.spaces.find(item => item.id === bootstrap.defaultSpaceId); check(space?.kind === 'shared' && space.published && space.canEdit, 'The default space is shared, published and editable');
    originalPage = await readPage(); originalNavigation = await readNavigation(); lastSavedRevision = originalPage.revision; equal(originalPage.spaceId, space.id, 'The page belongs to the guarded space'); check(originalNavigation.data.links.length > 0, 'Existing demo navigation is present'); approved = true;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base.origin) { blocked.push({ method: request.method(), url: url.origin + url.pathname, reason: 'external origin' }); return route.abort('blockedbyclient'); }
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      const attempt = { method: request.method(), path: url.pathname, step: currentStep }; attempts.push(attempt);
      if (phase !== 'grid' || !args.includes('--allow-demo-write') || request.method() !== 'PUT' || url.pathname !== pagePath() || url.search || putBudget !== 1) { blocked.push({ ...attempt, reason: 'outside the one armed grid save' }); return route.abort('blockedbyclient'); }
      let body; try { body = request.postDataJSON(); } catch { blocked.push({ ...attempt, reason: 'invalid JSON' }); return route.abort('blockedbyclient'); }
      if (!body || body.expectedRevision !== lastSavedRevision || body.name !== originalPage.name || body.config?.schemaVersion !== originalPage.config.schemaVersion || Object.keys(body).some(key => !['name', 'config', 'expectedRevision'].includes(key))) { blocked.push({ ...attempt, reason: 'unrecognized page payload or revision' }); return route.abort('blockedbyclient'); }
      putBudget = 0; attempt.expectedRevision = body.expectedRevision;
      try {
        const response = await route.fetch({ timeout: STEP, maxRedirects: 0 }); attempt.status = response.status();
        if (response.ok()) { const saved = await response.json(); check(saved.id === originalPage.id && saved.spaceId === space.id && typeof saved.revision === 'string', 'The save remains within the guarded page'); lastSavedRevision = saved.revision; commits.push({ revision: saved.revision, expectedRevision: body.expectedRevision, path: url.pathname, differences: differences(originalPage.config, saved.config) }); }
        return route.fulfill({ response });
      } catch (error) { routeErrors.push(error.message); await route.abort('failed').catch(() => {}); }
    });
    page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 400)); }); page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
    emit({ event: 'preflight', status: 'passed', phase, origin: base.origin, ownerless: true, language: 'en', pageId: originalPage.id, initialRevision: originalPage.revision, initialConfigSha256: hash(originalPage.config), businessSha256: hash(records(originalNavigation)) });
    await (phase === 'grid' ? gridPhase() : validationPhase());
    equal(records(await readNavigation()), records(originalNavigation), 'Every business-record field remains unchanged');
    equal(blocked, [], 'No outside request or unapproved write was attempted'); equal(routeErrors, [], 'No scoped request forwarding error'); equal(pageErrors, [], 'No uncaught browser errors'); equal(consoleErrors, [], 'No console errors'); equal(dialogs, [], 'No native alert/confirm/prompt dialogs');
  } catch (error) { failure = error; if (page) await capture('failure').catch(() => {}); }
  finally {
    putBudget = 0;
    if (approved) {
      try { await restoreOriginal(); } catch (error) { cleanups.push({ action: 'restoration-failed', message: error.message }); failure = failure || error; }
      try { equal(records(await readNavigation()), records(originalNavigation), 'Finally: complete original business records remain unchanged'); cleanups.push({ action: 'business-records-unchanged' }); } catch (error) { cleanups.push({ action: 'business-check-failed', message: error.message }); failure = failure || error; }
    }
    const diagnostics = page ? await page.evaluate(() => { const node = document.activeElement; return { activeElement: node ? { tag: node.tagName, id: node.id, role: node.getAttribute('role'), label: node.getAttribute('aria-label') || node.getAttribute('data-field-label') } : null, alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent) }; }).catch(error => ({ error: error.message })) : undefined;
    const report = { status: failure ? 'failed' : 'passed', phase, runId, assertions, currentStep, message: failure?.message, stack: failure?.stack, details, attempts, commits, cleanups, blocked, routeErrors, pageErrors, consoleErrors, nativeDialogs: dialogs, diagnostics, screenshots };
    try { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); } catch (error) { failure = failure || error; }
    emit({ event: 'summary', ...report, status: failure ? 'failed' : 'passed', message: failure?.message, reportPath }); if (failure) process.exitCode = 1;
    if (context) await context.close().catch(() => {}); if (browser) await browser.close().catch(() => {});
  }
})();
