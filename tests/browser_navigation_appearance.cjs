#!/usr/bin/env node
'use strict';
// Disposable ownerless fixtures only: 5218 zh-CN / 5219 en, started with --language.
// BASE_URL=http://127.0.0.1:5218 node tests/browser_navigation_appearance.cjs --allow-fixture-write
// --core-only runs both real editing/saving flows without the additional visual matrix.
// This test restores the original page using this run's latest revision, and deletes
// only the exact link/category IDs it created. It never copies a user database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
const base = new URL(process.env.BASE_URL || '');
assert.ok(process.argv.includes('--allow-fixture-write'), 'Pass --allow-fixture-write for the disposable fixture');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', '10.233.233.61', 'localhost'].includes(base.hostname)
  && ['5218', '5219'].includes(base.port) && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password,
  'Only dedicated navigation-content fixtures on ports 5218/5219 are allowed');
const run = randomUUID().slice(0, 8), prefix = 'Navigation content ' + run;
const out = path.resolve(process.env.OUTPUT_DIR || path.join(require('node:os').tmpdir(), 'navigation-content-' + base.port + '-' + run));
fs.mkdirSync(out, { recursive: true });
const desktops = [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080]], viewports = [...desktops, [390, 844]];
const report = { startedAt: new Date().toISOString(), origin: base.origin, run, checks: [], geometry: [], screenshots: [], uiWrites: [], blocked: [], pageErrors: [], consoleErrors: [], cleanup: [] };
const created = { links: new Map(), categories: new Map() }, uiWrites = [], responseTasks = [];
let browser, context, page, boot, csrf, space, originalPage, originalNavigation, fixturePage, fixtureNavigation, ownedRevision, viewId, longLink, emptyLink;
let approved = false, pageChanged = false, phase = 'preflight';
const l = (zh, en) => boot.language === 'en' ? en : zh;
const button = (scope, zh, en) => scope.getByRole('button', { name: l(zh, en), exact: true });
const label = (scope, zh, en) => scope.getByRole('combobox', { name: l(zh, en), exact: true });
const relative = suffix => '/spaces/' + space.id + suffix;
const apiURL = suffix => base.origin + '/api/v1' + suffix;
const toolbar = () => page.locator('.lh-composer-toolbar');
const contentFields = () => page.locator('[data-navigation-content-settings]:visible');
const panel = () => page.locator('.lh-navigation-panel').filter({ has: page.getByRole('heading', { name: prefix, exact: true }) }).first();
const item = link => panel().locator('[data-link-id="' + link.id + '"]');
const sorted = values => [...values].sort((a, b) => a.id.localeCompare(b.id));
const records = nav => ({ links: sorted(nav.data.links), categories: sorted(nav.data.categories) });
const snapshot = nav => ({ revision: nav.revision, data: records(nav) });
const savedSettings = value => value.config.views.find(view => view.id === viewId).settings;

