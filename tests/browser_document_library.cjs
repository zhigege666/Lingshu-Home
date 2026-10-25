#!/usr/bin/env node
'use strict';
// Only a dedicated local, disposable fixture is allowed. The fixture's document roots must be
// <repository>/.runtime/document-library/mounts. Never run this against production or user data.
// BASE_URL=http://127.0.0.1:5188 node tests/browser_document_library.cjs --allow-fixture-write
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:5188');
assert.ok(process.argv.includes('--allow-fixture-write'), 'Explicit --allow-fixture-write is required');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && base.port === '5188' && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash, 'Only the dedicated local document fixture on port 5188 is allowed');
const repository = path.resolve(__dirname, '..');
const fixture = path.join(repository, '.runtime', 'document-library');
const temporaryMount = process.env.LINGSHU_DOCUMENT_FIXTURE_MOUNTS;
const mountRoot = temporaryMount || path.join(fixture, 'mounts');
if (temporaryMount) {
  assert.match(temporaryMount, /^\/tmp\/lingshu-document-library-fixture-[a-f0-9]{8}\/mounts$/, 'Temporary mounts must use the dedicated disposable fixture prefix');
  assert.equal(fs.realpathSync(temporaryMount), temporaryMount, 'Temporary fixture paths cannot use symbolic links');
  assert.equal(fs.readFileSync(path.join(path.dirname(temporaryMount), 'fixture.guard'), 'utf8'), 'Document library fixture zh-CN\n', 'Temporary fixture guard is required');
}
const run = randomUUID().slice(0, 8), prefix = 'Library ' + run;
const out = path.join(fixture, 'browser-' + run); fs.mkdirSync(out, { recursive: true });
const report = { origin: base.origin, mountRoot, startedAt: new Date().toISOString(), run, checks: [], screenshots: [], pageErrors: [], consoleErrors: [], expectedFailures: [], documentRequests: [], documentResponses: [], fileEvents: [] };
const pendingResponses = [];
const credentialsFile = path.join(fixture, 'browser-fixture-account.json');
const fixtureName = 'Document library fixture zh-CN';
let browser, context, page, boot, csrf, shared, personal, notes, readonly, operations, document, bookmark, fileWatcher, stage = 'preflight';
const l = (zh, en) => boot.language === 'en' ? en : zh;
const button = (zh, en, scope = page) => scope.getByRole('button', { name: l(zh, en), exact: true });
const label = (zh, en, scope = page) => scope.getByLabel(l(zh, en), { exact: true });
const documentsPath = space => '/spaces/' + space.id + '/documents';
const sourcesPath = space => '/spaces/' + space.id + '/document-sources';
async function api(method, suffix, data, expected = 200, target = context) {
  const response = await target.request.fetch(base.origin + '/api/v1' + suffix, { method, data, headers: { 'X-CSRF-TOKEN': csrf || '' }, maxRedirects: 0 });
  const body = await response.text();
  assert.equal(response.status(), expected, method + ' ' + suffix + ': HTTP ' + response.status() + ' ' + body.slice(0, 300));
  if (expected >= 400) report.expectedFailures.push({ stage, status: expected, method, pathname: '/api/v1' + suffix, reason: 'Deliberate negative API assertion' });
  return body ? JSON.parse(body) : null;
}
async function step(name, action) { stage = name; console.log(JSON.stringify({ step: name })); const started = Date.now(); await action(); report.checks.push({ name, durationMs: Date.now() - started, status: 'passed' }); }
async function choose(control, text) { await control.click(); await page.getByRole('option', { name: text, exact: true }).click(); }
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function capture(name) { await settle(); const file = path.join(out, name + '.png'); await page.screenshot({ path: file, fullPage: false }); report.screenshots.push(file); }
async function library() {
  if (page.url() === base.origin + '/#/library') await page.reload(); else await page.goto(base.origin + '/#/library'); await page.locator('.library-shell').waitFor();
  const value = await label('选择空间', 'Choose a space').innerText();
  if (!value.includes(shared.name)) { await choose(label('选择空间', 'Choose a space'), shared.name); }
  await page.locator('.library-table').waitFor(); await settle();
}
async function filterCurrentRun() {
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1' + documentsPath(shared) && new URL(response.url()).searchParams.get('q') === prefix && response.request().method() === 'GET');
  await label('搜索资料库', 'Search library').fill(prefix); await waiting;
  await page.locator('.library-row-title').filter({ hasText: document.title }).first().waitFor();
}
async function openDocument(id) {
  const latest = await api('GET', documentsPath(shared) + '/' + id);
  const heading = page.locator('.library-document-heading[data-document-id="' + id + '"]');
  if (!await heading.count()) {
    const waiting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1' + documentsPath(shared) + '/' + id && response.request().method() === 'GET');
    await page.locator('.library-row-title[data-resource-id="' + id + '"]').click();
    const loaded = await (await waiting).json(); assert.equal(loaded.id, id); assert.equal(loaded.revision, latest.revision);
  }
  await heading.waitFor(); await page.locator('.library-document-body').waitFor(); return latest;
}
async function mutation(action, pathname, method = 'POST', expected = 200) {
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1' + pathname && response.request().method() === method);
  await action(); const response = await waiting;
  const body = response.status() === 204 ? '' : await response.text();
  assert.equal(response.status(), expected, method + ' ' + pathname + ': ' + body);
  if (expected >= 400) report.expectedFailures.push({ stage, status: expected, method, pathname: '/api/v1' + pathname, reason: 'Deliberate negative browser mutation assertion' });
  return body ? JSON.parse(body) : null;
}
async function dimensions(name) {
  await settle();
  const value = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    controls: [...document.querySelectorAll('.library-topbar button,.library-brand,.library-search,.library-editor-footer button,.docdirs-dialog .admin-form-footer button,.docdirs-dialog .cn-dialog-close')].filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden').map(element => {
      const box = element.getBoundingClientRect(); return { label: element.getAttribute('aria-label') || element.textContent, left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    }) }));
  assert.ok(value.scrollWidth <= value.width + 1, name + ': horizontal overflow');
  for (const control of value.controls) assert.ok(control.left >= -1 && control.top >= -1 && control.right <= value.width + 1 && control.bottom <= value.height + 1, name + ': offscreen control ' + JSON.stringify(control));
  report.checks.push({ name, status: 'passed', geometry: value }); await capture(name);
}
async function main() {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1, timezoneId: 'Asia/Shanghai' }); context.setDefaultTimeout(15000);
  boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken;
  let account;
  if (!boot.initialized) {
    account = { username: 'library-fixture', password: 'Fixture-' + randomBytes(24).toString('hex') };
    fs.writeFileSync(credentialsFile, JSON.stringify(account), { mode: 0o600 });
    if (boot.languageSelectionRequired) { await api('POST', '/setup/language', { language: 'zh-CN' }); boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken; }
    await api('POST', '/setup', { siteName: fixtureName, mode: 'public_read', username: account.username, password: account.password, displayName: 'Library fixture', seedDemo: false }, 201);
  } else {
    assert.equal(boot.siteName, fixtureName, 'Existing data does not belong to this disposable fixture');
    assert.ok(fs.existsSync(credentialsFile), 'The known fixture credential file is required'); account = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
    await api('POST', '/auth/login', account);
  }
  boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken;
  assert.equal(boot.siteName, fixtureName); assert.equal(boot.user?.role, 'Owner');
  await api('PUT', '/settings', { siteName: fixtureName, mode: 'public_read', registrationEnabled: false, autoFetchIcons: false, autoSelectEndpoint: false });
  boot = await api('GET', '/bootstrap'); csrf = boot.csrfToken; shared = boot.spaces.find(space => space.kind === 'shared'); personal = boot.spaces.find(space => space.kind === 'personal'); assert.ok(shared && personal);
  const sourceConfig = await api('GET', sourcesPath(shared)); assert.ok(sourceConfig.roots.includes(mountRoot), 'Fixture root is not in the server allowlist');
  const mounts = path.join(mountRoot, 'ui-' + run); for (const name of ['notes', 'projects', 'operations']) fs.mkdirSync(path.join(mounts, name), { recursive: true });
  const markdown = '---\ntitle: ' + prefix + ' handbook\ncustom: preserve-me\n---\n# ' + prefix + ' handbook\n\n## Preparation\n\n- [ ] Verify configuration\n- [x] Back up data\n\n[Related note](other.md)\n\n![Local image](image%20name.png)\n\n[Unsafe](javascript:alert(1))\n\n<script>window.__libraryInjected = true</script>\n\n```sh\nprintf "example"\n```\n';
  const primaryFile = path.join(mounts, 'notes', 'README.md'); fs.writeFileSync(primaryFile, markdown);
  fs.writeFileSync(path.join(mounts, 'notes', 'other.md'), '# ' + prefix + ' linked note\n\nA separate note.\n');
  fs.writeFileSync(path.join(mounts, 'notes', 'image name.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9WQAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(path.join(mounts, 'projects', 'README.md'), '# ' + prefix + ' read-only\n\nOriginal project notes.\n');
  fs.writeFileSync(path.join(mounts, 'operations', 'private.md'), '# ' + prefix + ' private\n\nPersonal space contents.\n');
  bookmark = await api('POST', '/spaces/' + shared.id + '/links', { title: prefix + ' Jenkins', url: 'https://example.invalid/' + run, description: 'Build and deploy project applications.', contextMarkdown: 'Use this service for test deployments.', categoryId: null, icon: 'lucide:link', iconMode: 'manual', tags: ['operations'], isFavorite: true, sortOrder: 0, endpoints: [] }, 201);
  page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push({ stage, text: error.message })); page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ stage, text: message.text().slice(0, 300), url: message.location().url || '' }); });
  page.on('request', request => {
    const url = new URL(request.url()); if (!url.pathname.includes('/documents')) return;
    let payload; try { payload = request.postDataJSON(); } catch {}
    if (payload?.content !== undefined) payload = { ...payload, contentSHA256: createHash('sha256').update(payload.content).digest('hex'), content: undefined };
    report.documentRequests.push({ at: new Date().toISOString(), stage, method: request.method(), path: url.pathname + url.search, payload });
  });
  page.on('response', response => {
    const url = new URL(response.url()); if (!url.pathname.includes('/documents') || url.pathname.includes('/asset')) return;
    const currentStage = stage;
    pendingResponses.push((async () => { try {
      const data = response.status() === 204 ? null : await response.json();
      report.documentResponses.push({ at: new Date().toISOString(), stage: currentStage, method: response.request().method(), path: url.pathname + url.search, httpStatus: response.status(), id: data?.id, revision: data?.revision, status: data?.status, contentSHA256: data?.content !== undefined ? createHash('sha256').update(data.content).digest('hex') : undefined, code: data?.code, currentRevision: data?.currentRevision });
    } catch {} })());
  });
  await context.route('**/*', route => new URL(route.request().url()).origin === base.origin || ['blob:', 'data:'].includes(new URL(route.request().url()).protocol) ? route.continue() : route.abort());
  await step('connect a writable directory through the real settings form', async () => {
    await page.goto(base.origin + '/#/admin?tab=documents'); await page.locator('.docdirs-workspace').waitFor(); await button('添加目录', 'Add directory').click();
    const dialog = page.getByRole('dialog'); await label('名称', 'Name', dialog).fill(prefix + ' Notes'); await label('容器目录', 'Container directory', dialog).fill(path.join(mounts, 'notes'));
    await choose(label('归属空间', 'Space', dialog), shared.name); await choose(label('访问方式', 'Access', dialog), l('允许写回原文件', 'Allow writing original files'));
    await dialog.locator('.docdirs-check-field').filter({ hasText: l('默认写入', 'Default directory') }).getByRole('checkbox').click();
    notes = await mutation(() => button('检查并接入', 'Check and connect', dialog).click(), sourcesPath(shared), 'POST', 201); await dialog.waitFor({ state: 'hidden' });
    assert.equal(notes.readOnly, false); assert.equal(notes.defaultWrite, true); assert.equal(fs.readFileSync(primaryFile, 'utf8'), markdown, 'Connecting does not rewrite the file');
    readonly = await api('POST', sourcesPath(shared), { name: prefix + ' Projects', path: path.join(mounts, 'projects'), readOnly: true, defaultWrite: false, defaultFolder: '', scanIntervalSeconds: 60 }, 201);
    operations = await api('POST', sourcesPath(personal), { name: prefix + ' Operations', path: path.join(mounts, 'operations'), readOnly: false, defaultWrite: true, defaultFolder: '', scanIntervalSeconds: 60 }, 201);
    await api('POST', sourcesPath(shared) + '/' + notes.id + '/scan', {}); await api('POST', sourcesPath(shared) + '/' + readonly.id + '/scan', {}); await api('POST', sourcesPath(personal) + '/' + operations.id + '/scan', {});
    const found = await api('GET', documentsPath(shared) + '?sourceId=' + notes.id); document = found.items.find(item => item.relativePath === 'README.md'); assert.ok(document);
  });
  await step('unified library reads real Markdown, relative images and related notes without active HTML', async () => {
    await library(); await openDocument(document.id);
    assert.ok(await page.locator('.library-markdown img').first().evaluate(image => image.complete && image.naturalWidth === 1));
    assert.equal(await page.evaluate(() => window.__libraryInjected), undefined);
    assert.equal(await page.locator('.library-markdown a[href^="javascript:"]').count(), 0);
    await page.locator('.library-markdown').getByRole('link', { name: 'Related note', exact: true }).click(); await page.locator('.library-document-heading h2').filter({ hasText: prefix + ' linked note' }).waitFor();
    await openDocument(document.id); await capture('library-original-document-2560x1440');
  });
  await step('create and rename write real files while retaining the document ID', async () => {
    await button('新建文档', 'New document').click(); const dialog = page.getByRole('dialog');
    await label('文件相对路径', 'Relative file path', dialog).fill('created/new-note.md'); await label('Markdown 正文', 'Markdown content', dialog).fill('# ' + prefix + ' created note\n\nCreated in Home.\n');
    const created = await mutation(() => button('创建文档', 'Create document', dialog).click(), documentsPath(shared), 'POST', 201); await dialog.waitFor({ state: 'hidden' });
    assert.equal(fs.readFileSync(path.join(mounts, 'notes', 'created/new-note.md'), 'utf8'), '# ' + prefix + ' created note\n\nCreated in Home.\n');
    await page.locator('.library-document-heading h2').filter({ hasText: created.title }).waitFor(); await button('重命名', 'Rename').click();
    await label('新相对路径', 'New relative path', page.getByRole('dialog')).fill('created/renamed-note.md');
    const renamed = await mutation(() => button('保存名称', 'Save name', page.getByRole('dialog')).click(), documentsPath(shared) + '/' + created.id + '/rename');
    assert.equal(renamed.id, created.id); assert.equal(fs.existsSync(path.join(mounts, 'notes', 'created/new-note.md')), false); assert.equal(fs.existsSync(path.join(mounts, 'notes', 'created/renamed-note.md')), true);
    await page.getByRole('dialog').waitFor({ state: 'hidden' }); await openDocument(document.id);
  });
  await step('editing writes the original file and preserves front matter', async () => {
    await button('编辑', 'Edit', page.locator('.library-preview')).click(); const editor = label('Markdown 文档正文', 'Markdown document content');
    assert.equal(await editor.inputValue(), markdown); await editor.fill(markdown + '\nSaved through Home.\n');
    await mutation(() => button('保存原文件', 'Save original file').click(), documentsPath(shared) + '/' + document.id, 'PUT');
    assert.equal(fs.readFileSync(primaryFile, 'utf8'), markdown + '\nSaved through Home.\n'); assert.ok(fs.readFileSync(primaryFile, 'utf8').includes('custom: preserve-me'));
  });
  await step('external conflicts preserve the draft and space changes respect unsaved protection', async () => {
    await button('编辑', 'Edit', page.locator('.library-preview')).click(); const editor = label('Markdown 文档正文', 'Markdown document content');
    const draft = (await editor.inputValue()) + '\nUnsaved browser draft.\n'; await editor.fill(draft);
    const external = markdown + '\nExternal editor change.\n'; fs.writeFileSync(primaryFile, external);
    await mutation(() => button('保存原文件', 'Save original file').click(), documentsPath(shared) + '/' + document.id, 'PUT', 409);
    assert.equal(await editor.inputValue(), draft); assert.equal(fs.readFileSync(primaryFile, 'utf8'), external);
    await choose(label('选择空间', 'Choose a space'), personal.name); await page.getByRole('dialog', { name: l('放弃未保存的修改？', 'Discard unsaved changes?') }).waitFor();
    await button('继续编辑', 'Keep editing').click(); assert.equal(await editor.inputValue(), draft);
    await button('重新读取', 'Reload', page.locator('.library-preview')).click(); await button('放弃修改', 'Discard changes').click();
    await page.locator('.library-markdown').filter({ hasText: 'External editor change.' }).waitFor(); assert.equal(await editor.count(), 0);
  });
  await step('document relations and bookmark usage notes use revision-checked APIs', async () => {
    await button('关联与标签', 'Links and tags').click(); const dialog = page.getByRole('dialog'); await label('标签', 'Tags', dialog).fill('deployment, reference'); await label('查找书签', 'Find bookmarks', dialog).fill(prefix);
    await dialog.locator('.library-link-picker label').filter({ hasText: bookmark.title }).getByRole('checkbox').click();
    await mutation(() => button('保存', 'Save', dialog).click(), documentsPath(shared) + '/' + document.id + '/metadata', 'PUT'); await dialog.waitFor({ state: 'hidden' });
    const detail = await api('GET', documentsPath(shared) + '/' + document.id); assert.deepEqual(detail.linkedBookmarkIds, [bookmark.id]); assert.deepEqual(detail.tags, ['deployment', 'reference']);
    await page.locator('.library-row-title').filter({ hasText: bookmark.title }).click(); await button('编辑说明', 'Edit notes').click();
    await label('书签使用说明', 'Bookmark usage notes').fill('Use the staging environment.\n\nSearch marker ' + run);
    await mutation(() => button('保存说明', 'Save notes').click(), '/spaces/' + shared.id + '/links/' + bookmark.id + '/context', 'PUT');
    await page.locator('.library-linked-documents button').filter({ hasText: document.title }).waitFor();
    await label('搜索资料库', 'Search library').fill('Search marker ' + run); await page.locator('.library-row-title').filter({ hasText: bookmark.title }).waitFor();
    await label('搜索资料库', 'Search library').fill(''); await page.locator('.library-row-title').filter({ hasText: document.title }).waitFor();
  });
  await step('read-only directories allow metadata without original file editing', async () => {
    const list = await api('GET', documentsPath(shared) + '?sourceId=' + readonly.id); const ro = list.items[0]; assert.ok(ro); await openDocument(ro.id);
    assert.equal(await button('编辑', 'Edit', page.locator('.library-preview')).count(), 0); assert.equal(await button('删除原文件', 'Delete original file').count(), 0);
    await button('关联与标签', 'Links and tags').click(); await label('标签', 'Tags', page.getByRole('dialog')).fill('readonly-reference');
    await mutation(() => button('保存', 'Save', page.getByRole('dialog')).click(), documentsPath(shared) + '/' + ro.id + '/metadata', 'PUT'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(fs.readFileSync(path.join(mounts, 'projects', 'README.md'), 'utf8'), '# ' + prefix + ' read-only\n\nOriginal project notes.\n');
  });
  await step('publication freezes content and authorized attachments; personal documents remain private', async () => {
    await openDocument(document.id); await button('发布', 'Publish', page.locator('.library-preview')).click();
    await mutation(() => button('确认发布', 'Publish', page.getByRole('dialog')).click(), documentsPath(shared) + '/' + document.id + '/publish'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const visitor = await browser.newContext();
    const published = await api('GET', documentsPath(shared) + '/' + document.id, undefined, 200, visitor); assert.ok(published.content.includes('External editor change.'));
    const asset = await visitor.request.get(base.origin + '/api/v1' + documentsPath(shared) + '/' + document.id + '/asset?path=image%20name.png'); assert.equal(asset.status(), 200);
    const personalDocs = await api('GET', documentsPath(personal) + '?sourceId=' + operations.id); assert.ok(personalDocs.items.length);
    await api('GET', documentsPath(personal) + '/' + personalDocs.items[0].id, undefined, 404, visitor);
    fs.writeFileSync(primaryFile, published.content + '\nUnpublished external draft.\n'); await api('POST', sourcesPath(shared) + '/' + notes.id + '/scan', {});
    const unchanged = await api('GET', documentsPath(shared) + '/' + document.id, undefined, 200, visitor); assert.equal(unchanged.content, published.content);
    const privateDraft = await api('GET', documentsPath(shared) + '/' + document.id); assert.equal(privateDraft.hasUnpublishedChanges, true);
    await visitor.close(); await button('刷新资料库', 'Refresh library').click(); await page.locator('.library-markdown').filter({ hasText: 'Unpublished external draft.' }).waitFor();
  });
  await step('original-file deletion retains history and restores through the UI', async () => {
    fileWatcher = fs.watch(path.dirname(primaryFile), (event, filename) => {
      if (String(filename) !== 'README.md') return;
      const change = { at: new Date().toISOString(), timestamp: Date.now(), event, exists: fs.existsSync(primaryFile) };
      if (change.exists) { try { change.revision = createHash('sha256').update(fs.readFileSync(primaryFile)).digest('hex'); } catch (error) { change.readError = error.code; } }
      report.fileEvents.push(change);
    });
    await library(); await openDocument(document.id); await button('删除原文件', 'Delete original file').click();
    const deleted = await mutation(() => button('确认删除原文件', 'Delete original file', page.getByRole('dialog')).click(), documentsPath(shared) + '/' + document.id, 'DELETE', 200); assert.equal(deleted.status, 'missing'); await page.getByRole('dialog').waitFor({ state: 'hidden' }); await page.locator('.library-preview').waitFor({ state: 'hidden' }); assert.equal(fs.existsSync(primaryFile), false);
    await page.locator('.library-row-title').filter({ hasText: document.title }).first().waitFor(); const missing = await openDocument(document.id); assert.equal(missing.status, 'missing'); assert.equal(missing.revision, deleted.revision); await button('历史', 'History').click();
    await page.locator('.library-history-list button').first().click(); await label('历史版本内容', 'Historical version content').waitFor();
    const retained = await label('历史版本内容', 'Historical version content').inputValue(); await button('恢复此版本', 'Restore version').click();
    report.restorePreflight = { at: new Date().toISOString(), path: primaryFile, exists: fs.existsSync(primaryFile), selectedRevision: createHash('sha256').update(retained).digest('hex'), expectedRevision: missing.revision };
    if (report.restorePreflight.exists) report.restorePreflight.actualRevision = createHash('sha256').update(fs.readFileSync(primaryFile)).digest('hex');
    assert.equal(report.restorePreflight.exists, false, 'The original must still be absent immediately before restoration');
    await mutation(() => button('确认写回原文件', 'Confirm restoration').click(), documentsPath(shared) + '/' + document.id + '/restore'); await page.getByRole('dialog').waitFor({ state: 'hidden' }); assert.equal(fs.readFileSync(primaryFile, 'utf8'), retained);
  });
  await step('four desktop sizes and a narrow screen preserve usable reading and editing', async () => {
    await filterCurrentRun();
    for (const [width, height] of [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080], [390, 844]]) {
      await page.setViewportSize({ width, height }); if (width === 390) { await button('关闭预览', 'Close preview').click(); await choose(label('筛选文档目录', 'Filter document directory'), notes.name); await page.locator('.library-row-title[data-resource-id="' + document.id + '"]').waitFor(); await choose(label('筛选文档目录', 'Filter document directory'), l('全部目录', 'All directories')); await button('全部', 'All', page.locator('.library-filters')).click(); await dimensions(`library-list-${width}x${height}`); const bounds = await page.locator('.library-content').boundingBox(); assert.ok(bounds.width >= width - 1, 'Narrow list uses the full available width'); await openDocument(document.id); } await dimensions(`library-reader-${width}x${height}`); await button('编辑', 'Edit', page.locator('.library-preview')).click(); await dimensions(`library-editor-${width}x${height}`); await button('取消', 'Cancel', page.locator('.library-editor-footer')).click();
    }
  });
  await step('directory settings have reachable fixed actions and disconnect preserves original files', async () => {
    await page.setViewportSize({ width: 2560, height: 1440 }); await page.goto(base.origin + '/#/admin?tab=documents'); await page.locator('.docdirs-table').waitFor();
    const row = page.locator('.docdirs-table tbody tr').filter({ hasText: notes.name }); await button('编辑', 'Edit', row).click(); await page.locator('.docdirs-dialog').waitFor();
    for (const [width, height] of [[2560, 1440], [1920, 1080], [1600, 900], [2560, 1080], [390, 844]]) { await page.setViewportSize({ width, height }); await dimensions(`directory-settings-${width}x${height}`); }
    await button('取消', 'Cancel', page.getByRole('dialog')).click(); await page.setViewportSize({ width: 2560, height: 1440 });
    const projectFile = path.join(mounts, 'projects', 'README.md'), projectBody = fs.readFileSync(projectFile, 'utf8');
    fs.unlinkSync(projectFile); const projectRow = page.locator('.docdirs-table tbody tr').filter({ hasText: readonly.name });
    const anomalous = await mutation(() => button('检查变更', 'Check changes', projectRow).click(), sourcesPath(shared) + '/' + readonly.id + '/scan'); assert.equal(anomalous.status, 'error');
    await button('确认缺失文件', 'Confirm missing files', projectRow).click();
    const confirmed = await mutation(() => button('确认文件已移除', 'Confirm files were removed', page.getByRole('dialog')).click(), sourcesPath(shared) + '/' + readonly.id + '/scan'); assert.equal(confirmed.status, 'ready');
    assert.equal(fs.existsSync(projectFile), false); fs.writeFileSync(projectFile, projectBody); await api('POST', sourcesPath(shared) + '/' + readonly.id + '/scan', {});
    await button('刷新文档目录', 'Refresh document directories').click(); await projectRow.waitFor();
    const fileBefore = fs.readFileSync(projectFile, 'utf8'); await button('解绑目录 ' + readonly.name, 'Disconnect directory ' + readonly.name).click();
    await mutation(() => button('确认解绑', 'Disconnect', page.getByRole('dialog')).click(), sourcesPath(shared) + '/' + readonly.id, 'DELETE', 204);
    assert.equal(fs.readFileSync(path.join(mounts, 'projects', 'README.md'), 'utf8'), fileBefore); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  });
  await library(); await filterCurrentRun(); await openDocument(document.id); await capture('final-library-2560x1440');
  assert.deepEqual(report.pageErrors, [], 'Unexpected browser runtime error');
  for (const entry of report.consoleErrors) {
    const expected = report.expectedFailures.find(failure => failure.stage === entry.stage && entry.text.includes(String(failure.status)) && (!entry.url || new URL(entry.url).pathname === failure.pathname));
    entry.expected = !!expected;
    if (expected) entry.reason = expected.reason + ': ' + expected.method + ' ' + expected.pathname + ' -> ' + expected.status;
  }
  assert.deepEqual(report.consoleErrors.filter(entry => !entry.expected), [], 'Unexpected console errors');
  report.renamePersistence = { at: new Date().toISOString(), previousPathExists: fs.existsSync(path.join(mounts, 'notes', 'created/new-note.md')), renamedPathExists: fs.existsSync(path.join(mounts, 'notes', 'created/renamed-note.md')) };
  assert.equal(report.renamePersistence.previousPathExists, false, 'The old path must remain absent after renaming');
  assert.equal(report.renamePersistence.renamedPathExists, true, 'The renamed original must still exist');
  report.status = 'passed';
}
main().catch(async error => { report.status = 'failed'; report.error = { stage, message: error.stack || String(error) }; console.error(report.error.message); if (page) await capture('failure').catch(() => {}); process.exitCode = 1; }).finally(async () => { fileWatcher?.close(); await Promise.allSettled(pendingResponses); report.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ status: report.status, report: path.join(out, 'report.json') })); await browser?.close(); });
