#!/usr/bin/env node
'use strict';
// Real browser activation and statistics regression on an owned disposable
// loopback Home instance only. Creates synthetic links, a push-source snapshot
// and a page configuration. All destinations are this same instance's /health;
// no user website, database, or external destination is used or restored.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'UI_FIXTURES and OUTPUT_DIR are required');
const fixtures = JSON.parse(fs.readFileSync(process.env.UI_FIXTURES, 'utf8')), OUT = path.resolve(process.env.OUTPUT_DIR);
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
const report = { passed: false, startedAt: new Date().toISOString(), checks: [], screenshots: [], errors: [], activations: [], expectedFailures: [], viewports: [], conditionalChecks: [], gesture: 'Actual Playwright pointer, keyboard Enter, modified primary and middle clicks. No synthetic DOM click/auxclick events or navigation overrides.' };
const secrets = Object.values(fixtures).flatMap(f => [f.username, f.password]).filter(Boolean);
const scrub = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));
let browser, currentPage;
async function until(fn, message) { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 60)); } throw Error(message); }
async function check(name, action) {
  const start = Date.now();
  try { await action(); report.checks.push({ name, passed: true, ms: Date.now() - start }); console.log('PASS ' + name); }
  catch (error) {
    report.checks.push({ name, passed: false, error: scrub(error.message) });
    if (currentPage) { const file = name.replaceAll('/', '-') + '-failure.png'; await currentPage.screenshot({ path: path.join(OUT, file), animations: 'disabled', mask: [currentPage.locator('input[type=password]')] }).then(() => report.screenshots.push(file)).catch(() => {}); }
    throw error;
  }
}
const addDays = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

