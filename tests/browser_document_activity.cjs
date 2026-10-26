#!/usr/bin/env node
'use strict';
/**
 * Real API + UI acceptance for the composable document-activity panels.
 * Only the disposable SQLite instance on http://127.0.0.1:5192 is allowed.
 * Prepare <repo>/.runtime/document-activity/{data,mounts}, and write exactly
 * "Document activity fixture zh-CN\n" to its fixture.guard before starting.
 * Start a freshly built server with that data directory and the mounts root
 * as its sole LINGSHU_DOCUMENT_ROOTS entry. No other database/mount is accepted.
 *
 * LINGSHU_PLAYWRIGHT_MODULE=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright \
 * CHROMIUM_EXECUTABLE=/tmp/lingshu-home-browser/chrome-linux64/chrome \
 * node tests/browser_document_activity.cjs --allow-fixture-write
 * Resume an already prepared fixture without creating more documents:
 * node tests/browser_document_activity.cjs --allow-fixture-write --resume-run=e0ea9958
 * After the saved-component scenarios passed, continue at calendar checks:
 * node tests/browser_document_activity.cjs --allow-fixture-write --resume-run=e0ea9958 --continue-from=calendar
 * After those core checks passed, run only the temporary theme preview:
 * node tests/browser_document_activity.cjs --allow-fixture-write --resume-run=e0ea9958 --continue-from=preview
 *
 * Fixtures are real API-created documents. A guarded Python/SQLite transaction
 * moves only this run's already-existing events into the previous 14 days and
 * moves these two sources' recording baseline. It never inserts activity rows,
 * changes actors/actions/origins, rewrites user navigation, or mocks responses.
 * The report records every timestamp adjustment. Keep the fixture for review;
 * this script deliberately performs no cleanup of documents or saved widgets.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const repository = fs.realpathSync(path.resolve(__dirname, '..'));
const fixture = path.join(repository, '.runtime', 'document-activity');
const dataRoot = path.join(fixture, 'data'), mountRoot = path.join(fixture, 'mounts');
const database = path.join(dataRoot, 'lingshu-home.db');
const fixtureName = 'Document activity fixture zh-CN';
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:5192');
assert.ok(process.argv.includes('--allow-fixture-write'), 'Explicit --allow-fixture-write is required');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && base.port === '5192' && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash, 'Only the dedicated local document-activity fixture on port 5192 is allowed');
for (const location of [fixture, dataRoot, mountRoot, database]) {
  assert.ok(fs.existsSync(location), 'Start the dedicated fixture first: missing ' + location);
  assert.equal(fs.realpathSync(location), location, 'Fixture paths cannot use symbolic links');
}
assert.equal(fs.readFileSync(path.join(fixture, 'fixture.guard'), 'utf8'), fixtureName + '\n', 'Dedicated fixture.guard is required');
assert.equal(fs.statSync(database).nlink, 1, 'Fixture database cannot be hard-linked to another instance');

const resumeArgument = process.argv.find(argument => argument.startsWith('--resume-run='));
const resumeRun = resumeArgument?.slice('--resume-run='.length);
if (resumeArgument) assert.match(resumeRun, /^[a-f0-9]{8}$/, '--resume-run must be an existing eight-character fixture run ID');
const continueArgument = process.argv.find(argument => argument.startsWith('--continue-from='));
const continueFrom = continueArgument?.slice('--continue-from='.length);
if (continueArgument) assert.ok(resumeRun && ['calendar', 'preview'].includes(continueFrom), 'Use --continue-from=calendar or preview together with --resume-run');
const componentStages = ['add all three presets, duplicate and configure instances through the UI', 'independent dates, periods and perspective remain transient', 'explicit date linking preserves per-instance directory and range'];
const coreStages = ['calendar semantics, real tooltip and keyboard drawer focus restoration', 'all-record pagination and document deep link are functional', 'four viewport captures and mixed 8/12/24-column containment', 'public visitor and read-only member receive no private activity data'];
const run = resumeRun || randomUUID().slice(0, 8), prefix = '活动示例 ' + run;
const checkpointPath = path.join(fixture, 'browser-fixture-' + run + '.json');
const priorReportPath = path.join(fixture, 'browser-' + run, 'report.json');
const out = path.join(fixture, 'browser-' + run + (resumeRun ? '-retry-' + randomUUID().slice(0, 8) : '')); fs.mkdirSync(out, { recursive: false });
const reportPath = path.join(out, 'report.json');
const report = { origin: base.origin, fixture, database, mountRoot, run, startedAt: new Date().toISOString(), checks: [], screenshots: [], geometry: [], pageErrors: [], consoleErrors: [], expectedFailures: [], apiCalls: [], activityResponses: [], pageWrites: [] };
const credentialsFile = path.join(fixture, 'browser-fixture-account.json');
const csrf = new WeakMap(), pendingResponses = [], created = [], ids = {};
let browser, context, page, boot, shared, notes, projects, baselinePage, baselineNavigation, savedPage, fixtureDates, stage = 'preflight';
const l = (zh, en) => boot?.language === 'en' ? en : zh;
const button = (zh, en, scope = page) => scope.getByRole('button', { name: l(zh, en), exact: true });
const label = (zh, en, scope = page) => scope.getByLabel(l(zh, en), { exact: true });
const select = (zh, en) => inspector().getByRole('combobox', { name: l(zh, en), exact: true });
const editor = () => page.locator('.lh-composer');
const toolbar = () => page.locator('.lh-composer-toolbar');
const inspector = () => page.locator('.lh-composer-sidebar.is-inspector .lh-composer-inspector');
const library = () => page.locator('.lh-composer-sidebar.is-library');
const panel = id => page.locator('[data-activity-view="' + id + '"]');
const layer = id => library().locator('[data-composer-layer="' + id + '"]');
const day = (id, date) => panel(id).locator('button[data-date="' + date + '"]');
const spacePath = suffix => '/spaces/' + shared.id + suffix;
const records = value => ({ categories: [...value.data.categories].sort((a, b) => a.id.localeCompare(b.id)), links: [...value.data.links].sort((a, b) => a.id.localeCompare(b.id)) });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const selectedDates = id => panel(id).locator('button[data-date][aria-selected="true"]').evaluateAll(nodes => nodes.map(node => node.dataset.date));
const dateAdd = (date, amount) => new Date(Date.parse(date + 'T12:00:00Z') + amount * 86400000).toISOString().slice(0, 10);
const dateKey = instant => { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant).map(part => [part.type, part.value])); return parts.year + '-' + parts.month + '-' + parts.day; };
const monthStart = (date, offset) => { const value = new Date(date + 'T12:00:00Z'); value.setUTCDate(1); value.setUTCMonth(value.getUTCMonth() + offset); return value.toISOString().slice(0, 10); };

async function api(method, suffix, data, expected = 200, target = context) {
  const response = await target.request.fetch(base.origin + '/api/v1' + suffix, { method, data, headers: { 'X-CSRF-TOKEN': csrf.get(target) || '' }, maxRedirects: 0 });
  const text = await response.text();
  report.apiCalls.push({ stage, method, path: suffix, status: response.status() });
  assert.equal(response.status(), expected, method + ' ' + suffix + ': HTTP ' + response.status() + ' ' + text.slice(0, 500));
  if (expected >= 400) report.expectedFailures.push({ stage, status: expected, path: new URL(base.origin + '/api/v1' + suffix).pathname, reason: 'Explicit permission assertion' });
  return text ? JSON.parse(text) : null;
}
async function bootstrap(target = context) { const value = await api('GET', '/bootstrap', undefined, 200, target); csrf.set(target, value.csrfToken); return value; }
async function step(name, action) {
  stage = name;
  if (continueFrom && componentStages.includes(name) || continueFrom === 'preview' && coreStages.includes(name)) {
    const evidence = componentStages.includes(name) ? report.earlierEvidence : report.earlierCoreEvidence;
    assert.ok(evidence, 'Skipping requires the earlier successful stage evidence');
    console.log(JSON.stringify({ step: name, status: 'skipped', earlierEvidence: evidence.report }));
    report.checks.push({ name, status: 'skipped', reason: '--continue-from=' + continueFrom + ' reuses prior successful checks and preserves the saved components', earlierEvidence: evidence.report }); return;
  }
  console.log(JSON.stringify({ step: name })); const started = Date.now(); await action(); report.checks.push({ name, durationMs: Date.now() - started, status: 'passed' });
}
async function settle() {
  const token = randomUUID();
  await page.waitForFunction(token => {
    if (document.fonts.status !== 'loaded' || document.querySelector('.react-draggable-dragging,.resizing')) return false;
    const nodes = [...document.querySelectorAll('.lh-home,.lh-grid-frame,.lh-document-activity,.lh-activity-drawer')];
    if (!nodes.length) return false;
    const signature = JSON.stringify(nodes.map(node => { const box = node.getBoundingClientRect(); return [box.x, box.y, box.width, box.height].map(value => Math.round(value)); }));
    const before = window.__activityAcceptanceStable;
    if (!before || before.token !== token || before.signature !== signature) { window.__activityAcceptanceStable = { token, signature, frames: 0 }; return false; }
    return ++before.frames >= 5;
  }, token, { timeout: 15000, polling: 'raf' });
}
async function ready(id) {
  await panel(id).locator('.lh-activity-summary').waitFor();
  await page.waitForFunction(id => { const node = document.querySelector('[data-activity-view="' + id + '"]'); return node && !node.querySelector('[aria-busy="true"]') && node.getAttribute('aria-busy') !== 'true'; }, id);
  await settle();
}
async function capture(name, fullPage = false, target = page) { await target.evaluate(() => document.fonts.ready); const file = path.join(out, name + '.png'); await target.screenshot({ path: file, fullPage, animations: 'disabled' }); report.screenshots.push({ name, file, viewport: target.viewportSize(), fullPage }); }
async function choose(control, text) { if ((await control.innerText()).trim() === text) return; await control.click(); await page.getByRole('option', { name: text, exact: true }).click(); }
async function home(reload = false) {
  if (reload && new URL(page.url()).hash === '#/') await page.reload(); else await page.goto(base.origin + '/#/');
  await page.locator('.lh-home:not([data-preview])').waitFor();
  // SpaceSelect is lazy-loaded. A count() immediately after the Home shell
  // appears can see its placeholder and incorrectly skip the space switch.
  if (boot.spaces.length > 1) {
    const chooser = page.getByRole('combobox', { name: l('选择空间', 'Choose a space'), exact: true });
    await chooser.waitFor({ state: 'visible' });
    if (!(await chooser.innerText()).includes(shared.name)) {
      const loaded = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/v1/dashboard' && url.searchParams.get('spaceId') === shared.id; });
      await choose(chooser, shared.name); const response = await loaded; assert.equal(response.status(), 200);
      assert.equal((await response.json()).space.id, shared.id, 'The actual shared-space dashboard is loaded');
    }
  }
  await page.locator('.lh-bookmark-title').filter({ hasText: prefix + ' 保留的导航书签' }).first().waitFor();
  await settle();
}
async function enterEditor() { await button('编辑页面', 'Edit page').click(); await editor().waitFor(); await inspector().waitFor(); await settle(); }
async function layerIds() { return library().locator('[data-composer-layer]').evaluateAll(nodes => nodes.map(node => node.dataset.composerLayer)); }
async function addPreset(presentation) {
  const before = await layerIds();
  await library().getByRole('tab', { name: l('添加组件', 'Add'), exact: true }).click();
  await library().locator('[data-activity-preset="' + presentation + '"]').click();
  await library().getByRole('tab', { name: l('页面结构', 'Layers'), exact: true }).waitFor();
  const added = (await layerIds()).filter(id => !before.includes(id)); assert.equal(added.length, 1, 'One activity preset adds exactly one component');
  await inspector().locator('[data-document-activity-settings]').waitFor(); return added[0];
}
async function onlySource(source) {
  const all = inspector().getByRole('checkbox', { name: l('全部目录', 'All directories'), exact: true });
  if (!await all.isChecked()) await all.click();
  const wanted = inspector().getByRole('checkbox', { name: source.name, exact: true }); await wanted.waitFor(); await wanted.check();
}
async function configure(id, value) {
  await layer(id).click();
  if (value.title) await label('组件标题', 'Component title', inspector()).fill(value.title);
  if (value.presentation) await choose(select('展示样式', 'Presentation'), l(...{ heatmap: ['热力图', 'Heatmap'], split: ['热力图与记录', 'Heatmap and records'], month: ['月历', 'Calendar'] }[value.presentation]));
  if (value.perspective) await choose(select('统计视角', 'Activity scope'), value.perspective === 'mine' ? l('我的编辑', 'My edits') : l('文档库变更', 'Library changes'));
  if (value.months) await choose(select('时间范围', 'Time range'), l('近 ' + value.months + ' 个月', 'Last ' + value.months + ' months'));
  if (value.width) await choose(select('宽度', 'Width'), value.width === 24 ? l('整行 · 24 列', 'Full width · 24 columns') : l(value.width + ' 列', value.width + ' columns'));
  if (value.fixedRows) { await choose(select('高度', 'Height'), l('固定高度', 'Fixed height')); await choose(select('高度行数', 'Height in rows'), l(value.fixedRows + ' 行', value.fixedRows + ' rows')); }
  if (value.detailLayout) await choose(select('明细位置', 'Record position'), value.detailLayout === 'below' ? l('下方', 'Below') : l('自动', 'Automatic'));
  if (value.recentLimit !== undefined) await choose(select('最近记录', 'Recent records'), value.recentLimit ? l(value.recentLimit + ' 条', value.recentLimit + ' records') : l('隐藏', 'Hidden'));
  if (value.source) await onlySource(value.source);
  if (value.timezone) await choose(select('时区', 'Time zone'), value.timezone);
  if (value.group !== undefined) await label('日期联动组', 'Date linking group', inspector()).fill(value.group);
  await settle();
}
async function save() {
  const responsePromise = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/v1' + spacePath('/page'));
  await button('保存页面', 'Save page', toolbar()).click(); const response = await responsePromise;
  assert.equal(response.status(), 200, 'UI page save succeeds: ' + await response.text());
  const sent = response.request().postDataJSON(), saved = await response.json();
  assert.deepEqual(saved.config, sent.config, 'Server saves the exact UI draft');
  assert.deepEqual(await api('GET', spacePath('/page')), saved, 'Save is followed by an exact API read-back');
  report.pageWrites.push({ stage, revision: saved.revision, configSHA256: digest(saved.config), addedViewIds: Object.values(ids) });
  savedPage = saved; checkpoint(); await editor().waitFor({ state: 'hidden' }); return saved;
}
function checkpoint() {
  if (!baselinePage || !baselineNavigation || !fixtureDates || !notes || !projects) return;
  if (fs.existsSync(checkpointPath)) { assert.equal(fs.realpathSync(checkpointPath), checkpointPath); assert.equal(fs.statSync(checkpointPath).nlink, 1); }
  fs.writeFileSync(checkpointPath, JSON.stringify({ fixture, database, mountRoot, run, spaceId: shared.id, fixtureDates, notes, projects,
    documents: created.map(({ id, sourceId, title }) => ({ id, sourceId, title })), baselinePage, baselineNavigation, savedPage,
    ids, fixtureHistory: report.fixtureHistory, data: report.data, baseline: report.baseline }, null, 2), { mode: 0o600 });
}
function earlierReports() {
  return fs.readdirSync(fixture, { withFileTypes: true }).filter(entry => entry.isDirectory() && (entry.name === 'browser-' + run || entry.name.startsWith('browser-' + run + '-retry-')))
    .map(entry => path.join(fixture, entry.name, 'report.json')).filter(file => fs.existsSync(file) && fs.realpathSync(file) === file)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}
function earlierComponentEvidence() {
  assert.ok(savedPage && Object.keys(ids).length === 4, 'Continuation requires the four already-saved components');
  for (const file of earlierReports()) {
    let evidence; try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (evidence.run !== run || evidence.fixture !== fixture || evidence.spaceId !== shared.id) continue;
    if (!componentStages.every(name => evidence.checks?.some(check => check.name === name && check.status === 'passed'))) continue;
    if (evidence.pageWrites?.at(-1)?.configSHA256 !== digest(savedPage.config)) continue;
    const cleanupPath = path.join(path.dirname(file), 'cleanup-interruption.json');
    const cleanup = fs.existsSync(cleanupPath) && fs.realpathSync(cleanupPath) === cleanupPath ? JSON.parse(fs.readFileSync(cleanupPath, 'utf8')) : undefined;
    return { report: file, originalStatus: evidence.status, passedStages: componentStages, savedPageRevision: savedPage.revision,
      ...(cleanup ? { cleanupInterruption: { file: cleanupPath, details: cleanup } } : {}) };
  }
  assert.fail('Calendar continuation needs an earlier report proving all three component stages passed for this exact saved page');
}
function earlierCoreEvidence() {
  for (const file of earlierReports()) {
    let evidence; try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (evidence.run !== run || evidence.fixture !== fixture || evidence.spaceId !== shared.id) continue;
    if (!coreStages.every(name => evidence.checks?.some(check => check.name === name && check.status === 'passed'))) continue;
    const sameSavedPage = evidence.resumedFrom?.savedPageConfigSHA256 === digest(savedPage.config)
      || evidence.earlierEvidence?.report === report.earlierEvidence.report && evidence.earlierEvidence?.savedPageRevision === savedPage.revision
        && JSON.stringify(evidence.resumedFrom?.reusedViewIds) === JSON.stringify(Object.values(ids));
    if (!sameSavedPage || evidence.pageErrors?.length || evidence.consoleErrors?.some(error => error.type === 'error' && !error.expected)) continue;
    return { report: file, originalStatus: evidence.status, passedStages: coreStages, savedPageRevision: savedPage.revision,
      savedPageConfigSHA256: digest(savedPage.config), componentEvidence: report.earlierEvidence.report };
  }
  assert.fail('Preview continuation needs an earlier report proving the four core stages passed for this saved page');
}
async function resumeFixture() {
  const sourcePath = fs.existsSync(checkpointPath) ? checkpointPath : priorReportPath;
  assert.equal(fs.realpathSync(sourcePath), sourcePath, 'Resume evidence cannot be a symlink');
  const previous = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  for (const key of ['fixture', 'database', 'mountRoot', 'run']) assert.equal(previous[key], { fixture, database, mountRoot, run }[key], 'Resume evidence belongs to this fixture: ' + key);
  assert.equal(previous.spaceId, shared.id);
  assert.ok(previous.fixtureHistory?.retimedEvents?.length && previous.data && previous.baseline, 'Resume requires a completed real-data baseline');
  if (!previous.baselinePage) assert.ok(previous.checks?.some(check => check.name === 'real directory baselines, document edits and reviewable 14-day history' && check.status === 'passed'), 'The original API baseline must have passed');
  // Keep the sample's original calendar anchor and event timestamps across
  // midnight. Actual today is used only for present/future UI semantics.
  fixtureDates = { sampleDate: previous.fixtureDates?.sampleDate || previous.fixtureDates?.today || previous.fixtureHistory.today };
  const actualToday = dateKey(new Date());
  assert.ok(fixtureDates.sampleDate <= actualToday, 'The original sample anchor cannot be in the future');
  report.dateContext = { sampleDate: fixtureDates.sampleDate, actualToday, timezone: 'Asia/Shanghai', eventTimestamps: 'Preserved exactly; no retiming on resume.' };
  const sources = await api('GET', spacePath('/document-sources'));
  notes = sources.items.find(source => source.id === previous.data.notes.id); projects = sources.items.find(source => source.id === previous.data.projects.id);
  for (const [source, directory] of [[notes, 'notes'], [projects, 'projects']]) {
    assert.ok(source?.enabled); assert.equal(source.path, path.join(mountRoot, 'ui-' + run, directory)); assert.equal(fs.realpathSync(source.path), source.path);
  }
  const documentIds = new Set(previous.fixtureHistory.retimedEvents.map(event => event.documentId));
  for (const source of [notes, projects]) {
    const listing = await api('GET', spacePath('/documents') + '?sourceId=' + source.id + '&limit=100');
    created.push(...listing.items.filter(document => documentIds.has(document.id)));
  }
  assert.equal(created.length, documentIds.size); assert.equal(created.length, 34, 'Reuse exactly the 34 already-created fixture documents');
  const currentPage = await api('GET', spacePath('/page')), currentNavigation = records(await api('GET', spacePath('/navigation')));
  baselinePage = previous.baselinePage || currentPage; baselineNavigation = previous.baselineNavigation || currentNavigation;
  assert.equal(digest(baselinePage.config), previous.baseline.pageConfigSHA256, 'The preserved page baseline still matches its recorded digest');
  assert.equal(digest(currentNavigation), previous.baseline.navigationSHA256, 'The original fixture bookmarks remain unchanged');
  if (previous.savedPage) {
    assert.deepEqual(currentPage, previous.savedPage, 'Resume only the exact page last saved by this fixture');
    assert.deepEqual(Object.keys(previous.ids), ['heatmap', 'copy', 'split', 'month']); Object.assign(ids, previous.ids); savedPage = currentPage;
  } else assert.equal(digest(currentPage.config), previous.baseline.pageConfigSHA256, 'A fixture without saved UI evidence must still have its original page');
  report.fixtureHistory = previous.fixtureHistory; report.data = previous.data; report.baseline = previous.baseline;
  report.resumedFrom = { path: sourcePath, reusedDocuments: created.length, reusedViewIds: Object.values(ids), savedPageRevision: savedPage?.revision,
    savedPageConfigSHA256: savedPage ? digest(savedPage.config) : undefined, baselineChecks: 'Previously passed; source/document identity and original navigation digest rechecked. No document creation or timestamp adjustment repeated.' };
  if (continueFrom) report.earlierEvidence = earlierComponentEvidence();
  if (continueFrom === 'preview') report.earlierCoreEvidence = earlierCoreEvidence();
  await unchangedNavigation(); checkpoint();
}
async function unchangedNavigation() {
  const current = await api('GET', spacePath('/page'));
  for (const view of baselinePage.config.views) {
    assert.deepEqual(current.config.views.find(item => item.id === view.id), view, 'Existing view settings/bindings/linking remain unchanged: ' + view.id);
    assert.deepEqual(current.config.layout.placements[view.id], baselinePage.config.layout.placements[view.id], 'Existing view placement remains unchanged: ' + view.id);
  }
  for (const [key, value] of Object.entries(baselinePage.config.bindings)) assert.deepEqual(current.config.bindings[key], value, 'Existing data binding remains unchanged');
  for (const key of ['pageTheme', 'appearance', 'chrome']) assert.deepEqual(current.config[key], baselinePage.config[key], 'Existing ' + key + ' remains unchanged');
  assert.deepEqual(records(await api('GET', spacePath('/navigation'))), baselineNavigation, 'Every bookmark/category field remains unchanged');
}
async function activity(source, perspective = 'mine', extra = {}) {
  const today = fixtureDates?.sampleDate || dateKey(new Date());
  const query = new URLSearchParams({ from: monthStart(today, -11), to: today, timezone: 'Asia/Shanghai', perspective, sourceIds: source.id, limit: '100', ...extra });
  return api('GET', spacePath('/document-activity') + '?' + query);
}

// These are the only direct database operations. The default branch is read-only.
function fixtureSQLite(operation, extra = {}) {
  const code = String.raw`
import datetime, json, os, pathlib, sqlite3, sys
from zoneinfo import ZoneInfo
p = json.load(sys.stdin)
root = pathlib.Path(p['repository']) / '.runtime' / 'document-activity'
db_path = root / 'data' / 'lingshu-home.db'
for target in [root, root / 'data', root / 'mounts', db_path]:
    assert target.exists() and str(target.resolve()) == str(target), 'Non-canonical fixture path'
assert (root / 'fixture.guard').read_text() == p['fixtureName'] + '\n', 'Fixture guard mismatch'
assert db_path.stat().st_nlink == 1, 'Hard-linked database is forbidden'
mode = 'rw' if p['operation'] == 'retime' else 'ro'
db = sqlite3.connect(db_path.as_uri() + '?mode=' + mode, uri=True, timeout=20)
db.row_factory = sqlite3.Row
settings = dict(db.execute('SELECT initialized,site_name FROM settings WHERE id=1').fetchone())
assert not settings['initialized'] or settings['site_name'] == p['fixtureName'], 'Database is not this disposable fixture'
if p.get('ownerId'):
    assert settings['initialized'] and settings['site_name'] == p['fixtureName']
    assert db.execute("SELECT id FROM users WHERE role='Owner'").fetchone()[0] == p['ownerId'], 'HTTP server and SQLite data directory differ'
    assert db.execute("SELECT id FROM spaces WHERE kind='shared'").fetchone()[0] == p['spaceId'], 'Shared-space identity mismatch'
if p['operation'] != 'retime':
    print(json.dumps(settings)); sys.exit(0)
assert p.get('ownerId') and p.get('spaceId')
sources = {entry['id']: entry for entry in p['sources']}
assert len(sources) == 2
for source_id, expected in sources.items():
    source = dict(db.execute('SELECT id,space_id,name,path,activity_started_at FROM document_sources WHERE id=?', (source_id,)).fetchone())
    source_path = pathlib.Path(source['path'])
    assert source['space_id'] == p['spaceId'] and source['name'] == expected['name'] and source['path'] == expected['path']
    assert source_path.resolve() == source_path and source_path.parent == root / 'mounts' / ('ui-' + p['run']), 'Source is outside this run'
documents = {entry['id']: entry for entry in p['documents']}
assert len(documents) == len(p['documents']) and len(documents) >= 30
for document_id, expected in documents.items():
    row = db.execute('SELECT source_id,title FROM documents WHERE id=?', (document_id,)).fetchone()
    assert row and row['source_id'] == expected['sourceId'] and row['source_id'] in sources and row['title'] == expected['title'], 'Document is not from this run'
marks = ','.join('?' for _ in documents)
rows = list(db.execute('SELECT id,document_id,source_id,space_id,actor_id,action,origin,occurred_at FROM document_activity WHERE document_id IN (' + marks + ') ORDER BY occurred_at,id', tuple(documents)))
assert rows and all(row['space_id'] == p['spaceId'] and row['source_id'] in sources for row in rows)
assert all(row['actor_id'] == p['ownerId'] or row['origin'] == 'external' and row['actor_id'] is None for row in rows)
today = datetime.date.fromisoformat(p['today']); zone = ZoneInfo('Asia/Shanghai')
def stamp(date, seconds=0):
    instant = datetime.datetime.combine(date, datetime.time(), zone) + datetime.timedelta(seconds=seconds)
    return instant.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000000000Z')
baseline = stamp(today - datetime.timedelta(days=14)); adjustments = []
db.execute('BEGIN IMMEDIATE')
for row in rows:
    document = documents[row['document_id']]
    offset = document['createdDaysAgo'] if row['action'] == 'create' else document['changedDaysAgo']
    target = stamp(today - datetime.timedelta(days=offset), 0 if offset == 0 else 43200 + document['order'])
    cursor = db.execute('UPDATE document_activity SET occurred_at=? WHERE id=? AND occurred_at=?', (target, row['id'], row['occurred_at']))
    assert cursor.rowcount == 1
    adjustments.append({'id': row['id'], 'documentId': row['document_id'], 'action': row['action'], 'origin': row['origin'], 'before': row['occurred_at'], 'after': target})
for source_id in sources:
    assert db.execute('UPDATE document_sources SET activity_started_at=? WHERE id=?', (baseline, source_id)).rowcount == 1
db.commit()
print(json.dumps({'today': str(today), 'recordedFrom': baseline, 'retimedEvents': adjustments, 'sourceIds': list(sources)}))
`;
  const input = { operation, repository, fixtureName, run, ownerId: boot?.user?.id, spaceId: shared?.id, ...extra };
  return JSON.parse(execFileSync('python3', ['-c', code], { input: JSON.stringify(input), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }));
}

function observe(target, identity) {
  target.on('pageerror', error => report.pageErrors.push({ identity, stage, text: error.message }));
  target.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') report.consoleErrors.push({ identity, stage, type: message.type(), text: message.text().slice(0, 700), url: message.location().url || '' }); });
  target.on('response', response => {
    const url = new URL(response.url()); if (!url.pathname.endsWith('/document-activity')) return;
    const when = stage;
    pendingResponses.push((async () => {
      let timer, timedOut = false;
      const metadata = { identity, stage: when, path: url.pathname + url.search, status: response.status() };
      try {
        const data = await Promise.race([response.json(), new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('Activity response body did not settle within 5000 ms')); }, 5000); })]);
        report.activityResponses.push({ ...metadata, summary: data.summary, total: data.total, hasMore: data.hasMore, items: data.items?.map(item => ({ documentId: item.documentId, sourceId: item.sourceId, date: item.date })), code: data.code });
      } catch (error) { report.activityResponses.push({ ...metadata, bodyReadStatus: timedOut ? 'timeout' : 'unavailable', bodyReadError: String(error).slice(0, 500) }); }
      finally { clearTimeout(timer); }
    })());
  });
}
async function geometry(name) {
  await settle();
  const result = await page.evaluate(() => {
    const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const problems = [], panels = [];
    const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    for (const root of document.querySelectorAll('.lh-document-activity')) {
      if (!visible(root)) continue;
      const bounds = box(root), frame = root.closest('.lh-grid-frame'), content = root.querySelector('.lh-activity-body');
      const info = { id: root.dataset.activityView, presentation: root.dataset.activityPresentation, bounds, fixed: frame?.classList.contains('is-fixed') || false, body: content ? { height: content.clientHeight, scrollHeight: content.scrollHeight, overflowY: getComputedStyle(content).overflowY } : null, chartScroll: [...root.querySelectorAll('.lh-activity-chart-scroll')].map(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, overflowX: getComputedStyle(node).overflowX })) };
      panels.push(info);
      for (const control of root.querySelectorAll('button,a[href]')) {
        if (!visible(control)) continue;
        const raw = box(control), clip = { ...raw };
        // Cells and record controls may legitimately lie beyond an internal
        // scrollport. Intersect only with intervening clipping ancestors;
        // do not clip to the component itself and accidentally hide a defect.
        for (let parent = control.parentElement; parent && parent !== root; parent = parent.parentElement) {
          const style = getComputedStyle(parent), r = box(parent);
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { clip.left = Math.max(clip.left, r.left); clip.right = Math.min(clip.right, r.right); }
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { clip.top = Math.max(clip.top, r.top); clip.bottom = Math.min(clip.bottom, r.bottom); }
        }
        if (clip.right <= clip.left || clip.bottom <= clip.top) continue;
        if (clip.left < bounds.left - 1.5 || clip.right > bounds.right + 1.5 || clip.top < bounds.top - 1.5 || clip.bottom > bounds.bottom + 1.5) problems.push({ id: info.id, control: control.getAttribute('aria-label') || control.textContent.trim().slice(0, 90), raw, clip, component: bounds });
      }
      if (frame) { const f = box(frame); if (bounds.left < f.left - 2 || bounds.right > f.right + 2 || bounds.bottom > f.bottom + 2) problems.push({ id: info.id, reason: 'Panel escapes its grid frame', bounds, frame: f }); }
      if (info.fixed && content && (content.clientHeight <= 0 || !/auto|scroll/.test(info.body.overflowY))) problems.push({ id: info.id, reason: 'Fixed panel has no usable internal scrollport', body: info.body });
    }
    const close = document.querySelector('.lh-activity-drawer-heading button');
    if (close) { const r = box(close); if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) problems.push({ reason: 'Drawer close control leaves viewport', bounds: r }); }
    return { viewport: { width: innerWidth, height: innerHeight }, document: { scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) }, panels, problems };
  });
  report.geometry.push({ name, ...result });
  assert.ok(result.document.scrollWidth <= result.viewport.width + 1, name + ': horizontal page overflow');
  assert.deepEqual(result.problems, [], name + ': controls or components overflow');
  return result;
}
async function palette(id) {
  return panel(id).locator('button[data-level]:not(.is-unrecorded):not(:disabled)').evaluateAll(nodes => Object.values(nodes.reduce((result, node) => {
    const level = node.dataset.level;
    if (!result[level]) result[level] = { level: Number(level), date: node.dataset.date, background: getComputedStyle(node).backgroundColor };
    return result;
  }, {})));
}
function distinctPalette(name, values, minimum) {
  assert.ok(values.length >= minimum, name + ' has enough actual heat levels for a visual comparison: ' + JSON.stringify(values));
  assert.equal(new Set(values.map(value => value.background)).size, values.length, name + ' heat levels have distinct computed backgrounds; a global button rule must not flatten the chart');
  report.checks.push({ name: name + ' computed color scale', status: 'passed', palette: values });
}

async function main() {
  report.diskPreflight = fixtureSQLite('inspect');
  const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
  context.setDefaultTimeout(15000); boot = await bootstrap();
  let account;
  await step('guarded Owner initialization and shared space', async () => {
    assert.equal(boot.initialized, !!report.diskPreflight.initialized, 'HTTP and fixture database initialization agree');
    if (!boot.initialized) {
      account = { username: 'activity-fixture', password: 'Fixture-' + randomBytes(24).toString('hex') };
      if (fs.existsSync(credentialsFile)) { assert.equal(fs.realpathSync(credentialsFile), credentialsFile); assert.equal(fs.statSync(credentialsFile).nlink, 1); }
      fs.writeFileSync(credentialsFile, JSON.stringify(account), { mode: 0o600 });
      if (boot.languageSelectionRequired) { await api('POST', '/setup/language', { language: 'zh-CN' }); boot = await bootstrap(); }
      await api('POST', '/setup', { siteName: fixtureName, mode: 'public_read', ...account, displayName: 'Activity fixture', seedDemo: false }, 201);
    } else {
      assert.equal(boot.siteName, fixtureName, 'Existing server does not belong to this fixture');
      assert.ok(fs.existsSync(credentialsFile), 'Known fixture credentials are required');
      assert.equal(fs.realpathSync(credentialsFile), credentialsFile, 'Credential path cannot be a symlink');
      account = JSON.parse(fs.readFileSync(credentialsFile, 'utf8')); await api('POST', '/auth/login', account);
    }
    boot = await bootstrap(); assert.equal(boot.siteName, fixtureName); assert.equal(boot.user?.role, 'Owner');
    shared = boot.spaces.find(space => space.kind === 'shared'); assert.ok(shared?.canEdit);
    fixtureSQLite('inspect');
    await api('PUT', '/settings', { siteName: fixtureName, mode: 'public_read', registrationEnabled: false, autoFetchIcons: false, autoSelectEndpoint: false }); boot = await bootstrap();
    if (!boot.user) { await api('POST', '/auth/login', account); boot = await bootstrap(); }
    const sourceConfig = await api('GET', spacePath('/document-sources')); assert.deepEqual(sourceConfig.roots, [mountRoot], 'Only this fixture mount root may be allowed');
    report.spaceId = shared.id;
  });
  page = await context.newPage(); observe(page, 'owner');
  await context.route('**/*', route => new URL(route.request().url()).origin === base.origin || ['blob:', 'data:'].includes(new URL(route.request().url()).protocol) ? route.continue() : route.abort());

  if (resumeRun) await step('reuse the guarded, already verified document fixture', resumeFixture);
  else await step('real directory baselines, document edits and reviewable 14-day history', async () => {
    const mount = path.join(mountRoot, 'ui-' + run);
    fs.mkdirSync(mount, { recursive: false });
    for (const directory of ['notes', 'projects']) { fs.mkdirSync(path.join(mount, directory)); fs.writeFileSync(path.join(mount, directory, 'existing.md'), '# ' + prefix + ' ' + directory + ' 原有文档\n\n接入前已经存在的内容。\n', { flag: 'wx' }); }
    notes = await api('POST', spacePath('/document-sources'), { name: prefix + ' 工作笔记', path: path.join(mount, 'notes'), readOnly: false, defaultWrite: true, defaultFolder: '', scanIntervalSeconds: 3600 }, 201);
    projects = await api('POST', spacePath('/document-sources'), { name: prefix + ' 项目资料', path: path.join(mount, 'projects'), readOnly: false, defaultWrite: false, defaultFolder: '', scanIntervalSeconds: 3600 }, 201);
    for (const source of [notes, projects]) {
      await api('POST', spacePath('/document-sources/') + source.id + '/scan', {});
      const baseline = await activity(source, 'library'); assert.equal(baseline.summary.documents, 0); assert.equal(baseline.total, 0); assert.ok(baseline.recordedFrom, 'Initial scan establishes a baseline without inventing edits');
    }
    const names = ['页面组件拆分方案', '文档目录接入说明', '编辑器快捷键', '导航布局评审', '索引与扫描记录', '部署验收清单', '接口权限边界', '月历组件笔记'];
    // The notes directory covers every legend tier (1, 2–3, 4–6, 7+).
    // Projects gives the calendar 1/2–3/7+ days and observed zero days.
    const offsets = [13, 13, 13, 13, 13, 13, 13, 12, 12, 12, 12, 12, 11, 11, 11, 10, 10, 6, 5, 4, 3, 3, 4, 5, 13, 13, 13, 13, 13, 13, 13, 12];
    for (let index = 0; index < 32; index++) {
      const source = index < 24 ? notes : projects;
      let document = await api('POST', spacePath('/documents'), { sourceId: source.id, relativePath: 'examples/note-' + String(index + 1).padStart(2, '0') + '.md', content: '# ' + prefix + ' · ' + names[index % names.length] + ' ' + (index + 1) + '\n\n可审查的组件验收示例。\n' }, 201);
      if (index < 5 || index === 24) document = await api('PUT', spacePath('/documents/') + document.id, { expectedRevision: document.revision, content: document.content + '\n已补充本轮评审结果。\n' });
      created.push({ ...document, order: index, createdDaysAgo: offsets[index], changedDaysAgo: index % 3 });
    }
    for (const source of [notes, projects]) {
      const listing = await api('GET', spacePath('/documents') + '?sourceId=' + source.id + '&relativePath=existing.md');
      let document = listing.items.find(item => item.relativePath === 'existing.md'); assert.ok(document);
      document = await api('GET', spacePath('/documents/') + document.id);
      if (source.id === notes.id) document = await api('PUT', spacePath('/documents/') + document.id, { expectedRevision: document.revision, content: document.content + '\n首次真实修改，接入本身不算编辑。\n' });
      else { fs.appendFileSync(path.join(mount, 'projects', 'existing.md'), '\n外部编辑器检测示例。\n'); await api('POST', spacePath('/document-sources/') + source.id + '/scan', {}); document = await api('GET', spacePath('/documents/') + document.id); }
      created.push({ ...document, order: created.length, createdDaysAgo: 13, changedDaysAgo: source.id === notes.id ? 1 : 0 });
    }
    fixtureDates = { sampleDate: dateKey(new Date()) };
    report.dateContext = { sampleDate: fixtureDates.sampleDate, actualToday: fixtureDates.sampleDate, timezone: 'Asia/Shanghai', eventTimestamps: 'Initial fixture adjustment recorded in fixtureHistory.' };
    report.fixtureHistory = fixtureSQLite('retime', { today: fixtureDates.sampleDate, sources: [notes, projects], documents: created.map(({ id, sourceId, title, order, createdDaysAgo, changedDaysAgo }) => ({ id, sourceId, title, order, createdDaysAgo, changedDaysAgo })) });
    const mine = await activity(notes), other = await activity(projects, 'library'), otherMine = await activity(projects, 'mine');
    assert.equal(mine.summary.documents, 25); assert.ok(mine.total > 20); assert.equal(other.summary.documents, 9); assert.equal(otherMine.summary.documents, 8);
    assert.equal(mine.days.some(value => value.date === dateAdd(fixtureDates.sampleDate, -8)), false, 'An observed zero day remains empty');
    report.data = { notes: { id: notes.id, summary: mine.summary, total: mine.total }, projects: { id: projects.id, summary: other.summary, mine: otherMine.summary }, sourceCount: 2, apiCreatedDocuments: 32, preexistingDocuments: 2 };
    await api('POST', spacePath('/links'), { title: prefix + ' 保留的导航书签', url: 'https://example.invalid/activity/' + run, description: '活动组件保存后仍需保留的导航数据。', contextMarkdown: '用于验证组件配置不会改写导航。', categoryId: null, icon: 'lucide:link', iconMode: 'manual', tags: ['fixture'], isFavorite: true, sortOrder: 0, endpoints: [] }, 201);
    baselinePage = await api('GET', spacePath('/page')); baselineNavigation = records(await api('GET', spacePath('/navigation')));
    assert.ok(baselinePage.config.views.length <= 28, 'Fixture must have room for four more widgets; use a fresh dedicated data directory');
    report.baseline = { pageRevision: baselinePage.revision, pageConfigSHA256: digest(baselinePage.config), navigationSHA256: digest(baselineNavigation) };
    checkpoint();
  });

  await step('add all three presets, duplicate and configure instances through the UI', async () => {
    await home();
    if (Object.keys(ids).length) {
      report.resumedUI = { ids: { ...ids }, revision: savedPage.revision, action: 'Reuse previously saved fixture components; repeat interaction checks without adding duplicate widgets.' };
      // A later retry may resume after the explicit linking scenario. Reset
      // only that fixture component through UI so independence is tested first.
      if (savedPage.config.views.find(view => view.id === ids.split).interactionScope) {
        await enterEditor(); await configure(ids.split, { group: '' }); await save();
      }
    } else {
      await enterEditor();
      ids.heatmap = await addPreset('heatmap');
      await configure(ids.heatmap, { title: '我的文档活动', months: 3, width: 8, source: notes, timezone: 'Asia/Shanghai', group: 'review-' + run });
      const before = await layerIds(); await button('复制组件', 'Duplicate component', inspector()).click();
      const copies = (await layerIds()).filter(id => !before.includes(id)); assert.equal(copies.length, 1); ids.copy = copies[0];
      assert.equal(await label('日期联动组', 'Date linking group', inspector()).inputValue(), '', 'Copy starts independent even when its original is linked');
      await configure(ids.copy, { title: '项目记录', presentation: 'split', perspective: 'library', months: 12, source: projects, width: 8, fixedRows: 16, detailLayout: 'auto', recentLimit: 0 });
      ids.split = await addPreset('split');
      await configure(ids.split, { title: '编辑明细', perspective: 'mine', months: 6, source: notes, width: 24, timezone: 'Asia/Shanghai' });
      ids.month = await addPreset('month');
      await configure(ids.month, { title: '文档月历', perspective: 'library', source: projects, width: 12, timezone: 'Asia/Shanghai' });
      await capture('composer-three-presets-and-independent-copy-2560x1440');
      await save();
    }
    const views = Object.fromEntries(savedPage.config.views.map(value => [value.id, value]));
    assert.deepEqual([views[ids.heatmap].settings.presentation, views[ids.copy].settings.presentation, views[ids.split].settings.presentation, views[ids.month].settings.presentation], ['heatmap', 'split', 'split', 'month']);
    assert.deepEqual([views[ids.heatmap].settings.months, views[ids.copy].settings.months, views[ids.split].settings.months], [3, 12, 6]);
    assert.deepEqual(views[ids.heatmap].settings.sourceIds, [notes.id]); assert.deepEqual(views[ids.copy].settings.sourceIds, [projects.id]);
    assert.ok(!views[ids.copy].interactionScope); assert.equal(views[ids.copy].settings.perspective, 'library');
    assert.equal(savedPage.config.layout.placements[ids.copy].base.heightMode, 'fixed');
    assert.deepEqual(Object.values(ids).map(id => savedPage.config.layout.placements[id].base.w), [8, 8, 24, 12]);
    await home(true); for (const id of Object.values(ids)) await ready(id);
    assert.deepEqual(await api('GET', spacePath('/page')), savedPage, 'Full reload retains saved presets and configuration');
    await unchangedNavigation(); report.viewIds = ids;
  });

  await step('independent dates, periods and perspective remain transient', async () => {
    const others = Object.fromEntries(await Promise.all([ids.copy, ids.split, ids.month].map(async id => [id, await selectedDates(id)])));
    await day(ids.heatmap, dateAdd(fixtureDates.sampleDate, -2)).click(); await page.locator('.lh-activity-drawer').waitFor(); await page.keyboard.press('Escape'); await page.locator('.lh-activity-drawer').waitFor({ state: 'hidden' });
    for (const [id, selected] of Object.entries(others)) assert.deepEqual(await selectedDates(id), selected, 'Selection stays independent: ' + id);
    await day(ids.copy, dateAdd(fixtureDates.sampleDate, -1)).click(); await ready(ids.copy);
    assert.deepEqual(await selectedDates(ids.heatmap), [dateAdd(fixtureDates.sampleDate, -2)]);
    assert.deepEqual(await selectedDates(ids.split), others[ids.split]);
    const otherPeriods = await Promise.all([ids.copy, ids.split, ids.month].map(id => panel(id).locator('.lh-activity-period strong').innerText()));
    await button('上一时段', 'Previous period', panel(ids.heatmap)).click(); await ready(ids.heatmap);
    assert.deepEqual(await Promise.all([ids.copy, ids.split, ids.month].map(id => panel(id).locator('.lh-activity-period strong').innerText())), otherPeriods);
    await button('今天', 'Today', panel(ids.heatmap)).click(); await ready(ids.heatmap);
    await button('我的编辑', 'My edits', panel(ids.copy)).click(); await ready(ids.copy);
    assert.equal(await button('我的编辑', 'My edits', panel(ids.heatmap)).getAttribute('aria-pressed'), 'true');
    assert.equal(await button('文档库变更', 'Library changes', panel(ids.month)).getAttribute('aria-pressed'), 'true');
    await button('文档库变更', 'Library changes', panel(ids.copy)).click(); await ready(ids.copy);
    assert.deepEqual(await api('GET', spacePath('/page')), savedPage, 'Reading dates, paging periods and switching perspective never persist page settings');
  });

  await step('explicit date linking preserves per-instance directory and range', async () => {
    await enterEditor(); await configure(ids.split, { group: 'review-' + run }); await save();
    await home(true); for (const id of Object.values(ids)) await ready(id);
    const copyBefore = await selectedDates(ids.copy), date = dateAdd(fixtureDates.sampleDate, -2);
    await day(ids.heatmap, date).click(); await page.locator('.lh-activity-drawer').waitFor(); await page.keyboard.press('Escape'); await page.locator('.lh-activity-drawer').waitFor({ state: 'hidden' }); await ready(ids.split);
    assert.deepEqual(await selectedDates(ids.split), [date]); assert.deepEqual(await selectedDates(ids.copy), copyBefore);
    const views = Object.fromEntries(savedPage.config.views.map(value => [value.id, value]));
    assert.equal(views[ids.heatmap].interactionScope, views[ids.split].interactionScope);
    assert.deepEqual(views[ids.copy].settings.sourceIds, [projects.id]); assert.equal(views[ids.copy].settings.months, 12); assert.equal(views[ids.copy].settings.perspective, 'library');
    assert.equal(views[ids.heatmap].settings.months, 3); assert.equal(views[ids.split].settings.months, 6);
    await unchangedNavigation();
  });

  await step('calendar semantics, real tooltip and keyboard drawer focus restoration', async () => {
    if (continueFrom === 'calendar') { await home(); for (const id of Object.values(ids)) await ready(id); report.viewIds = { ...ids }; }
    const sampleDate = fixtureDates.sampleDate, actualToday = dateKey(new Date());
    const zero = day(ids.heatmap, dateAdd(sampleDate, -8)), unknown = day(ids.heatmap, dateAdd(sampleDate, -16));
    assert.equal(await zero.getAttribute('data-level'), '0'); assert.ok(!(await zero.getAttribute('class')).includes('is-unrecorded'));
    assert.ok((await unknown.getAttribute('class')).includes('is-unrecorded')); assert.match(await unknown.getAttribute('aria-label'), /尚未记录|Not recorded/);
    // The prior drawer restores focus to its date trigger. Separate this
    // pointer check from that focused tooltip and its hover transit region;
    // keyboard navigation and focus restoration are asserted below.
    await button('刷新文档活动', 'Refresh document activity', panel(ids.heatmap)).focus();
    await page.mouse.move(0, 0);
    const zeroLabel = await zero.getAttribute('aria-label');
    const zeroDateLabel = zeroLabel.slice(0, zeroLabel.lastIndexOf(', '));
    await zero.hover();
    // A previously focused date may still have an open Tooltip while the
    // hovered cell's delay is pending. Wait for this date, not any tooltip.
    await page.waitForFunction(expected => [...document.querySelectorAll('[role="tooltip"]')].some(node => node.querySelector('strong')?.textContent === expected), zeroDateLabel);
    const zeroTooltip = page.getByRole('tooltip').filter({ hasText: zeroDateLabel });
    assert.equal(await zeroTooltip.locator('strong').innerText(), zeroDateLabel);
    assert.match(await zeroTooltip.innerText(), /0 篇|0 documents/); await page.mouse.move(0, 0);
    assert.equal(await day(ids.heatmap, actualToday).getAttribute('aria-current'), 'date', 'Today marker follows the actual date, not the sample anchor');
    const futureDates = await panel(ids.month).locator('button[data-date]').evaluateAll((nodes, today) => nodes.filter(node => node.dataset.date > today).map(node => ({ date: node.dataset.date, disabled: node.disabled })), actualToday);
    assert.ok(futureDates.every(value => value.disabled), 'Future calendar cells are disabled');
    const calendarDates = await panel(ids.month).locator('button[data-date]').evaluateAll(nodes => nodes.map(node => node.dataset.date));
    const first = calendarDates[0], weekday = (new Date(first + 'T12:00:00Z').getUTCDay() + 6) % 7;
    const firstPosition = await panel(ids.month).locator('.lh-activity-grid.is-month > [role="row"]').first().evaluate(node => [...node.children].findIndex(item => item.hasAttribute('data-date')));
    assert.equal(firstPosition, weekday, 'Calendar date columns match the actual weekday');
    const grids = await page.locator('.lh-document-activity [role="grid"]').evaluateAll(nodes => nodes.map(grid => {
      const rows = [...grid.children].filter(node => node.getAttribute('role') === 'row'), columns = Number(grid.getAttribute('aria-colcount'));
      return { view: grid.closest('[data-activity-view]').dataset.activityView, rows: rows.length, declaredRows: Number(grid.getAttribute('aria-rowcount')), columns,
        invalidCells: [...grid.querySelectorAll('[role="gridcell"]')].filter(cell => cell.closest('[role="row"]')?.parentElement !== grid || Number(cell.getAttribute('aria-colindex')) < 1 || Number(cell.getAttribute('aria-colindex')) > columns).map(cell => cell.getAttribute('data-date')) };
    }));
    for (const grid of grids) { assert.equal(grid.rows, grid.declaredRows); assert.ok(grid.rows > 0); assert.deepEqual(grid.invalidCells, [], 'Every gridcell has its visual ARIA row and valid column'); }
    report.calendarStructure = grids;
    const twelveMonthFrom = monthStart(actualToday, -11), twelveMonthText = await panel(ids.copy).locator('.lh-activity-period strong').innerText();
    if (twelveMonthFrom.slice(0, 4) !== actualToday.slice(0, 4)) assert.ok(twelveMonthText.includes(twelveMonthFrom.slice(0, 4)) && twelveMonthText.includes(actualToday.slice(0, 4)), 'A cross-year period identifies both endpoint years');
    const legends = await panel(ids.heatmap).locator('.lh-activity-legend-item').evaluateAll(nodes => nodes.map(node => node.title));
    assert.ok(legends.every(value => !value.includes('NaN')) && legends[2].includes('2–3') && legends[4].includes('7+'));
    distinctPalette('heatmap', await palette(ids.heatmap), 5);
    let calendarPalette = await palette(ids.month), previousMonth = false;
    // Near a month boundary the 14-day fixture spans two calendars. Inspect
    // the previous one if needed, then return to the present month via UI.
    if (calendarPalette.length < 3) { await button('上个月', 'Previous month', panel(ids.month)).click(); await ready(ids.month); calendarPalette = await palette(ids.month); previousMonth = true; }
    distinctPalette('calendar', calendarPalette, 3);
    if (previousMonth) { await button('今天', 'Today', panel(ids.month)).click(); await ready(ids.month); }
    // Start on a known sample date so the keyboard-opened drawer has real
    // records even if the retry occurs one or more calendar days later.
    await day(ids.heatmap, sampleDate).focus(); await page.keyboard.press('ArrowUp');
    const expectedDate = dateAdd(sampleDate, -1);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-date')), expectedDate);
    const beforeScroll = await page.evaluate(() => scrollY); await page.keyboard.press('Enter');
    await page.locator('.lh-activity-drawer').waitFor(); await page.locator('.lh-activity-drawer .lh-activity-documents').waitFor();
    await geometry('keyboard-opened-date-drawer'); await capture('keyboard-date-drawer-2560x1440'); await page.keyboard.press('Escape');
    await page.locator('.lh-activity-drawer').waitFor({ state: 'hidden' });
    assert.equal(await day(ids.heatmap, expectedDate).evaluate(node => document.activeElement === node), true, 'Escape restores focus to the exact date cell');
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - beforeScroll) <= 2, 'Closing the drawer preserves the reader position');
  });

  await step('all-record pagination and document deep link are functional', async () => {
    await panel(ids.heatmap).locator('.lh-activity-footer button').click(); const drawer = page.locator('.lh-activity-drawer'); await drawer.waitFor();
    await drawer.locator('.lh-activity-documents > li').first().waitFor();
    const firstKeys = await drawer.locator('[data-activity-document]').evaluateAll(nodes => nodes.map(node => node.dataset.activityDocument + ':' + node.querySelector('time').dateTime));
    assert.equal(firstKeys.length, 20); assert.equal(await button('上一页记录', 'Previous records', drawer).isDisabled(), true);
    const responsePromise = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/v1' + spacePath('/document-activity') && url.searchParams.get('offset') === '20' && !url.searchParams.get('date'); });
    await button('下一页记录', 'Next records', drawer).click(); const nextResponse = await responsePromise; assert.equal(nextResponse.status(), 200); const next = await nextResponse.json();
    await page.waitForFunction(() => document.querySelector('.lh-activity-drawer .lh-activity-details')?.getAttribute('aria-busy') !== 'true');
    const secondKeys = await drawer.locator('[data-activity-document]').evaluateAll(nodes => nodes.map(node => node.dataset.activityDocument + ':' + node.querySelector('time').dateTime));
    assert.equal(secondKeys.length, next.items.length); assert.ok(secondKeys.length > 0); assert.ok(secondKeys.every(key => !firstKeys.includes(key))); assert.equal(next.total, (await activity(notes)).total);
    await geometry('all-records-second-page'); await capture('all-records-second-page-2560x1440');
    await button('关闭活动记录', 'Close activity records', drawer).click(); await drawer.waitFor({ state: 'hidden' });
    const link = panel(ids.heatmap).locator('.lh-activity-recent a').first();
    const href = await link.getAttribute('href'), query = new URLSearchParams(href.split('?')[1]), documentId = query.get('document');
    assert.equal(query.get('space'), shared.id); assert.ok(created.some(document => document.id === documentId));
    await link.click(); await page.locator('.library-document-heading[data-document-id="' + documentId + '"]').waitFor();
    assert.ok(page.url().endsWith(href)); await page.reload(); await page.locator('.library-document-heading[data-document-id="' + documentId + '"]').waitFor();
    await capture('document-deep-link-2560x1440'); await home(); for (const id of Object.values(ids)) await ready(id);
  });

  await step('four viewport captures and mixed 8/12/24-column containment', async () => {
    for (const viewport of [{ width: 2560, height: 1440 }, { width: 1920, height: 1080 }, { width: 1600, height: 900 }, { width: 2560, height: 1080 }]) {
      await page.setViewportSize(viewport); await page.evaluate(() => scrollTo(0, 0));
      const name = 'homepage-' + viewport.width + 'x' + viewport.height;
      const result = await geometry(name); assert.ok(Object.values(ids).every(id => result.panels.some(value => value.id === id)));
      const actualWidths = Object.fromEntries(result.panels.map(value => [value.id, value.bounds.width]));
      assert.ok(actualWidths[ids.heatmap] < actualWidths[ids.month] && actualWidths[ids.month] < actualWidths[ids.split], 'All three column widths coexist at this viewport');
      await capture(name, true);
    }
    await page.setViewportSize({ width: 1600, height: 900 }); await panel(ids.copy).scrollIntoViewIfNeeded();
    const fixed = panel(ids.copy).locator('.lh-activity-body');
    assert.ok(await fixed.evaluate(node => node.scrollHeight > node.clientHeight + 1), 'Narrow fixed-height component scrolls internally');
    const chart = panel(ids.copy).locator('.lh-activity-chart').first(), details = panel(ids.copy).locator('.lh-activity-content > .lh-activity-details');
    const chartBox = await chart.boundingBox(), detailsBox = await details.boundingBox();
    assert.ok(detailsBox.y >= chartBox.y + chartBox.height - 2, 'Narrow split keeps its mode and moves records below the chart');
    assert.equal(await panel(ids.copy).getAttribute('data-activity-presentation'), 'split');
    await fixed.evaluate(node => { node.scrollTop = node.scrollHeight; }); await geometry('narrow-fixed-height-scrolled'); await capture('narrow-fixed-height-8-columns-1600x900');
    await panel(ids.copy).locator('.lh-activity-footer button').click(); await page.locator('.lh-activity-drawer').waitFor(); await geometry('narrow-fixed-height-drawer'); await capture('narrow-fixed-height-drawer-1600x900');
    await page.keyboard.press('Escape'); await page.locator('.lh-activity-drawer').waitFor({ state: 'hidden' });
    assert.equal(await panel(ids.copy).locator('.lh-activity-footer button').evaluate(node => document.activeElement === node), true);
    await unchangedNavigation(); assert.deepEqual(await api('GET', spacePath('/page')), savedPage);
  });

  await step('public visitor and read-only member receive no private activity data', async () => {
    const visitor = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
    const visitorBoot = await bootstrap(visitor); assert.equal(visitorBoot.user ?? null, null); assert.equal(visitorBoot.mode, 'public_read');
    const visitorPage = await visitor.newPage(); observe(visitorPage, 'visitor'); await visitorPage.goto(base.origin + '/#/');
    await visitorPage.locator('[data-activity-view="' + ids.heatmap + '"]').waitFor();
    const visitorPanels = visitorPage.locator('.lh-document-activity');
    assert.equal(await visitorPanels.locator('.lh-activity-summary,.lh-activity-grid,.lh-activity-documents').count(), 0, 'Visitor widgets expose no counts, dates or document titles');
    const text = await visitorPage.locator('body').innerText(); for (const document of created) assert.ok(!text.includes(document.title), 'Private document title is absent for visitors');
    assert.match(await visitorPanels.first().innerText(), /登录后查看文档活动|Sign in to view document activity/);
    const denial = await api('GET', spacePath('/document-activity') + '?perspective=library', undefined, 401, visitor); assert.ok(!denial.items && !denial.days && !denial.summary);
    await capture('public-visitor-no-private-activity-1920x1080', true, visitorPage); await visitor.close();
    // Members may sign in only in private_multi. Temporarily switch this
    // fixture and always restore public_read, including on a failed assertion.
    const fixtureSettings = mode => ({ siteName: fixtureName, mode, registrationEnabled: false, autoFetchIcons: false, autoSelectEndpoint: false });
    await api('PUT', '/settings', fixtureSettings('private_multi'));
    let reader;
    try {
      boot = await bootstrap(); await api('POST', '/auth/login', account); boot = await bootstrap();
      const readerAccount = { username: 'activity-reader-' + run, password: 'Reader-' + randomBytes(20).toString('hex') };
      await api('POST', '/admin/users', { ...readerAccount, displayName: 'Activity read-only fixture' }, 201);
      reader = await browser.newContext(); await bootstrap(reader); await api('POST', '/auth/login', readerAccount, 200, reader); await bootstrap(reader);
      const denied = await api('GET', spacePath('/document-activity') + '?perspective=library', undefined, 403, reader); assert.equal(denied.code, 'document_activity_forbidden'); assert.ok(!denied.items && !denied.days && !denied.summary);
    } finally {
      await reader?.close(); boot = await bootstrap();
      if (!boot.user) { await api('POST', '/auth/login', account); boot = await bootstrap(); }
      await api('PUT', '/settings', fixtureSettings('public_read')); boot = await bootstrap(); await api('POST', '/auth/login', account); boot = await bootstrap();
      assert.equal(boot.mode, 'public_read'); report.finalMode = boot.mode;
    }
    await Promise.allSettled(pendingResponses);
    assert.equal(report.activityResponses.filter(value => value.identity === 'visitor' && value.status === 200).length, 0, 'Public UI never receives successful private activity responses');
  });
  await step('temporary iOS light and dark previews inherit theme colors without saving', async () => {
    await page.setViewportSize({ width: 2560, height: 1440 }); await home(true);
    const before = await api('GET', spacePath('/page')); assert.deepEqual(before, savedPage);
    await enterEditor(); await library().locator('.lh-composer-layer.is-page').click();
    await inspector().locator('.lh-composer-themes').waitFor(); await button('iOS 风格', 'iOS inspired', inspector()).click();
    await choose(select('配色', 'Color mode'), l('浅色', 'Light'));
    await button('预览', 'Preview', toolbar()).click();
    const preview = page.locator('.lh-composer-canvas > .lh-home[data-page-theme="builtin/ios"][data-theme="light"]'); await preview.waitFor();
    for (const id of Object.values(ids)) await ready(id);
    report.themePreview = await panel(ids.heatmap).evaluate(node => { const style = getComputedStyle(node); return { theme: 'builtin/ios', colorMode: 'light', accent: style.getPropertyValue('--lh-accent').trim(), surface: style.getPropertyValue('--lh-surface').trim(), saved: false }; });
    distinctPalette('temporary iOS heatmap', await palette(ids.heatmap), 5);
    await panel(ids.heatmap).scrollIntoViewIfNeeded(); await geometry('temporary-ios-light-preview'); await capture('temporary-ios-light-preview-2560x1440');
    for (const [name, id] of [['heatmap', ids.heatmap], ['split', ids.split], ['month', ids.month]]) {
      const component = panel(id), screenshotName = 'component-' + name + '-ios-light', file = path.join(out, screenshotName + '.png');
      await component.scrollIntoViewIfNeeded(); await component.screenshot({ path: file, animations: 'disabled' });
      report.screenshots.push({ name: screenshotName, file, viewport: page.viewportSize(), fullPage: false, scope: 'component', viewId: id });
    }
    await button('继续编辑', 'Keep editing', toolbar()).click();
    await choose(select('配色', 'Color mode'), l('深色', 'Dark')); await button('预览', 'Preview', toolbar()).click();
    await page.locator('.lh-composer-canvas > .lh-home[data-page-theme="builtin/ios"][data-theme="dark"]').waitFor();
    for (const id of Object.values(ids)) await ready(id);
    report.themePreview.dark = await panel(ids.heatmap).evaluate(node => { const style = getComputedStyle(node); return { accent: style.getPropertyValue('--lh-accent').trim(), surface: style.getPropertyValue('--lh-surface').trim() }; });
    await panel(ids.heatmap).scrollIntoViewIfNeeded(); await capture('temporary-ios-dark-preview-2560x1440');
    await button('继续编辑', 'Keep editing', toolbar()).click(); await button('取消', 'Cancel', toolbar()).click();
    const discard = page.getByRole('dialog', { name: l('放弃未保存的修改？', 'Discard unsaved changes?'), exact: true });
    await discard.waitFor({ state: 'visible' }); await button('放弃修改', 'Discard changes', discard).click();
    await discard.waitFor({ state: 'hidden' }); await editor().waitFor({ state: 'hidden' });
    assert.deepEqual(await api('GET', spacePath('/page')), before, 'Theme preview cancellation preserves the exact saved page and appearance');
    assert.equal(await page.locator('.lh-home:not([data-preview])').getAttribute('data-page-theme'), before.config.pageTheme.id);
    await unchangedNavigation();
    report.finalMode = boot.mode;
  });
  await Promise.allSettled(pendingResponses);
  for (const entry of report.consoleErrors) {
    let pathname = ''; try { pathname = new URL(entry.url).pathname; } catch {}
    const expected = report.expectedFailures.find(value => value.stage === entry.stage && entry.text.includes(String(value.status)) && (!pathname || value.path === pathname));
    entry.expected = !!expected; if (expected) entry.reason = expected.reason;
  }
  assert.deepEqual(report.pageErrors, [], 'Unexpected browser runtime errors');
  assert.deepEqual(report.consoleErrors.filter(value => value.type === 'error' && !value.expected), [], 'Unexpected browser console errors');
  report.status = 'passed';
}
main().catch(async error => {
  report.status = 'failed'; report.error = { stage, message: error.stack || String(error) }; console.error(report.error.message);
  if (page) await capture('failure').catch(() => {}); process.exitCode = 1;
}).finally(async () => {
  // Closing the task-owned browser rejects aborted body reads before waiting
  // on evidence. Each read also has a 5-second deadline in observe().
  try { await browser?.close(); report.cleanup = { browserClosed: !!browser }; }
  catch (error) { report.cleanup = { browserClosed: false, error: String(error) }; report.status = 'failed'; process.exitCode = 1; }
  await Promise.allSettled(pendingResponses); report.finishedAt = new Date().toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ status: report.status, report: reportPath, screenshots: report.screenshots.length }));
});
