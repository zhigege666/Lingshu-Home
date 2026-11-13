#!/usr/bin/env node
'use strict';
// Exercise only this release's header/account journey on a disposable loopback instance.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'Use the disposable fixture runner');
const fixtures = JSON.parse(fs.readFileSync(process.env.UI_FIXTURES, 'utf8'));
const provider = process.env.UI_PROVIDER || 'sqlite', f = fixtures[provider], origin = new URL(f.url).origin;
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Only an owned loopback fixture is accepted');
const OUT = path.resolve(process.env.OUTPUT_DIR), ROOT = path.resolve(__dirname, '..');
const report = { passed: false, checks: [], errors: [], screenshots: [], viewports: [] };
const scrub = value => [f.username, f.password].reduce((s, secret) => s.split(secret).join('[redacted]'), String(value));
let browser, page, context;
async function until(fn, message) { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 60)); } throw Error(message); }
async function check(name, run) { try { await run(); report.checks.push({ name, passed: true }); console.log('PASS ' + name); } catch (error) { report.checks.push({ name, passed: false, error: scrub(error.message) }); throw error; } }
async function boot(ctx = context) { const r = await ctx.request.get(origin + '/api/v1/bootstrap'); assert(r.ok()); return r.json(); }
async function api(route, method = 'GET', data, expected = 200, ctx = context) {
  const b = await boot(ctx), r = await ctx.request.fetch(origin + '/api/v1' + route, { method, data, headers: { Origin: origin, 'X-CSRF-TOKEN': b.csrfToken } });
  assert.equal(r.status(), expected, method + ' ' + route); return expected === 204 ? null : r.json();
}
const b = (zh, en, scope) => (scope || page).getByRole('button', { name: new RegExp('^(' + zh + '|' + en + ')$') });
async function home() { await page.goto(origin + '/#/'); await page.locator('.lh-home').waitFor(); }
async function profile() { await page.locator('.home-account-trigger').click(); await page.getByRole('menuitem', { name: /^(我的资料|My profile)$/ }).click(); await page.locator('.profile-avatar-editor').waitFor(); }
async function toggleTheme(tab = page, visitor = false) {
  const trigger = tab.locator(visitor ? '.lh-home-menu-trigger' : '.home-account-trigger');
  await trigger.click();
  const menu = tab.locator(visitor ? '.lh-home-actions-menu' : '.home-account-menu'); await menu.waitFor();
  await menu.getByRole('menuitemcheckbox', { name: /^(切换深浅色|Toggle light or dark)$/ }).click();
  await tab.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
}
async function choose(file) { await page.locator('.profile-avatar-file').setInputFiles(file); await until(() => page.locator('.profile-avatar-editor img').getAttribute('src').then(s => s?.startsWith('data:')).catch(() => false), 'Avatar draft preview is missing'); }
async function save(expected = 200, method = 'PUT') { const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/account/avatar' && r.request().method() === method); await b('保存头像', 'Save avatar').click(); assert.equal((await response).status(), expected); await until(() => b('上传头像|更换头像', 'Upload avatar|Change avatar').isEnabled(), 'Avatar editor remained locked'); }
async function snap(name, clip) { const file = name + '.png'; await page.screenshot({ path: path.join(OUT, file), animations: 'disabled', ...(clip ? { clip } : {}) }); report.screenshots.push(file); }
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, reducedMotion: 'reduce', locale: 'zh-CN' });
  await api('/auth/login', 'POST', { username: f.username, password: f.password, sessionMode: 'temporary' });
  let initial = await boot(); assert.equal(initial.siteName, 'Release UI fixture ' + provider);
  await api('/account/profile', 'PUT', { displayName: '志哥', expectedDisplayName: initial.user.displayName });
  page = await context.newPage(); page.on('pageerror', e => report.errors.push(scrub(e.message)));
  await home();
  await check('header_navigation_menu_and_responsive_bounds', async () => {
    for (const [width, height] of [[2560,1440], [1920,1080], [1600,900], [2560,1080], [390,844]]) {
      await page.setViewportSize({ width, height });
      await page.getByRole('link', { name: /^(资料库|Library)$/, exact: true }).waitFor();
      await page.getByRole('link', { name: /^(事项|Work)$/, exact: true }).waitFor();
      assert.equal(await b('更多', 'More').count(), 0); assert.equal(await b('刷新内容', 'Refresh content').count(), 0);
      const g = await page.locator('header.app-header').evaluate(el => {
        const r = el.getBoundingClientRect(), controls = [...el.querySelectorAll('button,a')].filter(e => e.getClientRects().length).map(e => { const b = e.getBoundingClientRect(); return { x:b.x, y:b.y, right:b.right, bottom:b.bottom, width:b.width, height:b.height }; });
        return { width: innerWidth, height: innerHeight, right:r.right, documentWidth: document.documentElement.scrollWidth, controls };
      });
      assert(g.documentWidth <= width + 1 && g.right <= width + 1, 'Header overflow at ' + width);
      for (const r of g.controls) assert(r.x >= -1 && r.right <= width + 1 && r.y >= 0 && r.bottom <= height, 'Clipped header control');
      if (width >= 1600) assert(Math.max(...g.controls.map(r => r.y + r.height/2)) - Math.min(...g.controls.map(r => r.y + r.height/2)) < 3, 'Desktop controls wrapped');
      await page.locator('.home-account-trigger').click();
      const accountMenu = page.locator('.home-account-menu'); await accountMenu.waitFor();
      for (const name of [/^(我的资料|My profile)$/, /^(管理中心|Admin)$/, /^(退出登录|Sign out)$/]) assert(await accountMenu.getByRole('menuitem', { name }).isVisible());
      const accountRect = await accountMenu.boundingBox(); assert(accountRect.x >= 0 && accountRect.y >= 0 && accountRect.x + accountRect.width <= width + 1 && accountRect.y + accountRect.height <= height + 1, 'Account menu clipped');
      const avatar = await page.locator('header.app-header .home-account-avatar').boundingBox(); assert(Math.abs(avatar.width - avatar.height) <= 1, 'Account avatar is stretched');
      await page.keyboard.press('Escape');
      await page.locator('.lh-home-menu-trigger').click();
      const menu = page.locator('.lh-home-actions-menu'); await menu.waitFor();
      assert.equal(await menu.getByRole('menuitem', { name: /刷新|Refresh/ }).count(), 0);
      for (const name of [/^(点击统计|Click statistics)$/, /^(调整布局|Adjust layout)$/]) assert(await menu.getByRole('menuitem', { name }).isVisible());
      assert.equal(await menu.getByRole('menuitem', { name: /我的资料|My profile|退出登录|Sign out/ }).count(), 0, 'Page actions duplicate account actions');
      const rect = await menu.boundingBox(); assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width + 1 && rect.y + rect.height <= height + 1, 'Page menu clipped');
      await page.keyboard.press('Escape');
      await snap('home-' + width + 'x' + height); report.viewports.push({width,height,passed:true});
    }
  });
  await page.setViewportSize({ width: 2560, height: 1440 });
  await check('theme_persists_and_account_menu_uses_page_palette', async () => {
    await toggleTheme(); await page.locator('.lh-home[data-theme=dark]').waitFor();
    await page.reload(); await page.locator('.lh-home[data-theme=dark]').waitFor();
    const trigger=page.locator('.home-account-trigger'); await trigger.focus(); await page.keyboard.press('ArrowDown');
    const menu=page.locator('.home-account-menu'); await menu.waitFor();
    assert.equal(await menu.getAttribute('data-theme'), 'dark');
    assert.equal(await menu.evaluate(el=>getComputedStyle(el).backgroundColor), await page.locator('.lh-home').evaluate(el=>{ const s=document.createElement('span'); s.style.color=getComputedStyle(el).getPropertyValue('--lh-surface'); el.appendChild(s); const color=getComputedStyle(s).color; s.remove(); return color; }));
    await snap('header-account-dark', {x:1760,y:0,width:800,height:620});
    await page.keyboard.press('Escape'); await until(()=>trigger.evaluate(e=>document.activeElement===e),'Escape focus was lost');
    await toggleTheme(); await page.locator('.lh-home[data-theme=light]').waitFor();
    await trigger.click(); await snap('header-account-light',{x:1760,y:0,width:800,height:620}); await page.keyboard.press('Escape');
  });
  await check('library_and_board_open_directly', async()=>{
    await page.getByRole('link',{name:/^(资料库|Library)$/}).click(); await page.locator('.library-shell').waitFor();
    await home(); await page.getByRole('link',{name:/^(事项|Work)$/}).click(); await page.locator('.work-shell').waitFor(); await home();
  });
  if (process.env.UI_CHECK_MATCH === 'header') { assert.deepEqual(report.errors, []); report.passed = true; return; }
  const image=path.join(ROOT,'web/src/assets/apple-touch-icon.png'), other=path.join(ROOT,'web/src/assets/favicon-32.png');
  await profile();
  await check('avatar_preview_cancel_and_unsaved_navigation',async()=>{
    await choose(image); assert.equal((await boot()).user.avatarDigest,'');
    await page.locator('nav.lh-module-nav').getByRole('link', { name: /^(导航|Home)$/, exact: true }).click(); const dialog=page.getByRole('dialog',{name:/放弃未保存|Discard unsaved/}); await dialog.waitFor();
    await b('继续编辑','Keep editing',dialog).click(); assert((await page.locator('.profile-avatar-editor img').getAttribute('src')).startsWith('data:'));
    await b('取消','Cancel',page.locator('.profile-avatar-editor')).click(); assert.equal(await page.locator('.profile-avatar-editor img').count(),0);
  });
  let digest='';
  await check('avatar_save_refresh_and_header_sync',async()=>{
    await choose(image); await save(); digest=(await boot()).user.avatarDigest; assert.match(digest,/^[a-f0-9]{64}$/);
    await until(()=>page.locator('.home-account-trigger img').getAttribute('src').then(s=>s.includes(digest)),'Header avatar did not refresh');
    await page.reload(); await page.locator('.profile-avatar-editor img').waitFor(); assert((await page.locator('.profile-avatar-editor img').getAttribute('src')).includes(digest));
    for(const [width,height]of [[2560,1440],[1920,1080],[1600,900],[2560,1080]]){
      await page.setViewportSize({width,height}); const r=await page.locator('.profile-avatar-editor').boundingBox(); assert(r.x>=0&&r.x+r.width<=width&&r.y>=0&&r.y+r.height<=height,'Avatar editor leaves viewport'); assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
    await snap('profile-avatar-2560x1080');
  });
  await check('avatar_rejects_invalid_file_and_retains_saved_image',async()=>{
    await page.locator('.profile-avatar-file').setInputFiles({name:'invalid.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});
    await page.locator('.profile-avatar-feedback .admin-error').waitFor(); assert.equal((await boot()).user.avatarDigest,digest);
    await page.locator('.profile-avatar-file').setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('not an image')});
    await page.locator('.profile-avatar-feedback .admin-error').waitFor(); assert.equal((await boot()).user.avatarDigest,digest);
  });
  await check('avatar_failed_save_keeps_draft_and_previous_image',async()=>{
    await choose(other); await page.route('**/api/v1/account/avatar', route=>route.request().method()==='PUT'?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({code:'fixture_failure',message:'Synthetic write failure'})}):route.continue());
    await save(500); await page.unroute('**/api/v1/account/avatar'); assert.equal((await boot()).user.avatarDigest,digest);
    assert((await page.locator('.profile-avatar-editor img').getAttribute('src')).startsWith('data:'));
    await b('读取当前头像','Read current avatar').click(); await page.locator('.profile-avatar-feedback .profile-info').waitFor();
    await b('取消','Cancel',page.locator('.profile-avatar-editor')).click();
  });
  await check('avatar_conflict_requires_readback_without_replay',async()=>{
    await choose(image);
    const peer=await browser.newContext();
    try{await api('/auth/login','POST',{username:f.username,password:f.password},200,peer);
      const updated=await api('/account/avatar','PUT',{expectedAvatar:digest,mediaType:'image/png',dataBase64:fs.readFileSync(other).toString('base64')},200,peer);
      assert.notEqual(updated.avatarDigest,digest); await save(409); assert.equal((await boot()).user.avatarDigest,updated.avatarDigest);
      await b('读取当前头像','Read current avatar').click(); await page.locator('.profile-avatar-feedback .profile-info').waitFor();
      assert((await page.locator('.profile-avatar-editor img').getAttribute('src')).startsWith('data:')); await b('取消','Cancel',page.locator('.profile-avatar-editor')).click(); digest=updated.avatarDigest;
    }finally{await peer.close();}
  });
  await check('avatar_remove_cancel_and_persistence',async()=>{
    await b('移除头像','Remove avatar').click(); assert.equal(await page.locator('.profile-avatar-editor img').count(),0);
    await b('取消','Cancel',page.locator('.profile-avatar-editor')).click(); assert.equal((await boot()).user.avatarDigest,digest);
    await b('移除头像','Remove avatar').click(); await save(200,'DELETE'); assert.equal((await boot()).user.avatarDigest,'');
    await page.reload(); await page.locator('.profile-avatar-editor').waitFor(); assert.equal(await page.locator('.profile-avatar-editor img').count(),0);
  });
  await check('guest_keeps_library_view_options_and_theme_without_private_entries',async()=>{
    const visitor=await browser.newContext();const tab=await visitor.newPage();
    try{await tab.goto(origin+'/#/');await tab.locator('.lh-home').waitFor();assert(await tab.getByRole('link',{name:/^(资料库|Library)$/}).isVisible());assert.equal(await tab.getByRole('link',{name:/^(事项|Work)$/}).count(),0);
      await tab.getByRole('button',{name:/^(页面设置|Page options)$/}).click();const menu=tab.locator('.lh-home-actions-menu');await menu.waitFor();assert.equal(await menu.getByRole('menuitemradio').count(),2);assert.equal(await menu.getByRole('menuitem',{name:/我的资料|My profile|点击统计|Click statistics/}).count(),0);
      await tab.keyboard.press('Escape');await toggleTheme(tab, true);await tab.locator('.lh-home[data-theme=dark]').waitFor();
    }finally{await visitor.close();}
  });
  assert.deepEqual(report.errors,[]);report.passed=true;
})().catch(async error=>{report.failure=scrub(error.stack||error);if(page&&!page.isClosed())await snap('failure').catch(()=>{});process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();fs.writeFileSync(path.join(OUT,'header-avatar-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,failure:report.failure||null}));});
