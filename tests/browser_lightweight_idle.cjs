#!/usr/bin/env node
'use strict';
/** Read-only cold-home and foreground-idle acceptance.
 * BASE_URL=http://127.0.0.1:5200 node tests/browser_lightweight_idle.cjs
 * Requires an already initialized, anonymously readable, local-navigation home.
 * Never initializes an instance, signs in, creates a source, or performs a write.
 * --guard-only validates the target without loading Playwright or making requests.
 * Browser requests and WebSocket attempts are observed; no response is mocked.
 * Forbidden requests are blocked and remain failures. A routed WebSocket is closed
 * without connecting to its server. The idle window is always at least 65 seconds.
 * This measures browser HTTP/WS activity, not server CPU/RAM, background workers,
 * HTTP-cache effectiveness, field performance, or the contents of the main bundle.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const runId = randomUUID().slice(0, 12), timeout = 20000, idleDurationMs = 65000;
const reportPath = path.resolve(process.env.REPORT_PATH || path.join(os.tmpdir(), `home-lightweight-idle-${runId}.json`));
const screenshotDirectory = path.resolve(process.env.SCREENSHOT_DIR || path.join(path.dirname(reportPath), `home-lightweight-idle-${runId}`));
const viewport = { width: 2560, height: 1440 };
const protectedPorts = new Set(['5180', '5182', '5183', '5184', '5185', '5194', '5195']);
const navigationPanels = new Set(['builtin/search', 'builtin/category-navigation', 'builtin/navigation', 'builtin/favorites']);
// Vite chunk stems are stable enough to identify optional imports; hashes are not.
const optionalChunks = [
  { name: 'DataPanels', stem: /^(?:DataPanels|data-panels)(?:[-.]|$)/i },
  { name: 'TrafficPanel', stem: /^(?:TrafficPanel|traffic-panel)(?:[-.]|$)/i },
  { name: 'WidgetImportDialog', stem: /^(?:WidgetImportDialog|widget-import)(?:[-.]|$)/i },
  { name: 'DashboardPresetDialog', stem: /^(?:DashboardPresetDialog|dashboard-presets-dialog)(?:[-.]|$)/i },
  { name: 'HomeEditor', stem: /^(?:HomeEditor|home-editor)(?:[-.]|$)/i }
];
const started = performance.now();
const report = {
  runId, measuredAt: new Date().toISOString(), baseURL: null, browser: null, viewport,
  method: 'Fresh anonymous Chromium context; same-origin GET/HEAD only; service workers blocked; WebSocket attempts closed before server connection; no UI interaction after ready; 65 seconds of visible foreground idle.',
  scope: 'Browser HTTP requests and WebSocket attempts only. Optional chunk checks inspect requested JS/CSS asset names, not code inlining. Interception is a safety guard, not an HTTP cache benchmark. No assertion about server workers, memory, CPU or external collector activity.',
  status: 'running', phase: 'preflight', checks: 0, requests: [], responses: [], failedRequests: [],
  forbiddenRequests: [], websocketAttempts: [], browserWebSockets: [], console: [], pageErrors: [],
  harnessErrors: [], unexpectedPages: [], screenshots: [], assertions: [], measurements: {}
};
let base, browser, context, page, boot, dashboard, failure;
const requestRecords = new WeakMap(), inFlight = new Set(), inspections = new Set();
const stamp = () => ({ phase: report.phase, elapsedMs: Number((performance.now() - started).toFixed(3)) });
function check(value, label) { report.assertions.push({ label, pass: !!value }); assert.ok(value, label); report.checks++; }
function step(label) { report.phase = label; process.stdout.write(JSON.stringify({ phase: label, checks: report.checks }) + '\n'); }
function validateStartup() {
  base = new URL(process.env.BASE_URL || 'http://127.0.0.1:5200');
  check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Use a plain application origin without credentials, path, query or fragment');
  const host = base.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  check(loopback || host === '10.233.233.61', 'Only loopback or the approved 10.233.233.61 test host is accepted');
  check(base.port && !protectedPorts.has(base.port), 'Use an explicit test port; daily, demo, previous component and auto-icon instances are protected');
  if (process.env.LINGSHU_EXPECT_LANGUAGE) check(['zh-CN', 'en'].includes(process.env.LINGSHU_EXPECT_LANGUAGE), 'Expected language must be zh-CN or en');
  report.baseURL = base.origin;
}
function findOptionalAssets(urls) {
  return optionalChunks.map(chunk => ({ name: chunk.name, urls: [...new Set(urls)].filter(raw => {
    try { const filename = new URL(raw).pathname.split('/').pop(); return /\.(?:js|css)$/i.test(filename) && chunk.stem.test(filename); } catch { return false; }
  }) }));
}
async function geometryAndResources() {
  return page.evaluate(() => ({
    documentURL: location.href, nowMs: performance.now(), visibility: document.visibilityState,
    visibilityChanges: window.__lingshuIdleAudit?.visibilityChanges || [],
    width: innerWidth, height: innerHeight, clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
    theme: document.querySelector('.lh-home')?.getAttribute('data-page-theme'),
    bookmarkElements: document.querySelectorAll('.lh-home article.lh-bookmark[data-link-id]').length,
    optionalPanelElements: document.querySelectorAll('.lh-data-panel,.lh-traffic-panel,.lh-composer').length,
    resources: performance.getEntriesByType('resource').map(entry => ({
      url: entry.name, initiatorType: entry.initiatorType, startTime: entry.startTime,
      duration: entry.duration, transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize
    }))
  }));
}
async function screenshot(label) {
  if (!page || page.isClosed()) return;
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  const target = path.join(screenshotDirectory, `${label}-${viewport.width}x${viewport.height}.png`);
  try { await page.screenshot({ path: target, fullPage: true, timeout }); report.screenshots.push(target); }
  catch (error) { report.harnessErrors.push({ ...stamp(), operation: 'screenshot', message: String(error) }); }
}
function observeNetwork() {
  context.on('request', request => {
    const record = { ...stamp(), id: report.requests.length + 1, url: request.url(), method: request.method(), resourceType: request.resourceType() };
    requestRecords.set(request, record); report.requests.push(record); inFlight.add(request);
  });
  context.on('requestfinished', request => { inFlight.delete(request); });
  context.on('requestfailed', request => {
    inFlight.delete(request);
    report.failedRequests.push({ ...stamp(), requestId: requestRecords.get(request)?.id, url: request.url(), method: request.method(), failure: request.failure()?.errorText || 'unknown' });
  });
  context.on('response', response => {
    const request = response.request(), url = new URL(response.url());
    report.responses.push({ ...stamp(), requestId: requestRecords.get(request)?.id, url: response.url(), status: response.status() });
    if (url.origin !== base.origin || request.method() !== 'GET' || !['/api/v1/bootstrap', '/api/v1/dashboard'].includes(url.pathname)) return;
    const inspection = (async () => {
      check(response.status() === 200, `${url.pathname} is a real successful read`);
      const value = await response.json();
      if (url.pathname === '/api/v1/bootstrap') boot = value; else dashboard = value;
    })().catch(error => { report.harnessErrors.push({ ...stamp(), operation: 'inspect-read-response', url: response.url(), message: String(error) }); });
    inspections.add(inspection); void inspection.finally(() => inspections.delete(inspection));
  });
  context.on('console', message => { report.console.push({ ...stamp(), type: message.type(), text: message.text(), location: message.location() }); });
  context.on('weberror', webError => { report.pageErrors.push({ ...stamp(), message: String(webError.error()), stack: webError.error()?.stack }); });
  context.on('page', opened => {
    opened.on('websocket', socket => { report.browserWebSockets.push({ ...stamp(), url: socket.url() }); });
    if (page) report.unexpectedPages.push({ ...stamp(), url: opened.url() });
  });
}
async function installReadOnlyGuards() {
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const foreign = url.origin !== base.origin, write = !['GET', 'HEAD'].includes(request.method());
    if (foreign || write) {
      report.forbiddenRequests.push({ ...stamp(), url: request.url(), method: request.method(), foreign, write });
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
  check(typeof context.routeWebSocket === 'function', 'Playwright supports blocking WebSockets before a server connection');
  await context.routeWebSocket('**/*', async socket => {
    report.websocketAttempts.push({ ...stamp(), url: socket.url(), action: 'closed-without-connectToServer' });
    try { await socket.close({ code: 1008, reason: 'Read-only idle audit' }); }
    catch (error) { report.harnessErrors.push({ ...stamp(), operation: 'close-websocket', message: String(error) }); }
  });
  await context.addInitScript(() => {
    const audit = { visibilityChanges: [{ nowMs: performance.now(), state: document.visibilityState }] };
    Object.defineProperty(window, '__lingshuIdleAudit', { value: audit, configurable: false });
    document.addEventListener('visibilitychange', () => audit.visibilityChanges.push({ nowMs: performance.now(), state: document.visibilityState }));
  });
}
function verifyFixture() {
  check(boot?.initialized === true, 'The supplied instance is already initialized; the audit never runs setup');
  check(boot.user === null, 'The new browser context remains anonymous without login');
  check(['open_edit', 'public_read'].includes(boot.mode), 'The instance allows an anonymous homepage');
  if (process.env.LINGSHU_EXPECT_LANGUAGE) check(boot.language === process.env.LINGSHU_EXPECT_LANGUAGE, 'Instance language matches the requested run');
  const config = dashboard?.page?.config;
  check(dashboard?.space?.kind === 'shared' && dashboard.space.published === true, 'A real published shared-space dashboard is loaded');
  check(config?.schemaVersion === 2 && Array.isArray(config.views), 'The dashboard contains a real version-2 page');
  check(config.views.some(view => ['builtin/navigation', 'builtin/favorites'].includes(view.panel.id)), 'The fixture includes a navigation or favorites component');
  check(config.views.every(view => navigationPanels.has(view.panel.id)), 'All configured components belong to the local-navigation baseline');
  check(Object.values(config.bindings).every(binding => binding.datasetId === 'local-navigation'), 'The page has no external-source bindings, including hidden or unused bindings');
  check(Object.values(dashboard.datasets).every(dataset => dataset.datasetId === 'local-navigation' && dataset.schemaId === 'navigation.collection'), 'Dashboard projections contain only the local navigation dataset');
  report.measurements.fixture = {
    version: boot.version, language: boot.language, mode: boot.mode, user: null,
    spaceId: dashboard.space.id, pageId: dashboard.page.id, pageRevision: dashboard.page.revision,
    theme: config.pageTheme.id, panels: config.views.map(view => ({ id: view.id, panelId: view.panel.id })),
    datasetIds: [...new Set(Object.values(config.bindings).map(binding => binding.datasetId))],
    sourceInventory: 'Not requested: this read-only audit checks visible page contracts, not server-wide source configuration.'
  };
}
async function run() {
  validateStartup();
  if (process.argv.includes('--guard-only')) { report.status = 'guard-only'; return; }
  const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--disable-dev-shm-usage', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])] });
  report.browser = browser.version();
  context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
  context.setDefaultTimeout(timeout); context.setDefaultNavigationTimeout(timeout);
  check((await context.cookies()).length === 0, 'The context starts with no saved cookies or authenticated state');
  observeNetwork(); await installReadOnlyGuards();
  page = await context.newPage();
  step('cold navigation');
  await page.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded' });
  await page.locator('.lh-home:not([data-preview])').waitFor({ state: 'visible' });
  await page.locator('.lh-home:not([data-preview]) article.lh-bookmark[data-link-id]').first().waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
  await Promise.all([...inspections]);
  verifyFixture();
  await page.bringToFront();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  report.measurements.cold = await geometryAndResources();
  const cold = report.measurements.cold;
  check(cold.bookmarkElements > 0, 'At least one real bookmark is rendered before foreground-idle timing begins');
  check(cold.visibility === 'visible', 'The homepage is visible before the foreground-idle window');
  check(cold.width === viewport.width && cold.height === viewport.height, 'The real viewport is 2560 by 1440');
  check(cold.scrollWidth <= cold.clientWidth + 1, 'The settled cold homepage has no document horizontal overflow');
  check(cold.optionalPanelElements === 0, 'No optional data panel, traffic panel or page composer is mounted');
  check(inFlight.size === 0, 'All initial HTTP requests have finished before idle timing begins');
  report.measurements.coldOptionalAssets = findOptionalAssets([...report.requests.map(request => request.url), ...cold.resources.map(resource => resource.url)]);
  check(report.measurements.coldOptionalAssets.every(chunk => chunk.urls.length === 0), 'Cold navigation requests none of the five optional feature chunks');
  const idleStart = performance.now(), requestStart = report.requests.length, socketStart = report.websocketAttempts.length;
  report.measurements.idle = { requestedDurationMs: idleDurationMs, startElapsedMs: idleStart - started, startPageMs: cold.nowMs, requestStart, socketStart, samples: [] };
  step('foreground idle');
  for (const checkpointMs of [30000, 60000, idleDurationMs]) {
    await delay(Math.max(0, idleStart + checkpointMs - performance.now()));
    const state = await page.evaluate(() => ({ nowMs: performance.now(), visibility: document.visibilityState }));
    const sample = { elapsedMs: performance.now() - idleStart, ...state, newRequests: report.requests.length - requestStart, newWebSocketAttempts: report.websocketAttempts.length - socketStart };
    report.measurements.idle.samples.push(sample);
    process.stdout.write(JSON.stringify({ phase: report.phase, sample }) + '\n');
  }
  report.measurements.idle.elapsedMs = performance.now() - idleStart;
  report.measurements.after = await geometryAndResources();
  report.measurements.idle.requests = report.requests.slice(requestStart);
  report.measurements.idle.websocketAttempts = report.websocketAttempts.slice(socketStart);
  report.measurements.optionalAssets = findOptionalAssets([...report.requests.map(request => request.url), ...report.measurements.after.resources.map(resource => resource.url)]);
  step('complete read-only audit');
  check(report.measurements.idle.elapsedMs >= idleDurationMs, 'At least 65 seconds of real time were measured');
  check(report.measurements.idle.samples.every(sample => sample.visibility === 'visible') && report.measurements.after.visibility === 'visible'
    && report.measurements.after.visibilityChanges.filter(change => change.nowMs >= cold.nowMs).every(change => change.state === 'visible'), 'The homepage stayed in the foreground throughout the idle window');
  check(report.measurements.idle.requests.length === 0, 'Foreground idle caused zero additional HTTP requests');
  check(report.measurements.idle.websocketAttempts.length === 0, 'Foreground idle caused zero additional WebSocket attempts');
  check(report.websocketAttempts.length === 0 && report.browserWebSockets.length === 0, 'Neither initial navigation nor idle attempted a WebSocket connection');
  check(report.measurements.optionalAssets.every(chunk => chunk.urls.length === 0), 'Optional feature chunks remain unloaded after idle');
  check(report.measurements.after.scrollWidth <= report.measurements.after.clientWidth + 1, 'The final settled homepage has no document horizontal overflow');
  check(report.forbiddenRequests.length === 0, 'No cross-origin request or non-GET/HEAD request was attempted');
  check(!report.requests.some(request => /\/api\/v1\/(?:sources\/|spaces\/[^/]+\/sources(?:[/?]|$))/.test(request.url)), 'No source-management or source-snapshot endpoint was requested');
  check(report.unexpectedPages.length === 0, 'The read-only homepage did not open another page');
  check(report.responses.every(response => response.status < 400), 'Every browser HTTP response succeeded without an HTTP error');
  check(report.failedRequests.length === 0, 'No browser request failed');
  check(report.pageErrors.length === 0, 'No uncaught browser error occurred');
  check(report.console.every(message => message.type !== 'error'), 'No browser console error occurred; all messages remain in the report');
  check(report.harnessErrors.length === 0, 'No audit observation or interception failed');
  await screenshot('complete');
  check(report.harnessErrors.length === 0, 'The completed homepage screenshot was saved');
  report.status = 'passed';
}
async function main() {
  try { await run(); }
  catch (error) {
    failure = error; report.status = 'failed'; report.failure = { phase: report.phase, message: String(error), stack: error.stack };
    if (page && !page.isClosed()) {
      try { report.measurements.failure = await geometryAndResources(); } catch (cause) { report.harnessErrors.push({ ...stamp(), operation: 'failure-evidence', message: String(cause) }); }
      await screenshot('failure');
    }
  } finally {
    // Closing the browser is outside the measured window; preserve all prior evidence.
    report.phase = 'cleanup';
    try { if (browser) await browser.close(); } catch (error) { report.harnessErrors.push({ ...stamp(), operation: 'close-browser', message: String(error) }); report.status = 'failed'; }
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ reportPath, status: report.status, checks: report.checks,
      idleElapsedMs: report.measurements.idle?.elapsedMs, idleRequests: report.measurements.idle?.requests?.length,
      idleWebSocketAttempts: report.measurements.idle?.websocketAttempts?.length, screenshots: report.screenshots }) + '\n');
    if (report.status === 'failed') { if (failure) console.error(failure.stack || failure); process.exitCode = 1; }
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
