#!/usr/bin/env node
'use strict';
/**
 * Real visual-composer checks against the two disposable copied demos only.
 * BASE_URL=http://10.233.233.61:5184 node tests/browser_visual_composer.cjs --allow-demo-write
 * BASE_URL=http://10.233.233.61:5185 node tests/browser_visual_composer.cjs --allow-demo-write
 * Without --allow-demo-write, only unsaved draft/cancel checks run.
 * One exact UI page PUT is allowed, followed by revision-checked API restoration.
 * No account, settings, bookmark, source or icon writes are permitted.
 * Optional: EXPECTED_PAGE_REVISION (explicit rerun baseline), REPORT_PATH,
 * SCREENSHOT_DIR, LINGSHU_PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const STEP = 15_000, runId = randomUUID().slice(0, 12), startedAt = new Date().toISOString();
const allowWrite = process.argv.includes('--allow-demo-write');
const reportPath = path.resolve(process.env.REPORT_PATH || path.join(os.tmpdir(), `lingshu-visual-composer-${runId}.json`));
let browser, context, page, base, bootstrap, space, originalPage, originalNavigation, originalDashboard, expectedConfig, committedPage;
let approved = false, putBudget = 0, active = 'preflight';
const checks = [], attempts = [], commits = [], blocked = [], routeErrors = [], pageErrors = [], consoleErrors = [], dialogs = [], cleanups = [], screenshots = [], details = {};
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const l = (zh, en) => bootstrap.language === 'en' ? en : zh;
const endpoint = relative => base.origin + '/api/v1' + relative;
const pagePath = () => '/api/v1/spaces/' + encodeURIComponent(space.id) + '/page';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const records = dataset => ({ categories: [...dataset.data.categories].sort((a, b) => a.id.localeCompare(b.id)), links: [...dataset.data.links].sort((a, b) => a.id.localeCompare(b.id)) });
const selector = (name, value) => `[${name}=${JSON.stringify(value)}]`;
const editor = () => page.locator('.lh-composer');
const inspector = () => page.locator('.lh-composer-sidebar.is-inspector .lh-composer-inspector');
const toolbar = () => page.locator('.lh-composer-toolbar');
const canvas = () => page.locator('.lh-composer-canvas > .lh-home');
const viewFrame = id => page.locator('.lh-composer-canvas ' + selector('data-panel-id', id));
const layer = id => page.locator('.lh-composer-sidebar.is-library ' + selector('data-composer-layer', id));
const allLayerIds = () => page.locator('.lh-composer-sidebar.is-library [data-composer-layer]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-composer-layer')));
const defaultChrome = () => ({ header: { enabled: false, left: [], center: [], right: [] }, footer: { enabled: true, left: [], center: [], right: [{ id: 'home-branding', type: 'branding' }] } });
async function read(relative) {
  const response = await context.request.get(endpoint(relative), { timeout: STEP, maxRedirects: 0 });
  assert.ok(response.ok(), `GET ${relative}: HTTP ${response.status()}`); return response.json();
}
const readPage = () => read('/spaces/' + encodeURIComponent(space.id) + '/page');
const readNavigation = () => read('/spaces/' + encodeURIComponent(space.id) + '/navigation');
async function group(name, action) {
  active = name; emit({ event: 'step', label: name }); const began = Date.now();
  await action(); checks.push({ name, status: 'passed', durationMs: Date.now() - began });
}
async function settle() {
  const token = randomUUID();
  await page.waitForFunction(token => {
    if (document.fonts.status !== 'loaded' || document.querySelector('.react-draggable-dragging,.resizing')) return false;
    const nodes = [...document.querySelectorAll('.lh-home,.lh-composer-workbench,.lh-composer-sidebar,.lh-composer-drawer,.lh-grid-frame')];
    if (!nodes.some(node => node.getBoundingClientRect().width > 0)) return false;
    const signature = JSON.stringify(nodes.map(node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(value => Math.round(value * 10)); }));
    const previous = window.__composerStable;
    if (!previous || previous.token !== token || previous.signature !== signature) { window.__composerStable = { token, signature, frames: 0 }; return false; }
    return ++previous.frames >= 5;
  }, token, { timeout: STEP, polling: 'raf' });
}
async function capture(name) {
  if (!process.env.SCREENSHOT_DIR) return;
  const directory = path.resolve(process.env.SCREENSHOT_DIR); fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `visual-composer-${bootstrap.language}-${name}.png`);
  await page.screenshot({ path: target, fullPage: false, animations: 'allow', timeout: STEP }); screenshots.push(target);
}
async function choose(control, label) {
  await control.click(); const list = page.getByRole('listbox'); await list.waitFor({ state: 'visible' });
  await page.getByRole('option', { name: label, exact: true }).click(); await list.waitFor({ state: 'hidden' });
  assert.ok((await control.textContent()).includes(label), `Selection visibly retains ${label}`); await settle();
}
async function home(reload = false) {
  if (reload) await page.reload({ waitUntil: 'domcontentloaded' }); else await page.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded' });
  await page.locator('.lh-home:not([data-preview]) .lh-home-heading h1').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('.lh-home .lh-bookmark').length > 0, null, { timeout: STEP }); await settle();
}
async function enter() {
  await page.locator('.lh-edit-menu summary').click(); await page.getByRole('button', { name: l('调整布局', 'Adjust layout'), exact: true }).click();
  await editor().waitFor({ state: 'visible' }); await toolbar().waitFor({ state: 'visible' }); await settle();
}
async function cancel() {
  await toolbar().getByRole('button', { name: l('取消', 'Cancel'), exact: true }).click();
  await editor().waitFor({ state: 'hidden' }); await page.locator('.lh-header').waitFor({ state: 'visible' }); await settle();
}
async function pageSettings() { await page.locator('.lh-composer-sidebar.is-library .lh-composer-layer.is-page').click(); await inspector().locator('.lh-composer-themes').waitFor({ state: 'visible' }); }
async function noOverflow(label) {
  const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), height: innerHeight, scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) }));
  assert.ok(geometry.scrollWidth <= geometry.width + 1, `${label}: horizontal document overflow`);
  if (await editor().count()) assert.ok(geometry.scrollHeight <= geometry.height + 1, `${label}: editor creates an outer document scrollbar`);
  return geometry;
}
async function addFromLibrary(name) {
  const before = await allLayerIds();
  await toolbar().getByRole('button', { name: l('组件与页面结构', 'Components and layers'), exact: true }).click();
  await page.locator('.lh-composer-sidebar.is-library .lh-composer-library-items').first().getByRole('button', { name, exact: true }).click();
  await page.locator('.lh-composer-sidebar.is-library [data-composer-layer]').first().waitFor({ state: 'visible' });
  const after = await allLayerIds(), added = after.filter(id => !before.includes(id)); assert.equal(added.length, 1, 'Exactly one component was added');
  await settle(); return added[0];
}
async function clickChrome(area, slot) {
  await page.locator(`.lh-composer-canvas [data-chrome-area=${area}] [data-chrome-slot=${slot}]`).click();
  await inspector().locator('.lh-composer-chrome').waitFor({ state: 'visible' });
}

async function unsavedChecks() {
  const category = originalPage.config.views.find(view => view.panel.id === 'builtin/category-navigation');
  assert.ok(category, 'The fixture contains category navigation');
  let addedId, copiedId;
  await group('2K editor replaces the ordinary header with a fixed composition workspace', async () => {
    await home(); await enter();
    assert.equal(await editor().locator('.lh-header').count(), 0, 'Ordinary homepage header is absent while editing');
    assert.equal(await editor().locator('.lh-composer-sidebar').count(), 2, 'Both desktop tool panels are visible');
    assert.equal(await canvas().getAttribute('data-page-theme'), originalPage.config.pageTheme.id);
    assert.equal(await toolbar().getByRole('button', { name: l('保存页面', 'Save page'), exact: true }).isDisabled(), true);
    const before = await toolbar().boundingBox(); await page.locator('.lh-composer-stage').evaluate(node => { node.scrollTop = node.scrollHeight; }); await settle();
    const after = await toolbar().boundingBox(); assert.ok(Math.abs(after.y - before.y) < 1, 'Save toolbar stays visible while the canvas scrolls');
    await page.locator('.lh-composer-stage').evaluate(node => { node.scrollTop = 0; });
    details.editorGeometry = await noOverflow('2K editor'); await capture('editor-classic-2k');
  });
  await group('Category component can be selected on the canvas and moved/styled without saving', async () => {
    await page.locator('.lh-composer-canvas ' + selector('data-view-id', category.id)).getByRole('button', { name: l('编辑分类导航组件', 'Edit Categories component'), exact: true }).click();
    await choose(inspector().getByRole('combobox', { name: l('显示位置', 'Position'), exact: true }), l('右侧', 'Right'));
    assert.equal(await page.locator('.lh-composer-canvas .lh-right-region ' + selector('data-view-id', category.id)).count(), 1);
    await choose(inspector().getByRole('combobox', { name: l('显示模式', 'Display mode'), exact: true }), l('纯图标', 'Icons only'));
    assert.equal(await page.locator('.lh-composer-canvas ' + selector('data-view-id', category.id) + ' .lh-categories.is-icons').count(), 1);
    await choose(inspector().getByRole('combobox', { name: l('显示模式', 'Display mode'), exact: true }), l('图标与文字', 'Icon + text'));
    const collapsed = inspector().getByRole('checkbox', { name: l('默认收起', 'Collapsed by default'), exact: true }), before = await collapsed.isChecked();
    await collapsed.click(); assert.equal(await collapsed.isChecked(), !before);
    assert.equal(attempts.length, 0);
  });
  await group('Adding and duplicating components display the actual 43-bookmark dataset', async () => {
    addedId = await addFromLibrary(l('书签导航', 'Bookmarks'));
    await inspector().getByLabel(l('组件标题', 'Component title'), { exact: true }).fill(l('临时组件', 'Draft component'));
    assert.equal(await viewFrame(addedId).locator('.lh-bookmark').count(), 43, 'New panel renders real source records');
    const before = await allLayerIds(); await inspector().getByRole('button', { name: l('复制组件', 'Duplicate component'), exact: true }).click(); await settle();
    const added = (await allLayerIds()).filter(id => !before.includes(id)); assert.equal(added.length, 1); copiedId = added[0];
    assert.equal(await viewFrame(copiedId).locator('.lh-bookmark').count(), 43);
    assert.equal(await inspector().getByLabel(l('组件标题', 'Component title'), { exact: true }).inputValue(), l('临时组件', 'Draft component'));
    await capture('editor-components-2k');
  });
  await group('Ordering, locking, hiding and removing affect only the selected draft component', async () => {
    const before = await allLayerIds();
    await inspector().getByRole('button', { name: l('上移', 'Up'), exact: true }).click(); await settle();
    assert.equal((await allLayerIds()).indexOf(copiedId), before.indexOf(copiedId) - 1);
    await inspector().getByRole('button', { name: l('下移', 'Down'), exact: true }).click(); await settle(); assert.deepEqual(await allLayerIds(), before);
    const lock = inspector().getByRole('checkbox', { name: l('锁定位置与尺寸', 'Lock position and size'), exact: true }); await lock.click();
    const blockedControls = [inspector().getByRole('combobox', { name: l('显示位置', 'Position'), exact: true }), inspector().getByRole('button', { name: l('移除组件', 'Remove component'), exact: true }), inspector().getByRole('button', { name: l('复制组件', 'Duplicate component'), exact: true })];
    assert.ok((await Promise.all(blockedControls.map(control => control.isDisabled()))).every(Boolean), 'Locked component has disabled structural operations');
    await lock.click(); await inspector().getByRole('button', { name: l('移除组件', 'Remove component'), exact: true }).click();
    assert.equal(await layer(copiedId).count(), 0); await layer(addedId).click();
    await inspector().getByRole('button', { name: l('隐藏', 'Hide'), exact: true }).click(); await settle(); assert.equal(await viewFrame(addedId).count(), 0); assert.equal(await layer(addedId).count(), 1);
    await inspector().getByRole('button', { name: l('显示', 'Show'), exact: true }).click(); await settle(); assert.equal(await viewFrame(addedId).locator('.lh-bookmark').count(), 43);
    await inspector().getByRole('button', { name: l('移除组件', 'Remove component'), exact: true }).click();
    assert.deepEqual(await allLayerIds(), originalPage.config.views.map(view => view.id)); assert.equal(attempts.length, 0);
  });
  await group('Direct footer editing validates every slot before Save and focuses an invalid URL', async () => {
    await clickChrome('footer', 'left');
    await inspector().locator('.lh-composer-add-chrome').getByRole('button', { name: l('链接', 'Link'), exact: true }).click();
    await inspector().getByLabel(l('链接文本', 'Link text'), { exact: true }).fill(l('使用说明', 'User guide'));
    await inspector().getByLabel(l('链接网址', 'Link URL'), { exact: true }).fill('javascript:alert(1)');
    await pageSettings();
    await toolbar().getByRole('button', { name: l('保存页面', 'Save page'), exact: true }).click();
    const invalid = inspector().getByLabel(l('链接网址', 'Link URL'), { exact: true }); await invalid.waitFor({ state: 'visible' });
    assert.equal(await invalid.evaluate(node => node.ownerDocument.activeElement === node), true, 'Save selects the correct footer slot and focuses its URL');
    assert.equal(await invalid.getAttribute('aria-invalid'), 'true'); assert.equal(attempts.length, 0, 'Invalid draft does not even attempt a page write');
    await invalid.fill('https://example.com/docs');
    assert.equal(await page.locator('.lh-composer-canvas [data-chrome-area=footer] [data-chrome-slot=left] a').getAttribute('aria-disabled'), 'true');
    await inspector().getByRole('checkbox', { name: l('显示页脚', 'Show footer'), exact: true }).click();
    assert.equal(await page.locator('.lh-composer-canvas [data-chrome-area=footer]').evaluate(node => node.classList.contains('is-disabled')), true);
    await toolbar().getByRole('button', { name: l('恢复', 'Restore'), exact: true }).click(); await settle();
    assert.equal(await toolbar().getByRole('button', { name: l('保存页面', 'Save page'), exact: true }).isDisabled(), true, 'Restore returns all edits to the original baseline');
    assert.deepEqual(await readPage(), originalPage); assert.equal(attempts.length, 0);
  });
  await group('Theme selection previews real data at full width and returns to the same editor', async () => {
    await pageSettings(); await inspector().getByRole('button', { name: l('iOS 风格', 'iOS inspired'), exact: true }).click();
    await canvas().locator('[data-link-appearance=app-icons]').first().waitFor({ state: 'visible' });
    assert.equal(await canvas().getAttribute('data-page-theme'), 'builtin/ios');
    const editWidth = (await canvas().boundingBox()).width;
    await toolbar().getByRole('button', { name: l('预览', 'Preview'), exact: true }).click(); await settle();
    assert.equal(await editor().locator('.lh-composer-sidebar').count(), 0); assert.equal(await canvas().locator('.lh-header').count(), 1);
    assert.ok((await canvas().boundingBox()).width > editWidth + 450, 'Preview uses space released by both property panels');
    const link = canvas().locator('.lh-bookmark-title[role=link]').first();
    assert.equal(await link.getAttribute('aria-disabled'), 'true'); assert.equal(await link.getAttribute('href'), null);
    const href = page.url(), openPageCount = context.pages().length;
    // locator.click() correctly waits for aria-disabled to become enabled. A
    // real pointer can still land here, so test that interaction without
    // changing the preview link's intentional disabled state.
    await link.scrollIntoViewIfNeeded(); const linkBox = await link.boundingBox(); assert.ok(linkBox && linkBox.width > 0 && linkBox.height > 0);
    const point = { x: linkBox.x + linkBox.width / 2, y: linkBox.y + linkBox.height / 2 };
    assert.equal(await link.evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), point), true, 'The pointer lands on the disabled preview link');
    await page.mouse.click(point.x, point.y); await settle();
    assert.equal(page.url(), href, 'Clicking the disabled preview link leaves the current URL unchanged');
    assert.equal(context.pages().length, openPageCount, 'Clicking the disabled preview link opens no new page');
    await toolbar().getByRole('button', { name: l('继续编辑', 'Keep editing'), exact: true }).click(); await settle();
    assert.equal(await editor().locator('.lh-header').count(), 0); assert.equal(await editor().locator('.lh-composer-sidebar').count(), 2);
    assert.equal(await canvas().getAttribute('data-page-theme'), 'builtin/ios'); await capture('editor-ios-draft-2k');
    await cancel(); assert.deepEqual(await readPage(), originalPage); assert.deepEqual(records(await readNavigation()), records(originalNavigation)); assert.equal(attempts.length, 0, 'Multi-operation cancellation sends no mutations');
  });
  await group('390px properties use an accessible drawer and a visible custom select above it', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await home(); await enter(); await noOverflow('390px composer');
    assert.equal(await editor().locator('.lh-composer-sidebar').count(), 0);
    await toolbar().getByRole('button', { name: l('组件与页面结构', 'Components and layers'), exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor({ state: 'visible' });
    await dialog.getByRole('tab', { name: l('页面结构', 'Layers'), exact: true }).click();
    await dialog.locator(selector('data-composer-layer', category.id)).click();
    const select = dialog.getByRole('combobox', { name: l('显示模式', 'Display mode'), exact: true }); await select.click();
    const option = page.getByRole('option', { name: l('纯文字', 'Text only'), exact: true }); await option.waitFor({ state: 'visible' });
    assert.equal(await option.evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.left + Math.min(12, r.width / 2), r.top + r.height / 2)); }), true, 'Select portal is visibly above the modal drawer');
    await option.click(); await settle(); await capture('mobile-properties-390');
    assert.equal(await page.locator('select:visible').count(), 0, 'The editor exposes no native select');
    await dialog.getByRole('button', { name: l('返回画布', 'Back to canvas'), exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); await noOverflow('390px live canvas'); await capture('mobile-canvas-390');
    await page.locator('.lh-composer-canvas ' + selector('data-view-id', category.id)).getByRole('button', { name: l('编辑分类导航组件', 'Edit Categories component'), exact: true }).click();
    await dialog.waitFor({ state: 'visible' }); assert.equal(await dialog.getByRole('combobox', { name: l('显示模式', 'Display mode'), exact: true }).count(), 1, 'Tapping the same selected component reopens its inspector');
    await dialog.getByRole('button', { name: l('返回画布', 'Back to canvas'), exact: true }).click(); await cancel();
    assert.deepEqual(await readPage(), originalPage); assert.equal(attempts.length, 0);
    await page.setViewportSize({ width: 2560, height: 1440 });
  });
}

async function saveOnce() {
  await group('One deliberate UI save persists the iOS theme, footer text and one data-backed component', async () => {
    await home(); await enter(); await pageSettings();
    await inspector().getByRole('button', { name: l('iOS 风格', 'iOS inspired'), exact: true }).click();
    await choose(inspector().getByRole('combobox', { name: l('配色', 'Color mode'), exact: true }), l('浅色', 'Light'));
    const newId = await addFromLibrary(l('常用收藏', 'Favorites')), title = l('快速访问', 'Quick access');
    await inspector().getByLabel(l('组件标题', 'Component title'), { exact: true }).fill(title);
    assert.equal(await viewFrame(newId).locator('.lh-bookmark').count(), 3, 'New Favorites component displays the existing three favorites');
    await clickChrome('footer', 'left');
    const beforeItems = await inspector().locator('[data-composer-chrome-item]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-composer-chrome-item')));
    await inspector().locator('.lh-composer-add-chrome').getByRole('button', { name: l('文字', 'Text'), exact: true }).click();
    const footerText = l('个人面板 · 自由组合', 'Personal dashboard · Make it yours');
    await inspector().getByLabel(l('文本', 'Text'), { exact: true }).fill(footerText);
    const newItems = (await inspector().locator('[data-composer-chrome-item]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-composer-chrome-item')))).filter(id => !beforeItems.includes(id));
    assert.equal(newItems.length, 1, 'Exactly one footer item was added');
    const alias = Object.entries(originalPage.config.bindings).find(([, binding]) => binding.datasetId === 'local-navigation' && !Object.keys(binding.query).length)?.[0];
    assert.ok(alias, 'Known fixture has an unfiltered local navigation binding');
    const y = Math.max(0, ...Object.values(originalPage.config.layout.placements).map(entry => entry.base.kind === 'grid' ? entry.base.y + entry.base.h : 0));
    expectedConfig = structuredClone(originalPage.config); expectedConfig.pageTheme = { id: 'builtin/ios' }; expectedConfig.appearance.colorMode = 'light';
    expectedConfig.views.push({ id: newId, panel: { id: 'builtin/favorites' }, inputs: { collection: alias }, interactionScope: 'primary-navigation', settings: { variant: 'cards', title } });
    expectedConfig.layout.placements[newId] = { base: { kind: 'grid', region: 'main', x: 0, y, w: 24, h: 3, heightMode: 'content', locked: false }, overrides: { narrow: { kind: 'flow', region: 'main', order: originalPage.config.views.length } } };
    expectedConfig.chrome = structuredClone(originalPage.config.chrome || defaultChrome()); expectedConfig.chrome.footer.enabled = true;
    expectedConfig.chrome.footer.left.push({ id: newItems[0], type: 'text', text: footerText });
    assert.deepEqual(await readPage(), originalPage, 'Server baseline remains untouched immediately before the one save');
    putBudget = 1;
    const [response] = await Promise.all([
      page.waitForResponse(value => value.request().method() === 'PUT' && new URL(value.url()).pathname === pagePath(), { timeout: STEP }),
      toolbar().getByRole('button', { name: l('保存页面', 'Save page'), exact: true }).click(),
    ]);
    putBudget = 0; assert.ok(response.ok(), `Save returned HTTP ${response.status()}`);
    const saved = await response.json(); assert.deepEqual(saved.config, expectedConfig); assert.equal(saved.name, originalPage.name);
    assert.equal(attempts.length, 1); assert.equal(commits.length, 1); assert.equal(saved.revision, String(Number(originalPage.revision) + 1));
    assert.deepEqual(await readPage(), saved); await editor().waitFor({ state: 'hidden' });
    await home(true); assert.deepEqual(await readPage(), saved, 'Full document reload preserves exact saved configuration and revision');
    assert.equal(await page.locator('.lh-home').getAttribute('data-page-theme'), 'builtin/ios');
    assert.equal(await page.locator(selector('data-panel-id', newId)).locator('.lh-bookmark').count(), 3);
    assert.ok((await page.locator('.lh-footer .is-left').textContent()).includes(footerText));
    assert.deepEqual(records(await readNavigation()), records(originalNavigation));
    details.saved = { pageId: saved.id, initialRevision: originalPage.revision, savedRevision: saved.revision, addedViewId: newId, addedChromeItemId: newItems[0], configSha256: digest(saved.config), businessSha256: digest(records(originalNavigation)) };
    await noOverflow('Saved iOS 2K'); await capture('ios-saved-light-2k');
    await page.getByRole('button', { name: l('切换深浅色', 'Toggle light or dark'), exact: true }).click(); await settle();
    assert.equal(await page.locator('.lh-home').getAttribute('data-theme'), 'dark'); await capture('ios-saved-dark-2k');
    assert.deepEqual(await readPage(), saved, 'Temporary viewing color control sends no second write');
    await enter(); await capture('editor-saved-ios-2k'); await cancel();
  });
}

async function restoreOriginal() {
  const current = await readPage();
  if (!committedPage) { assert.deepEqual(current, originalPage, 'No-save run retains the entire page and revision'); cleanups.push({ action: 'page-unchanged', revision: current.revision }); return; }
  assert.ok(allowWrite && commits.length === 1 && current.revision === committedPage.revision && current.name === originalPage.name && isDeepStrictEqual(current.config, expectedConfig), 'Restoration refuses any state not written by this run');
  const freshBootstrap = await read('/bootstrap');
  assert.ok(freshBootstrap.mode === 'open_edit' && freshBootstrap.user == null && freshBootstrap.defaultSpaceId === space.id, 'Restoration remains in the same anonymous demo scope');
  const response = await context.request.put(endpoint('/spaces/' + encodeURIComponent(space.id) + '/page'), { timeout: STEP, maxRedirects: 0,
    headers: { 'X-CSRF-TOKEN': freshBootstrap.csrfToken }, data: { name: originalPage.name, config: originalPage.config, expectedRevision: current.revision } });
  cleanups.push({ action: 'restore-original-page', status: response.status(), expectedRevision: current.revision, classification: 'API cleanup, separate from UI save' });
  assert.ok(response.ok(), `Restore returned HTTP ${response.status()}`); const restored = await response.json();
  assert.deepEqual(await readPage(), restored); assert.deepEqual({ name: restored.name, config: restored.config }, { name: originalPage.name, config: originalPage.config });
  assert.equal(restored.revision, String(Number(committedPage.revision) + 1)); cleanups.push({ action: 'restored-original-name-and-full-config', revision: restored.revision });
}

(async () => {
  let failure;
  try {
    assert.ok(process.env.BASE_URL, 'An explicit BASE_URL is required'); base = new URL(process.env.BASE_URL);
    assert.ok(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Use a plain instance root');
    assert.equal(base.hostname, '10.233.233.61'); assert.ok(['5184', '5185'].includes(base.port), 'Only the disposable 5184/5185 copies are allowed; primary and existing demos are refused');
    const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, timeout: STEP, ignoreDefaultArgs: ['--hide-scrollbars'], args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'] });
    context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light', reducedMotion: 'no-preference' }); context.setDefaultTimeout(STEP); context.setDefaultNavigationTimeout(STEP);
    bootstrap = await read('/bootstrap'); const settings = await read('/settings');
    assert.ok(bootstrap.initialized && bootstrap.mode === 'open_edit' && settings.mode === 'open_edit' && !settings.hasOwner && bootstrap.user == null, 'Only initialized ownerless anonymous editing demos are accepted');
    assert.equal(bootstrap.language, base.port === '5184' ? 'zh-CN' : 'en');
    space = bootstrap.spaces.find(item => item.id === bootstrap.defaultSpaceId); assert.ok(space?.kind === 'shared' && space.published && space.canEdit);
    originalPage = await readPage(); originalNavigation = await readNavigation(); originalDashboard = await read('/dashboard?spaceId=' + encodeURIComponent(space.id));
    assert.equal(originalPage.spaceId, space.id); assert.deepEqual(originalDashboard.page, originalPage);
    assert.deepEqual([originalNavigation.data.links.length, originalNavigation.data.categories.length, originalNavigation.data.links.filter(link => link.isFavorite).length], [43, 8, 3]);
    assert.equal(originalPage.revision, process.env.EXPECTED_PAGE_REVISION || (base.port === '5184' ? '35' : '45'), 'The explicitly expected copied-page revision matches');
    assert.equal(originalPage.config.pageTheme.id, 'builtin/dashboard'); assert.ok(originalPage.config.views.length <= 29, 'Fixture leaves room for reversible add/duplicate checks');
    const navigation = originalPage.config.views.filter(view => view.panel.id === 'builtin/navigation' && originalPage.config.bindings[view.inputs.collection]?.datasetId === 'local-navigation');
    assert.equal(navigation.length, 1); const placement = originalPage.config.layout.placements[navigation[0].id].base;
    assert.ok(placement.kind === 'grid' && !placement.locked && placement.w === 24);
    assert.deepEqual([placement.heightMode, placement.h], base.port === '5184' ? ['content', 3] : ['fixed', 27]);
    approved = true;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base.origin) { blocked.push({ method: request.method(), path: url.origin + url.pathname, reason: 'outside disposable origin' }); return route.abort('blockedbyclient'); }
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      const attempt = { method: request.method(), path: url.pathname, step: active }; attempts.push(attempt);
      if (!allowWrite || request.method() !== 'PUT' || url.pathname !== pagePath() || url.search || putBudget !== 1) { blocked.push({ ...attempt, reason: 'outside the one armed UI page save' }); return route.abort('blockedbyclient'); }
      let body; try { body = request.postDataJSON(); } catch { blocked.push({ ...attempt, reason: 'invalid JSON' }); return route.abort('blockedbyclient'); }
      if (!body || body.expectedRevision !== originalPage.revision || body.name !== originalPage.name || !isDeepStrictEqual(body.config, expectedConfig) || Object.keys(body).some(key => !['name', 'config', 'expectedRevision'].includes(key))) { blocked.push({ ...attempt, reason: 'payload differs from exact theme/footer/component draft' }); return route.abort('blockedbyclient'); }
      putBudget = 0;
      try {
        const response = await route.fetch({ timeout: STEP, maxRedirects: 0 }); attempt.status = response.status();
        if (response.ok()) { committedPage = await response.json(); commits.push({ revision: committedPage.revision, expectedRevision: body.expectedRevision, configSha256: digest(committedPage.config) }); }
        await route.fulfill({ response });
      } catch (error) { routeErrors.push(error.message); await route.abort('failed').catch(() => {}); }
    });
    page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 400)); }); page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
    emit({ event: 'preflight', status: 'passed', origin: base.origin, language: bootstrap.language, revision: originalPage.revision, configSha256: digest(originalPage.config), businessSha256: digest(records(originalNavigation)), allowWrite });
    await unsavedChecks(); if (allowWrite) await saveOnce();
    assert.deepEqual(blocked, []); assert.deepEqual(routeErrors, []); assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(dialogs, []);
  } catch (error) { failure = error; if (page) await capture('failure').catch(() => {}); }
  finally {
    putBudget = 0;
    if (approved) {
      try { await restoreOriginal(); } catch (error) { cleanups.push({ action: 'restoration-failed', message: error.message }); failure ||= error; }
      try { assert.deepEqual(records(await readNavigation()), records(originalNavigation)); cleanups.push({ action: 'every-original-business-field-unchanged' }); } catch (error) { cleanups.push({ action: 'business-check-failed', message: error.message }); failure ||= error; }
    }
    const report = { status: failure ? 'failed' : 'passed', runId, startedAt, finishedAt: new Date().toISOString(), language: bootstrap?.language, allowWrite, step: active, message: failure?.message, stack: failure?.stack, checks, details, attempts, commits, cleanups, blocked, routeErrors, pageErrors, consoleErrors, nativeDialogs: dialogs, screenshots };
    try { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); } catch (error) { failure ||= error; }
    emit({ event: 'summary', status: failure ? 'failed' : 'passed', groupsPassed: checks.length, attemptedUIWrites: attempts.length, confirmedUIWrites: commits.length, cleanups, message: failure?.message, reportPath, screenshots });
    if (failure) process.exitCode = 1;
    if (context) await context.close().catch(() => {}); if (browser) await browser.close().catch(() => {});
  }
})();
