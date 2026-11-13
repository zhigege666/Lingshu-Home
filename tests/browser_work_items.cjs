#!/usr/bin/env node
'use strict';
// Dedicated disposable loopback fixtures only; never run against user data.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'Owned fixture and output are required');
const fixtures = JSON.parse(fs.readFileSync(process.env.UI_FIXTURES, 'utf8'));
const out = path.resolve(process.env.OUTPUT_DIR);
const baseline = process.env.UI_BASELINE === '1';
const report = { passed: false, phase: baseline ? 'baseline-0.0.11' : 'current', checks: [], screenshots: [], errors: [], performance: [], startedAt: new Date().toISOString() };
let browser, currentPage;
const secrets = Object.values(fixtures).flatMap(f => [f.username, f.password]).filter(Boolean);
const scrub = x => secrets.reduce((v, s) => v.split(s).join('[redacted]'), String(x));
async function check(name, fn) {
  if (process.env.UI_CHECK_MATCH && !new RegExp(process.env.UI_CHECK_MATCH).test(name)) return;
  const start = Date.now();
  try { await fn(); report.checks.push({ name, passed: true, ms: Date.now() - start }); console.log('PASS ' + name); }
  catch (e) { report.checks.push({ name, passed: false, error: scrub(e.message) }); throw e; }
}
function quantile(values, p) { const a = [...values].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)]; }
async function main() {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.browser = browser.version();
  for (const provider of process.env.UI_PROVIDER ? [process.env.UI_PROVIDER] : Object.keys(fixtures)) {
    const f = fixtures[provider], base = new URL(f.url);
    assert(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && !base.username && !base.password, 'Only disposable loopback fixtures');
    const origin = base.origin;
    const context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'zh-CN', reducedMotion: 'reduce' });
    const page = await context.newPage(); currentPage = page; page.setDefaultTimeout(15000);
    page.on('pageerror', e => report.errors.push(scrub(e.message)));
    const boot = async (ctx = context) => { const r = await ctx.request.get(origin + '/api/v1/bootstrap'); assert(r.ok()); return r.json(); };
    async function api(suffix, method = 'GET', data, expected = 200, ctx = context) {
      const state = await boot(ctx);
      const r = await ctx.request.fetch(origin + '/api/v1' + suffix, { method, data, headers: { Origin: origin, 'X-CSRF-TOKEN': state.csrfToken }, maxRedirects: 0 });
      assert((Array.isArray(expected) ? expected : [expected]).includes(r.status()), method + ' ' + suffix + ': ' + r.status() + ' ' + (await r.text()).slice(0, 300));
      return expected === 204 ? null : r.json();
    }
    await api('/auth/login', 'POST', { username: f.username, password: f.password, sessionMode: 'temporary' });
    const initial = await boot();
    assert.equal(initial.siteName, 'Release UI fixture ' + provider, 'Fixture guard must match');
    const l = (zh, en) => initial.language === 'en' ? en : zh;
    const button = (zh, en, scope = page) => scope.getByRole('button', { name: l(zh, en), exact: true });
    const label = (zh, en, scope = page) => scope.getByLabel(l(zh, en), { exact: true });
    const space = '/spaces/' + f.shared;
    const prefix = 'Work ' + crypto.randomBytes(4).toString('hex');
    const bookmark = await api(space + '/links', 'POST', { title: prefix + ' reference', url: 'https://example.invalid/work', iconMode: 'manual', icon: 'lucide:link', description: 'Owned work fixture', tags: [] }, 201);
    async function shot(name) { const file = provider + '-' + name + '.png'; await page.screenshot({ path: path.join(out, file), animations: 'disabled' }); report.screenshots.push(file); }
    async function geometry(name, overflowingBoard = false) {
      const g = await page.evaluate(() => {
        const rect = selector => { const e = document.querySelector(selector); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, height: r.height }; };
        const board = document.querySelector('.work-board');
        return { width: innerWidth, height: innerHeight, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), panel: rect('[data-work-detail-id]'), header: rect('.work-topbar'), heading: rect('.work-context-heading'), actions: rect('.work-page-actions'), search: rect('.work-topbar .work-search'), board: board && { ...rect('.work-board'), clientWidth: board.clientWidth, scrollWidth: board.scrollWidth, overflowX: getComputedStyle(board).overflowX }, controls: [...document.querySelectorAll('.work-toolbar button,.work-topbar button,.work-detail-footer button,[data-work-detail-id] header button')].filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return { name: e.textContent || e.getAttribute('aria-label'), x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }) };
      });
      assert(g.scrollWidth <= g.width + 1, name + ' horizontal overflow');
      if (g.panel) assert(g.panel.x >= -1 && g.panel.y >= -1 && g.panel.right <= g.width + 1 && g.panel.bottom <= g.height + 1, name + ' detail panel outside viewport');
      for (const c of g.controls) assert(c.x >= -1 && c.y >= -1 && c.right <= g.width + 1 && c.bottom <= g.height + 1, name + ' offscreen control ' + c.name);
      assert(g.header && g.heading && g.actions && g.search, name + ' contextual header and search exist');
      for (const [key, r] of [['title', g.heading], ['actions', g.actions]]) assert(r.y >= g.header.y && r.bottom <= g.header.bottom + 1, name + ' ' + key + ' stays in topbar');
      assert(g.heading.right <= g.actions.x + 1, name + ' title does not overlap actions');
      assert(g.header.height <= 65 && g.search.y >= g.header.y && g.search.bottom <= g.header.bottom + 1, name + ' search stays in the compact header');
      if (g.board) {
        assert(g.board.x >= -1 && g.board.right <= g.width + 1, name + ' board container stays in viewport');
        assert(g.search.bottom <= g.board.y + 1, name + ' search stays above board');
        if (overflowingBoard) {
          assert(g.board.scrollWidth > g.board.clientWidth + 1 && ['auto', 'scroll'].includes(g.board.overflowX), name + ' extra columns scroll within board');
          const moved = await page.locator('.work-board').evaluate(e => { const old = e.scrollLeft; e.scrollLeft = e.scrollWidth; const moved = e.scrollLeft > 0; e.scrollLeft = old; return moved; });
          assert(moved, name + ' internal horizontal scrolling works');
        }
      }
      await shot(name);
    }
    await check(provider + '/home_initial_loading_baseline', async () => {
      const storageState = await context.storageState();
      for (let run = 1; run <= 3; run++) {
        const c = await browser.newContext({ viewport: { width: 2560, height: 1440 }, storageState, reducedMotion: 'reduce' });
        const p = await c.newPage();
        const errors = []; p.on('pageerror', e => errors.push(e.message));
        await p.addInitScript(() => {
          window.__workLab = { lcp: null, longTasks: [] };
          new PerformanceObserver(list => { for (const e of list.getEntries()) window.__workLab.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
          new PerformanceObserver(list => window.__workLab.longTasks.push(...list.getEntries().map(e => e.duration))).observe({ type: 'longtask', buffered: true });
        });
        await p.goto(origin + '/#/', { waitUntil: 'networkidle' });
        await p.locator('.lh-home').waitFor();
        const m = await p.evaluate(() => ({ readyMs: performance.now(), lcpMs: window.__workLab.lcp, fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime, blockingMs: window.__workLab.longTasks.reduce((a, x) => a + Math.max(0, x - 50), 0), domNodes: document.querySelectorAll('*').length, resources: performance.getEntriesByType('resource').map(e => ({ path: new URL(e.name).pathname, encoded: e.encodedBodySize, decoded: e.decodedBodySize })) }));
        assert.equal(errors.length, 0, 'Homepage browser errors');
        assert.equal(m.resources.some(e => /BoardView|\/work\//.test(e.path)), false, 'Home must not load board code or data');
        report.performance.push({ surface: 'home', provider, run, ...m });
        await c.close();
      }
    });
    if (!baseline) {
      const work = space + '/work';
      const newID = () => crypto.randomBytes(16).toString('hex');
      let project, item, second, source, document;
      await check(provider + '/http_references_versions_and_create_replay', async () => {
        project = await api(work + '/projects', 'POST', { id: newID(), name: prefix + ' project' });
        source = await api(space + '/document-sources', 'POST', { name: prefix + ' notes', path: f.documentRoot, readOnly: true, defaultWrite: false, defaultFolder: '', scanIntervalSeconds: 0 }, 201);
        await api(space + '/document-sources/' + source.id + '/scan', 'POST', {});
        document = (await api(space + '/documents?sourceId=' + source.id)).items.find(x => x.relativePath === 'plan.md');
        assert(document, 'Mounted original is indexed');
        const input = { id: newID(), title: prefix + ' initial', projectId: project.id, nextStep: 'Check the original reference', bookmarkIds: [bookmark.id], documentIds: [document.id] };
        item = await api(work + '/items', 'POST', input);
        const replay = await api(work + '/items', 'POST', input, [200, 201]);
        assert.equal(replay.id, item.id); assert.equal(replay.revision, item.revision);
        await api(work + '/items', 'POST', { ...input, title: 'different intent' }, 409);
        assert.equal(item.references.length, 2);
        const before = item.revision;
        item = await api(work + '/items/' + item.id, 'PATCH', { expectedRevision: before, needsAttention: true });
        await api(work + '/items/' + item.id, 'PATCH', { expectedRevision: before, title: 'must not overwrite' }, 409);
        assert.equal((await api(work + '/items/' + item.id)).title, input.title);
        second = await api(work + '/items', 'POST', { id: newID(), title: prefix + ' second', status: 'waiting' });
        const board = await api(work + '/board?limit=1');
        assert.equal(board.columns.find(c => c.status === 'todo').total, 1);
        const onlyAttention = await api(work + '/items?attention=true');
        assert(onlyAttention.items.some(x => x.id === item.id));
        assert(!onlyAttention.items.some(x => x.id === second.id), 'Waiting is independent of needsAttention');
        const anonymous = await browser.newContext();
        await api(work + '/board', 'GET', undefined, [401, 403], anonymous);
        await anonymous.close();
        assert.equal(fs.readFileSync(path.join(f.documentRoot, 'plan.md'), 'utf8'), '# Work fixture\n\nOriginal mounted document.\n');
      });
      // A selected regression receives fresh setup records without rerunning prior check groups.
      if (!project) {
        project = await api(work + '/projects', 'POST', { id: newID(), name: prefix + ' project' });
        item = await api(work + '/items', 'POST', { id: newID(), title: prefix + ' initial', projectId: project.id });
      }
      const detail = () => page.locator('[data-work-detail-id]');
      const card = id => page.locator('[data-work-id="' + id + '"]');
      async function openBoard() { await page.goto(origin + '/#/library?view=board&space=' + f.shared, { waitUntil: 'domcontentloaded' }); await page.locator('.work-shell').waitFor(); await card(item.id).waitFor(); }
      async function choose(control, text) { await control.click(); await page.getByRole('option', { name: text, exact: true }).click(); }
      async function mutation(action, suffix, method = 'PATCH', status = 200) {
        const waiting = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1' + suffix && r.request().method() === method);
        await action(); const r = await waiting; assert.equal(r.status(), status); return r.json();
      }
      async function closeDetail() { if (await detail().count()) { await button('关闭事项', 'Close item', detail()).click(); await detail().waitFor({ state: 'hidden' }); } }
      async function openStatuses() {
        await button('看板操作', 'Board actions').click();
        await page.getByRole('menuitem', { name: l('管理状态', 'Manage statuses'), exact: true }).click();
        const dialog = page.locator('.work-status-manager'); await dialog.locator('[data-status-id]').first().waitFor(); return dialog;
      }
      async function setStatusColor(row, color) {
        await row.locator('input[type=color]').evaluate((input, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }, color);
      }
      let uiItem, uiProject;
      await check(provider + '/ui_create_project_item_edit_and_persistence', async () => {
        await openBoard();
        await button('新建项目', 'New project').click();
        const dialog = page.getByRole('dialog'); await label('项目名称', 'Project name', dialog).fill(prefix + ' UI project');
        uiProject = await mutation(() => button('创建项目', 'Create project', dialog).click(), work + '/projects', 'POST');
        await dialog.waitFor({ state: 'hidden' });
        await button('新建事项', 'New item').click(); await detail().waitFor();
        await label('事项标题', 'Item title', detail()).fill(prefix + ' UI item');
        await label('下一步', 'Next step', detail()).fill('Verify through the real browser');
        await label('说明', 'Description', detail()).fill('A working record linked to original resources.');
        uiItem = await mutation(() => button('创建事项', 'Create item', detail()).click(), work + '/items', 'POST');
        assert.equal(uiItem.projectId, uiProject.id, 'Current project is prefilled');
        await label('结果', 'Result', detail()).fill('Saved from the actual editor');
        await label('待我处理', 'Needs my attention', detail()).check();
        uiItem = await mutation(() => button('保存事项', 'Save item', detail()).click(), work + '/items/' + uiItem.id);
        assert(uiItem.needsAttention); assert.equal(uiItem.result, 'Saved from the actual editor');
        await closeDetail(); await page.reload(); await card(uiItem.id).waitFor();
        const saved = await api(work + '/items/' + uiItem.id); assert.equal(saved.result, uiItem.result);
      });
      if (!uiItem) {
        uiProject = await api(work + '/projects', 'POST', { id: newID(), name: prefix + ' UI project' });
        uiItem = await api(work + '/items', 'POST', { id: newID(), title: prefix + ' UI item', projectId: uiProject.id });
        await openBoard();
      }
      await check(provider + '/ui_native_drag_and_keyboard_status', async () => {
        const sourceCard = card(uiItem.id), target = page.locator('section[data-work-status="doing"] .work-lane-body');
        const changed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1' + work + '/items/' + uiItem.id + '/move');
        await sourceCard.dragTo(target, { targetPosition: { x: 50, y: 35 } }); assert.equal((await changed).status(), 200);
        await page.locator('section[data-work-status="doing"] [data-work-id="' + uiItem.id + '"]').waitFor();
        assert.equal((await api(work + '/items/' + uiItem.id)).status, 'doing');
        await card(uiItem.id).locator('.work-card-title').click(); await detail().waitFor();
        await choose(label('状态', 'Status', detail()), l('完成', 'Done'));
        await label('结果', 'Result', detail()).fill('');
        uiItem = await mutation(() => button('保存事项', 'Save item', detail()).click(), work + '/items/' + uiItem.id);
        assert.equal(uiItem.status, 'done'); assert.equal(uiItem.result, '', 'Result is optional when completing work');
        await closeDetail();
      });
      await check(provider + '/ui_conflict_preserves_draft_and_uncertain_response_reads_back', async () => {
        await card(uiItem.id).locator('.work-card-title').click(); await detail().waitFor();
        const title = label('事项标题', 'Item title', detail()); await title.fill(prefix + ' local draft');
        let latest = await api(work + '/items/' + uiItem.id);
        await api(work + '/items/' + uiItem.id, 'PATCH', { expectedRevision: latest.revision, title: prefix + ' remote update' });
        await mutation(() => button('保存事项', 'Save item', detail()).click(), work + '/items/' + uiItem.id, 'PATCH', 409);
        assert.equal(await title.inputValue(), prefix + ' local draft');
        await button('读取最新版本', 'Read latest version', detail()).click();
        await button('使用最新版本', 'Use latest version', detail()).click();
        assert.equal(await title.inputValue(), prefix + ' remote update');
        let patches = 0;
        const pattern = '**/api/v1' + work + '/items/' + uiItem.id;
        const lostResponse = async route => {
          if (route.request().method() !== 'PATCH') return route.continue();
          patches++; await route.fetch(); await route.abort('failed');
        };
        await context.route(pattern, lostResponse);
        await title.fill(prefix + ' lost response'); await button('保存事项', 'Save item', detail()).click();
        await page.locator('.app-toast').getByText(l('已读到与当前草稿一致的内容。', 'The current record matches your draft.'), { exact: true }).waitFor();
        assert.equal(patches, 1, 'No blind write replay');
        await context.unroute(pattern, lostResponse);
        latest = await api(work + '/items/' + uiItem.id); assert.equal(latest.title, prefix + ' lost response');
        await closeDetail();
      });
      await check(provider + '/ui_archive_restore_and_dirty_close_guard', async () => {
        await card(uiItem.id).locator('.work-card-title').click(); await detail().waitFor();
        await label('说明', 'Description', detail()).fill('Unsaved text must be guarded');
        await button('关闭事项', 'Close item', detail()).click();
        await button('继续编辑', 'Keep editing', page.getByRole('dialog')).click();
        assert.equal(await label('说明', 'Description', detail()).inputValue(), 'Unsaved text must be guarded');
        await button('关闭事项', 'Close item', detail()).click(); await button('放弃修改', 'Discard changes', page.getByRole('dialog')).click();
        await detail().waitFor({ state: 'hidden' });
        await card(uiItem.id).locator('.work-card-title').click(); await detail().waitFor();
        uiItem = await mutation(() => button('归档事项', 'Archive item', detail()).click(), work + '/items/' + uiItem.id);
        assert(uiItem.archived);
        uiItem = await mutation(() => button('恢复事项', 'Restore item', detail()).click(), work + '/items/' + uiItem.id);
        assert(!uiItem.archived); await closeDetail();
      });
      await check(provider + '/ui_project_archive_unconfirmed_and_recovery', async () => {
        await closeDetail();
        const editProject = () => page.locator('[data-work-project-id="' + uiProject.id + '"] .work-project-edit');
        await editProject().click();
        const dialog = page.getByRole('dialog');
        let patches = 0;
        const pattern = '**/api/v1' + work + '/projects/' + uiProject.id;
        const failedWrite = async route => {
          if (route.request().method() !== 'PATCH') return route.continue();
          patches++;
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'injected_unavailable', message: 'Owned fixture unavailable' } }) });
        };
        await context.route(pattern, failedWrite);
        await button('归档项目', 'Archive project', dialog).click();
        await button('读取最新版本', 'Read latest version', dialog).click();
        await dialog.getByText(l('当前状态：未归档；待确认操作：归档项目', 'Current state: Active; unconfirmed action: Archive project'), { exact: true }).waitFor();
        assert(await dialog.isVisible(), 'A name match cannot confirm an uncommitted archive');
        assert.equal(patches, 1, 'Failed project archive is not automatically retried');
        assert.equal((await api(work + '/projects')).items.find(x => x.id === uiProject.id).archived, false);
        await context.unroute(pattern, failedWrite);
        await button('使用最新版本', 'Use latest version', dialog).click();
        uiProject = await mutation(() => button('归档项目', 'Archive project', dialog).click(), work + '/projects/' + uiProject.id);
        assert(uiProject.archived); await dialog.waitFor({ state: 'hidden' });
        await editProject().click();
        patches = 0;
        const lostResponse = async route => {
          if (route.request().method() !== 'PATCH') return route.continue();
          patches++; await route.fetch(); await route.abort('failed');
        };
        await context.route(pattern, lostResponse);
        await button('恢复项目', 'Restore project', dialog).click();
        await button('读取最新版本', 'Read latest version', dialog).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(patches, 1, 'Committed restore is confirmed by readback without retry');
        await context.unroute(pattern, lostResponse);
        uiProject = (await api(work + '/projects')).items.find(x => x.id === uiProject.id);
        assert.equal(uiProject.archived, false);
        await button('全部事项', 'All items').click(); await card(uiItem.id).waitFor();
      });
      await check(provider + '/ui_resources_and_create_from_originals', async () => {
        await closeDetail(); await page.setViewportSize({ width: 1920, height: 1080 });
        if (!document) {
          source = await api(space + '/document-sources', 'POST', { name: prefix + ' notes', path: f.documentRoot, readOnly: true, defaultWrite: false, defaultFolder: '', scanIntervalSeconds: 0 }, 201);
          await api(space + '/document-sources/' + source.id + '/scan', 'POST', {});
          document = (await api(space + '/documents?sourceId=' + source.id)).items.find(x => x.relativePath === 'plan.md');
        }
        await page.goto(origin + '/#/library?space=' + f.shared + '&document=' + document.id, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-document-id="' + document.id + '"]').waitFor();
        await button('创建事项', 'Create item').click(); await detail().waitFor();
        assert.equal(await label('事项标题', 'Item title', detail()).inputValue(), document.title);
        const fromDocument = await mutation(() => button('创建事项', 'Create item', detail()).click(), work + '/items', 'POST');
        assert.deepEqual(fromDocument.documentIds, [document.id]); await closeDetail();
        await page.goto(origin + '/#/library?space=' + f.shared + '&bookmark=' + bookmark.id, { waitUntil: 'domcontentloaded' });
        await button('创建事项', 'Create item').click(); await detail().waitFor();
        assert.equal(await label('事项标题', 'Item title', detail()).inputValue(), bookmark.title);
        let fromBookmark = await mutation(() => button('创建事项', 'Create item', detail()).click(), work + '/items', 'POST');
        assert.deepEqual(fromBookmark.bookmarkIds, [bookmark.id]);
        await button('关联资料', 'Link resources', detail()).click();
        const picker = page.locator('.work-resource-picker');
        await button('文档', 'Documents', picker).click();
        await picker.locator('[data-work-resource-id="' + document.id + '"]').click();
        await button('关闭资料选择', 'Close resource picker', picker).click();
        fromBookmark = await mutation(() => button('保存事项', 'Save item', detail()).click(), work + '/items/' + fromBookmark.id);
        assert.deepEqual(fromBookmark.documentIds, [document.id]);
        await detail().getByRole('button', { name: l('取消关联：', 'Unlink: ') + bookmark.title, exact: true }).click();
        fromBookmark = await mutation(() => button('保存事项', 'Save item', detail()).click(), work + '/items/' + fromBookmark.id);
        assert.deepEqual(fromBookmark.bookmarkIds, []);
        assert.equal((await api(work + '/resources?kind=bookmark')).items.find(x => x.id === bookmark.id).title, bookmark.title, 'Unlinking preserves the bookmark');
        assert.equal(fs.readFileSync(path.join(f.documentRoot, 'plan.md'), 'utf8'), '# Work fixture\n\nOriginal mounted document.\n');
        await closeDetail(); await page.setViewportSize({ width: 2560, height: 1440 }); await openBoard();
      });
      await check(provider + '/ui_dynamic_status_configuration_and_migration', async () => {
        await closeDetail(); await page.setViewportSize({ width: 2560, height: 1440 }); await openBoard();
        const original = await api(work + '/statuses');
        let manager = await openStatuses();
        await button('新增状态', 'Add status', manager).click();
        let row = manager.locator('[data-status-id]').last();
        const statusId = await row.getAttribute('data-status-id'), initialName = prefix + ' review', editedName = prefix + ' final review';
        await row.locator('[data-status-name]').fill(initialName);
        await row.locator('.work-status-description').fill('Ready for a person to review the result.');
        await setStatusColor(row, '#517d9b');
        await choose(row.getByRole('combobox'), l('进行中', 'In progress'));
        await row.getByRole('radio').check();
        let catalog = await mutation(() => button('保存状态', 'Save statuses', manager).click(), work + '/statuses/batch-edit', 'POST');
        await manager.waitFor({ state: 'hidden' });
        assert.match(statusId, /^[a-f0-9]{32}$/); assert.equal(catalog.defaultStatus, statusId);
        let custom = catalog.items.find(x => x.id === statusId);
        assert.equal(custom.name, initialName); assert.equal(custom.type, 'doing'); assert.equal(custom.color, '#517d9b');
        await page.locator('.work-lane[data-work-status="' + statusId + '"]').waitFor();
        await button('新建事项', 'New item').click(); await detail().waitFor();
        assert.equal((await label('状态', 'Status', detail()).innerText()).trim(), initialName, 'New items use the space default');
        await label('事项标题', 'Item title', detail()).fill(prefix + ' review decision');
        await label('下一步', 'Next step', detail()).fill('Review the completed dashboard before publishing.');
        await label('说明', 'Description', detail()).fill('Keep the original work and archived records when the workflow changes.');
        const activeItem = await mutation(() => button('创建事项', 'Create item', detail()).click(), work + '/items', 'POST');
        assert.equal(activeItem.status, statusId); await closeDetail();
        let archivedItem = await api(work + '/items', 'POST', { id: newID(), title: prefix + ' archived review', status: statusId });
        archivedItem = await api(work + '/items/' + archivedItem.id, 'PATCH', { expectedRevision: archivedItem.revision, archived: true });
        manager = await openStatuses(); row = manager.locator('[data-status-id="' + statusId + '"]');
        await row.locator('[data-status-name]').fill(editedName);
        await row.locator('.work-status-description').fill('Waiting for a reviewer; preserve the decision and all references.');
        await choose(row.getByRole('combobox'), l('等待', 'Waiting'));
        await setStatusColor(row, '#a97831');
        await button('上移：' + editedName, 'Move up: ' + editedName, row).click();
        catalog = await mutation(() => button('保存状态', 'Save statuses', manager).click(), work + '/statuses/batch-edit', 'POST');
        await manager.waitFor({ state: 'hidden' });
        custom = catalog.items.find(x => x.id === statusId);
        assert.equal(custom.name, editedName); assert.equal(custom.type, 'waiting'); assert.equal(custom.color, '#a97831');
        assert.equal(custom.description, 'Waiting for a reviewer; preserve the decision and all references.');
        assert.equal(catalog.items[original.items.length - 1].id, statusId, 'Custom status order is persisted');
        await page.locator('.work-lane[data-work-status="' + statusId + '"] .work-status-name').filter({ hasText: editedName }).waitFor();
        await card(activeItem.id).locator('.work-card-title').click(); await detail().waitFor();
        assert.equal((await label('状态', 'Status', detail()).innerText()).trim(), editedName, 'Existing item keeps its stable status ID after rename');
        await closeDetail();
        manager = await openStatuses(); row = manager.locator('[data-status-id="' + statusId + '"]');
        await shot('status-manager-with-custom-stage');
        await manager.locator('[data-status-id="' + original.defaultStatus + '"]').getByRole('radio').check();
        await button('删除状态：' + editedName, 'Remove status: ' + editedName, row).click();
        await row.getByText(l('迁移 2 个事项（含 1 个已归档）', 'Move 2 items (1 archived)'), { exact: true }).waitFor();
        const destination = catalog.items.find(x => x.id === 'doing');
        await choose(row.getByRole('combobox'), destination.name);
        catalog = await mutation(() => button('保存状态', 'Save statuses', manager).click(), work + '/statuses/batch-edit', 'POST');
        await manager.waitFor({ state: 'hidden' });
        assert.equal(catalog.items.some(x => x.id === statusId), false); assert.equal(catalog.defaultStatus, original.defaultStatus);
        const migrated = await api(work + '/items/' + activeItem.id), migratedArchive = await api(work + '/items/' + archivedItem.id);
        assert.equal(migrated.status, destination.id); assert.equal(migrated.description, activeItem.description);
        assert.equal(migratedArchive.status, destination.id); assert.equal(migratedArchive.archived, true);
        await page.locator('.work-lane[data-work-status="' + statusId + '"]').waitFor({ state: 'hidden' });
        await page.locator('.work-lane[data-work-status="doing"] [data-work-id="' + activeItem.id + '"]').waitFor();
      });
      await check(provider + '/ui_status_manager_layout_and_scrolling', async () => {
        await closeDetail(); await openBoard();
        const original = await api(work + '/statuses');
        async function assertManagerLayout(manager, name, scrollExpected) {
          const before = await manager.evaluate(el => {
            const rect = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
            const body = el.querySelector('.work-detail-body');
            return { viewport: { width: innerWidth, height: innerHeight }, dialog: rect(el), heading: rect(el.querySelector('.work-detail-heading')), body: { ...rect(body), clientHeight: body.clientHeight, scrollHeight: body.scrollHeight, overflow: getComputedStyle(body).overflowY }, footer: rect(el.querySelector('.work-detail-footer')), display: getComputedStyle(el).display };
          });
          report.layouts ||= []; report.layouts.push({ name, ...before });
          await shot(name);
          assert(Math.abs(before.footer.bottom - before.dialog.bottom) <= 1, name + ' footer must touch drawer bottom: ' + JSON.stringify(before));
          assert(before.dialog.left >= -1 && before.dialog.right <= before.viewport.width + 1 && Math.abs(before.dialog.bottom - before.viewport.height) <= 1, name + ' drawer stays in viewport');
          assert(before.body.top >= before.heading.bottom - 1 && before.body.bottom <= before.footer.top + 1, name + ' content stays between heading and footer');
          assert(['auto', 'scroll'].includes(before.body.overflow), name + ' only content owns scrolling');
          if (scrollExpected) {
            assert(before.body.scrollHeight > before.body.clientHeight + 1, name + ' long status list has internal overflow');
            const after = await manager.evaluate(el => {
              const body = el.querySelector('.work-detail-body'); body.scrollTop = body.scrollHeight;
              return { scrollTop: body.scrollTop, footerBottom: el.querySelector('.work-detail-footer').getBoundingClientRect().bottom, headingTop: el.querySelector('.work-detail-heading').getBoundingClientRect().top, windowScroll: scrollY };
            });
            assert(after.scrollTop > 0 && after.windowScroll === 0, name + ' list scroll does not move the page');
            assert(Math.abs(after.footerBottom - before.footer.bottom) <= 1 && Math.abs(after.headingTop - before.heading.top) <= 1, name + ' heading/footer remain fixed');
            const add = await button('新增状态', 'Add status', manager).boundingBox();
            assert(add && add.y + add.height <= before.footer.top + 1, name + ' add action stays reachable above footer');
            await shot(name + '-scrolled');
          }
        }
        for (const [width, height] of [[2560,1440],[1920,1080],[1600,900],[2560,1080]]) {
          await page.setViewportSize({ width, height });
          const manager = await openStatuses();
          await assertManagerLayout(manager, 'status-manager-short-' + width + 'x' + height, false);
          await button('关闭状态管理', 'Close status manager', manager).click();
          await manager.waitFor({ state: 'hidden' });
        }
        const extra = Array.from({ length: 10 }, (_, index) => ({ id: newID(), name: prefix + ' layout ' + (index + 1), type: 'doing', color: '#517d9b', description: 'Review the result before moving this item to the next stage.' }));
        const added = await api(work + '/statuses/batch-edit', 'POST', { expectedRevision: original.revision, create: extra, order: [...original.items.map(x => x.id), ...extra.map(x => x.id)] });
        await openBoard();
        for (const [width, height] of [[2560,1440],[1920,1080],[1600,900],[2560,1080]]) {
          await page.setViewportSize({ width, height });
          const manager = await openStatuses();
          await assertManagerLayout(manager, 'status-manager-long-' + width + 'x' + height, true);
          const last = manager.locator('[data-status-id="' + extra.at(-1).id + '"]');
          await last.getByRole('combobox').click();
          const popup = await page.getByRole('listbox').boundingBox();
          assert(popup && popup.x >= 0 && popup.y >= 0 && popup.x + popup.width <= width + 1 && popup.y + popup.height <= height + 1, 'Status menu stays within viewport after scrolling');
          await page.keyboard.press('Escape');
          await button('关闭状态管理', 'Close status manager', manager).click();
          await manager.waitFor({ state: 'hidden' });
        }
        await api(work + '/statuses/batch-edit', 'POST', { expectedRevision: added.revision, deletions: extra.map(x => ({ id: x.id })), order: original.items.map(x => x.id) });
        await page.setViewportSize({ width: 2560, height: 1440 }); await openBoard();
      });
      await check(provider + '/ui_view_switch_and_four_screen_sizes', async () => {
        await closeDetail(); await page.setViewportSize({ width: 2560, height: 1440 });
        const original = await api(work + '/statuses');
        const extra = ['todo', 'doing', 'waiting', 'done', 'canceled'].map((type, index) => ({ id: newID(), name: prefix + ' stage ' + (index + 1) + ' with a longer name', type, color: ['#778899', '#4b879f', '#b18c35', '#4d8967', '#977986'][index], description: 'Owned layout fixture' }));
        await api(work + '/statuses/batch-edit', 'POST', { expectedRevision: original.revision, create: extra, order: [...original.items.map(x => x.id), ...extra.map(x => x.id)] });
        await openBoard();
        await page.locator('.work-lane[data-work-status="' + extra[0].id + '"]').waitFor();
        await button('列表', 'List').click(); await page.locator('.work-table').waitFor();
        await page.locator('.work-table [data-work-id="' + uiItem.id + '"]').waitFor();
        await button('看板', 'Board').click(); await page.locator('.work-board').waitFor();
        assert.equal(await page.locator('.work-lane').count(), original.items.length + extra.length);
        assert((await page.locator('.work-card').count()) > 0, 'Responsive screenshots include real item content');
        for (const [width, height] of [[2560,1440],[1920,1080],[1600,900],[2560,1080]]) {
          await page.setViewportSize({ width, height }); await geometry('board-' + width + 'x' + height, true);
          await card(uiItem.id).locator('.work-card-title').click(); await detail().waitFor(); await geometry('detail-' + width + 'x' + height, true); await closeDetail();
        }
        await page.setViewportSize({ width: 2560, height: 1440 });
        const latest = await api(work + '/statuses');
        await api(work + '/statuses/batch-edit', 'POST', { expectedRevision: latest.revision, deletions: extra.map(x => ({ id: x.id })), order: original.items.map(x => x.id) });
        await openBoard();
        const requests = []; const countRequest = r => { if (new URL(r.url()).pathname.includes('/work/')) requests.push({ path: new URL(r.url()).pathname, method: r.method() }); };
        await page.waitForLoadState('networkidle'); page.on('request', countRequest);
        const revisionCheck = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1' + work + '/revision');
        await page.evaluate(() => window.dispatchEvent(new Event('focus'))); assert.equal((await revisionCheck).status(), 200);
        await page.waitForLoadState('networkidle'); page.off('request', countRequest);
        assert(requests.length > 0 && requests.every(r => r.path.endsWith('/revision') && r.method === 'GET'), 'Returning to an unchanged board only checks the lightweight revision');
      });
      await check(provider + '/project_archive_preserves_open_items_and_originals', async () => {
        project = await api(work + '/projects/' + project.id, 'PATCH', { expectedRevision: project.revision, archived: true });
        const all = await api(work + '/items');
        assert(all.items.some(x => x.id === item.id), 'Project archive must not hide its open item');
        const oneProject = await api(work + '/items?projectId=' + project.id);
        assert(oneProject.items.some(x => x.id === item.id));
        project = await api(work + '/projects/' + project.id, 'PATCH', { expectedRevision: project.revision, archived: false });
        assert.equal(fs.readFileSync(path.join(f.documentRoot, 'plan.md'), 'utf8'), '# Work fixture\n\nOriginal mounted document.\n');
      });
      if (provider === 'sqlite') await check(provider + '/bounded_board_100_1000_10000_performance', async () => {
        const { spawnSync } = require('node:child_process');
        const db = path.join(out, 'data', 'lingshu-home.db');
        assert.equal(fs.realpathSync(db), db, 'Fixture database must not be a symlink');
        assert.equal(path.dirname(f.documentRoot), out, 'Only the task fixture can be seeded');
        const perfPrefix = crypto.randomBytes(8).toString('hex');
        const seed = `import json,sqlite3,sys,datetime\np=json.load(sys.stdin)\nc=sqlite3.connect(p['db'], timeout=10)\nc.execute('PRAGMA foreign_keys=ON')\nc.execute('BEGIN IMMEDIATE')\nc.execute('DELETE FROM work_items WHERE space_id=? AND substr(id,1,16)=?',(p['space'],p['prefix']))\nother=c.execute('SELECT count(*) FROM work_items WHERE space_id=?',(p['space'],)).fetchone()[0]\nnow=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')\nrows=[(p['prefix']+format(i,'016x'),p['space'],'Performance item '+str(i),['todo','doing','waiting','done'][i%4],(i+1)*1024,now,now) for i in range(p['count']-other)]\nc.executemany(\"INSERT INTO work_items(id,space_id,project_id,title,description,next_step,result,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash) VALUES(?,?,NULL,?,'','','',?,0,0,?,1,?,?,'performance-fixture')\",rows)\nc.execute('UPDATE work_spaces SET revision=revision+1 WHERE space_id=?',(p['space'],))\nc.commit()\nprint(json.dumps({'count':c.execute('SELECT count(*) FROM work_items WHERE space_id=?',(p['space'],)).fetchone()[0]}))\nc.close()\n`;
        for (const count of [100, 1000, 10000]) {
          const seeded = spawnSync('python3', ['-c', seed], { input: JSON.stringify({ db, space: f.shared, prefix: perfPrefix, count }), encoding: 'utf8' });
          assert.equal(seeded.status, 0, seeded.stderr); assert.equal(JSON.parse(seeded.stdout).count, count);
          const elapsed = [], sizes = []; let cards = 0;
          for (let sample = 0; sample < 20; sample++) {
            const start = performance.now(); const r = await context.request.get(origin + '/api/v1' + work + '/board?limit=30');
            assert.equal(r.status(), 200); const text = await r.text(); elapsed.push(performance.now() - start); sizes.push(Buffer.byteLength(text));
            const value = JSON.parse(text); cards = value.columns.reduce((a, c) => a + c.items.length, 0);
            assert(cards <= 120, 'Bounded summary count');
            for (const c of value.columns) for (const row of c.items) { assert(!('description' in row) && !('result' in row), 'List excludes long detail fields'); }
          }
          report.performance.push({ surface: 'board-api', count, samples: elapsed.length, p50Ms: quantile(elapsed, .5), p95Ms: quantile(elapsed, .95), responseBytes: Math.max(...sizes), cards });
          const storageState = await context.storageState();
          for (let run = 1; run <= 3; run++) {
            const c = await browser.newContext({ viewport: { width: 2560, height: 1440 }, storageState, reducedMotion: 'reduce' });
            const p = await c.newPage(); p.on('pageerror', e => report.errors.push(scrub(e.message)));
            await p.goto(origin + '/#/library?view=board&space=' + f.shared, { waitUntil: 'domcontentloaded' });
            await p.locator('[data-work-id]').first().waitFor();
            await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const m = await p.evaluate(() => ({ readyMs: performance.now(), cards: document.querySelectorAll('[data-work-id]').length, domNodes: document.querySelectorAll('*').length, fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime }));
            assert(m.cards <= 120 && m.cards > 0, 'Browser mounts bounded cards');
            report.performance.push({ surface: 'board-browser', count, run, ...m });
            if (count === 10000 && run === 1) { const file = provider + '-10000-board.png'; await p.screenshot({ path: path.join(out, file), animations: 'disabled' }); report.screenshots.push(file); }
            await c.close();
          }
        }
      });
    }
    await context.close();
  }
  assert.equal(report.errors.length, 0, 'No uncaught browser errors');
  report.passed = true;
}
main().catch(async e => {
  report.failure = scrub(e.stack || e);
  if (currentPage && !currentPage.isClosed()) { const file = 'work-failure.png'; await currentPage.screenshot({ path: path.join(out, file), animations: 'disabled', mask: [currentPage.locator('input[type=password]')] }).then(() => report.screenshots.push(file)).catch(() => {}); }
  console.error(report.failure); process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); fs.writeFileSync(path.join(out, 'work-report.json'), JSON.stringify(report, null, 2) + '\n'); });
