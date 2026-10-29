#!/usr/bin/env node
'use strict';
/** Dashboard preset acceptance against a FRESH, explicitly disposable instance.
 * BASE_URL=http://127.0.0.1:5202 LINGSHU_EXPECT_LANGUAGE=zh-CN \
 *   node tests/browser_dashboard_presets.cjs --disposable-instance
 * Run en against a separate fresh 5203 instance. Only these two ports are allowed.
 * --guard-only checks the target/opt-in without loading Playwright or using HTTP.
 * LINGSHU_DASHBOARD_EXAMPLES_DIR overrides the required public example directory
 * when this script is copied away from the repository. Missing files are errors.
 * All service data is explicitly created through the real external-push API.
 * Calendar/weather fixtures are shifted into the current UTC week in memory;
 * their titles and values remain fictional. No upstream URL is fetched.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const runId = randomUUID().slice(0, 12), timeout = 15000;
const reportPath = process.env.REPORT_PATH || path.join(os.tmpdir(), `home-dashboard-presets-${runId}.json`);
const screenshotDirectory = process.env.SCREENSHOT_DIR || path.join(path.dirname(reportPath), `dashboard-presets-${runId}`);
const examplesDirectory = process.env.LINGSHU_DASHBOARD_EXAMPLES_DIR || path.resolve(__dirname, '../examples/dashboard-data');
const desktops = [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080]];
const navigationQuery = { tags: ['ops'], limit: 5 }, navigationScope = 'fixture-navigation-scope';
const presets = {
  'personal-overview': { slots: ['weather', 'calendar', 'favorites', 'navigation'], external: ['weather', 'calendar'], pair: ['weather', 'calendar'], widths: [8, 16], panels: ['builtin/weather', 'builtin/calendar', 'builtin/favorites', 'builtin/navigation'] },
  'service-operations': { slots: ['services', 'resources', 'navigation'], external: ['services', 'resources'], pair: ['services', 'resources'], widths: [16, 8], panels: ['builtin/status', 'builtin/metrics', 'builtin/navigation'] },
  'data-summary': { slots: ['overview', 'secondary', 'traffic', 'navigation'], external: ['overview', 'secondary'], pair: ['overview', 'secondary'], widths: [12, 12], panels: ['builtin/metrics', 'builtin/metrics', 'builtin/navigation'] },
};
const contracts = {
  'builtin/category-navigation': ['navigation.collection', 'collection'],
  'builtin/favorites': ['navigation.collection', 'collection'],
  'builtin/navigation': ['navigation.collection', 'collection'],
  'builtin/calendar': ['calendar.events', 'events'],
  'builtin/weather': ['weather.forecast', 'weather'],
  'builtin/metrics': ['metrics.summary', 'metrics'],
  'builtin/status': ['status.collection', 'status'],
  'builtin/github-traffic': ['github.traffic', 'traffic'],
};
let base, browser, context, page, boot, space, csrf = '', checks = 0, phase = 'preflight';
let initializedByRun = false, acceptanceExecuted = false, socketCount = 0;
let preservationBaseline, navigationBaseline, fixtureIndex, awaitingSource;
const sourceByName = {}, sourceSnapshots = {}, examples = {}, fixtureHashes = {};
const errors = [], pageErrors = [], consoleErrors = [], expectedConsoleErrors = [], expectedHTTP = [];
const requests = [], responses = [], failedRequests = [], unexpectedNetwork = [], apiRequests = [], screenshots = [];
const measurements = { geometry: {}, savedPages: [], fixtureScope: 'Synthetic, same-space, explicit HTTP push; no polling or upstream fetch.' };
const check = (value, label) => { assert.ok(value, label); checks++; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const clone = value => structuredClone(value);
const l = (zh, en) => boot.language === 'en' ? en : zh;
const step = label => { phase = label; process.stdout.write(JSON.stringify({ phase, checks }) + '\n'); };
const apiURL = value => base.origin + '/api/v1' + value;
const readPage = () => api(`/spaces/${space.id}/page`);
const readNavigation = () => api(`/spaces/${space.id}/navigation`);
const browserMutations = () => requests.filter(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method));
const dialog = () => page.getByRole('dialog', { name: l('预置仪表板', 'Dashboard presets'), exact: true });
const slot = id => dialog().locator(`.dashboard-preset-slot[data-slot="${id}"]`);
const applyButton = () => dialog().getByRole('button', { name: l('替换当前草稿布局', 'Replace draft layout'), exact: true });
const control = view => ['builtin/search', 'builtin/category-navigation'].includes(view.panel.id);

function validateStartup() {
  check(process.argv.includes('--disposable-instance'), 'Disposable-instance opt-in is required before any HTTP request');
  check(!!process.env.BASE_URL, 'BASE_URL must explicitly name the fresh disposable instance');
  base = new URL(process.env.BASE_URL);
  check(base.protocol === 'http:' && !base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'A plain local test origin is required');
  check(['127.0.0.1', 'localhost', '10.233.233.61'].includes(base.hostname), 'Only an approved local test host is accepted');
  check(['5202', '5203'].includes(base.port), 'Only isolated preset ports 5202/5203 are permitted; all existing service and acceptance ports are protected');
  if (process.env.LINGSHU_EXPECT_LANGUAGE) check(['zh-CN', 'en'].includes(process.env.LINGSHU_EXPECT_LANGUAGE), 'Expected language must be zh-CN or en');
}
function loadExamples() {
  const indexPath = path.join(examplesDirectory, 'index.json');
  fixtureIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  equal(fixtureIndex.format, 'lingshu-home-dashboard-data-examples', 'Required fixture directory contains the public handoff index');
  equal(fixtureIndex.indexVersion, 1, 'Fixture index version is supported');
  for (const contract of fixtureIndex.contracts) for (const item of contract.examples) {
    check(path.basename(item.file) === item.file && !examples[item.file], 'Fixture names are unique local files');
    const bytes = fs.readFileSync(path.join(examplesDirectory, item.file));
    examples[item.file] = JSON.parse(bytes.toString('utf8'));
    fixtureHashes[item.file] = createHash('sha256').update(bytes).digest('hex');
    equal(examples[item.file].schemaId, contract.schemaId, 'Example schema matches its public index');
    equal(examples[item.file].schemaVersion, 1, 'Example uses the implemented schema version');
  }
  for (const filename of ['metrics.resources.push.json', 'metrics.overview.push.json', 'metrics.secondary.push.json', 'status.services.push.json', 'calendar.events.push.json', 'weather.forecast.push.json']) {
    check(!!examples[filename], `Required public fixture ${filename} exists`);
  }
}
async function api(relative, method = 'GET', body, status = 200) {
  if (!['GET', 'HEAD'].includes(method)) check(initializedByRun || relative === '/setup' && boot?.initialized === false, 'Mutations require a fresh instance initialized by this run');
  const response = await context.request.fetch(apiURL(relative), { method, data: body, headers: { 'X-CSRF-TOKEN': csrf }, timeout, maxRedirects: 0 });
  apiRequests.push({ phase, method, path: relative, status: response.status() });
  equal(response.status(), status, `${method} ${relative}: real API status`);
  return status === 204 ? null : response.json();
}
async function refreshBoot() { boot = await api('/bootstrap'); csrf = boot.csrfToken; return boot; }
async function until(predicate, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) { check(true, label); return; }
    await page.waitForTimeout(40);
  }
  throw new Error(label + ': timed out');
}
async function select(locator, label) {
  await locator.click();
  await page.getByRole('option', { name: label, exact: true }).click();
}
async function chooseSharedSpace() {
  if (boot.spaces.length < 2) return;
  const picker = page.getByRole('combobox', { name: l('选择空间', 'Choose a space'), exact: true });
  await picker.waitFor();
  if ((await picker.innerText()).trim() === space.name.trim()) return;
  const [response] = await Promise.all([
    page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.origin === base.origin && url.pathname === '/api/v1/dashboard' && url.searchParams.get('spaceId') === space.id;
    }, { timeout }),
    select(picker, space.name),
  ]);
  equal(response.status(), 200, 'UI loads the authorized shared fixture space');
  equal((await response.json()).space.id, space.id, 'Displayed dashboard belongs to the fixture space');
  await page.waitForLoadState('networkidle');
  equal((await picker.innerText()).trim(), space.name.trim(), 'Space picker reflects the actual loaded space');
}
async function home() {
  await page.goto(base.origin + '/#/', { waitUntil: 'networkidle', timeout });
  await page.reload({ waitUntil: 'networkidle', timeout });
  await page.locator('.lh-home').waitFor();
  await chooseSharedSpace();
  await page.waitForLoadState('networkidle');
  equal(await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.type), 'reload', 'Page is verified after a real document reload');
}
async function enterEditor() {
  await page.locator('.lh-more-trigger').click(); await page.getByRole('menuitem', { name: l('调整布局', 'Adjust layout'), exact: true }).click();
  await page.locator('.lh-composer').waitFor();
  await page.waitForLoadState('networkidle');
}
async function openPresets(presetId) {
  await page.locator('.lh-composer-library-toggle').click();
  await page.locator('.lh-composer-library').getByRole('button', { name: l('预置仪表板', 'Dashboard presets'), exact: true }).click();
  await dialog().waitFor();
  await until(() => dialog().locator('[data-preset="personal-overview"]').isEnabled(), 'Preset source inventory has loaded');
  await choosePreset(presetId);
}
async function choosePreset(id) {
  await dialog().locator(`[data-preset="${id}"]`).click();
  equal(await dialog().locator(`[data-preset="${id}"]`).getAttribute('aria-pressed'), 'true', 'Selected preset is explicit');
  equal(await dialog().locator('.dashboard-preset-slot').evaluateAll(nodes => nodes.map(node => node.dataset.slot)), presets[id].slots, 'Dialog exposes the exact selected preset slots');
  await page.waitForLoadState('networkidle');
}
async function includeSlot(id, included) {
  const checkbox = slot(id).getByRole('checkbox');
  if (await checkbox.isChecked() !== included) await checkbox.click();
  equal(await checkbox.isChecked(), included, `${id}: inclusion is explicit`);
}
async function assignSlot(id, source) {
  await includeSlot(id, true);
  await select(slot(id).getByRole('combobox'), source.name);
  equal(await slot(id).getAttribute('data-state'), 'bound', `${id}: chosen real source is bound in the draft`);
}
async function cancelDialog() {
  await dialog().getByRole('button', { name: l('取消', 'Cancel'), exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  await page.waitForLoadState('networkidle');
}
async function cancelEditor(expectDirty, keepOnce = false) {
  const cancel = () => page.locator('.lh-composer-toolbar-actions').getByRole('button', { name: l('取消', 'Cancel'), exact: true }).click();
  await cancel();
  if (expectDirty) {
    const confirmation = page.getByRole('dialog', { name: l('放弃未保存的修改？', 'Discard unsaved changes?'), exact: true });
    await confirmation.waitFor();
    if (keepOnce) {
      await confirmation.getByRole('button', { name: l('继续编辑', 'Keep editing'), exact: true }).click();
      await confirmation.waitFor({ state: 'hidden' });
      check(await page.locator('.lh-composer').isVisible(), 'Declining discard keeps the draft open');
      await cancel(); await confirmation.waitFor();
    }
    await confirmation.getByRole('button', { name: l('放弃修改', 'Discard changes'), exact: true }).click();
  }
  await page.locator('.lh-composer').waitFor({ state: 'hidden' });
  await page.waitForLoadState('networkidle');
}
async function applyDraft(before) {
  check(await applyButton().isEnabled(), 'All included slots are valid before applying');
  const writes = browserMutations().length;
  await applyButton().click();
  await dialog().waitFor({ state: 'hidden' });
  await page.waitForLoadState('networkidle');
  equal(browserMutations().length, writes, 'Applying a preset only changes the local page draft');
  equal(await readPage(), before, 'Apply has not changed the server page or its revision');
  check(await page.locator('.lh-composer-toolbar-actions').getByRole('button', { name: l('保存页面', 'Save page'), exact: true }).isEnabled(), 'Draft requires the explicit Save page action');
}
function preservation(config) {
  return {
    pageTheme: config.pageTheme, appearance: config.appearance, chrome: config.chrome, gap: config.layout.gap,
    controls: config.views.filter(control).map(view => ({ view, placement: config.layout.placements[view.id], bindings: Object.fromEntries(Object.values(view.inputs).map(alias => [alias, config.bindings[alias]])) })),
  };
}
function validatePage(config, expectedPanels, expectedNavigation) {
  equal(config.schemaVersion, 2, 'Saved page uses PageConfig version 2');
  equal(config.layout.grid.columns, 24, 'Saved page uses the existing 24-column grid');
  check(config.views.length <= 32 && Object.keys(config.bindings).length <= 32, 'Saved page remains within existing component/binding bounds');
  equal(Object.keys(config.layout.placements).sort(), config.views.map(view => view.id).sort(), 'Skipped components leave no orphan placements');
  equal(preservation(config), preservationBaseline, 'Theme, appearance, chrome, gap, search and category settings/placements/bindings are preserved');
  equal(config.views.filter(view => !control(view)).map(view => view.panel.id).sort(), [...expectedPanels].sort(), 'Only selected preset components are persisted');
  const inventory = new Map(Object.values(sourceByName).map(source => [source.datasetId, source]));
  for (const [alias, binding] of Object.entries(config.bindings)) {
    equal(binding.space, 'current-page-space', `${alias}: binding remains in the current page space`);
    check(binding.datasetId === 'local-navigation' || inventory.has(binding.datasetId), `${alias}: dataset is local or a real source created in this fixture space`);
    const schema = binding.datasetId === 'local-navigation' ? 'navigation.collection' : inventory.get(binding.datasetId).schemaId;
    if (schema !== 'navigation.collection') equal(binding.query, {}, `${alias}: non-navigation data has no invented field projection`);
  }
  for (const view of config.views) {
    check(!!config.layout.placements[view.id], `${view.id}: view has its placement`);
    if (view.panel.id === 'builtin/search') { equal(view.inputs, {}, 'Search retains its input-free contract'); continue; }
    const pair = contracts[view.panel.id]; check(!!pair, `${view.id}: renderer is actually installed`);
    equal(Object.keys(view.inputs), [pair[1]], `${view.id}: exact renderer input contract`);
    const binding = config.bindings[view.inputs[pair[1]]]; check(!!binding, `${view.id}: input alias resolves`);
    const schema = binding.datasetId === 'local-navigation' ? 'navigation.collection' : inventory.get(binding.datasetId).schemaId;
    equal(schema, pair[0], `${view.id}: saved source schema matches the renderer`);
    if (['builtin/navigation', 'builtin/favorites'].includes(view.panel.id)) {
      equal(binding.query, navigationQuery, 'Preset preserves the original navigation/favorites binding query');
      equal(view.interactionScope, navigationScope, 'Preset preserves the navigation/favorites interaction group');
    }
    if (view.panel.id === 'builtin/navigation') equal(binding.datasetId, expectedNavigation, 'Preset preserves the intended original navigation source');
    if (!control(view)) {
      equal(config.layout.placements[view.id].base.heightMode, 'content', 'Preset cards retain content-aware height');
      equal(config.layout.placements[view.id].overrides.narrow.kind, 'flow', 'Preset cards retain an explicit narrow-flow override');
    }
  }
}
async function saveDraft(before, expectedPanels, expectedNavigation, label) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url() === apiURL(`/spaces/${space.id}/page`) && response.request().method() === 'PUT', { timeout }),
    page.locator('.lh-composer-toolbar-actions').getByRole('button', { name: l('保存页面', 'Save page'), exact: true }).click(),
  ]);
  equal(response.status(), 200, 'Save page passes the real backend validators');
  const body = response.request().postDataJSON(), saved = await response.json();
  equal(body.expectedRevision, before.revision, 'Save uses the revision originally read by the editor');
  check(saved.revision !== before.revision, 'Successful Save advances the actual page revision');
  equal(saved.config, body.config, 'Server persists the complete UI compiler output');
  validatePage(saved.config, expectedPanels, expectedNavigation);
  await page.locator('.lh-composer').waitFor({ state: 'hidden' });
  await page.waitForLoadState('networkidle');
  equal(await readPage(), saved, 'Immediate read returns the saved page');
  await home();
  equal(await readPage(), saved, 'A full reload preserves page config and revision');
  equal((await readNavigation()).data, navigationBaseline, 'Preset/save/reload leaves local bookmark/category records unchanged');
  measurements.savedPages.push({ label, revision: saved.revision, config: saved.config });
  return saved;
}
async function capture(label) {
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  const target = path.join(screenshotDirectory, `presets-${boot?.language || 'unknown'}-${runId}-${label}.png`);
  await page.screenshot({ path: target, fullPage: false, timeout }); screenshots.push(target);
}
function slotView(config, id) {
  return config.views.find(view => view.id.startsWith('preset-') && (view.id.endsWith('-' + id) || new RegExp('-' + id + '-[0-9]+$').test(view.id)));
}
async function measurePreset(presetId, config) {
  const declaration = presets[presetId];
  const expectedViews = config.views.filter(view => !control(view));
  for (const view of expectedViews) await page.locator(`.lh-grid-frame[data-panel-id="${view.id}"]`).waitFor();
  await page.locator('.lh-data-panel').first().waitFor();
  await page.waitForLoadState('networkidle');
  for (const [width, height] of desktops) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const measured = await page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight }, clientWidth: document.documentElement.clientWidth,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      theme: document.querySelector('.lh-home')?.getAttribute('data-page-theme'),
      frames: [...document.querySelectorAll('.lh-grid-frame')].map(node => {
        const box = node.getBoundingClientRect(), measure = node.querySelector('.lh-grid-measure');
        return { id: node.dataset.panelId, x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height,
          clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, contentClient: measure?.clientWidth, contentScroll: measure?.scrollWidth };
      }),
    }));
    const label = `${presetId}-${width}x${height}`; measurements.geometry[label] = measured;
    equal(measured.theme, preservationBaseline.pageTheme.id, `${label}: saved page theme is actually rendered`);
    check(measured.scrollWidth <= measured.clientWidth + 1, `${label}: no horizontal document overflow`);
    equal(measured.frames.map(frame => frame.id).sort(), expectedViews.map(view => view.id).sort(), `${label}: only persisted main panels render`);
    for (const frame of measured.frames) {
      check(frame.width > 150 && frame.height > 50, `${label}/${frame.id}: usable card geometry`);
      check(frame.x >= -1 && frame.right <= width + 1, `${label}/${frame.id}: card stays inside viewport width`);
      check(frame.scrollWidth <= frame.clientWidth + 1 && frame.contentScroll <= frame.contentClient + 1, `${label}/${frame.id}: content does not overflow its width`);
    }
    for (let i = 0; i < measured.frames.length; i++) for (let j = i + 1; j < measured.frames.length; j++) {
      const a = measured.frames[i], b = measured.frames[j];
      const overlapX = Math.min(a.right, b.right) - Math.max(a.x, b.x), overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      check(overlapX <= 1 || overlapY <= 1, `${label}: panels do not overlap`);
    }
    const pair = declaration.pair.map(id => {
      const view = slotView(config, id); check(!!view, `${label}: expected paired slot ${id} is persisted`);
      return measured.frames.find(frame => frame.id === view.id);
    });
    check(Math.abs(pair[0].y - pair[1].y) <= 2 && pair[0].right <= pair[1].x + 1, `${label}: primary pair shares a row in the intended order`);
    const actualRatio = (pair[0].width + config.layout.gap) / (pair[1].width + config.layout.gap);
    check(Math.abs(actualRatio - declaration.widths[0] / declaration.widths[1]) < 0.04, `${label}: visual column proportions match the preset`);
    await page.evaluate(() => scrollTo(0, 0));
    await capture(label);
  }
  await page.setViewportSize({ width: 2560, height: 1440 });
}
async function seedLocalPage() {
  const category = await api(`/spaces/${space.id}/categories`, 'POST', { name: 'Fixture bookmarks', icon: 'lucide:folder', sortOrder: 0 }, 201);
  const reference = await api(`/spaces/${space.id}/categories`, 'POST', { name: 'Fixture reference', icon: 'lucide:folder', sortOrder: 1 }, 201);
  for (const [index, title] of ['Fixture documentation', 'Fixture console', 'Fixture handbook', 'Fixture excluded by saved query'].entries()) {
    await api(`/spaces/${space.id}/links`, 'POST', { title, url: `https://preset-${index}.invalid/`, categoryId: index === 2 ? reference.id : category.id, icon: 'lucide:link', iconMode: 'manual', tags: index === 3 ? ['personal'] : ['ops', 'fixture'], isFavorite: index < 2, sortOrder: index, endpoints: [] }, 201);
  }
  navigationBaseline = (await readNavigation()).data;
  const current = await readPage(), config = clone(current.config);
  config.pageTheme = { id: 'builtin/ios' }; config.appearance = { colorMode: 'light', density: 'compact' }; config.layout.gap = 12;
  config.chrome = { header: { enabled: true, left: [{ id: 'fixture-header', type: 'text', text: 'Dashboard acceptance fixture' }], center: [], right: [] }, footer: { enabled: true, left: [{ id: 'fixture-footer', type: 'text', text: 'Synthetic test data only' }], center: [], right: [{ id: 'fixture-brand', type: 'branding' }] } };
  const search = config.views.find(view => view.panel.id === 'builtin/search'), categories = config.views.find(view => view.panel.id === 'builtin/category-navigation');
  check(!!search && !!categories, 'Fresh page has the existing search and category controls');
  for (const view of config.views) if (['builtin/search', 'builtin/category-navigation', 'builtin/navigation', 'builtin/favorites'].includes(view.panel.id)) view.interactionScope = navigationScope;
  config.bindings.navigation.query = clone(navigationQuery);
  search.settings = { title: 'Preserved search settings' };
  categories.settings = { title: 'Preserved category settings', displayMode: 'text', hierarchyMode: 'flat', collapsible: true, defaultCollapsed: false, showCounts: false };
  config.layout.placements[search.id].base.size = { widthPx: 320, maxWidthPx: 360 };
  const saved = await api(`/spaces/${space.id}/page`, 'PUT', { name: 'Dashboard preset acceptance', expectedRevision: current.revision, config });
  preservationBaseline = preservation(saved.config);
}
async function missingSourceAndCancellation() {
  step('Missing-source constraints, explicit omission and draft cancellation');
  await home(); const initial = await readPage(); await enterEditor();
  await openPresets('personal-overview');
  const beforeWrites = browserMutations().length;
  for (const id of Object.keys(presets)) {
    await choosePreset(id);
    for (const required of presets[id].external) {
      equal(await slot(required).getByRole('checkbox').isChecked(), true, `${id}/${required}: required slot starts explicitly selected`);
      equal(await slot(required).getAttribute('data-state'), 'pending', `${id}/${required}: absence of a real source is visible`);
    }
    check(await applyButton().isDisabled(), `${id}: selected missing sources block Apply`);
    check(await dialog().locator('.dashboard-preset-issues').isVisible(), `${id}: unresolved slots have an explanation`);
    if (id === 'data-summary') {
      equal(await slot('traffic').getAttribute('data-state'), 'omitted', 'GitHub source is optional and initially omitted');
      await includeSlot('traffic', true);
      equal(await slot('traffic').getAttribute('data-state'), 'pending', 'Explicitly selecting unavailable GitHub traffic does not create a connection');
      await includeSlot('traffic', false);
    }
    for (const required of presets[id].external) await includeSlot(required, false);
    check(await applyButton().isEnabled(), `${id}: explicitly omitting unavailable data leaves a legal navigation layout`);
  }
  await choosePreset('service-operations');
  await includeSlot('services', false); await includeSlot('resources', false);
  await capture('unbound-slots-omitted');
  await cancelDialog();
  equal(browserMutations().length, beforeWrites, 'Choosing/omitting/cancelling presets has no browser writes');
  equal(await readPage(), initial, 'Dialog Cancel preserves the server page exactly');
  await openPresets('service-operations'); await includeSlot('services', false); await includeSlot('resources', false);
  await applyDraft(initial);
  await cancelEditor(true, true);
  equal(browserMutations().length, beforeWrites, 'Applying then discarding the page draft still makes no browser writes');
  equal(await readPage(), initial, 'Discarding the applied preset restores the exact saved page');
  await enterEditor(); await openPresets('service-operations'); await includeSlot('services', false); await includeSlot('resources', false);
  await applyDraft(initial);
  const saved = await saveDraft(initial, ['builtin/navigation'], 'local-navigation', 'all-external-slots-omitted');
  equal(Object.values(saved.config.bindings).map(binding => binding.datasetId), ['local-navigation'], 'Skipped external slots leave only the real local binding');
  equal((await api(`/spaces/${space.id}/sources`)).length, 0, 'Preset/skip/cancel/save did not create any source');
}
function currentFixture(filename) {
  const result = clone(examples[filename]); result.requestId = `preset-${runId}-${filename.replace(/\.push\.json$/, '')}`;
  result.sourceUpdatedAt = new Date().toISOString();
  const now = new Date(), midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monday = midnight - ((now.getUTCDay() + 6) % 7) * 86400000, shift = monday / 1000 - 1705276800;
  if (result.schemaId === 'calendar.events') {
    result.data.windowStart += shift; result.data.windowEnd += shift;
    for (const event of result.data.events) {
      event.startAt += shift; event.endAt += shift;
      if (event.allDay) { event.startDate = new Date(event.startAt * 1000).toISOString().slice(0, 10); event.endDate = new Date(event.endAt * 1000).toISOString().slice(0, 10); }
      event.description = 'Synthetic browser acceptance fixture, shifted into the current UTC week. No real appointment.';
    }
  }
  if (result.schemaId === 'weather.forecast') {
    if (result.data.current) result.data.current.time += shift;
    for (const day of result.data.daily) {
      day.date = new Date(Date.parse(day.date + 'T00:00:00Z') + shift * 1000).toISOString().slice(0, 10);
      if (day.sunrise) day.sunrise += shift; if (day.sunset) day.sunset += shift;
    }
  }
  return result;
}
async function createPushFixture(name, schemaId, data) {
  const source = await api(`/spaces/${space.id}/sources`, 'POST', { name, kind: 'external-push', schemaId, schemaVersion: 1, connection: {}, sync: { mode: 'push', staleAfterSeconds: 3600 }, enabled: true }, 201);
  sourceByName[name] = source;
  equal(source.kind, 'external-push', 'Fixture source is explicitly push-only');
  equal(source.nextSyncAt, null, 'Push fixture creates no poll schedule');
  equal(source.credentialConfigured, false, 'Push fixture contains no upstream credential');
  const receipt = await api(`/sources/${source.id}/snapshot`, 'PUT', data);
  equal(receipt.revision, '1', 'First real snapshot is accepted at revision 1');
  const snapshot = await api(`/sources/${source.id}/snapshot`);
  equal(snapshot.schemaId, schemaId, 'Read-back snapshot uses the intended schema');
  sourceSnapshots[source.id] = { revision: snapshot.revision, data: snapshot.data };
  return source;
}
async function seedPushSources() {
  step('Explicit same-space push fixtures for the four existing data schemas');
  for (const [name, filename] of [
    ['Fixture weather', 'weather.forecast.push.json'], ['Fixture calendar', 'calendar.events.push.json'],
    ['Fixture services', 'status.services.push.json'], ['Fixture resources', 'metrics.resources.push.json'],
    ['Fixture overview', 'metrics.overview.push.json'], ['Fixture secondary', 'metrics.secondary.push.json'],
  ]) {
    const body = currentFixture(filename); await createPushFixture(name, body.schemaId, body);
  }
  await createPushFixture('Fixture external bookmarks', 'navigation.collection', {
    requestId: `preset-navigation-${runId}`, expectedRevision: '0', schemaId: 'navigation.collection', schemaVersion: 1, sourceUpdatedAt: new Date().toISOString(),
    data: { categories: [{ externalId: 'fixture', parentExternalId: null, name: 'External fixture operations', icon: 'lucide:folder', sortOrder: 0 }, { externalId: 'reference', parentExternalId: null, name: 'External fixture reference', icon: 'lucide:folder', sortOrder: 1 }], links: [
      { externalId: 'runbook', categoryExternalId: 'reference', title: 'External fixture runbook', url: 'https://external-preset.invalid/runbook', description: 'Synthetic source; not fetched', icon: 'lucide:link', tags: ['ops', 'fixture'], isFavorite: true, sortOrder: 0, endpoints: [] },
      { externalId: 'console', categoryExternalId: 'fixture', title: 'External fixture console', url: 'https://external-preset.invalid/console', description: 'Synthetic source; not fetched', icon: 'lucide:link', tags: ['ops', 'fixture'], isFavorite: false, sortOrder: 1, endpoints: [] },
      { externalId: 'excluded', categoryExternalId: 'fixture', title: 'External fixture excluded by saved query', url: 'https://external-preset.invalid/excluded', description: 'Synthetic source; not fetched', icon: 'lucide:link', tags: ['personal'], isFavorite: false, sortOrder: 2, endpoints: [] },
    ] },
  });
  measurements.fixtureTransform = 'Eight required public samples read and hashed; six component snapshots used. Calendar/weather dates shifted by whole UTC days to the current week in memory; values stay fictional and resource/status values stay unknown. SourceUpdatedAt denotes this synthetic test generation.';
}
async function configurePreset(id, assignments, expectedNavigation) {
  const before = await readPage(); await enterEditor(); await openPresets(id);
  for (const [key, name] of Object.entries(assignments)) await assignSlot(key, sourceByName[name]);
  if (id === 'data-summary') equal(await slot('traffic').getAttribute('data-state'), 'omitted', 'Optional GitHub traffic remains omitted without a connection');
  const navLabel = expectedNavigation === 'local-navigation' ? l('本地书签', 'Local bookmarks') : sourceByName['Fixture external bookmarks'].name;
  equal((await slot('navigation').getByRole('combobox').innerText()).trim(), navLabel, 'Preset defaults retain the original valid navigation source');
  await applyDraft(before);
  return saveDraft(before, presets[id].panels, expectedNavigation, id);
}
async function bindExistingNavigationSource() {
  step('Preserve a real existing navigation-source binding across later presets');
  const before = await readPage(), config = clone(before.config), source = sourceByName['Fixture external bookmarks'];
  config.bindings['fixture-navigation'] = { datasetId: source.datasetId, space: 'current-page-space', query: clone(navigationQuery) };
  const nav = config.views.find(view => view.panel.id === 'builtin/navigation'); check(!!nav, 'Existing saved navigation panel is available to rebind');
  nav.inputs.collection = 'fixture-navigation';
  // The fixture explicitly connects its category panel to the same collection;
  // later presets must preserve this existing configuration and custom group.
  config.views.find(view => view.panel.id === 'builtin/category-navigation').inputs.collection = 'fixture-navigation';
  const saved = await api(`/spaces/${space.id}/page`, 'PUT', { name: before.name, config, expectedRevision: before.revision });
  preservationBaseline = preservation(saved.config);
  await home();
  check(await page.getByText('External fixture runbook', { exact: true }).first().isVisible(), 'The real pushed navigation snapshot renders before preset replacement');
  equal((await readNavigation()).data, navigationBaseline, 'Explicit source binding does not rewrite authoritative bookmarks');
}
async function verifyNavigationInteraction(config, external) {
  const view = config.views.find(item => item.panel.id === 'builtin/navigation');
  const frame = page.locator(`.lh-grid-frame[data-panel-id="${view.id}"]`);
  const titles = () => frame.locator('.lh-bookmark-title').allTextContents().then(values => values.map(value => value.trim()).sort());
  const expected = external ? ['External fixture console', 'External fixture runbook'] : ['Fixture console', 'Fixture documentation', 'Fixture handbook'];
  equal(await titles(), [...expected].sort(), 'The saved tag query hides non-ops records without changing stored bookmarks');
  const requestStart = requests.length, mutationStart = browserMutations().length;
  const search = page.locator('.lh-header-search input[type="search"]');
  const wanted = external ? 'External fixture console' : 'Fixture console';
  await search.fill(wanted);
  await until(async () => JSON.stringify(await titles()) === JSON.stringify([wanted]), 'Preserved custom search scope filters the navigation panel');
  if (!external) {
    const favorites = config.views.find(item => item.panel.id === 'builtin/favorites');
    if (favorites) equal(await page.locator(`.lh-grid-frame[data-panel-id="${favorites.id}"] .lh-bookmark-title`).allTextContents().then(values => values.map(value => value.trim())), [wanted], 'Favorites remains linked to the same custom search group');
  }
  await page.getByRole('button', { name: l('清除搜索', 'Clear search'), exact: true }).click();
  await until(async () => JSON.stringify(await titles()) === JSON.stringify([...expected].sort()), 'Clearing search restores the saved query-filtered collection');
  const category = page.locator('.lh-categories');
  await category.getByRole('button', { name: external ? 'External fixture reference' : 'Fixture reference', exact: true }).click();
  await until(async () => JSON.stringify(await titles()) === JSON.stringify([external ? 'External fixture runbook' : 'Fixture handbook']), 'Preserved category scope still filters its corresponding navigation collection');
  await category.getByRole('button', { name: l('全部链接', 'All links'), exact: true }).click();
  await until(async () => JSON.stringify(await titles()) === JSON.stringify([...expected].sort()), 'All links clears the transient category filter while retaining the saved tag query');
  equal(browserMutations().length, mutationStart, 'Search and category choices do not save page/source changes');
  equal(requests.length, requestStart, 'Search and category interactions use the already loaded snapshot');
}
async function metricsWarning() {
  step('Duplicate metrics-source warning and optional unavailable traffic');
  const before = await readPage(); await enterEditor(); await openPresets('data-summary');
  await assignSlot('overview', sourceByName['Fixture overview']); await assignSlot('secondary', sourceByName['Fixture overview']);
  const warning = dialog().locator('.dashboard-preset-warning'); await warning.waitFor();
  check((await warning.innerText()).includes(l('同一整组指标', 'entire metric set')), 'Same-source metrics warning explains complete-snapshot duplication');
  check(await applyButton().isEnabled(), 'The warning permits an intentional same-source layout');
  await includeSlot('traffic', true); equal(await slot('traffic').getAttribute('data-state'), 'pending', 'No GitHub source is fabricated by selecting its optional slot');
  check(await applyButton().isDisabled(), 'Selected but unavailable GitHub source blocks Apply');
  await includeSlot('traffic', false);
  await assignSlot('secondary', sourceByName['Fixture secondary']);
  equal(await warning.count(), 0, 'Different source groups remove the duplication warning');
  const writes = browserMutations().length; await cancelDialog(); await cancelEditor(false);
  equal(browserMutations().length, writes, 'Reviewing warnings and cancelling performs no write');
  equal(await readPage(), before, 'Warning exploration preserves the saved page and revision');
}
async function awaitingFirstSnapshot() {
  step('First-snapshot waiting state for a real, explicitly created push source');
  const proofPhase = phase;
  awaitingSource = await api(`/spaces/${space.id}/sources`, 'POST', {
    name: 'Fixture awaiting metrics', kind: 'external-push', schemaId: 'metrics.summary', schemaVersion: 1,
    connection: {}, sync: { mode: 'push', staleAfterSeconds: 3600 }, enabled: true,
  }, 201);
  sourceByName[awaitingSource.name] = awaitingSource;
  equal(awaitingSource.revision, '0', 'The new metrics source has never received a snapshot');
  equal(awaitingSource.lastSuccessAt, null, 'The pending source does not invent a collection time');
  equal(awaitingSource.lastError, null, 'An absent first push is not a source fetch failure');
  equal(awaitingSource.nextSyncAt, null, 'The pending source has no poll schedule');
  const before = await readPage(), writes = browserMutations().length;
  await enterEditor(); await openPresets('data-summary');
  await assignSlot('overview', awaitingSource);
  await includeSlot('secondary', false); await includeSlot('traffic', false);
  const snapshotURL = apiURL(`/sources/${awaitingSource.id}/snapshot`), metadataURL = apiURL(`/sources/${awaitingSource.id}`);
  const [missingResponse, metadataResponse] = await Promise.all([
    page.waitForResponse(response => response.url() === snapshotURL && response.request().method() === 'GET', { timeout }),
    page.waitForResponse(response => response.url() === metadataURL && response.request().method() === 'GET', { timeout }),
    applyDraft(before),
  ]);
  equal(missingResponse.status(), 404, 'A real missing first snapshot returns the existing 404 contract');
  const missing = await missingResponse.json();
  equal(missing.code, 'not_found', 'Only the exact missing-snapshot error is eligible for the waiting state');
  equal(metadataResponse.status(), 200, 'The editor confirms the source still exists after its snapshot 404');
  const metadata = await metadataResponse.json();
  equal(metadata.id, awaitingSource.id, 'The metadata proof belongs to this explicitly created source');
  equal(metadata.datasetId, awaitingSource.datasetId, 'The metadata proof matches the selected dataset');
  equal(metadata.revision, '0', 'The live source still has no first snapshot');
  equal(metadata.lastSuccessAt, null, 'The live source has no successful snapshot timestamp');
  equal(metadata.lastError, null, 'The live source has no hidden fetch error');
  expectedHTTP.push({ phase: proofPhase, method: 'GET', url: snapshotURL, status: 404, code: missing.code, sourceId: metadata.id,
    reason: 'One verified missing first snapshot, followed by this live revision-0 source metadata.' });
  const panel = page.locator('.lh-metrics-panel');
  equal(await panel.count(), 1, 'Only the selected pending metrics card appears in the draft');
  await until(async () => (await panel.locator('.lh-data-state').innerText()).trim() === l('等待数据', 'Awaiting data'), 'The real component settles into the first-snapshot waiting state');
  equal((await panel.locator('.lh-data-empty strong').innerText()).trim(), l('还没有指标快照', 'No metrics snapshot yet'), 'The empty card explains the missing first snapshot');
  check(await panel.getAttribute('aria-busy') !== 'true', 'A missing first push does not leave an indefinite loading state');
  equal(await panel.locator('.lh-metric').count(), 0, 'The pending source displays no invented metric values');
  equal(responses.filter(response => response.phase === proofPhase && response.url === snapshotURL && response.method === 'GET').length, 1, 'The draft reads the missing snapshot only once');
  equal(responses.filter(response => response.phase === proofPhase && response.url === metadataURL && response.method === 'GET').length, 1, 'The draft makes exactly one metadata check after the missing snapshot');
  measurements.awaitingFirstSnapshot = { sourceId: metadata.id, datasetId: metadata.datasetId, revision: metadata.revision,
    snapshot: { status: missingResponse.status(), code: missing.code }, metadata: { status: metadataResponse.status(), lastSuccessAt: metadata.lastSuccessAt, lastError: metadata.lastError },
    uiState: await panel.locator('.lh-data-state').innerText(), emptyMessage: await panel.locator('.lh-data-empty strong').innerText() };
  await capture('first-snapshot-waiting');
  await cancelEditor(true);
  equal(browserMutations().length, writes, 'Applying and discarding the pending-source layout makes no browser write');
  equal(await readPage(), before, 'Cancelling the waiting-source draft preserves the saved page and revision');
}
async function inspectSourcePreservation() {
  const sources = await api(`/spaces/${space.id}/sources`);
  equal(sources.length, Object.keys(sourceByName).length, 'Presets never silently create or delete sources');
  for (const source of sources) {
    equal(source.kind, 'external-push', 'All fixture sources remain push-only'); equal(source.sync.mode, 'push', 'No source is converted to polling');
    equal(source.nextSyncAt, null, 'No source has a pending poll schedule'); equal(source.configRevision, '1', 'Preset choices did not edit source configuration');
    if (source.id === awaitingSource?.id) {
      equal(source.revision, '0', 'The waiting-source exercise publishes no snapshot');
      equal(source.lastSuccessAt, null, 'No snapshot collection time was invented');
      equal(source.lastError, null, 'A missing first snapshot stays distinct from a failed fetch');
      continue;
    }
    const actual = await api(`/sources/${source.id}/snapshot`);
    equal({ revision: actual.revision, data: actual.data }, sourceSnapshots[source.id], 'Preset changes preserve each accepted source snapshot');
  }
  equal((await readNavigation()).data, navigationBaseline, 'Final authoritative bookmarks/categories match the fixture baseline');
}
async function installMonitoring() {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== base.origin) {
      unexpectedNetwork.push({ phase, method: route.request().method(), url: url.href }); await route.abort();
    } else await route.continue();
  });
  context.on('request', request => requests.push({ phase, method: request.method(), url: request.url(), type: request.resourceType() }));
  context.on('response', response => responses.push({ phase, method: response.request().method(), url: response.url(), status: response.status() }));
  context.on('requestfailed', request => failedRequests.push({ phase, method: request.method(), url: request.url(), type: request.resourceType(), error: request.failure()?.errorText || '' }));
  context.on('page', target => {
    target.on('pageerror', error => pageErrors.push({ phase, message: error.message }));
    target.on('console', message => { if (message.type() === 'error') consoleErrors.push({ phase, text: message.text(), url: message.location().url || '' }); });
    target.on('websocket', socket => { socketCount++; unexpectedNetwork.push({ phase, type: 'websocket', url: socket.url() }); });
    target.on('dialog', async nativeDialog => { pageErrors.push({ phase, message: 'Unexpected native dialog: ' + nativeDialog.type() }); await nativeDialog.dismiss(); });
  });
}
async function idleAndAudit() {
  step('Saved dashboard idle budget and complete browser network/error audit');
  await page.waitForLoadState('networkidle');
  const idleMS = Number(process.env.IDLE_MS || '65000');
  check(Number.isInteger(idleMS) && idleMS >= 1000 && idleMS <= 70000, 'Idle sample is explicit and bounded');
  const start = requests.length, socketStart = socketCount;
  for (let elapsed = 0; elapsed < idleMS;) {
    const duration = Math.min(15000, idleMS - elapsed); await page.waitForTimeout(duration); elapsed += duration;
    process.stdout.write(JSON.stringify({ phase, checks, idleElapsedMS: elapsed }) + '\n');
  }
  measurements.idle = { durationMS: idleMS, requests: requests.slice(start), webSockets: socketCount - socketStart };
  equal(measurements.idle.requests, [], 'Saved dashboard does not poll or fetch during its idle window');
  equal(socketCount, 0, 'Dashboard presets add no WebSocket');
  equal(unexpectedNetwork, [], 'Browser contacts only the fresh Home origin');
  equal(pageErrors, [], 'No runtime errors or unexpected native dialogs');
  // Keep every original console error. Only one verified response for the
  // exact pending-source ID and phase may explain a browser resource error.
  const unexpectedConsoleErrors = [];
  for (const entry of consoleErrors) {
    const proof = expectedHTTP.find(response => response.phase === entry.phase && response.url === entry.url
      && response.status === 404 && response.code === 'not_found'
      && /^Failed to load resource: the server responded with a status of 404\b/.test(entry.text));
    if (proof) expectedConsoleErrors.push({ ...entry, reason: proof.reason, sourceId: proof.sourceId });
    else unexpectedConsoleErrors.push(entry);
  }
  check(expectedConsoleErrors.length <= 1, 'At most the one proven missing-first-snapshot resource error is classified');
  equal(unexpectedConsoleErrors, [], 'All other console errors fail acceptance without broad filtering');
  equal(failedRequests, [], 'No browser request fails during the accepted flows');
  equal(expectedHTTP.length, 1, 'The suite explicitly proves exactly one first-snapshot 404');
  for (const proof of expectedHTTP) equal(responses.filter(response => response.phase === proof.phase && response.method === proof.method
    && response.url === proof.url && response.status === proof.status).length, 1, 'The expected HTTP error is observed once and does not repeat');
  equal(responses.filter(response => response.status >= 400 && !expectedHTTP.some(proof => proof.phase === response.phase
    && proof.method === response.method && proof.url === response.url && proof.status === response.status)), [], 'No HTTP error other than the specifically proven missing first snapshot is accepted');
}
async function run() {
  validateStartup();
  if (process.argv.includes('--guard-only')) { step('startup guard passed without Playwright or HTTP'); return; }
  loadExamples();
  const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--disable-dev-shm-usage', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])] });
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1, reducedMotion: 'reduce', locale: process.env.LINGSHU_EXPECT_LANGUAGE === 'en' ? 'en-US' : 'zh-CN', serviceWorkers: 'block' });
  context.setDefaultTimeout(timeout); context.setDefaultNavigationTimeout(timeout);
  await refreshBoot(); equal(boot.initialized, false, 'An initialized instance is refused before its first mutation');
  check(['zh-CN', 'en'].includes(boot.language), 'Fresh instance has a supported UI language');
  if (process.env.LINGSHU_EXPECT_LANGUAGE) equal(boot.language, process.env.LINGSHU_EXPECT_LANGUAGE, 'Fixture language matches this acceptance run');
  await api('/setup', 'POST', { siteName: 'Dashboard acceptance ' + runId, mode: 'open_edit', seedDemo: false, username: 'preset-owner', displayName: 'Preset fixture owner', password: 'Fixture-' + randomUUID() }, 201);
  initializedByRun = true; acceptanceExecuted = true;
  await refreshBoot(); space = boot.spaces.find(item => item.kind === 'shared');
  check(space?.published && space.canEdit && boot.user?.role === 'Owner', 'Fixture has an authenticated Owner and a writable shared space');
  equal((await readNavigation()).data.links.length, 0, 'Fresh fixture has no pre-existing bookmarks');
  equal((await api(`/spaces/${space.id}/sources`)).length, 0, 'Fresh fixture has no external sources');
  equal((await api('/network-proxy')).mode, 'direct', 'Fresh fixture has no outbound proxy configuration');
  await installMonitoring(); page = await context.newPage();
  await seedLocalPage(); await missingSourceAndCancellation(); await seedPushSources(); await home();

  step('Personal overview: local navigation, real save/reload and four desktop geometries');
  const personal = await configurePreset('personal-overview', { weather: 'Fixture weather', calendar: 'Fixture calendar' }, 'local-navigation');
  await verifyNavigationInteraction(personal.config, false);
  await measurePreset('personal-overview', personal.config);
  await bindExistingNavigationSource();

  step('Service operations: original external navigation and four desktop geometries');
  const external = sourceByName['Fixture external bookmarks'].datasetId;
  const service = await configurePreset('service-operations', { services: 'Fixture services', resources: 'Fixture resources' }, external);
  await verifyNavigationInteraction(service.config, true);
  await measurePreset('service-operations', service.config);
  await metricsWarning();

  step('Data summary: separate metric sources, optional slot omitted and four desktop geometries');
  const statistics = await configurePreset('data-summary', { overview: 'Fixture overview', secondary: 'Fixture secondary' }, external);
  const primary = slotView(statistics.config, 'overview'), secondary = slotView(statistics.config, 'secondary');
  check(primary.inputs.metrics !== secondary.inputs.metrics, 'Distinct metric sources have distinct valid aliases');
  equal(statistics.config.layout.placements[slotView(statistics.config, 'navigation').id].base.y, 6, 'Omitted optional traffic leaves no empty twelve-row hole');
  await verifyNavigationInteraction(statistics.config, true);
  await measurePreset('data-summary', statistics.config);
  await awaitingFirstSnapshot();
  await inspectSourcePreservation(); await idleAndAudit();
  equal(screenshots.filter(filename => Object.keys(presets).some(id => path.basename(filename).includes(id + '-'))).length, 12, 'Each of three saved layouts has four required desktop screenshots');
}
let failure;
run().catch(error => { failure = error; errors.push({ phase, message: error.message }); }).finally(async () => {
  if (failure && page && !page.isClosed()) await capture('failure').catch(error => errors.push({ phase: 'failure screenshot', message: error.message }));
  try { await browser?.close(); }
  catch (error) { failure ||= error; errors.push({ phase: 'browser cleanup', message: error.message }); }
  const report = { status: failure ? 'failed' : acceptanceExecuted ? 'passed' : 'guard-passed', acceptanceExecuted, initializedByRun, runId, phase, language: boot?.language, origin: base?.origin,
    checks, measurements, fixtureHashes, screenshots, errors, pageErrors, consoleErrors, expectedConsoleErrors, expectedHTTP, failedRequests, unexpectedNetwork, apiRequests,
    browserRequests: requests, browserResponses: responses, webSockets: socketCount, completedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: report.status, acceptanceExecuted, checks, language: report.language, phase, errors }) + '\n');
  if (failure) process.exitCode = 1;
});
