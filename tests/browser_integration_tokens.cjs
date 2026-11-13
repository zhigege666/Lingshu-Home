#!/usr/bin/env node
'use strict';
// Uses an explicitly supplied disposable Release UI fixture. No production data,
// service startup, direct database writes, stored PAT secrets, or token screenshots.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'UI_FIXTURES and OUTPUT_DIR are required');
const fixtures = JSON.parse(fs.readFileSync(process.env.UI_FIXTURES, 'utf8'));
const provider = process.env.UI_PROVIDER || 'sqlite';
const fixture = fixtures[provider];
assert(fixture && fixture.username && fixture.password && /^[0-9a-f]{32}$/.test(fixture.shared), 'An owned fixture account and shared space are required');
const base = new URL(fixture.url);
assert(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password, 'Only disposable loopback fixtures');
const origin = base.origin, out = path.resolve(process.env.OUTPUT_DIR);
fs.mkdirSync(out, { recursive: true });
const prefix = 'Token UI ' + crypto.randomBytes(5).toString('hex');
const secrets = new Set([fixture.username, fixture.password]);
const scrub = value => [...secrets].reduce((text, secret) => text.split(secret).join('[redacted]'), String(value)).replace(/lhp_[A-Za-z0-9_-]{43}/g, '[redacted-token]');
const report = { passed: false, provider, startedAt: new Date().toISOString(), checks: [], screenshots: [], geometry: [], mutations: [], tokenRequests: [], pageErrors: [], cleanup: [] };
let browser, context, patContext, page, initial, actionCatalog, credential, ownedTokenID, rawToken = '', probeItem, verified = false, secretVisible = false;
const l = (zh, en) => initial.language === 'en' ? en : zh;
const button = (zh, en, scope = page) => scope.getByRole('button', { name: l(zh, en), exact: true });
const label = (zh, en, scope = page) => scope.getByLabel(l(zh, en), { exact: true });
const dialog = (zh, en) => page.getByRole('dialog', { name: l(zh, en), exact: true });
const tokenRow = () => page.locator('[data-token-id="' + ownedTokenID + '"]');
const tokenPath = () => '/integrations/tokens/' + ownedTokenID;
const workPath = '/spaces/' + fixture.shared + '/work';
const newID = () => crypto.randomBytes(16).toString('hex');

