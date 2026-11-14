#!/usr/bin/env node
'use strict';
// Real HTTP/UI checks against an explicitly supplied disposable loopback fixture.
// Fault injection is limited to the negative paths; it never simulates successful
// saves. No service startup, direct database writes or production access here.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'UI_FIXTURES and OUTPUT_DIR are required');
const provider = process.env.UI_PROVIDER || 'sqlite';
const fixture = JSON.parse(fs.readFileSync(process.env.UI_FIXTURES, 'utf8'))[provider];
assert(fixture && fixture.username && fixture.password && /^[0-9a-f]{32}$/.test(fixture.shared), 'Use the owned fixture account and shared space');
const base = new URL(fixture.url);
assert(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password, 'Only disposable loopback HTTP fixtures');
const origin = base.origin, out = path.resolve(process.env.OUTPUT_DIR), secrets = [fixture.username, fixture.password];
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const report = { passed: false, provider, startedAt: new Date().toISOString(), checks: [], screenshots: [], geometry: [], errors: [], requests: [], focusStimulus: 'Two real pages share one browser context. Headless activation dispatches the existing focus event after bringToFront; it does not reload the Work page.' };
const id = () => crypto.randomBytes(16).toString('hex');
const scrub = value => secrets.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, String(value)).replace(/lhp_[A-Za-z0-9_-]{43}/g, '[redacted-token]');
let browser, context, page, initial, workPage, memberContext;
const text = (zh, en) => initial?.language === 'en' ? en : zh;
const panel = (current = page) => current.locator('[data-mcp-settings]');
const button = (zh, en, scope = page) => scope.getByRole('button', { name: text(zh, en), exact: true });
const toggle = (key, current = page) => panel(current).getByRole('switch', { name: key === 'workflowEnabled' ? text('MCP 工作流指导', 'MCP workflow guidance') : text('多 Agent 协作', 'Multi-agent collaboration'), exact: true });
const saveButton = (current = page) => button('保存 MCP 设置', 'Save MCP settings', panel(current));
const settingsPattern = '**/api/v1/settings/mcp';
const work = '/spaces/' + fixture.shared + '/work';