(async () => {
  browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  for (const provider of process.env.UI_PROVIDER ? [process.env.UI_PROVIDER] : Object.keys(fixtures)) {
    const f = fixtures[provider]; assert(f, 'Unknown fixture provider');
    const base = new URL(f.url);
    assert(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash, 'Only disposable loopback HTTP fixtures are allowed');
    const BASE = base.origin, context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'zh-CN', reducedMotion: 'reduce' });
    const page = await context.newPage(); currentPage = page; page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(scrub(error.message)));
    const clickRequests = [];
    function captureRequests(ctx) { ctx.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === BASE && request.method() === 'POST' && /^\/api\/v1\/spaces\/[^/]+\/links\/[^/]+\/clicks$/.test(url.pathname)) {
        let body; try { body = request.postDataJSON(); } catch { body = null; }
        clickRequests.push({ path: url.pathname, body });
      }
    }); }
    captureRequests(context);
    async function boot(ctx = context) { const response = await ctx.request.get(BASE + '/api/v1/bootstrap'); assert(response.ok()); return response.json(); }
    async function api(route, method = 'GET', body, expected = 200, ctx = context) {
      const state = await boot(ctx);
      const response = await ctx.request.fetch(BASE + '/api/v1' + route, { method, data: body, headers: { Origin: BASE, 'X-CSRF-TOKEN': state.csrfToken }, maxRedirects: 0 });
      assert.equal(response.status(), expected, method + ' ' + route + ': HTTP ' + response.status());
      return expected === 204 ? null : response.json();
    }
    const unopened = await boot(); assert.equal(unopened.siteName, 'Release UI fixture ' + provider, 'Named disposable fixture guard must match before writing');
    await api('/auth/login', 'POST', { username: f.username, password: f.password, sessionMode: 'temporary' });
    const initial = await boot(); assert.equal(initial.siteName, 'Release UI fixture ' + provider); assert.equal(initial.user?.role, 'Owner');
    assert(['private_multi', 'public_read'].includes(initial.mode), 'Use private_multi or public_read fixture');
    const l = (zh, en) => initial.language === 'en' ? en : zh;
    const button = (zh, en, scope = page) => scope.getByRole('button', { name: l(zh, en), exact: true });
    const run = crypto.randomBytes(4).toString('hex'), prefix = 'Click test ' + run, spacePath = '/spaces/' + f.shared;
    const navPath = spacePath + '/navigation', statsPath = navPath + '/click-stats', pagePath = spacePath + '/page';
    const nav = () => api(navPath), savedPage = () => api(pagePath), stats = (query = '') => api(statsPath + query);
    const categories = [];
    for (const [name, order] of [['Usage', -800000], ['Zero', -799990]]) categories.push(await api(spacePath + '/categories', 'POST', { name: prefix + ' ' + name, icon: 'lucide:folder', parentId: null, sortOrder: order }, 201));
    const target = kind => BASE + '/health?fixture=click-' + run + '&entry=' + kind;
    const links = [];
    for (let index = 0; index < 9; index++) links.push(await api(spacePath + '/links', 'POST', {
      title: prefix + ' ' + String(index).padStart(2, '0'), url: target('primary-' + index), categoryId: categories[index === 8 ? 1 : 0].id,
      icon: 'lucide:link', iconMode: 'manual', description: 'Owned loopback activation fixture', contextMarkdown: '', tags: ['click-' + run], isFavorite: index === 0, sortOrder: index,
      endpoints: index === 0 ? [{ label: 'Extra', url: target('additional') }] : index === 1 ? [{ label: 'Internal', url: target('internal'), route: 'internal', probePath: '/health' }, { label: 'External', url: target('external'), route: 'external', probePath: '/health' }] : []
    }, 201));
    const main = links[0], routes = links[1], zero = links[8];
    const count = async id => { const data = await stats('?linkId=' + id + '&limit=1'); assert.equal(data.items.length, 1); return data.items[0].totalClicks; };
    const source = await api(spacePath + '/sources', 'POST', { name: prefix + ' snapshot', kind: 'external-push', schemaId: 'navigation.collection', schemaVersion: 1, connection: {}, sync: { mode: 'push', staleAfterSeconds: 3600 }, enabled: true }, 201);
    await api('/sources/' + source.id + '/snapshot', 'PUT', { requestId: 'click-snapshot-' + run, expectedRevision: '0', schemaId: 'navigation.collection', schemaVersion: 1, data: { categories: [], links: [{ externalId: 'external-click-test', categoryExternalId: null, title: prefix + ' external', url: target('source'), description: 'Read-only push snapshot', icon: 'lucide:link', tags: [], isFavorite: false, sortOrder: 0, endpoints: [] }] } });
    const snapshot = await api('/sources/' + source.id + '/snapshot'), externalID = snapshot.data.links[0].id;
    assert(externalID && !links.some(link => link.id === externalID), 'Snapshot bookmark has an independent source identity');
    const original = await savedPage(), viewID = 'click-test-navigation', externalViewID = 'click-test-source';
    const localView = { id: viewID, panel: { id: 'builtin/navigation' }, inputs: { collection: 'navigation' }, interactionScope: 'click-local', settings: { title: prefix, variant: 'cards', groupPreviewCount: 6, showGroupTitles: true, showCounts: true, showTags: false, showEndpoints: true, urlDisplay: 'always', maxColumns: 4 } };
    const config = { ...original.config, pageTheme: { id: 'builtin/dashboard' }, appearance: { colorMode: 'light', density: 'comfortable' }, bindings: {
      navigation: { datasetId: 'local-navigation', space: 'current-page-space', query: { categoryIds: categories.map(category => category.id) } },
      clickSource: { datasetId: source.datasetId || 'source:' + source.id, space: 'current-page-space', query: {} }
    }, views: [localView, { id: externalViewID, panel: { id: 'builtin/navigation' }, inputs: { collection: 'clickSource' }, interactionScope: 'click-source', settings: { title: prefix + ' external', variant: 'cards', showGroupTitles: false } }], layout: { mode: 'regions-grid', gap: 16, grid: { columns: 24 }, placements: {
      [viewID]: { base: { kind: 'flow', region: 'main', order: 0 } }, [externalViewID]: { base: { kind: 'flow', region: 'main', order: 1 } }
    } } };
    await api(pagePath, 'PUT', { name: prefix, expectedRevision: original.revision, config });
    const panel = (tab = page) => tab.locator('.lh-region-item[data-view-id="' + viewID + '"]');
    const card = (id, tab = page) => panel(tab).locator('article.lh-bookmark[data-link-id="' + id + '"]');
    const primary = (id = main.id, tab = page) => card(id, tab).locator('a.lh-bookmark-title');
    async function home(tab = page, ctx = context) {
      await tab.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' }); await tab.locator('.lh-home').waitFor();
      const state = await boot(ctx), sharedName = state.spaces.find(space => space.id === f.shared)?.name; assert(sharedName);
      if (state.spaces.length > 1) { const select = tab.getByRole('combobox', { name: l('选择空间', 'Choose a space'), exact: true }); await select.waitFor(); if (!(await select.innerText()).includes(sharedName)) { await select.click(); await tab.getByRole('option', { name: sharedName, exact: true }).click(); } }
      await primary(main.id, tab).waitFor();
    }
    async function unchanged(baseline) { const current = await nav(); assert.equal(current.revision, baseline.nav.revision, 'Activation changed navigation revision'); assert.deepEqual(current.data, baseline.nav.data, 'Activation changed link metadata including updatedAt'); assert.deepEqual(await savedPage(), baseline.page, 'Activation changed page/layout'); }
    async function baseline() { return { nav: await nav(), page: await savedPage() }; }
    async function frames(tab = page) { await tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
    async function open(anchor, expected, gesture, ctx = context, sourcePage = page) {
      await sourcePage.bringToFront(); await sourcePage.waitForFunction(() => document.hasFocus());
      const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 15000 }), gesture ? gesture() : anchor.click()]);
      await popup.waitForURL(url => url.href === expected, { timeout: 15000 }); await popup.waitForLoadState('domcontentloaded');
      assert.equal(await popup.evaluate(() => window.opener === null), true, 'Destination retains an opener'); assert.equal(await popup.evaluate(() => document.referrer), '', 'Destination received a referrer');
      const body = await popup.locator('body').innerText(); assert.equal(JSON.parse(body).status, 'ok', 'Same-origin destination did not load');
      await popup.close(); await sourcePage.bringToFront(); await sourcePage.waitForFunction(() => document.hasFocus());
    }
    async function activation(name, id, entry, anchor, expected, gesture) {
      const before = await count(id), requests = clickRequests.length, content = await baseline();
      await open(anchor, expected, gesture); await until(() => count(id).then(value => value === before + 1), name + ' was not recorded exactly once'); await frames();
      assert.equal(clickRequests.length, requests + 1, name + ' sent duplicate/missing click requests');
      const posted = clickRequests.at(-1); assert.equal(posted.path, '/api/v1' + spacePath + '/links/' + id + '/clicks'); assert.equal(posted.body.entry, entry); assert.match(posted.body.eventId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      await unchanged(content); report.activations.push({ provider, name, entry, counted: 1, destination: expected });
    }
    await home();
    await check(provider + '/hover_focus_right_click_and_folder_open_do_not_count', async () => {
      const requests = clickRequests.length, before = await count(main.id), content = await baseline();
      await primary().hover(); await primary().focus(); await primary().click({ button: 'right' }); await page.keyboard.press('Escape');
      await panel().locator('.lh-link-group[data-category-id="' + categories[0].id + '"] .lh-folder-more').click(); await page.locator('.lh-folder-dialog').waitFor();
      await button('关闭书签文件夹', 'Close bookmark folder', page.locator('.lh-folder-dialog')).click(); await page.locator('.lh-folder-dialog').waitFor({ state: 'hidden' }); await frames();
      assert.equal(clickRequests.length, requests); assert.equal(await count(main.id), before); await unchanged(content);
    });
    await check(provider + '/pointer_enter_ctrl_middle_and_explicit_entries_count_once', async () => {
      await activation('primary pointer', main.id, 'primary', primary(), main.url);
      await activation('keyboard Enter', main.id, 'primary', primary(), main.url, async () => { await primary().focus(); await primary().press('Enter'); });
      await activation('Control click', main.id, 'primary', primary(), main.url, () => primary().click({ modifiers: ['Control'] }));
      await activation('middle click', main.id, 'primary', primary(), main.url, () => primary().click({ button: 'middle' }));
      await activation('additional endpoint', main.id, 'additional', card(main.id).locator('.lh-additional-endpoints a'), target('additional'));
      await activation('manual internal endpoint', routes.id, 'internal', card(routes.id).locator('.lh-network-endpoints a[data-route="internal"]'), target('internal'));
      await activation('manual external endpoint', routes.id, 'external', card(routes.id).locator('.lh-network-endpoints a[data-route="external"]'), target('external'));
      assert.equal(await count(main.id), 5); assert.equal(await count(routes.id), 2); assert.equal(await count(zero.id), 0);
      const eventIDs = clickRequests.map(row => row.body.eventId); assert.equal(new Set(eventIDs).size, eventIDs.length, 'Separate activations reused an event ID');
    });
    await check(provider + '/source_snapshot_activation_never_posts_a_local_link_count', async () => {
      const requests = clickRequests.length, before = await count(main.id), content = await baseline();
      const external = page.locator('.lh-region-item[data-view-id="' + externalViewID + '"] article[data-link-id="' + externalID + '"] a.lh-bookmark-title');
      await open(external, target('source')); await frames(); assert.equal(clickRequests.length, requests, 'Source snapshot sent a local link counter'); assert.equal(await count(main.id), before); await unchanged(content);
    });
    await check(provider + '/statistics_failure_does_not_block_open_or_retry', async () => {
      const endpoint = BASE + '/api/v1' + spacePath + '/links/' + main.id + '/clicks', before = await count(main.id), requests = clickRequests.length, content = await baseline();
      const failed = page.waitForEvent('requestfailed', { predicate: request => request.url() === endpoint, timeout: 15000 });
      const abort = route => route.abort('failed'); await page.route(endpoint, abort);
      try { await open(primary(), main.url); await failed; await frames(); assert.equal(clickRequests.length, requests + 1); assert.equal(await count(main.id), before); await unchanged(content); }
      finally { await page.unroute(endpoint, abort); }
      report.expectedFailures.push({ provider, kind: 'browser transport abort before commit', countChanged: false, destinationLoaded: true });
    });
    await check(provider + '/content_edit_and_layout_preview_do_not_count', async () => {
      const requests = clickRequests.length, before = await count(main.id);
      await page.locator('.lh-edit-trigger').click(); await page.locator('.lh-content-toolbar').waitFor(); await card(main.id).locator('.lh-bookmark-edit-title').click();
      const inspector = page.locator('.lh-content-inspector'); await inspector.waitFor();
      const summary = inspector.locator('.lh-link-click-summary[data-link-id="' + main.id + '"]'); await summary.locator('[data-stat=totalClicks]').waitFor(); assert.equal((await summary.locator('[data-stat=totalClicks]').innerText()).trim(), String(before));
      await inspector.locator('#home-content-title').fill(main.title + ' edited');
      const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === BASE + '/api/v1' + navPath + '/batch-edit');
      await button('保存', 'Save', page.locator('.lh-content-toolbar')).click(); assert((await saved).ok()); await page.locator('.lh-content-toolbar').waitFor({ state: 'hidden' });
      assert.equal(clickRequests.length, requests); assert.equal(await count(main.id), before);
      const content = await baseline(); await page.locator('.lh-edit-menu summary').click(); await button('调整布局', 'Adjust layout', page.locator('.lh-edit-menu')).click(); await page.locator('.lh-composer').waitFor();
      await button('预览', 'Preview', page.locator('.lh-composer-toolbar')).click(); await page.locator('.lh-composer.is-previewing').waitFor();
      const inert = panel().locator('article[data-link-id="' + main.id + '"] .lh-bookmark-title'); assert.equal(await inert.getAttribute('href'), null); assert.equal(await inert.getAttribute('aria-disabled'), 'true');
      await inert.scrollIntoViewIfNeeded(); const box = await inert.boundingBox(); assert(box && box.width && box.height);
      const receives = await inert.evaluate(node => { const rect = node.getBoundingClientRect(), hit = node.ownerDocument.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return node === hit || node.contains(hit); }); assert(receives, 'Inert preview title is not a real visible hit target');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await frames(); assert.equal(context.pages().length, 1); assert.equal(clickRequests.length, requests); assert.equal(await count(main.id), before);
      await button('取消', 'Cancel', page.locator('.lh-composer-toolbar')).click(); await page.locator('.lh-composer').waitFor({ state: 'hidden' }); await unchanged(content);
    });
    await check(provider + '/statistics_filters_zero_links_recent_click_and_desktop_geometry', async () => {
      const trigger = button('点击统计', 'Click statistics'); if (!(await trigger.isVisible())) await page.locator('.lh-edit-menu summary').click(); await trigger.click();
      const dialog = page.locator('.lh-click-stats-dialog'); await dialog.waitFor();
      const ready = () => dialog.locator('.lh-click-stats-table-wrap[aria-busy=false]').waitFor(); await ready();
      const refreshed = async action => {
        const pending = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/v1' + statsPath);
        await action(); const response = await pending; assert(response.ok(), 'Statistics filter request failed'); await ready(); return response.json();
      };
      const choose = async (name, option) => { await dialog.getByRole('combobox', { name, exact: true }).click(); return refreshed(() => page.getByRole('option', { name: option, exact: true }).click()); };
      await choose(l('分类', 'Category'), categories[1].name);
      const zeroRow = dialog.locator('tbody tr[data-link-id="' + zero.id + '"]'); await zeroRow.waitFor(); assert.equal(await dialog.locator('tbody tr').count(), 1);
      assert.equal((await zeroRow.locator('[data-stat=totalClicks]').innerText()).trim(), '0'); assert.equal((await zeroRow.locator('[data-stat=periodClicks]').innerText()).trim(), '0'); assert.equal((await zeroRow.locator('[data-stat=lastClickedAt]').innerText()).trim(), '—');
      await choose(l('分类', 'Category'), categories[0].name); await choose(l('排序', 'Sort'), l('最近点击', 'Most recent click'));
      const routeRow = dialog.locator('tbody tr[data-link-id="' + routes.id + '"]'); await routeRow.waitFor(); assert.equal(await dialog.locator('tbody tr').first().getAttribute('data-link-id'), routes.id);
      const mainRow = dialog.locator('tbody tr[data-link-id="' + main.id + '"]'); assert.equal((await mainRow.locator('[data-stat=totalClicks]').innerText()).trim(), '5'); assert(await mainRow.locator('[data-stat=lastClickedAt] time').getAttribute('datetime'));
      await refreshed(() => button('最近 7 天', 'Last 7 days', dialog).click()); const to = await dialog.locator('input[name=click-stats-to]').inputValue(); assert.equal(await dialog.locator('input[name=click-stats-from]').inputValue(), addDays(to, -6));
      const rangeRequests = []; const capture = request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/v1' + statsPath) rangeRequests.push(new URL(request.url())); }; page.on('request', capture);
      try { await dialog.locator('input[name=click-stats-from]').fill(to); await dialog.locator('input[name=click-stats-to]').fill(to); await refreshed(() => button('应用', 'Apply', dialog).click()); await until(() => Promise.resolve(rangeRequests.some(url => url.searchParams.get('from') === to && url.searchParams.get('to') === to)), 'Date Apply did not read the selected inclusive UTC day'); }
      finally { page.off('request', capture); }
      assert.equal((await mainRow.locator('[data-stat=periodClicks]').innerText()).trim(), '5');
      const beforeTracking = addDays((await stats()).recordedFrom.slice(0, 10), -1);
      await dialog.locator('input[name=click-stats-from]').fill(beforeTracking); await dialog.locator('input[name=click-stats-to]').fill(beforeTracking);
      await refreshed(() => button('应用', 'Apply', dialog).click());
      assert.equal((await mainRow.locator('[data-stat=periodClicks]').innerText()).trim(), '—', 'Untracked history was shown as an observed zero');
      assert.equal((await mainRow.locator('[data-stat=totalClicks]').innerText()).trim(), '5');
      await dialog.getByText(l('所选日期早于开始记录时间。', 'This range is before recording began.'), { exact: true }).waitFor();
      await dialog.locator('input[name=click-stats-from]').fill(addDays(to, 2));
      await dialog.locator('input[name=click-stats-to]').fill(addDays(to, 4));
      const future = await refreshed(() => button('应用', 'Apply', dialog).click());
      assert(future.days.length > 0 && future.days.every(day => day.tracked === false), 'Future fixture includes an observed day');
      const overview = dialog.locator('.lh-click-stats-summary');
      assert.equal((await overview.locator('[data-stat=periodClicks]').innerText()).trim(), '—', 'Future clicks were shown as an observed zero');
      assert.equal((await overview.locator('[data-stat=activeLinks]').innerText()).trim(), '—', 'Future active links were shown as an observed zero');
      assert.equal((await mainRow.locator('[data-stat=periodClicks]').innerText()).trim(), '—');
      assert.equal((await mainRow.locator('[data-stat=totalClicks]').innerText()).trim(), '5', 'Future range changed the lifetime count');
      await dialog.getByText(l('所选日期尚未记录。', 'This range has not been recorded yet.'), { exact: true }).waitFor();
      await refreshed(() => button('最近 7 天', 'Last 7 days', dialog).click());
      await choose(l('分类', 'Category'), categories[1].name);
      await zeroRow.waitFor();
      assert.equal((await zeroRow.locator('[data-stat=periodClicks]').innerText()).trim(), '0', 'An observed zero became unknown after leaving the future range');
      assert.equal((await overview.locator('[data-stat=periodClicks]').innerText()).trim(), '0');
      assert.equal((await overview.locator('[data-stat=activeLinks]').innerText()).trim(), '0');
      await choose(l('分类', 'Category'), categories[0].name);
      for (const [width, height] of [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080]]) {
        await page.setViewportSize({ width, height }); await frames();
        const bounds = await dialog.boundingBox(); assert(bounds && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1, 'Statistics dialog escapes viewport');
        const geometry = await dialog.evaluate(node => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth })); assert(geometry.scrollWidth <= geometry.clientWidth + 1, 'Statistics dialog has horizontal overflow');
        const controls = await dialog.locator('button,[role=combobox],input').evaluateAll(nodes => nodes.filter(node => { const box = node.getBoundingClientRect(); return box.width && box.height; }).map(node => { const box = node.getBoundingClientRect(); return { x: box.x, right: box.right, y: box.y, bottom: box.bottom }; }));
        assert(controls.every(box => box.x >= -1 && box.right <= width + 1 && box.y >= -1 && box.bottom <= height + 1), 'A statistics control is clipped');
        const file = provider + '-click-statistics-' + width + 'x' + height + '.png'; await page.screenshot({ path: path.join(OUT, file), animations: 'disabled' }); report.screenshots.push(file); report.viewports.push({ provider, width, height, bounds, geometry });
      }
      await button('关闭点击统计', 'Close click statistics', dialog).click(); await dialog.waitFor({ state: 'hidden' });
    });
    await check(provider + '/anonymous_analytics_protection_and_public_click_policy', async () => {
      const anonymous = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: initial.language, reducedMotion: 'reduce' }); captureRequests(anonymous);
      try {
        await api(statsPath, 'GET', undefined, 401, anonymous);
        if (initial.mode === 'public_read') {
          const visitor = await anonymous.newPage(); visitor.setDefaultTimeout(15000); const before = await count(main.id), requests = clickRequests.length, content = await baseline();
          await home(visitor, anonymous); assert.equal(await visitor.getByRole('button', { name: l('点击统计', 'Click statistics'), exact: true }).count(), 0, 'Anonymous visitor sees the analytics entry');
          await open(primary(main.id, visitor), main.url, undefined, anonymous, visitor); await until(() => count(main.id).then(value => value === before + 1), 'Public visitor activation was not counted'); assert.equal(clickRequests.length, requests + 1); await unchanged(content); await visitor.close();
          report.conditionalChecks.push({ provider, mode: initial.mode, anonymousActivation: 'passed' });
        } else {
          await api(spacePath + '/links/' + main.id + '/clicks', 'POST', { eventId: crypto.randomUUID(), entry: 'primary' }, 401, anonymous);
          report.conditionalChecks.push({ provider, mode: initial.mode, anonymousActivation: 'private mode correctly rejects; public browser activation requires a public_read fixture' });
        }
      } finally { await anonymous.close(); }
    });
    assert.deepEqual(report.errors, [], 'Browser raised an unhandled error'); await context.close(); currentPage = null;
  }
  report.passed = true;
})().catch(error => { report.error = scrub(error.stack || error); console.error(report.error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close(); report.completedAt = new Date().toISOString(); fs.writeFileSync(path.join(OUT, 'link-clicks-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
});
