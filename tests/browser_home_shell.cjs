#!/usr/bin/env node
'use strict';
// Disposable loopback fixtures only. Creates isolated navigation, restores the
// original page with its current revision, then deletes only the IDs it created.
// UI_FIXTURES, OUTPUT_DIR, PLAYWRIGHT_MODULE and CHROMIUM_PATH match the other
// owned release-fixture suites. No production database or external site is used.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'UI_FIXTURES and OUTPUT_DIR are required');
const fixtures = JSON.parse(fs.readFileSync(process.env.UI_FIXTURES, 'utf8')), OUT = path.resolve(process.env.OUTPUT_DIR);
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
const report = { passed: false, startedAt: new Date().toISOString(), checks: [], viewports: [], screenshots: [], cleanups: [], errors: [] };
const secrets = Object.values(fixtures).flatMap(f => [f.username, f.password]).filter(Boolean);
const scrub = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));
const sizes = [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080], [390, 844]];
let browser, currentPage;
async function until(fn, message) { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 60)); } throw Error(message); }
async function check(name, action) {
  const start = Date.now();
  try { await action(); report.checks.push({ name, passed: true, ms: Date.now() - start }); console.log('PASS ' + name); }
  catch (error) {
    report.checks.push({ name, passed: false, error: scrub(error.message) });
    if (currentPage && !currentPage.isClosed()) { const file = name.replaceAll('/', '-') + '-failure.png'; await currentPage.screenshot({ path: path.join(OUT, file), animations: 'disabled' }).then(() => report.screenshots.push(file)).catch(() => {}); }
    throw error;
  }
}
const records = dataset => ({ categories: [...dataset.data.categories].sort((a, b) => a.id.localeCompare(b.id)), links: [...dataset.data.links].sort((a, b) => a.id.localeCompare(b.id)) });
function stableNavigation(dataset) {
  const value = structuredClone(dataset);
  // localDataset assigns these two transport timestamps on each GET. Keep
  // revision, every business field and sourceUpdatedAt in the comparison.
  delete value.meta.receivedAt; delete value.meta.lastSuccessAt;
  return value;
}