async function boot() {
  const response = await context.request.get(origin + '/api/v1/bootstrap', { maxRedirects: 0 });
  assert.equal(response.status(), 200, 'Bootstrap read failed');
  return response.json();
}
async function api(suffix, method = 'GET', data, expected = 200) {
  const state = await boot();
  const response = await context.request.fetch(origin + '/api/v1' + suffix, {
    method, data, headers: { Origin: origin, 'X-CSRF-TOKEN': state.csrfToken }, maxRedirects: 0, timeout: 15000,
  });
  assert.equal(response.status(), expected, method + ' ' + suffix + ': unexpected HTTP ' + response.status());
  return expected === 204 ? null : response.json();
}
async function pat(suffix, method = 'GET', data, expected = 200) {
  assert(rawToken, 'The original PAT must remain available only in memory');
  const response = await patContext.request.fetch(origin + '/api/v1' + suffix, {
    method, data, headers: { Authorization: 'Bearer ' + rawToken }, maxRedirects: 0, timeout: 15000,
  });
  assert.equal(response.status(), expected, 'Original PAT ' + method + ' ' + suffix + ': unexpected HTTP ' + response.status());
  return expected === 204 ? null : response.json();
}
async function readCredential() {
  const values = await api('/integrations/tokens');
  assert(Array.isArray(values), 'Credential listing must retain its array contract');
  return values.find(value => value.id === ownedTokenID);
}
async function check(name, action) {
  const started = Date.now();
  try { await action(); report.checks.push({ name, passed: true, ms: Date.now() - started }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: scrub(error.message) }); throw error; }
}
async function mutation(action, suffix, method = 'PATCH', expected = 200) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1' + suffix && response.request().method() === method);
  pending.catch(() => {});
  await action();
  const response = await pending;
  assert.equal(response.status(), expected, 'UI ' + method + ' ' + suffix + ': unexpected HTTP ' + response.status());
  report.mutations.push({ method, path: suffix, status: response.status() });
  return expected === 204 ? null : response.json();
}
async function choose(control, option) {
  await control.click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
async function setActions(scope, desired) {
  for (const action of actionCatalog.items) {
    const checkbox = scope.getByRole('checkbox', { name: action.label, exact: true });
    if (await checkbox.count() && !desired.includes(action.id) && await checkbox.isChecked()) await checkbox.uncheck();
  }
  for (const id of desired) {
    const action = actionCatalog.items.find(value => value.id === id);
    assert(action, 'Missing action metadata: ' + id);
    await scope.getByRole('checkbox', { name: action.label, exact: true }).check();
  }
}
async function admin() {
  const target = origin + '/#/admin?tab=integrations';
  if (page.url() === target) await page.reload({ waitUntil: 'domcontentloaded' });
  else await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: l('数据源', 'Sources'), exact: true }).waitFor();
  const space = initial.spaces.find(value => value.id === fixture.shared);
  const picker = page.getByRole('combobox', { name: l('当前空间', 'Current space'), exact: true });
  const display = space.name + l(' · 共享', ' · Shared');
  if (!(await picker.innerText()).includes(display)) await choose(picker, display);
  await page.getByRole('tab', { name: l('MCP 与访问令牌', 'MCP and access tokens'), exact: true }).click();
  await button('创建令牌', 'Create token').waitFor();
}
async function openEditor() {
  credential = await readCredential();
  assert(credential && credential.status === 'active', 'Expected this run\'s active token');
  await tokenRow().waitFor();
  await button('编辑令牌 ' + credential.name, 'Edit token ' + credential.name, tokenRow()).click();
  const editor = dialog('编辑访问令牌', 'Edit access token');
  await label('令牌名称', 'Token name', editor).waitFor();
  assert.equal(await label('令牌名称', 'Token name', editor).inputValue(), credential.name);
  assert((await label('有效期', 'Validity period', editor).innerText()).includes(l('保持原有效期', 'Keep current validity')), 'Editing must default to preserving expiry');
  assert.equal(await label('新访问令牌', 'New access token', editor).count(), 0, 'Editing cannot redisplay or rotate the secret');
  return editor;
}
async function saveEditor(editor, expected = 200) {
  const result = await mutation(() => button('保存令牌', 'Save token', editor).click(), tokenPath(), 'PATCH', expected);
  if (expected === 200) {
    assert.equal(result.id, ownedTokenID, 'Editing must keep the original token identity');
    assert(!('token' in result), 'Editing must not return a new secret');
    credential = result;
    await editor.waitFor({ state: 'hidden' });
    await tokenRow().getByText(credential.name, { exact: true }).waitFor();
    assert.equal(await label('新访问令牌', 'New access token').count(), 0);
  }
  return result;
}
async function captureForm(editor, name, width, height) {
  assert(!secretVisible, 'Never capture a displayed credential');
  await page.setViewportSize({ width, height });
  await button('保存令牌', 'Save token', editor).scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const panel = await editor.boundingBox(), save = await button('保存令牌', 'Save token', editor).boundingBox();
  const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
  assert(metrics.scrollWidth <= width + 1, name + ': document horizontal overflow');
  for (const [control, box] of [['dialog', panel], ['save', save]]) assert(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, name + ': ' + control + ' is outside the viewport');
  assert(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1), name + ': form horizontal overflow');
  report.geometry.push({ name, width, height, panel, save });
  const file = provider + '-' + name + '.png';
  await page.screenshot({ path: path.join(out, file), animations: 'disabled', mask: [page.locator('input[type=password]')] });
  report.screenshots.push(file);
}

