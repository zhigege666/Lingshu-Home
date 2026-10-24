#!/usr/bin/env node
'use strict';
// Destructive fixture tests are limited to these two dedicated navigation instances.
// BASE_URL=http://10.233.233.61:5206 node tests/browser_navigation_workflow.cjs --allow-fixture-write
// LINGSHU_PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE may point to an installed browser.
// Never use production, copied user data or any other port. Existing fixtures must have the exact test site name.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
const base = new URL(process.env.BASE_URL || '');
assert.ok(process.argv.includes('--allow-fixture-write'), 'Explicit --allow-fixture-write is required');
assert.ok(['10.233.233.61', '127.0.0.1', 'localhost'].includes(base.hostname) && ['5206', '5207'].includes(base.port) && base.protocol === 'http:' && !base.username && !base.password, 'Only dedicated navigation fixture ports 5206/5207 are allowed');
const out = path.resolve(process.env.OUTPUT_DIR || path.join(require('node:os').tmpdir(), 'navigation-workflow-' + base.port));
fs.mkdirSync(out, { recursive: true });
const run = randomUUID().slice(0, 8), prefix = 'Navigation ' + run;
const report = { startedAt: new Date().toISOString(), origin: base.origin, run, checks: [], screenshots: [], expectedFailures: [], consoleErrors: [], pageErrors: [] };
let browser, context, page, boot, csrf, space, category, originalPage, active = 'preflight';
const writes = [];
const l = (zh, en) => boot.language === 'en' ? en : zh;
const button = (zh, en, scope = page) => scope.getByRole('button', { name: l(zh, en), exact: true });
const label = (zh, en, scope = page) => scope.getByLabel(l(zh, en), { exact: true });
const toolbar = () => page.locator('.lh-composer-toolbar');
const inspector = () => page.locator('.lh-composer-sidebar.is-inspector');
const undo = () => button('撤销', 'Undo', page.locator('.lh-composer'));
const redo = () => button('重做', 'Redo', page.locator('.lh-composer'));
async function api(method, relative, data, expected = 200) {
  const response = await context.request.fetch(base.origin + '/api/v1' + relative, { method, data, headers: { 'X-CSRF-TOKEN': csrf || '' }, maxRedirects: 0 });
  assert.equal(response.status(), expected, method + ' ' + relative + ': HTTP ' + response.status());
  return response.json();
}
const readNav = () => api('GET', '/spaces/' + space.id + '/navigation');
const readPage = () => api('GET', '/spaces/' + space.id + '/page');
const selectedRecords = async () => (await readNav()).data.links.filter(link => link.title.startsWith(prefix));
async function group(name, action) {
  active = name; console.log(JSON.stringify({ step: name }));
  const began = Date.now(); await action(); report.checks.push({ name, status: 'passed', durationMs: Date.now() - began });
}
async function settle() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function screenshot(name) {
  await settle(); const file = path.join(out, name + '.png'); await page.screenshot({ path: file, fullPage: false }); report.screenshots.push(file);
}
async function choose(control, name) { await control.click(); await page.getByRole('option', { name, exact: true }).click(); await settle(); }
async function goAdmin(tab = 'links') {
  await page.goto(base.origin + '/#/admin?tab=' + tab);
  await page.locator(tab === 'appearance' ? '.admin-layout-form' : '.admin-content-toolbar').waitFor();
  if (tab === 'links') await page.getByRole('button', { name: l('刷新列表', 'Refresh list'), exact: true }).waitFor();
}
async function filterLinks() {
  await label('搜索链接列表', 'Search links').fill(prefix);
  await page.locator('.admin-links-table tbody tr').first().waitFor();
}
async function selectAll() {
  await button('选择全部筛选结果（30）', 'Select all results (30)').click();
  await page.locator('.admin-selection-count').filter({ hasText: '30' }).waitFor();
}
async function applyDialog() {
  const response = page.waitForResponse(r => r.url().endsWith('/links/batch') && r.request().method() === 'POST');
  await page.getByRole('dialog').getByRole('button', { name: l('应用到 30 个链接', 'Apply to 30 links'), exact: true }).click();
  assert.equal((await response).status(), 200);
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('.admin-content-toolbar button[aria-label]')?.disabled === false);
}
async function home() { await page.goto(base.origin + '/#/'); await page.locator('.lh-home:not([data-composing])').waitFor(); }
async function enter() { await button('编辑页面', 'Edit page').click(); await page.locator('.lh-composer-sidebar.is-inspector').waitFor(); await settle(); }
async function blurToToolbar() { await toolbar().locator('strong').first().click(); }
async function saveHome() {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/spaces/' + space.id + '/page' && r.request().method() === 'PUT');
  await button('保存页面', 'Save page', toolbar()).click();
  assert.equal((await response).status(), 200);
  await page.locator('.lh-composer').waitFor({ state: 'hidden' });
}
async function checkGeometry(name) {
  await settle();
  const geometry = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    buttons: [...document.querySelectorAll('.lh-composer-toolbar button,.admin-layout-savebar button,.admin-bulk-toolbar button')].filter(e => e.getClientRects().length).map(e => {
      const r = e.getBoundingClientRect(); return { label: e.getAttribute('aria-label') || e.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    })
  }));
  assert.ok(geometry.scrollWidth <= geometry.width + 1, name + ': horizontal overflow');
  for (const item of geometry.buttons) assert.ok(item.x >= -1 && item.y >= -1 && item.right <= geometry.width + 1 && item.bottom <= geometry.height + 1, name + ': unreachable control ' + item.label);
  report.checks.push({ name, status: 'passed', geometry }); await screenshot(name);
}
async function main() {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'], ignoreDefaultArgs: ['--hide-scrollbars'] });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 });
  context.setDefaultTimeout(15000);
  boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken;
  const fixtureName = 'Navigation workflow fixture ' + boot.language;
  if (!boot.initialized) {
    await api('POST', '/setup', { siteName: fixtureName, mode: 'open_edit', seedDemo: false }, 201);
    boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken;
  }
  assert.equal(boot.siteName, fixtureName, 'Existing instance is not this test fixture');
  assert.equal(boot.mode, 'open_edit'); assert.equal(boot.user, null);
  await api('PUT', '/settings', { siteName: fixtureName, mode: 'open_edit', registrationEnabled: false, autoFetchIcons: false, autoSelectEndpoint: false });
  boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken; space = boot.spaces.find(item => item.kind === 'shared');
  assert.ok(space?.canEdit); originalPage = await readPage();
  const baselinePath=path.join(out,'baseline.json');
  if (fs.existsSync(baselinePath)) {
    const baseline=JSON.parse(fs.readFileSync(baselinePath,'utf8'));
    assert.equal(baseline.origin,base.origin);assert.equal(baseline.page.spaceId,space.id);
    originalPage=await api('PUT','/spaces/'+space.id+'/page',{name:baseline.page.name,config:baseline.page.config,expectedRevision:originalPage.revision});
  } else fs.writeFileSync(baselinePath,JSON.stringify({origin:base.origin,page:originalPage},null,2));
  category = await api('POST', '/spaces/' + space.id + '/categories', { name: 'Organized ' + run, icon: 'lucide:folder', parentId: null, sortOrder: 0 }, 201);
  page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ phase: active, text: message.text().slice(0,300) }); });
  page.on('request', request => {
    if (!['GET','HEAD','OPTIONS'].includes(request.method()) && new URL(request.url()).origin === base.origin) writes.push({ method: request.method(), pathname: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  await context.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.origin !== base.origin && !['data:','blob:'].includes(u.protocol)) return route.abort();
    await route.continue();
  });
  await group('bookmark HTML import previews folders and skips duplicate URLs', async () => {
    await goAdmin(); await button('导入','Import').click();
    const items = Array.from({ length: 30 }, (_, i) => '<DT><A HREF="https://example.invalid/' + run + '/' + i + '">' + prefix + ' ' + String(i + 1).padStart(2,'0') + '</A>').join('\n');
    const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8"><DL><p><DT><H3>Inbox ' + run + '</H3><DL><p>' + items + '\n<DT><A HREF="https://example.invalid/' + run + '/0">Duplicate</A></DL><p></DL><p>';
    await page.locator('input[type=file]').setInputFiles({ name: 'navigation-bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(html) });
    await button('预览文件','Preview file').click(); await page.locator('.admin-import-counts').waitFor();
    assert.match(await page.locator('.admin-import-counts').innerText(), /31/);
    const response = page.waitForResponse(r => r.url().endsWith('/bookmarks/import'));
    await button('确认导入','Import bookmarks').click();
    const result = await (await response).json(); assert.equal(result.imported,30); assert.equal(result.skipped,1);
    await page.getByRole('dialog').waitFor({ state:'hidden' }); await filterLinks();
    assert.equal((await selectedRecords()).length,30);
  });
  await group('page selection, mixed checkbox, cross-page selection and filter reset', async () => {
    await label('选择本页链接','Select links on this page').click();
    assert.equal(await page.locator('.admin-selection-count').innerText(),l('已选 25 个','25 selected'));
    await button('链接下一页','Links: next page').click();
    assert.equal(await page.locator('.admin-selection-count').innerText(),l('已选 25 个','25 selected'));
    await page.locator('.admin-links-table tbody [role=checkbox]').first().click();
    assert.equal(await label('选择本页链接','Select links on this page').getAttribute('aria-checked'),'mixed');
    assert.equal(await page.locator('.admin-selection-count').innerText(),l('已选 26 个','26 selected'));
    await selectAll(); await screenshot('selection-across-pages');
    await label('搜索链接列表','Search links').fill(prefix + ' 01');
    assert.equal(await page.locator('.admin-selection-count').innerText(),l('已选 0 个','0 selected'));
    await filterLinks();
  });
  await group('move all filtered links with explicit count; unrelated fields stay intact', async () => {
    const before = await selectedRecords(); await selectAll(); await button('移动分类','Move category').click();
    await choose(label('目标分类','Destination category'),category.name); await screenshot('batch-move-confirmation'); await applyDialog();
    const after = await selectedRecords();
    for (const link of after) {
      assert.equal(link.categoryId,category.id);
      const previous = before.find(item=>item.id===link.id);
      for (const key of ['title','url','description','icon','iconMode','tags','endpoints','sortOrder','isFavorite']) assert.deepEqual(link[key],previous[key],key+' preserved');
    }
    assert.equal(await page.locator('.admin-selection-count').innerText(),l('已选 0 个','0 selected'));
  });
  await group('add and remove tags and set favorites through the real dialog', async () => {
    await selectAll(); await button('维护标签','Edit tags').click(); await label('标签','Tags').fill('new, keep, new'); await applyDialog();
    for (const link of await selectedRecords()) assert.deepEqual(link.tags,['new','keep']);
    await selectAll(); await button('维护标签','Edit tags').click(); await choose(label('标签操作','Tag operation'),l('移除标签','Remove tags')); await label('标签','Tags').fill('new'); await applyDialog();
    for (const link of await selectedRecords()) assert.deepEqual(link.tags,['keep']);
    await selectAll(); await button('设置收藏','Set favorites').click(); await applyDialog();
    for (const link of await selectedRecords()) assert.equal(link.isFavorite,true);
  });
  await group('a stale selected snapshot returns 409 and requires an explicit reload', async () => {
    await selectAll(); await button('设置收藏','Set favorites').click(); await choose(label('收藏状态','Favorite status'),l('取消收藏','Remove from favorites'));
    const nav = await readNav();
    await api('POST','/spaces/'+space.id+'/links/batch',{ operation:'add-tags',expectedRevision:nav.revision,linkIds:(await selectedRecords()).map(link=>link.id),tags:['other-window'] });
    const pending=page.waitForResponse(r=>r.url().endsWith('/links/batch'));
    await button('应用到 30 个链接','Apply to 30 links',page.getByRole('dialog')).click(); assert.equal((await pending).status(),409);
    report.expectedFailures.push({ phase:active,status:409 });
    await button('刷新并重新选择','Refresh and select again').waitFor();
    for (const link of await selectedRecords()) assert.equal(link.isFavorite,true);
    await screenshot('stale-selection'); await button('刷新并重新选择','Refresh and select again').click();
    await page.getByRole('dialog').waitFor({ state:'hidden' });
    assert.equal(await page.locator('.admin-selection-count').innerText(),l('已选 0 个','0 selected'));
  });
  await group('four desktop viewports keep the batch toolbar and table usable', async () => {
    await selectAll();
    for (const viewport of [{width:2560,height:1440},{width:1920,height:1080},{width:1600,height:900},{width:2560,height:1080}]) {
      await page.setViewportSize(viewport); await checkGeometry('links-'+viewport.width+'x'+viewport.height);
    }
    await button('清除选择','Clear selection').click(); await page.setViewportSize({width:2560,height:1440});
  });
  await group('home undo and redo are draft-only and branch after a new edit', async () => {
    await home(); await enter();
    assert.equal(await undo().isDisabled(),true); assert.equal(await redo().isDisabled(),true);
    const original = await readPage(), count=writes.length;
    await choose(label('内容密度','Content density',inspector()),l('紧凑','Compact'));
    assert.equal(await page.locator('.lh-composer-canvas > .lh-home').getAttribute('data-density'),'compact');
    await undo().click(); assert.equal(await page.locator('.lh-composer-canvas > .lh-home').getAttribute('data-density'),original.config.appearance.density);
    await redo().click(); assert.equal(await page.locator('.lh-composer-canvas > .lh-home').getAttribute('data-density'),'compact');
    await blurToToolbar(); await page.keyboard.press('Control+z'); assert.equal(await page.locator('.lh-composer-canvas > .lh-home').getAttribute('data-density'),original.config.appearance.density);
    await choose(label('组件间距','Component spacing',inspector()),'24 px');
    assert.equal(await redo().isDisabled(),true); assert.equal(writes.length,count); assert.deepEqual(await readPage(),original);
    await undo().click(); assert.equal(await button('保存页面','Save page',toolbar()).isDisabled(),true);
  });
  await group('adding a panel and a single resize each undo as one step', async () => {
    const layer=page.locator('.lh-composer-sidebar.is-library [data-composer-layer]');
    const before=await layer.count();
    await button('组件与页面结构','Components and layers',toolbar()).click();
    await page.locator('.lh-composer-library-items').getByRole('button',{name:l('常用收藏','Favorites'),exact:true}).click();
    assert.equal(await layer.count(),before+1); await undo().click(); assert.equal(await layer.count(),before); await redo().click(); assert.equal(await layer.count(),before+1);
    await undo().click(); assert.equal(await button('保存页面','Save page',toolbar()).isDisabled(),true);
    const frame=page.locator('.lh-home-grid .react-grid-item').filter({has:page.locator('.lh-grid-frame')}).last();
    const handle=frame.locator('.react-resizable-handle').last();
    await handle.scrollIntoViewIfNeeded(); const box=await handle.boundingBox(); assert.ok(box);
    const beforeRect=await frame.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down(); await page.mouse.move(box.x-100,box.y+80,{steps:8});
    await page.keyboard.press('Control+z'); assert.equal(await undo().isDisabled(),true);
    await page.mouse.up(); await settle(); assert.equal(await undo().isEnabled(),true);
    const afterRect=await frame.boundingBox(); assert.ok(Math.abs(afterRect.width-beforeRect.width)>20||Math.abs(afterRect.height-beforeRect.height)>20,'resize changed footprint');
    await undo().click(); await settle(); const restored=await frame.boundingBox(); assert.ok(Math.abs(restored.width-beforeRect.width)<2,'one undo restores width');
    assert.equal(await button('保存页面','Save page',toolbar()).isDisabled(),true); await redo().click(); await settle();
    await saveHome(); const saved=await readPage(); await page.reload(); await page.locator('.lh-home').waitFor(); assert.deepEqual((await readPage()).config,saved.config);
  });
  await group('preview, native input undo and four editor desktop viewports', async () => {
    await enter(); await choose(label('组件间距','Component spacing',inspector()),'12 px');
    await button('预览','Preview',toolbar()).click(); assert.equal(await undo().isDisabled(),true); await page.keyboard.press('Control+z'); await button('继续编辑','Keep editing',toolbar()).click();
    assert.match(await label('组件间距','Component spacing',inspector()).innerText(),/12/);
    for (const viewport of [{width:2560,height:1440},{width:1920,height:1080},{width:1600,height:900},{width:2560,height:1080}]) {
      await page.setViewportSize(viewport); await checkGeometry('composer-'+viewport.width+'x'+viewport.height);
    }
    await page.setViewportSize({width:2560,height:1440}); await undo().click();
    await button('取消','Cancel',toolbar()).click(); await page.locator('.lh-composer').waitFor({state:'hidden'});
  });
  await group('admin editor history includes name, appearance and native text undo', async () => {
    await goAdmin('appearance'); const form=page.locator('.admin-layout-form'), original=await readPage(), count=writes.length;
    const name=label('页面名称','Page name',form);
    await name.fill('Workflow '+run); await choose(label('组件间距','Panel spacing',form),'24 px');
    await button('撤销','Undo',form).click(); assert.equal(await name.inputValue(),'Workflow '+run);
    await button('撤销','Undo',form).click(); assert.equal(await name.inputValue(),original.name);
    await button('重做','Redo',form).click(); assert.equal(await name.inputValue(),'Workflow '+run);
    await name.focus(); await name.press('End'); await name.pressSequentially(' abc'); await name.press('Control+z');
    assert.equal(await name.inputValue(),'Workflow '+run,'text input retains native undo');
    assert.equal(await button('重做','Redo',form).isDisabled(),true,'typing starts a new draft branch');
    await choose(label('组件间距','Panel spacing',form),'24 px');
    assert.equal(writes.length,count);
    for (const viewport of [{width:2560,height:1440},{width:1920,height:1080},{width:1600,height:900},{width:2560,height:1080}]) {
      await page.setViewportSize(viewport); await checkGeometry('admin-editor-'+viewport.width+'x'+viewport.height);
    }
    await page.setViewportSize({width:2560,height:1440});
    const pending=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname.endsWith('/page'));
    await button('保存页面','Save page',form).click(); assert.equal((await pending).status(),200);
    await page.waitForFunction(()=>document.querySelector('.admin-layout-savebar button[type=submit]')?.disabled===true);
    assert.equal(await button('撤销','Undo',form).isDisabled(),true);
    const saved=await readPage();await page.reload();await page.locator('.admin-layout-form').waitFor();assert.equal(await label('页面名称','Page name').inputValue(),saved.name);assert.deepEqual((await readPage()).config,saved.config);
  });
  await group('home failed save and real version conflict retain recoverable draft history', async () => {
    await home(); await enter(); const before=await readPage();
    const target=before.config.appearance.density==='compact'?'comfortable':'compact';
    await choose(label('内容密度','Content density',inspector()),target==='compact'?l('紧凑','Compact'):l('舒适','Comfortable'));
    const pageURL=base.origin+'/api/v1/spaces/'+space.id+'/page';
    const reject=async route=>route.request().method()==='PUT'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'test_failure',message:'Injected temporary failure'})}):route.continue();
    await page.route(pageURL,reject);
    let pending=page.waitForResponse(r=>r.url()===pageURL&&r.request().method()==='PUT');
    await button('保存页面','Save page',toolbar()).click();assert.equal((await pending).status(),503);report.expectedFailures.push({phase:active,status:503});
    await page.getByRole('alert').filter({hasText:'Injected temporary failure'}).waitFor();
    assert.equal(await undo().isEnabled(),true);assert.equal(await button('保存页面','Save page',toolbar()).isEnabled(),true);assert.deepEqual(await readPage(),before);
    await page.unroute(pageURL,reject);
    const changed=await api('PUT','/spaces/'+space.id+'/page',{name:'Other window '+run,config:before.config,expectedRevision:before.revision});
    pending=page.waitForResponse(r=>r.url()===pageURL&&r.request().method()==='PUT');
    await button('保存页面','Save page',toolbar()).click();assert.equal((await pending).status(),409);report.expectedFailures.push({phase:active,status:409});
    await page.getByRole('alert').filter({hasText:l('页面已在其他窗口修改','The page changed in another window')}).waitFor();
    assert.equal(await undo().isEnabled(),true);assert.deepEqual(await readPage(),changed);await screenshot('home-save-conflict');
    await undo().click();
    let releaseRead;const readGate=new Promise(resolve=>{releaseRead=resolve});
    const delayRead=async route=>{await readGate;await route.continue()};
    await page.route('**/api/v1/dashboard*',delayRead);
    const readStarted=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/v1/dashboard');
    await button('取消','Cancel',toolbar()).click();await readStarted;await page.locator('.lh-composer').waitFor({state:'hidden'});
    assert.equal(await button('编辑页面','Edit page').isDisabled(),true,'cancel readback blocks immediate editor re-entry');
    const readComplete=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/dashboard');
    releaseRead();assert.equal((await readComplete).status(),200);await page.unroute('**/api/v1/dashboard*',delayRead);
  });
  await group('home saved response plus failed read resets history and retains the new revision', async () => {
    await enter();const before=await readPage();
    const target=before.config.appearance.density==='compact'?'comfortable':'compact';
    await choose(label('内容密度','Content density',inspector()),target==='compact'?l('紧凑','Compact'):l('舒适','Comfortable'));
    const pageURL=base.origin+'/api/v1/spaces/'+space.id+'/page';let block=false;
    const commit=async route=>{if(route.request().method()!=='PUT')return route.continue();const response=await route.fetch();block=response.ok();await route.fulfill({response})};
    const rejectRead=async route=>block?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'test_reload_failure',message:'Injected read failure'})}):route.continue();
    await page.route(pageURL,commit);await page.route('**/api/v1/dashboard*',rejectRead);
    await button('保存页面','Save page',toolbar()).click();
    await page.getByRole('alert').filter({hasText:l('布局已经保存，但重新加载失败','The layout was saved, but reloading failed')}).waitFor();
    report.expectedFailures.push({phase:active,status:503});
    const saved=await readPage();assert.equal(saved.config.appearance.density,target);assert.notEqual(saved.revision,before.revision);
    assert.equal(await undo().isDisabled(),true);assert.equal(await redo().isDisabled(),true);assert.equal(await button('保存页面','Save page',toolbar()).isDisabled(),true);
    await screenshot('home-saved-read-failed');
    await page.unroute(pageURL,commit);await page.unroute('**/api/v1/dashboard*',rejectRead);
    await choose(label('内容密度','Content density',inspector()),target==='compact'?l('舒适','Comfortable'):l('紧凑','Compact'));
    await saveHome();const again=await readPage();assert.equal(Number(again.revision),Number(saved.revision)+1);
  });
  await group('admin saved response plus failed read keeps a clean baseline and next save succeeds', async () => {
    await goAdmin('appearance');const form=page.locator('.admin-layout-form'),before=await readPage();
    await label('页面名称','Page name',form).fill('Read failure '+run);
    const pageURL=base.origin+'/api/v1/spaces/'+space.id+'/page';let block=false;
    const commit=async route=>{if(route.request().method()!=='PUT')return route.continue();const response=await route.fetch();block=response.ok();await route.fulfill({response})};
    const rejectRead=async route=>block?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'test_reload_failure',message:'Injected read failure'})}):route.continue();
    await page.route(pageURL,commit);await page.route('**/api/v1/dashboard*',rejectRead);
    await button('保存页面','Save page',form).click();
    await form.getByRole('alert').filter({hasText:l('页面已经保存，但重新加载失败','The page was saved, but reloading failed')}).waitFor();report.expectedFailures.push({phase:active,status:503});
    const saved=await readPage();assert.equal(saved.name,'Read failure '+run);assert.notEqual(saved.revision,before.revision);
    assert.equal(await button('撤销','Undo',form).isDisabled(),true);assert.equal(await button('保存页面','Save page',form).isDisabled(),true);
    assert.equal(await form.locator('.admin-draft-status').innerText(),l('已保存','Saved'));await screenshot('admin-saved-read-failed');
    await page.unroute(pageURL,commit);await page.unroute('**/api/v1/dashboard*',rejectRead);
    await label('页面名称','Page name',form).fill('Navigation workflow '+run);
    const pending=page.waitForResponse(r=>r.url()===pageURL&&r.request().method()==='PUT');
    await button('保存页面','Save page',form).click();assert.equal((await pending).status(),200);
    await page.waitForFunction(()=>document.querySelector('.admin-layout-savebar button[type=submit]')?.disabled===true);
    const again=await readPage();assert.equal(Number(again.revision),Number(saved.revision)+1);
    await page.reload();await page.locator('.admin-layout-form').waitFor();assert.equal(await label('页面名称','Page name').inputValue(),again.name);
  });
  assert.deepEqual(report.pageErrors,[]);
  const unexpected=report.consoleErrors.filter(item=>!report.expectedFailures.some(failure=>failure.phase===item.phase&&item.text.includes(String(failure.status))));
  assert.deepEqual(unexpected,[]);
  report.status='passed';
}
main().catch(async error=>{
  report.status='failed';report.failure={phase:active,message:error.stack};
  if(page) {try{await screenshot('failure');report.visibleText=(await page.locator('body').innerText()).slice(0,10000)}catch{}}
  process.exitCode=1;
}).finally(async()=>{
  report.finishedAt=new Date().toISOString();report.uiWrites=writes.map(({method,pathname})=>({method,pathname}));
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,checks:report.checks.length,failure:report.failure,report:path.join(out,'report.json')}));
  if(browser)await browser.close();
});
