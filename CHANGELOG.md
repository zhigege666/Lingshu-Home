# Changelog

Changes describe user-visible behavior, deployment, interfaces, and maintenance. Development changes stay under `Unreleased`; a release adds a dated section matching `VERSION` and its Git tag.

## [Unreleased]

## [0.0.3] - 2026-10-25

### Container distribution

- Add a serialized, independently repairable `latest` promotion workflow that reuses the highest verified published stable image, checks release metadata and registry identities, and refuses ambiguous versions, unknown aliases or source changes. Stable releases call it after successful publication; promotion-maintenance changes and a manual Actions run can also synchronize the alias without rebuilding or modifying fixed tags.
- Default the Unraid template and Docker quick starts to `latest`, retain exact version tags for pinning, and align the English/Chinese installation and upgrade guidance. Existing fixed-tag installations need a one-time Repository change; subsequent image updates still require pulling and recreating the container with the same appdata.
- Link manual Unraid installation and its template ReadMe to the maintained instructions, including the existing database/key backup and first-upgrade language requirements for 0.0.2.

### Website category icons

- Expand the offline Lucide collection from 30 to 120 SVGs, covering AI, development, servers and networks, work and learning, media and design, everyday services, and communities. Keep every existing icon ID and SVG unchanged, and retain the same pinned upstream commit, original license and per-file checksums.
- Add eight browsing groups, bilingual names and search aliases, visible icon labels, result counts, and a clear-search action to the shared link/category picker. Searching covers all built-in groups and accepts case, width and word-separator variants; selecting a group clears the search. Built-in results show 24 icons per page in a bounded grid.
- Extend server-side icon validation together with the frontend catalog and add a manifest/allowlist/asset integrity regression. Existing saved icons remain valid; there is no database migration or automatic replacement of category or bookmark icons.

### Batch deletion and confirmation

- Add revision-checked batch link deletion for 1–500 selected links. Validate every ID before deleting, roll back the complete batch on failure, preserve unselected content, and clean only automatic-icon jobs whose origins are no longer referenced.
- Confirm link, category, batch, data-source and access-token deletion beside the initiating button with a keyboard-accessible popover. Keep the object/count, cancel action and request errors visible; prevent duplicate submission and distinguish a completed delete from a subsequent refresh failure.

### Internal website icons and templates

- Allow the editor-selected hostname to use RFC1918/ULA addresses, LAN hostnames and valid HTTP/HTTPS ports 1–65535 for automatic/manual website icons and component-template discovery/preview. Preserve custom ports in origin/cache keys.
- Keep the original hostname scope across redirects and HTML declarations. Other hosts must resolve entirely to public addresses; validate every DNS answer and dial only the validated literal IP. Continue blocking loopback, link-local, metadata, CGNAT, reserved and transition destinations.
- Preserve origin-only icon requests, image validation, request budgets and explicit proxy behavior. HTTP JSON/ICS sources retain their existing per-source private-network option; weather/GitHub keep their fixed providers. No database migration is required.

### Dialog layout and startup space

- Keep dialog headers and close controls outside the content scrollbar, preserve the clipped rounded frame and keep form actions visible while scrolling. Expand wide forms to 1240 px and arrange link basics and icon selection in two columns on suitable desktop widths; retain a single column on narrow screens.
- Remember the last successfully loaded space in browser storage per account and site origin. Add **Default opening space** beside the space selector, with **Remember last space** or a fixed accessible default. A successful manual choice in the current tab takes priority; signing out clears that tab override and retains the account's local preference. Validate preferences against current access, isolate anonymous/account choices and recover from unavailable browser storage. Failed reads never replace the last successful space. Preferences do not sync across devices or change server permissions or the API default-space contract.

### Navigation and favorites content