async function eventually(run, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await run()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(message);
}
async function check(name, run) {
  if (process.env.UI_CHECK_MATCH && !new RegExp(process.env.UI_CHECK_MATCH).test(name)) return;
  const start = Date.now();
  try { await run(); report.checks.push({ name, passed: true, ms: Date.now() - start }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: scrub(error.message) }); throw error; }
}
async function boot(ctx = context) {
  const response = await ctx.request.get(origin + '/api/v1/bootstrap', { timeout: 15000, maxRedirects: 0 });
  assert.equal(response.status(), 200, 'Bootstrap must be readable'); return response.json();
}
async function api(suffix, method = 'GET', data, expected = 200, ctx = context) {
  const state = await boot(ctx);
  const response = await ctx.request.fetch(origin + '/api/v1' + suffix, { method, data, headers: { Origin: origin, 'X-CSRF-TOKEN': state.csrfToken }, timeout: 15000, maxRedirects: 0 });
  assert.equal(response.status(), expected, method + ' ' + suffix + ': HTTP ' + response.status());
  return expected === 204 ? null : response.json();
}
async function login(ctx = context, account = fixture) { await api('/auth/login', 'POST', { username: account.username, password: account.password, sessionMode: 'temporary' }, 200, ctx); }
async function setSaved(values) {
  const current = await api('/settings/mcp');
  return api('/settings/mcp', 'PUT', { expectedRevision: current.revision, workflowEnabled: current.workflowEnabled, collaborationEnabled: current.collaborationEnabled, ...values });
}
async function siteSettings(changes) {
  const current = await api('/settings');
  return api('/settings', 'PUT', { siteName: current.siteName, mode: current.mode, registrationEnabled: current.registrationEnabled, autoFetchIcons: current.autoFetchIcons, autoSelectEndpoint: current.autoSelectEndpoint, modules: current.modules, ...changes });
}
async function createPage(ctx = context) {
  const current = await ctx.newPage(); current.setDefaultTimeout(15000);
  current.on('pageerror', error => report.errors.push(scrub(error.message))); return current;
}
async function admin(current = page) {
  const url = origin + '/#/admin?tab=integrations';
  if (current.url() === url) await current.reload({ waitUntil: 'domcontentloaded' });
  else await current.goto(url, { waitUntil: 'domcontentloaded' });
  await current.getByRole('tab', { name: text('数据源', 'Sources'), exact: true }).waitFor();
  await current.getByRole('tab', { name: text('MCP 与访问令牌', 'MCP and access tokens'), exact: true }).click();
  await toggle('workflowEnabled', current).waitFor();
  await eventually(async () => !await panel(current).getByRole('status').filter({ hasText: text('正在读取 MCP 设置…', 'Loading MCP settings…') }).count(), 'MCP configuration loads');
}
async function setToggle(key, desired, current = page) {
  if ((await toggle(key, current).getAttribute('aria-checked') === 'true') !== desired) await toggle(key, current).click();
  assert.equal(await toggle(key, current).getAttribute('aria-checked'), String(desired));
}
async function assertValues(values, current = page) {
  for (const key of ['workflowEnabled', 'collaborationEnabled']) assert.equal(await toggle(key, current).getAttribute('aria-checked'), String(values[key]), key);
}
async function saveUI(expected = 200, current = page) {
  const pending = current.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/settings/mcp' && response.request().method() === 'PUT');
  pending.catch(() => {}); await saveButton(current).click();
  const response = await pending; assert.equal(response.status(), expected, 'UI settings save HTTP status');
  report.requests.push({ method: 'PUT', status: response.status() });
  if (expected !== 200) return response.json();
  const saved = await response.json(); assert.equal(saved.workflowSource, 'saved'); assert.equal(saved.collaborationSource, 'saved');
  await eventually(async () => await saveButton(current).count() === 1 && await saveButton(current).isDisabled(), 'Saved form is clean');
  await assertValues(saved, current);
  const actual = await api('/settings/mcp'); assert.deepEqual(actual, saved, 'UI success matches the persisted record'); return saved;
}
async function shot(name, current = page) {
  const filename = provider + '-mcp-settings-' + name + '.png';
  await current.screenshot({ path: path.join(out, filename), animations: 'disabled', mask: [current.locator('input[type="password"]')] }); report.screenshots.push(filename);
}
async function geometry(width, height) {
  await page.setViewportSize({ width, height }); await panel().scrollIntoViewIfNeeded();
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  const rects = [];
  for (const [name, locator] of [['workflow', toggle('workflowEnabled')], ['collaboration', toggle('collaborationEnabled')], ['save', saveButton()], ['cancel', button('取消修改', 'Cancel changes', panel())]]) {
    const rect = await locator.boundingBox();
    assert(rect && rect.width > 0 && rect.height > 0 && rect.x >= -1 && rect.y >= -1 && rect.x + rect.width <= width + 1 && rect.y + rect.height <= height + 1, name + ' must remain in the viewport');
    rects.push({ name, ...rect });
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'No horizontal page overflow');
  report.geometry.push({ width, height, rects }); await shot(width + 'x' + height);
}

