#!/usr/bin/env node
'use strict';
// Run only against this task's disposable, ownerless icon fixtures:
// BASE_URL=http://127.0.0.1:5210 node tests/browser_category_icons.cjs --allow-fixture-write
// Use 5211 for an instance started with --language en. The script creates no account,
// changes no existing navigation, and cleans up only IDs created by this run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');

const base = new URL(process.env.BASE_URL || '');
assert.ok(process.argv.includes('--allow-fixture-write'), 'Pass --allow-fixture-write for the disposable icon fixture');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', '10.233.233.61'].includes(base.hostname)
  && ['5210', '5211'].includes(base.port) && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password,
  'Only dedicated icon fixture ports 5210/5211 are allowed');
const run = randomUUID().slice(0, 8), prefix = 'Category icons ' + run;
const out = path.resolve(process.env.OUTPUT_DIR || path.join(require('node:os').tmpdir(), 'category-icons-' + base.port + '-' + run));
fs.mkdirSync(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), origin: base.origin, run, checks: [], screenshots: [], pageErrors: [], consoleErrors: [], externalRequests: [], cleanup: [] };
let browser, context, page, boot, csrf, space, manifest, originalNavigation, originalPage, phase = 'preflight', approved = false;
const createdCategories = new Map(), createdLinks = new Map();
const l = (zh, en) => boot.language === 'en' ? en : zh;
const button = (scope, zh, en) => scope.getByRole('button', { name: l(zh, en), exact: true });
const search = picker => picker.getByRole('searchbox', { name: l('搜索图标', 'Search icons'), exact: true });
const groupControl = picker => picker.getByRole('combobox', { name: l('图标分组', 'Icon group'), exact: true });
const gridButtons = picker => picker.locator('.lh-icon-picker-grid.is-labelled > button');
const iconButton = (picker, name) => picker.locator(`.lh-icon-picker-grid.is-labelled > button:has(img[src="/icons/lucide/${name}.svg"])`);
const relative = suffix => '/spaces/' + space.id + suffix;
const records = nav => ({ categories: [...nav.data.categories].sort((a, b) => a.id.localeCompare(b.id)), links: [...nav.data.links].sort((a, b) => a.id.localeCompare(b.id)) });