- Add the same **Component content** controls to the homepage inspector and admin layout editor for navigation and favorites: maximum links per row, URL display, description lines, tags, additional URLs, group titles, link counts and content density.
- Keep automatic columns as the default (`maxColumns:0`), with optional upper limits of 1–8 links per row and fewer columns when available width requires it. Directory mode stays single-column and hides the column-limit control; switching back to cards restores any saved limit.
- Preserve compatible defaults for older pages: one description line, URL fallback when no description is displayed, tags following the existing style, visible additional URLs/group headings/counts, and page-inherited density. Following the tag style omits `showTags`; explicit per-component choices leave source records and other components unchanged.
- Apply changes immediately to the page draft and canvas/preview, include them in Undo/Redo, and persist only through explicit **Save page**. Retain page Schema 2, expected-revision checks and the existing database schema.

### Release documentation and upgrade

- Require every release to update both English and Chinese READMEs and the matching dated CHANGELOG entry. Keep current version, release/download links, fixed-image examples, feature scope and upgrade guidance aligned; release notes are generated from that entry. Enforce this in the repository release checks and document it in AGENTS.md and the release guide.
- Include the navigation-content core regressions in application CI alongside the existing routing, page-preset and startup-space checks.
- This version adds no database migration and retains page Schema 2. Upgrading from 0.0.2 keeps the same database and instance-key paths. Back up before upgrading; if a page saves new component settings, restoring a pre-upgrade database/key backup is the supported way to return to 0.0.2 because its older page validator does not accept these new fields or added built-in icon IDs. Upgrading directly from 0.0.1 still requires migration 007 and retaining the original language on the first upgraded start.

## [0.0.2] - 2026-10-24

### One-time instance language and setup

- Persist one instance language with additive SQLite/PostgreSQL migration `007_instance_language.sql`. An explicit startup flag or environment value fixes a new instance's language; an omitted or empty value opens a bilingual language-confirmation step before account setup. The development helper and both Compose files preserve the unconfigured state instead of inserting Chinese.
- Add `POST /api/v1/setup/language` and bootstrap `languageSelectionRequired`, with browser CSRF protection, atomic confirmation, same-language retry and rejection of a different choice. Setup cannot proceed before confirmation. Saved language survives restarts; conflicting valid startup configuration is logged and ignored without stopping the service.
- Preserve an initialized legacy instance's explicit upgrade-start language, or the old `zh-CN` default when absent, without reopening setup. Migration 007 requires a pre-upgrade database/key backup to roll back to the published 0.0.1 program.
- Match starter bookmarks to the saved instance language, remove the independent collection-language selector, and keep the website preview. The starter-pack API returns only that language's collection, or an empty list before selection; setup rejects a mismatched collection on the server.

### Form spacing and source-format guidance

- Restore the intended 14 px vertical spacing around shared information, warning and error blocks when paragraph resets previously overrode it. Keep existing scoped layout gaps and add 12 px between text and controls within feedback blocks, covering setup, sign-in and administration forms.
- Explain that the source editor's five component data formats are built-in contracts, show expandable JSON data examples, and direct external publishers to the matching push template and component binding workflow. This does not add arbitrary schema registration or install new renderers.
- Update English/Chinese setup, startup, Unraid and storage guidance for 0.0.2, including the first upgrade from 0.0.1 and the database/key backup required by migration 007.

### Navigation organization and draft history

- Add explicit current-page and filtered-result selection to Link management, with a 500-link batch limit, selected counts and separate move-category, add/remove-tag and favorite actions. Refreshing, filtering, switching spaces or changing identity clears the selection.
- Add `POST /api/v1/spaces/{spaceId}/links/batch` with required navigation revision, same-space authorization and atomic updates. A batch preserves unrelated link fields and automatic icon intent; unchanged batches do not advance the navigation revision or timestamps.
- Add bounded in-memory Undo/Redo to the visual homepage and admin layout editors. A drag/resize is one step; text edits coalesce within a focused field, and input controls retain their native shortcuts. Saving remains explicit and clears the draft history on success.
- Prevent starting a new homepage draft while cancellation is still loading the current server page, so an immediate re-entry cannot reuse the previous revision.
- Keep the saved page revision and a clean baseline when the subsequent refresh fails, including in the admin editor. Failed/conflicting writes retain the current draft for recovery.
- Add SQLite/PostgreSQL batch regressions, draft-history tests and a bilingual browser workflow covering bookmark import, batch organization, page history, save/reload and four desktop viewports. Keep navigation provider tests in their own disposable PostgreSQL database.

