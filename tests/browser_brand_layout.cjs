#!/usr/bin/env node
'use strict';
/**
 * Actual browser acceptance for bundled branding and homepage space usage.
 * BASE_URL=http://10.233.233.61:5182 node tests/browser_brand_layout.cjs
 * BASE_URL=http://10.233.233.61:5183 node tests/browser_brand_layout.cjs --phase fit --allow-demo-write
 * Read-only by default. The optional English-clone phase allows one exact UI
 * page save, followed by API restoration at this run's latest own revision.
 * Never targets the main service or writes bookmarks, accounts, or settings.
 * Optional: LINGSHU_PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE, REPORT_PATH, SCREENSHOT_DIR.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const STEP = 12_000, args = process.argv.slice(2), runId = randomUUID().slice(0, 12);
const phaseIndex = args.indexOf('--phase');
const phase = args.find(value => value.startsWith('--phase='))?.slice(8) || (phaseIndex >= 0 ? args[phaseIndex + 1] : 'readonly');
let browser, context, page, base, bootstrap, space, originalPage, originalNavigation, navigationView, expectedConfig, lastSavedRevision, approved = false, putBudget = 0;
let assertions = 0, currentStep = 'preflight';
const attempts = [], commits = [], blocked = [], routeErrors = [], pageErrors = [], consoleErrors = [], dialogs = [], cleanups = [], screenshots = [];
const details = { logos: {}, geometry: {}, scope: { lockedObstacle: 'Existing rules retained; no lock mutation in this acceptance run', startupAndSetup: 'Logo paths integrated; no setup mutation in this run' } };
const reportPath = path.resolve(process.env.REPORT_PATH || path.join(os.tmpdir(), `lingshu-brand-layout-${runId}.json`));
const check = (value, message) => { assert.ok(value, message); assertions++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const step = value => { currentStep = value; emit({ event: 'step', phase, label: value, assertions }); };
const l = (chinese, english) => bootstrap.language === 'en' ? english : chinese;
const endpoint = relative => base.origin + '/api/v1' + relative;
const pagePath = () => '/api/v1/spaces/' + encodeURIComponent(space.id) + '/page';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const records = dataset => ({ categories: [...dataset.data.categories].sort((a, b) => a.id.localeCompare(b.id)), links: [...dataset.data.links].sort((a, b) => a.id.localeCompare(b.id)) });
const panelSelector = () => `.lh-grid-frame[data-panel-id=${JSON.stringify(navigationView.id)}]`;
async function read(relative) {
  const response = await context.request.get(endpoint(relative), { timeout: STEP, maxRedirects: 0 });
  check(response.ok(), `GET ${relative}: HTTP ${response.status()}`); return response.json();
}
const readPage = () => read('/spaces/' + encodeURIComponent(space.id) + '/page');
const readNavigation = () => read('/spaces/' + encodeURIComponent(space.id) + '/navigation');
async function until(callback, label) {
  const deadline = Date.now() + STEP;
  while (Date.now() < deadline) { if (await callback()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timed out: ${label}`);
}
async function settle() {
  const token = randomUUID();
  await page.waitForFunction(token => {
    const home = document.querySelector('.lh-home');
    if (!home || document.fonts.status !== 'loaded' || home.querySelector('.react-draggable-dragging,.resizing,.react-grid-placeholder')) return false;
    const boxes = [home, ...home.querySelectorAll('.react-grid-item,.lh-side-region')].map(node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(value => Math.round(value * 10)); });
    const signature = JSON.stringify([document.documentElement.scrollWidth, document.documentElement.scrollHeight, boxes]);
    const previous = window.__brandLayoutGeometry;
    if (!previous || previous.token !== token || previous.signature !== signature) { window.__brandLayoutGeometry = { token, signature, frames: 0, changedAt: performance.now() }; return false; }
    return ++previous.frames >= 8 && performance.now() - previous.changedAt >= 180;
  }, token, { timeout: STEP, polling: 'raf' });
}
async function capture(name) {
  if (!process.env.SCREENSHOT_DIR || !page) return;
  const directory = path.resolve(process.env.SCREENSHOT_DIR); fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `brand-layout-${bootstrap.language}-${phase}-${name}.png`);
  await page.screenshot({ path: target, fullPage: false, animations: 'allow', timeout: STEP }); screenshots.push(target);
}
async function noHorizontalOverflow(label) {
  const geometry = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
  check(geometry.scrollWidth <= geometry.clientWidth + 1, `${label}: no horizontal document overflow`); return geometry;
}
async function home() {
  await page.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded', timeout: STEP });
  await page.locator('.lh-home-heading h1').waitFor({ state: 'visible', timeout: STEP });
  await page.waitForFunction(() => document.querySelectorAll('.lh-bookmark').length > 0, null, { timeout: STEP }); await settle();
}
async function logos(surface, label, minimum, sizes) {
  // Synchronous evaluation also works inside the no-script preview iframe;
  // polling is owned by Node rather than awaiting iframe animation callbacks.
  await until(() => surface.evaluate(() => {
    const images = [...document.querySelectorAll('.project-logo')].filter(node => node.getBoundingClientRect().width > 0);
    return images.length > 0 && images.every(node => node.complete && node.naturalWidth > 0);
  }), `${label}: decoded project logos`);
  const result = await surface.evaluate(() => [...document.querySelectorAll('.project-logo')].filter(node => node.getBoundingClientRect().width > 0).map(node => {
    const r = node.getBoundingClientRect(), style = getComputedStyle(node);
    return { src: node.currentSrc || node.src, width: r.width, height: r.height, naturalWidth: node.naturalWidth, naturalHeight: node.naturalHeight, filter: style.filter, alt: node.alt, ariaHidden: node.getAttribute('aria-hidden') };
  }));
  check(result.length >= minimum, `${label}: all expected identity surfaces have logo images`);
  for (const image of result) {
    check(new URL(image.src).origin === base.origin && !new URL(image.src).pathname.startsWith('/icons/'), `${label}: project art is local and outside the filtered navigation icon catalog`);
    check(image.naturalWidth > 0 && image.naturalHeight > 0 && image.width > 0 && Math.abs(image.width - image.height) <= 1, `${label}: loaded logo remains square`);
    equal(image.filter, 'none', `${label}: original logo colors are not inverted`);
    equal([image.alt, image.ariaHidden], ['', 'true'], `${label}: decorative image does not repeat its adjacent project name`);
  }
  if (sizes) for (const size of sizes) check(result.some(image => Math.abs(image.width - size) <= 1 && Math.abs(image.height - size) <= 1), `${label}: expected ${size}px identity is rendered`);
  details.logos[label] = result; return result;
}
async function favicons() {
  step('Bundled favicon responses and actual image dimensions');
  const icons = await page.locator('link[rel="icon"],link[rel="apple-touch-icon"]').evaluateAll(nodes => nodes.map(node => ({ rel: node.rel, type: node.type, sizes: node.sizes.value, href: node.href })));
  equal(icons.length, 3, 'The document declares PNG, SVG, and Apple touch icons');
  details.favicons = [];
  for (const icon of icons) {
    const url = new URL(icon.href); equal(url.origin, base.origin, 'Icon URL uses the application origin'); check(url.pathname.startsWith('/assets/'), 'Icon is emitted as a production asset');
    const response = await context.request.get(url.href, { timeout: STEP, maxRedirects: 0 }); equal(response.status(), 200, 'The exact declared icon responds with HTTP 200');
    const bytes = await response.body(), contentType = response.headers()['content-type'] || ''; let dimensions;
    if (icon.type === 'image/svg+xml') { check(contentType.includes('image/svg+xml') && bytes.toString('utf8').includes('<svg'), 'SVG favicon is real SVG with the correct MIME type'); }
    else {
      check(contentType.includes('image/png'), 'PNG icon has image/png MIME'); equal([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10], 'PNG icon has a genuine PNG signature');
      dimensions = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]; equal(dimensions, icon.rel === 'apple-touch-icon' ? [180,180] : [32,32], 'Icon dimensions match the HTML declaration');
    }
    equal(response.headers()['cache-control'], 'no-cache', 'Brand assets retain safe revalidation under the existing image policy');
    details.favicons.push({ ...icon, contentType, bytes: bytes.length, dimensions, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}
async function cardGeometry() {
  const nav = page.locator(panelSelector());
  const groups = await nav.locator('.lh-link-group').evaluateAll(nodes => nodes.map(node => {
    const links = node.querySelector('.lh-links'), cards = [...links.querySelectorAll('.lh-bookmark')], box = links.getBoundingClientRect(), section = node.getBoundingClientRect();
    return { name: node.getAttribute('aria-label'), count: cards.length, groupTop: section.top, groupLeft: section.left, groupRight: section.right, groupWidth: section.width, left: box.left, right: box.right, width: box.width, cards: cards.map(card => { const r = card.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: r.width }; }) };
  }));
  const sparse = groups.filter(group => group.count === 3); equal(sparse.length, 3, 'The fixture contains three small categories with three links each');
  check(sparse.every(group => Math.abs(group.groupTop - sparse[0].groupTop) <= 1), 'Three small categories share one row at 2K instead of each occupying a full row');
  check(sparse.slice(1).every((group, index) => group.groupLeft > sparse[index].groupRight), 'Small categories retain their order with a clear horizontal gap');
  check(sparse.flatMap(group => group.cards).every(card => Math.abs(card.top - sparse[0].cards[0].top) <= 1 && card.width >= 180 && card.width <= 320), 'All nine cards share the row with normal readable proportions');
  const panel = await nav.locator('.lh-navigation-panel').boundingBox(); check(!!panel, 'The navigation content bounds are measurable');
  check(Math.abs(sparse[0].groupLeft - panel.x) <= 1 && Math.abs(sparse.at(-1).groupRight - panel.x - panel.width) <= 1, 'The three small categories together fill the navigation width');
  const fuller = groups.filter(group => [5,7].includes(group.count)); check(fuller.some(group => group.count === 5) && fuller.some(group => group.count === 7), 'Demo contains the screenshot\'s five- and seven-link rows');
  for (const group of fuller) {
    check(group.cards.every(card => Math.abs(card.top - group.cards[0].top) <= 1), `${group.name}: cards fit on one 2K row`);
    check(Math.abs(group.cards[0].left - group.left) <= 1 && Math.abs(group.cards.at(-1).right - group.right) <= 1, `${group.name}: first and last cards fill the available row edges`);
  }
  const favorite = await page.locator('.lh-favorites-group').evaluate(node => {
    const r = node.getBoundingClientRect(), cards = [...node.querySelectorAll('.lh-bookmark')].map(card => { const b = card.getBoundingClientRect(); return { width: b.width, right: b.right }; });
    return { width: r.width, right: r.right, mainWidth: node.closest('.lh-main').getBoundingClientRect().width, cards };
  });
  equal(favorite.cards.length, 3, 'The sparse favorites fixture contains three cards');
  check(favorite.width < favorite.mainWidth * .6, 'Three favorites use a bounded backdrop instead of a full-width empty plate');
  check(favorite.cards.every(card => card.width >= 180 && card.width <= 320), 'Sparse favorites retain normal readable card proportions');
  check(favorite.right - favorite.cards.at(-1).right < 25, 'The backdrop ends shortly after its last card');
  details.geometry.rows = groups; details.geometry.favorites = favorite;
}
async function footer(label) {
  const value = await page.locator('.lh-footer').evaluate(node => {
    const r = node.getBoundingClientRect(), brand = node.querySelector('.is-right .lh-chrome-branding'), b = brand?.getBoundingClientRect();
    return { bottom: r.bottom + window.scrollY, documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight), x: b?.x, right: b?.right, viewportWidth: window.innerWidth, brandCount: node.querySelectorAll('.project-logo').length };
  });
  check(Math.abs(value.bottom - value.documentHeight) <= 2, `${label}: footer remains at the document bottom`);
  check(value.x > value.viewportWidth * .7 && value.brandCount === 1, `${label}: default project branding is in the bottom-right slot`); details.geometry[label] = value;
}
async function enterEditor() {
  await page.getByRole('button', { name: l('编辑页面', 'Edit page'), exact: true }).click();
  const root = page.locator('.lh-page-editor'); await root.locator('.lh-editor-controls').waitFor({ state: 'visible', timeout: STEP }); await settle(); return root;
}
async function fitDraft(root) {
  const control = page.locator(panelSelector()).getByRole('button', { name: l('书签导航：适应内容', 'Bookmarks: fit content'), exact: true });
  await control.waitFor({ state: 'visible', timeout: STEP }); await control.click(); await settle();
  const geometry = await page.locator(panelSelector()).evaluate(node => { const scroll = node.querySelector('.lh-grid-scroll'), r = node.getBoundingClientRect(); return { width: r.width, height: r.height, isFixed: node.classList.contains('is-fixed'), scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight }; });
  equal(geometry.isFixed, false, 'Fit content selects natural content height in the draft');
  check(geometry.scrollHeight <= geometry.clientHeight + 1, 'The fitted navigation exposes all content without its previous inner scroll');
  const changed = !isDeepStrictEqual(expectedConfig, originalPage.config);
  equal(await root.locator('.lh-editor-status').textContent(), changed ? l('尚未保存', 'Unsaved changes') : l('未修改', 'No changes'), 'Fit content reports whether it actually changed the original configuration');
  details.geometry.fitDraft = geometry; return geometry;
}
async function readonlyChecks() {
  step('2K homepage card fill and light branding'); await home();
  equal(await page.locator('html').getAttribute('lang'), bootstrap.language, 'Document language follows the fixed instance setting');
  await logos(page, 'home-light', 2, [36,18]); await noHorizontalOverflow('2K home'); await cardGeometry(); await footer('footer-light'); await capture('home-light'); await favicons();
  step('Dark homepage keeps the project logo colors');
  await page.getByRole('button', { name: l('切换深浅色', 'Toggle light or dark'), exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.lh-home')?.dataset.theme === 'dark', null, { timeout: STEP }); await settle();
  await logos(page, 'home-dark', 2, [36,18]); await capture('home-dark');
  step('Homepage edit controls use the full row and Fit content remains a draft');
  await home(); const root = await enterEditor();
  const controls = await root.locator('.lh-editor-controls').evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, controls: [...node.querySelectorAll('[role="combobox"]')].map(control => { const b = control.getBoundingClientRect(); return { name: control.getAttribute('aria-label'), left: b.left, right: b.right, top: b.top }; }) }; });
  equal(controls.controls.length, 6, 'The fixture exposes six homepage controls');
  check(controls.controls.every(control => Math.abs(control.top - controls.controls[0].top) <= 1), 'Six editor controls share one row at 2K');
  check(Math.abs(controls.controls[0].left - controls.left) <= 1 && Math.abs(controls.controls.at(-1).right - controls.right) <= 1, 'Editor controls fill the available left-to-right width');
  details.geometry.editorControls = controls; await fitDraft(root); await logos(page, 'home-editor', 2, [36,18]); await noHorizontalOverflow('Fitted 2K editor'); await capture('home-edit-fit-draft');
  equal(attempts, [], 'All appearance and fit changes remain unsaved'); equal(await readPage(), originalPage, 'Fit draft preserves the complete original persisted page and revision');
  await root.getByRole('button', { name: l('取消', 'Cancel'), exact: true }).click(); await root.waitFor({ state: 'hidden', timeout: STEP }); await settle();
  equal(attempts, [], 'Cancel sends no PUT'); equal(await readPage(), originalPage, 'Cancel retains the original configuration and revision');
  equal(await page.locator(panelSelector()).evaluate(node => node.classList.contains('is-fixed')), originalPage.config.layout.placements[navigationView.id].base.heightMode === 'fixed', 'Cancel restores the original saved navigation height mode');

  step('Admin, actual preview iframe, branding inspector, and About');
  await page.goto(base.origin + '/#/admin?tab=appearance', { waitUntil: 'domcontentloaded', timeout: STEP }); await page.locator('.admin-layout-savebar').waitFor({ state: 'visible', timeout: STEP });
  await logos(page, 'admin', 1, [39]);
  await page.getByRole('button', { name: l('预览首页', 'Preview homepage'), exact: true }).click();
  const iframe = page.locator('.admin-page-preview iframe'); await iframe.waitFor({ state: 'visible', timeout: STEP }); const frame = await (await iframe.elementHandle()).contentFrame(); check(!!frame, 'Admin preview has its real frame');
  await logos(frame, 'admin-preview-home', 2, [36,18]); equal(await iframe.getAttribute('sandbox'), 'allow-same-origin', 'Preview retains its no-script sandbox');
  equal(await frame.locator('.lh-grid-fit').count(), 0, 'The read-only preview exposes no grid mutation action'); await capture('admin-live-preview');
  await page.locator('.admin-layout-tabbar').getByRole('tab', { name: l('页眉与页脚', 'Header and footer'), exact: true }).click();
  const chrome = page.locator('.admin-chrome-editor'); await chrome.getByRole('tab', { name: l('页脚', 'Footer'), exact: true }).click(); await chrome.locator('.admin-chrome-alignments > button').nth(2).click();
  await chrome.locator('.admin-chrome-branding').waitFor({ state: 'visible', timeout: STEP }); await logos(page, 'admin-chrome-branding', 3, [39,18,48]); await capture('admin-header-footer');
  await page.getByRole('navigation', { name: l('管理菜单', 'Administration menu'), exact: true }).getByRole('button', { name: l('关于 Home', 'About Home'), exact: true }).click();
  await page.locator('.admin-about').waitFor({ state: 'visible', timeout: STEP }); await logos(page, 'admin-about', 2, [39,66]); await capture('admin-about');
  step('Sign-in identity without signing in'); await page.goto(base.origin + '/#/login', { waitUntil: 'domcontentloaded', timeout: STEP });
  await page.locator('.auth-card').waitFor({ state: 'visible', timeout: STEP }); await logos(page, 'sign-in', 1, [39]); await capture('sign-in');

  step('390px homepage and editor do not overflow'); await page.setViewportSize({ width: 390, height: 844 }); await home();
  await logos(page, 'home-390', 2, [32,18]); await noHorizontalOverflow('390px home'); await capture('home-390');
  const mobileEditor = await enterEditor(); await noHorizontalOverflow('390px editor'); equal(await page.locator('.lh-grid-fit').count(), 0, 'Narrow flow mode does not expose grid resizing or fit actions'); await capture('editor-390');
  await mobileEditor.getByRole('button', { name: l('取消', 'Cancel'), exact: true }).click(); await mobileEditor.waitFor({ state: 'hidden', timeout: STEP });
  equal(attempts, [], 'All captures and readonly acceptance checks send no writes'); equal(await readPage(), originalPage, 'Read-only phase retains page DTO and revision exactly');
  equal(records(await readNavigation()), records(originalNavigation), 'All original navigation fields remain exact after captures');
  await page.setViewportSize({ width: 2560, height: 1440 });
}
async function saveFitOnce() {
  step('English-only exact Fit content UI save'); await home(); const root = await enterEditor(); await fitDraft(root);
  equal(await readPage(), originalPage, 'Before Save, the live page is still the original'); equal(attempts, [], 'No write occurs before the Save click');
  putBudget = 1;
  try {
    const [response] = await Promise.all([
      page.waitForResponse(value => value.request().method() === 'PUT' && new URL(value.url()).pathname === pagePath(), { timeout: STEP }),
      root.getByRole('button', { name: 'Save layout', exact: true }).click()
    ]);
    check(response.ok(), `The one actual homepage Save succeeds: HTTP ${response.status()}`);
    equal(attempts.length, 1, 'One Save action sends exactly one page PUT'); equal(commits.length, 1, 'Exactly one page save is confirmed');
    const saved = await response.json(); equal(saved.config, expectedConfig, 'Saved full config differs only by the selected heightMode and h'); equal(saved.name, originalPage.name, 'Save retains the original page name');
    equal(await readPage(), saved, 'Save response equals its complete persisted readback'); await root.waitFor({ state: 'hidden', timeout: STEP });
    const reload = await page.reload({ waitUntil: 'domcontentloaded', timeout: STEP });
    check(reload?.ok(), 'A full document reload succeeds after saving');
    await page.locator('.lh-home-heading h1').waitFor({ state: 'visible', timeout: STEP });
    await page.waitForFunction(() => document.querySelectorAll('.lh-bookmark').length > 0, null, { timeout: STEP }); await settle();
    equal(await readPage(), saved, 'A full document reload retains the content-height selection');
    const scroll = await page.locator(panelSelector() + ' .lh-grid-scroll').evaluate(node => ({ scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
    check(scroll.scrollHeight <= scroll.clientHeight + 1, 'Saved and reloaded navigation needs no inner scroll');
    await settle(); await capture('home-fit-saved');
    equal(records(await readNavigation()), records(originalNavigation), 'Saving layout changes no bookmark or category field');
    details.savedFit = { initialRevision: originalPage.revision, savedRevision: saved.revision, viewId: navigationView.id, before: originalPage.config.layout.placements[navigationView.id].base, after: saved.config.layout.placements[navigationView.id].base, scroll };
  } finally { putBudget = 0; }
}
async function restoreOriginal() {
  const current = await readPage();
  if (isDeepStrictEqual({ name: current.name, config: current.config }, { name: originalPage.name, config: originalPage.config })) {
    equal(current, originalPage, 'No-write run preserves original page DTO and revision'); cleanups.push({ action: 'not-needed', revision: current.revision }); return;
  }
  check(phase === 'fit' && base.port === '5183' && commits.length === 1 && current.revision === lastSavedRevision && isDeepStrictEqual(current.config, expectedConfig), 'Restoration requires this run\'s exact latest saved page; another writer is never overwritten');
  const response = await context.request.put(endpoint('/spaces/' + encodeURIComponent(space.id) + '/page'), { timeout: STEP, maxRedirects: 0, headers: { 'X-CSRF-TOKEN': bootstrap.csrfToken }, data: { name: originalPage.name, config: originalPage.config, expectedRevision: current.revision } });
  cleanups.push({ action: 'restore-original-name-and-full-config', expectedRevision: current.revision, status: response.status(), classification: 'API cleanup, separate from the one UI save' });
  check(response.ok(), `Original page restoration: HTTP ${response.status()}`); const restored = await response.json(); equal(await readPage(), restored, 'Restoration response matches its readback');
  equal({ name: restored.name, config: restored.config }, { name: originalPage.name, config: originalPage.config }, 'Original name and complete configuration are restored, including absent optional fields'); cleanups.push({ action: 'restored', revision: restored.revision });
}
(async () => {
  let failure;
  try {
    check(['readonly','fit'].includes(phase), 'Use --phase readonly or fit'); check(!!process.env.BASE_URL, 'An explicit BASE_URL is required'); base = new URL(process.env.BASE_URL);
    check(['http:','https:'].includes(base.protocol) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Use a plain instance root'); equal(base.hostname, '10.233.233.61', 'Only the designated demo host is allowed'); check(['5182','5183'].includes(base.port), 'Only isolated demo ports 5182 and 5183 are accepted');
    if (phase === 'fit') check(base.port === '5183' && args.includes('--allow-demo-write'), 'One-save phase requires the English clone and --allow-demo-write');
    const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, timeout: STEP, ignoreDefaultArgs: ['--hide-scrollbars'], args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox','--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'] });
    context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light', reducedMotion: 'no-preference' }); context.setDefaultTimeout(STEP); context.setDefaultNavigationTimeout(STEP);
    bootstrap = await read('/bootstrap'); const settings = await read('/settings'); equal(bootstrap.initialized, true, 'The demo is initialized'); equal(bootstrap.language, base.port === '5183' ? 'en' : 'zh-CN', 'The demo language matches its dedicated port');
    equal(bootstrap.mode, 'open_edit', 'Bootstrap confirms open_edit'); equal(settings.mode, 'open_edit', 'Settings confirm open_edit'); equal(settings.hasOwner, false, 'An owner-bearing service is refused'); check(bootstrap.user == null, 'No account is signed in');
    space = bootstrap.spaces.find(item => item.id === bootstrap.defaultSpaceId); check(space?.kind === 'shared' && space.published && space.canEdit, 'The demo space is shared, published and editable');
    originalPage = await readPage(); originalNavigation = await readNavigation(); lastSavedRevision = originalPage.revision; equal(originalPage.spaceId, space.id, 'Page belongs to the guarded space');
    equal(originalNavigation.data.links.length, 43, 'The known public demo contains 43 bookmarks'); equal(originalNavigation.data.categories.length, 8, 'The known public demo contains eight categories');
    const candidates = originalPage.config.views.filter(view => view.panel.id === 'builtin/navigation' && originalPage.config.bindings[view.inputs.collection]?.datasetId === 'local-navigation'); equal(candidates.length, 1, 'There is one local navigation panel'); navigationView = candidates[0];
    const placement = originalPage.config.layout.placements[navigationView.id].base; check(placement.kind === 'grid' && !placement.locked && ['fixed','content'].includes(placement.heightMode) && placement.h >= 3 && placement.w === 24, 'The screenshot fixture retains its full-width, unlocked navigation panel');
    if (phase === 'fit') check(placement.heightMode === 'fixed' && placement.h > 3, 'The one-save English phase starts from a genuinely fixed navigation footprint');
    expectedConfig = structuredClone(originalPage.config); expectedConfig.layout.placements[navigationView.id].base = { ...placement, h: 3, heightMode: 'content' }; approved = true;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base.origin) { blocked.push({ method: request.method(), path: url.origin + url.pathname, reason: 'outside demo origin' }); return route.abort('blockedbyclient'); }
      if (['GET','HEAD','OPTIONS'].includes(request.method())) return route.continue();
      const attempt = { method: request.method(), path: url.pathname, step: currentStep }; attempts.push(attempt);
      if (phase !== 'fit' || base.port !== '5183' || !args.includes('--allow-demo-write') || request.method() !== 'PUT' || url.pathname !== pagePath() || url.search || putBudget !== 1) { blocked.push({ ...attempt, reason: 'outside the one armed page save' }); return route.abort('blockedbyclient'); }
      let body; try { body = request.postDataJSON(); } catch { blocked.push({ ...attempt, reason: 'invalid JSON' }); return route.abort('blockedbyclient'); }
      if (!body || body.expectedRevision !== lastSavedRevision || body.name !== originalPage.name || !isDeepStrictEqual(body.config, expectedConfig) || Object.keys(body).some(key => !['name','config','expectedRevision'].includes(key))) { blocked.push({ ...attempt, reason: 'payload differs from the exact fit-only configuration' }); return route.abort('blockedbyclient'); }
      putBudget = 0; attempt.expectedRevision = body.expectedRevision;
      try {
        const response = await route.fetch({ timeout: STEP, maxRedirects: 0 }); attempt.status = response.status();
        if (response.ok()) { const saved = await response.json(); check(saved.id === originalPage.id && saved.spaceId === space.id && typeof saved.revision === 'string', 'Save remains inside the guarded page'); lastSavedRevision = saved.revision; commits.push({ revision: saved.revision, expectedRevision: body.expectedRevision, path: url.pathname }); }
        return route.fulfill({ response });
      } catch (error) { routeErrors.push(error.message); await route.abort('failed').catch(() => {}); }
    });
    page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0,400)); }); page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
    emit({ event: 'preflight', status: 'passed', phase, origin: base.origin, language: bootstrap.language, pageId: originalPage.id, revision: originalPage.revision, initialConfigSha256: hash(originalPage.config), businessSha256: hash(records(originalNavigation)) });
    await readonlyChecks(); if (phase === 'fit') await saveFitOnce();
    equal(blocked, [], 'No external or unapproved request was attempted'); equal(routeErrors, [], 'No forwarding errors'); equal(pageErrors, [], 'No uncaught browser errors'); equal(consoleErrors, [], 'No console errors'); equal(dialogs, [], 'No native alert, prompt, or confirm dialogs');
  } catch (error) { failure = error; if (page) await capture('failure').catch(() => {}); }
  finally {
    putBudget = 0;
    if (approved) {
      try { await restoreOriginal(); } catch (error) { cleanups.push({ action: 'restoration-failed', message: error.message }); failure = failure || error; }
      try { equal(records(await readNavigation()), records(originalNavigation), 'Finally: every original bookmark and category field remains unchanged'); cleanups.push({ action: 'business-records-unchanged' }); } catch (error) { cleanups.push({ action: 'business-check-failed', message: error.message }); failure = failure || error; }
    }
    const report = { status: failure ? 'failed' : 'passed', phase, runId, assertions, currentStep, message: failure?.message, stack: failure?.stack, details, attempts, commits, cleanups, blocked, routeErrors, pageErrors, consoleErrors, nativeDialogs: dialogs, screenshots };
    try { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); } catch (error) { failure = failure || error; }
    emit({ event: 'summary', ...report, status: failure ? 'failed' : 'passed', message: failure?.message, reportPath }); if (failure) process.exitCode = 1;
    if (context) await context.close().catch(() => {}); if (browser) await browser.close().catch(() => {});
  }
})();
