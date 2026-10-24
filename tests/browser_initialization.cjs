#!/usr/bin/env node
'use strict';

/**
 * Real UI acceptance for disposable, uninitialized Home instances.
 *
 * node tests/browser_initialization.cjs --fixtures fixtures.json \
 *   --output-dir /tmp/home-initialization-run --allow-write --expected-version 0.0.1
 *
 * fixtures.json is an array of { name, url, language, scenario }. Each origin
 * must be fresh and unique. Ordinary fixtures require an explicit startup
 * language; language_choice fixtures omit it and declare their eventual choice.
 * Every fixture is preflighted before any UI write.
 * Ordinary writes use the UI; APIRequestContext is used only for GET evidence,
 * except the explicit committed-response-loss fault injected with route.fetch.
 * This script does not restart servers, create upstream sources, visit example
 * websites, or claim process-restart persistence. Reload checks reload the
 * actual document and never select a space on behalf of the application.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const started = performance.now();
const timeout = 20000;
const protectedPorts = new Set(['5180', '5182', '5183', '5184', '5185', '5194', '5195']);
const scenarios = new Set([
  'seed', 'blank', 'private_single', 'private_multi', 'open_ownerless',
  'open_owner', 'recover_uncommitted', 'recover_committed', 'conflict', 'language_choice'
]);
const viewports = [
  { width: 2560, height: 1440 }, { width: 1920, height: 1080 },
  { width: 1600, height: 900 }, { width: 2560, height: 1080 }
];
const optionalAssets = [
  /^(?:DataPanels|data-panels)(?:[-.]|$)/i,
  /^(?:TrafficPanel|traffic-panel)(?:[-.]|$)/i,
  /^(?:WidgetImportDialog|widget-import)(?:[-.]|$)/i,
  /^(?:DashboardPresetDialog|dashboard-presets-dialog)(?:[-.]|$)/i,
  /^(?:HomeEditor|home-editor)(?:[-.]|$)/i
];
const secrets = new Set();
const report = {
  runId, startedAt: new Date().toISOString(), status: 'running', expectedVersion: null,
  browserVersion: null, checks: 0, fixtures: [], preflightComplete: false,
  method: 'Fresh independent browser contexts; all instances verified uninitialized before the first write in the batch. Configuration, account creation, sign-in, sign-out and link saves use real UI controls. Later writes are explicitly permitted one request at a time.',
  faultInjection: 'Only recover_uncommitted and recover_committed intercept setup. The former aborts before server delivery; the latter sends the real UI request once, verifies HTTP 201, then aborts the browser response and clears that context cookies. Conflict uses a real second context and real HTTP 409.',
  scope: 'Same-tab document reload and identity-scoped space restoration, not a server restart. Responsive measurements run after two animation frames. No foreign website navigation or poll-source creation. Console errors and expected injected failures remain in the report. No request bodies, headers, cookies, passwords, storage dumps or connection strings are saved.'
};
let options, browser;
const states = [];

function sanitize(value) {
  let text = String(value ?? '');
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  // Never retain URL credentials or query/fragment data in diagnostics.
  return text.replace(/https?:\/\/[^\s"'<>]+/g, raw => {
    try { const u = new URL(raw); return u.origin + u.pathname; } catch { return '[URL]'; }
  }).slice(0, 16000);
}
function pathname(raw) { try { return new URL(raw).pathname; } catch { return null; } }
function stamp(st, side) {
  return { phase: st.phase, context: side?.label, elapsedMs: Math.round(performance.now() - started) };
}
function check(st, condition, label) {
  assert.ok(condition, label);
  st.result.assertions.push({ phase: st.phase, label });
  st.result.checks++;
}
function equal(st, actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  st.result.assertions.push({ phase: st.phase, label });
  st.result.checks++;
}
function step(st, phase) {
  st.phase = phase;
  st.result.phases.push({ name: phase, checksAtStart: st.result.checks, elapsedMs: Math.round(performance.now() - started) });
  process.stdout.write(JSON.stringify({ fixture: st.fixture.name, language: st.fixture.language, scenario: st.fixture.scenario, phase, checks: st.result.checks }) + '\n');
}
function l(st, zh, en) { return st.fixture.language === 'en' ? en : zh; }
function apiURL(st, relative) { return st.origin + '/api/v1' + relative; }
function button(st, side, zh, en) { return side.page.getByRole('button', { name: l(st, zh, en), exact: true }); }
function field(st, side, zh, en) { return side.page.getByLabel(l(st, zh, en), { exact: true }); }
function setupCount(st, side) {
  return st.result.requests.filter(item => item.method === 'POST' && item.path === '/api/v1/setup' && (!side || item.context === side.label)).length;
}
function languageChoiceCount(st) {
  return st.result.requests.filter(item => item.method === 'POST' && item.path === '/api/v1/setup/language').length;
}
function credentials(st, suffix = 'owner') {
  const value = {
    username: suffix + '_' + runId + '_' + st.index,
    displayName: l(st, '初始化验收', 'Initialization check') + ' ' + suffix,
    password: 'Init-' + randomUUID() + '-9!',
    siteName: ('Home ' + st.fixture.name + ' ' + suffix).slice(0, 80)
  };
  secrets.add(value.password);
  return value;
}
function parseOptions() {
  const parsed = { expectedVersion: '0.0.1', outputDir: path.join(os.tmpdir(), 'home-initialization-' + runId), allowWrite: false };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node tests/browser_initialization.cjs --fixtures <JSON-file-or-array> --output-dir <directory> --allow-write [--expected-version 0.0.1]\nScenarios: ' + [...scenarios].join(', ') + '\nEnvironment: LINGSHU_PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE\n');
      return null;
    }
    if (arg === '--allow-write') { parsed.allowWrite = true; continue; }
    const key = { '--fixtures': 'fixturesArg', '--output-dir': 'outputDir', '--expected-version': 'expectedVersion' }[arg];
    assert.ok(key && args[i + 1] && !args[i + 1].startsWith('--'), 'Unknown or incomplete command-line option');
    parsed[key] = args[++i];
  }
  assert.ok(parsed.allowWrite, 'Explicit --allow-write is required; no write is permitted without it');
  assert.ok(parsed.fixturesArg, '--fixtures is required');
  assert.match(parsed.expectedVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Expected version must be explicit SemVer');
  const input = parsed.fixturesArg.trim().startsWith('[') ? parsed.fixturesArg : fs.readFileSync(parsed.fixturesArg, 'utf8');
  const fixtures = JSON.parse(input);
  assert.ok(Array.isArray(fixtures) && fixtures.length > 0 && fixtures.length <= 36, 'Fixtures must be a nonempty array of at most 36 entries');
  const origins = new Set(), names = new Set();
  parsed.fixtures = fixtures.map(fixture => {
    assert.ok(fixture && typeof fixture.name === 'string' && fixture.name.length > 0 && fixture.name.length <= 100 && !/[\u0000-\u001f]/.test(fixture.name), 'Each fixture needs a short, nonempty name');
    assert.ok(!names.has(fixture.name), 'Fixture names must be unique'); names.add(fixture.name);
    assert.ok(scenarios.has(fixture.scenario), 'Unknown initialization scenario');
    assert.ok(['zh-CN', 'en'].includes(fixture.language), 'Fixture language must be zh-CN or en');
    assert.ok(typeof fixture.url === 'string', 'Fixture URL must be a string');
    const base = new URL(fixture.url);
    assert.ok(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Use a plain application origin without credentials, path, query or fragment');
    const host = base.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
    assert.ok(loopback || host === '10.233.233.61', 'Only loopback or approved test host 10.233.233.61 is allowed');
    assert.ok(base.port && !protectedPorts.has(base.port), 'An explicit disposable port is required; all seven old instances are protected');
    assert.ok(!origins.has(base.origin), 'Each fixture must use a unique fresh origin'); origins.add(base.origin);
    return { name: fixture.name, url: base.origin, language: fixture.language, scenario: fixture.scenario };
  });
  parsed.outputDir = path.resolve(parsed.outputDir);
  fs.mkdirSync(parsed.outputDir, { recursive: true, mode: 0o700 });
  assert.ok(!fs.existsSync(path.join(parsed.outputDir, 'initialization-report.json')), 'Refusing to overwrite an earlier initialization report');
  return parsed;
}
function newState(fixture, index) {
  const result = {
    ...fixture, status: 'pending', checks: 0, phases: [], assertions: [], observations: [],
    requests: [], console: [], pageErrors: [], forbiddenRequests: [], websocketAttempts: [],
    harnessErrors: [], faultEvents: [], measurements: [], screenshots: [], reloads: [],
    unexpectedConsole: [], unexpectedHTTP: [], unexpectedFailedRequests: []
  };
  const st = { fixture, index, origin: fixture.url, result, phase: 'preflight', sides: [], inspections: new Set(), configured: false, languageSelected: fixture.scenario !== 'language_choice', ready: false, closing: false };
  report.fixtures.push(result); states.push(st); return st;
}
function inspect(st, pending) {
  st.inspections.add(pending);
  pending.catch(error => st.result.harnessErrors.push({ ...stamp(st), error: sanitize(error.message) }))
    .finally(() => st.inspections.delete(pending));
}
async function drain(st) {
  while (st.inspections.size) await Promise.allSettled([...st.inspections]);
}
async function settle(st, side) {
  await side.page.waitForLoadState('networkidle');
  await side.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await drain(st);
}
function attachPage(st, side, page) {
  page.on('request', request => {
    if (st.closing) return;
    const item = { id: st.result.requests.length + 1, ...stamp(st, side), method: request.method(), path: pathname(request.url()), resourceType: request.resourceType() };
    side.requestMap.set(request, item); st.result.requests.push(item);
  });
  page.on('response', response => {
    if (st.closing) return;
    const item = side.requestMap.get(response.request());
    if (item) item.status = response.status();
    const p = pathname(response.url());
    if (p === '/api/v1/dashboard' && response.request().method() === 'GET' && response.status() === 200) {
      inspect(st, response.json().then(value => {
        side.lastDashboard = { id: value.space?.id, kind: value.space?.kind, name: value.space?.name, canEdit: value.space?.canEdit, published: value.space?.published };
        if (item) item.spaceId = value.space?.id;
      }));
    }
    if (response.status() >= 400 && item) {
      inspect(st, response.json().then(value => { item.code = typeof value.code === 'string' ? value.code : value.error?.code; }).catch(() => { item.code = null; }));
    }
  });
  page.on('requestfailed', request => {
    if (st.closing) return;
    const item = side.requestMap.get(request);
    if (item) item.failure = sanitize(request.failure()?.errorText || 'request failed');
  });
  page.on('console', message => {
    if (!st.closing) st.result.console.push({ ...stamp(st, side), type: message.type(), text: sanitize(message.text()), path: pathname(message.location().url) });
  });
  page.on('pageerror', error => { if (!st.closing) st.result.pageErrors.push({ ...stamp(st, side), error: sanitize(error.message) }); });
  page.on('dialog', async dialog => {
    st.result.harnessErrors.push({ ...stamp(st, side), error: 'Unexpected native browser dialog: ' + dialog.type() });
    await dialog.dismiss();
  });
  page.on('websocket', socket => {
    if (!st.closing) st.result.websocketAttempts.push({ ...stamp(st, side), path: pathname(socket.url()), kind: 'browser-event' });
  });
}
async function newSide(st, label) {
  const context = await browser.newContext({
    viewport: viewports[0], deviceScaleFactor: 1, locale: st.fixture.language === 'en' ? 'en-US' : 'zh-CN',
    serviceWorkers: 'block', reducedMotion: 'reduce'
  });
  context.setDefaultTimeout(timeout); context.setDefaultNavigationTimeout(30000);
  const side = { label, context, page: null, requestMap: new WeakMap(), permit: null, lastDashboard: null, freshChecked: false, injection: null };
  st.sides.push(side);
  await context.route('**/*', async route => {
    const request = route.request();
    const raw = request.url();
    let url;
    try { url = new URL(raw); } catch { await route.abort('blockedbyclient'); return; }
    if (!['http:', 'https:'].includes(url.protocol)) { await route.continue(); return; }
    const item = side.requestMap.get(request);
    if (url.origin !== st.origin) {
      st.result.forbiddenRequests.push({ ...stamp(st, side), method: request.method(), path: url.pathname, reason: 'Foreign origin blocked' });
      await route.abort('blockedbyclient'); return;
    }
    if (['GET', 'HEAD'].includes(request.method())) { await route.continue(); return; }
    const permit = side.permit;
    if (!st.ready || !permit || permit.remaining !== 1 || permit.path !== url.pathname || permit.method !== request.method()) {
      st.result.forbiddenRequests.push({ ...stamp(st, side), method: request.method(), path: url.pathname, reason: 'Write was not explicitly authorized by the current UI action' });
      await route.abort('blockedbyclient'); return;
    }
    permit.remaining--;
    if (item) { item.action = permit.label; item.expectedStatus = permit.status; }
    if (permit.fault) {
      if (item) item.fault = permit.fault;
      const evidence = { ...stamp(st, side), kind: permit.fault, path: url.pathname, forwarded: false };
      st.result.faultEvents.push(evidence); side.injection = evidence;
      try {
        if (permit.fault === 'committed-response-lost') {
          const upstream = await route.fetch({ timeout: 30000, maxRedirects: 0 });
          evidence.forwarded = true; evidence.upstreamStatus = upstream.status();
          if (upstream.status() !== 201) throw new Error('Committed-response fault requires a real HTTP 201 from setup');
          const data = await upstream.json();
          side.committedOwnerId = data.user?.id;
          st.configured = true;
          await upstream.dispose();
        }
        await route.abort('failed');
      } catch (error) {
        st.result.harnessErrors.push({ ...stamp(st, side), error: sanitize(error.message) });
        await route.abort('failed').catch(() => {});
      }
      return;
    }
    await route.continue();
  });
  assert.equal(typeof context.routeWebSocket, 'function', 'Playwright routeWebSocket is required to block unexpected sockets before connection');
  await context.routeWebSocket('**/*', async socket => {
    st.result.websocketAttempts.push({ ...stamp(st, side), path: pathname(socket.url()), kind: 'blocked-before-connect' });
    await socket.close();
  });
  context.on('page', page => {
    if (side.page && side.page !== page) st.result.harnessErrors.push({ ...stamp(st, side), error: 'Unexpected extra browser page' });
    if (!side.page) side.page = page;
    attachPage(st, side, page);
  });
  return side;
}
async function get(st, side, relative, purpose = 'observation') {
  assert.ok(relative.startsWith('/') && !relative.startsWith('//') && !relative.includes('#'), 'Read-only API helper accepts relative API paths only');
  const response = await side.context.request.get(apiURL(st, relative), { timeout, maxRedirects: 0, failOnStatusCode: false });
  st.result.observations.push({ ...stamp(st, side), method: 'GET', path: relative.split('?')[0], status: response.status(), purpose });
  equal(st, response.status(), 200, 'Read-only GET ' + relative.split('?')[0] + ' succeeds');
  return response.json();
}
async function readBoot(st, side) {
  const boot = await get(st, side, '/bootstrap');
  equal(st, boot.version, options.expectedVersion, 'Bootstrap version matches the explicitly expected release');
  equal(st, boot.languageSelectionRequired, !st.languageSelected, 'Bootstrap reports whether an explicit first-run language choice is still required');
  if (st.languageSelected) equal(st, boot.language, st.fixture.language, 'Bootstrap language matches this fixture and remains locked');
  else check(st, ['zh-CN', 'en'].includes(boot.language), 'Pending bootstrap uses a supported rendering language without treating it as the final choice');
  return boot;
}
async function verifyFresh(st, side) {
  const boot = await readBoot(st, side);
  equal(st, boot.initialized, false, 'Disposable fixture is uninitialized before its first setup write');
  equal(st, boot.user, null, 'Fresh fixture has no authenticated account');
  side.freshChecked = true;
  return boot;
}
async function openSetup(st, side) {
  const boot = await verifyFresh(st, side);
  side.page = await side.context.newPage();
  await side.page.goto(st.origin + '/', { waitUntil: 'networkidle' });
  if (boot.languageSelectionRequired) {
    await side.page.getByRole('heading', { level: 1, name: /选择语言|Choose your language/ }).waitFor();
    await settle(st, side);
    equal(st, await side.page.locator('input[name="setup-language"]').count(), 2, 'First-run language screen offers exactly Simplified Chinese and English');
    equal(st, await side.page.locator('input[name="setup-language"]:checked').count(), 0, 'No language is silently preselected');
    equal(st, await side.page.locator('button[type="submit"]').isEnabled(), false, 'Language confirmation waits for an explicit selection');
    equal(st, await side.page.locator('input[name="setup-mode"]').count(), 0, 'Access-mode setup is not available before language confirmation');
    equal(st, (await get(st, side, '/starter-packs')).length, 0, 'No starter content pack is offered before the language is fixed');
    equal(st, setupCount(st), 0, 'Opening language selection performs no setup write');
    equal(st, languageChoiceCount(st), 0, 'Opening language selection performs no language write');
    return;
  }
  await assertSetupScreen(st, side);
}
async function assertSetupScreen(st, side) {
  await side.page.getByRole('heading', { level: 1, name: l(st, '初始化 Home', 'Set up Home'), exact: true }).waitFor();
  await settle(st, side);
  equal(st, await side.page.locator('.auth-footer').innerText(), options.expectedVersion, 'Setup visibly identifies the expected release');
  equal(st, await side.page.getByRole('checkbox', { name: l(st, '填充示例导航', 'Add example bookmarks'), exact: true }).isChecked(), false, 'Example bookmarks are opt-in by default');
  equal(st, await modeRadio(st, side, 'public_read', 'setup-mode').isChecked(), true, 'Setup starts with the documented public-browsing choice');
  check(st, await side.page.getByText(l(st, '语言已确定：简体中文，示例内容将自动匹配。', 'Language is set to English. Example content will match automatically.'), { exact: true }).isVisible(), 'Setup explains that language is fixed and example content will match it');
  equal(st, await side.page.locator('input[name="setup-language"]').count(), 0, 'Confirmed setup offers no language-change controls');
  equal(st, await side.page.getByRole('combobox').count(), 0, 'Setup offers no independent example-language selector');
  equal(st, await side.page.locator('html').getAttribute('lang'), st.fixture.language, 'Document language follows the fixed instance language');
}
function modeRadio(st, side, mode, group) {
  const names = {
    open_edit: ['完全开放', 'Open editing'], public_read: ['公开浏览', 'Public browsing'],
    private_single: ['私人导航', 'Private navigation'], private_multi: ['多人空间', 'Multiple users']
  };
  return side.page.locator('.admin-mode-option').filter({ has: side.page.getByText(l(st, ...names[mode]), { exact: true }) }).locator('input[name="' + group + '"]');
}
async function setChecked(locator, value) { if (await locator.isChecked() !== value) await locator.click(); }
async function fillIdentity(st, side, identity) {
  await field(st, side, '用户名', 'Username').fill(identity.username);
  await field(st, side, '显示名称', 'Display name').fill(identity.displayName);
  await field(st, side, '密码', 'Password').fill(identity.password);
}
async function fillSetup(st, side, identity, mode, seed = false, owner = true) {
  await field(st, side, '站点名称', 'Site name').fill(identity.siteName);
  await modeRadio(st, side, mode, 'setup-mode').check();
  if (mode === 'open_edit') {
    const create = side.page.getByRole('checkbox', { name: l(st, '同时创建管理员（可选）', 'Also create an administrator (optional)'), exact: true });
    equal(st, await create.isChecked(), false, 'Open editing initially needs no account');
    equal(st, await field(st, side, '用户名', 'Username').count(), 0, 'Account fields are absent until optional Owner creation is selected');
    await setChecked(create, owner);
  }
  if (owner) await fillIdentity(st, side, identity);
  await setChecked(side.page.getByRole('checkbox', { name: l(st, '填充示例导航', 'Add example bookmarks'), exact: true }), seed);
  if (mode === 'private_multi') {
    check(st, await side.page.getByText(l(st, '成员自行注册默认关闭。创建后可在“成员管理”添加账号，或在“访问与账号”开启注册。', 'Member self-registration starts off. After setup, add accounts in Member management or enable registration in Access and accounts.'), { exact: true }).isVisible(), 'Multi-user setup explains that self-registration starts off');
  }
}
async function writeUI(st, side, method, relative, status, action, label) {
  assert.ok(!side.permit, 'UI write permits cannot overlap');
  side.permit = { method, path: '/api/v1' + relative, remaining: 1, status, label };
  try {
    const [response] = await Promise.all([
      side.page.waitForResponse(response => response.url() === apiURL(st, relative) && response.request().method() === method, { timeout: 30000 }),
      action()
    ]);
    equal(st, response.status(), status, label + ': real HTTP status');
    const value = status === 204 ? null : await response.json();
    equal(st, side.permit.remaining, 0, label + ': exactly one permitted browser write was used');
    return { value, response };
  } finally { side.permit = null; }
}
async function submitSetup(st, side, status = 201) {
  if (status === 201) await verifyFresh(st, side);
  else {
    check(st, side.freshChecked, 'Competing window was loaded while the fixture was fresh');
    equal(st, (await readBoot(st, side)).initialized, true, 'Conflict is against a truly initialized server, not a mocked response');
  }
  const result = await writeUI(st, side, 'POST', '/setup', status,
    () => button(st, side, '创建我的 Home', 'Create my Home').click(), 'Submit setup through the form');
  if (status === 201) { st.configured = true; equal(st, result.value.initialized, true, 'Real setup response confirms initialization'); }
  else equal(st, result.value.code || result.value.error?.code, 'conflict', 'Competing setup returns the precise conflict error');
  return result.value;
}
async function abortSetup(st, side, committed) {
  await verifyFresh(st, side);
  const kind = committed ? 'committed-response-lost' : 'uncommitted-request';
  side.permit = { method: 'POST', path: '/api/v1/setup', remaining: 1, status: null, label: 'Explicit setup fault injection', fault: kind };
  try {
    await Promise.all([
      side.page.waitForEvent('requestfailed', { predicate: request => request.url() === apiURL(st, '/setup') && request.method() === 'POST', timeout: 30000 }),
      button(st, side, '创建我的 Home', 'Create my Home').click()
    ]);
    equal(st, side.permit.remaining, 0, 'Fault injection consumes exactly one UI setup request');
  } finally { side.permit = null; }
  await button(st, side, '重新检查初始化状态', 'Check setup status again').waitFor();
  await settle(st, side);
  equal(st, setupCount(st, side), 1, 'A failed setup response causes no automatic setup re-POST');
  equal(st, side.injection?.forwarded, committed, 'Fault evidence identifies whether the setup request reached the server');
  if (committed) equal(st, side.injection?.upstreamStatus, 201, 'Committed-response fault observed a real successful server transaction');
}
async function recheck(st, side, initialized) {
  const before = setupCount(st, side);
  const [response] = await Promise.all([
    side.page.waitForResponse(response => response.url() === apiURL(st, '/bootstrap') && response.request().method() === 'GET'),
    button(st, side, '重新检查初始化状态', 'Check setup status again').click()
  ]);
  equal(st, response.status(), 200, 'Explicit recovery reads the actual bootstrap state');
  const boot = await response.json();
  equal(st, boot.initialized, initialized, 'Recovery uses the actual initialization state');
  equal(st, boot.version, options.expectedVersion, 'Recovery reads the expected release');
  equal(st, boot.language, st.fixture.language, 'Recovery keeps the configured interface language');
  await settle(st, side);
  equal(st, setupCount(st, side), before, 'Explicit status recovery does not re-submit setup');
  return boot;
}
async function waitHome(st, side, expected) {
  await side.page.locator('.lh-home:not([data-preview])').waitFor({ state: 'visible' });
  await settle(st, side);
  check(st, !!side.lastDashboard?.id, 'Rendered Home has a real dashboard response');
  if (expected?.id) equal(st, side.lastDashboard.id, expected.id, 'UI dashboard uses the expected space ID');
  if (expected?.kind) equal(st, side.lastDashboard.kind, expected.kind, 'UI dashboard uses the expected space kind');
  const picker = side.page.getByRole('combobox', { name: l(st, '选择空间', 'Choose a space'), exact: true });
  if (await picker.count()) {
    check(st, (await picker.innerText()).includes(side.lastDashboard.name), 'Space selector displays the actual loaded space');
    if (side.lastDashboard.kind === 'personal') check(st, (await picker.innerText()).includes(l(st, '私人', 'Personal')), 'Personal space is visibly identified');
  }
  equal(st, await side.page.getByRole('heading', { level: 1, name: l(st, '初始化 Home', 'Set up Home'), exact: true }).count(), 0, 'Completed setup is no longer rendered');
}
async function waitLogin(st, side) {
  await side.page.getByRole('heading', { level: 1, name: l(st, '登录', 'Sign in'), exact: true }).waitFor();
  await settle(st, side);
  equal(st, await side.page.locator('.lh-home:not([data-preview])').count(), 0, 'Unauthenticated private access renders no dashboard');
  equal(st, await button(st, side, '创建我的 Home', 'Create my Home').count(), 0, 'An initialized instance does not expose setup submission');
}
async function signIn(st, side, identity) {
  await waitLogin(st, side);
  await field(st, side, '用户名', 'Username').fill(identity.username);
  await field(st, side, '密码', 'Password').fill(identity.password);
  await writeUI(st, side, 'POST', '/auth/login', 200, () => button(st, side, '登录', 'Sign in').click(), 'Sign in through the login form');
}
async function signOut(st, side) {
  await writeUI(st, side, 'POST', '/auth/logout', 200, () => button(st, side, '退出登录', 'Sign out').click(), 'Sign out through the current UI');
  await settle(st, side);
  equal(st, (await readBoot(st, side)).user, null, 'Sign-out removes the authenticated identity');
}
async function navigation(st, side, space) { return get(st, side, '/spaces/' + space.id + '/navigation'); }
async function assertConfigured(st, side, identity, mode, owner, seed) {
  const boot = await readBoot(st, side);
  equal(st, boot.initialized, true, 'Initialization is persisted in bootstrap');
  equal(st, boot.mode, mode, 'Selected access mode is persisted exactly');
  equal(st, boot.siteName, identity.siteName, 'Site name is persisted exactly');
  equal(st, boot.registrationEnabled, false, 'Member self-registration remains off by default');
  equal(st, boot.autoFetchIcons, true, 'Default icon setting remains enabled');
  equal(st, boot.autoSelectEndpoint, true, 'Default endpoint-selection setting remains enabled');
  const shared = boot.spaces.filter(space => space.kind === 'shared');
  const personal = boot.spaces.filter(space => space.kind === 'personal');
  equal(st, shared.length, 1, 'Exactly one accessible shared space exists');
  equal(st, personal.length, owner ? 1 : 0, 'Personal space is created only with an account');
  equal(st, shared[0].published, mode === 'public_read' || mode === 'open_edit', 'Shared visibility matches the chosen access mode');
  if (owner) {
    check(st, boot.user?.role === 'Owner' && boot.user.username === identity.username, 'The actual created Owner is signed in');
    equal(st, boot.defaultSpaceId, personal[0].id, 'Backend default-space contract still identifies the Owner personal space');
    equal(st, (await navigation(st, side, personal[0])).data.links.length, 0, 'The new personal navigation starts empty');
  } else {
    equal(st, boot.user, null, 'Account-free setup does not create or sign in an Owner');
    equal(st, boot.defaultSpaceId, shared[0].id, 'Account-free default space is shared');
  }
  const nav = await navigation(st, side, shared[0]);
  equal(st, nav.data.links.length, seed ? 12 : 0, 'Shared bookmark count matches the explicit example choice');
  equal(st, nav.data.categories.length, seed ? 3 : 0, 'Shared category count matches the explicit example choice');
  if (seed) check(st, nav.data.links.every(link => link.icon?.startsWith('lucide:')), 'Example bookmarks use bundled icons');
  return { boot, shared: shared[0], personal: personal[0], nav };
}
async function assertLightweight(st, side, space) {
  const saved = await get(st, side, '/spaces/' + space.id + '/page');
  const config = saved.config;
  check(st, !!config?.bindings && Object.keys(config.bindings).length > 0 && Object.values(config.bindings).every(binding => binding.datasetId === 'local-navigation'), 'Initial page binds only the local navigation dataset');
  const allowed = new Set(['builtin/search', 'builtin/category-navigation', 'builtin/favorites', 'builtin/navigation']);
  check(st, Array.isArray(config.views) && config.views.every(view => allowed.has(view.panel?.id)), 'Initial page contains only bundled navigation components');
  const optional = st.result.requests.filter(item => item.resourceType === 'script' || item.resourceType === 'stylesheet').filter(item => optionalAssets.some(pattern => pattern.test(path.basename(item.path || ''))));
  equal(st, optional.length, 0, 'Initial navigation does not request optional data, traffic, import, preset or editor chunks');
  equal(st, st.result.websocketAttempts.length, 0, 'Initialization and initial Home open no WebSocket');
  equal(st, st.result.forbiddenRequests.length, 0, 'Initialization and initial Home request no foreign resources or unexpected writes');
}
async function naturalReload(st, side, expected, label) {
  const [response] = await Promise.all([
    side.page.waitForResponse(response => pathname(response.url()) === '/api/v1/dashboard' && response.request().method() === 'GET' && response.status() === 200),
    side.page.reload({ waitUntil: 'networkidle' })
  ]);
  const value = await response.json();
  equal(st, value.space.id, expected.id, label + ': the first dashboard after natural reload is already correct');
  await waitHome(st, side, expected);
  const navigationType = await side.page.evaluate(() => performance.getEntriesByType('navigation')[0]?.type);
  equal(st, navigationType, 'reload', label + ': a real document reload was measured');
  st.result.reloads.push({ ...stamp(st, side), label, navigationType, expectedSpaceId: expected.id, actualSpaceId: side.lastDashboard.id, helperSelectedSpace: false });
}
async function selectSpace(st, side, space) {
  const label = space.name + (space.kind === 'personal' ? l(st, ' · 私人', ' · Personal') : '');
  await side.page.getByRole('combobox', { name: l(st, '选择空间', 'Choose a space'), exact: true }).click();
  const [response] = await Promise.all([
    side.page.waitForResponse(response => pathname(response.url()) === '/api/v1/dashboard' && new URL(response.url()).searchParams.get('spaceId') === space.id && response.request().method() === 'GET'),
    side.page.getByRole('option', { name: label, exact: true }).click()
  ]);
  equal(st, response.status(), 200, 'Explicit manual space selection loads its real dashboard');
  await waitHome(st, side, space);
}
async function screenshot(st, side, label) {
  if (!side.page || side.page.isClosed()) return;
  const filename = String(st.index + 1).padStart(2, '0') + '-' + st.fixture.language + '-' + st.fixture.scenario + '-' + side.label + '-' + label.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) + '.png';
  const target = path.join(options.outputDir, filename);
  await side.page.screenshot({ path: target, fullPage: false, mask: [side.page.locator('input[type="password"]')] });
  st.result.screenshots.push({ context: side.label, phase: st.phase, file: filename });
}
async function responsive(st, side, label, controls) {
  for (const viewport of viewports) {
    await side.page.setViewportSize(viewport);
    await settle(st, side);
    const measured = await side.page.evaluate(() => {
      const submit = document.querySelector('.auth-setup button[type="submit"]');
      const notice = [...document.querySelectorAll('.auth-setup .admin-plain-fieldset > p.admin-info')].at(-1);
      const infoBox = notice?.getBoundingClientRect(), actionBox = submit?.getBoundingClientRect();
      return {
        innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
        innerHeight, bookmarkElements: document.querySelectorAll('.lh-home:not([data-preview]) article.lh-bookmark[data-link-id]').length,
        setupSpacing: infoBox && actionBox ? {
          gap: actionBox.top - infoBox.bottom,
          notice: { left: infoBox.left, right: infoBox.right, top: infoBox.top, bottom: infoBox.bottom },
          submit: { left: actionBox.left, right: actionBox.right, top: actionBox.top, bottom: actionBox.bottom },
          background: getComputedStyle(notice).backgroundColor
        } : null,
        overflows: [...document.querySelectorAll('body *')].filter(element => {
          const style = getComputedStyle(element), r = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
        }).slice(0, 15).map(element => ({ tag: element.tagName, className: String(element.className).slice(0, 160), left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }))
      };
    });
    const entry = { ...stamp(st, side), label, viewport, ...measured, controls: [] };
    st.result.measurements.push(entry);
    check(st, measured.scrollWidth <= measured.clientWidth + 1 && measured.scrollWidth <= viewport.width + 1, label + ' ' + viewport.width + 'x' + viewport.height + ': document has no horizontal overflow after painting');
    if (label === 'setup' || label.startsWith('setup-')) {
      check(st, !!measured.setupSpacing, label + ': final setup notice and submit button are both measurable');
      check(st, measured.setupSpacing.gap >= 13 && measured.setupSpacing.gap <= 15, label + ' ' + viewport.width + 'x' + viewport.height + ': final notice and submit button have the intended 14px separation without overlap');
      check(st, Math.abs(measured.setupSpacing.notice.left - measured.setupSpacing.submit.left) <= 1 && Math.abs(measured.setupSpacing.notice.right - measured.setupSpacing.submit.right) <= 1, label + ': final notice and submit button keep their aligned horizontal edges');
    }
    for (const control of controls()) {
      await control.locator.scrollIntoViewIfNeeded();
      await control.locator.click({ trial: true });
      const box = await control.locator.boundingBox();
      entry.controls.push({ name: control.name, box });
      check(st, !!box && box.x >= -1 && box.x + box.width <= viewport.width + 1 && box.y >= -1 && box.y + box.height <= viewport.height + 1, label + ': ' + control.name + ' is reachable inside the viewport');
    }
    if (measured.setupSpacing) await screenshot(st, side, label + '-actions-' + viewport.width + 'x' + viewport.height);
    await side.page.evaluate(() => window.scrollTo(0, 0));
    await side.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await screenshot(st, side, label + '-' + viewport.width + 'x' + viewport.height);
  }
  await side.page.setViewportSize(viewports[0]); await settle(st, side);
}
async function visitAnonymous(st, label = 'visitor') {
  const side = await newSide(st, label);
  side.page = await side.context.newPage();
  await side.page.goto(st.origin + '/', { waitUntil: 'networkidle' });
  return side;
}
async function enterAccessSettings(st, side) {
  await side.page.getByRole('link', { name: l(st, '管理中心', 'Admin'), exact: true }).click();
  await side.page.locator('.admin-shell').waitFor();
  await button(st, side, '访问与账号', 'Access and accounts').click();
  await button(st, side, '保存访问设置', 'Save access settings').waitFor();
  await settle(st, side);
}
async function returnHome(st, side, space) {
  await button(st, side, '返回导航', 'Back to Home').click();
  await waitHome(st, side, space);
}

