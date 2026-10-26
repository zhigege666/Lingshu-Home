# Integrations, external snapshots, MCP, and GitHub Traffic

This document describes the current development implementation. It is not a production release or a claim that a user's GitHub repository has already been connected. The first successful authorized GitHub synchronization establishes that source's traffic baseline.

## Supported sources

| Source kind | Update method | Dataset schema | Current behavior |
| --- | --- | --- | --- |
| `local-navigation` | Home's navigation APIs | `navigation.collection@1` | Built-in, authoritative categories and bookmarks |
| `local-document-activity` | Authorized local activity query | `documents.activity@1` | **Unreleased**: empty dashboard marker; working-document data comes from the dedicated read-only API |
| `external-push` | External HTTP or MCP write | Navigation or four component schemas | Validated, versioned snapshots stored independently of local navigation |
| `external-json` | Scheduled HTTP GET/manual queue | Calendar, weather, metrics or status | Normalized JSON data object; no arbitrary code mapping |
| `calendar-ics` | Scheduled HTTP/HTTPS subscription | `calendar.events@1` | Read-only bounded ICS agenda |
| `weather-open-meteo` | Fixed provider HTTP API | `weather.forecast@1` | Current observations and daily forecast |
| `github-traffic` | Scheduled polling and manual queue | `github.traffic@1` | GitHub repository traffic, immutable first baseline, retained daily observations |

The public `deliveryModes` capability is `push` and `poll`. Built-in local navigation and document activity are not external delivery modes. Realtime request adapters, arbitrary JSON field mapping, and `knowledge.items@1` are future work. The bounded HTTP GET adapter, calendar/weather configuration, four component schemas and template import are documented in [COMPONENTS.md](COMPONENTS.md). Unsupported source kinds and schemas are rejected.

The homepage reads stored snapshots. Opening or refreshing the homepage does not trigger an upstream source request. One failing integration does not replace the local navigation tables.

## Authentication and permissions

Browser administration uses the existing account cookie and CSRF protection. External clients use `Authorization: Bearer <home-pat>`. A present but malformed, invalid, expired, or revoked Authorization header never falls back to browser cookies.

Personal access tokens are the intersection of an active account, one space, selected actions, and an optional source restriction. They do not grant global Owner privileges. An Owner cannot inspect another account's personal space. Members can use integration credentials only while enabled and allowed to sign in under the current access mode. Anonymous MCP is unavailable in all four modes, including `open_edit`.

| Action | Permitted integration operations |
| --- | --- |
| `navigation:read` | Read local categories and bookmarks |
| `navigation:write` | Maintain local categories and bookmarks |
| `sources:read` | Read source configuration and snapshots; resolve external page bindings |
| `sources:write` | Create or edit source configuration; rotate a source credential; queue polling |
| `datasets:write` | Push an external snapshot |
| `pages:read` | Read saved page configuration |
| `pages:write` | Save a page using its expected revision |
| `documents:read` | Read authorized documents; **Unreleased** activity queries additionally require working-document access |
| `documents:write` | Maintain authorized documents using the separate document contracts; writes also require `documents:read` |

Dashboard access requires `navigation:read` and `pages:read`. External dashboard inputs additionally require `sources:read`; without that action, they are omitted. Page writes also require read permission for every dataset binding: `navigation:read` for local navigation, `sources:read` for an external source, and `documents:read` for a local activity binding. Reading a dashboard with an activity binding does not require activity access because that projection contains only an empty schema marker; the dedicated activity query enforces working-document permission separately. A source-scoped token allows only `sources:read` and/or `datasets:write`, and only for that source. It cannot create another source, manage accounts, change publication, or mint tokens.

### Create and revoke a Home token

