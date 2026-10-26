# Components, source contracts and lightweight operation

This document describes the component/data-source contracts in version 0.0.6, including the document-activity component. Test results and release verification are recorded separately in [tests/README.md](../tests/README.md).

## Separation of responsibilities

Home owns authentication, spaces, page revisions, source credentials, fetching and persistence. A component receives a typed, authorized dataset and renders it. Page bindings connect a component to a dataset in the same space. Layout and theme changes preserve those bindings and the underlying navigation records.

The ordinary homepage does not call upstream services directly. Configuring an enabled polling source explicitly starts server-side collection, even if its component is later hidden. Hiding or removing a component changes presentation; disable the source to stop collection. A source with an existing snapshot can remain visible after disabling, with its disabled state shown.

The scheduler waits for the next due source or a committed source change. An empty schedule has no recurring polling timer. Source creation/configuration/manual synchronization wakes it after the transaction commits. No Redis, queue service, separate collector agent, time-series database, or charting service is required for the built-in components. Source responses and parsing are bounded, and unsuccessful refreshes preserve the last good snapshot.

The browser shares the dashboard snapshot among components. It exposes a cached-data refresh action for external components; refreshing it is not an upstream synchronization request. Returning to a visible page may refresh that shared snapshot after a freshness threshold. Components do not create their own polling intervals or WebSocket connections. Optional component/editor code is loaded when needed.

## Built-in component contracts

All schemas below are version 1. The external component schemas use exact fields and bounded collections; unknown fields are rejected. Calendar/weather instants use UTC Unix seconds, not JavaScript milliseconds. Document-activity timestamps use RFC 3339 strings as defined by its API. Calendar dates (`YYYY-MM-DD`) are not UTC instants.

| Renderer | Dataset schema | Input | Function |
| --- | --- | --- | --- |
| `builtin/search` | No dataset input | — | Search through its navigation interaction group |
| `builtin/category-navigation` | `navigation.collection` | `collection` | Category navigation |
| `builtin/favorites` | `navigation.collection` | `collection` | Favorite bookmarks |
| `builtin/navigation` | `navigation.collection` | `collection` | Bookmark cards/directory |
| `builtin/github-traffic` | `github.traffic` | `traffic` | Retained GitHub Traffic observations |
| `builtin/calendar` | `calendar.events` | `events` | Day/week agenda, all-day and overlapping events |
| `builtin/weather` | `weather.forecast` | `weather` | Current conditions and a bounded daily forecast |
| `builtin/metrics` | `metrics.summary` | `metrics` | Numeric metrics and optional defined-range bars |
| `builtin/status` | `status.collection` | `status` | Service availability and optional latency |
| `builtin/document-activity` | `documents.activity` | `activity` | Heatmap, heatmap with details, or monthly calendar (since 0.0.6) |

### Component settings

Every component accepts an optional plain-text `title` of at most 80 characters. Calendar, weather, metrics and status additionally support:

| Renderer | Setting | Accepted values | Default |
| --- | --- | --- | --- |
| Calendar | `viewMode` | `day`, `week` | `week` |
| Weather | `forecastDays` | Numeric `3`, `5`, `7` | `5` |
| Metrics | `showBars` | Boolean | `true` |
| Status | `showLatency` | Boolean | `true` |

Display settings do not change source collection settings. The forecast view can only display days present in its source snapshot. Calendar day/week navigation during ordinary browsing is temporary.

### Navigation category previews

