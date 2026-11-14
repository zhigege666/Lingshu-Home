#!/usr/bin/env node
'use strict';
// Cross-page shell contract. Run only with a named, disposable loopback fixture;
// navigation, profile and settings mutations below never target a daily instance.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'Use the owned fixture runner');
const fixtures = JSON.parse(fs.readFileSync(process.env.UI_FIXTURES, 'utf8'));
const provider = process.env.UI_PROVIDER || 'sqlite', fixture = fixtures[provider];
assert(fixture, 'Unknown fixture provider');
const base = new URL(fixture.url);
assert(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && !base.username && !base.password && !base.search && !base.hash, 'Only an owned loopback HTTP fixture is accepted');
const origin = base.origin, out = path.resolve(process.env.OUTPUT_DIR);
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const report = { passed: false, checks: [], errors: [], screenshots: [], geometry: [] };
const secrets = Object.values(fixtures).flatMap(item => [item.username, item.password]).filter(Boolean);
const scrub = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));
const sizes = [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080]];
const views = [
  { id: 'home', route: '/#/', shell: '.lh-home', active: 'home' },
  { id: 'library', route: '/#/library?space=' + fixture.shared, shell: '.library-shell', active: 'documents' },
  { id: 'work', route: '/#/library?view=board&space=' + fixture.shared, shell: '.work-shell', active: 'work' },
  { id: 'admin', route: '/#/admin?tab=links', shell: '.admin-shell', active: null },
];
let browser, context, page, initial, language;
const text = (zh, en) => language === 'en' ? en : zh;
const header = () => page.locator('header.app-header');
const account = () => header().locator('.home-account-trigger');
const accountMenu = () => page.locator('.home-account-menu');
const button = (zh, en, scope = page) => scope.getByRole('button', { name: text(zh, en), exact: true });
const menuItem = (zh, en, scope = accountMenu()) => scope.getByRole('menuitem', { name: text(zh, en), exact: true });