(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  for (const provider of process.env.UI_PROVIDER ? [process.env.UI_PROVIDER] : Object.keys(fixtures)) {
    const f = fixtures[provider]; assert(f, 'Unknown fixture provider'); const base = new URL(f.url);
    assert(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && !base.username && !base.password && !base.search && !base.hash, 'Only disposable loopback HTTP fixtures are allowed');
    const BASE = base.origin, context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'zh-CN', reducedMotion: 'reduce' });
    const page = await context.newPage(); currentPage = page; page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(scrub(error.message)));
    const uiWrites = []; page.on('request', request => { const url = new URL(request.url()); if (url.origin === BASE && url.pathname.startsWith('/api/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) uiWrites.push({ method: request.method(), path: url.pathname }); });
    async function boot() { const response = await context.request.get(BASE + '/api/v1/bootstrap'); assert(response.ok()); return response.json(); }
    async function api(route, method = 'GET', body, expected = 200) {
      const state = await boot(), response = await context.request.fetch(BASE + '/api/v1' + route, { method, data: body, headers: { Origin: BASE, 'X-CSRF-TOKEN': state.csrfToken }, maxRedirects: 0 });
      assert.equal(response.status(), expected, method + ' ' + route + ': HTTP ' + response.status()); return expected === 204 ? null : response.json();
    }
    await api('/auth/login', 'POST', { username: f.username, password: f.password, sessionMode: 'temporary' });
    const initial = await boot(); assert.equal(initial.siteName, 'Release UI fixture ' + provider, 'Named disposable fixture guard must match');
    const l = (zh, en) => initial.language === 'en' ? en : zh;
    const button = (zh, en, scope = page) => scope.getByRole('button', { name: l(zh, en), exact: true });
    const menuItem = (zh, en) => page.getByRole('menuitem', { name: l(zh, en), exact: true });
    const prefix = 'Shell ' + crypto.randomBytes(4).toString('hex'), spacePath = '/spaces/' + f.shared, pagePath = spacePath + '/page';
    const savedPage = () => api(pagePath), navigation = () => api(spacePath + '/navigation');
    const originalPage = await savedPage(), originalNavigation = records(await navigation()), categoryIDs = [], linkIDs = [];
    let expectedPage = null;
    async function category(label, order) { const row = await api(spacePath + '/categories', 'POST', { name: prefix + ' ' + label, icon: 'lucide:folder', parentId: null, sortOrder: order }, 201); categoryIDs.push(row.id); return row; }
    async function link(categoryId, label, order) { const row = await api(spacePath + '/links', 'POST', { title: prefix + ' ' + label, url: 'https://example.invalid/home-shell/' + order, categoryId, icon: 'lucide:link', iconMode: 'manual', description: 'Synthetic layout fixture', tags: ['shell-test'], isFavorite: false, sortOrder: order }, 201); linkIDs.push(row.id); return row; }
    async function frames() { await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }); }
    const body = () => page.locator('.lh-home-scroll');
    async function home() {
      const target = BASE + '/#/';
      // A hash-only goto to the current route can keep React's old dashboard.
      // Fixture API writes therefore need a real reload when already at Home.
      if (page.url() === target) await page.reload({ waitUntil: 'domcontentloaded' });
      else await page.goto(target, { waitUntil: 'domcontentloaded' });
      await page.locator('.lh-home').waitFor();
      const state = await boot(), name = state.spaces.find(space => space.id === f.shared)?.name; assert(name);
      if (state.spaces.length > 1) { const select = page.getByRole('combobox', { name: l('选择空间', 'Choose a space'), exact: true }); await select.waitFor(); if (!(await select.innerText()).includes(name)) { await select.click(); await page.getByRole('option', { name, exact: true }).click(); } }
      await page.locator('[data-view-id=home-shell-navigation]').waitFor(); await body().waitFor();
      if (expectedPage) {
        const expectedViews = expectedPage.config.views.map(view => view.id).sort();
        await until(() => page.locator('.lh-home [data-view-id]').evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('data-view-id')))].sort()).then(actual => JSON.stringify(actual) === JSON.stringify(expectedViews)), 'Home did not render the current fixture view set');
      }
      await frames();
    }
    async function apply(config) { const current = await savedPage(); expectedPage = await api(pagePath, 'PUT', { name: prefix, expectedRevision: current.revision, config }); await home(); }
    async function more() { const menu = page.locator('.lh-home-actions-menu'); if (!(await menu.isVisible())) await button('更多', 'More').click(); await menu.waitFor(); return menu; }
    async function layout() { await more(); await menuItem('调整布局', 'Adjust layout').click(); }
    async function snapshot(name) { const file = provider + '-' + name + '.png'; await page.screenshot({ path: path.join(OUT, file), animations: 'disabled' }); report.screenshots.push(file); }
    async function geometry(label, ordinaryHeader = true) {
      await frames();
      const g = await page.evaluate(() => {
        const rect = selector => { const node = document.querySelector(selector); if (!node) return null; const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; };
        const scroller = document.querySelector('.lh-home-scroll');
        return { width: innerWidth, height: innerHeight, documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight), windowY: scrollY,
          header: rect('.lh-header'), customHeader: rect('[data-chrome-area=header]'), footer: rect('[data-chrome-area=footer]'), body: rect('.lh-home-scroll'), toolbar: rect('.lh-content-toolbar'), composerToolbar: rect('.lh-composer-toolbar'),
          scrollTop: scroller.scrollTop, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight, bodyWidth: scroller.clientWidth, bodyScrollWidth: scroller.scrollWidth };
      });
      assert(g.documentWidth <= g.width + 1 && g.documentHeight <= g.height + 1, label + ': outer document scrollbars');
      assert.equal(g.windowY, 0, label + ': outer document scrolled'); assert(g.bodyWidth >= g.bodyScrollWidth - 1, label + ': horizontal body overflow');
      for (const name of ['customHeader', 'footer', 'body', ...(ordinaryHeader ? ['header'] : []), ...(g.toolbar ? ['toolbar'] : []), ...(g.composerToolbar ? ['composerToolbar'] : [])]) {
        const box = g[name]; assert(box && box.width > 0 && box.height > 0 && box.x >= -1 && box.y >= -1 && box.right <= g.width + 1 && box.bottom <= g.height + 1, label + ': ' + name + ' leaves viewport');
      }
      assert(g.body.y >= g.customHeader.bottom - 1, label + ': body hides under custom header');
      assert(g.body.bottom <= g.footer.y + 1, label + ': body hides under footer');
      if (g.header) assert(g.customHeader.y >= g.header.bottom - 1, label + ': header overlaps custom header');
      return g;
    }
    async function pinnedScroll(label, ordinaryHeader = true, wheel = false) {
      await body().evaluate(node => { node.scrollTop = 0; }); const before = await geometry(label + ' at top', ordinaryHeader);
      assert(before.scrollHeight > before.clientHeight + 100, label + ': long fixture must actually overflow');
      if (wheel) { await page.mouse.move(before.body.x + before.body.width * .7, before.body.y + Math.min(150, before.body.height / 2)); await page.mouse.wheel(0, 600); await until(() => body().evaluate(node => node.scrollTop > 10), label + ': wheel did not scroll the content'); }
      await body().evaluate(node => { node.scrollTop = node.scrollHeight; }); const after = await geometry(label + ' at bottom', ordinaryHeader);
      assert(Math.abs(after.scrollHeight - after.clientHeight - after.scrollTop) <= 2, label + ': content cannot reach its bottom');
      for (const name of ['customHeader', 'footer', ...(ordinaryHeader ? ['header'] : []), ...(before.toolbar ? ['toolbar'] : []), ...(before.composerToolbar ? ['composerToolbar'] : [])]) {
        assert(Math.abs(before[name].y - after[name].y) <= 1 && Math.abs(before[name].bottom - after[name].bottom) <= 1, label + ': ' + name + ' moved with body');
      }
      // Editing exposes empty-category drop targets after the final link. Reach
      // the content end above, then verify the actual final link remains usable.
      const last = page.locator('[data-view-id=home-shell-tail] article.lh-bookmark').last();
      await last.scrollIntoViewIfNeeded(); const accessible = await geometry(label + ' at final link', ordinaryHeader), box = await last.boundingBox();
      assert(box && box.y >= accessible.body.y - 1 && box.y + box.height <= accessible.body.bottom + 1, label + ': final card is obscured');
      assert(await last.evaluate(node => { const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return node === hit || node.contains(hit); }), label + ': final card is covered by another surface');
      report.viewports.push({ provider, label, ...after }); return after;
    }
    try {
      const short = await category('Short', -910000), long = await category('Long', -909990), tail = await category('End', -909980);
      const first = await link(short.id, 'First link', 0); await link(short.id, 'Second link', 1);
      for (let index = 0; index < 80; index++) await link(long.id, 'Long link ' + String(index + 1).padStart(2, '0'), index);
      await link(tail.id, 'Last visible link', 0);
      const view = (id, panel, collection, settings = {}) => ({ id, panel: { id: 'builtin/' + panel }, inputs: panel === 'search' ? {} : { collection }, interactionScope: 'home-shell', settings });
      const config = large => ({ ...originalPage.config, pageTheme: { id: 'builtin/dashboard' }, appearance: { colorMode: 'light', density: 'comfortable' },
        chrome: { header: { enabled: true, left: [{ id: 'shell-header', type: 'text', text: 'Shell header' }], center: [], right: [] }, footer: { enabled: true, left: [{ id: 'shell-footer', type: 'text', text: 'Shell footer' }], center: [], right: [{ id: 'shell-branding', type: 'branding' }] } },
        bindings: { navigation: { datasetId: 'local-navigation', space: 'current-page-space', query: { categoryIds: large ? [short.id, long.id] : [short.id] } }, tail: { datasetId: 'local-navigation', space: 'current-page-space', query: { categoryIds: [tail.id] } } },
        views: [view('home-shell-categories', 'category-navigation', 'navigation', { hierarchyMode: 'tree', displayMode: 'icon-text', showCounts: true }), view('home-shell-search', 'search'),
          view('home-shell-navigation', 'navigation', 'navigation', { variant: 'cards', groupPreviewCount: 0, showGroupTitles: true, showCounts: true, showTags: true, maxColumns: 4 }),
          ...(large ? [view('home-shell-tail', 'navigation', 'tail', { variant: 'cards', groupPreviewCount: 0, showGroupTitles: true, maxColumns: 4 })] : [])],
        layout: { mode: 'regions-grid', gap: 16, grid: { columns: 24 }, placements: { 'home-shell-categories': { base: { kind: 'region', region: 'left', order: 0 } }, 'home-shell-search': { base: { kind: 'region', region: 'top', order: 0 } }, 'home-shell-navigation': { base: { kind: 'flow', region: 'main', order: 0 } }, ...(large ? { 'home-shell-tail': { base: { kind: 'flow', region: 'main', order: 1 } } } : {}) } }
      });
      await apply(config(false));
      await check(provider + '/short_pages_keep_header_footer_and_compact_actions_in_view', async () => {
        for (const [width, height] of sizes) {
          await page.setViewportSize({ width, height }); const g = await geometry('short ' + width + 'x' + height);
          assert(g.scrollHeight <= g.clientHeight + 1, 'Short fixture unexpectedly scrolls at ' + width);
          const actions = page.locator('.lh-header-actions'); assert(await actions.getByRole('button').count() <= 3, 'Too many always-visible header actions');
          for (const control of [button('编辑', 'Edit', actions), button('更多', 'More', actions)]) { const box = await control.boundingBox(); assert(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height, 'Primary action is clipped'); }
          assert.equal(await actions.locator('a[href="#/admin"],a[href="#/library"],[role=combobox]').count(), 0, 'Secondary navigation or space selector still clutters actions');
          report.viewports.push({ provider, label: 'short', ...g });
        }
      });
      await page.setViewportSize({ width: 1600, height: 900 });
      await check(provider + '/more_menu_keyboard_theme_view_and_statistics', async () => {
        const trigger = button('更多', 'More'); await trigger.focus(); await page.keyboard.press('ArrowDown'); const menu = page.locator('.lh-home-actions-menu'); await menu.waitFor();
        await until(() => menu.evaluate(node => node.contains(document.activeElement) && /^menuitem/.test(document.activeElement.getAttribute('role') || '')), 'Keyboard did not focus a menu item');
        await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
        await until(() => trigger.evaluate(node => document.activeElement === node), 'Escape did not restore More focus');
        await more(); await page.locator('.lh-home-heading h1').click(); await menu.waitFor({ state: 'hidden' });
        await more(); const directory = page.getByRole('menuitemradio', { name: l('目录模式', 'Directory view'), exact: true }); await directory.click(); assert.equal(await directory.getAttribute('aria-checked'), 'true');
        await page.getByRole('menuitemradio', { name: l('卡片模式', 'Card view'), exact: true }).click();
        await menuItem('切换深浅色', 'Toggle light or dark').click(); await page.locator('.lh-home[data-theme=dark]').waitFor();
        if (!(await menu.isVisible())) await more(); assert.equal(await menu.getAttribute('data-theme'), 'dark');
        const box = await menu.boundingBox(); assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1600 && box.y + box.height <= 900, 'Menu escapes the viewport');
        await snapshot('more-dark-1600x900'); await page.keyboard.press('Escape');
        await more(); await menuItem('点击统计', 'Click statistics').click(); const stats = page.locator('.lh-click-stats-dialog'); await stats.waitFor();
        await until(() => stats.evaluate(node => node.contains(document.activeElement)), 'Opening Statistics from More lost dialog focus');
        await button('关闭点击统计', 'Close click statistics', stats).click(); await stats.waitFor({ state: 'hidden' });
        await until(() => trigger.evaluate(node => document.activeElement === node), 'Closing Statistics did not restore More focus');
        await more(); await menuItem('切换深浅色', 'Toggle light or dark').click(); await page.locator('.lh-home[data-theme=light]').waitFor(); await page.keyboard.press('Escape');
      });
      await apply(config(true));
      await check(provider + '/long_pages_scroll_only_content_and_reach_the_last_link', async () => {
        for (const [width, height] of sizes) {
          await page.setViewportSize({ width, height }); await pinnedScroll('long ' + width + 'x' + height, true, true);
          const menu = await more(), box = await menu.boundingBox(); assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, 'More menu is clipped at ' + width);
          await page.keyboard.press('Escape'); await snapshot('long-' + width + 'x' + height);
        }
      });
      await page.setViewportSize({ width: 1600, height: 900 }); await body().evaluate(node => { node.scrollTop = 0; });
      await check(provider + '/content_editing_keeps_chrome_and_guards_menu_navigation', async () => {
        const before = await navigation(), beforePage = await savedPage(); await button('编辑', 'Edit').click(); const toolbar = page.locator('.lh-content-toolbar'); await button('保存', 'Save', toolbar).waitFor();
        await pinnedScroll('content edit 1600x900'); await body().evaluate(node => { node.scrollTop = 0; });
        const handle = page.locator('article[data-link-id="' + first.id + '"] .lh-nav-drag-handle');
        await handle.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' })); const dragBox = await handle.boundingBox(); assert(dragBox);
        const startX = dragBox.x + dragBox.width / 2, startY = dragBox.y + dragBox.height / 2; await page.mouse.move(startX, startY); await page.mouse.down();
        try {
          await page.mouse.move(startX + 8, startY, { steps: 4 }); await until(() => handle.evaluate(node => node.classList.contains('is-dragging')), 'Native content drag did not start');
          const edge = await body().boundingBox(), initialScroll = await body().evaluate(node => node.scrollTop); assert(edge);
          await page.mouse.move(edge.x + edge.width * .7, edge.y + edge.height - 12, { steps: 20 });
          await until(() => body().evaluate(node => node.scrollTop).then(value => value > initialScroll + 40), 'Native drag at the content edge did not scroll its container');
          await page.keyboard.press('Escape');
        } finally { await page.mouse.up(); }
        await geometry('content drag keeps chrome'); await body().evaluate(node => { node.scrollTop = 0; });
        await page.locator('article[data-link-id="' + first.id + '"] .lh-bookmark-edit-title').click(); const inspector = page.locator('.lh-content-inspector'); await inspector.waitFor();
        await inspector.locator('#home-content-title').fill(first.title + ' unsaved'); await button('关闭编辑面板', 'Close edit panel', inspector).click(); await inspector.waitFor({ state: 'hidden' });
        await layout(); const leave = page.getByRole('dialog', { name: l('保存内容修改？', 'Save content changes?'), exact: true }); await leave.waitFor();
        await button('继续编辑', 'Keep editing', leave).click(); await leave.waitFor({ state: 'hidden' }); assert(await toolbar.isVisible(), 'Keep editing discarded the draft');
        await layout(); await leave.waitFor(); await button('放弃修改', 'Discard changes', leave).click(); await page.locator('.lh-composer').waitFor();
        await button('取消', 'Cancel', page.locator('.lh-composer-toolbar')).click(); await page.locator('.lh-composer').waitFor({ state: 'hidden' });
        assert.deepEqual(stableNavigation(await navigation()), stableNavigation(before), 'Cancelling menu handoff changed navigation'); assert.deepEqual(await savedPage(), beforePage, 'Cancelling menu handoff changed the saved page');
      });
      await check(provider + '/layout_inspection_and_preview_keep_enabled_chrome', async () => {
        await layout(); await page.locator('.lh-composer').waitFor(); await pinnedScroll('layout inspection 1600x900', false);
        await button('预览', 'Preview', page.locator('.lh-composer-toolbar')).click(); await page.locator('.lh-composer.is-previewing').waitFor();
        for (const [width, height] of [[1600, 900], [390, 844]]) { await page.setViewportSize({ width, height }); await pinnedScroll('layout preview ' + width + 'x' + height); await snapshot('layout-preview-' + width + 'x' + height); }
        await button('取消', 'Cancel', page.locator('.lh-composer-toolbar')).click(); await page.locator('.lh-composer').waitFor({ state: 'hidden' });
      });
      await check(provider + '/enlarged_iframe_preview_scroll_and_two_stage_escape', async () => {
        await page.setViewportSize({ width: 1600, height: 900 }); const beforePage = await savedPage(), beforeNavigation = await navigation();
        await page.goto(BASE + '/#/admin?tab=appearance&spaceId=' + encodeURIComponent(f.shared), { waitUntil: 'domcontentloaded' });
        await button('预览首页', 'Preview homepage', page.locator('.admin-layout-tabbar')).click();
        // Use the inline preview: its parent editor fields remain available,
        // unlike the enlarged preview's modal-covered page-name field.
        const inline = page.locator('.admin-page-preview'); await inline.locator('.admin-preview-stage[aria-busy=false]').waitFor();
        const inlineFrame = await (await inline.locator('iframe').elementHandle()).contentFrame(); assert(inlineFrame, 'Inline preview must contain a real iframe');
        await inlineFrame.getByRole('button', { name: l('更多', 'More'), exact: true }).click();
        const inlineMenu = inlineFrame.locator('.lh-home-actions-menu'); await inlineMenu.waitFor();
        const parentName = page.getByRole('textbox', { name: l('页面名称', 'Page name'), exact: true });
        await parentName.click(); await inlineMenu.waitFor({ state: 'hidden' }); await frames();
        assert(await parentName.evaluate(node => document.activeElement === node), 'Closing the iframe menu stole focus from the parent page-name field');
        await button('放大预览', 'Enlarge preview').click(); const expanded = page.locator('.admin-preview-dialog'); await expanded.waitFor();
        await expanded.getByRole('combobox', { name: l('预览分辨率', 'Preview resolution'), exact: true }).click();
        await page.getByRole('option', { name: '1600 × 900', exact: true }).click();
        await expanded.locator('.admin-preview-stage[aria-busy=false]').waitFor(); const iframe = expanded.locator('iframe'); await iframe.waitFor();
        const frame = await (await iframe.elementHandle()).contentFrame(); assert(frame, 'Enlarged preview must contain a real iframe');
        await frame.locator('.lh-home[data-preview=true]').waitFor(); await frame.locator('[data-view-id=home-shell-tail] article.lh-bookmark').waitFor();
        await until(() => frame.evaluate(() => innerWidth === 1600 && innerHeight === 900), 'Iframe did not reach its selected resolution');
        const read = async () => {
          // The intentionally script-disabled iframe cannot run its own rAF poller.
          // Poll from the test host and wait for paint in the parent document.
          await frames();
          return frame.evaluate(() => {
            const rect = selector => { const node = document.querySelector(selector), box = node?.getBoundingClientRect(); return box ? { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height } : null; };
            const scroller = document.querySelector('.lh-home-scroll');
            return { width: innerWidth, height: innerHeight, documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight), windowY: scrollY,
              header: rect('.lh-header'), customHeader: rect('[data-chrome-area=header]'), footer: rect('[data-chrome-area=footer]'), body: rect('.lh-home-scroll'), lastCard: rect('[data-view-id=home-shell-tail] article.lh-bookmark'), scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
          });
        };
        const content = frame.locator('.lh-home-scroll'); await content.evaluate(node => { node.scrollTop = 0; }); const top = await read();
        assert(top.scrollHeight > top.clientHeight + 100, 'Iframe long-content fixture must actually overflow');
        await content.hover(); await page.mouse.wheel(0, 600); await until(() => content.evaluate(node => node.scrollTop > 10), 'Iframe wheel did not reach its content scroller');
        await content.evaluate(node => { node.scrollTop = node.scrollHeight; }); const bottom = await read();
        assert(bottom.documentWidth <= bottom.width + 1 && bottom.documentHeight <= bottom.height + 1 && bottom.windowY === 0, 'Iframe developed an outer document scrollbar');
        for (const name of ['header', 'customHeader', 'footer', 'body']) {
          const box = bottom[name]; assert(box && box.width > 0 && box.height > 0 && box.x >= -1 && box.y >= -1 && box.right <= bottom.width + 1 && box.bottom <= bottom.height + 1, 'Iframe ' + name + ' leaves its actual viewport');
          assert(Math.abs(top[name].y - box.y) <= 1 && Math.abs(top[name].bottom - box.bottom) <= 1, 'Iframe ' + name + ' moved with content');
        }
        assert(bottom.body.y >= bottom.customHeader.bottom - 1 && bottom.body.bottom <= bottom.footer.y + 1, 'Iframe chrome overlaps its content viewport');
        assert(Math.abs(bottom.scrollHeight - bottom.clientHeight - bottom.scrollTop) <= 2, 'Iframe content cannot reach its end');
        assert(bottom.lastCard && bottom.lastCard.y >= bottom.body.y - 1 && bottom.lastCard.bottom <= bottom.body.bottom + 1, 'Iframe final card is obscured');
        const trigger = frame.getByRole('button', { name: l('更多', 'More'), exact: true });
        const parentTitle = expanded.getByRole('heading', { name: l('首页预览', 'Homepage preview'), exact: true });
        await parentTitle.click(); await trigger.click(); const menu = frame.locator('.lh-home-actions-menu'); await menu.waitFor();
        await parentTitle.click(); await menu.waitFor({ state: 'hidden' });
        await trigger.press('ArrowDown'); await menu.waitFor();
        const cards = menu.getByRole('menuitemradio', { name: l('卡片模式', 'Card view'), exact: true });
        const directory = menu.getByRole('menuitemradio', { name: l('目录模式', 'Directory view'), exact: true });
        await until(() => cards.evaluate(node => document.activeElement === node), 'Iframe keyboard open did not focus the first item');
        await page.keyboard.press('ArrowDown'); await until(() => directory.evaluate(node => document.activeElement === node), 'Iframe ArrowDown skipped the next item');
        await page.keyboard.press('Enter'); assert.equal(await directory.getAttribute('aria-checked'), 'true');
        await page.keyboard.press('ArrowUp'); await until(() => cards.evaluate(node => document.activeElement === node), 'Iframe ArrowUp did not return to the previous item');
        await page.keyboard.press('Enter'); assert.equal(await cards.getAttribute('aria-checked'), 'true');
        assert.equal(await menu.getByRole('menuitemradio').count(), 2, 'Preview lost temporary display choices');
        assert.equal(await menu.getByRole('menuitem').count(), 1, 'Preview exposes maintenance actions');
        await menu.getByRole('menuitem', { name: l('切换深浅色', 'Toggle light or dark'), exact: true }).waitFor();
        assert.equal(await menu.locator('a').count(), 0, 'Preview exposes navigation out of the draft');
        await snapshot('enlarged-iframe-more-1600x900');
        await menu.press('Escape'); await menu.waitFor({ state: 'hidden' }); assert(await expanded.isVisible(), 'First Escape closed the enlarged preview instead of only its menu');
        await until(() => trigger.evaluate(node => node === document.activeElement), 'Iframe Escape did not restore More focus');
        await trigger.press('Escape'); await expanded.waitFor({ state: 'hidden' });
        await until(() => button('放大预览', 'Enlarge preview').evaluate(node => node === document.activeElement), 'Closing enlarged preview did not restore the admin trigger');
        assert(await page.locator('.admin-layout-form').isVisible(), 'Second Escape did not return to the admin layout editor');
        assert.deepEqual(await savedPage(), beforePage, 'Iframe browsing changed the saved page'); assert.deepEqual(stableNavigation(await navigation()), stableNavigation(beforeNavigation), 'Iframe browsing changed navigation');
        report.viewports.push({ provider, label: 'enlarged iframe 1600x900', ...bottom });
        await home();
      });
      await check(provider + '/explicitly_disabled_custom_chrome_stays_disabled', async () => {
        const disabled = config(false); disabled.chrome.header.enabled = false; disabled.chrome.footer.enabled = false; await apply(disabled);
        assert.equal(await page.locator('[data-chrome-area]').count(), 0, 'The shell overrode explicitly disabled chrome'); assert(await page.locator('.lh-header').isVisible(), 'Disabling custom chrome removed the main header');
      });
      assert.deepEqual(uiWrites, [], 'Read-only shell interactions unexpectedly wrote server state'); assert.deepEqual(report.errors, [], 'Unhandled browser errors');
    } finally {
      const cleanup = { provider, passed: false, pageRestored: false, createdLinksRemoved: 0, createdCategoriesRemoved: 0 };
      try {
        await page.close(); currentPage = null;
        if (expectedPage) { const current = await savedPage(); assert.equal(current.revision, expectedPage.revision, 'Fixture page changed concurrently; refusing to overwrite it during cleanup'); assert.deepEqual(current.config, expectedPage.config, 'Fixture page changed concurrently'); await api(pagePath, 'PUT', { name: originalPage.name, expectedRevision: current.revision, config: originalPage.config }); cleanup.pageRestored = true; }
        if (linkIDs.length) { const current = await navigation(); await api(spacePath + '/links/batch', 'POST', { operation: 'delete', linkIds: linkIDs, expectedRevision: current.revision }); cleanup.createdLinksRemoved = linkIDs.length; }
        for (const id of categoryIDs) { await api(spacePath + '/categories/' + id, 'DELETE', undefined, 204); cleanup.createdCategoriesRemoved++; }
        assert.deepEqual(records(await navigation()), originalNavigation, 'Fixture cleanup changed pre-existing navigation'); const restored = await savedPage(); assert.equal(restored.name, originalPage.name); assert.deepEqual(restored.config, originalPage.config); cleanup.passed = true;
      } catch (error) { cleanup.error = scrub(error.message); throw error; }
      finally { report.cleanups.push(cleanup); await context.close(); }
    }
  }
  report.passed = true;
})().catch(error => { report.error = scrub(error.stack || error); console.error(report.error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close(); report.completedAt = new Date().toISOString(); fs.writeFileSync(path.join(OUT, 'home-shell-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
});
