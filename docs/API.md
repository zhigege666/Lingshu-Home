# API and integration reference

Lingshu-Home serves the built frontend and its API from one origin. This document describes the 0.0.6 Go implementation in `server/`, including storage selection, browser-session policy, profiles, atomic navigation editing, category folders, the file-backed library, direct HTTPS and document activity. Product versions are read from `VERSION`; API, page, export and dataset schema versions evolve independently.

## Storage bootstrap API

Version 0.0.6 adds these endpoints for first-run storage selection and recovery. Responses are bare JSON objects. They run before the normal database-backed API.

`GET /api/v1/storage/bootstrap` returns `state` (`required`, `error`, `ready`), `provider`, `source` (`default`, `cli`, `environment`, `file`, `legacy`), `language`, `csrfToken`, `version` and optional `error:{code,message}`. An empty language has not yet been fixed for the instance. No connection URL or password is returned. `ready` describes storage, not completed site/account setup. Check `/health` as well, since a later PostgreSQL lease failure can make a ready instance unavailable.

Storage writes use `X-CSRF-Token` from that snapshot, same-origin protection and a shared limit of 40 mutation attempts per process per minute. Bearer authentication does not authorize this setup surface. Bodies contain exactly one JSON object and reject unknown fields. The token changes after process restart.

| Endpoint | Request and result |
| --- | --- |
| `POST /api/v1/storage/test` | A proposed selection; success `{"ok":true}`. No config, tables, migrations or keys are written. |
| `POST /api/v1/storage/configure` | The same selection; revalidates, atomically binds the target, initializes storage and returns its current snapshot. |
| `POST /api/v1/storage/retry` | Empty body or `{}` only; retries the selected target and returns its snapshot. Cannot replace connection settings. |

SQLite body: `{"provider":"sqlite"}`. PostgreSQL body:

~~~json
{
  "provider": "postgres",
  "postgres": {
    "host": "db.internal",
    "port": 5432,
    "database": "lingshu_home",
    "username": "lingshu_home",
    "password": "<database-password>",
    "sslMode": "require"
  }
}
~~~

The host is a single hostname or IP, without a URL or embedded port; port is 1–65535. Database and username are 1–128 characters, password at most 4096 characters, and TLS is `disable`, `require` or `verify-full`. Browser fields never write credentials to localStorage.

A successful test does not reserve a target or bypass configure validation. Configuration is serialized; another in-flight operation receives 409. Once a target is bound, test/configure return 409 and only recovery of that target is possible. Inspect `state` after configure/retry: HTTP 200 may still contain `state:"error"`. After an ambiguous response, read state before another action. Public errors use `{code,message}`; configuration and recovery never return raw driver errors or passwords.

