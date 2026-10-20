# Dashboard presets and data handoff

The dashboard presets arrange Home's existing components into three reusable layouts. Their static catalogue and page-draft compiler live in `web/src/home/dashboard-presets.ts`. The producer handoff examples live in `examples/dashboard-data/`; they describe the existing version-1 data contracts and are not dashboard import payloads. Acceptance results belong to [tests/README.md](../tests/README.md).

The layouts do not create sources, enable polling, install plugins, fabricate live values, or add historical storage. They arrange the same authorized datasets already supported by Home. A current-value card is not a time-series chart, and a service-status list only displays status supplied by its source.

## Three layouts

All main layouts use the existing 24-column grid. Narrow displays use one ordered flow, preserving the same source binding. Page theme, color preference, density, header and footer remain independent of the selected layout.

| Preset | Main content | Source slots | Intended use |
| --- | --- | --- | --- |
| `personal-overview` | Weather, 8 columns; calendar, 16 columns; favorites and bookmark navigation below | `weather` → `weather.forecast@1`; `calendar` → `calendar.events@1` | An everyday starting page with the user's own agenda, chosen location and bookmarks |
| `service-operations` | Service status, 16 columns; resource metrics, 8 columns; operational bookmarks below | `services` → `status.collection@1`; `resources` → `metrics.summary@1` | Read an existing monitoring system's summary and open its full management interfaces |
| `data-summary` | Two metric groups, 12 columns each; optional GitHub Traffic below; reference bookmarks last | `overview` and `secondary` → `metrics.summary@1`; `traffic` → `github.traffic@1` | Latest business or operational totals, with the existing GitHub observations when explicitly configured |

Metric groups are complete source snapshots. Home currently does not support a binding query that selects metric IDs, aggregates values, changes units, computes ratios, or creates trend history. Use a separate source per group, or one larger metrics panel. Binding both metric slots to the same source displays the same group twice and should be identified by the setup UI.

The existing GitHub Traffic source is optional. Selecting a data-summary layout must not create a GitHub connection or imply a new history backend.

### Slots, display settings and field mapping

| Preset / slot | Renderer and input | Default settings | Actual fields displayed |
| --- | --- | --- | --- |
| Personal / `weather` | `builtin/weather`, input `weather` | `forecastDays: 5` | `locationName` or coordinates; current temperature, conditions and optional apparent temperature/humidity/wind; available `daily` dates, high/low temperatures, conditions and optional rain probability |
| Personal / `calendar` | `builtin/calendar`, input `events` | `viewMode: "week"` | Event title, start/end, all-day range, status and supplied location/description; dataset timezone and synchronized window |
| Services / `services` | `builtin/status`, input `status` | `showLatency: true` | Each item's label, availability, optional message and measured `latencyMs`; an optional URL is a display link |
| Services / `resources` | `builtin/metrics`, input `metrics` | `showBars: true` | Every metric's label, current value or unknown marker, unit and supplied status; a range bar when a numeric value and usable range exist |
| Statistics / `overview` | `builtin/metrics`, input `metrics` | `showBars: false` | Complete primary metric group; intended for latest totals or period aggregates already calculated upstream |
| Statistics / `secondary` | `builtin/metrics`, input `metrics` | `showBars: true` | Complete secondary metric group; meaningful percentages can include `min: 0, max: 100` |
| Statistics / `traffic` | `builtin/github-traffic`, input `traffic` | Existing renderer defaults | Existing `github.traffic@1` repository observations; no new general-purpose history contract |

Component titles follow the selected UI language and remain editable. Settings control presentation; they do not select fields, change collection frequency or convert units. Both metric slots display their source's entire `metrics` array. A progress bar represents position within a supplied range, not a time trend or automatically evaluated threshold. Weather sunrise/sunset and the observation instant can be retained in its contract without being shown as extra widgets by this preset.

The service layout emphasizes a status list beside resource cards. The statistics layout gives two metric groups equal width. The personal layout gives the agenda more room than the weather summary. These are arrangements of existing cards, not additional frontend themes or a new chart engine. When a slot is omitted, empty rows are removed and the remaining card in a two-card row can use all 24 columns.

## Resolve slots before producing a page

The current PageConfig validator requires each non-search view to have exactly its declared input and an existing binding. A binding can reference only `local-navigation` or a real `source:<32-hex-ID>` in the current space. Calendar, weather, metric, status and Traffic bindings use `query:{}`. A navigation/favorites slot that retains its existing dataset also retains that panel's valid navigation query and effective interaction group, so its filters and retained search/category controls continue working. Changing its dataset starts a new empty query; unrelated category filters are not copied into a new navigation panel. Unknown source IDs, cross-space sources and incompatible schemas are rejected on page save.