These endpoints require a signed-in browser account. They reject bearer-token management requests.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/v1/integrations/tokens` | This account's token metadata, without credentials |
| POST | `/api/v1/integrations/tokens` | New metadata and a token displayed once |
| DELETE | `/api/v1/integrations/tokens/{id}` | Revoke one of this account's tokens |

Creation body:

```json
{
  "name": "Navigation publisher",
  "spaceId": "<space-id>",
  "sourceId": "<source-id>",
  "actions": ["sources:read", "datasets:write"],
  "expiresAt": "<RFC3339 time>"
}
```

Omit `sourceId` or set it to `null` for a space-scoped token. Expiry must be more than one minute and at most 365 days in the future. Each account can have at most 64 non-revoked token entries. Revoke old entries, including expired ones, to free a slot.

The `201` response contains `{ "token": "lhp_...", "credential": {...} }`. The credential metadata includes `id`, `name`, `spaceId`, nullable `sourceId`, `actions`, `createdAt`, `expiresAt`, nullable `revokedAt`, and `status`. List status is `active`, `expired`, `revoked`, or `invalidated`.

Home stores only the token's SHA-256 digest. Later GETs do not return the secret or its digest. Mode changes invalidate all existing tokens. Disabling a user or resetting their password invalidates that user's existing tokens. Revocation takes effect at authentication, including queued MCP operations after they acquire the write gate.

## Source configuration

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/v1/spaces/{spaceId}/sources` | Authorized external sources; a JSON array |
| POST | `/api/v1/spaces/{spaceId}/sources` | Create a source, `201` |
| GET | `/api/v1/sources/{id}` | Source configuration and synchronization status |
| PUT | `/api/v1/sources/{id}` | Save configuration with `expectedConfigRevision` |
| GET | `/api/v1/sources/{id}/snapshot` | Latest successful dataset; `404` before the first success |
| PUT | `/api/v1/sources/{id}/snapshot` | Push a snapshot for an `external-push` source |
| POST | `/api/v1/sources/{id}/sync` | Queue an enabled polling source, `202` |
| POST | `/api/v1/sources/{id}/calendar-import` | Import a bounded ICS file into a calendar push source |
| DELETE | `/api/v1/sources/{id}` | Revision-checked deletion; active/hidden page references block it |

Configuration writes require a real account even in `open_edit`. Source and snapshot reads follow their space's visibility. Source listing excludes built-in bindings; use `/api/v1/spaces/{spaceId}/navigation` for the complete authoritative local navigation, independently of page bindings. This iteration allows up to 64 external sources per space. Source deletion and one-time ICS import use the endpoints below and their [component lifecycle contract](COMPONENTS.md#one-time-ics-import-and-source-deletion).

An external navigation source can be created with:

```json
{
  "name": "Project directory",
  "kind": "external-push",
  "schemaId": "navigation.collection",
  "schemaVersion": 1,
  "connection": {},
  "sync": { "mode": "push", "staleAfterSeconds": 3600 },
  "enabled": true
}
```

The response contains `id`, `spaceId`, `name`, `kind`, `schemaId`, `schemaVersion`, `datasetId`, `connection`, `sync`, `enabled`, string `configRevision`, string snapshot `revision`, `credentialConfigured`, `createdAt`, `updatedAt`, nullable `nextSyncAt`, nullable `lastSuccessAt`, and nullable `lastError: {code,message,at}`. No credential value, ciphertext, or internal account security version is returned.

Configuration and data have separate revision counters. A new source starts at `configRevision: "1"` and data `revision: "0"`. Updating a source requires the complete editable configuration:

```json
{
  "expectedConfigRevision": "1",
  "name": "Project directory",
  "connection": {},
  "sync": { "mode": "push", "staleAfterSeconds": 3600 },
  "enabled": false
}
```

A stale configuration revision returns `409 source_config_conflict` with `currentRevision`. Source kind and schema are immutable. Disabling a source preserves successful snapshots and history. `staleAfterSeconds` accepts 60–2,592,000 seconds; its default for push sources is 86,400 seconds.

## Push protocol

Use a token with `datasets:write` and write access to the source's space. A typical request to `PUT /api/v1/sources/{id}/snapshot` is:

```json
{
  "requestId": "directory-20261018-001",
  "expectedRevision": "0",
  "sourceSequence": 1,
  "schemaId": "navigation.collection",
  "schemaVersion": 1,
  "sourceUpdatedAt": null,
  "data": {
    "categories": [
      { "externalId": "ops", "parentExternalId": null, "name": "Operations", "icon": "lucide:folder", "sortOrder": 0 }
    ],
    "links": [
      {
        "externalId": "status", "categoryExternalId": "ops",
        "title": "Service status", "url": "https://example.com/status",
        "description": "", "icon": "lucide:link", "tags": ["operations"],
        "isFavorite": false, "sortOrder": 0, "endpoints": []
      }
    ]
  }
}
```

Each request replaces that source's snapshot atomically. It never imports records into the local bookmark/category tables. The output ID is `source:<source-id>:<external-id>`; output records also retain `sourceId` and `externalId`. A link's output `updatedAt` is the accepted snapshot time, not an assertion about its upstream modification time.

### Replay and concurrent writers

