# Dashboard data handoff examples

These files illustrate the four existing component data contracts. They are not loaded by Home at startup, registered as sources, or shown as live preview data. The layout and source-slot behavior is described in [DASHBOARDS.md](../../docs/DASHBOARDS.md).

`index.json` is a machine-readable index of schema IDs, renderer inputs, limits, field notes, suggested dashboard slots and matching source-creation bodies. It is **not** a JSON Schema validator or an import API payload. The server's existing normalizer is authoritative, including UTF-8 byte limits, unknown-field rejection and cross-field constraints.

| File | Use | Example semantics |
| --- | --- | --- |
| `metrics.resources.push.json` | Resource overview | Unknown CPU/memory percentages and disk use; no measured zeros |
| `metrics.overview.push.json` | Primary statistics | Unknown visitor, page-view and request totals for a declared previous-24-hour period |
| `metrics.secondary.push.json` | Secondary statistics | Unknown error count, error percentage and p95 latency for the same period |
| `status.services.push.json` | Service operations | Explicitly unknown availability; unmeasured latency is absent |
| `calendar.events.push.json` | Agenda fields | Fictional timed/all-day entries on 15–16 January 2024 in UTC |
| `calendar.empty.push.json` | Empty agenda | A successfully collected empty window, distinct from a missing snapshot |
| `weather.forecast.push.json` | Weather fields | Fictional conditions and forecast on 15–16 January 2024; fixed Celsius/km/h/percent units |
| `weather.empty.push.json` | Missing observations | Known example location, no current observation, empty daily list |

All envelopes use `sourceUpdatedAt: "2024-01-15T08:00:00Z"`. Their values are intentionally fixed examples. The previous-24-hour labels refer to `[2024-01-14T08:00:00Z, 2024-01-15T08:00:00Z)`. Do not advance their timestamp and present them as newly collected data. Home determines freshness from its receipt time and source settings; it does not use this fixture timestamp to automatically reject or mark an old sample stale.

## Send through the existing push API

1. Explicitly create a source through `POST /api/v1/spaces/{spaceId}/sources`, using the matching contract's `sourceCreate` object in the index. The caller needs source-write and space-write authorization. Creating one of these enabled push sources does not start polling.
2. Keep the returned real source ID and dataset ID. Obtain the appropriate account/session authorization or a PAT scoped to this source with `datasets:write`; do not add a token to a shared JSON file.
3. For the first snapshot only, send one matching `.push.json` body to `PUT /api/v1/sources/{id}/snapshot`. The sample's `expectedRevision: "0"` assumes this source has no snapshot. For subsequent observations, use the actual revision from the source/receipt, a new request ID and the actual data/collection time. If the exact request timed out, retry the same body and request ID within the retained replay window.
4. Read `GET /api/v1/sources/{id}/snapshot` with source-read authorization, or bind its dataset to a compatible component and save the page normally. Creating/pushing a source does not add a component to a page.

The source create response contains both `id` and `datasetId`; `sourceId` is a later receipt field. The JSON files contain no source ID, user identity, connection address or credential. Do not copy one example's request ID into a continuous adapter; derive a stable request ID for each distinct observation.

## Use an existing HTTP JSON adapter

An explicitly configured `external-json` polling source expects only the example's `data` object from its HTTP GET endpoint. For example, extract that object locally:

```sh
jq '.data' examples/dashboard-data/metrics.resources.push.json
```

Do not return the push envelope or a full Home Dataset envelope. Configure the subscription address and optional bearer credential through the existing source form's write-only fields, separately from the data object. A polling adapter does not ingest this example's `sourceUpdatedAt`; its normalized snapshot records the collection/receipt time, and the weather/calendar data carries its own observation/window times. Polling defaults, network limits and credential behavior are documented in [COMPONENTS.md](../../docs/COMPONENTS.md).

An enabled poll source collects independently of whether its component is visible. Selecting a layout or reading these examples does not enable such a source. No additional daemon, charting library or history table is required by these examples.

## Check the handoff against the server

From the repository's `server` directory:

```sh
go test ./internal/home -run '^TestDashboardDataExamplesMatchContracts$' -count=1
```

The test reads the index and every published push file, validates source-creation shapes, decodes the exact existing push envelope, calls the production `normalizeComponentData()` function, and verifies normalized data stays within its storage bound and can be read back. It uses no database, credentials, network, or running service. This is contract validation; live authentication, source creation and page binding retain their separate integration tests.
