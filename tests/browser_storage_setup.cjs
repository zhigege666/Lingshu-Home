#!/usr/bin/env node
'use strict';
// Run only against three owned, disposable loopback fixtures. This script saves
// storage configuration, but never initializes or replaces an existing account.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
for (const name of ['BASE_SQLITE', 'BASE_PG', 'BASE_ERROR', 'PG_URL', 'OUTPUT_DIR']) {
  assert(process.env[name], 'Missing fixture variable: ' + name);
}
const bases = Object.fromEntries(['SQLITE', 'PG', 'ERROR'].map(k => [k, process.env['BASE_' + k].replace(/\/+$/, '')]));
for (const base of Object.values(bases)) assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Use owned loopback fixtures');
const output = path.resolve(process.env.OUTPUT_DIR);
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const url = new URL(process.env.PG_URL);
const pg = { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || '5432', database: decodeURIComponent(url.pathname.slice(1)), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), tls: url.searchParams.get('sslmode') || 'require' };
const secrets = [process.env.PG_URL, pg.password, pg.username, encodeURIComponent(pg.password)].filter(Boolean);
function redact(s) { for (const secret of secrets) s = String(s).split(secret).join('[redacted]'); return String(s).replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted URL]'); }
const report = { passed: false, checks: [], screenshots: [], viewports: [] };
const contexts = [], pageErrors = [];
const root = '[data-testid="storage-setup"]', submit = root + ' button[type="submit"]';
let browser;
async function check(name, fn) {
  const started = Date.now();
  try { await fn(); report.checks.push({ name, status: 'passed', durationMs: Date.now() - started }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, status: 'failed', error: redact(error.message) }); throw error; }
}
async function makePage(locale = 'zh-CN', viewport = { width: 2560, height: 1440 }) {
  const context = await browser.newContext({ locale, viewport, reducedMotion: 'reduce' });
  contexts.push(context); const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => pageErrors.push(redact(error.message)));
  return { context, page };
}
async function state(context, base) {
  const response = await context.request.get(base + '/api/v1/storage/bootstrap');
  assert(response.ok()); const value = await response.json();
  assert(['required', 'ready', 'error'].includes(value.state)); return value;
}
async function open(page, base) {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator(root).waitFor({ state: 'visible' });
}
async function capture(page, name) {
  const mask = [];
  for (const key of ['password', 'username']) {
    const input = page.locator('input[name="storage-' + key + '"]');
    if (await input.count()) { if (key === 'password') assert.equal(await input.getAttribute('type'), 'password'); mask.push(input); }
  }
  await page.screenshot({ path: path.join(output, name), animations: 'disabled', mask, maskColor: '#dbe6df' });
  report.screenshots.push(name);
}
function responseFor(page, endpoint) {
  return page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/storage/' + endpoint && r.request().method() === 'POST', { timeout: 60000 });
}
async function testConnection(page, success) {
  const invalid = await page.locator('form').evaluate(f => Array.from(f.elements).filter(e => e.validity && !e.validity.valid).map(e => ({ name: e.name, message: e.validationMessage.replace(e.value, '[value]') })));
  assert.deepEqual(invalid, [], 'Invalid fixture form fields');
  const response = responseFor(page, 'test');
  await page.getByRole('button', { name: /^(测试连接|Test connection)$/ }).click();
  assert.equal((await response).ok(), success, 'Unexpected connection test result');
  await page.locator(success ? '.storage-setup-test-status.is-success' : '.storage-setup-error[role="alert"]').waitFor();
  assert.equal(await page.locator(submit).isEnabled(), success);
}
async function business(page, context, base) {
  await page.locator('.auth-language, .auth-setup').first().waitFor({ state: 'visible', timeout: 45000 });
  assert.equal(await page.locator(root).count(), 0);
  const status = await state(context, base); assert.equal(status.state, 'ready');
  await page.locator(status.language ? '.auth-setup' : '.auth-language').waitFor();
  if (status.language) assert.equal(await page.locator('.auth-language').count(), 0);
}
async function main() {
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  for (const kind of ['SQLITE', 'PG', 'ERROR']) {
    for (const locale of ['zh-CN', 'en-US']) {
      await check('language_' + kind + '_' + locale, async () => {
        const { context, page } = await makePage(locale);
        const status = await state(context, bases[kind]);
        assert.equal(status.state, kind === 'ERROR' ? 'error' : 'required', 'Fixture must be fresh or intentionally unavailable');
        await open(page, bases[kind]);
        assert.equal(await page.locator(root).getAttribute('lang'), status.language || (locale.startsWith('en') ? 'en' : 'zh-CN'));
        await context.close();
      });
    }
  }
  const external = await makePage('zh-CN'), page = external.page;
  await check('no_business_api_before_storage', async () => {
    const observed = [];
    const handler = request => { const p = new URL(request.url()).pathname; if (p.startsWith('/api/v1/') && !p.startsWith('/api/v1/storage/')) observed.push(p); };
    page.on('request', handler); await open(page, bases.PG); page.off('request', handler); assert.deepEqual(observed, []);
    assert(await page.locator('input[value="sqlite"][name="storage-provider"]').isChecked());
  });
  await page.locator('input[value="postgres"][name="storage-provider"]').check();
  for (const key of ['host', 'port', 'database', 'username']) {
    await page.locator('input[name="storage-' + key + '"]').fill(pg[key]);
    assert((await page.locator('input[name="storage-' + key + '"]').inputValue()) === pg[key], 'Input did not retain fixture field: ' + key);
  }
  await page.locator('select[name="storage-tls"]').selectOption(pg.tls);
  await check('wrong_password_blocks_save', async () => {
    const bad = 'intentionally-wrong-' + Date.now(); secrets.push(bad);
    await page.locator('input[name="storage-password"]').fill(bad);
    assert(!(await page.locator(submit).isEnabled())); await testConnection(page, false);
  });
  await check('correct_password_and_edit_requires_retest', async () => {
    await page.locator('input[name="storage-password"]').fill(pg.password); await testConnection(page, true);
    await page.locator('input[name="storage-port"]').fill(String(Number(pg.port) === 65535 ? 65534 : Number(pg.port) + 1));
    assert(!(await page.locator(submit).isEnabled())); assert.equal(await page.locator('.storage-setup-test-status.is-success').count(), 0);
    await page.locator('input[name="storage-port"]').fill(pg.port);
    assert(!(await page.locator(submit).isEnabled())); await testConnection(page, true);
  });
  for (const [width, height] of [[2560,1440], [1920,1080], [1600,900], [2560,1080]]) {
    await check('layout_' + width + 'x' + height, async () => {
      await page.setViewportSize({ width, height });
      const geometry = await page.locator('.storage-setup-page').evaluate(e => ({ width: e.clientWidth, scrollWidth: e.scrollWidth, viewport: innerWidth, document: document.documentElement.scrollWidth }));
      assert(geometry.scrollWidth <= geometry.width + 1 && geometry.document <= geometry.viewport + 1, 'Horizontal overflow');
      const save = page.locator(submit); await save.scrollIntoViewIfNeeded(); await save.click({ trial: true });
      const rect = await save.boundingBox(); assert(rect && rect.y >= 0 && rect.y + rect.height <= height + 1 && rect.x + rect.width <= width + 1, 'Clipped save button');
      await capture(page, 'storage-postgres-' + width + 'x' + height + '.png');
      report.viewports.push({ width, height, horizontalOverflow: false, saveClickable: true });
    });
  }
  await check('postgres_save_and_reload', async () => {
    const response = responseFor(page, 'configure'); await page.locator(submit).click(); assert((await response).ok());
    await business(page, external.context, bases.PG);
    await page.reload({ waitUntil: 'domcontentloaded' }); await business(page, external.context, bases.PG);
  });
  const local = await makePage('en-US');
  await check('sqlite_save_and_reload', async () => {
    await open(local.page, bases.SQLITE); assert(await local.page.locator('input[value="sqlite"]').isChecked());
    assert.equal(await local.page.locator('input[name="storage-password"]').count(), 0);
    await capture(local.page, 'storage-sqlite-2560x1440.png');
    const response = responseFor(local.page, 'configure'); await local.page.locator(submit).click(); assert((await response).ok());
    await business(local.page, local.context, bases.SQLITE);
    await local.page.reload({ waitUntil: 'domcontentloaded' }); await business(local.page, local.context, bases.SQLITE);
  });
  const failed = await makePage('zh-CN', { width: 1600, height: 900 });
  await check('configured_failure_never_reopens_database_choice', async () => {
    await open(failed.page, bases.ERROR); await failed.page.locator('.storage-setup-card-recovery').waitFor();
    assert.equal(await failed.page.locator('input[name="storage-provider"]').count(), 0);
    assert.equal(await failed.page.locator(submit).count(), 0);
    const response = responseFor(failed.page, 'retry');
    await failed.page.getByRole('button', { name: /^(重试连接|Retry connection)$/ }).click(); await response;
    assert.equal((await state(failed.context, bases.ERROR)).state, 'error');
    await failed.page.locator('.storage-setup-card-recovery').waitFor();
    assert.equal(await failed.page.locator('input[name="storage-provider"]').count(), 0);
    assert.equal(await failed.page.locator('.auth-language, .auth-setup').count(), 0);
    await capture(failed.page, 'storage-error-1600x900.png');
  });
  await check('no_uncaught_browser_errors', async () => assert.deepEqual(pageErrors, []));
}
(async () => {
  try { await main(); report.passed = true; }
  catch (error) { report.error = redact(error.message); console.error('FAIL ' + report.error); }
  finally {
    for (const context of contexts) try { await context.close(); } catch {}
    if (browser) await browser.close();
    report.browserErrors = pageErrors;
    report.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'storage-browser-results.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log((report.passed ? 'PASS' : 'FAIL') + ' storage browser: ' + report.checks.filter(v => v.status === 'passed').length + '/' + report.checks.length);
    process.exitCode = report.passed ? 0 : 1;
  }
})();
