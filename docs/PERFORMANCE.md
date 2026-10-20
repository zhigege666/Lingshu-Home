# Performance and interface verification

This document records reproducible development measurements, their scope, and the changes they motivated. Product version: `0.1.0-dev.1`. These are Chromium laboratory samples on an internal deployment, not a Lighthouse score, a public-network service guarantee, or real-user Core Web Vitals percentiles.

## Network routing, template discovery and dashboard presets — 2026-10-19

This iteration uses `index-DULkGFQe.js`, `index-BVg0b9Zj.css` and deferred `DashboardPresetDialog-LOTH5yel.js`. The tested binary SHA-256 is `e696cc5b2996f2e15bfbf05cc99cdb6fa02f1b9a94922e84359071207bf07a04`. Build output and disposable test data are isolated from the daily and previous demo instances. All values in this section belong to this build; older measurements remain in their own sections below.

Selecting a dashboard preset compiles a page draft. It does not create a source, enable collection, or allocate a history store. The source setup form is an explicit separate action. Server proxy configuration adds no health-check timer. Bookmark route selection runs only after an ordinary primary-link click, uses a bounded in-memory cache, and has no hover, focus or idle polling. Existing source workers still run when an enabled polling source is configured; hiding its card does not disable collection.

### Navigation-only browser and process samples

The dedicated public `open_edit` fixture contains 12 distinct bookmarks in three groups and three favorites, yielding 15 rendered cards. Every bookmark uses a bundled/manual icon. Both automatic website icons and automatic endpoint selection are enabled, and no external data source is configured. This is a quiet navigation workload, not an active provider, icon-discovery, authentication or maximum-collection workload.

The final `browser_lightweight_idle.cjs` run first verified that real bookmark cards were visible, then observed the foreground page for **65.007 seconds**. Its **41 checks passed**. The initial and final card counts were both 15, document width remained 2560 px, and the page remained visible. There were **zero additional HTTP requests, zero WebSocket attempts, zero forbidden requests and zero console/page errors**. DataPanels, TrafficPanel, WidgetImportDialog, DashboardPresetDialog and HomeEditor JS/CSS chunks were not requested. This identifies deferred output files; it does not assert that every related helper is absent from the entry bundle.

An independent Linux sample of the same initialized process at 07:41:02–07:41:12 UTC recorded:

| Metric | Observation |
| --- | --- |
| RSS, beginning / end | 22,012 / 22,048 KiB, approximately 21.5 MiB |
| Process high-water RSS, beginning / end | 22,012 / 22,048 KiB |
| CPU tick change | 1 tick over 10.0007 seconds, at 100 ticks/second |
| Equivalent process CPU time | 0.01 seconds, approximately 0.1% of one core over this interval |

This is a short process sample, not a memory ceiling, a zero-work guarantee or an improvement claim against different historical workloads. Go allocator/scavenger timing can change RSS and CPU without browser requests. Account password hashing, larger collections, active fetches and enabled sources have additional costs. The browser report alone cannot establish server-side inactivity.

The Chinese and English dashboard-preset suites each also observed a saved page with explicitly created push sources for **65 seconds**, with zero additional HTTP requests and zero WebSockets. Push sources have no polling schedule. These are separate functional observations, not extra samples in the cold-load benchmark below.

### Cold-load laboratory measurement

`browser_performance.cjs` ran at **2026-10-19T07:41:49.991Z**, using Chromium **155.0.8059.12**, a **2560 × 1440** viewport and the desktop profile. It used three fresh contexts for the homepage and three for link management, disabled HTTP caching, and rejected all writes and foreign-origin requests. All six samples completed with zero browser errors and zero forbidden requests. The benchmark copy omitted the redundant explicit `--no-sandbox` argument; application and browser network-policy settings were unchanged.

| Median of three | Homepage | Link management |
| --- | ---: | ---: |
| Initial JS/CSS encoded response bodies | 177,964 B (173.8 KiB) | 259,727 B (253.6 KiB) |
| Initial JS/CSS decoded bodies | 616,514 B | 868,373 B |
| Resource Timing transfer sizes, including its header allowance | 179,164 B | 265,127 B |
| FCP / observed LCP | 644 / 644 ms | 624 / 624 ms |
| Readiness observation | 1,666.2 ms | 1,976.7 ms |
| Navigation response start | 138.7 ms | 138.5 ms |
| Initial CLS | 0 | 0 |
| Pre-interaction long-task blocking | 106 ms | 0 ms |
| DOM nodes | 398 | 541 |
| Mounted management rows | — | 12 |
| Search input to two animation frames | 27.0 ms | 24.5 ms |
| Largest observed Event Timing duration | 64 ms | 56 ms |

