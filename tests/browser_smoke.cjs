#!/usr/bin/env node
'use strict';

/**
 * Real UI acceptance for a dedicated, already initialized, ownerless open_edit demo.
 * Never run against a personal instance. The normal application port 5180 is refused.
 *
 * BASE_URL=http://demo-host:5182 \
 * LINGSHU_PLAYWRIGHT_MODULE=/path/to/playwright \
 * CHROMIUM_EXECUTABLE=/path/to/chromium \
 * node tests/browser_smoke.cjs --allow-demo-write --phase all
 *
 * Phases: crud | bookmarks | layout | all. Each may run independently.
 * Optional: LINGSHU_DEMO_BOOKMARKS=/path/to/demo-bookmarks.html, SCREENSHOT_DIR=/path.
 * CRUD removes only its unique synthetic link. Bookmark imports are deliberately kept.
 * Layout restores the complete original page through a revision-checked cleanup PUT in finally.
 * Validation mutations use UI controls. Cleanup alone may PUT the original page after checking
 * that the current revision is the last one saved by this run. All requests have 10s limits.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const STEP_TIMEOUT = 10_000;
const PHASE_TIMEOUT = 45_000;
const argv = process.argv.slice(2);
function argument(name, fallback) {
  const inline = argv.find(value => value.startsWith(name + '='));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}
const phase = argument('--phase', 'all');
const allowedPhases = ['all', 'crud', 'bookmarks', 'layout'];
const startedAt = Date.now();
const runId = randomUUID().slice(0, 12);
let assertions = 0;
let browser;
let context;
let page;
let selectedSpace;
let base;
let activePhase = 'preflight';
let synthetic = null;
let approvedDemo = false;
const pageErrors = [];
const consoleErrors = [];
const results = [];
let retainedDemo = null;
let layoutResult = null;
let layoutOriginal = null;
let layoutLastSavedRevision = null;
function check(value, description) { assert.ok(value, description); assertions++; }
function equal(actual, expected, description) { assert.deepEqual(actual, expected, description); assertions++; }
function emit(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function step(label) { emit({ event: 'step', phase: activePhase, label, elapsedMs: Date.now() - startedAt }); }
function endpoint(relative) { return base.origin + '/api/v1' + relative; }
function datasetValue(value) {
  equal(value.schemaId, 'navigation.collection', 'Admin reads authoritative navigation schema');
  check(Array.isArray(value.data?.links) && Array.isArray(value.data?.categories), 'Navigation contains arrays');
  return value;
}
function sortedRecords(data) {
  return {
    links: [...data.links].sort((a, b) => a.id.localeCompare(b.id)),
    categories: [...data.categories].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
async function readJson(relative) {
  const response = await context.request.get(endpoint(relative), { timeout: STEP_TIMEOUT, maxRedirects: 0 });
  check(response.ok(), `Read ${relative} returned HTTP ${response.status()}`);
  return response.json();
}
async function navigation() { return datasetValue(await readJson(`/spaces/${selectedSpace.id}/navigation`)); }
async function storedPage() { return readJson(`/spaces/${selectedSpace.id}/page`); }
async function mutation(method, relative, action) {
  const expected = '/api/v1' + relative;
  const [response] = await Promise.all([
    page.waitForResponse(value => value.request().method() === method && new URL(value.url()).pathname === expected, { timeout: STEP_TIMEOUT }),
    action(),
  ]);
  check(response.ok(), `${method} ${expected} returned HTTP ${response.status()}`);
  return response.status() === 204 ? null : response.json();
}
async function hidden(locator) { await locator.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT }); }
async function choose(control, label) {
  await control.click();
  const option = page.getByRole('option', { name: label, exact: true });
  equal(await option.count(), 1, `Select has one option named ${label}`);
  await option.click();
  await page.getByRole('listbox').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT });
  check((await control.textContent()).includes(label), `Select visibly retains ${label}`);
}
const panelNames = { 'builtin/category-navigation': '分类导航', 'builtin/search': '搜索框', 'builtin/favorites': '常用收藏', 'builtin/navigation': '导航链接', 'builtin/github-traffic': 'GitHub Traffic' };
async function inspectView(config, view) {
  const index = config.views.findIndex(item => item.id === view.id);
  await page.getByRole('button', { name: `配置 ${panelNames[view.panel.id] || view.panel.id} ${index + 1}`, exact: true }).click();
  const inspector = page.locator('.admin-view-inspector');
  equal(await inspector.count(), 1, 'Only the selected component inspector is rendered');
  return inspector;
}
async function restoreOriginalLayout() {
  if (!approvedDemo || !layoutOriginal) return;
  const current = await storedPage();
  if (isDeepStrictEqual(current.config, layoutOriginal.config) && current.name === layoutOriginal.name) { layoutOriginal = null; return; }
  equal(current.revision, layoutLastSavedRevision, 'Cleanup refuses to overwrite a concurrent page revision');
  const session = await readJson('/bootstrap');
  const response = await context.request.put(endpoint(`/spaces/${selectedSpace.id}/page`), {
    headers: { 'X-CSRF-TOKEN': session.csrfToken },
    data: { name: layoutOriginal.name, config: layoutOriginal.config, expectedRevision: current.revision }, timeout: STEP_TIMEOUT, maxRedirects: 0,
  });
  check(response.ok(), `Original-page cleanup returned HTTP ${response.status()}`);
  const restored = await response.json();
  equal(restored.config, layoutOriginal.config, 'Cleanup restores the entire original configuration');
  equal(restored.name, layoutOriginal.name, 'Cleanup restores the original page name');
  equal(await storedPage(), restored, 'Cleanup response matches persisted readback');
  emit({ event: 'cleanup', status: 'original-page-restored', method: 'revision-checked HTTP PUT', validationAction: false });
  layoutOriginal = null;
}
async function adminTab(label) {
  if (!(await page.locator('.admin-shell').isVisible())) {
    await page.getByRole('link', { name: '管理中心', exact: true }).click();
    await page.locator('.admin-main').waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
  }
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('heading', { name: label, level: 1, exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
}
async function home() {
  if (await page.locator('.admin-shell').isVisible()) await page.getByRole('button', { name: '返回导航', exact: true }).click();
  await page.locator('.lh-home').waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
  await page.locator('.lh-home-heading h1').waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
  await page.waitForFunction(() => {
    const match = document.querySelector('.lh-home-summary')?.textContent?.match(/(\d+) 个链接/);
    return !!match && document.querySelectorAll('.lh-bookmark').length >= Number(match[1]);
  }, null, { timeout: STEP_TIMEOUT });
}
function linkRow(title) { return page.getByRole('row').filter({ hasText: title }); }
async function assertNoPageErrors() { equal(pageErrors, [], 'Browser has no uncaught application errors'); }
async function screenshot(label) {
  if (!process.env.SCREENSHOT_DIR || !page) return null;
  const directory = path.resolve(process.env.SCREENSHOT_DIR);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `browser-smoke-${label}-${runId}.png`);
  await page.screenshot({ path: target, fullPage: true, timeout: STEP_TIMEOUT });
  return target;
}
async function runPhase(name, work) {
  activePhase = name;
  const begin = Date.now();
  const before = assertions;
  let timer;
  try {
    await Promise.race([
      work(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} exceeded its ${PHASE_TIMEOUT / 1000}s phase deadline`)), PHASE_TIMEOUT); }),
    ]);
    await assertNoPageErrors();
    const result = { phase: name, status: 'passed', assertions: assertions - before, elapsedMs: Date.now() - begin };
    results.push(result);
    emit({ event: 'phase', ...result });
  } finally { clearTimeout(timer); }
}

async function preflight() {
  check(argv.includes('--allow-demo-write'), 'Refusing writes: explicitly pass --allow-demo-write for the dedicated demo');
  check(allowedPhases.includes(phase), '--phase must be all, crud, bookmarks or layout');
  check(!!process.env.BASE_URL, 'BASE_URL must explicitly identify the dedicated preview instance');
  base = new URL(process.env.BASE_URL);
  check(['http:', 'https:'].includes(base.protocol), 'BASE_URL must use HTTP or HTTPS');
  check(!base.username && !base.password && !base.search && !base.hash, 'BASE_URL cannot contain credentials, query or fragment');
  check(base.pathname === '/', 'BASE_URL must identify the instance root, not an API or proxy subpath');
  check(base.port !== '5180', 'Port 5180 is reserved for the uninitialized main instance; use the dedicated preview');

  const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    timeout: STEP_TIMEOUT,
    args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'],
  });
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'zh-CN', timezoneId: 'UTC', reducedMotion: 'reduce' });
  context.setDefaultTimeout(STEP_TIMEOUT);
  context.setDefaultNavigationTimeout(STEP_TIMEOUT);
  const bootstrap = await readJson('/bootstrap');
  equal(bootstrap.initialized, true, 'Demo must already be initialized; this script never runs setup');
  equal(bootstrap.mode, 'open_edit', 'Demo must remain in open_edit mode');
  check(bootstrap.user == null, 'Demo browser must have no signed-in user');
  if ('hasOwner' in bootstrap) equal(bootstrap.hasOwner, false, 'Demo bootstrap cannot have an Owner');
  const settings = await readJson('/settings');
  equal(settings.mode, 'open_edit', 'Settings confirm open_edit mode');
  if ('hasOwner' in settings) equal(settings.hasOwner, false, 'Account-bearing instances are refused');
  check(Array.isArray(bootstrap.spaces), 'Bootstrap has accessible spaces');
  selectedSpace = bootstrap.spaces.find(space => space.id === bootstrap.defaultSpaceId);
  check(selectedSpace?.kind === 'shared' && selectedSpace.published && selectedSpace.canEdit, 'Default demo space is published shared and writable');
  approvedDemo = true;
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });
  // Test navigation never follows bookmarks or calls public services.
  await context.route('**/*', route => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort('blockedbyclient'));
  await page.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT });
  await home();
  const dataset = await navigation();
  const saved = await storedPage();
  equal(saved.config.schemaVersion, 2, 'Demo uses page Schema 2');
  check(saved.config.views.some(view => view.panel.id === 'builtin/navigation'), 'Demo includes a navigation panel');
  emit({ event: 'preflight', status: 'passed', origin: base.origin, mode: bootstrap.mode, ownerless: true, initialLinks: dataset.data.links.length, initialCategories: dataset.data.categories.length, viewport: '2560x1440' });
}

