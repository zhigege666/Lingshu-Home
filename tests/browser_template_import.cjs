#!/usr/bin/env node
'use strict';
/** Template-import UI acceptance against a FRESH disposable instance.
 * BASE_URL=http://127.0.0.1:5198 node tests/browser_template_import.cjs --disposable-instance
 * Run separately against fresh zh-CN/en instances; LINGSHU_EXPECT_LANGUAGE checks the run.
 * JSON preview, source creation, snapshot push and page writes use the real backend.
 * Webpage/JSON-URL discovery responses are explicitly mocked by context.route;
 * this tests discovery UI, not real publisher HTTP, DNS, TLS or redirect handling.
 * Foreign browser traffic and URL-bearing template requests without a known mock
 * are blocked. The only created source is external-push; no polling source is allowed.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const timeout = 15000, runId = randomUUID().slice(0, 12);
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:5198');
const reportPath = process.env.REPORT_PATH || path.join(os.tmpdir(), `home-template-import-${runId}.json`);
const sizes = [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080]];
let browser, context, page, boot, space, csrf = '', checks = 0, phase = 'preflight', failure, socketCount = 0;
const errors = [], consoleErrors = [], expectedConsoleErrors = [], expectedHTTP = [], requests = [], failedRequests = [];
const foreignRequests = [], screenshots = [], mockCalls = [], downloads = [], measurements = {}, samples = new Map(), mockedPreviews = new Map();
let heldDiscovery = null, pendingLateDelivery = null;
const mockURL = {
  publisher: 'https://publisher.invalid/components', finalPublisher: 'https://publisher.invalid/final/components',
  direct: 'https://publisher.invalid/direct-navigation.json', slow: 'https://publisher.invalid/delayed.json'
};
const check = (value, label) => { assert.ok(value, label); checks++; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const l = (zh, en) => boot.language === 'en' ? en : zh;
const step = label => { phase = label; process.stdout.write(JSON.stringify({ phase, checks }) + '\n'); };
const apiURL = relative => base.origin + '/api/v1' + relative;
const templatePath = suffix => `/spaces/${space.id}/component-templates/${suffix}`;
const readPage = () => api(`/spaces/${space.id}/page`);
const readSources = () => api(`/spaces/${space.id}/sources`);
const dialog = () => page.getByRole('dialog', { name: l('导入组件模板', 'Import a component template'), exact: true });
const button = (zh, en) => dialog().getByRole('button', { name: l(zh, en), exact: true });
const jsonInput = () => dialog().getByLabel(l('模板 JSON', 'Template JSON'), { exact: true });
async function until(predicate, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) { check(true, label); return; } await page.waitForTimeout(40); }
  throw new Error(label + ': condition did not become true');
}
async function api(relative, method = 'GET', body, status = 200) {
  if (method === 'POST' && relative.endsWith('/sources')) check(body?.kind === 'external-push' && body.sync?.mode === 'push', 'Test API cannot create a polling source');
  if (method === 'POST' && /\/component-templates\/(discover|preview)$/.test(relative)) check(!body?.url, 'Test API preview uses JSON only; URL discovery belongs to controlled UI mocks');
  const response = await context.request.fetch(apiURL(relative), { method, data: body, headers: { 'X-CSRF-TOKEN': csrf }, timeout, maxRedirects: 0 });
  const value = response.status() === 204 ? null : await response.json();
  equal(response.status(), status, `${method} ${relative}: real backend status (${value?.code || 'ok'})`);
  return value;
}
async function refreshBoot() { boot = await api('/bootstrap'); csrf = boot.csrfToken; }
async function select(locator, label) { await locator.click(); await page.getByRole('option', { name: label, exact: true }).click(); }
async function home() {
  await page.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.lh-home').waitFor();
  equal(await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.type), 'reload', 'Fixture home uses a fresh document after API writes');
  if (boot.spaces.length > 1) {
    const picker = page.getByRole('combobox', { name: l('选择空间', 'Choose a space'), exact: true });
    await picker.waitFor();
    if ((await picker.innerText()).trim() !== space.name.trim()) {
      const [response] = await Promise.all([
        page.waitForResponse(response => { const url = new URL(response.url()); return response.request().method() === 'GET' && url.origin === base.origin && url.pathname === '/api/v1/dashboard' && url.searchParams.get('spaceId') === space.id; }),
        select(picker, space.name)
      ]);
      equal(response.status(), 200, 'Selecting the shared fixture loads its dashboard');
      equal((await response.json()).space.id, space.id, 'Selected dashboard belongs to the shared fixture');
      await page.waitForLoadState('networkidle');
    }
    equal((await picker.innerText()).trim(), space.name.trim(), 'Home displays the shared fixture space');
  }
}
async function enterImport() {
  await page.locator('.lh-edit-menu summary').click(); await page.getByRole('button', { name: l('调整布局', 'Adjust layout'), exact: true }).click();
  await page.locator('.lh-composer').waitFor();
  await page.locator('.lh-composer-library-toggle').click();
  await page.getByRole('button', { name: l('导入组件模板', 'Import template'), exact: true }).click();
  await dialog().waitFor();
}
async function uiResponse(relative, method, action, status = 200, mocked = false) {
  if (status >= 400) expectedHTTP.push({ phase, url: apiURL(relative), status, method });
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url() === apiURL(relative) && response.request().method() === method), action()
  ]);
  equal(response.status(), status, `${method} ${relative}: ${mocked ? 'controlled mock' : 'real UI'} response`);
  equal(response.headers()['x-lingshu-test-mock'] === 'template-import', mocked, 'Response provenance is explicit');
  return { body: response.request().postDataJSON(), value: response.status() === 204 ? null : await response.json() };
}
async function reviewJSON(manifest) {
  await button('JSON 模板', 'JSON template').click();
  const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2);
  await jsonInput().fill(text);
  const result = await uiResponse(templatePath('preview'), 'POST', () => button('检查模板', 'Review template').click());
  await dialog().locator('.widget-import-review').waitFor();
  equal(result.body.manifest, JSON.parse(text), 'JSON review submits the edited manifest');
  equal(await jsonInput().inputValue(), text, 'Successful review preserves JSON input');
  return result.value;
}
async function capture(label, force = false) {
  const directory = process.env.SCREENSHOT_DIR || (force ? path.join(path.dirname(reportPath), 'screenshots') : null);
  if (!directory || !page || page.isClosed()) return;
  const target = path.join(directory, `templates-${boot?.language || 'unknown'}-${label}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target, fullPage: false, timeout }); screenshots.push(target);
}
async function geometry(label, selector = '.admin-dialog, .widget-import, .widget-import-review, .widget-import-discovery, .widget-import-example-content') {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const value = await page.evaluate(selector => ({
    width: innerWidth, height: innerHeight, client: document.documentElement.clientWidth,
    scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    items: [...document.querySelectorAll(selector)].filter(node => node.getClientRects().length).map(node => {
      const box = node.getBoundingClientRect();
      return { selector: node.className, x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height, client: node.clientWidth, scroll: node.scrollWidth };
    })
  }), selector);
  measurements[label] = value;
  check(value.scroll <= value.client + 1, `${label}: no horizontal document overflow`);
  check(value.items.length > 0, `${label}: expected UI is present`);
  for (const box of value.items) {
    check(box.width > 100 && box.height > 10, `${label}: usable component bounds`);
    check(box.x >= -1 && box.right <= value.width + 1, `${label}: horizontal bounds remain inside viewport`);
    check(box.scroll <= box.client + 1, `${label}: component content has no horizontal overflow`);
  }
  await capture(label);
}
async function fourDesktops(label, selector) {
  for (const [width, height] of sizes) { await page.setViewportSize({ width, height }); await geometry(`${label}-${width}x${height}`, selector); }
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function discardPage() {
  await page.locator('.lh-composer-toolbar-actions').getByRole('button', { name: l('取消', 'Cancel'), exact: true }).click();
  const discard = page.getByRole('dialog', { name: l('放弃未保存的修改？', 'Discard unsaved changes?'), exact: true });
  await discard.waitFor();
  await discard.getByRole('button', { name: l('放弃修改', 'Discard changes'), exact: true }).click();
  await page.locator('.lh-composer').waitFor({ state: 'hidden' }); await page.locator('.lh-home').waitFor();
}
function attachPage(p) {
  p.on('pageerror', error => errors.push({ phase, type: 'pageerror', message: error.message }));
  p.on('console', message => { if (message.type() === 'error') consoleErrors.push({ phase, text: message.text(), url: message.location().url || '' }); });
  p.on('request', request => requests.push({ phase, method: request.method(), url: request.url(), type: request.resourceType() }));
  p.on('requestfailed', request => { let body; try { body = request.postDataJSON(); } catch {} failedRequests.push({ phase, url: request.url(), type: request.resourceType(), error: request.failure()?.errorText, cancelledDiscovery: body?.url === mockURL.slow }); });
  p.on('websocket', socket => { socketCount++; errors.push({ phase, type: 'websocket', url: socket.url() }); });
  p.on('dialog', async native => { errors.push({ phase, type: 'native-dialog', message: native.type() }); await native.dismiss(); });
}
async function installIsolation() {
  context.on('page', attachPage);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    try {
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== base.origin) {
        foreignRequests.push({ phase, url: url.href, type: request.resourceType() }); await route.abort('blockedbyclient'); return;
      }
      if (url.origin !== base.origin || request.method() !== 'POST') { await route.continue(); return; }
      let body; try { body = request.postDataJSON(); } catch {}
      if (/\/sources$/.test(url.pathname) && (body?.kind !== 'external-push' || body?.sync?.mode !== 'push')) {
        errors.push({ phase, type: 'blocked-poll-source', kind: body?.kind }); await route.abort('blockedbyclient'); return;
      }
      const templateRequest = url.pathname === '/api/v1' + templatePath('discover') || url.pathname === '/api/v1' + templatePath('preview');
      if (!templateRequest || !body?.url) { await route.continue(); return; }
      const fulfill = value => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'x-lingshu-test-mock': 'template-import' }, body: JSON.stringify(value) });
      mockCalls.push({ phase, endpoint: url.pathname, sourceUrl: body.url, simulated: true });
      if (url.pathname.endsWith('/discover')) {
        if (body.url === mockURL.publisher) {
          const templates = [...mockedPreviews.entries()].map(([templateURL, preview]) => ({ url: templateURL, title: preview.manifest.name }));
          await fulfill({ sourceUrl: mockURL.finalPublisher, templates, truncated: true }); return;
        }
        if (body.url === mockURL.direct) {
          await fulfill({ sourceUrl: mockURL.direct, templates: [], truncated: false, preview: { ...samples.get('navigation').preview, sourceUrl: mockURL.direct } }); return;
        }
        if (body.url === mockURL.slow) {
          pendingLateDelivery = new Promise(resolve => {
            heldDiscovery = { release: resolve, phase, released: false, delivery: null };
          }).then(async () => {
            try { await fulfill({ sourceUrl: mockURL.slow, templates: [], truncated: false, preview: { ...samples.get('status').preview, sourceUrl: mockURL.slow } }); heldDiscovery.delivery = 'late response attempted after cancellation'; }
            catch (error) { heldDiscovery.delivery = 'cancelled request rejected late delivery'; heldDiscovery.transportMessage = error.message; }
          });
          await pendingLateDelivery; return;
        }
      } else if (mockedPreviews.has(body.url)) { await fulfill(mockedPreviews.get(body.url)); return; }
      errors.push({ phase, type: 'blocked-unmocked-template-url', url: body.url }); await route.abort('blockedbyclient');
    } catch (error) { errors.push({ phase, type: 'route-handler', message: error.message }); await route.abort().catch(() => {}); }
  });
}
async function sampleCoverage() {
  step('Seven downloadable and editable examples use the real backend preview');
  await enterImport();
  const originalSources = await readSources();
  const examples = [
    ['navigation', '书签导航', 'Bookmarks', 'navigation.collection'], ['favorites', '常用收藏', 'Favorites', 'navigation.collection'],
    ['calendar', '日程', 'Calendar', 'calendar.events'], ['weather', '天气', 'Weather', 'weather.forecast'],
    ['metrics', '统计指标', 'Metrics', 'metrics.summary'], ['status', '服务状态', 'Service status', 'status.collection'],
    ['github-traffic', 'GitHub Traffic', 'GitHub Traffic', 'github.traffic']
  ];
  await dialog().locator('.widget-import-examples > summary').click();
  for (const [slug, zh, en, schema] of examples) {
    await select(dialog().getByRole('combobox', { name: l('示例组件类型', 'Example component type'), exact: true }), l(zh, en));
    const [download] = await Promise.all([page.waitForEvent('download'), button('下载示例 JSON', 'Download example JSON').click()]);
    equal(download.suggestedFilename(), `lingshu-home-${slug}.json`, 'Download has the selected renderer filename');
    const bytes = await fs.promises.readFile(await download.path()), manifest = JSON.parse(bytes.toString('utf8'));
    equal(manifest.renderer, 'builtin/' + slug, 'Downloaded example contains the selected renderer');
    equal(manifest.dataSchema, { id: schema, version: 1 }, 'Downloaded example declares the correct schema/version');
    equal(manifest.format, 'lingshu-home-component', 'Downloaded example declares the component format');
    equal(manifest.manifestVersion, 1, 'Downloaded example uses the supported manifest version');
    check(!['bindings', 'connection', 'secret', 'sources', 'script', 'url'].some(key => Object.hasOwn(manifest, key)), 'Example does not embed credentials, page bindings or remote code');
    const downloadedPreview = await api(templatePath('preview'), 'POST', { manifest });
    await button('填入示例', 'Use example').click();
    equal(JSON.parse(await jsonInput().inputValue()), manifest, 'Use example fills the same downloaded JSON');
    const reviewed = await uiResponse(templatePath('preview'), 'POST', () => button('检查模板', 'Review template').click());
    await dialog().locator('.widget-import-review').waitFor();
    equal(reviewed.value.manifest, downloadedPreview.manifest, 'Filled example passes the real backend with identical normalized metadata');
    equal(reviewed.value.sha256, downloadedPreview.sha256, 'Download and fill preserve the same template content digest');
    check((await dialog().locator('.widget-import-review').innerText()).includes(schema + '@1'), 'Compatibility preview exposes the exact schema');
    equal(await dialog().locator('.widget-import-heading h3').innerText(), manifest.name, 'Review uses the selected template name');
    equal(await button('加入页面草稿', 'Add to page draft').isEnabled(), schema === 'navigation.collection', 'Only the compatible local navigation source enables binding before any source creation');
    samples.set(slug, { manifest, preview: reviewed.value });
    downloads.push({ renderer: manifest.renderer, filename: download.suggestedFilename(), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), backendAccepted: true, uiAccepted: true });
  }
  equal(await readSources(), originalSources, 'Previewing all seven examples creates no data source');
  await fourDesktops('examples-and-compatibility');
  check((await dialog().locator('.widget-import-example-content pre').innerText()).includes('rel="lingshu-home-component"'), 'Publisher head declaration example is available as inert text');
}
async function negativeCoverage() {
  step('Invalid JSON retains input and corrects without a request');
  const invalid = '{"format":"lingshu-home-component", "name":';
  await jsonInput().fill(invalid);
  const before = requests.filter(item => item.url === apiURL(templatePath('preview')) && item.method === 'POST').length;
  await button('检查模板', 'Review template').click(); await dialog().getByRole('alert').waitFor();
  equal(await jsonInput().inputValue(), invalid, 'Invalid JSON remains available for correction');
  equal(requests.filter(item => item.url === apiURL(templatePath('preview')) && item.method === 'POST').length, before, 'Malformed JSON is rejected without reaching the backend');
  equal(await dialog().locator('.widget-import-review').count(), 0, 'Invalid input clears the obsolete preview');
  check(await button('加入页面草稿', 'Add to page draft').isDisabled(), 'Invalid JSON cannot be applied');
  await reviewJSON(samples.get('navigation').manifest);
  equal(await dialog().getByRole('alert').count(), 0, 'Correcting JSON clears its error');

  step('Unknown renderer real 400 keeps JSON and permits correction');
  const unknown = { ...samples.get('metrics').manifest, renderer: 'https://publisher.invalid/external-widget.js' };
  const unknownText = JSON.stringify(unknown, null, 2); await jsonInput().fill(unknownText);
  await uiResponse(templatePath('preview'), 'POST', () => button('检查模板', 'Review template').click(), 400);
  await dialog().getByRole('alert').waitFor();
  equal(await jsonInput().inputValue(), unknownText, 'Unsupported renderer JSON is not lost on a real server rejection');
  check(await button('加入页面草稿', 'Add to page draft').isDisabled(), 'Unknown external renderer cannot be applied');
  equal(await dialog().locator('.widget-import-review').count(), 0, 'A rejected renderer has no compatibility approval');
  await capture('unknown-renderer-recovery');
  await reviewJSON(samples.get('navigation').manifest);
  equal(await dialog().getByRole('alert').count(), 0, 'Correcting the renderer succeeds through the same dialog');
}
async function localBinding() {
  step('Local navigation template binds existing bookmarks without creating a source');
  const beforePage = await readPage(), beforeSources = await readSources();
  equal((await dialog().getByRole('combobox', { name: l('数据来源', 'Data source'), exact: true }).innerText()).trim(), l('本地书签', 'Local bookmarks'), 'Local bookmarks are selected automatically');
  check(await button('加入页面草稿', 'Add to page draft').isEnabled(), 'Local template has an immediate compatible binding');
  await button('加入页面草稿', 'Add to page draft').click(); await dialog().waitFor({ state: 'hidden' });
  equal(await readPage(), beforePage, 'Adding a local template only changes the draft');
  equal(await readSources(), beforeSources, 'Local template requires no source creation');
  check(await page.getByRole('button', { name: l('保存页面', 'Save page'), exact: true }).isEnabled(), 'Adding a template marks the page draft as dirty');
  await discardPage(); equal(await readPage(), beforePage, 'Discard restores the persisted local page and revision');
}
async function sourceAndPersistence() {
  step('Missing metrics source can be created inline as external-push');
  await enterImport(); const preview = await reviewJSON(samples.get('metrics').manifest);
  const baseline = await readPage(), initialSources = await readSources();
  check(!initialSources.some(source => source.schemaId === 'metrics.summary'), 'Fresh fixture genuinely has no compatible metrics source');
  check(await button('加入页面草稿', 'Add to page draft').isDisabled(), 'Missing source prevents applying the template');
  await fourDesktops('missing-source-next-step');
  await button('创建兼容来源', 'Create a compatible source').click();
  const sourceDialog = page.getByRole('dialog', { name: l('添加数据来源', 'Add data source'), exact: true }); await sourceDialog.waitFor();
  const persistenceHint = sourceDialog.getByText(l('来源会立即保存到此空间；返回后仍保留当前模板预览和页面草稿。只有保存页面才会应用组件。', 'The source is saved to this space immediately. Your template preview and page draft will be kept when you return. The component is applied only when you save the page.'), { exact: true });
  await persistenceHint.waitFor({ state: 'visible' });
  check(await persistenceHint.isVisible(), 'Inline form visibly explains immediate source persistence, retained preview and page draft, and the separate page save');
  await select(sourceDialog.getByRole('combobox', { name: l('数据来源类型', 'Source type'), exact: true }), l('外部推送 / 日程文件导入', 'External push / Calendar file import'));
  const format = sourceDialog.getByRole('combobox', { name: l('组件数据格式', 'Component data format'), exact: true });
  check(await format.isDisabled(), 'Template-required schema is locked');
  equal((await format.innerText()).trim(), l('统计指标', 'Metrics'), 'Changing delivery mode preserves the required metrics schema');
  await sourceDialog.getByLabel(l('名称', 'Name'), { exact: true }).fill('Inline metrics ' + runId);
  await fourDesktops('inline-push-source', '.admin-dialog, .admin-dialog form');
  const created = await uiResponse(`/spaces/${space.id}/sources`, 'POST', () => sourceDialog.getByRole('button', { name: l('创建数据来源', 'Create source'), exact: true }).click(), 201);
  equal(created.body.kind, 'external-push', 'Inline UI creates a push source only');
  equal(created.body.sync.mode, 'push', 'Inline UI starts no background polling');
  equal(created.body.schemaId, 'metrics.summary', 'Inline UI persists the compatible schema');
  equal(created.body.connection, {}, 'Push source has no upstream URL or connection');
  await dialog().waitFor(); await dialog().locator('.widget-import-review').waitFor();
  equal(await jsonInput().inputValue(), JSON.stringify(samples.get('metrics').manifest, null, 2), 'Returning from source creation preserves the template JSON');
  equal(await dialog().locator('.widget-import-heading h3').innerText(), preview.manifest.name, 'Returning from source creation preserves the preview');
  equal((await dialog().getByRole('combobox', { name: l('数据来源', 'Data source'), exact: true }).innerText()).trim(), created.value.name, 'New compatible source is selected without leaving the import flow');
  check(await button('加入页面草稿', 'Add to page draft').isEnabled(), 'Inline-created source enables applying the template');
  check((await readSources()).some(source => source.id === created.value.id), 'The new source exists immediately');
  equal(await readPage(), baseline, 'Source creation does not persist page changes');
  equal(created.value.revision, '0', 'The inline-created source genuinely has no snapshot revision');
  equal(created.value.lastSuccessAt, null, 'The inline-created source has no successful snapshot time');
  const snapshotURL = apiURL(`/sources/${created.value.id}/snapshot`), sourceURL = apiURL(`/sources/${created.value.id}`);
  const [firstSnapshot, liveSource] = await Promise.all([
    page.waitForResponse(response => response.url() === snapshotURL && response.request().method() === 'GET'),
    page.waitForResponse(response => response.url() === sourceURL && response.request().method() === 'GET'),
    button('加入页面草稿', 'Add to page draft').click()
  ]);
  await dialog().waitFor({ state: 'hidden' });
  equal(firstSnapshot.status(), 404, 'Only this newly created source is expected to lack a first snapshot');
  equal(firstSnapshot.headers()['x-lingshu-test-mock'], undefined, 'Missing first snapshot is a real backend response');
  const missingSnapshot = await firstSnapshot.json();
  equal(missingSnapshot.code, 'not_found', 'The missing first snapshot has the exact backend error code');
  equal(liveSource.status(), 200, 'The preview checks that the source still exists after the snapshot 404');
  const live = await liveSource.json();
  equal(live.id, created.value.id, 'Live source verification uses this run’s exact newly created source ID');
  equal(live.datasetId, created.value.datasetId, 'Live source verification matches the component dataset');
  equal(live.revision, '0', 'Live source is still awaiting its first snapshot');
  equal(live.lastSuccessAt, null, 'Live source has never had a successful snapshot');
  equal(live.lastError, null, 'An upstream source failure is not classified as an empty first snapshot');
  const awaiting = page.locator('.lh-metrics-panel');
  await awaiting.getByText(l('等待数据', 'Awaiting data'), { exact: true }).waitFor({ state: 'visible' });
  check(await awaiting.getByText(l('还没有指标快照', 'No metrics snapshot yet'), { exact: true }).isVisible(), 'The component visibly explains that its first snapshot is still pending');
  check((await awaiting.getAttribute('aria-busy')) !== 'true', 'Awaiting the first push does not leave a permanent loading state');
  equal(await awaiting.locator('.lh-metric').count(), 0, 'An empty first snapshot does not invent metric values');
  measurements.awaitingFirstSnapshot = { sourceId: live.id, datasetId: live.datasetId, revision: live.revision, status: firstSnapshot.status(), code: missingSnapshot.code, uiState: await awaiting.locator('.lh-data-state').innerText(), emptyMessage: await awaiting.locator('.lh-data-empty strong').innerText() };
  expectedHTTP.push({ phase, url: snapshotURL, status: 404, method: 'GET', code: missingSnapshot.code, sourceId: live.id, datasetId: live.datasetId, verifiedResponse: true, reason: 'Verified first snapshot missing for the exact live newly created source; UI visibly awaits data' });
  await capture('new-source-awaiting-first-snapshot');
  equal(await readPage(), baseline, 'Adding the bound template still only changes the draft');
  await discardPage(); equal(await readPage(), baseline, 'Discarding the bound template leaves the original page revision unchanged');
  check((await readSources()).some(source => source.id === created.value.id), 'Discarding the page intentionally retains the explicitly created source');

  step('Explicit page save persists renderer, source binding and template provenance');
  await api(`/sources/${created.value.id}/snapshot`, 'PUT', { requestId: 'template-' + runId, expectedRevision: '0', schemaId: 'metrics.summary', schemaVersion: 1, data: { metrics: [{ id: 'requests', label: 'Template fixture requests', value: 42, unit: '/min', min: 0, max: 100, status: 'ok' }] } });
  await enterImport(); const checked = await reviewJSON(samples.get('metrics').manifest);
  await button('加入页面草稿', 'Add to page draft').click(); await dialog().waitFor({ state: 'hidden' });
  const saved = await uiResponse(`/spaces/${space.id}/page`, 'PUT', () => page.getByRole('button', { name: l('保存页面', 'Save page'), exact: true }).click());
  await page.locator('.lh-composer').waitFor({ state: 'hidden' });
  const persisted = await readPage(), imported = persisted.config.views.find(view => view.template?.id === checked.manifest.id);
  check(!!imported, 'Saved page contains the imported template instance');
  equal(imported.panel.id, 'builtin/metrics', 'Saved template uses the bundled metrics renderer');
  equal(imported.template.sha256, checked.sha256, 'Saved template retains the exact validated content digest');
  check(/^[a-f0-9]{64}$/.test(imported.template.sha256), 'Provenance digest is SHA-256');
  equal(imported.template.version, checked.manifest.version, 'Template version is persisted');
  equal(imported.settings.showBars, true, 'Validated template settings are persisted');
  equal(persisted.config.bindings[imported.inputs.metrics].datasetId, created.value.datasetId, 'Page binds the actual inline-created source');
  equal(saved.value.config, persisted.config, 'Read-after-save matches the actual UI save response');
  equal(persisted.config.pageTheme, baseline.config.pageTheme, 'Template import preserves the chosen page theme');
  equal(persisted.config.chrome, baseline.config.chrome, 'Template import preserves existing header and footer configuration');
  await home(); await page.getByText('Template fixture requests', { exact: true }).waitFor();
  for (const theme of ['builtin/dashboard', 'builtin/ios']) {
    const current = await readPage(), config = structuredClone(current.config); config.pageTheme = { id: theme };
    await api(`/spaces/${space.id}/page`, 'PUT', { name: current.name, expectedRevision: current.revision, config });
    await home(); await page.getByText('Template fixture requests', { exact: true }).waitFor();
    await fourDesktops('saved-' + theme.slice(8), '.lh-home, .lh-metrics-panel');
  }
}
async function webpageMocks() {
  step('Controlled webpage discovery lists templates and previews only the selected declaration');
  let index = 0;
  for (const value of samples.values()) {
    const url = `https://publisher.invalid/template-${index++}.json`;
    mockedPreviews.set(url, { ...value.preview, sourceUrl: url });
  }
  const eighth = 'https://publisher.invalid/template-7.json';
  mockedPreviews.set(eighth, { ...samples.get('navigation').preview, sourceUrl: eighth });
  await enterImport(); await dialog().getByLabel(l('模板或发布页面地址', 'Template or publisher page URL'), { exact: true }).fill(mockURL.publisher);
  await uiResponse(templatePath('discover'), 'POST', () => button('检查模板', 'Review template').click(), 200, true);
  await dialog().locator('.widget-import-discovery').waitFor();
  check((await dialog().locator('.widget-import-discovery').innerText()).includes(mockURL.finalPublisher), 'Discovery displays the reported final publisher URL');
  check((await dialog().locator('.widget-import-discovery').innerText()).includes(l('仅显示前 8 个', 'only the first 8 are shown')), 'Truncated discovery offers the direct-JSON fallback');
  equal(await dialog().locator('.widget-import-review').count(), 0, 'Multiple declarations require a concrete preview selection');
  const targetURL = 'https://publisher.invalid/template-2.json', selected = mockedPreviews.get(targetURL);
  const before = mockCalls.filter(item => item.endpoint.endsWith('/preview')).length;
  await select(dialog().getByRole('combobox', { name: l('选择网页模板', 'Choose a page template'), exact: true }), selected.manifest.name + ' · ' + targetURL);
  equal(mockCalls.filter(item => item.endpoint.endsWith('/preview')).length, before, 'Selecting a declaration does not fetch it before Review selected template');
  await uiResponse(templatePath('preview'), 'POST', () => button('检查选中模板', 'Review selected template').click(), 200, true);
  await dialog().locator('.widget-import-review').waitFor();
  equal(await dialog().locator('.widget-import-heading h3').innerText(), selected.manifest.name, 'Selected declaration controls the preview');
  check((await dialog().locator('.widget-import-review').innerText()).includes(selected.manifest.dataSchema.id + '@1'), 'Selected declaration exposes its own required schema');
  check((await dialog().locator('.widget-import-review').innerText()).includes(targetURL), 'Selected template provenance uses the actual selected declaration');
  check(await button('加入页面草稿', 'Add to page draft').isDisabled(), 'An unrelated existing metrics source is not compatible with a calendar template');
  await fourDesktops('publisher-selection');

  step('Controlled direct JSON URL discovery reuses its preview without an extra fetch');
  await dialog().getByLabel(l('模板或发布页面地址', 'Template or publisher page URL'), { exact: true }).fill(mockURL.direct);
  const previewCount = mockCalls.filter(item => item.endpoint.endsWith('/preview')).length;
  await uiResponse(templatePath('discover'), 'POST', () => button('检查模板', 'Review template').click(), 200, true);
  await dialog().locator('.widget-import-review').waitFor();
  equal(mockCalls.filter(item => item.endpoint.endsWith('/preview')).length, previewCount, 'Direct JSON discovery needs no second preview request');
  equal(await dialog().locator('.widget-import-discovery').count(), 0, 'Direct JSON does not show an unnecessary publisher selector');
  equal(await dialog().locator('.widget-import-heading h3').innerText(), samples.get('navigation').manifest.name, 'Direct JSON review is visible');
  check(await button('加入页面草稿', 'Add to page draft').isEnabled(), 'Direct JSON navigation template can use local bookmarks');

  step('Cancel delayed discovery; a late response cannot replace the new real JSON preview');
  await dialog().getByLabel(l('模板或发布页面地址', 'Template or publisher page URL'), { exact: true }).fill(mockURL.slow);
  await button('检查模板', 'Review template').click();
  await until(() => !!heldDiscovery, 'Controlled delayed request is waiting');
  await button('停止读取', 'Stop loading').click();
  equal(await dialog().getByLabel(l('模板或发布页面地址', 'Template or publisher page URL'), { exact: true }).inputValue(), mockURL.slow, 'Stopping a request retains its URL');
  check(await button('检查模板', 'Review template').isEnabled(), 'Stopping immediately enables a fresh review');
  const newPreview = await reviewJSON(samples.get('metrics').manifest);
  heldDiscovery.released = true; heldDiscovery.release(); await pendingLateDelivery;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  equal(await dialog().locator('.widget-import-heading h3').innerText(), newPreview.manifest.name, 'Late cancelled discovery cannot overwrite a newer real preview');
  check((await dialog().locator('.widget-import-review').innerText()).includes('metrics.summary@1'), 'New preview keeps its metrics compatibility');
  equal(await dialog().getByRole('alert').count(), 0, 'Cancelled request does not become an obsolete error after a successful retry');
  await capture('cancelled-discovery-recovered');
  const beforePage = await readPage();
  await button('取消', 'Cancel').click(); await dialog().waitFor({ state: 'hidden' });
  await page.locator('.lh-composer-toolbar-actions').getByRole('button', { name: l('取消', 'Cancel'), exact: true }).click();
  await page.locator('.lh-composer').waitFor({ state: 'hidden' });
  equal(await readPage(), beforePage, 'All mocked publisher previews remain read-only');
}
function verifyConsole() {
  const unmatchedHTTP = [...expectedHTTP];
  for (const entry of consoleErrors) {
    const responseIndex = unmatchedHTTP.findIndex(item => item.phase === entry.phase && item.url === entry.url && new RegExp('^Failed to load resource: the server responded with a status of ' + item.status + '\\b').test(entry.text));
    const expectedResponse = responseIndex < 0 ? null : unmatchedHTTP.splice(responseIndex, 1)[0];
    const cancelled = /^(Failed to load resource: )?net::ERR_ABORTED$/.test(entry.text) && failedRequests.some(item => item.cancelledDiscovery && item.url === entry.url && item.phase === entry.phase);
    if (expectedResponse || cancelled) expectedConsoleErrors.push({ ...entry, reason: expectedResponse ? expectedResponse.reason || 'Specific intentional real backend rejection' : 'Specific cancelled delayed discovery' });
    else errors.push({ ...entry, type: 'unexpected-console-error' });
  }
}
async function run() {
  check(process.argv.includes('--disposable-instance'), 'Disposable-instance opt-in is required');
  check(base.protocol === 'http:' && !base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'A plain local test origin is required');
  check(['127.0.0.1', 'localhost', '10.233.233.61'].includes(base.hostname), 'Only an approved local test host is accepted');
  check(base.port && !['5180', '5182', '5183', '5184', '5185', '5194', '5195', '5196', '5197'].includes(base.port), 'Daily, demo, previous component, icon and routing instances are protected');
  const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--disable-dev-shm-usage', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])] });
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'en-US', serviceWorkers: 'block', acceptDownloads: true });
  context.setDefaultTimeout(timeout); context.setDefaultNavigationTimeout(timeout);
  await refreshBoot(); equal(boot.initialized, false, 'Existing initialized instances are refused before any write');
  check(['zh-CN', 'en'].includes(boot.language), 'Instance language is supported');
  if (process.env.LINGSHU_EXPECT_LANGUAGE) equal(boot.language, process.env.LINGSHU_EXPECT_LANGUAGE, 'Language matches the requested isolated run');
  await api('/setup', 'POST', { siteName: 'Home template acceptance ' + runId, mode: 'open_edit', seedDemo: false, username: 'template-owner', displayName: 'Template owner', password: 'Fixture-' + randomUUID() }, 201);
  await refreshBoot(); space = boot.spaces.find(item => item.kind === 'shared');
  check(space?.published && space.canEdit && boot.user?.role === 'Owner', 'Fresh test owns an authenticated editable shared space');
  await api(`/spaces/${space.id}/links`, 'POST', { title: 'Template local bookmark', url: 'https://bookmark.invalid/', icon: 'lucide:bookmark', iconMode: 'manual', tags: [], endpoints: [] }, 201);
  const originalNavigation = await api(`/spaces/${space.id}/navigation`);
  equal(originalNavigation.data.links.length, 1, 'Fixture has only its own manual-icon bookmark');
  await installIsolation(); page = await context.newPage();
  await home();
  const cold = await page.evaluate(() => performance.getEntriesByType('resource').map(item => item.name));
  check(!cold.some(url => /WidgetImportDialog-|component-template-examples-|SourceDialog-/.test(url)), 'Cold navigation does not load the optional import/source tools');
  measurements.coldNavigationResources = cold;
  await sampleCoverage(); await negativeCoverage(); await localBinding(); await sourceAndPersistence(); await webpageMocks();
  step('Complete script, network and persistence audit');
  equal((await api(`/spaces/${space.id}/navigation`)).data, originalNavigation.data, 'Template workflows preserve the authoritative local navigation');
  const sources = await readSources(), external = sources.filter(source => source.datasetId.startsWith('source:'));
  equal(external.length, 1, 'Only the explicitly created metrics source persists');
  check(external.every(source => source.kind === 'external-push' && source.sync.mode === 'push'), 'No calendar/weather/API polling source was created');
  check(!requests.some(item => item.method === 'POST' && /\/sync$/.test(new URL(item.url).pathname)), 'Import and preview do not request upstream synchronization');
  equal(foreignRequests, [], 'No preview, template or source operation requests foreign browser resources');
  const scriptURLs = await page.evaluate(() => [...document.scripts].filter(script => script.src).map(script => script.src));
  check(scriptURLs.every(url => new URL(url).origin === base.origin), 'Every executed script is served by Home');
  check(requests.filter(item => item.type === 'script').every(item => new URL(item.url).origin === base.origin), 'Complete session loads no external script');
  equal(socketCount, 0, 'Import workflow opens no WebSocket');
  verifyConsole(); equal(errors, [], 'No unexpected browser runtime/console/network errors; intentional failures remain reported');
  step('completed');
}
run().catch(async error => {
  failure = error; errors.push({ phase, type: 'assertion', message: error.stack || error.message });
  process.stderr.write(phase + ': ' + error.message + '\n');
  try { if (page && !page.isClosed()) measurements.failure = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, url: location.href })); await capture('failure-' + runId, true); }
  catch (captureError) { errors.push({ phase, type: 'failure-capture', message: captureError.message }); }
}).finally(async () => {
  if (heldDiscovery && !heldDiscovery.released) { heldDiscovery.released = true; heldDiscovery.release(); }
  if (pendingLateDelivery) await pendingLateDelivery.catch(() => {});
  await browser?.close();
  const report = {
    status: failure ? 'failed' : 'passed', runId, phase, origin: base.origin, language: boot?.language, checks,
    scope: { real: ['JSON template validation', 'inline external-push source creation', 'source snapshot push', 'page draft/cancel/save', 'local navigation preservation'], controlledMocks: ['webpage multi-template discovery', 'direct JSON URL discovery', 'late cancelled discovery'], excluded: ['live publisher HTTP/DNS/TLS/redirect behavior', 'real provider data or accounts'], desktops: sizes, languageRun: 'Run separately on fresh zh-CN and en instances' },
    downloads, measurements, screenshots, errors, consoleErrors, expectedConsoleErrors, expectedHTTP, failedRequests,
    mockCalls, lateDelivery: heldDiscovery ? { released: heldDiscovery.released, result: heldDiscovery.delivery, transportMessage: heldDiscovery.transportMessage } : null,
    foreignRequests, scriptRequests: requests.filter(item => item.type === 'script'), browserRequestCount: requests.length, socketCount, completedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: report.status, language: report.language, checks, phase, reportPath }) + '\n');
  if (failure) process.exitCode = 1;
});
