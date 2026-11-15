#!/usr/bin/env node
'use strict';
// Use only an owned, disposable loopback fixture.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'Owned fixture and output are required');
const provider = process.env.UI_PROVIDER || 'sqlite', fixture = JSON.parse(fs.readFileSync(process.env.UI_FIXTURES, 'utf8'))[provider];
const base = new URL(fixture.url), output = path.resolve(process.env.OUTPUT_DIR);
assert(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname) && !base.username && !base.password, 'Only disposable loopback fixtures');
const origin = base.origin, work = '/spaces/' + fixture.shared + '/work', prefix = 'Short-ID-' + crypto.randomBytes(4).toString('hex');
const report = { passed: false, checks: [], screenshots: [], errors: [], startedAt: new Date().toISOString() };
const secrets = [fixture.username, fixture.password].filter(Boolean), scrub = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));
let browser, context, page, language;
const requests = [];
const t = (zh, en) => language === 'en' ? en : zh, detail = () => page.locator('[data-work-detail-id]');
const button = (zh, en, scope = detail()) => scope.getByRole('button', { name: t(zh, en), exact: true });
const boardURL = origin + '/#/library?view=board&space=' + fixture.shared;
async function boot() { const response = await context.request.get(origin + '/api/v1/bootstrap'); assert(response.ok()); return response.json(); }
async function api(suffix, method = 'GET', data, expected = 200) {
  const state = await boot(), response = await context.request.fetch(origin + '/api/v1' + suffix, { method, data, headers: { Origin: origin, 'X-CSRF-TOKEN': state.csrfToken } });
  assert.equal(response.status(), expected, method + ' ' + suffix + ': ' + scrub(await response.text()));
  return response.json();
}
async function check(name, run) {
  const start = Date.now();
  try { await run(); report.checks.push({ name, passed: true, ms: Date.now() - start }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: scrub(error.message) }); throw error; }
}
function shortID(value) {
  assert.match(value, /^[0-9a-z]{5,13}$/);
  assert.notEqual(value, '00000');
  const number = [...value].reduce((total, digit) => total * 36n + BigInt(parseInt(digit, 36)), 0n);
  assert.equal(number.toString(36).padStart(5, '0'), value);
}
async function openBoard() { await page.goto(boardURL, { waitUntil: 'domcontentloaded' }); await page.locator('.work-board').waitFor(); }
async function newDraft(title) {
  await page.locator('[data-work-new]').click();
  await detail().locator('[data-work-title]').fill(title);
  assert.equal(await detail().getAttribute('data-work-detail-id'), '');
}
async function waitForItem() {
  await button('复制事项编号', 'Copy item ID').waitFor();
  const value = await detail().getAttribute('data-work-detail-id'); shortID(value); return value;
}
async function createThroughUI(title) {
  await newDraft(title);
  const sent = page.waitForRequest(r => new URL(r.url()).pathname === '/api/v1' + work + '/items' && r.method() === 'POST');
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1' + work + '/items' && r.request().method() === 'POST');
  await button('创建事项', 'Create item').click();
  const payload = (await sent).postDataJSON(), result = await response; assert.equal(result.status(), 200);
  const item = await result.json(); shortID(item.id); assert(!('id' in payload)); assert(payload.requestId); assert(!('key' in item)); assert(!('number' in item));
  assert.equal(await waitForItem(), item.id);
  return { item, payload };
}
async function geometry(width, height) {
  await page.setViewportSize({ width, height });
  await page.locator('.work-item-dialog[role=dialog]').waitFor();
  assert.equal(await page.locator('aside[data-work-detail-id], .work-drawer').count(), 0, 'All desktop sizes use a centered dialog');
  const value = await detail().evaluate(el => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    return { panel: rect(el), code: rect(el.querySelector('[data-work-copy-id]')), header: rect(el.querySelector('.work-detail-heading')), footer: rect(el.querySelector('.work-detail-footer')), scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) };
  });
  assert(value.scrollWidth <= width + 1, 'No horizontal document overflow');
  for (const [label, rect] of Object.entries(value).filter(([, v]) => typeof v === 'object')) assert(rect.left >= 0 && rect.top >= 0 && rect.right <= width + 1 && rect.bottom <= height + 1, label + ' fits viewport');
  assert(value.code.top >= value.header.top && value.code.bottom <= value.header.bottom + 1, 'Copy ID stays within the header');
  assert(Math.abs(value.footer.bottom - value.panel.bottom) <= 2, 'Footer remains pinned');
  const filename = 'short-id-' + width + 'x' + height + '.png'; await page.screenshot({ path: path.join(output, filename), animations: 'disabled' }); report.screenshots.push(filename);
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'zh-CN', reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(scrub(error.message)));
  page.on('request', request => { const url = new URL(request.url()); requests.push({ method: request.method(), path: url.pathname, query: url.search }); });
  await api('/auth/login', 'POST', { username: fixture.username, password: fixture.password, sessionMode: 'temporary' });
  const initial = await boot(); assert.equal(initial.siteName, 'Release UI fixture ' + provider, 'Owned fixture guard'); language = initial.language;
  await openBoard();
  let created;
  await check('server_allocated_id_display_copy_deep_link_and_update', async () => {
    const result = await createThroughUI(prefix + ' normal'); created = result.item;
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('item'), created.id);
    assert(!page.url().includes(result.payload.requestId), 'Creation request ID is never a card route');
    await button('复制事项编号', 'Copy item ID').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), created.id);
    await page.locator('[data-work-id="' + created.id + '"] .work-item-id').waitFor();
    assert.equal((await page.locator('[data-work-id="' + created.id + '"] .work-item-id').textContent()).trim(), created.id);
    await button('复制事项链接', 'Copy item link').click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(new URLSearchParams(new URL(link).hash.split('?')[1]).get('item'), created.id);
    await page.goto(link, { waitUntil: 'domcontentloaded' }); assert.equal(await waitForItem(), created.id);
    await detail().getByLabel(t('下一步', 'Next step'), { exact: true }).fill('Verify the short ID');
    const saved = page.waitForResponse(r => r.url().endsWith('/items/' + created.id) && r.request().method() === 'PATCH');
    await button('保存事项', 'Save item').click(); assert.equal((await saved).status(), 200);
    assert.equal((await api(work + '/items/' + created.id)).nextStep, 'Verify the short ID');
    await api(work + '/items/' + 'b'.repeat(32), 'GET', undefined, 404);
    await api(work + '/items/W-1', 'GET', undefined, 404);
  });
  await check('copy_id_header_and_saved_card_fit_four_desktop_sizes', async () => {
    for (const [width, height] of [[2560,1440],[1920,1080],[1600,900],[2560,1080]]) await geometry(width,height);
    await page.setViewportSize({ width:2560,height:1440 }); await button('关闭事项', 'Close item').click();
  });
  await check('committed_creation_lost_response_recovers_by_request_id', async () => {
    const bodies = []; let committed;
    const route = '**/api/v1' + work + '/items';
    await page.route(route, async handler => {
      if (handler.request().method() !== 'POST') return handler.continue();
      bodies.push(handler.request().postDataJSON());
      const response = await handler.fetch(); assert.equal(response.status(), 200); committed = await response.json(); await handler.abort('failed');
    });
    await newDraft(prefix + ' committed loss'); const offset = requests.length;
    await button('创建事项', 'Create item').click();
    assert.equal(await waitForItem(), committed.id); assert.equal(bodies.length, 1);
    const requestId = bodies[0].requestId;
    assert(requests.slice(offset).some(row => row.method === 'GET' && row.path.endsWith('/work/items') && new URLSearchParams(row.query).get('requestId') === requestId));
    assert(!requests.slice(offset).some(row => row.path.endsWith('/items/' + requestId)), 'Draft request is never used as item ID');
    assert.equal((await api(work + '/items?' + new URLSearchParams({ requestId, limit:'1' }))).total, 1);
    await page.unroute(route); await button('关闭事项', 'Close item').click();
  });
  await check('uncommitted_creation_retries_same_request_and_original_payload', async () => {
    const bodies = [], route = '**/api/v1' + work + '/items';
    await page.route(route, async handler => {
      if (handler.request().method() !== 'POST') return handler.continue();
      bodies.push(handler.request().postDataJSON());
      if (bodies.length === 1) return handler.abort('failed');
      return handler.continue();
    });
    await newDraft(prefix + ' before commit loss'); await button('创建事项', 'Create item').click();
    await button('重试创建', 'Retry creation').waitFor();
    assert(await detail().locator('[data-work-title]').isDisabled(), 'Pending create keeps the original payload');
    const response = page.waitForResponse(r => r.url().endsWith('/api/v1' + work + '/items') && r.request().method() === 'POST');
    await button('重试创建', 'Retry creation').click(); assert.equal((await response).status(), 200);
    const itemID = await waitForItem(); assert.equal(bodies.length, 2); assert.deepEqual(bodies[1], bodies[0]);
    assert.equal((await api(work + '/items?' + new URLSearchParams({ requestId:bodies[0].requestId, limit:'1' }))).items[0].id, itemID);
    assert(!('id' in bodies[0])); await page.unroute(route);
  });
  assert.deepEqual(report.errors, []); report.passed = true;
}
main().catch(async error => {
  report.failure = scrub(error.stack || error); console.error(report.failure); process.exitCode = 1;
  if (page) { try { await page.screenshot({ path:path.join(output,'failure.png'), animations:'disabled' }); } catch {} }
}).finally(async () => { if (browser) await browser.close(); fs.mkdirSync(output,{recursive:true}); fs.writeFileSync(path.join(output,'short-id-report.json'),JSON.stringify(report,null,2)); });