async function starterPreview(st, side) {
  const packs = await get(st, side, '/starter-packs');
  equal(st, packs.length, 1, 'Server publishes only the starter pack for the locked instance language');
  equal(st, packs[0].id, st.fixture.language, 'The only starter pack matches the interface language');
  equal(st, await side.page.getByRole('combobox').count(), 0, 'Enabling examples does not introduce a language or content-pack selector');
  check(st, await side.page.locator('.auth-starter-heading').isVisible(), 'Example content has a static heading rather than a language selector');
  const details = side.page.locator('.auth-starter-pack details');
  if (!(await details.evaluate(element => element.open))) await details.locator('summary').click();
  await side.page.waitForFunction(() => document.querySelectorAll('.auth-starter-pack li').length === 12);
  const links = packs[0].groups.flatMap(group => group.links);
  equal(st, await details.locator('li small').allTextContents(), links.map(link => link.url), 'Visible preview lists exactly the twelve websites from the locked-language pack');
  equal(st, await details.locator('li span').allTextContents(), links.map(link => link.title), 'Visible bookmark titles follow the locked language');
  equal(st, await details.locator('h4').allTextContents(), packs[0].groups.map(group => group.name), 'Visible category names follow the locked language');
  equal(st, packs[0].groups.length, 3, 'The matching starter pack has three real categories');
  return packs[0];
}
function assertSavedStarter(st, configured, pack) {
  const expectedLinks = pack.groups.flatMap(group => group.links);
  const comparable = links => links.map(link => ({ title: link.title, url: link.url })).sort((a, b) => a.url.localeCompare(b.url));
  equal(st, comparable(configured.nav.data.links), comparable(expectedLinks), 'Saved example URLs and titles exactly match the locked-language preview');
  equal(st, configured.nav.data.categories.map(category => category.name).sort(), pack.groups.map(group => group.name).sort(), 'Saved category names exactly match the locked-language preview');
}
async function seedScenario(st, side, identity) {
  step(st, 'Seeded public setup and its locked-language content preview');
  await fillSetup(st, side, identity, 'public_read', true);
  const pack = await starterPreview(st, side);
  await responsive(st, side, 'setup', () => [
    { name: 'site name', locator: field(st, side, '站点名称', 'Site name') },
    { name: 'example preview', locator: side.page.locator('.auth-starter-pack summary') },
    { name: 'create Home', locator: button(st, side, '创建我的 Home', 'Create my Home') }
  ]);
  await submitSetup(st, side);
  const configured = await assertConfigured(st, side, identity, 'public_read', true, true);
  await waitHome(st, side, configured.shared);
  assertSavedStarter(st, configured, pack);
  equal(st, await side.page.locator('.lh-home article.lh-bookmark[data-link-id]').count(), 15, 'Twelve links plus three favorite cards are actually rendered');
  await assertLightweight(st, side, configured.shared);
  step(st, 'Natural shared reload, manual personal reload and identity isolation');
  await naturalReload(st, side, configured.shared, 'Seeded shared landing');
  equal(st, await side.page.locator('.lh-home article.lh-bookmark[data-link-id]').count(), 15, 'Natural reload retains the rendered seeded content without a helper space switch');
  await responsive(st, side, 'seeded-home', () => [
    { name: 'space selector', locator: side.page.getByRole('combobox', { name: l(st, '选择空间', 'Choose a space'), exact: true }) },
    { name: 'admin entry', locator: side.page.getByRole('link', { name: l(st, '管理中心', 'Admin'), exact: true }) },
    { name: 'sign out', locator: button(st, side, '退出登录', 'Sign out') }
  ]);
  await selectSpace(st, side, configured.personal);
  await naturalReload(st, side, configured.personal, 'Explicit personal selection');
  equal(st, await side.page.locator('.lh-home article.lh-bookmark[data-link-id]').count(), 0, 'Selected personal space remains empty and is not replaced by examples');
  await signOut(st, side);
  await waitHome(st, side, configured.shared);
  const anonymous = await readBoot(st, side);
  equal(st, anonymous.spaces.map(space => space.id), [configured.shared.id], 'Anonymous identity can access only the published shared space');
  equal(st, await button(st, side, '添加第一个链接', 'Add your first link').count(), 0, 'Anonymous public visitor is not offered editing actions');
  await naturalReload(st, side, configured.shared, 'Anonymous identity after sign-out');
  await side.page.getByRole('link', { name: l(st, '登录管理', 'Admin sign in'), exact: true }).click();
  await side.page.locator('.admin-shell').waitFor();
  await settle(st, side);
  await side.page.locator('.admin-topbar').getByRole('button', { name: l(st, '管理员登录', 'Administrator sign-in'), exact: true }).click();
  await signIn(st, side, identity);
  await waitHome(st, side, configured.personal);
  equal(st, (await readBoot(st, side)).user.id, configured.boot.user.id, 'Signing in again restores the same Owner identity');
  await naturalReload(st, side, configured.personal, 'Returning Owner keeps its own selected space');
  await selectSpace(st, side, configured.shared);
}
async function languageChoiceScenario(st, side, identity) {
  step(st, 'Explicit first-run language selection before site initialization');
  const choice = side.page.locator('input[name="setup-language"][value="' + st.fixture.language + '"]');
  await choice.check();
  equal(st, await choice.isChecked(), true, 'The user-selected language is visible before confirmation');
  equal(st, languageChoiceCount(st), 0, 'Selecting a radio does not prematurely persist the language');
  const confirm = button(st, side, '使用简体中文并继续', 'Continue in English');
  check(st, await confirm.isEnabled(), 'The explicit language choice enables its localized confirmation button');
  await responsive(st, side, 'language-choice', () => [
    { name: 'selected language', locator: choice },
    { name: 'confirm language', locator: confirm }
  ]);
  const selected = await writeUI(st, side, 'POST', '/setup/language', 200,
    () => confirm.click(), 'Confirm the instance language through the first-run form');
  equal(st, selected.value.language, st.fixture.language, 'Language confirmation returns the selected language');
  equal(st, selected.value.languageSelectionRequired, false, 'Language confirmation locks further selection');
  equal(st, selected.value.initialized, false, 'Language selection alone does not create a site or account');
  equal(st, selected.value.user, null, 'Language selection creates no authenticated identity');
  st.languageSelected = true;
  await assertSetupScreen(st, side);
  equal(st, setupCount(st), 0, 'Language confirmation does not silently submit the initialization form');
  await readBoot(st, side);

  step(st, 'Natural reload retains the language lock before setup');
  await side.page.reload({ waitUntil: 'networkidle' });
  await assertSetupScreen(st, side);
  equal(st, await side.page.evaluate(() => performance.getEntriesByType('navigation')[0]?.type), 'reload', 'The language lock is checked after a real document reload');
  await readBoot(st, side);
  equal(st, languageChoiceCount(st), 1, 'Reloading the locked setup sends no second language-selection write');

  step(st, 'Continue initialization with automatically matching example content');
  await fillSetup(st, side, identity, 'public_read', true);
  const pack = await starterPreview(st, side);
  await responsive(st, side, 'setup-selected-language', () => [
    { name: 'site name', locator: field(st, side, '站点名称', 'Site name') },
    { name: 'example preview', locator: side.page.locator('.auth-starter-pack summary') },
    { name: 'create Home', locator: button(st, side, '创建我的 Home', 'Create my Home') }
  ]);
  await submitSetup(st, side);
  const configured = await assertConfigured(st, side, identity, 'public_read', true, true);
  assertSavedStarter(st, configured, pack);
  await waitHome(st, side, configured.shared);
  await assertLightweight(st, side, configured.shared);
  await naturalReload(st, side, configured.shared, 'Explicit-language setup shared landing');
  await readBoot(st, side);
  equal(st, languageChoiceCount(st), 1, 'Completing setup and reloading Home never reopen or rewrite the chosen language');
  equal(st, await side.page.locator('input[name="setup-language"]').count(), 0, 'Completed Home exposes no first-run language selector');
  equal(st, await side.page.locator('html').getAttribute('lang'), st.fixture.language, 'Completed Home keeps the originally chosen document language');
}
async function blankScenario(st, side, identity) {
  step(st, 'Blank public setup lands in shared navigation');
  await fillSetup(st, side, identity, 'public_read', false);
  await submitSetup(st, side);
  const configured = await assertConfigured(st, side, identity, 'public_read', true, false);
  await waitHome(st, side, configured.shared);
  await naturalReload(st, side, configured.shared, 'Blank public landing');
  await assertLightweight(st, side, configured.shared);
  await responsive(st, side, 'blank-home', () => [
    { name: 'add first link', locator: button(st, side, '添加第一个链接', 'Add your first link') },
    { name: 'import browser bookmarks', locator: button(st, side, '导入浏览器书签', 'Import browser bookmarks') }
  ]);
  step(st, 'Empty-state import and add actions reuse real forms in the same shared space');
  const writesBefore = st.result.requests.filter(item => !['GET', 'HEAD'].includes(item.method)).length;
  await button(st, side, '导入浏览器书签', 'Import browser bookmarks').click();
  const importer = side.page.getByRole('dialog', { name: l(st, '导入浏览器书签', 'Import browser bookmarks'), exact: true });
  await importer.waitFor();
  check(st, await importer.locator('input[type="file"]').count() === 1, 'Empty-state import opens the existing HTML bookmark importer');
  equal(st, await importer.getByRole('button', { name: l(st, '预览文件', 'Preview file'), exact: true }).isEnabled(), false, 'Importer waits for an explicit local file');
  await importer.getByRole('button', { name: l(st, '取消', 'Cancel'), exact: true }).click();
  await importer.waitFor({ state: 'hidden' }); await settle(st, side);
  check(st, !new URLSearchParams(side.page.url().split('?')[1] || '').has('action'), 'One-shot empty-state action is consumed after opening the form');
  await side.page.reload({ waitUntil: 'networkidle' });
  await side.page.locator('.admin-shell').waitFor(); await settle(st, side);
  equal(st, await side.page.getByRole('dialog').count(), 0, 'Reload does not reopen a consumed import action');
  equal(st, st.result.requests.filter(item => !['GET', 'HEAD'].includes(item.method)).length, writesBefore, 'Opening and cancelling the importer performs no business write');
  await returnHome(st, side, configured.shared);
  await button(st, side, '添加第一个链接', 'Add your first link').click();
  const editor = side.page.getByRole('dialog', { name: l(st, '添加链接', 'Add link'), exact: true });
  await editor.waitFor();
  check(st, await editor.getByText(l(st, '保存到 ' + configured.shared.name, 'Save to ' + configured.shared.name), { exact: true }).isVisible(), 'Link editor explicitly identifies the shared destination');
  const title = 'Initialization bookmark ' + runId;
  await field(st, side, '链接名称', 'Link name').fill(title);
  await field(st, side, '主入口 URL', 'Primary URL').fill('https://initialization.invalid/');
  await button(st, side, '使用默认图标', 'Use default').click();
  equal(st, await side.page.getByRole('group', { name: l(st, '图标模式', 'Icon mode'), exact: true }).getByRole('button', { name: l(st, '手动选择', 'Manual selection'), exact: true }).getAttribute('aria-pressed'), 'true', 'Test bookmark uses a bundled manual icon and starts no backend website fetch');
  await responsive(st, side, 'add-link-form', () => [
    { name: 'link name', locator: field(st, side, '链接名称', 'Link name') },
    { name: 'primary URL', locator: field(st, side, '主入口 URL', 'Primary URL') },
    { name: 'save link', locator: button(st, side, '保存链接', 'Save link') }
  ]);
  const saved = await writeUI(st, side, 'POST', '/spaces/' + configured.shared.id + '/links', 201, () => button(st, side, '保存链接', 'Save link').click(), 'Save the first bookmark through the reused form');
  equal(st, saved.value.iconMode, 'manual', 'Server persists the explicitly manual icon choice');
  await editor.waitFor({ state: 'hidden' }); await settle(st, side);
  const nav = await navigation(st, side, configured.shared);
  equal(st, nav.data.links.length, 1, 'Exactly one real bookmark is saved in the shared space');
  equal(st, nav.data.links[0].title, title, 'Saved bookmark has the title entered in the form');
  equal(st, (await navigation(st, side, configured.personal)).data.links.length, 0, 'Adding shared content does not write into the personal space');
  await returnHome(st, side, configured.shared);
  await naturalReload(st, side, configured.shared, 'First shared bookmark after form save');
  check(st, await side.page.locator('article.lh-bookmark[data-link-id="' + saved.value.id + '"]').count() > 0, 'The saved bookmark is actually rendered after reload');
  const visitor = await visitAnonymous(st);
  await waitHome(st, visitor, configured.shared);
  equal(st, (await readBoot(st, visitor)).user, null, 'New visitor context has no inherited Owner session');
  check(st, await visitor.page.locator('article.lh-bookmark[data-link-id="' + saved.value.id + '"]').count() > 0, 'Anonymous public visitor sees the real saved shared bookmark');
  equal(st, await button(st, visitor, '添加第一个链接', 'Add your first link').count(), 0, 'Read-only visitor does not receive the empty-state editor shortcut');
  await screenshot(st, visitor, 'shared-bookmark-visible');
}
async function privateScenario(st, side, identity, mode) {
  step(st, 'Private setup, initial Owner and registration defaults');
  await fillSetup(st, side, identity, mode);
  if (mode === 'private_multi') await responsive(st, side, 'setup-private-multi', () => [
    { name: 'site name', locator: field(st, side, '站点名称', 'Site name') },
    { name: 'create Home', locator: button(st, side, '创建我的 Home', 'Create my Home') }
  ]);
  await submitSetup(st, side);
  const configured = await assertConfigured(st, side, identity, mode, true, false);
  await waitHome(st, side, configured.personal);
  await assertLightweight(st, side, configured.personal);
  await naturalReload(st, side, configured.personal, 'Private default landing');
  if (mode === 'private_multi') {
    await enterAccessSettings(st, side);
    equal(st, await side.page.getByRole('checkbox', { name: l(st, '允许访客自行注册 Member 账号', 'Allow visitors to register member accounts'), exact: true }).isChecked(), false, 'Actual access settings show self-registration disabled');
    const users = await get(st, side, '/admin/users');
    equal(st, users.length, 1, 'Multi-user initialization creates only one account');
    equal(st, users[0].role, 'Owner', 'The only initial account is the Owner');
    await returnHome(st, side, configured.personal);
  }
  step(st, 'Anonymous private visit and same-account login after sign-out');
  const visitor = await visitAnonymous(st);
  await waitLogin(st, visitor);
  const guest = await readBoot(st, visitor);
  equal(st, guest.spaces.length, 0, 'Anonymous private visitor receives no accessible spaces');
  equal(st, await button(st, visitor, '创建个人空间', 'Create a personal space').count(), 0, 'Private login offers no registration while registration is disabled');
  await signOut(st, side); await waitLogin(st, side);
  await signIn(st, side, identity); await waitHome(st, side, configured.personal);
  equal(st, (await readBoot(st, side)).user.id, configured.boot.user.id, 'Relogin uses the exact original Owner, not another account');
}
async function openScenario(st, side, identity, createAtSetup) {
  step(st, createAtSetup ? 'Open editing with optional Owner during setup' : 'Account-free open editing followed by optional first Owner');
  await fillSetup(st, side, identity, 'open_edit', false, createAtSetup);
  await submitSetup(st, side);
  let configured = await assertConfigured(st, side, identity, 'open_edit', createAtSetup, false);
  await waitHome(st, side, configured.shared);
  await assertLightweight(st, side, configured.shared);
  await naturalReload(st, side, configured.shared, 'Open-edit shared landing');
  if (!createAtSetup) {
    equal(st, (await get(st, side, '/settings')).hasOwner, false, 'Account-free setup does not create a hidden Owner');
    await enterAccessSettings(st, side);
    const optional = side.page.getByRole('checkbox', { name: l(st, '同时创建首个管理员（可选）', 'Also create the first administrator (optional)'), exact: true });
    equal(st, await optional.isChecked(), false, 'Accounts makes first-Owner creation explicitly optional');
    equal(st, await modeRadio(st, side, 'open_edit', 'access-mode').isChecked(), true, 'Accounts still shows open editing before Owner creation');
    equal(st, await field(st, side, '用户名', 'Username').count(), 0, 'First-Owner credential fields are absent until selected');
    await optional.click(); await fillIdentity(st, side, identity);
    await writeUI(st, side, 'PUT', '/settings', 200, () => button(st, side, '保存访问设置', 'Save access settings').click(), 'Create first Owner in Access and accounts');
    await settle(st, side);
    configured = await assertConfigured(st, side, identity, 'open_edit', true, false);
    equal(st, (await get(st, side, '/settings')).hasOwner, true, 'Accounts persists the newly created Owner');
    equal(st, await optional.count(), 0, 'First-Owner option disappears after successful account creation');
    equal(st, await field(st, side, '密码', 'Password').count(), 0, 'First-Owner password field is removed after saving');
    equal(st, await modeRadio(st, side, 'open_edit', 'access-mode').isChecked(), true, 'Optional Owner creation does not silently switch the access mode');
    await button(st, side, '返回导航', 'Back to Home').click();
    await waitHome(st, side, { kind: 'personal' });
  } else equal(st, (await get(st, side, '/settings')).hasOwner, true, 'Setup optional Owner is persisted');
  const visitor = await visitAnonymous(st);
  await waitHome(st, visitor, configured.shared);
  const guest = await readBoot(st, visitor);
  equal(st, guest.user, null, 'Open-edit visitor remains anonymous');
  equal(st, guest.mode, 'open_edit', 'Adding an Owner keeps the documented open-edit mode');
  equal(st, guest.spaces.length, 1, 'Anonymous open-edit visitor receives only the shared space');
  equal(st, guest.spaces[0].canEdit, true, 'Anonymous shared editing remains available after Owner creation');
  check(st, await button(st, visitor, '添加第一个链接', 'Add your first link').isVisible(), 'Open-edit visitor still has the real empty-state editing entry');
  await screenshot(st, visitor, 'anonymous-open-edit');
}
async function recoveryUncommitted(st, side, identity) {
  step(st, 'Uncommitted setup request fails without losing form values');
  await fillSetup(st, side, identity, 'public_read', false);
  await abortSetup(st, side, false);
  equal(st, (await readBoot(st, side)).initialized, false, 'Aborted request did not initialize the server');
  await recheck(st, side, false);
  check(st, await side.page.getByRole('status').filter({ hasText: l(st, '尚未完成初始化。你的输入已保留', 'Setup is not complete. Your entries are preserved') }).isVisible(), 'Recovery explicitly says setup is incomplete and entries are preserved');
  equal(st, await field(st, side, '站点名称', 'Site name').inputValue(), identity.siteName, 'Recovery preserves the site name');
  equal(st, await field(st, side, '用户名', 'Username').inputValue(), identity.username, 'Recovery preserves the username');
  equal(st, await field(st, side, '显示名称', 'Display name').inputValue(), identity.displayName, 'Recovery preserves the display name');
  check(st, await field(st, side, '密码', 'Password').inputValue() === identity.password, 'Recovery preserves the password in the existing form without logging it');
  equal(st, await modeRadio(st, side, 'public_read', 'setup-mode').isChecked(), true, 'Recovery preserves the selected access mode');
  equal(st, await side.page.getByRole('checkbox', { name: l(st, '填充示例导航', 'Add example bookmarks'), exact: true }).isChecked(), false, 'Recovery preserves the unselected example choice');
  equal(st, setupCount(st, side), 1, 'Reading recovery state still has not retried the setup POST');
  step(st, 'User explicitly retries once after an uncommitted failure');
  await submitSetup(st, side);
  const configured = await assertConfigured(st, side, identity, 'public_read', true, false);
  await waitHome(st, side, configured.shared);
  equal(st, setupCount(st, side), 2, 'Only the explicit second submit sends the second setup POST');
  await naturalReload(st, side, configured.shared, 'Recovered public setup landing');
}
async function recoveryCommitted(st, side, identity) {
  step(st, 'Real private setup commits but its response and session delivery are lost');
  await fillSetup(st, side, identity, 'private_single');
  await abortSetup(st, side, true);
  check(st, !!side.committedOwnerId, 'Successful hidden response identified the created Owner');
  await side.context.clearCookies();
  const afterLoss = await readBoot(st, side);
  equal(st, afterLoss.initialized, true, 'Server remains initialized after simulated response loss');
  equal(st, afterLoss.user, null, 'Cookie loss leaves this browser genuinely unauthenticated');
  step(st, 'Explicit status recovery follows actual identity to login without a setup retry');
  const recovered = await recheck(st, side, true);
  equal(st, recovered.user, null, 'Recovery does not infer account ownership from typed credentials');
  await waitLogin(st, side);
  equal(st, await field(st, side, '密码', 'Password').inputValue(), '', 'Recovery clears the old setup password before login');
  equal(st, setupCount(st, side), 1, 'Committed-response recovery has sent exactly one setup POST');
  await signIn(st, side, identity);
  const configured = await assertConfigured(st, side, identity, 'private_single', true, false);
  equal(st, configured.boot.user.id, side.committedOwnerId, 'UI login uses the very Owner created by the original committed request');
  await waitHome(st, side, configured.personal);
  equal(st, setupCount(st, side), 1, 'Login never resubmits setup');
  await naturalReload(st, side, configured.personal, 'Committed recovery after actual login');
}
async function conflictScenario(st, side, identity) {
  step(st, 'Two independent contexts fill setup before either submits');
  const competitor = await newSide(st, 'competing-window');
  await openSetup(st, competitor);
  const other = credentials(st, 'second');
  await fillSetup(st, side, identity, 'private_multi');
  await fillSetup(st, competitor, other, 'private_multi');
  await submitSetup(st, side);
  const configured = await assertConfigured(st, side, identity, 'private_multi', true, false);
  await waitHome(st, side, configured.personal);
  step(st, 'Second window receives a real conflict and explicitly rechecks state');
  await submitSetup(st, competitor, 409);
  await button(st, competitor, '重新检查初始化状态', 'Check setup status again').waitFor();
  await settle(st, competitor);
  equal(st, await field(st, competitor, '用户名', 'Username').inputValue(), other.username, 'Conflict keeps the second-window entries until explicit recovery');
  equal(st, setupCount(st, competitor), 1, 'Conflict does not automatically retry setup');
  const recovered = await recheck(st, competitor, true);
  equal(st, recovered.user, null, 'Second context does not inherit the winning context session');
  await waitLogin(st, competitor);
  equal(st, await field(st, competitor, '密码', 'Password').inputValue(), '', 'Conflict recovery clears obsolete setup credentials');
  await signIn(st, competitor, identity);
  await waitHome(st, competitor, configured.personal);
  const boot = await readBoot(st, competitor);
  equal(st, boot.user.id, configured.boot.user.id, 'Second context can sign in to the original, winning Owner');
  equal(st, boot.siteName, identity.siteName, 'Losing setup does not overwrite the winning site settings');
  const users = await get(st, competitor, '/admin/users');
  equal(st, users.length, 1, 'Real account inventory contains exactly one user after the conflict');
  equal(st, users[0].id, configured.boot.user.id, 'The single user is the original Owner');
  check(st, users.every(user => user.username !== other.username), 'No second Owner or account was created from the losing form');
  equal(st, setupCount(st, side), 1, 'Winning context submitted setup once');
  equal(st, setupCount(st, competitor), 1, 'Losing context submitted setup once and recovered without re-POST');
}