async function api(method, suffix, data, expected = 200) {
  const response = await context.request.fetch(base.origin + '/api/v1' + suffix, {
    method, data, headers: { 'X-CSRF-TOKEN': csrf || '' }, maxRedirects: 0, timeout: 15_000,
  });
  assert.equal(response.status(), expected, `${method} ${suffix}: unexpected status ${response.status()}`);
  return expected === 204 ? null : response.json();
}
const readNavigation = () => api('GET', relative('/navigation'));
async function step(name, action) {
  phase = name; console.log(JSON.stringify({ event: 'step', name }));
  const start = Date.now(); await action(); report.checks.push({ name, status: 'passed', durationMs: Date.now() - start });
}
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function capture(name) {
  await settle(); const file = path.join(out, boot.language + '-' + name + '.png');
  await page.screenshot({ path: file, fullPage: false }); report.screenshots.push(file);
}
async function admin(tab = 'categories') {
  await page.goto(base.origin + '/#/admin?tab=' + tab, { waitUntil: 'domcontentloaded' });
  await page.locator('.admin-content-toolbar').waitFor();
}
async function addCategory(name) {
  await button(page, '添加分类', 'Add category').click();
  const dialog = page.getByRole('dialog', { name: l('添加分类', 'Add category'), exact: true });
  await dialog.getByLabel(l('分类名称', 'Category name'), { exact: true }).fill(name);
  return dialog;
}
async function editCategory(record) {
  await button(page, '编辑分类 ' + record.name, 'Edit category ' + record.name).click();
  const dialog = page.getByRole('dialog', { name: l('编辑分类', 'Edit category'), exact: true });
  await dialog.waitFor(); return dialog;
}
async function chooseGroup(picker, id, keyboard = false) {
  const group = manifest.groups.find(item => item.id === id);
  const label = id === 'all' ? l(`全部图标（${manifest.icons.length}）`, `All icons (${manifest.icons.length})`)
    : l(group.label, group.labelEn) + ` (${manifest.icons.filter(icon => icon.group === id).length})`;
  const control = groupControl(picker);
  if (keyboard) { await control.focus(); await control.press('Enter'); }
  else await control.click();
  await page.getByRole('option', { name: label, exact: true }).click();
  await settle(); assert.equal((await control.innerText()).trim(), label);
}
async function selectedIcon(picker, name) {
  const selector = '.lh-icon-picker-current img';
  await picker.locator(selector).waitFor();
  await page.waitForFunction(({ selector, src }) => {
    const image = document.querySelector(selector);
    return image && image.getAttribute('src') === src && image.complete && image.naturalWidth > 0;
  }, { selector, src: '/icons/lucide/' + name + '.svg' });
}
async function selectIcon(picker, query, name, keyboard = false) {
  await search(picker).fill(query);
  const choice = iconButton(picker, name); await choice.waitFor();
  if (keyboard) { await choice.focus(); await choice.press('Enter'); } else await choice.click();
  assert.equal(await choice.getAttribute('aria-pressed'), 'true'); await selectedIcon(picker, name);
}
async function save(dialog, kind, method, id) {
  const pathname = '/api/v1' + relative('/' + kind + (id ? '/' + id : ''));
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === method);
  await button(dialog, kind === 'categories' ? '保存分类' : '保存链接', kind === 'categories' ? 'Save category' : 'Save link').click();
  const response = await pending; assert.equal(response.status(), method === 'POST' ? 201 : 200);
  const record = await response.json();
  assert.match(record.id, /^[0-9a-f]{32}$/);
  assert.ok((kind === 'categories' ? record.name : record.title).startsWith(prefix));
  if (method === 'POST') (kind === 'categories' ? createdCategories : createdLinks).set(record.id, record);
  await dialog.waitFor({ state: 'hidden' }); return record;
}
async function expectBuiltinIcon(row, icon) {
  const assetPath = '/icons/lucide/' + icon + '.svg';
  const mask = row.locator(`span.admin-mask-icon[style*="${assetPath}"]`).first();
  await mask.waitFor({ state: 'visible' });
  const rendered = await mask.evaluate(element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return { maskImage: style.maskImage || style.webkitMaskImage, width: rect.width, height: rect.height };
  });
  assert.ok(rendered.maskImage.includes(assetPath), `Saved ${icon} uses the expected CSS mask resource`);
  assert.ok(rendered.width > 0 && rendered.height > 0, `Saved ${icon} has visible geometry`);
}
async function expectSavedCategory(record, icon) {
  assert.equal(record.icon, 'lucide:' + icon, 'Save response contains the selected icon');
  await page.reload({ waitUntil: 'domcontentloaded' });
  const row = page.locator('.admin-categories-table tbody tr').filter({ hasText: record.name }); await row.waitFor();
  await expectBuiltinIcon(row, icon);
  const actual = (await readNavigation()).data.categories.find(item => item.id === record.id);
  assert.equal(actual?.icon, 'lucide:' + icon); return actual;
}