async function main() {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  page = await createPage(); await login(); initial = await boot();
  assert.equal(initial.siteName, 'Release UI fixture ' + provider, 'Named disposable fixture required before mutations');
  assert.equal(initial.user.role, 'Owner');

  await check('startup_source_unknown_noncommit_and_explicit_persistence', async () => {
    const before = await api('/settings/mcp');
    assert.equal(before.workflowSource, 'startup', 'This group requires a fresh fixture');
    assert.equal(before.collaborationSource, 'startup', 'This group requires a fresh fixture');
    await admin(); await assertValues(before); assert(await saveButton().isEnabled(), 'Saving unchanged startup values can establish persistent settings');
    let puts = 0;
    const reject = async route => { if (route.request().method() === 'PUT') { puts++; await route.abort('failed'); } else await route.continue(); };
    await page.route(settingsPattern, reject);
    try {
      await saveButton().click();
      await panel().getByText(text('当前仍是保存前的配置，修改已保留。可以重新保存。', 'The current settings still match the previous state. Your edits are retained; you can save again.'), { exact: true }).waitFor();
      assert.equal(puts, 1); assert.deepEqual(await api('/settings/mcp'), before, 'A matching startup value is not a confirmed persisted save');
      assert(await saveButton().isEnabled()); await shot('startup-unconfirmed');
    } finally { await page.unroute(settingsPattern, reject); }
    const saved = await saveUI(); assert.equal(saved.workflowEnabled, before.workflowEnabled); assert.equal(saved.collaborationEnabled, before.collaborationEnabled);
    assert(BigInt(saved.revision) > BigInt(before.revision)); await admin(); await assertValues(saved); assert(await saveButton().isDisabled());
  });

  await check('owner_four_sizes_keyboard_busy_and_navigation_guards', async () => {
    await setSaved({ workflowEnabled: false, collaborationEnabled: false }); await admin();
    await toggle('workflowEnabled').focus(); await page.keyboard.press('Space'); assert.equal(await toggle('workflowEnabled').getAttribute('aria-checked'), 'true');
    await setToggle('collaborationEnabled', true);
    await panel().getByText(text('开启后，Agent 修改事项前需要登记会话并认领事项。', 'When enabled, agents must register a session and claim an item before changing it.'), { exact: true }).waitFor();
    for (const [width, height] of [[2560,1440],[1920,1080],[1600,900],[2560,1080]]) await geometry(width, height);
    const sources = page.getByRole('tab', { name: text('数据源', 'Sources'), exact: true });
    await sources.click();
    const discard = page.getByRole('dialog', { name: text('放弃未保存的修改？', 'Discard unsaved changes?'), exact: true });
    await discard.waitFor(); await button('继续编辑', 'Keep editing', discard).click(); await discard.waitFor({ state: 'hidden' }); await assertValues({ workflowEnabled: true, collaborationEnabled: true });
    const spaces = (await boot()).spaces, picker = page.getByRole('combobox', { name: text('选择空间', 'Choose a space'), exact: true });
    const currentSpace = await picker.innerText(), other = spaces.find(space => !currentSpace.includes(space.name));
    assert(other, 'The fixture provides a second space for navigation protection');
    await picker.click(); await page.getByRole('option', { name: other.name + (other.kind === 'personal' ? text(' · 私人', ' · Personal') : ''), exact: true }).click();
    await discard.waitFor(); await button('继续编辑', 'Keep editing', discard).click(); await discard.waitFor({ state: 'hidden' }); assert.equal(await picker.innerText(), currentSpace); await assertValues({ workflowEnabled: true, collaborationEnabled: true });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const slow = async route => { if (route.request().method() === 'PUT') await gate; await route.continue(); };
    await page.route(settingsPattern, slow);
    try {
      const saved = saveUI();
      await button('正在保存…', 'Saving…', panel()).waitFor();
      assert(await sources.isDisabled(), 'Subtab navigation is blocked while saving'); assert(await picker.isDisabled(), 'Space navigation is blocked while saving');
      release(); await saved;
    } finally { release(); await page.unroute(settingsPattern, slow); }
    await setToggle('workflowEnabled', false); await button('取消修改', 'Cancel changes', panel()).click(); await assertValues({ workflowEnabled: true, collaborationEnabled: true });
    await setToggle('workflowEnabled', false); await sources.click(); await discard.waitFor(); await button('放弃修改', 'Discard changes', discard).click();
    await eventually(async () => await sources.getAttribute('aria-selected') === 'true', 'Discard navigates to Sources');
    await page.getByRole('tab', { name: text('MCP 与访问令牌', 'MCP and access tokens'), exact: true }).click(); await assertValues({ workflowEnabled: true, collaborationEnabled: true });
  });

  await check('conflict_merges_only_locally_changed_fields', async () => {
    await setSaved({ workflowEnabled: false, collaborationEnabled: false }); await admin(); await setToggle('workflowEnabled', true);
    const peer = await setSaved({ workflowEnabled: false, collaborationEnabled: true }); await saveUI(409);
    const compare = panel().getByRole('region', { name: text('比较 MCP 配置', 'Compare MCP settings'), exact: true });
    await compare.waitFor(); await shot('concurrent-comparison');
    assert(await saveButton().isDisabled()); await button('保留我的修改', 'Keep my changes', compare).click();
    await assertValues({ workflowEnabled: true, collaborationEnabled: true }); assert(await saveButton().isEnabled());
    assert.deepEqual(await api('/settings/mcp'), peer, 'Merge remains a draft until explicitly saved');
    await saveUI();
    await setToggle('workflowEnabled', false);
    const latest = await setSaved({ workflowEnabled: true, collaborationEnabled: false }); await saveUI(409); await compare.waitFor();
    await button('取消修改', 'Cancel changes', panel()).click(); await assertValues(latest);
    assert(await saveButton().isDisabled(), 'Canceling a conflict shows current settings, not the stale baseline');
  });

  await check('rejected_save_and_lost_success_retain_reconcile_draft', async () => {
    await setSaved({ workflowEnabled: false, collaborationEnabled: false }); await admin(); await setToggle('workflowEnabled', true);
    const rejected = async route => route.request().method() === 'PUT'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'fixture_rejected', message: 'Fixture validation rejected this save' }) }) : route.continue();
    await page.route(settingsPattern, rejected);
    try {
      await saveUI(400); await panel().getByText('Fixture validation rejected this save', { exact: true }).waitFor();
      await assertValues({ workflowEnabled: true, collaborationEnabled: false }); assert.equal((await api('/settings/mcp')).workflowEnabled, false); assert(await saveButton().isEnabled());
    } finally { await page.unroute(settingsPattern, rejected); }
    let puts = 0, submitted;
    const lost = async route => {
      if (route.request().method() === 'PUT') { puts++; submitted = route.request().postDataJSON(); const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed'); }
      else if (puts) await route.abort('failed'); else await route.continue();
    };
    await page.route(settingsPattern, lost);
    try {
      await saveButton().click();
      await panel().getByText(text('保存结果尚未确认，修改已保留。请重新读取配置后核对。', 'The save result is still unconfirmed. Your edits are retained; read the settings again to verify.'), { exact: true }).waitFor();
      assert(await saveButton().isDisabled()); await assertValues({ workflowEnabled: true, collaborationEnabled: false });
      assert(await toggle('workflowEnabled').isDisabled()); await shot('unknown-result-retained');
    } finally { await page.unroute(settingsPattern, lost); }
    await button('重新读取配置', 'Read settings again', panel()).click();
    await eventually(async () => await saveButton().count() === 1 && await saveButton().isDisabled() && await toggle('workflowEnabled').isEnabled(), 'Unknown save becomes confirmed after reading');
    const actual = await api('/settings/mcp'); assert.equal(puts, 1, 'Recovery does not resubmit');
    assert.equal(actual.workflowEnabled, submitted.workflowEnabled); assert.equal(actual.collaborationEnabled, submitted.collaborationEnabled);
    assert.equal(actual.workflowSource, 'saved'); assert.equal(actual.collaborationSource, 'saved');
  });

  await check('disabled_work_module_keeps_settings_visible_editable', async () => {
    const settings = await api('/settings'); await siteSettings({ modules: { documents: false, work: false } });
    try {
      await setSaved({ workflowEnabled: false, collaborationEnabled: false }); await admin(); assert(await toggle('collaborationEnabled').isEnabled());
      await setToggle('collaborationEnabled', true); await saveUI();
      await panel().getByText(text('事项模块已关闭；协作设置会保留，启用事项后可用。', 'The Work module is disabled. Collaboration settings are retained and become available when Work is enabled.'), { exact: true }).waitFor();
      await shot('module-disabled');
    } finally { await siteSettings({ modules: settings.modules || { documents: true, work: true } }); }
  });

  await check('two_pages_hot_collaboration_refresh_preserves_work_draft', async () => {
    await setSaved({ workflowEnabled: false, collaborationEnabled: false }); await admin();
    const item = await api(work + '/items', 'POST', { id: id(), title: 'Hot MCP configuration keeps this work draft', placement: 'start' });
    const before = await api(work + '/items/' + item.id), revisions = await api(work + '/revision');
    workPage = await createPage();
    await workPage.goto(origin + '/#/library?view=board&space=' + fixture.shared + '&item=' + item.id, { waitUntil: 'domcontentloaded' });
    const detail = workPage.locator('[data-work-detail-id]'), title = detail.getByLabel(text('事项标题', 'Item title'), { exact: true }), collaboration = detail.locator('[data-work-collaboration]');
    await title.waitFor(); assert.equal(await collaboration.count(), 0);
    const draft = 'Unsaved title must survive an MCP configuration change'; await title.fill(draft);
    await page.bringToFront(); await setToggle('collaborationEnabled', true); await saveUI();
    await workPage.bringToFront(); await workPage.evaluate(() => window.dispatchEvent(new Event('focus')));
    await collaboration.waitFor(); assert.equal(await title.inputValue(), draft); await shot('work-draft-enabled', workPage);
    const enabledRevision = await api(work + '/revision'); assert.notEqual(enabledRevision.mcpSettingsRevision, revisions.mcpSettingsRevision);
    assert.equal(enabledRevision.revision, revisions.revision); assert.equal(enabledRevision.collaborationRevision, revisions.collaborationRevision);
    async function hotToggle(enabled) {
      await page.bringToFront(); await setToggle('collaborationEnabled', enabled); await saveUI();
      await workPage.bringToFront(); await workPage.evaluate(() => window.dispatchEvent(new Event('focus')));
    }
    await collaboration.getByRole('button', { name: new RegExp('^' + text('执行记录', 'Execution records')) }).click();
    const note = collaboration.locator('[data-work-collaboration-note]'), noteDraft = 'Retain this collaboration note while the owner changes configuration';
    await note.fill(noteDraft); await hotToggle(false);
    await eventually(async () => await collaboration.getAttribute('data-collaboration-state') === 'disabled', 'Disabling retains the visible note draft');
    assert.equal(await note.inputValue(), noteDraft); assert.equal(await title.inputValue(), draft);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await button('复制草稿', 'Copy draft', collaboration).click(); assert.equal(await workPage.evaluate(() => navigator.clipboard.readText()), noteDraft);
    await shot('work-disabled-note-retained', workPage);
    await hotToggle(true); await eventually(async () => await collaboration.getAttribute('data-collaboration-state') === 'unclaimed', 'Enabling restores collaboration without remounting the editor');
    assert.equal(await note.inputValue(), noteDraft);
    await hotToggle(false); await button('清空草稿', 'Clear draft', collaboration).click();
    await collaboration.waitFor({ state: 'hidden' }); assert.equal(await title.inputValue(), draft, 'Clearing a collaboration draft does not clear the item draft');
    await hotToggle(true); await collaboration.waitFor();
    const unknownNote = 'Unconfirmed note keeps its original receipt when collaboration is disabled'; await note.fill(unknownNote);
    let posts = 0;
    const eventsPattern = '**/api/v1' + work + '/items/' + item.id + '/events**';
    const lostNote = async route => { if (route.request().method() === 'POST') { posts++; await route.abort('failed'); } else if (posts) await route.abort('failed'); else await route.continue(); };
    await workPage.route(eventsPattern, lostNote);
    try {
      await button('添加记录', 'Add record', collaboration).click();
      await collaboration.getByText(text('添加结果尚未确认，内容与创建标识已保留。先重新核对，再重试同次提交。', 'The add result is unconfirmed. The content and operation ID are retained. Read again before retrying the same submission.'), { exact: true }).waitFor();
      await hotToggle(false);
      await eventually(async () => await collaboration.getAttribute('data-collaboration-state') === 'disabled', 'Unconfirmed note remains visible after disabling');
    } finally { await workPage.unroute(eventsPattern, lostNote); }
    assert.equal(await note.inputValue(), unknownNote); assert(await button('清空草稿', 'Clear draft', collaboration).isDisabled());
    await button('重新核对', 'Verify again', collaboration).click();
    await collaboration.getByText(text('暂未查询到这次提交；内容和原标识已保留，重新开启协作后可按原标识重试。', 'This submission has not been found. Its content and original ID are retained; enable collaboration to retry with that ID.'), { exact: true }).waitFor();
    assert.equal(posts, 1, 'Disabling and verifying do not resubmit an uncertain record'); assert.equal(await note.inputValue(), unknownNote); assert.equal(await title.inputValue(), draft);
    await shot('work-disabled-unknown-receipt', workPage);
    const after = await api(work + '/items/' + item.id); assert.equal(after.revision, before.revision); assert.equal(after.updatedAt, before.updatedAt); assert.equal(after.title, before.title);
    assert.equal((await api(work + '/items/' + item.id + '/events')).items.length, 0, 'Draft recovery creates no collaboration record');
    await workPage.close(); workPage = null;
  });

  await check('member_sees_actual_readonly_values_and_server_denies_write', async () => {
    await siteSettings({ mode: 'private_multi' }); await login();
    const actual = await setSaved({ workflowEnabled: true, collaborationEnabled: false });
    const member = { username: 'mcp_reader_' + crypto.randomBytes(5).toString('hex'), password: crypto.randomBytes(24).toString('hex'), displayName: 'MCP settings reader' };
    secrets.push(member.username, member.password); await api('/admin/users', 'POST', member, 201);
    memberContext = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
    await login(memberContext, member); const memberPage = await createPage(memberContext); await admin(memberPage);
    const visible = await api('/settings/mcp', 'GET', undefined, 200, memberContext); assert.equal(visible.canManage, false);
    assert.equal(visible.revision, actual.revision); await assertValues(actual, memberPage);
    assert(await toggle('workflowEnabled', memberPage).isDisabled()); assert(await toggle('collaborationEnabled', memberPage).isDisabled()); assert.equal(await saveButton(memberPage).count(), 0);
    await panel(memberPage).getByText(text('只有管理员可以修改全站 MCP 设置。', 'Only the owner can change site-wide MCP settings.'), { exact: true }).waitFor();
    await api('/settings/mcp', 'PUT', { expectedRevision: actual.revision, workflowEnabled: false, collaborationEnabled: true }, 403, memberContext);
    assert.deepEqual(await api('/settings/mcp'), actual, 'Denied member request does not change settings');
    await panel(memberPage).scrollIntoViewIfNeeded(); await shot('member-readonly-1600x900', memberPage); await memberContext.close(); memberContext = null;
  });
  assert(report.checks.length > 0, 'The selected check filter must match a test'); assert.deepEqual(report.errors, []); report.passed = true;
}
main().catch(async error => {
  report.failure = scrub(error.stack || error); console.error(report.failure);
  try { if (page && !page.isClosed()) await shot('failure'); } catch {}
  process.exitCode = 1;
}).finally(async () => {
  report.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(out, 'mcp-settings-report.json'), JSON.stringify(report, null, 2));
  if (browser) await browser.close();
});