Paint timings may describe the initial boot surface; readiness includes the network-idle observation. These are laboratory samples, not field INP, percentile guarantees or a Lighthouse score. There was no paired baseline run with this iteration, so the smaller readiness numbers compared with historical sections do not prove an improvement. The 106 ms of homepage startup blocking remains a measured opportunity for later profiling; the quiet-page result does not imply negligible startup work.

### Actual compressed output files

The entry JS is **449,571 B**, with a **141,318 B** gzip sidecar. Entry CSS is **129,837 B**, with a **23,441 B** sidecar. Those two sidecars total **164,759 B**, 4,108 B above the preceding automatic-icon build's corresponding files. That is a file-level comparison, not the complete incremental feature cost. The homepage's other eagerly requested shared chunks account for the remaining 13,205 B in the measured initial encoded total.

| Deferred output | Actual gzip sidecar bytes | Scope |
| --- | ---: | --- |
| Dashboard preset dialog | 8,275 JS + 1,023 CSS = 9,298 | Preset catalogue, binding setup and draft application UI |
| Four data renderers | 6,070 JS + 1,868 CSS = 7,938 | Shared calendar/weather/metrics/status views |
| Template import dialog | 7,906 JS + 743 CSS = 8,649 | Template selection, examples and review UI |
| Homepage editor | 11,562 JS + 3,992 CSS = 15,554 | The existing composer, loaded when editing starts |
| Traffic renderer | 3,618 JS | Existing GitHub Traffic presentation |

Shared dependencies and the source dialog are separate files; these values are not promises that opening a feature loads exactly one row's total. The isolated final `assets` directory contains 61 files, including 26 precompressed sidecars. Compression is verified from files on disk and actual encoded browser response bodies, not Vite's estimated gzip column. Build-time compression and static/API cache policies remain as documented below.

