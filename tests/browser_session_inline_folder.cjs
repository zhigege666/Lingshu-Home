#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fixtures=JSON.parse(fs.readFileSync(process.env.UI_FIXTURES,'utf8')),OUT=process.env.OUTPUT_DIR;
fs.mkdirSync(OUT,{recursive:true,mode:0o700});
const report={passed:false,checks:[],screenshots:[],errors:[]};let browser;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,msg){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await wait(75)}throw Error(msg)}
async function check(name,fn){const start=Date.now();try{await fn();report.checks.push({name,passed:true,ms:Date.now()-start});console.log('PASS '+name)}catch(e){report.checks.push({name,passed:false,error:e.message});throw e}}
(async()=>{
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 for(const provider of (process.env.UI_PROVIDER?[process.env.UI_PROVIDER]:Object.keys(fixtures))){
 const f=fixtures[provider],BASE=f.url,origin=new URL(BASE).origin;
 assert(['127.0.0.1','localhost'].includes(new URL(BASE).hostname));
 const context=await browser.newContext({viewport:{width:1600,height:900},locale:'zh-CN'});
 const page=await context.newPage();page.setDefaultTimeout(15000);
 page.on('pageerror',e=>report.errors.push(e.message));
 async function boot(ctx=context){const r=await ctx.request.get(BASE+'/api/v1/bootstrap');assert(r.ok());return r.json()}
 async function api(route,method='GET',body,ctx=context,expected=200){const b=await boot(ctx);const r=await ctx.request.fetch(BASE+'/api/v1'+route,{method,data:body,headers:{Origin:origin,'X-CSRF-TOKEN':b.csrfToken}});const v=await r.json();assert.equal(r.status(),expected,method+' '+route+' '+JSON.stringify(v));return v}
 async function login(ctx=context,extra={sessionMode:'remember',rememberDays:30}){await api('/auth/login','POST',{username:f.username,password:f.password,...extra},ctx);return boot(ctx)}
 const navPath='/spaces/'+f.shared+'/navigation',batchPath=navPath+'/batch-edit';
 const nav=()=>api(navPath);
 const button=(name,scope=page)=>scope.getByRole('button',{name,exact:true});
 const active=()=>page.locator('.navigation-inline');
 const row=id=>active().locator('tbody tr[data-row-id="'+id+'"]');
 const cell=(id,field)=>row(id).locator('[data-field="'+field+'"] input');
 const saveButton=()=>button('保存全部',active());
 async function responseSave(status=200){const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1'+batchPath&&r.request().method()==='POST');await saveButton().click();assert.equal((await pending).status(),status);if(status===200)await until(()=>active().locator('.inline-draft-count').textContent().then(s=>s.includes('0 条')),'Draft was not cleared')}
 async function shared(){const b=await boot();const name=b.spaces.find(s=>s.id===f.shared).name;const select=page.locator('.admin-global-space [role="combobox"]');if(!(await select.textContent()).includes(name)){await select.click();await page.getByRole('option').filter({hasText:name}).first().click()}await page.locator('.admin-content-toolbar').waitFor()}
 async function admin(){await page.goto(BASE+'/#/admin?tab=links');await shared()}
 async function start(){await button('编辑列表').click();await active().waitFor()}
 async function tab(label){if(label==='我的资料'){await page.locator('.home-account-trigger').click();await page.getByRole('menuitem',{name:'我的资料',exact:true}).click();return}await page.locator('.admin-nav-item').filter({hasText:label==='访问设置'?'站点设置':label}).first().click()}
 async function choose(control,label){await control.click();await page.getByRole('option',{name:label,exact:true}).click()}
 async function snapshot(name){const file=provider+'-'+name+'.png';await page.screenshot({path:path.join(OUT,file),animations:'disabled'});report.screenshots.push(file)}
 async function uiLogin(choice){await page.locator('input[autocomplete="username"]').fill(f.username);await page.locator('input[autocomplete="current-password"]').fill(f.password);if(choice)await choose(page.getByRole('combobox',{name:'登录保持',exact:true}),choice);await button('登录',page.locator('.auth-card')).click();await page.locator('.auth-card').waitFor({state:'hidden'})}
 const reset=await browser.newContext();await login(reset,{sessionMode:'temporary'});const policy=await api('/settings/session-policy','GET',undefined,reset);await api('/settings/session-policy','PUT',{defaultMode:'remember',defaultIdleDays:30,maxIdleDays:30,allowUntilLogout:false,expectedVersion:policy.policyVersion},reset);await api('/auth/logout','POST',{},reset);await reset.close();
 await check(provider+'/login_choice_real_inputs_and_cookie',async()=>{
  await page.goto(BASE+'/#/login');await page.locator('.auth-card').waitFor();
  assert((await page.getByRole('combobox',{name:'登录保持',exact:true}).textContent()).includes('30'));
  assert.equal(await page.locator('.lh-field-help:visible').count(),0);
  await uiLogin('记住 · 7 天未使用后退出');
  const b=await boot();assert.equal(b.session.mode,'remember');assert.equal(b.session.idleDays,7);
  const cookies=await context.cookies();assert(cookies.some(c=>c.httpOnly&&c.expires>Date.now()/1000+6*86400));
 });
 await admin();await start();
 let data=await nav(),first=data.data.links[0],second=data.data.links[1],twentysix=data.data.links[25],category=data.data.categories[0];
 const suffix=provider+' '+Date.now(),title='批量修改 '+suffix,catName='开发工具 '+suffix;
 await check(provider+'/inline_keyboard_undo_crosspage_and_combined_save',async()=>{
  await cell(first.id,'title').fill(title);await page.keyboard.press('Enter');assert(await cell(first.id,'url').evaluate(e=>e===document.activeElement));
  await page.keyboard.press('Shift+Enter');assert(await cell(first.id,'title').evaluate(e=>e===document.activeElement));
  await page.keyboard.press('Tab');assert(await cell(first.id,'url').evaluate(e=>e===document.activeElement));
  await button('撤销修改',active()).click();assert.equal(await cell(first.id,'title').inputValue(),first.title);
  await button('重做修改',active()).click();assert.equal(await cell(first.id,'title').inputValue(),title);
  await button('编辑列表下一页',active()).click();await cell(twentysix.id,'tags').fill('批量,'+suffix);
  await tab('分类管理');await cell(category.id,'name').fill(catName);
  assert((await active().locator('.inline-draft-count').textContent()).includes('3 条'));
  const before=await nav();assert.equal(before.data.links.find(x=>x.id===first.id).title,first.title);
  await responseSave();const after=await nav();
  assert.equal(after.data.links.find(x=>x.id===first.id).title,title);assert.equal(after.data.categories.find(x=>x.id===category.id).name,catName);
  assert.deepEqual(after.data.links.find(x=>x.id===twentysix.id).tags,['批量',suffix]);
  assert.equal(BigInt(after.revision),BigInt(before.revision)+1n);
  await tab('链接管理');
 });
 await check(provider+'/more_settings_apply_to_draft_and_atomic_validation',async()=>{
  const before=await nav();await row(first.id).getByRole('button',{name:/更多设置$/}).click();
  const modal=page.locator('.admin-inline-detail');await modal.waitFor();await modal.locator('textarea').fill('更多设置先进入草稿 '+suffix);
  await button('应用到草稿',modal).click();await modal.waitFor({state:'hidden'});
  assert.equal((await nav()).revision,before.revision);
  await cell(second.id,'url').fill('invalid-url');await saveButton().click();await cell(second.id,'url').filter({visible:true}).waitFor();
  assert.equal(await cell(second.id,'url').getAttribute('aria-invalid'),'true');assert.equal((await nav()).revision,before.revision);
  await cell(second.id,'url').fill(second.url);await responseSave();assert.equal((await nav()).data.links.find(x=>x.id===first.id).description,'更多设置先进入草稿 '+suffix);
 });
 await check(provider+'/concurrent_edit_conflict_resolution',async()=>{
  await cell(first.id,'title').fill('我的修改 '+suffix);const current=await nav();
  await api(batchPath,'POST',{expectedRevision:current.revision,links:[{id:first.id,patch:{title:'另一窗口 '+suffix,description:'服务器描述 '+suffix}}]});
  await responseSave(409);assert.equal(await cell(first.id,'title').inputValue(),'我的修改 '+suffix);
  await button('读取最新内容并比较',active()).click();await page.locator('.inline-conflict').waitFor();
  assert.equal(await page.locator('.inline-conflict').count(),1);
  await button('冲突 1：保留我的修改',active()).click();await responseSave();
  const updated=(await nav()).data.links.find(x=>x.id===first.id);assert.equal(updated.title,'我的修改 '+suffix);assert.equal(updated.description,'服务器描述 '+suffix);
 });
 await check(provider+'/network_before_commit_and_lost_success_response',async()=>{
  await cell(first.id,'tags').fill('网络恢复,'+suffix);
  const pattern='**/api/v1'+batchPath;await page.route(pattern,route=>route.abort('failed'),{times:1});
  await saveButton().click();await button('读取最新内容并比较',active()).waitFor();
  assert(await saveButton().isDisabled());await button('读取最新内容并比较',active()).click();await until(()=>saveButton().isEnabled(),'Readback did not permit saving');await responseSave();
  await cell(first.id,'title').fill('响应丢失已保存 '+suffix);
  await page.route(pattern,async route=>{await route.fetch();await route.abort('failed')},{times:1});
  await saveButton().click();await button('读取最新内容并比较',active()).waitFor();
  const committed=await nav();assert.equal(committed.data.links.find(x=>x.id===first.id).title,'响应丢失已保存 '+suffix);
  await button('读取最新内容并比较',active()).click();await until(()=>active().locator('.inline-draft-count').textContent().then(s=>s.includes('0 条')),'Already committed changes were not recognised');
  assert(await saveButton().isDisabled());assert.equal((await nav()).revision,committed.revision);
 });
 await check(provider+'/leave_guard_and_four_desktop_layouts',async()=>{
  await cell(second.id,'title').fill('离开前的草稿 '+suffix);await tab('我的资料');
  const dialog=page.getByRole('dialog',{name:'保存列表中的修改？'});await dialog.waitFor();await button('继续编辑',dialog).click();assert.equal(await cell(second.id,'title').inputValue(),'离开前的草稿 '+suffix);
  for(const [width,height]of [[2560,1440],[1920,1080],[1600,900],[2560,1080]]){
   await page.setViewportSize({width,height});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Document overflow');
   for(const selector of ['.inline-savebar','.inline-pagination','.inline-filterbar']){
    const box=await active().locator(selector).boundingBox();assert(box&&box.x>=0&&box.x+box.width<=width+1,'Editor control clipped '+selector);
   }
   await snapshot('inline-'+width+'x'+height);
  }
  await tab('我的资料');await dialog.waitFor();await button('保存并离开',dialog).click();await page.locator('.profile-panel').waitFor();
  assert.equal((await nav()).data.links.find(x=>x.id===second.id).title,'离开前的草稿 '+suffix);
 });
 await check(provider+'/session_devices_and_policy_controls',async()=>{
  const peer=await browser.newContext();await login(peer);
  await button('刷新登录记录').click();await until(()=>page.locator('.session-row').count().then(n=>n>=2),'Devices not listed');
  await page.locator('input[name="profile-display-name"]').fill('未保存资料');
  assert(await button('退出其他登录').isDisabled());
  await button('取消修改',page.locator('form').filter({has:page.locator('input[name="profile-display-name"]')})).click();
  await button('退出其他登录').click();await button('确认退出其他登录').click();
  await until(()=>boot(peer).then(b=>!b.user),'Other browser was not revoked');await peer.close();
  await tab('访问设置');await page.locator('.session-policy-panel').waitFor();
  await choose(page.getByRole('combobox',{name:'最长闲置期限',exact:true}),'7 天');
  assert((await page.getByRole('combobox',{name:'默认登录方式',exact:true}).textContent()).includes('7'));
  await button('保存登录策略').click();await until(()=>api('/settings/session-policy').then(p=>p.maxIdleDays===7),'Policy limit not saved');
  await choose(page.getByRole('combobox',{name:'最长闲置期限',exact:true}),'90 天');
  await page.getByRole('checkbox',{name:'允许保持登录直到退出',exact:true}).check();
  await button('保存登录策略').click();await until(()=>api('/settings/session-policy').then(p=>p.allowUntilLogout&&p.maxIdleDays===90),'Until signout not enabled');
 });
 await check(provider+'/folder_preview_search_pagination_and_four_desktops',async()=>{
  await page.goto(BASE+'/#/');await page.locator('.lh-folder-more').first().waitFor();
  const group=page.locator('.lh-link-group').filter({has:page.getByRole('heading',{name:catName,exact:true})});
  assert.equal(await group.locator('.lh-bookmark').count(),6);
  const trigger=group.locator('.lh-folder-more');assert((await trigger.textContent()).includes('49'));
  await trigger.click();const dialog=page.locator('.lh-folder-dialog');await dialog.waitFor();
  assert.equal(await dialog.locator('.lh-bookmark').count(),24);
  assert(await dialog.locator('input[type="search"]').evaluate(e=>e===document.activeElement));
  await button('下一页书签',dialog).click();assert((await dialog.locator('.lh-folder-pagination').textContent()).includes('25–48'));
  await button('下一页书签',dialog).click();assert.equal(await dialog.locator('.lh-bookmark').count(),7);
  assert(await button('下一页书签',dialog).isDisabled());
  await dialog.locator('input[type="search"]').fill('bookmark-55.example');assert.equal(await dialog.locator('.lh-bookmark').count(),1);
  await dialog.locator('input[type="search"]').fill('no-such-bookmark');await dialog.locator('.lh-folder-empty').waitFor();
  await button('清空分类搜索',dialog).click();
  for(const [width,height]of [[2560,1440],[1920,1080],[1600,900],[2560,1080]]){
   await page.setViewportSize({width,height});const b=await dialog.boundingBox();assert(b&&b.x>=0&&b.y>=0&&b.x+b.width<=width+1&&b.y+b.height<=height+1,'Folder clipped');
   const columns=await dialog.locator('.lh-folder-grid').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length);assert(columns>=2&&columns<=4,'Expected 2–4 folder columns');
   assert(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'Folder horizontal overflow');await snapshot('folder-'+width+'x'+height);
  }
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});await until(()=>trigger.evaluate(e=>e===document.activeElement),'Closing folder did not restore focus');
 });
 await check(provider+'/until_logout_choice_and_current_session_revoke',async()=>{
  await page.locator('.home-account-trigger').click();await page.getByRole('menuitem',{name:'退出登录',exact:true}).click();await page.locator('.home-account-trigger').waitFor({state:'hidden'});await page.goto(BASE+'/#/login');await page.locator('.auth-card').waitFor();await uiLogin('保持登录，直到退出');
  assert.equal((await boot()).session.mode,'until_logout');
  await page.goto(BASE+'/#/admin?tab=profile');await page.locator('.session-row[data-current="true"]').waitFor();
  await button('退出此登录').click();await button('确认退出').click();await until(()=>boot().then(b=>!b.user),'Current session not revoked');
 });
 assert.equal(report.errors.length,0,'Browser page errors: '+report.errors.join('; '));await context.close();
 }
 report.passed=true;
})().catch(e=>{report.failure=e.stack;console.error(e.stack);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();fs.writeFileSync(path.join(OUT,'session-inline-folder-report.json'),JSON.stringify(report,null,2),{mode:0o600})});
