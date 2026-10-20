# Storage, migration and recovery

The Go service supports SQLite and PostgreSQL through `database/sql`, using `modernc.org/sqlite` and pgx. Both providers use real, separately maintained SQL migrations. Docker/Linux is the primary runtime. Browser access from Windows or macOS does not imply a native desktop client has been delivered.

## Runtime configuration

| Environment variable | CLI flag | Default / meaning |
| --- | --- | --- |
| `LINGSHU_LISTEN` | `--listen` | `127.0.0.1:5180` |
| `LINGSHU_DATA_DIR` | `--data-dir` | `data`, resolved to an absolute path |
| `LINGSHU_STORAGE_PROVIDER` | `--storage-provider` | `sqlite`; alternatively `postgres` |
| `LINGSHU_DATABASE_URL` | `--database-url` | Required PostgreSQL connection URL for that provider |
| `LINGSHU_WEB_DIR` | `--web-dir` | `web/dist`, the built frontend directory |
| `LINGSHU_VERSION_FILE` | `--version-file` | `VERSION`, required and nonempty |
| `LINGSHU_LANGUAGE` | `--language` | `zh-CN`; use `en` for the instance-wide English interface |
| `LINGSHU_SECURE_COOKIES` | `--secure-cookies` | `false`; enable behind an HTTPS reverse proxy |

Use environment or a private environment file for a PostgreSQL connection URL instead of a shell command line containing a password. Unsupported providers and missing PostgreSQL connection URLs fail startup. The service never silently substitutes an in-memory database or falls back to SQLite after a PostgreSQL error.

The supplied Docker image listens on `0.0.0.0:8080` inside the container. The README Docker command and both Compose files publish it only on the Docker host at `127.0.0.1:5180`. The standalone executable defaults to `127.0.0.1:5180`. Configure the published interface or reverse proxy for access from another computer; that computer's `127.0.0.1` refers to itself. The built frontend, API, icons and MCP endpoint share one origin. An HTTPS reverse proxy supplies TLS; `LINGSHU_SECURE_COOKIES=true` requires HTTPS cookies but does not enable a TLS listener in Home.

The Linux release includes the executable, `web/dist` and `VERSION`; run it from the extracted release directory unless you set those paths explicitly. Its default `data/` is relative to that working directory. The README uses `--data-dir "$HOME/.local/share/lingshu-home"` to keep persistence outside the versioned release directory. Continue using the same data directory when replacing the executable or extracting a later release.

The README image command mounts the named volume `lingshu-home-data` at `/data`. The source Compose deployments instead mount their project-scoped `home-data` volume there. Keep the same volume and Compose project identity on subsequent starts. These are different installation paths: switching between them does not automatically transfer data. The PostgreSQL deployment still needs its local data volume for both instance keys.

## Persistent files

`LINGSHU_DATA_DIR` is needed for both providers:

| File | Purpose |
| --- | --- |
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

SQLite is the default for a single personal instance. It enables foreign keys, a 15-second busy timeout and WAL. The application uses one open connection and serializes writes before authorization and transaction creation. Bookmark import is one atomic write transaction; page revisions are compared inside their write transaction.

The database is fixed at `<data-dir>/lingshu-home.db`. The service acquires a process-lifetime OS file lock. Starting another instance with the same directory fails, even when it uses a different HTTP port. The lock uses Unix flock or Windows LockFileEx according to the compiled target.

WAL provides local database concurrency; it is not a multi-host deployment protocol. This version supports one application instance, not an active-active cluster. Keep its data volume local to the host or use storage with the SQLite locking semantics required by the deployment.

## PostgreSQL

Set `LINGSHU_STORAGE_PROVIDER=postgres` and provide `LINGSHU_DATABASE_URL`. The provider uses native booleans, JSONB and timestamp columns, with a normal connection pool of up to six connections. A dedicated connection holds a database advisory lock for the lifetime of the application.

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

Migration 003 is additive for SQLite and PostgreSQL. Image bytes use SQLite BLOB / PostgreSQL BYTEA; normalized hashes and pack entries are scoped to a space. It does not rewrite existing links, category ownership, pages or access modes. The new homepage themes and visual editor continue to use page Schema 2 and do not need a separate database migration.