Consequently, an unconnected slot belongs to the preset selection UI, not to a fabricated Dataset or an invalid saved view:

1. Select a preset and preview its layout. A slot with no assignment shows **Needs a source** and its required schema. This preview does not fetch data or label example values as live. A compatible candidate has an explicit numeric `schemaVersion: 1` and is not disabled; a missing version is not assumed to mean version 1. An enabled source without a first snapshot can be selected, and its saved component displays the normal waiting-for-data state.
2. For each desired slot, choose an existing compatible source. A signed-in user with source-write access can explicitly open the normal source-creation form; creating that source is a separate immediate write, as in component-template import.
3. A user can explicitly skip a slot. Skipped slots produce no view, binding or placement. Navigation remains usable even if every external slot is skipped. A preset reuses the current navigation/favorites panel's compatible, still-available dataset when possible, with `local-navigation` as its fallback.
4. Compile the selected slots and local panels into a valid PageConfig draft. A selected slot without a compatible assignment prevents applying the draft and identifies the unresolved slot. Do not substitute `missing:*`, a fake source UUID, `local-navigation` with the wrong schema, or empty component inputs.
5. Preserve the current page's theme, appearance and chrome. Existing source records and navigation records remain unchanged. Replacing a layout changes views and their bindings in the draft, so the UI must state that replacement before applying it.
6. Use the existing explicit page-save endpoint and its current revision. The server rechecks source existence, schema and space permissions. A failed save leaves the draft available for correction.

At the compiler boundary, slot assignments are ephemeral inputs such as:

```json
{
  "presetId": "service-operations",
  "assignments": {
    "services": "source:<actual-status-source-id>",
    "resources": null
  }
}
```

This is an illustrative compiler input, **not** a new HTTP API. `null` means explicitly skip. An omitted assignment is unresolved until the user chooses or skips it. Real saved bindings contain neither `null` nor angle-bracket placeholders:

```json
{
  "bindings": {
    "services": {
      "datasetId": "source:0123456789abcdef0123456789abcdef",
      "space": "current-page-space",
      "query": {}
    }
  },
  "views": [
    {
      "id": "services",
      "panel": { "id": "builtin/status" },
      "inputs": { "status": "services" },
      "settings": { "title": "Service status", "showLatency": true }
    }
  ]
}
```

The example ID must be replaced with an existing source. This fragment also needs the ordinary PageConfig theme, appearance and layout fields; it is not a complete standalone page.

## Existing implementation boundaries

| Concern | Existing entry point |
| --- | --- |
| Current navigation-only presets | `web/src/core/presentation.ts`: `presetConfig()` |
| New dashboard catalogue and pure draft compiler | `web/src/home/dashboard-presets.ts`: `DASHBOARD_PRESETS`, `matchingDashboardPresetSources()`, `createDashboardPresetAssignments()`, `compileDashboardPreset()` |
| Preset selection, draft application and explicit save | `web/src/components/DashboardPresetDialog.tsx`, opened by `web/src/home/HomeEditor.tsx`; the visual composer applies the draft and uses the existing page-save flow |
| Renderer/schema/input map and safe draft operations | `web/src/home/composition.ts`: `panelContracts`, `addPagePanel()`, `bindPagePanel()` |
| Existing source selection and explicit compatible-source creation | `web/src/components/WidgetImportDialog.tsx` and `web/src/admin/SourceDialog.tsx` |
| Current-value, calendar, weather and status views | `web/src/home/DataPanels.tsx` |
| PageConfig shape and layout validation | `server/internal/home/page_config.go`: `validatePageConfig()` |
| Source existence, schema and same-space validation | `server/internal/home/integrations_data.go`: `validateIntegrationPageBindings()` |
| Normalized component data validation | `server/internal/home/integrations_components_data.go`: `normalizeComponentData()` |

The compiler receives the current config, authorized current-space source list and slot assignments. It reports unresolved or incompatible slots, warns when both metric groups use the same source, and returns a complete page draft only when all selected slots resolve. It preserves theme, appearance, chrome, gap and the relevant search/category settings, together with the query and interaction group of reused navigation/favorites sources. Its 64 KiB precheck accounts for the server's HTML-safe JSON escaping. It does not need a database migration, a new renderer, a new source kind, or a new network transport.

## Machine-readable handoff files

