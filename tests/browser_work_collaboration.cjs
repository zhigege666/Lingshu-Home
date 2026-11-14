#!/usr/bin/env node
'use strict';
// Run only against an owned disposable loopback fixture; never a daily instance.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'Owned fixture/output required');
const provider = process.env.UI_PROVIDER || 'sqlite';
const f = JSON.parse(fs.readFileSync(process.env.UI_FIXTURES, 'utf8'))[provider];
const base = new URL(f.url);
assert(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname) && !base.username && !base.password);
const origin = base.origin, out = path.resolve(process.env.OUTPUT_DIR), secrets = [f.username, f.password];
const report = { passed: false, checks: [], screenshots: [], errors: [], startedAt: new Date().toISOString() };
const id = () => crypto.randomBytes(16).toString('hex');
const scrub = value => secrets.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, String(value));
let browser, context, machine, page, language, token, work, sessionA, sessionB;
const text = (zh, en) => language === 'en' ? en : zh;
const button = (zh, en, scope = page) => scope.getByRole('button', { name: text(zh, en), exact: true });
const detail = () => page.locator('[data-work-detail-id]');
const panel = () => detail().locator('[data-work-collaboration]');
const title = () => detail().getByLabel(text('事项标题', 'Item title'), { exact: true });
async function check(name, run) {
  if (process.env.UI_CHECK_MATCH && !new RegExp(process.env.UI_CHECK_MATCH).test(name)) return;
  const start = Date.now();
  try { await run(); report.checks.push({ name, passed: true, ms: Date.now() - start }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: scrub(error.message) }); throw error; }
}
async function boot() { const r = await context.request.get(origin + '/api/v1/bootstrap'); assert(r.ok()); return r.json(); }
async function api(suffix, method = 'GET', data, expected = 200) {
  const state = await boot();
  const r = await context.request.fetch(origin + '/api/v1' + suffix, { method, data, headers: { Origin: origin, 'X-CSRF-TOKEN': state.csrfToken } });
  assert([].concat(expected).includes(r.status()), method + ' ' + suffix + ' returned ' + r.status() + ': ' + scrub((await r.text()).slice(0, 250)));
  return r.status() === 204 ? null : r.json();
}
async function mcp(method, params) {
  const r = await machine.request.post(origin + '/mcp', {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json, text/event-stream', 'Mcp-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(params.name ? { 'Mcp-Name': params.name } : {}) },
    data: { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'home-collaboration-fixture', version: '1' } } } },
  });
  assert.equal(r.status(), 200, 'Authenticated MCP transport'); const body = await r.json(); assert(!body.error, JSON.stringify(body.error)); return body.result;
}
async function tool(name, args, error = false) {
  const r = await mcp('tools/call', { name, arguments: args });
  assert.equal(!!r.isError, error, name + ': ' + JSON.stringify(r.structuredContent));
  assert(r.structuredContent && typeof r.structuredContent === 'object'); return r.structuredContent;
}
async function create(label) { return api(work + '/items', 'POST', { id: id(), title: label, placement: 'start' }, 200); }
async function read(item) { return api(work + '/items/' + item.id); }
async function acquire(item, session = sessionA) {
  const current = await read(item);
  return tool('work_claims_acquire', { id: item.id, input: { sessionId: session.id, operationId: id(), expectedRevision: current.revision, expectedGeneration: current.collaboration?.generation || '0' } });
}
async function event(item, session, kind, body) { return tool('work_events_append', { id: item.id, input: { sessionId: session.id, operationId: id(), kind, body } }); }
async function open(item) { if (page) await page.close(); page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(scrub(error.message))); await page.goto(origin + '/#/library?view=board&space=' + f.shared + '&item=' + item.id, { waitUntil: 'domcontentloaded' }); await detail().waitFor(); }
async function viewport(width, height) { await page.setViewportSize({ width, height }); await page.waitForFunction(w => { const element = document.querySelector('[data-work-detail-id]'); return element && element.tagName === (w >= 2200 ? 'ASIDE' : 'DIV') && (w < 2200 || !document.querySelector('.work-drawer')); }, width); }
async function refresh() { await page.evaluate(() => window.dispatchEvent(new Event('focus'))); }
async function shot(name) { const filename = provider + '-' + name + '.png'; await page.screenshot({ path: path.join(out, filename), animations: 'disabled' }); report.screenshots.push(filename); }
async function records() { const b = panel().getByRole('button', { name: new RegExp('^' + text('执行记录', 'Execution records')) }); if (await b.getAttribute('aria-expanded') !== 'true') await b.click(); }
async function main() {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  machine = await browser.newContext(); page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(scrub(error.message)));
  await api('/auth/login', 'POST', { username: f.username, password: f.password, sessionMode: 'temporary' });
  const initial = await boot(); assert.equal(initial.siteName, 'Release UI fixture ' + provider); language = initial.language;
  work = '/spaces/' + f.shared + '/work';
  const minted = await api('/integrations/tokens', 'POST', { name: 'Disposable collaboration validation', spaceId: f.shared, actions: ['work:read', 'work:write'], expiresAt: new Date(Date.now() + 3600000).toISOString() }, 201);
  token = minted.token; secrets.push(token); assert(token);
  const capability = await tool('work_collaboration_get', {});
  if (!capability.enabled) {
    await check('default_off_keeps_legacy_work_editing', async () => {
      await tool('work_sessions_open', { input: { registrationId: id(), agentName: 'Disabled fixture' } }, true);
      const item = await tool('work_items_create', { input: { id: id(), title: 'Legacy work with collaboration off' } });
      const current = await read(item);
      await tool('work_items_update', { id: item.id, input: { expectedRevision: current.revision, nextStep: 'Legacy MCP update succeeds without session' } });
      await open(item); assert.equal(await title().inputValue(), current.title);
      assert.equal(await panel().count(), 0, 'No empty collaboration UI for untouched legacy work'); await shot('default-off');
    });
  } else {
    assert.equal(capability.effectiveEnabled, true);
    sessionA = await tool('work_sessions_open', { input: { registrationId: id(), agentName: '实现 Agent · 协作会话 A', clientName: 'Same-token browser fixture', role: 'Implementation' } });
    sessionB = await tool('work_sessions_open', { input: { registrationId: id(), agentName: '复核 Agent · 独立会话 B', clientName: 'Same-token browser fixture', role: 'Review', parentSessionId: sessionA.id } });
    await check('shared_token_sessions_atomic_claim_and_handoff', async () => {
      assert.notEqual(sessionA.id, sessionB.id);
      const item = await create('Two sessions share one credential'), current = await read(item);
      const payload = { expectedRevision: current.revision, expectedGeneration: current.collaboration?.generation || '0' };
      const attempts = await Promise.all([sessionA, sessionB].map(session => mcp('tools/call', { name: 'work_claims_acquire', arguments: { id: item.id, input: { ...payload, sessionId: session.id, operationId: id() } } })));
      assert.equal(attempts.filter(result => !result.isError).length, 1, 'Exactly one concurrent acquisition succeeds');
      const winner = attempts.find(result => !result.isError).structuredContent;
      const owning = winner.session.id === sessionA.id ? sessionA : sessionB;
      const next = owning.id === sessionA.id ? sessionB : sessionA;
      const before = await read(item), revBefore = await api(work + '/revision');
      await tool('work_claims_renew', { id: item.id, input: { sessionId: owning.id, claimId: winner.claimId, claimGeneration: winner.generation, operationId: id() } });
      const renewed = await read(item); assert.equal(renewed.updatedAt, before.updatedAt); assert.equal(renewed.revision, before.revision); assert.deepEqual(await api(work + '/revision'), revBefore);
      await tool('work_claims_release', { id: item.id, input: { sessionId: owning.id, claimId: winner.claimId, claimGeneration: winner.generation, operationId: id(), handoff: { completed: 'Implemented the owned fixture change', workspace: 'Isolated loopback fixture; no user files', nextStep: 'Review the saved result', unknowns: '' } } });
      const second = await acquire(item, next); assert(BigInt(second.generation) > BigInt(winner.generation));
      const stale = await tool('work_items_update', { id: item.id, input: { expectedRevision: renewed.revision, nextStep: 'Must not overwrite the next owner', context: { sessionId: owning.id, claimId: winner.claimId, claimGeneration: winner.generation, operationId: id() } } }, true);
      assert(stale.code, 'Stale owner receives structured application error');
      await open(item); await panel().getByText(next.agentName, { exact: false }).first().waitFor(); await records();
      await panel().getByText('Implemented the owned fixture change', { exact: true }).first().waitFor(); await shot('handoff-next-session');
    });
    await check('live_collaboration_keeps_dirty_form', async () => {
      const item = await create('Keep a human draft while agents report progress'); await acquire(item); await open(item);
      await panel().getByText(sessionA.agentName, { exact: false }).first().waitFor();
      await title().fill('Unsaved human title must survive collaboration refresh');
      const before = await read(item); await event(item, sessionA, 'progress', 'Verified backend changes without completing the task');
      await event(item, sessionB, 'review', 'Independent review recorded under the second session');
      await refresh(); await records(); await panel().getByText('Independent review recorded under the second session', { exact: true }).waitFor();
      assert.equal(await title().inputValue(), 'Unsaved human title must survive collaboration refresh');
      const after = await read(item); assert.equal(after.revision, before.revision); assert.equal(after.updatedAt, before.updatedAt);
      await shot('dirty-form-live-records');
    });
    await check('human_resolve_preserves_draft_and_note_receipt', async () => {
      const item = await create('Human checks operations before ending a claim'); await acquire(item); await open(item);
      await title().fill('Human draft retained through verified claim resolution');
      await panel().locator('[data-work-resolve-claim]').click();
      const dialog = page.getByRole('dialog').filter({ has: page.getByLabel(text('核实情况与解除原因', 'Verification and release reason'), { exact: true }) });
      await dialog.waitFor(); const resolve = button('解除认领', 'Release claim', dialog);
      assert(await resolve.isDisabled(), 'Unverified resolve is disabled');
      await dialog.getByLabel(text('核实情况与解除原因', 'Verification and release reason'), { exact: true }).fill('Disposable fixture has no external commands; verified both sessions are idle.');
      await dialog.getByLabel(text('已核实相关外部操作已停止', 'I verified that the related external operations have stopped'), { exact: true }).check();
      await resolve.click(); await dialog.waitFor({ state: 'hidden' });
      assert.equal(await title().inputValue(), 'Human draft retained through verified claim resolution');
      const resolved = await read(item); assert.equal(resolved.collaboration.unresolved, false);
      await button('保存事项', 'Save item', detail()).click();
      await page.waitForFunction(expected => document.querySelector('[data-work-detail-id] input')?.value === expected, 'Human draft retained through verified claim resolution');
      await records(); const note = panel().locator('[data-work-collaboration-note]');
      const body = 'Human note whose first successful response was deliberately lost'; let posts = 0;
      const pattern = '**/api/v1' + work + '/items/' + item.id + '/events**';
      const lost = async route => { if (route.request().method() !== 'POST') return posts ? route.abort('failed') : route.continue(); posts++; await route.fetch(); await route.abort('failed'); };
      await context.route(pattern, lost); await note.fill(body); await button('添加记录', 'Add record', panel()).click();
      await panel().getByText(text('添加结果尚未确认，内容与创建标识已保留。先重新核对，再重试同次提交。', 'The add result is unconfirmed. The content and operation ID are retained. Read again before retrying the same submission.'), { exact: true }).waitFor(); await context.unroute(pattern, lost);
      await button('重新核对', 'Verify again', panel()).click();
      await panel().getByText(body, { exact: true }).waitFor(); assert.equal(posts, 1, 'Unknown outcome is reconciled without duplicate POST');
      const events = await api(work + '/items/' + item.id + '/events?limit=100');
      const notes = events.items.filter(row => row.body === body); assert.equal(notes.length, 1); assert.equal(notes[0].origin, 'web'); assert(!notes[0].session);
      assert.equal((await read(item)).title, 'Human draft retained through verified claim resolution'); await shot('human-record-and-resolution');
    });
    await check('four_desktop_sizes_scroll_keyboard_and_dark', async () => {
      const item = await create('协作布局检查 · 较长事项标题与执行者信息');
      const long = await tool('work_sessions_open', { input: { registrationId: id(), agentName: '审阅与交接 Agent · 使用较长名称核对窄桌面与超宽屏幕的显示和主要操作可达性', clientName: 'Independent session for long attribution', role: 'Integration and acceptance' } });
      await acquire(item, long);
      for (let i = 0; i < 12; i++) await event(item, long, i % 2 ? 'note' : 'progress', '第 ' + (i + 1) + ' 条真实执行记录：' + '已完成的内容、验证依据以及下一步保留在当前事项中。'.repeat(4));
      await open(item); await records();
      const draft = 'Unsubmitted collaboration record survives all four desktop widths';
      await panel().locator('[data-work-collaboration-note]').fill(draft);
      for (const [width, height] of [[2560,1440],[1920,1080],[1600,900],[2560,1080]]) {
        await viewport(width, height);
        await panel().locator('[data-work-collaboration-note]').waitFor();
        assert.equal(await panel().locator('[data-work-collaboration-note]').inputValue(), draft, 'Responsive layout preserves collaboration draft');
        const geometry = await detail().evaluate(element => {
          const r = element.getBoundingClientRect(), footer = element.querySelector('.work-detail-footer')?.getBoundingClientRect();
          const body = element.querySelector('.work-detail-body');
          return { left: r.left, right: r.right, bottom: r.bottom, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), footer: footer && { top: footer.top, bottom: footer.bottom }, body: body && { height: body.clientHeight, scroll: body.scrollHeight, overflow: getComputedStyle(body).overflowY } };
        });
        assert(geometry.left >= 0 && geometry.right <= width + 1 && geometry.bottom <= height + 1); assert(geometry.scrollWidth <= width + 1);
        assert(geometry.footer && geometry.footer.top >= 0 && geometry.footer.bottom <= height + 1, 'Save footer visible');
        assert(geometry.body && geometry.body.scroll > geometry.body.height && ['auto','scroll'].includes(geometry.body.overflow), 'Long detail has internal scrolling');
        await panel().locator('[data-work-collaboration-note]').scrollIntoViewIfNeeded();
        await panel().locator('[data-work-collaboration-note]').focus(); assert(await panel().locator('[data-work-collaboration-note]').evaluate(e => e === document.activeElement));
        await shot('collaboration-' + width + 'x' + height);
      }
      await panel().locator('[data-work-resolve-claim]').click();
      const reason = page.getByLabel(text('核实情况与解除原因', 'Verification and release reason'), { exact: true });
      const stopped = page.getByLabel(text('已核实相关外部操作已停止', 'I verified that the related external operations have stopped'), { exact: true });
      await reason.fill('Unsubmitted verification reason survives the drawer breakpoint'); await stopped.check();
      await viewport(1600, 900); await reason.waitFor();
      assert.equal(await reason.inputValue(), 'Unsubmitted verification reason survives the drawer breakpoint'); assert(await stopped.isChecked());
      await shot('resolution-dialog-1600x900');
      await button('返回查看', 'Back to review').click();
      assert.equal(await panel().locator('[data-work-collaboration-note]').inputValue(), draft);
      await viewport(2560, 1080);
      await page.locator('header.app-header .home-account-trigger').click();
      await page.locator('.home-account-menu').getByRole('menuitemcheckbox', { name: text('切换深浅色', 'Toggle light or dark'), exact: true }).click();
      await page.keyboard.press('Escape'); await page.locator('.work-theme-dark').waitFor();
      await viewport(1600, 900); await shot('collaboration-dark-1600x900');
    });
  }
  assert.deepEqual(report.errors, [], 'No uncaught browser errors'); report.passed = true;
}
main().catch(async error => { report.failure = scrub(error.stack || error); if (page) try { await shot('failure'); } catch {} process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close(); report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'work-collaboration-report.json'), scrub(JSON.stringify(report, null, 2)) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failure: report.failure?.split('\n')[0], report: path.join(out, 'work-collaboration-report.json') }));
});