Migration 004 leaves migration 001–003 checksums unchanged. SQLite rebuilds the constrained source/integration tables in one transaction using temporary copies and dependency-safe drop/restore order, with foreign keys enabled; PostgreSQL changes the source-kind constraint and adds the receipt retention fields/index. Credentials, source identity, tokens, snapshots, replay receipts and Traffic baseline/daily data must survive intact. The SQLite upgrade temporarily needs room for copies of the affected integration tables as well as transaction/WAL data. Back up the database and matching keys first. Restore that backup when reverting to an older binary; deleting the migration ledger is not rollback.

Migration 005 is additive and leaves migration 001–004 checksums unchanged. `settings.auto_fetch_icons` defaults to true; old links receive manual mode and retain their exact image references. The local-link canonical icon origin supports indexed, space-scoped automatic updates. `icon_favicon_jobs` persists bounded work by space/origin with a unique job identity and authorization metadata, without raw credentials. Normal restart resumes committed pending work; disabling automation clears pending work and cancels/discards in-flight automatic results. Migration and ordinary page reads do not scan or fetch old websites. No new external storage service or additional key file is needed.

Migration 006 adds `settings.auto_select_endpoint` (default true) and `network_proxy_config` (default direct, no credentials) without rewriting existing columns or endpoint JSON. Optional route/probe attributes remain in the existing link endpoint JSON. Proxy ciphertext uses `integrations.key`; browser observations are a bounded, disposable memory cache. No additional service, key file or background scan is introduced. See [NETWORK.md](NETWORK.md).

Startup first verifies all known applied migration checksums and refuses unknown newer versions or out-of-order history. It then applies each pending file and its ledger entry in one transaction. A failed migration rolls back that file and prevents startup; it does not mark a partial migration complete.

Never edit a migration that has reached a persistent database. Add a new numbered migration for a schema change. If a checksum mismatch occurs, first recover the matching application source or backup rather than replacing the checksum by hand. Older binaries refuse a database with unknown migrations; application downgrades can require a full matching database restore.

Before an upgrade, retain the previous executable/image, its VERSION, and a recoverable backup of both the database and its matching keys. Database migrations and credential-key compatibility are part of the upgrade, not just the container image.

**After migration 006, a binary that predates that migration cannot open the upgraded database.** To roll back, stop Home and restore the matching pre-upgrade database and key backup with the previous binary/image. Replacing only the application, removing ledger rows or dropping icon tables is not a supported downgrade. Keep the newer backup too if it contains changes made after the upgrade.

## Backups

### SQLite: straightforward stopped-instance backup

1. Stop Home cleanly and ensure its process has released the data directory lock.
2. Copy the complete data directory, including both key files and any remaining SQLite WAL files, to a private backup destination.
3. Record the product version and retain the matching release artifact.
4. Restart Home and check `/health`.

Do not copy only a running `.db` file and assume it includes committed WAL changes. If an online backup is required, use a SQLite-aware backup operation and preserve the matching keys separately. The service does not currently expose a database-backup HTTP endpoint.

SQLite's official [Online Backup API](https://sqlite.org/backup.html) and [WAL documentation](https://sqlite.org/wal.html) explain the database mechanisms behind these requirements.

### PostgreSQL

Use a PostgreSQL-aware backup such as `pg_dump` for the dedicated Home database, and back up the complete local Home data directory containing its key files. Keep the database dump and matching key backup together as one restore set. A coordinated maintenance window is the simplest way to avoid source-credential changes between those copies.

Use the PostgreSQL version's supported backup tooling and verify restore permissions. The official [pg_dump reference](https://www.postgresql.org/docs/18/app-pgdump.html) describes its snapshot and format behavior. The application does not manage your database administrator credentials or provide an automatic PostgreSQL dump scheduler.

### Restore

Restore into a stopped instance with a dedicated destination. Restore the database, both key files and the matching application version before starting it. Preserve private file ownership and permissions. Start one instance and verify health, initialization state, account access, expected spaces/navigation, source credential availability, saved page theme/layout and imported icon rendering. Test a restore periodically; the existence of backup files does not establish that they can be used successfully.

Keep backups private: exports can contain private links and configuration, and full backups contain password hashes, session/PAT hashes and encrypted source credentials. The corresponding integration key enables credential decryption.

## What is retained

Local navigation is authoritative business data and is never evicted as an external cache. Each source has its own configuration revision and latest snapshot revision. External navigation pushes replace that source's normalized snapshot without touching local bookmark rows. Idempotency receipts prevent ambiguous repeated push writes.

