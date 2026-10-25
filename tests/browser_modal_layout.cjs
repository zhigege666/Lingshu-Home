#!/usr/bin/env node
'use strict';
// Dedicated ownerless fixtures only: 5214 zh-CN / 5215 en, both started with --language.
// BASE_URL=http://127.0.0.1:5214 node tests/browser_modal_layout.cjs --allow-fixture-write
// --layout-only and --popover-only run one independent suite; default runs both.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
const base = new URL(process.env.BASE_URL || '');
assert.ok(process.argv.includes('--allow-fixture-write'), 'Pass --allow-fixture-write for the disposable fixture');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', '10.233.233.61'].includes(base.hostname)
  && ['5214', '5215'].includes(base.port) && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password,
  'Only dedicated modal-layout fixture ports 5214/5215 are allowed');
const layoutOnly = process.argv.includes('--layout-only'), popoverOnly = process.argv.includes('--popover-only');
assert.ok(!(layoutOnly && popoverOnly), 'Choose at most one partial suite');
const run = randomUUID().slice(0, 8), prefix = 'Modal layout ' + run;
const out = path.resolve(process.env.OUTPUT_DIR || path.join(require('node:os').tmpdir(), 'modal-layout-' + base.port + '-' + run));
fs.mkdirSync(out, { recursive: true });
const viewports = [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080], [1280, 720], [390, 844]];
const report = { startedAt: new Date().toISOString(), origin: base.origin, run, scope: layoutOnly ? 'layout' : popoverOnly ? 'popovers' : 'all',
  checks: [], geometry: [], screenshots: [], mutations: [], blocked: [], pageErrors: [], consoleErrors: [], cleanup: [] };
const created = { links: new Map(), categories: new Map() };
let browser, context, page, boot, csrf, space, originalNavigation, originalPage, category, link, armed, approved = false, phase = 'preflight';
const l = (zh, en) => boot.language === 'en' ? en : zh;
const button = (scope, zh, en) => scope.getByRole('button', { name: l(zh, en), exact: true });
const relative = suffix => '/spaces/' + space.id + suffix;
const apiURL = suffix => base.origin + '/api/v1' + suffix;
const records = nav => ({ categories: [...nav.data.categories].sort((a, b) => a.id.localeCompare(b.id)), links: [...nav.data.links].sort((a, b) => a.id.localeCompare(b.id)) });
const snapshot = nav => ({ revision: nav.revision, data: records(nav) });
async function api(method, suffix, data, expected = 200) {
  const response = await context.request.fetch(apiURL(suffix), { method, data, headers: { 'X-CSRF-TOKEN': csrf || '' }, maxRedirects: 0, timeout: 15_000 });
  assert.equal(response.status(), expected, `${method} ${suffix}: unexpected HTTP ${response.status()}`);
  return expected === 204 ? null : response.json();
}
const navigation = () => api('GET', relative('/navigation'));
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function step(name, action) {
  phase = name; console.log(JSON.stringify({ event: 'step', name }));
  const start = Date.now(); await action(); report.checks.push({ name, status: 'passed', durationMs: Date.now() - start });
}
async function capture(name) { await settle(); const file = path.join(out, boot.language + '-' + name + '.png'); await page.screenshot({ path: file }); report.screenshots.push(file); }
async function focused(control) {
  await control.waitFor(); const expected = await control.elementHandle();
  try { await page.waitForFunction(element => element === document.activeElement, expected); }
  catch (error) {
    const describe = element => ({ tag: element.tagName, id: element.id, label: element.getAttribute('aria-label'),
      text: element.textContent?.trim().slice(0, 100), connected: element.isConnected, inert: !!element.closest('[inert]'),
      disabled: 'disabled' in element && element.disabled, focused: element === document.activeElement });
    report.focusFailure = { phase, cachedTarget: await expected.evaluate(describe).catch(() => null),
      currentTarget: await control.evaluate(describe).catch(() => null),
      browser: await page.evaluate(() => ({ active: { tag: document.activeElement?.tagName, id: document.activeElement?.id,
        label: document.activeElement?.getAttribute('aria-label'), className: document.activeElement?.className }, calls: window.__modalFixtureFocusCalls || [] })) };
    error.message += ' (see report.focusFailure for target identity and actual focus-call timing)'; throw error;
  }
}
async function within(promise) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The expected fixture mutation was not sent')), 15_000); })]); }
  finally { clearTimeout(timer); }
}
async function admin(kind) {
  await page.goto(base.origin + '/#/admin?tab=' + kind, { waitUntil: 'domcontentloaded' });
  const field = page.getByRole('searchbox', { name: kind === 'links' ? l('搜索链接列表', 'Search links') : l('搜索分类列表', 'Search categories'), exact: true });
  await field.waitFor(); await field.fill(prefix); await settle();
}
const rowAction = (kind, record, action) => button(page,
  (action === 'edit' ? '编辑' : '删除') + (kind === 'categories' ? '分类 ' + record.name : ' ' + record.title),
  (action === 'edit' ? 'Edit' : 'Delete') + (kind === 'categories' ? ' category ' + record.name : ' ' + record.title));