Raw functional reports, six browser samples, process observations and screenshots are retained with the private iteration evidence. [tests/README.md](../tests/README.md#当前轮次网络模板预置与空闲验收) records real versus controlled network boundaries and separate final-source HTTP, race, Docker and packaging results. These browser and process measurements do not establish long-duration behavior, real provider-account compatibility, throttled-device performance or release-gate completion.

## Previous automatic website icons and idle operation — 2026-10-19

This follow-up uses `index-CfyvMXdD.js`, `index-DnX6M1YH.css` and deferred `AdminView-BQ-_eEvG.js`. The binary SHA-256 is `3bffc8161829602fe2e2773e0c8d50cf5eaed52969e3b80d145432c8fcf36cac`. The measurements below apply to that build. The preceding component iteration and its cold-load timings are retained separately below.

Automatic acquisition runs after an authorized bookmark save or import commits. One worker consumes durable, deduplicated per-space/origin jobs; an empty queue has no periodic timer. A page visit, image GET, cache expiry or re-enabling the setting does not scan bookmarks. A new navigation-only Refresh content action reads the saved dashboard explicitly without adding polling or a WebSocket. Settings and per-link controls add no runtime dependency or separate image service.

Image bytes remain in the existing database. The server caches successful discovery for 24 hours and failures for 30 minutes, with later eligible saves or an explicit lookup triggering the next attempt. These intervals do not create automatic retry timers. Browser image responses use `private, no-cache` and ETag validation after current authorization; JSON APIs remain `no-store`. Limits and cancellation behavior are in [ICONS.md](ICONS.md).

### Current idle samples

Two new ownerless `open_edit` fixtures each contained five bookmarks, one original local SVG and no external data sources. The automatic-icon switch was enabled, with zero queued jobs or favicon cache records at observation time. No public-site discovery was active. After the Chinese and English acceptance runs, Linux process samples gave:

| Fixture | RSS at both ends | Observed process high-water RSS | CPU tick change / sample |
| --- | ---: | ---: | --- |
| Chinese | 17,220 KiB (16.8 MiB) | 23,580 KiB (23.0 MiB) | 0 / 10.003 s |
| English | 17,304 KiB (16.9 MiB) | 23,716 KiB (23.2 MiB) | 0 / 10.003 s |

CPU ticks use 100 ticks/second. Zero means no measurable tick increase during this interval. RSS is a process sample after this workload and allocator reclamation, not a guaranteed minimum, cap, or an established improvement over the preceding 12-bookmark fixture. Real password hashing, enabled sources, network acquisition and larger collections have different resource costs.

Each visible browser also remained idle on its navigation-only homepage for **65 seconds** after requests settled. Both recorded **zero additional requests**, **zero WebSockets**, no foreign-origin browser requests and no console/page errors. This covers the default-enabled setting with an empty automatic queue; it does not claim zero traffic while jobs or external sources are active.

### Build size and cache verification scope

The current entry JS is 439,079 B, with a 137,315 B gzip sidecar; entry CSS is 129,275 B, with a 23,336 B gzip sidecar. These two sidecars total 160,651 B. The preceding component build's two sidecars total 160,635 B, a 16 B difference. This compares those files only, not all initial browser resources or the complete feature cost. The deferred AdminView sidecars are 43,565 B JS and 1,118 B CSS; other shared dependencies are separate.

The Chinese and English functional browser suites each passed 80 checks, including same-origin image rendering after reload and an explicit conditional request returning an empty 304. Their request routing disables Chromium's ordinary HTTP cache, so this is protocol validation rather than a measurement of automatic browser-cache hits. Backend tests separately verify ETag syntax, revoked authorization, cross-space access and error headers.

This follow-up did not repeat the cold-load FCP/LCP/CLS benchmark, container measurements or race checks. It does not reuse the timings below as results for the new binary. Raw process/browser reports and screenshot verification are retained with the private iteration evidence; reproduction commands and the exact test boundaries are in [tests/README.md](../tests/README.md#当前轮次自动网页图标).

## Previous component iteration: sources and idle operation — 2026-10-19

The final UI uses `index-B0fG8zm7.js`, `index-DnX6M1YH.css` and deferred `DataPanels-Cg_z1Jh5.js`. The Go binary's SHA-256 is `eebf96e0a78fb2c4def713f6c90aca04c1f8062a73c6d8e319c356ba9776749d`. The complete implementation and test boundaries are in [COMPONENTS.md](COMPONENTS.md) and [tests/README.md](../tests/README.md).

### What is avoided when no external source is enabled

The integration scheduler waits for a due source or an explicit, committed source change. It has no periodic empty-table scan. A push-only source does not create a polling job; source responses and normalized snapshots are bounded. A hidden component does not implicitly disable its source: users disable a source to stop collection, while retaining the last good snapshot.

Calendar/weather/metrics/status share one deferred renderer chunk and shared dashboard reads. Ordinary cards do not create independent polling intervals or WebSockets. Navigation-only browsing does not load that chunk, TrafficPanel or the component-template dialog. It requires no additional agent, Redis, queue, or time-series service.

### Server samples: startup, browsing and authentication are different workloads

Measurements use Linux process RSS, not virtual address space. CPU time comes from `/proc/PID/stat` at 100 ticks/second; “0” means no measurable tick increase in that sample, not a guarantee of zero instructions or work for all environments.

| Workload | RSS sample | Peak/scope | Observed CPU |
| --- | ---: | --- | --- |
| Before the startup fix: fresh, uninitialized, no sources | 85,092 KiB (83.1 MiB) | One sample before removing a redundant dummy-password derivation | 0 ticks / 10.00 s |
| Final binary: fresh, uninitialized, no sources | 19,728 KiB (19.3 MiB) | Same local environment, separate fresh process | 0 ticks / 10.00 s |
| Initialized navigation-only instance after cold-browser measurements | 21,452 KiB (20.9 MiB) | 12 stored bookmarks, no external sources; visible idle browser | 0 ticks / 10.00 s |
| New account plus component acceptance activity | 91,704 / 92,128 KiB (89.6 / 90.0 MiB) | Chinese/English fixture process high-water values after real password hashing and page/API activity | Not an idle-CPU comparison |

The fixed public dummy hash preserves the full unknown-account verification path, with the same Argon2id parameters as real passwords. It eliminates one unnecessary startup derivation. Real password creation and login still allocate their original 64 MiB work area. The tests reject unknown users even when their input matches the public dummy fixture; this is not a shared login credential.

An earlier sample during six active browser cold loads increased by 0.12 CPU seconds and is retained as a browsing sample, not reported as idle. The final idle sample was taken after those cold-load requests finished. Results depend on allocator/scavenger timing, traffic, enabled sources and snapshots; no fixed maximum RSS is promised.

### Final browser lab measurement

The existing `tests/browser_performance.cjs` ran three fresh contexts for the homepage and three for link management, with the HTTP cache disabled, Chromium **155.0.8059.12**, desktop profile and **2560 × 1440** viewport. This is a new disposable `open_edit` instance with **12 distinct local bookmarks in three groups**. Its default Favorites panel repeats three of those links, giving 15 rendered bookmark cards. No external source is configured.

| Median of three | Homepage | Link management |
| --- | ---: | ---: |
| Initial JS/CSS encoded response bodies | 173,786 B (169.7 KiB) | 245,024 B (239.3 KiB) |
| Initial JS/CSS decoded bodies | 605,230 B | 828,683 B |
| FCP / observed LCP | 672 / 672 ms | 668 / 668 ms |
| Readiness observation | 1,876.5 ms | 2,229.8 ms |
| Initial CLS | 0 | 0 |
| Pre-interaction long-task blocking | 76 ms | 0 ms |
| DOM nodes | 361 | 500 |
| Mounted management rows | — | 12 |
| Search input to two animation frames | 26.1 ms | 26.8 ms |
| Largest observed Event Timing duration | 48 ms | 48 ms |

There were no browser errors, write attempts or foreign-origin requests. These measurements do not establish a speedup over the historical 43-link benchmark below: the fixtures, source tree and observation times differ. The 76 ms of homepage startup blocking remains a concrete optimization opportunity. FCP/LCP may describe an early boot surface; readiness includes the network-idle observation. These are laboratory observations, not field INP or a Lighthouse score.

The entry JS and CSS gzip sidecars are 137,299 B and 23,336 B. Including their eagerly requested shared chunks yields the measured 173,786 B total. Optional chunk sizes are:

| Deferred feature | gzip sidecar bytes | Scope |
| --- | ---: | --- |
| Four data renderers | 6,061 JS + 1,868 CSS = 7,929 | Shared calendar/weather/metrics/status rendering |
| Traffic renderer | 3,611 JS | Existing Traffic presentation |
| Template dialog | 3,760 JS + 487 CSS = 4,247 | Template import UI; editor/shared dependencies are separate |

These are specific output files, not guarantees that every feature's full incremental load equals one chunk.

### Visible-page idle check

A separate fresh browser loaded the navigation-only instance, waited for its bookmarks, then remained visible without interaction for **65.055 seconds**. It observed **zero additional requests**, **zero WebSockets**, no blocked foreign-origin/write attempts and no browser errors. Resource entries contained no DataPanels, TrafficPanel or WidgetImportDialog chunk. This check crosses a 60-second interval boundary; it does not simulate every focus/background transition or an enabled polling source.

The ordinary component refresh action still reads a shared cached dashboard. The full component acceptance checks verify exactly one dashboard GET and no upstream sync request for that action, and no page writes for calendar day/week browsing.

Raw reports, geometry and process samples are retained in the private iteration verification directory. The historical metrics below belong to older implementations. This iteration does not claim current-source Docker/race/hosted-CI performance or long-duration behavior under maximum source/event counts.

## Historical visual composer, iOS theme and icons — 2026-10-18

The final frontend uses `index-QrhLUHDl.js`, shared `dist-BJSLTIqn.js` and `index-Co5760t1.css`. Its visitor route keeps the visual editor deferred. Imported icons are served from the current space on the same origin; ordinary viewing does not initiate website discovery or load an external icon library.

The preceding logo/card-sizing build was measured starting at **15:44:32 UTC**; the final build, including localized icon errors, was measured at **16:16:15 UTC**, in Chromium **155.0.8059.12**. The comparison uses **twelve fresh contexts in total**: two builds × homepage/admin × three repetitions. An intermediate six-context measurement at 15:44:49 UTC is retained separately but is not included in the table. Both compared builds use the same 43 links, eight categories, three favorites and restored Classic/content-height page configuration at **2560 × 1440**. The final run reuses the earlier unchanged baseline; the time gap and small sample size limit timing conclusions. These measurements use the **desktop profile only**; the four-times CPU profile below is historical. The scripts disabled browser caching and rejected all writes and foreign origins. Both reports contain zero browser errors and zero write attempts.

| Desktop metric, median of three | Previous homepage | Current homepage | Previous admin | Current admin |
| --- | ---: | ---: | ---: | ---: |
| Initial JS/CSS encoded bodies | 164,184 B | 174,389 B | 223,607 B | 239,232 B |
| Initial JS/CSS decoded bodies | 571,379 B | 608,560 B | 759,917 B | 814,761 B |
| FCP / observed LCP | 656 ms | 636 ms | 656 ms | 632 ms |
| Readiness observation | 1,783.9 ms | 1,875.1 ms | 2,097.8 ms | 2,142.6 ms |
| Initial CLS | 0.004714 | 0 | 0 | 0 |
| Search input to two animation frames | 31.3 ms | 29.0 ms | 28.2 ms | 25.7 ms |
| Pre-interaction long-task blocking | 110 ms | 124 ms | 0 ms | 0 ms |
| DOM nodes | 827 | 828 | 869 | 873 |
| Mounted admin rows | — | — | 25 | 25 |
| Document height | 1,440 px | 1,440 px | 1,440 px | 1,440 px |

The added theme and shared icon support cost **10,205 B (6.2%)** on the homepage and **15,625 B (7.0%)** on the admin route in compressed response bodies. This is actual browser resource timing, including all initially loaded JS/CSS chunks. FCP/LCP can describe the boot screen; readiness includes the network-idle observation. Small timing differences from three samples do not prove a general speedup: readiness on both surfaces and homepage startup blocking increased slightly, while search-to-frame observations decreased. Navigation response medians stayed between 138.1 and 139.9 ms. Observed interaction maxima were 72 ms on both homepages and 56 ms on both admin builds; these are lab Event Timing samples, not field INP.

Separate normal-motion UI runs passed eight composer workflows in **each** language. They exercised the fixed editor shell, selectable categories, added/duplicated components, theme preview, six-slot validation, a 390 px property drawer and actual save/reload/restoration. The 2K editor's document remained 2560 × 1440 without root overflow. Icon-library flows separately validated same-origin image decoding and complete cleanup of their temporary content. These functional runs are not additional performance samples. Commands, deliberate-write boundaries and the website-fetch outcome are in [tests/README.md](../tests/README.md).

Raw `performance-baseline.json` and `performance-current-final.json` are retained in the private verification directory; `performance-current.json` is the intermediate build's report. Reproduce this comparison with `PERFORMANCE_PROFILE=desktop PERFORMANCE_REPEATS=3`; run the baseline and current builds sequentially without changing their data or page configuration. Measuring iOS-specific rendering, editor latency, throttled devices and much larger collections remains outside this comparison.

## Historical logo and card-sizing follow-up — 2026-10-18

The final logo/card-sizing build uses `index-Bt7DVb98.js` and `index-BpXllbTu.css`. Its initial JavaScript/CSS gzip files are **143,244 B** and **20,940 B**, totaling **164,184 B**, compared with **163,335 B** for the measured preview/language build below: an **849 B** increase (about 0.5%). The shared SVG mark is **1,298 B**, with optional 32 px favicon (**1,262 B**) and 180 px touch icon (**6,444 B**) exported from it. These are actual build-file and gzip-sidecar sizes, not measured browser transfer totals; icon fetching depends on the browser.

This follow-up keeps deferred admin/editor loading, build-time compression and the static-cache policy. Card rows use available tracks; adjacent small categories share available space in their existing order, while larger categories retain full rows and favorites keep a bounded background. The explicit Fit content action changes an editable draft's height mode. Logo images reserve their dimensions before loading. The timing, CLS and long-task figures in the sections below describe the earlier entry assets named there; a new twelve-context performance benchmark has not been run for this follow-up. Current functional and geometry checks are recorded separately in [tests/README.md](../tests/README.md).

## Changes from the compact-admin iteration

- Link/category management mounts only the selected page of 25, 50, or 100 rows from the authorized navigation snapshot. The header, toolbar, table header and paginator stay visible; only the table body scrolls. This reduces DOM work without changing the navigation API.
- Homepage category counts, parent paths and search text reuse an index for each immutable dataset object. Grouping uses a single pass over links. These caches contain already authorized browser data and do not replace server authorization.
- Login/setup forms and the multi-space selector load when required. A single-space homepage does not eagerly load the admin form, Dialog or Select implementation. The default desktop grid keeps its initial layout implementation available.
- The grid measures its real container width before paint. Previously its first pixel layout used a 1,440 px fallback and then widened, moving cards between rows. Grid configuration, child elements and interaction callbacks keep stable references when their inputs have not changed, reducing avoidable work during content-height updates.
- Production builds create gzip sidecars for JavaScript/CSS files of at least 1 KiB when compression reduces their size. The Go service negotiates these only for static assets, honors an explicit `gzip;q=0`, sets `Vary: Accept-Encoding`, and serves the original representation for range requests or missing sidecars. Compression is performed during the build, not on every request.
- Content-hashed `/assets/*.js` and `/assets/*.css` use `public, max-age=31536000, immutable`. HTML and unversioned files use `no-cache` (revalidation). JSON API, MCP and health responses remain `no-store`; authorized icon image responses use private ETag revalidation.
- Native scrolling is retained. `scrollbar-gutter: stable`, bounded overflow regions, visible scrollbars and category scroll buttons address layout movement and reachability without adding a simulated-scrolling library.

## Reproduce the browser measurement

Use a disposable instance containing a fixed public navigation dataset. The recorded comparison uses 43 public links, eight categories, a 2560 × 1440 viewport and a fresh Chromium context for every sample. Do not change the dataset, page configuration, build or server while a comparison is running.

```bash
BASE_URL=http://demo-host:5182 \
LINGSHU_PLAYWRIGHT_MODULE=/path/to/playwright \
CHROMIUM_EXECUTABLE=/path/to/chromium \
PERFORMANCE_OUTPUT=.runtime/performance-current.json \
node tests/browser_performance.cjs
```

The script is read-only: it rejects write requests and foreign origins, clears the HTTP cache for every sample, and measures three repetitions for both the homepage and link management. Optional `PERFORMANCE_PROFILE=desktop` or `throttled` selects one profile; `PERFORMANCE_REPEATS=1..5` controls repetitions. `--baseline` labels an existing build for comparison; it does not switch application versions.

| Profile | CPU | Network emulation |
| --- | --- | --- |
| Desktop | No CPU throttling | Actual test-network conditions |
| Throttled | Chromium 4× CPU slowdown | 40 ms requested latency, 10 Mbit/s download, 2 Mbit/s upload, in addition to the underlying network |

The output includes raw per-sample resource timings, FCP, LCP, CLS using session windows, navigation response time, DOM size, mounted table rows and long tasks. `readyMs` includes the script's network-idle observation and must not be described as a user's first paint. `blockingTimeMs` sums the portion above 50 ms of observed pre-interaction long tasks; it is a diagnostic observation, not a Lighthouse TBT score.

Search latency is measured from a real input event to two animation frames later. The maximum observed Event Timing duration is a small laboratory interaction sample, not field INP. The browser's first visible boot state may be an LCP candidate, so compare readiness, layout stability and resource transfer alongside paint timings. Medians of three samples indicate this test run only; they are not a 75th-percentile real-user assessment.

## Composition, preview and form refinement — 2026-10-18

This later iteration adds the homepage draft editor, an actual-homepage preview in the layout settings, configurable header/footer slots and instance-level English. Category folding now updates measured grid width and content height before paint instead of animating the container width through intermediate layouts. The footer follows the page's flex flow: it rests at the bottom of short pages and follows all content on longer pages. The homepage editor remains a deferred chunk until editing starts; ordinary homepage measurements below do not include an opened editor or preview.

The final build also limits Tailwind class detection to `web/src`, using `source(none)` and an explicit source declaration. Automatic detection had made a build in a different output directory generate an additional 118 selectors and a 124,510 B stylesheet. The explicit source range produces the same **51 output files, including gzip sidecars, byte for byte** in two independent output directories. The resulting stylesheet is **109,843 B**. A scan audit found all 39 source files and no files outside that scope; the source's shared components and complete variant strings remain included. This build boundary follows [Tailwind's explicit source registration](https://tailwindcss.com/docs/detecting-classes-in-source-files#disabling-automatic-detection). No stylesheet is generated from private design documents or previous bundles.

The same 43-link, eight-category dataset and saved fixed-height navigation configuration were measured in **12 fresh Chromium contexts**, using both profiles and three loads of each surface. Chromium was `155.0.8059.12`; the measurement started at `2026-10-18T10:47:06.336Z`. The measured entry assets were `index-B_HJ6vA2.js` and `index-CLUYafx8.css`. Raw results are retained in the maintenance environment as `performance-source-final.json`; they are not required to run the public test script. No write requests or browser errors occurred.

### Resource and layout comparison with the preceding iteration

| Metric | Previous compact-admin build | Composition build |
| --- | ---: | ---: |
| Homepage initial JS/CSS, actual encoded response bodies | 156,805 B | 163,335 B |
| Admin initial JS/CSS, actual encoded response bodies | 202,542 B | 222,719 B |
| Homepage JS/CSS after decompression | 537,698 B | 568,189 B |
| Admin JS/CSS after decompression | 683,166 B | 756,731 B |
| Homepage initial CLS, both profiles | 0.001898 | 0 |
| Admin initial CLS, both profiles | 0 | 0 |
| Document height, homepage and admin | 1,440 px | 1,440 px |
| Mounted admin table rows | 25 | 25 |
| Homepage DOM nodes | 821 | 824 |
| Admin DOM nodes | 868 | 868 |

Encoded initial resources increased by **4.2% on the homepage** and **10.0% in admin**. The added language strings, composition controls and preview implementation have a measurable cost. The zero CLS result applies to these laboratory loads; it is not a guarantee for every theme, dataset, external image or device.

### Current timing observations

Values are medians of three repetitions, in milliseconds. Readiness includes the network-idle observation. FCP and observed LCP may describe the initial boot state rather than usable bookmarks.

| Profile / page | FCP and observed LCP | Readiness observation | Search input to two frames | Pre-interaction long-task blocking |
| --- | ---: | ---: | ---: | ---: |
| Desktop / homepage | 896 | 2,164.9 | 32.5 | 137 |
| Desktop / admin | 652 | 2,154.8 | 28.3 | 0 |
| 4× CPU / homepage | 948 | 2,258.2 | 83.8 | 738 |
| 4× CPU / admin | 992 | 3,042.6 | 92.6 | 262 |

Navigation response medians were 139.3–140.0 ms for three profile/surface combinations, while the desktop homepage observed 389.8 ms. That larger response wait means its paint and readiness increase cannot be attributed entirely to frontend code. The maximum observed interaction durations in the four summaries were 72, 64, 304 and 232 ms, respectively; these are small laboratory Event Timing samples, not field INP. Compared with the immediately preceding iteration, homepage startup blocking remained higher, while throttled admin blocking and readiness decreased; throttled search-to-frame observations increased on both surfaces. The fold and footer fixes improve visible stability, but this run does **not** establish an overall speed improvement. Lowering React/grid startup and filtered-card reconstruction cost remains a concrete performance target.

### Interaction and responsive evidence

- Normal-motion category folding was checked separately from paint timing: repeated fold/unfold actions retained document width, final grid geometry and scrollbar bounds. The Chinese run observed 14 actions across 157 frames; the continuous English run observed 14 actions across 174 frames. These are actual observations, not a requested frame-rate target.
- Actual homepage previews were checked at logical 2560 × 1440, 1920 × 1080, 1600 × 900 and 2560 × 1080 sizes. A scaled preview uses its own viewport for layout; the settings sidebar width does not become the simulated screen width.
- The separate responsive geometry run passed 65 total assertions at 2560 × 1440, 1920 × 1080, 1600 × 900, 2560 × 1080, 768 × 1024 and 390 × 844. This script uses reduced motion and checks overflow, panel overlap and retained data. It must not be described as a normal-animation run on all six sizes.
- Dedicated form runs passed 118 Chinese and 119 English assertions. The checks include keyboard Select interaction, search focus, inline constraints, corrected input retention, file selection, access-mode radios and dialog focus restoration. A real regression in which validation could restore an older input value was fixed by validating after the field's change handler has updated its state.
- The editor boundary checks passed 67 assertions for hidden/disabled-slot URL validation, visible error focus and draft restoration, plus 75 assertions for actual mouse resizing, dragging and one explicit save. The latter uses a separate English demo and restores the original full page configuration through a revision-guarded cleanup. These checks are separate from the read-only performance run.

Commands, instance guards, write budgets and revision-aware cleanup are documented in [tests/README.md](../tests/README.md). Performance samples are read-only; deliberate editor-save tests have separate records and run only against disposable demos.

## Historical measurement: compact-admin refinement

The pre-refinement and compact-admin builds were measured earlier on 2026-10-18 with the same instrumentation, dataset and saved page configuration. These are historical results from the preceding iteration, before the composition and preview work above. Each build has 12 cold-context loads: two profiles × two surfaces × three repetitions. The saved navigation panel uses a fixed height with internal scrolling; three favorites are also shown in their own panel, so the homepage mounts 46 bookmark cards for 43 distinct links. No request writes or browser errors occurred. The compact-admin report preserves six decimal places for CLS; the comparison below uses the original raw samples rather than the earlier summary's two-decimal rounding.

### Resource and layout measurements

| Metric | Before refinement | Final refined build |
| --- | ---: | ---: |
| Homepage initial JS/CSS, actual encoded response bodies | 496,789 B | 156,805 B |
| Admin initial JS/CSS, actual encoded response bodies | 581,548 B | 202,542 B |
| Homepage JS/CSS after decompression | 496,789 B | 537,698 B |
| Admin JS/CSS after decompression | 581,548 B | 683,166 B |
| Homepage initial CLS, both profiles | 0.113801 | 0.001898 |
| Admin initial CLS, both profiles | 0 | 0 |
| Admin document height in a 1,440 px viewport | 5,160 px | 1,440 px |
| Mounted admin table rows | 43 | 25 |
| Admin DOM nodes | 1,274 | 868 |
| Homepage DOM nodes | 806 | 821 |

The encoded-body reduction is **68.4% for the homepage** and **65.2% for admin**. These are actual browser resource timings with server-negotiated gzip, not a bundler's compression estimate. Decoded resources grew with the new interface, while compression and deferred loading reduced network transfer. The remaining small initial CLS comes from the footer moving when content height is measured; the large card-width correction is removed. Pagination bounds mounted admin rows while preserving the full authorized collection in browser memory.

### Timing observations

Values below are medians of three repetitions, in milliseconds. Every cell is **before → final**.

| Profile / page | FCP and observed LCP | Readiness observation | Search input to two frames | Pre-interaction long-task blocking |
| --- | ---: | ---: | ---: | ---: |
| Desktop / homepage | 1,608 → 632 | 2,695.7 → 1,790.1 | 24.5 → 37.5 | 4 → 130 |
| Desktop / admin | 1,588 → 632 | 3,276.2 → 2,089.8 | 25.9 → 26.5 | 0 → 0 |
| 4× CPU / homepage | 1,828 → 984 | 3,561.9 → 2,241.7 | 56.8 → 75.1 | 403 → 674 |
| 4× CPU / admin | 1,884 → 964 | 4,208.5 → 3,180.6 | 80.4 → 65.7 | 324 → 309 |

Navigation response times remained around 138–140 ms. The early boot state is a paint candidate, so the FCP/LCP column must not be interpreted as the time at which all bookmarks are usable. Readiness includes the test's network-idle observation, as described above.

**Not every metric improved.** The homepage's observed startup blocking and search-to-frame times increased from the old build even though transfer, readiness and layout stability improved. Measuring width before paint removes visible correction but does not eliminate React, grid and content-measurement work. Restoring a cleared search also remounts the full set of cards. This run does not isolate total CPU time by subsystem; reducing that startup and reconstruction cost remains a performance target. Do not advertise a general search-speed improvement from this 43-link experiment.

The maximum observed interaction duration in the final three-sample summaries was 72 ms for desktop home, 56 ms for desktop admin, 216 ms for throttled home and 208 ms for throttled admin. These limited laboratory Event Timing observations are **not field INP**. Earlier first-iteration HTTP, image and browser counts remain explicitly historical in [tests/README.md](../tests/README.md).

## Interface acceptance

See [tests/README.md](../tests/README.md) for commands and actual results. `tests/browser_refinement.cjs` checks bounded admin scrolling, pagination, real Select and Checkbox interaction, inline constraints, category presentation/disclosure and six responsive sizes. Its mutations require an explicitly identified ownerless demo on port 5182 and `--allow-demo-write`; it preserves original business records and revision-checks cleanup of temporary page configuration.

The source audit covers visible select, checkbox, radio, file, number, text/search and textarea controls. Hidden file inputs and Radix compatibility inputs intentionally retain browser/platform semantics. A styled file-selection button still opens the operating system's file picker. No source scan or screenshot alone establishes complete accessibility compliance.

## Further scale limits

The frontend still receives the complete authorized navigation snapshot. Pagination bounds the admin DOM, but it does not make network payloads independent of collection size. The homepage renders the filtered collection; large-collection virtualization and a server pagination/query contract need separate product decisions and representative browser evidence. Do not extrapolate the 43-link browser run to ten thousand live cards or concurrent-user capacity.

Reverse proxies may provide their own compression and caching; preserve response `Vary` and the distinction between versioned assets and private API data. Revisit bundle and browser measurements when adding a large data-source panel, icon library, theme or editor dependency.

## References

- [MDN: scrollbar-gutter](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scrollbar-gutter)
- [MDN: scrollbar-width and accessibility](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scrollbar-width)
- [Radix Select: keyboard and accessibility behavior](https://www.radix-ui.com/primitives/docs/components/select)
- [Tailwind: explicit source detection](https://tailwindcss.com/docs/detecting-classes-in-source-files#disabling-automatic-detection)
- [MDN: Accept-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Accept-Encoding)
- [MDN: Cache-Control](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control)
- [web.dev: Web Vitals and laboratory versus field measurement](https://web.dev/articles/vitals)
