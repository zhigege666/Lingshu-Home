#!/usr/bin/env node
'use strict';
// Owned disposable loopback instances only. UI_FIXTURES uses the same format as
// browser_session_inline_folder.cjs. This suite creates its own navigation and
// page fixture; it never reads or copies a user's database or remote website.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'UI_FIXTURES and OUTPUT_DIR are required');
const fixtures = JSON.parse(fs.readFileSync(process.env.UI_FIXTURES, 'utf8')), OUT = path.resolve(process.env.OUTPUT_DIR);
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
const report = { passed: false, startedAt: new Date().toISOString(), checks: [], screenshots: [], errors: [], gesture: 'Playwright real mouse starts a native draggable handle before scrolling to the target; no synthetic drag/drop or direct DOM state mutation.' };
const secrets = Object.values(fixtures).flatMap(f => [f.username, f.password]).filter(Boolean);
const scrub = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));
let browser, currentPage;
async function until(fn, message) { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 60)); } throw Error(message); }
async function check(name, run) {
  const start = Date.now();
  try { await run(); report.checks.push({ name, passed: true, ms: Date.now() - start }); console.log('PASS ' + name); }
  catch (error) {
    report.checks.push({ name, passed: false, error: scrub(error.message) });
    if (currentPage) { const file = name.replaceAll('/', '-') + '-failure.png'; await currentPage.screenshot({ path: path.join(OUT, file), animations: 'disabled', mask: [currentPage.locator('input[type=password]')] }).then(() => report.screenshots.push(file)).catch(() => {}); }
    throw error;
  }
}
const ids = (nav, categoryId) => nav.data.links.filter(link => (link.categoryId || null) === categoryId).sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title) || a.id.localeCompare(b.id)).map(link => link.id);
function insertBefore(order, id, beforeId) { const next = order.filter(value => value !== id); const at = beforeId === null ? next.length : next.indexOf(beforeId); assert(at >= 0, 'Expected order anchor exists'); next.splice(at, 0, id); return next; }

