# Storage, migration and recovery

The Go service supports SQLite and PostgreSQL through `database/sql`, using `modernc.org/sqlite` and pgx. Both providers use real, separately maintained SQL migrations. Version 0.0.6 application and Docker artifacts target Linux amd64 (x86-64). Browser access from Windows or macOS does not imply a native desktop client has been delivered.

Version **0.0.2** introduced persisted instance language and migration **007**; **0.0.5** added the document library in **008**. Version **0.0.6** adds document activity in **009** and browser-session retention in **010**, applied automatically on first startup. Follow the upgrade and restore rules below for each schema boundary; replacing the executable alone does not downgrade a database.

## First-run storage setup

Version 0.0.6 uses the same storage initialization for Docker, the Linux executable and source runs. An unconfigured new instance selects storage before language and account setup; explicit or existing configuration continues to select the original target.

Selection follows explicit CLI options, explicit environment configuration, `<data-dir>/storage.json`, a valid existing SQLite instance, then the first-run page. CLI values override matching environment values. An explicit storage target skips the page and is not copied to `storage.json`. Invalid configuration is an error, not permission to initialize another database.

A fresh instance without a selected target serves the storage page before creating an application database or keys. The process still holds the data-directory lock. Choose SQLite or external PostgreSQL; MySQL/MariaDB are not supported. PostgreSQL fields are host, port, database, username, password and TLS mode (`require`, `verify-full` or `disable`). The browser defaults to encrypted transport. Use `verify-full` with a trusted certificate and matching hostname; install the trusted CA in the application environment when needed. `disable` is an explicit option for a network where plaintext database traffic is acceptable.

Connection testing is read-only: it does not save credentials, create application tables, migrate or initialize keys. PostgreSQL needs a dedicated database and permissions to connect, use the schema and apply migrations. Confirmation validates again, saves a private atomic configuration without overwriting a concurrent selection, and performs the existing migrations.

### Saved configuration and recovery

`storage.json` has schema version 1 and contains `provider`, a PostgreSQL `databaseUrl` when applicable, and a `provisioned` completion marker. The file is private mode `0600` and can contain a password. Do not commit it, include it in images or serve it as a frontend asset.

`provisioned` means migrations and key initialization completed. It does not mean that site/account setup has finished. An interrupted first initialization can retry the same bound target. After provisioning, a missing database or Home schema is a recovery error; Home refuses to create an empty replacement. Deleting the marker is not a supported reset procedure.

Malformed or unsafe local configuration and invalid legacy SQLite files fail startup. A selected PostgreSQL connection that cannot be opened instead serves a recovery page with `/health` returning HTTP 503. Correct the connection problem and retry that same target; the page does not offer database switching or silently fall back to SQLite. A lost running PostgreSQL advisory lease still requires the controlled restart described below.

When storage is ready, normal language confirmation and site/account setup continue if needed. Existing valid SQLite instances are detected without a storage prompt, preserving accounts, language and data. No new SQL migration is introduced for this bootstrap feature.

Back up `storage.json` when present, the database, and matching `csrf.key` and `integrations.key` together. For explicit startup configuration, retain the private environment separately. PostgreSQL still requires the local data volume. Changing connection settings does not convert, copy or migrate existing data.

## Runtime configuration

| Environment variable | CLI flag | Default / meaning |
| --- | --- | --- |
| `LINGSHU_LISTEN` | `--listen` | `127.0.0.1:5180` |
| `LINGSHU_DATA_DIR` | `--data-dir` | `data`, resolved to an absolute path |
| `LINGSHU_STORAGE_PROVIDER` | `--storage-provider` | Explicit `sqlite` or `postgres`; omit to reuse saved/legacy storage or open first-run selection for a new instance |
| `LINGSHU_DATABASE_URL` | `--database-url` | Required PostgreSQL connection URL for that provider |
| `LINGSHU_WEB_DIR` | `--web-dir` | `web/dist`, the built frontend directory |
| `LINGSHU_VERSION_FILE` | `--version-file` | `VERSION`, required and nonempty |
| `LINGSHU_LANGUAGE` | `--language` | `zh-CN` or `en` before a language is saved; omitted/empty means first-run selection for a new instance; saved language takes precedence |
| `LINGSHU_SECURE_COOKIES` | `--secure-cookies` | `false`; enable behind an HTTPS reverse proxy |