### Unraid distribution

- Add a Docker Manager / Community Applications template pinned to the Linux amd64 `0.0.2` image, with configurable WebUI port, persistent appdata, one-time English/Chinese language configuration and HTTPS-cookie setting.
- Run the Unraid template as UID/GID `99:100` for dedicated appdata ownership, with no-new-privileges, dropped capabilities and a 30-second default stop timeout; document the Unraid global timeout override and Autostart setting.
- Add repository profile metadata and English/Chinese installation, backup, ownership and explicit-version upgrade instructions. Catalog submission and approval remain separate from publishing the template.
- Include the public Unraid template and `ca_profile.xml` in the release source-archive allowlist so a checkout containing those files can be packaged. Keep private configuration, runtime data and generated paths excluded.

### Documentation

- Replace the Chinese visual-editor image embedded in the English README with the verified English Classic-theme capture, and label the available Chinese editor gallery explicitly. Preserve the historical capture dates and distinguish interface language from existing bookmark/category text.

### Upgrade and release scope

- Version 0.0.2 targets Linux amd64 (x86-64) for the application and Docker image, with matching source archives and checksums. Native Windows/macOS applications and other CPU architectures are outside this release scope.
- Before the first 0.0.2 start, stop Home and back up the database together with its matching `csrf.key` and `integrations.key`. Retain the previous image/executable and continue using the same data directory or Docker volume. PostgreSQL also needs its matching local keys.
- On the first upgrade of an initialized 0.0.1 instance, preserve the original explicit language configuration, especially `en` for an English instance. Without that value, the legacy fallback is `zh-CN`; the chosen language then stays fixed for the database.
- After migration 007, rolling back to 0.0.1 requires restoring the complete matching pre-upgrade database/key backup with the old application. Replacing only the binary/image, deleting migration records or manually dropping the language column is not a supported downgrade.
- See `tests/README.md` for the actual verification scope. The release workflow records artifact identity in `release-metadata.json` after its validation and packaging gates.

## [0.0.1] - 2026-10-20

### First application release

Lingshu-Home is an independent navigation dashboard with its own administration, accounts, storage and APIs. The first release provides a Linux amd64 application bundle, matching source archives, a tested Docker image archive and the exact-version GHCR image. Native Windows/macOS applications and other CPU architectures are not part of this release.

### Navigation and homepage

- Manage nested categories, links, tags, favorites and ordering. Preview and import Chrome/Netscape bookmark HTML with folder preservation and duplicate handling; export authorized navigation as HTML or JSON.
- Configure internal and external routes separately from ordinary additional links. Default-on automatic selection uses bounded, click-triggered browser probes and short-lived observations; it does not continuously scan the network.
- Use cards or a directory, light/dark/system colors, density controls and category navigation on the top, left, right or bottom, or hide it. Desktop layouts target 2560×1440 and also support 1920×1080, 1600×900 and 2560×1080.
- Edit the homepage in a visual composer with component selection, page structure, a 24-column grid, positioning, resizing, content fitting, locking and a live preview. Header/footer slots, navigation and optional components share a revision-checked draft with explicit Save, Cancel and Restore.
- Choose the built-in Classic or iOS-inspired theme and icon/text presentation. Personal overview, Service operations and Data summary presets bind compatible local sources without starting collectors or copying navigation data.
- Use 30 licensed offline icons, space-scoped icon libraries or validated SVG/PNG/JPEG imports. Automatic website-icon retrieval is enabled by default, uses a bounded background queue, and stores canonical icon bytes in the selected database; manual icons are preserved.

### Initialization and access