async function api(method, suffix, data, expected = 200) {
  const response = await context.request.fetch(apiURL(suffix), { method, data, headers: { 'X-CSRF-TOKEN': csrf || '' }, maxRedirects: 0, timeout: 15_000 });
  assert.equal(response.status(), expected, method + ' ' + suffix + ': unexpected HTTP ' + response.status());
  return expected === 204 ? null : response.json();
}
const readPage = () => api('GET', relative('/page'));
const readNavigation = () => api('GET', relative('/navigation'));
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function step(name, action) { phase = name; console.log(JSON.stringify({ event: 'step', name })); const start = Date.now(); await action(); report.checks.push({ name, status: 'passed', durationMs: Date.now() - start }); }
async function capture(name) { await settle(); const file = path.join(out, boot.language + '-' + name + '.png'); await page.screenshot({ path: file, fullPage: false }); report.screenshots.push(file); }
async function choose(control, name) { await control.click(); await page.getByRole('option', { name, exact: true }).click(); await settle(); }
async function setCheck(zh, en, checked) {
  const control = contentFields().getByRole('checkbox', { name: l(zh, en), exact: true });
  if (await control.getAttribute('aria-checked') !== String(checked)) await control.click();
  await settle(); assert.equal(await control.getAttribute('aria-checked'), String(checked));
}
async function setColumns(count) { await choose(label(contentFields(), '每行最多链接数', 'Maximum links per row'), count ? l(count + ' 个', count + ' links') : l('自动', 'Automatic')); }
async function setURL(value) { await choose(label(contentFields(), '网址显示', 'URL display'), { fallback: l('无描述时', 'When no description'), always: l('始终', 'Always'), hidden: l('隐藏', 'Hidden') }[value]); }
async function setDescriptions(count) { await choose(label(contentFields(), '描述行数', 'Description lines'), count ? l(count + ' 行', count + ' lines') : l('隐藏', 'Hidden')); }
async function setTags(value) { await choose(label(contentFields(), '标签显示', 'Tags'), value === null ? l('跟随样式', 'Follow style') : value ? l('显示', 'Show') : l('隐藏', 'Hide')); }
async function setDensity(value) { await choose(label(contentFields(), '内容密度', 'Content density'), { inherit: l('跟随页面', 'Follow page'), comfortable: l('宽松', 'Comfortable'), compact: l('紧凑', 'Compact') }[value]); }
async function assertVisible(locator, expected, message) { assert.equal(await locator.isVisible(), expected, message); }
async function home() { const target = base.origin + '/#/'; if (page.url() === target) await page.reload({ waitUntil: 'domcontentloaded' }); else await page.goto(target, { waitUntil: 'domcontentloaded' }); await panel().waitFor(); await settle(); }
async function enter() {
  await page.locator('.lh-edit-menu summary').click(); await button(page, '调整布局', 'Adjust layout').click(); await toolbar().waitFor();
  const layer = page.locator('[data-composer-layer="' + viewId + '"]:visible');
  if (!await layer.count()) {
    await button(toolbar(), '组件与页面结构', 'Components and layers').click();
    await page.getByRole('tab', { name: l('页面结构', 'Layers'), exact: true }).click();
  }
  await layer.click(); await contentFields().waitFor(); await settle();
}
async function assertUnchangedNavigation() { assert.deepEqual(snapshot(await readNavigation()), snapshot(fixtureNavigation), 'Editing presentation must not mutate any navigation record or its revision'); }
function assertPlacementUnchanged(value) {
  assert.deepEqual(value.config.layout, fixturePage.config.layout, 'Component placement, width and height are preserved');
  assert.deepEqual(value.config.bindings, fixturePage.config.bindings, 'Data bindings are preserved');
  assert.deepEqual(value.config.views.filter(view => view.id !== viewId), fixturePage.config.views.filter(view => view.id !== viewId), 'Unselected components are preserved');
  const expected = fixturePage.config.views.find(view => view.id === viewId), actual = value.config.views.find(view => view.id === viewId);
  assert.deepEqual({ ...actual, settings: null }, { ...expected, settings: null }, 'The selected component identity, interaction scope and binding are preserved');
}
async function writeFixturePage(config) {
  const before = await readPage(); assert.equal(before.revision, ownedRevision, 'Refusing to overwrite a revision not produced by this test');
  const saved = await api('PUT', relative('/page'), { name: before.name, config, expectedRevision: ownedRevision });
  ownedRevision = saved.revision; pageChanged = true; return saved;
}
async function save(scope, homeEditor) {
  const before = await readPage(), count = uiWrites.length;
  assert.equal(before.revision, ownedRevision);
  const pending = page.waitForResponse(response => response.url() === apiURL(relative('/page')) && response.request().method() === 'PUT');
  await button(scope, '保存页面', 'Save page').click(); const response = await pending;
  assert.equal(response.status(), 200); const saved = await response.json(); ownedRevision = saved.revision; pageChanged = true;
  assert.equal(Number(saved.revision), Number(before.revision) + 1, 'One save increments the page revision once');
  const body = response.request().postDataJSON(); assert.equal(body.expectedRevision, before.revision);
  assert.equal(uiWrites.length, count + 1, 'One click sends one page PUT');
  if (homeEditor) await page.locator('.lh-composer').waitFor({ state: 'hidden' });
  else await page.waitForFunction(() => document.querySelector('.admin-layout-savebar button[type=submit]')?.disabled === true);
  assertPlacementUnchanged(saved); await assertUnchangedNavigation(); return saved;
}
async function assertColumns(cap, directory, name) {
  await settle();
  const geometry = await panel().evaluate((element, ids) => {
    const rect = element.getBoundingClientRect(), selected = new Set(ids);
    const groups = [...element.querySelectorAll('.lh-links')].map(group => {
      const boxes = [...group.querySelectorAll('.lh-bookmark')].filter(card => selected.has(card.dataset.linkId)).map(card => {
        const box = card.getBoundingClientRect(); return { id: card.dataset.linkId, x: box.x, y: box.y, right: box.right, width: box.width, height: box.height };
      });
      const rows = [];
      for (const box of boxes) { const row = rows.find(row => Math.abs(row.y - box.y) <= 2); if (row) row.count++; else rows.push({ y: box.y, count: 1 }); }
      return { boxes, rows };
    }).filter(group => group.boxes.length);
    return { viewport: [innerWidth, innerHeight], documentWidth: document.documentElement.scrollWidth, panelWidth: rect.width, panelScrollWidth: element.scrollWidth, panelClientWidth: element.clientWidth, left: rect.left, right: rect.right, groups };
  }, [...created.links.keys()]);
  assert.equal(geometry.groups.reduce((sum, group) => sum + group.boxes.length, 0), created.links.size, 'All fixture links have real rendered card geometry');
  assert.ok(geometry.documentWidth <= geometry.viewport[0] + 1, name + ': no page-level horizontal overflow');
  assert.ok(geometry.panelScrollWidth <= geometry.panelClientWidth + 1, name + ': no component-level horizontal overflow');
  let maximum = 0;
  for (const group of geometry.groups) {
    for (const row of group.rows) { maximum = Math.max(maximum, row.count); assert.ok(row.count <= (directory ? 1 : cap), name + ': visible row exceeds the configured cap'); }
    for (const box of group.boxes) assert.ok(box.width > 0 && box.height > 0 && box.x >= geometry.left - 1 && box.right <= geometry.right + 1, name + ': card fits inside the panel');
  }
  const componentRows = [];
  if (!directory) for (const group of geometry.groups) for (const box of group.boxes) {
    const row = componentRows.find(row => Math.abs(row.y - box.y) <= 2);
    if (row) row.count++; else componentRows.push({ y: box.y, count: 1 });
  }
  for (const row of componentRows) assert.ok(row.count <= cap, name + ': multiple category groups together exceed the component-wide row cap');
  report.geometry.push({ name, cap, directory, maximum, componentRows, ...geometry }); return maximum;
}
async function assertDescriptionLines(count) {
  const text = item(longLink).locator('.lh-bookmark-description');
  if (!count) return assert.equal(await text.count(), 0, 'Description is absent when hidden');
  await assertVisible(text, true, 'Description is visible');
  const measurement = await text.evaluate(element => ({ height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight), textLength: element.textContent.length }));
  assert.ok(measurement.height > 0 && measurement.lineHeight > 0 && measurement.height <= measurement.lineHeight * count + 2, 'Description respects its visible line limit');
  if (count === 3) assert.ok(measurement.height >= measurement.lineHeight * 2.5, 'Long fixture description actually occupies three rendered lines');
  report.geometry.push({ name: 'description ' + count + ' lines', ...measurement });
}
async function assertContent(settings) {
  for (const link of created.links.values()) {
    const article = item(link); await article.waitFor();
    const urlVisible = settings.urlDisplay === 'always' || settings.urlDisplay === 'fallback' && !(settings.descriptionLines > 0 && link.description);
    await assertVisible(article.locator('.lh-bookmark-url'), urlVisible, link.title + ': URL visibility');
    await assertVisible(article.locator('.lh-bookmark-description'), settings.descriptionLines > 0 && !!link.description, link.title + ': description visibility');
    await assertVisible(article.locator('.lh-additional-endpoints'), settings.showEndpoints, link.title + ': additional URL visibility');
    const tags = settings.showTags === undefined ? settings.variant !== 'directory' && settings.density !== 'compact' && settings.linkAppearance === 'icon-text' : settings.showTags;
    await assertVisible(article.locator('.lh-bookmark-tags'), tags, link.title + ': tags visibility');
  }
  for (const category of created.categories.values()) {
    const group = panel().locator('.lh-link-group').filter({ has: page.locator('[data-link-id="' + [...created.links.values()].find(link => link.categoryId === category.id).id + '"]') });
    await assertVisible(group.locator('.lh-group-heading'), settings.showGroupTitles, 'Category heading visibility');
    await assertVisible(group.locator('.lh-count'), settings.showGroupTitles && settings.showCounts, 'Category count visibility');
  }
  await assertVisible(panel().locator('.lh-custom-panel-title > span'), settings.showCounts, 'Panel total visibility');
}

