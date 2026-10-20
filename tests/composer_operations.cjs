#!/usr/bin/env node
/* Pure page-draft invariants. Uses the installed Vite/Rolldown toolchain only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-composer-test-'));
  let bundle;
  let passed = 0;
  const check = (name, run) => { run(); passed++; process.stdout.write(`PASS ${name}\n`); };
  try {
    const entry = path.join(temp, 'entry.ts');
    fs.writeFileSync(entry, [
      `export * from ${JSON.stringify(path.join(root, 'web/src/home/composition.ts'))};`,
      `export { presetConfig } from ${JSON.stringify(path.join(root, 'web/src/core/presentation.ts'))};`,
      `export { defaultPageChrome } from ${JSON.stringify(path.join(root, 'web/src/core/chrome.ts'))};`,
      `export { validatePageChrome } from ${JSON.stringify(path.join(root, 'web/src/core/chrome-validation.ts'))};`,
      `export { switchPageTheme, readLinkAppearance } from ${JSON.stringify(path.join(root, 'web/src/core/themes.ts'))};`,
    ].join('\n'));
    const { rolldown } = await import(pathToFileURL(require.resolve('rolldown', { paths: [path.join(root, 'web')] })).href);
    bundle = await rolldown({ input: entry, logLevel: 'silent' });
    const output = path.join(temp, 'helpers.cjs');
    await bundle.write({ file: output, format: 'cjs' });
    const h = require(output);
    const base = h.presetConfig('grouped-cards');
    const initial = structuredClone(base);
    const navId = base.views.find(view => view.panel.id === 'builtin/navigation').id;
    const catId = base.views.find(view => view.panel.id === 'builtin/category-navigation').id;
    const favId = base.views.find(view => view.panel.id === 'builtin/favorites').id;
    const traffic = { id: '11111111-2222-4333-8444-555555555555', name: 'Repository traffic', datasetId: 'source:11111111-2222-4333-8444-555555555555', schemaId: 'github.traffic' };
    const noOverlap = config => {
      const grids = Object.values(config.layout.placements).map(entry => entry.base).filter(p => p.kind === 'grid');
      grids.forEach((a, i) => grids.slice(i + 1).forEach(b => assert.ok(!(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y), 'Grid footprints overlap')));
    };

    check('adding each navigation component reuses the authorized local binding without changing the original', () => {
      for (const name of ['search', 'category-navigation', 'favorites', 'navigation']) {
        const added = h.addPagePanel(base, `builtin/${name}`, undefined, `view-test-${name}`);
        assert.equal(added.config.views.length, base.views.length + 1);
        assert.deepEqual(added.config.bindings, base.bindings);
        assert.deepEqual(added.config.views.slice(0, -1), base.views);
        assert.deepEqual(added.config.chrome, base.chrome);
        assert.deepEqual(added.config.views.at(-1).inputs, name === 'search' ? {} : { collection: 'navigation' });
        noOverlap(added.config);
      }
      assert.deepEqual(base, initial);
    });
    check('GitHub Traffic requires a compatible source and never receives navigation data', () => {
      assert.throws(() => h.addPagePanel(base, 'builtin/github-traffic'));
      const { config, id } = h.addPagePanel(base, 'builtin/github-traffic', traffic);
      const panel = config.views.find(view => view.id === id);
      assert.equal(config.bindings[panel.inputs.traffic].datasetId, traffic.datasetId);
      assert.deepEqual(config.bindings.navigation, base.bindings.navigation);
      assert.throws(() => h.bindPagePanel(config, id, { ...traffic, schemaId: 'navigation.collection' }));
      noOverlap(config);
    });
    const dataPanels = [
      { renderer: 'calendar', schema: 'calendar.events', input: 'events', settings: { viewMode: 'day' } },
      { renderer: 'weather', schema: 'weather.forecast', input: 'weather', settings: { forecastDays: 7 } },
      { renderer: 'metrics', schema: 'metrics.summary', input: 'metrics', settings: { showBars: false } },
      { renderer: 'status', schema: 'status.collection', input: 'status', settings: { showLatency: false } },
    ];
    const sourceFor = panel => ({ id: `test-${panel.renderer}`, name: panel.renderer, datasetId: `source:test-${panel.renderer}`, schemaId: panel.schema });
    check('calendar, weather, metrics and status use their own input contracts and reject other schemas', () => {
      for (const panel of dataPanels) {
        const panelId = `builtin/${panel.renderer}`, source = sourceFor(panel);
        assert.throws(() => h.addPagePanel(base, panelId), 'External data panels must not fall back to bookmarks');
        const { config, id } = h.addPagePanel(base, panelId, source);
        const view = config.views.find(item => item.id === id);
        assert.deepEqual(Object.keys(view.inputs), [panel.input]);
        assert.equal(config.bindings[view.inputs[panel.input]].datasetId, source.datasetId);
        assert.equal(view.interactionScope, undefined, 'Data panels must not share bookmark search and category filters');
        for (const other of dataPanels.filter(item => item.schema !== panel.schema)) {
          assert.throws(() => h.addPagePanel(base, panelId, sourceFor(other)));
          assert.throws(() => h.bindPagePanel(config, id, sourceFor(other)));
        }
        assert.throws(() => h.bindPagePanel(config, id, { ...source, schemaId: 'navigation.collection' }));
        const replacement = { ...source, datasetId: source.datasetId + '-replacement' };
        const rebound = h.bindPagePanel(config, id, replacement);
        assert.equal(rebound.bindings[rebound.views.find(item => item.id === id).inputs[panel.input]].datasetId, replacement.datasetId);
        assert.equal(config.bindings[view.inputs[panel.input]].datasetId, source.datasetId);
        assert.deepEqual(config.bindings.navigation, base.bindings.navigation);
        noOverlap(config);
      }
      assert.deepEqual(base, initial);
    });
    check('new data cards fill two columns without overlapping saved panels or narrow placements', () => {
      let config = base;
      const ids = [];
      for (const panel of dataPanels) {
        const added = h.addPagePanel(config, `builtin/${panel.renderer}`, sourceFor(panel));
        config = added.config; ids.push(added.id); noOverlap(config);
      }
      const positions = ids.map(id => config.layout.placements[id]);
      assert.deepEqual(positions.map(entry => entry.base.x), [0, 12, 0, 12]);
      assert.equal(positions[0].base.y, positions[1].base.y);
      assert.equal(positions[2].base.y, positions[3].base.y);
      assert.ok(positions[2].base.y >= positions[0].base.y + positions[0].base.h);
      for (const position of positions) {
        assert.equal(position.base.w, 12);
        assert.equal(position.overrides.narrow.kind, 'flow');
      }
      assert.equal(new Set(positions.map(entry => entry.overrides.narrow.order)).size, 4);
      for (const id of Object.keys(base.layout.placements)) assert.deepEqual(config.layout.placements[id], base.layout.placements[id]);
    });
    check('theme changes preserve all external data bindings, card settings, layout and template provenance', () => {
      let config = base;
      for (const panel of dataPanels) {
        const added = h.addPagePanel(config, `builtin/${panel.renderer}`, sourceFor(panel));
        config = added.config;
        const view = config.views.find(item => item.id === added.id);
        view.settings = { ...view.settings, ...panel.settings, title: `Custom ${panel.renderer}` };
        view.template = { id: `example.${panel.renderer}`, version: '1.0.0', sha256: 'a'.repeat(64) };
      }
      const before = structuredClone(config), ios = h.switchPageTheme(config, 'builtin/ios');
      assert.deepEqual({ ...ios, pageTheme: before.pageTheme }, before);
      assert.deepEqual(h.switchPageTheme(ios, 'builtin/dashboard'), before);
      assert.deepEqual(config, before);
    });
    check('adding an unfiltered panel does not silently reuse or replace a filtered alias', () => {
      const filtered = structuredClone(base); filtered.bindings.navigation.query = { favoritesOnly: true };
      const { config, id } = h.addPagePanel(filtered, 'builtin/navigation');
      const alias = config.views.find(view => view.id === id).inputs.collection;
      assert.notEqual(alias, 'navigation');
      assert.deepEqual(config.bindings[alias].query, {});
      assert.deepEqual(config.bindings.navigation, filtered.bindings.navigation);
      assert.deepEqual(filtered.bindings.navigation.query, { favoritesOnly: true });
    });
    check('removing a component preserves all bindings, custom content and the saved original', () => {
      const next = h.removePagePanel(base, navId);
      assert.equal(next.views.some(view => view.id === navId), false);
      assert.equal(Object.hasOwn(next.layout.placements, navId), false);
      assert.deepEqual(next.bindings, base.bindings);
      assert.deepEqual(next.chrome, base.chrome);
      assert.deepEqual(base, initial);
    });
    check('duplicating preserves settings and input identity with a separate non-overlapping placement', () => {
      const source = structuredClone(base); source.views.find(view => view.id === navId).settings.linkAppearance = 'minimal';
      const { config, id } = h.duplicatePagePanel(source, navId, 'view-copy');
      const original = source.views.find(view => view.id === navId), copy = config.views.find(view => view.id === id);
      assert.deepEqual(copy, { ...original, id });
      assert.deepEqual(config.bindings, source.bindings);
      assert.deepEqual(config.layout.placements[navId], source.layout.placements[navId]);
      noOverlap(config);
    });
    check('base and narrow placement locks reject moving, hiding, deleting, duplicating, ordering and resizing', () => {
      for (const target of ['base', 'narrow']) {
        const locked = structuredClone(base);
        (target === 'base' ? locked.layout.placements[navId].base : locked.layout.placements[navId].overrides.narrow).locked = true;
        assert.equal(h.panelLocked(locked, navId), true);
        assert.equal(h.movePagePanel(locked, navId, 'top'), locked);
        assert.equal(h.movePagePanel(locked, navId, 'hidden'), locked);
        assert.equal(h.removePagePanel(locked, navId), locked);
        assert.equal(h.duplicatePagePanel(locked, navId), null);
        assert.equal(h.reorderPagePanel(locked, navId, -1), locked);
        assert.equal(h.resizePagePanel(locked, navId, { w: 12 }), locked);
        const unlocked = h.setPanelLock(locked, navId, false);
        assert.equal(h.panelLocked(unlocked, navId), false);
        assert.equal(h.panelLocked(locked, navId), true);
      }
    });
    check('category components remain in schema-supported regions and retain their own settings', () => {
      assert.equal(h.movePagePanel(base, catId, 'main'), base);
      for (const slot of ['top', 'left', 'right', 'bottom', 'hidden']) {
        const moved = h.movePagePanel(base, catId, slot);
        const p = moved.layout.placements[catId].base;
        assert.equal(slot === 'hidden' ? p.kind : p.region, slot);
        assert.deepEqual(moved.views, base.views);
      }
    });
    check('reordering differently sized neighbors swaps footprints while preserving both component contents', () => {
      const next = h.reorderPagePanel(base, navId, -1);
      assert.equal(h.panelNeighbor(base, navId, -1), favId);
      assert.equal(next.layout.placements[navId].base.y, base.layout.placements[favId].base.y);
      assert.deepEqual(next.views.find(view => view.id === navId), base.views.find(view => view.id === navId));
      assert.deepEqual(next.views.find(view => view.id === favId), base.views.find(view => view.id === favId));
      assert.deepEqual(h.reorderPagePanel(next, navId, 1), base);
      noOverlap(next);
    });
    check('resizing a component avoids locked obstacles instead of covering or changing them', () => {
      const next = structuredClone(base), a = next.layout.placements[favId].base, b = next.layout.placements[navId].base;
      Object.assign(a, { x: 0, y: 0, w: 12, h: 4 }); Object.assign(b, { x: 12, y: 0, w: 12, h: 9, locked: true });
      const beforeObstacle = structuredClone(b), resized = h.resizePagePanel(next, favId, { w: 24 });
      assert.equal(resized.layout.placements[favId].base.y, 9);
      assert.deepEqual(resized.layout.placements[navId].base, beforeObstacle);
      noOverlap(resized);
      assert.equal(h.resizePagePanel(next, favId, { w: 25 }), next);
      assert.equal(h.resizePagePanel(next, favId, { h: NaN }), next);
    });
    check('hiding and adding components do not delete the page binding or underlying navigation references', () => {
      const hidden = h.movePagePanel(base, navId, 'hidden');
      assert.deepEqual(hidden.layout.placements[navId], { base: { kind: 'hidden' } });
      assert.deepEqual(hidden.views, base.views); assert.deepEqual(hidden.bindings, base.bindings);
      const shown = h.movePagePanel(hidden, navId, 'main');
      noOverlap(shown); assert.deepEqual(shown.views, base.views);
    });
    check('a theme roundtrip changes only the theme reference, including explicit icon choices', () => {
      const original = structuredClone(base); original.views.find(view => view.id === navId).settings.linkAppearance = 'minimal';
      const ios = h.switchPageTheme(original, 'builtin/ios');
      assert.deepEqual({ ...ios, pageTheme: original.pageTheme }, original);
      assert.equal(h.readLinkAppearance({}, 'builtin/ios'), 'app-icons');
      assert.equal(h.readLinkAppearance({ linkAppearance: 'minimal' }, 'builtin/ios'), 'minimal');
      assert.deepEqual(h.switchPageTheme(ios, 'builtin/dashboard'), original);
    });
    check('component and binding limits reject additions without changing the draft', () => {
      let full = base;
      while (full.views.length < 32) full = h.addPagePanel(full, 'builtin/search').config;
      const before = structuredClone(full);
      assert.throws(() => h.addPagePanel(full, 'builtin/navigation'));
      assert.throws(() => h.duplicatePagePanel(full, navId));
      assert.deepEqual(full, before);
      const bindings = structuredClone(base);
      for (let i = 1; i < 32; i++) bindings.bindings[`extra${i}`] = { datasetId: 'local-navigation', space: 'current-page-space', query: { search: `q${i}` } };
      const beforeBindings = structuredClone(bindings);
      assert.throws(() => h.addPagePanel(bindings, 'builtin/github-traffic', traffic));
      assert.deepEqual(bindings, beforeBindings);
    });
    check('hidden header and footer slots still validate empty and unsafe content before save', () => {
      const chrome = h.defaultPageChrome(); chrome.header.enabled = false;
      chrome.header.center.push({ id: 'custom-link', type: 'link', text: 'Docs', url: 'javascript:alert(1)' });
      const invalid = h.validatePageChrome(chrome);
      assert.equal(invalid.area, 'header'); assert.equal(invalid.alignment, 'center'); assert.equal(invalid.itemId, 'custom-link'); assert.equal(invalid.field, 'url');
      chrome.header.center[0].url = 'https://example.com/docs'; assert.equal(h.validatePageChrome(chrome), null);
      chrome.footer.left.push({ id: 'note', type: 'text', text: '  ' }); assert.equal(h.validatePageChrome(chrome).field, 'text');
    });
    check('chrome validation catches cross-slot identifiers, limits and credentialed URLs', () => {
      const chrome = h.defaultPageChrome(); chrome.header.left.push({ id: 'home-branding', type: 'branding' });
      assert.ok(h.validatePageChrome(chrome));
      chrome.header.left = Array.from({ length: 9 }, (_, i) => ({ id: `text-${i}`, type: 'text', text: 'Notes' })); assert.ok(h.validatePageChrome(chrome));
      chrome.header.left = [{ id: 'link', type: 'link', text: 'Docs', url: 'https://user:password@example.com' }]; assert.ok(h.validatePageChrome(chrome));
      chrome.header.left[0].url = 'https://example.com/path'; assert.equal(h.validatePageChrome(chrome), null);
    });
    check('a multi-operation unsaved draft leaves a complete restorable baseline intact', () => {
      const baseline = structuredClone(base);
      let draft = h.addPagePanel(base, 'builtin/navigation').config;
      draft = h.switchPageTheme(draft, 'builtin/ios');
      draft = h.movePagePanel(draft, catId, 'right');
      draft = h.removePagePanel(draft, favId);
      draft.chrome.header.enabled = true;
      draft.chrome.header.center.push({ id: 'draft-text', type: 'text', text: 'My workspace' });
      assert.notDeepEqual(draft, baseline);
      assert.deepEqual(base, baseline);
      assert.equal(h.validatePageChrome(draft.chrome), null);
      assert.deepEqual(structuredClone(base), initial);
    });
    process.stdout.write(`Composer operation checks: ${passed} passed. No API requests or data writes.\n`);
  } finally {
    if (bundle) await bundle.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
