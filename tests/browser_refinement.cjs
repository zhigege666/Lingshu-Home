#!/usr/bin/env node
'use strict';
/**
 * Real UI checks for the disposable ownerless demo on port 5182 only.
 * BASE_URL=http://demo-host:5182 node tests/browser_refinement.cjs --allow-demo-write --phase shell
 * Phases are independent. LINGSHU_PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE select a fresh browser.
 * Validation uses visible UI; only revision-guarded original-page cleanup may use HTTP PUT.
 * Synthetic records use this run's UUID and are removed through the admin UI in finally.
 * Never initializes, signs in, changes access settings, or visits bookmark destinations.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const STEP = 10_000;
const args = process.argv.slice(2);
function flag(name, fallback) { const inline = args.find(value => value.startsWith(name + '=')); const index = args.indexOf(name); return inline ? inline.slice(name.length + 1) : index >= 0 ? args[index + 1] : fallback; }
const selectedPhase = flag('--phase', 'shell');
const runId = randomUUID().slice(0, 12), started = Date.now();
const sizes = [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080], [768, 1024], [390, 844]];
const panelNames = { 'builtin/category-navigation': '分类导航', 'builtin/search': '搜索框', 'builtin/favorites': '常用收藏', 'builtin/navigation': '导航链接', 'builtin/github-traffic': 'GitHub Traffic' };
let browser, context, page, base, space, originalPage, originalNavigation, lastSavedRevision, approved = false;
let assertions = 0, active = 'preflight';
const errors = [], consoleErrors = [], nativeDialogs = [], writes = [], cleanups = [], results = [], synthetic = [];
function check(value, message) { assert.ok(value, message); assertions++; }
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); assertions++; }
function emit(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function step(label) { emit({ event: 'step', phase: active, label, elapsedMs: Date.now() - started }); }
const endpoint = relative => base.origin + '/api/v1' + relative;
async function read(relative) { const response = await context.request.get(endpoint(relative), { timeout: STEP, maxRedirects: 0 }); check(response.ok(), `GET ${relative}: HTTP ${response.status()}`); return response.json(); }
const readPage = () => read(`/spaces/${space.id}/page`);
const readNavigation = () => read(`/spaces/${space.id}/navigation`);
function records(dataset) { return { categories: [...dataset.data.categories].sort((a, b) => a.id.localeCompare(b.id)), links: [...dataset.data.links].sort((a, b) => a.id.localeCompare(b.id)) }; }
async function mutation(method, relative, action) {
  const [response] = await Promise.all([page.waitForResponse(value => value.request().method() === method && new URL(value.url()).pathname === '/api/v1' + relative, { timeout: STEP }), action()]);
  check(response.ok(), `${method} ${relative}: HTTP ${response.status()}`);
  const result = response.status() === 204 ? null : await response.json();
  if (method === 'PUT' && relative === `/spaces/${space.id}/page`) lastSavedRevision = result.revision;
  return result;
}
async function stable() {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}
async function dismiss() {
  for (let index = 0; index < 3 && (await page.getByRole('dialog').count() || await page.getByRole('listbox').count()); index++) await page.keyboard.press('Escape');
}
async function home(reload = false) {
  if (reload) await page.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded', timeout: STEP });
  else if (await page.locator('.admin-shell').isVisible()) await page.getByRole('button', { name: '返回导航', exact: true }).click();
  await page.locator('.lh-home-heading h1').waitFor({ state: 'visible', timeout: STEP });
  await page.waitForFunction(() => document.querySelectorAll('.lh-bookmark').length > 0, null, { timeout: STEP });
  await stable();
}
async function admin(label) {
  if (!(await page.locator('.admin-shell').isVisible())) {
    await home();
    await page.locator('.lh-more-trigger').click(); await page.getByRole('menuitem', { name: '管理中心', exact: true }).click();
    await page.locator('.admin-shell').waitFor({ state: 'visible', timeout: STEP });
  }
  await page.getByRole('navigation', { name: '管理菜单', exact: true }).getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('heading', { level: 1, name: label, exact: true }).waitFor({ state: 'visible', timeout: STEP });
  // The heading belongs to the shell and can precede its async content. Wait
  // for each page's usable controls before measuring; this also works for an
  // empty collection, where a table body is intentionally absent.
  if (label === '链接管理' || label === '分类管理') {
    const kind = label === '链接管理' ? '链接' : '分类';
    await page.getByRole('navigation', { name: `${kind}分页`, exact: true }).waitFor({ state: 'visible', timeout: STEP });
    await page.getByRole('searchbox', { name: `搜索${kind}列表`, exact: true }).waitFor({ state: 'visible', timeout: STEP });
  } else if (label === '布局与主题') {
    await page.locator('.admin-layout-savebar').waitFor({ state: 'visible', timeout: STEP });
  } else if (label === '导入与导出') {
    await page.getByRole('button', { name: '选择书签文件', exact: true }).waitFor({ state: 'visible', timeout: STEP });
  } else if (label === '访问与账号') {
    await page.getByRole('button', { name: '保存访问设置', exact: true }).waitFor({ state: 'visible', timeout: STEP });
  } else if (label === '数据源与 MCP') {
    await page.getByRole('tab', { name: '数据源', exact: true }).waitFor({ state: 'visible', timeout: STEP });
    await page.locator('.admin-page-body .admin-loading').waitFor({ state: 'hidden', timeout: STEP });
  }
  await stable();
}
async function choose(control, label) {
  await control.click();
  await page.getByRole('option', { name: label, exact: true }).click();
  await page.getByRole('listbox').waitFor({ state: 'hidden', timeout: STEP });
  check((await control.textContent()).includes(label), `Visible combobox retains ${label}`);
}
async function inspect(view, config = originalPage.config) {
  await page.getByRole('tab', { name: /积木与数据绑定/ }).click();
  const index = config.views.findIndex(item => item.id === view.id);
  check(index >= 0, 'The intended component exists in the saved page');
  await page.getByRole('button', { name: `配置 ${panelNames[view.panel.id] || view.panel.id} ${index + 1}`, exact: true }).click();
  const inspector = page.locator('.admin-view-inspector');
  equal(await inspector.count(), 1, 'Only the selected component inspector is mounted');
  return inspector;
}
async function savePage() {
  const saved = await mutation('PUT', `/spaces/${space.id}/page`, () => page.getByRole('button', { name: '保存页面', exact: true }).click());
  equal(await readPage(), saved, 'Saved page response exactly matches persisted readback');
  return saved;
}
async function frame(label) {
  const report = await page.evaluate(() => {
    const rect = selector => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; };
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight, bodyWidth: document.body.scrollWidth, bodyHeight: document.body.scrollHeight, scrollY, listPage: !!document.querySelector('.admin-page-body-list'), header: rect('.admin-topbar'), heading: rect('.admin-page-heading'), body: rect('.admin-page-body'), pager: rect('.admin-pagination'), save: rect('.admin-layout-savebar') };
  });
  check(report.documentWidth <= report.width + 1 && report.bodyWidth <= report.width + 1, `${label}: document has no horizontal overflow`);
  check(report.documentHeight <= report.height + 1 && report.bodyHeight <= report.height + 1, `${label}: document has no vertical overflow`);
  equal(report.scrollY, 0, `${label}: document itself does not scroll`);
  if (report.listPage) check(!!report.pager && report.pager.height > 0, `${label}: loaded list includes usable pagination`);
  for (const [name, rectangle] of Object.entries({ header: report.header, heading: report.heading, pager: report.pager, save: report.save })) if (rectangle) check(rectangle.y >= -1 && rectangle.bottom <= report.height + 1, `${label}: ${name} stays within the viewport`);
  check(report.body?.height > 40, `${label}: active content has usable space`);
  return report;
}
async function screenshot(name) {
  if (!process.env.SCREENSHOT_DIR) return null;
  const directory = path.resolve(process.env.SCREENSHOT_DIR); fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `refinement-${name}.png`);
  await page.screenshot({ path: target, fullPage: true, animations: 'disabled', timeout: STEP }); return target;
}
function observe(target) {
  target.on('pageerror', error => errors.push(error.message));
  target.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });
  target.on('dialog', dialog => { nativeDialogs.push(dialog.type()); void dialog.dismiss(); });
  target.on('request', request => { const url = new URL(request.url()); if (url.origin === base.origin && url.pathname.startsWith('/api/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname }); });
}
async function preflight() {
  check(args.includes('--allow-demo-write'), 'Use --allow-demo-write only for the disposable demo');
  check(!!process.env.BASE_URL, 'BASE_URL must explicitly identify the disposable demo');
  base = new URL(process.env.BASE_URL);
  check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Use a plain HTTP(S) instance root without credentials');
  equal(base.port, '5182', 'Only dedicated demo port 5182 is permitted; main 5180 is never touched');
  const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, timeout: STEP, args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'] });
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'zh-CN', timezoneId: 'UTC', reducedMotion: 'reduce' });
  context.setDefaultTimeout(STEP); context.setDefaultNavigationTimeout(STEP);
  const bootstrap = await read('/bootstrap'), settings = await read('/settings');
  equal(bootstrap.initialized, true, 'Demo is already initialized'); equal(bootstrap.mode, 'open_edit', 'Demo mode is open_edit');
  check(bootstrap.user == null, 'Fresh test browser has no account'); equal(settings.mode, 'open_edit', 'Settings confirm open_edit'); equal(settings.hasOwner, false, 'Account-bearing targets are refused');
  space = bootstrap.spaces.find(item => item.id === bootstrap.defaultSpaceId);
  check(space?.kind === 'shared' && space.published && space.canEdit, 'Default space is writable published shared data');
  originalPage = await readPage(); originalNavigation = await readNavigation();
  equal(originalPage.config.schemaVersion, 2, 'Page uses Schema 2'); check(originalNavigation.data.links.length > 0, 'Demo has existing fixture links');
  approved = true;
  await context.route('**/*', route => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort('blockedbyclient'));
  await context.addInitScript(() => {
    window.__refinementInvalid = [];
    // Retain native events, then inspect them after the user action has finished.
    // A microtask in a document capture listener can run before React's later
    // root listener during browser-initiated dispatch and snapshot a stale flag.
    document.addEventListener('invalid', event => { window.__refinementInvalid.push({ id: event.target.id, event }); }, true);
  });
  page = await context.newPage(); observe(page); await home(true);
  emit({ event: 'preflight', status: 'passed', origin: base.origin, ownerless: true, links: originalNavigation.data.links.length, categories: originalNavigation.data.categories.length });
}
async function restorePage() {
  if (!approved || !lastSavedRevision) return;
  const current = await readPage();
  if (current.name === originalPage.name && isDeepStrictEqual(current.config, originalPage.config)) return;
  equal(current.revision, lastSavedRevision, 'Cleanup refuses to overwrite another writer’s page revision');
  const bootstrap = await read('/bootstrap');
  const response = await context.request.put(endpoint(`/spaces/${space.id}/page`), { headers: { 'X-CSRF-TOKEN': bootstrap.csrfToken }, data: { name: originalPage.name, config: originalPage.config, expectedRevision: current.revision }, timeout: STEP, maxRedirects: 0 });
  check(response.ok(), `Original page cleanup: HTTP ${response.status()}`);
  const restored = await response.json(); equal(restored.config, originalPage.config, 'Cleanup restores the exact original config'); equal(restored.name, originalPage.name, 'Cleanup restores the original name'); equal(await readPage(), restored, 'Cleanup readback is exact');
  lastSavedRevision = restored.revision;
  const item = { kind: 'page', method: 'revision-checked HTTP PUT', validationAction: false, originalConfigRestored: true }; cleanups.push(item); emit({ event: 'cleanup', ...item });
}
async function removeSynthetic(record) {
  const dataset = await readNavigation();
  const current = (record.kind === 'links' ? dataset.data.links : dataset.data.categories).find(item => item.id === record.id);
  if (!current) { synthetic.splice(synthetic.indexOf(record), 1); return; }
  equal(record.kind === 'links' ? current.title : current.name, record.name, 'Cleanup checks the exact UUID-owned record name and ID');
  await dismiss(); await home(true); await admin(record.kind === 'links' ? '链接管理' : '分类管理');
  await page.getByRole('searchbox', { name: record.kind === 'links' ? '搜索链接列表' : '搜索分类列表', exact: true }).fill(record.name);
  const label = record.kind === 'links' ? `删除 ${record.name}` : `删除分类 ${record.name}`;
  await page.getByRole('button', { name: label, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: record.kind === 'links' ? '删除这个链接？' : '删除这个分类？', exact: true });
  await mutation('DELETE', `/spaces/${space.id}/${record.kind}/${record.id}`, () => dialog.getByRole('button', { name: '确认删除', exact: true }).click());
  await dialog.waitFor({ state: 'hidden', timeout: STEP }); synthetic.splice(synthetic.indexOf(record), 1);
  const item = { kind: record.kind, method: 'visible admin UI', syntheticId: record.id, removed: true }; cleanups.push(item); emit({ event: 'cleanup', ...item });
}
async function cleanup() {
  if (!approved || !page || page.isClosed()) return;
  await dismiss();
  await restorePage();
  for (const record of [...synthetic].reverse()) await removeSynthetic(record);
}