async function main() {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'], ignoreDefaultArgs: ['--hide-scrollbars'] });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 });
  context.setDefaultTimeout(15_000);
  boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken;
  assert.ok(['en', 'zh-CN'].includes(boot.language));
  assert.equal(boot.languageSelectionRequired, false, 'Start the fixture with an explicit --language');
  const fixtureName = 'Category icon fixture ' + boot.language;
  if (!boot.initialized) {
    await api('POST', '/setup', { siteName: fixtureName, mode: 'open_edit', seedDemo: false }, 201);
    boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken;
  }
  assert.equal(boot.siteName, fixtureName, 'Refusing to write to an unrelated instance');
  assert.equal(boot.mode, 'open_edit'); assert.equal(boot.user, null);
  space = boot.spaces.find(item => item.kind === 'shared'); assert.ok(space?.canEdit);
  originalNavigation = await readNavigation(); originalPage = await api('GET', relative('/page')); approved = true;
  report.language = boot.language;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base.origin && !['data:', 'blob:'].includes(url.protocol)) {
      report.externalRequests.push({ method: route.request().method(), origin: url.origin, pathname: url.pathname });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push({ phase, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ phase, message: message.text().slice(0, 300) }); });
  await admin();

  await step('120 manifest icons have matching local SVG responses and browser decoding', async () => {
    const response = await context.request.get(base.origin + '/icons/manifest.json'); assert.equal(response.status(), 200);
    manifest = await response.json(); assert.equal(manifest.icons.length, 120); assert.equal(manifest.groups.length, 8);
    assert.equal(new Set(manifest.icons.map(icon => icon.id)).size, 120);
    for (let offset = 0; offset < manifest.icons.length; offset += 8) {
      await Promise.all(manifest.icons.slice(offset, offset + 8).map(async icon => {
        const result = await context.request.get(base.origin + '/icons/' + icon.file);
        assert.equal(result.status(), 200, icon.id); assert.match(result.headers()['content-type'], /image\/svg\+xml/);
        const body = await result.body(); assert.equal(createHash('sha256').update(body).digest('hex'), icon.sha256, icon.id);
      }));
    }
    const decoded = await page.evaluate(async paths => Promise.all(paths.map(src => new Promise(resolve => {
      const image = new Image(); image.onload = () => resolve({ src, ok: image.naturalWidth > 0 && image.naturalHeight > 0 });
      image.onerror = () => resolve({ src, ok: false }); image.src = src;
    }))), manifest.icons.map(icon => '/icons/' + icon.file));
    assert.ok(decoded.every(image => image.ok), 'Every SVG must decode as an actual browser image'); report.decodedIcons = decoded.length;
  });

  let category, legacy, link, dialog = await addCategory(prefix + ' AI');
  let picker = dialog.locator('.lh-icon-picker');
  await step('all five pages expose 24 icons each and all eight groups match the catalog', async () => {
    const ids = [];
    for (let index = 0; index < 5; index++) {
      assert.equal(await gridButtons(picker).count(), 24);
      ids.push(...await picker.locator('.lh-icon-picker-grid.is-labelled img').evaluateAll(images => images.map(image => image.getAttribute('src'))));
      if (index < 4) await button(picker, '下一页图标', 'Next icon page').click();
    }
    assert.equal(new Set(ids).size, 120); assert.equal(await button(picker, '下一页图标', 'Next icon page').isDisabled(), true);
    for (const group of manifest.groups) {
      await chooseGroup(picker, group.id);
      const expected = manifest.icons.filter(icon => icon.group === group.id);
      assert.equal(await gridButtons(picker).count(), expected.length);
      const actual = await gridButtons(picker).evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
      assert.deepEqual(actual, expected.map(icon => l(icon.label, icon.labelEn)));
      if (group.id === 'ai' || group.id === 'infrastructure') await capture('group-' + group.id + '-2560x1440');
    }
  });
  await step('bilingual aliases, case, full-width input and technical ID searches work across groups', async () => {
    for (const [query, name] of [['NAS', 'hard-drive'], ['  nAs  ', 'hard-drive'], ['ＮＡＳ', 'hard-drive'], ['docker', 'container'],
      ['AI', 'bot'], ['知识', 'book-open'], ['knowledge', 'library'], ['VIDEO', 'video'], ['hard_drive', 'hard-drive'], ['lucide:bot', 'bot']]) {
      await search(picker).fill(query); await iconButton(picker, name).waitFor();
      assert.equal((await groupControl(picker).innerText()).trim(), l('全部图标（120）', 'All icons (120)'));
    }
    await search(picker).fill('AI'); assert.equal(await iconButton(picker, 'mail').count(), 0, 'AI must not match mail');
    await search(picker).fill('art');
    assert.equal(await iconButton(picker, 'shopping-cart').count(), 0, 'art must not match the middle of cart');
    assert.equal(await iconButton(picker, 'heart-pulse').count(), 0, 'art must not match the middle of heart');
    await search(picker).fill('work');
    assert.equal(await iconButton(picker, 'network').count(), 0, 'work must not match the middle of network');
    await iconButton(picker, 'workflow').waitFor();
    await chooseGroup(picker, 'work'); assert.equal(await search(picker).inputValue(), '');
    await search(picker).fill('no-icon-' + run); assert.equal(await gridButtons(picker).count(), 0);
    assert.ok(await picker.getByText(l('没有匹配的图标，试试其他关键词或清空搜索。', 'No matching icons. Try another keyword or clear the search.'), { exact: true }).isVisible());
    await button(picker, '清空图标搜索', 'Clear icon search').click();
    assert.equal(await search(picker).inputValue(), ''); assert.equal(await gridButtons(picker).count(), 24);
    assert.ok(await search(picker).evaluate(node => node === document.activeElement));
  });
  await step('paging, group changes and searches reset the bounded icon grid scroll', async () => {
    await chooseGroup(picker, 'all');
    const grid = picker.locator('.lh-icon-picker-grid.is-labelled'), previousStyle = await grid.getAttribute('style');
    await grid.evaluate(element => { element.style.maxHeight = '70px'; });
    const scrollDown = async () => {
      await grid.evaluate(element => { element.scrollTop = element.scrollHeight; });
      assert.ok(await grid.evaluate(element => element.scrollTop > 0), 'The fixture must really scroll');
    };
    const reset = async () => { await settle(); assert.equal(await grid.evaluate(element => element.scrollTop), 0); };
    try {
      await scrollDown(); await button(picker, '下一页图标', 'Next icon page').click(); await reset();
      await scrollDown(); await chooseGroup(picker, 'infrastructure'); await reset();
      await scrollDown(); await search(picker).fill('AI'); await reset();
    } finally {
      await grid.evaluate((element, previous) => { if (previous === null) element.removeAttribute('style'); else element.setAttribute('style', previous); }, previousStyle);
    }
  });
  await step('hover and keyboard focus display complete icon names', async () => {
    await chooseGroup(picker, 'ai'); await search(picker).focus();
    const label = picker.locator('.lh-icon-picker-full-label');
    await iconButton(picker, 'bot').hover(); await settle();
    const bot = manifest.icons.find(icon => icon.id === 'lucide:bot');
    assert.equal(await label.innerText(), l(bot.label, bot.labelEn)); assert.ok(await label.isVisible());
    await iconButton(picker, 'brain-circuit').focus(); await settle();
    const brain = manifest.icons.find(icon => icon.id === 'lucide:brain-circuit');
    assert.equal(await label.innerText(), l(brain.label, brain.labelEn)); assert.ok(await label.isVisible());
  });
  await step('keyboard controls select a new icon without submitting the category form', async () => {
    await chooseGroup(picker, 'ai', true);
    const control = groupControl(picker); await control.focus(); await control.press('Enter');
    await page.getByRole('listbox').waitFor(); await page.keyboard.press('Escape'); await settle();
    assert.ok(await control.evaluate(node => node === document.activeElement));
    await search(picker).fill('bot'); await search(picker).press('Enter'); assert.ok(await dialog.isVisible());
    assert.equal((await readNavigation()).data.categories.length, originalNavigation.data.categories.length);
    await selectIcon(picker, 'bot', 'bot', true);
  });
  await step('new AI category saves through the UI and survives a full page reload', async () => {
    category = await save(dialog, 'categories', 'POST'); assert.equal(category.icon, 'lucide:bot');
    category = await expectSavedCategory(category, 'bot');
  });
  await step('editing to a NAS icon persists while the legacy folder icon remains usable', async () => {
    dialog = await editCategory(category); picker = dialog.locator('.lh-icon-picker');
    await selectedIcon(picker, 'bot'); await selectIcon(picker, 'NAS', 'hard-drive');
    category = await save(dialog, 'categories', 'PUT', category.id); category = await expectSavedCategory(category, 'hard-drive');
    dialog = await addCategory(prefix + ' legacy'); picker = dialog.locator('.lh-icon-picker');
    await selectedIcon(picker, 'folder'); legacy = await save(dialog, 'categories', 'POST');
    assert.equal(legacy.icon, 'lucide:folder'); await expectSavedCategory(legacy, 'folder');
  });
  await step('category picker and save controls remain reachable at four desktop viewports', async () => {
    dialog = await editCategory(category); picker = dialog.locator('.lh-icon-picker');
    await chooseGroup(picker, 'infrastructure');
    for (const [width, height] of [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080]]) {
      await page.setViewportSize({ width, height }); await settle();
      await groupControl(picker).scrollIntoViewIfNeeded();
      const geometry = await dialog.evaluate(element => {
        const r = element.getBoundingClientRect(), grid = element.querySelector('.lh-icon-picker-grid.is-labelled');
        return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
          x: r.x, y: r.y, right: r.right, bottom: r.bottom, gridWidth: grid.clientWidth, gridScrollWidth: grid.scrollWidth, gridHeight: grid.clientHeight };
      });
      assert.ok(geometry.documentWidth <= width + 1 && geometry.x >= -1 && geometry.right <= width + 1, 'No horizontal overflow');
      assert.ok(geometry.y >= -1 && geometry.bottom <= height + 1, 'Dialog fits the viewport');
      assert.ok(geometry.gridScrollWidth <= geometry.gridWidth + 1 && geometry.gridHeight <= 265, 'Grid is bounded');
      const saveButton = button(dialog, '保存分类', 'Save category'); await saveButton.click({ trial: true });
      const box = await saveButton.boundingBox(); assert.ok(box && box.y >= 0 && box.y + box.height <= height + 1, 'Save can be reached by scrolling');
      report.checks.push({ name: `viewport ${width}x${height}`, status: 'passed', geometry });
      await capture(`picker-${width}x${height}`);
    }
    category = await save(dialog, 'categories', 'PUT', category.id); await expectSavedCategory(category, 'hard-drive');
  });
  await step('link editor uses the same container icon and persists manual selection', async () => {
    await page.setViewportSize({ width: 2560, height: 1440 }); await admin('links');
    await button(page, '添加链接', 'Add link').click();
    dialog = page.getByRole('dialog', { name: l('添加链接', 'Add link'), exact: true }); picker = dialog.locator('.lh-icon-picker');
    await dialog.getByLabel(l('链接名称', 'Link name'), { exact: true }).fill(prefix + ' container');
    await dialog.getByLabel(l('主入口 URL', 'Primary URL'), { exact: true }).fill('https://example.invalid/category-icons-' + run);
    await selectIcon(picker, 'docker', 'container');
    assert.equal(await button(picker, '手动选择', 'Manual selection').getAttribute('aria-pressed'), 'true');
    link = await save(dialog, 'links', 'POST'); assert.equal(link.icon, 'lucide:container'); assert.equal(link.iconMode, 'manual');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const row = page.locator('.admin-links-table tbody tr').filter({ hasText: link.title }); await row.waitFor();
    await expectBuiltinIcon(row, 'container');
    const saved = (await readNavigation()).data.links.find(item => item.id === link.id);
    assert.equal(saved?.icon, 'lucide:container'); assert.equal(saved?.iconMode, 'manual'); await capture('manual-link-icon-2560x1440');
  });
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.externalRequests, []);
}