Use environment or a private environment file for a PostgreSQL connection URL instead of a shell command line containing a password. Unsupported providers and missing PostgreSQL connection URLs fail startup. The service never silently substitutes an in-memory database or falls back to SQLite after a PostgreSQL error.

For a new database, a valid explicit language is saved at startup. Without one, the language-confirmation page saves it before setup. The chosen language belongs to the database rather than browser storage or container metadata. Restarting with a conflicting valid language logs a warning and retains the saved value. Existing initialized databases upgrading from 0.0.1 use the explicit language supplied on their first upgraded start, or the old default `zh-CN` when none is supplied; keep the original English startup configuration when upgrading an English instance. No post-setup language-change endpoint is provided.

The supplied Docker image listens on `0.0.0.0:8080` inside the container. The README Docker command and both Compose files publish it only on the Docker host at `127.0.0.1:5180`. The standalone executable defaults to `127.0.0.1:5180`. Configure the published interface or reverse proxy for access from another computer; that computer's `127.0.0.1` refers to itself. The built frontend, API, icons and MCP endpoint share one origin. Use Home's optional direct TLS listener or an HTTPS reverse proxy for encrypted access. `LINGSHU_SECURE_COOKIES=true` requires HTTPS cookies but does not enable a TLS listener by itself.

The Linux release includes the executable, `web/dist` and `VERSION`; run it from the extracted release directory unless you set those paths explicitly. Its default `data/` is relative to that working directory. The README uses `--data-dir "$HOME/.local/share/lingshu-home"` to keep persistence outside the versioned release directory. Continue using the same data directory when replacing the executable or extracting a later release.

The README image command mounts the named volume `lingshu-home-data` at `/data`. The source Compose deployments instead mount their project-scoped `home-data` volume there. Keep the same volume and Compose project identity on subsequent starts. These are different installation paths: switching between them does not automatically transfer data. The PostgreSQL deployment still needs its local data volume for both instance keys.

## Persistent files

`LINGSHU_DATA_DIR` is needed for both providers:

| File | Purpose |
| --- | --- |
| `storage.json` | Web-selected provider/connection and provisioning marker; private mode 0600; explicit CLI/environment targets are not written to this file |
| `lingshu-home.db` | SQLite database; not used by the PostgreSQL provider |
| `lingshu-home.db-wal`, `lingshu-home.db-shm` | Active SQLite WAL state; may be absent after a clean shutdown |
| `csrf.key` | Independent random 32-byte key for browser CSRF authentication |
| `integrations.key` | Independent random 32-byte key for encrypted source and outbound-proxy credentials |
| `.instance.lock` | OS lock handle guarding one process per data directory |

New data directories use mode 0700 and new keys/database files use private permissions. Run the service as a dedicated account with ownership of this directory. The integration key must be a private regular file. Its contents must not be committed, included in an image, sent to a theme, or printed in logs.

GitHub tokens, secret calendar/JSON subscription URLs and optional API credentials use AES-256-GCM with random nonces and source-specific associated data. The encryption key is separate from browser CSRF state. Startup refuses to invent a replacement integration key if the database already contains encrypted credentials and the matching key is missing. Proxy credentials use the same key with a separate proxy-specific associated-data context; a proxy-only database also blocks missing-key replacement. A database backup alone is therefore insufficient for restoring integrations or proxy credentials, including when the database is external PostgreSQL.

Accounts use salted Argon2id password hashes. Session and PAT secrets are stored as hashes. Source credentials are encrypted because the adapter must later use them; this is a different requirement from password or token verification.

The built frontend directory is not a data directory. Release artifacts should include only the executable, VERSION, intended web assets and notices. Internal design files, private environment configuration and user databases must stay outside build and release contents.

Imported icon images, pack metadata and cached website icons live in the selected database, not in an upload directory beside the frontend. They require no additional Compose volume or image-service container. Backing up the full database includes these assets; navigation JSON/HTML exports do not include their binary content. The bundled Lucide collection is a static application asset with its own source/license manifest.

## SQLite