async function shell() {
  step('Check every available admin section in its bounded viewport');
  const writeStart = writes.length;
  await page.setViewportSize({ width: 1600, height: 900 });
  for (const label of ['链接管理', '分类管理', '布局与主题', '导入与导出', '数据源与 MCP', '访问与账号', '关于 Home']) {
    await admin(label); const report = await frame(label);
    check(!(await page.locator('body').textContent()).includes('HOME / SETTINGS'), 'Decorative HOME / SETTINGS eyebrow is absent');
    if (label === '布局与主题') {
      await page.getByRole('tab', { name: /积木与数据绑定/ }).click();
      equal(await page.locator('.admin-view-inspector').count(), 1, 'Composition renders one inspector instead of every long form');
      equal(await page.locator('.admin-component-item').count(), originalPage.config.views.length, 'Component list keeps every page component reachable');
      await frame('积木检查器');
    }
    emit({ event: 'admin-frame', section: label, ...report });
  }
  step('Exercise bounded table pages and scroll without moving headings or pagination');
  await admin('链接管理');
  const pager = page.getByRole('navigation', { name: '链接分页', exact: true }), rows = page.locator('.admin-table-scroll tbody tr');
  equal(await rows.count(), Math.min(25, originalNavigation.data.links.length), 'First page renders at most 25 rows');
  check(await pager.getByRole('button', { name: '链接上一页', exact: true }).isDisabled(), 'Previous is disabled on the first page');
  check(await pager.getByRole('button', { name: '链接第一页', exact: true }).isDisabled(), 'First is disabled on the first page');
  const rowHeights = await rows.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
  check(rowHeights.every(height => height >= 40 && height <= 66), `Rows remain compact: ${Math.min(...rowHeights)}–${Math.max(...rowHeights)} px`);
  if (originalNavigation.data.links.length > 25) {
    await pager.getByRole('button', { name: '链接最后一页', exact: true }).click();
    equal(await rows.count(), originalNavigation.data.links.length % 25 || 25, 'Final page renders only its remaining records');
    check(await pager.getByRole('button', { name: '链接下一页', exact: true }).isDisabled(), 'Next is disabled on the final page');
    check(await pager.getByRole('button', { name: '链接最后一页', exact: true }).isDisabled(), 'Last is disabled on the final page');
    await pager.getByRole('button', { name: '链接第一页', exact: true }).click();
  }
  await choose(pager.getByRole('combobox', { name: '链接每页条数', exact: true }), '50 条 / 页');
  equal(await rows.count(), Math.min(50, originalNavigation.data.links.length), 'Changing page size uses the selected row bound');
  const before = await frame('滚动前');
  const scroller = page.getByRole('region', { name: '链接列表', exact: true });
  const box = await scroller.boundingBox(); check(!!box, 'Table scroll viewport is measurable');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, 700);
  await page.waitForFunction(() => document.querySelector('.admin-table-scroll').scrollTop > 0, null, { timeout: STEP });
  const after = await frame('滚动后'); equal(after.header, before.header, 'Table scrolling preserves header position'); equal(after.heading, before.heading, 'Table scrolling preserves page heading position'); equal(after.pager, before.pager, 'Table scrolling preserves pagination position');
  await choose(pager.getByRole('combobox', { name: '链接每页条数', exact: true }), '25 条 / 页');
  equal(await scroller.evaluate(node => node.scrollTop), 0, 'Changing page size resets only table scrolling');
  await page.getByRole('searchbox', { name: '搜索链接列表', exact: true }).fill(`missing-${runId}`);
  equal(await rows.count(), 0, 'A zero-result filter renders no stale table rows');
  equal((await pager.getByRole('status').textContent()).trim(), '0 条', 'Empty result count remains explicit');
  check(await pager.getByRole('button', { name: '链接下一页', exact: true }).isDisabled(), 'Empty results cannot advance beyond page one');
  await page.getByRole('searchbox', { name: '搜索链接列表', exact: true }).fill('');
  equal(writes.slice(writeStart), [], 'Admin section changes, pagination and scrolling make no API writes');
  equal(await readPage(), originalPage, 'Read-only shell checks preserve the complete original page');
  equal(records(await readNavigation()), records(originalNavigation), 'Read-only shell checks preserve every business record');
  await screenshot('admin-links');
}

