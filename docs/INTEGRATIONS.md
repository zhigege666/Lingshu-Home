# Integrations, external snapshots, MCP, and GitHub Traffic

This document describes the integration contracts in the current source; the product version is recorded in [VERSION](../VERSION). The first successful authorized GitHub synchronization establishes that source's traffic baseline.

## Supported sources

| Source kind | Update method | Dataset schema | Current behavior |
| --- | --- | --- | --- |
| `local-navigation` | Home's navigation APIs | `navigation.collection@1` | Built-in, authoritative categories and bookmarks |
| `local-document-activity` | Authorized local activity query | `documents.activity@1` | Since 0.0.6: empty dashboard marker; working-document data comes from the dedicated read-only API |
| `external-push` | External HTTP or MCP write | Navigation or four component schemas | Validated, versioned snapshots stored independently of local navigation |
| `external-json` | Scheduled HTTP GET/manual queue | Calendar, weather, metrics or status | Normalized JSON data object; no arbitrary code mapping |
| `calendar-ics` | Scheduled HTTP/HTTPS subscription | `calendar.events@1` | Read-only bounded ICS agenda |
| `weather-open-meteo` | Fixed provider HTTP API | `weather.forecast@1` | Current observations and daily forecast |
| `github-traffic` | Scheduled polling and manual queue | `github.traffic@1` | GitHub repository traffic, immutable first baseline, retained daily observations |

The public `deliveryModes` capability is `push` and `poll`. Built-in local navigation and document activity are not external delivery modes. Realtime request adapters, arbitrary JSON field mapping, and `knowledge.items@1` are future work. The bounded HTTP GET adapter, calendar/weather configuration, four component schemas and template import are documented in [COMPONENTS.md](COMPONENTS.md). Unsupported source kinds and schemas are rejected.

The homepage reads stored snapshots. Opening or refreshing the homepage does not trigger an upstream source request. One failing integration does not replace the local navigation tables.

## Authentication and permissions

Browser administration uses the existing account cookie and CSRF protection. External clients use `Authorization: Bearer <home-pat>`. A present but malformed, invalid, expired, or revoked Authorization header never falls back to browser cookies.

Personal access tokens are the intersection of an active account, one space, the chosen permission mode, and an optional source restriction. They do not grant global Owner privileges. An Owner cannot inspect another account's personal space. Members can use integration credentials only while enabled and allowed to sign in under the current access mode. Anonymous MCP is unavailable in all four modes, including `open_edit`.

| Action | Permitted integration operations |
| --- | --- |
| `navigation:read` | Read local categories, bookmarks, their navigation revision and aggregate link click statistics |
| `navigation:write` | Maintain local categories and bookmarks, including atomic creates, field patches, stable-ID moves and bookmark deletions |
| `sources:read` | Read source configuration and snapshots; resolve external page bindings |
| `sources:write` | Create or edit source configuration; rotate a source credential; queue polling |
| `datasets:write` | Push an external snapshot |
| `pages:read` | Read saved page configuration |
| `pages:write` | Save a page using its expected revision |
| `documents:read` | Read authorized documents; directory discovery and activity queries additionally require working-document access |
| `documents:write` | Maintain authorized documents using the separate document contracts; writes also require `documents:read` |
| `work:read` | Read internal work projects, item summaries/details, board columns and the status catalog in an editable space |
| `work:write` | Create, edit, move, archive and restore internal work items/projects; maintain the space's status catalog |

Dashboard access requires `navigation:read` and `pages:read`. External dashboard inputs additionally require `sources:read`; without that action, they are omitted. Page writes also require read permission for every dataset binding: `navigation:read` for local navigation, `sources:read` for an external source, and `documents:read` for a local activity binding. Reading a dashboard with an activity binding does not require activity access because that projection contains only an empty schema marker; the dedicated activity query enforces working-document permission separately. When creating a token for one external push source, the UI starts with read access only. Select snapshot push explicitly; a push-only producer need not have read access. Previously issued tokens keep their scopes. A source-scoped token allows only `sources:read` and/or `datasets:write`, and only for that source. It cannot create another source, manage accounts, change publication, or mint tokens.

### Create and revoke a Home token