async function crud() {
  const before = await navigation();
  const title = `UI smoke ${runId}`;
  const editedTitle = `${title} edited`;
  const url = `https://example.invalid/browser-smoke/${runId}`;
  step('Create one unique synthetic link with two additional URLs through the dialog');
  await adminTab('链接管理');
  await page.getByRole('button', { name: '添加链接', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '添加链接', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
  await dialog.getByRole('textbox', { name: '链接名称', exact: true }).fill(title);
  await dialog.getByRole('textbox', { name: '主入口 URL', exact: true }).fill(url);
  await dialog.getByRole('textbox', { name: /^描述/ }).fill('Synthetic browser acceptance entry; removed after validation.');
  await dialog.getByRole('textbox', { name: /^标签/ }).fill('ui-smoke, multi-url');
  await dialog.getByRole('checkbox', { name: '加入常用收藏', exact: true }).check();
  for (const [index, label, address] of [[0, 'Docs', url + '/docs'], [1, 'Repository', url + '/repo']]) {
    await dialog.getByRole('button', { name: '添加入口', exact: true }).click();
    const endpointRow = dialog.locator('.admin-endpoint-row').filter({ has: page.getByRole('textbox', { name: `入口 ${index + 1} 名称`, exact: true }) });
    await endpointRow.getByRole('textbox', { name: `入口 ${index + 1} 名称`, exact: true }).fill(label);
    await endpointRow.getByRole('textbox', { name: '入口 URL', exact: true }).fill(address);
  }
  synthetic = { id: null, title, editedTitle };
  const created = await mutation('POST', `/spaces/${selectedSpace.id}/links`, () => dialog.getByRole('button', { name: '保存链接', exact: true }).click());
  synthetic.id = created.id;
  equal(created.title, title, 'Create response preserves the synthetic title');
  equal(created.endpoints, [{ label: 'Docs', url: url + '/docs' }, { label: 'Repository', url: url + '/repo' }], 'Both additional URLs persist');
  equal(created.isFavorite, true, 'Favorite checkbox persists');
  await hidden(dialog);
  await page.getByRole('searchbox', { name: '搜索链接列表', exact: true }).fill(title);
  await linkRow(title).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
  equal((await navigation()).data.links.length, before.data.links.length + 1, 'Exactly one local link was created');

  step('Edit the saved link and an additional URL, then inspect the rendered row');
  await linkRow(title).getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
  dialog = page.getByRole('dialog', { name: '编辑链接', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
  const secondEndpoint = dialog.locator('.admin-endpoint-row').filter({ has: page.getByRole('textbox', { name: '入口 2 名称', exact: true }) });
  equal(await secondEndpoint.getByRole('textbox', { name: '入口 2 名称', exact: true }).inputValue(), 'Repository', 'Editor reloads the saved second endpoint');
  await dialog.getByRole('textbox', { name: '链接名称', exact: true }).fill(editedTitle);
  await secondEndpoint.getByRole('textbox', { name: '入口 2 名称', exact: true }).fill('Source code');
  await secondEndpoint.getByRole('textbox', { name: '入口 URL', exact: true }).fill(url + '/source');
  const updated = await mutation('PUT', `/spaces/${selectedSpace.id}/links/${created.id}`, () => dialog.getByRole('button', { name: '保存链接', exact: true }).click());
  equal(updated.title, editedTitle, 'Title edit persisted');
  equal(updated.endpoints[1], { label: 'Source code', url: url + '/source' }, 'Endpoint edit persisted');
  await hidden(dialog);
  await linkRow(editedTitle).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
  equal(await linkRow(editedTitle).getByRole('link', { name: 'Source code', exact: true }).getAttribute('href'), url + '/source', 'Table exposes the edited endpoint');

  step('Delete only the unique synthetic link and confirm the original collection remains');
  await linkRow(editedTitle).getByRole('button', { name: `删除 ${editedTitle}`, exact: true }).click();
  dialog = page.getByRole('dialog', { name: '删除这个链接？', exact: true });
  await mutation('DELETE', `/spaces/${selectedSpace.id}/links/${created.id}`, () => dialog.getByRole('button', { name: '确认删除', exact: true }).click());
  await hidden(dialog);
  await hidden(linkRow(editedTitle));
  synthetic = null;
  const after = await navigation();
  equal(sortedRecords(after.data), sortedRecords(before.data), 'CRUD leaves all pre-existing navigation records untouched');
}

async function importFromFile(fixture, expectedTotal) {
  await adminTab('导入与导出');
  await page.getByRole('button', { name: '选择书签文件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入浏览器书签', exact: true });
  await dialog.locator('input[type="file"]').setInputFiles(fixture);
  await choose(dialog.getByRole('combobox', { name: '重复网址', exact: true }), '跳过重复项');
  const before = await navigation();
  const preview = await mutation('POST', `/spaces/${selectedSpace.id}/bookmarks/preview`, () => dialog.getByRole('button', { name: '预览文件', exact: true }).click());
  equal(preview.total, expectedTotal, 'Preview covers every public fixture link');
  equal(preview.valid, expectedTotal, 'All public fixture links are valid (duplicates are included)');
  equal(preview.invalid, 0, 'Fixture has no unsafe/invalid link');
  equal(preview.folders, 5, 'Preview recognizes all five fixture folders');
  await dialog.locator('.admin-import-counts').waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
  equal(await dialog.locator('.admin-import-counts strong').allTextContents(), [String(preview.total), String(preview.valid), String(preview.duplicates), String(preview.invalid)], 'Visible preview statistics match the actual response');
  const afterPreview = await navigation();
  equal(afterPreview.revision, before.revision, 'Preview does not advance navigation revision');
  equal(sortedRecords(afterPreview.data), sortedRecords(before.data), 'Preview does not create records');
  const result = await mutation('POST', `/spaces/${selectedSpace.id}/bookmarks/import`, () => dialog.getByRole('button', { name: '确认导入', exact: true }).click());
  equal(result.imported, preview.valid - preview.duplicates, 'Import inserts exactly the nonduplicate items');
  equal(result.skipped, preview.duplicates, 'Duplicate skip total is exact');
  equal(result.invalid, 0, 'Import remains valid');
  await hidden(dialog);
  const after = await navigation();
  equal(after.data.links.length, before.data.links.length + result.imported, 'Saved link count matches import receipt');
  equal(after.data.categories.length, before.data.categories.length + result.categoriesCreated, 'Saved category count matches import receipt');
  return { before, after, preview, result };
}
async function bookmarks() {
  const fixture = path.resolve(process.env.LINGSHU_DEMO_BOOKMARKS || path.join(__dirname, 'fixtures', 'demo-bookmarks.html'));
  const markup = fs.readFileSync(fixture, 'utf8');
  const expectedTotal = (markup.match(/<a\b/gi) || []).length;
  equal(expectedTotal, 43, 'Explicit demo fixture contains 43 public URLs');
  equal((markup.match(/<h3\b/gi) || []).length, 5, 'Explicit demo fixture contains five categories');
  step('Preview and import the explicit public bookmark fixture; retain it for screenshots');
  const first = await importFromFile(fixture, expectedTotal);
  step('Repeat preview/import with skip policy and verify there are no duplicate writes');
  const second = await importFromFile(fixture, expectedTotal);
  equal(second.preview.duplicates, expectedTotal, 'Second preview marks every fixture item as duplicate');
  equal(second.result.imported, 0, 'Second import inserts no duplicate links');
  equal(second.result.categoriesCreated, 0, 'Second import inserts no duplicate folders');
  equal(second.after.revision, first.after.revision, 'No-op duplicate import does not advance data revision');
  equal(sortedRecords(second.after.data), sortedRecords(first.after.data), 'Second import does not alter the first result');
  retainedDemo = { fixture: path.basename(fixture), fixtureLinks: expectedTotal, fixtureFolders: 5, newlyImported: first.result.imported, alreadyPresent: first.result.skipped, totalSavedLinks: second.after.data.links.length, totalSavedCategories: second.after.data.categories.length, intentionallyRetained: true };
  emit({ event: 'demo-retained', ...retainedDemo });
  await home();
}

async function saveLayout() {
  const result = await mutation('PUT', `/spaces/${selectedSpace.id}/page`, () => page.getByRole('button', { name: '保存页面', exact: true }).click());
  layoutLastSavedRevision = result.revision;
  const readback = await storedPage();
  equal(readback, result, 'Saved page DTO exactly matches persisted readback');
  return result;
}
async function layout() {
  const original = await storedPage();
  const originalNavigation = await navigation();
  const categories = original.config.views.filter(view => view.panel.id === 'builtin/category-navigation');
  equal(categories.length, 1, 'Demo has one category-navigation panel');
  const categoryId = categories[0].id;
  check(!original.config.layout.placements[categoryId].base.locked, 'Category-navigation panel must be editable in this demo');
  const renamed = `我的导航 · UI ${runId}`;
  layoutOriginal = original;
  try {
    step('Rename through layout settings and verify the name on the homepage');
    await adminTab('布局与主题');
    await page.getByRole('textbox', { name: '页面名称', exact: true }).fill(renamed);
    equal((await saveLayout()).name, renamed, 'Page name persists through the UI');
    await home();
    check((await page.locator('.lh-home-heading h1').textContent()).includes(renamed), 'Homepage displays the saved page name');
    const articleCount = await page.locator('.lh-bookmark').count();
    check(articleCount >= originalNavigation.data.links.length, 'Homepage renders local bookmarks');
    for (const [position, label, container] of [
      ['top', '顶部', '.lh-top-region'], ['right', '右侧', '.lh-right-region'],
      ['bottom', '底部', '.lh-bottom-region'], ['hidden', '隐藏', null], ['left', '左侧', '.lh-left-region'],
    ]) {
      step(`Move category navigation to ${position} using the visible position button`);
      await adminTab('布局与主题');
      const button = page.getByRole('button', { name: `分类导航${label}`, exact: true });
      await button.click();
      equal(await button.getAttribute('aria-pressed'), 'true', 'Selected category position is exposed accessibly');
      const changed = await saveLayout(), placement = changed.config.layout.placements[categoryId].base;
      equal(position === 'hidden' ? placement.kind : placement.region, position, 'Saved category position matches the selected button');
      await home();
      if (container) await page.locator(container).getByRole('navigation', { name: '导航分类', exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      else equal(await page.getByRole('navigation', { name: '导航分类', exact: true }).count(), 0, 'Hidden category navigation is absent');
      equal(await page.locator('.lh-bookmark').count(), articleCount, 'Position changes preserve bookmark entries');
      const after = await navigation();
      equal(after.revision, originalNavigation.revision, 'Layout changes do not advance navigation revision');
      equal(sortedRecords(after.data), sortedRecords(originalNavigation.data), 'Layout changes preserve business records');
    }
    for (const [variant, label] of [['directory', '目录'], ['cards', '卡片']]) {
      step(`Verify ${variant} via the selected component inspector`);
      await adminTab('布局与主题');
      await page.getByRole('tab', { name: /积木与数据绑定/ }).click();
      for (const view of original.config.views.filter(item => ['builtin/navigation', 'builtin/favorites'].includes(item.panel.id))) {
        const inspector = await inspectView(original.config, view);
        await choose(inspector.getByRole('combobox', { name: '展示变体', exact: true }), label);
      }
      await saveLayout();
      await home();
      equal(await page.locator('.lh-bookmark.is-directory').count(), variant === 'directory' ? articleCount : 0, `${variant} renders every bookmark`);
    }
    layoutResult = { categoryPositionsVerified: ['top', 'right', 'bottom', 'hidden', 'left'], variantsVerified: ['directory', 'cards'], navigationCount: originalNavigation.data.links.length };
  } finally { await restoreOriginalLayout(); }
  await page.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT });
  await home();
  equal((await storedPage()).config, original.config, 'Layout phase finishes with its full original configuration');
  equal(sortedRecords((await navigation()).data), sortedRecords(originalNavigation.data), 'Layout phase leaves business records untouched');
  layoutResult.originalConfigRestored = true;
}

async function cleanupSynthetic() {
  if (!approvedDemo || !synthetic || !page || page.isClosed()) return;
  step('Best-effort cleanup of this run\'s uniquely named synthetic link after failure');
  try {
    const existingDialog = page.getByRole('dialog');
    if (await existingDialog.count()) await page.keyboard.press('Escape');
    await home();
    await adminTab('链接管理');
    await page.getByLabel('搜索链接列表', { exact: true }).fill(`UI smoke ${runId}`);
    const row = linkRow(`UI smoke ${runId}`);
    await row.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    const removeButton = row.getByRole('button', { name: /^删除 UI smoke / });
    equal(await removeButton.count(), 1, 'Cleanup selects only this run\'s synthetic link');
    await removeButton.click();
    const dialog = page.getByRole('dialog', { name: '删除这个链接？', exact: true });
    const pending = page.waitForResponse(value => value.request().method() === 'DELETE' && new URL(value.url()).pathname.startsWith(`/api/v1/spaces/${selectedSpace.id}/links/`), { timeout: STEP_TIMEOUT });
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
    check((await pending).ok(), 'Synthetic cleanup succeeds');
    synthetic = null;
    emit({ event: 'cleanup', status: 'removed-synthetic-link' });
  } catch (error) { emit({ event: 'cleanup', status: 'failed', message: error.message.split('\n')[0], syntheticTitle: synthetic.title }); }
}

(async () => {
  try {
    await preflight();
    const work = { crud, bookmarks, layout };
    for (const name of phase === 'all' ? ['crud', 'bookmarks', 'layout'] : [phase]) await runPhase(name, work[name]);
    await home();
    await assertNoPageErrors();
    equal(consoleErrors, [], 'Browser has no console errors');
    const image = await screenshot(phase);
    emit({ event: 'summary', status: 'passed', phase, assertions, elapsedMs: Date.now() - startedAt, phases: results, retainedDemo, layout: layoutResult, pageErrors: 0, consoleErrors, screenshot: image, syntheticLinkRemoved: synthetic === null, note: 'Imported public demo bookmarks are intentionally retained for screenshots. No accounts were changed.' });
  } catch (error) {
    const image = await screenshot(`${activePhase}-failure`).catch(() => null);
    emit({ event: 'summary', status: 'failed', phase: activePhase, assertions, elapsedMs: Date.now() - startedAt, message: error.message, pageErrors, consoleErrors, screenshot: image, retainedDemo });
    await cleanupSynthetic();
    await restoreOriginalLayout().catch(error => emit({ event: 'cleanup', status: 'failed', message: error.message }));
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
})();