- Complete first-run setup with a site name, one of four access modes, and an Owner when required. There is no default administrator password. Open editing can remain account-free or optionally create an Owner while retaining anonymous shared-space editing.
- Choose an optional Chinese or English starter website collection with a preview. The collections contain distinct sites and offline icons; examples are off by default and are placed in the shared space. Content selection is independent from the instance interface language.
- Keep English and Simplified Chinese interfaces consistent across setup, sign-in, home and administration. Set `en` or `zh-CN` at startup; existing user-entered content is retained when the interface language changes.
- Direct public setup to the shared space, retain a valid selected space across reloads within the same browser tab, and isolate that preference by identity. Backend default-space and data-permission contracts remain unchanged.
- Provide an explicit setup-state recovery action after interrupted or conflicting initialization. Recheck the server before choosing sign-in or home, preserve unsubmitted inputs when setup is still incomplete, and never automatically repeat the setup write.
- Guide editors from an empty local homepage directly to adding a first link or importing bookmarks. Show appropriate read-only and external-source empty states, and allow an account-free instance to create its first Owner without changing access mode.
- Enforce open editing, public read, private single-user and private multi-user modes on the server. Keep personal spaces private, shared content explicit, registration off by default, and sessions/tokens invalidated after relevant permission changes.

### Components and data sources

- Add calendar, weather, numeric metrics, service status and GitHub Traffic components with bounded, versioned data contracts. Load optional renderers only when used and share authorized cached snapshots.
- Receive authenticated external pushes, query normalized HTTP JSON APIs, subscribe to read-only ICS calendars, and use the fixed Open-Meteo provider. Configure source credentials on the server with encrypted storage and scoped tokens.
- Import declarative component templates from JSON, a public URL or advertised HTML-head links. Preview compatible templates, bind local sources and save the page draft explicitly. Templates use installed renderers; they do not execute downloaded plugin code.
- Expose a scoped HTTP API and Streamable HTTP MCP endpoint using the same authorization and business functions as the built-in UI. Keep local navigation authoritative and separate from external snapshots.
- Configure an optional Owner-managed outbound HTTP/HTTPS/SOCKS5 proxy with encrypted write-only credentials. Preserve each adapter's destination policy and discard work collected under obsolete configuration.
- Run source polling only when enabled sources need it. The default navigation-only setup creates no external data source or recurring navigation polling loop; an unavailable external service cannot block local navigation.

### Storage, reliability and distribution

- Use embedded SQLite by default or a dedicated external PostgreSQL database, with separate migrations through `006_network_routing.sql`, transaction boundaries, instance locking and documented recovery.
- Isolate PostgreSQL lease-health pings from request cancellation while retaining a latched unavailable response after actual lease loss. Do not silently reacquire a lost singleton lock.
- Drain HTTP requests before closing application resources, release resources after listener failures, and report forced shutdowns honestly. Compose provides a 30-second stop allowance around the application's 15-second HTTP drain budget.
- Serve compressed JavaScript/CSS with cache policies appropriate to static assets, HTML, authorized icons and APIs. Keep authentication hashing parameters unchanged while avoiding an unnecessary additional startup derivation.
- Include the public dashboard producer examples in source archives. Validate archive paths and exclude private design files, runtime data, credentials and generated build backups from source and application deliverables.
- Derive release identity from `VERSION`, the matching dated changelog and an immutable `v0.0.1` tag. Validate the application before packaging, extract the Linux program from the same tested image, and attach source/image identity, original dependency notices and SHA-256 checksums.
- Reorganize both READMEs around executable Docker and Linux quick starts, first-run setup, stable data paths and stopping/upgrading. Correct the distinction between container port 8080 and the default host loopback port 5180.

### Upgrade and scope

- This is the first published application version. Earlier `0.1.0-dev.1` screenshots and working-tree test records describe development builds; the change to the first public version number does not reset stored data.
- Preserve the database and its matching instance encryption key. Reuse the same data directory or Docker volume when replacing the application. Database-provider conversion is not automatic; rollback to a binary that predates a migration requires the matching database/key backup.
- GitHub Traffic requires the user's own repository authorization. Weather usage must follow the chosen provider's terms. No real repository traffic baseline is included in the starter data.
- Executable third-party plugins, general WebSocket/SSE/MQTT ingress, a full theme SDK, knowledge-base connectors and native desktop installers remain future work.
- Reproducible development checks and their exact scope are recorded in `tests/README.md` and `docs/PERFORMANCE.md`. Final release identity and artifact integrity are recorded by the tagged release workflow and its `release-metadata.json`; historical test counts are not substitutes for that workflow.