GitHub Traffic retains the first successful views/clones window as its baseline, later daily observations, and the latest normalized display snapshot. Missing observations remain unknown. Historical Traffic observations retain their existing history policy. Push receipts are retained for seven days with a maximum of 256 per source. Calendar, weather, metrics and service-status sources store one latest normalized snapshot each (at most 1 MiB), not raw downloaded bodies or an implicit time series. Multiple page aliases refer to the same stored snapshot. Disabling preserves the last good data and stops collection; page visibility alone does not stop an explicitly enabled source.

Canonical custom icon bytes are content-addressed and deduplicated within each space. Pack records retain the original and normalized hashes, source URL and supplied license notice. A pack deletion removes only its exclusive unreferenced images; a saved link/category/page/source reference blocks deletion of its last retained image. Existing assets can be shared by another pack or a website-cache record.

Website icon cache entries retain their origin, last successful image and refresh status. Positive results have a 24-hour freshness window; initial failures may retry after 30 minutes, and a failed refresh keeps the previous successful image. Expiry permits the next eligible automatic-mode save/import or explicit lookup; it does not schedule work or delete the image. Limits are 32 packs, 1,024 image hashes, 32 MiB of canonical bytes and 512 distinct cached/pending origins per space, with at most 2,048 queued origins per instance. A new remote lookup or refresh also requires fewer than 1,024 retained image hashes and at least 256 KiB remaining in that image-byte budget; cached images remain readable when new acquisition is blocked by capacity. An empty queue has no periodic timer. The database holds the authoritative image copy; browsers use private HTTP revalidation and never trigger a favicon lookup. Format and outbound policies are in [ICONS.md](ICONS.md).

Cookie sessions expire after 12 hours. Permission epochs and per-account versions invalidate old sessions and PATs immediately after supported security changes. These checks occur against current database state; an old frontend or MCP connection cannot retain a previous authorization decision.

## Provider validation

Run `go test ./...` from `server/` for the local SQLite, integration, page-theme, icon and component suites. PostgreSQL execution is explicit and requires **five different fresh disposable databases**:

- `LINGSHU_TEST_POSTGRES_URL` for the core provider test.
- `LINGSHU_TEST_INTEGRATIONS_POSTGRES_URL` for the integration provider test.
- `LINGSHU_TEST_ICONS_POSTGRES_URL` for icon storage, authorization, automatic acquisition and migration 005/006 plus network-setting tests.
- `LINGSHU_TEST_COMPONENTS_POSTGRES_URL` for component source lifecycles, snapshots, encrypted credentials and reference-safe deletion.
- `LINGSHU_TEST_COMPONENT_MIGRATION_POSTGRES_URL` for component source migration preservation and failure rollback.

Application suites fail rather than erase an initialized application schema. Do not point any variable at a user instance or reuse one database between the five configured provider groups. Core coverage includes permissions, optimistic page concurrency and failing closed after the advisory-lock connection disappears. Integration coverage exercises PAT/MCP authorization, snapshot writes and GitHub Traffic persistence with synthetic HTTP responses. Icon coverage exercises BYTEA persistence, pack import/deletion and rollback, same-space references, current mode/CSRF/PAT/MCP authorization, external snapshot references, private conditional image GETs and storage reopen. Automatic-icon lifecycle and migration 005 cases reuse the dedicated icon database through randomly named schemas. They require permission to create schemas, clean up only their own schema, and cover queue admission/rollback, origin deduplication, obsolete-result rejection, disable/restart behavior and migration preservation/rollback.

Component coverage adds push/import receipt replay and retention, credential projection and origin-change protection, stale-job rejection and source/page reference boundaries. The component migration suite also requires permission to create schemas in its separate database; it creates and cleans up only its own randomly named schemas, comparing all original columns in the six integration tables after successful upgrades and injected failures. The SQLite migration cases also assert that foreign keys remain enabled without violations. Tests that skip an unset PostgreSQL variable do not establish PostgreSQL runtime verification.

The separate HTTP acceptance runner in `tests/` supports disposable server instances and persistence checks across real process restarts. Record provider-specific results with the release; a source-level build alone does not verify a running deployment.

The application CI configuration creates `lingshu_core`, `lingshu_integrations`, `lingshu_icons`, `lingshu_components` and `lingshu_component_migration` for the five Go provider suites, plus distinct `lingshu_http` / `lingshu_ownerless` databases for HTTP acceptance. The PostgreSQL test step requires all five Go variables and uses verbose, uncached execution so each provider subtest is visible. The existing race, HTTP restart and Docker gates remain. Updating or locally checking this workflow is not evidence that the revised workflow has run successfully on GitHub. Actual execution results belong in [tests/README.md](../tests/README.md).