function expectedFailure(item) {
  return item.path === '/api/v1/setup' && item.method === 'POST' &&
    (item.fault === 'uncommitted-request' || item.fault === 'committed-response-lost') &&
    /^net::ERR_(?:FAILED|ABORTED)$/.test(item.failure || '');
}
function expectedHTTP(item) {
  return item.path === '/api/v1/setup' && item.method === 'POST' && item.status === 409 && item.expectedStatus === 409 && item.code === 'conflict';
}
async function audit(st) {
  await drain(st);
  st.result.unexpectedHTTP = st.result.requests.filter(item => item.status >= 400 && !expectedHTTP(item));
  st.result.unexpectedFailedRequests = st.result.requests.filter(item => item.failure && !expectedFailure(item));
  for (const entry of st.result.console) {
    if (entry.type !== 'error') continue;
    const related = st.result.requests.filter(item => item.context === entry.context && item.phase === entry.phase && item.path === '/api/v1/setup');
    const matchesPath = entry.path === '/api/v1/setup' || (!entry.path && related.length === 1);
    entry.expected = !!matchesPath && (
      related.some(item => expectedFailure(item)) && /Failed to load resource: net::ERR_(?:FAILED|ABORTED)/.test(entry.text) ||
      related.some(item => expectedHTTP(item)) && /Failed to load resource: the server responded with a status of 409\b/.test(entry.text)
    );
    if (!entry.expected) st.result.unexpectedConsole.push(entry);
  }
  equal(st, st.result.forbiddenRequests.length, 0, 'No foreign request or unauthorized write was attempted');
  equal(st, st.result.websocketAttempts.length, 0, 'No browser WebSocket was opened or attempted');
  equal(st, st.result.pageErrors.length, 0, 'Browser runtime has no page errors');
  equal(st, st.result.harnessErrors.length, 0, 'Harness has no interception, response-inspection or extra-page errors');
  equal(st, st.result.unexpectedHTTP.length, 0, 'HTTP errors are limited to the verified real setup conflict');
  equal(st, st.result.unexpectedFailedRequests.length, 0, 'Failed requests are limited to the precise injected setup faults');
  equal(st, st.result.unexpectedConsole.length, 0, 'Browser console has no errors beyond the retained, matched setup fault evidence');
}
function finalizePhases(st) {
  st.result.phases.forEach((phase, index) => {
    phase.checks = (st.result.phases[index + 1]?.checksAtStart ?? st.result.checks) - phase.checksAtStart;
  });
}
function saveReport() {
  for (const st of states) finalizePhases(st);
  report.checks = report.fixtures.reduce((sum, fixture) => sum + fixture.checks, 0);
  report.completedAt = new Date().toISOString();
  report.elapsedSeconds = Number(((performance.now() - started) / 1000).toFixed(3));
  report.totals = {
    fixtures: report.fixtures.length,
    passed: report.fixtures.filter(fixture => fixture.status === 'passed').length,
    failed: report.fixtures.filter(fixture => fixture.status === 'failed').length,
    pending: report.fixtures.filter(fixture => fixture.status === 'pending').length,
    assertions: report.checks
  };
  if (options) {
    // Individual diagnostics are bounded above; the complete structured report
    // must never be truncated or rewritten as a free-form diagnostic string.
    let serialized = JSON.stringify(report, null, 2);
    for (const secret of secrets) serialized = serialized.split(secret).join('[REDACTED]');
    fs.writeFileSync(path.join(options.outputDir, 'initialization-report.json'), serialized + '\n', { mode: 0o600 });
  }
}
async function runFixture(st) {
  const side = st.sides[0], identity = credentials(st);
  st.result.status = 'running';
  try {
    step(st, 'Load the actual fresh setup UI');
    await openSetup(st, side);
    switch (st.fixture.scenario) {
      case 'seed': await seedScenario(st, side, identity); break;
      case 'blank': await blankScenario(st, side, identity); break;
      case 'private_single': await privateScenario(st, side, identity, 'private_single'); break;
      case 'private_multi': await privateScenario(st, side, identity, 'private_multi'); break;
      case 'open_ownerless': await openScenario(st, side, identity, false); break;
      case 'open_owner': await openScenario(st, side, identity, true); break;
      case 'recover_uncommitted': await recoveryUncommitted(st, side, identity); break;
      case 'recover_committed': await recoveryCommitted(st, side, identity); break;
      case 'conflict': await conflictScenario(st, side, identity); break;
      case 'language_choice': await languageChoiceScenario(st, side, identity); break;
    }
    step(st, 'Final browser and request audit');
    for (const current of st.sides) if (current.page && !current.page.isClosed()) await settle(st, current);
    const expectedPosts = ['conflict', 'recover_uncommitted'].includes(st.fixture.scenario) ? 2 : 1;
    equal(st, setupCount(st), expectedPosts, 'Scenario sends exactly the intended total number of setup POST requests');
    equal(st, languageChoiceCount(st), st.fixture.scenario === 'language_choice' ? 1 : 0, 'Only the pending-language scenario submits one explicit language-selection request');
    await audit(st);
    await screenshot(st, side, 'final');
    st.result.status = 'passed';
  } catch (error) {
    st.result.status = 'failed';
    st.result.failure = { phase: st.phase, message: sanitize(error.message), stack: sanitize(error.stack) };
    await drain(st);
    for (const current of st.sides) {
      try { await screenshot(st, current, 'failure'); }
      catch (captureError) { st.result.harnessErrors.push({ ...stamp(st, current), error: 'Failure screenshot: ' + sanitize(captureError.message) }); }
    }
    // Classify evidence even when the scenario stops before its normal audit.
    try { await audit(st); } catch (auditError) { st.result.auditFailure = sanitize(auditError.message); }
  } finally {
    st.closing = true;
    for (const current of st.sides) await current.context.close().catch(() => {});
    finalizePhases(st); saveReport();
    process.stdout.write(JSON.stringify({ fixture: st.fixture.name, status: st.result.status, phase: st.phase, checks: st.result.checks }) + '\n');
  }
}
async function main() {
  options = parseOptions();
  if (!options) return;
  report.expectedVersion = options.expectedVersion;
  const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({
    headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--disable-dev-shm-usage', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])]
  });
  report.browserVersion = browser.version();
  // A bad fixture aborts the entire batch before any setup form is submitted.
  for (const [index, fixture] of options.fixtures.entries()) {
    const st = newState(fixture, index); step(st, 'Read-only preflight of all disposable fixtures');
    try { await verifyFresh(st, await newSide(st, 'main')); }
    catch (error) {
      st.result.status = 'failed'; st.result.failure = { phase: st.phase, message: sanitize(error.message) };
      throw new Error('Batch preflight failed for ' + fixture.name + '; no UI writes were authorized. ' + sanitize(error.message));
    }
  }
  report.preflightComplete = true;
  for (const st of states) st.ready = true;
  for (const st of states) await runFixture(st);
  report.status = states.every(st => st.result.status === 'passed') ? 'passed' : 'failed';
  if (report.status !== 'passed') process.exitCode = 1;
}
main().catch(error => {
  report.status = 'failed'; report.failure = sanitize(error.message);
  process.stderr.write(sanitize(error.stack) + '\n'); process.exitCode = 1;
}).finally(async () => {
  for (const st of states) {
    st.closing = true;
    for (const side of st.sides) await side.context.close().catch(() => {});
  }
  if (browser) await browser.close().catch(() => {});
  if (options) {
    saveReport();
    process.stdout.write(JSON.stringify({ status: report.status, checks: report.checks, fixtures: report.totals, report: path.join(options.outputDir, 'initialization-report.json') }) + '\n');
  }
});