The browser's **MCP and access tokens** tab supports creation, editing, revocation and removal of revoked records. Permission choices come from the server's action catalog. These endpoints require the current account's signed-in browser Cookie; writes also require CSRF. Bearer-token management requests are rejected, and another account's token ID returns `404`.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/v1/integrations/token-actions` | `{items:[{id,label,requires,sourceScoped,write}],defaultActions}`; labels follow the instance language |
| GET | `/api/v1/integrations/tokens` | This account's token metadata, without credentials |
| POST | `/api/v1/integrations/tokens` | New metadata and a token displayed once |
| PATCH | `/api/v1/integrations/tokens/{id}` | Revision-checked name, permission-mode/actions and expiry changes; returns the updated credential directly |
| DELETE | `/api/v1/integrations/tokens/{id}` | Revoke one of this account's tokens |
| DELETE | `/api/v1/integrations/tokens/{id}/record` | `{expectedRevision}`; delete an already revoked record |

Creation body:

```json
{
  "name": "Navigation publisher",
  "spaceId": "<space-id>",
  "sourceId": "<source-id>",
  "permissionMode": "selected",
  "actions": ["sources:read", "datasets:write"],
  "expiresAt": "<RFC3339 time>"
}
```

Omit `sourceId` or set it to `null` for a space-scoped token. Creation must explicitly supply `expiresAt`: a timestamp more than one minute and at most 365 days in the future, or `null` for permanent validity. **Never expires** is an explicit choice in the creation/edit form. Each account can have at most 64 non-revoked token entries. Revoke old entries, including expired ones, to free a slot.

The `201` response contains `{ "token": "lhp_...", "credential": {...} }`. Credential metadata includes `id`, string `revision`, `name`, `spaceId`, nullable `sourceId`, `permissionMode`, `actions`, `createdAt`, nullable `expiresAt`, nullable `revokedAt`, and `status`. List status is `active`, `expired`, `revoked`, or `invalidated`. Only the creation response displays the raw secret; later list/edit responses do not display it again or rotate it.

`permissionMode:"selected"` is the default. It requires a nonempty `actions` list with every `requires` dependency, such as `documents:read` for `documents:write`. `defaultActions` in the catalog is `navigation:read` plus `pages:read`. Explicitly selecting `permissionMode:"all"` grants the currently supported and future business actions within the token's existing space/source and the account's current permissions. Its `actions` metadata is the currently expanded effective set. Source-scoped all-permission tokens remain limited to source reads and, where the account can write, snapshot writes. All mode does not grant global administration, account/token management, or access to another space. Send `actions` as omitted or `[]` in all mode; a nonempty selected list is rejected. Existing tokens stay in selected mode unless the owner explicitly changes them.

Edit with `{expectedRevision,name?,permissionMode?,actions?,expiresAt?}`. Omitted fields preserve the existing value; omitted `expiresAt` preserves the exact original expiry, including `null`. Switching from all to selected permissions requires an explicit action list. A successful PATCH returns the updated credential with the same ID and secret, a newer revision, and immediate permission changes on later requests. Space/source bindings are fixed. Expired tokens require an explicit new expiry or `null`; revoked or invalidated tokens cannot be reactivated by editing.

On `409 integration_token_version_conflict`, keep the draft and read the current token list; compare the current record before submitting reviewed changes with its revision. An uncertain PATCH response also requires readback: matching intended fields confirm the save without another write. The browser offers **Read latest version**, **Use latest version** and **Keep my draft changes**. Reading alone does not replace the draft. Other lifecycle errors are `400 integration_token_expiry_required`, `409 integration_token_not_editable` and `409 integration_token_not_revoked`.

Revocation returns `200 {"success":true}` and retains a revoked list entry. Only revoked entries offer **Delete record**, whose revision-checked endpoint also returns `200 {"success":true}`. Deletion removes the management record; the old secret remains rejected. Both operations apply to finite and permanent tokens.

Home stores only the token's SHA-256 digest. Later GETs do not return the secret or its digest. Instance access-mode changes invalidate all existing tokens. Disabling a user or resetting their password invalidates that user's existing tokens. Permanent validity and all permissions do not bypass these checks. Revocation takes effect at authentication, including queued MCP operations after they acquire the write gate.

SQLite and PostgreSQL migration `015_integration_token_management.sql` adds revisions, `never_expires` and `permission_mode`. Existing rows keep finite validity and selected permissions; the migration does not expand their grants. Back up the database and matching data/key material before upgrading. To downgrade, restore the matching pre-upgrade backup and application version rather than deleting migration records or token columns manually.

Browser login retention does not renew or extend a personal access token. Session-policy, profile/password and browser-session endpoints accept browser authentication only; a PAT cannot use them. Revoking browser sessions leaves separately issued PATs intact, while a password/security-version change invalidates the account's existing PATs. The authorized HTTP `POST /api/v1/spaces/{spaceId}/navigation/batch-edit` endpoint and MCP `navigation_batch_edit` can apply up to 500 category/link creates, patches, moves and bookmark deletions combined with `navigation:write`, a matching space and `expectedRevision`; use the [atomic editing contract](API.md#atomic-category-and-link-editing), including readback after an uncertain response.

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

### Local document activity binding

Use `datasetId:"local-document-activity"`, `space:"current-page-space"`, `query:{}`, renderer `builtin/document-activity` and input `activity`. The page remains Schema 2. Per-instance activity filters belong in view settings; selected dates and open details are runtime state, not shared configuration. The same binding can serve multiple independently configured instances. Its dashboard envelope contains no activity counts, directory metadata or document titles.

No external source or credential is required for the browser component. Use `GET /api/v1/spaces/{spaceId}/document-activity` or MCP `documents_activity_list` to read authorized activity. Anonymous open-edit page saves retain their existing behavior, while activity reads always require a signed-in working-document reader. See [the activity guide](DOCUMENT_ACTIVITY.md), [API details](API.md) and [component templates](COMPONENTS.md#import-a-component-from-a-web-page). This binding and query are available since 0.0.6 and use migration 009.

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

Since 0.0.9, omit `spaceId` on space-scoped MCP calls. Home uses the single space of the bearer token authenticated for that request. Start a new session with a business call such as `documents_list` with `{}`. To display the connection’s space, call `space_current` with `{}` for `{spaceId, name, kind}`. An explicit ID still goes through the existing access checks. A source-specific token keeps its source and action limits. Read-only tools with all-optional filters (`documents_list`, `documents_activity_list`, `navigation_click_stats`) also accept an omitted `input`. Explicit `null`, required resource IDs and mutation inputs retain their validation; this does not make write bodies optional.

A 2026 tool call sends `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `Mcp-Protocol-Version: 2026-07-28`, `Mcp-Method: tools/call`, and `Mcp-Name: bookmarks_list`, with:

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "bookmarks_list",
    "arguments": {},
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { "name": "my-client", "version": "1" }
    }
  }
}
```

Use `server/discover` for 2026 discovery. Legacy clients use the SDK's `initialize` negotiation with `2025-11-25`. HTTP list shapes follow each endpoint's contract. MCP wraps array results in `structuredContent: { "items": [...] }` and retains structured paginated objects, including work-board columns, status metadata and item cursors. Application failures return MCP `isError: true` with `code`, `message`, `httpStatus`, and the applicable `currentRevision`, `entity`, `id`, `field` and authorized `details`. The wrapper forwards the handler's error without fetching more context; write-only status errors do not expose catalog contents or usage counts. Transport authentication failures remain HTTP `401`.

The current application catalog contains **55 tools, including 21 work tools**. An authenticated Home `tools/list` includes registered tools regardless of the PAT's work actions. A missing `work:read` or `work:write` action is rejected when calling the tool, not by hiding it from this list. A gateway may have its own discovery/exposure configuration; its catalog is not proof of the tools served by the connected Home instance.

| Tools | Arguments (`spaceId` is optional wherever listed) |
| --- | --- |
| `space_current` | No arguments |
| `work_board_get`, `work_items_list` | Optional `spaceId` and `input` filters; item lists also accept status and cursor |
| `work_items_get` | Optional `spaceId`, required `id`; optional `input:{activityLimit?,activityCursor?}` requests bounded history |
| `work_items_create`, `work_projects_create` | Optional `spaceId`, required `input` with a stable ID and creation fields |
| `work_items_update`, `work_projects_update` | Optional `spaceId`, required `id,input` with the entity's `expectedRevision` |
| `work_items_move` | Optional `spaceId`, required `id,input` with both expected revisions, status and `beforeId` |
| `work_projects_list` | Optional `spaceId`; includes archived projects |
| `work_resources_search` | Optional `spaceId`, required `input.kind`; optional resource search and cursor filters |
| `work_statuses_get` | Optional `spaceId`; returns the shared space status catalog and its revision |
| `work_statuses_batch_edit` | Optional `spaceId`, required `input.expectedRevision` and typed create/patch/order/delete arrays and/or a default status |
| `work_collaboration_get` | Optional `spaceId`; effective collaboration configuration, contract version and lease limits |
| `work_sessions_open` | Optional `spaceId`; `input` with stable `registrationId`, `agentName` and optional client/role/parent/resume attribution |
| `work_sessions_get`, `work_sessions_close` | Optional `spaceId`, required session `id`; close also takes `input.operationId` |
| `work_claims_acquire` | Optional `spaceId`, item `id`, `input` with session, operation ID, expected item revision/generation and optional verified recovery |
| `work_claims_renew`, `work_claims_release` | Optional `spaceId`, item `id`, `input` with current session/claim/generation/operation ID; release requires structured handoff |
| `work_events_list`, `work_events_append` | Optional `spaceId`, item `id`; list `input` accepts limit/cursor/after; append requires session, operation ID, kind and body |
| `document_sources_list` | Optional `spaceId`. Returns enabled working-document directories, including empty ones, with IDs, names, configured read-only mode, caller write availability, defaults and last observed status; no absolute paths. Requires `documents:read` and working-document access. |
| `documents_list`, `documents_activity_list` | Optional `spaceId` and `input` filters. Omit both to use the defaults. |
| `navigation_get` | `spaceId`; complete local navigation dataset and revision |
| `navigation_batch_edit` | Optional `spaceId`; `input` with `expectedRevision` and optional creation records, category/link patches, stable-ID moves or `deleteLinkIds` |
| `navigation_click_stats` | Optional `spaceId` and optional `input` containing date, category, link, sort and pagination filters; `{}` uses defaults |
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

After upgrading Home, refresh the connection in Gate or another MCP gateway in this order:

1. Confirm the running Home version and endpoint, then read its authenticated `tools/list`. The current contract includes twelve item/project/resource/status tools plus nine collaboration tools; an older Home process will not gain these tools by refreshing a gateway alone.
2. Refresh discovery and publish the updated tool metadata for that same gateway connection, preserving its intended tool exposure and caller grants. Upgrading Home alone does not confirm that Gate has synchronized. Compare descriptions and parameter schemas as well as tool names before changing credentials or assuming the implementation is missing.
3. Load the needed tools' current schemas and make a business read, such as `work_board_get {}` with `work:read`, or `documents_list {}` with document read access. Read `space_current {}` when space identity, workflow configuration or effective capabilities are unknown or have changed; reuse context that remains valid.

This connection refresh applies to an application upgrade that adds or changes tools. Editing the status catalog is ordinary space data maintenance and does not require another MCP discovery or publication cycle.

If Home lists a tool but the caller cannot find it, inspect discovery, publication and caller grants in the gateway. If Home itself omits it, inspect the running version and endpoint. A catalog count alone does not verify version, permissions or a successful business call.

MCP calls invoke the same business handlers and validation as HTTP, in database transactions after acquiring the common write gate. There is no loopback HTTP proxy or unrestricted administrative tool.

New credential creation/expiry timestamps and push receipt `receivedAt` values use UTC microsecond precision, matching both SQLite and PostgreSQL reads. Previously stored immutable request receipts keep their original values.

Since 0.0.9, a PAT with only `navigation:write` can still edit and receives operational receipts rather than stored readable fields. Creating or updating a bookmark returns `id` and `updatedAt`, category writes return the ID, and batch edits return `updatedCount` and `revision`. Since 0.0.11, a successful deletion batch also echoes the confirmed submitted IDs as `deletedLinkIds`. To display stored fields, the client also needs `navigation:read`. For data sources, PATs with `sources:write` alone receive only `id` and `configRevision` on creation and update. Queuing a sync returns `queued:true` with that same receipt under `source`. The complete stored source requires `sources:read` and still excludes credential secrets.

### Optional workflow guidance and module state

Since 0.2.1, Home provides a server-owned guide through the existing `space_current` tool. Enable it at startup:

```bash
LINGSHU_MCP_WORKFLOW_ENABLED=true ./lingshu-home
# Equivalent CLI option:
./lingshu-home --mcp-workflow-enabled
```

The default is `false`; `--mcp-workflow-enabled=false` explicitly disables it. The supplied Compose file forwards the same variable, defaulting to false. Restart a binary process with the new environment to apply it. For Compose, recreate the container with `LINGSHU_MCP_WORKFLOW_ENABLED=true docker compose up -d --force-recreate home`, retaining its data volume; `docker compose restart` alone does not load changed host or `.env` values. It controls guidance for ongoing work registration, stage updates, evidence and handoff; explicit user-requested CRUD remains available when guidance is off. Permissions, revisions, stable-ID replay and recovery contracts always apply. No extra Skills, tool addition or new token scope is required.

`space_current {}` returns additive context:

| Field | Meaning |
| --- | --- |
| `spaceId,name,kind` | Existing token-bound space fields |
| `contextVersion,serverVersion` | Context schema and product versions, separate from MCP protocol version |
| `modules:{documents,work}` | Instance-wide Site settings switches, both default on |
| `capabilities:{work,documents,navigation}` | Effective `read/write` booleans for this authenticated context; individual resources still need call-time checks |
| `workflow:{enabled,version,guide}` | Effective startup switch and permission-aware guidance |
| `entrypoints` | Available context/business tool names, without dumping projects, tasks or document bodies |

The guide covers existing-work reuse, goal/scope/acceptance criteria, stable IDs and original creation inputs, actual results versus next actions, status semantics, attention, evidence/documents, uncertain writes, conflicts, offline handoff and completion without automatic archiving. Read-only and write-only contexts receive their actual boundaries. Document-creation uncertainty is checked by the original source/path before retrying. Home records work but does not start or schedule an Agent.

Since 0.2.3, `workflow.version` is `"2"`. Its task boundaries are also near the start of the list/create/update tool descriptions:

- Reuse the existing project and task for the same unfinished round of work. Minor additions within that round do not each need a new task.
- After a task is completed or canceled, a new version or new acceptance scope requires a new task. Include the target version in its title when known and reference the predecessor's real task ID in its description; do not invent a version or parent/child relationship.
- Reopen an ended task only when the user explicitly requests correction or additional verification of the same delivery, and record why. Do not append successive deliveries indefinitely to a completed task. This is Agent guidance, not a blanket server ban on state transitions; explicit CRUD remains available with workflow guidance disabled.

Library/Work switches are independent of workflow guidance. A signed-in Owner changes them in **Site settings → Modules**; subsequent HTTP/MCP calls enforce the state and return `module_disabled` for disabled operations. Files, records, associations, tokens and sessions remain intact. See [module contracts](API.md#optional-library-and-work-modules). Context responses remain private and must not be shared across users or tokens.

**Gate and other gateways:** the guide appears in an ordinary tool result, with matching JSON text and `structuredContent`. It does not depend on forwarding initialization/discovery instructions, resources or prompts. Work-tool description prefixes point to `space_current` within a bounded catalog summary. On-demand search/describe uses the gateway's published metadata: refresh discovery and publish descriptions or schema changes after an upgrade, including the 0.2.3 task boundaries. Verify the published descriptions and optional history parameters against the running Home contract; a Home upgrade alone does not establish that Gate is synchronized. Later module changes or workflow-flag changes do not alter schemas or require a new token. Gateway exposure/authorization remains independent of Home permissions.

Read context for a new task without valid context, changed authorization or a reconnected session; reuse valid context during ordinary work. A server cannot force all clients to adopt a guide or retract text already in an Agent context. This project instruction selects the behavior without duplicating the workflow:

> 本项目使用 Home 维护工作上下文。执行或续接任务时，按需读取 Home 当前工作流配置，在已授权范围内遵循其规则；工作流关闭时，仅按我的明确要求操作记录。Home 不可用时保留待同步内容，并继续其他已授权工作。

Keep repository/environment, UI, authorization and delivery rules in project instructions. Projects currently have no repository binding, and same-ID replay does not provide semantic deduplication when agents create different IDs. Readable business numbering and native subtasks are not implemented by this change.

### Work items and projects

Work tools operate on the current PAT's bound space and use the same handlers as the HTTP `/api/v1/spaces/{spaceId}/work` routes. Migration 012 introduced work items; migration 014 adds configurable space-wide statuses. See [WORK_ITEMS.md](WORK_ITEMS.md) for the complete JSON contract, error codes and upgrade recovery.

- Start with `work_board_get {}` or `work_items_list {}` to read work and its current `statuses,statusRevision,defaultStatus`. Use `work_projects_list {}` when project discovery is needed, or `work_statuses_get {}` for only the catalog. Reuse known metadata; there is no mandatory preliminary call before every action. Read-only tools with optional filters accept an omitted `input`; `work_resources_search` requires `input.kind`.
- `work:read` and `work:write` are independent. The token account must have current edit access to the space even for a read, and a source-specific token cannot access work. Old tokens retain their previous actions.
- Each space has 1–64 active statuses shared by its projects. An item `status` is the stable definition `id`, never its display name. Initial IDs remain `todo/doing/waiting/done`; new IDs are 32 lowercase hexadecimal characters. Meaning comes from `type:todo|doing|waiting|done|canceled`. Canceled work is ended but not successfully completed; built-in types retain their original meaning. `needsAttention` and `archived` are independent.
- `work_statuses_get` returns `{revision,defaultStatus,canEdit,items}`; definitions contain `id,name,type,color,description,position,isDefault,total,archivedTotal`. Board/list/detail definitions omit usage counts; each board column's `total` applies to its current filters. Use catalog counts for status migration decisions.
- `work_statuses_batch_edit` accepts the catalog `expectedRevision`, optional typed `create/patches/order/deletions` arrays (at most 64 entries each) and `defaultStatus`. A supplied order includes all surviving IDs. Removing an occupied status requires `moveToStatus` and migrates active and archived items atomically without changing their archive flags. Removing the default requires a surviving `defaultStatus`. Removed IDs are retired and cannot be reused. Renaming preserves identity; the item `status` parameter is not a fixed MCP enum.
- Resource search and new reference IDs need the matching `navigation:read` or `documents:read` action. References, resource titles/paths and counts are filtered by those independent actions; work access does not grant document body access.
- Item/project creates use caller-generated stable IDs. The same normalized original payload and ID do not insert another record; a different payload conflicts. After a timeout, retain the same ID and payload. Item replay is checked before resolving a mutable default or rejecting a retired original status; old records retain their historical hash interpretation. Readback returns the current record, including later edits. A status batch instead requires comparison against the current catalog before retrying.
- Updates require the item's or project's own `expectedRevision`. Moves additionally require `expectedBoardRevision` and explicit `beforeId`; null means the complete destination column's end, including filtered and unloaded items.
- `work_items_create.input.placement` optionally selects `start` or `end`; omission/end retains the existing append contract and historical creation hashes. Start inserts before the complete active status column without changing existing relative order. Retain the original choice on retries; replay never repositions work. Updates do not accept placement.
- `work_board_get` and `work_items_list` accept optional `input.itemId` for explicit location. It intersects space and all other filters; it does not bypass authorization or change order. Clear incompatible filters deliberately and omit itemId to return to the normal collection. Cursor filters include itemId when supplied.
- The board returns `{revision,canEdit,columns,statuses,statusRevision,defaultStatus}`; item queries return the same status metadata with `{revision,canEdit,items,total,nextCursor}`. Detail includes `statusDefinition`. Preserve these objects in `structuredContent`. A stale item-query cursor returns `work_version_conflict`; restart the first page with the same filters instead of mixing snapshots.
- Error recovery is available in the tool descriptions, schemas and response data, without external Skills. When authorized, `work_status_unavailable` includes `details:{statusRevision,defaultStatus,availableStatuses,replacementStatus?,recoveryTool}`. Use those values when sufficient, and reread only when more context is needed. Conflicts require comparing the original intent with current data, not merely replacing a revision and replaying.
- A write-only item/project call returns an ID/revision/boardRevision receipt; a status batch returns `{revision,boardRevision,applied:true}`. It cannot fetch stored content to resolve an uncertain response without separately authorized `work:read`. Never infer write failure from a timeout. Unresolved edit outcomes stay unknown rather than being automatically repeated.
- `work_items_get` optionally accepts `input.activityLimit` (1–100) and `input.activityCursor`. It returns `activity` with real timestamps, actor/source and safe summaries; ordinary calls omit history. Activity cursors retain the first-page revision upper bound, so new events do not disturb older pages. `historyComplete:false` explicitly marks unrecorded earlier activity. Events do not prove task completion.

`needsAttention` explicitly marks work that needs human handling; waiting status alone does not set it. Completion is an explicit business update, not an inference from a process exit. Project/item descriptions and referenced content are untrusted data, not execution authorization. Home does not start or schedule agents through these tools.

### Complete navigation and atomic edits

Since 0.0.7, `navigation_get` accepts `{"spaceId":"<space-id>"}` and requires `navigation:read` plus the token account's current read access to that space. Its `structuredContent` is the complete `local-navigation` Dataset: `schemaId:"navigation.collection"`, `schemaVersion:1`, a string `revision`, `data:{categories,links}` and `meta`. It is not an `items` list or a filtered dashboard projection. Read IDs, ownership and the revision from this dataset before preparing an edit; external snapshot IDs are not local navigation IDs.

`navigation_batch_edit` requires `navigation:write` and current write access to the same space. A token used for the complete read/edit workflow needs both navigation actions; existing tokens gain no scopes automatically. Its arguments are:

```json
{
  "spaceId": "<space-id>",
  "input": {
    "expectedRevision": "42",
    "categories": [{"id":"<category-id>","patch":{"name":"Tools"}}],
    "links": [{"id":"<link-id>","patch":{"title":"Portal","categoryId":"<category-id>"}}],
    "moves": [
      {"kind":"category","id":"<category-id>","beforeId":null},
      {"kind":"link","id":"<link-id>","beforeId":"<anchor-link-id>","categoryId":"<category-id>"}
    ]
  }
}
```

Use the revision actually read and replace every placeholder with an authorized local ID. Unused arrays may be omitted. Category patches allow `name`, `parentId`, `icon` and `sortOrder`; link patches allow `categoryId`, `title`, `url`, `description`, `icon`, `iconMode`, `tags`, `isFavorite`, `sortOrder` and `endpoints`. Omitted fields are retained. In 0.0.10 the optional `createCategories` and `createLinks` arrays also accept new records with stable caller-generated IDs (32 lowercase hexadecimal characters). Insert new parents before their children. Since 0.0.11, optional `deleteLinkIds` selects existing same-space bookmarks for deletion. Deletes, creations, patches and moves commit together; a creation collision never replaces another record. Existing usage-note edits and category deletion retain their dedicated tools.

- Validate and remove selected bookmarks, insert new categories and links, then apply field patches, validate the final category tree, and apply moves in array order, all in the same transaction. Category moves stay among siblings under the patched `parentId`; use a field patch to change that parent and omit `categoryId` from a category move.
- Every move requires explicit `beforeId`: a same-group anchor ID places the row immediately before that anchor, while `null` appends. Link moves also require explicit `categoryId`; `null` targets Uncategorized. Anchors must exist in the target group after the field patches and preceding moves. For several dependent moves into one group, arrange the later anchors first, for example by sending the desired sequence from right to left.
- Submit 1–500 operations across the optional creation, patch, move and deletion arrays. Each deletion ID counts once. A row may have one patch and one move, counting as two operations; repeated patches or repeated moves for the same entity are rejected. Deletion IDs must be unique 32-character lowercase hexadecimal IDs. A deleted bookmark cannot also be created, patched, moved or used as a move anchor. Missing/foreign IDs, self anchors and invalid group references fail the whole batch.
- Moves operate on complete sibling groups, including hidden or paginated rows. Untouched siblings keep their relative order. A changed group's sort values are normalized, so the response may contain more than 500 affected records even though the request has at most 500 operations.

With navigation read access, success returns `structuredContent:{updatedCount,revision,categories,links,deletedLinkIds?}` with every normalized created/changed surviving row. `updatedCount` excludes deletions; remove the optional `deletedLinkIds` from the baseline and merge all returned rows. Write-only callers receive `updatedCount`, `revision` and the confirmed submitted deletion IDs, without readable stored rows. Actual changes, including a delete-only batch, advance the navigation revision once; a normalized no-op leaves the revision and link timestamps unchanged. Page composition has a separate revision and save operation.

Deleting bookmarks removes their existing click statistics and document relations, but never original document files or attachments. After an uncertain response, compare the requested deletions with `navigation_get`: an absent ID needs no repeat deletion; a changed bookmark needs a deliberate decision before a new batch. Saved deletions cannot be undone by changing the application version.

A stale revision yields `navigation_version_conflict`, `httpStatus:409` and `currentRevision` in the MCP application error. Any validation, authorization or commit failure rolls back the transaction, including deletions and earlier moves. After a timeout or uncertain response, call `navigation_get`, compare the complete result with the intended changes and review any remaining edit before resubmitting. Do not substitute a fresh revision and blindly replay the original request. See the [shared HTTP/MCP atomic contract](API.md#atomic-category-and-link-editing) for validation details.

### Read-only link click statistics

`navigation_click_stats` requires `navigation:read` and the token account's current read access to its scoped space. The equivalent browser read requires a signed-in account even when the homepage is public. This tool returns aggregate local bookmark activations; it has no click-reporting operation, and browser reporting rejects bearer credentials.

Call with `{"spaceId":"<space-id>","input":{}}` for the default last 30 UTC days, or set these optional `input` fields:

| Field | Contract |
| --- | --- |
| `from`, `to` | Inclusive `YYYY-MM-DD` UTC dates, spanning 1–366 days. Omitted `to` is today; omitted `from` is 29 days before the selected `to`. |
| `categoryId` | Omit for all categories; `""` selects Uncategorized; a same-space ID selects that exact current category, without descendants. |
| `linkId` | Optional local bookmark ID in the same space; combined with any category filter. |
| `sort` | `clicks` (default, descending count in the range) or `lastClicked` (descending lifetime last-click time), with title/ID ties. |
| `limit`, `offset` | Default 50 and 0; limit 1–200, offset 0–1,000,000. |

The result is a structured object containing `from`, `to`, `timezone:"UTC"`, `recordedFrom`, `summary`, `days`, `categories`, `items`, `total`, `limit`, `offset` and `hasMore`. Items include zero-click links and their `linkId`, `title`, `url`, current category, `periodClicks`, `totalClicks`, and nullable lifetime `firstClickedAt`/`lastClickedAt`. Only `items` is paginated: summary, daily totals and category aggregates cover the full filtered population. `summary.activeLinks` counts links clicked in the requested range; `summary.neverClickedLinks` counts links with no clicks since recording began.

History starts at `recordedFrom`; its first UTC day can be partial. Daily rows before that baseline or after today have `tracked:false`, not observed zero activity. Counts follow a link's current category, and deleting a link removes its counts. An activation does not establish that the destination loaded or count unique people; no visitor identity, IP, user agent or referrer is collected in these statistics. Editing, previews, hover and external snapshot links do not add counts. Statistics do not change navigation/page revisions or bookmark edit timestamps. See [the complete statistics contract](API.md#link-click-statistics) for result fields and recording semantics.

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

## Optional work collaboration

The outer `space_current.contextVersion` remains `"1"`: original fields and meanings stay compatible. The additive optional `collaboration` object has its own `version:"1"`; clients may ignore that object until they enable/adapt to collaboration.

Since 0.2.4, `LINGSHU_MCP_COLLABORATION_ENABLED` / `--mcp-collaboration-enabled` independently enables sessions and claim enforcement, default off. `space_current.collaboration` and `work_collaboration_get` report the actual setting, effective availability and contract version. Enabling it requires MCP/Bearer work-item create/update/move callers to provide `input.context`; current claim checks accompany the existing revision checks. Unresolved claims remain protected after the setting is disabled, with cleanup available. Session labels do not grant authority and lease expiry does not stop external work.

Home application IDs remain inside the original tool `arguments`, including when Gate loads tools on demand; Gate routing `session_id` is a different field. Refresh the gateway catalog after the application upgrade, preserve the original operation ID and payload on uncertain writes, and read back current records before continuing. Workflow guidance cannot guarantee that a client schedules or follows work automatically. See the complete [user, HTTP and Agent collaboration contract](WORK_COLLABORATION.md) for lifecycle, permissions, pagination, recovery and migration 018.