Normal business API, MCP and health return 503 before storage is ready; static frontend and storage status remain available. Invalid local bootstrap files fail startup. A provisioned target missing its Home schema is refused instead of initialized again. See [storage setup and recovery](STORAGE.md#first-run-storage-setup).

## Requests, authentication and errors

The JSON API prefix is `/api/v1`. Names use camelCase. Requests must contain one JSON value; unknown DTO fields are rejected. A typical error is:

```json
{"code":"validation_error","message":"The input is invalid."}
```

Authentication failures return JSON with HTTP 401 or 403. An inaccessible private resource can return 404. The API does not redirect to the login page. JSON API and MCP responses use `Cache-Control: no-store`. Authorized image responses additionally support private ETag revalidation as described below.

Once storage is ready, browser clients call `GET /bootstrap` before a business-API write. That endpoint sets an HttpOnly `Lingshu.Csrf` cookie and returns `csrfToken`; storage setup uses its separate bootstrap token described above. Send that value as `X-CSRF-TOKEN` on every write, including initialization, login, logout, registration and bookmark preview. The server binds the token to a random cookie nonce, the current session or anonymous context, and the permission epoch.

Read bootstrap again after login, logout or a settings change affecting access. Session cookies are named `Lingshu.Session`, are HttpOnly and SameSite=Lax, and follow the selected [login-retention policy](#browser-session-retention); legacy/temporary sessions retain a fixed 12-hour server lifetime. Cookies become Secure on direct TLS or when `LINGSHU_SECURE_COOKIES=true`; use that setting behind an HTTPS reverse proxy. Credentials and CSRF values should not be placed in URLs or browser persistent storage.

External callers can use `Authorization: Bearer <personal-access-token>` on supported JSON endpoints. Valid Bearer requests do not require a browser CSRF token. An empty, malformed or repeated Authorization header is rejected; it never falls back to the browser's Cookie identity. PAT scope restrictions apply in addition to account and space permissions. PATs cannot change global security settings or manage accounts.

Setup (including first-run language confirmation), login and registration share a limit of 20 attempts per remote IP per minute. HTTP 429 includes `Retry-After`. The service uses the direct connection address, not untrusted forwarded headers. A reverse proxy therefore shares the proxy's rate-limit bucket unless it provides distinct connections at the network layer.

## Access modes and spaces

| Mode | Anonymous access | Signed-in access |
| --- | --- | --- |
| `open_edit` | Read/write published shared navigation | Owner can manage shared and own personal content |
| `public_read` | Read published shared content | Owner can maintain shared and own personal content |
| `private_single` | No navigation access | Owner only |
| `private_multi` | No navigation access | Owner and enabled Members; registration is a separate switch |

Each instance has one shared space and each account has one personal space. Personal spaces cannot be published. An Owner cannot read another account's personal space. Members can read shared content and maintain their own personal content; they cannot edit shared navigation or administer the instance. Anonymous access is limited to explicitly published shared content.

The built-in browser's **Default opening space** preference is local to the site origin and current account; the anonymous identity has a separate remembered choice. It adds no server setting or API endpoint and does not change `GET /bootstrap`'s `defaultSpaceId` or accessible `spaces`. The browser chooses a valid current-tab manual selection first, then a fixed default, the last successfully loaded space, the API default and the first accessible space. The initial setup's shared-space landing remains a separate explicit choice. Choosing **Remember last space** clears the fixed default. Last-space persistence occurs only after a matching dashboard response succeeds; invalid preferences are cleared, and unavailable browser storage never blocks navigation. Signing out clears the tab override while retaining the account's local preference for a later sign-in.

Changing the access mode or registration policy revokes all browser sessions and invalidates existing PATs through the permission epoch. Changing an account password or enabled state invalidates that account's sessions and PATs. Mode changes preserve manually disabled Member state and do not automatically publish spaces. A source synchronization started before a relevant permission change cannot publish its result afterward.

## Bootstrap, initialization and accounts

| Method and path | Input / behavior |
| --- | --- |
| `GET /health` | `{status:"ok",version}`; also available at `/health` outside the API prefix |
| `GET /bootstrap` | Version, `language`, `languageSelectionRequired`, initialized state, site name, mode, `autoFetchIcons`, `autoSelectEndpoint`, current user, accessible spaces, default space, `sessionOptions`, current browser `session`, CSRF token and actual capabilities |
| `POST /setup/language` | `{language:"en"\|"zh-CN"}`; confirm an instance's language once, returning bootstrap |
| `GET /starter-packs` | The saved language's single starter pack, or `[]` before language confirmation |
| `POST /setup` | `{siteName,mode,username?,displayName?,password?,seedDemo,starterPack?,sessionMode?,rememberDays?}`; once only |
| `POST /auth/login` | `{username,password,sessionMode?,rememberDays?}` |
| `POST /auth/logout` | `{}` |
| `POST /auth/register` | `{username,displayName,password,sessionMode?,rememberDays?}`; creates a Member and session only when multi-user registration is enabled |
| `GET /settings` | `{siteName,mode,registrationEnabled,hasOwner,autoFetchIcons,autoSelectEndpoint}` for permitted administration |
| `PUT /settings` | `{siteName,mode,registrationEnabled,owner?,autoFetchIcons?,autoSelectEndpoint?}`; omitted preferences retain their values |
| `PUT /settings/navigation` | `{autoSelectEndpoint:boolean}` only; default on, Owner or ownerless open-edit, no PAT |
| `GET /network-proxy` | Owner browser only; `{revision,mode,url,credentialConfigured}` |
| `PUT /network-proxy` | Owner browser only; `{expectedRevision,mode,url,secret?:{username,password},clearCredentials?}` |
| `GET /admin/users` | Account array without password hashes; multi-user Owner only |
| `POST /admin/users` | `{username,displayName,password}`; creates a Member with a personal space |
| `PUT /admin/users/{id}` | `{displayName,isEnabled,password?}`; Owner cannot be disabled |

The default state is uninitialized and contains no demo navigation. `open_edit` setup can omit an Owner. Other modes must create an Owner. If an Owner is created, setup signs that account in. `seedDemo:true` creates 12 static starter links in the shared space; personal spaces remain empty. In 0.0.2, `GET /starter-packs` returns only the saved language's pack and returns `[]` while the language is unselected. Omit `starterPack` to use that language; sending the opposite supported pack returns `400 starter_language_mismatch`, even when `seedDemo` is false. Unknown pack IDs also reject setup before creating data. `seedDemo:false` remains blank. Published 0.0.1 exposed both packs and allowed independent content selection; the language-matching rules apply from 0.0.2.

An ownerless instance supplies `owner:{username,displayName,password}` when switching to a login mode. That transition creates the account and changes the mode atomically. An existing Owner cannot be replaced through this input. Once an Owner exists, only that Owner can change the mode or registration policy. Ordinary site-name editing is available in open-edit mode.

`autoFetchIcons` is a persisted boolean, defaulting to `true` for new and upgraded instances. Once an Owner exists, only that Owner can change it; an ownerless `open_edit` instance may change it with normal CSRF protection. A change to this setting alone does not invalidate sessions/PATs. Turning it off clears pending automatic-icon jobs and cancels/discards automatic results; saved images and explicit icon lookup remain available. Turning it on affects future eligible saves/imports and does not scan existing bookmarks.

`autoSelectEndpoint` defaults to true. Its narrow settings endpoint cannot alter other instance fields or authentication epochs. Proxy configuration defaults to direct, never returns saved credentials and uses optimistic string revisions. Proxy URL and credential status are excluded from bootstrap/export. See [NETWORK.md](NETWORK.md) for authorization, write/clear semantics, generation cancellation and transport policy.

Usernames contain 3–40 ASCII letters, digits, dots, underscores or hyphens, and are unique ignoring case. Passwords contain 10–128 characters and cannot be entirely whitespace. Display names and site names are limited to 80 characters. Passwords use Argon2id with 64 MiB memory, three iterations, one lane, a random 16-byte salt and a 32-byte derived hash.

Bootstrap capabilities distinguish the built-in theme package (`builtin`), its full-page exports (`builtin/dashboard` and `builtin/ios`), and its panel exports (ten, including the document-activity panel). Supported external delivery modes are `push` and `poll`. Local navigation and local document activity are application data, not external delivery adapters.

### Instance language

**Since 0.0.2:** the language is stored in `settings.language`, a column added by migration `007_instance_language.sql` for SQLite and PostgreSQL. For a database without a saved language, an explicit `--language en|zh-CN` overrides `LINGSHU_LANGUAGE` and saves the choice during startup. Omitted or empty startup values leave a new instance unselected. The only accepted nonempty values are `en` and `zh-CN`; other values fail configuration validation.

`GET /bootstrap` always includes `language:"zh-CN"` or `language:"en"` and a boolean `languageSelectionRequired`. Before confirmation, the latter is true and `language:"zh-CN"` is only a display fallback; it does not mean Chinese has been selected. The client shows a bilingual first-run choice and must not open the account/setup form yet. `POST /setup` returns `409 language_required` until the choice is saved.

Confirm with `POST /setup/language` and `{"language":"en"}` or `{"language":"zh-CN"}` using the usual browser cookie and CSRF token. This endpoint rejects bearer requests. Success returns HTTP 200 and the updated bootstrap, including `languageSelectionRequired:false`. The write is atomic; the running locale changes only after the transaction commits. Retrying the same confirmed language is idempotent, including after initialization. A different language returns `409 language_locked`; invalid language input returns 400. Concurrent tabs cannot overwrite the first successful choice. A response lost after confirmation can be recovered by reading bootstrap or retrying the same choice.

Once saved, that database's language wins over later startup configuration. A conflicting valid startup value produces a warning and is ignored without stopping the service. An initialized pre-007 database saves its explicit upgrade-start language, or the previous `zh-CN` default if none is supplied, and does not reopen first-run selection. Preserve the intended configuration when upgrading an existing English instance.

The Go-served HTML shell uses the effective `lang` before JavaScript mounts and sends a matching `Content-Language` header. Its HTML response does not use a static-file modification time as a locale validator. API field names, enum IDs and error codes remain stable. `POST /setup` and `PUT /settings` do not accept a language field; there is no per-user locale endpoint, later in-page switch, or browser-language override. Existing stored names and custom text remain unchanged. New default spaces/pages and optional starter records use the saved language.

Published 0.0.1 reads language from each process startup, defaults to `zh-CN`, and does not provide `POST /setup/language`, `languageSelectionRequired` or migration 007.

## Personal profile API

`PUT /api/v1/account/profile` accepts `{displayName,expectedDisplayName}` for the current Cookie-authenticated user. The name must contain 1–80 characters after trimming. The expected value is the exact name originally read; a mismatch returns `409 profile_version_conflict`. Success returns the existing public user shape. Username, role, account enablement and security version cannot be changed through this endpoint. Renaming does not invalidate sessions or access tokens.

`PUT /api/v1/account/password` accepts `{currentPassword,newPassword}`. It verifies the current password, validates a different new password with the existing 10–128 character policy, and preserves meaningful leading/trailing spaces. Incorrect current password returns `400 current_password_incorrect`. The transaction updates the password/security version, revokes old sessions and establishes a new session for this browser; existing PAT/MCP tokens become invalid through the user security-version check. Success is `{"success":true}`. Read `GET /bootstrap` again to refresh CSRF state before another write.

Both endpoints require a valid browser session and CSRF token; PATs and anonymous users cannot use them. Password changes share the existing authentication limit of 20 attempts per direct remote IP per minute. Failed handlers or transaction commits do not send newly issued cookies. Responses never contain password hashes. These endpoints use existing columns and add no SQL migration. Password changes now retain the current permitted login mode; see the [session-retention contract](#browser-session-retention) below.

## Browser session retention

Version 0.0.6 adds explicit login choices and Owner-managed retention policy. Login, registration and account-creating setup accept `sessionMode` (`temporary`, `remember`, `until_logout`), with `rememberDays` of 7, 30 or 90 for remembered sessions. Omitted choices remain temporary with the existing fixed 12-hour server deadline. Temporary cookies omit Expires/Max-Age. New UI logins explicitly choose a mode; initial UI defaults and the site limit are 30 idle days, with `until_logout` disabled.

Remembered sessions have a sliding idle deadline and matching persistent cookie. Until-sign-out sessions require the Owner to enable that mode, have no server idle deadline and use a renewable 365-day browser cookie. Browser storage limits or clearing cookies can still end access. Unsupported choices return `400 validation_error`; invalid registration rolls back account creation. Migration 010 preserves existing deadlines and leaves unknown legacy activity timestamps empty. Exact compatibility with the earlier unpublished session migration is described in [Storage](STORAGE.md#compatibility-with-an-unpublished-session-migration).

`GET /api/v1/bootstrap` adds:

~~~json
{
  "sessionOptions": {
    "defaultMode": "remember", "defaultIdleDays": 30,
    "maxIdleDays": 30, "allowUntilLogout": false, "rememberDays": [7, 30]
  },
  "session": {
    "mode": "remember", "idleDays": 30,
    "expiresAt": "2026-11-24T09:00:00Z", "renewAfterSeconds": 900
  }
}
~~~

`session` is null without an authenticated browser. `idleDays` is omitted outside `remember`; `expiresAt` is omitted for `until_logout`. UTC timestamps use RFC3339. `renewAfterSeconds` is the remaining server wait; temporary sessions report zero but do not renew.

| Endpoint | Request / response |
| --- | --- |
| `POST /api/v1/auth/renew` | Accepts `{}`; returns `{session:...}`. Requires browser authentication and CSRF. |
| `GET /api/v1/settings/session-policy` | Owner browser only. Returns `{defaultMode,defaultIdleDays,maxIdleDays,allowUntilLogout,policyVersion}`. |
| `PUT /api/v1/settings/session-policy` | Same policy fields plus `expectedVersion` instead of `policyVersion`. Returns the new policy; stale versions return `409 session_policy_conflict` with `currentRevision`. |
| `GET /api/v1/account/sessions` | Returns `{sessions:[...]}`, limited to the account's currently valid browser sessions. |
| `POST /api/v1/account/sessions/revoke` | Accepts `{id}`; returns `{revoked:true,current:boolean}`. Revoking this browser clears its cookie. |
| `POST /api/v1/account/sessions/revoke-others` | Accepts `{}`; returns `{revoked:number}`, the number of other stored records removed, including inactive records. |

All these endpoints reject PAT authentication. Writes retain CSRF/origin checks. Session records expose opaque `id`, `current`, `mode`, `userAgent` and applicable `idleDays`, `createdAt`, `lastInteractiveAt` and `expiresAt` fields; legacy unknown timestamps are omitted. References cannot authenticate a request. Another account's or unknown references return 404; tokens and token hashes are never returned. Browser-session revocation does not revoke separately issued PATs; token revocation, expiry and account security-version checks remain separate.

Renewal is driven by actual interaction in a visible page, with at most one database update per 15 minutes per session. Polling, bootstrap reads and PAT/MCP traffic do not renew browser logins. Early renew calls return the current summary without updating timestamps or Cookie. Expired/revoked sessions cannot be revived. Renewal keeps the token and CSRF binding. The frontend reconciles identity on authentication failure, backs off repeated failures, and orders Cookie-changing requests so a late renewal response cannot overwrite a newer login.

`policyVersion` and `expectedVersion` are JSON integers; the conflict response uses a string `currentRevision`, consistent with other revision errors. Both policy duration fields accept 7/30/90, with `defaultIdleDays` at most `maxIdleDays`; `until_logout` as the default requires `allowUntilLogout`. Tightening a limit persists a clamp on existing remembered sessions. Relaxation does not restore old choices or revive expired sessions. Disabling `until_logout` revokes those sessions, possibly including the caller. Changing the default does not upgrade existing logins. Password changes preserve the caller's permitted mode while rotating its token and revoking prior sessions/PATs.

Policy, renewal and revocation use transactions. Handler or commit failure rolls back database changes and suppresses pending Cookie writes/deletions. Clients must read back uncertain results before another write.

## Navigation and export

| Method and path | Behavior |
| --- | --- |
| `GET /dashboard?spaceId={id}` | Authorized space, page and only the dataset aliases declared by that page |
| `GET /spaces/{spaceId}/navigation` | Stable authoritative local navigation dataset for administration |
| `PUT /spaces/{spaceId}` | `{name,published}`; publication changes require the browser Owner |
| `POST /spaces/{spaceId}/categories` | Create a category |
| `PUT /spaces/{spaceId}/categories/{id}` | Replace a category's editable fields |
| `DELETE /spaces/{spaceId}/categories/{id}` | Refuses deletion while links or child categories refer to it |
| `POST /spaces/{spaceId}/links` | Create a bookmark |
| `POST /spaces/{spaceId}/links/batch` | Atomically move, tag or favorite selected bookmarks (since 0.0.2), or delete them (since 0.0.4; see below) |
| `PUT /spaces/{spaceId}/links/{id}` | Replace a bookmark's editable fields |
| `DELETE /spaces/{spaceId}/links/{id}` | Delete that bookmark |
| `POST /spaces/{spaceId}/navigation/batch-edit` | Atomically save 1–500 category/link patches and stable-ID moves with `expectedRevision`; see [atomic editing](#atomic-category-and-link-editing) |
| `GET /spaces/{spaceId}/export?format=json\|html` | Download local authorized navigation |

Category input is `{name,icon,parentId,sortOrder}`. Returned categories also contain `id` and `spaceId`. Parent IDs are nullable and must belong to the same space. Hierarchies are acyclic and limited to 32 levels.

Link input is:

```json
{
  "categoryId": null,
  "title": "Example",
  "url": "https://example.org/",
  "description": "A project with several entry points",
  "icon": "lucide:link",
  "iconMode": "auto",
  "tags": ["project"],
  "isFavorite": true,
  "sortOrder": 0,
  "endpoints": [{"label":"Documentation","url":"https://example.org/docs"}]
}
```

Local endpoint records may additionally contain `route:"internal"|"external"` and `probePath`. Only explicitly marked alternatives participate in click-triggered browser selection. Old `{label,url}` records remain manual; total endpoints remain bounded to 12. Probe paths use the strict same-origin path subset in [NETWORK.md](NETWORK.md#configure-bookmark-alternatives), defaulting to `/favicon.ico`. Remote navigation snapshots cannot configure automatic routing.

Returned local links also have `id`, `spaceId`, `updatedAt` and `iconMode:"auto"|"manual"`. `iconMode` is optional on input for older clients: creation without a mode uses manual when an icon is explicitly supplied, automatic otherwise; updates retain the previous intent unless an explicitly different icon selects manual mode. New clients should send the intended mode. Existing upgraded links and starter-pack links remain manual. Only automatic local bookmarks can enqueue website acquisition; category writes and external navigation snapshots do not create such jobs. Titles are limited to 160 characters, descriptions to 2,000, and category names to 80. A bookmark supports up to 32 tags of 40 characters and 12 additional endpoints with 40-character labels. Sort order is an integer between -1,000,000 and 1,000,000.

New local link `updatedAt` and navigation `sourceUpdatedAt` values use UTC with microsecond precision on both database providers. A successful link write returns the committed fields including the modification timestamp. Automatic icon acquisition runs afterward and, if it changes an eligible link's icon, updates that link's timestamp and navigation revision. The write does not wait for the website. Restarting without pending automatic work does not regenerate timestamps or advance the navigation revision.

URLs must be absolute HTTP/HTTPS addresses, at most 4,096 bytes, without embedded credentials, whitespace, control characters or backslashes. Ports must be within 1–65535. Icons accept the 120 bundled `lucide:*` IDs in `assets/icons/manifest.json` (expanded from 30 in 0.0.2) or an existing same-space `asset:<spaceId>:<sha256>` reference. Arbitrary remote image URLs and inline image data are not accepted in navigation. An authorized automatic-mode save/import or explicit website-icon operation can populate the local asset cache; ordinary browsing never fetches a remote favicon. [Icon library and cache contract](ICONS.md).

The admin interface must use `/navigation` for local maintenance. A page can rename, remove or retarget its own `navigation` alias; that must never make external snapshot IDs into local CRUD IDs.

JSON export uses `format:"lingshu-home.navigation"` and export `schemaVersion:1`. It contains the local space, categories, links, page, product version and export time. The included page still uses page Schema 2. The export omits accounts, sessions, credentials and external snapshots. HTML export preserves folders, escapes text/attributes and includes extra endpoints as additional bookmarks. JSON export is not an implemented full-instance restore format.

## Icon libraries and website icons

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/v1/spaces/{spaceId}/icon-packs` | `{packs:[...]}` metadata for imported packs, using current navigation read access |
| POST | `/api/v1/spaces/{spaceId}/icon-packs` | Atomically import `{schemaVersion:1,name,sourceUrl,license,icons:[{key,label,mediaType,dataBase64}]}`; `201` |
| DELETE | `/api/v1/spaces/{spaceId}/icon-packs/{id}` | Remove an unused pack; `204`, or `409` when removal would break a persisted reference |
| GET | `/api/v1/spaces/{spaceId}/icons/{sha256}` | Authorized canonical PNG/static SVG bytes; `private, no-cache`, ETag and current-auth checked `304`; no remote request |
| POST | `/api/v1/spaces/{spaceId}/icons/fetch` | Explicit `{url}` origin lookup; return a local image reference without changing a bookmark |

Mutations use the existing space edit policy, including anonymous maintenance in `open_edit`, and browser CSRF protection. PATs require the corresponding `navigation:read` or `navigation:write` action and space. Imported refs must exist in the same space when saved through HTTP, MCP or external snapshot writes. Library deletion checks links, categories, page values and persisted external snapshots; shared bytes retained by another pack or website cache remain available.

A returned pack has `{id,spaceId,name,sourceUrl,license,createdAt,icons:[{key,label,ref,url,mediaType,width,height,sha256,sourceSha256}]}`. Imports support up to 64 PNG/JPEG/static-geometry SVG icons, 256 KiB per image, 512 px dimensions, and 4 MiB decoded images per pack. A space permits 32 packs, 1,024 distinct custom images and 32 MiB of canonical bytes. The full [icon contract](ICONS.md#import-a-pack) includes the SVG allowlist, provenance and atomic failure behavior.

Website lookup returns `{ref,url,sha256,mediaType,width,height,cached,stale,sourceUrl}`. It strips the supplied bookmark path/query/fragment, discovers HTML icon/touch-icon links and `/favicon.ico`, validates destinations at every connection/redirect and caches validated image bytes. Version 0.0.4 accepts public destinations plus RFC1918/ULA and LAN names on the initially supplied hostname, with valid HTTP/HTTPS ports 1–65535. Redirects/candidates on other hosts must remain public; every resolved address is checked and the connection is pinned. Loopback/link-local/metadata/CGNAT/reserved destinations remain blocked. Custom ports are retained in cache keys. There are no ambient proxies, visitor-triggered requests or third-party favicon services. Success is cached for 24 hours, failures for 30 minutes; failed refresh retains an available good image with `stale:true`. Initial failure returns `422 favicon_unavailable`; a concurrent active lookup returns `429 icon_fetch_busy`. The lookup releases SQL/navigation write locks during network work and rechecks authorization before persistence.

Both database providers use `003_icons.sql` for images and add `005_auto_icons.sql` for the instance switch, link intent/origin and bounded persistent automatic work. Existing icon references and page values are preserved. Database backups include custom image bytes, cache metadata, the switch and pending jobs. Navigation exports contain refs, not an image-library backup. The automatic-worker contract, limits and disable/restart behavior are documented in [ICONS.md](ICONS.md#automatic-website-icons).

## Dataset envelope

```json
{
  "datasetId": "local-navigation",
  "schemaId": "navigation.collection",
  "schemaVersion": 1,
  "revision": "12",
  "data": {"categories": [], "links": []},
  "meta": {
    "sourceUpdatedAt": "2026-10-18T00:00:00Z",
    "receivedAt": "2026-10-18T00:01:00Z",
    "lastSuccessAt": "2026-10-18T00:01:00Z",
    "freshness": "fresh"
  }
}
```

The values above are illustrative. Revisions are opaque strings. Navigation revisions change with navigation data, independently of page revisions. `sourceUpdatedAt` is the source's known modification time; it is `null` when unknown. Reception time is not substituted for an unknown source time.

For `local-navigation`, `receivedAt` and `lastSuccessAt` describe the current successful local read and can advance even when the records and revision stay unchanged. Use the navigation revision and `sourceUpdatedAt` to detect stored content changes. These read-time fields are distinct from each link's persisted `updatedAt`; creating and updating a link returns the same persisted timestamp seen on subsequent reads. External snapshot timestamps describe their ingestion/synchronization lifecycle instead.

External snapshots use `datasetId:"source:<sourceId>"`. Their navigation records include `externalId` and `sourceId`, and rendered IDs are namespaced as `source:<sourceId>:<externalId>`. Snapshot freshness can be `fresh`, `stale` or `disabled`. Optional `meta.lastError` is a safe `{code,message,at}` from the latest failed refresh while successful data remains unchanged. Optional `meta.attribution` is adapter-owned `{name,url,license,licenseUrl}`; generic pushed weather does not receive an Open-Meteo attribution. A source without a snapshot does not inject a fake empty dataset; its alias can be absent from a dashboard while local navigation remains available.

The `local-document-activity` binding added in 0.0.6 uses `schemaId:"documents.activity"`, `schemaVersion:1`. Its dashboard envelope is only a renderer marker: `revision:"1"` and `data:{}`, with read-time metadata. It contains no activity counts, dates, document titles or directory details, including in public dashboards. This revision/freshness does not represent activity freshness. The component obtains authorized records through the separate [document-activity endpoint](#document-activity); adding a binding does not grant permission to those records.

## Batch bookmark organization

Version 0.0.2 adds `POST /spaces/{spaceId}/links/batch`; this route is not available in 0.0.1. Use the navigation dataset revision returned by `GET /spaces/{spaceId}/navigation`, not the page revision:

```json
{
  "expectedRevision": "12",
  "linkIds": ["0123456789abcdef0123456789abcdef"],
  "operation": "move",
  "categoryId": null
}
```

Choose exactly one operation:

| Operation | Additional input | Behavior |
| --- | --- | --- |
| `move` | `categoryId: string \| null` | Move selected links into an existing category of this space, or into Uncategorized |
| `add-tags` | `tags: string[]` | Trim/deduplicate the requested tags; append missing tags in input order |
| `remove-tags` | `tags: string[]` | Remove the named tags, preserving the order of remaining tags |
| `favorite` | `isFavorite: boolean` | Set a consistent favorite state on the selection |
| `delete` (since 0.0.4) | None | Delete the entire selected set and its additional URLs from this space |

Each request requires 1–500 unique local link IDs and a nonempty `expectedRevision`. Tag operations require 1–32 tags, each at most 40 characters; matching is case-sensitive and the resulting list on every link must remain at most 32 tags. A category and all links must belong to the URL's space. Extra category/favorite fields, nonempty tags for an unrelated operation, and unknown fields are rejected.

A successful response is `{"selectedCount":30,"updatedCount":24,"revision":"13"}`. The server validates all selected links and resulting tags before updating, then commits the entire operation in one transaction. Any validation or database failure rolls back the whole batch. Only the requested field and changed links' `updatedAt` are written; URLs, titles, descriptions, sort order, endpoints, icons and icon mode are preserved. Field-update operations neither start nor replace automatic icon jobs. If at least one link changes, the space navigation revision advances once. If none change, both the revision and stored timestamps remain unchanged.

For `delete`, send only `operation`, `linkIds` and `expectedRevision`; `categoryId`, `tags` and `isFavorite` are rejected even when explicitly null or empty. All selected IDs must exist in this space before any row is removed. Success returns `{"selectedCount":30,"updatedCount":0,"deletedCount":30,"revision":"13"}`. The transaction removes the selected links, prunes current-space automatic-icon jobs only for origins no longer referenced, and advances navigation once. Categories, unselected links, shared-origin jobs and other spaces are preserved. A failure in deletion, queue cleanup or revision update rolls back the whole operation. Deletion is immediate and has no undo/recycle bin.

A stale revision returns HTTP 409 with `code:"navigation_version_conflict"`. Reload and select again; never automatically retry against a new revision. Missing or foreign link IDs are indistinguishable (404 when the revision is current); invalid categories/inputs return 400. Existing space/account permissions, browser CSRF and PAT `navigation:write` scope all apply. This is a JSON API operation; the MCP tool catalog is unchanged.

## Atomic category and link editing

`POST /api/v1/spaces/{spaceId}/navigation/batch-edit` edits different fields on different records in one transaction. It accepts 1–500 operations combined across `categories`, `links` and optional `moves`; unused arrays may be omitted. It retains the existing space permissions, scoped `navigation:write` PAT rules and Cookie CSRF checks.

~~~json
{
  "expectedRevision": "42",
  "categories": [{"id":"category-id","patch":{"name":"Tools","parentId":null}}],
  "links": [{"id":"link-id","patch":{"title":"Portal","isFavorite":false,"sortOrder":0,"tags":[]}}]
}
~~~

Category patch fields: `name`, `parentId`, `icon`, `sortOrder`. Link patch fields: `categoryId`, `title`, `url`, `description`, `icon`, `iconMode`, `tags`, `isFavorite`, `sortOrder`, `endpoints`. Omitted fields are retained. Only nullable category references accept null; false, zero and empty arrays are explicit values. Empty patches, unknown fields, duplicate IDs and references outside the space are rejected. Entity/row/field details accompany validation errors when applicable.

Since 0.0.7, `moves` supports stable anchors without sending every hidden or paginated sibling:

```json
{
  "expectedRevision": "42",
  "links": [{"id":"link-id","patch":{"title":"Portal","categoryId":"category-id"}}],
  "moves": [
    {"kind":"category","id":"category-id","beforeId":null},
    {"kind":"link","id":"link-id","beforeId":"anchor-link-id","categoryId":"category-id"}
  ]
}
```

Apply all field patches first, then moves in array order. Each move requires `kind`, `id` and explicit `beforeId` (`null` appends). Link moves also require explicit `categoryId` (`null` means Uncategorized); their anchor must be in that category after previous moves. Category moves must omit `categoryId` and use an anchor sharing their final `parentId`; change a parent through its field patch. Reject self anchors, unknown/foreign IDs, missing required fields and repeated moves of the same entity. A row can have both one patch and one move; those count as two request operations.

Moves operate on complete same-space sibling groups. Existing untouched siblings retain relative order, and a changed group's sort values are normalized to distinct integers. A true no-op preserves old sort values, timestamps and revision. Responses can include more than 500 affected records when one move normalizes a large group; the 500 limit is on submitted operations. Clients must merge every returned row into their new baseline. The hierarchy and link ownership remain independent from page composition.

MCP `navigation_get` returns the same complete local dataset/revision; `navigation_batch_edit` accepts `{spaceId,input:{expectedRevision,categories?,links?,moves?}}` and invokes this same atomic handler. Never derive write IDs or missing sibling order from a filtered dashboard or external snapshot. A late validation error or stale revision cannot partially apply earlier moves.

The final merged category tree must have same-space parents, no cycles and at most 32 levels. Valid simultaneous reparenting is checked against that final tree. A stale navigation revision returns `409 navigation_version_conflict` with `currentRevision`. Any validation, authorization or commit failure rolls back the entire batch.

Success returns `{updatedCount,revision,categories,links}`; the arrays contain only normalized changed rows. Actual changes advance the dataset revision once. A normalized no-op leaves revision, timestamps and icon jobs unchanged. Existing automatic-icon behavior is preserved for URL/icon changes; ordinary title/tag edits do not reset an icon or schedule a fetch. Existing `contextMarkdown` usage notes are retained and remain editable through the dedicated bookmark-context endpoint.

The frontend retains drafts across both lists, filters and pages. More settings apply locally to the draft. Network uncertainty and conflicts require a fresh read and explicit conflict resolution, without automatic retries. Successfully committed fields detected on readback are removed from the draft. Drafts are memory-only and scoped to the account and space.

## Link click statistics

Available since 0.0.7 with additive migration `011_link_clicks.sql` on SQLite and PostgreSQL. Statistics are separate from navigation content, link timestamps and page revisions. A click means a browser activated a local bookmark or explicit alternate entry, not that the destination loaded, that a unique person visited it, or that an external system used it.

| Operation | Contract |
| --- | --- |
| `POST /api/v1/spaces/{spaceId}/links/{linkId}/clicks` | Browser Cookie/anonymous request with current space read permission and CSRF; `{eventId,entry}`; returns `{recorded:true}` or `{recorded:false}` for a duplicate |
| `GET /api/v1/spaces/{spaceId}/navigation/click-stats` | Signed-in, current space read access; PAT additionally requires `navigation:read`; returns aggregate statistics below |
| MCP `navigation_click_stats` | `{spaceId,input:{...filters}}`, same read-only authorization and result; `input:{}` selects defaults |

Reporting rejects Bearer/PAT credentials and has no MCP write tool. Ordinary click, keyboard Enter, Ctrl/Meta click and middle click count once; explicit internal/external/additional entrances count for their parent link. Right click, hover, prefetch/probes, folder browsing, content/layout editing and all previews do not count. External navigation snapshot links are not local reporting targets. A reporting failure does not block opening a bookmark and is not automatically retried.

`eventId` is a random 16–128 character string matching `[A-Za-z0-9][A-Za-z0-9_-]{15,127}`; the UI uses a random UUID. `entry` is `primary`, `internal`, `external` or `additional`. Server UTC time determines the day. Within 24 hours, a repeated `(spaceId,eventId)` for the same link and entry is a no-op; reusing it for another activation returns 409. Expired receipts are cleaned on subsequent valid reporting. This is a bounded idempotency window, not permanent event replay protection. Requests validate link membership in the authorized space and atomically increment counters; no visitor IDs, IPs, user agents, referrers or client timestamps are stored in these tables.

Read filters:

| Field | Meaning |
| --- | --- |
| `from`, `to` | Inclusive UTC dates `YYYY-MM-DD`; default 30 days through today; 1–366 days |
| `categoryId` | Omit for all; empty string for Uncategorized; a same-space ID for that exact current category |
| `linkId` | Optional same-space local link ID |
| `sort` | `clicks` (descending range count, default) or `lastClicked` (descending all-time last click); deterministic title/ID ties |
| `limit`, `offset` | Default 50; limit 1–200; offset 0–1,000,000 |

Repeated or unknown HTTP query parameters are rejected. Categories are exact, not recursive; clients can aggregate a subtree explicitly. Read responses use `Cache-Control: no-store` and contain:

```text
{
  from, to, timezone: "UTC", recordedFrom,
  summary: {periodClicks,totalClicks,links,activeLinks,neverClickedLinks},
  days: [{date,count,tracked}],
  categories: [{categoryId,categoryName,periodClicks,totalClicks,links}],
  items: [{linkId,title,url,categoryId,categoryName,periodClicks,totalClicks,
           firstClickedAt,lastClickedAt}],
  total,limit,offset,hasMore
}
```

`items` includes links with zero clicks; `summary`, `days` and `categories` cover the complete filtered population, not just the current page. `activeLinks` counts links with a positive range count; `neverClickedLinks` counts links with no recorded lifetime clicks. Lifetime timestamps are `null` until the first recorded click and are not restricted to the requested date range. Empty/unknown category names are represented by an empty string for Uncategorized.

`recordedFrom` is the migration's exact start instant. Days before that baseline or after today have `tracked:false`; their numeric zero is not an observation. The first day and current day may be partial. No historical clicks are inferred from link timestamps. Counters follow stable link IDs when links are renamed or moved, and category aggregates use current membership, not historical membership. Deleting a link cascades its aggregates/receipts; results describe surviving links. JSON/HTML bookmark export does not include these statistics; the matching database backup preserves them. Aggregate access is unavailable to anonymous users even when anonymous clicks on a published shared space are counted.

## Pages, bindings and layouts

`GET /spaces/{spaceId}/page` returns `{id,spaceId,name,revision,config}`. Replace the page with `PUT /spaces/{spaceId}/page` and:

```json
{"name":"Home","config":{},"expectedRevision":"12"}
```

The `config` placeholder must be replaced with a valid complete Schema 2 object. The server checks the expected revision and applies the replacement in one write transaction. A stale revision returns:

```json
{"code":"page_version_conflict","message":"The page changed. Reload the current revision before saving.","currentRevision":"13"}
```

Preserve the user's draft when this happens. Reload the current page before merging or retrying. Applying an admin layout preset preserves the page ID, selected page theme, local navigation data and existing custom `chrome`, but intentionally replaces the draft's views, bindings and placements. Switching only the page theme preserves the rest of the configuration. External clients performing a full replacement must retain any existing fields they want to keep; a missing optional field uses its documented default.

The development UI keeps up to 60 undoable draft steps in memory in each editor. History contains page content, never server revisions, and does not send API writes until Save page. A successful PUT establishes the returned content/revision as the new clean baseline and clears history even if the subsequent GET fails. A failed PUT preserves draft/history; switching page, space, identity or edit permission resets the editor. This adds no page schema or database migration.

The configuration has these independent parts:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Exactly `2` |
| `pageTheme` | `{id:"builtin/dashboard"}` or `{id:"builtin/ios"}`; no additional theme fields |
| `appearance` | `colorMode`: light/dark/system; `density`: comfortable/compact |
| `chrome` | Optional `{header,footer}` content areas with `enabled` and left/center/right item arrays; see below |
| `bindings` | Alias → `{datasetId,space:"current-page-space",query:{...}}` |
| `views` | Instances with `id`, `panel:{id}`, named `inputs`, optional `interactionScope`, `settings`, and optional validated `template` provenance |
| `layout` | `mode:"regions-grid"`, integer `gap` 8–24, `grid:{columns:24}`, and `placements` |

There are at most 32 bindings and 32 views. Empty bindings, views and placements are valid. Configurations are limited to 64 KiB. Unknown fields, schemas, page-theme IDs, panel IDs and placement kinds are rejected.

### Built-in page themes and link appearance

Both bundled page themes accept Schema 2, the regions-grid layout, all built-in panels (including the document-activity panel), light/dark/system color modes, both content densities, and header/footer content with all three alignments. Bootstrap advertises the supported page themes. No remote theme URL or executable package is accepted.

| Theme ID | Interface name | Default `linkAppearance` |
| --- | --- | --- |
| `builtin/dashboard` | Classic | `icon-text` |
| `builtin/ios` | iOS inspired | `app-icons` |

The theme-switch operation replaces only `config.pageTheme.id`. It retains component IDs and settings, bindings, data projections, base/narrow placements and locks, appearance and custom chrome. A theme does not write or reset navigation records. Admin, setup, authentication and the editor's controls are host interfaces; a homepage theme does not replace them.

`builtin/navigation` and `builtin/favorites` independently accept optional `settings.linkAppearance`:

| Value | Rendering contract |
| --- | --- |
| Omitted | Follow the selected page theme's default |
| `"icon-text"` | Show the decorative icon with the link text |
| `"minimal"` | Omit the decorative link icon; retain the text, entrances and permitted actions |
| `"app-icons"` | Use app-style rounded icon containers; directory presentation retains its row arrangement |

This key is independent of `settings.variant:"cards"\|"directory"`. Explicit values survive a theme switch. **Theme default / Follow theme** removes the optional key instead of storing `null`, `"theme"` or `"default"`. Unknown values, wrong types, and this setting on other panel types are rejected. Existing pages may omit it; reading or saving does not force a default value into old configurations. Theme/link-appearance changes do not require a page schema-version increment or a database migration. The separate icon-asset feature adds database migration 003.

### Navigation and favorites content settings

Each `builtin/navigation` or `builtin/favorites` view accepts the following optional keys in `config.views[].settings`. These control the content inside that component; component placement and dimensions remain in `layout.placements`.

| Setting | Accepted values | Default when omitted | Rendering contract |
| --- | --- | --- | --- |
| `maxColumns` | Integer `0`–`8` | `0` | `0` uses automatic responsive columns; `1`–`8` caps links per row. Available width can reduce the actual count. |
| `urlDisplay` | `"fallback"`, `"always"`, `"hidden"` | `"fallback"` | Show the main URL's host when no description is displayed, always, or never. The host label includes a non-default port; its tooltip contains the full URL. |
| `descriptionLines` | Integer `0`–`3` | `1` | `0` hides the description; `1`–`3` limits displayed lines without changing the saved text. With `urlDisplay:"fallback"`, hiding the description permits the URL label to appear. |
| `showTags` | Boolean, or omit the key | Omitted: follow style | Omission preserves theme/density/variant behavior. `true` displays up to the first three saved tags, including in directory mode; `false` hides them. |
| `showEndpoints` | Boolean | `true` | Show network entrances and other additional URLs. Hiding them does not disable automatic route selection; recovery URLs can remain available after a failed attempt to open a new page. |
| `showGroupTitles` | Boolean | `true` | Show category-group or favorites-group headings. Hiding them does not merge groups or remove a separately configured navigation component title. |
| `showCounts` | Boolean | `true` | Show counts in visible component/group headings. A hidden group heading has no visible count. |
| `density` | `"inherit"`, `"comfortable"`, `"compact"` | `"inherit"` | Follow `config.appearance.density`, or override only this component's content spacing and sizing. |

`settings.variant:"directory"` remains single-column. Both editors hide the column-limit control in directory mode; an existing `maxColumns` value remains valid and applies again when the view uses cards. The **Follow style** tags option deletes `showTags`; `null` and strings such as `"inherit"` are not valid values for that boolean setting. All optional fields may remain absent in existing configurations: validation does not inject their defaults. Out-of-range or fractional integers, invalid enum values and incorrectly typed booleans are rejected.

This content-setting group is available only for navigation and favorites. Category navigation retains its separate `showCounts` setting described below; the other content keys are not accepted on that panel, search or unrelated panels. The current page Schema 2 and database schema remain unchanged.

The homepage path is **More editing options → Adjust layout → select Bookmarks/Favorites → Component content**. Admin exposes the same controls under **Layout and theme → Panels and data → select the component → Component content**. Changes immediately update the in-memory draft and canvas/preview, enter the existing Undo/Redo history, and persist only through the explicit revision-checked **Save page** PUT. There is no separate write endpoint for these controls, and they do not modify navigation records.

### Category folder presentation

Only the `builtin/navigation` panel accepts `settings.groupPreviewCount`. Valid numeric values are 0 (all), 4, 6, 8, 12 and 24. Missing settings render a six-bookmark preview without rewriting stored JSON. Favorites do not accept this category-only setting.

The folder dialog uses the complete current category dataset, including current global filters, with local search and 24 items per page. The setting changes presentation only: API navigation datasets, exports and administration still include every authorized record. It uses the existing page revision/save contract and leaves navigation revision untouched.

### Panels and bindings

Built-in panels are category navigation, search, favorites, navigation, GitHub Traffic, calendar, weather, metrics, service status and document activity. Navigation/category/favorites require `collection`; Traffic uses `traffic`, calendar uses `events`, weather uses `weather`, metrics uses `metrics`, status uses `status`, and `builtin/document-activity` uses `activity` with `documents.activity@1`; search has no dataset input. Renderer/schema mappings, component settings, template preview and source limits are specified in [COMPONENTS.md](COMPONENTS.md). Every alias must exist and expose the panel's supported dataset schema. The same authorized dataset can feed multiple instances. `interactionScope` connects frontend filtering interactions and grants no additional data access. When provided, it is a nonempty string of at most 80 characters. An omitted scope is independent and falls back to that view’s ID.

Binding `datasetId` is `local-navigation`, `local-document-activity`, or `source:<sourceId>`. Local activity requires `space:"current-page-space"` and `query:{}`; each activity instance keeps filters in its own settings. A PAT saving this binding through the page API/MCP needs `documents:read` in addition to its page-write grant. Existing anonymous `open_edit` page composition remains available but cannot read working-document activity.

The built-in editor presents scopes as **Search and category linking**:

| Stored scope | Editor behavior |
| --- | --- |
| `primary-navigation` | Main navigation; used by presets |
| `user:<name>` | Friendly name, up to 75 characters after trimming; the full value is saved unchanged |
| A unique `independent:<generated-id>` | Independent state for the selected component |
| A view's own ID or an omitted scope | Independent when no other view shares it |
| Other existing value | Preserved and shown as a numbered existing group; the admin inspector also exposes the full identifier in a tooltip |

A name is part of the persisted scope; no separate group registry or hidden name map is created. The same named scope links its search/category/navigation/favorite instances. An independent search has no other target. Neither a named group nor a shared dataset allows access to a different space.

Activity components use explicit date-linking groups separately: the editor stores `interactionScope:"activity:<name>"` when linked, otherwise each view is independent. The scope is a view field, not a panel setting. Selected dates, current calendar months and open detail drawers remain transient state.

Navigation bindings accept only `categoryIds`, `tags`, `favoritesOnly`, `search`, `sort` and `limit`. Category ID and tag lists contain at most 100 unique entries; IDs are at most 256 characters and tags at most 40. Search is at most 160 characters. Sort is `sortOrder`, `title` or `updatedAt`; limit is 1–10,000. All non-navigation bindings require an empty query. Bindings cannot select another space.

All panels accept an optional title of at most 80 characters. Navigation and favorites independently select `cards` or `directory`, link appearance and the content settings above; navigation supports `groupBy:"category"`. Actual component width, height, order, coordinates and visibility never belong in panel settings; `maxColumns` controls only the component's internal link arrangement.

`builtin/document-activity` accepts `presentation:"heatmap"|"split"|"month"`, `months:3|6|12`, `perspective:"mine"|"library"`, up to 100 unique current-space `sourceIds`, boolean `showSummary`, `recentLimit:0|3|5`, `detailLayout:"auto"|"side"|"below"`, and `timezone:"local"` or an IANA zone, in addition to `title`. The browser resolves the settings value `local` to a concrete timezone before querying; the HTTP/MCP endpoint does not accept that sentinel. Defaults, repeatable presets and the declarative template contract are in [DOCUMENT_ACTIVITY.md](DOCUMENT_ACTIVITY.md). Template import uses renderer `builtin/document-activity` with data schema `documents.activity@1` and binds the local activity marker; it cannot create a directory grant or install a collector.

Category navigation accepts the following optional presentation settings. Existing pages without these keys remain valid and use the defaults; no database migration is needed.

| Setting | Accepted values | Default |
| --- | --- | --- |
| `displayMode` | `"icon-text"`, `"icons"`, `"text"` | `"icon-text"` |
| `hierarchyMode` | `"tree"`, `"flat"` | `"tree"` |
| `collapsible` | Boolean: allow the sidebar to collapse to icons | `true` |
| `defaultCollapsed` | Boolean: initial sidebar state for a new browser tab | `false` |
| `showCounts` | Boolean: show navigation counts | `true` |

These category-navigation settings are checked for `builtin/category-navigation`; its `showCounts` is independent of the navigation/favorites count setting above. The category-specific keys are not accepted on other panels. Unknown keys, invalid enum values, and string/number substitutes for booleans are rejected. The pure icon mode does not show a redundant whole-sidebar collapse toggle. Tree branch disclosure remains available. A selected descendant keeps its ancestors visible.

In ordinary browsing, category selection and temporary whole-sidebar/branch disclosure do not write to the page API. Disclosure preferences live in browser `sessionStorage`, isolated by page and view; a reload in the same tab retains them. The configured defaults apply when that tab has no preference. In explicit homepage editing, whole-panel disclosure updates the draft `defaultCollapsed` and persists only on the page save. Branches and search remain temporary. Admin preview uses isolated in-memory state and never writes those session preferences. Top, bottom, and narrow-screen category lists use a single horizontal scroll region. Their placement still belongs exclusively to `layout.placements`.

The admin link/category list paginates the already authorized local navigation snapshot into 25, 50, or 100 mounted rows. This is a presentation feature, not a new server pagination contract; the navigation endpoint still returns its complete snapshot.

`layout.placements[viewId]` is the only position authority. Each view has exactly one entry with `base` and optional `overrides.narrow`. The narrow override replaces the position rather than introducing a second active desktop position.

| Kind | Fields and constraints |
| --- | --- |
| `region` | top/left/right/main/bottom, `order`, optional `size:{widthPx,maxWidthPx}`, `sticky` and `locked` |
| `grid` | main only, integer `x/y/w/h`, `heightMode:"content"\|"fixed"`, boolean `locked` |
| `flow` | named region, integer `order`, optional `locked` |
| `hidden` | Only `{kind:"hidden"}`; retains the view and binding |

Grid bounds are x 0–23, y 0–10,000, w 1–24 and h 1–1,000, with x+w ≤24. Overlaps are rejected for the base and effective narrow layout, including locked blocks. Region/flow order is 0–10,000. Region widths are 160–1,600 px; the search panel is capped at 360 px. Category navigation belongs to top/left/right/bottom/hidden and cannot occupy main. Grid h is a minimum for content-sized panels and a fixed viewport for fixed-height panels; the frontend handles content growth.

### Header and footer content

`config.chrome` is optional within Schema 2; no database migration or page schema-version increment is required. If supplied, it must contain exactly `header` and `footer`. Each area must contain `enabled:boolean` plus `left`, `center` and `right` arrays. All six arrays are validated even when their area is disabled.

Example property within a complete page configuration:

```json
{
  "chrome": {
    "header": {
      "enabled": true,
      "left": [{"id":"intro","type":"text","text":"Project resources"}],
      "center": [],
      "right": [{"id":"docs","type":"link","text":"Documentation","url":"https://example.org/docs","newTab":true}]
    },
    "footer": {
      "enabled": true,
      "left": [],
      "center": [],
      "right": [{"id":"home-branding","type":"branding"}]
    }
  }
}
```

| Field / item | Validation |
| --- | --- |
| Any alignment array | At most 8 items, including disabled areas |
| Item `id` | Required string, 1–80 characters, without surrounding whitespace; unique across all six slots |
| `type:"text"` | Only `id`, `type`, `text`; text is nonempty after whitespace trimming and at most 500 characters; line breaks are allowed |
| `type:"link"` | `id`, `type`, required nonempty `text` up to 160 characters, required `url` up to 2,048 characters, optional boolean `newTab` |
| Link URL | Absolute HTTP/HTTPS; no credentials, whitespace, control characters or backslashes; valid port 1–65535. General URL validation, including the 4,096-byte UTF-8 bound, also applies. |
| `type:"branding"` | Only `id` and `type`; no custom text, URL or `newTab` |
| Unknown fields or types | Rejected |

The renderer treats text as text. It does not parse HTML, Markdown, script or style content. Links with `newTab` omitted behave as `true`; new-tab links use `noopener noreferrer`. Switching item types must remove fields that the new type does not accept. An empty slot is valid; a disabled area retains its configured items.

A missing `chrome` uses this compatible default: the header is disabled with three empty arrays; the footer is enabled with empty left/center arrays and `[{"id":"home-branding","type":"branding"}]` on the right. Branding can be moved or removed. It is not required content and is not silently reinserted into an explicitly configured empty footer.

In normal browsing, the custom header renders as an extra content row below the host header. In visual editing, a dedicated editor toolbar replaces that ordinary header, and the search component appears as a selectable canvas component. Preview restores the ordinary header presentation while keeping account changes and write controls unavailable. Configurable chrome does not supply authentication or management controls. The footer uses normal document flow: at the bottom of a short page, after the content of a long page, without an overlay that hides links. These areas are separate from `layout.placements`; they are not additional panel instances or category regions.

### Draft editing and preview behavior

Home and Admin layout drafts share an unsaved-change guard. Cancel, Restore, route/tab/space changes and sign-out require an explicit discard when changes exist; Keep editing preserves the draft. Browser document close/reload uses its native beforeunload confirmation. Confirmed discard restores the real draft before continuing the chosen action. Clicking the current admin tab does not count as leaving.

The visual homepage editor has one in-memory edit session. Its dedicated toolbar replaces the ordinary header, with a library/layers rail, selectable live canvas and properties inspector. In compact windows the rails become drawers. It can add, duplicate, remove, hide, move and resize built-in components; edit source bindings and interaction groups; select themes and appearance; and edit all six chrome slots. None of these draft changes has an independent write endpoint.

Adding a data-consuming panel reuses a compatible unfiltered binding or creates a new binding within the limit. Duplicating copies configuration and binding references to a new view ID, not source records. Removing a view removes its placement and retains existing binding definitions and business data. Showing a hidden view assigns a supported visible position; hidden placement does not retain an extra active coordinate set. Categories remain limited to top/left/right/bottom/hidden. A lock in either the base or narrow placement prevents the visual editor from moving, resizing, hiding, duplicating or removing that component until unlocked; content settings can still be edited.

Desktop dragging and the inspector's width/height controls operate on the 24-column grid. Size changes remain within bounds and can move the selected component to avoid an existing footprint. Content height uses the stored grid height as a minimum; fixed height uses it as a viewport. The editor measures the available canvas: at 900 px or less, the narrow layout applies and desktop dragging is disabled. Window resizing and opening/closing inspector drawers do not rewrite saved desktop coordinates.

All chrome slots are directly selectable on the editable canvas, including empty and disabled areas. Before saving, shared validation checks every item in every slot. An invalid item exits preview if necessary, selects its area/alignment/item, opens the relevant inspector and focuses its field; the browser sends no page PUT for that failed validation. The server separately enforces the complete chrome contract.

**Save page**, including Ctrl/Cmd+S in the visual editor, sends one revision-guarded page replacement for the entire draft. **Restore** restores the edit session's initial configuration without a request; **Cancel** exits the draft and reloads the saved page. Saving a changed category default/style clears only conflicting whole-panel preferences for those components in the current tab. A rejected 409 preserves the draft. If a save succeeds but the following read fails, the UI reports success of the write and retains its new revision.

The homepage editor's **Preview** hides its rails and selection outlines while preserving the draft; **Keep editing** returns to it. The admin uses the same page API and provides **Preview homepage** in a same-origin blank iframe with logical dimensions 2560×1440, 1920×1080, 1600×900 or 2560×1080, scaled to its panel. There is no preview write endpoint or alternate authentication route. Opening, closing, changing resolution or enlarging a preview does not save automatically.

Preview first reuses authorized Dashboard projections when both the dataset ID and query match. For newly used visible inputs with an empty query it may read `/spaces/{spaceId}/navigation` or `/sources/{sourceId}/snapshot` using the existing permissions. It does not run an upstream sync. Missing filtered projections are not reconstructed from an unfiltered dataset; unavailable aliases remain unavailable. No fake records or placeholder success snapshots are inserted.

Preview search, category disclosure and temporary appearance remain in memory, separate from normal homepage session preferences. Management, login/logout, space switching, favorite writes, layout editing and link navigation are disabled or absent inside the preview. The editable canvas also prevents external navigation and favorite writes; its whole-panel category folding changes the draft default, while preview folding stays temporary. Explicit **Save page** outside the read-only preview surface uses the normal validation, CSRF/authorization and expected-revision checks. The iframe is a controlled built-in rendering surface, not a third-party plugin sandbox or arbitrary HTML execution facility.

Only bundled trusted themes run in this version. These contracts do not imply an installed third-party theme marketplace or script sandbox.

Changing the running application does not itself constitute a page update. Rendering compatible defaults does not require a background page write. A full-page save or explicit test restoration advances the revision normally; restoring a prior configuration is not a revision rewind. Icon-library imports/deletions and website-cache writes are separate immediate space operations, not part of this page draft.

The [test record](../tests/README.md) separates source validation, HTTP authorization/concurrency, browser flows, database providers and actual deployment checks. Results from earlier composition or logo/layout runs retain their original scope and do not by themselves verify this visual-editor iteration.

## Chrome / Netscape bookmark import

`POST /spaces/{spaceId}/bookmarks/preview` and `/import` accept:

```json
{"html":"<DL>...</DL>","duplicatePolicy":"skip","targetCategoryId":null}
```

Limits are 2 MiB UTF-8 HTML, 10,000 anchors, 10,000 folders, 10,001 DL lists, 32 resulting category levels and bounded HTML nesting. HTML is parsed as a document without script execution or remote resource loading. Folder names and bookmark titles become bounded plain text.

Preview returns `total`, `valid`, `duplicates`, `invalid`, `folders`, up to 200 `items`, and `truncated`. Each item contains `title`, `url`, a folder-path array, and status. Valid counts include duplicates. Duplicate detection compares canonical URLs in the destination space and earlier entries in the same file.

Import returns `{imported,skipped,invalid,categoriesCreated}`. It reparses the original HTML, rechecks authorization and limits, resolves destination folders, and writes inside one transaction. `skip` omits duplicates; `keep` retains safe duplicate entries. Invalid protocols do not become bookmarks. A wholly rejected file produces no partial import. Repeating a skip import does not advance the local data revision when nothing changes.

## Personal access tokens and source management

Token management requires a signed-in browser account; it cannot be delegated to another PAT.

| Method and path | Input / behavior |
| --- | --- |
| `GET /integrations/tokens` | List the current account's token metadata, never raw secrets |
| `POST /integrations/tokens` | `{name,spaceId,sourceId?,actions,expiresAt}`; secret returned once |
| `DELETE /integrations/tokens/{id}` | Revoke the current account's token; returns HTTP 200 with `{ "success": true }`, and retains a revoked entry in the token list |
| `GET /spaces/{spaceId}/sources` | List permitted source metadata |
| `POST /spaces/{spaceId}/sources` | Create a supported source |
| `GET /sources/{id}` | Read safe connection and status metadata |
| `PUT /sources/{id}` | Replace editable configuration using `expectedConfigRevision` |
| `GET /sources/{id}/snapshot` | Read its latest authorized dataset envelope |
| `PUT /sources/{id}/snapshot` | Push a complete snapshot for an external-push source |
| `POST /sources/{id}/sync` | Queue an enabled polling source synchronization |
| `POST /sources/{id}/calendar-import` | `{requestId,expectedRevision,icsText,timezone,pastDays?,futureDays?}`; calendar push source only |
| `DELETE /sources/{id}` | `{expectedConfigRevision,detachUnusedBindings?}`; component references block deletion |

Each PAT belongs to one account and one space. Optional `sourceId` further restricts it to one source. Source-specific tokens accept only `sources:read` and `datasets:write`. Tokens expire between one minute and 365 days after creation. Only a cryptographic token hash is stored.

| Action | Grants, subject to account and space permissions |
| --- | --- |
| `navigation:read` | Local navigation reads and HTML export |
| `navigation:write` | Bookmark/category maintenance and bookmark import |
| `pages:read` | Page reads; dashboard and JSON export also require navigation read |
| `pages:write` | Page replacement; bound local/external datasets also require their read actions |
| `sources:read` | Permitted source metadata and snapshots |
| `sources:write` | Source create/update/synchronization requests |
| `datasets:write` | External snapshot writes |

Source kinds include `external-push`, `external-json`, `calendar-ics`, `weather-open-meteo` and `github-traffic`; their exact schemas, secrets and intervals are in [COMPONENTS.md](COMPONENTS.md). Local navigation is a built-in authority, not a mutable source configuration. Credentials stay on the server, encrypted with an independent key; DTOs expose only `credentialConfigured`. Configuration revision and snapshot revision are separate. Source deletion returns `source_in_use` while any active/hidden component references it. Explicitly detaching only unused aliases advances affected page revisions atomically with deletion; clients must reload the page afterward. Full lifecycle details are in [COMPONENTS.md](COMPONENTS.md#one-time-ics-import-and-source-deletion).

A push contains `requestId`, `schemaId:"navigation.collection"`, `schemaVersion:1`, optional `sourceUpdatedAt`, `data:{categories,links}`, and a concurrency condition: `expectedRevision` or a positive, strictly increasing `sourceSequence`. Categories use `externalId` and optional `parentExternalId`; links use `externalId` and optional `categoryExternalId` plus normal navigation fields. A full snapshot is limited to 5,000 categories, 10,000 links and 8 MiB of canonical normalized data. References must resolve within that snapshot.

Snapshot replacement and idempotency receipt are atomic. Repeating an identical request ID within the retained replay window returns its original receipt; reusing it with different content is rejected. Stale expected revisions and out-of-order sequences are rejected. A revision-based update retains any previous source-sequence watermark. Snapshot updates never insert, overwrite or delete local navigation records. Receipts expire after seven days and are capped at 256 per source; revision/sequence guards continue to apply after eviction. The four non-navigation component schemas have a 1 MiB bound in addition to per-schema collection limits.

The GitHub adapter only calls fixed HTTPS repository Traffic endpoints on `api.github.com` and rejects redirects. It does not reuse Git-over-SSH authentication. A repository token must be explicitly supplied through source configuration. The default poll interval is six hours, with a 300-second minimum and seven-day maximum. Failed source collection leaves local navigation working.

`github.traffic@1` keeps the first successful 14-day views/clones window as a baseline and stores later observed daily values. Unknown days remain null rather than zero; partial-day observations retain their measurement timestamps. GitHub rolling-window totals are not lifetime totals. Popular paths and referrers have independent success/error status, so auxiliary failures do not discard a valid core observation. No live GitHub account data is needed for the automated adapter tests.

## MCP

The endpoint is `/mcp` on the same server. It uses the official MCP Go SDK and stateless Streamable HTTP, supporting protocol versions `2026-07-28` and `2025-11-25`. Browser cookies are not accepted as MCP authentication; supply a PAT. The SDK handles protocol negotiation, initialization/discovery, schemas and JSON-RPC framing.

Tools cover dashboard/page reads, page updates, category and bookmark CRUD, source management, snapshot reads/pushes and synchronization requests. Tool inputs contain resource identifiers and, for mutations, an `input` object. List results use an `items` array. Discover exact schemas using the negotiated protocol rather than duplicating JSON-RPC assumptions in clients.

Every tool invocation reloads the current account, permission epoch and token scope. Mutations use the same write gate, transaction, authorization and business handlers as the HTTP API. Long-lived clients cannot retain revoked permissions. MCP responses are private and not cacheable across accounts.


## File-backed library API

The file-backed library is available since 0.0.5 and requires migration 008, applied on first startup. The activity endpoint added in 0.0.6 requires migration 009, also applied automatically on first startup. All paths below have the `/api/v1` prefix and retain the existing CSRF/PAT rules. Read responses use `Cache-Control: no-store`.

### Bookmark usage context

`Link` responses now include `contextMarkdown` (default `""`). Create/update accepts this optional field, limited to 65,536 UTF-8 bytes. Omitting it from an old full-link update preserves the existing notes; an explicit empty string clears them. Full-link updates additionally accept optional `expectedUpdatedAt`; when supplied it must equal the last read timestamp, or the server returns `409 bookmark_version_conflict`. Existing unversioned clients retain their previous behavior.

`PUT /spaces/{spaceId}/links/{id}/context` requires `{contextMarkdown,expectedUpdatedAt}` and changes only usage notes. It requires `navigation:write`, returns the updated bookmark and does not advance the timestamp for an unchanged value. JSON navigation export includes the field. It is user-authored reference data, never a source of authority for an agent.

### Directory registrations

Only a browser Owner session can create/update/disconnect/rescan directories, and only in an already editable space. Paths must be under configured document roots. PATs cannot add grants or expand directory access. One source owns one immutable path/space; duplicate and overlapping paths across spaces are rejected, including disconnected registrations.

| Method and path | Input / result |
| --- | --- |
| `GET /spaces/{spaceId}/document-sources` | Signed-in access; `{items,roots,canManage}`. Non-editing readers receive no unpublished source details. Absolute paths/allowed roots are only shown to a permitted manager. |
| `POST /spaces/{spaceId}/document-sources` | `{name,path,readOnly?,defaultWrite?,defaultFolder?,scanIntervalSeconds?}` → `201` source; omitted `readOnly` defaults to true |
| `PUT /spaces/{spaceId}/document-sources/{id}` | `{name,readOnly,defaultWrite,defaultFolder,scanIntervalSeconds,enabled,expectedRevision}` → source. Path and space do not change. |
| `DELETE /spaces/{spaceId}/document-sources/{id}?expectedRevision=...` | `204`; disconnects only. It retains original files and database metadata/snapshots. |
| `POST /spaces/{spaceId}/document-sources/{id}/scan` | `{}` → source status. `{confirmMissing:true}` explicitly accepts a healthy but unexpectedly empty/reduced directory and marks old entries missing; it never deletes originals. |

A source contains `id,spaceId,name,path,readOnly,defaultWrite,defaultFolder,scanIntervalSeconds,enabled,status,lastScanAt,lastError,revision,documentCount`. Status is `pending`, `ready`, `offline`, `error` or `detached`. A successful scan request can return a source whose status is `offline`/`error`: inspect that status rather than equating HTTP 200 with healthy storage. Scan intervals are 10–86400 seconds (default 60); the worker has a five-second cadence.

### Documents

A document metadata record contains `id,sourceId,spaceId,sourceName,relativePath,title,revision,metadataRevision,size,updatedAt,status,readOnly,published,hasUnpublishedChanges,tags,linkedBookmarkIds`. `revision` is the body SHA-256; `metadataRevision` is a separate monotonically increasing string for tags/relationships. Public snapshot views have no editable metadata revision and do not report private draft state. A missing file retains its record and history. An unavailable live source is identified with `unavailableReason` and does not imply deletion.

| Method and path | Input / result |
| --- | --- |
| `GET /spaces/{spaceId}/documents` | Filters `q,sourceId,relativePath,linkedBookmarkId,limit,offset`; returns `{items,total,limit,offset}`. Limit defaults to 100, maximum 500. Search is case-folded substring matching over authorized titles/paths/body/tag text, not vector retrieval. |
| `GET /spaces/{spaceId}/documents/{id}` | Metadata plus `content` and readable related `links:[{id,title,url}]`. Reads the original for an authorized editor, the frozen snapshot for a public/non-editing shared-space reader. |
| `POST /spaces/{spaceId}/documents` | `{sourceId?,relativePath,content}` → `201` document. Explicit source paths are source-relative. An omitted source selects that space's enabled default write source and its default folder; no fallback into another source/space. |
| `PUT /spaces/{spaceId}/documents/{id}` | `{content,expectedRevision}` → updated original. Content must be explicitly present; `""` deliberately clears it. |
| `POST /spaces/{spaceId}/documents/{id}/rename` | `{relativePath,expectedRevision}` → same durable document ID at the new source-relative path; existing destinations are never replaced |
| `DELETE /spaces/{spaceId}/documents/{id}?expectedRevision=...` | Saves a recovery body, removes the original and public snapshot, returns a retained `missing` record |
| `PUT /spaces/{spaceId}/documents/{id}/metadata` | `{tags,linkedBookmarkIds,expectedRevision,expectedMetadataRevision}` → document. Both arrays are required, with explicit `[]` for clearing. At most 32 tags (40 characters each) and 100 same-space bookmarks. |
| `GET /spaces/{spaceId}/documents/{id}/history` | Authorized working-document readers only; `{items:[{revision,createdAt,size}]}` |
| `GET /spaces/{spaceId}/documents/{id}/history/{revision}` | Authorized recovery body `{revision,content}`; never exposed through public snapshots |
| `POST /spaces/{spaceId}/documents/{id}/restore` | `{revision,expectedRevision}` → restores a saved body into the original path, comparing existing content or requiring that a missing target remains absent |
| `POST /spaces/{spaceId}/documents/{id}/publish` | Browser Owner only, shared space only; `{expectedRevision,expectedMetadataRevision}` freezes the reviewed body/metadata and current referenced attachments |
| `DELETE /spaces/{spaceId}/documents/{id}/publish` | Browser Owner only; removes snapshot and captured attachment access |
| `GET /spaces/{spaceId}/documents/{id}/asset?path=...` | Authorized referenced attachment bytes. The path is relative to the document. Public access returns only captured snapshot attachments. |

A body is valid UTF-8 Markdown, at most 1 MiB, without NUL bytes. Hidden paths, `..` document path segments, symlinks, absolute paths and unsupported document extensions are rejected. Relative asset links are resolved within the registered source; they cannot expose another source or arbitrary files. Raster images have an inline media type; other files are forced downloads with `nosniff` and restrictive security headers. Publication attachment limits are 100 references, 10 MiB each and 20 MiB total.

Read-only applies to original-file mutations. Authorized tags/relationships/publication can still be maintained without changing a read-only original. Anonymous `open_edit` never permits server-file writes. Personal documents can never be published. A shared space's publication flag is not a wildcard publication grant for new files.

Writes return their resulting document and therefore require both PAT actions `documents:read` and `documents:write`; token creation rejects write without read. The handler checks this before any file mutation, including for legacy/malformed grants. Old PATs gain no actions automatically. External-source-scoped tokens cannot have document actions. Related bookmark IDs/details/filtering and changes to existing relations also require `navigation:read`.

Filesystem reads/scans are separated from database transactions; original-file mutations are serialized independently of ordinary navigation updates. File bytes and SQL metadata cannot form one atomic transaction. After a file has been created, replaced, linked or removed, a later operation/finalization failure returns `503 document_index_pending`; inspect the original path and rescan before retrying. File effects are not automatically rolled back; recovery copies retained before destructive changes remain available. Content conflicts return `409 document_version_conflict`; metadata conflicts return `409 document_metadata_conflict`; source-setting conflicts return `409 document_source_version_conflict`, with `currentRevision` where relevant. Metadata saves check the current original's revision and update its index, so an external edit followed by a reload does not require waiting for the next scan before tagging.

### Document activity

`GET /spaces/{spaceId}/document-activity` returns persisted activity for the current space without opening original files or triggering a scan. It requires a signed-in user with access to working documents; a PAT additionally needs `documents:read` and the same space grant. A read-only directory remains readable to an otherwise authorized working-document reader. Access to a public document snapshot does not grant access to draft counts, titles or directory names. A signed-in snapshot-only reader receives `403 document_activity_forbidden`; missing PAT actions receive `403 forbidden`. Anonymous access is rejected. Inaccessible spaces and unknown, disconnected or cross-space source IDs return 404 under the normal resource-hiding rules.

| Parameter | Meaning and default |
| --- | --- |
| `from`, `to` | Inclusive `YYYY-MM-DD` dates in the selected timezone, with `from <= to` and at most 367 calendar days. `to` defaults to today in that timezone. `from` defaults to `to` shifted back six calendar months plus one day, using calendar-date arithmetic. |
| `timezone` | IANA timezone such as `Asia/Shanghai` or `America/New_York`; default `UTC`. `Local` and unknown zones are rejected. Day boundaries follow local daylight-saving transitions. |
| `perspective` | `mine` (default) or `library`. `mine` selects events attributed to the authenticated account, including its browser, HTTP API and MCP writes. `library` includes all actors and external observations in this authorized space. |
| `sourceIds` | Optional directory IDs; omission or an empty MCP array selects all enabled directories in the space. HTTP accepts repeated parameters and comma-separated values, for example `sourceIds=<id1>,<id2>&sourceIds=<id1>`; duplicates are removed. MCP accepts a string array. At most 100 supplied IDs; malformed IDs fail validation and unknown, disconnected or cross-space IDs return 404. |
| `date` | Optional `YYYY-MM-DD` inside the range. Filters only the detail items; `days` and `summary` continue to describe the whole `from`/`to` range. |
| `limit`, `offset` | Detail pagination: `limit` defaults to 20 and accepts 1–100; `offset` defaults to 0 and accepts 0–1,000,000. |

The response is one object with the following fields. Arrays are empty arrays when there are no matching entries.

| Field | Result contract |
| --- | --- |
| `from`, `to`, `timezone`, `perspective` | The effective query values after applying defaults. |
| `recordedFrom` | Earliest recording baseline among the selected enabled directories, or an earlier known event for this perspective; UTC RFC 3339 timestamp, or `""` if neither exists. It is a recording boundary, not the first day on which this user edited a document. |
| `days` | Sparse, ascending `[{date,count,created,updated}]` for dates with content activity. Each document ID counts once per local date. Creation and later updates/restorations on the same date count only under `created`; other `restore` events count under `updated`. Thus `created + updated == count`. |
| `summary` | `{documents,activeDays}`: distinct document IDs with content activity across the entire range, and the number of dates with nonzero content activity. One document edited on two dates contributes one document and two active days. |
| `items` | `[{documentId,title,relativePath,sourceId,sourceName,date,lastAt,count,actions,origins,status}]`, grouped by document ID and local date, ordered by latest activity descending with a stable document-ID tie-breaker. Titles, paths, source names and `status` reflect the current index; they are not historical name snapshots. `lastAt` is a UTC RFC 3339 instant. `count` is the number of recorded operations in the group; `actions` and `origins` are deduplicated arrays. A `missing` document retains a detail item but has no currently indexed original to open. |
| `total`, `hasMore` | Total daily document groups after the optional `date` filter, and whether another page follows. These describe detail pagination; they do not truncate or redefine `days` or `summary`. |
| `sources` | All currently enabled directories readable in this space, even when `sourceIds` selects a subset: `[{id,name,status,lastScanAt,recordedFrom}]`. Each source's `recordedFrom` is its successful scan baseline or `""`. Offline/error sources retain their historical activity and report their current status; disconnected sources and their counts are omitted. Absolute filesystem paths are not returned. |

Only `create`, `update` and `restore` contribute to content activity in `days` and `summary`. `rename`, `delete` and `metadata` also appear in `items`, so a date can have detail operations while its heatmap count is zero. Saving unchanged bytes, changing only file mtime, repeating unchanged metadata or rescanning unchanged files produces no extra event. A real `A → B → A` sequence observed by Home records both content transitions. Recreating an indexed missing path keeps its document ID and records `restore`.

Origins are server-assigned: `web` for browser operations, `api` for ordinary Bearer HTTP operations, `mcp` for MCP dispatch, and `external` for filesystem observations. A Bearer request alone is not an agent label. External events have no inferred actor and do not enter `mine`, including when an Owner manually triggers the scan or a metadata save first observes an external body change. External timestamps record observation time, not file mtime or an inferred authoring time; changes between observations cannot be reconstructed.

The first successful complete scan of a newly connected or upgraded directory establishes a baseline without backfilling its existing files as new activity. Explicit Home changes already recorded before that scan remain visible. Treat dates before `recordedFrom` as unrecorded rather than zero activity, and inspect per-source baselines when combining directories that began recording on different dates. Failed/incomplete scans do not advance a new baseline or fabricate removals. Disconnecting retains stored history; reconnecting unchanged files does not create fresh edits.

Invalid parameters return `400 validation_error`. A query whose selected range, perspective and directories contain more than 250,000 events returns `422 document_activity_window_too_large`, with no partial aggregate. Reduce the date range or selected directories; changing only `date`, `limit` or `offset` does not reduce the full-range aggregation work. The 367-day and 250,000-event limits bound a query, not stored history retention. See [document activity](DOCUMENT_ACTIVITY.md) for component configuration and [activity storage](STORAGE.md#document-activity-storage) for persistence and recovery.

### MCP

`bookmarks_context_update` takes `spaceId,id,input:{contextMarkdown,expectedUpdatedAt}`. The document tools are `documents_list`, `documents_get`, `documents_create`, `documents_update`, `documents_rename`, `documents_delete` and `documents_metadata_update`. Their `spaceId`/`id` arguments and `input` objects follow the HTTP contracts; `documents_list` uses an input object for its filters, and `documents_delete` puts `expectedRevision` in input. Results contain metadata or body as appropriate. Directory grants and publication are deliberately not exposed as agent tools.

`documents_activity_list`, added in 0.0.6, requires `spaceId` and an `input` object whose optional fields are `from,to,timezone,perspective,sourceIds,date,limit,offset`; use `input:{}` for all defaults. `sourceIds` is an array, not a comma-separated string. It runs the same read handler, permissions, defaults, aggregation, pagination and limits as the HTTP activity endpoint. It returns the same result fields and cannot request another user's `mine` perspective or assign an event origin.

The same HTTPS listener or trusted reverse proxy protects `/api/v1`, `/mcp` and attachment routes. Configure clients with the HTTPS URL directly; do not send a bearer token to HTTP and rely on a redirect. See [transport encryption](TRANSPORT_SECURITY.md) and the [document guide](DOCUMENT_LIBRARY.md).
