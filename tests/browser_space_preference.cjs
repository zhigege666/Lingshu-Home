#!/usr/bin/env node
'use strict';
// Fresh, disposable private_multi fixtures only; never copied/user databases.
// BASE_URL=http://127.0.0.1:5216 node tests/browser_space_preference.cjs --allow-fixture-write
// Use 5216 for Chinese, 5217 for English. The fixture must be uninitialized.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
const base = new URL(process.env.BASE_URL || '');
assert.ok(process.argv.includes('--allow-fixture-write'), 'Pass --allow-fixture-write for this disposable test');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '10.233.233.61'].includes(base.hostname)
  && ['5216', '5217'].includes(base.port) && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password,
  'Only dedicated space-preference fixture ports 5216/5217 are allowed');
const run = randomUUID().slice(0, 8);
const ownerCredentials = { username: 'space-owner-' + run, password: 'Space-owner-fixture-' + run };
const memberCredentials = { username: 'space-member-' + run, password: 'Space-member-fixture-' + run };
const out = path.resolve(process.env.OUTPUT_DIR || path.join(require('node:os').tmpdir(), 'space-preference-' + base.port + '-' + run));
fs.mkdirSync(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), origin: base.origin, run, checks: [], screenshots: [], expectedFailures: [], pageErrors: [], consoleErrors: [], dashboardRequests: [] };
let browser, context, page, boot, csrf, ownerBoot, memberBoot, shared, ownerPersonal, memberPersonal, phase = 'preflight';
const l = (zh, en) => boot.language === 'en' ? en : zh;
const preferenceKey = user => 'lingshu-home:space-preferences:v1:user:' + user.id;
const tabKey = user => 'lingshu-home:space:v1:user:' + user.id;
const optionLabel = space => space.name + (space.kind === 'personal' ? l(' · 私人', ' · Personal') : '');
const selector = tab => tab.getByRole('combobox', { name: l('选择空间', 'Choose a space'), exact: true });
const settings = tab => tab.getByRole('button', { name: l('默认打开空间', 'Default opening space'), exact: true });
const menu = tab => tab.locator('.lh-space-preference-menu');
async function api(method, relative, data, expected = 200) {
  const response = await context.request.fetch(base.origin + '/api/v1' + relative, { method, data, headers: { 'X-CSRF-TOKEN': csrf || '' }, maxRedirects: 0, timeout: 15_000 });
  assert.equal(response.status(), expected, method + ' ' + relative + ': HTTP ' + response.status());
  return expected === 204 ? null : response.json();
}
async function refreshBootstrap() { boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken; return boot; }
async function step(name, action) {
  phase = name; console.log(JSON.stringify({ event: 'step', name }));
  const began = Date.now(); await action(); report.checks.push({ name, status: 'passed', durationMs: Date.now() - began });
}
async function newPage() {
  const tab = await context.newPage();
  tab.on('pageerror', error => report.pageErrors.push({ phase, message: error.message }));
  tab.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ phase, text: message.text().slice(0, 300) }); });
  tab.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base.origin && url.pathname === '/api/v1/dashboard') report.dashboardRequests.push({ phase, spaceId: url.searchParams.get('spaceId') });
  });
  return tab;
}
async function settle(tab = page) { await tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function waitSpace(tab, space) {
  await tab.locator('.lh-home').waitFor();
  await selector(tab).waitFor();
  await tab.waitForFunction(({ label }) => document.querySelector('.lh-space-control')?.textContent.trim() === label, { label: optionLabel(space) });
}
async function home(tab, space) { await tab.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded' }); await waitSpace(tab, space); }
async function chooseSpace(tab, space) { await selector(tab).click(); await tab.getByRole('option', { name: optionLabel(space), exact: true }).click(); await waitSpace(tab, space); }
async function preferences(tab = page, user = boot.user) {
  return tab.evaluate(key => JSON.parse(localStorage.getItem(key) || '{"lastSpaceId":"","defaultSpaceId":""}'), preferenceKey(user));
}
async function openSettings(tab = page) { await settings(tab).click(); await menu(tab).waitFor(); }
async function closeSettings(tab = page) { await tab.keyboard.press('Escape'); await menu(tab).waitFor({ state: 'hidden' }); }
async function chooseDefault(tab, space) {
  await openSettings(tab);
  await menu(tab).getByRole('radio', { name: space ? space.name : l('记住上次空间', 'Remember last space'), exact: true }).check();
  await menu(tab).getByRole('radio', { name: space ? space.name : l('记住上次空间', 'Remember last space'), exact: true }).waitFor();
  assert.equal(await menu(tab).getByRole('radio', { name: space ? space.name : l('记住上次空间', 'Remember last space'), exact: true }).isChecked(), true);
  await closeSettings(tab);
}
async function logout(tab = page) {
  await tab.getByRole('button', { name: l('退出登录', 'Sign out'), exact: true }).click();
  await tab.locator('input[autocomplete="username"]').waitFor();
  await refreshBootstrap(); assert.equal(boot.user, null);
}
async function login(credentials, expectedSpace, tab = page) {
  await tab.locator('input[autocomplete="username"]').fill(credentials.username);
  await tab.locator('input[autocomplete="current-password"]').fill(credentials.password);
  const response = tab.waitForResponse(item => new URL(item.url()).pathname === '/api/v1/auth/login' && item.request().method() === 'POST');
  await tab.locator('form button[type="submit"]').click();
  assert.equal((await response).status(), 200);
  await refreshBootstrap();
  await waitSpace(tab, expectedSpace);
}
async function capture(name, tab = page) { await settle(tab); const file = path.join(out, boot.language + '-' + name + '.png'); await tab.screenshot({ path: file, fullPage: false }); report.screenshots.push(file); }
async function seedPreference(tab, user, value, manual = '') {
  await tab.evaluate(({ key, tabKey, value, manual }) => {
    if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key);
    if (manual) sessionStorage.setItem(tabKey, manual); else sessionStorage.removeItem(tabKey);
  }, { key: preferenceKey(user), tabKey: tabKey(user), value, manual });
}

async function main() {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'], ignoreDefaultArgs: ['--hide-scrollbars'] });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  context.setDefaultTimeout(15_000);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === base.origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  await refreshBootstrap();
  assert.equal(boot.initialized, false, 'This test requires a fresh dedicated fixture; it will not alter existing accounts or navigation');
  if (boot.languageSelectionRequired) {
    boot = await api('POST', '/setup/language', { language: base.port === '5217' ? 'en' : 'zh-CN' }); csrf = boot.csrfToken;
  }
  const fixtureName = 'Space preference fixture ' + boot.language;
  await api('POST', '/setup', { siteName: fixtureName, mode: 'private_multi', ...ownerCredentials, displayName: 'Space Owner ' + run, seedDemo: false }, 201);
  ownerBoot = await refreshBootstrap();
  assert.equal(boot.siteName, fixtureName); assert.equal(boot.mode, 'private_multi'); assert.equal(boot.user?.role, 'Owner');
  shared = boot.spaces.find(space => space.kind === 'shared'); ownerPersonal = boot.spaces.find(space => space.kind === 'personal');
  assert.ok(shared && ownerPersonal);
  await api('POST', '/admin/users', { ...memberCredentials, displayName: 'Space Member ' + run }, 201);
  // A separate HTTP context discovers the Member's accessible inventory through
  // a real login without replacing the main browser's Owner session.
  const memberContext = await browser.newContext();
  try {
    const fresh = await (await memberContext.request.get(base.origin + '/api/v1/bootstrap')).json();
    const loginResponse = await memberContext.request.post(base.origin + '/api/v1/auth/login', { data: memberCredentials, headers: { 'X-CSRF-TOKEN': fresh.csrfToken } });
    assert.equal(loginResponse.status(), 200);
    memberBoot = await (await memberContext.request.get(base.origin + '/api/v1/bootstrap')).json();
    memberPersonal = memberBoot.spaces.find(space => space.kind === 'personal'); assert.ok(memberPersonal);
    assert.equal(memberBoot.user.username, memberCredentials.username);
  } finally { await memberContext.close(); }
  page = await newPage();

  await step('last successful space survives closing the tab and opening an independent page', async () => {
    await home(page, ownerPersonal);
    await chooseSpace(page, shared);
    assert.deepEqual(await preferences(), { lastSpaceId: shared.id, defaultSpaceId: '' });
    await page.close(); page = await newPage();
    await home(page, shared);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), tabKey(ownerBoot.user)), null);
    await capture('last-space-new-page');
  });

  await step('fixed default applies to fresh pages while successful manual choice wins in its tab', async () => {
    await chooseDefault(page, ownerPersonal);
    await waitSpace(page, shared);
    const fresh = await newPage();
    try {
      await home(fresh, ownerPersonal);
      assert.deepEqual(await preferences(fresh), { lastSpaceId: ownerPersonal.id, defaultSpaceId: ownerPersonal.id });
      await chooseSpace(fresh, shared);
      await fresh.reload({ waitUntil: 'domcontentloaded' }); await waitSpace(fresh, shared);
      assert.deepEqual(await preferences(fresh), { lastSpaceId: shared.id, defaultSpaceId: ownerPersonal.id });
    } finally { await fresh.close(); }
    const another = await newPage();
    try { await home(another, ownerPersonal); } finally { await another.close(); }
    await chooseSpace(page, ownerPersonal); await chooseSpace(page, shared);
    await chooseDefault(page, null);
    const remembered = await newPage();
    try { await home(remembered, shared); assert.equal((await preferences(remembered)).defaultSpaceId, ''); } finally { await remembered.close(); }
  });

  await step('real sign-out and two real sign-ins retain each account own default and last space', async () => {
    const ownerPreferences = await preferences(page, ownerBoot.user);
    await logout();
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), tabKey(ownerBoot.user)), null);
    await login(memberCredentials, memberPersonal);
    assert.equal(boot.user.id, memberBoot.user.id);
    assert.deepEqual(await preferences(page, ownerBoot.user), ownerPreferences);
    await chooseDefault(page, memberPersonal); await chooseSpace(page, shared);
    const memberPreferences = await preferences(page, memberBoot.user);
    assert.deepEqual(memberPreferences, { lastSpaceId: shared.id, defaultSpaceId: memberPersonal.id });
    await logout(); await login(ownerCredentials, shared);
    assert.equal(boot.user.id, ownerBoot.user.id);
    assert.deepEqual(await preferences(page, memberBoot.user), memberPreferences);
    assert.equal((await preferences()).defaultSpaceId, '');
    await capture('owner-return-after-member');
  });

  await step('failed dashboard switch cannot change last success, manual choice, or fixed default', async () => {
    await chooseSpace(page, ownerPersonal); await chooseDefault(page, shared);
    const before = await preferences();
    const failedURL = base.origin + '/api/v1/dashboard?spaceId=' + shared.id;
    await page.route(failedURL, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'fixture_unavailable', message: 'Fixture dashboard unavailable' }) }));
    try {
      const failed = page.waitForResponse(response => response.url() === failedURL);
      await selector(page).click(); await page.getByRole('option', { name: optionLabel(shared), exact: true }).click();
      assert.equal((await failed).status(), 503); report.expectedFailures.push({ phase, status: 503 });
      await page.getByRole('alert').filter({ hasText: 'Fixture dashboard unavailable' }).waitFor();
      await waitSpace(page, ownerPersonal);
      assert.deepEqual(await preferences(), before);
      assert.equal(await page.evaluate(key => sessionStorage.getItem(key), tabKey(ownerBoot.user)), ownerPersonal.id);
    } finally { await page.unroute(failedURL); }
  });

  await step('403 and 404 clear a rejected fixed target and recover without a retry loop', async () => {
    for (const status of [403, 404]) {
      await seedPreference(page, ownerBoot.user, { lastSpaceId: ownerPersonal.id, defaultSpaceId: shared.id });
      const fresh = await newPage(), targetURL = base.origin + '/api/v1/dashboard?spaceId=' + shared.id;
      let attempts = 0;
      await fresh.route(targetURL, route => { attempts++; return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ code: 'fixture_forbidden', message: 'Fixture permission changed' }) }); });
      try {
        await home(fresh, ownerPersonal);
        assert.equal(attempts, 1, 'a stale bootstrap inventory must not cause a request loop');
        assert.deepEqual(await preferences(fresh), { lastSpaceId: ownerPersonal.id, defaultSpaceId: '' });
        report.expectedFailures.push({ phase, status, simulated: true });
      } finally { await fresh.close(); }
    }
  });

  await step('stale preferences outside the current access inventory are cleared before any request', async () => {
    await seedPreference(page, ownerBoot.user, { lastSpaceId: memberPersonal.id, defaultSpaceId: memberPersonal.id }, memberPersonal.id);
    const before = report.dashboardRequests.length;
    await page.reload({ waitUntil: 'domcontentloaded' }); await waitSpace(page, ownerPersonal);
    assert.ok(report.dashboardRequests.slice(before).every(item => item.spaceId !== memberPersonal.id));
    assert.deepEqual(await preferences(), { lastSpaceId: ownerPersonal.id, defaultSpaceId: '' });
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), tabKey(ownerBoot.user)), null);
  });

  await step('legacy tab record migrates after a successful dashboard response', async () => {
    await seedPreference(page, ownerBoot.user, null);
    const fresh = await newPage();
    await fresh.addInitScript(({ key, id }) => sessionStorage.setItem(key, id), { key: tabKey(ownerBoot.user), id: shared.id });
    try {
      await home(fresh, shared);
      assert.deepEqual(await preferences(fresh), { lastSpaceId: shared.id, defaultSpaceId: '' });
    } finally { await fresh.close(); }
  });

  await step('preference popover has keyboard focus and stays in the viewport at desktop and phone widths', async () => {
    for (const [width, height] of [[1600, 900], [1920, 1080], [2560, 1440], [3440, 1440], [390, 844]]) {
      await page.setViewportSize({ width, height }); await openSettings();
      const checked = menu(page).locator('input:checked');
      await page.waitForFunction(element => element === document.activeElement, await checked.elementHandle());
      const bounds = await menu(page).boundingBox(); assert.ok(bounds);
      assert.ok(bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1);
      const scrollWidth = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
      assert.ok(scrollWidth <= width + 1, 'horizontal overflow at width ' + width);
      await capture('default-space-' + width);
      await closeSettings();
      await page.waitForFunction(element => element === document.activeElement, await settings(page).elementHandle());
    }
    await page.setViewportSize({ width: 1600, height: 900 });
  });

  await step('blocked storage does not prevent reading, switching, sign-out or real sign-in', async () => {
    const fresh = await newPage();
    await fresh.addInitScript(() => {
      for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, { configurable: true, get() { throw new DOMException('Fixture storage denied', 'SecurityError'); } });
    });
    try {
      await home(fresh, ownerPersonal); await chooseSpace(fresh, shared);
      await openSettings(fresh);
      await menu(fresh).getByRole('radio', { name: ownerPersonal.name, exact: true }).click();
      await menu(fresh).getByRole('alert').waitFor();
      assert.ok(await menu(fresh).getByRole('radio', { name: l('记住上次空间', 'Remember last space'), exact: true }).isChecked());
      await closeSettings(fresh);
      await logout(fresh); await login(ownerCredentials, ownerPersonal, fresh);
      await chooseSpace(fresh, shared);
      await capture('blocked-storage-navigation', fresh);
    } finally { await fresh.close(); }
  });
  assert.deepEqual(report.pageErrors, [], 'No unhandled browser exceptions');
  report.status = 'passed';
}

main().catch(async error => {
  report.status = 'failed'; report.failedPhase = phase; report.error = error.stack || error.message; process.exitCode = 1;
  try { if (page && !page.isClosed()) await capture('failure'); } catch {}
}).finally(async () => {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, report: path.join(out, 'report.json'), passed: report.checks.length, failedPhase: report.failedPhase }));
  if (browser) await browser.close();
});
