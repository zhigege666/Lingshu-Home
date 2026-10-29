#!/usr/bin/env node
'use strict';

/** Real UI spacing and source-format examples on one disposable zh-CN origin.
 * Exactly two UI writes are authorized: ownerless open_edit setup, then first
 * Owner creation in Access and accounts. No source, token, proxy or account API
 * is written directly. No source is saved and no collector is started.
 * Random credentials exist only in this process; screenshots mask passwords.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const password = 'Spacing-' + randomUUID() + '-9!';
const protectedPorts = new Set(['5180', '5182', '5183', '5184', '5185', '5194', '5195']);
const viewports = [{ width: 2560, height: 1440 }, { width: 1920, height: 1080 }, { width: 1600, height: 900 }, { width: 2560, height: 1080 }];
const schemas = [
  { id: 'navigation.collection', label: '导航书签', keys: ['categories', 'links'] },
  { id: 'calendar.events', label: '日程', keys: ['events', 'timezone', 'windowEnd', 'windowStart'] },
  { id: 'weather.forecast', label: '天气', keys: ['current', 'daily', 'latitude', 'locationName', 'longitude', 'timezone'] },
  { id: 'metrics.summary', label: '统计指标', keys: ['metrics'] },
  { id: 'status.collection', label: '服务状态', keys: ['items'] }
];
const report = { runId, startedAt: new Date().toISOString(), status: 'running', assertions: [], requests: [], observations: [], measurements: [], examples: [], screenshots: [], console: [], pageErrors: [], forbidden: [], sockets: [], harnessErrors: [], scope: 'Real setup and first Owner creation through UI only. Source forms and examples are inspected without saving. Anonymous contexts inspect actual permission notices. Calendar source notices are checked; calendar import requires a persisted source and is intentionally outside this no-source-write run.' };
let options, browser, currentPhase = 'preflight', ready = false;
const sides = [];
const usedWrites = new Map();

function clean(value) { return String(value ?? '').split(password).join('[REDACTED]').replace(/https?:\/\/[^\s"'<>]+/g, raw => { try { const u = new URL(raw); return u.origin + u.pathname; } catch { return '[URL]'; } }).slice(0, 12000); }
function pathname(raw) { try { return new URL(raw).pathname; } catch { return null; } }
function equal(actual, expected, label) { assert.deepEqual(actual, expected, label); report.assertions.push({ phase: currentPhase, label }); }
function check(value, label) { assert.ok(value, label); report.assertions.push({ phase: currentPhase, label }); }
function phase(name) { currentPhase = name; process.stdout.write(JSON.stringify({ phase: name, checks: report.assertions.length }) + '\n'); }
function parseOptions() {
  const parsed = { allowWrite: false, expectedVersion: '0.0.1', outputDir: path.join(os.tmpdir(), 'home-spacing-sources-' + runId) };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (['--help', '-h'].includes(args[i])) { process.stdout.write('Usage: node tests/browser_spacing_sources.cjs --url http://127.0.0.1:<fresh-port> --output-dir <new-directory> --allow-write [--expected-version 0.0.1]\nRequires a fresh zh-CN instance with explicit startup language. Creates ownerless open_edit then a temporary Owner through UI; never saves sources.\nEnvironment: LINGSHU_PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE\n'); return null; }
    if (args[i] === '--allow-write') { parsed.allowWrite = true; continue; }
    const key = { '--url': 'url', '--output-dir': 'outputDir', '--expected-version': 'expectedVersion' }[args[i]];
    assert.ok(key && args[i + 1] && !args[i + 1].startsWith('--'), 'Unknown or incomplete option'); parsed[key] = args[++i];
  }
  assert.ok(parsed.allowWrite && parsed.url, 'An explicit disposable --url and --allow-write are required');
  assert.match(parsed.expectedVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const url = new URL(parsed.url), host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Use a plain application origin');
  assert.ok(host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host), 'Only loopback instances are allowed');
  assert.ok(url.port && !protectedPorts.has(url.port), 'A fresh explicit port outside protected instances is required');
  parsed.url = url.origin; parsed.outputDir = path.resolve(parsed.outputDir);
  fs.mkdirSync(parsed.outputDir, { recursive: true, mode: 0o700 });
  assert.ok(!fs.existsSync(path.join(parsed.outputDir, 'spacing-sources-report.json')), 'Refusing to overwrite an existing report');
  return parsed;
}
async function newSide(label) {
  const context = await browser.newContext({ viewport: viewports[0], deviceScaleFactor: 1, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
  context.setDefaultTimeout(20000); context.setDefaultNavigationTimeout(30000);
  const side = { label, context, page: null, permit: null, map: new WeakMap(), closing: false }; sides.push(side);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) { await route.continue(); return; }
    if (url.origin !== options.url) { report.forbidden.push({ context: label, phase: currentPhase, method: request.method(), path: url.pathname, reason: 'Foreign origin' }); await route.abort('blockedbyclient'); return; }
    if (['GET', 'HEAD'].includes(request.method())) { await route.continue(); return; }
    const key = request.method() + ' ' + url.pathname, permit = side.permit;
    if (!ready || label !== 'owner' || !permit || permit.key !== key || permit.remaining !== 1 || !['POST /api/v1/setup', 'PUT /api/v1/settings'].includes(key) || usedWrites.has(key)) {
      report.forbidden.push({ context: label, phase: currentPhase, method: request.method(), path: url.pathname, reason: 'Write not explicitly permitted for this UI action' }); await route.abort('blockedbyclient'); return;
    }
    permit.remaining--; usedWrites.set(key, 1);
    const item = side.map.get(request); if (item) { item.permitted = true; item.hasCSRF = !!request.headers()['x-csrf-token']; }
    await route.continue();
  });
  assert.equal(typeof context.routeWebSocket, 'function', 'Playwright routeWebSocket is required');
  await context.routeWebSocket('**/*', async socket => { report.sockets.push({ context: label, phase: currentPhase, path: pathname(socket.url()) }); await socket.close(); });
  context.on('page', page => {
    if (side.page && side.page !== page) report.harnessErrors.push({ context: label, error: 'Unexpected extra page' });
    if (!side.page) side.page = page;
    page.on('request', request => { if (!side.closing) { const item = { context: label, phase: currentPhase, method: request.method(), path: pathname(request.url()) }; side.map.set(request, item); report.requests.push(item); } });
    page.on('response', response => { const item = side.map.get(response.request()); if (item && !side.closing) item.status = response.status(); });
    page.on('requestfailed', request => { const item = side.map.get(request); if (item && !side.closing) item.failure = clean(request.failure()?.errorText); });
    page.on('console', message => { if (!side.closing) report.console.push({ context: label, phase: currentPhase, type: message.type(), text: clean(message.text()), path: pathname(message.location().url) }); });
    page.on('pageerror', error => { if (!side.closing) report.pageErrors.push({ context: label, phase: currentPhase, error: clean(error.message) }); });
    page.on('dialog', async dialog => { report.harnessErrors.push({ context: label, error: 'Unexpected native dialog: ' + dialog.type() }); await dialog.dismiss(); });
    page.on('websocket', socket => { if (!side.closing) report.sockets.push({ context: label, path: pathname(socket.url()), kind: 'browser-event' }); });
  });
  return side;
}
async function get(side, relative) {
  assert.ok(relative.startsWith('/') && !relative.startsWith('//') && !relative.includes('#'));
  const response = await side.context.request.get(options.url + '/api/v1' + relative, { timeout: 20000, maxRedirects: 0, failOnStatusCode: false });
  report.observations.push({ context: side.label, phase: currentPhase, method: 'GET', path: relative, status: response.status() });
  equal(response.status(), 200, 'Read-only ' + relative + ' succeeds'); return response.json();
}
async function settle(side) { await side.page.waitForLoadState('networkidle'); await side.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function writeUI(side, method, relative, status, action) {
  assert.ok(!side.permit); side.permit = { key: method + ' /api/v1' + relative, remaining: 1 };
  try {
    const [response] = await Promise.all([side.page.waitForResponse(r => r.url() === options.url + '/api/v1' + relative && r.request().method() === method), action()]);
    equal(response.status(), status, 'Explicit UI ' + method + ' ' + relative + ' succeeds with real CSRF');
    equal(side.permit.remaining, 0, 'Exactly one UI write permit was consumed'); await response.finished();
  } finally { side.permit = null; }
  await settle(side);
}
async function screenshot(side, label) {
  const file = side.label + '-' + label + '.png';
  await side.page.screenshot({ path: path.join(options.outputDir, file), fullPage: false, mask: [side.page.locator('input[type="password"]')] });
  report.screenshots.push({ context: side.label, phase: currentPhase, file });
}
async function openAdmin(side) { await side.page.locator('.lh-more-trigger').click(); await side.page.getByRole('menuitem', { name: '管理中心', exact: true }).click(); await side.page.locator('.admin-shell').waitFor(); await settle(side); }
async function tab(side, label) { await side.page.locator('.admin-sidebar').getByRole('button', { name: label, exact: true }).click(); await side.page.locator('.admin-page-heading').getByRole('heading', { name: label, exact: true }).waitFor(); await settle(side); }
async function select(side, locator, label) { await locator.click(); await side.page.getByRole('option', { name: label, exact: true }).click(); await settle(side); }
async function feedback(side, locator, label, internal = false) {
  await locator.waitFor();
  const value = await locator.evaluate(element => {
    const css = getComputedStyle(element), box = element.getBoundingClientRect(), next = element.nextElementSibling?.getBoundingClientRect();
    const paragraph = element.querySelector(':scope > p'), action = paragraph?.nextElementSibling;
    return { tag: element.tagName, marginTop: parseFloat(css.marginTop), marginBottom: parseFloat(css.marginBottom), background: css.backgroundColor, color: css.color, nextGap: next ? next.top - box.bottom : null, internalGap: paragraph && action ? action.getBoundingClientRect().top - paragraph.getBoundingClientRect().bottom : null };
  });
  equal(value.marginTop, 14, label + ': top feedback margin is restored'); equal(value.marginBottom, 14, label + ': bottom feedback margin is restored');
  equal(value.background, 'rgb(237, 245, 239)', label + ': green information background is preserved'); equal(value.color, 'rgb(68, 110, 87)', label + ': information text color is preserved');
  if (internal) check(value.internalGap >= 11 && value.internalGap <= 13, label + ': paragraph and action have 12px separation');
  if (value.nextGap !== null) check(value.nextGap >= 13, label + ': following content does not touch or overlap the notice');
  report.measurements.push({ context: side.label, phase: currentPhase, label, viewport: side.page.viewportSize(), feedback: value });
}
async function responsive(side, label, verify, anchor) {
  for (const viewport of viewports) {
    await side.page.setViewportSize(viewport); await settle(side); await verify();
    if (anchor) await anchor().scrollIntoViewIfNeeded();
    const size = await side.page.evaluate(() => ({ width: innerWidth, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, dialogs: [...document.querySelectorAll('.admin-ui.cn-dialog-content')].map(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, client: element.clientWidth, scroll: element.scrollWidth }; }) }));
    check(size.scroll <= size.client + 1 && size.scroll <= viewport.width + 1, label + ': no horizontal document overflow at ' + viewport.width + 'x' + viewport.height);
    for (const dialog of size.dialogs) check(dialog.left >= -1 && dialog.right <= viewport.width + 1 && dialog.scroll <= dialog.client + 1, label + ': dialog fits the viewport without horizontal overflow');
    report.measurements.push({ context: side.label, phase: currentPhase, label, viewport, size });
    await screenshot(side, label + '-' + viewport.width + 'x' + viewport.height);
  }
  await side.page.setViewportSize(viewports[0]); await settle(side);
}
async function sourceExamples(side, dialog, kind, allowedSchemas) {
  const picker = dialog.getByRole('combobox', { name: '组件数据格式', exact: true });
  await picker.click();
  equal(await side.page.getByRole('option').allTextContents(), allowedSchemas.map(item => item.label), kind + ': selector offers exactly the supported built-in formats');
  await side.page.keyboard.press('Escape');
  const details = dialog.locator('.admin-source-example');
  if (!(await details.evaluate(element => element.open))) { await details.locator('summary').focus(); await side.page.keyboard.press('Enter'); }
  check(await details.evaluate(element => element.open), 'Native example details can be opened with the keyboard');
  check((await details.locator(':scope > p').innerText()).includes(kind === 'external-push' ? '推送模板' : '外部 API 需返回'), kind + ': help distinguishes a push snapshot from the raw external JSON response');
  let previous = null;
  for (const schema of allowedSchemas) {
    await select(side, picker, schema.label);
    const raw = await details.locator('pre').innerText(), data = JSON.parse(raw);
    equal(Object.keys(data).sort(), [...schema.keys].sort(), kind + ': valid JSON has the appropriate structure for ' + schema.id);
    if (previous !== null) check(raw !== previous, 'Changing the schema replaces the visible JSON example'); previous = raw;
    report.examples.push({ kind, schema: schema.id, keys: Object.keys(data).sort(), characters: raw.length });
  }
  await details.locator('pre').focus(); check(await details.locator('pre').evaluate(element => element === document.activeElement), 'JSON example is keyboard focusable for scrolling and selection');
}
async function run() {
  options = parseOptions(); if (!options) return;
  const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--disable-dev-shm-usage', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])] });
  report.browserVersion = browser.version();
  const owner = await newSide('owner'), fresh = await get(owner, '/bootstrap');
  equal(fresh.version, options.expectedVersion, 'Expected application version is running'); equal(fresh.initialized, false, 'Origin is fresh before any UI write'); equal(fresh.user, null, 'Fresh origin has no account'); equal(fresh.language, 'zh-CN', 'Fixture is explicitly Chinese'); equal(fresh.languageSelectionRequired, false, 'Language was fixed at startup');
  ready = true;
  phase('Initialize open editing without an Owner through UI');
  owner.page = await owner.context.newPage(); await owner.page.goto(options.url + '/', { waitUntil: 'networkidle' });
  await owner.page.getByRole('heading', { level: 1, name: '初始化 Home', exact: true }).waitFor();
  await owner.page.getByLabel('站点名称', { exact: true }).fill('页面间距验收');
  await owner.page.locator('.admin-mode-option').filter({ has: owner.page.getByText('完全开放', { exact: true }) }).locator('input').check();
  equal(await owner.page.getByRole('checkbox', { name: '同时创建管理员（可选）', exact: true }).isChecked(), false, 'Initial open editing creates no Owner'); equal(await owner.page.getByRole('checkbox', { name: '填充示例导航', exact: true }).isChecked(), false, 'Setup creates no example resources');
  await writeUI(owner, 'POST', '/setup', 201, () => owner.page.getByRole('button', { name: '创建我的 Home', exact: true }).click());
  await owner.page.locator('.lh-home:not([data-preview])').waitFor(); await settle(owner);
  equal((await get(owner, '/bootstrap')).user, null, 'Ownerless setup remains anonymous'); equal((await get(owner, '/settings')).hasOwner, false, 'Ownerless setup creates no hidden account');
  await openAdmin(owner); await tab(owner, '访问与账号');
  phase('Create only the first temporary Owner through Access and accounts');
  await owner.page.getByRole('checkbox', { name: '同时创建首个管理员（可选）', exact: true }).click();
  await owner.page.getByLabel('用户名', { exact: true }).fill('spacing_' + runId); await owner.page.getByLabel('显示名称', { exact: true }).fill('间距验收'); await owner.page.getByLabel('密码', { exact: true }).fill(password);
  await writeUI(owner, 'PUT', '/settings', 200, () => owner.page.getByRole('button', { name: '保存访问设置', exact: true }).click());
  const boot = await get(owner, '/bootstrap'); equal(boot.mode, 'open_edit', 'Creating the Owner preserves open editing'); equal(boot.user?.role, 'Owner', 'The real UI signs in the new Owner');
  const shared = boot.spaces.find(space => space.kind === 'shared'); check(shared?.published, 'Calendar notice is inspected in the actual published shared space');

  phase('Inspect actual source schemas and calendar notices without saving');
  await tab(owner, '数据源与 MCP');
  const spacePicker = owner.page.getByRole('combobox', { name: '当前空间', exact: true });
  if (!(await spacePicker.innerText()).includes(shared.name + ' · 共享')) await select(owner, spacePicker, shared.name + ' · 共享');
  equal((await get(owner, '/spaces/' + shared.id + '/sources')).length, 0, 'Shared source inventory starts empty');
  await owner.page.getByRole('button', { name: '添加数据源', exact: true }).click();
  const dialog = owner.page.getByRole('dialog', { name: '添加数据来源', exact: true }); await dialog.waitFor(); await settle(owner);
  const typePicker = dialog.getByRole('combobox', { name: '数据来源类型', exact: true }), schemaPicker = dialog.getByRole('combobox', { name: '组件数据格式', exact: true });
  check((await typePicker.innerText()).includes('外部推送'), 'Source form opens in its real push-source mode');
  await sourceExamples(owner, dialog, 'external-push', schemas);
  await select(owner, schemaPicker, '日程');
  const calendarNote = () => dialog.locator('p.admin-info').filter({ hasText: '日程内容将按此空间的访问权限展示' });
  await responsive(owner, 'push-calendar-example', () => feedback(owner, calendarNote(), 'Shared calendar push notice'), () => dialog.locator('.admin-source-example'));
  await select(owner, typePicker, '外部 API · 定时读取 JSON');
  await sourceExamples(owner, dialog, 'external-json', schemas.filter(item => item.id !== 'navigation.collection'));
  await select(owner, schemaPicker, '统计指标');
  await responsive(owner, 'external-json-example', async () => { const value = JSON.parse(await dialog.locator('.admin-source-example pre').innerText()); check(Array.isArray(value.metrics), 'JSON mode displays the current metrics example'); }, () => dialog.locator('.admin-source-example'));
  await select(owner, typePicker, '日程 · ICS 订阅');
  equal(await dialog.locator('.admin-source-example').count(), 0, 'ICS mode does not show an unrelated JSON example');
  await feedback(owner, calendarNote(), 'Shared calendar ICS notice'); await calendarNote().scrollIntoViewIfNeeded(); await screenshot(owner, 'ics-calendar-notice-2560x1440');
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); await settle(owner);
  equal((await get(owner, '/spaces/' + shared.id + '/sources')).length, 0, 'Opening examples and cancelling created no source');

  phase('Inspect anonymous source, access and network permission notices');
  const visitor = await newSide('anonymous'); visitor.page = await visitor.context.newPage(); await visitor.page.goto(options.url + '/', { waitUntil: 'networkidle' }); await visitor.page.locator('.lh-home:not([data-preview])').waitFor(); await settle(visitor);
  equal((await get(visitor, '/bootstrap')).user, null, 'The second context has no inherited Owner session'); await openAdmin(visitor);
  await tab(visitor, '数据源与 MCP');
  const signIn = () => visitor.page.locator('div.admin-info').filter({ hasText: '配置数据源、MCP 和推送令牌需要登录账号' });
  equal(await visitor.page.getByRole('button', { name: '添加数据源', exact: true }).count(), 0, 'Anonymous inspection retains the real source-creation permission boundary');
  await responsive(visitor, 'sources-sign-in-notice', () => feedback(visitor, signIn(), 'Source sign-in guidance', true), signIn);
  await tab(visitor, '访问与账号');
  const accessLogin = () => visitor.page.locator('div.admin-info').filter({ hasText: '本站已有管理员' });
  const accessWarning = () => visitor.page.locator('p.admin-info').filter({ hasText: '切换访问模式会使旧会话失效' });
  await responsive(visitor, 'access-notices', async () => { await feedback(visitor, accessLogin(), 'Access sign-in guidance', true); await feedback(visitor, accessWarning(), 'Access-mode warning'); }, accessLogin);
  await tab(visitor, '网络设置');
  const networkWarning = () => visitor.page.locator('p.admin-info').filter({ hasText: '只有管理员可以修改全站自动选路设置' });
  await responsive(visitor, 'network-permission-notice', () => feedback(visitor, networkWarning(), 'Network permission notice'), networkWarning);
  phase('Verify exact writes and browser audit');
  equal([...usedWrites.keys()].sort(), ['POST /api/v1/setup', 'PUT /api/v1/settings'], 'Exactly setup and first-Owner creation were written');
  const writes = report.requests.filter(item => !['GET', 'HEAD'].includes(item.method)); equal(writes.length, 2, 'No modal or example operation performed a business write'); check(writes.every(item => item.permitted && item.hasCSRF), 'Both writes used real CSRF and exact UI permits');
  equal(report.forbidden.length, 0, 'No external request or unauthorized write was attempted'); equal(report.sockets.length, 0, 'No WebSocket was attempted'); equal(report.pageErrors.length, 0, 'No browser runtime errors'); equal(report.harnessErrors.length, 0, 'No harness errors'); equal(report.requests.filter(item => item.status >= 400).length, 0, 'No HTTP errors'); equal(report.requests.filter(item => item.failure).length, 0, 'No request failed'); equal(report.console.filter(item => item.type === 'error').length, 0, 'No console errors');
  report.status = 'passed';
}
run().catch(async error => {
  report.status = 'failed'; report.failure = { phase: currentPhase, message: clean(error.message), stack: clean(error.stack) }; process.exitCode = 1; process.stderr.write(clean(error.stack) + '\n');
  for (const side of sides) if (side.page && !side.page.isClosed()) try { await screenshot(side, 'failure'); } catch (captureError) { report.harnessErrors.push({ error: clean(captureError.message) }); }
}).finally(async () => {
  for (const side of sides) { side.closing = true; await side.context.close().catch(() => {}); } if (browser) await browser.close().catch(() => {});
  if (options) { report.completedAt = new Date().toISOString(); report.checks = report.assertions.length; const file = path.join(options.outputDir, 'spacing-sources-report.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2).split(password).join('[REDACTED]') + '\n', { mode: 0o600 }); process.stdout.write(JSON.stringify({ status: report.status, checks: report.checks, screenshots: report.screenshots.length, report: file }) + '\n'); }
});
