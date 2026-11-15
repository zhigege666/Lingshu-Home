#!/usr/bin/env node
'use strict';
// Run only against a fresh, owned, disposable loopback UI fixture.
// Existing short-ID tests cover create/recovery contracts; this suite exercises
// the changed item container, save-and-close path and return to the board.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'Owned fixture and output are required');
const provider = process.env.UI_PROVIDER || 'sqlite';
const fixture = JSON.parse(fs.readFileSync(process.env.UI_FIXTURES, 'utf8'))[provider];
assert(fixture, 'Requested fixture provider is missing');
const base = new URL(fixture.url), output = path.resolve(process.env.OUTPUT_DIR);
assert(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname) && !base.username && !base.password, 'Only disposable loopback fixtures');
const origin = base.origin, work = '/spaces/' + fixture.shared + '/work', prefix = 'Dialog-' + crypto.randomBytes(4).toString('hex');
const report = { passed: false, provider, checks: [], skipped: [], screenshots: [], errors: [], startedAt: new Date().toISOString() };
const checkMatch = process.env.UI_CHECK_MATCH ? new RegExp(process.env.UI_CHECK_MATCH) : null;
const checkSkip = process.env.UI_CHECK_SKIP_MATCH ? new RegExp(process.env.UI_CHECK_SKIP_MATCH) : null;
const secrets = [fixture.username, fixture.password].filter(Boolean);
const scrub = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));
let browser, context, page, language, project, item;
const t = (zh, en) => language === 'en' ? en : zh;
const detail = () => page.locator('[data-work-detail-id]');
const modal = () => page.locator('.work-item-dialog');
const button = (zh, en, scope = detail()) => scope.getByRole('button', { name: t(zh, en), exact: true });
const label = (zh, en) => detail().getByLabel(t(zh, en), { exact: true });
const card = (id = item.id) => page.locator('[data-work-id="' + id + '"]');
const titleButton = (id = item.id) => card(id).locator('.work-card-title, .work-list-title');
const boardURL = origin + '/#/library?view=board&space=' + fixture.shared;
const projectURL = (layout = 'board') => boardURL + '&projectId=' + project.id + '&layout=' + layout;
const newID = () => crypto.randomBytes(16).toString('hex');
async function boot() {
  const response = await context.request.get(origin + '/api/v1/bootstrap');
  assert(response.ok(), 'Fixture bootstrap responds');
  return response.json();
}
async function api(suffix, method = 'GET', data, expected = 200) {
  const state = await boot();
  const response = await context.request.fetch(origin + '/api/v1' + suffix, {
    method, data, headers: { Origin: origin, 'X-CSRF-TOKEN': state.csrfToken }, maxRedirects: 0
  });
  assert.equal(response.status(), expected, method + ' ' + suffix + ': ' + scrub(await response.text()));
  return response.json();
}
async function check(name, run) {
  if ((checkMatch && !checkMatch.test(name)) || (checkSkip && checkSkip.test(name))) {
    report.skipped.push(name); console.log('SKIP ' + name); return;
  }
  const start = Date.now();
  try { await run(); report.checks.push({ name, passed: true, ms: Date.now() - start }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: scrub(error.message) }); throw error; }
}
async function shot(name) {
  const filename = provider + '-' + name + '.png';
  await page.screenshot({ path: path.join(output, filename), animations: 'disabled' });
  report.screenshots.push(filename);
}
async function board(projectOnly = true, layout = 'board') {
  await page.goto(projectOnly ? projectURL(layout) : boardURL + '&q=' + encodeURIComponent(prefix), { waitUntil: 'domcontentloaded' });
  if (layout === 'calendar') await page.locator('[data-calendar-item="' + item.id + '"]').waitFor();
  else await titleButton().waitFor();
}
async function openItem(useKeyboard = false) {
  await titleButton().scrollIntoViewIfNeeded();
  const position = await boardPosition();
  if (useKeyboard) { await titleButton().focus(); await page.keyboard.press('Enter'); }
  else await titleButton().click();
  await detail().locator('[data-work-title]').waitFor();
  assert.equal(await detail().getAttribute('data-work-detail-id'), item.id);
  return position;
}
async function closeItem() {
  await button('关闭事项', 'Close item').click();
  await modal().waitFor({ state: 'hidden' });
}
async function boardPosition() {
  return page.evaluate(id => {
    const board = document.querySelector('.work-board'), card = document.querySelector('[data-work-id="' + id + '"]');
    const lane = card && card.closest('.work-lane-body'), rect = board && board.getBoundingClientRect();
    return { left: rect?.left, width: rect?.width, scrollLeft: board?.scrollLeft, laneScroll: lane?.scrollTop };
  }, item.id);
}
async function assertReturned(position) {
  await page.waitForFunction(id => {
    const active = document.activeElement;
    return active?.closest('[data-work-id]')?.getAttribute('data-work-id') === id;
  }, item.id);
  assert.equal(await page.locator('.work-card.selected').count(), 0, 'Closed item leaves no stale selected card');
  const returned = await boardPosition();
  for (const key of ['left', 'width', 'scrollLeft', 'laneScroll']) {
    if (position[key] !== undefined) assert(Math.abs(returned[key] - position[key]) <= 1, 'Closing retains board ' + key);
  }
}
async function save(action, expected = 200) {
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1' + work + '/items/' + item.id && response.request().method() === 'PATCH');
  await action();
  const response = await waiting;
  assert.equal(response.status(), expected);
  return response.json();
}
async function inlineID() {
  await titleButton().scrollIntoViewIfNeeded();
  const value = await card().evaluate(element => {
    const title = element.querySelector('.work-card-title, .work-list-title'), id = title?.querySelector('.work-item-id');
    if (!title || !id) return null;
    const walk = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
    let text;
    while (walk.nextNode()) {
      if (walk.currentNode.textContent.trim() && !id.contains(walk.currentNode)) { text = walk.currentNode; break; }
    }
    const range = document.createRange();
    if (text) { const first = text.textContent.search(/\S/); range.setStart(text, first); range.setEnd(text, first + 1); }
    const rect = node => { const value = node.getBoundingClientRect(); return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }; };
    const lane = element.closest('.work-lane-body');
    const summary = element.querySelector('.work-planning-summary');
    return {
      code: rect(id), glyph: text && rect(range), title: rect(title), card: rect(element),
      viewport: { width: innerWidth, height: innerHeight },
      lane: lane && { ...rect(lane), scrollTop: lane.scrollTop }, titleText: title.textContent,
      idCount: element.querySelectorAll('.work-item-id').length,
      summaryID: !!summary?.querySelector('.work-item-id'),
      emptySummaryHeight: summary && !summary.textContent.trim() ? summary.getBoundingClientRect().height : 0
    };
  });
  const evidence = JSON.stringify(value);
  assert(value && value.glyph, 'ID and actual title text are inside the opening control: ' + evidence);
  assert.equal(value.idCount, 1, 'ID appears once per card or row');
  assert.equal(value.summaryID, false, 'ID no longer occupies the metadata row');
  assert.equal(value.emptySummaryHeight, 0, 'Unused metadata does not reserve a blank row');
  assert(value.code.right <= value.glyph.left + 1, 'ID precedes the title: ' + evidence);
  assert(value.code.top < value.glyph.bottom && value.glyph.top < value.code.bottom, 'ID and first title glyph share a line: ' + evidence);
}
async function geometry(width, height, position) {
  const value = await modal().evaluate(element => {
    const rect = node => { const value = node.getBoundingClientRect(); return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height }; };
    return {
      dialog: rect(element), header: rect(element.querySelector('.work-detail-heading')), footer: rect(element.querySelector('.work-detail-footer')),
      controls: [...element.querySelectorAll('.work-detail-heading button, .work-detail-footer button')].filter(node => node.getClientRects().length).map(rect),
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
    };
  });
  assert.equal(await modal().getAttribute('role'), 'dialog');
  assert.equal(await modal().getAttribute('aria-modal'), 'true');
  assert(await modal().evaluate(element => {
    const labels = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return labels.length > 0 && labels.every(id => document.getElementById(id)?.textContent.trim());
  }), 'Dialog accessible title resolves to an existing, nonempty element');
  assert.equal(await page.locator('.work-drawer, aside[data-work-detail-id]').count(), 0, 'No right-side drawer or wide-screen aside');
  assert(Math.abs((value.dialog.left + value.dialog.right) / 2 - width / 2) <= 2, 'Dialog is horizontally centered');
  assert(Math.abs((value.dialog.top + value.dialog.bottom) / 2 - height / 2) <= 2, 'Dialog is vertically centered');
  assert(value.dialog.left >= 16 && value.dialog.right <= width - 16, 'Normal dialog leaves background on both sides');
  assert(value.overflow <= width + 1, 'No document horizontal overflow');
  for (const rect of [value.dialog, value.header, value.footer, ...value.controls]) assert(rect.left >= 0 && rect.top >= 0 && rect.right <= width + 1 && rect.bottom <= height + 1, 'Dialog and actions fit the viewport');
  assert(Math.abs(value.footer.bottom - value.dialog.bottom) <= 3, 'Save controls stay at the dialog bottom');
  const behind = await boardPosition();
  for (const key of ['left', 'width', 'scrollLeft', 'laneScroll']) assert(Math.abs(behind[key] - position[key]) <= 1, 'Opening does not alter board ' + key);
  await detail().locator('.work-detail-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
  const after = await detail().locator('.work-detail-footer').boundingBox();
  assert(Math.abs(after.y + after.height - value.footer.bottom) <= 1, 'Body scroll keeps footer visible');
  await detail().locator('.work-detail-body').evaluate(element => { element.scrollTop = 0; });
  await shot('work-dialog-' + width + 'x' + height);
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(scrub(error.message)));
  await api('/auth/login', 'POST', { username: fixture.username, password: fixture.password, sessionMode: 'temporary' });
  const initial = await boot();
  assert.equal(initial.siteName, 'Release UI fixture ' + provider, 'Owned fixture guard'); language = initial.language;
  const catalog = await api(work + '/statuses'), status = catalog.items.find(value => value.type === 'todo')?.id || catalog.defaultStatus;
  assert(status, 'Fixture has a current todo/default status');
  project = await api(work + '/projects', 'POST', { id: newID(), name: prefix + ' project' });
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  for (let index = 0; index < 18; index++) {
    const created = await api(work + '/items', 'POST', {
      requestId: newID(), projectId: project.id, status, businessDate: today,
      title: prefix + ' ' + String(index + 1).padStart(2, '0') + ' winning-webui-clinical-order：表格选择值与事项编辑交互验证',
      nextStep: '保留看板列位置，打开事项，修改内容后返回同一张卡片。',
      description: '这是独立测试数据。核对长标题、内容滚动、草稿、保存和关闭行为。\n'.repeat(12)
    });
    if (index === 10) item = created;
  }
  await check('compact_card_id_and_project_context', async () => {
    await board(); await inlineID();
    assert.equal(await card().locator('.work-project-badge').count(), 0, 'Single-project board omits redundant project badges');
    await shot('work-board-compact-2560x1440');
    await board(false); await inlineID();
    assert.equal((await card().locator('.work-project-badge').textContent()).trim(), project.name, 'Cross-project board retains project identity');
    await board();
  });
  await check('centered_dialog_four_sizes_preserves_board_and_focus', async () => {
    await board();
    for (const [width, height] of [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080]]) {
      await page.setViewportSize({ width, height });
      await inlineID();
      const before = await openItem(width === 2560 && height === 1440);
      await geometry(width, height, before);
      await page.keyboard.press('Escape'); await modal().waitFor({ state: 'hidden' });
      await assertReturned(before);
    }
    await page.setViewportSize({ width: 2560, height: 1440 });
  });
  await check('modal_focus_wrap_maximize_and_dirty_close', async () => {
    await board();
    const before = await openItem();
    await modal().evaluate(element => {
      const controls = [...element.querySelectorAll('button, input, textarea, select, a[href], [tabindex]')].filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
      controls.at(-1).focus();
    });
    await page.keyboard.press('Tab');
    assert(await modal().evaluate(element => element.contains(document.activeElement)), 'Tab wraps inside modal');
    await page.keyboard.press('Shift+Tab');
    assert(await modal().evaluate(element => element.contains(document.activeElement)), 'Shift+Tab wraps inside modal');
    const text = '尚未保存的弹窗草稿 ' + prefix;
    await label('说明', 'Description').fill(text);
    const normal = await modal().boundingBox();
    await detail().locator('[data-work-maximize]').click();
    assert.equal(await detail().locator('[data-work-maximize]').getAttribute('aria-pressed'), 'true');
    const expanded = await modal().boundingBox(); assert(expanded.width > normal.width && expanded.height >= normal.height, 'Maximize uses more available space');
    assert.equal(await label('说明', 'Description').inputValue(), text, 'Maximize preserves draft');
    await shot('work-dialog-maximized-2560x1440');
    await detail().locator('[data-work-maximize]').click();
    assert.equal(await detail().locator('[data-work-maximize]').getAttribute('aria-pressed'), 'false');
    const restored = await modal().boundingBox(); assert(Math.abs(restored.width - normal.width) <= 1, 'Restore returns normal width');
    await page.keyboard.press('Escape');
    const discard = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: t('放弃修改', 'Discard changes'), exact: true }) });
    await button('继续编辑', 'Keep editing', discard).click();
    assert.equal(await label('说明', 'Description').inputValue(), text, 'Keep editing retains draft');
    await button('关闭事项', 'Close item').click();
    await button('放弃修改', 'Discard changes', discard).click();
    await modal().waitFor({ state: 'hidden' }); await assertReturned(before);
    assert.notEqual((await api(work + '/items/' + item.id)).description, text, 'Discard never writes the draft');
  });
  await check('save_stays_and_save_close_returns_after_confirmed_write', async () => {
    await board();
    await openItem();
    const savedText = prefix + ' saved and open';
    await label('下一步', 'Next step').fill(savedText);
    await save(() => button('保存事项', 'Save item').click());
    await page.waitForFunction(() => !document.querySelector('[data-work-title]')?.matches(':disabled'));
    assert.equal(await modal().count(), 1, 'Save keeps the editor open');
    assert.equal((await api(work + '/items/' + item.id)).nextStep, savedText);
    const closedText = prefix + ' saved and closed';
    await label('下一步', 'Next step').fill(closedText);
    await save(() => detail().locator('[data-work-save-close]').click());
    await modal().waitFor({ state: 'hidden' });
    assert.equal((await api(work + '/items/' + item.id)).nextStep, closedText);
    await titleButton().waitFor();
    await page.waitForFunction(id => document.activeElement?.closest('[data-work-id]')?.getAttribute('data-work-id') === id, item.id);
    const destination = catalog.items.find(value => value.type === 'doing');
    assert(destination && destination.id !== item.status, 'Fixture provides a different destination status');
    await openItem();
    await label('状态', 'Status').click();
    await page.getByRole('option', { name: destination.name, exact: true }).click();
    await save(() => detail().locator('[data-work-save-close]').click());
    await modal().waitFor({ state: 'hidden' });
    await page.locator('section[data-work-status="' + destination.id + '"] [data-work-id="' + item.id + '"]').waitFor();
    await page.waitForFunction(id => document.activeElement?.closest('[data-work-id]')?.getAttribute('data-work-id') === id, item.id);
    assert.equal((await api(work + '/items/' + item.id)).status, destination.id, 'Saved status is reflected in the destination column');
  });
  await check('save_shortcuts_and_list_calendar_use_same_modal', async () => {
    await board(true, 'list'); await inlineID(); await openItem();
    await label('下一步', 'Next step').fill(prefix + ' Ctrl-S');
    await save(() => page.keyboard.press('Control+s'));
    assert.equal(await modal().count(), 1, 'Ctrl+S keeps the editor open');
    await label('下一步', 'Next step').fill(prefix + ' Ctrl-Enter');
    await save(() => page.keyboard.press('Control+Enter'));
    await modal().waitFor({ state: 'hidden' });
    assert.equal((await api(work + '/items/' + item.id)).nextStep, prefix + ' Ctrl-Enter');
    await board(true, 'calendar');
    await page.locator('[data-calendar-item="' + item.id + '"]').click();
    await detail().locator('[data-work-title]').waitFor();
    assert.equal(await modal().getAttribute('aria-modal'), 'true', 'Calendar uses the same modal');
    await closeItem(); await board();
  });
  await check('save_close_conflict_preserves_draft_without_closing', async () => {
    await board();
    await openItem();
    const draft = prefix + ' conflicting local draft', remote = prefix + ' newer remote title';
    await label('事项标题', 'Item title').fill(draft);
    const latest = await api(work + '/items/' + item.id);
    await api(work + '/items/' + item.id, 'PATCH', { expectedRevision: latest.revision, title: remote });
    await save(() => detail().locator('[data-work-save-close]').click(), 409);
    assert.equal(await modal().count(), 1, 'Conflict keeps modal open');
    assert.equal(await label('事项标题', 'Item title').inputValue(), draft, 'Conflict keeps local title');
    assert.equal((await api(work + '/items/' + item.id)).title, remote, 'Conflict does not overwrite remote title');
    await button('读取最新版本', 'Read latest version').click();
    await button('使用最新版本', 'Use latest version').click();
    await closeItem();
  });
  await check('save_close_unconfirmed_write_waits_for_readback', async () => {
    await board();
    await openItem();
    const original = await api(work + '/items/' + item.id), draft = prefix + ' interrupted before commit';
    let patches = 0;
    const pattern = '**/api/v1' + work + '/items/' + item.id;
    const failBeforeCommit = async route => { if (route.request().method() !== 'PATCH') return route.continue(); patches++; return route.abort('failed'); };
    await page.route(pattern, failBeforeCommit);
    await label('下一步', 'Next step').fill(draft);
    await detail().locator('[data-work-save-close]').click();
    await button('使用最新版本', 'Use latest version').waitFor();
    assert.equal(patches, 1, 'Unconfirmed save is not blindly replayed');
    assert.equal(await modal().count(), 1); assert.equal(await label('下一步', 'Next step').inputValue(), draft);
    assert.equal((await api(work + '/items/' + item.id)).nextStep, original.nextStep);
    await page.unroute(pattern, failBeforeCommit);
    await button('使用最新版本', 'Use latest version').click();
    await closeItem();
  });
  await check('card_menu_is_independent_of_opening', async () => {
    await board();
    await titleButton().scrollIntoViewIfNeeded();
    await card().locator('.work-card-menu-trigger').click();
    await page.getByRole('menu').waitFor();
    assert.equal(await modal().count(), 0, 'Card menu does not open the item');
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    assert.equal(await modal().count(), 0); assert.equal(await page.locator('.work-card.selected').count(), 0);
  });
  await check('status_and_schedule_drafts_are_centered_and_discardable', async () => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await board();
    async function centered(target) {
      assert.equal(await target.getAttribute('role'), 'dialog');
      assert.equal(await target.getAttribute('aria-modal'), 'true');
      const rect = await target.boundingBox();
      assert(rect && rect.x >= 16 && rect.y >= 16 && rect.x + rect.width <= 1584 && rect.y + rect.height <= 884, 'Related editor fits the viewport with margins');
      assert(Math.abs(rect.x + rect.width / 2 - 800) <= 2 && Math.abs(rect.y + rect.height / 2 - 450) <= 2, 'Related editor is centered');
      assert.equal(await page.locator('.work-drawer').count(), 0, 'Related editor does not reintroduce a drawer');
    }
    const before = await api(work + '/statuses');
    await button('看板操作', 'Board actions', page).click();
    await page.getByRole('menuitem', { name: t('管理状态', 'Manage statuses'), exact: true }).click();
    const manager = page.locator('.work-status-manager');
    await manager.locator('[data-status-name]').first().waitFor(); await centered(manager);
    const name = manager.locator('[data-status-name]').first();
    await name.fill((await name.inputValue()) + ' draft');
    await button('关闭状态管理', 'Close status manager', manager).click();
    const discard = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: t('放弃修改', 'Discard changes'), exact: true }) });
    await button('放弃修改', 'Discard changes', discard).click();
    await manager.waitFor({ state: 'hidden' });
    assert.equal((await api(work + '/statuses')).revision, before.revision, 'Discarding status draft does not save configuration');
    let createdSchedules = 0;
    const observe = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1' + work + '/schedules') createdSchedules++; };
    page.on('request', observe);
    await button('更多新建选项', 'More creation options', page).click();
    await page.locator('[data-work-new-schedule][role="menuitem"]').click();
    const schedule = page.locator('.work-dialog').filter({ has: page.locator('[data-work-schedule-detail]') });
    await schedule.locator('[data-schedule-name]').waitFor(); await centered(schedule);
    await schedule.locator('[data-schedule-name]').fill(prefix + ' schedule draft');
    await button('关闭', 'Close', schedule).click();
    await button('继续编辑', 'Keep editing', discard).click();
    assert.equal(await schedule.locator('[data-schedule-name]').inputValue(), prefix + ' schedule draft');
    await button('关闭', 'Close', schedule).click();
    await button('放弃修改', 'Discard changes', discard).click();
    await schedule.waitFor({ state: 'hidden' });
    page.off('request', observe);
    assert.equal(createdSchedules, 0, 'Opening and discarding never creates a real recurring rule');
  });
  assert.deepEqual(report.errors, [], 'No browser runtime errors');
  report.passed = true;
}
main().catch(async error => {
  report.failure = scrub(error.stack || error); console.error(report.failure); process.exitCode = 1;
  if (page) { try { await page.screenshot({ path: path.join(output, provider + '-work-dialog-failure.png'), animations: 'disabled' }); } catch {} }
}).finally(async () => {
  if (browser) await browser.close();
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, provider + '-work-dialog-report.json'), JSON.stringify(report, null, 2));
});
