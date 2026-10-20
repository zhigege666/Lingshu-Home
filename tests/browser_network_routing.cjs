#!/usr/bin/env node
'use strict';
/** Network settings and browser-local bookmark routing acceptance.
 * Requires a FRESH, explicitly disposable instance; never resets existing data.
 * BASE_URL=http://127.0.0.1:5196 node tests/browser_network_routing.cjs --disposable-instance
 * Run once against each independently initialized zh-CN/en instance.
 *
 * Default probe responses are fulfilled/aborted by Playwright context.route.
 * Navigation uses two temporary read-only loopback HTTP servers, including
 * Ctrl/middle clicks whose first background-tab requests this Chromium may
 * not expose to Playwright interception. Exact URL/opener/referrer checks apply.
 * This proves UI/Fetch/native-click integration, not real DNS/TLS/LNA or LAN reachability.
 * Browser CORS, mixed-content, certificate and local-network checks stay enabled.
 * CORS probes never follow redirects. A cross-origin read-only probe path must
 * return Access-Control-Allow-Origin for Home's origin (or * without credentials).
 * Only the deadline/cancellation section controls the browser clock. Real
 * pointer clicks still run; 799/800ms checks exercise the production timeout.
 * The clock resumes before optional LAN checks and the real-time idle sample.
 * Optional real, resource-free fixtures (both required):
 * LINGSHU_ROUTE_INTERNAL_URL=http://192.168.1.20:8080/internal
 * LINGSHU_ROUTE_EXTERNAL_URL=https://fixture.example.org/external
 * LINGSHU_ROUTE_INTERNAL_PROBE_PATH=/favicon.ico (same default for EXTERNAL)
 * LINGSHU_ROUTE_EXPECT=internal|external|either (default internal)
 * These explicit URLs are never substituted with a subnet scan. Real-fixture
 * requests are passed through and reported separately from controlled fixtures.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const runId = randomUUID().slice(0, 12), timeout = 15000;
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:5196');
const reportPath = process.env.REPORT_PATH || path.join(os.tmpdir(), `home-network-routing-${runId}.json`);
const sizes = [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080]];
const fixtures = {
  main: 'https://route-main.invalid/primary?keep=fixture#section',
  internal: 'https://192.168.249.31:8443/private/action?operation=never-probed#keep',
  external: 'https://route-external.invalid/public?keep=fixture#section',
  additional: 'https://route-docs.invalid/admin?operation=never-probed#manual',
};
const fixturePaths = { internal: '/healthz', external: '/favicon.ico' };
let browser, context, page, boot, space, csrf = '', checks = 0, phase = 'preflight', fixtureLink;
let mockMode = 'response', socketCount = 0, activeProbes = 0, peakProbes = 0;
let realFixtures = null, redirectTrapURL = '';
const errors = [], consoleErrors = [], expectedNetworkErrors = [], unexpectedNetwork = [], screenshots = [];
const requests = [], probes = [], probeResponses = [], failedRequests = [], measurements = {}, held = new Map(), activeRequests = new Set();
const inflightRequests = new Map(), requestRecords = new WeakMap();
const fixtureServers = [], loopbackRequests = [];
const probeTargets = new Map(), navigationTargets = new Map();
const check = (value, label) => { assert.ok(value, label); checks++; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const l = (zh, en) => boot.language === 'en' ? en : zh;
const step = label => { phase = label; process.stdout.write(JSON.stringify({ phase, checks }) + '\n'); };
const apiURL = relative => base.origin + '/api/v1' + relative;
const withoutFragment = value => { const parsed = new URL(value); parsed.hash = ''; return parsed.href; };
const probeURL = (value, probePath) => new URL(probePath, new URL(value).origin).href;
const fixtureHTML = role => `<!doctype html><meta charset="utf-8"><title>Controlled ${role} route</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"><h1>Controlled ${role} navigation fixture</h1>`;
async function startLoopbackFixtures() {
  async function start() {
    let origin = '';
    const server = http.createServer({ maxHeaderSize: 4096 }, (request, response) => {
      const send = (status, body = '', type = 'text/plain', extraHeaders = {}) => {
        response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; img-src data:; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
        response.end(body);
      };
      if (request.method !== 'GET') { send(405); return; }
      if (!origin || request.headers.host !== new URL(origin).host || !request.url.startsWith('/') || request.url.startsWith('//')) { send(421); return; }
      let url;
      try { url = new URL(request.url, origin); } catch { send(400); return; }
      // Only explicit static fixture paths are served. No request body, file,
      // arbitrary URL, credential or operating-system action is ever consumed.
      const destination = Object.entries(fixtures).find(([, value]) => withoutFragment(value) === url.href);
      const probeRole = ['internal', 'external'].find(role => probeURL(fixtures[role], fixturePaths[role]) === url.href);
      const favicon = url.pathname === '/favicon.ico' && !url.search;
      const trap = url.href === redirectTrapURL;
      const record = { phase, origin, method: request.method, path: url.pathname + url.search, kind: destination ? 'navigation' : probeRole ? 'probe' : trap ? 'redirect-trap' : favicon ? 'favicon' : 'rejected' };
      loopbackRequests.push(record);
      if (destination) { send(200, fixtureHTML(destination[0]), 'text/html; charset=utf-8'); return; }
      if (probeRole) {
        const noCORS = mockMode === 'real-no-cors' && probeRole === 'internal';
        const redirect = mockMode === 'real-redirect' && probeRole === 'internal';
        const allowOrigin = noCORS ? null : probeRole === 'internal' ? base.origin : '*';
        Object.assign(record, { role: probeRole, mode: mockMode, status: redirect ? 302 : 200, redirectTo: redirect ? redirectTrapURL : null, allowOrigin, credentialsSent: !!request.headers.authorization || !!request.headers.cookie, referrerSent: !!request.headers.referer, requestOrigin: request.headers.origin || '', fetchMode: request.headers['sec-fetch-mode'] || null });
        const headers = { ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}), ...(redirect ? { Location: redirectTrapURL } : {}) };
        send(redirect ? 302 : 200, 'Read-only loopback response; not a health assertion.', 'text/plain', headers); return;
      }
      if (trap) { send(200, 'Redirect target trap: this path must never be requested by a probe.', 'text/plain', { 'Access-Control-Allow-Origin': '*' }); return; }
      if (favicon) { send(204); return; }
      send(404);
    });
    fixtureServers.push(server);
    server.headersTimeout = 3000; server.requestTimeout = 3000; server.keepAliveTimeout = 1000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, () => { server.off('error', reject); resolve(); });
    });
    origin = 'http://127.0.0.1:' + server.address().port;
    server.unref();
    return origin;
  }
  const inside = await start(), outside = await start();
  Object.assign(fixtures, {
    main: outside + '/primary?keep=fixture#section',
    internal: inside + '/private/action?operation=never-probed#keep',
    external: outside + '/public?keep=fixture#section',
    additional: outside + '/admin?operation=never-probed#manual',
  });
  redirectTrapURL = outside + '/redirect-target';
  measurements.loopbackNavigation = { simulated: false, origins: [inside, outside], scope: 'Temporary read-only local HTTP fixture; not LAN/TLS/LNA evidence', requests: loopbackRequests };
}
async function until(predicate, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) { check(true, label); return; }
    await page.waitForTimeout(40);
  }
  throw new Error(label + ': condition did not become true');
}
async function api(relative, method = 'GET', body, status = 200) {
  const response = await context.request.fetch(apiURL(relative), { method, data: body, headers: { 'X-CSRF-TOKEN': csrf }, timeout, maxRedirects: 0 });
  equal(response.status(), status, `${method} ${relative}: status`);
  return status === 204 ? null : response.json();
}
async function refreshBoot() { boot = await api('/bootstrap'); csrf = boot.csrfToken; return boot; }
async function navigation() { return api(`/spaces/${space.id}/navigation`); }
async function savedLink(id) { return (await navigation()).data.links.find(link => link.id === id); }
async function select(locator, label) { await locator.click(); await page.getByRole('option', { name: label, exact: true }).click(); }
async function chooseSpace(admin = false) {
  if (boot.spaces.length < 2) return;
  const picker = page.getByRole('combobox', { name: admin ? l('当前空间', 'Current space') : l('选择空间', 'Choose a space'), exact: true });
  await picker.waitFor();
  if ((await picker.innerText()).trim() === space.name.trim()) return;
  const [response] = await Promise.all([
    page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.origin === base.origin && url.pathname === '/api/v1/dashboard' && url.searchParams.get('spaceId') === space.id;
    }, { timeout }),
    select(picker, space.name),
  ]);
  equal(response.status(), 200, 'Space selection receives its actual dashboard response');
  equal(await response.finished(), null, 'Selected-space dashboard response body finishes');
  equal((await response.json()).space.id, space.id, 'Selected-space dashboard is the authorized fixture space');
  await until(async () => (await picker.innerText()).trim() === space.name.trim(), 'Shared fixture space selected through UI');
}
function unfinishedInScope(scope) {
  return [...inflightRequests.values()].filter(record => record.index >= scope.startRequestIndex);
}
async function settleHomeRender(scope) {
  if (fixtureLink?.id) await card().waitFor();
  let deadlineTimer, stopped = false;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => { stopped = true; reject(new Error('Home did not finish rendering/loading in its request scope: ' + JSON.stringify({ scope, unfinished: unfinishedInScope(scope) }))); }, timeout);
  });
  const settled = (async () => {
    while (!stopped) {
      const before = requests.length, startedWithoutInflight = unfinishedInScope(scope).length === 0;
      const state = await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const images = [...document.querySelectorAll('.lh-home img')];
        return { homePresent: !!document.querySelector('.lh-home'), fonts: document.fonts.status, images: images.length, pendingImages: images.filter(image => !image.complete).map(image => image.currentSrc || image.src) };
      });
      // Observe new work after React commits the chosen dashboard, including
      // its images/fonts. An earlier document's loadstate cannot establish this.
      if (state.homePresent && state.fonts === 'loaded' && state.pendingImages.length === 0 && startedWithoutInflight && unfinishedInScope(scope).length === 0 && requests.length === before) return state;
    }
  })();
  try {
    const state = await Promise.race([settled, deadline]);
    check(true, 'Selected Home renders its assets with no unfinished requests in its current scope across two frames');
    (measurements.homeReadiness ||= []).push({ phase, spaceId: space.id, fixtureLinkId: fixtureLink?.id || null, at: Date.now(), requestCount: requests.length, requestScope: scope, inflightInScope: 0,
      earlierUnfinishedRequestIndices: [...inflightRequests.values()].filter(record => record.index < scope.startRequestIndex).map(record => record.index), ...state });
  } finally { stopped = true; clearTimeout(deadlineTimer); }
}
async function admin(tab) {
  await page.goto(base.origin + '/#/admin?tab=' + tab, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.admin-shell').waitFor();
  // Instance-wide settings intentionally have no current-space picker.
  if (tab === 'links') await chooseSpace(true);
  if (tab === 'network') await page.locator('.admin-network-settings').waitFor();
}
async function home() {
  await page.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'networkidle' });
  // Retired documents can leave intercepted requests without terminal events.
  // Keep those records untouched; only work observed after this completed
  // reload participates in the subsequent explicit space-selection boundary.
  const scope = { startRequestIndex: requests.length, establishedAt: Date.now(), documentURL: page.url(), boundary: 'Complete Home reload; before explicit space selection' };
  (measurements.homeRequestScopes ||= []).push(scope);
  await page.locator('.lh-home').waitFor();
  await chooseSpace();
  await settleHomeRender(scope);
  return scope;
}
async function expectWrite(relative, method, action, status = 200) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url() === apiURL(relative) && response.request().method() === method, { timeout }),
    action(),
  ]);
  equal(response.status(), status, `${method} ${relative}: real UI response`);
  return { body: response.request().postDataJSON(), value: status === 204 ? null : await response.json() };
}
async function capture(label, force = false) {
  const directory = process.env.SCREENSHOT_DIR || (force ? path.join(path.dirname(reportPath), 'screenshots') : null);
  if (!directory || !page || page.isClosed()) return;
  const target = path.join(directory, `network-${boot?.language || 'unknown'}-${label}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target, fullPage: false, timeout }); screenshots.push(target);
}
async function geometry(label, selector) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const value = await page.evaluate(selector => ({
    width: innerWidth, client: document.documentElement.clientWidth,
    scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    items: [...document.querySelectorAll(selector)].map(node => {
      const box = node.getBoundingClientRect();
      return { x: box.x, right: box.right, width: box.width, height: box.height, client: node.clientWidth, scroll: node.scrollWidth };
    }),
  }), selector);
  measurements[label] = value;
  check(value.scroll <= value.client + 1, `${label}: no horizontal document overflow`);
  check(value.items.length > 0, `${label}: intended UI is present`);
  for (const box of value.items) {
    check(box.width > 100 && box.height > 20, `${label}: usable bounds`);
    check(box.x >= -1 && box.right <= value.width + 1, `${label}: bounds remain inside viewport`);
    check(box.scroll <= box.client + 1, `${label}: content has no horizontal overflow`);
  }
  await capture(label);
}
async function fourDesktops(label, selector) {
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await geometry(`${label}-${width}x${height}`, selector);
  }
  await page.setViewportSize({ width: 2560, height: 1440 });
}
const routingSwitch = () => page.getByRole('checkbox', { name: l('自动选择内外网入口', 'Automatically select internal or external routes'), exact: true });
const proxyURLInput = () => page.getByLabel(l('代理地址', 'Proxy URL'), { exact: true });
const proxyUsername = () => page.getByLabel(l('代理用户名', 'Proxy username'), { exact: true });
const proxyPassword = () => page.getByLabel(l('代理密码', 'Proxy password'), { exact: true });
const proxySave = () => page.getByRole('button', { name: l('保存代理设置', 'Save proxy settings'), exact: true });
const proxyReload = () => page.getByRole('button', { name: l('重新读取代理配置', 'Reload proxy configuration'), exact: true });
async function setRouting(enabled) {
  await admin('network');
  const before = await api('/settings');
  equal(await routingSwitch().isChecked(), !enabled, 'Routing switch starts in opposite state');
  await routingSwitch().click();
  const write = await expectWrite('/settings/navigation', 'PUT', () => page.getByRole('button', { name: l('保存选路设置', 'Save routing settings'), exact: true }).click());
  equal(write.body, { autoSelectEndpoint: enabled }, 'Routing UI writes only its one authorized field');
  equal(write.value, { autoSelectEndpoint: enabled }, 'Narrow response contains only the routing setting');
  equal(await api('/settings'), { ...before, autoSelectEndpoint: enabled }, 'Saving routing leaves access, icon and site settings unchanged');
  await refreshBoot(); equal(boot.autoSelectEndpoint, enabled, 'Bootstrap reflects the saved preference');
  await admin('network');
  equal(await routingSwitch().isChecked(), enabled, 'Routing setting survives full reload');
}
function assertPublicProxy(value, credentialConfigured, label) {
  equal(Object.keys(value).sort(), ['credentialConfigured', 'mode', 'revision', 'url'], label + ': exact public projection');
  equal(value.credentialConfigured, credentialConfigured, label + ': configured flag');
}
async function proxySettings() {
  step('Owner proxy persistence, write-only credentials and explicit clearing');
  await admin('network');
  equal(await page.locator('input[name="network-proxy-mode"][value="direct"]').isChecked(), true, 'Server proxy defaults to direct mode');
  equal(await proxyURLInput().inputValue(), '', 'Fresh proxy URL is empty');
  const first = await api('/network-proxy'); assertPublicProxy(first, false, 'Fresh proxy');
  const user = 'fixture-proxy-' + runId, password = 'fixture-only-' + randomUUID();
  await page.locator('input[name="network-proxy-mode"][value="proxy"]').check();
  await proxyURLInput().fill('http://127.0.0.1:18997');
  await proxyUsername().fill(user); await proxyPassword().fill(password);
  equal(await proxyPassword().getAttribute('type'), 'password', 'Credential entry is masked');
  const saved = await expectWrite('/network-proxy', 'PUT', () => proxySave().click());
  equal(saved.body.expectedRevision, first.revision, 'Proxy write includes the read revision');
  equal(saved.body.secret, { username: user, password }, 'Proxy credentials use the explicit write-only object');
  assertPublicProxy(saved.value, true, 'Saved proxy');
  await until(async () => (await proxyUsername().inputValue()) === '' && (await proxyPassword().inputValue()) === '', 'Successful save clears credential input fields');
  const loaded = await api('/network-proxy'); assertPublicProxy(loaded, true, 'Reloaded proxy');
  for (const value of [saved.value, loaded, await refreshBoot(), await api(`/dashboard?spaceId=${space.id}`)]) {
    check(!JSON.stringify(value).includes(user) && !JSON.stringify(value).includes(password), 'Proxy credentials are absent from API read projections');
  }
  await admin('network');
  equal(await proxyUsername().inputValue(), '', 'Reload never refills saved username');
  equal(await proxyPassword().inputValue(), '', 'Reload never refills saved password');
  await page.locator('input[name="network-proxy-mode"][value="direct"]').check();
  const direct = await expectWrite('/network-proxy', 'PUT', () => proxySave().click());
  check(!('secret' in direct.body) && !('clearCredentials' in direct.body), 'Blank credential fields preserve the saved credentials');
  assertPublicProxy(direct.value, true, 'Saved direct mode');
  equal(direct.value.mode, 'direct', 'Proxy mode is disabled without deleting its saved configuration');
  const clear = page.getByRole('checkbox', { name: l('清除已保存的代理凭据', 'Clear saved proxy credentials'), exact: true });
  await clear.click();
  equal(await proxyUsername().isDisabled(), true, 'Explicit clear disables replacement username');
  equal(await proxyPassword().isDisabled(), true, 'Explicit clear disables replacement password');
  const cleared = await expectWrite('/network-proxy', 'PUT', () => proxySave().click());
  equal(cleared.body.clearCredentials, true, 'Explicit clear flag reaches the server');
  check(!('secret' in cleared.body), 'Clear and replacement credentials are mutually exclusive');
  assertPublicProxy(cleared.value, false, 'Cleared proxy');
  assertPublicProxy(await api('/network-proxy'), false, 'Persisted clear');

  step('Real proxy 409 preserves draft until explicit discard/reload');
  await admin('network');
  const baseline = await api('/network-proxy');
  const draftURL = 'http://127.0.0.1:18998', draftUser = 'unsubmitted-fixture-user', draftPassword = 'unsubmitted-' + randomUUID();
  await page.locator('input[name="network-proxy-mode"][value="proxy"]').check();
  await proxyURLInput().fill(draftURL); await proxyUsername().fill(draftUser); await proxyPassword().fill(draftPassword);
  const concurrent = await api('/network-proxy', 'PUT', { expectedRevision: baseline.revision, mode: 'direct', url: baseline.url });
  check(concurrent.revision !== baseline.revision, 'Independent authorized write advances the actual server revision');
  const conflict = await expectWrite('/network-proxy', 'PUT', () => proxySave().click(), 409);
  equal(conflict.value.code, 'network_proxy_version_conflict', 'Conflict is produced by the real revision guard');
  await page.getByText(l('代理配置已在其他页面更改，当前输入已保留。请重新读取已保存配置后再修改。', 'The proxy configuration changed in another page. Your input is preserved. Reload the saved configuration before editing again.'), { exact: true }).waitFor();
  equal(await proxyURLInput().inputValue(), draftURL, '409 retains the unsaved proxy URL');
  equal(await proxyUsername().inputValue(), draftUser, '409 retains unsubmitted username');
  equal(await proxyPassword().inputValue(), draftPassword, '409 retains unsubmitted password');
  equal(await proxySave().isDisabled(), true, 'Conflict cannot be blindly resubmitted');
  equal(await api('/network-proxy'), concurrent, 'Conflict does not overwrite the concurrent version');
  await proxyReload().click();
  let dialog = page.getByRole('dialog', { name: l('放弃未保存的修改？', 'Discard unsaved changes?'), exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: l('继续编辑', 'Keep editing'), exact: true }).click();
  equal(await proxyPassword().inputValue(), draftPassword, 'Declining reload retains the draft');
  await proxyReload().click(); dialog = page.getByRole('dialog');
  const [reloaded] = await Promise.all([
    page.waitForResponse(response => response.url() === apiURL('/network-proxy') && response.request().method() === 'GET'),
    dialog.getByRole('button', { name: l('放弃修改', 'Discard changes'), exact: true }).click(),
  ]);
  equal(reloaded.status(), 200, 'Explicit discard reads current proxy configuration');
  await until(async () => (await proxyURLInput().inputValue()) === concurrent.url && (await proxyPassword().inputValue()) === '', 'Reload replaces proxy draft and clears unsubmitted credentials');
  equal(await proxyUsername().inputValue(), '', 'Reload clears unsubmitted username');
  equal(await page.locator('input[name="network-proxy-mode"][value="direct"]').isChecked(), true, 'Reload restores saved direct mode');
  await proxyURLInput().fill('');
  const reset = await expectWrite('/network-proxy', 'PUT', () => proxySave().click());
  equal(reset.value.mode, 'direct', 'Fixture leaves server networking direct');
  equal(reset.value.url, '', 'Fixture removes unused proxy address');
  measurements.proxy = { conflictStatus: 409, credentialRoundtrip: 'write-only, retained, explicitly cleared', finalMode: 'direct' };
}
async function editLink(link) {
  await admin('links');
  await page.getByRole('row').filter({ hasText: link.title }).getByRole('button', { name: l('编辑 ', 'Edit ') + link.title, exact: true }).click();
  await page.getByRole('dialog', { name: l('编辑链接', 'Edit link'), exact: true }).waitFor();
}
async function saveLink(id) {
  const write = await expectWrite(`/spaces/${space.id}/links${id ? '/' + id : ''}`, id ? 'PUT' : 'POST', () => page.getByRole('button', { name: l('保存链接', 'Save link'), exact: true }).click(), id ? 200 : 201);
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  return write;
}
async function endpointEditor() {
  step('Additional/internal/external endpoint UI roundtrip and four desktop widths');
  await admin('links');
  await page.getByRole('button', { name: l('添加链接', 'Add link'), exact: true }).click();
  await page.getByLabel(l('链接名称', 'Link name'), { exact: true }).fill('Network routing fixture ' + runId);
  await page.getByLabel(l('主入口 URL', 'Primary URL'), { exact: true }).fill(fixtures.main);
  await page.getByRole('button', { name: l('使用默认图标', 'Use default'), exact: true }).click();
  await page.getByRole('button', { name: l('添加入口', 'Add URL'), exact: true }).click();
  const extra = page.locator('.link-additional-row');
  await extra.getByRole('textbox').nth(0).fill('Internal admin docs');
  await extra.getByLabel(l('入口 URL', 'URL'), { exact: true }).fill(fixtures.additional);
  await page.getByRole('button', { name: l('添加内网入口', 'Add internal route'), exact: true }).click();
  const inside = page.locator('.link-route-card[data-route="internal"]');
  await inside.getByLabel(l('入口名称', 'Route name'), { exact: true }).fill('LAN fixture');
  await inside.getByLabel(l('内网地址', 'Internal URL'), { exact: true }).fill(fixtures.internal);
  await inside.getByLabel(l('探测路径', 'Probe path'), { exact: true }).fill(fixturePaths.internal);
  await page.getByRole('button', { name: l('添加外网入口', 'Add external route'), exact: true }).click();
  const outside = page.locator('.link-route-card[data-route="external"]');
  await outside.getByLabel(l('入口名称', 'Route name'), { exact: true }).fill('WAN fixture');
  await outside.getByLabel(l('外网地址', 'External URL'), { exact: true }).fill(fixtures.external);
  await outside.getByLabel(l('探测路径', 'Probe path'), { exact: true }).fill('');
  await fourDesktops('endpoint-editor', '.link-route-card, .link-additional-row');
  const created = await saveLink(); fixtureLink = created.value;
  equal(created.body.iconMode, 'manual', 'Routing fixture uses a bundled manual icon and queues no website icon work');
  equal(created.body.endpoints, [
    { label: 'Internal admin docs', url: fixtures.additional },
    { label: 'LAN fixture', url: fixtures.internal, route: 'internal', probePath: fixturePaths.internal },
    { label: 'WAN fixture', url: fixtures.external, route: 'external', probePath: '' },
  ], 'UI preserves explicit categories and original array order');
  equal(fixtureLink.endpoints, [
    { label: 'Internal admin docs', url: fixtures.additional },
    { label: 'LAN fixture', url: fixtures.internal, route: 'internal', probePath: fixturePaths.internal },
    { label: 'WAN fixture', url: fixtures.external, route: 'external' },
  ], 'Server retains route metadata and omits an empty optional probe path');
  equal((await savedLink(fixtureLink.id)).endpoints, fixtureLink.endpoints, 'Three entry kinds survive an authoritative read');
  await editLink(fixtureLink);
  equal(await page.locator('.link-route-card[data-route="internal"]').count(), 1, 'Reload restores internal route group');
  equal(await page.locator('.link-route-card[data-route="external"]').count(), 1, 'Reload restores external route group');
  equal(await page.locator('.link-additional-row').count(), 1, 'A label mentioning Internal remains an ordinary additional link');
  equal(await page.locator('.link-route-card[data-route="internal"]').getByLabel(l('探测路径', 'Probe path'), { exact: true }).inputValue(), '/healthz', 'Custom read-only probe path survives reload');
  equal(await page.locator('.link-route-card[data-route="external"]').getByLabel(l('探测路径', 'Probe path'), { exact: true }).inputValue(), '', 'Empty default probe path survives reload');
  await page.locator('.link-additional-row').getByRole('textbox').nth(0).fill('Internal admin docs updated');
  const changed = await saveLink(fixtureLink.id); fixtureLink = changed.value;
  equal((await savedLink(fixtureLink.id)).endpoints, fixtureLink.endpoints, 'Real editor update preserves routing metadata');
}
function registerFixtureTargets() {
  for (const [role, url] of Object.entries(fixtures)) navigationTargets.set(withoutFragment(url), { role, real: false, loopback: true });
  for (const role of ['internal', 'external']) probeTargets.set(probeURL(fixtures[role], fixturePaths[role]), { role, real: false });
  if (realFixtures) for (const role of ['internal', 'external']) {
    navigationTargets.set(withoutFragment(realFixtures[role]), { role, real: true });
    probeTargets.set(probeURL(realFixtures[role], realFixtures.paths[role]), { role, real: true });
  }
}
function finishProbe(request) { if (activeRequests.delete(request)) activeProbes--; }
function finishRequest(request) {
  const record = requestRecords.get(request);
  if (record) {
    record.finishedAt = Date.now(); record.durationMS = record.finishedAt - record.startedAt;
    const failure = request.failure(); if (failure) record.error = failure.errorText;
  }
  inflightRequests.delete(request); finishProbe(request);
}
function releaseHeld() { for (const resume of held.values()) resume(); held.clear(); }
function monitor(p) {
  p.on('pageerror', error => errors.push({ phase, message: error.message }));
  p.on('console', message => { if (message.type() === 'error') consoleErrors.push({ phase, text: message.text(), url: message.location().url || '' }); });
  p.on('websocket', () => socketCount++);
  p.on('dialog', async dialog => { errors.push({ phase, message: 'Unexpected native dialog: ' + dialog.type() }); await dialog.dismiss(); });
}
async function installFixtures() {
  registerFixtureTargets();
  context.on('page', monitor);
  context.on('request', request => {
    const target = probeTargets.get(request.url());
    const record = { index: requests.length, method: request.method(), url: request.url(), resourceType: request.resourceType(), phase, startedAt: Date.now() };
    requests.push(record); requestRecords.set(request, record); inflightRequests.set(request, record);
    if (target && request.resourceType() === 'fetch') {
      activeRequests.add(request); activeProbes++; peakProbes = Math.max(peakProbes, activeProbes);
    }
  });
  context.on('requestfinished', finishRequest);
  context.on('response', response => {
    const record = requestRecords.get(response.request()); if (record) record.status = response.status();
    if (probeTargets.has(response.url()) && response.request().resourceType() === 'fetch') probeResponses.push({ url: response.url(), status: response.status() });
  });
  context.on('requestfailed', request => {
    finishRequest(request);
    failedRequests.push({ phase, url: request.url(), resourceType: request.resourceType(), error: request.failure()?.errorText || '' });
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === base.origin) { await route.continue(); return; }
    // A single explicit read-only trap is allowed through the harness so an
    // accidental redirect-follow really reaches it and fails the zero-hit test.
    if (url.href === redirectTrapURL) { await route.continue(); return; }
    const target = probeTargets.get(url.href);
    if (target && request.resourceType() === 'fetch') {
      const headers = await request.allHeaders();
      const loopback = ['real-cors', 'real-no-cors', 'real-redirect'].includes(mockMode);
      const record = { role: target.role, real: target.real, transport: target.real ? 'real-external' : loopback ? 'real-loopback' : 'simulated', url: url.href, mode: mockMode, method: request.method(), phase, credentialsSent: !!headers.authorization || !!headers.cookie, referrerSent: !!headers.referer, fetchMode: headers['sec-fetch-mode'] || null };
      probes.push(record);
      if (target.real || loopback) { await route.continue(); return; }
      if (mockMode === 'hold') {
        await new Promise(resolve => held.set(request, resolve));
        await route.abort('aborted').catch(() => {}); return;
      }
      if (mockMode === 'all-unknown' || mockMode === 'internal-unknown' && target.role === 'internal') { await route.abort('failed'); return; }
      await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': base.origin }, body: 'Controlled readable response; not a service health result.' });
      return;
    }
    const destination = navigationTargets.get(withoutFragment(url.href));
    if (destination && request.isNavigationRequest()) {
      await route.continue(); return;
    }
    // A destination may request its favicon as an image. It is unrelated to the
    // fetch-based probe and is never counted as one or allowed to fan out.
    if (request.resourceType() === 'image' && url.pathname === '/favicon.ico' && [...navigationTargets.keys()].some(value => new URL(value).origin === url.origin)) {
      await route.fulfill({ status: 204, body: '' }); return;
    }
    unexpectedNetwork.push({ phase, url: url.href, resourceType: request.resourceType() });
    await route.abort('blockedbyclient');
  });
}
const card = () => page.locator(`.lh-bookmark[data-link-id="${fixtureLink.id}"]`).first();
async function frozenNativeClick(locator, expectedRouting = 'idle') {
  // Locator.click waits for stable animation frames. The clock intentionally
  // pauses those frames here, so use real pointer events after checking the
  // visible hit target; do not synthesize DOM clicks or bypass an obstruction.
  const serial = randomUUID();
  const hit = await locator.evaluate((node, serial) => {
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const target = node.ownerDocument.elementFromPoint(x, y);
    const visible = box.width > 0 && box.height > 0 && style.visibility === 'visible' && style.display !== 'none'
      && Number(style.opacity) > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight;
    node.addEventListener('click', event => {
      window.__lingshuClockClick = { serial, trusted: event.isTrusted, at: performance.now(), routing: node.closest('.lh-bookmark')?.getAttribute('data-routing') || null, href: node.href };
    }, { capture: true, once: true });
    return { x, y, visible, receivesEvents: node === target || node.contains(target), enabled: node.getAttribute('aria-disabled') !== 'true' };
  }, serial);
  check(hit.visible && hit.enabled && hit.receivesEvents, 'Frozen-clock pointer target is visible, enabled and unobstructed');
  await page.mouse.click(hit.x, hit.y);
  const event = await page.evaluate(() => window.__lingshuClockClick);
  check(event?.serial === serial && event.trusted, 'Frozen-clock action delivers a trusted browser pointer click');
  equal(event.routing, expectedRouting, 'Actual click occurs in the required routing state');
  measurements.controlledClock.nativeClicks.push(event);
}
async function openLink(locator, expected, options = {}, activate) {
  const requestStart = requests.length, failureStart = failedRequests.length;
  const attempt = { phase, checksBefore: checks, selector: locator.toString(), href: await locator.getAttribute('href'), expected: new URL(expected).href, options, activation: activate ? 'hit-tested native pointer under controlled clock' : 'locator' };
  (measurements.navigationAttempts ||= []).push(attempt);
  const [popup] = await Promise.all([context.waitForEvent('page', { timeout }), activate ? activate() : locator.click(options)]);
  attempt.initialURL = popup.url();
  try { await popup.waitForURL(url => url.href === new URL(expected).href, { timeout }); }
  catch (cause) {
    attempt.actualURL = popup.url(); attempt.closed = popup.isClosed();
    attempt.navigationRequests = requests.slice(requestStart).filter(item => item.resourceType === 'document');
    attempt.failedRequests = failedRequests.slice(failureStart);
    throw new Error(`Expected exact popup URL ${attempt.expected}; actual ${attempt.actualURL}; href ${attempt.href}; ${cause.message}`, { cause });
  }
  await popup.waitForLoadState('domcontentloaded');
  equal(await popup.evaluate(() => window.opener === null), true, 'Opened destination has no opener');
  equal(await popup.evaluate(() => document.referrer), '', 'Opened destination receives no document referrer');
  attempt.actualURL = popup.url(); attempt.passed = true;
  await popup.close();
  return expected;
}
async function browserRouting() {
  step('Cold Home, hover/focus, manual choices and native modified clicks');
  await home(); await card().waitFor();
  equal(probes.length, 0, 'Home loading and editor activity do not probe configured endpoints');
  await fourDesktops('home', '.lh-bookmark');
  equal(await card().locator('.lh-network-endpoints a[data-route="internal"]').count(), 1, 'Manual internal route is exposed');
  equal(await card().locator('.lh-network-endpoints a[data-route="external"]').count(), 1, 'Manual external route is exposed');
  equal(await card().locator('.lh-additional-endpoints a').count(), 1, 'Ordinary additional links remain separate');
  equal(await card().locator('.lh-bookmark-title').getAttribute('href'), fixtures.external, 'Cold native href keeps configured external fallback');
  await card().locator('.lh-bookmark-title').hover(); await card().locator('.lh-bookmark-title').focus();
  await page.waitForTimeout(250);
  equal(probes.length, 0, 'Hover and focus do not start probes');
  for (const [selector, expected] of [['.lh-network-endpoints a[data-route="internal"]', fixtures.internal], ['.lh-network-endpoints a[data-route="external"]', fixtures.external], ['.lh-additional-endpoints a', fixtures.additional]]) {
    const anchor = card().locator(selector);
    check((await anchor.getAttribute('rel')).includes('noopener') && (await anchor.getAttribute('rel')).includes('noreferrer'), 'Manual route advertises safe native navigation');
    await openLink(anchor, expected);
    equal(probes.length, 0, 'Manual entry opens directly without a probe');
  }
  await openLink(card().locator('.lh-bookmark-title'), fixtures.external, { modifiers: ['Control'] });
  await openLink(card().locator('.lh-bookmark-title'), fixtures.external, { button: 'middle' });
  equal(probes.length, 0, 'Ctrl and middle clicks preserve native href without probing');

  step('Primary click prefers responding internal route and reuses memory evidence');
  mockMode = 'response';
  await openLink(card().locator('.lh-bookmark-title'), fixtures.internal);
  await until(async () => (await card().getAttribute('data-routing')) === 'idle', 'Routing settles after navigation');
  check(probes.some(item => !item.real && item.role === 'internal'), 'Primary click actually requested the configured internal probe');
  check(probes.length <= 2, 'Primary click probes at most two configured candidates');
  const firstCount = probes.length;
  await openLink(card().locator('.lh-bookmark-title'), fixtures.internal);
  equal(probes.length, firstCount, 'Repeated click reuses positive memory TTL');
  equal(await card().locator('.lh-bookmark-title').getAttribute('href'), fixtures.internal, 'Cached reachable route is available to native link behavior');
  await openLink(card().locator('.lh-bookmark-title'), fixtures.internal, { modifiers: ['Control'] });
  equal(probes.length, firstCount, 'Modified click uses cached href without a new check');
  await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
  equal(probes.length, firstCount, 'Connectivity-change notifications only invalidate memory and do not probe');
  await openLink(card().locator('.lh-bookmark-title'), fixtures.external, { modifiers: ['Control'] });
  equal(probes.length, firstCount, 'Pointer/key handling refreshes stale native href after cache invalidation without probing');
  measurements.cacheInvalidation = { trigger: 'controlled online/offline DOM events', newProbeRequests: 0 };

  step('Unknown internal or blocked probes preserve external fallback and negative TTL');
  for (const mode of ['internal-unknown', 'all-unknown']) {
    mockMode = mode; await home();
    const before = probes.length;
    await openLink(card().locator('.lh-bookmark-title'), fixtures.external);
    check(probes.length > before && probes.length <= before + 2, `${mode}: fresh click only checks bounded candidates`);
    const after = probes.length;
    await openLink(card().locator('.lh-bookmark-title'), fixtures.external);
    equal(probes.length, after, `${mode}: immediate retry reuses short unknown TTL`);
  }

  measurements.corsPolicy = [];
  for (const [mode, expected] of [['real-cors', fixtures.internal], ['real-no-cors', fixtures.external], ['real-redirect', fixtures.external]]) {
    step(mode === 'real-cors' ? 'Real loopback CORS-authorized HTTP response'
      : mode === 'real-no-cors' ? 'Real missing-CORS response preserves external fallback' : 'Real redirect response is refused without contacting its target');
    mockMode = mode; await home();
    const serverStart = loopbackRequests.length, probeStart = probes.length;
    await openLink(card().locator('.lh-bookmark-title'), expected);
    const received = loopbackRequests.slice(serverStart).filter(item => item.kind === 'probe');
    const internalProbe = received.find(item => item.role === 'internal');
    check(!!internalProbe, `${mode}: the actual HTTP fixture receives the configured internal probe`);
    equal(internalProbe.status, mode === 'real-redirect' ? 302 : 200, `${mode}: real server status is controlled`);
    equal(internalProbe.allowOrigin, mode === 'real-no-cors' ? null : base.origin, `${mode}: actual CORS policy is explicit`);
    for (const record of received) {
      equal(record.credentialsSent, false, 'Actual probe request contains no Cookie or Authorization');
      equal(record.referrerSent, false, 'Actual probe request contains no Referer');
      equal(record.requestOrigin, base.origin, 'Actual CORS request declares the Home origin');
      if (record.fetchMode) equal(record.fetchMode, 'cors', 'Actual browser probe uses CORS mode');
    }
    const observed = probes.slice(probeStart);
    check(observed.length >= 1 && observed.length <= 2 && observed.every(item => item.transport === 'real-loopback'), `${mode}: proof uses actual loopback networking, not fulfilled responses`);
    equal(requests.filter(item => item.url === redirectTrapURL).length, 0, 'Browser never requests the unconfigured redirect target');
    equal(loopbackRequests.filter(item => item.kind === 'redirect-trap').length, 0, 'Real redirect-target server receives no request');
    if (mode !== 'real-cors') {
      const before = probes.length;
      await openLink(card().locator('.lh-bookmark-title'), fixtures.external);
      equal(probes.length, before, `${mode}: immediate repeat uses the short unknown cache and external evidence`);
    }
    measurements.corsPolicy.push({ mode, selected: expected, simulated: false, received, redirectTargetRequests: 0 });
  }

  step('Production 800ms deadline under an explicitly controlled browser clock');
  // Installing before a new Home document avoids mixing existing native timer
  // handles with clock-owned handles. No app timeout or network policy changes.
  await page.goto('about:blank');
  const clockStart = Date.now();
  await page.clock.install({ time: new Date(clockStart) });
  measurements.controlledClock = { scope: 'Production 799/800ms deadline and in-budget cancellation only', simulatedTime: true, activation: 'Trusted hit-tested pointer clicks', nativeClicks: [], resumed: false };
  try {
    mockMode = 'hold'; await home();
    await page.clock.pauseAt(new Date(clockStart + 60000));
    const deadlineStart = await page.evaluate(() => performance.now());
    let [pending] = await Promise.all([context.waitForEvent('page', { timeout }), frozenNativeClick(card().locator('.lh-bookmark-title'))]);
    await until(async () => (await card().getAttribute('data-routing')) === 'pending', 'Slow fixture exposes bounded pending state');
    equal(pending.url(), 'about:blank', 'Pending tab has not visited any unselected URL');
    equal(await pending.evaluate(() => window.opener === null), true, 'Even pending blank tab has no opener');
    await page.clock.runFor(799);
    equal(await page.evaluate(() => performance.now()) - deadlineStart, 799, 'The first deadline checkpoint advances exactly 799ms');
    equal(await card().getAttribute('data-routing'), 'pending', 'Production deadline has not elapsed at 799ms');
    equal(pending.url(), 'about:blank', 'No fallback navigation starts before the 800ms budget');
    await page.clock.runFor(1);
    await pending.waitForURL(url => url.href === fixtures.external, { timeout });
    await pending.waitForLoadState('domcontentloaded');
    equal(pending.url(), fixtures.external, 'At 800ms the unchanged production timer opens the exact external fallback');
    equal(await pending.evaluate(() => window.opener === null), true, 'Timed-out fallback has no opener');
    equal(await pending.evaluate(() => document.referrer), '', 'Timed-out fallback receives no referrer');
    await until(async () => (await card().getAttribute('data-routing')) === 'idle', 'Deadline settles routing state');
    equal(await page.evaluate(() => performance.now()) - deadlineStart, 800, 'Fallback needs no time beyond the configured 800ms');
    measurements.controlledClock.deadline = { beforeMS: 799, fallbackAtMS: 800, productionTimeoutUnchanged: true, selected: pending.url() };
    await pending.close(); releaseHeld();
    await until(async () => activeProbes === 0, 'Deadline aborts every unfinished probe');
    await page.clock.resume();

    step('Pending selection closes on manual choice and on leaving Home');
    await home();
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 60000));
    const manualStart = loopbackRequests.length, manualTime = await page.evaluate(() => performance.now());
    [pending] = await Promise.all([context.waitForEvent('page', { timeout }), frozenNativeClick(card().locator('.lh-bookmark-title'))]);
    await until(async () => (await card().getAttribute('data-routing')) === 'pending', 'Fresh cancellation case starts while still in budget');
    equal(pending.url(), 'about:blank', 'Cancellation starts before any fallback navigation');
    equal(await pending.evaluate(() => window.opener === null), true, 'Cancellation case blank tab has no opener');
    const manual = card().locator('.lh-network-endpoints a[data-route="external"]');
    await openLink(manual, fixtures.external, {}, () => frozenNativeClick(manual, 'pending'));
    await until(async () => pending.isClosed(), 'Manual choice closes the cancelled pending tab');
    equal(await page.evaluate(() => performance.now()), manualTime, 'Manual cancellation happens before the production budget can elapse');
    const manualNavigations = loopbackRequests.slice(manualStart).filter(item => item.kind === 'navigation');
    equal(manualNavigations.map(item => item.origin + item.path), [withoutFragment(fixtures.external)], 'Only the explicit manual navigation occurs; the cancelled blank never navigates');
    measurements.controlledClock.manualCancellation = { closed: pending.isClosed(), beforeBudgetMS: 0, navigations: manualNavigations };
    releaseHeld(); mockMode = 'response';
    await until(async () => activeProbes === 0, 'Manual cancellation aborts every unfinished probe');
    const beforeCancelledRetry = probes.length;
    const primary = card().locator('.lh-bookmark-title');
    await openLink(primary, fixtures.internal, {}, () => frozenNativeClick(primary));
    check(probes.length > beforeCancelledRetry, 'Cancelled probes do not create a negative cache entry');

    await page.clock.resume();
    mockMode = 'hold'; await home();
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 60000));
    const leaveStart = loopbackRequests.length;
    [pending] = await Promise.all([context.waitForEvent('page', { timeout }), frozenNativeClick(card().locator('.lh-bookmark-title'))]);
    await until(async () => (await card().getAttribute('data-routing')) === 'pending', 'Leaving Home starts while the original tab is still pending');
    equal(pending.url(), 'about:blank', 'Leaving Home cancels an unvisited pending tab');
    await page.goto(base.origin + '/#/admin?tab=network', { waitUntil: 'domcontentloaded' });
    await until(async () => pending.isClosed(), 'Leaving Home closes its cancelled pending tab');
    equal(loopbackRequests.slice(leaveStart).filter(item => item.kind === 'navigation'), [], 'Leaving Home does not navigate a cancelled destination');
    measurements.controlledClock.leavingHome = { closed: pending.isClosed(), navigationRequests: 0 };
  } finally {
    releaseHeld(); mockMode = 'response';
    await page.clock.resume();
    measurements.controlledClock.resumed = true;
  }
  await page.locator('.admin-network-settings').waitFor();

  step('Disabled automatic routing restores primary URL while manual routes remain available');
  await setRouting(false); await home();
  const disabledCount = probes.length;
  equal(await card().locator('.lh-bookmark-title').getAttribute('href'), fixtures.main, 'Disabled title uses original primary URL');
  await openLink(card().locator('.lh-bookmark-title'), fixtures.main);
  await openLink(card().locator('.lh-network-endpoints a[data-route="internal"]'), fixtures.internal);
  equal(probes.length, disabledCount, 'Disabled routing makes no probe, including manual selection');
  await setRouting(true);
}
async function realNetworkCheck() {
  if (!realFixtures) { measurements.realNetwork = { executed: false, reason: 'No explicit real-fixture URLs supplied; controlled results do not prove LAN/LNA behavior.' }; return; }
  step('Explicit real-network fixture verification');
  const value = await api(`/spaces/${space.id}/links`, 'POST', {
    title: 'Real network fixture ' + runId, url: fixtures.main, icon: 'lucide:link', iconMode: 'manual',
    endpoints: ['internal', 'external'].map(role => ({ label: 'Real ' + role, url: realFixtures[role], route: role, probePath: realFixtures.paths[role] })),
  }, 201);
  await home();
  const anchor = page.locator(`.lh-bookmark[data-link-id="${value.id}"] .lh-bookmark-title`).first();
  const start = probes.length;
  const [popup] = await Promise.all([context.waitForEvent('page', { timeout }), anchor.click()]);
  await popup.waitForURL(url => [realFixtures.internal, realFixtures.external].some(value => new URL(value).href === url.href), { timeout });
  const chosen = popup.url() === new URL(realFixtures.internal).href ? 'internal' : 'external';
  if (realFixtures.expect !== 'either') equal(chosen, realFixtures.expect, 'Actual browser chose the expected configured real-network route');
  equal(await popup.evaluate(() => window.opener === null), true, 'Real destination has no opener');
  const actual = probes.slice(start).filter(item => item.real);
  check(actual.length > 0 && actual.length <= 2, 'Actual networking is limited to the explicitly configured safe probe paths');
  measurements.realNetwork = { executed: true, simulated: false, expected: realFixtures.expect, selected: chosen, probes: actual.map(item => ({ role: item.role, url: item.url })) };
  await popup.close();
}
function verifyConsole() {
  for (const message of consoleErrors) {
    const conflict = message.phase === 'Real proxy 409 preserves draft until explicit discard/reload'
      && message.url === apiURL('/network-proxy') && /^Failed to load resource: the server responded with a status of 409\b/.test(message.text);
    const target = [...probeTargets.keys()].find(url => message.url === url || message.text.includes(url));
    const originalRedirectProbe = probeURL(fixtures.internal, fixturePaths.internal);
    // Chromium can attribute a refused redirect's ERR_FAILED to its Location,
    // even though Fetch never requested that URL. Accept only this exact case
    // with independent original-failure and zero-target-traffic evidence.
    const refusedRedirectLocation = message.phase === 'Real redirect response is refused without contacting its target'
      && message.url === redirectTrapURL && message.text === 'Failed to load resource: net::ERR_FAILED'
      && loopbackRequests.some(item => item.phase === message.phase && item.kind === 'probe' && item.role === 'internal'
        && item.mode === 'real-redirect' && item.status === 302 && item.origin + item.path === originalRedirectProbe && item.redirectTo === redirectTrapURL)
      && failedRequests.some(item => item.phase === message.phase && item.url === originalRedirectProbe && item.resourceType === 'fetch')
      && !requests.some(item => item.url === redirectTrapURL)
      && !loopbackRequests.some(item => item.kind === 'redirect-trap');
    const refusedRedirect = !!target && message.phase === 'Real redirect response is refused without contacting its target'
      && loopbackRequests.some(item => item.phase === message.phase && item.mode === 'real-redirect' && item.status === 302 && item.origin + item.path === target)
      && /redirect.*(?:mode|follow)/i.test(message.text);
    const failedProbe = !!target && (
      failedRequests.some(item => item.url === target && item.resourceType === 'fetch') && /(?:Failed to load resource:|ERR_)/.test(message.text)
      || /(?:blocked by|Local Network Access|local network|CORS policy|Mixed Content)/i.test(message.text)
      || probeResponses.some(item => item.url === target && item.status >= 400) && /^Failed to load resource: the server responded with a status of [45][0-9]{2}\b/.test(message.text)
      || refusedRedirect
    );
    if (conflict || failedProbe || refusedRedirectLocation) expectedNetworkErrors.push({ ...message,
      reason: conflict ? 'real expected 409' : refusedRedirectLocation ? 'refused configured redirect attributed to its unrequested Location' : 'specific configured probe response/failure',
      ...(target || refusedRedirectLocation ? { probeURL: target || originalRedirectProbe } : {}),
      ...(refusedRedirectLocation ? { unrequestedLocation: redirectTrapURL } : {}) });
    else errors.push(message);
  }
}
function validateRealFixtures() {
  const inside = process.env.LINGSHU_ROUTE_INTERNAL_URL, outside = process.env.LINGSHU_ROUTE_EXTERNAL_URL;
  if (!inside && !outside) return;
  check(!!inside && !!outside, 'Real fixture mode requires both explicit URLs');
  const result = { internal: inside, external: outside, paths: {}, expect: process.env.LINGSHU_ROUTE_EXPECT || 'internal' };
  check(['internal', 'external', 'either'].includes(result.expect), 'Real fixture expected route is explicit');
  for (const role of ['internal', 'external']) {
    const raw = result[role], parsed = new URL(raw);
    check(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && !/[\s\\]/u.test(raw) && raw.length <= 4096, 'Real fixture is a credential-free HTTP(S) URL without query or fragment');
    check(parsed.origin !== base.origin, 'Real route fixture is separate from the disposable Home application');
    result[role] = parsed.href;
    const probe = process.env[`LINGSHU_ROUTE_${role.toUpperCase()}_PROBE_PATH`] || '/favicon.ico';
    check(probe.length <= 256 && /^\/(?!\/)[A-Za-z0-9/_.~-]*$/.test(probe) && !probe.split('/').some(part => part === '.' || part === '..'), 'Real fixture probe uses the same bounded read-path subset');
    result.paths[role] = probe;
  }
  check(result.internal !== result.external, 'Real fixture URLs identify distinct navigation choices');
  realFixtures = result;
}
async function run() {
  check(process.argv.includes('--disposable-instance'), 'Disposable-instance opt-in is required');
  check(base.protocol === 'http:' && !base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'A plain local test origin is required');
  check(['127.0.0.1', 'localhost', '10.233.233.61'].includes(base.hostname), 'Only an approved local test host is accepted');
  check(base.port && !['5180', '5182', '5183', '5184', '5185', '5194', '5195'].includes(base.port), 'Main, previous preview and icon acceptance instances are protected');
  validateRealFixtures();
  const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--disable-dev-shm-usage'] });
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1, locale: 'en-US', serviceWorkers: 'block' });
  context.setDefaultTimeout(timeout); context.setDefaultNavigationTimeout(timeout);
  await refreshBoot(); equal(boot.initialized, false, 'An already initialized instance is refused before any write');
  equal(boot.autoSelectEndpoint, true, 'Fresh instance defaults to automatic endpoint selection');
  check(['zh-CN', 'en'].includes(boot.language), 'Instance uses a supported localized UI');
  if (process.env.LINGSHU_EXPECT_LANGUAGE) equal(boot.language, process.env.LINGSHU_EXPECT_LANGUAGE, 'Instance language matches the requested acceptance run');
  await api('/setup', 'POST', { siteName: 'Home networking acceptance ' + runId, mode: 'open_edit', seedDemo: false, username: 'routing-owner', displayName: 'Routing owner', password: 'Fixture-' + randomUUID() }, 201);
  await refreshBoot(); space = boot.spaces.find(item => item.kind === 'shared');
  check(space?.published && space.canEdit && boot.user?.role === 'Owner', 'Fresh fixture has an authenticated Owner and editable shared space');
  equal((await navigation()).data.links.length, 0, 'Fixture starts with no seeded or imported bookmarks');
  await startLoopbackFixtures();
  await installFixtures();
  page = await context.newPage();

  step('Localized network defaults, four desktop widths and narrow setting persistence');
  await admin('network');
  await page.getByRole('heading', { name: l('浏览器选路', 'Browser routing'), exact: true }).waitFor();
  await page.getByRole('heading', { name: l('服务端代理', 'Server proxy'), exact: true }).waitFor();
  equal(await routingSwitch().isChecked(), true, 'Localized visible routing switch is enabled by default');
  await fourDesktops('network-settings', '.admin-network-settings .admin-card');
  await setRouting(false); await setRouting(true);
  await proxySettings();
  await endpointEditor();
  await browserRouting();
  equal(measurements.controlledClock.resumed, true, 'Controlled cancellation time ends before LAN and idle verification');
  await realNetworkCheck();

  step('Automatic-routing homepage idle budget and complete network/error audit');
  const idleRequestScope = await home();
  equal(boot.autoSelectEndpoint, true, 'Idle sample runs with automatic routing enabled');
  const start = requests.length, beforeProbes = probes.length, beforeSockets = socketCount, beforeLoopback = loopbackRequests.length;
  const idleMS = Number(process.env.IDLE_MS || '15000');
  check(Number.isInteger(idleMS) && idleMS >= 1000 && idleMS <= 70000, 'Idle sample duration is bounded');
  const idleWallStart = Date.now(), idlePageStart = await page.evaluate(() => performance.now());
  for (let remaining = idleMS; remaining > 0; remaining -= Math.min(remaining, 30000)) await page.waitForTimeout(Math.min(remaining, 30000));
  measurements.idle = { durationMS: idleMS, elapsedWallMS: Date.now() - idleWallStart, elapsedPageMS: await page.evaluate(() => performance.now()) - idlePageStart, clockPaused: false, requestScope: idleRequestScope,
    requests: requests.length - start, newRequests: requests.slice(start), inflightAtEnd: unfinishedInScope(idleRequestScope),
    earlierUnfinishedRequestIndices: [...inflightRequests.values()].filter(record => record.index < idleRequestScope.startRequestIndex).map(record => record.index),
    probes: probes.length - beforeProbes, webSockets: socketCount - beforeSockets, loopbackRequests: loopbackRequests.length - beforeLoopback };
  check(measurements.idle.elapsedWallMS >= idleMS && measurements.idle.elapsedPageMS >= idleMS - 50, 'Idle sample uses elapsed wall time and a running browser clock');
  equal(measurements.idle.requests, 0, 'Idle homepage makes no background HTTP request');
  equal(measurements.idle.probes, 0, 'Idle homepage makes no network probes');
  equal(measurements.idle.loopbackRequests, 0, 'Loopback fixture receives no unobserved idle requests');
  equal(socketCount, 0, 'Routing adds no WebSocket');
  check(peakProbes <= 2, 'All clicked bookmarks share a maximum of two concurrent probes');
  for (const item of probes) {
    equal(item.method, 'GET', 'Probe method is read-only GET');
    equal(item.credentialsSent, false, 'Probe sends no Cookie or Authorization');
    equal(item.referrerSent, false, 'Probe sends no Referer');
    if (item.fetchMode) equal(item.fetchMode, 'cors', 'Browser uses readable CORS response mode');
  }
  check(!probes.some(item => /operation=|keep=|#/.test(item.url)), 'Full navigation operations, queries and fragments never become probes');
  equal(unexpectedNetwork, [], 'Browser contacts only Home and explicitly controlled/authorized fixture URLs');
  verifyConsole();
  equal(errors, [], 'No unexpected runtime or console errors; expected probe failures remain separately reported');
  equal(requests.filter(item => item.url === redirectTrapURL).length, 0, 'No probe followed a redirect during the complete run');
  equal(loopbackRequests.filter(item => item.kind === 'redirect-trap').length, 0, 'The real redirect target remains untouched');
  measurements.routing = { controlledProbeSimulation: true, realCORSPolicyChecks: true, nativeNavigation: 'Real read-only loopback HTTP; exact URL, opener and referrer checked for normal, Ctrl and middle clicks', counts: { simulatedProbes: probes.filter(item => item.transport === 'simulated').length, realLoopbackProbes: probes.filter(item => item.transport === 'real-loopback').length, realExternalProbes: probes.filter(item => item.transport === 'real-external').length, peakConcurrent: peakProbes }, budget: '800ms total in core; browser timings are not site health or precise latency measurements' };
}
let failure;
run().catch(error => { failure = error; errors.push({ phase, message: error.message }); }).finally(async () => {
  releaseHeld();
  const latestScope = measurements.homeRequestScopes?.at(-1);
  // Snapshot unresolved observations before browser shutdown can cancel them.
  // This records their actual state; it does not invent completion events.
  const unfinishedAtRunEnd = [...inflightRequests.values()].map(record => ({ ...record,
    scope: latestScope ? record.index >= latestScope.startRequestIndex ? 'latest Home request scope' : 'before latest Home request scope' : 'before any Home request scope' }));
  if (failure) await capture('failure', true).catch(() => {});
  await browser?.close();
  await Promise.all(fixtureServers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  const report = { status: failure ? 'failed' : 'passed', runId, phase, language: boot?.language, origin: base.origin, checks, measurements, screenshots, errors, consoleErrors, expectedNetworkErrors, failedRequests, unexpectedNetwork, probes, probeResponses,
    requests, unfinishedAtRunEnd, requestCount: requests.length, completedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: report.status, checks, language: report.language, phase, errors }) + '\n');
  if (failure) process.exitCode = 1;
});