The [example directory](../examples/dashboard-data/README.md) contains `index.json` plus eight complete existing `PUT /snapshot` bodies:

| Files | Contract | Purpose |
| --- | --- | --- |
| `metrics.resources.push.json` | `metrics.summary@1` | CPU/memory percentages and disk-use fields, all explicitly unknown |
| `metrics.overview.push.json`, `metrics.secondary.push.json` | `metrics.summary@1` | Separate primary and secondary aggregates with units and collection-period labels |
| `status.services.push.json` | `status.collection@1` | Unknown service status with explanatory messages; unmeasured latency omitted |
| `calendar.events.push.json`, `calendar.empty.push.json` | `calendar.events@1` | Fictional timed/all-day events and a successful empty window |
| `weather.forecast.push.json`, `weather.empty.push.json` | `weather.forecast@1` | Fictional current/daily fields and omitted current observations |

The index declares renderer inputs, collection limits, required/optional fields, units and compatible source-creation bodies. It is a machine-readable handoff guide, not a new API format or a claim that a generic JSON Schema fully reproduces Home's validator. No separate JSON Schema is supplied: UTF-8 byte lengths, calendar/timezone relationships, duplicate IDs and numeric cross-field constraints remain governed by `normalizeComponentData()` and the existing source validator. The examples are read by `TestDashboardDataExamplesMatchContracts`, which runs them through those production validators without creating sources or performing network I/O.

All examples have the fixed collection timestamp **2024-01-15T08:00:00Z**. Their calendar entries and weather observations are fictional and visibly labelled as examples; the metrics and status samples are unknown. The previous-24-hour statistic labels refer to the fixed interval `[2024-01-14T08:00:00Z, 2024-01-15T08:00:00Z)`. They illustrate a contract and must not be seeded or relabelled as current data.

### Values, units and missing fields

| Situation | Producer representation | Meaning |
| --- | --- | --- |
| Unknown metric | Required `value: null`; `status` normalizes to `unknown` | No measured number; the view shows an unknown marker |
| Measured zero | `value: 0` | An actual zero, not a fallback for a failed collection |
| Missing required metric value | Omit `value` | Invalid input; it does not become null or zero |
| Unknown service availability | `status: "unknown"` | Availability was not established |
| Unmeasured service latency | Omit `latencyMs` | No latency is inferred; zero is reserved for a supplied measurement |
| No calendar entries in a successfully read window | `events: []` with valid timezone/window fields | Empty successful result, distinct from no snapshot or a failed subscription |
| No current weather observation | Omit `current` entirely; retain required location/timezone/`daily` fields | `current: null` is rejected; `daily: []` is permitted |
| Missing forecast value | Omit an unavailable optional field, or omit a day whose required fields cannot be supplied | Required day temperature/code fields cannot be filled with invented zeros |

Top-level collections must be arrays, including when empty; missing/null required collections are rejected. Unknown fields inside these four schemas are rejected. Units in a metric are display text only: the producer must decide whether values are percentages, bytes, MiB/GiB, counts, rates or milliseconds and convert them consistently. Use labels/source names to make the period and aggregation clear. Home does not aggregate distinct visitors, compute p95, turn a counter into a rate, or convert units for the adapter.

Weather units are fixed to Celsius, kilometres per hour and percentages. Its times, and calendar event/window times, use UTC Unix **seconds**; an all-day date and a forecast date use `YYYY-MM-DD`. All-day event dates must match local-midnight timestamps in the event timezone, falling back to the dataset timezone, with an exclusive end date. A weather date retains its provider's daily bucket label. The accepted WMO weather-code set is listed in the index and checked by the normalizer; an unsupported code cannot be substituted for unknown conditions.

### Collection time, freshness and failure

The push envelope's `sourceUpdatedAt` is an RFC 3339 timestamp or `null` when unknown. Values more than five minutes into the future are rejected. It belongs to the envelope, not inside `metrics`, `items` or another custom metadata object. Home records its own `receivedAt` and successful snapshot time separately. Metric/status items do not have individual collection timestamps in version 1; publish one coherent group, or separate sources when their observation times and freshness expectations differ.

`meta.freshness` is currently `fresh`, `stale` or `disabled`. Its age check uses **Home's receipt time** and `staleAfterSeconds`; a recorded collection error also makes retained data stale. It does not age data using `sourceUpdatedAt`, a weather observation instant or a calendar window. Therefore, freshly re-pushing an old successful result can make the receipt look fresh. Adapters must preserve the actual collection time and avoid continually publishing cached upstream data as a new observation. Card footers report Home's last successful receipt/collection time; they do not claim to display each metric's observation time.

