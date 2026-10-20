#!/usr/bin/env node
'use strict';
/**
 * Real icon-picker acceptance, only on the designated ownerless demo clones.
 * BASE_URL=http://10.233.233.61:5184 node tests/browser_icons.cjs --allow-demo-write
 * The same runner accepts 5185 (English). Optional --fetch-website exercises an
 * explicit favicon fetch; its positive/negative server cache is retained.
 * WEBSITE_ICON_URL defaults to https://github.com; the only other allowed roots
 * are https://www.typescriptlang.org/ and https://developer.mozilla.org/.
 * No existing link, category, page, account, setting, or icon pack is writable.
 * UI creates one unique link and a unique original geometric image pack. Both
 * are deleted through the UI, with guarded ID-only API cleanup in finally.
 * LINGSHU_PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE, REPORT_PATH, SCREENSHOT_DIR work
 * like the other browser runners. Screenshots use a real 2560 x 1440 viewport.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const STEP = 12_000, FETCH_STEP = 25_000, argv = process.argv.slice(2), runId = randomUUID();
const websiteIconURL = process.env.WEBSITE_ICON_URL || 'https://github.com';
const websiteIconOrigins = ['https://github.com', 'https://www.typescriptlang.org', 'https://developer.mozilla.org'];
const title = `LH icon ${runId}`, packName = `LH icons ${runId}`, invalidPackName = `LH invalid icons ${runId}`;
const license = 'Original geometric browser-test fixture for Lingshu-Home, created for this test. Apache-2.0.';
const color = runId.replaceAll('-', '').slice(0, 6);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="15" fill="#${color}"/><path d="M18 18h11v17h17v11H18z" fill="#ffffff"/></svg>`;
// This input is only staged as file bytes and submitted to the sanitizer. It is
// never placed in the DOM, opened as a document, or used as an executable image.
const invalidSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" onclick="void 0"><rect width="64" height="64" fill="#${color}"/></svg>`;
const singlePayload = { schemaVersion: 1, name: packName, sourceUrl: '', license, icons: [{ key: 'icon', label: packName, mediaType: 'image/svg+xml', dataBase64: Buffer.from(svg).toString('base64') }] };
const invalidPayload = { schemaVersion: 1, name: invalidPackName, sourceUrl: '', license, icons: [
  { ...singlePayload.icons[0], key: 'first-valid', label: 'Valid image before rejected entry' },
  { key: 'second-invalid', label: 'Rejected event attribute', mediaType: 'image/svg+xml', dataBase64: Buffer.from(invalidSVG).toString('base64') },
] };
const reportPath = path.resolve(process.env.REPORT_PATH || path.join(os.tmpdir(), `lingshu-icons-${runId}.json`));
let browser, context, page, base, bootstrap, space, originalNavigation, originalPage, originalPacks, approved = false;
let assertions = 0, currentStep = 'preflight', armed = null;
const attempts = [], blocked = [], routeErrors = [], pageErrors = [], consoleErrors = [], nativeDialogs = [], screenshots = [], cleanups = [];
const createdLinks = new Map(), createdPacks = new Map(), pendingForwards = new Set();
const details = { fixture: { title, url: websiteIconURL, packName, invalidPackName }, images: {}, favicon: { status: 'not-requested', target: websiteIconURL, reason: 'Enable --fetch-website to allow explicit server-side retrieval of the selected public website icon.' } };
const check = (value, message) => { assert.ok(value, message); assertions++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const step = value => { currentStep = value; emit({ event: 'step', label: value, assertions }); };
const l = (zh, en) => bootstrap.language === 'en' ? en : zh;
const relative = suffix => '/spaces/' + encodeURIComponent(space.id) + suffix;
const endpoint = suffix => base.origin + '/api/v1' + suffix;
const apiPath = suffix => '/api/v1' + relative(suffix);
const records = navigation => ({ categories: [...navigation.data.categories].sort((a, b) => a.id.localeCompare(b.id)), links: [...navigation.data.links].sort((a, b) => a.id.localeCompare(b.id)) });
const sortedPacks = packs => [...packs].sort((a, b) => a.id.localeCompare(b.id));
async function read(suffix) {
  const response = await context.request.get(endpoint(suffix), { timeout: STEP, maxRedirects: 0 });
  check(response.ok(), `GET ${suffix}: HTTP ${response.status()}`); return response.json();
}
const readNavigation = () => read(relative('/navigation'));
const readPage = () => read(relative('/page'));
const readPacks = async () => (await read(relative('/icon-packs'))).packs;
async function waitFor(callback, label) {
  const deadline = Date.now() + STEP;
  while (Date.now() < deadline) { if (await callback()) return; await new Promise(resolve => setTimeout(resolve, 35)); }
  throw new Error(`Timed out: ${label}`);
}
async function capture(name) {
  if (!process.env.SCREENSHOT_DIR || !page) return;
  const directory = path.resolve(process.env.SCREENSHOT_DIR); fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `icons-${bootstrap?.language || 'unknown'}-${name}.png`);
  await page.screenshot({ path: target, fullPage: false, timeout: STEP }); screenshots.push(target);
}
function ownLinkInput(ref) {
  return { title, url: websiteIconURL, description: '', categoryId: null, icon: ref, tags: [], isFavorite: false, sortOrder: 0, endpoints: [] };
}
function matchesInput(link, input) { return isDeepStrictEqual(Object.fromEntries(Object.keys(input).map(key => [key, link[key]])), input); }
function validAsset(asset) {
  check(asset && asset.ref === `asset:${space.id}:${asset.sha256}` && /^[0-9a-f]{64}$/.test(asset.sha256), 'Asset reference belongs to this space and a SHA-256 digest');
  equal(asset.url, apiPath('/icons/' + asset.sha256), 'Server returns a same-origin protected asset URL');
  check(['image/png', 'image/jpeg', 'image/svg+xml'].includes(asset.mediaType) && asset.width > 0 && asset.height > 0, 'Asset response has supported image metadata');
}
function rememberCreation(gate, body) {
  if (gate.kind === 'create-link' && body && /^[0-9a-f]{32}$/.test(body.id || '') && body.spaceId === space.id && matchesInput(body, gate.body)) {
    check(!originalNavigation.data.links.some(link => link.id === body.id), 'New link ID cannot identify an original record'); createdLinks.set(body.id, body);
  }
  if (gate.kind === 'import-pack' && body && /^[0-9a-f]{32}$/.test(body.id || '') && body.spaceId === space.id && body.name === gate.body.name && body.license === license && body.sourceUrl === '' && Array.isArray(body.icons)) {
    check(!originalPacks.some(pack => pack.id === body.id), 'New library ID cannot identify an original pack'); createdPacks.set(body.id, body);
  }
}
async function installGuard() {
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== base.origin) { blocked.push({ method, url: url.origin + url.pathname, type: request.resourceType(), reason: 'outside the demo origin' }); return route.abort('blockedbyclient'); }
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
    const attempt = { method, path: url.pathname, step: currentStep }; attempts.push(attempt);
    const gate = armed;
    let body = null; try { if (request.postData()) body = request.postDataJSON(); } catch { /* rejected below */ }
    if (!approved || !gate || gate.method !== method || gate.path !== url.pathname || url.search || !isDeepStrictEqual(body, gate.body)) {
      blocked.push({ ...attempt, reason: 'outside the one exact armed UI mutation' }); return route.abort('blockedbyclient');
    }
    if (method === 'DELETE' && !(gate.kind === 'delete-link' && createdLinks.has(gate.id) || gate.kind === 'delete-pack' && createdPacks.has(gate.id))) {
      blocked.push({ ...attempt, reason: 'deletion lacks a captured creation receipt from this run' }); return route.abort('blockedbyclient');
    }
    armed = null; attempt.kind = gate.kind; attempt.bodySha256 = hash(body);
    const forwarding = (async () => {
      try {
        const response = await route.fetch({ timeout: gate.timeout, maxRedirects: 0 });
        attempt.status = response.status();
        let responseBody = null; if (response.status() !== 204) { try { responseBody = await response.json(); } catch { /* asserted by callers when required */ } }
        // Capture cleanup IDs before handing the response to React, including
        // unexpected successful imports during a negative-path assertion.
        if (response.ok()) rememberCreation(gate, responseBody);
        await route.fulfill({ response }); gate.resolve({ status: response.status(), body: responseBody });
      } catch (error) { routeErrors.push({ step: currentStep, message: error.message }); await route.abort('failed').catch(() => {}); gate.reject(error); }
    })();
    pendingForwards.add(forwarding); await forwarding; pendingForwards.delete(forwarding);
  });
}
async function uiWrite(spec, action) {
  check(armed === null, 'Only one write may be armed at a time');
  let timer;
  const gate = { timeout: STEP, body: null, ...spec };
  gate.done = new Promise((resolve, reject) => { gate.resolve = resolve; gate.reject = reject; timer = setTimeout(() => reject(new Error(`No completed UI mutation: ${gate.method} ${gate.path}`)), gate.timeout + STEP); });
  // Keep the rejection handled while Playwright waits for the click action.
  gate.done.catch(() => {}); armed = gate;
  try {
    await action(); const result = await gate.done;
    if (gate.status !== undefined) equal(result.status, gate.status, `${gate.kind}: expected HTTP ${gate.status}`);
    return result;
  } finally { if (armed === gate) armed = null; clearTimeout(timer); await Promise.allSettled([...pendingForwards]); }
}
async function unchangedOriginals(label, expectedExtra = []) {
  const current = await readNavigation();
  equal(records(current), { ...records(originalNavigation), links: [...originalNavigation.data.links, ...expectedExtra].sort((a, b) => a.id.localeCompare(b.id)) }, `${label}: every existing link and category field is unchanged`);
  equal(await readPage(), originalPage, `${label}: the complete page and its revision are unchanged`);
  return current;
}
async function admin() {
  await page.goto(base.origin + '/#/admin?tab=links', { waitUntil: 'domcontentloaded', timeout: STEP });
  await page.locator('.admin-main').waitFor({ state: 'visible', timeout: STEP });
  await page.getByRole('searchbox', { name: l('搜索链接列表', 'Search links'), exact: true }).waitFor({ state: 'visible', timeout: STEP });
}
async function newDialog() {
  await page.getByRole('button', { name: l('添加链接', 'Add link'), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: l('添加链接', 'Add link'), exact: true });
  await dialog.waitFor({ state: 'visible', timeout: STEP }); return dialog;
}
async function cancel(dialog) {
  await dialog.locator('.admin-form-footer').getByRole('button', { name: l('取消', 'Cancel'), exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: STEP });
}
async function selectedImage(picker, source, label) {
  const image = picker.locator('.lh-icon-picker-current img');
  await waitFor(() => image.evaluateAll((nodes, expected) => nodes.length === 1 && nodes[0].getAttribute('src') === expected && nodes[0].complete && nodes[0].naturalWidth > 0, source), `${label}: selected preview decodes`);
}
async function decodedImage(locator, asset, label) {
  await waitFor(() => locator.evaluateAll((nodes, expected) => nodes.length >= 1 && nodes.every(node => node.getAttribute('src') === expected && node.complete && node.naturalWidth > 0), asset.url), `${label}: persisted asset decodes`);
  const info = await locator.evaluateAll(nodes => nodes.map(node => ({ src: node.currentSrc || node.src, naturalWidth: node.naturalWidth, naturalHeight: node.naturalHeight, filter: getComputedStyle(node).filter, className: node.className })));
  for (const image of info) { equal(new URL(image.src).origin, base.origin, `${label}: the visitor image uses only this origin`); equal(image.filter, 'none', `${label}: imported colors are not inverted`); }
  details.images[label] = info;
}
async function selectLibrary(picker, pack) {
  await picker.getByRole('tab', { name: l('图标库', 'Libraries'), exact: true }).click();
  const chooser = picker.getByRole('combobox', { name: l('选择图标库', 'Choose icon library'), exact: true });
  await chooser.waitFor({ state: 'visible', timeout: STEP });
  if (!(await chooser.textContent()).includes(pack.name)) {
    await chooser.click(); await page.getByRole('option', { name: `${pack.name} (${pack.icons.length})`, exact: true }).click();
  }
}
async function deletePackUI(picker, pack, status) {
  equal((await readPacks()).find(item => item.id === pack.id), pack, 'Library deletion first reads and verifies this run\'s exact created pack');
  await selectLibrary(picker, pack);
  await picker.getByRole('button', { name: l(`删除图标库 ${pack.name}`, `Delete library ${pack.name}`), exact: true }).click();
  return uiWrite({ method: 'DELETE', path: apiPath('/icon-packs/' + pack.id), kind: 'delete-pack', id: pack.id, status }, () => picker.locator('.lh-icon-picker-delete').getByRole('button', { name: l('删除图标库', 'Delete library'), exact: true }).click());
}
async function optionalFavicon(dialog) {
  if (!argv.includes('--fetch-website')) return;
  step(`Explicit server-side favicon retrieval for ${websiteIconURL}, with network limitations recorded separately`);
  const picker = dialog.locator('.lh-icon-picker');
  const fetch = () => uiWrite({ method: 'POST', path: apiPath('/icons/fetch'), body: { url: new URL(websiteIconURL).href }, kind: 'fetch-icon', timeout: FETCH_STEP }, () => picker.getByRole('button', { name: l('获取网站图标', 'Fetch website icon'), exact: true }).click());
  const first = await fetch();
  if (first.status !== 200) {
    check([408, 422, 429, 502, 503, 504].includes(first.status), 'Favicon failure is an explicit upstream/cache availability result');
    const alert = picker.getByRole('alert'); await alert.waitFor({ state: 'visible', timeout: STEP });
    const displayedMessage = (await alert.textContent()).trim();
    if (first.body?.code === 'favicon_unavailable' || first.body?.code === 'icon_fetch_busy') {
      const translated = {
        'No supported public website icon was found. Choose a built-in icon or import an image.': '未找到支持的公网网站图标，请选择内置图标或导入图片。',
        'No supported website icon was found recently. Retry after the cache expires or import an image.': '最近未找到支持的网站图标，请在缓存过期后重试，或直接导入图片。',
        'A website icon is being fetched. Try again shortly.': '已有网站图标正在获取，请稍后重试。',
      }[first.body.message];
      check(!!translated, 'Favicon response has a known message for its unchanged machine code');
      equal(displayedMessage, l(translated, first.body.message), 'Favicon error is displayed in the instance language');
    }
    details.favicon = { status: 'unavailable', target: websiteIconURL, httpStatus: first.status, response: first.body, displayedMessage, retained: 'Only this isolated demo\'s website cache may retain a negative entry.' }; return;
  }
  validAsset(first.body); await selectedImage(picker, first.body.url, 'Fetched favicon');
  const cached = await fetch(); equal(cached.status, 200, 'Second explicit fetch reads the server cache'); equal(cached.body.cached, true, 'Repeated request is explicitly marked cached'); equal(cached.body.ref, first.body.ref, 'Cached favicon retains the same space-owned asset');
  await selectedImage(picker, cached.body.url, 'Cached favicon');
  details.favicon = { status: 'passed', target: websiteIconURL, first: first.body, repeated: cached.body, retained: 'The isolated demo retains its server favicon cache; canceling a link does not undo it.' };
}
async function runCore() {
  step('A built-in icon selection can be canceled without creating a link'); await admin();
  let dialog = await newDialog(), picker = dialog.locator('.lh-icon-picker');
  await dialog.getByRole('textbox', { name: l('链接名称', 'Link name'), exact: true }).fill(`LH canceled icon ${runId}`);
  await dialog.getByRole('textbox', { name: l('主入口 URL', 'Primary URL'), exact: true }).fill(websiteIconURL);
  const builtin = picker.getByRole('button', { name: l('服务器', 'Server'), exact: true }); await builtin.click();
  equal(await builtin.getAttribute('aria-pressed'), 'true', 'The chosen bundled icon is selected in the draft');
  await selectedImage(picker, '/icons/lucide/server.svg', 'Built-in'); await capture('builtin-picker-2k'); await cancel(dialog);
  equal(attempts, [], 'Opening, selecting, and canceling sends no write request');
  await unchangedOriginals('Canceled built-in draft'); equal(sortedPacks(await readPacks()), sortedPacks(originalPacks), 'Cancel adds no icon library');

  step('Single SVG import persists a library and automatically selects its icon only in the draft');
  dialog = await newDialog(); picker = dialog.locator('.lh-icon-picker');
  await dialog.getByRole('textbox', { name: l('链接名称', 'Link name'), exact: true }).fill(title);
  await dialog.getByRole('textbox', { name: l('主入口 URL', 'Primary URL'), exact: true }).fill(websiteIconURL);
  await picker.getByRole('button', { name: l('服务器', 'Server'), exact: true }).click();
  await optionalFavicon(dialog);
  await picker.getByRole('tab', { name: l('导入', 'Import'), exact: true }).click();
  await picker.locator('input[type=file]').setInputFiles({ name: `${packName}.svg`, mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  const nameField = picker.getByRole('textbox', { name: l('图标库名称', 'Library name'), exact: true });
  await nameField.waitFor({ state: 'visible', timeout: STEP }); equal(await nameField.inputValue(), packName, 'Single-image import stages the actual filename');
  const licenseField = picker.getByRole('textbox', { name: l('许可或权属说明', 'License or ownership notice'), exact: true });
  equal(await licenseField.inputValue(), '', 'Single-image import does not invent a license'); await licenseField.fill(license);
  const imported = await uiWrite({ method: 'POST', path: apiPath('/icon-packs'), body: singlePayload, kind: 'import-pack', status: 201 }, () => picker.getByRole('button', { name: l('导入并选用', 'Import and select'), exact: true }).click());
  const pack = imported.body; check(createdPacks.has(pack?.id), 'Successful import captured its cleanup ID'); equal(pack.icons.length, 1, 'Single image produces one imported icon');
  const asset = pack.icons[0]; validAsset(asset); equal(asset.sourceSha256, hash(svg), 'Source provenance records the uploaded bytes');
  await selectedImage(picker, asset.url, 'Imported SVG'); await unchangedOriginals('Imported icon before saving link');
  equal((await readPacks()).find(item => item.id === pack.id), pack, 'Library import is already persisted while the link remains a draft');
  await picker.scrollIntoViewIfNeeded(); await capture('imported-library-picker-2k');

  step('Saving the link persists its asset reference across a full document reload');
  const input = ownLinkInput(asset.ref);
  const saved = await uiWrite({ method: 'POST', path: apiPath('/links'), body: input, kind: 'create-link', status: 201 }, () => dialog.locator('.admin-form-footer').getByRole('button', { name: l('保存链接', 'Save link'), exact: true }).click());
  const link = saved.body; check(createdLinks.has(link?.id), 'Successful link creation captured its cleanup ID');
  await dialog.waitFor({ state: 'hidden', timeout: STEP }); await unchangedOriginals('Saved link', [link]);
  const reload = await page.reload({ waitUntil: 'domcontentloaded', timeout: STEP }); check(reload?.ok(), 'A full document reload succeeds after saving');
  await page.getByRole('searchbox', { name: l('搜索链接列表', 'Search links'), exact: true }).fill(title);
  let row = page.getByRole('row').filter({ has: page.getByRole('link', { name: title, exact: true }) });
  await row.waitFor({ state: 'visible', timeout: STEP }); await decodedImage(row.locator('img.lh-icon-asset'), asset, 'admin-after-reload');
  await page.goto(base.origin + '/#/', { waitUntil: 'domcontentloaded', timeout: STEP });
  const card = page.locator('.lh-bookmark').filter({ has: page.getByRole('link', { name: title, exact: true }) });
  await card.waitFor({ state: 'attached', timeout: STEP }); await decodedImage(card.locator('img.lh-icon-asset'), asset, 'homepage-visitor');
  await unchangedOriginals('Reloaded homepage', [link]);

  step('A library still referenced by the saved link rejects deletion with HTTP 409'); await admin();
  await page.getByRole('searchbox', { name: l('搜索链接列表', 'Search links'), exact: true }).fill(title);
  row = page.getByRole('row').filter({ has: page.getByRole('link', { name: title, exact: true }) });
  await row.getByRole('button', { name: l(`编辑 ${title}`, `Edit ${title}`), exact: true }).click();
  dialog = page.getByRole('dialog', { name: l('编辑链接', 'Edit link'), exact: true }); picker = dialog.locator('.lh-icon-picker');
  await deletePackUI(picker, pack, 409);
  const alert = picker.getByRole('alert'); await alert.waitFor({ state: 'visible', timeout: STEP });
  check((await alert.textContent()).includes(l('仍被链接', 'still used by links')), 'The picker explains the reference conflict in the instance language');
  equal((await readPacks()).find(item => item.id === pack.id), pack, 'Rejected deletion preserves the complete imported library');
  await cancel(dialog); await unchangedOriginals('Rejected deletion', [link]);

  step('Delete only the test link, then delete its now-unused library through the UI');
  equal((await readNavigation()).data.links.find(item => item.id === link.id), link, 'Deletion first reads and verifies this run\'s complete link receipt');
  await row.getByRole('button', { name: l(`删除 ${title}`, `Delete ${title}`), exact: true }).click();
  dialog = page.getByRole('dialog', { name: l('删除这个链接？', 'Delete this link?'), exact: true });
  await uiWrite({ method: 'DELETE', path: apiPath('/links/' + link.id), kind: 'delete-link', id: link.id, status: 204 }, () => dialog.getByRole('button', { name: l('确认删除', 'Confirm deletion'), exact: true }).click());
  await dialog.waitFor({ state: 'hidden', timeout: STEP }); await unchangedOriginals('Test link deleted');
  dialog = await newDialog(); picker = dialog.locator('.lh-icon-picker'); await deletePackUI(picker, pack, 204);
  await waitFor(async () => !(await picker.locator('.lh-icon-picker-delete').count()), 'Library delete finishes'); await cancel(dialog);
  equal(sortedPacks(await readPacks()), sortedPacks(originalPacks), 'Deleting the test library restores the exact original pack list');
  let missingAsset = await context.request.get(base.origin + asset.url, { timeout: STEP, maxRedirects: 0 });
  equal(missingAsset.status(), 404, 'Deleting the unused test library also removes its image asset');

  step('A JSON pack with a later forbidden SVG event rolls back its earlier valid asset');
  dialog = await newDialog(); picker = dialog.locator('.lh-icon-picker');
  await picker.getByRole('tab', { name: l('导入', 'Import'), exact: true }).click();
  await picker.locator('input[type=file]').setInputFiles({ name: `${invalidPackName}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalidPayload)) });
  await picker.getByRole('textbox', { name: l('图标库名称', 'Library name'), exact: true }).waitFor({ state: 'visible', timeout: STEP });
  const rejected = await uiWrite({ method: 'POST', path: apiPath('/icon-packs'), body: invalidPayload, kind: 'import-pack', status: 400 }, () => picker.getByRole('button', { name: l('导入图标库', 'Import library'), exact: true }).click());
  const rejectedAlert = picker.getByRole('alert'); await rejectedAlert.waitFor({ state: 'visible', timeout: STEP });
  equal(rejected.body?.code, 'validation_error', 'Rejected SVG retains the API machine-readable validation code');
  const displayedMessage = (await rejectedAlert.textContent()).trim();
  equal(displayedMessage, l('无法解码图标，或 SVG 包含不支持的内容。', 'The icon could not be decoded or contains unsupported SVG content.'), 'Rejected SVG is explained in the instance language');
  equal(sortedPacks(await readPacks()), sortedPacks(originalPacks), 'Rejected JSON import leaves no new pack or changed original pack');
  missingAsset = await context.request.get(base.origin + asset.url, { timeout: STEP, maxRedirects: 0 });
  equal(missingAsset.status(), 404, 'The first valid asset is absent after the later SVG rejects: transaction rollback has no image residue');
  details.invalidSVG = { status: rejected.status, response: rejected.body, displayedMessage, firstValidAssetUrl: asset.url, firstValidAssetAfterRejection: missingAsset.status(), rawImageRendered: false };
  await capture('rejected-svg-import-2k'); await cancel(dialog); await unchangedOriginals('Canceled rejected import');
  details.created = { linkId: link.id, packId: pack.id, assetRef: asset.ref, sourceSha256: asset.sourceSha256 };
}
async function cleanupOwned() {
  const session = await read('/bootstrap');
  equal(session.mode, 'open_edit', 'Cleanup requires the same open-edit demo mode'); check(session.user == null, 'Cleanup still has no signed-in account');
  for (const [id, created] of createdLinks) {
    const current = (await readNavigation()).data.links.find(item => item.id === id);
    if (!current) { cleanups.push({ kind: 'link', id, action: 'already-removed' }); continue; }
    equal(current, created, 'Fallback cleanup refuses a test link changed by another writer');
    check(created.title === title && created.spaceId === space.id && !originalNavigation.data.links.some(item => item.id === id), 'Fallback link cleanup is restricted to this run\'s captured ID');
    const response = await context.request.delete(endpoint(relative('/links/' + id)), { timeout: STEP, maxRedirects: 0, headers: { 'X-CSRF-TOKEN': session.csrfToken } });
    cleanups.push({ kind: 'link', id, action: 'API cleanup', status: response.status(), validationAction: false }); equal(response.status(), 204, 'Fallback test-link deletion succeeds');
  }
  for (const [id, created] of createdPacks) {
    const current = (await readPacks()).find(item => item.id === id);
    if (!current) { cleanups.push({ kind: 'pack', id, action: 'already-removed' }); continue; }
    equal(current, created, 'Fallback cleanup refuses a library changed by another writer');
    check([packName, invalidPackName].includes(created.name) && created.license === license && created.spaceId === space.id && !originalPacks.some(item => item.id === id), 'Fallback pack cleanup is restricted to this run\'s captured ID');
    const response = await context.request.delete(endpoint(relative('/icon-packs/' + id)), { timeout: STEP, maxRedirects: 0, headers: { 'X-CSRF-TOKEN': session.csrfToken } });
    cleanups.push({ kind: 'pack', id, action: 'API cleanup', status: response.status(), validationAction: false }); equal(response.status(), 204, 'Fallback test-library deletion succeeds');
  }
}

(async () => {
  let failure; const startedAt = new Date().toISOString();
  try {
    check(argv.includes('--allow-demo-write'), 'Explicit --allow-demo-write is required'); check(!!process.env.BASE_URL, 'An explicit BASE_URL is required'); base = new URL(process.env.BASE_URL);
    check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Use a plain instance root without credentials or a proxy subpath');
    equal(base.hostname, '10.233.233.61', 'Only the designated demo host is allowed'); check(['5184', '5185'].includes(base.port), 'Only isolated icon/composer demo ports 5184 and 5185 are writable');
    const target = new URL(websiteIconURL);
    check(websiteIconOrigins.includes(target.origin), 'WEBSITE_ICON_URL must use one of the three allowed public HTTPS origins');
    check(websiteIconURL === target.origin || websiteIconURL === target.origin + '/', 'WEBSITE_ICON_URL must be a plain allowed origin, without credentials, a non-root path, query, fragment or explicit port');
    const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, timeout: STEP, ignoreDefaultArgs: ['--hide-scrollbars'], args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'] });
    context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light', serviceWorkers: 'block' }); context.setDefaultTimeout(STEP); context.setDefaultNavigationTimeout(STEP);
    bootstrap = await read('/bootstrap'); const settings = await read('/settings');
    equal(bootstrap.initialized, true, 'The demo is initialized'); equal(bootstrap.language, base.port === '5185' ? 'en' : 'zh-CN', 'Instance language agrees with its dedicated demo port');
    equal(bootstrap.mode, 'open_edit', 'Bootstrap confirms open_edit'); equal(settings.mode, 'open_edit', 'Settings confirm open_edit'); equal(settings.hasOwner, false, 'Account-bearing services are refused'); check(bootstrap.user == null, 'Browser is not signed in');
    space = bootstrap.spaces.find(item => item.id === bootstrap.defaultSpaceId); check(space?.kind === 'shared' && space.published && space.canEdit && /^[0-9a-f]{32}$/.test(space.id), 'Default space is the editable, published shared demo');
    originalNavigation = await readNavigation(); originalPage = await readPage(); originalPacks = await readPacks();
    equal(originalNavigation.data.links.length, 43, 'Demo starts with its known 43 bookmarks'); equal(originalNavigation.data.categories.length, 8, 'Demo starts with its known eight categories'); equal(originalNavigation.data.links.filter(item => item.isFavorite).length, 3, 'Demo starts with its known three favorites');
    equal(originalPage.spaceId, space.id, 'Page belongs to the same guarded space'); check(originalPage.config.views.some(view => view.panel.id === 'builtin/navigation'), 'Demo has a navigation panel');
    check(originalPacks.length < 32, 'The demo has room for exactly this test pack'); approved = true;
    await installGuard(); page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ message: message.text().slice(0, 450), url: message.location().url }); });
    page.on('dialog', dialog => { nativeDialogs.push(dialog.type()); void dialog.dismiss(); });
    emit({ event: 'preflight', origin: base.origin, language: bootstrap.language, runId, spaceId: space.id, businessSha256: hash(records(originalNavigation)), pageSha256: hash(originalPage), originalPackCount: originalPacks.length, viewport: '2560x1440' });
    await runCore();
    equal(blocked, [], 'No visitor image or other browser request targets an external origin or an unapproved write'); equal(routeErrors, [], 'Request forwarding has no errors'); equal(pageErrors, [], 'No uncaught browser error'); equal(nativeDialogs, [], 'No native alert/confirm/prompt dialog');
    const unexpectedConsole = consoleErrors.filter(item => !attempts.some(attempt => attempt.status >= 400 && item.url === base.origin + attempt.path && /Failed to load resource/.test(item.message)));
    equal(unexpectedConsole, [], 'Only intentional rejected HTTP operations may appear as browser resource errors');
  } catch (error) { failure = error; if (page) await capture('failure').catch(() => {}); }
  finally {
    armed = null; await Promise.allSettled([...pendingForwards]);
    if (approved) {
      try { await cleanupOwned(); } catch (error) { cleanups.push({ action: 'cleanup-failed', message: error.message }); failure = failure || error; }
      try {
        const finalNavigation = await unchangedOriginals('Finally'); equal(sortedPacks(await readPacks()), sortedPacks(originalPacks), 'Finally: original icon libraries are unchanged and test libraries are gone');
        details.final = { links: finalNavigation.data.links.length, categories: finalNavigation.data.categories.length, favorites: finalNavigation.data.links.filter(item => item.isFavorite).length, businessSha256: hash(records(finalNavigation)), pageSha256: hash(await readPage()), initialNavigationRevision: originalNavigation.revision, finalNavigationRevision: finalNavigation.revision };
        cleanups.push({ action: 'all-original-records-and-page-unchanged' });
      } catch (error) { cleanups.push({ action: 'final-invariant-failed', message: error.message }); failure = failure || error; }
    }
    const report = { status: failure ? 'failed' : 'passed', runId, startedAt, finishedAt: new Date().toISOString(), origin: base?.origin, language: bootstrap?.language, assertions, currentStep, message: failure?.message, stack: failure?.stack, details, attempts, createdLinkIds: [...createdLinks.keys()], createdPackIds: [...createdPacks.keys()], cleanups, blocked, routeErrors, pageErrors, consoleErrors, nativeDialogs, screenshots };
    try { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); } catch (error) { failure = failure || error; }
    emit({ event: 'summary', ...report, status: failure ? 'failed' : 'passed', message: failure?.message, reportPath });
    if (context) await context.close().catch(() => {}); if (browser) await browser.close().catch(() => {}); if (failure) process.exitCode = 1;
  }
})();
