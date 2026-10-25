#!/usr/bin/env node
'use strict';
// Requires NEW disposable fixtures only: 5222 zh-CN / 5223 en.
// BASE_URL=http://127.0.0.1:5222 node tests/browser_integration_confirm.cjs --allow-fixture-write
// This creates a real fixture Owner. Its random credentials and PAT secret stay
// in memory and are never logged. Discard the fixture database after the run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
const base = new URL(process.env.BASE_URL || '');
assert.ok(process.argv.includes('--allow-fixture-write'), 'Pass --allow-fixture-write for the disposable fixture');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', '10.233.233.61', 'localhost'].includes(base.hostname)
  && ['5222', '5223'].includes(base.port) && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password,
  'Only fresh integration-confirm fixtures on ports 5222/5223 are allowed');
const run = randomUUID().slice(0, 8), prefix = 'Integration confirm ' + run;
const out = path.resolve(process.env.OUTPUT_DIR || path.join(require('node:os').tmpdir(), 'integration-confirm-' + base.port + '-' + run));
fs.mkdirSync(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), origin: base.origin, run, requiresDisposableInstance: true, checks: [], screenshots: [], geometry: [], mutations: [], blocked: [], pageErrors: [], consoleErrors: [], expectedFailures: [], cleanup: [] };
const sources = new Map(), tokens = new Map();
let browser, context, page, boot, csrf, space, originalPage, originalNavigation, ownedRevision, disposableSource, protectedSource, token;
let approved = false, pageChanged = false, armed = null, phase = 'preflight';
const l = (zh, en) => boot.language === 'en' ? en : zh;
const button = (scope, zh, en) => scope.getByRole('button', { name: l(zh, en), exact: true });
const apiURL = suffix => base.origin + '/api/v1' + suffix;
const relative = suffix => '/spaces/' + space.id + suffix;
const records = nav => ({ revision: nav.revision, data: { links: [...nav.data.links].sort((a,b) => a.id.localeCompare(b.id)), categories: [...nav.data.categories].sort((a,b) => a.id.localeCompare(b.id)) } });
async function api(method, suffix, data, expected = 200) {
  const response = await context.request.fetch(apiURL(suffix), { method, data, headers: { 'X-CSRF-TOKEN': csrf || '' }, maxRedirects: 0, timeout: 15_000 });
  assert.equal(response.status(), expected, method + ' ' + suffix + ': unexpected HTTP ' + response.status());
  return expected === 204 ? null : response.json();
}
const readSources = () => api('GET', relative('/sources'));
const readTokens = () => api('GET', '/integrations/tokens');
const readPage = () => api('GET', relative('/page'));
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function step(name, action) { phase = name; console.log(JSON.stringify({ event: 'step', name })); const start = Date.now(); await action(); report.checks.push({ name, status: 'passed', durationMs: Date.now() - start }); }
async function capture(name) { await settle(); const file = path.join(out, boot.language + '-' + name + '.png'); await page.screenshot({ path: file, fullPage: false }); report.screenshots.push(file); }
async function focused(control) { await control.waitFor(); await page.waitForFunction(element => element === document.activeElement, await control.elementHandle()); }
async function unchangedNavigation() { assert.deepEqual(records(await api('GET', relative('/navigation'))), records(originalNavigation)); }
async function admin(kind) {
  const target = base.origin + '/#/admin?tab=integrations';
  if (page.url() === target) await page.reload(); else await page.goto(target);
  await page.getByRole('tab', { name: l('数据源', 'Sources'), exact: true }).waitFor();
  const picker = page.getByRole('combobox', { name: l('当前空间', 'Current space'), exact: true });
  if (!(await picker.innerText()).includes(space.name)) {
    await picker.click(); await page.getByRole('option', { name: space.name + l(' · 个人', ' · Personal'), exact: true }).click();
  }
  await page.getByRole('tab', { name: kind === 'source' ? l('数据源', 'Sources') : l('MCP 与访问令牌', 'MCP and access tokens'), exact: true }).click();
}
const trigger = (kind, record) => button(page, kind === 'source' ? '删除数据源 ' + record.name : '撤销令牌 ' + record.name, kind === 'source' ? 'Delete source ' + record.name : 'Revoke token ' + record.name);
async function open(kind, record, keyboard = false) {
  const action = trigger(kind, record); await action.scrollIntoViewIfNeeded();
  if (keyboard) { await action.focus(); await action.press('Enter'); } else await action.click();
  const popover = page.locator('.lh-confirm-popover[data-confirm-kind="' + kind + '"]'); await popover.waitFor(); await settle();
  assert.equal(await popover.getAttribute('role'), 'dialog'); assert.equal(await action.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(await action.getAttribute('aria-expanded'), 'true'); assert.equal(await action.getAttribute('aria-controls'), await popover.getAttribute('id'));
  assert.equal(await page.locator('[data-slot="dialog-overlay"]:visible,.cn-dialog-overlay:visible').count(), 0);
  await focused(popover.locator('[data-confirm-cancel]'));
  const p = await popover.boundingBox(), a = await action.boundingBox(), viewport = page.viewportSize();
  assert.ok(p && a && p.x >= 10 && p.y >= 10 && p.x + p.width <= viewport.width - 10 && p.y + p.height <= viewport.height - 10, 'Confirmation fits the viewport without an overlay');
  const gap = Math.min(Math.abs(p.y - a.y - a.height), Math.abs(a.y - p.y - p.height));
  assert.ok(gap <= 24 && p.x < a.x + a.width && p.x + p.width > a.x, 'Confirmation remains beside the exact action button');
  assert.ok(await popover.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  report.geometry.push({ kind, viewport, popover: p, anchor: a }); return { action, popover };
}
async function exists(kind, record) {
  const values = kind === 'source' ? await readSources() : await readTokens();
  return values.find(item => item.id === record.id);
}
async function outside() { const box = await page.locator('.admin-page-heading h1').boundingBox(); assert.ok(box); await page.mouse.click(box.x + 8, box.y + 8); }
async function confirm(kind, record, { busy = false, status = kind === 'token' ? 200 : 204 } = {}) {
  assert.equal(armed, null); const { popover } = await open(kind, record);
  let reached, release; const started = new Promise(resolve => { reached = resolve; }), held = new Promise(resolve => { release = resolve; });
  const state = { kind, record, path: kind === 'source' ? '/sources/' + record.id : '/integrations/tokens/' + record.id, count: 0, reached, gate: busy ? held : Promise.resolve() };
  armed = state;
  const pending = page.waitForResponse(response => response.url() === apiURL(state.path) && response.request().method() === 'DELETE'); pending.catch(() => {});
  try {
    await button(popover, kind === 'source' ? '确认删除' : '确认撤销', kind === 'source' ? 'Delete source' : 'Confirm revocation').click();
    let timer; try { await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected DELETE was not sent')), 15_000); })]); } finally { clearTimeout(timer); }
    if (busy) {
      const deleting = button(popover, kind === 'source' ? '正在删除…' : '正在撤销…', kind === 'source' ? 'Deleting…' : 'Revoking…');
      await deleting.waitFor(); assert.ok(await deleting.isDisabled()); assert.ok(await popover.locator('[data-confirm-cancel]').isDisabled());
      assert.equal(await popover.getAttribute('aria-busy'), 'true'); assert.equal(await page.locator('.admin-shell[inert]').count(), 1);
      await page.keyboard.press('Escape'); await outside(); await settle(); assert.ok(await popover.isVisible());
      await deleting.evaluate(element => { element.click(); element.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await settle(); assert.equal(state.count, 1);
      const current = await exists(kind, record); assert.ok(current); if (kind === 'token') assert.equal(current.revokedAt, null);
      await capture(kind + '-busy-lock');
    }
    release(); const response = await pending; assert.equal(response.status(), status); assert.equal(state.count, 1);
    if (status === (kind === 'token' ? 200 : 204)) {
      if (kind === 'token') assert.deepEqual(await response.json(), { success: true }, 'PAT revocation returns its documented success object');
      await popover.waitFor({ state: 'hidden' });
      if (kind === 'source') assert.equal(await exists(kind, record), undefined);
      else { const revoked = await exists(kind, record); assert.equal(revoked.status, 'revoked'); assert.ok(revoked.revokedAt); }
      await focused(button(page, kind === 'source' ? '刷新数据源' : '创建令牌', kind === 'source' ? 'Refresh sources' : 'Create token'));
    } else {
      const value = await response.json(); assert.equal(value.code, 'source_in_use'); report.expectedFailures.push({ phase, status, code: value.code });
      await popover.getByRole('alert').waitFor(); assert.match(await popover.getByRole('alert').innerText(), new RegExp(l('仍被已保存的组件使用', 'saved component still uses')));
      assert.ok(await button(popover, '刷新数据源', 'Refresh sources').isVisible()); assert.ok(await exists('source', record));
      await capture('source-in-use'); await button(popover, '保留', 'Keep').click(); await popover.waitFor({ state: 'hidden' });
    }
    report.mutations.push({ kind, id: record.id, status, count: state.count }); await unchangedNavigation();
  } finally { release(); armed = null; }
}

async function main() {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] }); report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 }); context.setDefaultTimeout(15_000);
  boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken;
  assert.equal(boot.initialized, false, 'This script requires a fresh fixture and never logs into an existing account');
  const language = base.port === '5223' ? 'en' : 'zh-CN';
  if (boot.languageSelectionRequired) { boot = await api('POST', '/setup/language', { language }); csrf = boot.csrfToken; }
  assert.equal(boot.language, language); const fixtureName = 'Integration confirm fixture ' + language;
  await api('POST', '/setup', { siteName: fixtureName, mode: 'private_single', username: 'integration-owner-' + run, displayName: 'Fixture Owner', password: 'Fixture!' + randomBytes(24).toString('base64url'), seedDemo: false }, 201);
  boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken;
  assert.equal(boot.siteName, fixtureName); assert.equal(boot.mode, 'private_single'); assert.equal(boot.user?.role, 'Owner'); report.language = language;
  space = boot.spaces.find(item => item.kind === 'personal'); assert.ok(space?.canEdit); approved = true;
  originalPage = await readPage(); ownedRevision = originalPage.revision; originalNavigation = await api('GET', relative('/navigation'));
  for (const suffix of ['disposable source', 'protected source']) {
    const source = await api('POST', relative('/sources'), { name: prefix + ' ' + suffix, kind: 'external-push', schemaId: 'navigation.collection', schemaVersion: 1, enabled: true, connection: {}, sync: { mode: 'push', staleAfterSeconds: 86400 } }, 201);
    sources.set(source.id, source); if (!disposableSource) disposableSource = source; else protectedSource = source;
  }
  // Retain metadata only: never write the once-only PAT secret to a file or page.
  const { credential } = await api('POST', '/integrations/tokens', { name: prefix + ' read token', spaceId: space.id, sourceId: null, actions: ['navigation:read'], expiresAt: new Date(Date.now() + 86400000).toISOString() }, 201);
  token = credential; tokens.set(token.id, token);
  const config = structuredClone(originalPage.config), navigation = config.views.find(view => view.panel.id === 'builtin/navigation'); assert.ok(navigation);
  const alias = 'source-' + protectedSource.id; config.bindings[alias] = { datasetId: protectedSource.datasetId, space: 'current-page-space', query: {} }; navigation.inputs.collection = alias;
  const bound = await api('PUT', relative('/page'), { name: originalPage.name, config, expectedRevision: ownedRevision }); ownedRevision = bound.revision; pageChanged = true;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base.origin && !['data:', 'blob:'].includes(url.protocol)) { report.blocked.push({ method: request.method(), origin: url.origin, pathname: url.pathname }); return route.abort(); }
    if (url.origin === base.origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      if (!armed || request.method() !== 'DELETE' || url.pathname !== '/api/v1' + armed.path) { report.blocked.push({ method: request.method(), pathname: url.pathname }); return route.abort(); }
      const state = armed; state.count++;
      if (state.kind === 'source') assert.deepEqual(request.postDataJSON(), { expectedConfigRevision: state.record.configRevision, detachUnusedBindings: true });
      else assert.ok(!request.postData());
      state.reached(); await state.gate; return route.continue();
    }
    return route.continue();
  });
  page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push({ phase, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ phase, message: message.text().slice(0, 300) }); });
  for (const [kind, record] of [['source', disposableSource], ['token', token]]) await step(kind + ': anchored confirmation, keyboard focus and three non-destructive dismissal paths', async () => {
    await admin(kind);
    for (const [width, height] of [[1600, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      let result = await open(kind, record, true); await capture(kind + '-confirmation-' + width);
      await button(result.popover, '保留', 'Keep').click(); await result.popover.waitFor({ state: 'hidden' }); await focused(result.action);
      result = await open(kind, record); await page.keyboard.press('Escape'); await result.popover.waitFor({ state: 'hidden' }); await focused(result.action);
      result = await open(kind, record); await outside(); await result.popover.waitFor({ state: 'hidden' });
      const current = await exists(kind, record); assert.ok(current); if (kind === 'token') assert.equal(current.revokedAt, null);
      assert.deepEqual(report.blocked, [], 'Dismissal sends no DELETE');
    }
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await step('saved component references block a real source DELETE without altering the binding', async () => {
    await admin('source'); const before = await readPage(); await confirm('source', protectedSource, { status: 409 }); assert.deepEqual(await readPage(), before);
  });
  await step('source deletion holds busy state and sends one successful DELETE', async () => { await admin('source'); await confirm('source', disposableSource, { busy: true }); });
  await step('token revocation holds busy state and sends one successful DELETE', async () => { await admin('token'); await confirm('token', token, { busy: true }); });
  assert.deepEqual(report.blocked, []); assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors.filter(error => !report.expectedFailures.some(expected => expected.phase === error.phase && error.message.includes(String(expected.status)))), []);
}
async function cleanup() {
  if (!approved || !context || !space) return;
  if (page && !page.isClosed()) await page.close();
  if (pageChanged) {
    const current = await readPage(); assert.equal(current.revision, ownedRevision, 'Refusing to overwrite an unknown page revision');
    const restored = await api('PUT', relative('/page'), { name: originalPage.name, config: originalPage.config, expectedRevision: ownedRevision }); assert.deepEqual(restored.config, originalPage.config); report.cleanup.push({ kind: 'page', status: 'restored' });
  }
  for (const [id, own] of tokens) { const current = (await readTokens()).find(item => item.id === id); if (current && !current.revokedAt) { assert.equal(current.name, own.name); assert.deepEqual(await api('DELETE', '/integrations/tokens/' + id, undefined, 200), { success: true }); } report.cleanup.push({ kind: 'token', id, status: 'revoked' }); }
  for (const [id, own] of sources) { const current = (await readSources()).find(item => item.id === id); if (current) { assert.equal(current.name, own.name); await api('DELETE', '/sources/' + id, { expectedConfigRevision: current.configRevision, detachUnusedBindings: true }, 204); } report.cleanup.push({ kind: 'source', id, status: 'deleted' }); }
  await unchangedNavigation();
}
(async () => {
  try { await main(); report.status = 'passed'; }
  catch (error) { report.status = 'failed'; report.failure = { phase, message: error.message, stack: error.stack }; process.exitCode = 1; if (page) await capture('failure').catch(() => {}); }
  finally {
    try { await cleanup(); } catch (error) { report.status = 'failed'; report.cleanupFailure = error.stack; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: path.join(out, 'report.json'), failure: report.failure, cleanupFailure: report.cleanupFailure }));
    if (browser) await browser.close();
  }
})();
