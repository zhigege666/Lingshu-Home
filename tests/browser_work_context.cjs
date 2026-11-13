#!/usr/bin/env node
'use strict';
// Owned, disposable loopback fixtures only. Never use a daily Home instance.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'Owned fixture and output directory are required');
const fixtures = JSON.parse(fs.readFileSync(process.env.UI_FIXTURES, 'utf8'));
const output = path.resolve(process.env.OUTPUT_DIR), baseline = process.env.UI_BASELINE === '1';
const report = { passed: false, phase: baseline ? 'v0.2.0-reproduction' : 'current', checks: [], observations: [], screenshots: [], errors: [] };
const secrets = Object.values(fixtures).flatMap(f => [f.username, f.password]).filter(Boolean);
const scrub = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));
let browser, page;
async function check(name, run) {
  if (process.env.UI_CHECK_MATCH && !new RegExp(process.env.UI_CHECK_MATCH).test(name)) return;
  const start = Date.now();
  try { await run(); report.checks.push({ name, passed: true, ms: Date.now() - start }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: scrub(error.message) }); throw error; }
}
async function main() {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.browser = browser.version();
  const provider = process.env.UI_PROVIDER || 'sqlite', fixture = fixtures[provider], base = new URL(fixture.url);
  assert(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && !base.username && !base.password);
  const origin = base.origin, context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(scrub(error.message)));
  const boot = async () => { const r = await context.request.get(origin + '/api/v1/bootstrap'); assert(r.ok()); return r.json(); };
  async function api(suffix, method = 'GET', data, expected = 200) {
    const state = await boot();
    const r = await context.request.fetch(origin + '/api/v1' + suffix, { method, data, headers: { Origin: origin, 'X-CSRF-TOKEN': state.csrfToken }, maxRedirects: 0 });
    assert((Array.isArray(expected) ? expected : [expected]).includes(r.status()), method + ' ' + suffix + ': ' + r.status());
    return r.json();
  }
  await api('/auth/login', 'POST', { username: fixture.username, password: fixture.password, sessionMode: 'temporary' });
  const initial = await boot(); assert.equal(initial.siteName, 'Release UI fixture ' + provider);
  const l = (zh, en) => initial.language === 'en' ? en : zh;
  const button = (zh, en, scope = page) => scope.getByRole('button', { name: l(zh, en), exact: true });
  const label = (zh, en, scope = page) => scope.getByLabel(l(zh, en), { exact: true });
  const space = '/spaces/' + fixture.shared, work = space + '/work';
  const id = () => crypto.randomBytes(16).toString('hex'), prefix = 'Context ' + crypto.randomBytes(4).toString('hex');
  const detail = () => page.locator('[data-work-detail-id]'), card = key => page.locator('[data-work-id="' + key + '"]');
  const title = () => label('事项标题', 'Item title', detail());
  const projectField = () => label('项目', 'Project', detail());
  const projectA = await api(work + '/projects', 'POST', { id: id(), name: prefix + ' Alpha' });
  const projectB = await api(work + '/projects', 'POST', { id: id(), name: prefix + ' Beta' });
  const seed = await api(work + '/items', 'POST', { id: id(), title: prefix + ' seed', projectId: projectA.id });
  const bookmark = await api(space + '/links', 'POST', { title: prefix + ' reference', url: 'https://example.invalid/context', iconMode: 'manual', icon: 'lucide:link', tags: [] }, 201);
  const boardURL = origin + '/#/library?view=board&space=' + fixture.shared;
  async function shot(name) { const filename = provider + '-' + name + '.png'; await page.screenshot({ path: path.join(output, filename), animations: 'disabled' }); report.screenshots.push(filename); }
  async function openBoard() {
    await page.goto(boardURL, { waitUntil: 'domcontentloaded' });
    if (!baseline) await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.work-board').waitFor(); await page.locator('[data-work-project-id="' + projectA.id + '"]').waitFor();
    await button('全部事项', 'All items', page.locator('.work-sidebar')).click();
    await page.waitForFunction(name => document.querySelector('.work-context-heading h1')?.textContent === name, l('全部事项', 'All items'));
    await page.locator('.work-board').waitFor();
  }
  async function selectProject(project) {
    await page.locator('[data-work-project-id="' + project.id + '"] > button').first().click();
    await page.waitForFunction(name => document.querySelector('.work-context-heading h1')?.textContent === name, project.name);
    await page.locator('.work-board').waitFor();
  }
  async function createDraft() { await button('新建事项', 'New item').click(); await detail().waitFor(); }
  async function mutation(action, suffix, method = 'POST', status = 200) {
    const waiting = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1' + suffix && r.request().method() === method);
    await action(); const r = await waiting; assert.equal(r.status(), status); return r.json();
  }
  async function saveCreate() { return mutation(() => button('创建事项', 'Create item', detail()).click(), work + '/items'); }
  async function closeDetail() { if (await detail().count()) { await button('关闭事项', 'Close item', detail()).click(); await detail().waitFor({ state: 'hidden' }); } }
  async function choose(control, text) { await control.click(); await page.getByRole('option', { name: text, exact: true }).click(); }
  async function reloadBoard() { await button('看板操作', 'Board actions').click(); await page.getByRole('menuitem', { name: l('重新读取', 'Reload'), exact: true }).click(); }

  if (baseline) {
    await check('baseline/normal_project_creation', async () => {
      await openBoard(); await selectProject(projectA); await createDraft();
      const before = await projectField().innerText(); await title().fill(prefix + ' ordinary');
      const after = await projectField().innerText(); const item = await saveCreate();
      await detail().getByText(l('事项已创建', 'Item created'), { exact: true }).waitFor();
      report.observations.push({ kind: 'ordinary-create', before, after, projectId: item.projectId, expectedProjectId: projectA.id });
      await shot('01-baseline-ordinary-create'); await closeDetail();
    });
    await check('baseline/project_switch_creates_hidden_item', async () => {
      await openBoard(); await createDraft(); await title().fill(prefix + ' scope mismatch');
      await selectProject(projectA);
      assert.equal(await button('放弃修改', 'Discard changes').count(), 0, 'Old scope switch unexpectedly guarded');
      assert.equal(await projectField().innerText(), l('未分组', 'No project'));
      await shot('02-baseline-scope-mismatch');
      const item = await saveCreate(); assert.equal(item.projectId, null);
      await page.locator('.work-feedback').waitFor();
      await page.waitForFunction(() => !document.querySelector('.work-main .admin-loading'));
      assert.equal(await card(item.id).count(), 0);
      report.observations.push({ kind: 'created-item-filtered', itemId: item.id, selectedProject: projectA.id, savedProject: item.projectId });
      await shot('03-baseline-created-hidden');
      await page.waitForTimeout(7000);
      assert.equal(await page.locator('.work-feedback').count(), 1);
      assert.equal(await detail().locator('.work-notice').count(), 1);
      await shot('04-baseline-persistent-duplicate-notice'); await closeDetail();
    });
    report.passed = true; return;
  }

  await check('project_create_inherits_scope_and_is_visible', async () => {
    await openBoard(); await button('新建项目', 'New project').click();
    const dialog = page.getByRole('dialog'); await label('项目名称', 'Project name', dialog).fill(prefix + ' UI project');
    const project = await mutation(() => button('创建项目', 'Create project', dialog).click(), work + '/projects');
    await dialog.waitFor({ state: 'hidden' }); await createDraft();
    assert.equal(await projectField().innerText(), project.name);
    await title().fill(prefix + ' immediate create'); const item = await saveCreate();
    assert.equal(item.projectId, project.id); await card(item.id).waitFor();
    assert(new URL(page.url()).hash.includes('item=' + item.id));
    assert.equal(await detail().locator('.work-notice').count(), 0);
    assert.equal(await page.locator('.work-feedback').count(), 0);
    await page.locator('.app-toast').waitFor(); await shot('01-created-visible-in-project');
    await page.locator('.app-toast').waitFor({ state: 'hidden', timeout: 9000 }); await closeDetail();
  });
  await check('scope_switch_guards_draft_and_resets_creation_context', async () => {
    await openBoard(); await createDraft(); await title().fill(prefix + ' retained draft');
    await page.locator('[data-work-project-id="' + projectA.id + '"] > button').first().click();
    await button('继续编辑', 'Keep editing', page.getByRole('dialog')).click();
    assert.equal(await title().inputValue(), prefix + ' retained draft');
    assert.equal(await projectField().innerText(), l('未分组', 'No project'));
    await page.locator('[data-work-project-id="' + projectA.id + '"] > button').first().click();
    await button('放弃修改', 'Discard changes', page.getByRole('dialog')).click();
    await detail().waitFor({ state: 'hidden' }); await createDraft();
    assert.equal(await projectField().innerText(), projectA.name);
    await title().fill(prefix + ' reload discard'); await reloadBoard();
    await button('放弃修改', 'Discard changes', page.getByRole('dialog')).click();
    await detail().waitFor(); assert.equal(await title().inputValue(), '');
    assert.equal(await projectField().innerText(), projectA.name);
    await title().fill(prefix + ' preserved project'); const item = await saveCreate();
    assert.equal(item.projectId, projectA.id); await card(item.id).waitFor(); await closeDetail();
  });
  await check('attention_search_and_archived_creation_boundaries', async () => {
    await openBoard(); await button('待我处理', 'Needs my attention', page.locator('.work-sidebar')).click();
    await createDraft(); assert.equal(await detail().getByRole('checkbox').getAttribute('data-state'), 'checked');
    await title().fill(prefix + ' attention'); const attentionItem = await saveCreate();
    assert.equal(attentionItem.needsAttention, true); await card(attentionItem.id).waitFor(); await closeDetail();
    await label('搜索事项', 'Search items').fill('no-match-' + prefix);
    await page.waitForFunction(() => document.querySelectorAll('.work-card').length === 0);
    await createDraft(); await title().fill(prefix + ' search created'); const item = await saveCreate();
    await card(item.id).waitFor(); assert.equal(await label('搜索事项', 'Search items').inputValue(), ''); await closeDetail();
    await button('已归档', 'Archived', page.locator('.work-sidebar')).click();
    await page.waitForFunction(() => document.querySelector('[data-work-new]')?.disabled === true);
    assert.equal(await page.locator('.work-lane-actions button[aria-label^="新建"],.work-lane-actions button[aria-label^="New "]').count(), 0);
    await button('已归档', 'Archived', page.locator('.work-sidebar')).click();
    const archivedProject = await api(work + '/projects', 'POST', { id: id(), name: prefix + ' archived project' });
    await api(work + '/projects/' + archivedProject.id, 'PATCH', { expectedRevision: archivedProject.revision, archived: true });
    await openBoard(); await selectProject(archivedProject); assert(await button('新建事项', 'New item').isDisabled());
  });
  await check('first_page_creation_and_explicit_existing_item_location', async () => {
    const pagedProject = await api(work + '/projects', 'POST', { id: id(), name: prefix + ' paged' });
    const items = [];
    for (let n = 0; n < 35; n++) items.push(await api(work + '/items', 'POST', { id: id(), title: prefix + ' page ' + n, projectId: pagedProject.id }));
    await openBoard(); await selectProject(pagedProject); await createDraft(); await title().fill(prefix + ' first page');
    const item = await saveCreate(); await card(item.id).waitFor();
    assert.equal(await page.locator('.work-lane[data-work-status="todo"] .work-card').first().getAttribute('data-work-id'), item.id);
    await closeDetail();
    const after = await api(work + '/items?projectId=' + pagedProject.id + '&status=todo&limit=100');
    assert.deepEqual(after.items.map(row => row.id), [item.id, ...items.map(row => row.id)]);
    await page.goto(boardURL + '&item=' + items[34].id, { waitUntil: 'domcontentloaded' }); await detail().waitFor();
    await detail().getByRole('button', { name: /定位事项|Locate item|在看板中定位|Locate in board/ }).click();
    await card(items[34].id).waitFor(); await shot('02-locate-existing-item'); await closeDetail();
    await button('清除事项定位', 'Clear item focus').click();
    await button('列表', 'List', page.locator('.work-topbar')).click();
    await page.locator('.work-table').waitFor();
    await createDraft(); await title().fill(prefix + ' later-state list item');
    await label('状态', 'Status', detail()).click();
    await page.getByRole('option', { name: l('进行中', 'In progress'), exact: true }).click();
    const listed = await saveCreate(); assert.equal(listed.status, 'doing');
    await card(listed.id).waitFor();
    assert.equal(await page.locator('.work-shell').getAttribute('data-work-view'), 'list');
    assert.equal(await page.locator('.work-table tbody tr').count(), 1);
    assert(await page.locator('.work-focus-filter').isVisible());
    await closeDetail(); await button('清除事项定位', 'Clear item focus').click();
    await page.waitForFunction(() => document.querySelectorAll('.work-table tbody tr').length === 30);
  });
  await check('reference_create_route_is_replay_safe_and_discard_keeps_reference', async () => {
    const fromReference = origin + '/#/library?' + new URLSearchParams({ view: 'board', space: fixture.shared, new: '1', resourceKind: 'bookmark', resourceId: bookmark.id, title: bookmark.title });
    await page.goto(fromReference, { waitUntil: 'domcontentloaded' }); await detail().waitFor();
    await title().fill(prefix + ' changed reference draft'); await reloadBoard();
    await button('放弃修改', 'Discard changes', page.getByRole('dialog')).click();
    assert.equal(await title().inputValue(), bookmark.title);
    assert.equal(await detail().locator('.work-references a').filter({ hasText: bookmark.title }).count(), 1);
    const item = await saveCreate(); assert.deepEqual(item.bookmarkIds, [bookmark.id]); await card(item.id).waitFor();
    assert(!new URL(page.url()).hash.includes('new=1')); assert(new URL(page.url()).hash.includes('item=' + item.id));
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('[data-work-detail-id="' + item.id + '"]').waitFor();
    assert.equal(await button('创建事项', 'Create item', detail()).count(), 0);
    const matching = await api(work + '/items?q=' + encodeURIComponent(bookmark.title)); assert.equal(matching.items.filter(row => row.title === bookmark.title).length, 1);
    await closeDetail(); assert(!new URL(page.url()).hash.includes('item='));
  });
  await check('conflict_retains_actionable_error_and_draft', async () => {
    await page.goto(boardURL + '&item=' + seed.id, { waitUntil: 'domcontentloaded' }); await detail().waitFor();
    await title().fill(prefix + ' conflict draft');
    const remote = await api(work + '/items/' + seed.id);
    await api(work + '/items/' + seed.id, 'PATCH', { expectedRevision: remote.revision, nextStep: 'Concurrent owner edit' });
    await mutation(() => button('保存事项', 'Save item', detail()).click(), work + '/items/' + seed.id, 'PATCH', 409);
    await detail().locator('.work-conflict').waitFor();
    await page.waitForTimeout(7000);
    assert.equal(await title().inputValue(), prefix + ' conflict draft'); assert(await button('读取最新版本', 'Read latest version', detail()).isVisible());
    await shot('03-conflict-stays-actionable');
    await button('读取最新版本', 'Read latest version', detail()).click(); await button('使用最新版本', 'Use latest version', detail()).click(); await closeDetail();
  });
  await check('header_search_four_desktop_sizes', async () => {
    await openBoard(); await selectProject(projectA);
    for (const [width, height] of [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080]]) {
      await page.setViewportSize({ width, height });
      const geometry = await page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r && { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; };
        return { width: innerWidth, scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), header: rect('.work-topbar'), search: rect('.work-search'), title: rect('.work-context-heading'), actions: rect('.work-page-actions .work-view-toggle'), board: rect('.work-board'), controls: [...document.querySelectorAll('.work-topbar button,.work-topbar input')].filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return { x: r.x, right: r.right, bottom: r.bottom }; }) };
      });
      assert(geometry.scroll <= width + 1, 'No page horizontal overflow');
      assert(geometry.search.y >= geometry.header.y && geometry.search.bottom <= geometry.header.bottom + 1, 'Search is inside header');
      assert(geometry.title.right <= geometry.search.x + 1, 'Project title does not overlap search');
      assert(geometry.search.right <= geometry.actions.x + 1, 'Search does not overlap actions');
      for (const control of geometry.controls) assert(control.x >= -1 && control.right <= width + 1 && control.bottom <= geometry.header.bottom + 1, 'Header control fits');
      assert(geometry.board.y <= geometry.header.bottom + 28, 'No unused toolbar row above board');
      report.observations.push({ viewport: [width, height], geometry }); await shot('header-search-' + width + 'x' + height);
    }
  });
  assert.equal(report.errors.length, 0, 'Unhandled browser errors'); report.passed = true;
}
main().catch(async error => { report.failure = scrub(error.stack || error); console.error(report.failure); process.exitCode = 1; if (page) { try { await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' }); } catch {} } })
  .finally(async () => { if (browser) await browser.close(); fs.writeFileSync(path.join(output, 'work-context-report.json'), JSON.stringify(report, null, 2)); });