When a polling source cannot be fetched or validated, Home preserves the last successful snapshot and exposes a safe `lastError`. A failed push returns an error to the producer and does not install the invalid data. A push producer whose upstream is unavailable can stop updating so the saved snapshot ages past its configured threshold, or publish truthful `null`/`unknown` observations when that is an intentional new state. Do not convert a failed calendar fetch into a successful empty calendar, replace failed counters with zero, or put a forged Home `meta.lastError` inside the data object.

### Bounded persistence

Every accepted component update atomically replaces **one latest snapshot for that source**. There is no new metrics/status time-series schema, chart history, aggregation table or background retention service in these presets. Collection bounds are 32 metrics, 64 status items, 500 calendar events within at most 90 local calendar days, and seven weather forecast days. Both incoming component data and normalized stored data are limited to 1 MiB. A space supports at most 64 external sources; a page supports at most 32 views and 32 bindings.

Push receipts retain exact retries for up to seven days, with a maximum of 256 retained receipts per source after an accepted write. Cleanup happens on accepted writes or source deletion; an idle source does not start a cleanup timer. An evicted receipt does not bypass revision/sequence guards. The existing optional GitHub Traffic adapter retains its own defined observations, independently of this latest-snapshot component contract.

## Existing API shapes for later adapters

Create an explicitly requested push source:

```http
POST /api/v1/spaces/{spaceId}/sources
```

```json
{
  "name": "Resource summary",
  "kind": "external-push",
  "schemaId": "metrics.summary",
  "schemaVersion": 1,
  "connection": {},
  "sync": { "mode": "push", "staleAfterSeconds": 300 },
  "enabled": true
}
```

This source kind does not poll. The source response supplies its real `id` and `datasetId`. Creating a source requires an account, source-write authorization and write access to its space. A source-scoped PAT with `datasets:write` and the necessary space access can submit the existing `PUT /api/v1/sources/{id}/snapshot` envelope. Keep credentials out of files intended for sharing. Binding the resulting dataset also requires page-write/source-read authorization in that same space.

Use an example's `expectedRevision: "0"` only on a source with no snapshot. After acceptance, keep the returned revision and choose a new request ID for a new observation. At least one of `expectedRevision` or a positive numeric `sourceSequence` is required; if both are supplied, both must pass. A retained exact retry uses the same ID and unchanged body. `GET /api/v1/sources/{id}/snapshot` reads the current Dataset with source-read authorization; reading cached data does not trigger upstream collection.

An `external-json` source instead uses HTTP GET to retrieve only the normalized data object, such as `{"metrics":[...]}` or `{"items":[...]}`. It does not consume a full Home Dataset envelope. Its address belongs to encrypted `secret.url`, an optional bearer credential to `secret.bearerToken`, and its public connection declares the schema and any explicit private-network permission. Configuring an enabled polling source is an intentional action separate from choosing a dashboard layout.

The polling adapter records its receipt/collection time but does not ingest the push envelope's `sourceUpdatedAt`. Its default interval is 60 seconds, minimum 30 seconds, with staleness defaulting to twice the interval. Calendar subscriptions default to 15 minutes and weather to 30 minutes; a push source has no polling interval. `POST /api/v1/sources/{id}/sync` with `{}` queues an enabled polling source and returns `202`; it does not report a completed fetch. Disabling a source stops collection while preserving its successful snapshot. Hiding a view alone does not stop an already-enabled source.

The shared page, preset catalogue, example data and component settings never carry source passwords, API keys, bearer tokens or subscription URLs. Those belong to the existing encrypted source configuration and are not returned with source reads. Browser authorization headers/cookies are not forwarded to upstream data services. For an external JSON source with a saved bearer credential, changing its URL origin requires an explicit replacement or `secret.clearBearerToken: true`. Existing target-address, redirect, timeout and [outbound-proxy](NETWORK.md) policies continue to apply.

Save the compiled page through the existing API:

```http
PUT /api/v1/spaces/{spaceId}/page
Content-Type: application/json
```

The request body is `{name, expectedRevision, config}`, where `config` is the complete compiler result and `expectedRevision` is the current page revision. No unresolved slots, sample source IDs or preview-only placeholders are included. The server performs the same current-revision and space checks as any manual edit. See [COMPONENTS.md](COMPONENTS.md) and [INTEGRATIONS.md](INTEGRATIONS.md) for the complete source, snapshot, timestamp, credential and retention contracts.