- `requestId` is scoped to the source and bound to the canonical decoded request payload. An identical retry within the retained receipt window returns the original receipt, even after later snapshots have been accepted. Reusing that ID with a changed payload returns `409`.
- After strict JSON decoding, identifier validation, and the size check, the receipt lookup happens before new-request schema/revision/sequence validation. A reused ID with a changed schema is therefore still a `409`; malformed JSON or unknown fields remain `400`.
- At least one guard is required: `expectedRevision`, or a positive `sourceSequence`. If both are provided, both must pass.
- `expectedRevision` is a canonical nonnegative decimal string. Concurrent requests expecting the same revision cannot both succeed. A conflict returns `409 snapshot_version_conflict` and `currentRevision`.
- A supplied `sourceSequence` must be greater than the last accepted source sequence. An expected-revision-only write preserves that watermark. It does not reset replay protection.
- Receipts are retained for seven days and capped at 256 per source. Their receipt, snapshot, success timestamp and receipt cleanup commit in one transaction. Cleanup runs on accepted writes; old receipts in an idle source are not replayable after seven days but may remain physically stored until the next successful write or source deletion. Once a receipt is evicted, exact replay is no longer guaranteed; a stale expected revision or source sequence still conflicts.

A successful `200` response is `{sourceId,datasetId,requestId,revision,sourceSequence,receivedAt}`. Receipt `sourceSequence` is `null` if that request omitted the field, even if the source retains an earlier watermark.

### Validation limits

Navigation push JSON is limited to 8 MiB. New calendar/weather/metrics/status data additionally have a 1 MiB bound and per-schema limits in [COMPONENTS.md](COMPONENTS.md). For navigation, both `categories` and `links` arrays are required; empty arrays are valid, `null` is not. The limit is 5,000 categories and 10,000 links. External IDs and request IDs must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.

Category and link IDs must be unique within their respective collections. Parent/category references must resolve within the same payload. Category hierarchies must be acyclic and at most 32 levels deep. Names, icons, URLs, tags, descriptions, endpoint URLs, and ordering reuse the local navigation validation rules. External endpoint records keep only `label` and `url`; automatic browser route/probe configuration belongs to explicit local-navigation writes and cannot be added by a remote snapshot. Only HTTP/HTTPS URLs and installed icon IDs are accepted; data is rendered as text, not executable HTML.

`sourceUpdatedAt` may be `null`; unknown source timestamps remain unknown. Values more than five minutes into the future are rejected. Snapshot `meta` reports `receivedAt`, `lastSuccessAt`, nullable `sourceUpdatedAt`, optional safe `lastError:{code,message,at}`, optional adapter `attribution:{name,url,license,licenseUrl}`, and `freshness` (`fresh`, `stale`, or `disabled`). A required synchronization failure or an elapsed stale threshold marks retained data as stale. Official Open-Meteo sources attach their attribution; generic pushed weather does not inherit it.

## Bind a snapshot to the homepage

Page Schema 2 refers to source datasets by ID:

```json
{
  "bindings": {
    "projects": {
      "datasetId": "source:<source-id>",
      "space": "current-page-space",
      "query": {}
    }
  }
}
```

This is a fragment of the full page configuration, not a complete page-save request. Bind a navigation panel's `collection` input to `projects`. A GitHub Traffic panel uses the `traffic` input and consumes `github.traffic@1`. Calendar uses the `events` input, weather uses `weather`, metrics uses `metrics`, and status uses `status`. The server rejects cross-space bindings, schema mismatches, and query fields on all non-navigation datasets.

`GET /api/v1/dashboard?spaceId=...` returns datasets under the page's **binding aliases**, such as `datasets.projects`, not under their dataset IDs. External aliases without a successful snapshot are absent. The renderer should show the corresponding missing-data state. A layout or theme change does not copy, delete, or reassign navigation records.

### Local document activity binding — Unreleased

Use `datasetId:"local-document-activity"`, `space:"current-page-space"`, `query:{}`, renderer `builtin/document-activity` and input `activity`. The page remains Schema 2. Per-instance activity filters belong in view settings; selected dates and open details are runtime state, not shared configuration. The same binding can serve multiple independently configured instances. Its dashboard envelope contains no activity counts, directory metadata or document titles.

