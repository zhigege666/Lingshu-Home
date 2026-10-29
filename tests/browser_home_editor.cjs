#!/usr/bin/env node
'use strict';
// Read-only browser acceptance on a disposable, initialized loopback fixture.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
for(const key of ['BASE_ADMIN','ADMIN_USERNAME','ADMIN_PASSWORD','OUTPUT_DIR']) assert(process.env[key],'Missing fixture variable: '+key);
const BASE=process.env.BASE_ADMIN.replace(/\/+$/,''),OUT=path.resolve(process.env.OUTPUT_DIR);
assert(['127.0.0.1','localhost','[::1]'].includes(new URL(BASE).hostname),'Use an owned loopback fixture');
const sizes=[[2560,1440],[1920,1080],[1600,900],[2560,1080],[1280,800],[1000,900],[390,844]];
fs.mkdirSync(OUT,{recursive:true,mode:0o700});
const report={passed:false,checks:[],screenshots:[],viewports:sizes},errors=[],writes=[];
const secrets=[process.env.ADMIN_USERNAME,process.env.ADMIN_PASSWORD].filter(Boolean);
const redact=value=>secrets.reduce((s,secret)=>s.split(secret).join('[redacted]'),String(value));
let browser,page,context;
async function check(name,fn){const start=Date.now();try{await fn();report.checks.push({name,status:'passed',durationMs:Date.now()-start});console.log('PASS '+name)}catch(error){report.checks.push({name,status:'failed',error:redact(error.message)});throw error}}
async function until(fn,message){for(let i=0;i<100;i++){if(await fn())return;await page.waitForTimeout(100)}throw Error(message)}
async function openLibrary(width,height){
 const old=page.locator('.lh-composer-drawer');
 if(await old.isVisible())await old.getByRole('button',{name:/^(关闭面板|Close panel)$/}).click();
 await page.setViewportSize({width,height});
 if(width<1100)await page.locator('.lh-composer-sidebar.is-library').waitFor({state:'detached'});
 else await page.locator('.lh-composer-sidebar.is-library').waitFor();
 await page.locator('.lh-composer-library-toggle').click();
 const rail=page.locator(width<1100?'.lh-composer-drawer':'.lh-composer-sidebar.is-library');await rail.waitFor();
 await rail.locator('.lh-composer-library-actions').waitFor();
 return rail;
}
async function layout(rail,width,height){
 const scroll=width<1100?rail.locator('.lh-composer-drawer-body'):rail;
 const actions=rail.locator('.lh-composer-library-actions');
 await actions.scrollIntoViewIfNeeded();
 const geometry=await scroll.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().left+el.clientWidth}));
 assert(geometry.scroll<=geometry.client+1,'Library has horizontal overflow: '+JSON.stringify(geometry));
 const boxes=await actions.locator('button').evaluateAll(buttons=>buttons.map(b=>{const r=b.getBoundingClientRect(),s=b.querySelector('span');return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,labelFits:!s||s.scrollWidth<=s.clientWidth+1}}));
 assert.equal(boxes.length,3);
 assert(boxes.every(b=>b.x>=geometry.left-1&&b.right<=geometry.right+1&&b.labelFits),'An action or label is clipped');
 assert(boxes[0].bottom<=boxes[1].y&&Math.abs(boxes[1].y-boxes[2].y)<2&&boxes[2].width===32,'Expected two-row action layout');
 const refresh=actions.getByRole('button',{name:/^(刷新来源|Refresh sources)$/});assert(await refresh.getAttribute('title'),'Icon-only action lacks a title');await refresh.click({trial:true});
 assert.equal(await page.locator('.lh-field-help:visible').count(),0,'Guidance should be collapsed');
 const file='library-'+width+'x'+height+'.png';
 await rail.screenshot({path:path.join(OUT,file),animations:'disabled'});report.screenshots.push(file);
}
async function help(rail){
 const trigger=rail.getByRole('button',{name:/^(内置组件说明|Help for Built-in components)$/});
 await trigger.hover();assert.equal(await page.locator('.lh-field-help:visible').count(),0);
 await trigger.click();await page.locator('.lh-field-help').waitFor();await page.locator('.lh-field-help-close').click();
 assert(await rail.isVisible(),'Help close also closed its parent');
 await trigger.focus();await page.keyboard.press('Enter');await page.locator('.lh-field-help').waitFor();
 await page.keyboard.press('Escape');await page.locator('.lh-field-help').waitFor({state:'detached'});
 assert(await rail.isVisible(),'Escape closed the library');assert(await trigger.evaluate(el=>el===document.activeElement),'Help did not restore focus');
}
async function dialogFlow(kind,width,height){
 const rail=await openLibrary(width,height);
 const name=kind==='preset'?/^(预置仪表板|Dashboard presets)$/:/^(导入模板|Import template)$/;
 const trigger=rail.getByRole('button',{name});await trigger.click();
 const dialog=page.locator('.admin-dialog');await dialog.waitFor();
 assert.equal(await page.locator('.lh-composer-drawer:visible').count(),0,'Drawer covers the modal');
 const close=dialog.getByRole('button',{name:/^(关闭|Close)$/});await close.click();
 await dialog.waitFor({state:'detached'});
 const target=width<1100?page.locator('.lh-composer-library-toggle'):trigger;
 await until(()=>target.evaluate(el=>el===document.activeElement),'Dialog did not restore focus to a live control');
 assert(await page.locator('.lh-composer').isVisible(),'Closing modal left the editor');
}
async function main(){
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
 context=await browser.newContext({locale:process.env.ADMIN_LOCALE||'zh-CN',viewport:{width:1600,height:900},reducedMotion:'reduce'});
 const boot=await(await context.request.get(BASE+'/api/v1/bootstrap')).json();
 const auth=await context.request.post(BASE+'/api/v1/auth/login',{headers:{Origin:new URL(BASE).origin,'X-CSRF-TOKEN':boot.csrfToken},data:{username:process.env.ADMIN_USERNAME,password:process.env.ADMIN_PASSWORD}});
 assert(auth.ok(),'Fixture login HTTP '+auth.status());
 page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(redact(error.message)));
 page.on('request',request=>{if(request.url().startsWith(BASE+'/api/v1/')&&!['GET','HEAD','OPTIONS'].includes(request.method()))writes.push({method:request.method(),path:new URL(request.url()).pathname})});
 await page.goto(BASE+'/#/',{waitUntil:'domcontentloaded'});await page.locator('.lh-edit-menu summary').click();await page.getByRole('button',{name:/^(调整布局|Adjust layout)$/,exact:true}).click();await page.locator('.lh-composer').waitFor();
 for(const [width,height]of sizes)await check('library_layout_'+width+'x'+height,async()=>{const rail=await openLibrary(width,height);await layout(rail,width,height)});
 for(const [width,height]of [[1600,900],[1000,900],[390,844]])await check('library_help_'+width,async()=>{await help(await openLibrary(width,height))});
 for(const [width,height]of [[1600,900],[1000,900]])for(const kind of ['preset','import'])await check(kind+'_dialog_focus_'+width,()=>dialogFlow(kind,width,height));
 await check('refresh_sources_without_mutation',async()=>{
  const rail=await openLibrary(1280,800),refresh=rail.getByRole('button',{name:/^(刷新来源|Refresh sources)$/});
  const pending=page.waitForResponse(response=>/\/api\/v1\/spaces\/[^/]+\/sources$/.test(new URL(response.url()).pathname)&&response.request().method()==='GET');
  await refresh.click();assert((await pending).ok(),'Sources refresh failed');await until(async()=>await refresh.isEnabled(),'Refresh did not finish');
 });
 for(const [width,height]of [[1280,800],[390,844]])await check('library_footer_scroll_'+width,async()=>{
  const rail=await openLibrary(width,height),footer=rail.locator('.lh-composer-library-item').filter({hasText:/^(页脚|Footer)$/});
  await footer.scrollIntoViewIfNeeded();await footer.click();
  const inspector=page.locator(width<1100?'.lh-composer-drawer':'.lh-composer-sidebar.is-inspector');await inspector.getByRole('heading',{name:/^(页脚|Footer)$/}).waitFor();
  assert(await page.locator('.lh-composer').isVisible());
 });
 await check('no_writes_or_browser_errors',async()=>{assert.deepEqual(writes,[],'Read-only editor interactions wrote data');assert.deepEqual(errors,[])});
 report.passed=true;
}
main().catch(error=>{report.error=redact(error.stack||error);console.error(report.error);process.exitCode=1}).finally(async()=>{if(page&&!report.passed)await page.screenshot({path:path.join(OUT,'failure.png')}).catch(()=>{});if(browser)await browser.close();fs.writeFileSync(path.join(OUT,'home-editor-results.json'),JSON.stringify(report,null,2),{mode:0o600})});