async function main() {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'], ignoreDefaultArgs: ['--hide-scrollbars'] });
  report.browserVersion = browser.version(); context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 }); context.setDefaultTimeout(15_000);
  boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken;
  assert.ok(['zh-CN', 'en'].includes(boot.language)); assert.equal(boot.languageSelectionRequired, false, 'Start the fixture with an explicit language');
  const fixtureName = 'Navigation content fixture ' + boot.language;
  if (!boot.initialized) { await api('POST', '/setup', { siteName: fixtureName, mode: 'open_edit', seedDemo: false }, 201); boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken; }
  assert.equal(boot.siteName, fixtureName, 'Refusing writes to an unrelated instance'); assert.equal(boot.mode, 'open_edit'); assert.equal(boot.user, null);
  space = boot.spaces.find(value => value.kind === 'shared'); assert.ok(space?.canEdit); report.language = boot.language;
  originalPage = await readPage(); originalNavigation = await readNavigation(); ownedRevision = originalPage.revision; approved = true;
  fs.writeFileSync(path.join(out, 'baseline.json'), JSON.stringify({ origin: base.origin, page: originalPage, navigation: originalNavigation }, null, 2));
  for (let index = 0; index < 2; index++) {
    const category = await api('POST', relative('/categories'), { name: prefix + ' group ' + (index + 1), icon: 'lucide:folder', parentId: null, sortOrder: index }, 201);
    created.categories.set(category.id, category);
  }
  const categories = [...created.categories.values()];
  // Two sparse groups plus ten uncategorized links exercise a panel-wide cap,
  // including the layout that otherwise puts several small categories on one row.
  for (let index = 0; index < 16; index++) {
    const record = await api('POST', relative('/links'), { title: prefix + ' ' + String(index + 1).padStart(2, '0'), url: 'https://example.invalid/content/' + run + '/' + index,
      categoryId: index < 6 ? categories[index < 3 ? 0 : 1].id : null, icon: 'lucide:link', iconMode: 'manual', description: index === 1 ? '' : 'Readable description used to verify wrapping and line limits. '.repeat(24),
      tags: ['fixture-' + run, 'visible-tag'], isFavorite: false, sortOrder: index,
      endpoints: [{ label: 'Additional ' + (index + 1), url: 'https://example.invalid/alternate/' + run + '/' + index }] }, 201);
    created.links.set(record.id, record); if (index === 0) longLink = record; if (index === 1) emptyLink = record;
  }
  const config = structuredClone(originalPage.config), selected = config.views.find(view => view.panel.id === 'builtin/navigation'); assert.ok(selected, 'Fresh fixture has a navigation panel'); viewId = selected.id;
  assert.notEqual(config.layout.placements[viewId]?.base.kind, 'hidden', 'Fixture navigation panel must be visible');
  config.pageTheme = { id: 'builtin/dashboard' }; config.appearance = { ...config.appearance, colorMode: 'light', density: 'comfortable' };
  selected.settings = { ...selected.settings, title: prefix, groupPreviewCount: 0, variant: 'cards', linkAppearance: 'icon-text', maxColumns: 0, urlDisplay: 'fallback', descriptionLines: 1, showTags: true, showEndpoints: true, showGroupTitles: true, showCounts: true, density: 'inherit' };
  fixturePage = await writeFixturePage(config); fixtureNavigation = await readNavigation();
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base.origin && !['data:', 'blob:'].includes(url.protocol)) { report.blocked.push({ method: request.method(), origin: url.origin, pathname: url.pathname }); return route.abort('blockedbyclient'); }
    if (url.origin === base.origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      if (request.method() !== 'PUT' || url.pathname !== '/api/v1' + relative('/page')) { report.blocked.push({ method: request.method(), pathname: url.pathname }); return route.abort('blockedbyclient'); }
    }
    return route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push({ phase, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ phase, message: message.text().slice(0, 300) }); });
  page.on('request', request => { if (request.url() === apiURL(relative('/page')) && request.method() === 'PUT') uiWrites.push({ phase, method: 'PUT', pathname: '/api/v1' + relative('/page') }); });
  page.on('response', response => {
    if (response.url() === apiURL(relative('/page')) && response.request().method() === 'PUT' && response.status() === 200)
      responseTasks.push(response.json().then(value => { ownedRevision = value.revision; pageChanged = true; }));
  });

  await step('homepage inspector exposes navigation content and category-preview settings and live URL changes stay draft-only', async () => {
    await home(); await enter(); assert.equal(await contentFields().getByRole('combobox').count(), 6); assert.equal(await contentFields().getByRole('checkbox').count(), 3);
    const previewControl = label(contentFields(), '分类默认显示', 'Category preview');
    const help = previewControl.locator('..').getByRole('button').first();
    assert.equal(await page.locator('.lh-field-help:visible').count(), 0);
    await help.hover(); assert.equal(await page.locator('.lh-field-help:visible').count(), 0);
    await help.click(); await page.locator('.lh-field-help:visible').waitFor();
    await page.keyboard.press('Escape'); await page.locator('.lh-field-help:visible').waitFor({ state: 'hidden' });
    await previewControl.click(); await page.getByRole('option', { name: l('4 个', '4 bookmarks'), exact: true }).click(); await settle();
    assert.ok(await panel().locator('.lh-folder-more').count() > 0, 'Category preview must expose remaining bookmarks');
    await previewControl.click(); await page.getByRole('option', { name: l('全部', 'All'), exact: true }).click(); await settle();
    assert.equal(await panel().locator('.lh-folder-more').count(), 0, 'All option must keep every bookmark visible');
    const before = await readPage(), writes = uiWrites.length;
    await assertVisible(item(longLink).locator('.lh-bookmark-url'), false); await assertVisible(item(emptyLink).locator('.lh-bookmark-url'), true);
    await setURL('hidden'); await assertVisible(item(emptyLink).locator('.lh-bookmark-url'), false);
    await button(toolbar(), '撤销', 'Undo').click(); await settle(); await assertVisible(item(emptyLink).locator('.lh-bookmark-url'), true);
    await button(toolbar(), '重做', 'Redo').click(); await settle(); await assertVisible(item(emptyLink).locator('.lh-bookmark-url'), false);
    await setURL('always'); await assertVisible(item(longLink).locator('.lh-bookmark-url'), true);
    assert.equal(uiWrites.length, writes); assert.deepEqual(await readPage(), before); await assertUnchangedNavigation();
  });
  await step('text, tags, extra URLs, headings, counts and density visibly update without saving', async () => {
    const before = await readPage(), writes = uiWrites.length;
    await setColumns(3); await setDescriptions(3); await assertDescriptionLines(3);
    await setTags(false); await assertVisible(item(longLink).locator('.lh-bookmark-tags'), false);
    await setTags(true); await assertVisible(item(longLink).locator('.lh-bookmark-tags'), true); await setTags(false);
    await setCheck('显示其他入口', 'Show additional URLs', false); await assertVisible(item(longLink).locator('.lh-additional-endpoints'), false);
    await setCheck('显示其他入口', 'Show additional URLs', true); await assertVisible(item(longLink).locator('.lh-additional-endpoints'), true); await setCheck('显示其他入口', 'Show additional URLs', false);
    await setCheck('显示链接数量', 'Show link counts', false); assert.equal(await panel().locator('.lh-count').count(), 0); await assertVisible(panel().locator('.lh-custom-panel-title > span'), false);
    await setCheck('显示链接数量', 'Show link counts', true); assert.ok(await panel().locator('.lh-count').count() >= 2); await setCheck('显示链接数量', 'Show link counts', false);
    await setCheck('显示分组标题', 'Show group titles', false); assert.equal(await panel().locator('.lh-group-heading').count(), 0);
    await setCheck('显示分组标题', 'Show group titles', true); assert.ok(await panel().locator('.lh-group-heading').count() >= 2); await setCheck('显示分组标题', 'Show group titles', false);
    await setDensity('compact'); const compact = await item(emptyLink).boundingBox(); await setDensity('comfortable'); const comfortable = await item(emptyLink).boundingBox();
    assert.ok(comfortable.height > compact.height + 5, 'Comfortable density changes real card height'); await setDensity('compact');
    assert.equal(uiWrites.length, writes); assert.deepEqual(await readPage(), before); await assertUnchangedNavigation(); await capture('home-live-content-controls');
  });
  await step('card column caps use real rows and directory mode keeps one column and hides the irrelevant control', async () => {
    await setColumns(1); assert.equal(await assertColumns(1, false, 'draft columns 1 across sparse category groups'), 1);
    assert.equal(await panel().locator('.lh-link-group.is-sparse').count(), 2, 'Two real sparse categories participate in the cap-one regression');
    await setColumns(3); assert.ok(await assertColumns(3, false, 'draft columns 3') >= 2, 'Increasing the cap makes more than one real card fit per row');
    await setColumns(8); await assertColumns(8, false, 'draft columns 8'); await setColumns(3);
    const inspector = page.locator('.lh-composer-panel-inspector');
    await choose(label(inspector, '排列方式', 'Presentation'), l('目录', 'Directory'));
    assert.equal(await label(contentFields(), '每行最多链接数', 'Maximum links per row').count(), 0); await assertColumns(1, true, 'draft directory');
    await setTags(null); await assertVisible(item(longLink).locator('.lh-bookmark-tags'), false);
    await setTags(true); await assertVisible(item(longLink).locator('.lh-bookmark-tags'), true); await setTags(false);
    await choose(label(inspector, '排列方式', 'Presentation'), l('卡片', 'Cards'));
    assert.match(await label(contentFields(), '每行最多链接数', 'Maximum links per row').innerText(), /3/);
    assert.equal(uiWrites.length, 0, 'All preview/history operations sent no page PUT'); assert.deepEqual(await readPage(), fixturePage);
  });
  await step('four desktop editor sizes remain usable, then one explicit save survives a reload', async () => {
    for (const [width, height] of desktops) { await page.setViewportSize({ width, height }); await assertColumns(3, false, 'editor ' + width + 'x' + height); await button(toolbar(), '保存页面', 'Save page').click({ trial: true }); await capture('editor-' + width + 'x' + height); }
    await page.setViewportSize({ width: 2560, height: 1440 }); const saved = await save(toolbar(), true);
    assert.deepEqual(Object.fromEntries(['maxColumns','urlDisplay','descriptionLines','showTags','showEndpoints','showGroupTitles','showCounts','density'].map(key => [key, savedSettings(saved)[key]])),
      { maxColumns: 3, urlDisplay: 'always', descriptionLines: 3, showTags: false, showEndpoints: false, showGroupTitles: false, showCounts: false, density: 'compact' });
    await page.reload(); await panel().waitFor(); assert.deepEqual(await readPage(), saved); await assertContent(savedSettings(saved)); await assertDescriptionLines(3); await assertColumns(3, false, 'saved home cards');
  });
  await step('administration edits the same options, clears inherited tags, and saves through the existing revision API', async () => {
    await page.goto(base.origin + '/#/admin?tab=appearance'); const form = page.locator('.admin-layout-form'); await form.waitFor();
    await form.getByRole('tab', { name: l('积木与数据绑定', 'Panels and data') }).click();
    await form.locator('.admin-component-item').filter({ hasText: prefix }).click(); await contentFields().waitFor();
    const before = await readPage(), writes = uiWrites.length;
    await setColumns(1); await setURL('hidden'); await setDescriptions(0); await setTags(null);
    await setCheck('显示其他入口', 'Show additional URLs', true); await setCheck('显示分组标题', 'Show group titles', true); await setCheck('显示链接数量', 'Show link counts', true); await setDensity('comfortable');
    await button(form, '撤销', 'Undo').click(); assert.match(await label(contentFields(), '内容密度', 'Content density').innerText(), new RegExp(l('紧凑', 'Compact')));
    await button(form, '重做', 'Redo').click(); assert.match(await label(contentFields(), '内容密度', 'Content density').innerText(), new RegExp(l('宽松', 'Comfortable')));
    await choose(label(form, '展示变体', 'Display variant'), l('目录', 'Directory')); assert.equal(await label(contentFields(), '每行最多链接数', 'Maximum links per row').count(), 0);
    assert.equal(uiWrites.length, writes); assert.deepEqual(await readPage(), before); await capture('admin-component-content');
    const saved = await save(form, false); assert.equal(Object.hasOwn(savedSettings(saved), 'showTags'), false, 'Follow style removes the explicit tag override');
    assert.equal(savedSettings(saved).variant, 'directory'); assert.equal(savedSettings(saved).descriptionLines, 0);
    await home(); assert.deepEqual(await readPage(), saved); await assertContent(savedSettings(saved)); await assertDescriptionLines(0); await assertColumns(1, true, 'saved admin directory');
  });
  await step('mobile properties use the real drawer with accessible content controls', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await enter();
    assert.equal(await label(contentFields(), '每行最多链接数', 'Maximum links per row').count(), 0);
    await label(contentFields(), '内容密度', 'Content density').scrollIntoViewIfNeeded(); await label(contentFields(), '内容密度', 'Content density').click({ trial: true }); await capture('mobile-properties');
    await button(page.getByRole('dialog'), '返回画布', 'Back to canvas').click();
    await button(toolbar(), '取消', 'Cancel').click(); await page.locator('.lh-composer').waitFor({ state: 'hidden' }); await assertUnchangedNavigation();
    await page.setViewportSize({ width: 2560, height: 1440 });
  });
  if (!process.argv.includes('--core-only')) await step('Classic and iOS cards/directories render correctly at four desktops and a phone', async () => {
    const cases = [
      { name: 'classic-cards-compact', theme: 'builtin/dashboard', variant: 'cards', density: 'compact', maxColumns: 3, urlDisplay: 'always', descriptionLines: 3, showTags: false, showEndpoints: false, showGroupTitles: true, showCounts: false, linkAppearance: 'icon-text' },
      { name: 'ios-cards-comfortable', theme: 'builtin/ios', pageDensity: 'compact', variant: 'cards', density: 'comfortable', maxColumns: 8, urlDisplay: 'always', descriptionLines: 3, showTags: true, showEndpoints: true, showGroupTitles: true, showCounts: true },
      { name: 'classic-directory-comfortable', theme: 'builtin/dashboard', variant: 'directory', density: 'comfortable', maxColumns: 3, urlDisplay: 'hidden', descriptionLines: 3, showTags: true, showEndpoints: true, showGroupTitles: true, showCounts: true, linkAppearance: 'icon-text' },
      { name: 'ios-directory-compact', theme: 'builtin/ios', variant: 'directory', density: 'compact', maxColumns: 8, urlDisplay: 'always', descriptionLines: 0, showTags: false, showEndpoints: false, showGroupTitles: false, showCounts: false },
    ];
    for (const scenario of cases) {
      const current = await readPage(), config = structuredClone(current.config), settings = config.views.find(view => view.id === viewId).settings;
      config.pageTheme = { id: scenario.theme }; config.appearance.density = scenario.pageDensity || 'comfortable';
      for (const key of ['variant','density','maxColumns','urlDisplay','descriptionLines','showTags','showEndpoints','showGroupTitles','showCounts','linkAppearance']) {
        if (scenario[key] === undefined) delete settings[key]; else settings[key] = scenario[key];
      }
      const saved = await writeFixturePage(config); assertPlacementUnchanged(saved); await home();
      const scenarioViewports = scenario.name === 'classic-cards-compact' ? [...viewports, [550, 844]] : viewports;
      for (const [width, height] of scenarioViewports) {
        await page.setViewportSize({ width, height }); await settle(); await panel().locator('.lh-custom-panel-title').scrollIntoViewIfNeeded();
        await assertContent(settings); if (scenario.descriptionLines) await assertDescriptionLines(scenario.descriptionLines);
        const columns = await assertColumns(scenario.maxColumns, scenario.variant === 'directory', scenario.name + ' ' + width + 'x' + height);
        if (width === 550) assert.equal(columns, 1, 'The 550px regression remains a single card column');
        if (scenario.name === 'ios-cards-comfortable') {
          const sizes = await item(emptyLink).evaluate(element => {
            const style = getComputedStyle(element), icon = element.querySelector('.lh-bookmark-icon'), image = icon.querySelector('img,svg');
            return { pageDensity: element.closest('.lh-home').dataset.density, minHeight: parseFloat(style.minHeight), padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat), iconWidth: icon.getBoundingClientRect().width, imageWidth: image?.getBoundingClientRect().width, tagsVisible: !!element.querySelector('.lh-bookmark-tags')?.getClientRects().length };
          });
          assert.equal(sizes.pageDensity, 'compact'); assert.equal(sizes.minHeight, 124); assert.deepEqual(sizes.padding, [14, 10, 12, 10]);
          assert.equal(sizes.iconWidth, 62); assert.equal(sizes.imageWidth, 31); assert.equal(sizes.tagsVisible, true);
          report.geometry.push({ name: 'panel comfortable overrides page compact and app-icon tags at ' + width + 'x' + height, ...sizes });
        }
        await capture(scenario.name + '-' + width + 'x' + height);
      }
      await assertUnchangedNavigation();
    }
  });
  await assertUnchangedNavigation(); assert.deepEqual(report.blocked, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
}