SQLite is the embedded option for a single personal instance. It enables foreign keys, a 15-second busy timeout and WAL. The application uses one open connection and serializes writes before authorization and transaction creation. Bookmark import is one atomic write transaction; page revisions are compared inside their write transaction.

The database is fixed at `<data-dir>/lingshu-home.db`. The service acquires a process-lifetime OS file lock. Starting another instance with the same directory fails, even when it uses a different HTTP port. The lock uses Unix flock or Windows LockFileEx according to the compiled target.

WAL provides local database concurrency; it is not a multi-host deployment protocol. This version supports one application instance, not an active-active cluster. Keep its data volume local to the host or use storage with the SQLite locking semantics required by the deployment.

## PostgreSQL

Choose external PostgreSQL on the first-run storage page, or explicitly set `LINGSHU_STORAGE_PROVIDER=postgres` and provide `LINGSHU_DATABASE_URL`. The provider uses native booleans, JSONB and timestamp columns, with a normal connection pool of up to six connections. A dedicated connection holds a database advisory lock for the lifetime of the application.

The service generates new local navigation modification timestamps at microsecond precision for both providers. This matches PostgreSQL `TIMESTAMPTZ` storage and keeps a write response equal to later stored reads. Existing data is not rewritten to apply this precision rule; no database migration is required for it.

The PostgreSQL lock also prevents two instances using the same database from running with different local data directories. The local directory lock remains necessary to protect that instance's key files. Use a dedicated database for Home; the migration ledger and schema are not intended to share a database with unrelated applications.

Before serving API, health or MCP requests, the application checks its pinned advisory-lock connection. If that connection is lost, it marks storage unavailable and returns HTTP 503, even if the ordinary pool can reconnect. Background mutations and MCP tool calls also check the lease. Restore connectivity and restart the service after verifying that another instance has not taken the database. The application does not silently resume writes without reacquiring its singleton lock.

A request that is already cancelled does not start a lease ping. Checks of the dedicated connection are serialized; a caller can cancel while waiting for its turn. Once a ping starts, it has its own three-second timeout, independent of that request's cancellation or deadline; this is the active ping budget, not a total queue-and-check latency limit. Abandoning a request must not discard the process-wide lock connection. After a successful check, a cancelled caller still receives its context error. An actual failed lease ping remains a latched storage failure even if the caller was cancelled at the same time. Closing the store marks the lease unavailable before releasing the connection. This does not introduce a periodic timer, a connection retry, or background polling.

On an interrupt or SIGTERM, the executable first stops accepting HTTP connections and waits up to 15 seconds for in-flight requests to drain before closing the application and its storage. A listener failure also runs application cleanup before returning a nonzero exit status. If the drain times out, it force-closes active HTTP connections and returns a nonzero status with an explicit error; forced connection close does not prove that handler code ignoring cancellation has finished. No data migration is needed for these lifecycle changes.

Both supplied Compose files set `stop_grace_period: 30s`, and the README image command sets `--stop-timeout 30`, leaving time for the HTTP drain and storage cleanup before Docker may force termination. Use `docker stop lingshu-home` / `docker start lingshu-home` for that image command, or `docker compose stop home` / `docker compose start home` for the source Compose deployment. These stop/start operations retain the named volume. A Linux foreground process stops with `Ctrl+C`; wait for it to exit before copying its data or starting a replacement.

This version does not migrate an existing SQLite database to PostgreSQL automatically. Exported navigation JSON is not a database-conversion tool. Choose the provider when configuring the instance or plan a separately validated data migration.

## Versioned migrations

Migration files are embedded from `server/internal/home/migrations/sqlite/` and `postgres/`. Applied versions, SHA-256 checksums and application times are stored in `schema_migrations`.