async function forms() {
  step('Check styled controls, keyboard navigation, validation and optional empty selections');
  await page.setViewportSize({ width: 1600, height: 900 }); await admin('链接管理');
  await page.getByRole('button', { name: '添加链接', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加链接', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: STEP });
  const title = dialog.getByRole('textbox', { name: '链接名称', exact: true }), url = dialog.getByRole('textbox', { name: '主入口 URL', exact: true });
  await dialog.getByRole('button', { name: '保存链接', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '链接名称' }).waitFor({ state: 'visible', timeout: STEP });
  check(await title.evaluate(node => node === document.activeElement), 'First invalid required input receives focus');
  const name = `UI refinement ${runId} link`;
  await title.fill(name); await url.fill('not-a-valid-url');
  await dialog.getByRole('button', { name: '保存链接', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '主入口 URL' }).waitFor({ state: 'visible', timeout: STEP });
  check(await url.evaluate(node => node === document.activeElement), 'Invalid URL receives focus with an inline error');
  const invalidEvents = await page.evaluate(() => window.__refinementInvalid.map(({ id, event }) => ({ id, prevented: event.defaultPrevented, phase: event.eventPhase, cancelable: event.cancelable })));
  check(invalidEvents.every(event => event.phase === 0 && event.cancelable), 'Validation is observed only after native event dispatch has completed');
  check(invalidEvents.length >= 2 && invalidEvents.every(event => event.prevented), 'HTML validation events are cancelled so system bubbles do not appear');
  const category = dialog.getByRole('combobox', { name: '分类', exact: true });
  check((await category.textContent()).includes('未分类'), 'Optional empty category is visibly labelled');
  await category.focus(); await category.press('ArrowDown');
  const listbox = page.getByRole('listbox'); await listbox.waitFor({ state: 'visible', timeout: STEP });
  check(await page.getByRole('option', { name: '未分类', exact: true }).isVisible(), 'Keyboard opens the project-rendered option list');
  const popup = await listbox.boundingBox(); check(!!popup && popup.y >= 0 && popup.y + popup.height <= 900, 'Portal remains inside the visible viewport');
  const hit = await listbox.evaluate(node => { const r = node.getBoundingClientRect(); const target = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(12, r.height / 2)); return !!target && node.contains(target); });
  check(hit, 'Dialog clipping does not cover the option list hit target');
  equal(await listbox.evaluate(node => getComputedStyle(node).colorScheme), 'light', 'Admin Portal retains an explicit light palette');
  await page.keyboard.press('Escape'); await listbox.waitFor({ state: 'hidden', timeout: STEP });
  await page.waitForFunction(id => document.activeElement?.id === id, await category.getAttribute('id'), { timeout: STEP });
  check(await category.evaluate(node => node === document.activeElement), 'Escape returns focus to the combobox');
  check(await dialog.isVisible(), 'Escape closes the select without closing its surrounding dialog');
  if (originalNavigation.data.categories.length) {
    await category.press('ArrowDown'); await listbox.waitFor({ state: 'visible', timeout: STEP });
    // Portal visibility precedes Radix's focus effect. Start the navigation only
    // once the checked option owns focus, then observe the next focused option.
    await page.waitForFunction(() => {
      const focused = document.activeElement;
      return focused?.getAttribute('role') === 'option' && focused.getAttribute('data-state') === 'checked' && focused.textContent.trim() === '未分类';
    }, null, { timeout: STEP });
    const expectedNextLabel = await listbox.getByRole('option').evaluateAll(options => {
      const current = options.findIndex(option => option === document.activeElement);
      return options.slice(current + 1).find(option => option.getAttribute('aria-disabled') !== 'true')?.textContent.trim();
    });
    check(!!expectedNextLabel && expectedNextLabel !== '未分类', 'The visible option order provides a next enabled category');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(expected => {
      const focused = document.activeElement;
      return focused?.getAttribute('role') === 'option' && focused.textContent.trim() === expected && focused.getAttribute('aria-disabled') !== 'true';
    }, expectedNextLabel, { timeout: STEP });
    const focusedLabel = await page.evaluate(() => document.activeElement.textContent.trim());
    const selectedCategory = originalNavigation.data.categories.find(item => categoryPath(item, originalNavigation.data.categories) === focusedLabel);
    check(!!selectedCategory, 'ArrowDown focuses an actual saved category option');
    await page.keyboard.press('Enter');
    await listbox.waitFor({ state: 'hidden', timeout: STEP });
    await page.waitForFunction(id => document.activeElement?.id === id, await category.getAttribute('id'), { timeout: STEP });
    check(await category.evaluate(node => node === document.activeElement), 'Enter restores focus to the originating combobox');
    check(!(await category.textContent()).includes('未分类'), 'ArrowDown and Enter select another real category');
    check((await category.textContent()).includes(focusedLabel), 'Enter selects the option that actually held keyboard focus');
    equal(await dialog.locator('form').evaluate(form => new FormData(form).get('categoryId')), selectedCategory.id, 'Keyboard-selected category preserves its actual FormData ID');
    await choose(category, '未分类');
  }
  equal(await dialog.locator('form').evaluate(form => new FormData(form).get('categoryId')), '', 'Named FormData preserves empty string instead of the internal Radix sentinel');
  const favorite = dialog.getByRole('checkbox', { name: '加入常用收藏', exact: true });
  await favorite.focus(); await favorite.press('Space'); check(await favorite.isChecked(), 'Space toggles the styled checkbox');
  await favorite.press('Space'); check(!(await favorite.isChecked()), 'Space restores the unchecked checkbox');
  const native = await dialog.evaluate(node => [...node.querySelectorAll('select,input[type=checkbox],input[type=file]')].filter(element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect(); return !element.hidden && element.getAttribute('aria-hidden') !== 'true' && style.opacity !== '0' && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 2 && rect.height > 2;
  }).map(element => element.tagName + ':' + element.type));
  equal(native, [], 'No visible system select, checkbox or file control remains in the dialog');
  const writeCount = writes.length;
  await url.fill(`https://example.invalid/refinement/${runId}`);
  const created = await mutation('POST', `/spaces/${space.id}/links`, () => dialog.getByRole('button', { name: '保存链接', exact: true }).click());
  synthetic.push({ kind: 'links', id: created.id, name });
  equal(created.categoryId, null, 'Actual UI save preserves an optional empty category as null'); equal(created.isFavorite, false, 'Keyboard checkbox roundtrip preserves the final unchecked state');
  await dialog.waitFor({ state: 'hidden', timeout: STEP });
  equal(writes.length, writeCount + 1, 'Only the final valid submit creates a link');
  await removeSynthetic(synthetic[synthetic.length - 1]);
  await admin('分类管理'); await page.getByRole('button', { name: '添加分类', exact: true }).click();
  const categoryDialog = page.getByRole('dialog', { name: '添加分类', exact: true });
  await choose(categoryDialog.getByRole('combobox', { name: '父分类', exact: true }), '顶层分类');
  equal(await categoryDialog.locator('form').evaluate(form => new FormData(form).get('parentId')), '', 'Top-level category keeps empty parent FormData');
  await categoryDialog.getByRole('button', { name: '取消', exact: true }).click();
  await admin('导入与导出'); await page.getByRole('button', { name: '选择书签文件', exact: true }).click();
  const importer = page.getByRole('dialog', { name: '导入浏览器书签', exact: true });
  check(!(await importer.locator('input[type=file]').isVisible()), 'Native file field stays hidden');
  await importer.locator('input[type=file]').setInputFiles(path.join(__dirname, 'fixtures', 'demo-bookmarks.html'));
  await importer.getByText('demo-bookmarks.html', { exact: true }).waitFor({ state: 'visible', timeout: STEP });
  await choose(importer.getByRole('combobox', { name: '导入到分类', exact: true }), '根目录');
  await importer.getByRole('button', { name: '取消', exact: true }).click();
  equal(records(await readNavigation()), records(originalNavigation), 'Form checks restore every original link and category exactly');
  equal(await readPage(), originalPage, 'Form validation and file selection do not change layout');
}

