#!/usr/bin/env node
'use strict';
// Read-only Chromium lab measurements. No field INP or Lighthouse score is inferred.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.LINGSHU_PLAYWRIGHT_MODULE || 'playwright');
const origin = new URL(process.env.BASE_URL || 'http://127.0.0.1:5182');
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/') throw new Error('Use a plain application origin');
const output = path.resolve(process.env.PERFORMANCE_OUTPUT || '.runtime/browser-performance.json');
const phase = process.argv.includes('--baseline') ? 'baseline' : 'current';
const repeats = Number(process.env.PERFORMANCE_REPEATS || 3);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('PERFORMANCE_REPEATS must be 1..5');
const profiles = process.env.PERFORMANCE_PROFILE === 'desktop' ? ['desktop'] : process.env.PERFORMANCE_PROFILE === 'throttled' ? ['throttled'] : ['desktop', 'throttled'];
const report = { phase, measuredAt: new Date().toISOString(), browser: '', viewport: { width: 2560, height: 1440 },
  method: 'Fresh browser context and disabled HTTP cache per sample. Desktop unthrottled; throttled uses 4x CPU, 40 ms latency, 10 Mbit/s down and 2 Mbit/s up. Three repeated lab samples by default; metrics are not field percentiles or a Lighthouse score.', samples: [], summaries: [], errors: [], writes: [] };
function median(values, precision = 2) { const sorted = values.filter(v => typeof v === 'number').sort((a,b) => a-b); return sorted.length ? Number(sorted[Math.floor(sorted.length/2)].toFixed(precision)) : null; }
async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--disable-dev-shm-usage', '--no-sandbox'] });
  report.browser = browser.version();
  try {
    for (const profile of profiles) for (const surface of ['home', 'admin']) for (let run = 1; run <= repeats; run++) {
      const context = await browser.newContext({ viewport: report.viewport, locale: 'zh-CN', timezoneId: 'UTC', reducedMotion: 'reduce' });
      try {
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== origin.origin || !['GET', 'HEAD'].includes(request.method())) {
            report.writes.push({ method: request.method(), path: url.pathname, foreignOrigin: url.origin !== origin.origin });
            return route.abort('blockedbyclient');
          }
          await route.continue();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', error => report.errors.push(String(error)));
        page.on('console', msg => { if (msg.type() === 'error') report.errors.push(msg.text()); });
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile === 'throttled' ? 4 : 1 });
        if (profile === 'throttled') await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 1250000, uploadThroughput: 250000, connectionType: 'wifi' });
        await page.addInitScript(() => {
          window.__lab = { lcp: null, cls: 0, longTasks: [], interactions: [], search: [], assets: [] };
          let sessionStart = 0, lastShift = 0, sessionValue = 0;
          new PerformanceObserver(list => { for (const e of list.getEntries()) window.__lab.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
          new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) {
            if (e.startTime - lastShift > 1000 || e.startTime - sessionStart > 5000) { sessionStart = e.startTime; sessionValue = 0; }
            lastShift = e.startTime; sessionValue += e.value; window.__lab.cls = Math.max(window.__lab.cls, sessionValue);
          } }).observe({ type: 'layout-shift', buffered: true });
          new PerformanceObserver(list => { window.__lab.longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))); }).observe({ type: 'longtask', buffered: true });
          if (PerformanceObserver.supportedEntryTypes.includes('event')) new PerformanceObserver(list => {
            window.__lab.interactions.push(...list.getEntries().filter(e => e.interactionId).map(e => e.duration));
          }).observe({ type: 'event', durationThreshold: 16, buffered: true });
          document.addEventListener('input', e => {
            if (e.target instanceof HTMLInputElement && e.target.type === 'search') {
              const start = performance.now();
              requestAnimationFrame(() => requestAnimationFrame(() => window.__lab.search.push(performance.now()-start)));
            }
          }, true);
        });
        await page.goto(origin.origin + (surface === 'home' ? '/#/' : '/#/admin?tab=links'), { waitUntil: 'networkidle', timeout: 30000 });
        await page.locator(surface === 'home' ? '.lh-home-heading h1' : '.admin-links-table tbody tr').first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const beforeInput = await page.evaluate(() => ({ ...window.__lab, ready: performance.now(), domNodes: document.querySelectorAll('*').length,
          rows: document.querySelectorAll('.admin-links-table tbody tr').length, cards: document.querySelectorAll('.lh-link-card,.lh-link-row').length,
          pageHeight: document.documentElement.scrollHeight, bodyWidth: document.body.scrollWidth,
          fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
          ttfb: performance.getEntriesByType('navigation')[0]?.responseStart ?? null,
          resources: performance.getEntriesByType('resource').map(e => ({ path: new URL(e.name).pathname, transfer: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize, duration: e.duration })) }));
        const input = page.locator('input[type=search]').first();
        for (const query of ['github', 'not-present-lingshu-lab', '']) {
          await input.fill(query);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
        }
        const interaction = await page.evaluate(() => ({ search: window.__lab.search, eventDurations: window.__lab.interactions }));
        const assets = beforeInput.resources.filter(e => /\.(js|css)$/.test(e.path));
        const sample = { profile, surface, run, fcpMs: beforeInput.fcp, lcpMs: beforeInput.lcp, cls: beforeInput.cls,
          readyMs: beforeInput.ready, ttfbMs: beforeInput.ttfb, longTaskCount: beforeInput.longTasks.length,
          blockingTimeMs: beforeInput.longTasks.reduce((sum,e) => sum+Math.max(0,e.duration-50),0),
          domNodes: beforeInput.domNodes, renderedRows: beforeInput.rows, pageHeight: beforeInput.pageHeight,
          initialAssetTransferBytes: assets.reduce((sum,e) => sum+e.transfer,0), initialAssetEncodedBytes: assets.reduce((sum,e) => sum+e.encoded,0),
          initialAssetDecodedBytes: assets.reduce((sum,e) => sum+e.decoded,0),
          searchTwoFrameMedianMs: median(interaction.search), maxObservedEventMs: interaction.eventDurations.length ? Math.max(...interaction.eventDurations) : null,
          assets, api: beforeInput.resources.filter(e => e.path.startsWith('/api/')) };
        report.samples.push(sample);
        console.log(JSON.stringify({ sample: { ...sample, assets: undefined, api: undefined } }));
      } finally { await context.close(); }
    }
    for (const profile of profiles) for (const surface of ['home', 'admin']) {
      const rows = report.samples.filter(s => s.profile === profile && s.surface === surface);
      const summary = { profile, surface, samples: rows.length };
      for (const key of ['fcpMs','lcpMs','cls','readyMs','ttfbMs','blockingTimeMs','domNodes','renderedRows','pageHeight','initialAssetTransferBytes','initialAssetEncodedBytes','initialAssetDecodedBytes','searchTwoFrameMedianMs','maxObservedEventMs']) summary[key] = median(rows.map(s => s[key]), key === 'cls' ? 6 : 2);
      report.summaries.push(summary);
    }
    if (report.errors.length || report.writes.length) throw new Error('Browser errors or forbidden requests occurred');
  } finally {
    await browser.close();
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)+'\n');
    console.log(JSON.stringify({ output, summaries: report.summaries, errors: report.errors, writes: report.writes }));
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