| Migration | Persistent model |
| --- | --- |
| `001_initial.sql` | Instance, accounts, spaces, local navigation and page configuration |
| `002_integrations.sql` | Sources, encrypted credentials, normalized snapshots, synchronization state, push receipts and API tokens |
| `003_icons.sql` | Space-scoped `icon_assets`, `icon_packs`, `icon_pack_entries` and `icon_favicon_cache` |
| `004_component_sources.sql` | Additional source kinds and bounded push-receipt retention index/timestamp |
| `005_auto_icons.sql` | Default-on automatic-icon setting, explicit local-link icon intent/origin and a bounded persistent origin job queue |
| `006_network_routing.sql` | Default-on browser selection and a singleton, versioned outbound proxy configuration with encrypted credentials |
| `007_instance_language.sql` (0.0.2) | `settings.language`, initially empty until the instance's first language is determined; allowed saved values `zh-CN` and `en` |
| `008_document_library.sql` (0.0.5) | Bookmark usage notes, registered document directories, stable document IDs, metadata/search caches and explicit publication/attachment snapshots |
| `009_document_activity.sql` (0.0.6) | Directory recording baselines and persistent, indexed document activity events; existing files are not backfilled as edits |
| `010_session_retention.sql` (0.0.6) | Versioned Owner session policy, remembered/until-sign-out modes, browser-session activity timestamps and device descriptions |

Migration 003 is additive for SQLite and PostgreSQL. Image bytes use SQLite BLOB / PostgreSQL BYTEA; normalized hashes and pack entries are scoped to a space. It does not rewrite existing links, category ownership, pages or access modes. The new homepage themes and visual editor continue to use page Schema 2 and do not need a separate database migration.

Migration 004 leaves migration 001–003 checksums unchanged. SQLite rebuilds the constrained source/integration tables in one transaction using temporary copies and dependency-safe drop/restore order, with foreign keys enabled; PostgreSQL changes the source-kind constraint and adds the receipt retention fields/index. Credentials, source identity, tokens, snapshots, replay receipts and Traffic baseline/daily data must survive intact. The SQLite upgrade temporarily needs room for copies of the affected integration tables as well as transaction/WAL data. Back up the database and matching keys first. Restore that backup when reverting to an older binary; deleting the migration ledger is not rollback.

Migration 005 is additive and leaves migration 001–004 checksums unchanged. `settings.auto_fetch_icons` defaults to true; old links receive manual mode and retain their exact image references. The local-link canonical icon origin supports indexed, space-scoped automatic updates. `icon_favicon_jobs` persists bounded work by space/origin with a unique job identity and authorization metadata, without raw credentials. Normal restart resumes committed pending work; disabling automation clears pending work and cancels/discards in-flight automatic results. Migration and ordinary page reads do not scan or fetch old websites. No new external storage service or additional key file is needed.

Migration 006 adds `settings.auto_select_endpoint` (default true) and `network_proxy_config` (default direct, no credentials) without rewriting existing columns or endpoint JSON. Optional route/probe attributes remain in the existing link endpoint JSON. Proxy ciphertext uses `integrations.key`; browser observations are a bounded, disposable memory cache. No additional service, key file or background scan is introduced. See [NETWORK.md](NETWORK.md).

Migration 007 is additive for both providers and leaves migration 001–006 checksums unchanged. It adds `settings.language` with an empty default and a constraint allowing only empty, `zh-CN` or `en`. Startup then saves a configured language or preserves an initialized legacy instance's previous default. New unconfigured databases keep the empty state until the first successful language confirmation. The migration and confirmation do not rename existing site, account, space, page, category or bookmark content, and need no new key or volume. A full database backup includes the chosen language. Navigation exports are not a language-setting backup or reset mechanism.

