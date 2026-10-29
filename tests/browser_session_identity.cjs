#!/usr/bin/env node
'use strict';
// Run only against owned release UI fixtures. Two pages deliberately share cookies.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixtureFile = path.resolve(process.env.UI_FIXTURES || '');
const fixtures = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
const output = path.resolve(process.env.OUTPUT_DIR || '');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'Dedicated fixture paths are required');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const report = { passed: false, checks: [], screenshots: [], browserErrors: [], focusStimulus: 'Two real pages share one BrowserContext and cookies. Headless Chrome does not emit OS window focus when bringToFront changes pages, so activation explicitly dispatches focus after bringToFront and a pointer click.' };
let browser, currentPage;
const secrets = Object.values(fixtures).flatMap(value => [value.username, value.password]).filter(Boolean);
const scrub = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));
async function until(fn, label) { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 75)); } throw new Error(label); }
async function check(name, run) { const started = Date.now(); try { await run(); report.checks.push({ name, passed: true, durationMs: Date.now() - started }); console.log('PASS ' + name); } catch (error) { report.checks.push({ name, passed: false, error: scrub(error.message) }); if (currentPage) { const file = name.replaceAll('/', '-') + '-failure.png'; await currentPage.screenshot({ path: path.join(output, file), mask: [currentPage.locator('input[type="password"],input[autocomplete="username"]')] }).then(() => report.screenshots.push(file)).catch(() => {}); } throw error; } }
(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  for (const [provider, fixture] of Object.entries(fixtures)) {
    const base = fixture.url, origin = new URL(base).origin;
    assert.equal(new URL(base).hostname, '127.0.0.1');
    const folder = fs.realpathSync(fixture.folder);
    assert(folder.startsWith(path.dirname(fixtureFile) + path.sep), 'Only this fixture directory may be changed');
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
    const page = await context.newPage(), peer = await context.newPage();
    currentPage = page;
    for (const current of [page, peer]) { current.setDefaultTimeout(15000); current.on('pageerror', error => report.browserErrors.push(scrub(error.message))); }
    async function boot() { const response = await context.request.get(base + '/api/v1/bootstrap'); assert(response.ok()); return response.json(); }
    async function api(route, method = 'GET', body, status = 200) { const state = await boot(); const response = await context.request.fetch(base + '/api/v1' + route, { method, data: body, headers: { Origin: origin, 'X-CSRF-TOKEN': state.csrfToken } }); assert.equal(response.status(), status, method + ' ' + route); return response.json(); }
    async function login(account = fixture) { await api('/auth/login', 'POST', { username: account.username, password: account.password, sessionMode: 'remember', rememberDays: 7 }); }
    const button = (name, scope = page) => scope.getByRole('button', { name, exact: true });
    async function uiLogin(current, account) { await current.locator('input[autocomplete="username"]').fill(account.username); await current.locator('input[autocomplete="current-password"]').fill(account.password); await button('登录', current.locator('.auth-card')).click(); await current.locator('.auth-card').waitFor({ state: 'hidden' }); }
    async function uiLogout(current) { await current.locator('.home-account-trigger').click(); await current.getByRole('menuitem', { name: '退出登录', exact: true }).click(); await current.locator('.home-account-trigger').waitFor({ state: 'hidden' }); }
    async function shared(current = page) { const state = await boot(), name = state.spaces.find(space => space.id === fixture.shared).name; const select = current.locator('.lh-space-holder [role="combobox"]'); await select.waitFor(); if (!(await select.innerText()).includes(name)) { const response = current.waitForResponse(result => result.url().includes('/dashboard?spaceId=' + fixture.shared)); await select.click(); await current.getByRole('option').filter({ hasText: name }).first().click(); assert((await response).ok()); } }
    async function activate(current) { await current.bringToFront(); await current.locator('body').click({ position: { x: 2, y: 2 } }); await current.evaluate(() => window.dispatchEvent(new Event('focus'))); }
    await login();
    const initial = await boot();
    assert.equal(initial.siteName, 'Release UI fixture ' + provider, 'The named fixture guard must match');
    const settings = mode => ({ siteName: initial.siteName, mode, registrationEnabled: false, autoFetchIcons: false, autoSelectEndpoint: false });
    const spacePath = '/spaces/' + fixture.shared;
    const originalPage = await api(spacePath + '/page');
    let installed = false;
    try {
      await api('/settings', 'PUT', settings('private_multi')); await login();
      const reader = { username: 'reader_' + crypto.randomBytes(5).toString('hex'), password: crypto.randomBytes(20).toString('hex'), displayName: 'Browser identity reader' };
      secrets.push(reader.username, reader.password);
      await api('/admin/users', 'POST', reader, 201);
      const sourceFolder = path.join(folder, 'mounts', 'identity-' + crypto.randomBytes(4).toString('hex')); fs.mkdirSync(sourceFolder, { mode: 0o700 });
      const source = await api(spacePath + '/document-sources', 'POST', { name: 'Identity boundary fixture', path: sourceFolder, readOnly: false, defaultWrite: true, defaultFolder: '', scanIntervalSeconds: 3600 }, 201);
      const document = await api(spacePath + '/documents', 'POST', { sourceId: source.id, relativePath: 'private.md', content: '# Private activity identity fixture\n\nOwned QA record.' }, 201);
      const config = structuredClone(originalPage.config), id = 'view-identity-' + crypto.randomBytes(8).toString('hex');
      config.bindings.identityActivity = { datasetId: 'local-document-activity', space: 'current-page-space', query: {} };
      config.views.push({ id, panel: { id: 'builtin/document-activity' }, inputs: { activity: 'identityActivity' }, settings: { presentation: 'heatmap', months: 3, perspective: 'mine', sourceIds: [source.id], showSummary: true, recentLimit: 3, detailLayout: 'auto', timezone: 'UTC' } });
      config.layout.placements[id] = { base: { kind: 'region', region: 'top', order: 0 } };
      await api(spacePath + '/page', 'PUT', { name: originalPage.name, expectedRevision: originalPage.revision, config }); installed = true;
      await page.goto(base + '/#/admin?tab=profile'); await page.locator('.profile-panel').waitFor();
      await peer.goto(base + '/#/'); await peer.locator('.lh-home').waitFor();
      await check(provider + '/same_account_focus_keeps_profile_draft', async () => {
        await activate(page);
        const input = page.locator('input[name="profile-display-name"]');
        await input.fill('Focus identity draft'); const handle = await input.elementHandle();
        await activate(peer);
        const checked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/bootstrap');
        await activate(page); assert((await checked).ok());
        assert(await handle.evaluate(node => node.isConnected), 'A same-account read remounted the form');
        assert.equal(await input.inputValue(), 'Focus identity draft');
        await button('取消修改', page.locator('form').filter({ has: input })).click();
      });
      await check(provider + '/shared_cookie_account_switch_clears_home_draft_and_activity', async () => {
        await page.goto(base + '/#/'); await shared();
        const panel = page.locator('[data-activity-view="' + id + '"]');
        await panel.getByText(document.title, { exact: true }).waitFor();
        await page.locator('.lh-more-trigger').click();await page.getByRole('menuitem',{name:/^(调整布局|Adjust layout)$/,exact:true}).click(); await page.locator('.lh-composer').waitFor();
        await page.locator('.lh-composer-sidebar.is-library').getByRole('tab', { name: '添加组件', exact: true }).click();
        await page.locator('[data-activity-preset="month"]').click();
        assert.equal(await page.locator('.lh-document-activity').count(), 2, 'The first tab owns an unsaved component draft');
        await activate(peer); await uiLogout(peer); await peer.goto(base + '/#/login'); await uiLogin(peer, reader);
        const checked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/bootstrap');
        await activate(page); assert((await checked).ok());
        await page.locator('.lh-composer').waitFor({ state: 'hidden' });
        await until(() => page.locator('.home-account-name').innerText().then(name => name === reader.displayName), 'Old account remained in the focused tab');
        await shared(); await panel.waitFor();
        assert.equal(await panel.locator('.lh-activity-summary,.lh-activity-grid,.lh-activity-documents').count(), 0);
        assert(!(await page.locator('body').innerText()).includes(document.title), 'Old private activity is still visible');
        assert.equal(await page.locator('.lh-edit-trigger').count(), 0, 'Read-only shared space kept the old edit action');
        const stored = await api(spacePath + '/page'); assert.equal(stored.config.views.filter(view => view.panel.id === 'builtin/document-activity').length, 1, 'Identity switch saved an old draft');
        const shot = provider + '-account-switch.png'; await page.screenshot({ path: path.join(output, shot), animations: 'disabled' }); report.screenshots.push(shot);
        await activate(peer); await uiLogout(peer); await peer.goto(base + '/#/login'); await uiLogin(peer, fixture);
        await activate(page); await until(() => page.locator('.home-account-name').innerText().then(name => name !== reader.displayName), 'Owner identity did not refresh');
        await shared(); await panel.getByText(document.title, { exact: true }).waitFor();
      });
      await check(provider + '/late_bootstrap_cannot_restore_logout_or_csrf', async () => {
        await activate(peer);
        let heldResolve, releaseResolve, heldRequest;
        const held = new Promise(resolve => heldResolve = resolve), release = new Promise(resolve => releaseResolve = resolve);
        await page.route('**/api/v1/bootstrap', async route => { heldRequest = route.request(); const response = await route.fetch(); heldResolve(); await release; await route.fulfill({ response }); }, { times: 1 });
        const late = page.waitForResponse(response => response.request() === heldRequest);
        await activate(page); await held;
        await uiLogout(page); await page.locator('.auth-card').waitFor();
        releaseResolve(); await (await late).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert(await page.locator('.auth-card').isVisible()); assert.equal(await page.locator('.home-account-trigger').count(), 0, 'Late bootstrap restored the previous account');
        await uiLogin(page, fixture); assert.equal((await boot()).user.id, initial.user.id, 'The next login did not use the current CSRF token');
      });
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
      await login();
      if (installed) { const current = await api(spacePath + '/page'); await api(spacePath + '/page', 'PUT', { name: originalPage.name, expectedRevision: current.revision, config: originalPage.config }); }
      await api('/settings', 'PUT', settings(initial.mode)); await login();
      await context.close();
    }
  }
  assert.deepEqual(report.browserErrors, []);
  report.passed = true;
})().catch(error => { report.failure = scrub(error.stack || error); console.error(report.failure); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); fs.writeFileSync(path.join(output, 'session-identity-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 }); });
