#!/usr/bin/env node
'use strict';
// Only owned disposable loopback fixtures. This suite creates its own work data.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'Owned fixture and output are required');
const provider = process.env.UI_PROVIDER || 'sqlite', fixture = JSON.parse(fs.readFileSync(process.env.UI_FIXTURES, 'utf8'))[provider];
const base = new URL(fixture.url), output = path.resolve(process.env.OUTPUT_DIR);
assert(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname) && !base.username && !base.password, 'Only disposable loopback fixtures');
const origin = base.origin, work = '/spaces/' + fixture.shared + '/work', id = () => crypto.randomBytes(16).toString('hex');
const prefix = 'Navigation-' + id().slice(0, 6), secrets = [fixture.username, fixture.password].filter(Boolean);
const scrub = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));
const report = { passed:false, phase:process.env.UI_BASELINE === '1' ? 'baseline' : 'candidate', checks:[], skipped:[], screenshots:[], errors:[], observations:[], startedAt:new Date().toISOString() };
let browser, context, page, language, initial, project, otherProject, savedView;
const records = {}, responses = [], requests = [];
const t = (zh, en) => language === 'en' ? en : zh;
const button = (zh, en, scope = page) => scope.getByRole('button', { name:t(zh, en), exact:true });
const side = () => page.locator('.work-sidebar');
const quick = (zh, en) => button(zh, en, page.locator('.work-quick-filters'));
const boardURL = () => origin + '/#/library?view=board&space=' + fixture.shared;
const ids = names => names.map(name => records[name].id).sort();
const all = () => Object.keys(records).filter(name => name !== 'archived');
const filterKeys = ['projectId','attention','date','blocked','assigneeUserId','priority','status','itemId','businessDate','versionId','parentId','labelIds'];
async function boot() { const response = await context.request.get(origin + '/api/v1/bootstrap'); assert(response.ok()); return response.json(); }
async function api(suffix, method = 'GET', data, expected = 200) {
  const state = await boot(), response = await context.request.fetch(origin + '/api/v1' + suffix, {method,data,headers:{Origin:origin,'X-CSRF-TOKEN':state.csrfToken},maxRedirects:0});
  assert.equal(response.status(), expected, method + ' ' + suffix + ': ' + scrub(await response.text()));
  return response.status() === 204 ? null : response.json();
}
async function check(name, run) {
  if (process.env.UI_CHECK_MATCH && !new RegExp(process.env.UI_CHECK_MATCH).test(name)) { report.skipped.push(name); return; }
  const start = Date.now();
  try { await run(); report.checks.push({name,passed:true,ms:Date.now()-start}); console.log('PASS ' + name); }
  catch (error) { report.checks.push({name,passed:false,error:scrub(error.message)}); throw error; }
}
async function until(read, accept, timeout = 12000) {
  const end = Date.now() + timeout; let value;
  do { value = await read(); if (accept(value)) return value; await page.waitForTimeout(75); } while (Date.now() < end);
  throw new Error('Timed out waiting for actual state: ' + scrub(JSON.stringify(value)));
}
async function renderedIDs() { return (await page.locator('.work-board [data-work-id],.work-table [data-work-id]').evaluateAll(rows => rows.map(row => row.dataset.workId))).sort(); }
async function expectRows(names) { const expected = ids(names); await until(renderedIDs, value => JSON.stringify(value) === JSON.stringify(expected)); }
async function snapshot() {
  return page.evaluate(() => ({
    active:[...document.querySelectorAll('.work-quick-filters>button.active,.work-projects>div.active,.work-sidebar>footer>button.active,.work-saved-view-nav.active')].map(el => el.textContent.trim()),
    current:[...document.querySelectorAll('.work-sidebar [aria-current="page"]')].map(el => el.textContent.trim()),
    title:document.querySelector('.work-context-heading h1')?.textContent.trim(),
    ids:[...document.querySelectorAll('.work-board [data-work-id],.work-table [data-work-id]')].map(el => el.dataset.workId).sort(),
    hash:location.hash
  }));
}
async function expectSelection(label, title = label) {
  const value = await snapshot(), expected = label ? [label] : [];
  assert.deepEqual(value.active, expected, 'Only the actual navigation scope is highlighted');
  assert.deepEqual(value.current, expected, 'Current page semantics match the highlighted scope');
  assert.equal(value.title, title);
}
function assertQuery(query, expected = {}) {
  const params = new URLSearchParams(query), actual = {};
  for (const key of filterKeys) if (params.has(key) && !['false',''].includes(params.get(key))) actual[key] = params.get(key);
  if (params.get('archived') === 'true') actual.archived = 'true';
  assert.deepEqual(actual, Object.fromEntries(Object.entries(expected).map(([key,value]) => [key,String(value)])), 'Actual query contains only the intended scope');
}
async function expectScope(label, names, filters = {}, title = label) {
  await expectRows(names); await expectSelection(label, title);
  const response = responses.filter(row => ['/api/v1'+work+'/board','/api/v1'+work+'/items'].includes(row.path)).at(-1);
  assert(response, 'A real work response was observed'); assertQuery(response.query, filters);
  assertQuery(new URL(page.url()).hash.split('?')[1], filters);
}
async function openBoard(query = '') {
  await page.goto('about:blank'); await page.goto(boardURL() + query, {waitUntil:'domcontentloaded'}); await page.locator('.work-board').waitFor();
}
async function shot(name) {
  const filename = 'navigation-' + provider + '-' + (language || 'unknown') + '-' + name + '.png';
  await page.screenshot({path:path.join(output,filename),animations:'disabled'}); report.screenshots.push(filename);
}
async function create(name, fields = {}) {
  records[name] = await api(work + '/items','POST',{requestId:id(),title:prefix+' '+name,...fields});
  return records[name];
}
async function theme(value) {
  if (await page.locator('.work-shell').getAttribute('data-theme') === value) return;
  await page.locator('.home-account-trigger').click();
  await page.getByRole('menuitemcheckbox',{name:t('切换深浅色','Toggle light or dark'),exact:true}).click();
  await page.keyboard.press('Escape');
  await until(() => page.locator('.work-shell').getAttribute('data-theme'), current => current === value);
}
async function main() {
  fs.mkdirSync(output,{recursive:true});
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  report.browser = browser.version();
  context = await browser.newContext({viewport:{width:2560,height:1440},locale:'zh-CN',timezoneId:'Asia/Shanghai',reducedMotion:'reduce'});
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror',error => report.errors.push(scrub(error.message)));
  page.on('request',request => {const url=new URL(request.url()); if(url.pathname.startsWith('/api/v1')) requests.push({method:request.method(),path:url.pathname,query:url.search});});
  page.on('response',response => {const url=new URL(response.url()); if(url.pathname.startsWith('/api/v1') && response.request().method()==='GET') responses.push({path:url.pathname,query:url.search,status:response.status()});});
  await api('/auth/login','POST',{username:fixture.username,password:fixture.password,sessionMode:'temporary'});
  initial = await boot(); assert.equal(initial.siteName,'Release UI fixture '+provider,'Owned fixture guard'); language = initial.language;
  const empty = await api(work+'/items'); assert.equal(empty.total,0,'Use a fresh fixture without existing work');
  const catalog = await api(work+'/statuses'), owner = initial.user;
  project = await api(work+'/projects','POST',{id:id(),name:prefix+' Alpha'});
  otherProject = await api(work+'/projects','POST',{id:id(),name:prefix+' Beta'});
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  await create('blocker',{projectId:otherProject.id});
  await create('attention',{projectId:project.id,needsAttention:true,businessDate:today,assignee:{name:owner.displayName||owner.username,userId:owner.id}});
  await create('blocked',{projectId:otherProject.id});
  await create('both',{projectId:project.id,needsAttention:true});
  await create('normal',{projectId:project.id,businessDate:today});
  await create('overdue',{projectId:otherProject.id,dueAt:new Date(Date.now()-86400000).toISOString()});
  await create('archived',{projectId:project.id,needsAttention:true});
  for (const name of ['blocked','both']) records[name] = await api(work+'/items/'+records[name].id+'/relations','PATCH',{expectedRevision:records[name].revision,blockedByIds:[records.blocker.id]});
  records.archived = await api(work+'/items/'+records.archived.id,'PATCH',{expectedRevision:records.archived.revision,archived:true});
  savedView = await api(work+'/views','POST',{id:id(),name:prefix+' attention in Alpha',visibility:'private',definition:{layout:'board',filters:{projectId:project.id,attention:true},fields:['id','project','relations']}});
  const attention = t('待我处理','Needs my attention'), blocked = t('有阻塞','Blocked'), allLabel = t('全部事项','All items');

  await check('UX-NAV-001 blocked_to_attention_clears_previous_scope',async()=>{
    await openBoard(); await quick('有阻塞','Blocked').click(); await expectRows(['blocked','both']);
    const waiting = page.waitForResponse(response => response.url().includes('/api/v1'+work+'/board?') && new URL(response.url()).searchParams.get('attention') === 'true');
    await quick('待我处理','Needs my attention').click(); await waiting; await page.locator('.work-board').waitFor();
    const actual = await snapshot(); report.observations.push({name:'original-reproduction',...actual}); await shot('blocked-to-attention');
    assert.deepEqual(actual.active,[attention],'Switching Blocked → Needs my attention must not keep both highlighted');
    await expectScope(attention,['attention','both'],{attention:true});
    await quick('有阻塞','Blocked').click(); await expectScope(blocked,['blocked','both'],{blocked:true});
    await quick('全部事项','All items').click(); await expectScope(allLabel,all());
  });
  await check('UX-NAV-002 shortcuts_are_idempotent_and_reset_other_scopes',async()=>{
    await openBoard();
    for(const [zh,en,names,filters] of [
      ['待我处理','Needs my attention',['attention','both'],{attention:true}],
      ['我负责的','Assigned to me',['attention'],{assigneeUserId:'me'}],
      ['今日事项','Today',['attention','normal'],{date:'today'}],
      ['逾期事项','Overdue',['overdue'],{date:'overdue'}],
      ['有阻塞','Blocked',['blocked','both'],{blocked:true}],
      ['待我处理','Needs my attention',['attention','both'],{attention:true}],
      ['全部事项','All items',all(),{}]
    ]) {
      await quick(zh,en).click(); await expectScope(t(zh,en),names,filters);
      const before = requests.filter(row => row.path==='/api/v1'+work+'/board').length;
      await quick(zh,en).click(); await expectScope(t(zh,en),names,filters);
      assert.equal(requests.filter(row => row.path==='/api/v1'+work+'/board').length,before,'Selecting the current scope does not reload the board');
    }
  });
  await check('UX-NAV-003 projects_and_archive_replace_quick_filters',async()=>{
    await openBoard('&blocked=true'); await expectRows(['blocked','both']);
    await page.locator('[data-work-project-id="'+project.id+'"]>button').first().click();
    await expectScope(project.name,['attention','both','normal'],{projectId:project.id});
    await quick('待我处理','Needs my attention').click(); await expectScope(attention,['attention','both'],{attention:true});
    await button('已归档','Archived',side().locator('footer')).click();
    await expectScope(t('已归档','Archived'),['archived'],{archived:true},t('已归档事项','Archived items'));
    await quick('有阻塞','Blocked').click(); await expectScope(blocked,['blocked','both'],{blocked:true});
  });
  await check('UX-NAV-004 combined_filters_remain_available_and_clear_cleanly',async()=>{
    await openBoard('&blocked=true');
    await button('筛选与字段','Filters and fields').click(); const panel=page.locator('.work-filter-panel');
    await panel.getByLabel(attention,{exact:true}).check(); await button('应用','Apply',panel).click();
    await expectScope(null,['both'],{blocked:true,attention:true},t('筛选结果','Filtered items'));
    await page.reload({waitUntil:'domcontentloaded'}); await expectScope(null,['both'],{blocked:true,attention:true},t('筛选结果','Filtered items'));
    await button('筛选与字段','Filters and fields').click(); await button('清除筛选','Clear filters',panel).click(); await button('应用','Apply',panel).click();
    await expectScope(allLabel,all());
  });
  await check('UX-NAV-005 saved_view_is_distinct_and_exit_preserves_saved_definition',async()=>{
    await openBoard('&savedView='+savedView.id);
    await expectScope(t('保存的视图','Saved views'),['attention','both'],{projectId:project.id,attention:true},savedView.name);
    await quick('有阻塞','Blocked').click(); await expectScope(blocked,['blocked','both'],{blocked:true});
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).has('savedView'),false);
    const current=(await api(work+'/views?id='+savedView.id)).items[0];
    assert.deepEqual(current.definition,savedView.definition,'Navigating does not overwrite the saved view');
  });
  await check('UX-NAV-006 search_empty_state_and_layout_keep_the_scope',async()=>{
    await openBoard('&attention=true'); await expectScope(attention,['attention','both'],{attention:true});
    await page.getByLabel(t('搜索事项','Search items'),{exact:true}).fill(prefix+' missing');
    await expectRows([]); await expectSelection(attention); await shot('empty-attention');
    await page.getByLabel(t('搜索事项','Search items'),{exact:true}).fill('');
    await expectRows(['attention','both']);
    await button('列表','List').click(); await page.locator('.work-table').waitFor(); await expectScope(attention,['attention','both'],{attention:true});
    await button('日历','Calendar').click(); await page.locator('.work-calendar-grid').waitFor(); await expectSelection(attention);
    const response=responses.filter(row=>row.path==='/api/v1'+work+'/calendar').at(-1); assert(response); assertQuery(response.query,{attention:true});
    await button('看板','Board').click(); await expectScope(attention,['attention','both'],{attention:true});
  });
  await check('UX-NAV-007_schedules_archive_and_other_surfaces_do_not_double_select',async()=>{
    await openBoard('&blocked=true');
    await quick('定时事项','Recurring items').click(); await page.locator('.work-schedule-table').waitFor();
    await expectSelection(t('定时事项','Recurring items'));
    await button('已归档','Archived',side().locator('footer')).click(); await page.locator('.work-schedule-table').waitFor();
    const state=await snapshot(); assert.equal(state.active.length,1,'Archived schedules have one current scope'); assert.equal(state.current.length,1); assert.equal(state.title,t('已归档规则','Archived schedules'));
    await quick('今日事项','Today').click(); await expectScope(t('今日事项','Today'),['attention','normal'],{date:'today'});
    await button('看板操作','Board actions').click(); await page.getByRole('menuitem',{name:t('统计','Statistics'),exact:true}).click();
    await page.locator('.work-stats').waitFor(); await expectSelection(null,t('统计','Statistics'));
    await quick('全部事项','All items').click(); await expectScope(allLabel,all());
  });
  await check('UX-NAV-008_refresh_hash_history_and_timezone_metadata_restore_scope',async()=>{
    await openBoard('&blocked=true&timezone=Asia%2FShanghai&show=id&show=relations'); await expectScope(blocked,['blocked','both'],{blocked:true});
    await page.reload({waitUntil:'domcontentloaded'}); await expectScope(blocked,['blocked','both'],{blocked:true});
    await page.evaluate(hash => {location.hash=hash;},'/library?view=board&space='+fixture.shared+'&attention=true');
    await expectScope(attention,['attention','both'],{attention:true});
    await page.goBack(); await expectScope(blocked,['blocked','both'],{blocked:true});
    await page.goForward(); await expectScope(attention,['attention','both'],{attention:true});
  });
  await check('UX-NAV-009_late_previous_response_cannot_replace_new_scope',async()=>{
    await openBoard();
    let release, fetchedResolve, completedResolve; const gate=new Promise(resolve=>{release=resolve;}), fetched=new Promise(resolve=>{fetchedResolve=resolve;}), completed=new Promise(resolve=>{completedResolve=resolve;});
    const pattern='**/api/v1'+work+'/board?*';
    await page.route(pattern,async route=>{
      if(new URL(route.request().url()).searchParams.get('blocked')!=='true') return route.continue();
      const response=await route.fetch(); fetchedResolve(); await gate;
      try { await route.fulfill({response}); } catch(error) { if(!/closed|aborted|Invalid InterceptionId/i.test(error.message)) throw error; } finally { completedResolve(); }
    });
    try {
      await quick('有阻塞','Blocked').click(); await fetched;
      await quick('待我处理','Needs my attention').click(); await expectScope(attention,['attention','both'],{attention:true});
      release(); await completed; await page.unroute(pattern); await expectRows(['attention','both']); await expectSelection(attention); assertQuery(new URL(page.url()).hash.split('?')[1],{attention:true});
    } finally { release(); await page.unroute(pattern); }
  });
  await check('UX-NAV-010_four_desktop_sizes_themes_and_keyboard',async()=>{
    await openBoard('&attention=true'); await expectScope(attention,['attention','both'],{attention:true});
    for(const mode of ['light','dark']) {
      await theme(mode);
      for(const [width,height] of [[2560,1440],[1920,1080],[1600,900],[2560,1080]]) {
        await page.setViewportSize({width,height}); await expectSelection(attention);
        const value=await page.evaluate(()=>{
          const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
          const active=document.querySelector('.work-quick-filters>button.active'), style=getComputedStyle(active), inactive=getComputedStyle(document.querySelector('.work-quick-filters>button:not(.active)'));
          return {width:innerWidth,height:innerHeight,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),sidebar:rect('.work-sidebar'),heading:rect('.work-context-heading'),active:rect('.work-quick-filters>button.active'),textColor:style.color,background:style.backgroundColor,inactiveBackground:inactive.backgroundColor};
        });
        assert(value.scrollWidth<=width+1,'No document horizontal overflow');
        for(const rect of [value.sidebar,value.heading,value.active]) assert(rect.x>=0&&rect.y>=0&&rect.right<=width+1&&rect.bottom<=height+1,'Navigation fits viewport');
        assert.notEqual(value.background,value.inactiveBackground,'Current scope remains visually distinct');
        report.observations.push({name:'geometry',theme:mode,...value}); await shot(mode+'-'+width+'x'+height);
      }
    }
    await page.setViewportSize({width:2560,height:1440}); await theme('light');
    await quick('有阻塞','Blocked').focus(); await page.keyboard.press('Enter'); await expectScope(blocked,['blocked','both'],{blocked:true});
    assert(await quick('有阻塞','Blocked').evaluate(element=>element===document.activeElement),'Keyboard focus stays on the selected navigation button');
  });
  await check('UX-NAV-011_space_switch_clears_filters_and_does_not_show_other_space_items',async()=>{
    const personal=initial.spaces.find(space=>space.kind==='personal');
    assert(personal,'Fixture owner has a private space');
    await openBoard('&blocked=true'); await expectScope(blocked,['blocked','both'],{blocked:true});
    await page.getByRole('combobox',{name:t('选择空间','Choose a space'),exact:true}).click();
    await page.getByRole('option',{name:personal.name+t(' · 私人',' · Personal'),exact:true}).click();
    await page.locator('.work-board').waitFor(); await expectRows([]); await expectSelection(allLabel);
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('space'),personal.id);
    await page.getByRole('combobox',{name:t('选择空间','Choose a space'),exact:true}).click();
    const shared=initial.spaces.find(space=>space.id===fixture.shared);
    await page.getByRole('option',{name:shared.name,exact:true}).click();
    await expectScope(allLabel,all());
  });
  await check('UX-NAV-012_explicit_unblocked_filter_is_not_all_items',async()=>{
    await openBoard('&blocked=false'); await expectRows(['blocker','attention','normal','overdue']);
    await expectSelection(null,t('筛选结果','Filtered items'));
    const response=responses.filter(row=>row.path==='/api/v1'+work+'/board').at(-1);
    assert.equal(new URLSearchParams(response.query).get('blocked'),'false','Explicit false remains a meaningful server-side filter');
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('blocked'),'false');
    await quick('全部事项','All items').click(); await expectScope(allLabel,all());
  });
  assert.deepEqual(report.errors,[],'No uncaught browser errors'); report.passed=true;
}
main().catch(async error=>{
  report.failure=scrub(error.stack||error); console.error(report.failure); process.exitCode=1;
  if(page) {try {report.failureState=await snapshot();await shot('failure');} catch {}}
}).finally(async()=>{
  report.finishedAt=new Date().toISOString();
  fs.mkdirSync(output,{recursive:true}); fs.writeFileSync(path.join(output,'navigation-report.json'),JSON.stringify(report,null,2)+'\n');
  if(browser) await browser.close();
});
