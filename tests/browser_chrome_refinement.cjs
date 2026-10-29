#!/usr/bin/env node
'use strict';
/**
 * Read-only focus, form, and instance-language checks on ownerless demo 5182/5183.
 * BASE_URL=http://demo-host:5182 node tests/browser_chrome_refinement.cjs
 * Optional: LINGSHU_PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE, SCREENSHOT_DIR.
 * Uses an independent Chromium/context. All non-read requests are blocked.
 * Form drafts are cancelled; no setup, sign-in, account, or configuration save.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const STEP = 10_000;
let browser, context, page, base, space, originalPage, originalNavigation, language, approved = false;
let assertions = 0, currentStep = 'preflight';
const errors = [], consoleErrors = [], writes = [], dialogs = [], images = [], checks = [], focusOperations = [];
const check = (value, message) => { assert.ok(value, message); assertions++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const l = (chinese, english) => language === 'en' ? english : chinese;
const endpoint = relative => base.origin + '/api/v1' + relative;
async function read(relative) {
  const response = await context.request.get(endpoint(relative), { timeout: STEP, maxRedirects: 0 });
  check(response.ok(), `GET ${relative}: HTTP ${response.status()}`); return response.json();
}
const readPage = () => read(`/spaces/${space.id}/page`);
const readNavigation = () => read(`/spaces/${space.id}/navigation`);
function records(dataset) {
  return { categories: [...dataset.data.categories].sort((a, b) => a.id.localeCompare(b.id)), links: [...dataset.data.links].sort((a, b) => a.id.localeCompare(b.id)) };
}
async function stable() {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}
async function capture(name) {
  if (!process.env.SCREENSHOT_DIR) return;
  const directory = path.resolve(process.env.SCREENSHOT_DIR); fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `chrome-${language}-${name}.png`);
  await page.screenshot({ path: target, fullPage: false, animations: 'disabled', timeout: STEP });
  images.push(target);
}
async function keyboardFocus(control, label = 'homepage search') {
  // Exercise real keyboard movement back to the control after initial routing.
  currentStep = `Keyboard focus: ${label}`;
  emit({ event: 'step', label: currentStep, assertions });
  async function record(action) {
    focusOperations.push({ label, action, ...await control.evaluate(node => {
      const describe = target => target ? { tag: target.tagName, id: target.id, role: target.getAttribute('role'), type: target.getAttribute('type'), ariaLabel: target.getAttribute('aria-label'), fieldLabel: target.getAttribute('data-field-label'), tabIndex: target.tabIndex, focused: target === document.activeElement } : null;
      return { time: performance.now(), target: describe(node), active: describe(document.activeElement) };
    }) });
  }
  await control.focus(); await record('focus');
  await page.keyboard.press('Tab'); await record('Tab');
  await page.keyboard.press('Shift+Tab'); await record('Shift+Tab');
  const handle = await control.elementHandle();
  await page.waitForFunction(node => node === document.activeElement, handle, { timeout: STEP });
  // Read the final focused style, not an interpolated shadow between the base
  // input decoration and its focus state. Keep real CSS transitions enabled.
  currentStep = `Focus transitions: ${label}`;
  await page.waitForFunction(node => {
    if (!node.isConnected || node !== document.activeElement) return false;
    void getComputedStyle(node).boxShadow;
    return node.getAnimations({ subtree: false }).every(animation => animation.playState === 'finished' || animation.playState === 'idle');
  }, handle, { timeout: STEP, polling: 'raf' });
  await record('transitions-finished');
  const report = await control.evaluate(node => {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return { focused: node === document.activeElement, focusVisible: node.matches(':focus-visible'), outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth), outlineColor: style.outlineColor, boxShadow: style.boxShadow, borderRadius: style.borderRadius, appearance: style.appearance, width: rect.width, height: rect.height };
  });
  check(report.focused && report.focusVisible, 'The intended control receives keyboard-visible focus');
  return report;
}
async function adminControl(control, label) {
  const report = await keyboardFocus(control, label);
  check(report.outline !== 'none' && report.outlineWidth >= 2, `${label}: a visible keyboard outline is retained`);
  equal(report.boxShadow, 'none', `${label}: no second box-shadow focus ring is layered underneath`);
  checks.push({ control: label, ...report }); return report;
}
async function admin(label) {
  if (!(await page.locator('.admin-shell').isVisible())) {
    await page.locator('.lh-more-trigger').click(); await page.locator('.lh-home-actions-menu a[href="#/admin"]').click();
    await page.locator('.admin-shell').waitFor({ state: 'visible', timeout: STEP });
  }
  await page.getByRole('navigation', { name: l('管理菜单', 'Administration menu'), exact: true }).getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('heading', { name: label, level: 1, exact: true }).waitFor({ state: 'visible', timeout: STEP });
  if (label === l('链接管理', 'Link management')) await page.getByRole('navigation', { name: l('链接分页', 'Links pagination'), exact: true }).waitFor({ state: 'visible', timeout: STEP });
  await stable();
}
async function selectKeyboard(control, label) {
  await adminControl(control, label);
  await page.keyboard.press('Enter');
  const listbox = page.getByRole('listbox'); await listbox.waitFor({ state: 'visible', timeout: STEP });
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option' && document.activeElement.hasAttribute('data-highlighted'), null, { timeout: STEP });
  equal(await page.locator('.lh-select-content').getAttribute('data-theme'), 'light', `${label}: the admin portal keeps the admin palette`);
  const box = await listbox.boundingBox();
  check(!!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 2560 && box.y + box.height <= 1440, `${label}: the popup is not clipped by the viewport`);
  const option = await page.evaluate(() => { const style = getComputedStyle(document.activeElement); return { outline: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  check(option.outline !== 'none' && option.width >= 2, `${label}: the active option is visibly indicated`);
  await capture('select-open');
  await page.keyboard.press('Escape'); await listbox.waitFor({ state: 'hidden', timeout: STEP });
  const handle = await control.elementHandle();
  await page.waitForFunction(node => node === document.activeElement, handle, { timeout: STEP });
  equal(await control.evaluate(node => node === document.activeElement), true, `${label}: Escape returns focus to the trigger`);
}
async function expectInvalid(control, expectedText) {
  currentStep = `Inline validation: ${expectedText}`;
  const handle = await control.elementHandle();
  await page.waitForFunction(node => node.getAttribute('aria-invalid') === 'true' && document.activeElement === node, handle, { timeout: STEP });
  const state = await control.evaluate(node => {
    const described = (node.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    return { invalid: node.getAttribute('aria-invalid'), description: described.map(id => document.getElementById(id)?.textContent || '').join(' '), missing: described.filter(id => !document.getElementById(id)) };
  });
  equal(state.missing, [], 'Every error description references a real element');
  check(state.description.includes(expectedText), 'The visible control has a localized validation description');
  const nativeEvents = await page.evaluate(() => window.__chromeInvalid.map(event => ({ cancelled: event.defaultPrevented, phase: event.eventPhase })));
  check(nativeEvents.length > 0 && nativeEvents.every(event => event.cancelled && event.phase === 0), 'Native HTML validation is preserved and its browser bubbles are cancelled after dispatch');
}
async function expectCorrected(control) {
  currentStep = 'Corrected field clears invalid state';
  const handle = await control.elementHandle();
  await page.waitForFunction(node => node.getAttribute('aria-invalid') !== 'true' && !(node.getAttribute('aria-describedby') || '').includes('-validation'), handle, { timeout: STEP });
  equal(await control.getAttribute('aria-invalid'), null, 'Corrected input clears its invalid marker');
}
async function fillRetained(control, value, label) {
  currentStep = `Retained input value: ${label}`;
  await control.fill(value);
  equal(await control.inputValue(), value, `${label}: fill retains the controlled input value`);
  await page.keyboard.press('Tab');
  const handle = await control.elementHandle();
  await page.waitForFunction(node => node !== document.activeElement, handle, { timeout: STEP });
  equal(await control.inputValue(), value, `${label}: blur does not restore a stale value`);
}
async function run() {
  await page.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded', timeout: STEP });
  await page.locator('.lh-home').waitFor({ state: 'visible', timeout: STEP });
  await page.waitForFunction(() => document.querySelectorAll('.lh-bookmark').length > 0, null, { timeout: STEP });
  equal(await page.locator('html').getAttribute('lang'), language, 'Document language follows the instance configuration');
  const search = page.locator('.lh-home .lh-search input').first();
  await search.waitFor({ state: 'visible', timeout: STEP });
  const beforeSearch = await search.evaluate(node => { const style = getComputedStyle(node.closest('.lh-search')); return { border: style.borderColor, outline: style.outlineStyle, shadow: style.boxShadow }; });
  const searchFocus = await keyboardFocus(search);
  check(searchFocus.outline === 'none' || searchFocus.outlineWidth === 0, 'Homepage search does not draw an inner square outline');
  equal(searchFocus.boxShadow, 'none', 'Homepage search has no extra inner box-shadow ring');
  const searchShell = await search.evaluate(node => { const style = getComputedStyle(node.closest('.lh-search')); return { border: style.borderColor, outline: style.outlineStyle, width: parseFloat(style.outlineWidth), shadow: style.boxShadow, radius: parseFloat(style.borderRadius) }; });
  check(searchShell.radius > 0 && ((searchShell.outline !== 'none' && searchShell.width >= 2) || searchShell.shadow !== 'none' || searchShell.border !== beforeSearch.border), 'Homepage search retains focus on its rounded outer shell');
  checks.push({ control: 'homepage search', input: searchFocus, shell: searchShell }); await capture('search-focused');

  await admin(l('链接管理', 'Link management'));
  await adminControl(page.getByRole('searchbox', { name: l('搜索链接列表', 'Search links'), exact: true }), 'admin search');
  const previousPage = page.getByRole('button', { name: l('链接上一页', 'Links: previous page'), exact: true });
  equal(await previousPage.isDisabled(), true, 'The unavailable previous-page action is natively disabled');
  check(await previousPage.evaluate(node => parseFloat(getComputedStyle(node).opacity) < 1), 'Disabled controls remain visibly distinct');
  await selectKeyboard(page.getByRole('combobox', { name: l('链接每页条数', 'Links per page'), exact: true }), 'page size');
  const create = page.getByRole('button', { name: l('添加链接', 'Add link'), exact: true });
  await create.click();
  const dialog = page.getByRole('dialog', { name: l('添加链接', 'Add link'), exact: true }); await dialog.waitFor({ state: 'visible', timeout: STEP });
  const name = dialog.getByRole('textbox', { name: l('链接名称', 'Link name'), exact: true });
  const url = dialog.getByRole('textbox', { name: l('主入口 URL', 'Primary URL'), exact: true });
  const save = dialog.getByRole('button', { name: l('保存链接', 'Save link'), exact: true });
  await save.click(); await expectInvalid(name, l('不能为空', 'is required')); await capture('required-error');
  await fillRetained(name, 'Focus review (unsaved)', 'required link name'); await expectCorrected(name);
  // Re-enter the invalid state before typing so the first key has to coexist
  // with validation cleanup, which previously reset controlled input values.
  await name.fill(''); await save.click(); await expectInvalid(name, l('不能为空', 'is required'));
  currentStep = 'Sequential keyboard input after required validation';
  let typed = '';
  for (const character of 'Keyboard draft') {
    await page.keyboard.type(character); typed += character;
    equal(await name.inputValue(), typed, 'Every real typed character survives controlled validation updates');
  }
  await expectCorrected(name); await page.keyboard.press('Tab');
  equal(await name.inputValue(), typed, 'The sequentially typed value survives blur');
  await fillRetained(url, 'not-a-url', 'invalid URL'); await save.click(); await expectInvalid(url, l('请填写完整网址', 'enter a complete URL'));
  await fillRetained(url, 'https://example.com/', 'corrected URL'); await expectCorrected(url);
  await adminControl(name, 'text input');
  await adminControl(url, 'URL input');
  await adminControl(dialog.getByRole('textbox', { name: l('描述', 'Description'), exact: true }), 'textarea');
  const number = dialog.getByRole('spinbutton', { name: l('排序', 'Sort order'), exact: true });
  await number.fill('12'); await adminControl(number, 'number input');
  const category = dialog.getByRole('combobox', { name: l('分类', 'Category'), exact: true });
  await selectKeyboard(category, 'empty category select');
  equal(await dialog.locator('form').evaluate(form => new FormData(form).get('categoryId')), '', 'An optional empty category keeps an actual empty form value');
  const checkbox = dialog.getByRole('checkbox', { name: l('加入常用收藏', 'Add to favorites'), exact: true });
  await adminControl(checkbox, 'checkbox'); const checked = await checkbox.getAttribute('aria-checked');
  await page.keyboard.press('Space');
  await page.waitForFunction(({ node, checked }) => node.getAttribute('aria-checked') !== checked, { node: await checkbox.elementHandle(), checked }, { timeout: STEP });
  await page.keyboard.press('Space');
  await page.waitForFunction(({ node, checked }) => node.getAttribute('aria-checked') === checked, { node: await checkbox.elementHandle(), checked }, { timeout: STEP });
  equal(await checkbox.getAttribute('aria-checked'), checked, 'Space toggles the checkbox and restores the draft');
  const iconButtons = dialog.locator('.admin-icon-grid button');
  equal(await iconButtons.count(), 30, 'All built-in icon choices remain available');
  const native = await dialog.locator('select,input[type=checkbox]').evaluateAll(nodes => nodes.filter(node => {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return node.getAttribute('aria-hidden') !== 'true' && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1;
  }).map(node => ({ tag: node.tagName, type: node.type })));
  equal(native, [], 'Native select and checkbox helpers do not expose operating-system controls');
  if (language === 'en') check((await iconButtons.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') || ''))).every(label => label && !/\p{Script=Han}/u.test(label)), 'English icon choices use readable English labels');
  await dialog.getByRole('button', { name: l('取消', 'Cancel'), exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: STEP });
  await page.waitForFunction(node => node === document.activeElement, await create.elementHandle(), { timeout: STEP });
  equal(await create.evaluate(node => node === document.activeElement), true, 'Cancelling a programmatic dialog restores its opening button');

  await admin(l('导入与导出', 'Import and export'));
  await page.getByRole('button', { name: l('选择书签文件', 'Choose bookmark file'), exact: true }).click();
  const importer = page.getByRole('dialog', { name: l('导入浏览器书签', 'Import browser bookmarks'), exact: true });
  const fileButton = importer.locator('.admin-file-picker button'); await adminControl(fileButton, 'file chooser button');
  equal(await importer.locator('input[type=file]').evaluate(node => node.hidden && node.tabIndex === -1), true, 'The native file input stays hidden behind its styled button');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: STEP }), page.keyboard.press('Space')]);
  await chooser.setFiles({ name: 'focus-review.html', mimeType: 'text/html', buffer: Buffer.from('<!DOCTYPE NETSCAPE-Bookmark-file-1><DL></DL>') });
  await importer.getByText('focus-review.html', { exact: true }).waitFor({ state: 'visible', timeout: STEP });
  await importer.getByRole('button', { name: l('取消', 'Cancel'), exact: true }).click();
  await importer.waitFor({ state: 'hidden', timeout: STEP });

  await admin(l('访问与账号', 'Access and accounts'));
  const radios = page.locator('.admin-mode-options input[type=radio]'); await radios.first().waitFor({ state: 'visible', timeout: STEP });
  equal(await radios.count(), 4, 'Four native radio choices retain their keyboard grouping');
  const radioFocus = await adminControl(radios.first(), 'access-mode radio'); equal(radioFocus.appearance, 'none', 'Radio rendering uses the project style');
  await page.keyboard.press('ArrowRight'); equal(await radios.nth(1).isChecked(), true, 'Arrow keys move within the native radio group');
  await page.keyboard.press('ArrowLeft'); equal(await radios.first().isChecked(), true, 'The original unsaved access choice is restored');

  await page.goto(base.origin + '/#/login', { waitUntil: 'domcontentloaded', timeout: STEP });
  const username = page.getByRole('textbox', { name: l('用户名', 'Username'), exact: true }); await username.waitFor({ state: 'visible', timeout: STEP });
  await adminControl(username, 'username input'); await adminControl(page.getByLabel(l('密码', 'Password'), { exact: true }), 'password input');
  await page.getByRole('button', { name: l('登录', 'Sign in'), exact: true }).click(); await expectInvalid(username, l('不能为空', 'is required'));
  await capture('login-validation');
  equal(writes, [], 'Focus checks, invalid submits, and cancelled drafts issue no API writes');
  equal(errors, [], 'No uncaught browser errors'); equal(consoleErrors, [], 'No console errors'); equal(dialogs, [], 'No system alert/confirm/prompt dialogs');
}
(async () => {
  let failure;
  try {
    check(!!process.env.BASE_URL, 'Explicit disposable-demo BASE_URL is required'); base = new URL(process.env.BASE_URL);
    check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Use a plain instance root');
    check(['5182', '5183'].includes(base.port), 'Only disposable demos 5182 and 5183 are permitted');
    const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, timeout: STEP, ignoreDefaultArgs: ['--hide-scrollbars'], args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'] });
    context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1, locale: 'en-US', reducedMotion: 'reduce' });
    context.setDefaultTimeout(STEP); context.setDefaultNavigationTimeout(STEP);
    const bootstrap = await read('/bootstrap'), settings = await read('/settings');
    equal(bootstrap.initialized, true, 'Instance is already initialized'); equal(bootstrap.mode, 'open_edit', 'Ownerless demo is open_edit'); equal(settings.mode, 'open_edit', 'Settings confirm open_edit'); equal(settings.hasOwner, false, 'Account-bearing instances are refused'); check(bootstrap.user == null, 'No account is signed in');
    language = bootstrap.language === 'en' ? 'en' : 'zh-CN'; space = bootstrap.spaces.find(item => item.id === bootstrap.defaultSpaceId);
    check(space?.kind === 'shared' && space.published && space.canEdit, 'Default space is the published writable shared demo');
    originalPage = await readPage(); originalNavigation = await readNavigation(); approved = true;
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base.origin) return route.abort('blockedbyclient');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) { writes.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient'); }
      return route.continue();
    });
    await context.addInitScript(() => {
      window.__chromeInvalid = []; document.addEventListener('invalid', event => window.__chromeInvalid.push(event), true);
      window.__chromeFocus = [];
      document.addEventListener('focusin', event => {
        const target = event.target;
        window.__chromeFocus.push({ time: performance.now(), tag: target.tagName, id: target.id, role: target.getAttribute('role'), type: target.getAttribute('type'), ariaLabel: target.getAttribute('aria-label'), fieldLabel: target.getAttribute('data-field-label'), tabIndex: target.tabIndex });
        if (window.__chromeFocus.length > 120) window.__chromeFocus.shift();
      }, true);
    });
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); }); page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
    emit({ event: 'preflight', status: 'passed', language, browserLocale: 'en-US', ownerless: true, origin: base.origin });
    await run();
  } catch (error) { failure = error; if (page) await capture('failure').catch(() => {}); }
  finally {
    if (approved) try { equal(await readPage(), originalPage, 'Full page DTO and revision remain exact'); equal(records(await readNavigation()), records(originalNavigation), 'All business records remain exact'); } catch (error) { failure = failure || error; }
    const diagnostics = page ? await page.evaluate(() => {
      const active = document.activeElement;
      return { active: active ? { tag: active.tagName, id: active.id, role: active.getAttribute('role'), type: active.getAttribute('type'), ariaLabel: active.getAttribute('aria-label'), fieldLabel: active.getAttribute('data-field-label') } : null, focusEvents: window.__chromeFocus || [], dialogs: [...document.querySelectorAll('[role="dialog"]')].map(node => ({ labelledby: node.getAttribute('aria-labelledby'), state: node.getAttribute('data-state') })) };
    }).catch(error => ({ unavailable: error.message })) : undefined;
    emit({ event: 'summary', status: failure ? 'failed' : 'passed', assertions, language, message: failure?.message, stack: failure?.stack, currentStep, checks, screenshots: images, writes, pageErrors: errors, consoleErrors, nativeDialogs: dialogs, focusOperations, diagnostics });
    if (failure) process.exitCode = 1;
    if (context) await context.close().catch(() => {}); if (browser) await browser.close().catch(() => {});
  }
})();
