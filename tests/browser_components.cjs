#!/usr/bin/env node
'use strict';
/** Real browser/API acceptance; requires a new disposable, uninitialized instance.
 * BASE_URL=http://127.0.0.1:5184 node tests/browser_components.cjs --disposable-instance
 * Never targets the main/demo ports and never resets an existing database.
 * Optional LINGSHU_PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE, REPORT_PATH, SCREENSHOT_DIR.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const timeout = 15000, runId = randomUUID().slice(0, 12);
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:5184');
const reportPath = process.env.REPORT_PATH || path.join(os.tmpdir(), `home-components-${runId}.json`);
let browser, context, page, boot, spaceId, csrf, checks = 0, phase = 'preflight';
const errors = [], requests = [], screenshots = [], measurements = {}, expectedConsoleErrors = [];
let socketCount = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const l = (zh, en) => boot.language === 'en' ? en : zh;
const step = label => { phase = label; process.stdout.write(JSON.stringify({ step: label, checks }) + '\n'); };
const apiURL = relative => base.origin + '/api/v1' + relative;
async function api(relative, method = 'GET', body, status = 200) {
  const response = await context.request.fetch(apiURL(relative), { method, data: body, headers: { 'X-CSRF-TOKEN': csrf || '' }, timeout, maxRedirects: 0 });
  const value = response.status() === 204 ? null : await response.json();
  equal(response.status(), status, `${method} ${relative}: expected status; ${value?.code || ''}`);
  return value;
}
const readPage = () => api(`/spaces/${spaceId}/page`);
async function putPage(config) { const current = await readPage(); return api(`/spaces/${spaceId}/page`, 'PUT', { name: current.name, config, expectedRevision: current.revision }); }
async function chooseSharedSpace(admin = false) {
  if (!spaceId || boot.spaces.length < 2) return;
  const shared = boot.spaces.find(space => space.id === spaceId);
  check(shared?.kind === 'shared', 'Fixture space is an accessible shared space');
  const picker = page.getByRole('combobox', { name: admin ? l('当前空间', 'Current space') : l('选择空间', 'Choose a space'), exact: true });
  await picker.waitFor({ timeout });
  if ((await picker.innerText()).trim() === shared.name.trim()) return;
  const [response] = await Promise.all([
    page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.origin === base.origin && url.pathname === '/api/v1/dashboard' && url.searchParams.get('spaceId') === spaceId;
    }, { timeout }),
    select(picker, shared.name)
  ]);
  equal(response.status(), 200, 'Selecting the shared space loads its dashboard');
  equal((await response.json()).space.id, spaceId, 'The selected dashboard belongs to the fixture space');
  await page.waitForLoadState('networkidle');
  await picker.waitFor({ timeout });
  equal((await picker.innerText()).trim(), shared.name.trim(), 'The space picker reflects the loaded shared space');
}
async function home() {
  await page.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded', timeout });
  // Navigating to the same URL/hash may stay in the existing document. A real
  // reload is required after fixture API writes and for cold resource checks.
  await page.reload({ waitUntil: 'networkidle', timeout });
  await page.locator('.lh-home').waitFor({ timeout });
  equal(await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.type), 'reload', 'Home starts from a real document reload');
  // A cold navigation follows the account default. Select the fixture space
  // through the real UI instead of changing the product's default-space rules.
  await chooseSharedSpace();
  await page.locator('.lh-home').waitFor({ timeout });
}
async function select(locator, label) { await locator.click(); await page.getByRole('option', { name: label, exact: true }).click(); }
async function capture(label, force = false) {
  const directory = process.env.SCREENSHOT_DIR || (force ? path.join(path.dirname(reportPath), 'screenshots') : null);
  if (!directory || !page || page.isClosed()) return;
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `components-${boot?.language || 'unknown'}-${label}.png`);
  await page.screenshot({ path: target, fullPage: false, timeout }); screenshots.push(target);
}
async function geometry(label) {
  const value = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.lh-data-panel')].map(node => { const r = node.getBoundingClientRect(); return { type: node.className, x: r.x, y: r.y, width: r.width, height: r.height, overflow: node.scrollWidth > node.clientWidth + 1 }; });
    return { width: innerWidth, client: document.documentElement.clientWidth, scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), cards };
  });
  // Preserve the measured bounds even when the first assertion fails.
  measurements[label] = value;
  check(value.scroll <= value.client + 1, `${label}: no horizontal document overflow`);
  equal(value.cards.length, 4, `${label}: four data cards render`);
  for (const card of value.cards) { check(card.width > 150 && card.height > 60, `${label}: usable card bounds`); check(!card.overflow, `${label}: card content stays within its width`); }
}
async function enterEditor() { await page.locator('.lh-edit-menu summary').click(); await page.getByRole('button', { name: l('调整布局', 'Adjust layout'), exact: true }).click(); await page.locator('.lh-composer').waitFor({ timeout }); }
async function library() { await page.locator('.lh-composer-library-toggle').click(); await page.locator('.lh-composer-library-items').first().waitFor({ timeout }); }
async function importTemplate() {
  await library(); await page.getByRole('button', { name: l('导入组件模板', 'Import template'), exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: l('JSON 模板', 'JSON template'), exact: true }).click();
  const manifest = { format: 'lingshu-home-component', manifestVersion: 1, id: 'acceptance/metrics', version: '1.0.0', name: 'Imported fixture metrics', license: 'MIT', renderer: 'builtin/metrics', dataSchema: { id: 'metrics.summary', version: 1 }, settings: { showBars: false }, layout: { width: 12, height: 6 } };
  await dialog.getByLabel(l('模板 JSON', 'Template JSON'), { exact: true }).fill(JSON.stringify(manifest));
  await dialog.getByRole('button', { name: l('检查模板', 'Review template'), exact: true }).click();
  await dialog.locator('.widget-import-review').waitFor({ timeout });
  const sourceSelect = dialog.getByRole('combobox');
  if (!(await dialog.getByRole('button', { name: l('加入页面草稿', 'Add to page draft'), exact: true }).isEnabled())) await select(sourceSelect, 'Fixture metrics');
  await dialog.getByRole('button', { name: l('加入页面草稿', 'Add to page draft'), exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout });
}
async function main() {
  check(process.argv.includes('--disposable-instance'), 'Disposable-instance flag is required');
  check(['127.0.0.1', 'localhost', '10.233.233.61'].includes(base.hostname) && Number(base.port) >= 5184 && Number(base.port) <= 5197, 'Target is an explicit isolated test port');
  const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--disable-dev-shm-usage', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])] });
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, reducedMotion: 'reduce' }); page = await context.newPage(); page.setDefaultTimeout(timeout);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
  page.on('websocket', () => socketCount++);
  boot = await api('/bootstrap'); check(!boot.initialized, 'Instance is fresh; an initialized instance is never modified'); csrf = boot.csrfToken;
  step('Localized setup pack preview and real setup');
  await page.goto(base.origin, { waitUntil: 'networkidle', timeout });
  await page.locator('.auth-card [role="checkbox"]').click(); await page.locator('.auth-starter-pack summary').click();
  await page.waitForFunction(() => document.querySelectorAll('.auth-starter-pack li').length === 12, null, { timeout });
  const packs = await api('/starter-packs'); equal(packs.map(pack => pack.id).sort(), ['en', 'zh-CN'], 'Both locale packs are listed');
  for (const pack of packs) equal(pack.groups.flatMap(group => group.links).length, 12, 'Each pack has 12 links');
  check(JSON.stringify(packs[0].groups) !== JSON.stringify(packs[1].groups), 'The content packs differ');
  await capture('setup-pack');
  await page.getByLabel(l('站点名称', 'Site name'), { exact: true }).fill('Home component acceptance ' + runId);
  await page.getByLabel(l('用户名', 'Username'), { exact: true }).fill('component-owner');
  await page.getByLabel(l('密码', 'Password'), { exact: true }).fill(randomUUID() + '-test');
  await page.getByRole('button', { name: l('创建我的 Home', 'Create my Home'), exact: true }).click(); await page.locator('.lh-home').waitFor({ timeout });
  boot = await api('/bootstrap'); csrf = boot.csrfToken; spaceId = boot.spaces.find(space => space.kind === 'shared')?.id;
  check(!!spaceId, 'Setup exposes its shared starter space');
  await page.waitForFunction(() => document.querySelectorAll('.lh-bookmark').length >= 12, null, { timeout });
  check(true, 'Seeded initialization lands on the shared bookmarks');
  const nav = await api(`/spaces/${spaceId}/navigation`); equal(nav.data.links.length, 12, 'Setup persisted exactly the chosen 12 bookmarks');
  const expectedPack = packs.find(pack => pack.id === boot.language);
  equal(nav.data.links.map(link => link.url).sort(), expectedPack.groups.flatMap(group => group.links.map(link => link.url)).sort(), 'Instance default pack uses the correct locale URLs');
  await home();
  const cold = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => ({ name: entry.name, bytes: entry.transferSize })));
  check(!cold.some(entry => /DataPanels-|TrafficPanel-|WidgetImportDialog-/.test(entry.name)), 'Navigation-only home does not load optional component/import bundles');
  check(!(await page.getByRole('button', { name: l('读取最新组件快照', 'Read latest component snapshots'), exact: true }).count()), 'Navigation-only home has no component refresh action');
  measurements.navigationResources = cold;

  step('Authenticated component snapshots and actual persisted page bindings');
  const now = Math.floor(Date.now() / 1000), day = new Date().toISOString().slice(0, 10), nextDay = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const start = Math.floor(Date.parse(day + 'T09:00:00Z') / 1000);
  const examples = [
    ['calendar.events', 'calendar', 'events', { timezone: 'UTC', windowStart: now - 86400, windowEnd: now + 30 * 86400, events: [{ id: 'planning', title: 'Fixture planning', startAt: start, endAt: start + 3600, allDay: false, location: 'Studio' }, { id: 'all-day', title: 'Fixture all-day event', startAt: Math.floor(Date.parse(day) / 1000), endAt: Math.floor(Date.parse(nextDay) / 1000), allDay: true, startDate: day, endDate: nextDay }] }],
    ['weather.forecast', 'weather', 'weather', { timezone: 'UTC', latitude: 31.23, longitude: 121.47, locationName: 'Shanghai fixture', current: { time: now, temperature: 22, apparentTemperature: 21, weatherCode: 2, humidity: 62, windSpeed: 8, isDay: true }, daily: Array.from({ length: 5 }, (_, i) => ({ date: new Date((now + i * 86400) * 1000).toISOString().slice(0, 10), weatherCode: i % 2 ? 61 : 2, temperatureMax: 24 + i, temperatureMin: 18 + i, precipitationProbability: 20 })) }],
    ['metrics.summary', 'metrics', 'metrics', { metrics: [{ id: 'cpu', label: 'CPU', value: 21.5, unit: '%', min: 0, max: 100, status: 'ok' }, { id: 'unknown', label: 'Unknown fixture', value: null }, { id: 'zero', label: 'Zero fixture', value: 0 }] }],
    ['status.collection', 'status', 'status', { items: [{ id: 'api', label: 'Fixture API', status: 'up', latencyMs: 24 }, { id: 'queue', label: 'Fixture queue', status: 'degraded', message: 'Maintenance' }] }]
  ];
  const sources = {};
  for (const [schema, kind, , data] of examples) {
    const source = await api(`/spaces/${spaceId}/sources`, 'POST', { name: 'Fixture ' + kind, kind: 'external-push', schemaId: schema, schemaVersion: 1, connection: {}, sync: { mode: 'push', staleAfterSeconds: 3600 }, enabled: true }, 201);
    sources[kind] = source;
    const push = { requestId: 'fixture-' + runId, expectedRevision: '0', schemaId: schema, schemaVersion: 1, data };
    const receipt = await api(`/sources/${source.id}/snapshot`, 'PUT', push); equal(receipt.revision, '1', 'First component snapshot revision');
    equal(await api(`/sources/${source.id}/snapshot`, 'PUT', push), receipt, 'Exact retry returns the same receipt');
  }
  const initialPage = await readPage(), config = structuredClone(initialPage.config);
  const keep = config.views.filter(view => ['builtin/search', 'builtin/category-navigation', 'builtin/navigation'].includes(view.panel.id));
  config.views = keep; for (const key of Object.keys(config.layout.placements)) if (!keep.some(view => view.id === key)) delete config.layout.placements[key];
  for (const view of keep) if (view.panel.id === 'builtin/navigation') config.layout.placements[view.id] = { base: { kind: 'grid', region: 'main', x: 0, y: 26, w: 24, h: 3, heightMode: 'content', locked: false } };
  for (let i = 0; i < examples.length; i++) {
    const [, kind, input] = examples[i], id = 'fixture-' + kind;
    config.bindings[kind] = { datasetId: sources[kind].datasetId, space: 'current-page-space', query: {} };
    config.views.push({ id, panel: { id: 'builtin/' + kind }, inputs: { [input]: kind }, settings: kind === 'calendar' ? { viewMode: 'week' } : kind === 'weather' ? { forecastDays: 5 } : {} });
    config.layout.placements[id] = { base: { kind: 'grid', region: 'main', x: i % 2 * 12, y: i < 2 ? 0 : 20, w: 12, h: i < 2 ? 20 : 6, heightMode: 'content', locked: false } };
  }
  await putPage(config); await home(); await page.locator('.lh-data-panel').first().waitFor({ timeout });
  await page.getByText('Fixture planning', { exact: true }).waitFor({ timeout });
  check((await page.locator('.lh-metrics-panel').innerText()).includes('Unknown fixture'), 'Unknown metric is rendered');
  check(!(await page.locator('.lh-weather-panel').innerText()).includes('Open-Meteo'), 'Pushed weather is not falsely attributed to a provider');
  const beforeRefresh = requests.length;
  await page.getByRole('button', { name: l('读取最新组件快照', 'Read latest component snapshots'), exact: true }).click();
  await page.waitForLoadState('networkidle');
  const refreshRequests = requests.slice(beforeRefresh).filter(item => item.url.includes('/api/'));
  equal(refreshRequests.filter(item => item.method === 'GET' && item.url.includes('/dashboard?')).length, 1, 'One shared dashboard refresh');
  check(!refreshRequests.some(item => item.url.endsWith('/sync')), 'Homepage refresh does not synchronize upstream sources');
  const calendarWrites = requests.filter(item => item.method !== 'GET').length;
  await page.locator('.lh-calendar-panel').getByRole('button', { name: l('日', 'Day'), exact: true }).click();
  await page.locator('.lh-calendar-panel').getByRole('button', { name: l('周', 'Week'), exact: true }).click();
  equal(requests.filter(item => item.method !== 'GET').length, calendarWrites, 'Calendar day/week browsing is temporary');

  step('Both themes and all four desktop resolutions');
  for (const theme of ['builtin/dashboard', 'builtin/ios']) {
    const next = structuredClone((await readPage()).config); next.pageTheme = { id: theme }; await putPage(next); await home();
    for (const [width, height] of [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080]]) {
      await page.setViewportSize({ width, height }); await page.waitForFunction(() => document.querySelectorAll('.lh-data-panel').length === 4, null, { timeout });
      // Let ResizeObserver and the following React/grid paint apply the new
      // container width before measuring. The overflow assertions stay strict.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await geometry(`${theme}-${width}x${height}`); if (width === 2560 && height === 1440) await capture(theme.split('/')[1] + '-2560x1440');
    }
  }
  await page.setViewportSize({ width: 2560, height: 1440 });
  step('Template preview stays in draft; cancel/restore and explicit save');
  await enterEditor(); await library(); equal(await page.locator('.lh-composer-library-items').first().locator('button').count(), 9, 'Component library exposes nine renderers');
  const beforeImport = await readPage(); await importTemplate(); equal(await readPage(), beforeImport, 'Applying a template has not saved the page');
  await page.locator('.lh-composer-toolbar-actions').getByRole('button', { name: l('取消', 'Cancel'), exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: l('继续编辑', 'Keep editing'), exact: true }).click();
  check(await page.locator('.lh-composer').isVisible(), 'Keep editing preserves the draft');
  await page.locator('.lh-composer-restore').click(); await page.getByRole('dialog').getByRole('button', { name: l('放弃修改', 'Discard changes'), exact: true }).click();
  equal(await readPage(), beforeImport, 'Restore leaves persisted content/revision unchanged');
  await importTemplate(); await page.getByRole('button', { name: l('保存页面', 'Save page'), exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.lh-composer'), null, { timeout }); await home();
  const saved = await readPage(), imported = saved.config.views.find(view => view.template?.id === 'acceptance/metrics');
  check(imported && /^[a-f0-9]{64}$/.test(imported.template.sha256), 'Saved component retains a content hash and identity');
  equal(imported.template.version, '1.0.0', 'Template version persisted'); equal(imported.settings.showBars, false, 'Imported setting persisted');
  equal(saved.config.bindings[imported.inputs.metrics].datasetId, sources.metrics.datasetId, 'Imported view uses a local authorized data source');

  step('Route guard preserves an unsaved homepage draft');
  await enterEditor(); await library(); await page.locator('.lh-composer-library-items').first().getByRole('button', { name: l('日程', 'Calendar'), exact: true }).click();
  await page.evaluate(() => { window.location.hash = '/admin'; });
  await page.getByRole('dialog').getByRole('button', { name: l('继续编辑', 'Keep editing'), exact: true }).click();
  check(await page.locator('.lh-composer').isVisible(), 'Hash navigation is blocked until discard');
  await page.locator('.lh-composer-toolbar-actions').getByRole('button', { name: l('取消', 'Cancel'), exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: l('放弃修改', 'Discard changes'), exact: true }).click();
  await page.locator('.lh-home').waitFor({ timeout }); equal((await readPage()).config, saved.config, 'Discard did not write a changed configuration');

  step('Actual ICS file import and disabled-source retained snapshot');
  await page.goto(base.origin + '/#/admin?tab=integrations', { waitUntil: 'networkidle', timeout });
  await chooseSharedSpace(true);
  const row = page.getByRole('row').filter({ hasText: 'Fixture calendar' }); await row.getByRole('button', { name: l('导入 ICS', 'Import ICS'), exact: true }).click();
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Home Acceptance//EN', 'BEGIN:VEVENT', 'UID:acceptance-file', 'DTSTAMP:' + day.replaceAll('-', '') + 'T000000Z', 'DTSTART:' + day.replaceAll('-', '') + 'T090000Z', 'DTEND:' + day.replaceAll('-', '') + 'T100000Z', 'SUMMARY:Imported ICS fixture', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'fixture.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
  await page.getByRole('dialog').getByLabel(l('默认时区', 'Default time zone'), { exact: true }).fill('UTC');
  await page.getByRole('dialog').getByRole('button', { name: l('导入并替换快照', 'Import and replace snapshot'), exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden', timeout });
  const calendar = await api(`/sources/${sources.calendar.id}/snapshot`); equal(calendar.data.events.length, 1, 'ICS file replaces the finite-window snapshot'); equal(calendar.data.events[0].title, 'Imported ICS fixture', 'ICS event content persisted');
  const source = await api(`/sources/${sources.calendar.id}`);
  await api(`/sources/${source.id}`, 'PUT', { name: source.name, connection: source.connection, sync: source.sync, expectedConfigRevision: source.configRevision, enabled: false });
  const retained = await api(`/sources/${source.id}/snapshot`); equal(retained.data, calendar.data, 'Disable keeps the last successful calendar'); equal(retained.meta.freshness, 'disabled', 'Disabled state is explicit');
  await home(); check((await page.locator('.lh-calendar-panel').innerText()).includes(l('已停用', 'Disabled')), 'Disabled source status reaches the component');
  equal((await api(`/spaces/${spaceId}/navigation`)).data, nav.data, 'All component operations preserve local navigation');
  equal(socketCount, 0, 'No WebSocket is opened'); equal(errors, expectedConsoleErrors, 'No browser runtime or unexpected console errors');
  step('completed');
}
main().then(() => { process.exitCode = 0; }).catch(async error => {
  process.exitCode = 1; errors.push(`${phase}: ${error.stack || error}`); process.stderr.write(`${phase}: ${error.message}\n`);
  try { await capture(`failure-${runId}-${phase.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)}`, true); }
  catch (captureError) { errors.push(`Failure screenshot: ${captureError.message}`); }
}).finally(async () => {
  const report = { runId, base: base.origin, language: boot?.language, phase, checks, passed: process.exitCode === 0, errors, socketCount, screenshots, measurements, pageRequestCount: requests.length, scope: 'Fresh disposable instance; synthetic source data; no main/demo writes; no live calendar account or real weather-provider authorization test' };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  await browser?.close(); process.stdout.write(JSON.stringify({ passed: report.passed, checks, reportPath }) + '\n');
});