No external source or credential is required for the browser component. Use `GET /api/v1/spaces/{spaceId}/document-activity` or MCP `documents_activity_list` to read authorized activity. Anonymous open-edit page saves retain their existing behavior, while activity reads always require a signed-in working-document reader. See [the activity guide](DOCUMENT_ACTIVITY.md), [API details](API.md) and [component templates](COMPONENTS.md#import-a-component-from-a-web-page). This feature is not in the published 0.0.5 image.

## GitHub Traffic

Create a source with `kind: "github-traffic"`, schema `github.traffic@1`, and connection `{ "owner": "octocat", "repo": "Hello-World" }`. Its sync object is `{ "mode": "poll", "intervalSeconds": 21600, "staleAfterSeconds": 43200 }`. Add a write-only `secret: { "token": "<github-token>" }` and `enabled: true` to activate it. A disabled draft may omit its credential; enabling it without one is rejected.

The worker sleeps until the next scheduled source or a committed source-change signal; it has no periodic timer when the polling schedule is empty. GitHub defaults to a six-hour interval. Polling intervals accept 300–604,800 seconds. The stale threshold defaults to twice the interval. `POST /api/v1/sources/{id}/sync` accepts `{}` and responds `202 { "queued": true, "source": {...} }`; this confirms queuing, not a completed upstream request. Subsequent GETs report the actual result.

GitHub's traffic APIs require repository access as described in its [official traffic documentation](https://docs.github.com/en/rest/metrics/traffic), including repository write access and the fine-grained token's **Administration: read** repository permission. The adapter uses API version `2026-03-10` and these four endpoints:

| Endpoint under `/repos/{owner}/{repo}/traffic/` | Role |
| --- | --- |
| `views?per=day` | Required rolling view totals and daily observations |
| `clones?per=day` | Required rolling clone totals and daily observations |
| `popular/paths` | Optional popular-path detail |
| `popular/referrers` | Optional referrer detail |

Production requests use fixed `https://api.github.com` URLs, no inherited environment proxy (or the explicit Owner-configured [outbound proxy](NETWORK.md)), no redirects, finite timeouts, and bounded response bodies. Connection configuration cannot supply an arbitrary upstream host. The homepage never receives the GitHub token.

### Baseline and time semantics

`github.traffic@1` data contains:

| Field | Meaning |
| --- | --- |
| `repository` | `owner`, `name`, and GitHub `url` |
| `baseline` | First successful required-metric window, retained immutably |
| `current` | Latest successful required-metric window |
| `daily` | Retained UTC daily observations, including explicit gaps |
| `popularPaths`, `referrers` | Latest successful optional details |
| `auxiliaryStatus.paths`, `.referrers` | Independent `state`, nullable `lastSuccessAt`, optional error `code` |

Both window objects contain `capturedAt`, nullable `windowStart`/`windowEnd`, `windowBasis: "github-last-14-days"`, and `views`/`clones` metrics `{count,uniques}`. GitHub describes a rolling last-14-days aggregate but does not provide exact aggregate boundary fields in these responses. Home preserves `null` for those bounds. A displayed date range derived from daily chart points describes the chart's observations, not the aggregate window's exact boundaries.

Baseline/current differences compare two rolling windows. They are not lifetime growth, lifetime views, or a way to recover activity before GitHub's available history. Aggregate `uniques` comes directly from GitHub; daily unique counts must never be added together to manufacture the rolling unique total.

Each daily item has `date`, nullable `views` and `clones`, `isPartial`, nullable `observedAt`, `viewsObservedAt`, and `clonesObservedAt`. Missing observations are `null`, not zero. Missing or null metric fields in upstream daily, popular-path, or referrer records are treated as invalid responses; they are never silently converted to zero. Upserts retain historical days beyond the upstream window and preserve a previous metric when that metric is absent from a later response. An observation captured during its UTC day remains partial until that metric is observed after the day has ended; simply advancing the calendar does not make old incomplete data final.

If either required endpoint fails, Home preserves the entire prior successful snapshot and baseline. Failure of an optional endpoint preserves its previous successful details and reports `stale`; before any optional success it reports `unavailable`. Error responses contain a safe code and message, not upstream bodies or secrets.

Changing the repository after the first snapshot is rejected. Create a new source so a baseline cannot silently change repository identity. Rotating a credential uses the source PUT request with a new `secret.token` and matching `expectedConfigRevision`; omit `secret` to retain the existing one. A blank credential is rejected.

### Credential storage and recovery

GitHub tokens and new write-only subscription/API credentials are encrypted with AES-GCM. A private 32-byte `integrations.key` in `LINGSHU_DATA_DIR` is bound to source identity during encryption. Back up this key together with the database, **including when PostgreSQL is external**. Database backup alone cannot recover source credentials.

Startup refuses a missing key if encrypted source credentials already exist. Runtime encryption/decryption never regenerates a missing key. The current key-file protection uses regular-file and POSIX permission checks (`0600`); native Windows credential-file ACL behavior still needs platform-specific validation. No Windows desktop/runtime verification is implied by browser support.

## MCP transport

The endpoint is `/mcp`, implemented with the official [MCP Go SDK v1.8.0](https://github.com/modelcontextprotocol/go-sdk/releases/tag/v1.8.0). It uses Streamable HTTP with JSON responses and supports [protocol `2026-07-28`](https://modelcontextprotocol.io/specification/2026-07-28) and legacy `2025-11-25`. It is stateless: no `Mcp-Session-Id` is issued; authenticated GET and DELETE transport requests are not supported (`405`). Cross-origin and localhost DNS-rebinding protections remain enabled.

Every transport request, including discovery and tool listing, requires a Home bearer token. Browser cookies do not authenticate MCP. Responses enforce `Cache-Control: no-store`; cacheable protocol metadata uses `ttlMs: 0` and `cacheScope: "private"`. This implementation supplies personal access tokens, not an OAuth authorization server; configure a client that can send an Authorization header.

A 2026 tool call sends `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `Mcp-Protocol-Version: 2026-07-28`, `Mcp-Method: tools/call`, and `Mcp-Name: bookmarks_list`, with:

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "bookmarks_list",
    "arguments": { "spaceId": "<space-id>" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { "name": "my-client", "version": "1" }
    }
  }
}
```

Use `server/discover` for 2026 discovery. Legacy clients use the SDK's `initialize` negotiation with `2025-11-25`. HTTP list endpoints return arrays; MCP list tools return `structuredContent: { "items": [...] }`, preserving object output compatibility. Application failures return MCP `isError: true` with `code`, `message`, `httpStatus`, and optional `currentRevision`. Transport authentication failures remain HTTP `401`.

| Tools | Arguments |
| --- | --- |
| `bookmarks_list`, `categories_list` | `spaceId` |
| `bookmarks_get`, `categories_get` | `spaceId`, `id` |
| `bookmarks_create`, `categories_create` | `spaceId`, `input` containing the normal CRUD body |
| `bookmarks_update`, `categories_update` | `spaceId`, `id`, `input` |
| `bookmarks_delete`, `categories_delete` | `spaceId`, `id` |
| `dashboard_get`, `page_get` | `spaceId` |
| `page_update` | `spaceId`, `input` with `name`, `config`, `expectedRevision` |
| `sources_list`, `sources_create` | `spaceId`, plus `input` for creation |
| `sources_get`, `sources_snapshot_get` | `id` |
| `sources_update`, `sources_snapshot_push`, `sources_sync` | `id`, `input`; sync input is `{}` |

MCP calls invoke the same business handlers and validation as HTTP, in database transactions after acquiring the common write gate. There is no loopback HTTP proxy or unrestricted administrative tool.

New credential creation/expiry timestamps and push receipt `receivedAt` values use UTC microsecond precision, matching both SQLite and PostgreSQL reads. Previously stored immutable request receipts keep their original values.

## Verification

The recovered development implementation was exercised on 2026-10-18 with real HTTP, SDK MCP discovery/calls in both protocol versions, token scope/expiry/revocation, account changes, source isolation, concurrent guarded pushes, page bindings, and deterministic GitHub worker fixtures. The PostgreSQL-enabled complete Go suite also passed on nx11. The integration regressions include exact PAT creation/readback timestamp equality, receipt/snapshot timestamp equality, unchanged replay receipts, and rejection of missing upstream metrics. Real GitHub account access was not used; a real repository baseline still requires a configured credential.

The separate complete navigation HTTP acceptance passed for both SQLite and PostgreSQL, including actual process restarts. Its **36 groups and 4,450 assertions** are separate from the Go integration tests and do not count MCP tools as HTTP navigation assertions. See [the current test record and commands](../tests/README.md) for provider-specific results and the distinct browser, Docker and release-validation boundaries. Run tests against the exact source being reviewed; earlier recovery checkpoints do not substitute for current validation.

From `server/`:

```sh
go test ./internal/home -run '^TestIntegration' -count=1 -v
go test -race ./internal/home -run '^TestIntegration' -count=1
```

PostgreSQL coverage requires `LINGSHU_TEST_INTEGRATIONS_POSTGRES_URL` pointing to a dedicated fresh test database. It must differ from the core test database. An initialized database is refused and is never cleared by the tests. Without this environment variable, the PostgreSQL subtest reports an explicit skip.

The separate process-level check is:

```sh
python3 tests/integrations_smoke.py \
  --base-url http://127.0.0.1:5189 \
  --allow-destructive
```

Use a fresh disposable service with a separate data directory/database. The script rejects non-loopback hosts, redirects, and initialized instances; disables environment proxies; and retains synthetic state for inspection. Never point it at a populated user instance. This script creates a disabled credential-free Traffic source, so it does not contact GitHub. Go worker tests use fixture transports. Real repository access and its first baseline remain dependent on the user configuring a valid credential.
