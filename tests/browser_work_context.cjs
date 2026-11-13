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
  await check('module_navigation_consistency_four_sizes', async () => {
    await closeDetail();
    const routes = [
      ['home', '/#/', '.lh-home', '.lh-brand'],
      ['library', '/#/library?space=' + fixture.shared, '.library-shell', '.library-brand'],
      ['work', '/#/library?view=board&space=' + fixture.shared, '.work-shell', '.work-brand'],
      ['admin', '/#/admin?tab=access', '.admin-shell', '.admin-brand'],
    ];
    for (const [width, height] of [[2560,1440],[1920,1080],[1600,900],[2560,1080]]) {
      await page.setViewportSize({ width, height });
      for (const [name, route, shell, brand] of routes) {
        await page.goto(origin + route, { waitUntil: 'domcontentloaded' }); await page.locator(shell).waitFor();
        const nav = page.locator('nav.lh-module-nav'); await nav.waitFor();
        assert.equal(await nav.count(), 1, name + ' has one module navigation');
        assert.deepEqual(await nav.locator(':scope > a > span,:scope > span > span').allTextContents(), [l('导航','Home'),l('资料库','Library'),l('事项','Work')]);
        const geometry = await page.evaluate(brand => {
          const rect = e => { const r = e.getBoundingClientRect(); return { left:r.left,right:r.right,top:r.top,bottom:r.bottom }; };
          const nav = document.querySelector('nav.lh-module-nav'), header = nav.closest('header');
          return { nav:rect(nav), brand:rect(document.querySelector(brand)), header:rect(header), width:innerWidth, scrollWidth:Math.max(document.body.scrollWidth,document.documentElement.scrollWidth) };
        }, brand);
        assert(geometry.brand.right <= geometry.nav.left + 1, name + ' modules follow brand on the left');
        assert(geometry.nav.right < width / 2 && geometry.nav.top >= geometry.header.top - 1 && geometry.nav.bottom <= geometry.header.bottom + 1, name + ' module nav stays in left half of header');
        assert(geometry.scrollWidth <= width + 1, name + ' has no page horizontal overflow');
        report.observations.push({ name:'modules-' + name, viewport:[width,height], geometry });
        await shot('modules-' + name + '-' + width + 'x' + height);
      }
    }
  });
  await check('module_switches_preserve_data_and_block_disabled_routes', async () => {
    await page.setViewportSize({ width:2560,height:1440 });
    assert.deepEqual((await boot()).modules, { documents:true,work:true }, 'Existing installations enable both modules by default');
    const source = await api(space + '/document-sources', 'POST', { name:prefix + ' module notes', path:fixture.documentRoot, readOnly:true, defaultWrite:false, defaultFolder:'', scanIntervalSeconds:0 }, 201);
    await api(space + '/document-sources/' + source.id + '/scan', 'POST', {});
    const document = (await api(space + '/documents?sourceId=' + source.id)).items.find(x => x.relativePath === 'plan.md');
    assert(document, 'Owned document fixture exists');
    let linked = await api(work + '/items', 'POST', { id:id(),title:prefix + ' retained links',projectId:projectA.id,bookmarkIds:[bookmark.id],documentIds:[document.id] });
    async function settingsUI(modules) {
      await page.goto(origin + '/#/admin?tab=access', { waitUntil:'domcontentloaded' });
      const library = label('启用资料库','Enable library'), items = label('启用事项','Enable work');
      await library.waitFor();
      await library.setChecked(modules.documents); await items.setChecked(modules.work);
      const saved = await mutation(() => button('保存访问设置','Save access settings').click(), '/settings', 'PUT');
      assert.deepEqual(saved.modules, modules);
      await page.waitForFunction(expected => document.querySelectorAll('nav.lh-module-nav > *').length === expected, 1 + Number(modules.documents) + Number(modules.work));
      assert.deepEqual((await boot()).modules, modules);
    }
    await settingsUI({ documents:false,work:true }); await shot('modules-documents-off');
    const docsDenied = await api(space + '/documents?sourceId=' + source.id, 'GET', undefined, 403);
    assert.equal(docsDenied.code,'module_disabled');
    await page.goto(origin + '/#/library?space=' + fixture.shared + '&document=' + document.id, { waitUntil:'domcontentloaded' });
    await page.locator('.app-module-disabled[data-disabled-module="documents"]').waitFor();
    await button('返回导航','Return to navigation').click(); await page.locator('.lh-home').waitFor();
    await page.goto(boardURL + '&item=' + linked.id, { waitUntil:'domcontentloaded' }); await detail().waitFor();
    await title().fill(prefix + ' edited with documents off');
    const editBody = page.waitForRequest(r => new URL(r.url()).pathname === '/api/v1' + work + '/items/' + linked.id && r.method() === 'PATCH');
    linked = await mutation(() => button('保存事项','Save item',detail()).click(), work + '/items/' + linked.id, 'PATCH');
    assert(!Object.hasOwn((await editBody).postDataJSON(),'documentIds'),'Disabled document module must not clear hidden document references');
    await closeDetail(); await createDraft(); await title().fill(prefix + ' create while documents off');
    const createBody = page.waitForRequest(r => new URL(r.url()).pathname === '/api/v1' + work + '/items' && r.method() === 'POST');
    const created = await saveCreate(); assert(!Object.hasOwn((await createBody).postDataJSON(),'documentIds')); await card(created.id).waitFor(); await closeDetail();
    await settingsUI({ documents:false,work:false });
    assert.equal((await api(work + '/items/' + linked.id, 'GET', undefined, 403)).code,'module_disabled');
    await page.goto(boardURL + '&item=' + linked.id, { waitUntil:'domcontentloaded' }); await page.locator('.app-module-disabled[data-disabled-module="work"]').waitFor();
    await shot('modules-all-off-deep-link');
    await button('返回导航','Return to navigation').click(); await page.locator('.lh-home').waitFor();
    assert.equal(await page.locator('nav.lh-module-nav > *').count(),1);
    const navigation = await api(space + '/navigation');
    assert(navigation.data.links.some(row => row.id === bookmark.id), 'Navigation remains available with both optional modules off');
    await settingsUI({ documents:true,work:true });
    const restored = await api(work + '/items/' + linked.id);
    assert.deepEqual(restored.documentIds,[document.id]); assert.deepEqual(restored.bookmarkIds,[bookmark.id]);
    assert.equal(restored.title,prefix + ' edited with documents off');
    assert.equal((await api(space + '/documents/' + document.id)).id,document.id);
    await page.goto(boardURL + '&item=' + linked.id, { waitUntil:'domcontentloaded' }); await detail().waitFor();
    await detail().locator('.work-references').getByText(document.title,{exact:true}).waitFor(); await closeDetail();
  });
  await check('module_navigation_and_shutdown_preserve_unsaved_drafts', async () => {
    // The wide layout keeps navigation interactive beside the editor; narrower layouts use a modal drawer.
    await page.setViewportSize({width:2560,height:1440}); await openBoard(); await createDraft();
    await title().fill(prefix + ' navigation draft');
    const homeLink = () => page.locator('nav.lh-module-nav').getByRole('link',{name:l('导航','Home'),exact:true});
    await homeLink().click(); await button('继续编辑','Keep editing',page.getByRole('dialog')).click();
    assert.equal(await title().inputValue(),prefix + ' navigation draft');
    await homeLink().click(); await button('放弃修改','Discard changes',page.getByRole('dialog')).click();
    await page.locator('.lh-home').waitFor(); assert.equal(await page.getByRole('dialog').count(),0,'One discard decision completes navigation');
    await page.goto(boardURL + '&item=' + seed.id,{waitUntil:'domcontentloaded'}); await detail().waitFor();
    const intended = prefix + ' retained after module shutdown'; await title().fill(intended);
    const settings = await api('/settings');
    const setWork = workEnabled => api('/settings','PUT',{siteName:settings.siteName,mode:settings.mode,registrationEnabled:settings.registrationEnabled,modules:{work:workEnabled}});
    await setWork(false);
    const rejected = await mutation(()=>button('保存事项','Save item',detail()).click(),work + '/items/' + seed.id,'PATCH',403);
    assert.equal(rejected.code,'module_disabled'); assert.equal(await title().inputValue(),intended);
    assert.equal(await detail().locator('.work-conflict').count(),0,'A definite module rejection is not an unknown write result');
    await detail().locator('.admin-error').filter({hasText:l('草稿已保留','draft')}).waitFor(); await shot('work-draft-retained-module-disabled');
    await setWork(true);
    const saved = await mutation(()=>button('保存事项','Save item',detail()).click(),work + '/items/' + seed.id,'PATCH');
    assert.equal(saved.title,intended); await closeDetail();
  });
  await check('work_activity_timestamps_pagination_and_live_update', async () => {
    const itemId = id();
    let item = await api(work + '/items','POST',{id:itemId,title:prefix + ' activity',projectId:projectA.id});
    for (let n=0;n<23;n++) item = await api(work + '/items/' + itemId,'PATCH',{expectedRevision:item.revision,result:'Verified milestone ' + (n+1)});
    const expected = await api(work + '/items/' + itemId + '/activity?limit=100');
    assert.equal(expected.items.length,24); assert.equal(expected.historyComplete,true);
    await page.goto(boardURL + '&item=' + itemId,{waitUntil:'domcontentloaded'}); await detail().waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.work-activity [data-work-activity-id]').length === 20);
    // Opening another detail keeps the current board snapshot; explicitly locate this API-created item.
    await detail().getByRole('button',{name:l('定位事项','Locate item'),exact:true}).click();
    await card(itemId).waitFor();
    assert.equal(await card(itemId).locator('time.work-updated-time').getAttribute('datetime'),item.updatedAt);
    assert.deepEqual(await detail().locator('.work-activity [data-work-activity-id]').evaluateAll(nodes=>nodes.map(n=>n.dataset.workActivityId)),expected.items.slice(0,20).map(e=>e.id));
    await detail().locator('.work-activity-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.work-activity [data-work-activity-id]').length === 24);
    const rendered = await detail().locator('.work-activity [data-work-activity-id] time').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('datetime')));
    assert.deepEqual(rendered,expected.items.map(e=>e.occurredAt));
    await shot('work-activity-real-history');
    await label('下一步','Next step',detail()).fill('Review the recorded timeline');
    item = await mutation(()=>button('保存事项','Save item',detail()).click(),work + '/items/' + itemId,'PATCH');
    const latest = await api(work + '/items/' + itemId + '/activity?limit=1');
    await detail().locator('[data-work-activity-id="' + latest.items[0].id + '"]').waitFor();
    assert.equal(latest.items[0].itemRevision,item.revision);
    for (const [width,height] of [[2560,1440],[1920,1080],[1600,900],[2560,1080]]) {
      await page.setViewportSize({width,height});
      await detail().locator('.work-activity').scrollIntoViewIfNeeded();
      const geometry = await detail().evaluate(el=>{
        const body=el.querySelector('.work-detail-body'),footer=el.querySelector('.work-detail-footer'),r=el.getBoundingClientRect(),f=footer.getBoundingClientRect();
        return {left:r.left,right:r.right,bottom:r.bottom,footerBottom:f.bottom,footerTop:f.top,width:innerWidth,height:innerHeight,bodyWidth:body.clientWidth,bodyScrollWidth:body.scrollWidth};
      });
      assert(geometry.left>=0 && geometry.right<=width+1 && geometry.bottom<=height+1 && Math.abs(geometry.footerBottom-geometry.bottom)<=1,'Timeline detail and save footer fit viewport');
      assert(geometry.bodyScrollWidth<=geometry.bodyWidth+1,'Timeline does not overflow horizontally');
      await shot('work-activity-' + width + 'x' + height);
    }
    await closeDetail(); await button('列表','List',page.locator('.work-topbar')).click();
    await page.locator('.work-table').waitFor();
    assert.equal(await card(itemId).locator('time.work-updated-time').getAttribute('datetime'),item.updatedAt);
    await button('看板','Board',page.locator('.work-topbar')).click();
  });
  assert.equal(report.errors.length, 0, 'Unhandled browser errors'); report.passed = true;
}
main().catch(async error => { report.failure = scrub(error.stack || error); console.error(report.failure); process.exitCode = 1; if (page) { try { await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' }); } catch {} } })
  .finally(async () => { if (browser) await browser.close(); fs.writeFileSync(path.join(output, 'work-context-report.json'), JSON.stringify(report, null, 2)); });