async function edit(kind, record) {
  await rowAction(kind, record, 'edit').click();
  const dialog = page.getByRole('dialog', { name: kind === 'links' ? l('编辑链接', 'Edit link') : l('编辑分类', 'Edit category'), exact: true });
  await dialog.waitFor(); await settle(); return dialog;
}
async function create(kind, input) {
  const record = await api('POST', relative('/' + kind), input, 201); assert.match(record.id, /^[0-9a-f]{32}$/);
  assert.ok((record.title || record.name).startsWith(prefix)); created[kind].set(record.id, record); return record;
}
async function protectExisting() {
  const nav = await navigation();
  assert.deepEqual(records({ data: { links: nav.data.links.filter(item => !created.links.has(item.id)), categories: nav.data.categories.filter(item => !created.categories.has(item.id)) } }), records(originalNavigation));
  assert.deepEqual(await api('GET', relative('/page')), originalPage, 'The existing page and revision are untouched');
}
async function visibleControl(control, interactive = true) {
  const state = await control.evaluate(element => {
    const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom,
      visible: r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      unobstructed: !!hit && element.contains(hit) };
  });
  assert.ok(state.visible && (!interactive || state.unobstructed), 'Control is inside the viewport' + (interactive ? ' and can receive a real pointer click: ' : ': ') + JSON.stringify(state));
  return state;
}
async function modalGeometry(dialog, kind, stage) {
  const geometry = await dialog.evaluate(element => {
    const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const body = element.querySelector('.admin-dialog-body'), frame = rect(element), style = getComputedStyle(element);
    const corner = document.elementFromPoint(frame.right - 1, frame.bottom - 1);
    const basics = element.querySelector('.admin-link-basics'), panel = element.querySelector('.admin-link-icon-panel');
    return { frame, body: { ...rect(body), scrollTop: body.scrollTop, clientHeight: body.clientHeight, scrollHeight: body.scrollHeight, clientWidth: body.clientWidth, scrollWidth: body.scrollWidth },
      header: rect(element.querySelector('.cn-dialog-header')), title: rect(element.querySelector('.cn-dialog-title')), close: rect(element.querySelector('.cn-dialog-close')),
      rootScrollTop: element.scrollTop, rootScrollWidth: element.scrollWidth, rootClientWidth: element.clientWidth, documentWidth: document.documentElement.scrollWidth,
      radius: parseFloat(style.borderBottomRightRadius), cornerClipped: !corner || !element.contains(corner),
      basics: basics && rect(basics), panel: panel && rect(panel), viewport: { width: innerWidth, height: innerHeight } };
  });
  const { frame, body, header, title, close, viewport } = geometry;
  assert.ok(frame.x >= 0 && frame.y >= 0 && frame.right <= viewport.width + 1 && frame.bottom <= viewport.height + 1, 'The entire modal fits the viewport');
  assert.ok(geometry.documentWidth <= viewport.width + 1 && geometry.rootScrollWidth <= geometry.rootClientWidth + 1 && body.scrollWidth <= body.clientWidth + 1, 'Long content must not create horizontal overflow');
  assert.ok(body.y >= header.bottom - 1 && body.bottom <= frame.bottom + 1 && body.height >= 120, 'The content has usable space below the fixed header');
  assert.ok(title.right <= close.x - 1 || title.y >= close.bottom, 'The heading must leave room for the close control');
  assert.equal(geometry.rootScrollTop, 0, 'The frame must not scroll away with its content');
  assert.ok(geometry.radius > 0 && geometry.cornerClipped, 'The content scrollbar must be clipped inside the rounded frame');
  await visibleControl(dialog.locator('.cn-dialog-close'));
  await visibleControl(button(dialog, '取消', 'Cancel'));
  await visibleControl(button(dialog, kind === 'links' ? '保存链接' : '保存分类', kind === 'links' ? 'Save link' : 'Save category'));
  report.geometry.push({ phase, stage, ...geometry }); return geometry;
}
async function scrollBottom(dialog) {
  const body = dialog.locator('.admin-dialog-body'); await body.evaluate(element => { element.scrollTop = element.scrollHeight; }); await settle();
  assert.ok(await body.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) < 2));
}
async function save(kind, record, dialog, checkBusy = false) {
  let release, reached;
  const arrived = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const state = { method: 'PUT', target: apiURL(relative('/' + kind + '/' + record.id)), kind, id: record.id, attempts: 0, reached, gate: checkBusy ? gate : Promise.resolve() };
  assert.ok(!armed); armed = state;
  const pending = page.waitForResponse(response => response.url() === state.target && response.request().method() === 'PUT'); pending.catch(() => {});
  try {
    await button(dialog, kind === 'links' ? '保存链接' : '保存分类', kind === 'links' ? 'Save link' : 'Save category').click(); await within(arrived);
    if (checkBusy) {
      const busy = button(dialog, '正在保存…', 'Saving…'); await busy.waitFor(); assert.ok(await busy.isDisabled());
      const close = dialog.locator('.cn-dialog-close'); await visibleControl(close, false); assert.ok(await close.isDisabled());
      assert.ok(await button(dialog, '取消', 'Cancel').isDisabled());
      await page.keyboard.press('Escape'); await page.mouse.click(1, 1); await settle(); assert.ok(await dialog.isVisible());
      await dialog.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); }); await settle(); assert.equal(state.attempts, 1);
      release();
    }
    const response = await pending; assert.equal(response.status(), 200); const result = await response.json();
    assert.equal(result.id, record.id); assert.equal(state.attempts, 1); created[kind].set(record.id, result);
    await dialog.waitFor({ state: 'hidden' }); return result;
  } finally { release(); armed = null; }
}
async function layoutChecks() {
  const widths = new Map();
  for (const [index, [width, height]] of viewports.entries()) await step(`link editor at ${width}x${height}: long fields, 12 endpoints, scrolling and footer`, async () => {
    await page.setViewportSize({ width, height }); await admin('links'); const dialog = await edit('links', link);
    const before = await modalGeometry(dialog, 'links', 'initial'); widths.set(width + 'x' + height, before.frame.width);
    assert.ok(before.body.scrollHeight > before.body.clientHeight + 100, 'The 12-endpoint fixture really requires scrolling');
    const { basics, panel } = before;
    if (width >= 1100) assert.ok(panel.x >= basics.right + 8 && Math.abs(panel.y - basics.y) <= 2, 'Wide editors use two readable columns');
    else assert.ok(panel.y >= basics.bottom, 'Narrow editors stack the icon panel below the fields');
    assert.equal(await dialog.getByLabel(l('链接名称', 'Link name'), { exact: true }).inputValue(), link.title);
    assert.equal(await dialog.getByLabel(l('主入口 URL', 'Primary URL'), { exact: true }).inputValue(), link.url);
    assert.equal(await dialog.getByLabel(l('描述', 'Description'), { exact: true }).inputValue(), link.description);
    assert.equal(await dialog.locator('.link-route-card').count(), 2); assert.equal(await dialog.locator('.link-additional-row').count(), 10);
    for (const [zh, en] of [['添加内网入口', 'Add internal route'], ['添加外网入口', 'Add external route'], ['添加入口', 'Add URL']]) assert.ok(await button(dialog, zh, en).isDisabled());
    const picker = dialog.locator('.lh-icon-picker'), images = picker.locator('.lh-icon-picker-grid.is-labelled img');
    const firstPage = await images.evaluateAll(nodes => nodes.map(node => node.getAttribute('src'))); assert.equal(firstPage.length, 24);
    await button(picker, '下一页图标', 'Next icon page').click();
    assert.notDeepEqual(await images.evaluateAll(nodes => nodes.map(node => node.getAttribute('src'))), firstPage);
    await button(picker, '上一页图标', 'Previous icon page').click();
    assert.deepEqual(await images.evaluateAll(nodes => nodes.map(node => node.getAttribute('src'))), firstPage);
    const shouldSave = index === 0 || width === 390;
    const original = await navigation(), expectedDescription = link.description.slice(0, 1850) + `\nSaved from ${width}x${height}.`;
    if (shouldSave) await dialog.getByLabel(l('描述', 'Description'), { exact: true }).fill(expectedDescription);
    else await dialog.getByLabel(l('链接名称', 'Link name'), { exact: true }).fill(prefix + ' unsaved draft');
    await scrollBottom(dialog); const after = await modalGeometry(dialog, 'links', 'bottom');
    assert.ok(Math.abs(before.header.y - after.header.y) <= 1 && Math.abs(before.close.y - after.close.y) <= 1, 'Header and X stay fixed after a real content scroll');
    await capture(`link-bottom-${width}x${height}`);
    if (shouldSave) {
      const old = link; link = await save('links', link, dialog);
      assert.equal(link.description, expectedDescription); assert.equal(link.title, old.title); assert.equal(link.url, old.url);
      assert.deepEqual(link.endpoints, old.endpoints); assert.equal(link.iconMode, 'manual');
      await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('.admin-content-toolbar').waitFor();
      assert.deepEqual((await navigation()).data.links.find(item => item.id === link.id), link, 'The saved long form survives a reload');
    } else {
      if (index % 2) await button(dialog, '取消', 'Cancel').click(); else await dialog.locator('.cn-dialog-close').click();
      await dialog.waitFor({ state: 'hidden' }); assert.deepEqual(snapshot(await navigation()), snapshot(original), 'Cancel and X discard unsaved changes');
    }
    await protectExisting();
  });
  for (const [width, height] of viewports) await step(`category editor at ${width}x${height}: fixed controls and default width`, async () => {
    await page.setViewportSize({ width, height }); await admin('categories'); const dialog = await edit('categories', category);
    const before = await modalGeometry(dialog, 'categories', 'initial');
    if (width >= 1100) assert.ok(before.frame.width + 200 < widths.get(width + 'x' + height), 'The default editor is meaningfully narrower than the wide link editor');
    await scrollBottom(dialog); const after = await modalGeometry(dialog, 'categories', 'bottom');
    assert.ok(Math.abs(before.header.y - after.header.y) <= 1 && Math.abs(before.close.y - after.close.y) <= 1);
    await capture(`category-${width}x${height}`);
    if (width === 390) category = await save('categories', category, dialog);
    else { await button(dialog, '取消', 'Cancel').click(); await dialog.waitFor({ state: 'hidden' }); }
  });
  await step('busy editor retains a visible disabled X and prevents repeated saves or dismissal', async () => {
    await page.setViewportSize({ width: 1280, height: 720 }); await admin('links'); const dialog = await edit('links', link);
    await scrollBottom(dialog); link = await save('links', link, dialog, true); await protectExisting();
  });
}
async function openConfirmation(kind, record) {
  const action = rowAction(kind, record, 'delete'); await action.click();
  const popover = page.locator(`.lh-confirm-popover[data-confirm-kind="${kind === 'links' ? 'link' : 'category'}"]`);
  await popover.waitFor(); await settle();
  assert.equal(await popover.getAttribute('role'), 'dialog'); assert.equal(await action.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(await action.getAttribute('aria-expanded'), 'true'); assert.equal(await action.getAttribute('aria-controls'), await popover.getAttribute('id'));
  assert.equal(await page.locator('[data-slot="dialog-overlay"]:visible').count(), 0, 'Delete uses no full-screen overlay');
  await focused(popover.locator('[data-confirm-cancel]')); return { action, popover };
}
async function popoverGeometry(popover, action) {
  const p = await popover.boundingBox(), a = await action.boundingBox(), { width, height } = page.viewportSize();
  assert.ok(p && a && p.x >= 10 && p.y >= 10 && p.x + p.width <= width - 10 && p.y + p.height <= height - 10, 'The confirmation avoids every viewport edge');
  const gap = Math.min(Math.abs(p.y - a.y - a.height), Math.abs(a.y - p.y - p.height));
  assert.ok(gap <= 24 && p.x < a.x + a.width && p.x + p.width > a.x, 'The confirmation remains anchored to the triggering button');
  assert.ok(await popover.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await visibleControl(popover.locator('[data-confirm-cancel]')); await visibleControl(button(popover, '确认删除', 'Confirm deletion'));
  report.geometry.push({ phase, popover: p, anchor: a });
}
async function popoverChecks() {
  for (const kind of ['links', 'categories']) await step(`${kind}: anchored confirmation, safe focus and non-destructive dismissal`, async () => {
    const record = kind === 'links' ? link : category;
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height }); await admin(kind); const before = await navigation();
      let { action, popover } = await openConfirmation(kind, record); await popoverGeometry(popover, action); await capture(`${kind}-confirm-${width}x${height}`);
      await button(popover, '保留', 'Keep').click(); await popover.waitFor({ state: 'hidden' }); await focused(action);
      ({ action, popover } = await openConfirmation(kind, record)); await page.keyboard.press('Escape'); await popover.waitFor({ state: 'hidden' }); await focused(action);
      ({ popover } = await openConfirmation(kind, record));
      const field = page.getByRole('searchbox', { name: kind === 'links' ? l('搜索链接列表', 'Search links') : l('搜索分类列表', 'Search categories'), exact: true });
      await field.click(); await popover.waitFor({ state: 'hidden' }); await focused(field);
      assert.deepEqual(snapshot(await navigation()), snapshot(before));
    }
  });
  await step('confirmation collision handling at all four corners of a compact viewport', async () => {
    await page.setViewportSize({ width: 1280, height: 720 }); await admin('links');
    const action = rowAction('links', link, 'delete'), original = await action.getAttribute('style');
    // Only the fixture's trigger position is varied. The real portal, collision
    // logic, focus and hit testing remain in use; no product stylesheet is changed.
    try {
      for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
        await action.evaluate((element, corner) => {
          Object.assign(element.style, { position: 'fixed', zIndex: '999', left: 'auto', right: 'auto', top: 'auto', bottom: 'auto' });
          element.style[corner.includes('left') ? 'left' : 'right'] = '14px'; element.style[corner.includes('top') ? 'top' : 'bottom'] = '14px';
        }, corner);
        const { popover } = await openConfirmation('links', link); await popoverGeometry(popover, action);
        assert.equal(await popover.getAttribute('data-side'), corner.includes('bottom') ? 'top' : 'bottom');
        await capture('collision-' + corner); await page.keyboard.press('Escape'); await popover.waitFor({ state: 'hidden' });
      }
    } finally { await action.evaluate((element, style) => { if (style === null) element.removeAttribute('style'); else element.setAttribute('style', style); }, original); }
  });
  for (const kind of ['links', 'categories']) await step(`${kind}: a held delete locks dismissal and repeats, then returns focus to the list`, async () => {
    await page.setViewportSize({ width: 1280, height: 720 }); await admin(kind);
    const record = kind === 'links' ? link : category, { popover } = await openConfirmation(kind, record);
    let release, reached; const arrived = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const state = { method: 'DELETE', target: apiURL(relative('/' + kind + '/' + record.id)), kind, id: record.id, attempts: 0, reached, gate };
    assert.ok(!armed); armed = state; const pending = page.waitForResponse(response => response.url() === state.target && response.request().method() === 'DELETE'); pending.catch(() => {});
    try {
      await button(popover, '确认删除', 'Confirm deletion').click(); await within(arrived);
      const busy = button(popover, '正在删除…', 'Deleting…'); await busy.waitFor(); assert.ok(await busy.isDisabled());
      assert.ok(await popover.locator('[data-confirm-cancel]').isDisabled()); assert.equal(await popover.getAttribute('aria-busy'), 'true');
      await page.keyboard.press('Escape'); await page.mouse.click(1, 1); await settle(); assert.ok(await popover.isVisible());
      await busy.evaluate(element => { element.click(); element.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await settle(); assert.equal(state.attempts, 1);
      assert.ok((await navigation()).data[kind].some(item => item.id === record.id), 'A held request has not deleted anything');
      release(); assert.equal((await pending).status(), 204); await popover.waitFor({ state: 'hidden' });
      await focused(button(page.locator('.admin-content-toolbar'), kind === 'links' ? '刷新列表' : '添加分类', kind === 'links' ? 'Refresh list' : 'Add category'));
      assert.equal(state.attempts, 1); assert.ok(!(await navigation()).data[kind].some(item => item.id === record.id));
      await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('.admin-content-toolbar').waitFor();
      assert.ok(!(await navigation()).data[kind].some(item => item.id === record.id)); await protectExisting();
    } finally { release(); armed = null; }
  });
}
async function main() {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'], ignoreDefaultArgs: ['--hide-scrollbars'] }); report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 }); context.setDefaultTimeout(15_000);
  // Observe calls without moving focus ourselves. This distinguishes a stale
  // test handle from focusing a disabled/inert target before React commits.
  await context.addInitScript(() => {
    const original = HTMLElement.prototype.focus;
    window.__modalFixtureFocusCalls = [];
    HTMLElement.prototype.focus = function (...args) {
      const entry = { at: performance.now(), tag: this.tagName, id: this.id, label: this.getAttribute('aria-label'),
        text: this.tagName === 'BUTTON' ? this.textContent?.trim().slice(0, 100) : undefined,
        connected: this.isConnected, inert: !!this.closest('[inert]'), disabled: 'disabled' in this && this.disabled };
      const result = original.apply(this, args); entry.focusedAfterCall = document.activeElement === this;
      window.__modalFixtureFocusCalls.push(entry); if (window.__modalFixtureFocusCalls.length > 80) window.__modalFixtureFocusCalls.shift();
      return result;
    };
  });
  boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken;
  assert.ok(['en', 'zh-CN'].includes(boot.language)); assert.equal(boot.languageSelectionRequired, false);
  const fixtureName = 'Modal layout fixture ' + boot.language;
  if (!boot.initialized) { await api('POST', '/setup', { siteName: fixtureName, mode: 'open_edit', seedDemo: false }, 201); boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken; }
  assert.equal(boot.siteName, fixtureName, 'Refusing to write to an unrelated instance'); assert.equal(boot.mode, 'open_edit'); assert.equal(boot.user, null);
  space = boot.spaces.find(item => item.kind === 'shared'); assert.ok(space?.canEdit);
  originalNavigation = await navigation(); originalPage = await api('GET', relative('/page')); approved = true; report.language = boot.language;
  category = await create('categories', { name: (prefix + ' category Long-category-名称-'.repeat(4)).slice(0, 79), icon: 'lucide:folder', parentId: null, sortOrder: 0 });
  const longPath = 'long-path-segment-'.repeat(95), endpoints = Array.from({ length: 12 }, (_, index) => ({
    label: ('Endpoint ' + (index + 1) + ' long readable label').slice(0, 40), url: 'https://example.invalid/layout/' + run + '/' + index + '/' + longPath,
    ...(index < 2 ? { route: index === 0 ? 'internal' : 'external', probePath: '/favicon.ico' } : {}) }));
  link = await create('links', { title: (prefix + ' long title Long-unbroken-title-名称-'.repeat(8)).slice(0, 159),
    url: 'https://example.invalid/layout/' + run + '/' + longPath, description: ('Long description for testing form scrolling and wrapping. 详细描述用于验证布局。\n').repeat(40).slice(0, 1950),
    categoryId: category.id, icon: 'lucide:container', iconMode: 'manual', tags: ['fixture', run], isFavorite: false, sortOrder: 0, endpoints });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base.origin && !['data:', 'blob:'].includes(url.protocol)) { report.blocked.push({ phase, reason: 'outside fixture origin', origin: url.origin, pathname: url.pathname }); return route.abort('blockedbyclient'); }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      const current = armed; if (current) current.attempts++;
      if (!approved || !current || current.attempts !== 1 || current.method !== request.method() || current.target !== request.url() || !created[current.kind].has(current.id)) {
        report.blocked.push({ phase, reason: 'unexpected or repeated mutation', method: request.method(), pathname: url.pathname });
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'fixture_guard', message: 'Unexpected mutation blocked by the acceptance fixture.' }) });
      }
      report.mutations.push({ phase, method: request.method(), pathname: url.pathname }); current.reached(); await current.gate;
    }
    return route.continue();
  });
  page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push({ phase, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ phase, message: message.text().slice(0, 300) }); });
  if (!popoverOnly) await layoutChecks(); if (!layoutOnly) await popoverChecks();
  await protectExisting(); assert.deepEqual(report.blocked, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
}
async function cleanup() {
  if (!approved || !context || !space) return;
  for (const kind of ['links', 'categories']) for (const [id, own] of [...created[kind]].reverse()) {
    const current = (await navigation()).data[kind].find(item => item.id === id); if (!current) continue;
    assert.equal(current.title || current.name, own.title || own.name); assert.ok((current.title || current.name).startsWith(prefix));
    await api('DELETE', relative('/' + kind + '/' + id), undefined, 204); report.cleanup.push({ kind, id, status: 'deleted' });
  }
  assert.deepEqual(records(await navigation()), records(originalNavigation)); assert.deepEqual(await api('GET', relative('/page')), originalPage);
}
(async () => {
  try { await main(); report.status = 'passed'; }
  catch (error) { report.status = 'failed'; report.failure = { phase, message: error.message, stack: error.stack }; process.exitCode = 1; await capture('failure').catch(() => {}); }
  finally {
    try { await cleanup(); } catch (error) { report.status = 'failed'; report.cleanupError = error.message; process.exitCode = 1; }
    await browser?.close(); report.finishedAt = new Date().toISOString(); const file = path.join(out, 'report.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, language: report.language, scope: report.scope, checks: report.checks.length, report: file, failure: report.failure?.message, cleanupError: report.cleanupError }));
  }
})();