Migrations 008 and 009 are additive and leave earlier migration files/checksums unchanged. The [document-library](#document-library-storage) and [activity](#document-activity-storage) sections below describe their authoritative data, recording baselines and original-file backup requirements. Migration 009 adds a column, table and indexes; it does not rewrite existing document bodies, metadata, publications or page layouts.

Migration 010 is additive for SQLite and PostgreSQL. It adds the retention policy and session fields while preserving existing session deadlines; those sessions remain temporary until the user signs in with a new choice. Legacy timestamps that were never recorded remain unknown. The initial policy selects 30 idle days for new UI logins, limits remembered logins to 30 days and disables until-sign-out. No additional key or external authentication service is introduced. The profile and atomic navigation-editing endpoints reuse existing data columns.

Startup first verifies all known applied migration checksums and refuses unknown newer versions or out-of-order history. It then applies each pending file and its ledger entry in one transaction. A failed migration rolls back that file and prevents startup; it does not mark a partial migration complete.

Never edit a migration that has reached a persistent database. Add a new numbered migration for a schema change. If a checksum mismatch occurs, first recover the matching application source or backup rather than replacing the checksum by hand. Older binaries refuse a database with unknown migrations; application downgrades can require a full matching database restore.

Before an upgrade, retain the previous executable/image, its VERSION, and a recoverable backup of both the database and its matching keys. Database migrations and credential-key compatibility are part of the upgrade, not just the container image.

**After migration 007, the published 0.0.1 binary cannot open the upgraded database.** The same rule applies to earlier migration boundaries. To roll back, stop Home and restore the matching pre-upgrade database and key backup with the previous binary/image. Replacing only the application, removing ledger rows or dropping columns is not a supported downgrade. Keep the newer backup too if it contains changes made after the upgrade.

### Compatibility with an unpublished session migration

Some unpublished builds applied `008_session_retention.sql` before the document-library release used the official 008 slot. Version 0.0.6 recognizes only that exact legacy layout: the complete 001–007 ledger must have the expected checksums, its sole later entry must be the known session-migration checksum at 008, and the settings/session schema must match. SQLite checks the complete settings/session DDL and both session indexes; PostgreSQL checks column types, defaults, nullability, constraints and indexes.

For an exact match, one transaction applies the official `008_document_library.sql` and `009_document_activity.sql` and records the already-applied session migration at 010. The session migration's original checksum and application time are preserved, its `ALTER` statements are not rerun, and existing session policy, sessions and other data remain in place. The canonical 010 SQL is byte-for-byte the same as that recognized unpublished session SQL. Official 008/009 files and checksums are unchanged.

An unknown checksum, incomplete ledger, unexpected schema or failed DDL prevents the bridge and leaves the previous database state intact. This is a narrowly recognized upgrade, not a general checksum-repair or migration-renumbering mechanism. Keep a recoverable backup with the exact prior executable/source and keys before starting it; on refusal, restore or inspect that matching version rather than editing migration rows. Returning to an unpublished build requires its own matching pre-upgrade restore set, not the published 0.0.5 backup described below.

## Backups

### SQLite: straightforward stopped-instance backup

1. Stop Home cleanly and ensure its process has released the data directory lock.
2. Copy the complete data directory, including `storage.json` when present, both key files, document recovery history and any remaining SQLite WAL files, to a private backup destination.
3. Record the product version and retain the matching release artifact.
4. Restart Home and check `/health`.

Do not copy only a running `.db` file and assume it includes committed WAL changes. If an online backup is required, use a SQLite-aware backup operation and preserve the matching keys separately. The service does not currently expose a database-backup HTTP endpoint.

SQLite's official [Online Backup API](https://sqlite.org/backup.html) and [WAL documentation](https://sqlite.org/wal.html) explain the database mechanisms behind these requirements.

### PostgreSQL

Use a PostgreSQL-aware backup such as `pg_dump` for the dedicated Home database, and back up the complete local Home data directory containing its key files, `storage.json` when present and document recovery history. Keep the database dump and matching local backup together as one restore set. A coordinated maintenance window is the simplest way to avoid source-credential changes between those copies.

Use the PostgreSQL version's supported backup tooling and verify restore permissions. The official [pg_dump reference](https://www.postgresql.org/docs/18/app-pgdump.html) describes its snapshot and format behavior. The application does not manage your database administrator credentials or provide an automatic PostgreSQL dump scheduler.

### Restore

Restore into a stopped instance with a dedicated destination. Restore the database, both key files, any saved `storage.json` and the matching application version before starting it. Preserve the selected target and deployment settings; do not remove the provisioning marker to create a new empty replacement. Preserve private file ownership and permissions. Start one instance and verify health, initialization state, saved instance language, account access, expected spaces/navigation, source credential availability, saved page theme/layout and imported icon rendering. Test a restore periodically; the existence of backup files does not establish that they can be used successfully.

Keep backups private: exports can contain private links and configuration, and full backups contain password hashes, session/PAT hashes and encrypted source credentials. The corresponding integration key enables credential decryption.

## What is retained

Local navigation is authoritative business data and is never evicted as an external cache. Each source has its own configuration revision and latest snapshot revision. External navigation pushes replace that source's normalized snapshot without touching local bookmark rows. Idempotency receipts prevent ambiguous repeated push writes.

GitHub Traffic retains the first successful views/clones window as its baseline, later daily observations, and the latest normalized display snapshot. Missing observations remain unknown. Historical Traffic observations retain their existing history policy. Push receipts are retained for seven days with a maximum of 256 per source. Calendar, weather, metrics and service-status sources store one latest normalized snapshot each (at most 1 MiB), not raw downloaded bodies or an implicit time series. Multiple page aliases refer to the same stored snapshot. Disabling preserves the last good data and stops collection; page visibility alone does not stop an explicitly enabled source.

Canonical custom icon bytes are content-addressed and deduplicated within each space. Pack records retain the original and normalized hashes, source URL and supplied license notice. A pack deletion removes only its exclusive unreferenced images; a saved link/category/page/source reference blocks deletion of its last retained image. Existing assets can be shared by another pack or a website-cache record.

Website icon cache entries retain their origin, last successful image and refresh status. Positive results have a 24-hour freshness window; initial failures may retry after 30 minutes, and a failed refresh keeps the previous successful image. Expiry permits the next eligible automatic-mode save/import or explicit lookup; it does not schedule work or delete the image. Limits are 32 packs, 1,024 image hashes, 32 MiB of canonical bytes and 512 distinct cached/pending origins per space, with at most 2,048 queued origins per instance. A new remote lookup or refresh also requires fewer than 1,024 retained image hashes and at least 256 KiB remaining in that image-byte budget; cached images remain readable when new acquisition is blocked by capacity. An empty queue has no periodic timer. The database holds the authoritative image copy; browsers use private HTTP revalidation and never trigger a favicon lookup. Format and outbound policies are in [ICONS.md](ICONS.md).

Legacy and temporary Cookie sessions expire after 12 hours. Version 0.0.6 adds explicit remembered and until-sign-out modes through migration 010, preserving existing session deadlines. See [session retention](API.md#browser-session-retention) for activity renewal, revocation and Owner policy. Permission epochs and per-account versions invalidate old sessions and PATs immediately after supported security changes. These checks occur against current database state; an old frontend or MCP connection cannot retain a previous authorization decision.

## Provider validation

Run `go test ./...` from `server/` for the local SQLite, integration, page-theme, icon and component suites. PostgreSQL execution is explicit and requires **nine different fresh disposable databases**:

- `LINGSHU_TEST_POSTGRES_URL` for the core provider test.
- `LINGSHU_TEST_INTEGRATIONS_POSTGRES_URL` for the integration provider test.
- `LINGSHU_TEST_ICONS_POSTGRES_URL` for icon storage, authorization, automatic acquisition, network settings and migrations 005/006; instance language and migration 007 tests use isolated schemas in the same test database.
- `LINGSHU_TEST_COMPONENTS_POSTGRES_URL` for component source lifecycles, snapshots, encrypted credentials and reference-safe deletion.
- `LINGSHU_TEST_COMPONENT_MIGRATION_POSTGRES_URL` for component source migration preservation and failure rollback.
- `LINGSHU_TEST_NAVIGATION_POSTGRES_URL` for atomic navigation batches, unchanged operations, authorization, revision conflicts, rollback and persistence.
- `LINGSHU_TEST_DOCUMENT_POSTGRES_URL` for document directories, original-file operations, authorization, publication, document activity and migrations 008/009 preservation/failure rollback. Activity runtime and document migration cases create and clean up their own randomly named schemas, so they require schema-creation permission and do not consume the original library suite's application schema.
- `LINGSHU_TEST_BOOKMARK_CONTEXT_POSTGRES_URL` for optional bookmark usage notes, backward-compatible updates and optimistic concurrency.
- `LINGSHU_TEST_STORAGE_POSTGRES_URL` for storage bootstrap and profile cases in owned random schemas; schema-creation permission is required.

Application suites fail rather than erase an initialized application schema. Do not point any variable at a user instance or reuse one database between the nine configured provider groups. Core coverage includes permissions, optimistic page concurrency and failing closed after the advisory-lock connection disappears. Integration coverage exercises PAT/MCP authorization, snapshot writes and GitHub Traffic persistence with synthetic HTTP responses. Icon coverage exercises BYTEA persistence, pack import/deletion and rollback, same-space references, current mode/CSRF/PAT/MCP authorization, external snapshot references, private conditional image GETs and storage reopen. Automatic-icon lifecycle and migration 005 cases reuse the dedicated icon database through randomly named schemas. They require permission to create schemas, clean up only their own schema, and cover queue admission/rollback, origin deduplication, obsolete-result rejection, disable/restart behavior and migration preservation/rollback.

Component coverage adds push/import receipt replay and retention, credential projection and origin-change protection, stale-job rejection and source/page reference boundaries. The component migration suite also requires permission to create schemas in its separate database; it creates and cleans up only its own randomly named schemas, comparing all original columns in the six integration tables after successful upgrades and injected failures. The SQLite migration cases also assert that foreign keys remain enabled without violations. Tests that skip an unset PostgreSQL variable do not establish PostgreSQL runtime verification.

The separate HTTP acceptance runner in `tests/` supports disposable server instances and persistence checks across real process restarts. Record provider-specific results with the release; a source-level build alone does not verify a running deployment.

The application CI configuration creates `lingshu_core`, `lingshu_integrations`, `lingshu_icons`, `lingshu_components`, `lingshu_component_migration`, `lingshu_navigation`, `lingshu_documents`, `lingshu_bookmark_context` and `lingshu_storage` for the nine Go provider suites, plus distinct `lingshu_http` / `lingshu_ownerless` databases for HTTP acceptance. The PostgreSQL test step requires all nine Go variables and uses verbose, uncached execution so each provider subtest is visible. The existing race, HTTP restart and Docker gates remain. Updating or locally checking this workflow is not evidence that the revised workflow has run successfully on GitHub. Actual execution results belong in [tests/README.md](../tests/README.md).


## Document-library storage

Version **0.0.5** introduced separately maintained migration **008** to SQLite and PostgreSQL. Version 0.0.4 ends at migration 007; the new application applies 008 on first startup while preserving existing data. With the old environment unchanged, document roots remain disabled and direct TLS remains off.

Migration 008 adds optional bookmark usage notes (`links.context_markdown`, empty for old rows), directory registrations, durable document records, tags/relationships, searchable body caches and explicit publication/attachment snapshots. It does not rewrite existing links, categories, ownership or document files. Working document bodies remain authoritative in their mounted source directories. The database still contains irreplaceable manual metadata and public snapshots; it is not a disposable cache.

| Location | Contents / backup requirement |
| --- | --- |
| One or more separately mounted source directories | Original `.md` / `.markdown` and attachments; back up the originals, filenames and folder structure |
| Home database | Source/space bindings, stable IDs, tags, bookmark relationships, publication state/body/attachment snapshots, rebuildable search text and, after migration 009, recording baselines/activity events |
| `<data-dir>/document-history/` | Up to 20 distinct prior body revisions per document, created before Home overwrites/deletes; private permissions, not a complete external-edit or attachment history |
| Existing data directory and keys | Retain the original `/data`, `csrf.key` and `integrations.key` for both database providers |
| Deployment configuration | Host/container mount mappings, allowed root list, readonly flags, TLS certificate configuration and ownership |

`LINGSHU_DOCUMENT_ROOTS` / `--document-roots` is a JSON array of absolute allowed document paths, default `[]`. It never replaces `LINGSHU_DATA_DIR`. Root paths cannot expose application data/web assets or configured TLS keys, including their resolved paths. Register multiple non-overlapping roots under one space in Admin; disconnecting a registration does not delete either original files or their metadata/history.

Before upgrading, stop Home and back up the database, instance keys/history, mounted originals and deployment configuration together. To revert to 0.0.4, restore its matching pre-upgrade database/data backup and executable/image. Restoring the database alone cannot undo edits made to original Markdown files; recover those from the corresponding original-file backup. Do not modify applied migration checksums, delete migration ledger entries or let an older binary operate on the new schema.

File operations and database transactions are coordinated but are not one cross-filesystem transaction. An index-finalization failure after writing a file is reported as `document_index_pending`; recovery copies remain and a later scan can repair derived content records. Metadata is retained on missing mounts, partial scan failures and unexpectedly empty scans. File/version behavior and exact limits are documented in [the library guide](DOCUMENT_LIBRARY.md).

Direct HTTPS adds `LINGSHU_TLS_CERT_FILE` / `--tls-cert-file` and `LINGSHU_TLS_KEY_FILE` / `--tls-key-file`. Both must be present; certificate-load errors fail before opening business storage and never cause HTTP fallback. The private key is mounted separately from document roots. `LINGSHU_SECURE_COOKIES` still does not enable a TLS listener by itself. HTTPS does not encrypt document/history/database files at rest or a host-to-NAS mount; see [transport encryption](TRANSPORT_SECURITY.md).

## Document-activity storage

Upgrading from **0.0.5 to 0.0.6** automatically applies migration **009_document_activity.sql**, maintained separately for SQLite and PostgreSQL, followed by session-retention migration 010. Direct upgrades from 0.0.4 apply 008 first, then 009 and 010. Retain the same SQLite data directory or PostgreSQL database, instance keys, recovery history, document/certificate mounts, allowed roots, runtime identity and saved language. No new volume or environment setting is required; existing document roots and HTTP/TLS configuration retain their behavior. It adds `document_sources.activity_started_at` with an empty default, and the `document_activity` table with indexes for space/time, actor/space/time and source/time queries. Each event stores its ID, document/source/space IDs, optional actor ID, action, origin, occurrence/observation instants, and before/after content-revision hashes. Instants use fixed-precision UTC text consistently in both providers. The table contains event metadata and hashes, not another copy of the document body.

Actions are `create`, `update`, `restore`, `rename`, `delete` and `metadata`; origins are `web`, `api`, `mcp` and `external`. A known browser/API/MCP change records the authenticated account. An external observation has a null actor and uses the time Home observed the change. File mtime, the person pressing Scan and a user saving tags are not evidence of authorship. Multiple external changes between observations may be invisible or combined into one observed transition; this is an activity record, not a complete filesystem audit history.

The first successful complete scan after connection or upgrade sets the directory's recording baseline without manufacturing events for existing content. Migration 009 itself leaves existing baselines empty and creates no historical events. Home writes that succeed before that first scan still record known activity; the API's range-level `recordedFrom` can therefore precede a directory's scan baseline. A failed, unavailable or incomplete scan retains the previous index and does not establish a new baseline. Unexpectedly empty or greatly reduced directories retain the existing missing-file confirmation behavior. Dates before recording began are unknown, not proof of inactivity. File timestamps and recovery bodies cannot reconstruct earlier activity or its authors.

Each event is committed in the same short SQL transaction as its associated index/metadata update. If that transaction fails, both database changes roll back. Original files are outside that transaction: a failure after a successful file operation still returns `document_index_pending`, and a later scan may repair the index and record an external observation. It cannot recover a failed transaction's authenticated actor from file bytes. Inspect the original before retrying; no automatic filesystem rollback is promised.

Activity is durable database data. Rescanning unchanged content, changing mtime, restarting, or reconnecting an unchanged directory does not create another event. Disconnecting retains its baseline and events, while authorized queries omit the disconnected directory and its counts. Missing-document records retain their history. Foreign keys remove events only if their document, source or space is actually deleted from the database; deleting an actor account sets its event actor references to null. There is no automatic activity retention cutoff or activity-deletion API. The API's 367-day range and 250,000-event maximum are per-query limits, not pruning policies; exceeding the event limit returns explicit `422 document_activity_window_too_large` rather than partial counts.

Before applying 009, stop Home and retain the matching executable/image, complete database backup, local data directory/keys/history, source-file backups and deployment configuration. These are the same restore-set requirements as the document library; no new key file or mounted volume is introduced. A navigation JSON export or a fresh file scan is not an activity backup. Keep the newer backup as well if it contains post-upgrade activity or document changes.

A failed pending migration and its ledger entry roll back transactionally and prevent startup. A successfully applied 009 has no automatic down migration: a 0.0.5 binary that only knows migrations through 008 refuses the upgraded database. To return to that version, stop Home and restore its matching pre-009 database/data backup and executable/image. Do not delete ledger entries, change checksums or drop the new table/column as a substitute. Restoring the database does not undo later Markdown edits; restore or reconcile the corresponding original-file backups separately. See the [API contract](API.md#document-activity) for the recording boundary and permission-filtered aggregation returned to clients.
