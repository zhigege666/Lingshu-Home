#!/usr/bin/env node
'use strict';
// Owned disposable loopback fixture only. Never point this suite at user data.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.UI_FIXTURES && process.env.OUTPUT_DIR, 'Owned fixture/output are required');
const provider = process.env.UI_PROVIDER || 'sqlite', f = JSON.parse(fs.readFileSync(process.env.UI_FIXTURES, 'utf8'))[provider];
const base = new URL(f.url), out = path.resolve(process.env.OUTPUT_DIR);
assert(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname) && !base.username && !base.password);
const origin = base.origin, secrets = [f.username, f.password], id = () => crypto.randomBytes(16).toString('hex');
const scrub = value => secrets.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, String(value));
const report = { passed: false, checks: [], skipped: [], screenshots: [], errors: [], performance: [], startedAt: new Date().toISOString() };
let browser, context, page, language, work, schedule, sourceItem, generated, settings;
const t = (zh, en) => language === 'en' ? en : zh;
const button = (zh, en, scope = page) => scope.getByRole('button', { name: t(zh, en), exact: true });
const label = (zh, en, scope = page) => scope.getByLabel(t(zh, en), { exact: true });
const detail = () => page.locator('[data-work-schedule-detail]'), itemDetail = () => page.locator('[data-work-detail-id]');
const scheduleName = () => detail().locator('[data-schedule-name]');
async function check(name, run) {
  if (process.env.UI_CHECK_SKIP_MATCH && new RegExp(process.env.UI_CHECK_SKIP_MATCH).test(name)) { report.skipped.push(name); return; }
  const start = Date.now();
  try { await run(); report.checks.push({ name, passed: true, ms: Date.now() - start }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: scrub(error.message) }); throw error; }
}
async function boot() { const response = await context.request.get(origin + '/api/v1/bootstrap'); assert(response.ok()); return response.json(); }
async function api(suffix, method = 'GET', data, expected = 200) {
  const state = await boot();
  const response = await context.request.fetch(origin + '/api/v1' + suffix, { method, data, headers: { Origin: origin, 'X-CSRF-TOKEN': state.csrfToken }, maxRedirects: 0 });
  assert([].concat(expected).includes(response.status()), method + ' ' + suffix + ': ' + response.status() + ' ' + scrub((await response.text()).slice(0, 300)));
  return response.status() === 204 ? null : response.json();
}
async function mutation(action, suffix, method = 'PATCH', expected = 200) {
  const waiting = page.waitForResponse(response => response.url().endsWith('/api/v1' + suffix) && response.request().method() === method);
  await action(); const response = await waiting; assert.equal(response.status(), expected, scrub(await response.text())); return response.json();
}
async function shot(name) { const filename = provider + '-' + language + '-' + name + '.png'; await page.screenshot({ path: path.join(out, filename), animations: 'disabled' }); report.screenshots.push(filename); if (name === 'final-static-title-preview-generated') { const jpeg = filename.replace(/\.png$/, '.jpg'); await page.screenshot({ path: path.join(out, jpeg), type: 'jpeg', quality: 55, animations: 'disabled' }); report.screenshots.push(jpeg); } }
async function openSchedule() { const url = origin + '/#/library?view=board&space=' + f.shared + '&tab=schedules&schedule=' + schedule.id; if (page.url() === url) await page.reload({ waitUntil: 'domcontentloaded' }); else await page.goto(url, { waitUntil: 'domcontentloaded' }); await scheduleName().waitFor(); await page.waitForFunction(() => !!document.querySelector('[data-schedule-name]')?.value); }
async function saveSchedule() { const value = await mutation(() => button('保存规则', 'Save schedule', detail()).click(), work + '/schedules/' + schedule.id); schedule = value.schedule; return schedule; }
async function configureModules(modules) { return api('/settings', 'PUT', { siteName: settings.siteName, mode: settings.mode, registrationEnabled: settings.registrationEnabled, modules }); }
async function geometry(width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForFunction(w => { const e = document.querySelector('[data-work-schedule-detail]'); return e && e.tagName === (w >= 2200 ? 'ASIDE' : 'DIV'); }, width);
  const result = await page.evaluate(() => {
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const e = document.querySelector('[data-work-schedule-detail]'), body = e.querySelector('.work-detail-body'), before = body.scrollTop;
    body.scrollTop = body.scrollHeight; const scrolls = body.scrollTop > before; body.scrollTop = 0;
    const visible = selector => [...document.querySelectorAll(selector)].filter(e => e.getClientRects().length).map(e => ({ name: e.textContent || e.getAttribute('aria-label'), ...rect(e) }));
    return { width: innerWidth, height: innerHeight, pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), panel: rect(e), heading: rect(e.querySelector('.work-detail-heading')), footer: rect(e.querySelector('.work-detail-footer')), body: rect(body), scrolls, controls: visible('.work-topbar button,[data-work-schedule-detail] .work-detail-footer button') };
  });
  assert(result.pageWidth <= width + 1, 'No page horizontal overflow');
  assert(result.panel.x >= 0 && result.panel.right <= width + 1 && result.panel.bottom <= height + 1, 'Detail fits viewport');
  if (width >= 2200) assert.equal(Math.round(result.panel.width), 520, 'Wide detail stays 520 px');
  assert(result.body.bottom <= result.footer.y + 1 && result.body.y >= result.heading.bottom - 1, 'Body scroll stays between fixed heading/footer');
  assert(result.scrolls, 'Long form has internal scrolling');
  for (const c of result.controls) assert(c.x >= 0 && c.right <= width + 1 && c.y >= 0 && c.bottom <= height + 1, 'Visible control remains reachable: ' + c.name);
  report.performance.push({ surface: 'schedule-layout', ...result }); await shot(width + 'x' + height);
  if (width === 1600) { await detail().locator('.work-detail-body').evaluate(element => { element.scrollTop = element.scrollHeight; }); await shot('1600x900-bottom-actions'); }
}
async function main() {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }); report.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: process.env.LINGSHU_LANGUAGE === 'en' ? 'en-US' : 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(scrub(error.message)));
  const network = []; page.on('request', request => network.push({ at: Date.now(), method: request.method(), path: new URL(request.url()).pathname, query: new URL(request.url()).search }));
  await api('/auth/login', 'POST', { username: f.username, password: f.password, sessionMode: 'temporary' });
  const initial = await boot(); assert.equal(initial.siteName, 'Release UI fixture ' + provider); language = initial.language; work = '/spaces/' + f.shared + '/work'; settings = await api('/settings');
  const space = '/spaces/' + f.shared, prefix = 'Schedule ' + id().slice(0, 6), catalog = await api(work + '/statuses');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const dateAfter = days => { const date = new Date(today + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
  const project = await api(work + '/projects', 'POST', { id: id(), name: prefix + ' project' });
  const bookmark = await api(space + '/links', 'POST', { title: prefix + ' source', url: 'https://example.invalid/recurring', iconMode: 'manual', icon: 'lucide:link', description: 'Owned fixture', tags: [] }, 201);
  const documentSource = await api(space + '/document-sources', 'POST', { name: prefix + ' notes', path: f.documentRoot, readOnly: true, defaultWrite: false, defaultFolder: '', scanIntervalSeconds: 0 }, 201);
  await api(space + '/document-sources/' + documentSource.id + '/scan', 'POST', {});
  const document = (await api(space + '/documents?sourceId=' + documentSource.id)).items.find(item => item.relativePath === 'plan.md'); assert(document);
  sourceItem = await api(work + '/items', 'POST', { requestId: id(), title: prefix + ' daily sync', projectId: project.id, status: catalog.defaultStatus, description: 'Verify the synchronization output', nextStep: 'Compare source and destination', result: 'Previous result must not be copied', needsAttention: true, bookmarkIds: [bookmark.id], documentIds: [document.id], businessDate: today, dueAt: new Date(Date.now() - 3600000).toISOString() });
  const undated = await api(work + '/items', 'POST', { requestId: id(), title: prefix + ' undated' });
  const doneStatus = catalog.items.find(item => item.type === 'done'); assert(doneStatus);
  const done = await api(work + '/items', 'POST', { requestId: id(), title: prefix + ' complete', status: doneStatus.id, businessDate: today, dueAt: new Date(Date.now() - 3600000).toISOString() });
  const boardURL = origin + '/#/library?view=board&space=' + f.shared;
  await check('ordinary_board_does_not_load_recurring_chunk_or_api', async () => {
    await page.goto(boardURL, { waitUntil: 'networkidle' }); await page.locator('[data-work-id="' + sourceItem.id + '"]').waitFor();
    const start = Date.now(); await page.waitForTimeout(16000);
    assert.equal(network.some(entry => /WorkSchedules|\/work\/schedules/.test(entry.path)), false, 'Ordinary board does not load recurring code or data');
    report.performance.push({ surface: 'ordinary-board', observedMs: Date.now() - start, requests: network.filter(entry => /\/work\//.test(entry.path)).map(({ path, query, method }) => ({ path, query, method })) });
  });
  if (page.url() === 'about:blank') { await page.goto(boardURL, { waitUntil: 'domcontentloaded' }); await page.locator('[data-work-id="' + sourceItem.id + '"]').waitFor(); }
  await check('today_and_overdue_use_business_date_and_deadline', async () => {
    await page.locator('[data-work-today]').click(); await page.locator('[data-work-id="' + sourceItem.id + '"]').waitFor();
    assert.equal(await page.locator('[data-work-id="' + undated.id + '"]').count(), 0, 'An updated undated item is not a today item');
    await page.locator('[data-work-overdue]').click(); await page.locator('[data-work-id="' + sourceItem.id + '"]').waitFor();
    assert.equal(await page.locator('[data-work-id="' + done.id + '"]').count(), 0, 'Completed items are excluded from overdue');
    assert(network.some(entry => entry.query.includes('date=today') && entry.query.includes('timezone=')));
    assert(network.some(entry => entry.query.includes('date=overdue')));
    await page.locator('[data-work-id="' + sourceItem.id + '"] .work-card-title').click(); await itemDetail().waitFor();
    await itemDetail().locator('[data-work-business-date]').fill(dateAfter(1)); await itemDetail().locator('[data-work-due-at]').fill(dateAfter(1) + 'T18:00');
    sourceItem = await mutation(() => button('保存事项', 'Save item', itemDetail()).click(), work + '/items/' + sourceItem.id);
    assert.equal(sourceItem.businessDate, dateAfter(1)); assert(sourceItem.dueAt); await shot('ordinary-dates');
    await itemDetail().locator('[data-work-business-date]').fill(''); await itemDetail().locator('[data-work-due-at]').fill(''); sourceItem = await mutation(() => button('保存事项', 'Save item', itemDetail()).click(), work + '/items/' + sourceItem.id); assert.equal(sourceItem.businessDate || '', ''); assert.equal(sourceItem.dueAt || '', '');
  });
  if (!await itemDetail().count()) { await page.goto(boardURL + '&item=' + sourceItem.id, { waitUntil: 'domcontentloaded' }); await itemDetail().locator('[data-work-title]').waitFor(); }
  await check('ordinary_item_references_still_unlink_relink_and_preserve_hidden_documents', async () => {
    await itemDetail().getByRole('button', { name: t('取消关联：', 'Unlink: ') + bookmark.title, exact: true }).click();
    sourceItem = await mutation(() => button('保存事项', 'Save item', itemDetail()).click(), work + '/items/' + sourceItem.id); assert.deepEqual(sourceItem.bookmarkIds, []); assert.deepEqual(sourceItem.documentIds, [document.id]);
    await button('关联资料', 'Link resources', itemDetail()).click(); await itemDetail().locator('[data-work-resource-id="' + bookmark.id + '"]').click();
    await button('关闭资料选择', 'Close resource picker', itemDetail()).click(); sourceItem = await mutation(() => button('保存事项', 'Save item', itemDetail()).click(), work + '/items/' + sourceItem.id); assert.deepEqual(sourceItem.bookmarkIds, [bookmark.id]);
    await configureModules({ documents: false, work: true }); await page.reload({ waitUntil: 'domcontentloaded' }); await itemDetail().locator('[data-work-title]').waitFor();
    await label('下一步', 'Next step', itemDetail()).fill('Reference still points to the original document'); sourceItem = await mutation(() => button('保存事项', 'Save item', itemDetail()).click(), work + '/items/' + sourceItem.id);
    await configureModules({ documents: true, work: true }); sourceItem = await api(work + '/items/' + sourceItem.id); assert.deepEqual(sourceItem.documentIds, [document.id]); await page.reload({ waitUntil: 'domcontentloaded' }); await itemDetail().locator('[data-work-title]').waitFor(); await itemDetail().locator('.work-references').getByRole('link', { name: document.title, exact: true }).waitFor();
  });
  await check('create_recurring_from_item_preserves_template_only_and_previews', async () => {
    await button('保存为定时模板', 'Save as recurring template', itemDetail()).click(); await scheduleName().waitFor();
    assert.equal(await scheduleName().inputValue(), sourceItem.title);
    assert.equal(await label('下一步', 'Next step', detail()).inputValue(), sourceItem.nextStep);
    await label('生成时间', 'Creation time', detail()).fill('23:59');
    await detail().locator('.work-schedule-preview li').nth(4).waitFor(); assert.equal(await detail().locator('.work-schedule-preview li strong').first().textContent(), sourceItem.title); assert.match(await detail().locator('.work-schedule-preview li').first().getAttribute('data-business-date'), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(network.filter(entry => /\/occurrences$/.test(entry.path)).length, 0, 'History is not loaded before its tab is opened');
    const value = await mutation(() => button('创建规则', 'Create schedule', detail()).click(), work + '/schedules', 'POST'); schedule = value.schedule;
    assert.deepEqual(schedule.template.bookmarkIds, [bookmark.id]); assert.deepEqual(schedule.template.documentIds, [document.id]); assert.equal(schedule.template.projectId, project.id); assert.equal(schedule.template.status, sourceItem.status); assert(!('result' in schedule.template));
    assert.equal((await api(work + '/items/' + sourceItem.id)).result, 'Previous result must not be copied');
    await detail().getByRole('button', { name: t('保存规则', 'Save schedule'), exact: true }).waitFor();
    await page.locator('[data-work-schedule-id="' + schedule.id + '"]').waitFor();
  });
  if (!schedule) { schedule = (await api(work + '/schedules', 'POST', { id: id(), name: sourceItem.title, template: { title: sourceItem.title, projectId: project.id, status: sourceItem.status, description: sourceItem.description, nextStep: sourceItem.nextStep, needsAttention: true, bookmarkIds: [bookmark.id], documentIds: [document.id] }, rule: { frequency: 'daily', time: '23:59', timezone: 'Asia/Shanghai', startDate: today }, enabled: true, missedPolicy: 'latest', overlapPolicy: 'create' })).schedule; await openSchedule(); }
  await check(language === 'en' ? 'english_compact_detail_fixed_actions_and_shared_theme' : 'four_viewports_fixed_actions_and_shared_theme', async () => {
    for (const size of language === 'en' ? [[1600, 900]] : [[2560, 1440], [2560, 1080], [1920, 1080], [1600, 900]]) await geometry(...size);
    await page.setViewportSize({ width: 2560, height: 1440 });
    await page.locator('.home-account-trigger').click(); await page.getByRole('menuitemcheckbox', { name: t('切换深浅色', 'Toggle light or dark') }).click(); await page.keyboard.press('Escape');
    await page.locator('.work-shell[data-theme="dark"]').waitFor(); await shot('dark-theme');
    await page.locator('.home-account-trigger').click(); await page.getByRole('menuitemcheckbox', { name: t('切换深浅色', 'Toggle light or dark') }).click(); await page.keyboard.press('Escape');
  });
  await check('generate_is_idempotent_and_history_locates_actual_item', async () => {
    await label('生成业务日期', 'Occurrence business date', detail()).fill(today);
    const first = await mutation(() => button('生成本期', 'Generate', detail()).click(), work + '/schedules/' + schedule.id + '/generate', 'POST'); assert.equal(first.occurrence.result, 'created'); generated = await api(work + '/items/' + first.occurrence.itemId);
    assert.equal(generated.title, schedule.template.title); assert.equal(generated.businessDate, today); assert.equal(generated.result, ''); assert.equal(generated.scheduleId, schedule.id); assert.deepEqual(generated.documentIds, [document.id]); assert.deepEqual(generated.bookmarkIds, [bookmark.id]);
    await detail().locator('.work-detail-body').evaluate(element => { element.scrollTop = element.scrollHeight; }); await shot('final-static-title-preview-generated');
    generated = await api(work + '/items/' + generated.id, 'PATCH', { expectedRevision: generated.revision, result: 'Actual execution result remains' });
    const second = await mutation(() => button('生成本期', 'Generate', detail()).click(), work + '/schedules/' + schedule.id + '/generate', 'POST'); assert.equal(second.replayed, true); assert.equal(second.occurrence.itemId, generated.id); assert.equal((await api(work + '/items/' + generated.id)).result, generated.result);
    await button('生成记录', 'Creation history', detail()).click(); await detail().locator('.work-schedule-history li').waitFor(); await shot('creation-history');
    await button('打开事项', 'Open item', detail()).click(); await itemDetail().waitFor(); assert.equal(await itemDetail().locator('[data-work-title]').inputValue(), generated.title); assert(page.url().includes('item=' + generated.id));
    await itemDetail().getByText(t('定时生成', 'Scheduled creation'), { exact: false }).first().waitFor();
    await openSchedule();
    const paused = await mutation(() => button('暂停', 'Pause', detail()).click(), work + '/schedules/' + schedule.id); schedule = paused.schedule; assert.equal(schedule.enabled, false);
  });
  if (!generated) { const result = await api(work + '/schedules/' + schedule.id + '/generate', 'POST', { expectedRevision: schedule.revision, businessDate: today }); generated = await api(work + '/items/' + result.occurrence.itemId); schedule = (await api(work + '/schedules/' + schedule.id, 'PATCH', { expectedRevision: schedule.revision, enabled: false })).schedule; await openSchedule(); }
  await check('discard_guard_conflict_merge_and_unknown_save_are_explicit', async () => {
    await scheduleName().fill(prefix + ' local name'); await page.locator('[data-work-today]').click();
    await button('继续编辑', 'Keep editing', page.getByRole('dialog')).click(); assert.equal(await scheduleName().inputValue(), prefix + ' local name');
    const remote = await api(work + '/schedules/' + schedule.id); await api(work + '/schedules/' + schedule.id, 'PATCH', { expectedRevision: remote.schedule.revision, template: { ...remote.schedule.template, description: 'Concurrent remote description' } });
    await mutation(() => button('保存规则', 'Save schedule', detail()).click(), work + '/schedules/' + schedule.id, 'PATCH', 409); assert.equal(await scheduleName().inputValue(), prefix + ' local name');
    await button('读取最新版本', 'Read latest version', detail()).click(); await button('保存草稿中的改动', 'Save my draft changes', detail()).waitFor();
    const merged = await mutation(() => button('保存草稿中的改动', 'Save my draft changes', detail()).click(), work + '/schedules/' + schedule.id); schedule = merged.schedule;
    assert.equal(schedule.name, prefix + ' local name'); assert.equal(schedule.template.description, 'Concurrent remote description');
    let writes = 0;
    const pattern = '**/api/v1' + work + '/schedules/' + schedule.id;
    await page.route(pattern, async route => { if (route.request().method() !== 'PATCH') return route.continue(); writes++; await route.fetch(); await route.abort('failed'); }, { times: 1 });
    await label('下一步', 'Next step', detail()).fill('Saved once despite a lost response'); await button('保存规则', 'Save schedule', detail()).click();
    await detail().locator('.admin-error').filter({ hasText: t('保存结果尚未确认', 'The save result is unconfirmed') }).waitFor(); assert.equal(writes, 1); assert.equal(await label('下一步', 'Next step', detail()).inputValue(), 'Saved once despite a lost response');
    await button('读取最新版本', 'Read latest version', detail()).click(); await button('使用最新版本', 'Use latest version', detail()).click(); schedule = (await api(work + '/schedules/' + schedule.id)).schedule; assert.equal(schedule.template.nextStep, 'Saved once despite a lost response');
  });
  await check('monthly_weekly_rules_and_due_time_previews', async () => {
    const repeat = label('重复周期', 'Repeat', detail()); await label('生成时间', 'Creation time', detail()).fill('09:00');
    await repeat.click(); await page.getByRole('option', { name: t('每月', 'Every month'), exact: true }).click();
    await label('每月几日', 'Day of month', detail()).fill('31'); await label('当月没有此日', 'When day is missing', detail()).click(); await page.getByRole('option', { name: t('使用当月最后一天', 'Use last day of month'), exact: true }).click();
    await label('完成期限', 'Due time', detail()).click(); await page.getByRole('option', { name: t('指定时刻', 'At a specific time'), exact: true }).click();
    await label('截止时刻', 'Due at', detail()).fill('18:00'); await detail().locator('.work-schedule-preview li').nth(4).waitFor();
    await saveSchedule(); assert.equal(schedule.rule.frequency, 'monthly'); assert.equal(schedule.rule.monthDay, 31); assert.equal(schedule.rule.monthPolicy, 'last_day'); assert.equal(schedule.rule.dueTime, '18:00');
    await repeat.click(); await page.getByRole('option', { name: t('每周', 'Every week'), exact: true }).click(); await detail().getByRole('group', { name: t('每周生成日', 'Days of the week') }).getByRole('button', { name: t('五', 'Fri'), exact: true }).click();
    await saveSchedule(); assert.deepEqual(schedule.rule.weekdays, [1, 5]);
    await repeat.click(); await page.getByRole('option', { name: t('每天', 'Every day'), exact: true }).click(); await label('开始日期', 'Start date', detail()).fill(dateAfter(-40)); await saveSchedule();
  });
  if (schedule.rule.frequency !== 'daily' || schedule.rule.startDate !== dateAfter(-40)) { schedule = (await api(work + '/schedules/' + schedule.id, 'PATCH', { expectedRevision: schedule.revision, enabled: false, rule: { frequency: 'daily', time: '23:59', timezone: 'Asia/Shanghai', startDate: dateAfter(-40), dueTime: '23:59' } })).schedule; await openSchedule(); }
  await check('history_pagination_and_archive_restore', async () => {
    for (let day = 1; day <= 31; day++) await api(work + '/schedules/' + schedule.id + '/generate', 'POST', { expectedRevision: schedule.revision, businessDate: dateAfter(-day) });
    await button('生成记录', 'Creation history', detail()).click(); await detail().locator('.work-schedule-history li').nth(29).waitFor(); assert.equal(await detail().locator('.work-schedule-history li').count(), 30);
    await button('加载更多', 'Load more', detail()).click(); await detail().locator('.work-schedule-history li').nth(31).waitFor(); assert.equal(await detail().locator('.work-schedule-history li').count(), 32);
    const archived = await mutation(() => button('归档', 'Archive', detail()).click(), work + '/schedules/' + schedule.id); schedule = archived.schedule; assert.equal(schedule.archived, true); assert.equal(await button('保存规则', 'Save schedule', detail()).count(), 0);
    const restored = await mutation(() => button('恢复', 'Restore', detail()).click(), work + '/schedules/' + schedule.id); schedule = restored.schedule; assert.equal(schedule.archived, false); assert.equal(schedule.enabled, false);
    await button('配置', 'Settings', detail()).click();
  });
  await check('module_switches_preserve_hidden_references_and_active_draft', async () => {
    await configureModules({ documents: false, work: true }); await openSchedule();
    await scheduleName().fill(prefix + ' document module off'); await label('下一步', 'Next step', detail()).fill('Update template while document references are hidden'); await saveSchedule();
    await configureModules({ documents: true, work: true }); schedule = (await api(work + '/schedules/' + schedule.id)).schedule; assert.deepEqual(schedule.template.documentIds, [document.id], 'Unchanged hidden document links survive template edits'); await openSchedule();
    await scheduleName().fill(prefix + ' retained during disable'); await configureModules({ work: false });
    const rejected = await mutation(() => button('保存规则', 'Save schedule', detail()).click(), work + '/schedules/' + schedule.id, 'PATCH', 403); assert.equal(rejected.code, 'module_disabled'); assert.equal(await scheduleName().inputValue(), prefix + ' retained during disable'); assert.equal(await detail().locator('.work-conflict').count(), 0);
    await configureModules({ work: true }); await saveSchedule(); assert.equal(schedule.name, prefix + ' retained during disable');
  });
  await check('list_pagination_toggle_and_new_entry', async () => {
    for (let index = 0; index < 31; index++) await api(work + '/schedules', 'POST', { id: id(), name: prefix + ' extra ' + index, template: { ...schedule.template, bookmarkIds: [], documentIds: [] }, rule: { ...schedule.rule, startDate: dateAfter(366) }, enabled: false, missedPolicy: 'skip', overlapPolicy: 'create' });
    await button('关闭定时事项', 'Close recurring item', detail()).click(); await page.locator('.work-schedule-list-heading').getByRole('button').click();
    await page.locator('[data-work-schedule-id]').nth(29).waitFor(); assert.equal(await page.locator('[data-work-schedule-id]').count(), 30);
    await page.locator('.work-schedule-table-scroll').getByRole('button', { name: t('加载更多', 'Load more'), exact: true }).click(); await page.locator('[data-work-schedule-id]').nth(31).waitFor(); await shot('2560x1440-schedule-list');
    const row = page.locator('[data-work-schedule-id="' + schedule.id + '"]');
    const enabled = await mutation(() => row.locator('.work-schedule-state').click(), work + '/schedules/' + schedule.id); schedule = enabled.schedule; assert.equal(schedule.enabled, true);
    const paused = await mutation(() => row.locator('.work-schedule-state').click(), work + '/schedules/' + schedule.id); schedule = paused.schedule; assert.equal(schedule.enabled, false);
    await page.locator('[data-work-new-schedule]').click(); await scheduleName().waitFor(); await scheduleName().fill(prefix + ' unsaved'); await button('关闭定时事项', 'Close recurring item', detail()).click(); await button('放弃修改', 'Discard changes', page.getByRole('dialog')).click(); assert.equal(await detail().count(), 0);
    await page.locator('[data-work-today]').click(); await button('更多新建选项', 'More creation options').click(); await page.getByRole('menuitem', { name: t('新建定时事项', 'New recurring item'), exact: true }).click(); await scheduleName().waitFor(); assert.equal(await scheduleName().inputValue(), ''); await button('关闭定时事项', 'Close recurring item', detail()).click();
  });
  await check('module_off_does_not_add_background_requests', async () => {
    await configureModules({ work: false }); await page.goto('about:blank'); network.length = 0;
    await page.goto(boardURL + '&tab=schedules&schedule=' + schedule.id, { waitUntil: 'networkidle' }); const start = Date.now(); await page.waitForTimeout(16000);
    const extra = network.filter(entry => /\/work\//.test(entry.path)); assert.deepEqual(extra, [], 'Disabled Work makes no Work requests, including schedule polling');
    report.performance.push({ surface: 'work-disabled', observedMs: Date.now() - start, workRequests: extra.length }); await shot('module-off'); await configureModules({ work: true });
  });
  assert.equal(report.errors.length, 0, 'Browser has no uncaught errors'); assert.equal(fs.readFileSync(path.join(f.documentRoot, 'plan.md'), 'utf8'), '# Work fixture\n\nOriginal mounted document.\n'); report.passed = true;
}
main().catch(async error => { report.failure = scrub(error.stack || error); console.error(report.failure); if (page) try { await page.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }); } catch {} process.exitCode = 1; }).finally(async () => { report.finishedAt = new Date().toISOString(); fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'work-schedules-report.json'), JSON.stringify(report, null, 2)); if (browser) await browser.close(); });
