#!/usr/bin/env node
'use strict';

/**
 * One-time language recovery on two disposable, pending-language instances.
 * Fixtures: [{ name, url, language: 'en', scenario: 'uncommitted' },
 *            { name, url, language: 'en', scenario: 'committed_response_lost' }].
 * Both origins must be fresh, unique loopback origins. Every instance passes
 * read-only preflight before any write. All writes originate from UI buttons
 * with real CSRF; route.fetch forwards only the explicitly injected request.
 * This test never submits site setup, creates accounts, or contacts websites.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const protectedPorts = new Set(['5180', '5182', '5183', '5184', '5185', '5194', '5195']);
const scenarios = new Set(['uncommitted', 'committed_response_lost']);
const languagePath = '/api/v1/setup/language';
const report = {
  runId, startedAt: new Date().toISOString(), status: 'running', preflightComplete: false,
  scope: 'Two fresh pending-language loopback instances. Only the language-confirmation UI writes; no site initialization or account creation. Faults preserve the real CSRF request. No headers, bodies, cookies or storage dumps are recorded.',
  fixtures: []
};
let options, browser;
const states = [];

function clean(value) {
  return String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, raw => {
    try { const url = new URL(raw); return url.origin + url.pathname; } catch { return '[URL]'; }
  }).slice(0, 12000);
}
function requestPath(raw) { try { return new URL(raw).pathname; } catch { return null; } }
function equal(st, actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  st.result.assertions.push({ phase: st.phase, label });
}
function check(st, value, label) {
  assert.ok(value, label);
  st.result.assertions.push({ phase: st.phase, label });
}
function phase(st, name) {
  st.phase = name;
  process.stdout.write(JSON.stringify({ fixture: st.fixture.name, scenario: st.fixture.scenario, phase: name }) + '\n');
}
function postCount(st) { return st.result.requests.filter(item => item.method === 'POST' && item.path === languagePath).length; }
function parseOptions() {
  const value = { allowWrite: false, expectedVersion: '0.0.1', outputDir: path.join(os.tmpdir(), 'home-language-recovery-' + runId) };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (['--help', '-h'].includes(args[i])) {
      process.stdout.write('Usage: node tests/browser_language_recovery.cjs --fixtures <JSON-file-or-array> --output-dir <directory> --allow-write [--expected-version 0.0.1]\nExactly two English fixtures: uncommitted, committed_response_lost. Fresh unique loopback origins only.\nEnvironment: LINGSHU_PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE\n');
      return null;
    }
    if (args[i] === '--allow-write') { value.allowWrite = true; continue; }
    const key = { '--fixtures': 'fixturesArg', '--output-dir': 'outputDir', '--expected-version': 'expectedVersion' }[args[i]];
    assert.ok(key && args[i + 1] && !args[i + 1].startsWith('--'), 'Unknown or incomplete option');
    value[key] = args[++i];
  }
  assert.ok(value.allowWrite, 'Explicit --allow-write is required');
  assert.ok(value.fixturesArg, '--fixtures is required');
  assert.match(value.expectedVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const input = value.fixturesArg.trim().startsWith('[') ? value.fixturesArg : fs.readFileSync(value.fixturesArg, 'utf8');
  const fixtures = JSON.parse(input), origins = new Set(), ports = new Set(), names = new Set(), seenScenarios = new Set();
  assert.ok(Array.isArray(fixtures) && fixtures.length === 2, 'Exactly two disposable fixtures are required');
  value.fixtures = fixtures.map(item => {
    assert.ok(item && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 100 && !/[\u0000-\u001f]/.test(item.name), 'Each fixture needs a short nonempty name');
    assert.ok(!names.has(item.name), 'Fixture names must be unique'); names.add(item.name);
    assert.ok(scenarios.has(item.scenario) && !seenScenarios.has(item.scenario), 'Each recovery scenario must appear exactly once'); seenScenarios.add(item.scenario);
    assert.equal(item.language, 'en', 'These recovery fixtures must target English');
    const url = new URL(item.url);
    assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Use a plain origin without credentials, path, query or fragment');
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    assert.ok(host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host), 'Only loopback test instances are allowed');
    assert.ok(url.port && !protectedPorts.has(url.port), 'An explicit disposable port outside all protected instances is required');
    assert.ok(!ports.has(url.port), 'Each recovery fixture must use a separate disposable port'); ports.add(url.port);
    assert.ok(!origins.has(url.origin), 'Recovery fixtures must have independent unique origins'); origins.add(url.origin);
    return { name: item.name, url: url.origin, language: 'en', scenario: item.scenario };
  });
  value.outputDir = path.resolve(value.outputDir);
  fs.mkdirSync(value.outputDir, { recursive: true, mode: 0o700 });
  assert.ok(!fs.existsSync(path.join(value.outputDir, 'language-recovery-report.json')), 'Refusing to overwrite an existing report');
  return value;
}
async function freshState(fixture, index) {
  const result = { ...fixture, status: 'pending', assertions: [], requests: [], observations: [], faults: [], console: [], pageErrors: [], forbidden: [], sockets: [], harnessErrors: [], screenshots: [] };
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: 'en-US', reducedMotion: 'reduce', serviceWorkers: 'block' });
  context.setDefaultTimeout(20000); context.setDefaultNavigationTimeout(30000);
  const st = { fixture, index, result, context, page: null, phase: 'preflight', ready: false, permit: null, requests: new WeakMap(), closing: false };
  states.push(st); report.fixtures.push(result);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) { await route.continue(); return; }
    if (url.origin !== fixture.url) {
      result.forbidden.push({ phase: st.phase, method: request.method(), path: url.pathname, reason: 'Foreign origin' });
      await route.abort('blockedbyclient'); return;
    }
    if (['GET', 'HEAD'].includes(request.method())) { await route.continue(); return; }
    const permit = st.permit;
    if (!st.ready || !permit || permit.remaining !== 1 || request.method() !== 'POST' || url.pathname !== languagePath) {
      result.forbidden.push({ phase: st.phase, method: request.method(), path: url.pathname, reason: 'No explicit single-request language UI permit' });
      await route.abort('blockedbyclient'); return;
    }
    permit.remaining--;
    const item = st.requests.get(request);
    if (item) { item.permitted = true; item.fault = permit.fault || null; item.hasCSRF = !!request.headers()['x-csrf-token']; }
    if (!permit.fault) { await route.continue(); return; }
    const fault = { phase: st.phase, kind: permit.fault, forwarded: false };
    result.faults.push(fault);
    try {
      if (permit.fault === 'committed_response_lost') {
        const upstream = await route.fetch({ timeout: 30000, maxRedirects: 0 });
        fault.forwarded = true; fault.status = upstream.status();
        equal(st, upstream.status(), 200, 'Forwarded language request really commits with HTTP 200');
        const value = await upstream.json();
        equal(st, value.language, 'en', 'Committed response confirms English');
        equal(st, value.languageSelectionRequired, false, 'Committed response confirms the language lock');
        equal(st, value.initialized, false, 'Forwarded language request does not initialize the site');
        equal(st, value.user, null, 'Forwarded language request creates no account or session identity');
        await upstream.dispose();
      }
    } catch (error) { result.harnessErrors.push({ phase: st.phase, error: clean(error.message) }); }
    await route.abort('failed');
  });
  assert.equal(typeof context.routeWebSocket, 'function', 'Playwright routeWebSocket is required');
  await context.routeWebSocket('**/*', async socket => { result.sockets.push({ phase: st.phase, path: requestPath(socket.url()) }); await socket.close(); });
  context.on('page', page => {
    if (st.page && st.page !== page) result.harnessErrors.push({ phase: st.phase, error: 'Unexpected extra page' });
    if (!st.page) st.page = page;
    page.on('request', request => {
      if (st.closing) return;
      const item = { phase: st.phase, method: request.method(), path: requestPath(request.url()), resourceType: request.resourceType() };
      st.requests.set(request, item); result.requests.push(item);
    });
    page.on('response', response => { const item = st.requests.get(response.request()); if (item && !st.closing) item.status = response.status(); });
    page.on('requestfailed', request => { const item = st.requests.get(request); if (item && !st.closing) item.failure = clean(request.failure()?.errorText); });
    page.on('console', message => { if (!st.closing) result.console.push({ phase: st.phase, type: message.type(), text: clean(message.text()), path: requestPath(message.location().url) }); });
    page.on('pageerror', error => { if (!st.closing) result.pageErrors.push({ phase: st.phase, error: clean(error.message) }); });
    page.on('dialog', async dialog => { result.harnessErrors.push({ phase: st.phase, error: 'Unexpected native dialog: ' + dialog.type() }); await dialog.dismiss(); });
    page.on('websocket', socket => { if (!st.closing) result.sockets.push({ phase: st.phase, path: requestPath(socket.url()), kind: 'browser-event' }); });
  });
  return st;
}
async function readBoot(st, pending) {
  const response = await st.context.request.get(st.fixture.url + '/api/v1/bootstrap', { timeout: 20000, maxRedirects: 0, failOnStatusCode: false });
  st.result.observations.push({ phase: st.phase, method: 'GET', path: '/api/v1/bootstrap', status: response.status() });
  equal(st, response.status(), 200, 'Read-only bootstrap succeeds');
  const value = await response.json();
  equal(st, value.version, options.expectedVersion, 'Expected application version is running');
  equal(st, value.initialized, false, 'Disposable instance remains uninitialized');
  equal(st, value.user, null, 'No authenticated account exists');
  equal(st, value.languageSelectionRequired, pending, 'Bootstrap reports the actual pending or locked language state');
  if (!pending) equal(st, value.language, 'en', 'Persisted instance language is English');
  return value;
}
async function settle(st) {
  await st.page.waitForLoadState('networkidle');
  await st.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function screenshot(st, label) {
  if (!st.page || st.page.isClosed()) return;
  const name = `${st.index + 1}-${st.fixture.scenario}-${label}.png`;
  await st.page.screenshot({ path: path.join(options.outputDir, name), fullPage: true, mask: [st.page.locator('input[type="password"]')] });
  st.result.screenshots.push({ phase: st.phase, file: name });
}
async function confirm(st, fault) {
  assert.ok(!st.permit, 'UI write permits cannot overlap');
  st.permit = { remaining: 1, fault };
  try {
    const pending = fault
      ? st.page.waitForEvent('requestfailed', { predicate: request => request.url() === st.fixture.url + languagePath && request.method() === 'POST', timeout: 30000 })
      : st.page.waitForResponse(response => response.url() === st.fixture.url + languagePath && response.request().method() === 'POST', { timeout: 30000 });
    const [result] = await Promise.all([pending, st.page.getByRole('button', { name: 'Continue in English', exact: true }).click()]);
    equal(st, st.permit.remaining, 0, 'Explicit confirmation consumes exactly one permitted UI write');
    if (!fault) {
      equal(st, result.status(), 200, 'Explicit retry succeeds with real HTTP 200 and CSRF');
      const value = await result.json();
      equal(st, value.language, 'en', 'Explicit retry returns English');
      equal(st, value.languageSelectionRequired, false, 'Explicit retry locks the language');
      equal(st, value.initialized, false, 'Explicit retry still creates no site');
    }
  } finally { st.permit = null; }
}
async function assertLockedSetup(st) {
  await st.page.getByRole('heading', { level: 1, name: 'Set up Home', exact: true }).waitFor();
  await settle(st);
  equal(st, await st.page.locator('input[name="setup-language"]').count(), 0, 'Locked initialization offers no language radio');
  equal(st, await st.page.getByRole('combobox').count(), 0, 'Locked initialization offers no alternate content-language selector');
  check(st, await st.page.getByText('Language is set to English. Example content will match automatically.', { exact: true }).isVisible(), 'Initialization visibly explains the confirmed language');
  equal(st, await st.page.locator('html').getAttribute('lang'), 'en', 'Document language updates to English');
}
function audit(st) {
  const faultRequest = item => item.path === languagePath && item.method === 'POST' && item.permitted && scenarios.has(item.fault) && /^net::ERR_(?:FAILED|ABORTED)$/.test(item.failure || '');
  const unexpectedConsole = st.result.console.filter(entry => {
    if (entry.type !== 'error') return false;
    const related = st.result.requests.filter(item => item.phase === entry.phase && faultRequest(item));
    entry.expected = related.length === 1 && (entry.path === languagePath || !entry.path) && /Failed to load resource: net::ERR_(?:FAILED|ABORTED)/.test(entry.text);
    return !entry.expected;
  });
  equal(st, st.result.forbidden.length, 0, 'No foreign request or unpermitted write was attempted');
  equal(st, st.result.sockets.length, 0, 'No WebSocket was opened or attempted');
  equal(st, st.result.pageErrors.length, 0, 'No browser runtime error occurred');
  equal(st, st.result.harnessErrors.length, 0, 'No harness or injected-commit verification error occurred');
  equal(st, st.result.requests.filter(item => item.status >= 400).length, 0, 'No real HTTP error occurred');
  equal(st, st.result.requests.filter(item => item.failure && !faultRequest(item)).length, 0, 'Only the precise injected request failed');
  equal(st, unexpectedConsole.length, 0, 'Console errors match only the retained injection evidence');
  equal(st, st.result.requests.filter(item => !['GET', 'HEAD'].includes(item.method) && item.path !== languagePath).length, 0, 'No site setup, account or other business write occurred');
  check(st, st.result.requests.filter(item => item.method === 'POST').every(item => item.permitted && item.hasCSRF), 'Every POST used the explicit UI permit and a real CSRF header');
}
async function runScenario(st) {
  st.result.status = 'running';
  try {
    phase(st, 'Open pending language UI');
    st.page = await st.context.newPage();
    await st.page.goto(st.fixture.url + '/', { waitUntil: 'networkidle' });
    await st.page.getByRole('heading', { level: 1, name: /选择语言|Choose your language/ }).waitFor();
    equal(st, await st.page.locator('input[name="setup-language"]:checked').count(), 0, 'Fresh language UI makes no implicit choice');
    await st.page.locator('input[name="setup-language"][value="en"]').check();
    phase(st, 'Inject precisely one language request failure');
    await confirm(st, st.fixture.scenario);
    const recheck = st.page.getByRole('button', { name: '重新检查 / Check again', exact: true });
    await recheck.waitFor(); await settle(st);
    equal(st, postCount(st), 1, 'The failed response causes no automatic POST retry');
    equal(st, st.result.faults.length, 1, 'Exactly one explicit fault was injected');
    equal(st, st.result.faults[0].forwarded, st.fixture.scenario === 'committed_response_lost', 'Evidence distinguishes no server delivery from a real committed request');
    equal(st, await st.page.locator('input[name="setup-language"]').count(), 2, 'Failure preserves both visible language choices');
    for (const language of ['zh-CN', 'en']) equal(st, await st.page.locator(`input[name="setup-language"][value="${language}"]`).isDisabled(), true, 'Unknown outcome disables changes to ' + language);
    equal(st, await st.page.locator('.auth-language button[type="submit"]').isDisabled(), true, 'Unknown outcome disables resubmission');
    equal(st, await recheck.isEnabled(), true, 'Explicit status recheck remains available');
    await screenshot(st, 'unknown-result');

    phase(st, 'Explicitly recheck the real server state');
    const [response] = await Promise.all([
      st.page.waitForResponse(value => value.url() === st.fixture.url + '/api/v1/bootstrap' && value.request().method() === 'GET'),
      recheck.click()
    ]);
    equal(st, response.status(), 200, 'Recovery reads actual bootstrap with GET');
    const value = await response.json(), pending = st.fixture.scenario === 'uncommitted';
    equal(st, value.initialized, false, 'Recovery does not initialize the site');
    equal(st, value.user, null, 'Recovery has no account identity');
    equal(st, value.languageSelectionRequired, pending, 'Recovery follows the actual pending or committed language state');
    await settle(st);
    equal(st, postCount(st), 1, 'Status recheck never re-POSTs the language');
    if (pending) {
      phase(st, 'Explicit retry only after pending state is confirmed');
      for (const language of ['zh-CN', 'en']) equal(st, await st.page.locator(`input[name="setup-language"][value="${language}"]`).isEnabled(), true, 'Confirmed pending state restores ' + language + ' choice');
      check(st, await st.page.getByRole('status').filter({ hasText: 'No language has been confirmed' }).isVisible(), 'Recovery explains that no language has been confirmed');
      await st.page.locator('input[name="setup-language"][value="en"]').check();
      await confirm(st, null);
    } else equal(st, value.language, 'en', 'Recovery retrieves the language committed by the lost response');
    await assertLockedSetup(st);
    await readBoot(st, false);
    await screenshot(st, 'locked-setup');
    phase(st, 'Natural reload retains the lock without site setup');
    await st.page.reload({ waitUntil: 'networkidle' });
    await assertLockedSetup(st);
    equal(st, await st.page.evaluate(() => performance.getEntriesByType('navigation')[0]?.type), 'reload', 'Lock survives a real document reload');
    await readBoot(st, false);
    equal(st, postCount(st), pending ? 2 : 1, 'Scenario performs only the explicitly intended language POST requests');
    audit(st);
    st.result.status = 'passed';
  } catch (error) {
    st.result.status = 'failed'; st.result.failure = { phase: st.phase, message: clean(error.message), stack: clean(error.stack) };
    try { await screenshot(st, 'failure'); } catch (captureError) { st.result.harnessErrors.push({ phase: st.phase, error: clean(captureError.message) }); }
    try { audit(st); } catch (auditError) { st.result.auditFailure = clean(auditError.message); }
  } finally {
    st.closing = true; await st.context.close().catch(() => {}); saveReport();
    process.stdout.write(JSON.stringify({ fixture: st.fixture.name, status: st.result.status, checks: st.result.assertions.length }) + '\n');
  }
}
function saveReport() {
  if (!options) return;
  report.completedAt = new Date().toISOString();
  report.checks = report.fixtures.reduce((sum, item) => sum + item.assertions.length, 0);
  fs.writeFileSync(path.join(options.outputDir, 'language-recovery-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
async function main() {
  options = parseOptions(); if (!options) return;
  report.expectedVersion = options.expectedVersion;
  const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--disable-dev-shm-usage', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])] });
  report.browserVersion = browser.version();
  for (const [index, fixture] of options.fixtures.entries()) {
    const st = await freshState(fixture, index);
    phase(st, 'Read-only preflight before any write in the batch');
    try { await readBoot(st, true); }
    catch (error) { st.result.status = 'failed'; st.result.failure = { phase: st.phase, message: clean(error.message) }; throw error; }
  }
  report.preflightComplete = true;
  for (const st of states) st.ready = true;
  for (const st of states) await runScenario(st);
  report.status = states.every(st => st.result.status === 'passed') ? 'passed' : 'failed';
  if (report.status === 'failed') process.exitCode = 1;
}
main().catch(error => {
  report.status = 'failed'; report.failure = clean(error.message); process.exitCode = 1;
  process.stderr.write(clean(error.stack) + '\n');
}).finally(async () => {
  for (const st of states) { st.closing = true; await st.context.close().catch(() => {}); }
  if (browser) await browser.close().catch(() => {});
  if (options) { saveReport(); process.stdout.write(JSON.stringify({ status: report.status, checks: report.checks, report: path.join(options.outputDir, 'language-recovery-report.json') }) + '\n'); }
});
