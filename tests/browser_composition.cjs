#!/usr/bin/env node
'use strict';
/**
 * Real composition UI checks on an initialized, ownerless disposable demo only.
 * BASE_URL=http://10.233.233.61:5182 node tests/browser_composition.cjs --phase preview
 * BASE_URL=http://10.233.233.61:5183 node tests/browser_composition.cjs --phase all --allow-demo-write
 * Phases: fold, preview, editor, chrome, all. Only editor/chrome save page config.
 * No setup, login, navigation-record edits, or bookmark destination visits.
 * Exactly scoped page PUTs originate from UI; final restoration uses the latest
 * revision confirmed from this run. A changed revision from elsewhere is refused.
 * The editor rejection test explicitly simulates one HTTP 409; it is not a real
 * concurrent-edit test. Other allowed page PUTs are forwarded to the real server.
 * Optional: LINGSHU_PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE, REPORT_PATH, SCREENSHOT_DIR.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const STEP = 12_000;
const args = process.argv.slice(2);
function option(name, fallback) {
  const inline = args.find(value => value.startsWith(name + '='));
  const index = args.indexOf(name);
  return inline ? inline.slice(name.length + 1) : index >= 0 ? args[index + 1] : fallback;
}
const selectedPhase = option('--phase', 'preview');
const phases = ['fold', 'preview', 'editor', 'chrome'];
const runId = randomUUID().slice(0, 12);
const startedAt = new Date().toISOString();
const resolutions = [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080]];
let browser, context, page, base, space, bootstrap, originalPage, originalNavigation, language, lastSavedRevision;
let approved = false, assertions = 0, active = 'preflight', putBudget = 0, simulateNext409 = false;
const attempts = [], commits = [], blocked = [], routeErrors = [], pageErrors = [], consoleErrors = [], expectedConsoleErrors = [], nativeDialogs = [], screenshots = [], results = [], cleanup = [];
const details = {};
const reportPath = path.resolve(process.env.REPORT_PATH || path.join(os.tmpdir(), `lingshu-composition-${runId}.json`));
const check = (value, message) => { assert.ok(value, message); assertions++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const l = (chinese, english) => language === 'en' ? english : chinese;
const endpoint = relative => base.origin + '/api/v1' + relative;
const pagePath = () => '/api/v1/spaces/' + encodeURIComponent(space.id) + '/page';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function differences(before, after, prefix = '') {
  if (isDeepStrictEqual(before, after)) return [];
  if (Array.isArray(before) || Array.isArray(after) || !before || !after || typeof before !== 'object' || typeof after !== 'object') return [prefix || '/'];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => differences(before[key], after[key], prefix + '/' + key));
}
function records(dataset) {
  return { categories: [...dataset.data.categories].sort((a, b) => a.id.localeCompare(b.id)), links: [...dataset.data.links].sort((a, b) => a.id.localeCompare(b.id)) };
}
async function read(relative) {
  const response = await context.request.get(endpoint(relative), { timeout: STEP, maxRedirects: 0 });
  check(response.ok(), `GET ${relative}: HTTP ${response.status()}`);
  return response.json();
}
const readPage = () => read('/spaces/' + encodeURIComponent(space.id) + '/page');
const readNavigation = () => read('/spaces/' + encodeURIComponent(space.id) + '/navigation');
async function capture(name, fullPage = false) {
  if (!process.env.SCREENSHOT_DIR || !page) return;
  const directory = path.resolve(process.env.SCREENSHOT_DIR); fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `composition-${language}-${name}-${runId}.png`);
  await page.screenshot({ path: target, fullPage, animations: 'allow', timeout: STEP });
  screenshots.push(target);
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function pollNode(probe, accepts, label, timeout = STEP) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await probe();
    if (accepts(result)) return result;
    if (Date.now() >= deadline) throw new Error(`${label}: condition not met within ${timeout} ms`);
    await delay(16);
  }
}
async function frameUntil(frame, predicate, value, label) {
  return pollNode(() => frame.evaluate(predicate, value), Boolean, label);
}
async function idle(target = page) {
  // The preview deliberately has no allow-scripts sandbox token. Callbacks
  // created in its main world (including test-created rAF callbacks) may not
  // execute. Poll synchronous DOM reads from Node without changing the sandbox.
  if (target !== page) {
    let stable = 0;
    await pollNode(() => target.evaluate(() => document.fonts.status === 'loaded' && document.readyState !== 'loading'), ready => { stable = ready ? stable + 1 : 0; return stable >= 3; }, 'Preview fonts and document readiness');
    return;
  }
  await target.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}
async function choose(control, label) {
  await control.click();
  const listbox = page.getByRole('listbox'); await listbox.waitFor({ state: 'visible', timeout: STEP });
  await page.getByRole('option', { name: label, exact: true }).click();
  await listbox.waitFor({ state: 'hidden', timeout: STEP });
  check((await control.textContent()).includes(label), `Select visibly retains ${label}`);
}
async function home() {
  await page.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded', timeout: STEP });
  await page.locator('.lh-home:not([data-preview]) .lh-home-heading h1').waitFor({ state: 'visible', timeout: STEP });
  await page.waitForFunction(() => document.querySelectorAll('.lh-home:not([data-preview]) .lh-bookmark').length > 0, null, { timeout: STEP });
  await idle();
}
async function layout() {
  await page.goto(base.origin + '/#/admin?tab=appearance', { waitUntil: 'domcontentloaded', timeout: STEP });
  await page.locator('.admin-layout-form .admin-layout-savebar').waitFor({ state: 'visible', timeout: STEP });
  await page.locator('.admin-layout-tabbar').getByRole('tab', { name: l('页面与外观', 'Page and appearance'), exact: true }).click();
  await page.getByRole('textbox', { name: l('页面名称', 'Page name'), exact: true }).waitFor({ state: 'visible', timeout: STEP });
  await idle();
}
async function editHomepage() {
  await page.locator('.lh-more-trigger').click(); await page.getByRole('menuitem', { name: l('调整布局', 'Adjust layout'), exact: true }).click();
  const editor = page.locator('.lh-page-editor[aria-label]');
  await editor.locator('.lh-editor-controls').waitFor({ state: 'visible', timeout: STEP });
  return editor;
}
async function cancelHomepage(editor) {
  await editor.getByRole('button', { name: l('取消', 'Cancel'), exact: true }).click();
  await editor.waitFor({ state: 'hidden', timeout: STEP });
  await page.locator('.lh-edit-trigger').waitFor({ state: 'visible', timeout: STEP });
  await idle();
}

// Install read-only measurement functions in the document being inspected. A
// requestAnimationFrame trace observes intermediate frames between real clicks.
function installMeasurements() {
  const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
  window.__compositionMeasure = () => ({
    time: performance.now(),
    viewport: { width: innerWidth, height: innerHeight },
    document: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight), scrollX, scrollY },
    home: document.querySelector('.lh-home') ? rect(document.querySelector('.lh-home')) : null,
    grid: [...document.querySelectorAll('.react-grid-layout')].map(node => ({ ...rect(node), transition: getComputedStyle(node).transition })),
    items: [...document.querySelectorAll('.react-grid-item:not(.react-grid-placeholder)')].map(node => ({
      id: node.querySelector('[data-panel-id]')?.getAttribute('data-panel-id'), ...rect(node),
      transition: getComputedStyle(node).transition, transform: getComputedStyle(node).transform
    })),
    scrollers: [...document.querySelectorAll('.lh-grid-scroll')].map(node => ({
      id: node.closest('[data-panel-id]')?.getAttribute('data-panel-id'), ...rect(node), clientWidth: node.clientWidth, clientHeight: node.clientHeight,
      scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop, overflowX: getComputedStyle(node).overflowX, overflowY: getComputedStyle(node).overflowY
    })),
    collapsed: [...document.querySelectorAll('.lh-category-collapse')].map(node => ({ key: node.closest('[data-state-key]')?.getAttribute('data-state-key'), expanded: node.getAttribute('aria-expanded') }))
  });
  window.__compositionStartTrace = () => {
    window.__compositionTrace = []; window.__compositionTracing = true;
    const sample = () => {
      if (!window.__compositionTracing) return;
      window.__compositionTrace.push(window.__compositionMeasure());
      if (window.__compositionTrace.length < 3000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  };
}
async function settledGeometry(target = page) {
  if (target !== page) {
    let previous = '', same = 0;
    return pollNode(() => target.evaluate(() => window.__compositionMeasure()), current => {
      const signature = JSON.stringify({ document: current.document, grid: current.grid, items: current.items, scrollers: current.scrollers });
      same = signature === previous ? same + 1 : 0; previous = signature;
      return same >= 5;
    }, 'Preview grid/document geometry stability', 4000);
  }
  return target.evaluate(() => new Promise((resolve, reject) => {
    let previous = '', same = 0; const start = performance.now();
    const sample = () => {
      const current = window.__compositionMeasure();
      const signature = JSON.stringify({ document: current.document, grid: current.grid, items: current.items, scrollers: current.scrollers });
      same = signature === previous ? same + 1 : 0; previous = signature;
      if (same >= 5) resolve(current);
      else if (performance.now() - start > 4000) reject(new Error('Grid/document geometry did not settle within 4 seconds'));
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
}
function noHorizontalOverflow(snapshot, label) {
  check(snapshot.document.scrollWidth <= snapshot.document.width + 1 && snapshot.document.scrollX === 0, `${label}: the document has no horizontal overflow`);
  check(snapshot.items.every(item => Number.isFinite(item.width) && item.width > 0 && item.height > 0 && item.x >= -1 && item.right <= snapshot.document.width + 1), `${label}: grid panels remain within the document width`);
}
function sameGeometry(before, after, label) {
  equal(after.items.map(item => item.id), before.items.map(item => item.id), `${label}: panel identities remain unchanged`);
  for (const key of ['width', 'height', 'scrollWidth', 'scrollHeight']) check(Math.abs(before.document[key] - after.document[key]) <= 1, `${label}: document ${key} returns to the same value`);
  for (let index = 0; index < before.items.length; index++) for (const key of ['x', 'y', 'width', 'height']) check(Math.abs(before.items[index][key] - after.items[index][key]) <= 1, `${label}: panel ${before.items[index].id} ${key} does not drift`);
  equal(after.scrollers.map(item => [item.id, item.clientWidth, item.clientHeight, item.scrollWidth, item.scrollHeight]), before.scrollers.map(item => [item.id, item.clientWidth, item.clientHeight, item.scrollWidth, item.scrollHeight]), `${label}: internal scrolling dimensions return exactly`);
}

async function foldPhase() {
  const before = await readPage(), attemptCount = attempts.length;
  await home(); await page.evaluate(installMeasurements);
  check(!(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)), 'Folding is observed with normal motion preferences');
  const toggle = page.locator('.lh-home:not([data-preview]) .lh-category-collapse').first();
  await toggle.waitFor({ state: 'visible', timeout: STEP });
  const initialState = await toggle.getAttribute('aria-expanded');
  const initial = await settledGeometry();
  check(initial.items.length > 0 && initial.scrollers.length === initial.items.length, 'The actual React grid and its internal scroll containers are present');
  noHorizontalOverflow(initial, 'Before folding');
  const states = new Map([[initialState, initial]]), settled = [];
  await page.evaluate(() => window.__compositionStartTrace());
  for (let index = 0; index < 6; index++) {
    const old = await toggle.getAttribute('aria-expanded');
    await toggle.click();
    await page.waitForFunction(({ node, old }) => node.getAttribute('aria-expanded') !== old, { node: await toggle.elementHandle(), old }, { timeout: STEP });
    const state = await toggle.getAttribute('aria-expanded'), geometry = await settledGeometry();
    noHorizontalOverflow(geometry, `Toggle ${index + 1}`);
    if (states.has(state)) sameGeometry(states.get(state), geometry, `Repeated ${state === 'true' ? 'expanded' : 'collapsed'} state`);
    else states.set(state, geometry);
    settled.push({ expanded: state, geometry });
  }
  // A second burst changes state again before waiting for the full geometry
  // convergence. Every click still goes through Playwright's actual UI action.
  for (let index = 0; index < 8; index++) {
    const old = await toggle.getAttribute('aria-expanded'); await toggle.click();
    await page.waitForFunction(({ node, old }) => node.getAttribute('aria-expanded') !== old, { node: await toggle.elementHandle(), old }, { timeout: STEP });
  }
  const final = await settledGeometry();
  const trace = await page.evaluate(() => { window.__compositionTracing = false; return window.__compositionTrace; });
  check(trace.length >= 10, 'Intermediate animation frames were actually sampled');
  check(trace.every(frame => frame.document.scrollWidth <= frame.document.width + 1 && frame.document.scrollX === 0), 'No sampled folding frame introduces horizontal document overflow');
  check(trace.every(frame => frame.items.every(item => item.x >= -1 && item.right <= frame.document.width + 1)), 'No sampled grid panel escapes the document width');
  equal(await toggle.getAttribute('aria-expanded'), initialState, 'Fourteen toggles restore the original category state');
  sameGeometry(initial, final, 'After the rapid toggle burst');
  equal(attempts.length, attemptCount, 'Category folding sends no page PUT');
  equal(await readPage(), before, 'Folding leaves the full persisted page and revision unchanged');
  details.fold = { motion: 'no-preference', clicks: 14, initial, settled, final, trace };
  await capture('folding');
  return { clicks: 14, frames: trace.length, documentWidthRange: [Math.min(...trace.map(x => x.document.scrollWidth)), Math.max(...trace.map(x => x.document.scrollWidth))], documentHeightRange: [Math.min(...trace.map(x => x.document.scrollHeight)), Math.max(...trace.map(x => x.document.scrollHeight))], pagePuts: 0 };
}

async function previewFrame(container = page.locator('.admin-page-preview')) {
  await container.locator('.admin-preview-stage[aria-busy="false"]').waitFor({ state: 'visible', timeout: STEP });
  const iframe = container.locator('iframe'); await iframe.waitFor({ state: 'visible', timeout: STEP });
  const handle = await iframe.elementHandle(), frame = await handle.contentFrame();
  check(!!frame, 'A real iframe browsing context exists');
  await frame.locator('.lh-home[data-preview="true"]').waitFor({ state: 'visible', timeout: STEP });
  await frameUntil(frame, () => document.querySelectorAll('.lh-bookmark').length > 0, null, 'Preview navigation content');
  await idle(frame); await frame.evaluate(installMeasurements);
  return { iframe, frame };
}
async function previewPhase() {
  const before = await readPage(), attemptCount = attempts.length, commitCount = commits.length;
  await layout();
  await page.locator('.admin-layout-tabbar').getByRole('button', { name: l('预览首页', 'Preview homepage'), exact: true }).click();
  let preview = await previewFrame();
  equal(await preview.frame.locator('.lh-home-heading h1').textContent(), before.name, 'The iframe initially renders the saved page name');
  const draftName = `Composition preview ${runId}`, draftColor = before.config.appearance.colorMode === 'dark' ? 'light' : 'dark';
  await page.getByRole('textbox', { name: l('页面名称', 'Page name'), exact: true }).fill(draftName);
  await preview.frame.getByRole('heading', { level: 1, name: draftName, exact: true }).waitFor({ state: 'visible', timeout: STEP });
  await choose(page.getByRole('combobox', { name: l('配色', 'Color mode'), exact: true }), draftColor === 'dark' ? l('深色', 'Dark') : l('浅色', 'Light'));
  await frameUntil(preview.frame, color => document.querySelector('.lh-home')?.getAttribute('data-theme') === color, draftColor, 'Preview draft color');
  const measured = [];
  for (const [width, height] of resolutions) {
    await choose(page.locator('.admin-page-preview').getByRole('combobox', { name: l('预览分辨率', 'Preview resolution'), exact: true }), `${width} × ${height}`);
    preview = await previewFrame();
    await frameUntil(preview.frame, ({ width, height }) => innerWidth === width && innerHeight === height, { width, height }, 'Preview viewport dimensions');
    equal(await preview.iframe.getAttribute('width'), String(width), 'The iframe uses the selected real width');
    equal(await preview.iframe.getAttribute('height'), String(height), 'The iframe uses the selected real height');
    const geometry = await settledGeometry(preview.frame); noHorizontalOverflow(geometry, `Preview ${width} × ${height}`);
    equal(await preview.frame.locator('.lh-home-heading h1').textContent(), draftName, 'The unsaved title survives resolution changes');
    equal(await preview.frame.locator('.lh-home').getAttribute('data-theme'), draftColor, 'The unsaved color survives resolution changes');
    equal(await preview.frame.locator('.lh-edit-trigger,.lh-space-holder').count(), 0, 'Preview omits editing and space-changing actions');
    await preview.frame.locator('.lh-more-trigger').click();
    equal(await preview.frame.locator('.lh-home-actions-menu a[href="#/admin"],.lh-home-actions-menu a[href="#/library"]').count(), 0, 'Preview menu omits management navigation');
    equal(await preview.frame.getByRole('menuitem', { name: l('调整布局', 'Adjust layout'), exact: true }).count(), 0, 'Preview menu omits layout editing');
    equal(await preview.frame.getByRole('menuitem', { name: l('点击统计', 'Click statistics'), exact: true }).count(), 0, 'Preview menu omits statistics');
    await page.keyboard.press('Escape');
    check(await preview.frame.locator('.lh-bookmark').count() > 0, 'Preview contains actual loaded navigation content');
    measured.push({ width, height, geometry, bookmarks: await preview.frame.locator('.lh-bookmark').count() });
  }
  await page.getByRole('button', { name: l('放大预览', 'Enlarge preview'), exact: true }).click();
  const expanded = page.locator('.admin-preview-dialog'); await expanded.waitFor({ state: 'visible', timeout: STEP });
  const large = await previewFrame(expanded);
  equal(await large.frame.locator('.lh-home-heading h1').textContent(), draftName, 'The enlarged real iframe retains the same draft');
  await capture('preview-enlarged');
  await expanded.locator('.admin-preview-dialog-close').click(); await expanded.waitFor({ state: 'hidden', timeout: STEP });
  await previewFrame();
  await page.locator('.admin-layout-savebar').getByRole('button', { name: l('取消更改', 'Cancel changes'), exact: true }).click();
  preview = await previewFrame();
  await preview.frame.getByRole('heading', { level: 1, name: before.name, exact: true }).waitFor({ state: 'visible', timeout: STEP });
  await page.getByRole('button', { name: l('关闭预览', 'Close preview'), exact: true }).click();
  equal(attempts.length, attemptCount, 'Preview and cancelled admin drafts send no page PUT');
  equal(commits.length, commitCount, 'Preview never commits a configuration');
  equal(await readPage(), before, 'Preview leaves the full persisted page and revision unchanged');
  details.preview = { resolutions: measured, draftName, draftColor, enlarged: true };
  return { resolutions: resolutions.map(([w, h]) => `${w}x${h}`), liveDraft: true, realIframe: true, enlarged: true, pagePuts: 0 };
}

async function pageWrite(action, simulated = false) {
  check(putBudget === 0, 'Page mutation windows never overlap');
  const beforeAttempts = attempts.length, beforeCommits = commits.length;
  putBudget = 1; simulateNext409 = simulated;
  try {
    const [response] = await Promise.all([
      page.waitForResponse(value => value.request().method() === 'PUT' && new URL(value.url()).pathname === pagePath(), { timeout: STEP }),
      action()
    ]);
    if (simulated) {
      equal(response.status(), 409, 'One page save receives the deliberately simulated HTTP 409');
      equal(commits.length, beforeCommits, 'The simulated rejection is never forwarded to the server');
    } else {
      check(response.ok(), `UI page save succeeds: HTTP ${response.status()}`);
      equal(commits.length, beforeCommits + 1, 'Exactly one real page PUT was forwarded and confirmed');
    }
    equal(attempts.length, beforeAttempts + 1, 'One Save action sends exactly one page PUT request');
    const result = await response.json();
    if (!simulated) equal(await readPage(), result, 'The saved page response exactly matches the persisted readback');
    return result;
  } finally { putBudget = 0; simulateNext409 = false; }
}
async function editorPhase() {
  const before = await readPage(), attemptCount = attempts.length;
  await home();
  let editor = await editHomepage();
  const color = before.config.appearance.colorMode === 'dark' ? 'light' : 'dark';
  await choose(editor.getByRole('combobox', { name: l('配色', 'Color'), exact: true }), color === 'dark' ? l('深色', 'Dark') : l('浅色', 'Light'));
  await page.waitForFunction(color => document.querySelector('.lh-home')?.getAttribute('data-theme') === color, color, { timeout: STEP });
  await cancelHomepage(editor);
  equal(attempts.length, attemptCount, 'Cancelling homepage editing sends no PUT');
  equal(await readPage(), before, 'Cancel retains the exact server page and revision');
  const originalColor = before.config.appearance.colorMode === 'system' ? 'light' : before.config.appearance.colorMode;
  equal(await page.locator('.lh-home').getAttribute('data-theme'), originalColor, 'Cancel discards the unsaved color on screen');

  editor = await editHomepage();
  const density = before.config.appearance.density === 'compact' ? 'comfortable' : 'compact';
  await choose(editor.getByRole('combobox', { name: l('密度', 'Density'), exact: true }), density === 'compact' ? l('紧凑', 'Compact') : l('舒适', 'Comfortable'));
  await page.waitForFunction(density => document.querySelector('.lh-home')?.getAttribute('data-density') === density, density, { timeout: STEP });
  const saved = await pageWrite(() => editor.getByRole('button', { name: l('保存布局', 'Save layout'), exact: true }).click());
  await editor.waitFor({ state: 'hidden', timeout: STEP });
  const expected = structuredClone(before.config); expected.appearance.density = density;
  equal(saved.config, expected, 'Homepage Save changes only the selected density');
  equal(saved.name, before.name, 'Homepage Save preserves the page name');
  check(saved.revision !== before.revision, 'A successful page save advances the revision');
  await home(); equal(await page.locator('.lh-home').getAttribute('data-density'), density, 'Saved density persists after returning to Home');

  editor = await editHomepage();
  const rejectedDensity = density === 'compact' ? 'comfortable' : 'compact';
  await choose(editor.getByRole('combobox', { name: l('密度', 'Density'), exact: true }), rejectedDensity === 'compact' ? l('紧凑', 'Compact') : l('舒适', 'Comfortable'));
  await pageWrite(() => editor.getByRole('button', { name: l('保存布局', 'Save layout'), exact: true }).click(), true);
  await page.locator('.lh-notice.is-error').getByText(l('页面已在其他窗口修改。你的草稿仍然保留；取消编辑以加载最新布局，再重新调整。', 'The page changed in another window. Your draft is still here. Cancel editing to load the latest layout before making your changes again.'), { exact: true }).waitFor({ state: 'visible', timeout: STEP });
  check(await editor.isVisible(), 'The rejected save leaves the homepage editor open');
  equal(await page.locator('.lh-home').getAttribute('data-density'), rejectedDensity, 'The rejected draft remains visibly intact');
  check((await editor.locator('.lh-editor-status').textContent()).includes(l('尚未保存', 'Unsaved changes')), 'The rejected draft is still marked unsaved');
  equal(await readPage(), saved, 'The simulated HTTP 409 leaves the real server page unchanged');
  await capture('homepage-conflict');
  const afterRejectionAttempts = attempts.length; await cancelHomepage(editor);
  equal(attempts.length, afterRejectionAttempts, 'Cancelling after rejection sends no PUT');
  equal(await page.locator('.lh-home').getAttribute('data-density'), density, 'Cancel after rejection reloads the saved appearance');
  equal(await readPage(), saved, 'Cancel after rejection preserves the saved server page');
  return { cancelledPagePuts: 0, successfulPagePuts: 1, successfulChange: '/config/appearance/density', rejection: 'One route-fulfilled HTTP 409; no actual concurrent writer was used', draftRetained: true };
}

function defaultChrome() {
  return { header: { enabled: false, left: [], center: [], right: [] }, footer: { enabled: true, left: [], center: [], right: [{ id: 'home-branding', type: 'branding' }] } };
}
async function chromePhase() {
  const before = await readPage(), startingChrome = structuredClone(before.config.chrome || defaultChrome());
  const slots = [
    { area: 'header', alignment: 'left', type: 'text' }, { area: 'header', alignment: 'center', type: 'link' }, { area: 'header', alignment: 'right', type: 'branding' },
    { area: 'footer', alignment: 'left', type: 'link' }, { area: 'footer', alignment: 'center', type: 'text' }, { area: 'footer', alignment: 'right', type: 'branding' }
  ].map((slot, index) => ({ ...slot, text: `Composition ${runId} ${slot.area} ${slot.alignment}`, url: `https://example.com/lingshu-composition/${runId}/${slot.area}-${slot.alignment}`, newTab: index !== 1 }));
  check(slots.every(slot => startingChrome[slot.area][slot.alignment].length < 8), 'Every demo chrome slot has room for one synthetic item without removing existing content');
  await layout();
  await page.locator('.admin-layout-tabbar').getByRole('tab', { name: l('页眉与页脚', 'Header and footer'), exact: true }).click();
  const chrome = page.locator('.admin-chrome-editor'); await chrome.waitFor({ state: 'visible', timeout: STEP });
  for (const slot of slots) {
    await chrome.getByRole('tab', { name: slot.area === 'header' ? l('页眉', 'Header') : l('页脚', 'Footer'), exact: true }).click();
    const enabled = chrome.getByRole('checkbox', { name: slot.area === 'header' ? l('显示页眉内容', 'Show header content') : l('显示页脚内容', 'Show footer content'), exact: true });
    if (await enabled.getAttribute('aria-checked') !== 'true') await enabled.click();
    const alignment = chrome.locator('.admin-chrome-alignments > button').nth(['left', 'center', 'right'].indexOf(slot.alignment));
    await alignment.click(); equal(await alignment.getAttribute('aria-pressed'), 'true', `The ${slot.area}/${slot.alignment} slot is selected`);
    const typeName = slot.type === 'text' ? l('文字', 'Text') : slot.type === 'link' ? l('链接', 'Link') : l('项目品牌', 'Project branding');
    await choose(chrome.getByRole('combobox', { name: l('要添加的页眉页脚内容', 'Header or footer item to add'), exact: true }), typeName);
    await chrome.getByRole('button', { name: l('添加内容', 'Add item'), exact: true }).click();
    const inspector = chrome.getByRole('region', { name: l('页眉页脚内容配置', 'Header or footer item settings'), exact: true });
    await inspector.waitFor({ state: 'visible', timeout: STEP });
    if (slot.type === 'text') await inspector.getByRole('textbox', { name: l('文本', 'Text'), exact: true }).fill(slot.text);
    if (slot.type === 'link') {
      await inspector.getByRole('textbox', { name: l('链接文本', 'Link text'), exact: true }).fill(slot.text);
      await inspector.getByRole('textbox', { name: l('链接网址', 'Link URL'), exact: true }).fill(slot.url);
      const newTab = inspector.getByRole('checkbox', { name: l('在新标签页打开', 'Open in a new tab'), exact: true });
      if ((await newTab.getAttribute('aria-checked') === 'true') !== slot.newTab) await newTab.click();
    }
  }
  const saved = await pageWrite(() => page.locator('.admin-layout-savebar').getByRole('button', { name: l('保存页面', 'Save page'), exact: true }).click());
  const expectedChrome = structuredClone(startingChrome), ids = [];
  expectedChrome.header.enabled = true; expectedChrome.footer.enabled = true;
  for (const slot of slots) {
    const actual = saved.config.chrome[slot.area][slot.alignment], old = startingChrome[slot.area][slot.alignment];
    equal(actual.length, old.length + 1, `${slot.area}/${slot.alignment} contains exactly one additional item`);
    equal(actual.slice(0, old.length), old, `${slot.area}/${slot.alignment} retains all pre-existing items in order`);
    const item = actual[actual.length - 1]; check(typeof item.id === 'string' && !!item.id, 'UI-generated chrome content has an identifier'); ids.push(item.id);
    const expectedItem = slot.type === 'branding' ? { id: item.id, type: 'branding' } : slot.type === 'text' ? { id: item.id, type: 'text', text: slot.text } : { id: item.id, type: 'link', text: slot.text, url: slot.url, newTab: slot.newTab };
    equal(item, expectedItem, `${slot.area}/${slot.alignment} preserves its exact configured fields`);
    expectedChrome[slot.area][slot.alignment].push(expectedItem);
  }
  equal(new Set(ids).size, 6, 'The six new items have distinct identifiers');
  equal(saved.config, { ...before.config, chrome: expectedChrome }, 'Chrome Save preserves every other page configuration field');
  equal(saved.name, before.name, 'Chrome Save preserves the page name');
  await home();
  for (const slot of slots) {
    const rendered = page.locator(`${slot.area === 'header' ? '.lh-custom-header' : '.lh-footer'} .lh-chrome-slot.is-${slot.alignment}`);
    equal(await rendered.count(), 1, `The homepage renders ${slot.area}/${slot.alignment}`);
    if (slot.type === 'branding') check(await rendered.locator('.lh-chrome-branding').count() >= 1, 'The branding item is rendered in its configured slot');
    else await rendered.getByText(slot.text, { exact: true }).waitFor({ state: 'visible', timeout: STEP });
    if (slot.type === 'link') {
      const link = rendered.getByRole('link', { name: slot.text, exact: true });
      equal(await link.getAttribute('href'), slot.url, 'The chrome link keeps its configured destination');
      equal(await link.getAttribute('target'), slot.newTab ? '_blank' : null, 'The chrome link respects its new-tab preference');
    }
  }
  await capture('six-chrome-slots', true);
  return { successfulPagePuts: 1, slots: slots.map(slot => ({ area: slot.area, alignment: slot.alignment, type: slot.type })), existingItemsRetained: true };
}

async function restoreOriginal() {
  const current = await readPage(), diff = differences({ name: originalPage.name, config: originalPage.config }, { name: current.name, config: current.config });
  cleanup.push({ action: 'inspect-before-restoration', revision: current.revision, lastSavedRevision, differences: diff });
  if (diff.length) {
    check(commits.length > 0 && current.revision === lastSavedRevision, 'Cleanup only restores the latest revision confirmed from this run; another writer is never overwritten');
    const response = await context.request.put(endpoint('/spaces/' + encodeURIComponent(space.id) + '/page'), {
      timeout: STEP, maxRedirects: 0, headers: { 'X-CSRF-TOKEN': bootstrap.csrfToken },
      data: { name: originalPage.name, config: originalPage.config, expectedRevision: current.revision }
    });
    cleanup.push({ action: 'restore-original-page', expectedRevision: current.revision, status: response.status(), scope: pagePath(), classification: 'cleanup API request, not UI validation' });
    check(response.ok(), `Original page restoration succeeds: HTTP ${response.status()}`);
    const restored = await response.json(); lastSavedRevision = restored.revision;
    const readback = await readPage(); equal(readback, restored, 'Cleanup response exactly matches its persisted readback');
    equal({ name: readback.name, config: readback.config }, { name: originalPage.name, config: originalPage.config }, 'The full original page name and config are restored');
    cleanup.push({ action: 'restoration-confirmed', revision: readback.revision, configSha256: digest(readback.config), differences: [] });
  } else cleanup.push({ action: 'restoration-not-needed', revision: current.revision, differences: [] });
}

(async () => {
  let failure;
  try {
    check(phases.includes(selectedPhase) || selectedPhase === 'all', 'Choose a supported composition phase');
    if (['all', 'editor', 'chrome'].includes(selectedPhase)) check(args.includes('--allow-demo-write'), 'This phase requires explicit --allow-demo-write for the isolated demo page');
    check(!!process.env.BASE_URL, 'An explicit disposable-demo BASE_URL is required'); base = new URL(process.env.BASE_URL);
    check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Use a plain instance root without credentials, path, query or fragment');
    equal(base.hostname, '10.233.233.61', 'Only the designated isolated demo host is permitted');
    check(['5182', '5183'].includes(base.port), 'Only disposable demo ports 5182/5183 are permitted');
    const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, timeout: STEP, ignoreDefaultArgs: ['--hide-scrollbars'], args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'] });
    context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light', reducedMotion: 'no-preference' });
    context.setDefaultTimeout(STEP); context.setDefaultNavigationTimeout(STEP);
    bootstrap = await read('/bootstrap'); const settings = await read('/settings');
    equal(bootstrap.initialized, true, 'The demo is already initialized'); equal(bootstrap.mode, 'open_edit', 'Bootstrap confirms open_edit');
    equal(settings.mode, 'open_edit', 'Settings confirm open_edit'); equal(settings.hasOwner, false, 'An instance with an Owner account is refused'); check(bootstrap.user == null, 'No user is signed in');
    language = bootstrap.language === 'en' ? 'en' : 'zh-CN'; space = bootstrap.spaces.find(item => item.id === bootstrap.defaultSpaceId);
    check(space?.kind === 'shared' && space.published && space.canEdit, 'The selected demo space is published, shared and editable');
    originalPage = await readPage(); originalNavigation = await readNavigation(); lastSavedRevision = originalPage.revision;
    equal(originalPage.spaceId, space.id, 'The page belongs to the guarded demo space');
    check(originalNavigation.data.links.length > 0, 'The demo already contains real navigation data'); approved = true;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.protocol === 'about:') return route.continue();
      if (url.origin !== base.origin) { blocked.push({ phase: active, method: request.method(), url: url.origin + url.pathname, reason: 'external origin' }); return route.abort('blockedbyclient'); }
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      const attempt = { phase: active, method: request.method(), path: url.pathname, simulated: false }; attempts.push(attempt);
      if (!args.includes('--allow-demo-write') || !['editor', 'chrome'].includes(active) || request.method() !== 'PUT' || url.pathname !== pagePath() || url.search || putBudget !== 1) {
        blocked.push({ ...attempt, reason: 'outside the single explicitly armed page save' }); return route.abort('blockedbyclient');
      }
      let body;
      try { body = request.postDataJSON(); } catch { blocked.push({ ...attempt, reason: 'invalid JSON' }); return route.abort('blockedbyclient'); }
      if (!body || body.expectedRevision !== lastSavedRevision || typeof body.name !== 'string' || body.config?.schemaVersion !== originalPage.config.schemaVersion || Object.keys(body).some(key => !['name', 'config', 'expectedRevision'].includes(key))) {
        blocked.push({ ...attempt, reason: 'unrecognized payload or revision' }); return route.abort('blockedbyclient');
      }
      putBudget = 0; attempt.expectedRevision = body.expectedRevision; attempt.configSha256 = digest(body.config);
      if (simulateNext409) {
        simulateNext409 = false; attempt.simulated = true; attempt.status = 409;
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'page_version_conflict', message: 'Composition test: simulated rejection; no concurrent server write was performed.' }) });
      }
      try {
        // Forward the application's actual body/headers/cookies unchanged, and
        // record the response before releasing it to the UI. No API write is
        // synthesized here, and redirects cannot escape the guarded endpoint.
        const response = await route.fetch({ timeout: STEP, maxRedirects: 0 }); attempt.status = response.status();
        if (response.ok()) {
          const saved = await response.json();
          check(saved.spaceId === space.id && saved.id === originalPage.id && typeof saved.revision === 'string', 'The saved response remains within the guarded page');
          lastSavedRevision = saved.revision;
          commits.push({ phase: active, expectedRevision: body.expectedRevision, revision: saved.revision, path: url.pathname, configSha256: digest(saved.config), differencesFromOriginal: differences(originalPage.config, saved.config) });
        }
        return route.fulfill({ response });
      } catch (error) { routeErrors.push(error.message); await route.abort('failed').catch(() => {}); }
    });
    page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const entry = { text: message.text().slice(0, 400), url: message.location().url };
      if (attempts.some(attempt => attempt.simulated) && expectedConsoleErrors.length === 0 && /\b409\b/.test(entry.text) && entry.url === base.origin + pagePath()) expectedConsoleErrors.push({ ...entry, expected: 'Single simulated HTTP 409' });
      else consoleErrors.push(entry);
    });
    page.on('dialog', dialog => { nativeDialogs.push(dialog.type()); void dialog.dismiss(); });
    emit({ event: 'preflight', status: 'passed', origin: base.origin, phase: selectedPhase, language, ownerless: true, pageId: originalPage.id, initialRevision: originalPage.revision, initialConfigSha256: digest(originalPage.config), navigationSha256: digest(records(originalNavigation)), motion: 'no-preference' });
    const runners = { fold: foldPhase, preview: previewPhase, editor: editorPhase, chrome: chromePhase };
    for (const phase of selectedPhase === 'all' ? phases : [selectedPhase]) {
      active = phase; const beforeAssertions = assertions, start = Date.now(); emit({ event: 'phase-start', phase });
      const result = await runners[phase]();
      const entry = { phase, status: 'passed', assertions: assertions - beforeAssertions, durationMs: Date.now() - start, ...result }; results.push(entry); emit({ event: 'phase-result', ...entry });
      equal(records(await readNavigation()), records(originalNavigation), `${phase}: all link/category fields remain unchanged`);
    }
    equal(blocked, [], 'No external request or unauthorized write was attempted'); equal(routeErrors, [], 'No guarded request failed to forward');
    equal(pageErrors, [], 'No uncaught browser errors'); equal(consoleErrors, [], 'No unexpected console errors'); equal(nativeDialogs, [], 'No native alert/confirm/prompt dialogs');
  } catch (error) { failure = error; if (page) await capture('failure').catch(() => {}); }
  finally {
    active = 'cleanup'; putBudget = 0; simulateNext409 = false;
    if (page) await page.evaluate(() => { window.__compositionTracing = false; }).catch(() => {});
    if (approved) {
      try { await restoreOriginal(); } catch (error) { cleanup.push({ action: 'restoration-failed', message: error.message }); failure = failure || error; }
      try { const finalNavigation = await readNavigation(); equal(records(finalNavigation), records(originalNavigation), 'Finally: every link/category field is unchanged'); cleanup.push({ action: 'business-records-confirmed-unchanged', navigationSha256: digest(records(finalNavigation)) }); }
      catch (error) { cleanup.push({ action: 'business-record-check-failed', message: error.message }); failure = failure || error; }
    }
    const report = { status: failure ? 'failed' : 'passed', runId, startedAt, endedAt: new Date().toISOString(), selectedPhase, origin: base?.origin, language, assertions, message: failure?.message, results, attempts, commits, cleanup, blocked, routeErrors, pageErrors, consoleErrors, expectedConsoleErrors, nativeDialogs, screenshots, details };
    try { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }
    catch (error) { failure = failure || error; }
    emit({ event: 'summary', ...report, details: undefined, status: failure ? 'failed' : 'passed', message: failure?.message, reportPath });
    if (failure) process.exitCode = 1;
    if (context) await context.close().catch(() => {}); if (browser) await browser.close().catch(() => {});
  }
})();