async function cleanup() {
  if (!approved || !context || !space) return;
  await Promise.all(responseTasks); if (page && !page.isClosed()) await page.close();
  if (pageChanged) {
    const current = await readPage(); assert.equal(current.revision, ownedRevision, 'Cleanup refuses to overwrite an unknown page revision');
    const restored = await api('PUT', relative('/page'), { name: originalPage.name, config: originalPage.config, expectedRevision: ownedRevision });
    assert.equal(restored.name, originalPage.name); assert.deepEqual(restored.config, originalPage.config); report.cleanup.push({ kind: 'page', status: 'restored', revision: restored.revision });
  }
  for (const kind of ['links', 'categories']) for (const [id, own] of [...created[kind]].reverse()) {
    const nav = await readNavigation(), actual = nav.data[kind].find(value => value.id === id); if (!actual) continue;
    assert.ok((actual.title || actual.name).startsWith(prefix)); assert.deepEqual(actual, own, 'Only this run’s unchanged fixture records may be deleted');
    await api('DELETE', relative('/' + kind + '/' + id), undefined, 204); report.cleanup.push({ kind, id, status: 'deleted' });
  }
  assert.deepEqual(records(await readNavigation()), records(originalNavigation), 'All pre-existing navigation is preserved');
}
(async () => {
  try { await main(); report.status = 'passed'; }
  catch (error) { report.status = 'failed'; report.failure = { phase, message: error.message, stack: error.stack }; process.exitCode = 1; if (page) await capture('failure').catch(() => {}); }
  finally {
    try { await cleanup(); } catch (error) { report.cleanupFailure = error.stack; report.status = 'failed'; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); report.uiWrites = uiWrites;
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: path.join(out, 'report.json'), failure: report.failure, cleanupFailure: report.cleanupFailure }));
    if (browser) await browser.close();
  }
})();
