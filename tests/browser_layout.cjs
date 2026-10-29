#!/usr/bin/env node
'use strict';
/**
 * Layout and interaction acceptance for the dedicated ownerless open_edit demo.
 * BASE_URL=http://demo-host:5182 node tests/browser_layout.cjs --allow-demo-write --phase viewport
 * Use --phase interactions [--interaction search|favorite|grid|all] for UI mutations.
 * Optional: LINGSHU_PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE, SCREENSHOT_DIR.
 * Uses a new independent Chromium/context. Never uses Gate's persistent browser profile.
 * Every browser step and read/mutation-response wait has a 10-second timeout.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const STEP = 10_000;
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const inline = args.find(arg => arg.startsWith(name + '='));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const phase = flag('--phase', 'viewport');
const interaction = flag('--interaction', 'all');
const sizes = [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080], [768, 1024], [390, 844]];
const started = Date.now();
const runId = randomUUID().slice(0, 12);
const screenshotDir = path.resolve(process.env.SCREENSHOT_DIR || path.join(process.cwd(), '.runtime', 'browser-layout'));
let browser, context, page, base, space, initialPage, initialNavigation;
let assertions = 0;
let active = 'preflight';
const pageErrors = [], consoleErrors = [], writes = [], results = [];
function check(value, message) { assert.ok(value, message); assertions++; }
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); assertions++; }
function emit(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function step(label) { emit({ event: 'step', phase: active, label, elapsedMs: Date.now() - started }); }
async function read(relative) {
  const response = await context.request.get(base.origin + '/api/v1' + relative, { timeout: STEP, maxRedirects: 0 });
  check(response.ok(), `GET ${relative} returned HTTP ${response.status()}`);
  return response.json();
}
async function readPage() { return read(`/spaces/${space.id}/page`); }
async function readNavigation() { return read(`/spaces/${space.id}/navigation`); }
async function mutation(method, relative, action) {
  const [response] = await Promise.all([
    page.waitForResponse(value => value.request().method() === method && new URL(value.url()).pathname === '/api/v1' + relative, { timeout: STEP }),
    action(),
  ]);
  check(response.ok(), `${method} ${relative} returned HTTP ${response.status()}`);
  return response.status() === 204 ? null : response.json();
}
async function settle() {
  const key = randomUUID();
  await page.waitForFunction(token => {
    const home = document.querySelector('.lh-home');
    if (!home || document.fonts.status !== 'loaded' || [...home.querySelectorAll('img')].some(img => !img.complete)) return false;
    if (home.querySelector('.react-draggable-dragging,.resizing,.react-grid-placeholder')) return false;
    const nodes = [home, ...home.querySelectorAll('.react-grid-item,.lh-bookmark,.lh-side-region,.lh-top-region,.lh-bottom-region')];
    const geometry = nodes.map(node => {
      const r = node.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map(value => Math.round(value * 10));
    });
    const signature = JSON.stringify([document.documentElement.scrollWidth, document.documentElement.scrollHeight, geometry]);
    const probe = window.__lingshuLayoutProbe;
    if (!probe || probe.token !== token || probe.signature !== signature) {
      window.__lingshuLayoutProbe = { token, signature, frames: 0, changedAt: performance.now() };
      return false;
    }
    probe.frames++;
    return probe.frames >= 8 && performance.now() - probe.changedAt >= 180;
  }, key, { polling: 'raf', timeout: STEP });
}
async function home({ reload = false } = {}) {
  if (reload) await page.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded', timeout: STEP });
  else if (await page.locator('.admin-shell').isVisible()) await page.getByRole('button', { name: '返回导航', exact: true }).click();
  await page.locator('.lh-home-heading h1').waitFor({ state: 'visible', timeout: STEP });
  await page.waitForFunction(() => !!document.querySelector('.lh-home-summary') && document.querySelectorAll('.lh-bookmark').length > 0, null, { timeout: STEP });
  await settle();
}
async function capture(name) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const output = path.join(screenshotDir, `${name}.png`);
  await page.screenshot({ path: output, fullPage: true, animations: 'disabled', timeout: STEP });
  return output;
}
async function preflight() {
  check(args.includes('--allow-demo-write'), 'Explicit --allow-demo-write is required for the dedicated demo');
  check(['viewport', 'interactions', 'all'].includes(phase), '--phase must be viewport, interactions, or all');
  check(['search', 'favorite', 'grid', 'all'].includes(interaction), '--interaction must be search, favorite, grid, or all');
  check(!!process.env.BASE_URL, 'BASE_URL must be explicit');
  base = new URL(process.env.BASE_URL);
  check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password, 'Use an HTTP(S) instance URL without credentials');
  check(base.pathname === '/' && !base.search && !base.hash, 'BASE_URL must be an instance root');
  check(base.port !== '5180', 'Port 5180 is reserved for the uninitialized main service');
  const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, timeout: STEP, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'] });
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'zh-CN', timezoneId: 'UTC', reducedMotion: 'reduce' });
  context.setDefaultTimeout(STEP); context.setDefaultNavigationTimeout(STEP);
  const bootstrap = await read('/bootstrap');
  equal(bootstrap.initialized, true, 'Target is already initialized');
  equal(bootstrap.mode, 'open_edit', 'Target uses open_edit');
  check(bootstrap.user == null, 'No account is signed in');
  if ('hasOwner' in bootstrap) equal(bootstrap.hasOwner, false, 'Bootstrap has no Owner');
  const settings = await read('/settings');
  equal(settings.mode, 'open_edit', 'Settings confirm open_edit');
  if ('hasOwner' in settings) equal(settings.hasOwner, false, 'Target has no Owner');
  space = bootstrap.spaces.find(item => item.id === bootstrap.defaultSpaceId);
  check(space?.kind === 'shared' && space.published && space.canEdit, 'Default demo space is shared, published and writable');
  initialPage = await readPage(); initialNavigation = await readNavigation();
  equal(initialPage.config.schemaVersion, 2, 'Page uses Schema 2');
  equal(initialNavigation.schemaId, 'navigation.collection', 'Authoritative navigation schema is correct');
  check(initialNavigation.data.links.length > 0, 'Demo already has real saved example bookmarks');
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base.origin && url.pathname.startsWith('/api/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname });
  });
  await context.route('**/*', route => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort('blockedbyclient'));
  await home({ reload: true });
  emit({ event: 'preflight', status: 'passed', origin: base.origin, ownerless: true, links: initialNavigation.data.links.length, categories: initialNavigation.data.categories.length });
}
async function geometry() {
  return page.evaluate(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const clippedRect = node => {
      const r = rect(node);
      for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent), p = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { r.left = Math.max(r.left, p.left + parent.clientLeft); r.right = Math.min(r.right, p.left + parent.clientLeft + parent.clientWidth); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { r.top = Math.max(r.top, p.top + parent.clientTop); r.bottom = Math.min(r.bottom, p.top + parent.clientTop + parent.clientHeight); }
      }
      r.width = Math.max(0, r.right - r.left); r.height = Math.max(0, r.bottom - r.top);
      return r;
    };
    const overlap = items => {
      const errors = [];
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const x = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const y = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (x > 1 && y > 1) errors.push({ first: a.id, second: b.id, width: Math.round(x), height: Math.round(y) });
      }
      return errors;
    };
    const panels = [...document.querySelectorAll('.lh-home-grid .react-grid-item:not(.react-grid-placeholder)')].map(node => ({ id: node.querySelector('[data-panel-id]')?.getAttribute('data-panel-id') || 'unknown', rect: rect(node) })).filter(item => item.rect.width > 1 && item.rect.height > 1);
    // Intersect with actual overflow clips. Offscreen content within a legitimate
    // fixed-height scroller must not be mistaken for overlap with the next panel.
    const cards = [...document.querySelectorAll('.lh-bookmark')].map((node, index) => ({ id: `${index}:${node.querySelector('.lh-bookmark-title')?.textContent?.trim()}`, rect: clippedRect(node) })).filter(item => item.rect.width > 1 && item.rect.height > 1);
    const scrollAreas = [...document.querySelectorAll('.lh-grid-frame')].map(frame => {
      const scroller = frame.querySelector('.lh-grid-scroll'), content = frame.querySelector('.lh-grid-measure');
      return { panelId: frame.getAttribute('data-panel-id'), mode: frame.classList.contains('is-fixed') ? 'fixed' : 'content', clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight,
        contentHeight: Math.round(content.getBoundingClientRect().height), overflowY: getComputedStyle(scroller).overflowY, hasVerticalScroll: scroller.scrollHeight > scroller.clientHeight + 1 };
    });
    return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.clientWidth, documentScrollWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.clientWidth, bodyScrollWidth: document.body.scrollWidth, documentHeight: document.documentElement.scrollHeight,
      gridPanels: panels, totalCards: document.querySelectorAll('.lh-bookmark').length, visibleClippedCards: cards.length,
      gridOverlaps: overlap(panels), cardOverlaps: overlap(cards), scrollAreas,
      horizontalCategoryScroll: [...document.querySelectorAll('.lh-category-list')].some(node => node.scrollWidth > node.clientWidth + 1) };
  });
}
async function viewportPhase() {
  active = 'viewport';
  const writeStart = writes.length;
  for (const [width, height] of sizes) {
    step(`Inspect stable content at ${width}x${height}`);
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.mouse.move(1, 1);
    await settle();
    const report = await geometry();
    check(report.documentScrollWidth <= report.documentWidth + 1, `Document has no horizontal overflow at ${width}x${height}: ${report.documentScrollWidth}/${report.documentWidth}`);
    check(report.bodyScrollWidth <= report.documentWidth + 1, `Body has no horizontal overflow at ${width}x${height}: ${report.bodyScrollWidth}/${report.documentWidth}`);
    equal(report.gridOverlaps, [], `Grid panels do not overlap at ${width}x${height}`);
    equal(report.cardOverlaps, [], `Visible bookmark cards do not overlap at ${width}x${height}`);
    check(report.totalCards >= initialNavigation.data.links.length, `Every saved bookmark remains rendered at ${width}x${height}`);
    equal(await readPage(), initialPage, 'Responsive reflow does not persist a different page or revision');
    const image = await capture(`layout-${width}x${height}`);
    const item = { event: 'viewport', status: 'passed', ...report, screenshot: image };
    results.push(item); emit(item);
  }
  equal(writes.slice(writeStart), [], 'Viewport changes perform no API writes');
  equal(pageErrors, [], 'No uncaught browser errors during viewport checks');
}