async function check(name, run) {
  if (process.env.UI_CHECK_MATCH && !new RegExp(process.env.UI_CHECK_MATCH).test(name)) return;
  const started = Date.now();
  try { await run(); report.checks.push({ name, passed: true, ms: Date.now() - started }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: scrub(error.message) }); throw error; }
}
async function boot(ctx = context) {
  const response = await ctx.request.get(origin + '/api/v1/bootstrap');
  assert(response.ok(), 'Bootstrap failed'); return response.json();
}
async function api(route, method = 'GET', data, expected = 200) {
  const state = await boot();
  const response = await context.request.fetch(origin + '/api/v1' + route, { method, data, headers: { Origin: origin, 'X-CSRF-TOKEN': state.csrfToken }, maxRedirects: 0 });
  assert.equal(response.status(), expected, method + ' ' + route + ': ' + response.status());
  return expected === 204 ? null : response.json();
}
async function frames() {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}
async function open(view) {
  const url = origin + view.route;
  if (page.url() === url) await page.reload({ waitUntil: 'domcontentloaded' });
  else await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator(view.shell).waitFor(); await header().waitFor(); await account().waitFor();
  await header().getByRole('combobox', { name: text('选择空间', 'Choose a space'), exact: true }).waitFor();
  await frames();
}
async function shot(name, headerOnly = false) {
  const filename = provider + '-header-' + name + '.png', viewport = page.viewportSize();
  await page.screenshot({ path: path.join(out, filename), animations: 'disabled', ...(headerOnly ? { clip: { x: 0, y: 0, width: viewport.width, height: Math.min(180, viewport.height) } } : {}) });
  report.screenshots.push(filename);
}
async function inViewport(locator, label) {
  await locator.waitFor(); const rect = await locator.boundingBox(), viewport = page.viewportSize();
  assert(rect && rect.width > 0 && rect.height > 0 && rect.x >= -1 && rect.y >= -1 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1, label + ' leaves the viewport');
  return rect;
}
async function closeMenu(trigger, menu) {
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
  await page.waitForFunction(element => document.activeElement === element, await trigger.elementHandle());
}
async function openAccount(keyboard = false) {
  const trigger = account();
  if (keyboard) { await trigger.focus(); await page.keyboard.press('ArrowDown'); }
  else await trigger.click();
  await accountMenu().waitFor(); return trigger;
}
async function theme(color) {
  await openAccount(); await accountMenu().getByRole('menuitemcheckbox', { name: text('切换深浅色', 'Toggle light or dark'), exact: true }).click();
  await closeMenu(account(), accountMenu());
  await page.locator('.lh-home[data-theme=' + color + '],.work-shell[data-theme=' + color + '],.work-theme-' + color).first().waitFor();
}
async function geometry(view, label) {
  const result = await header().evaluate(element => {
    const rect = node => { if (!node || !node.getClientRects().length) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const find = selector => rect(element.querySelector(selector));
    return {
      header: rect(element), brand: find('.app-header-brand'), logo: find('.app-header-brand .project-logo'), navigation: find('.lh-module-nav'), context: find('.app-header-context'),
      search: find('.app-header-search'), actions: find('.app-header-actions'), utilities: find('.app-header-utilities'), space: find('.app-header-space'), account: find('.home-account-trigger'),
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      titleStyle: (() => { const title = element.querySelector('.app-header-context h1'); const style = title && getComputedStyle(title); return style && { fontSize:style.fontSize, fontWeight:style.fontWeight, lineHeight:style.lineHeight }; })(),
      spaceBorder: getComputedStyle(element.querySelector('.app-header-space-select')).borderTopWidth,
      controls: [...element.querySelectorAll('button,a,input,[role=combobox]')].filter(node => node.getClientRects().length).map(node => ({ label: node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.textContent.trim(), ...rect(node) })),
    };
  });
  const viewport = page.viewportSize();
  assert(Math.abs(result.header.height - 64) <= 1 && Math.abs(result.header.y) <= 1, label + ': common header is not 64px at the top');
  assert(Math.abs(result.brand.x - 24) <= 1, label + ': brand does not use the common 24px inset');
  assert(Math.abs(result.logo.width - 32) <= 1 && Math.abs(result.logo.height - 32) <= 1, label + ': logo size differs');
  assert(result.documentWidth <= viewport.width + 1, label + ': horizontal document overflow');
  assert.equal(result.titleStyle?.fontSize, '15px', label + ': page title typography differs');
  assert.equal(result.titleStyle?.fontWeight, '600', label + ': page title weight differs');
  assert.equal(result.spaceBorder, '1px', label + ': space selector border differs');
  const ordered = ['brand', 'navigation', 'context', 'search', 'actions', 'utilities'].map(name => ({ name, rect: result[name] })).filter(item => item.rect);
  for (let index = 0; index < ordered.length; index++) {
    const { name, rect } = ordered[index];
    assert(rect.x >= -1 && rect.right <= viewport.width + 1 && rect.y >= -1 && rect.bottom <= 65, label + ': ' + name + ' is clipped or wrapped');
    if (index) assert(ordered[index - 1].rect.right <= rect.x + 1, label + ': ' + ordered[index - 1].name + ' overlaps or follows ' + name);
  }
  assert(result.space && result.account && result.space.right <= result.account.x + 1, label + ': space/account order differs');
  assert(Math.abs(result.account.right - (viewport.width - 24)) <= 1, label + ': account is not anchored to the common right inset');
  for (const control of result.controls) {
    assert(control.width > 0 && control.x >= -1 && control.right <= viewport.width + 1 && control.y >= -1 && control.bottom <= 65, label + ': clipped control ' + control.label);
  }
  const navigation = header().locator('.lh-module-nav');
  const expectedLabels = [text('导航', 'Home'), text('资料库', 'Library'), text('事项', 'Work')];
  assert.deepEqual(await navigation.locator(':scope > *').evaluateAll(nodes => nodes.map(node => node.getAttribute('title') || node.textContent.trim())), expectedLabels, label + ': module order changed');
  const active = navigation.locator('[aria-current=page]');
  if (view.active) assert.equal(await active.getAttribute('title'), expectedLabels[['home', 'documents', 'work'].indexOf(view.active)], label + ': current module is wrong');
  else assert.equal(await active.count(), 0, label + ': administration must not mark another module current');
  report.geometry.push({ page: view.id, label, ...viewport, ...result }); return result;
}

async function main() {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  const unsigned = await boot(); assert.equal(unsigned.siteName, 'Release UI fixture ' + provider, 'Named disposable fixture guard must match before any write');
  await api('/auth/login', 'POST', { username: fixture.username, password: fixture.password, sessionMode: 'temporary' });
  initial = await boot(); language = initial.language;
  const settings = await api('/settings'), originalSpace = initial.spaces.find(space => space.id === fixture.shared);
  assert(originalSpace?.canEdit && initial.user?.role === 'Owner', 'Use an owned, editable shared fixture');
  const settingsInput = siteName => ({ siteName, mode: settings.mode, registrationEnabled: settings.registrationEnabled, autoFetchIcons: settings.autoFetchIcons, autoSelectEndpoint: settings.autoSelectEndpoint, modules: settings.modules });
  await api('/settings', 'PUT', settingsInput('Lingshu-Home'));
  await api('/account/profile', 'PUT', { displayName: '志哥', expectedDisplayName: initial.user.displayName });
  await context.addInitScript(({ key, id }) => sessionStorage.setItem(key, id), { key: 'lingshu-home:space:v1:user:' + initial.user.id, id: fixture.shared });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(scrub(error.message)));
  const logoutRequests = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/v1/auth/logout') logoutRequests.push(request.method()); });

  await check('four_pages_four_sizes_share_header_geometry', async () => {
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height }); let reference;
      for (const view of views) {
        await open(view); const result = await geometry(view, view.id + '-' + width + 'x' + height);
        if (reference) for (const name of ['brand', 'navigation', 'space', 'account']) assert(Math.abs(result[name].x - reference[name].x) <= 1, name + ' changes position across pages at ' + width);
        else reference = result;
        await shot(view.id + '-' + width + 'x' + height, true);
        if (width === 1600) await shot(view.id + '-' + width + 'x' + height + '-full');
      }
    }
  });

  await check('space_account_menus_keyboard_and_profile_preserve_session', async () => {
    await page.setViewportSize({ width: 1600, height: 900 });
    for (const view of views) {
      await open(view);
      const picker = header().getByRole('combobox', { name: text('选择空间', 'Choose a space'), exact: true });
      await picker.click(); const choices = page.getByRole('listbox'); await inViewport(choices, view.id + ' space menu');
      assert(await choices.getByRole('option', { name: originalSpace.name, exact: true }).isVisible(), 'Current space is absent');
      await closeMenu(picker, choices);
      assert.equal(await button('默认打开空间', 'Default opening space', header()).count(), 0, 'Browser preferences should not occupy the header');
      const trigger = await openAccount(true), menu = accountMenu();
      await inViewport(menu, view.id + ' account menu');
      await page.waitForFunction(() => !!document.activeElement?.closest('.home-account-menu [role^=menuitem]'));
      assert(await menuItem('我的资料', 'My profile').isVisible()); assert(await menuItem('退出登录', 'Sign out').isVisible());
      assert.equal(logoutRequests.length, 0, 'Opening the account menu signed out');
      await shot(view.id + '-account-menu-1600x900'); await closeMenu(trigger, menu);
      await openAccount(); await menuItem('我的资料', 'My profile').click();
      await page.locator('.profile-panel').waitFor(); assert.equal((await boot()).user.id, initial.user.id, 'Profile navigation changed the session');
      assert.equal(logoutRequests.length, 0, 'Profile entry sent a logout request');
    }
  });


  await check('default_space_preferences_save_in_profile_without_disrupting_drafts', async () => {
    await page.setViewportSize({ width: 1600, height: 900 }); await open(views[0]);
    const state = await boot(), personal = state.spaces.find(space => space.kind === 'personal');
    assert(personal, 'The fixture needs private_multi mode with a personal space');
    const key = 'lingshu-home:space-preferences:v1:user:' + state.user.id;
    const original = await page.evaluate(key => localStorage.getItem(key), key);
    await openAccount(); await menuItem('我的资料', 'My profile').click();
    const card = page.getByRole('region', { name: text('浏览偏好', 'Browsing preferences'), exact: true });
    await card.waitFor(); await card.scrollIntoViewIfNeeded();
    const picker = header().getByRole('combobox', { name: text('选择空间', 'Choose a space'), exact: true });
    const selectedBefore = await picker.innerText(), routeBefore = page.url();
    const displayName = page.locator('input[name=profile-display-name]');
    const nameBefore = await displayName.inputValue(), draftName = nameBefore + ' draft';
    const writes = [], observe = request => {
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname.startsWith('/api/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(url.pathname);
    };
    page.on('request', observe);
    try {
      await displayName.fill(draftName);
      await card.getByRole('radio', { name: personal.name, exact: true }).check();
      assert.equal(page.url(), routeBefore, 'Changing a browser preference navigated away');
      assert.equal(await picker.innerText(), selectedBefore, 'Changing a default changed the current space');
      assert.equal(await displayName.inputValue(), draftName, 'Changing a preference discarded the profile draft');
      assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).defaultSpaceId, key), personal.id);
      assert(await button('保存资料', 'Save profile').isEnabled(), 'Preference save changed the profile dirty state');
      assert.deepEqual(writes, [], 'A browser preference wrote shared or account configuration');
      await card.getByRole('status').filter({ hasText: text('已保存', 'Saved') }).waitFor();
      await page.waitForFunction(() => document.querySelector('.lh-space-preference-status')?.textContent === '', null, { timeout: 6000 });
      await button('取消修改', 'Cancel changes').click();
      const second = await context.newPage();
      try {
        await second.goto(origin + '/#/admin?tab=profile', { waitUntil: 'domcontentloaded' });
        const secondCard = second.getByRole('region', { name: text('浏览偏好', 'Browsing preferences'), exact: true });
        await secondCard.waitFor();
        assert(await secondCard.getByRole('radio', { name: personal.name, exact: true }).isChecked());
        await secondCard.getByRole('radio', { name: text('记住上次空间', 'Remember last space'), exact: true }).check();
        await page.waitForFunction(() => document.querySelector('.lh-space-preference-options input:checked')?.value === '');
        assert.equal(await picker.innerText(), selectedBefore, 'Another tab changed this tab navigation');
      } finally { await second.close(); }
      await shot('profile-preferences-1600x900');
    } finally {
      page.off('request', observe);
      await page.evaluate(({ key, original }) => { if (original === null) localStorage.removeItem(key); else localStorage.setItem(key, original); }, { key, original });
    }
  });

  await check('default_space_settings_four_sizes_keyboard_and_storage_failure', async () => {
    await open(views[3]); await openAccount(); await menuItem('我的资料', 'My profile').click();
    const card = page.getByRole('region', { name: text('浏览偏好', 'Browsing preferences'), exact: true });
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height }); await card.scrollIntoViewIfNeeded(); await frames();
      await inViewport(card, 'Preference settings ' + width + 'x' + height);
      const checked = card.locator('input:checked'); await checked.focus();
      await page.waitForFunction(element => document.activeElement === element, await checked.elementHandle());
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Preference settings overflow horizontally');
      await shot('profile-preferences-' + width + 'x' + height);
    }
    const blocked = await context.newPage();
    try {
      await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Fixture storage denied', 'SecurityError'); } }));
      await blocked.goto(origin + '/#/admin?tab=profile', { waitUntil: 'domcontentloaded' });
      const blockedCard = blocked.getByRole('region', { name: text('浏览偏好', 'Browsing preferences'), exact: true });
      await blockedCard.getByRole('radio', { name: originalSpace.name, exact: true }).click();
      await blockedCard.getByRole('alert').waitFor();
      assert(await blockedCard.getByRole('radio', { name: text('记住上次空间', 'Remember last space'), exact: true }).isChecked(), 'Failed persistence displayed an unsaved choice as saved');
      const target = (await boot()).spaces.find(space => space.kind === 'personal');
      assert(target, 'The fixture needs private_multi mode with a personal space');
      const picker = blocked.locator('header.app-header').getByRole('combobox', { name: text('选择空间', 'Choose a space'), exact: true });
      assert(await picker.isEnabled(), 'Blocked storage disabled quick space selection'); await picker.click();
      await blocked.getByRole('option', { name: target.name + (target.kind === 'personal' ? text(' · 私人', ' · Personal') : ''), exact: true }).click();
      await blocked.waitForFunction(name => document.querySelector('.app-header-space-select')?.textContent.includes(name), target.name);
    } finally { await blocked.close(); }
  });

  await check('page_action_menus_keep_existing_commands_and_focus', async () => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const menus = [
      { view: views[0], trigger: ['页面设置', 'Page options'], selector: '.lh-home-actions-menu', items: [['点击统计', 'Click statistics'], ['调整布局', 'Adjust layout']] },
      { view: views[1], trigger: ['资料库操作', 'Library actions'], selector: '.library-page-menu', items: [['管理目录', 'Manage directories'], ['刷新资料库', 'Refresh library']] },
      { view: views[2], trigger: ['看板操作', 'Board actions'], selector: '.work-menu', items: [['管理状态', 'Manage statuses'], ['重新读取', 'Reload']] },
      { view: views[3], trigger: ['列表操作', 'List actions'], selector: '.admin-header-menu', items: [['刷新列表', 'Refresh list'], ['编辑列表', 'Edit list'], ['导入', 'Import']] },
    ];
    for (const entry of menus) {
      await open(entry.view); const trigger = button(...entry.trigger, header());
      await trigger.focus(); await page.keyboard.press('ArrowDown'); const menu = page.locator(entry.selector);
      await inViewport(menu, entry.view.id + ' page actions');
      for (const [zh, en] of entry.items) assert(await menu.getByRole('menuitem', { name: text(zh, en), exact: true }).isVisible(), entry.view.id + ': missing existing command ' + en);
      assert.equal(await menu.getByRole('menuitem', { name: text('退出登录', 'Sign out'), exact: true }).count(), 0, 'Page actions include account sign-out');
      await shot(entry.view.id + '-page-menu-1600x900'); await closeMenu(trigger, menu);
    }
  });

  await check('home_work_theme_menu_persists_without_server_writes', async () => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await open(views[0]); const beforePage = await api('/spaces/' + fixture.shared + '/page');
    await theme('dark'); await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('.lh-home[data-theme=dark]').waitFor();
    await openAccount(); assert.equal(await accountMenu().getAttribute('data-theme'), 'dark');
    await inViewport(accountMenu(), 'Dark Home account menu'); await shot('home-dark-menu-1600x900'); await closeMenu(account(), accountMenu());
    await open(views[2]); await page.locator('.work-theme-dark').waitFor();
    await openAccount(); assert.equal(await accountMenu().getAttribute('data-theme'), 'dark');
    await inViewport(accountMenu(), 'Dark Work account menu'); await shot('work-dark-menu-1600x900');
    await accountMenu().getByRole('menuitemcheckbox', { name: text('切换深浅色', 'Toggle light or dark'), exact: true }).click(); await page.locator('.work-theme-light').waitFor();
    await closeMenu(account(), accountMenu());
    await open(views[0]); await page.locator('.lh-home[data-theme=light]').waitFor();
    assert.deepEqual(await api('/spaces/' + fixture.shared + '/page'), beforePage, 'Theme browsing changed shared page configuration');
  });

  await check('long_names_keep_primary_actions_and_global_controls_reachable', async () => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const longSite = 'Lingshu-Home 跨项目资料与协作工作台', longName = '志哥的跨项目协作与开发账号', longSpace = '共享空间 · 产品设计、项目开发与文档协作验收';
    await api('/settings', 'PUT', settingsInput(longSite));
    await api('/spaces/' + fixture.shared, 'PUT', { name: longSpace, published: originalSpace.published });
    await api('/account/profile', 'PUT', { displayName: longName, expectedDisplayName: (await boot()).user.displayName });
    try {
      for (const [index, view] of views.entries()) {
        await open(view);
        if (index === 0) {
          // API setup bypasses the mounted app state. Refresh explicitly so
          // this check works after any filtered set of preceding checks.
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForFunction(({ name, space }) =>
            document.querySelector('.home-account-name')?.textContent === name
            && document.querySelector('.app-header-space-select')?.textContent.includes(space),
          { name: longName, space: longSpace });
          await frames();
        }
        await geometry(view, view.id + '-long-names');
        assert((await account().getAttribute('aria-label')).includes(longName), 'Truncation removed the full accessible account name');
        assert((await header().getByRole('combobox', { name: text('选择空间', 'Choose a space'), exact: true }).innerText()).includes(longSpace), 'Truncation replaced the actual space label');
        const primary = view.id === 'home' ? button('编辑', 'Edit', header()) : view.id === 'library' ? button('新建文档', 'New document', header()) : view.id === 'work' ? button('新建事项', 'New item', header()) : button('添加链接', 'Add link', header());
        await inViewport(primary, view.id + ' primary action'); await shot(view.id + '-long-names-1600x900', true);
        await openAccount(); await inViewport(accountMenu(), view.id + ' long account menu'); await closeMenu(account(), accountMenu());
      }
    } finally {
      await api('/settings', 'PUT', settingsInput('Lingshu-Home'));
      await api('/spaces/' + fixture.shared, 'PUT', { name: originalSpace.name, published: originalSpace.published });
      await api('/account/profile', 'PUT', { displayName: '志哥', expectedDisplayName: (await boot()).user.displayName });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(name => document.querySelector('.home-account-name')?.textContent === name, '志哥');
    }
  });

  await check('visitor_keeps_public_navigation_without_private_account_actions', async () => {
    const visitor = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
    try {
      const visitorState = await boot(visitor); assert.equal(visitorState.user, null);
      const tab = await visitor.newPage(); tab.on('pageerror', error => report.errors.push(scrub(error.message)));
      for (const view of views.filter(item => ['home', 'library'].includes(item.id))) {
        await tab.goto(origin + view.route, { waitUntil: 'domcontentloaded' }); await tab.locator(view.shell + ' header.app-header').waitFor();
        const shell = tab.locator('header.app-header');
        assert.equal(await shell.locator('.home-account-trigger').count(), 0, 'Visitor has a private account menu');
        assert.equal(await shell.getByRole('link', { name: text('事项', 'Work'), exact: true }).count(), 0, 'Visitor has a private work link');
        assert.equal(await shell.getByRole('button', { name: text('新建文档', 'New document'), exact: true }).count(), 0, 'Visitor can create documents');
        assert.equal(await shell.getByRole('button', { name: text('编辑', 'Edit'), exact: true }).count(), 0, 'Visitor can edit navigation');
        assert(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Visitor shell overflows');
        const filename = provider + '-header-' + view.id + '-visitor-1600x900.png'; await tab.screenshot({ path: path.join(out, filename), animations: 'disabled' }); report.screenshots.push(filename);
      }
    } finally { await visitor.close(); }
  });
  await check('admin_header_actions_open_cancel_and_guard_inline_drafts', async () => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const navigationPath = '/spaces/' + fixture.shared + '/navigation', before = await api(navigationPath);
    assert(before.data.links.length > 0, 'The seeded fixture must have a link for the inline draft');
    const writes = [], observe = request => {
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname.startsWith('/api/v1/spaces/' + fixture.shared + '/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname });
    };
    const focused = async target => { await target.waitFor(); await page.waitForFunction(element => document.activeElement === element, await target.elementHandle()); };
    const listActions = () => button('列表操作', 'List actions', header());
    async function listCommand(zh, en) {
      await listActions().click(); const menu = page.locator('.admin-header-menu'); await menu.waitFor();
      await menu.getByRole('menuitem', { name: text(zh, en), exact: true }).click(); await menu.waitFor({ state: 'hidden' });
    }
    page.on('request', observe);
    try {
      await open(views[3]);
      const addLink = button('添加链接', 'Add link', header()); await addLink.click();
      const linkDialog = page.getByRole('dialog', { name: text('添加链接', 'Add link'), exact: true }); await inViewport(linkDialog, 'Add link dialog');
      assert(await linkDialog.getByRole('textbox', { name: text('链接名称', 'Link name'), exact: true }).isVisible());
      assert(await linkDialog.getByRole('textbox', { name: text('主入口 URL', 'Primary URL'), exact: true }).isVisible());
      await button('取消', 'Cancel', linkDialog).click(); await linkDialog.waitFor({ state: 'hidden' }); await focused(addLink);

      await button('分类管理', 'Category management', page.locator('.admin-sidebar')).click();
      const addCategory = button('添加分类', 'Add category', header()); await addCategory.click();
      const categoryDialog = page.getByRole('dialog', { name: text('添加分类', 'Add category'), exact: true }); await inViewport(categoryDialog, 'Add category dialog');
      assert(await categoryDialog.getByRole('textbox', { name: text('分类名称', 'Category name'), exact: true }).isVisible());
      await button('取消', 'Cancel', categoryDialog).click(); await categoryDialog.waitFor({ state: 'hidden' }); await focused(addCategory);

      await button('链接管理', 'Link management', page.locator('.admin-sidebar')).click();
      await listCommand('导入', 'Import');
      const importer = page.getByRole('dialog', { name: text('导入浏览器书签', 'Import browser bookmarks'), exact: true }); await inViewport(importer, 'Bookmark import dialog');
      assert.equal(await importer.locator('input[type=file]').count(), 1, 'Import command did not open the file workflow');
      // Field binds its label to the visible FilePicker button, so its
      // accessible name is the field label rather than its button text.
      const fileTrigger = button('HTML 书签文件', 'HTML bookmark file', importer);
      assert(await fileTrigger.isEnabled());
      assert.equal((await fileTrigger.innerText()).trim(), text('选择文件', 'Choose file'));
      await button('取消', 'Cancel', importer).click(); await importer.waitFor({ state: 'hidden' }); await focused(listActions());

      await listCommand('编辑列表', 'Edit list'); const inline = page.locator('.navigation-inline'); await inline.waitFor();
      await button('结束编辑', 'Finish editing', inline).click(); await inline.waitFor({ state: 'hidden' }); await focused(listActions());
      await listCommand('编辑列表', 'Edit list'); await inline.waitFor();
      const title = inline.locator('[data-inline-cell][data-field=title] input').first(); await title.waitFor();
      const draft = (await title.inputValue()) + ' · unsaved header draft'; await title.fill(draft);
      await openAccount(); await menuItem('我的资料', 'My profile').click();
      const leave = page.getByRole('dialog', { name: text('保存列表中的修改？', 'Save your list changes?'), exact: true }); await leave.waitFor();
      assert.equal(await page.getByRole('dialog').count(), 1, 'Inline navigation opened duplicate confirmations');
      await shot('admin-inline-profile-guard-1600x900');
      await button('继续编辑', 'Keep editing', leave).click(); await leave.waitFor({ state: 'hidden' });
      assert.equal(await title.inputValue(), draft, 'Keeping the inline draft lost the edited title');
      assert.equal(await page.locator('.profile-panel').count(), 0, 'Profile opened despite keeping the draft');
      await openAccount(); await menuItem('我的资料', 'My profile').click(); await leave.waitFor();
      await button('丢弃草稿并离开', 'Discard draft and leave', leave).click();
      await page.locator('.profile-panel').waitFor(); await leave.waitFor({ state: 'hidden' });
      assert.equal(await page.getByRole('dialog').count(), 0, 'One discard did not finish profile navigation');
      const after = await api(navigationPath);
      assert.equal(after.revision, before.revision, 'Cancelled header actions changed navigation revision');
      assert.deepEqual(after.data, before.data, 'Cancelled header actions changed links or categories');
      assert.deepEqual(writes, [], 'Opening/cancelling header actions unexpectedly wrote business data');
    } finally { page.off('request', observe); }
  });

  await check('library_notes_draft_guards_account_and_space_navigation_once', async () => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const navigationPath = '/spaces/' + fixture.shared + '/navigation', before = await api(navigationPath);
    const bookmark = before.data.links[0], personal = initial.spaces.find(space => space.kind === 'personal' && space.canEdit && space.id !== fixture.shared);
    assert(bookmark && personal, 'The fixture needs a shared bookmark and an editable personal space');
    const preview = () => page.locator('.library-preview');
    const editor = () => preview().getByRole('textbox', { name: text('书签使用说明', 'Bookmark usage notes'), exact: true });
    const picker = () => header().getByRole('combobox', { name: text('选择空间', 'Choose a space'), exact: true });
    const leave = () => page.getByRole('dialog', { name: text('放弃未保存的修改？', 'Discard unsaved changes?'), exact: true });
    const personalLabel = personal.name + text(' · 私人', ' · Personal');
    const writes = [], observe = request => {
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname === '/api/v1/spaces/' + fixture.shared + '/links/' + bookmark.id + '/context' && request.method() !== 'GET') writes.push(request.method());
    };
    async function notesDraft(value) {
      await open(views[1]);
      await page.locator('.library-row-title[data-resource-id="' + bookmark.id + '"]').click();
      await button('编辑说明', 'Edit notes', preview()).click(); await editor().fill(value);
    }
    async function chooseSpace(name) { await picker().click(); await page.getByRole('option', { name, exact: true }).click(); }
    page.on('request', observe);
    try {
      const profileDraft = (bookmark.contextMarkdown || '') + '\nUnsaved notes before profile navigation.';
      await notesDraft(profileDraft); await openAccount(); await menuItem('我的资料', 'My profile').click(); await leave().waitFor();
      assert.equal(await page.getByRole('dialog').count(), 1, 'Account navigation opened duplicate notes confirmations');
      await shot('library-notes-account-guard-1600x900');
      await button('继续编辑', 'Keep editing', leave()).click(); await leave().waitFor({ state: 'hidden' });
      assert.equal(await editor().inputValue(), profileDraft, 'Account navigation lost the notes draft');
      assert.equal(await page.locator('.profile-panel').count(), 0, 'Profile opened after choosing Keep editing');
      await openAccount(); await menuItem('我的资料', 'My profile').click(); await leave().waitFor();
      await button('放弃修改', 'Discard changes', leave()).click(); await page.locator('.profile-panel').waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0, 'One notes discard did not complete profile navigation');

      const spaceDraft = (bookmark.contextMarkdown || '') + '\nUnsaved notes before changing space.';
      await notesDraft(spaceDraft); await chooseSpace(personalLabel); await leave().waitFor();
      assert.equal(await page.getByRole('dialog').count(), 1, 'Space navigation opened duplicate notes confirmations');
      await shot('library-notes-space-guard-1600x900');
      await button('继续编辑', 'Keep editing', leave()).click(); await leave().waitFor({ state: 'hidden' });
      assert.equal(await editor().inputValue(), spaceDraft, 'Space selection lost the retained notes draft');
      assert((await picker().innerText()).includes(originalSpace.name), 'Keeping a draft changed the active space');
      await chooseSpace(personalLabel); await leave().waitFor(); await button('放弃修改', 'Discard changes', leave()).click();
      await page.waitForFunction(name => document.querySelector('header.app-header .app-header-space-select')?.textContent.includes(name), personal.name);
      assert.equal(await page.getByRole('dialog').count(), 0, 'One notes discard did not complete the space switch');
      assert.equal(await editor().count(), 0, 'The old space notes editor remained open after switching');
      await chooseSpace(originalSpace.name);
      await page.waitForFunction(name => document.querySelector('header.app-header .app-header-space-select')?.textContent.includes(name), originalSpace.name);
      const after = await api(navigationPath);
      assert.equal(after.revision, before.revision, 'Discarding notes unexpectedly changed navigation revision');
      assert.deepEqual(after.data.links.find(item => item.id === bookmark.id), bookmark, 'Discarding notes changed the saved bookmark');
      assert.deepEqual(writes, [], 'Discarded notes sent a write request');
    } finally { page.off('request', observe); }
  });

  assert(report.checks.length > 0, 'UI_CHECK_MATCH did not select any header checks');
  assert.deepEqual(report.errors, [], 'Unhandled browser errors'); report.passed = true;
}
main().catch(async error => {
  report.failure = scrub(error.stack || error); console.error(report.failure); process.exitCode = 1;
  if (page && !page.isClosed()) await shot('failure').catch(() => {});
}).finally(async () => {
  if (browser) await browser.close();
  fs.writeFileSync(path.join(out, 'header-contract-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failure: report.failure || null }));
});