async function cleanup() {
  if (!approved || !context || !space) return;
  for (const [kind, created] of [['links', createdLinks], ['categories', createdCategories]]) {
    for (const [id, own] of [...created].reverse()) {
      const nav = await readNavigation(), actual = nav.data[kind].find(item => item.id === id);
      if (!actual) continue;
      const name = kind === 'links' ? 'title' : 'name';
      assert.equal(actual[name], own[name], 'Only this run’s unchanged identity may be cleaned up');
      assert.ok(actual[name].startsWith(prefix));
      await api('DELETE', relative('/' + kind + '/' + id), undefined, 204); report.cleanup.push({ kind, id, status: 'deleted' });
    }
  }
  assert.deepEqual(records(await readNavigation()), records(originalNavigation), 'All pre-existing navigation is preserved');
  assert.deepEqual(await api('GET', relative('/page')), originalPage, 'The homepage and its revision are preserved');
}

(async () => {
  try { await main(); report.status = 'passed'; }
  catch (error) { report.status = 'failed'; report.failure = { phase, message: error.message, stack: error.stack }; process.exitCode = 1; await capture('failure').catch(() => {}); }
  finally {
    try { await cleanup(); } catch (error) { report.status = 'failed'; report.cleanupError = error.message; process.exitCode = 1; }
    await browser?.close(); report.finishedAt = new Date().toISOString();
    const file = path.join(out, 'report.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, language: report.language, checks: report.checks.length, decodedIcons: report.decodedIcons || 0, report: file, failure: report.failure?.message, cleanupError: report.cleanupError }));
  }
})();