function panel(viewId) {
  const id = JSON.stringify(viewId);
  return page.locator(`[data-panel-id=${id}],[data-view-id=${id}]`);
}
function localNavigationView(config) {
  const views = config.views.filter(view => view.panel.id === 'builtin/navigation'
    && config.bindings[view.inputs.collection]?.datasetId === 'local-navigation'
    && Object.keys(config.bindings[view.inputs.collection].query || {}).length === 0);
  equal(views.length, 1, 'Demo has one unfiltered authoritative local navigation panel');
  return views[0];
}
function sortedRecords(data, timestampException) {
  const byId = (a, b) => a.id.localeCompare(b.id);
  return {
    categories: structuredClone(data.categories).sort(byId),
    links: structuredClone(data.links).map(link => {
      // Only the link deliberately toggled by this test may get a new updatedAt.
      // All properties on every other record remain part of the exact comparison.
      if (link.id === timestampException) delete link.updatedAt;
      return link;
    }).sort(byId),
  };
}
function equalNavigation(actual, expected, message) {
  const persisted = dataset => {
    const copy = structuredClone(dataset);
    // The built-in local navigation dataset stamps these two observations when
    // it is read. Keep every other envelope field and every business timestamp
    // exact, including revision, sourceUpdatedAt, and each link's updatedAt.
    if (copy.meta) {
      delete copy.meta.receivedAt;
      delete copy.meta.lastSuccessAt;
    }
    return copy;
  };
  equal(persisted(actual), persisted(expected), message);
}
function bookmark(view, link) {
  const href = JSON.stringify(new URL(link.url).href);
  return panel(view.id).locator('.lh-bookmark').filter({ has: page.locator(`a.lh-bookmark-title[href=${href}]`) });
}
async function searchInteraction() {
  active = 'search';
  const original = await readPage(), data = await readNavigation(), writeStart = writes.length;
  const view = localNavigationView(original.config);
  const search = page.getByRole('searchbox', { name: /^搜索链接、描述或标签/ });
  equal(await search.count(), 1, 'The demo exposes one unambiguous homepage search');
  equal(await panel(view.id).locator('.lh-bookmark').count(), data.data.links.length, 'Search starts with all saved local links');
  const color = await page.locator('.lh-home').getAttribute('data-theme');
  const originalDirectoryCount = await page.locator('.lh-bookmark.is-directory').count();
  const originalCardCount = await page.locator('.lh-bookmark').count();
  step('Use the slash shortcut, search a saved URL, clear no-results, then dismiss with Escape');
  await page.locator('.lh-home-heading h1').click();
  await page.keyboard.press('/');
  check(await search.evaluate(node => node === document.activeElement), 'Slash focuses the homepage search');
  equal(await search.inputValue(), '', 'The shortcut does not insert a slash into the query');
  const candidate = data.data.links.find(link => data.data.links.filter(other => other.url === link.url).length === 1);
  check(!!candidate, 'Fixture contains a unique URL suitable for an actual search');
  await search.fill(candidate.url);
  await settle();
  const matched = await panel(view.id).locator('.lh-bookmark').count();
  check(matched > 0 && matched < data.data.links.length, 'A saved URL narrows the rendered navigation list');
  equal(await bookmark(view, candidate).count(), 1, 'The saved URL search keeps the intended bookmark');
  await search.fill(`no-bookmark-${runId}`);
  await settle();
  equal(await panel(view.id).locator('.lh-bookmark').count(), 0, 'A unique missing query renders zero bookmarks');
  await panel(view.id).getByText('没有匹配的链接', { exact: true }).waitFor({ state: 'visible', timeout: STEP });
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await settle();
  equal(await search.inputValue(), '', 'Clear resets the search field');
  equal(await panel(view.id).locator('.lh-bookmark').count(), data.data.links.length, 'Clear restores every saved local link');
  await search.fill(candidate.title);
  await search.press('Escape');
  await settle();
  equal(await search.inputValue(), '', 'Escape clears the query');
  check(!(await search.evaluate(node => node === document.activeElement)), 'Escape dismisses search focus');

  step('Switch temporary cards/directory and light/dark appearance without saving the page');
  await page.getByRole('button', { name: '目录模式', exact: true }).click();
  await settle();
  equal(await page.locator('.lh-bookmark.is-directory').count(), originalCardCount, 'Temporary directory mode affects every rendered bookmark');
  equal(await page.getByRole('button', { name: '目录模式', exact: true }).getAttribute('aria-pressed'), 'true', 'Directory selection is exposed accessibly');
  await page.getByRole('button', { name: '切换深浅色', exact: true }).click();
  await settle();
  equal(await page.locator('.lh-home').getAttribute('data-theme'), color === 'light' ? 'dark' : 'light', 'Temporary color changes to the other appearance');
  await capture('interaction-directory-temporary');
  await page.getByRole('button', { name: '卡片模式', exact: true }).click();
  await settle();
  equal(await page.locator('.lh-bookmark.is-directory').count(), 0, 'Temporary cards mode restores card rendering');
  await page.getByRole('button', { name: '切换深浅色', exact: true }).click();
  await settle();
  equal(await page.locator('.lh-home').getAttribute('data-theme'), color, 'Color toggles back to its original appearance');
  equal(await readPage(), original, 'Search and temporary presentation leave the full page DTO and revision unchanged');
  equalNavigation(await readNavigation(), data, 'Search and temporary presentation leave all persisted navigation fields unchanged');
  equal(writes.slice(writeStart), [], 'Search and temporary presentation produce no API writes');
  await home({ reload: true });
  equal(await page.locator('.lh-home').getAttribute('data-theme'), color, 'Reload restores the configured color');
  equal(await page.locator('.lh-bookmark.is-directory').count(), originalDirectoryCount, 'Reload restores each configured panel variant');
  results.push({ event: 'interaction', name: 'search-and-temporary-appearance', status: 'passed', savedWrites: 0 });
  emit(results[results.length - 1]);
}
async function setFavoriteThroughUI(view, original, desired) {
  const data = await readNavigation(), current = data.data.links.find(link => link.id === original.id);
  check(!!current, 'The favorite target still exists in the authoritative collection');
  if (current.isFavorite === desired) return current;
  await home({ reload: true });
  const card = bookmark(view, current);
  equal(await card.count(), 1, 'The favorite target is uniquely identified inside the local navigation panel');
  const response = await mutation('PUT', `/spaces/${space.id}/links/${current.id}`, () => card.getByRole('button', {
    name: `${current.isFavorite ? '取消收藏' : '收藏'} ${current.title}`, exact: true,
  }).click());
  equal(response.isFavorite, desired, 'Favorite PUT returns the requested UI state');
  await card.getByRole('button', { name: `${desired ? '取消收藏' : '收藏'} ${current.title}`, exact: true }).waitFor({ state: 'visible', timeout: STEP });
  await settle();
  equal(await card.getByRole('button', { name: `${desired ? '取消收藏' : '收藏'} ${current.title}`, exact: true }).getAttribute('aria-pressed'), String(desired), 'The refreshed button reflects the saved favorite');
  return response;
}
async function favoriteInteraction() {
  active = 'favorite';
  const original = await readNavigation(), savedPage = await readPage(), writeStart = writes.length;
  const view = localNavigationView(savedPage.config);
  const target = original.data.links.find(link => link.isFavorite
    && original.data.links.filter(other => other.url === link.url).length === 1);
  check(!!target, 'Demo has an existing uniquely addressed favorite to toggle and restore');
  let failure;
  try {
    step('Toggle one real favorite through the homepage and compare the saved collection');
    await setFavoriteThroughUI(view, target, !target.isFavorite);
    const changed = await readNavigation();
    const expected = structuredClone(original.data);
    expected.links.find(link => link.id === target.id).isFavorite = !target.isFavorite;
    equal(sortedRecords(changed.data, target.id), sortedRecords(expected, target.id), 'Only the intended favorite value changes; all other record properties and links remain exact');
    check(changed.revision !== original.revision, 'A real favorite mutation advances the authoritative data revision');
    equal(await readPage(), savedPage, 'Favorite mutation does not alter page layout or its revision');
  } catch (error) {
    failure = error;
    await capture('interaction-favorite-failure').catch(() => {});
  } finally {
    try {
      step('Restore the original favorite with the same UI control');
      await setFavoriteThroughUI(view, target, target.isFavorite);
      equal(sortedRecords((await readNavigation()).data, target.id), sortedRecords(original.data, target.id), 'Favorite cleanup restores the original full collection, allowing only the touched link updatedAt to advance');
      equal(await readPage(), savedPage, 'Favorite cleanup also preserves the exact page');
    } catch (error) {
      throw new Error(`${failure ? failure.message + '; ' : ''}Favorite restoration failed: ${error.message}`);
    }
  }
  if (failure) throw failure;
  equal(writes.slice(writeStart), Array.from({ length: 2 }, () => ({ method: 'PUT', path: `/api/v1/spaces/${space.id}/links/${target.id}` })), 'Favorite test performs exactly the requested toggle and restoration');
  results.push({ event: 'interaction', name: 'favorite-roundtrip', status: 'passed', originalFavoriteRestored: true, timestampException: 'Only the toggled link updatedAt may advance' });
  emit(results[results.length - 1]);
}
async function choose(control, label) {
  await control.click();
  await page.getByRole('option', { name: label, exact: true }).click();
  await page.getByRole('listbox').waitFor({ state: 'hidden', timeout: STEP });
  check((await control.textContent()).includes(label), `Select visibly retains ${label}`);
}
const panelNames = { 'builtin/category-navigation': '分类导航', 'builtin/search': '搜索框', 'builtin/favorites': '常用收藏', 'builtin/navigation': '导航链接', 'builtin/github-traffic': 'GitHub Traffic' };
async function adminLayout() {
  await home({ reload: true });
  await page.getByRole('link', { name: '管理中心', exact: true }).click();
  await page.locator('.admin-shell').waitFor({ state: 'visible', timeout: STEP });
  await page.getByRole('button', { name: '布局与主题', exact: true }).click();
  await page.getByRole('heading', { name: '布局与主题', level: 1, exact: true }).waitFor({ state: 'visible', timeout: STEP });
  await page.getByRole('tab', { name: /^积木与数据绑定/ }).click();
  const form = page.locator('.admin-layout-form');
  const tabs = form.getByRole('tablist'), content = form.getByRole('tabpanel');
  equal(await tabs.count(), 1, 'Layout editor exposes one tab list');
  equal(await content.count(), 1, 'Layout editor exposes only the active tab panel');
  await content.waitFor({ state: 'visible', timeout: STEP });
  const [formBox, tabsBox, contentBox] = await Promise.all([form.boundingBox(), tabs.boundingBox(), content.boundingBox()]);
  check(!!formBox && !!tabsBox && !!contentBox, 'Admin tabs and content have measurable geometry');
  check(tabsBox.y + tabsBox.height <= contentBox.y + 1, 'Admin tab list sits above its content, instead of beside a full-height blank area');
  check(contentBox.width >= formBox.width * 0.8, `Admin tab content uses the available form width: ${Math.round(contentBox.width)}/${Math.round(formBox.width)}`);
}
async function restoreGridThroughAdmin(original) {
  const current = await readPage();
  if (isDeepStrictEqual(current.config, original.config) && current.name === original.name) {
    await home({ reload: true });
    equal((await readPage()).config, original.config, 'An unsaved mouse draft is discarded without an API write');
    return { saved: false, restoredGridPanels: 0 };
  }
  step('Restore every original grid placement through the actual admin fields');
  await adminLayout();
  equal(await page.locator('.admin-component-list .admin-component-item').count(), original.config.views.length, 'Admin still lists the original set of components');
  let restoredGridPanels = 0;
  for (const [index, view] of original.config.views.entries()) {
    const placement = original.config.layout.placements[view.id].base;
    if (placement.kind !== 'grid') continue;
    await page.getByRole('button', { name: `配置 ${panelNames[view.panel.id] || view.panel.id} ${index + 1}`, exact: true }).click();
    const card = page.locator('.admin-view-inspector');
    equal(await card.count(), 1, `Grid editor #${index + 1} is the single selected inspector`);
    const advanced = card.locator('details.admin-advanced-settings');
    if (!(await advanced.evaluate(node => node.open))) await advanced.locator('summary').click();
    const lock = card.getByRole('checkbox', { name: '锁定位置与尺寸', exact: true });
    if (await lock.isChecked()) await lock.uncheck();
    for (const [key, label] of [['x', '起始列 X'], ['y', '起始行 Y'], ['w', '宽度（列）'], ['h', '高度（行）']]) {
      const input = card.getByRole('spinbutton', { name: label, exact: true });
      await input.fill(String(placement[key]));
      equal(await input.inputValue(), String(placement[key]), `Admin restores ${view.id}.${key}`);
    }
    const heightLabel = placement.heightMode === 'content' ? '随内容增长' : '固定高度，内部滚动';
    await choose(card.getByRole('combobox', { name: '内容高度', exact: true }), heightLabel);
    await lock.setChecked(!!placement.locked);
    equal(await lock.isChecked(), !!placement.locked, `Admin restores ${view.id}.locked`);
    if (placement.locked) check(await card.getByRole('spinbutton', { name: '宽度（列）', exact: true }).isDisabled(), 'The restored locked panel disables its width input');
    restoredGridPanels++;
  }
  const saved = await mutation('PUT', `/spaces/${space.id}/page`, () => page.getByRole('button', { name: '保存页面', exact: true }).click());
  equal(saved.config, original.config, 'Admin form restores the complete original config, including overrides, bindings, views, and every placement');
  equal(saved.name, original.name, 'Original page name is preserved');
  equal(saved.id, original.id, 'Restoration updates the original page');
  check(saved.revision !== current.revision, 'UI restoration produces a new saved page revision');
  equal(await readPage(), saved, 'The restored page response equals its persisted readback');
  await home({ reload: true });
  equal((await readPage()).config, original.config, 'Reload preserves the full restored config');
  return { saved: true, restoredGridPanels };
}
async function mouseGesture(handle, dx, dy = 0) {
  await handle.scrollIntoViewIfNeeded({ timeout: STEP });
  const box = await handle.boundingBox();
  check(!!box && box.width > 0 && box.height > 0, 'The actual mouse interaction handle has a visible hit target');
  const start = { x: box.x + Math.min(box.width / 2, 70), y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try { await page.mouse.move(start.x + dx, start.y + dy, { steps: 12 }); }
  finally { await page.mouse.up(); }
  await settle();
}
async function gridInteraction() {
  active = 'grid';
  const original = await readPage(), navigation = await readNavigation(), writeStart = writes.length;
  const favorites = original.config.views.filter(view => view.panel.id === 'builtin/favorites'
    && original.config.bindings[view.inputs.collection]?.datasetId === 'local-navigation');
  equal(favorites.length, 1, 'Demo has one local favorites panel for mouse layout acceptance');
  const view = favorites[0], originalPlacement = original.config.layout.placements[view.id].base;
  check(originalPlacement.kind === 'grid' && !originalPlacement.locked && originalPlacement.w >= 8, 'Favorites has an unlocked grid footprint wide enough to shrink');
  // Verify the restoration form before any saved mutation, so a tab rendering
  // regression cannot strand a successfully moved panel without a working editor.
  step('Check the admin tab layout before beginning a saved mouse edit');
  await adminLayout();
  await home();
  let failure, saved, restored;
  try {
    step('Enter homepage editing and resize the real favorites panel narrower with the mouse');
    await page.locator('.lh-edit-menu summary').click(); await page.getByRole('button', { name: '调整布局', exact: true }).click();
    await page.locator('.lh-edit-bar').waitFor({ state: 'visible', timeout: STEP });
    await settle();
    const frame = panel(view.id);
    equal(await frame.count(), 1, 'Favorites grid frame is unique');
    const item = page.locator('.lh-home-grid .react-grid-item').filter({ has: page.locator(`[data-panel-id=${JSON.stringify(view.id)}]`) });
    equal(await item.count(), 1, 'Favorites has one actual react-grid-layout item');
    const gridBox = await page.locator('.lh-home-grid').boundingBox();
    check(!!gridBox, 'Desktop grid has a measurable container');
    const column = (gridBox.width + original.config.layout.gap) / 24;
    const desiredWidth = Math.max(4, Math.floor(originalPlacement.w / 2));
    const resize = item.locator('.react-resizable-handle-se');
    equal(await resize.count(), 1, 'The unlocked favorites item exposes its southeast resize handle');
    await mouseGesture(resize, (desiredWidth - originalPlacement.w) * column);
    const widthText = await frame.locator('.lh-grid-handle small').textContent();
    const widthMatch = widthText.match(/^(\d+)\s*列/);
    check(!!widthMatch, 'The drag handle reports the new width in columns');
    const resizedWidth = Number(widthMatch[1]);
    check(resizedWidth < originalPlacement.w && resizedWidth >= 4, `Mouse resize makes the panel narrower: ${originalPlacement.w} -> ${resizedWidth}`);
    equal(resizedWidth, desiredWidth, 'Mouse resize snaps to the intended 24-column grid width');
    check(await frame.evaluate(node => node.classList.contains('is-fixed')), 'Explicit mouse resize selects fixed height and internal scrolling');

    step('Drag the resized favorites title to the right side, then save the actual draft');
    const resizedBox = await item.boundingBox(), currentGrid = await page.locator('.lh-home-grid').boundingBox();
    check(!!resizedBox && !!currentGrid, 'Resized panel and container have measurable geometry');
    const currentX = Math.round((resizedBox.x - currentGrid.x) / column), desiredX = 24 - resizedWidth;
    check(desiredX > currentX, 'The resized panel has room to move right');
    const drag = frame.locator('.lh-grid-handle:not(.is-locked)');
    equal(await drag.count(), 1, 'The unlocked title exposes the actual drag handle');
    await mouseGesture(drag, (desiredX - currentX) * column);
    const draggedBox = await item.boundingBox();
    check(!!draggedBox && draggedBox.x > resizedBox.x + column / 2, 'Actual mouse drag moves the favorites frame to the right');
    equal(await readPage(), original, 'Mouse resize and drag remain an unsaved draft before Save');
    equal(writes.slice(writeStart), [], 'Mouse gestures themselves perform no API writes');
    saved = await mutation('PUT', `/spaces/${space.id}/page`, () => page.getByRole('button', { name: '保存布局', exact: true }).click());
    const placement = saved.config.layout.placements[view.id].base;
    equal(placement.kind, 'grid', 'The saved favorite remains a grid panel');
    equal(placement.w, resizedWidth, 'The saved width matches the real resize gesture');
    equal(placement.x, desiredX, 'The saved horizontal position matches the real drag gesture');
    equal(placement.heightMode, 'fixed', 'The explicit resized height mode persists');
    equal(placement.locked, false, 'Mouse movement does not change the lock setting');
    check(placement.h >= 3 && placement.x + placement.w <= 24, 'The saved footprint remains inside the supported grid');
    check(saved.revision !== original.revision, 'Saving the mouse draft advances page revision');
    const withoutPlacements = value => { const copy = structuredClone(value); delete copy.layout.placements; return copy; };
    equal(withoutPlacements(saved.config), withoutPlacements(original.config), 'Mouse editing changes only placements, preserving themes, appearance, bindings, and views');
    equal(await readPage(), saved, 'The mouse save response exactly equals persisted readback');
    await home({ reload: true });
    equal(await readPage(), saved, 'Reload retains the saved mouse placement and revision');
    const report = await geometry();
    equal(report.gridOverlaps, [], 'Saved resized/moved grid panels do not overlap');
    equal(report.cardOverlaps, [], 'Clipped card content does not overlap after the resized layout');
    equalNavigation(await readNavigation(), navigation, 'Mouse layout editing leaves all persisted navigation fields unchanged');
    await capture('interaction-favorites-resized-right');
  } catch (error) {
    failure = error;
    await capture('interaction-grid-failure').catch(() => {});
  } finally {
    try { restored = await restoreGridThroughAdmin(original); }
    catch (error) { throw new Error(`${failure ? failure.message + '; ' : ''}Grid restoration failed: ${error.message}`); }
  }
  if (failure) throw failure;
  check(restored.saved && restored.restoredGridPanels > 0, 'A successful mouse save is restored through the admin UI');
  equalNavigation(await readNavigation(), navigation, 'Admin placement restoration preserves every persisted navigation field');
  equal(writes.slice(writeStart), Array.from({ length: 2 }, () => ({ method: 'PUT', path: `/api/v1/spaces/${space.id}/page` })), 'Grid test writes only the mouse save and admin restoration');
  await capture('interaction-grid-restored');
  results.push({ event: 'interaction', name: 'mouse-grid-roundtrip', status: 'passed', original: originalPlacement,
    mouseSaved: saved.config.layout.placements[view.id].base, originalConfigRestored: true, restoredGridPanels: restored.restoredGridPanels });
  emit(results[results.length - 1]);
}
async function interactionsPhase() {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await home({ reload: true });
  if (interaction === 'all' || interaction === 'search') await searchInteraction();
  if (interaction === 'all' || interaction === 'favorite') await favoriteInteraction();
  if (interaction === 'all' || interaction === 'grid') await gridInteraction();
  equal((await readPage()).config, initialPage.config, 'Interaction acceptance ends with the full original page config');
  equal((await readPage()).name, initialPage.name, 'Interaction acceptance ends with the original page name');
  equal(pageErrors, [], 'Interaction acceptance produces no uncaught browser errors');
}

(async () => {
  try {
    await preflight();
    if (phase === 'viewport' || phase === 'all') await viewportPhase();
    if (phase === 'interactions' || phase === 'all') await interactionsPhase();
    equal(consoleErrors, [], 'No browser console errors');
    emit({ event: 'summary', status: 'passed', phase, interaction, assertions, elapsedMs: Date.now() - started, results, pageErrors, consoleErrors, writes });
  } catch (error) {
    let screenshot = null;
    if (page) screenshot = await capture(`layout-${active}-failure`).catch(() => null);
    emit({ event: 'summary', status: 'failed', phase: active, assertions, message: error.message, pageErrors, consoleErrors, screenshot });
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
})();
