#!/usr/bin/env node
'use strict';
/** Automatic-icon UI acceptance against a fresh, explicitly disposable instance.
 * BASE_URL=http://127.0.0.1:5194 node tests/browser_auto_icons.cjs --disposable-instance
 * Uses reserved .invalid bookmarks and original local SVG bytes; no external website fixture.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const runId = randomUUID().slice(0, 12), timeout = 15000;
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:5194');
const reportPath = process.env.REPORT_PATH || path.join(os.tmpdir(), `home-auto-icons-${runId}.json`);
let browser, context, page, boot, space, csrf = '', checks = 0, phase = 'preflight';
const errors = [], browserRequests = [], foreign = [], screenshots = [], metrics = {};
let sockets = 0;
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const check = (value, label) => { assert.ok(value, label); checks++; };
const l = (zh, en) => boot.language === 'en' ? en : zh;
const step = label => { phase = label; process.stdout.write(JSON.stringify({ phase, checks }) + '\n'); };
const apiURL = value => base.origin + '/api/v1' + value;
async function api(relative, method = 'GET', body, status = 200) {
  const response = await context.request.fetch(apiURL(relative), { method, data: body, headers: { 'X-CSRF-TOKEN': csrf }, timeout, maxRedirects: 0 });
  equal(response.status(), status, `${method} ${relative}: status`);
  return status === 204 ? null : response.json();
}
async function refreshBoot() { boot = await api('/bootstrap'); csrf = boot.csrfToken; return boot; }
async function navigation() { return api(`/spaces/${space.id}/navigation`); }
async function record(title) { return (await navigation()).data.links.find(link => link.title === title); }
async function admin(tab) {
  await page.goto(base.origin + '/#/admin?tab=' + tab, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.admin-shell').waitFor();
}
async function expectWrite(relative, method, action) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url() === apiURL(relative) && response.request().method() === method, { timeout }),
    action()
  ]);
  check(response.status() >= 200 && response.status() < 300, `${method} ${relative}: real UI write succeeded`);
  return { body: response.request().postDataJSON(), value: await response.json() };
}
async function setAutomaticSetting(enabled) {
  await admin('access');
  const checkbox = page.getByRole('checkbox', { name: l('自动获取网页图标', 'Automatically fetch website icons'), exact: true });
  equal(await checkbox.isChecked(), !enabled, 'Setting starts in the opposite state');
  await checkbox.click();
  const result = await expectWrite('/settings', 'PUT', () => page.getByRole('button', { name: l('保存访问设置', 'Save access settings'), exact: true }).click());
  equal(result.body.autoFetchIcons, enabled, 'UI sends the selected boolean');
  equal(result.value.autoFetchIcons, enabled, 'Settings response persists the selected boolean');
  await refreshBoot(); equal(boot.autoFetchIcons, enabled, 'Bootstrap exposes the saved switch');
  await admin('access');
  equal(await checkbox.isChecked(), enabled, 'Setting survives a full document reload');
}
function mode(name) { return page.getByRole('group', { name: l('图标模式', 'Icon mode'), exact: true }).getByRole('button', { name, exact: true }); }
async function editLink(title) {
  await admin('links');
  await page.getByRole('row').filter({ hasText: title }).getByRole('button', { name: l('编辑 ', 'Edit ') + title, exact: true }).click();
  await page.getByRole('dialog', { name: l('编辑链接', 'Edit link'), exact: true }).waitFor();
}
async function saveLink(id) {
  const result = await expectWrite(`/spaces/${space.id}/links${id ? '/' + id : ''}`, id ? 'PUT' : 'POST', () => page.getByRole('button', { name: l('保存链接', 'Save link'), exact: true }).click());
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  return result;
}
async function addLink(title, url, automatic = true) {
  await admin('links');
  await page.getByRole('button', { name: l('添加链接', 'Add link'), exact: true }).click();
  equal(await mode(l('自动获取', 'Automatic')).getAttribute('aria-pressed'), 'true', 'New link defaults to automatic mode');
  await page.getByLabel(l('链接名称', 'Link name'), { exact: true }).fill(title);
  await page.getByLabel(l('主入口 URL', 'Primary URL'), { exact: true }).fill(url);
  if (!automatic) {
    await page.getByRole('button', { name: l('使用默认图标', 'Use default'), exact: true }).click();
    equal(await mode(l('手动选择', 'Manual selection')).getAttribute('aria-pressed'), 'true', 'Choosing the default image is an explicit manual choice');
  }
  const result = await saveLink();
  equal(result.body.iconMode, automatic ? 'auto' : 'manual', 'Link form sends the intended icon mode');
  return result.value;
}
async function layout(label) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  check(geometry.scrollWidth <= geometry.width + 1, `${label}: document has no horizontal overflow`);
  if (process.env.SCREENSHOT_DIR) {
    const target = path.join(process.env.SCREENSHOT_DIR, `${boot.language}-${label}.png`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await page.screenshot({ path: target, fullPage: false }); screenshots.push(target);
  }
}
async function run() {
  check(process.argv.includes('--disposable-instance'), 'Disposable-instance opt-in is required');
  check(base.protocol === 'http:' && !base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'A plain local test origin is required');
  check(['127.0.0.1', 'localhost', '10.233.233.61'].includes(base.hostname), 'Only an approved local test host is accepted');
  check(base.port && !['5180', '5182', '5183', '5184', '5185'].includes(base.port), 'Main and existing preview services are protected');
  const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1, locale: 'en-US', serviceWorkers: 'block' });
  context.setDefaultTimeout(timeout); context.setDefaultNavigationTimeout(timeout);
  await refreshBoot(); equal(boot.initialized, false, 'Existing initialized instances are refused before any write');
  equal(boot.autoFetchIcons, true, 'New instance defaults to automatic website icons');
  await api('/setup', 'POST', { siteName: 'Home icon acceptance', mode: 'open_edit', seedDemo: false }, 201);
  await refreshBoot(); space = boot.spaces.find(item => item.id === boot.defaultSpaceId);
  check(space?.kind === 'shared' && space.published && space.canEdit, 'Fixture owns its fresh editable shared space');
  equal((await api('/settings')).autoFetchIcons, true, 'Persisted setting defaults on after setup');
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== base.origin) { foreign.push(url.origin); await route.abort(); }
    else await route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => browserRequests.push({ method: request.method(), path: new URL(request.url()).pathname }));
  page.on('websocket', () => { sockets++; });
  page.on('dialog', async dialog => { errors.push('Unexpected native dialog: ' + dialog.type()); await dialog.dismiss(); });

  step('default setting, responsive settings and persistence');
  await admin('access');
  equal(await page.getByRole('checkbox', { name: l('自动获取网页图标', 'Automatically fetch website icons'), exact: true }).isChecked(), true, 'Visible checkbox is enabled by default');
  await layout('settings-2560');
  await page.setViewportSize({ width: 390, height: 844 }); await layout('settings-390');
  await page.setViewportSize({ width: 2560, height: 1440 });
  await setAutomaticSetting(false);
  const paused = await addLink('Paused automatic bookmark', 'https://paused.invalid/private?key=fixture#anchor');
  equal(paused.iconMode, 'auto', 'Disabled global acquisition keeps per-link automatic intent');
  equal(paused.icon, 'lucide:link', 'Disabled acquisition keeps a local fallback');
  await editLink(paused.title);
  check(await page.getByText(l('自动获取已由站点设置暂停。已保存图标继续显示，你仍可手动选择或获取。', 'Automatic fetching is paused in site settings. Saved icons stay visible; you can still select or fetch an icon manually.'), { exact: true }).isVisible(), 'Link form explains the paused global policy');
  check(await page.getByRole('button', { name: l('获取网站图标', 'Fetch website icon'), exact: true }).isEnabled(), 'Explicit fetch remains available while automatic fetching is disabled');
  await page.getByRole('button', { name: l('取消', 'Cancel'), exact: true }).click();
  await setAutomaticSetting(true);

  step('automatic/manual intent, draft cancellation and URL editing');
  const automatic = await addLink('Automatic bookmark', 'https://automatic.invalid/a?private=fixture#fragment');
  equal(automatic.iconMode, 'auto', 'Automatic creation is stored');
  const manual = await addLink('Manual bookmark', 'https://manual.invalid/', false);
  equal((await record(manual.title)).iconMode, 'manual', 'Manual choice survives a fresh navigation read');
  await editLink(manual.title);
  equal(await mode(l('手动选择', 'Manual selection')).getAttribute('aria-pressed'), 'true', 'Editor restores the saved manual mode');
  const writesBeforeMode = browserRequests.filter(item => item.method !== 'GET').length;
  await mode(l('自动获取', 'Automatic')).click();
  await page.getByRole('button', { name: l('取消', 'Cancel'), exact: true }).click();
  equal(browserRequests.filter(item => item.method !== 'GET').length, writesBeforeMode, 'Changing and cancelling the mode does not fetch or write');
  equal((await record(manual.title)).iconMode, 'manual', 'Cancelled automatic mode is not persisted');
  await editLink(automatic.title);
  await page.getByLabel(l('主入口 URL', 'Primary URL'), { exact: true }).fill('https://changed.invalid/new-origin');
  await page.getByRole('button', { name: l('使用默认图标', 'Use default'), exact: true }).click();
  const changed = await saveLink(automatic.id);
  equal(changed.value.iconMode, 'manual', 'Saving an explicit default choice persists manual mode after URL editing');
  equal((await record(automatic.title)).url, 'https://changed.invalid/new-origin', 'Edited origin survives a full read');
  await editLink(manual.title); await mode(l('自动获取', 'Automatic')).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await mode(l('自动获取', 'Automatic')).scrollIntoViewIfNeeded(); await layout('link-mode-390');
  await page.setViewportSize({ width: 2560, height: 1440 });
  await mode(l('自动获取', 'Automatic')).scrollIntoViewIfNeeded(); await layout('link-mode-2560');
  equal((await saveLink(manual.id)).value.iconMode, 'auto', 'Explicitly selecting automatic mode and saving opts a link in');

  step('browser-bookmark preview/import and explicit refresh');
  await admin('bookmarks');
  await page.getByRole('button', { name: l('选择书签文件', 'Choose bookmark file'), exact: true }).click();
  const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><TITLE>Fixture</TITLE><DL><p><DT><A HREF="https://imported.invalid/path">Imported auto fixture</A></DL><p>';
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'auto-icons.html', mimeType: 'text/html', buffer: Buffer.from(html) });
  await expectWrite(`/spaces/${space.id}/bookmarks/preview`, 'POST', () => page.getByRole('button', { name: l('预览文件', 'Preview file'), exact: true }).click());
  check(!(await record('Imported auto fixture')), 'Preview does not create a bookmark');
  const imported = await expectWrite(`/spaces/${space.id}/bookmarks/import`, 'POST', () => page.getByRole('button', { name: l('确认导入', 'Import bookmarks'), exact: true }).click());
  equal(imported.value.imported, 1, 'Real file import reports one new link');
  equal((await record('Imported auto fixture')).iconMode, 'auto', 'Imported bookmark stores automatic icon intent');
  await admin('links');
  const [refresh] = await Promise.all([page.waitForResponse(response => response.url() === apiURL(`/spaces/${space.id}/navigation`) && response.request().method() === 'GET'), page.getByRole('button', { name: l('刷新列表', 'Refresh list'), exact: true }).click()]);
  equal(refresh.status(), 200, 'Refresh list reads the local authoritative dataset');

  step('local image storage, browser revalidation and idle requests');
  const svg = '<svg viewBox="0 0 24 24" fill="none" stroke="#2266aa" stroke-width="2"><path d="M4 12 12 4 20 12M6 10v10h12V10"/></svg>';
  const pack = await api(`/spaces/${space.id}/icon-packs`, 'POST', { schemaVersion: 1, name: 'Cache fixture', sourceUrl: '', license: 'Original test artwork, Apache-2.0', icons: [{ key: 'fixture', label: 'Fixture image', mediaType: 'image/svg+xml', dataBase64: Buffer.from(svg).toString('base64') }] }, 201);
  const asset = pack.icons[0];
  await api(`/spaces/${space.id}/links`, 'POST', { title: 'Server image fixture', url: 'https://image.invalid/', icon: asset.ref, iconMode: 'manual', tags: [], endpoints: [] }, 201);
  const first = await context.request.get(base.origin + asset.url); equal(first.status(), 200, 'Image bytes are served from Home');
  equal(first.headers()['cache-control'], 'private, no-cache', 'Browser image cache requires permission revalidation');
  const second = await context.request.get(base.origin + asset.url, { headers: { 'If-None-Match': first.headers().etag } });
  equal(second.status(), 304, 'Matching image ETag reuses the persisted bytes'); equal((await second.body()).length, 0, '304 has no response body');
  await page.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded' }); await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.lh-home').waitFor();
  const img = page.locator(`img[src="${asset.url}"]`).first(); await img.waitFor();
  check(await img.evaluate(element => element.complete && element.naturalWidth > 0), 'Home renders the persisted same-origin image after reload');
  await page.locator('.lh-more-trigger').click();
  const [homeRefresh] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/dashboard' && response.request().method() === 'GET'), page.getByRole('menuitem', { name: l('刷新内容', 'Refresh content'), exact: true }).click()]);
  equal(homeRefresh.status(), 200, 'Refresh content is an explicit dashboard read');
  await page.waitForLoadState('networkidle'); await layout('homepage-2560');
  const idleStart = browserRequests.length; const idleMS = Number(process.env.IDLE_MS || '15000');
  check(Number.isInteger(idleMS) && idleMS >= 1000 && idleMS <= 70000, 'Idle sample is bounded');
  await page.waitForTimeout(idleMS);
  metrics.idle = { durationMS: idleMS, requests: browserRequests.length - idleStart, webSockets: sockets };
  equal(metrics.idle.requests, 0, 'Navigation-only homepage makes no requests during the idle window');
  equal(sockets, 0, 'Automatic icons add no WebSocket');
  equal(foreign, [], 'Browser never requests an external origin');
  equal(errors, [], 'No browser runtime or console errors');
}
let failure;
run().catch(error => { failure = error; errors.push(`${phase}: ${error.message}`); }).finally(async () => {
  if (failure && page && process.env.SCREENSHOT_DIR) { await layout('failure').catch(() => {}); }
  await browser?.close();
  const report = { status: failure ? 'failed' : 'passed', runId, phase, language: boot?.language, origin: base.origin, checks, metrics, screenshots, errors, foreignOrigins: foreign, browserRequestCount: browserRequests.length, completedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: report.status, checks, language: report.language, phase, errors }) + '\n');
  if (failure) process.exitCode = 1;
});