async function main() {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  patContext = await browser.newContext(); // No browser cookies can authenticate PAT probes.
  const anonymous = await boot();
  assert.equal(anonymous.siteName, 'Release UI fixture ' + provider, 'Fixture site-name guard failed before writes');
  assert.equal(anonymous.initialized, true, 'Use a newly prepared, initialized release UI fixture');
  await api('/auth/login', 'POST', { username: fixture.username, password: fixture.password, sessionMode: 'temporary' });
  initial = await boot();
  assert(initial.user && initial.spaces.some(value => value.id === fixture.shared), 'Fixture account must own the supplied space');
  verified = true;
  actionCatalog = await api('/integrations/token-actions');
  assert(Array.isArray(actionCatalog.items) && Array.isArray(actionCatalog.defaultActions), 'Action metadata contract');
  for (const id of ['navigation:read', 'work:read', 'work:write']) assert(actionCatalog.items.some(value => value.id === id), 'Action metadata must include ' + id);
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.pageErrors.push(scrub(error.message)));
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (['POST', 'PATCH', 'DELETE'].includes(request.method()) && /^\/api\/v1\/integrations\/tokens(?:\/|$)/.test(pathname)) report.tokenRequests.push({ method: request.method(), path: pathname });
  });
  await admin();

  await check('create_token_and_close_one_time_secret', async () => {
    await button('创建令牌', 'Create token').click();
    const form = dialog('创建访问令牌', 'Create access token');
    await label('令牌名称', 'Token name', form).fill(prefix + ' initial');
    await choose(label('权限范围', 'Permission scope', form), l('自定义权限', 'Selected permissions'));
    await setActions(form, ['navigation:read']);
    secretVisible = true; // Also suppress failure screenshots until explicitly closed.
    const created = await mutation(() => button('创建令牌', 'Create token', form).click(), '/integrations/tokens', 'POST', 201);
    rawToken = created.token; secrets.add(rawToken);
    credential = created.credential; ownedTokenID = credential.id;
    assert(/^lhp_[A-Za-z0-9_-]{43}$/.test(rawToken), 'Creation did not return a valid one-time PAT');
    assert.equal(credential.spaceId, fixture.shared);
    assert.equal(credential.permissionMode, 'selected');
    assert.deepEqual(credential.actions, ['navigation:read']);
    const secret = dialog('保存你的访问令牌', 'Save your access token');
    assert.equal(await label('新访问令牌', 'New access token', secret).inputValue(), rawToken);
    await button('已保存，关闭', 'Saved; close', secret).click();
    await secret.waitFor({ state: 'hidden' }); secretVisible = false;
    await tokenRow().waitFor();
    assert.equal(await button('删除令牌记录 ' + credential.name, 'Delete token record ' + credential.name, tokenRow()).count(), 0);
    const denied = await pat(workPath + '/board', 'GET', undefined, 403);
    assert.equal(denied.code, 'forbidden');
  });

  await check('edit_original_token_scopes_preserves_expiry', async () => {
    const editor = await openEditor(), expiry = credential.expiresAt;
    await label('令牌名称', 'Token name', editor).fill(prefix + ' work');
    await setActions(editor, ['navigation:read', 'work:read', 'work:write']);
    await saveEditor(editor);
    assert.equal(credential.expiresAt, expiry, 'Default edit must preserve the exact expiry');
    assert.equal(credential.permissionMode, 'selected');
    await pat(workPath + '/board');
    probeItem = await pat(workPath + '/items', 'POST', { id: newID(), title: prefix + ' capability probe' });
    assert(probeItem.id, 'The original PAT must gain work:write immediately');
  });

  await check('permanent_all_permissions_on_same_token', async () => {
    const editor = await openEditor();
    await choose(label('有效期', 'Validity period', editor), l('永久有效', 'Never expires'));
    await choose(label('权限范围', 'Permission scope', editor), l('全部权限', 'All permissions'));
    await captureForm(editor, 'token-all-permanent-2560x1440', 2560, 1440);
    await saveEditor(editor);
    assert.equal(credential.expiresAt, null);
    assert.equal(credential.permissionMode, 'all');
    assert(actionCatalog.items.every(action => credential.actions.includes(action.id)), 'All mode must expand the current permitted business actions');
    const persisted = await readCredential();
    assert.equal(persisted.expiresAt, null); assert.equal(persisted.permissionMode, 'all');
    await pat(workPath + '/board');
    probeItem = await pat(workPath + '/items/' + probeItem.id, 'PATCH', { expectedRevision: probeItem.revision, nextStep: 'Original token remains usable in all mode' });
  });

  await check('return_to_selected_and_revoke_scopes_immediately', async () => {
    let editor = await openEditor();
    await choose(label('权限范围', 'Permission scope', editor), l('自定义权限', 'Selected permissions'));
    await setActions(editor, ['navigation:read', 'work:read']);
    await choose(label('有效期', 'Validity period', editor), l('7 天', '7 days'));
    await captureForm(editor, 'token-selected-1600x900', 1600, 900);
    await saveEditor(editor);
    assert.equal(credential.permissionMode, 'selected');
    assert(credential.expiresAt && Date.parse(credential.expiresAt) > Date.now(), 'Explicit finite expiry must replace permanent validity');
    await pat(workPath + '/board');
    assert.equal((await pat(workPath + '/items', 'POST', { id: newID(), title: prefix + ' denied write' }, 403)).code, 'forbidden');
    editor = await openEditor();
    await setActions(editor, ['navigation:read']);
    await saveEditor(editor);
    assert.equal((await pat(workPath + '/board', 'GET', undefined, 403)).code, 'forbidden');
  });

  await check('revision_conflict_keeps_draft_and_reads_current', async () => {
    const editor = await openEditor(), draftName = prefix + ' local draft', remoteName = prefix + ' remote edit';
    const name = label('令牌名称', 'Token name', editor);
    await name.fill(draftName);
    const remote = await api(tokenPath(), 'PATCH', { expectedRevision: credential.revision, name: remoteName });
    const error = await saveEditor(editor, 409);
    assert.equal(error.code, 'integration_token_version_conflict');
    assert.equal(error.currentRevision, remote.revision);
    assert.equal(await name.inputValue(), draftName, 'Conflict must retain the unsaved draft');
    const writes = report.tokenRequests.length;
    await button('读取最新版本', 'Read latest version', editor).click();
    await button('使用最新版本', 'Use latest version', editor).waitFor();
    assert.equal(await name.inputValue(), draftName, 'Readback alone must not overwrite the draft');
    await button('使用最新版本', 'Use latest version', editor).click();
    await page.waitForFunction(({ input, value }) => input.value === value, { input: await name.elementHandle(), value: remoteName });
    assert.equal(report.tokenRequests.length, writes, 'Readback and adoption must not submit another mutation');
    await button('取消', 'Cancel', editor).click();
    await editor.waitFor({ state: 'hidden' });
    await admin();
    credential = await readCredential();
    assert.equal(credential.name, remoteName);
    assert.equal(await label('新访问令牌', 'New access token').count(), 0, 'Reloading must not redisplay the secret');
  });

  await check('revoke_then_delete_only_the_revoked_record', async () => {
    const row = tokenRow(); await row.waitFor();
    const deleteName = l('删除令牌记录 ' + credential.name, 'Delete token record ' + credential.name);
    assert.equal(await row.getByRole('button', { name: deleteName, exact: true }).count(), 0, 'Active token must not offer record deletion');
    await button('撤销令牌 ' + credential.name, 'Revoke token ' + credential.name, row).click();
    const confirm = dialog('撤销访问令牌？', 'Revoke this access token?');
    const result = await mutation(() => button('确认撤销', 'Confirm revocation', confirm).click(), tokenPath(), 'DELETE');
    assert.equal(result.success, true);
    await confirm.waitFor({ state: 'hidden' });
    await row.getByText(l('已撤销', 'Revoked'), { exact: true }).waitFor();
    assert.equal((await pat(workPath + '/board', 'GET', undefined, 401)).code, 'unauthorized');
    credential = await readCredential();
    assert.equal(credential.status, 'revoked');
    assert.equal(await button('编辑令牌 ' + credential.name, 'Edit token ' + credential.name, row).count(), 0, 'Revoked tokens cannot be revived by editing');
    await row.getByRole('button', { name: deleteName, exact: true }).click();
    const remove = dialog('删除令牌记录？', 'Delete this token record?');
    const deleted = await mutation(() => button('确认删除', 'Confirm deletion', remove).click(), tokenPath() + '/record', 'DELETE');
    assert.equal(deleted.success, true);
    await remove.waitFor({ state: 'hidden' });
    await row.waitFor({ state: 'detached' });
    assert.equal(await readCredential(), undefined, 'Deleted record must disappear from the API list');
    assert.equal((await pat(workPath + '/board', 'GET', undefined, 401)).code, 'unauthorized');
  });
  assert.equal(report.pageErrors.length, 0, 'No uncaught browser errors');
  report.passed = true;
}

