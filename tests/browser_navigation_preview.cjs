#!/usr/bin/env node
'use strict';
// Targeted preview layout regression on an explicitly supplied disposable fixture.
// Restores the page and removes only records created by this run.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'UI_FIXTURES and OUTPUT_DIR are required');
const fixtures = JSON.parse(fs.readFileSync(process.env.UI_FIXTURES, 'utf8')), provider = process.env.UI_PROVIDER || 'sqlite', fixture = fixtures[provider];
assert(fixture?.username && fixture.password && /^[a-f0-9]{32}$/.test(fixture.shared), 'An owned fixture account and shared space are required');
const base = new URL(fixture.url), origin = base.origin, out = path.resolve(process.env.OUTPUT_DIR);
assert(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password, 'Only disposable loopback fixtures');
fs.mkdirSync(out, { recursive: true });
const prefix = 'Preview ' + crypto.randomBytes(5).toString('hex'), space = '/spaces/' + fixture.shared;
const report = { passed: false, provider, startedAt: new Date().toISOString(), checks: [], screenshots: [], geometry: [], pageErrors: [], cleanup: [] };
const groups = [], ownedLinks = new Map(), ownedCategories = new Map();
const scrub = value => [fixture.username, fixture.password].reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));
let browser, context, page, initial, originalPage, originalNavigation, fixtureNavigation, ownedRevision, viewId, approved = false, pageChanged = false;
const l = (zh, en) => initial.language === 'en' ? en : zh;
const panel = () => page.locator('.lh-navigation-panel').filter({ has: page.getByRole('heading', { name: prefix, exact: true }) }).first();
const group = id => panel().locator('[data-category-id="' + id + '"]');
const records = value => Object.fromEntries(['categories', 'links'].map(key => [key, [...value.data[key]].sort((a, b) => a.id.localeCompare(b.id))]));
async function boot() { const response = await context.request.get(origin + '/api/v1/bootstrap'); assert.equal(response.status(), 200); return response.json(); }
async function api(suffix, method = 'GET', data, expected = 200) {
  const state = await boot();
  const response = await context.request.fetch(origin + '/api/v1' + suffix, { method, data, headers: { Origin: origin, 'X-CSRF-TOKEN': state.csrfToken }, maxRedirects: 0, timeout: 15000 });
  assert.equal(response.status(), expected, method + ' ' + suffix + ': unexpected HTTP ' + response.status());
  return expected === 204 ? null : response.json();
}
async function check(name, action) {
  if (process.env.UI_CHECK_MATCH && !new RegExp(process.env.UI_CHECK_MATCH).test(name)) return;
  const started = Date.now();
  try { await action(); report.checks.push({ name, passed: true, ms: Date.now() - started }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: scrub(error.message) }); throw error; }
}
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function screenshot(name) { await settle(); const file = provider + '-navigation-preview-' + name + '.png'; await page.screenshot({ path: path.join(out, file), animations: 'disabled' }); report.screenshots.push(file); }
async function home() {
  const target = origin + '/#/';
  if (page.url() !== target) await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await panel().waitFor(); await group(groups[0].category.id).locator('.lh-folder-more').waitFor(); await settle();
}
async function presentation(appearance, density = 'comfortable', variant = 'cards') {
  const before = await api(space + '/page'); assert.equal(before.revision, ownedRevision, 'Only this run may change the fixture page revision');
  const config = structuredClone(originalPage.config), selected = config.views.find(view => view.id === viewId);
  config.pageTheme = { id: 'builtin/dashboard' }; config.appearance = { ...config.appearance, colorMode: 'light', density };
  selected.settings = { ...selected.settings, title: prefix, variant, linkAppearance: appearance, maxColumns: 0, descriptionLines: 1, showTags: false, showEndpoints: false, showGroupTitles: true, density };
  delete selected.settings.groupPreviewCount; // Exercise the existing default of six; do not introduce a new setting.
  const saved = await api(space + '/page', 'PUT', { name: before.name, config, expectedRevision: ownedRevision });
  ownedRevision = saved.revision; pageChanged = true;
  await home();
}
async function geometry(name) {
  for (const entry of groups) {
    const target = group(entry.category.id);
    assert.deepEqual(await target.locator('.lh-links>.lh-bookmark').evaluateAll(cards => cards.map(card => card.dataset.linkId)), entry.links.slice(0, 6).map(link => link.id), 'Preview count and original order stay unchanged');
    assert.equal(await target.locator('.lh-folder-more').count(), 1);
    const measured = await target.evaluate(element => {
      const grid = element.querySelector('.lh-links'), more = grid.querySelector('.lh-folder-more'), cards = [...grid.querySelectorAll(':scope>.lh-bookmark')];
      const box = value => { const r = value.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const gridStyle = getComputedStyle(grid), moreStyle = getComputedStyle(more), copy = more.querySelector('.lh-folder-more-copy');
      return { viewport: [innerWidth, innerHeight], documentWidth: document.documentElement.scrollWidth, grid: box(grid), gridScrollWidth: grid.scrollWidth, gridClientWidth: grid.clientWidth, columns: gridStyle.gridTemplateColumns.split(/\s+/).filter(value => parseFloat(value) > 1).length, gap: parseFloat(gridStyle.columnGap), more: box(more), columnStart: moreStyle.gridColumnStart, columnEnd: moreStyle.gridColumnEnd, cards: cards.map(box), copyOverflows: copy.scrollWidth > copy.clientWidth + 1 };
    });
    report.geometry.push({ name, count: entry.links.length, ...measured });
    assert(measured.documentWidth <= measured.viewport[0] + 1 && measured.gridScrollWidth <= measured.gridClientWidth + 1, name + ': no page or group horizontal overflow');
    assert.equal(measured.columnStart, 'auto', name + ': more starts in its own grid cell');
    assert.equal(measured.columnEnd, 'auto', name + ': more does not span all columns');
    assert(Math.abs(measured.more.width - measured.cards[0].width) < 2, name + ': more has the same cell width as a bookmark');
    assert.equal(measured.copyOverflows, false, name + ': more text fits its cell');
    const all = [...measured.cards, measured.more], firstY = measured.cards[0].y;
    const firstRow = all.filter(value => Math.abs(value.y - firstY) < 2);
    assert.equal(firstRow.length, Math.min(measured.columns, 7), name + ': preview uses every available first-row track');
    assert(measured.grid.right - Math.max(...firstRow.map(value => value.right)) < measured.cards[0].width, name + ': no entire card-width gap at the right of a populated row');
    if (measured.columns >= 7) {
      assert.equal(firstRow.length, 7, name + ': six cards plus more share one row when room permits');
      assert(Math.abs(measured.more.right - measured.grid.right) < 2, name + ': last preview cell reaches the grid edge');
    }
    const neighbors = measured.cards.filter(value => Math.abs(value.y - measured.more.y) < 2);
    if (neighbors.length) assert(Math.abs(measured.more.height - neighbors[0].height) < 2, name + ': more stretches to the neighboring card height');
  }
  assert.deepEqual(records(await api(space + '/navigation')), records(fixtureNavigation), 'Layout and folder reads never change navigation data');
}
async function main() {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  await api('/auth/login', 'POST', { username: fixture.username, password: fixture.password, sessionMode: 'temporary' });
  initial = await boot(); assert.equal(initial.siteName, 'Release UI fixture ' + provider, 'Fixture guard must match');
  assert(initial.spaces.some(value => value.id === fixture.shared && value.canEdit)); approved = true;
  originalPage = await api(space + '/page'); ownedRevision = originalPage.revision; originalNavigation = await api(space + '/navigation');
  const navigation = originalPage.config.views.find(view => view.panel.id === 'builtin/navigation'); assert(navigation, 'Fixture has a navigation view'); viewId = navigation.id;
  assert.notEqual(originalPage.config.layout.placements[viewId]?.base.kind, 'hidden', 'Fixture navigation is visible');
  for (const count of [11, 17]) {
    const category = await api(space + '/categories', 'POST', { name: prefix + ' ' + count + ' bookmarks', icon: 'lucide:folder', parentId: null, sortOrder: -count }, 201);
    ownedCategories.set(category.id, category);
    const entry = { category, links: [] }; groups.push(entry);
    for (let index = 0; index < count; index++) {
      const link = await api(space + '/links', 'POST', { categoryId: category.id, title: 'Bookmark ' + String(index + 1).padStart(2, '0'), url: 'https://example.invalid/' + prefix.replaceAll(' ', '-') + '/' + count + '/' + index, description: 'Preview layout sample', iconMode: 'manual', icon: 'lucide:link', tags: [], endpoints: [], isFavorite: false, sortOrder: index }, 201);
      entry.links.push(link); ownedLinks.set(link.id, link);
    }
  }
  fixtureNavigation = await api(space + '/navigation');
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.pageErrors.push(scrub(error.message)));
  // The existing library deep link selects and remembers this exact space.
  await page.goto(origin + '/#/library?space=' + fixture.shared, { waitUntil: 'domcontentloaded' });
  await page.locator('.library-shell').waitFor();
  await presentation('icon-text');
  await check('default_six_preview_four_desktop_sizes', async () => {
    for (const [width, height] of [[2560,1440], [1920,1080], [1600,900], [2560,1080]]) {
      await page.setViewportSize({ width, height }); await settle();
      await geometry('icon-text-' + width + 'x' + height); await screenshot('icon-text-' + width + 'x' + height);
    }
  });
  await check('folder_keyboard_open_and_hidden_records', async () => {
    for (const entry of groups) {
      const more = group(entry.category.id).locator('.lh-folder-more'), hidden = entry.links.at(-1);
      assert.equal(await group(entry.category.id).locator('[data-link-id="' + hidden.id + '"]').count(), 0);
      await more.focus(); await page.keyboard.press('Enter');
      const folder = page.locator('.lh-folder-dialog'); await folder.waitFor();
      assert.equal(await folder.locator('[data-link-id]').count(), entry.links.length);
      await folder.locator('.lh-folder-search input').fill(hidden.title);
      const found = folder.locator('[data-link-id="' + hidden.id + '"]'); await found.waitFor();
      assert.equal(await found.locator('.lh-bookmark-title').getAttribute('href'), hidden.url, 'A hidden bookmark retains its original usable target');
      await page.keyboard.press('Escape'); await folder.waitFor({ state: 'hidden' });
      // Radix restores focus after the portal unmounts, not at the instant its
      // content becomes hidden. Observe the result without a fixed sleep.
      await page.waitForFunction(id => document.activeElement === document.querySelector('[data-category-id="' + id + '"] .lh-folder-more'), entry.category.id);
      assert(await more.evaluate(element => element === document.activeElement), 'Folder close returns keyboard focus to more');
    }
  });
  await check('minimal_and_app_icons_keep_compact_more_cells', async () => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await presentation('minimal', 'compact'); await geometry('minimal-compact-1600x900'); await screenshot('minimal-compact-1600x900');
    await presentation('app-icons', 'compact'); await geometry('app-icons-compact-1600x900'); await screenshot('app-icons-compact-1600x900');
    await page.setViewportSize({ width: 2560, height: 1440 }); await presentation('app-icons'); await geometry('app-icons-2560x1440'); await screenshot('app-icons-2560x1440');
  });
  await check('directory_more_keeps_its_row', async () => {
    await presentation('icon-text', 'comfortable', 'directory');
    for (const entry of groups) {
      const measured = await group(entry.category.id).evaluate(element => { const grid = element.querySelector('.lh-links'), more = grid.querySelector('.lh-folder-more'); return { display: getComputedStyle(grid).display, start: getComputedStyle(more).gridColumnStart, end: getComputedStyle(more).gridColumnEnd, gridWidth: grid.getBoundingClientRect().width, moreWidth: more.getBoundingClientRect().width }; });
      assert.equal(measured.display, 'flex'); assert.equal(measured.start, '1'); assert.equal(measured.end, '-1'); assert(Math.abs(measured.gridWidth - measured.moreWidth) < 2, 'Directory more keeps its full row');
    }
    assert.deepEqual(records(await api(space + '/navigation')), records(fixtureNavigation));
  });
  assert.deepEqual(report.pageErrors, []); report.passed = true;
}
async function cleanup() {
  if (!approved || !context) return;
  if (page && !page.isClosed()) await page.close();
  if (pageChanged) {
    const current = await api(space + '/page'); assert.equal(current.revision, ownedRevision, 'Cleanup refuses to overwrite a foreign page revision');
    const restored = await api(space + '/page', 'PUT', { name: originalPage.name, config: originalPage.config, expectedRevision: ownedRevision });
    assert.deepEqual(restored.config, originalPage.config); report.cleanup.push('page restored');
  }
  for (const [kind, entries] of [['links', ownedLinks], ['categories', ownedCategories]]) for (const [id, expected] of [...entries].reverse()) {
    const navigation = await api(space + '/navigation'), current = navigation.data[kind].find(value => value.id === id);
    if (!current) continue;
    assert.deepEqual(current, expected, 'Cleanup only removes an unchanged record created by this run');
    await api(space + '/' + kind + '/' + id, 'DELETE', undefined, 204);
  }
  if (originalNavigation) assert.deepEqual(records(await api(space + '/navigation')), records(originalNavigation), 'Pre-existing navigation is preserved');
  report.cleanup.push('owned preview records removed');
}
main().catch(async error => { report.passed = false; report.failure = scrub(error.stack || error); process.exitCode = 1; if (page && !page.isClosed()) await screenshot('failure').catch(() => {}); console.error(report.failure); }).finally(async () => {
  try { await cleanup(); } catch (error) { report.passed = false; report.cleanupFailure = scrub(error.stack || error); process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(out, 'navigation-preview-report.json'), JSON.stringify(report, null, 2) + '\n'); if (browser) await browser.close();
});