The `builtin/navigation` renderer additionally accepts `settings.groupPreviewCount`: numeric `0` (all), `4`, `6`, `8`, `12` or `24`, defaulting to `6` when absent. The remainder opens in a searchable category folder with 24 records per page and up to four responsive columns. Current navigation filters still apply. `builtin/favorites` does not accept this category-only setting. The saved choice belongs to the page draft; opened folders and their local search/page remain temporary, and no dataset records are trimmed. See [the page/API contract](API.md#category-folder-presentation).

### `documents.activity@1`

This built-in component has three repeatable presets, not a fixed homepage layout. Bind `activity` to `local-document-activity` in the current page space with `query:{}`. Each view owns `presentation`, `months`, `perspective`, `sourceIds`, `showSummary`, `recentLimit`, `detailLayout` and `timezone`; widths and heights remain in `layout.placements`. The [activity guide](DOCUMENT_ACTIVITY.md) defines exact values, defaults and counting rules.

Dashboard datasets contain only an empty schema marker for this binding. A shared browser provider reads authorized working-document activity through its dedicated read-only API, deduplicates queries and resets on identity/space/permission changes. It does not use external JSON/push sources or collect original files. Public-page readers receive no draft activity data. Date selection is independent unless views explicitly share `interactionScope`; copying an activity component clears that scope. Browsed dates/details remain runtime state.

### `calendar.events@1`

```json
{
  "timezone": "Asia/Shanghai",
  "windowStart": 1792252800,
  "windowEnd": 1794931200,
  "events": [
    {
      "id": "planning-20261019",
      "title": "Planning",
      "startAt": 1792371600,
      "endAt": 1792375200,
      "allDay": false,
      "timezone": "Asia/Shanghai",
      "status": "confirmed"
    }
  ]
}
```

The window is explicit and at most 90 days. Up to 500 events are accepted. Optional event fields are `location`, `description`, `url`, `timezone`, and `status` (`confirmed`, `tentative`, `cancelled`). For all-day events, `startDate` and `endDate` are required and the end date is exclusive. Keep an event's source timezone distinct from the viewer's machine timezone. An empty event array is a successful empty calendar; a missing snapshot or failed refresh is a different state.

#### ICS support and limits

Subscriptions and one-time file imports share a read-only parser for a bounded subset of RFC 5545. The input must be a `VERSION:2.0` calendar containing `VEVENT` entries, with `METHOD` omitted or set to `PUBLISH`.

| Area | Supported subset |
| --- | --- |
| Event times | `VALUE=DATE` all-day events; UTC date-times ending in `Z`; date-times with an explicit IANA `TZID`; and floating date-times interpreted in the configured source timezone. All-day `endDate` is exclusive. `DTEND` and positive week/day/time `DURATION` are supported separately, with a maximum event duration of 366 days. |
| Recurrence rules | One `RRULE` per master event, with `FREQ=DAILY`, `WEEKLY`, `MONTHLY`, or `YEARLY`. Accepted parts are `INTERVAL`, `COUNT`, `UNTIL`, `WKST`, `BYDAY`, `BYMONTH`, `BYMONTHDAY`, and `BYSETPOS`. Ordinal `BYDAY` is limited to monthly/yearly rules; weekly rules cannot use `BYMONTHDAY`; `BYSETPOS` requires another `BY` part. `COUNT` and `UNTIL` cannot be combined, and `DTSTART` must match the rule. |
| Recurrence dates and exceptions | `RDATE` and `EXDATE` with the same DATE/DATE-TIME and floating/zoned form as the master; single-instance `RECURRENCE-ID` rescheduling and `STATUS:CANCELLED` exclusions. An exception must identify an occurrence of a master in the same file. The event ID remains tied to the original occurrence when it moves. |
| Embedded timezone definitions | `VTIMEZONE` with a recognized IANA identifier and supported `STANDARD`/`DAYLIGHT` observances whose transitions can be verified against the bundled IANA timezone database around the requested window. Yearly observance rules and local `RDATE` values are supported within the expansion budget. |
| Display content | Summary, description and location are normalized as plain text. Event links are limited to HTTP/HTTPS and are not fetched by the parser. Embedded `VALARM` entries are ignored; importing a calendar does not schedule notifications. |

Local recurrences retain their wall-clock time across daylight-saving changes. A generated occurrence in a nonexistent local time is skipped without consuming `COUNT`; an explicitly supplied nonexistent time is rejected. An ambiguous repeated time uses its first, earlier occurrence. A nominal `DURATION:P1D` follows one local calendar day, which may span 23 or 25 hours, while the duration derived from a timed `DTEND` remains an elapsed duration. `UNTIL` must be a date for an all-day series, a floating time for a floating series, or a UTC time for a zoned series.

The requested window is at most **90 local calendar days**, with an exclusive end. Source defaults are one past day and 30 future days; `pastDays` is 0–30, `futureDays` is 1–90, and their sum cannot exceed 90. The parser accepts at most 1 MiB of raw input, 2,000 `VEVENT` entries and 10,000 explicit recurrence dates, and returns at most 500 events. A shared 100,000-unit work budget also bounds recurrence and timezone expansion; even an otherwise valid rule can be rejected when too expensive to expand. Normalized snapshots are limited to 1 MiB. Exceeding an event or expansion limit fails the import/refresh rather than silently truncating the event set.

Explicitly rejected constructs include hourly/minutely/secondly recurrence; rule parts outside the list above, including `BYHOUR`, `BYMINUTE`, `BYSECOND`, `BYWEEKNO` and `BYYEARDAY`; `EXRULE`; `RDATE;VALUE=PERIOD`; `RECURRENCE-ID;RANGE=THISANDFUTURE` or any other `RANGE`; unknown/custom, conflicting or unverifiable timezone definitions; orphaned or ambiguous duplicate recurrence exceptions; scheduling methods such as `REQUEST`, `REPLY` or `CANCEL`; and non-event components such as `VTODO` or `VJOURNAL`. Leap seconds and numeric-offset date-time strings are not supported. These validation failures leave the last successful subscription snapshot intact.

Raw ICS bodies are not persisted. The stored snapshot contains the normalized event window, including its event titles and other accepted display fields; subscription URLs are stored separately as encrypted credentials. A file import creates a finite-window snapshot and does not continue following the original file or expanding future recurrences. CalDAV discovery, OAuth calendar account connection, invitations, event editing and two-way synchronization remain outside this iteration's scope.

### `weather.forecast@1`

The required top-level fields are `timezone`, `latitude`, `longitude`, and `daily`; `locationName` and `current` are optional. `daily` contains at most seven entries. Temperature is always Celsius, wind speed kilometres per hour, and humidity/precipitation probability percent in this schema.

```json
{
  "timezone": "Asia/Shanghai",
  "latitude": 31.23,
  "longitude": 121.47,
  "locationName": "Shanghai",
  "current": {
    "time": 1792371600,
    "temperature": 22,
    "weatherCode": 2,
    "isDay": true
  },
  "daily": [
    { "date": "2026-10-19", "weatherCode": 2,
      "temperatureMax": 24, "temperatureMin": 18 }
  ]
}
```

Optional current fields are `apparentTemperature`, `humidity` and `windSpeed`. Optional daily fields are `sunrise`, `sunset` (instants) and `precipitationProbability`. Missing observations remain absent/unknown; zero is a measured value. Weather codes follow the provider's documented WMO mapping; unknown codes retain a fallback description.

Open-Meteo daily dates retain the provider's fixed-offset daily bucket labels. They do not claim to recalculate 23/25-hour daylight-saving days from hourly observations. The contract retains current/sunrise/sunset instants for timezone-aware use. This first weather view displays conditions and daily forecasts; its footer reports the latest successful collection/receipt time (`meta.lastSuccessAt`, falling back to `meta.receivedAt`), not the weather observation instant. Calendar and weather footer times use the current interface locale and the validated source IANA timezone printed on the card; metrics and status footer times use the browser's local timezone. The weather view does not yet display sunrise/sunset. See the provider's [time format and timezone documentation](https://open-meteo.com/en/docs).

The source form uses explicit city coordinates and a timezone, without requesting browser geolocation on homepage load. The free hosted Open-Meteo service is for non-commercial use under its [current terms](https://open-meteo.com/en/terms); commercial hosting uses the commercial provider option and its write-only API key. Its data attribution is attached by the official adapter. A generic pushed weather payload is not automatically attributed to Open-Meteo.

### `metrics.summary@1` and `status.collection@1`

```json
{
  "metrics": [
    { "id": "cpu", "label": "CPU", "value": 21.5,
      "unit": "%", "min": 0, "max": 100, "status": "ok" },
    { "id": "visitors", "label": "Visitors", "value": null }
  ]
}
```

Up to 32 metrics are accepted. `id`, `label` and `value` are required; `value` is finite numeric data or explicit `null`. `unit`, `min`, `max`, and `status` (`ok`, `warning`, `critical`, `unknown`) are optional. A progress bar requires a meaningful range. Home does not sum distinct visitors across days or infer missing values as zero.

```json
{
  "items": [
    { "id": "api", "label": "API", "status": "up",
      "latencyMs": 24, "url": "https://example.org/status" }
  ]
}
```

Up to 64 status entries are accepted. `id`, `label` and `status` are required; status is `up`, `degraded`, `down` or `unknown`. Optional fields are `message`, `latencyMs` and an HTTP/HTTPS `url`. Rendering these entries does not run a probe against each URL.

## Source and transport choices

| Source | Configuration | Default interval | Storage |
| --- | --- | --- | --- |
| `external-push` | Existing authenticated snapshot endpoint; navigation or one of the four schemas above | No polling | Latest snapshot and bounded replay receipts |
| `external-json` | HTTP GET returning one normalized component data object | 60 seconds; minimum 30 | Latest valid normalized snapshot |
| `calendar-ics` | Secret HTTP/HTTPS ICS subscription URL, source timezone and window | 900 seconds; minimum 300 | Latest expanded window; no raw subscription body |
| `weather-open-meteo` | Coordinates, timezone, forecast days and provider selection | 1800 seconds; minimum 900 | Latest normalized weather response |
| `github-traffic` | Repository plus encrypted token | 21600 seconds; minimum 300 | Existing baseline, daily history and snapshot |

Connection configuration values are strings. `schemaVersion` in source/data envelopes remains numeric; the optional duplicate value in the `external-json` connection is the string `"1"`. Secret subscription/API URLs belong to the write-only `secret.url`, not public connection fields. A bearer credential uses `secret.bearerToken`; a commercial weather key uses `secret.apiKey`. Browser source reads only report whether credentials are configured. Omitting a secret while editing retains it. For `external-json`, `secret.clearBearerToken:true` explicitly removes the saved bearer credential and cannot accompany a replacement token. Changing URL origin while a bearer credential exists requires a replacement token or explicit clearing; credentials are never silently inherited by a different origin. The clear control is not stored as a credential.

`external-json` accepts the data object, not an entire Home Dataset envelope. Its first version deliberately has no user-authored JavaScript, SQL expression or arbitrary request body. An upstream JSON shape that differs from the contract needs a small adapter in the existing upstream system or a future named Home connector. An upstream API may use POST for read-only queries; that alone does not make it supported by this GET adapter.

Push writes reuse Home PAT scopes, same-space checks, a request ID, and expected revision and/or a monotonic source sequence. They atomically replace one source snapshot. Replay lookup accepts receipts from the past seven days, with a maximum of 256 receipts per source after each accepted write; exact replay is guaranteed within the retained window. After eviction, revision/sequence checks still apply. Physical cleanup happens on the next accepted snapshot or source deletion; an idle source does not start a background cleanup timer. See [INTEGRATIONS.md](INTEGRATIONS.md) for the wire protocol.

New polling responses and component snapshots are limited to 1 MiB; template import has a smaller independent limit. HTTP polling has a 15-second request budget, bounded redirects, DNS-to-connection address checks, and no inherited environment proxy. An Owner can configure the explicit [server outbound proxy](NETWORK.md), preserving the adapter's target-address and credential policies. Public networking is the default. An explicit private-network option permits eligible private ranges for self-hosted sources while still blocking loopback, link-local and metadata addresses. A redirect does not transfer credentials to another origin. Network errors return safe codes, not subscription URLs, bearer tokens or upstream response bodies.

WebSocket, server-sent events and MQTT are considered transport adapters, not component APIs. They must feed the same authorization, schema validation, revision and latest-snapshot path. This iteration does **not** expose a WebSocket/SSE/MQTT ingress or advertise a realtime capability. A later implementation needs per-source connection limits, bounded queues, heartbeat/reconnect backoff, message size/rate limits, sequence recovery and cancellation on disable. Calendar/weather defaults do not require persistent connections.

### One-time ICS import and source deletion

`POST /api/v1/sources/{id}/calendar-import` requires an enabled `external-push` source with `calendar.events@1`, current account/space authorization, and `datasets:write`. Its body is `{requestId,expectedRevision,icsText,timezone,pastDays?,futureDays?}`; day counts are JSON integers, while subscription connection day counts are strings. The imported file is at most 1 MiB. The original decoded request is hashed for replay before calculating the time window, so an identical retained retry across midnight returns the original receipt. Raw ICS text is not persisted. Unsupported rules return a validation failure rather than being guessed.

`DELETE /api/v1/sources/{id}` requires source-write authorization and `{expectedConfigRevision,detachUnusedBindings?}`. Any active or hidden component still referring to that source returns `409 source_in_use`. With only orphaned page bindings remaining, omission/false still rejects deletion; explicit `detachUnusedBindings:true` removes those unused aliases in the same transaction, advances affected page revisions, and deletes the source, credentials, snapshots, receipts and source-related history. It does not delete components or local bookmarks. A stale source configuration revision returns `409 source_config_conflict`. The admin confirmation explicitly describes the unused-binding cleanup and reloads the dashboard after success.

## Import a component from a web page

The supported import unit is a declarative template for an installed built-in renderer. It can arrive as a JSON file/paste, an HTTP/HTTPS JSON URL, or a page that advertises its template in the HTML head (including reachable LAN hosts and custom ports since 0.0.4):

```html
<link rel="lingshu-home-component" href="/home/calendar.component.json">
```

```json
{
  "format": "lingshu-home-component",
  "manifestVersion": 1,
  "id": "example/team-calendar",
  "version": "1.0.0",
  "name": "Team calendar",
  "description": "A weekly agenda using a local calendar source",
  "license": "MIT",
  "homepage": "https://example.org/components/calendar",
  "renderer": "builtin/calendar",
  "dataSchema": { "id": "calendar.events", "version": 1 },
  "settings": { "viewMode": "week" },
  "layout": { "width": 12, "height": 6 }
}
```

`POST /api/v1/spaces/{spaceId}/component-templates/preview` accepts exactly one of `{ "url": "..." }` and `{ "manifest": { ... } }`. It requires current page-write authorization and normal browser CSRF protection. Network fetches happen outside the database transaction and authorization is checked again before returning a result.

`POST /api/v1/spaces/{spaceId}/component-templates/discover` accepts `{ "url": "..." }` with the same page-write/CSRF requirements. A direct JSON document returns `{sourceUrl,templates:[],truncated:false,preview:{manifest,sha256,sourceUrl}}`. An HTML head returns `{sourceUrl,templates:[{url,title?}],truncated}` with at most eight distinct allowed declarations. Relative links resolve against the final page URL; fragment duplicates collapse. Extra declarations or parser/body limits set `truncated`. The server does not fetch candidate manifests during discovery. Selecting a candidate calls the existing preview endpoint. Existing URL-preview clients retain first-declaration behavior. Both endpoints share an eight-second, five-request/redirect budget and recheck authorization plus the proxy revision after network I/O.

The manifest is at most 64 KiB, supports only manifest version 1 and known renderer/schema pairs, and must pass normal page-settings validation. The head-discovery path reads at most 128 KiB and does not render or execute the external page. Requests accept HTTP/HTTPS ports 1–65535. The editor-supplied hostname may resolve to RFC1918/ULA or public addresses; redirects and declarations on other hosts must remain public. The original hostname scope survives discovery and nested preview, and every DNS answer is validated before dialing a literal IP. Loopback/link-local/metadata/CGNAT/reserved targets remain blocked. Requests retain bounded redirects and carry no browser cookies or Home token. See [destination policies](NETWORK.md#destination-policies). An ordinary arbitrary webpage without a supported template is not convertible into a component.

The import flow previews the name, renderer, version, license, source URL and content hash; the user then selects a compatible source. The dialog can create a compatible source and return to the preserved preview, using normal account and space authorization. Source creation persists immediately; dismissing an unsaved page draft does not delete that source. The dialog also provides static, credential-free renderer examples and an HTML-head declaration example. Applying the template only changes the current page draft. The existing explicit, revision-checked page save persists it. Saved `view.template` metadata is `{id,version,sha256,sourceUrl?}`; it is provenance, not executable loader configuration or proof of publisher identity. A hash alone is not a signature. A template source URL is public provenance, including any query string, and follows page sharing/export visibility; use a publicly shareable template URL. Secret subscriptions belong in encrypted source configuration. Imported templates contain no credentials, source connections, scripts, styles, external assets or automatic update channel.

**Activity templates (since 0.0.6):** use `renderer:"builtin/document-activity"` with `dataSchema:{"id":"documents.activity","version":1}` and the [activity settings](DOCUMENT_ACTIVITY.md). The importer automatically uses the built-in current-space binding and does not offer external source/token/header setup. Import remains a draft operation, and the template conveys no document-read permission.

Remote JavaScript plugins and arbitrary iframes remain future design work. Supporting them would need a separate trust model, version compatibility, isolated origin/runtime, content security policy, capability grants, package signatures/provenance, resource limits, update/rollback and revocation. They must not be introduced by broadening this template endpoint.

## Locale-specific starter content

`GET /api/v1/starter-packs` lists two static, versioned packs: `zh-CN` and `en`. Each contains 12 curated links in three groups, with bundled offline icons. They choose different sites and localized documentation URLs; they are not one URL list with translated labels.

First-run setup accepts optional `starterPack` alongside existing `seedDemo`. With `seedDemo: true`, an omitted pack follows the instance language; an explicit pack selects its content without changing the interface language. With `seedDemo: false`, setup creates no starter links. After seeded setup, the frontend opens the accessible shared space containing the new examples; normal login and later refreshes retain their existing space-selection behavior. Invalid pack IDs fail before creating instance data. Previewing a pack does not query every website. Changing the instance language later never replaces a user's links.

## Statistics systems and connector scope

Home can render normalized metrics/status supplied by an existing collector. That avoids installing another machine agent solely to populate a homepage.

| System | Practical integration boundary | Current Home scope |
| --- | --- | --- |
| Komari | Normalize latest node status/metrics from its documented API | Generic push/JSON adapter; no bundled native Komari connector |
| Umami | Normalize a selected site/time-window's analytics via its API | Metrics component; preserve period and unique-visitor semantics in labels |
| Uptime Kuma | Prefer documented public status/metrics interfaces over its internal socket API | Status component; no internal Socket.IO dependency |
| Prometheus | Query selected aggregates from an existing server | Upstream normalization; Home is not a metrics database |
| Plausible | Its stats query API uses authenticated POST | Not directly callable through the current GET adapter; use an upstream adapter or a future named connector |

These are integration directions, not claims that all native connectors are installed. See [Komari API](https://www.komari.wiki/dev/api), [Umami embedding/API guidance](https://docs.umami.is/docs/guides/embed-analytics-in-your-app), [Uptime Kuma internal API warning](https://github.com/louislam/uptime-kuma/wiki/Internal-API), [Prometheus HTTP API](https://prometheus.io/docs/prometheus/latest/querying/api/), and [Plausible Stats API](https://plausible.io/docs/stats-api).