async function cleanup() {
  if (!verified || !context) return;
  if (probeItem) {
    const current = await api(workPath + '/items/' + probeItem.id);
    if (!current.archived) await api(workPath + '/items/' + current.id, 'PATCH', { expectedRevision: current.revision, archived: true });
    report.cleanup.push({ kind: 'probe-item', id: current.id, status: 'archived' });
  }
  if (ownedTokenID) {
    let current = await readCredential();
    if (current && !current.revokedAt) { await api(tokenPath(), 'DELETE'); current = await readCredential(); }
    if (current) await api(tokenPath() + '/record', 'DELETE', { expectedRevision: current.revision });
    report.cleanup.push({ kind: 'token', id: ownedTokenID, status: 'removed' });
  }
}
main().catch(async error => {
  report.failure = scrub(error.stack || error); process.exitCode = 1;
  if (page && !page.isClosed() && !secretVisible) {
    const file = provider + '-token-failure.png';
    await page.screenshot({ path: path.join(out, file), animations: 'disabled', mask: [page.locator('input[type=password]')] }).then(() => report.screenshots.push(file)).catch(() => {});
  }
  console.error(report.failure);
}).finally(async () => {
  try { await cleanup(); } catch (error) { report.cleanupFailure = scrub(error.stack || error); report.passed = false; process.exitCode = 1; }
  if (report.pageErrors.length) { report.passed = false; process.exitCode = 1; }
  if (browser) await browser.close();
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'integration-tokens-report.json'), scrub(JSON.stringify(report, null, 2)) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: path.join(out, 'integration-tokens-report.json') }));
});