async function createCategory(name, parentLabel) {
  await admin('分类管理'); await page.getByRole('button', { name: '添加分类', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加分类', exact: true });
  await dialog.getByRole('textbox', { name: '分类名称', exact: true }).fill(name);
  if (parentLabel) await choose(dialog.getByRole('combobox', { name: '父分类', exact: true }), parentLabel);
  const created = await mutation('POST', `/spaces/${space.id}/categories`, () => dialog.getByRole('button', { name: '保存分类', exact: true }).click());
  synthetic.push({ kind: 'categories', id: created.id, name });
  await dialog.waitFor({ state: 'hidden', timeout: STEP }); return created;
}
function categoryPath(category, categories) {
  const names = [category.name], seen = new Set([category.id]); let parentId = category.parentId;
  while (parentId && !seen.has(parentId)) { seen.add(parentId); const parent = categories.find(item => item.id === parentId); if (!parent) break; names.unshift(parent.name); parentId = parent.parentId; }
  return names.join(' / ');
}
async function categoryConfig(view, { mode = 'icon-text', hierarchy = 'tree', counts = true, collapsible = true, defaultCollapsed = false } = {}) {
  await admin('布局与主题'); const inspector = await inspect(view);
  await choose(inspector.getByRole('combobox', { name: '分类显示模式', exact: true }), { 'icon-text': '图标 + 文字', icons: '纯图标', text: '纯文字' }[mode]);
  await choose(inspector.getByRole('combobox', { name: '分类层级', exact: true }), hierarchy === 'tree' ? '树形层级' : '平铺分类');
  await inspector.getByRole('checkbox', { name: '显示链接数量', exact: true }).setChecked(counts);
  if (mode !== 'icons') {
    await inspector.getByRole('checkbox', { name: '允许收起为图标', exact: true }).setChecked(collapsible);
    if (collapsible) await inspector.getByRole('checkbox', { name: '默认收起为图标', exact: true }).setChecked(defaultCollapsed);
  } else {
    check(await inspector.getByRole('checkbox', { name: '允许收起为图标', exact: true }).isDisabled(), 'Always-icon mode disables an inapplicable collapse setting');
    check(await inspector.getByRole('checkbox', { name: '默认收起为图标', exact: true }).isDisabled(), 'Always-icon mode disables inapplicable default collapse');
  }
  const saved = await savePage(), settings = saved.config.views.find(item => item.id === view.id).settings;
  equal(settings.displayMode || 'icon-text', mode, 'Saved category display mode matches the chosen UI');
  equal(settings.hierarchyMode || 'tree', hierarchy, 'Saved category hierarchy matches the chosen UI');
  equal(settings.showCounts ?? true, counts, 'Saved category count visibility matches the checkbox');
  await home(); return saved;
}
async function independentCategoryTab(expectedCollapsed, key) {
  const isolated = await context.newPage(); observe(isolated);
  try {
    await isolated.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded', timeout: STEP });
    const nav = isolated.getByRole('navigation', { name: '导航分类', exact: true }); await nav.waitFor({ state: 'visible', timeout: STEP });
    equal(await nav.evaluate(node => node.classList.contains('is-collapsed')), expectedCollapsed, 'A new independent tab uses the saved default, not another tab’s temporary collapse');
    equal(await isolated.evaluate(storageKey => sessionStorage.getItem(storageKey), key), null, 'Independent tab has no inherited temporary category-panel preference');
  } finally { await isolated.close(); }
}
async function categories() {
  step('Configure three category modes and exercise saved defaults versus tab-local browsing state');
  await page.setViewportSize({ width: 1600, height: 900 });
  const categoryViews = originalPage.config.views.filter(view => view.panel.id === 'builtin/category-navigation');
  equal(categoryViews.length, 1, 'Demo has one category-navigation panel');
  const view = categoryViews[0], placement = originalPage.config.layout.placements[view.id].base;
  check(placement.kind === 'hidden' || !placement.locked, 'Demo category-navigation placement is editable');
  try {
    let data = (await readNavigation()).data;
    let child = data.categories.find(category => category.parentId && data.categories.some(parent => parent.id === category.parentId));
    if (!child) {
      step('Create only this run’s temporary parent/child fixture through the category dialogs');
      const parent = await createCategory(`UI refinement ${runId} parent`);
      child = await createCategory(`UI refinement ${runId} child`, parent.name);
      equal(child.parentId, parent.id, 'Category editor saves the intended parent');
      data = (await readNavigation()).data;
    }
    const parent = data.categories.find(category => category.id === child.parentId);
    const parentPath = categoryPath(parent, data.categories), childPath = categoryPath(child, data.categories);
    await admin('布局与主题');
    await page.getByRole('button', { name: '分类导航左侧', exact: true }).click(); await savePage();
    await home();
    const saved = await categoryConfig(view);
    const nav = page.getByRole('navigation', { name: '导航分类', exact: true });
    check(await nav.evaluate(node => node.classList.contains('is-icon-text')), 'Icon + text mode is rendered');
    check(await nav.locator('.lh-category-select > img,.lh-category-select > svg').count() > 0, 'Icon + text mode renders icons');
    const sidebar = page.locator('.lh-left-region'), expandedWidth = (await sidebar.boundingBox()).width;
    await nav.getByRole('button', { name: '收起分类导航', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.lh-categories')?.classList.contains('is-collapsed'), null, { timeout: STEP });
    const collapsedWidth = (await sidebar.boundingBox()).width;
    check(collapsedWidth < expandedWidth, `Collapsed sidebar becomes narrower: ${expandedWidth} → ${collapsedWidth} px`);
    equal(await nav.getByRole('button', { name: '展开分类导航', exact: true }).getAttribute('aria-expanded'), 'false', 'Collapsed navigation exposes the correct expanded state');
    equal(await readPage(), saved, 'Temporary collapsing never writes the saved page');
    const sessionKey = `lh:category-panels:${saved.id}`;
    const panelState = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), sessionKey);
    equal(Object.keys(panelState), [view.id], 'Panel preference is scoped to the current page and exact view ID'); equal(panelState[view.id], true, 'Only the current panel is collapsed');
    await home(true);
    check(await nav.evaluate(node => node.classList.contains('is-collapsed')), 'Same-tab reload retains temporary collapse');
    await independentCategoryTab(false, sessionKey);
    await nav.getByRole('button', { name: '展开分类导航', exact: true }).click();
    check(!(await nav.evaluate(node => node.classList.contains('is-collapsed'))), 'Expand restores the original category mode');

    step('Collapse a real parent branch, reload, and keep selected descendants reachable');
    const collapseBranch = nav.getByRole('button', { name: `收起 ${parentPath} 的子分类`, exact: true });
    await collapseBranch.click();
    const expandBranch = nav.getByRole('button', { name: `展开 ${parentPath} 的子分类`, exact: true });
    equal(await expandBranch.getAttribute('aria-expanded'), 'false', 'Parent branch is actually collapsed');
    equal(await nav.getByRole('button', { name: childPath, exact: true }).count(), 0, 'Collapsed branch removes hidden descendants from the selectable list');
    await home(true);
    equal(await expandBranch.getAttribute('aria-expanded'), 'false', 'Same-tab reload retains parent-branch state');
    await expandBranch.click();
    await nav.getByRole('button', { name: childPath, exact: true }).click();
    equal(await collapseBranch.getAttribute('aria-disabled'), 'true', 'A parent of the active descendant cannot hide that selection');
    equal(await collapseBranch.getAttribute('aria-expanded'), 'true', 'Active descendant remains expanded and reachable');
    await nav.getByRole('button', { name: '全部链接', exact: true }).click();
    equal(await readPage(), saved, 'Branch navigation and filtering never mutate page config');

    step('Render icon-only navigation with accessible names and visible tooltips');
    await categoryConfig(view, { mode: 'icons', hierarchy: 'tree', counts: false });
    check(await nav.evaluate(node => node.classList.contains('is-icons')), 'Pure icon mode is rendered');
    equal(await nav.locator('.lh-category-collapse').count(), 0, 'Always-icon mode does not expose a meaningless collapse button');
    equal(await nav.locator('.lh-category-select b').count(), 0, 'Count-off configuration removes category count badges');
    const parentButton = nav.getByRole('button', { name: parentPath, exact: true });
    await parentButton.focus();
    const tooltip = page.locator('.lh-category-tooltip'); await tooltip.waitFor({ state: 'visible', timeout: STEP });
    check((await tooltip.textContent()).includes(parentPath), 'Keyboard focus exposes a human-readable category tooltip');
    await page.keyboard.press('Escape');
    check(await nav.locator('.lh-category-name').first().evaluate(node => node.getBoundingClientRect().width <= 1), 'Pure-icon labels are visually hidden while accessible names remain');
    await screenshot('categories-icons');

    step('Render pure text, flat paths, and a saved collapsed default');
    await categoryConfig(view, { mode: 'text', hierarchy: 'flat', counts: false, defaultCollapsed: false });
    check(await nav.evaluate(node => node.classList.contains('is-text')), 'Pure text mode is rendered');
    equal(await nav.locator('.lh-category-select > img,.lh-category-select > svg').count(), 0, 'Pure-text category buttons do not render decorative icons');
    equal(await nav.locator('.lh-category-disclosure').count(), 0, 'Flat categories do not present tree disclosure buttons');
    check((await nav.getByRole('button', { name: childPath, exact: true }).textContent()).includes(childPath), 'Flat mode displays full parent/child paths');
    await screenshot('categories-text');
    await categoryConfig(view, { mode: 'icon-text', hierarchy: 'tree', defaultCollapsed: true });
    await independentCategoryTab(true, sessionKey);
    equal(records(await readNavigation()).links, records(originalNavigation).links, 'Category presentation tests do not alter any pre-existing links');
  } finally {
    await restorePage();
    for (const record of [...synthetic].reverse()) if (record.kind === 'categories') await removeSynthetic(record);
    await home(true);
  }
  equal((await readPage()).config, originalPage.config, 'Category checks restore all original settings including omitted legacy defaults');
  equal(records(await readNavigation()), records(originalNavigation), 'Temporary hierarchy fixtures are removed and all original business records remain exact');
}

async function horizontalCategories(width, height) {
  if (width > 768) return [];
  const lists = page.locator('.lh-categories.is-horizontal .lh-category-list'), reports = [], writeStart = writes.length;
  for (let index = 0; index < await lists.count(); index++) {
    const list = lists.nth(index);
    if (!(await list.evaluate(node => node.scrollWidth > node.clientWidth + 2))) continue;
    step(`Scroll overflowing category list ${index + 1} at ${width}x${height}`);
    const nav = page.locator('.lh-categories.is-horizontal').nth(index);
    const backward = nav.getByRole('button', { name: '向前滚动分类', exact: true });
    const forward = nav.getByRole('button', { name: '向后滚动分类', exact: true });
    // Overflow is measured by ResizeObserver + rAF; visible list content can
    // precede its scroll buttons. Wait for the actual affordances before use.
    await backward.waitFor({ state: 'visible', timeout: STEP });
    await forward.waitFor({ state: 'visible', timeout: STEP });
    const measure = () => list.evaluate(node => ({ scrollLeft: node.scrollLeft, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
      viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, scrollX }));
    const before = await measure();
    check(before.scrollWidth > before.clientWidth + 2, 'Category overflow belongs to the inner list');
    check(before.scrollLeft <= 1, 'Fresh category list begins at its leading edge');
    check(await backward.isDisabled(), 'Backward category scroll is disabled at the leading edge');
    await forward.click();
    await page.waitForFunction(({ index, left }) => document.querySelectorAll('.lh-categories.is-horizontal .lh-category-list')[index]?.scrollLeft > left + 1,
      { index, left: before.scrollLeft }, { timeout: STEP });
    const after = await measure();
    check(after.scrollLeft > before.scrollLeft + 1, 'Clicking forward moves the real category list');
    check(after.documentWidth <= after.viewportWidth + 1 && after.bodyWidth <= after.viewportWidth + 1 && after.scrollX === 0, 'Category scrolling does not overflow or move the page horizontally');
    await backward.click();
    await page.waitForFunction(({ index, left }) => document.querySelectorAll('.lh-categories.is-horizontal .lh-category-list')[index]?.scrollLeft <= left + 1,
      { index, left: before.scrollLeft }, { timeout: STEP });
    const restored = await measure();
    check(Math.abs(restored.scrollLeft - before.scrollLeft) <= 1, 'Clicking backward restores the category list leading edge');
    check(restored.documentWidth <= restored.viewportWidth + 1 && restored.bodyWidth <= restored.viewportWidth + 1 && restored.scrollX === 0, 'Returning to the first categories keeps the page within its width');
    equal(writes.slice(writeStart), [], 'Category scroll controls make no API writes');
    reports.push({ listIndex: index, before, after, restored });
  }
  if (width === 390) check(reports.length > 0, 'The phone viewport exercises a genuinely overflowing category list');
  return reports;
}

async function viewport() {
  step('Check header controls and fixed admin frames at all six target sizes');
  const before = await readPage(), writeStart = writes.length;
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height }); await home(true);
    const report = await page.evaluate(() => {
      const header = document.querySelector('.lh-header'), r = header.getBoundingClientRect();
      const nodes = [...header.querySelectorAll('button,a,input')].filter(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 1 && rect.height > 1; });
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, headerHeight: r.height,
        controls: nodes.map(node => { const b = node.getBoundingClientRect(); return { label: node.getAttribute('aria-label') || node.textContent.trim(), x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom }; }),
        searchWidth: document.querySelector('.lh-header .lh-search')?.getBoundingClientRect().width || 0 };
    });
    check(report.documentWidth <= width + 1 && report.bodyWidth <= width + 1, `Homepage has no document overflow at ${width}×${height}`);
    check(report.controls.every(control => control.x >= -1 && control.right <= width + 1 && control.y >= -1 && control.bottom <= height + 1), `All visible header controls are reachable at ${width}×${height}`);
    if (width >= 1600) { check(report.headerHeight <= 110, `Desktop header stays in a compact single band at ${width}×${height}`); check(report.searchWidth > 0 && report.searchWidth <= 400, 'Desktop search remains compact'); }
    report.categoryScroll = await horizontalCategories(width, height);
    await screenshot(`home-${width}x${height}`);
    await admin('链接管理'); const adminFrame = await frame(`链接管理 ${width}×${height}`);
    check(await page.getByRole('navigation', { name: '链接分页', exact: true }).isVisible(), 'Pagination stays available at every target size');
    await admin('布局与主题'); await frame(`布局与主题 ${width}×${height}`);
    const view = originalPage.config.views.find(item => item.panel.id === 'builtin/navigation');
    if (view) { await inspect(view); await frame(`积木检查器 ${width}×${height}`); }
    emit({ event: 'viewport', status: 'passed', homepage: report, admin: adminFrame });
  }
  equal(writes.slice(writeStart), [], 'Responsive inspection performs no API writes'); equal(await readPage(), before, 'Viewport changes leave page config and revision untouched');
}

