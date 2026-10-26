#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fixtures=JSON.parse(fs.readFileSync(process.env.UI_FIXTURES,'utf8')),OUT=process.env.OUTPUT_DIR;
const report={passed:false,checks:[]};let browser;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,msg){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await delay(75)}throw Error(msg)}
async function check(name,fn){await fn();report.checks.push({name,passed:true});console.log('PASS '+name)}
const scrub=s=>Object.values(fixtures).reduce((x,f)=>x.split(f.password).join('[redacted]'),String(s));
const ageScript=[
'import json,sys,os,sqlite3,subprocess,re,datetime',
'from pathlib import Path',
'd=json.load(sys.stdin);assert re.fullmatch(r"[0-9a-f]{64}",d["hash"])',
'stamp=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=20)).isoformat().replace("+00:00","Z")',
'if d["provider"]=="sqlite":',
' p=Path(d["folder"])/"data/lingshu-home.db";assert p.is_file()',
' c=sqlite3.connect(str(p));c.execute("UPDATE sessions SET renewed_at=?,last_interactive_at=? WHERE token_hash=?",(stamp,stamp,d["hash"]));c.commit();c.close()',
'else:',
' assert re.fullmatch(r"home_ui_[0-9a-f]+",os.environ["UI_BROWSER_PG_DATABASE"])',
' e=os.environ.copy();e["PGDATABASE"]=e["UI_BROWSER_PG_DATABASE"]',
' sql="UPDATE sessions SET renewed_at=\'"+stamp+"\',last_interactive_at=\'"+stamp+"\' WHERE token_hash=\'"+d["hash"]+"\';"',
' r=subprocess.run([e["LINGSHU_PSQL"],"-X","-q","-v","ON_ERROR_STOP=1"],input=sql,env=e,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)',
' assert r.returncode==0,"Owned PostgreSQL fixture clock update failed"'
].join('\n');
(async()=>{
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 for(const provider of Object.keys(fixtures)){
 const f=fixtures[provider],BASE=f.url,origin=new URL(BASE).origin;
 assert(new URL(BASE).hostname==='127.0.0.1');assert(path.resolve(f.folder).startsWith(path.dirname(path.resolve(process.env.UI_FIXTURES))+path.sep));
 const context=await browser.newContext({viewport:{width:1600,height:900},locale:'zh-CN'}),page=await context.newPage();page.setDefaultTimeout(15000);
 async function boot(ctx=context){const r=await ctx.request.get(BASE+'/api/v1/bootstrap');assert(r.ok());return r.json()}
 async function api(route,method='GET',body,ctx=context){const b=await boot(ctx);const r=await ctx.request.fetch(BASE+'/api/v1'+route,{method,data:body,headers:{Origin:origin,'X-CSRF-TOKEN':b.csrfToken}});assert(r.ok(),route+' HTTP '+r.status());return r.json()}
 async function login(ctx=context,extra={sessionMode:'remember',rememberDays:7}){return api('/auth/login','POST',{username:f.username,password:f.password,...extra},ctx)}
 async function age(){const cookie=(await context.cookies()).find(c=>c.name==='Lingshu.Session');assert(cookie);cp.execFileSync('python3',['-c',ageScript],{input:JSON.stringify({provider,folder:f.folder,hash:crypto.createHash('sha256').update(cookie.value).digest('hex')}),env:process.env,stdio:['pipe','pipe','pipe']})}
 const button=(name,scope=page)=>scope.getByRole('button',{name,exact:true});
 let renews=0,writes=0,passwordWrites=0;page.on('request',r=>{const p=new URL(r.url()).pathname;if(p.endsWith('/auth/renew'))renews++;if(p.endsWith('/navigation/batch-edit'))writes++;if(p.endsWith('/account/password'))passwordWrites++});
 await login();await age();
 await check(provider+'/real_activity_renewal_preserves_profile_and_throttles',async()=>{
  await page.goto(BASE+'/#/admin?tab=profile');await page.locator('.profile-panel').waitFor();
  const input=page.locator('input[name="profile-display-name"]'),handle=await input.elementHandle();await input.fill('续期时保留草稿');
  await delay(250);assert.equal(renews,0,'Idle page renewed a session');
  await page.evaluate(()=>{window.dispatchEvent(new Event('pointerdown'));window.dispatchEvent(new Event('keydown'))});await delay(150);assert.equal(renews,0,'Synthetic activity renewed a session');
  const response=page.waitForResponse(r=>r.url().endsWith('/auth/renew'));await page.locator('.profile-panel h2').first().click();assert.equal((await response).status(),200);
  await delay(100);assert(await handle.evaluate(e=>e.isConnected));assert.equal(await input.inputValue(),'续期时保留草稿');assert.equal(renews,1);
  await input.press('ArrowLeft');await page.locator('.profile-panel h2').first().click();await delay(100);assert.equal(renews,1,'Renewal was not throttled');
  await button('取消修改',page.locator('form').filter({has:input})).click();
 });
 await check(provider+'/403_identity_readback_has_backoff_and_keeps_form',async()=>{
  await age();await page.reload();await page.locator('.profile-panel').waitFor();renews=0;
  await page.route('**/api/v1/auth/renew',r=>r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({code:'csrf_failed',message:'Controlled test rejection'})}),{times:1});
  const input=page.locator('input[name="profile-display-name"]');await input.fill('认证读回仍保留');
  await page.locator('.profile-panel h2').first().click();await until(()=>Promise.resolve(renews===1),'Renewal rejection not sent');await delay(200);
  for(let i=0;i<5;i++)await page.locator('.profile-panel h2').first().click();await delay(100);
  assert.equal(renews,1,'403 caused a renewal/readback click loop');assert.equal(await input.inputValue(),'认证读回仍保留');
  await button('取消修改',page.locator('form').filter({has:input})).click();
 });
 await check(provider+'/late_renewal_cookie_cannot_replace_password_session',async()=>{
  await age();await page.reload();await page.locator('.profile-panel').waitFor();
  let heldResolve,releaseResolve;const held=new Promise(r=>heldResolve=r),release=new Promise(r=>releaseResolve=r);
  await page.route('**/api/v1/auth/renew',async route=>{const result=await route.fetch();assert(result.headers()['set-cookie'],'Eligible renewal did not set a cookie');heldResolve();await release;await route.fulfill({response:result})},{times:1});
  const next='qa-'+crypto.randomBytes(18).toString('hex'),previous=f.password;
  await page.locator('input[name="profile-current-password"]').fill(previous);await page.locator('input[name="profile-new-password"]').fill(next);await page.locator('input[name="profile-confirm-password"]').fill(next);
  const response=page.waitForResponse(r=>r.url().endsWith('/account/password')&&r.request().method()==='PUT');passwordWrites=0;
  await button('更新密码').click();await held;await delay(150);assert.equal(passwordWrites,0,'Password request raced a delayed renewal cookie');
  releaseResolve();assert.equal((await response).status(),200);await until(()=>boot().then(b=>!!b.user),'Password rotation lost the browser session');f.password=next;
  await page.locator('input[name="profile-current-password"]').waitFor();await delay(100);assert((await boot()).user,'Late renewal cookie logged out the browser');
  await api('/account/password','PUT',{currentPassword:next,newPassword:previous});f.password=previous;
  await page.goto(BASE+'/');await page.reload();
 });
 await check(provider+'/expired_private_draft_restores_without_replaying_save',async()=>{
  const b=await boot(),personal=b.spaces.find(s=>s.kind==='personal');assert(personal);
  const item=await api('/spaces/'+personal.id+'/links','POST',{title:'私人草稿 '+Date.now(),url:'https://private.example.invalid/',description:'',icon:'lucide:link',iconMode:'manual',categoryId:null,tags:[],isFavorite:false,sortOrder:0,endpoints:[]});
  await page.goto(BASE+'/#/admin?tab=links');await page.locator('.admin-global-space [role="combobox"]').waitFor();
  const select=page.locator('.admin-global-space [role="combobox"]');if(!(await select.textContent()).includes(personal.name)){await select.click();await page.getByRole('option').filter({hasText:personal.name}).first().click()}
  await button('编辑列表').click();await page.locator('.navigation-inline').waitFor();
  const cell=page.locator('.navigation-inline [data-row-id="'+item.id+'"] [data-field="title"] input'),draft='重登后恢复 '+Date.now();await cell.fill(draft);
  const current=(await api('/account/sessions')).sessions.find(s=>s.current),peer=await browser.newContext();await login(peer);await api('/account/sessions/revoke','POST',{id:current.id},peer);
  writes=0;const failed=page.waitForResponse(r=>r.url().endsWith('/navigation/batch-edit'));await button('保存全部').click();assert([401,403].includes((await failed).status()));
  await page.locator('.navigation-inline').waitFor({state:'hidden'});assert(await page.locator('input').evaluateAll((inputs,value)=>inputs.every(input=>input.value!==value),draft),'Private draft remained visible after expiry');
  await button('管理员登录').click();await page.locator('.auth-card').waitFor();
  await page.locator('input[autocomplete="username"]').fill(f.username);await page.locator('input[autocomplete="current-password"]').fill(f.password);await button('登录',page.locator('.auth-card')).click();
  await page.locator('.navigation-inline').waitFor();assert.equal(await cell.inputValue(),draft);assert.equal(writes,1,'Reauthentication replayed a write');
  await button('读取最新内容并比较').click();await until(()=>button('保存全部').isEnabled(),'Restored draft could not reconcile');
  const saved=page.waitForResponse(r=>r.url().endsWith('/navigation/batch-edit'));await button('保存全部').click();assert.equal((await saved).status(),200);assert.equal(writes,2);
  assert.equal((await api('/spaces/'+personal.id+'/navigation')).data.links.find(x=>x.id===item.id).title,draft);
  await peer.close();
 });
 await context.close();
 await check(provider+'/persistent_cookie_survives_real_browser_restart',async()=>{
  const profile=fs.mkdtempSync(path.join(OUT,provider+'-persistent-'));fs.chmodSync(profile,0o700);
  const options={executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']};
  let persistent=await chromium.launchPersistentContext(profile,options);await login(persistent);await persistent.close();
  persistent=await chromium.launchPersistentContext(profile,options);assert((await boot(persistent)).user,'Remembered login was lost on restart');
  await api('/auth/logout','POST',{},persistent);await login(persistent,{sessionMode:'temporary'});await persistent.close();
  persistent=await chromium.launchPersistentContext(profile,options);assert.equal((await boot(persistent)).user,null,'Temporary cookie persisted after a normal clean browser close');await persistent.close();
 });
 }
 report.passed=true;
})().catch(e=>{report.failure=scrub(e.stack);console.error(report.failure);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();fs.writeFileSync(path.join(OUT,'session-recovery-report.json'),JSON.stringify(report,null,2),{mode:0o600});fs.writeFileSync(process.env.UI_FIXTURES,JSON.stringify(fixtures),{mode:0o600})});