(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  for (const provider of process.env.UI_PROVIDER ? [process.env.UI_PROVIDER] : Object.keys(fixtures)) {
    const f = fixtures[provider]; assert(f, 'Unknown fixture provider');
    const base = new URL(f.url);
    assert(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && !base.username && !base.password && !base.search && !base.hash, 'Only disposable loopback HTTP fixtures are allowed');
    const BASE = base.origin, context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'zh-CN', reducedMotion: 'reduce' });
    const page = await context.newPage(); currentPage = page; page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(scrub(error.message)));
    const writes = [];
    page.on('request', request => { const url = new URL(request.url()); if (url.origin === BASE && url.pathname.startsWith('/api/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname }); });
    async function boot(ctx = context) { const response = await ctx.request.get(BASE + '/api/v1/bootstrap'); assert(response.ok()); return response.json(); }
    async function api(route, method = 'GET', body, expected = 200, ctx = context) {
      const state = await boot(ctx);
      const response = await ctx.request.fetch(BASE + '/api/v1' + route, { method, data: body, headers: { Origin: BASE, 'X-CSRF-TOKEN': state.csrfToken }, maxRedirects: 0 });
      assert.equal(response.status(), expected, method + ' ' + route + ': HTTP ' + response.status());
      return expected === 204 ? null : response.json();
    }
    async function login(ctx = context, account = f) { await api('/auth/login', 'POST', { username: account.username, password: account.password, sessionMode: 'temporary' }, 200, ctx); return boot(ctx); }
    const initial = await login();
    assert.equal(initial.siteName, 'Release UI fixture ' + provider, 'Named disposable fixture guard must match');
    assert(['private_multi', 'public_read'].includes(initial.mode), 'Fixture must use private_multi or public_read for the read-only check');
    const l = (zh, en) => initial.language === 'en' ? en : zh;
    const button = (zh, en, scope = page) => scope.getByRole('button', { name: l(zh, en), exact: true });
    const prefix = 'Home edit ' + crypto.randomBytes(4).toString('hex'), spacePath = '/spaces/' + f.shared;
    const navPath = spacePath + '/navigation', batchPath = navPath + '/batch-edit', batchURL = BASE + '/api/v1' + batchPath;
    const nav = () => api(navPath), savedPage = () => api(spacePath + '/page');
    const posts = () => writes.filter(item => item.method === 'POST' && item.path === '/api/v1' + batchPath).length;
    const categories = {};
    async function category(key, order, parentId = null) { const row = await api(spacePath + '/categories', 'POST', { name: prefix + ' ' + key, icon: 'lucide:folder', parentId, sortOrder: order }, 201); categories[key] = row; return row; }
    await category('A', -900000); await category('B', -899990); await category('Empty', -899980); await category('Child', 0, categories.A.id);
    const links = [];
    for (let index = 0; index < 33; index++) {
      const categoryId = index < 30 ? categories.A.id : index < 32 ? categories.B.id : categories.Child.id;
      links.push(await api(spacePath + '/links', 'POST', { title: prefix + ' link ' + String(index + 1).padStart(2, '0'), url: 'https://example.invalid/home-content/' + index,
        categoryId, icon: 'lucide:link', iconMode: 'manual', description: 'Homepage content fixture', contextMarkdown: 'Preserve existing Agent usage notes',
        tags: [9, 19].includes(index) ? ['anchor-filter'] : ['home-edit'], isFavorite: index === 0, sortOrder: index * 10,
        endpoints: [{ label: 'Extra', url: 'https://example.invalid/alternate/' + index }] }, 201));
    }
    const original = await savedPage(), viewId = 'home-content-navigation', scope = 'home-content-test';
    const view = (id, panel, settings = {}) => ({ id, panel: { id: 'builtin/' + panel }, inputs: panel === 'search' ? {} : { collection: 'navigation' }, interactionScope: scope, settings });
    const config = { ...original.config, pageTheme: { id: 'builtin/dashboard' }, appearance: { colorMode: 'light', density: 'comfortable' },
      bindings: { navigation: { datasetId: 'local-navigation', space: 'current-page-space', query: {} } },
      views: [view('home-content-categories', 'category-navigation', { hierarchyMode: 'tree', displayMode: 'icon-text', showCounts: true }), view('home-content-search', 'search'),
        view(viewId, 'navigation', { variant: 'cards', groupPreviewCount: 6, showGroupTitles: true, showCounts: true, showTags: true, urlDisplay: 'always', maxColumns: 4 }),
        view('home-content-favorites', 'favorites', { variant: 'cards' })],
      layout: { mode: 'regions-grid', gap: 16, grid: { columns: 24 }, placements: {
        'home-content-categories': { base: { kind: 'region', region: 'left', order: 0 } },
        'home-content-search': { base: { kind: 'region', region: 'top', order: 0 } },
        [viewId]: { base: { kind: 'flow', region: 'main', order: 0 } },
        'home-content-favorites': { base: { kind: 'flow', region: 'main', order: 1 } }
      } }
    };
    const fixturePage = await api(spacePath + '/page', 'PUT', { name: prefix, expectedRevision: original.revision, config });
    const panel = () => page.locator('.lh-region-item[data-view-id="' + viewId + '"] .lh-navigation-panel');
    const group = id => panel().locator('.lh-link-group[data-category-id="' + id + '"]');
    const card = (id, parent = panel()) => parent.locator('article.lh-bookmark[data-link-id="' + id + '"]');
    const toolbar = () => page.locator('.lh-content-toolbar'), details = () => page.locator('.lh-content-inspector');
    const field = name => details().locator('#home-content-' + name);
    const visibleIds = parent => parent.locator('article.lh-bookmark').evaluateAll(nodes => nodes.map(node => node.dataset.linkId));
    async function shared(tab = page, ctx = context) {
      const state = await boot(ctx), name = state.spaces.find(item => item.id === f.shared)?.name; assert(name);
      const control = tab.locator('.lh-space-holder [role=combobox]');
      if (state.spaces.length > 1) { await control.waitFor(); if (!(await control.innerText()).includes(name)) { await control.click(); await tab.getByRole('option', { name, exact: true }).click(); } }
      await tab.locator('.lh-region-item[data-view-id="' + viewId + '"]').waitFor();
    }
    async function home() { await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' }); await page.locator('.lh-home').waitFor(); await shared(); }
    async function start() { await page.locator('.lh-edit-trigger').click(); await toolbar().waitFor(); assert.equal(await page.locator('.lh-composer').count(), 0); }
    async function editLink(id, parent = panel()) { await card(id, parent).locator('.lh-bookmark-edit-title').click(); await details().waitFor(); await field('title').waitFor(); }
    async function closeDetails() { if (await details().count()) { await button('关闭编辑面板', 'Close edit panel', details()).click(); await details().waitFor({ state: 'hidden' }); } }
    async function save(status = 200) {
      const response = page.waitForResponse(value => value.url() === batchURL && value.request().method() === 'POST');
      await button('保存', 'Save', toolbar()).click(); assert.equal((await response).status(), status);
      if (status === 200) await toolbar().waitFor({ state: 'hidden' });
    }
    async function drag(source, target, side = 'before', vertical = false) {
      // Start the native gesture before scrolling to a distant group. Minimal
      // automatic scrolling can put the source behind the sticky edit toolbar.
      await source.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
      const from = await source.boundingBox(); assert(from && from.width > 0 && from.height > 0, 'Drag source is visible');
      const startX = from.x + from.width / 2, startY = from.y + from.height / 2;
      await page.mouse.move(startX, startY); await page.mouse.down();
      try {
        await page.mouse.move(startX + 8, startY, { steps: 4 });
        await until(() => source.evaluate(node => node.classList.contains('is-dragging')), 'Native dragstart did not occur');
        await target.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
        const box = await target.boundingBox(); assert(box && box.width > 0 && box.height > 0, 'Drop target is visible');
        const x = box.x + (vertical ? box.width / 2 : side === 'after' ? box.width - 5 : 5);
        const y = box.y + (vertical ? side === 'after' ? box.height - 5 : 5 : box.height / 2);
        await page.mouse.move(x, y, { steps: 12 }); await page.mouse.move(x + 1, y);
      } finally { await page.mouse.up(); }
    }
    async function layoutMenu() { await page.locator('.lh-more-trigger').click(); await page.getByRole('menuitem', { name: l('调整布局', 'Adjust layout'), exact: true }).click(); }
    async function snapshot(name) { const file = provider + '-' + name + '.png'; await page.screenshot({ path: path.join(OUT, file), animations: 'disabled' }); report.screenshots.push(file); }
    await home();
    let newCategoryName = prefix + ' renamed', newTitle = prefix + ' edited link', newURL = 'https://example.invalid/edited/' + provider;
    await check(provider + '/default_edit_inline_fields_keyboard_history_and_atomic_save', async () => {
      const before = await nav(), count = posts(); await start();
      assert.equal(await panel().locator('.lh-nav-drag-handle').count() > 0, true);
      assert.equal(await page.locator('.lh-region-item[data-view-id="home-content-favorites"] .lh-nav-drag-handle').count(), 0, 'Favorites must not imply a separate sort order');
      await group(categories.A.id).getByRole('button', { name: l('重命名分类 ' + categories.A.name, 'Rename category ' + categories.A.name), exact: true }).click();
      const name = group(categories.A.id).locator('.lh-category-name-input'); await name.fill(newCategoryName); await name.press('Enter');
      await editLink(links[0].id); await field('title').fill(newTitle); await field('title').press('Enter'); assert(await field('url').evaluate(node => node === document.activeElement));
      await field('url').press('Shift+Enter'); assert(await field('title').evaluate(node => node === document.activeElement));
      await field('title').press('Tab'); assert(await field('url').evaluate(node => node === document.activeElement));
      await button('撤销内容修改', 'Undo content edit', toolbar()).click(); assert.equal(await field('title').inputValue(), links[0].title);
      await button('重做内容修改', 'Redo content edit', toolbar()).click(); assert.equal(await field('title').inputValue(), newTitle);
      await field('url').fill(newURL); await field('tags').fill('home-edit,维护');
      assert.equal(posts(), count, 'Draft fields must not write before Save'); assert.equal((await nav()).revision, before.revision);
      assert.equal(context.pages().length, 1, 'Editing a bookmark opened a website');
      await save(); const after = await nav(), updated = after.data.links.find(row => row.id === links[0].id);
      assert.equal(after.data.categories.find(row => row.id === categories.A.id).name, newCategoryName);
      assert.equal(updated.title, newTitle); assert.equal(updated.url, newURL); assert.deepEqual(updated.tags, ['home-edit', '维护']);
      assert.equal(updated.contextMarkdown, links[0].contextMarkdown); assert.deepEqual(updated.endpoints, links[0].endpoints);
      assert.equal(BigInt(after.revision), BigInt(before.revision) + 1n); assert.equal(posts(), count + 1);
      assert.deepEqual(await savedPage(), fixturePage, 'Content edits changed the page layout/revision');
    });
    await check(provider + '/real_drag_self_same_category_cross_category_empty_and_subtree', async () => {
      const before = await nav(), count = posts(); await start();
      const beforeA = ids(before, categories.A.id), beforeB = ids(before, categories.B.id);
      await drag(card(links[2].id).locator('.lh-nav-drag-handle'), card(links[2].id));
      assert(await button('保存', 'Save', toolbar()).isDisabled(), 'Dropping a link on itself created a change');
      await drag(card(links[1].id).locator('.lh-nav-drag-handle'), card(links[0].id));
      await until(() => visibleIds(group(categories.A.id)).then(values => values[0] === links[1].id), 'Same-category drag did not reorder');
      await button('撤销内容修改', 'Undo content edit', toolbar()).click(); assert.equal((await visibleIds(group(categories.A.id)))[0], links[0].id);
      await button('重做内容修改', 'Redo content edit', toolbar()).click(); assert.equal((await visibleIds(group(categories.A.id)))[0], links[1].id);
      await drag(card(links[2].id).locator('.lh-nav-drag-handle'), group(categories.B.id).locator('.lh-group-heading'));
      await until(() => card(links[2].id, group(categories.B.id)).count().then(value => value === 1), 'Cross-category drop failed');
      await drag(card(links[3].id).locator('.lh-nav-drag-handle'), group(categories.Empty.id).locator('.lh-empty-category-target'));
      await until(() => card(links[3].id, group(categories.Empty.id)).count().then(value => value === 1), 'Empty category did not accept a link');
      const row = id => page.locator('.lh-categories .lh-category-node[data-category-id="' + id + '"] > .lh-category-row');
      await drag(row(categories.B.id).locator('.lh-nav-drag-handle'), row(categories.A.id), 'before', true);
      const ordered = await panel().locator('.lh-link-group').evaluateAll(nodes => nodes.map(node => node.dataset.categoryId));
      assert(ordered.indexOf(categories.B.id) < ordered.indexOf(categories.A.id));
      assert.equal(ordered.indexOf(categories.Child.id), ordered.indexOf(categories.A.id) + 1, 'Parent/subcategory groups are not adjacent');
      assert.equal(posts(), count); assert.equal((await nav()).revision, before.revision);
      await save(); const after = await nav();
      assert.deepEqual(ids(after, categories.A.id), insertBefore(beforeA, links[1].id, links[0].id).filter(id => ![links[2].id, links[3].id].includes(id)));
      assert.deepEqual(ids(after, categories.B.id), [...beforeB, links[2].id]); assert.deepEqual(ids(after, categories.Empty.id), [links[3].id]);
      assert.equal(after.data.categories.find(row => row.id === categories.Child.id).parentId, categories.A.id);
      assert.equal(after.data.links.length, before.data.links.length); assert.equal(posts(), count + 1);
      assert.deepEqual(await savedPage(), fixturePage);
    });
    await check(provider + '/folder_second_page_and_filtered_drag_preserve_hidden_order', async () => {
      const before = await nav(), originalOrder = ids(before, categories.A.id); let expected = [...originalOrder]; await start();
      await group(categories.A.id).locator('.lh-folder-more').click(); const folder = page.locator('.lh-folder-dialog'); await folder.waitFor();
      assert.equal(await folder.locator('.lh-bookmark').count(), 24); await button('下一页书签', 'Next bookmark page', folder).click();
      const pageIds = await visibleIds(folder); assert(pageIds.length >= 2, 'Fixture needs a second folder page');
      await drag(card(pageIds[1], folder).locator('.lh-nav-drag-handle'), card(pageIds[0], folder));
      await until(() => visibleIds(folder).then(values => values[0] === pageIds[1]), 'Second-page drag failed');
      assert(await folder.isVisible()); assert((await folder.locator('.lh-folder-pagination').innerText()).includes('25'));
      expected = insertBefore(expected, pageIds[1], pageIds[0]);
      await folder.locator('input[type=search]').fill('anchor-filter'); await until(() => folder.locator('.lh-bookmark').count().then(value => value === 2), 'Folder search fixture did not match');
      const filtered = await visibleIds(folder), withoutMoving = expected.filter(id => id !== filtered[0]);
      const afterTarget = withoutMoving[withoutMoving.indexOf(filtered[1]) + 1]; assert(afterTarget, 'Filtered drop must have a hidden following anchor');
      await drag(card(filtered[0], folder).locator('.lh-nav-drag-handle'), card(filtered[1], folder), 'after');
      await until(() => visibleIds(folder).then(values => values[0] === filtered[1]), 'Filtered drag failed');
      expected = insertBefore(expected, filtered[0], afterTarget); assert(await folder.isVisible());
      await page.keyboard.press('Escape'); await folder.waitFor({ state: 'hidden' }); await save();
      const after = await nav(); assert.deepEqual(ids(after, categories.A.id), expected, 'Hidden folder links were lost or reordered'); assert.equal(after.data.links.length, before.data.links.length);
      await page.reload(); await panel().waitFor(); assert.deepEqual(await visibleIds(group(categories.A.id)), expected.slice(0, 6));
    });
    await check(provider + '/client_validation_and_http_400_keep_draft_retryable', async () => {
      const before = await nav(), count = posts(); await start(); await editLink(links[0].id);
      await field('url').fill('not-a-url'); await button('保存', 'Save', toolbar()).click();
      await until(() => field('url').getAttribute('aria-invalid').then(value => value === 'true'), 'Invalid URL was not identified');
      assert.equal(posts(), count); assert.equal((await nav()).revision, before.revision);
      await field('url').fill(newURL); newTitle = prefix + ' rejected then saved'; await field('title').fill(newTitle);
      await page.route(batchURL, route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'validation_error', message: 'Injected validation rejection' }) }), { times: 1 });
      await save(400); await page.locator('.lh-content-feedback [role=alert]').filter({ hasText: 'Injected validation rejection' }).waitFor();
      assert.equal(await field('title').inputValue(), newTitle); assert.equal((await nav()).revision, before.revision);
      assert(await button('保存', 'Save', toolbar()).isEnabled()); await save(); assert.equal((await nav()).data.links.find(row => row.id === links[0].id).title, newTitle);
    });
    await check(provider + '/real_409_readback_field_merge_and_explicit_resolution', async () => {
      await start(); await editLink(links[0].id); const mine = prefix + ' mine', serverDescription = prefix + ' changed elsewhere'; await field('title').fill(mine);
      const before = await nav(); await api(batchPath, 'POST', { expectedRevision: before.revision, links: [{ id: links[0].id, patch: { title: prefix + ' server', description: serverDescription } }] });
      await save(409); assert.equal(await field('title').inputValue(), mine); assert(await button('保存', 'Save', toolbar()).isDisabled());
      await button('读取最新内容并比较', 'Read latest and compare').click(); await page.locator('.lh-content-conflict').waitFor(); assert.equal(await page.locator('.lh-content-conflict').count(), 1);
      await button('冲突 1：保留我的修改', 'Conflict 1: keep my edit').click(); await save();
      const saved = (await nav()).data.links.find(row => row.id === links[0].id); assert.equal(saved.title, mine); assert.equal(saved.description, serverDescription); newTitle = mine;
    });
    await check(provider + '/network_uncertainty_and_lost_success_are_not_auto_replayed', async () => {
      await start(); await editLink(links[0].id); await field('tags').fill('network-check'); const before = await nav();
      await page.route(batchURL, route => route.abort('failed'), { times: 1 }); await button('保存', 'Save', toolbar()).click();
      await button('读取最新内容并比较', 'Read latest and compare').waitFor(); assert(await button('保存', 'Save', toolbar()).isDisabled()); assert.equal((await nav()).revision, before.revision);
      await button('读取最新内容并比较', 'Read latest and compare').click(); await until(() => button('保存', 'Save', toolbar()).isEnabled(), 'Readback did not allow an explicit retry'); await save();
      await start(); await editLink(links[0].id); newTitle = prefix + ' committed response lost'; await field('title').fill(newTitle); const count = posts();
      await page.route(batchURL, async route => { const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed'); }, { times: 1 });
      await button('保存', 'Save', toolbar()).click(); await button('读取最新内容并比较', 'Read latest and compare').waitFor();
      const committed = await nav(); assert.equal(committed.data.links.find(row => row.id === links[0].id).title, newTitle);
      await button('读取最新内容并比较', 'Read latest and compare').click(); await toolbar().waitFor({ state: 'hidden' });
      assert.equal((await nav()).revision, committed.revision); assert.equal(posts(), count + 1, 'Readback replayed a committed POST');
    });
    await check(provider + '/committed_save_refresh_failure_keeps_confirmed_content_without_repost', async () => {
      await start(); await editLink(links[0].id); newTitle = prefix + ' saved with failed refresh'; await field('title').fill(newTitle); const count = posts();
      await page.route('**/api/v1/dashboard?*', route => route.abort('failed'), { times: 1 });
      const response = page.waitForResponse(value => value.url() === batchURL && value.request().method() === 'POST');
      await button('保存', 'Save', toolbar()).click(); assert.equal((await response).status(), 200);
      await button('读取最新内容并比较', 'Read latest and compare').waitFor();
      assert(await button('保存', 'Save', toolbar()).isDisabled()); assert.equal((await nav()).data.links.find(row => row.id === links[0].id).title, newTitle);
      await button('取消', 'Cancel', toolbar()).click(); await toolbar().waitFor({ state: 'hidden' });
      assert.equal(await card(links[0].id).locator('.lh-bookmark-title').innerText(), newTitle, 'Exit exposed stale pre-save dashboard');
      assert.equal(posts(), count + 1, 'Refresh failure repeated the committed save');
      const refresh = page.waitForResponse(value => new URL(value.url()).pathname === '/api/v1/dashboard' && value.ok());
      await page.locator('.lh-more-trigger').click(); await page.getByRole('menuitem', { name: l('刷新内容', 'Refresh content'), exact: true }).click(); await refresh;
      assert.equal(posts(), count + 1);
    });
    await check(provider + '/leave_guard_cancel_discard_and_save_into_existing_layout_editor', async () => {
      const before = await nav(); await start(); await editLink(links[0].id); await field('title').fill(prefix + ' discarded'); await closeDetails(); await layoutMenu();
      const guard = page.getByRole('dialog', { name: l('保存内容修改？', 'Save content changes?'), exact: true }); await guard.waitFor();
      await button('继续编辑', 'Keep editing', guard).click(); assert(await toolbar().isVisible()); assert.equal((await nav()).revision, before.revision);
      await button('取消', 'Cancel', toolbar()).click(); await guard.waitFor(); await button('放弃修改', 'Discard changes', guard).click(); await toolbar().waitFor({ state: 'hidden' }); assert.equal((await nav()).revision, before.revision);
      await start(); await editLink(links[0].id); newTitle = prefix + ' save and layout'; await field('title').fill(newTitle); await closeDetails(); await layoutMenu(); await guard.waitFor();
      await button('保存并离开', 'Save and leave', guard).click(); await page.locator('.lh-composer').waitFor(); assert.equal(await toolbar().count(), 0);
      assert.equal((await nav()).data.links.find(row => row.id === links[0].id).title, newTitle); assert.deepEqual(await savedPage(), fixturePage);
      await button('取消', 'Cancel', page.locator('.lh-composer-toolbar')).click(); await page.locator('.lh-composer').waitFor({ state: 'hidden' });
    });
    await check(provider + '/four_desktops_and_dark_edit_panel_geometry', async () => {
      await start(); await editLink(links[0].id);
      for (const [width, height] of [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Document overflow at ' + width);
        for (const selector of ['.lh-content-toolbar', '.lh-content-inspector', '.lh-content-toolbar-actions']) {
          const box = await page.locator(selector).boundingBox(); assert(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, 'Editor controls clipped: ' + selector + ' at ' + width);
        }
        assert(await details().evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Inspector horizontal overflow');
        const label = await details().locator('[data-content-field=title] > label').boundingBox(), input = await field('title').boundingBox(); assert(label && input && Math.abs(label.y - input.y) <= 14, 'Label and input are not on one row');
        await snapshot('content-' + width + 'x' + height);
      }
      await closeDetails(); await button('取消', 'Cancel', toolbar()).click(); await toolbar().waitFor({ state: 'hidden' });
      await page.locator('.lh-more-trigger').click(); await page.getByRole('menuitem', { name: l('切换深浅色', 'Toggle light or dark'), exact: true }).click(); await page.keyboard.press('Escape');
      await page.locator('.lh-home[data-theme=dark]').waitFor(); await start(); await editLink(links[0].id); await snapshot('content-dark-2560x1080');
      await closeDetails(); await button('取消', 'Cancel', toolbar()).click(); await toolbar().waitFor({ state: 'hidden' });
    });
    await check(provider + '/read_only_shared_space_has_no_content_or_layout_actions', async () => {
      const reader = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: initial.language });
      if (initial.mode === 'private_multi') {
        const account = { username: 'content_reader_' + crypto.randomBytes(4).toString('hex'), password: crypto.randomBytes(24).toString('hex'), displayName: 'Home content reader' }; secrets.push(account.username, account.password);
        await api('/admin/users', 'POST', account, 201); await login(reader, account);
      }
      const state = await boot(reader); assert.equal(state.spaces.find(space => space.id === f.shared)?.canEdit, false);
      const tab = await reader.newPage(); tab.setDefaultTimeout(15000); tab.on('pageerror', error => report.errors.push(scrub(error.message)));
      await tab.goto(BASE + '/#/'); await tab.locator('.lh-home').waitFor(); await shared(tab, reader);
      assert.equal(await tab.locator('.lh-edit-trigger,.lh-nav-drag-handle,.lh-content-toolbar').count(), 0);
      await tab.locator('.lh-more-trigger').click();
      assert.equal(await tab.getByRole('menuitem', { name: l('调整布局', 'Adjust layout'), exact: true }).count(), 0, 'A read-only space exposes layout editing in More');
      assert.equal(await tab.getByRole('menuitem', { name: l('点击统计', 'Click statistics'), exact: true }).count(), state.user ? 1 : 0, 'Statistics visibility does not match the reader identity');
      await tab.keyboard.press('Escape');
      const before = await nav(); await api(batchPath, 'POST', { expectedRevision: before.revision, links: [{ id: links[0].id, patch: { title: 'Forbidden' } }] }, initial.mode === 'private_multi' ? 403 : 401, reader); assert.equal((await nav()).revision, before.revision);
      await reader.close();
    });
    assert.deepEqual(report.errors, [], 'Unhandled browser exceptions'); await context.close(); currentPage = null;
  }
  report.passed = true;
})().catch(error => { report.failure = scrub(error.stack || error); console.error(report.failure); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close(); fs.writeFileSync(path.join(OUT, 'home-content-edit-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
});