const phases = { shell, forms, categories, viewport };
(async () => {
  let failure;
  try {
    check(selectedPhase === 'all' || Object.hasOwn(phases, selectedPhase), `--phase must be one of ${Object.keys(phases).join(', ')} or all`);
    await preflight();
    for (const [name, work] of selectedPhase === 'all' ? Object.entries(phases) : [[selectedPhase, phases[selectedPhase]]]) {
      active = name; const begin = Date.now(), count = assertions; await work();
      equal(errors, [], `${name}: no uncaught page errors`); equal(consoleErrors, [], `${name}: no console errors`); equal(nativeDialogs, [], `${name}: no system alert/confirm/prompt dialogs`);
      const result = { phase: name, status: 'passed', elapsedMs: Date.now() - begin, assertions: assertions - count }; results.push(result); emit({ event: 'phase', ...result });
    }
  } catch (error) { failure = error; await screenshot(`${active}-failure`).catch(() => {}); }
  finally {
    try { await cleanup(); } catch (error) { failure = new Error(`${failure ? failure.message + '; ' : ''}Cleanup failed: ${error.message}`); }
    if (approved) try { equal(records(await readNavigation()), records(originalNavigation), 'Final business records match the original collection'); equal((await readPage()).config, originalPage.config, 'Final complete page config matches its original'); } catch (error) { failure = failure || error; }
    emit({ event: 'summary', status: failure ? 'failed' : 'passed', phase: selectedPhase, assertions, elapsedMs: Date.now() - started, results, message: failure?.message, pageErrors: errors, consoleErrors, nativeDialogs, writes, cleanups, remainingSynthetic: synthetic });
    if (failure) process.exitCode = 1;
    if (context) await context.close().catch(() => {}); if (browser) await browser.close().catch(() => {});
  }
})();
