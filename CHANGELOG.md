# Changelog

Changes describe user-visible behavior, deployment, interfaces, and maintenance. Development changes stay under `Unreleased`; a release adds a dated section matching `VERSION` and its Git tag.

## [Unreleased]

## [0.2.2] - 2026-11-13

### Unified application headers

- **① User experience:** align Home, Library, Work and administration around one header. Keep the brand, module navigation and current context on the left; place search and page actions before the shared space/preferences/account controls on the right. Library creation and administration list search/add actions move into the header; secondary list actions use More, while bulk operations and form saves remain with their content. Home layout and click statistics use Page options. Home/Work appearance moves into the account menu; visitor and preview appearance stays in Page options. Library and administration remain light.
- **② Developer experience:** reuse `AppHeader`, `HeaderSpaceSelect` and `AccountMenu`, with a 64 px desktop header, 24 px horizontal padding and a 32 px brand mark. Replace conflicting page-specific header rules while retaining custom page chrome, editor/preview behavior, permission checks and unsaved-draft navigation guards. Responsive layouts target 2560×1440, 1920×1080, 1600×900 and 2560×1080.
- **③ AI Agent experience:** keep named search, page-action, space and account entrypoints consistent across screens. Existing HTTP/MCP contracts, authorization, tokens and data remain unchanged; this interface change introduces no migration or extra Skill requirement. Update both READMEs and user guides with the current menu paths.

### Upgrade compatibility

- Keep this compatible improvement in the 0.2.x line. Version 0.2.2 adds no database migration, HTTP/MCP schema change or required deployment setting over 0.2.1. Reuse the existing data, keys, mounts and configuration; the earlier migration and backup requirements still apply when upgrading from 0.2.0 or earlier.

## [0.2.1] - 2026-11-13

### Release versioning

- Keep this compatible set of existing-module improvements in the 0.2.x line as 0.2.1. Document the 0.x policy for small releases; migration and recovery requirements remain unchanged.

### Module navigation, configuration and work history

- Share the left-side Home / Library / Work navigation across the homepage, library, board and administration. Keep search and page actions separate from module navigation, retain unsaved-change protection and support the four desktop sizes.
- Add Owner-controlled Library and Work switches to Site settings. Both default on; disabling a module blocks its HTTP/MCP operations while preserving records, files and associations. Navigation remains available. Reopening a module reuses the same data, sessions and tokens; existing editors retain their drafts if another session disables access.
- Display work update times on cards and lists, and creation/update times plus a paginated change timeline in details. Record server-observed edits, moves, archive/restore, status migration/type changes and reference changes atomically. Bookmark deletions also record their actual reference removals without changing navigation authorization.
- Keep create replay and no-op edits/moves from producing duplicate history or artificial update times. Store structural summaries instead of long text or private reference contents; filter reference changes by current read scopes. Earlier activity for existing items remains explicitly unknown.
- Fix the status manager's height allocation so its header and save footer remain in place while long status lists scroll inside the drawer. Verify short/long lists and menus at 2560×1440, 1920×1080, 1600×900 and 2560×1080.
- Add SQLite/PostgreSQL migrations 016 (work activity) and 017 (module settings). Preserve existing item timestamps and use the migration time as the history boundary. Returning to an older application requires its matching pre-upgrade database/data backup.

### Optional MCP workflow guidance

- Add `LINGSHU_MCP_WORKFLOW_ENABLED` / `--mcp-workflow-enabled`, default off and read at startup. The switch controls work-registration and handoff guidance; it does not change permissions or disable explicit CRUD requests.
- Extend `space_current` with module state, effective read/write capabilities, versioned guidance and available entrypoints while retaining its original fields. Tool-description prefixes point to this result so gateways using on-demand tool discovery can reach the guide without additional Skills, resources or prompts.
- Extend `work_items_get` with optional `input.activityLimit` / `activityCursor`; ordinary detail reads stay small. The catalog remains 46 tools including 12 work tools, with no new token scope. The first upgrade needs updated gateway metadata; later module or guidance settings do not require a replacement token.

### Work creation, location and feedback

- Move work search into the contextual header beside the view switch. Remove the redundant project-reset label and unused desktop toolbar row; retain responsive project controls and explicit item-location filters.
- Preserve the complete creation context and linked resources when discarding edits. Guard project, attention and archive switches, inherit the selected project/status/attention, and immediately adopt newly saved projects. Disable creation in archived views or archived projects.
- Show newly created items at the beginning of their full active status column without changing existing relative order. Follow the saved item's actual scope and clear blocking search filters; list creation and the detail Locate action use an explicit, removable exact-item filter. Replace source-create URLs with the saved item link and provide Copy link.
- Reuse the existing temporary application confirmation for item/project/status saves instead of duplicate permanent banners. Keep actionable errors, conflicts and unknown write outcomes visible. Show creation and update times in item details.
- Add optional create-only `placement:start|end` and query `itemId` to the existing HTTP/MCP contracts. Omission/end retains legacy append behavior and historical creation hashes; replay does not reposition work. Exact lookup intersects all filters and preserves authorization. These two extensions require no separate migration or additional MCP tool; the complete release includes migrations 016–017 described above.

## [0.2.0] - 2026-11-13

### Board layout and dynamic workflow

- Place navigation's View all entry in one card slot instead of spanning the full grid row. Release unused auto-fit tracks on wide screens while retaining configured preview limits, bookmark order, keyboard folder access and directory presentation.
- Move the current board scope, Board/List toggle and New item action into the header. Keep search above the content, constrain horizontal scrolling to status columns and support 2560×1440, 1920×1080, 1600×900 and 2560×1080 layouts. Reuse the browser's Home theme preference and check lightweight revisions while preserving editors, drafts, dragging and loaded pages.
- Maintain space-wide status names, colors, descriptions, order and default through one revision-checked batch. Stable IDs retain Todo/Doing/Waiting/Done/Canceled semantics independently from names, attention and archive flags. Preserve current four states on upgrade; projects use the same space catalog.
- Retire a status only with a valid remaining default and, when occupied, an explicit destination. Migrate active and archived items atomically, retaining references and destination ordering. Retired IDs cannot be reused. Preserve local drafts on configuration conflicts and merge only intended changes against a freshly read catalog.
- Resolve omitted item status from the current default, while preserving successful creation replay across default changes and retired states. Keep compatibility with creation hashes saved by earlier releases.

### Access-token lifecycle

- Edit an existing token's name, action selection and expiry without replacing its secret, bound space/source or MCP configuration. Add optional Never expires and an explicit All permissions mode that includes future supported business actions within the same binding and current account permissions. Existing tokens retain selected permissions and finite expiry.
- Serve permission options and dependencies from one backend catalog used by creation, editing and authentication. Apply increases and reductions to subsequent HTTP/MCP requests using the original token; all permissions never grants account/token administration or bypasses space, source, account-version or site-epoch checks.
- Require an explicit new expiry or permanent choice to renew expired tokens; revoked or security-invalidated tokens cannot be reactivated. Preserve Cookie ownership and CSRF checks, reject PAT credential management and protect edits with revisions. Keep drafts on conflicts or uncertain responses.
- Keep the existing DELETE token route as revocation. Add a separate owner-only, revision-checked deletion of already-revoked records; active tokens cannot be removed through that path. Revocation remains effective for permanent tokens.

### HTTP and MCP contracts

- Add work_statuses_get and work_statuses_batch_edit: twelve work tools and 46 total tools. Typed arrays/objects, catalog metadata, stable-ID descriptions and concrete recovery messages support agents without extra Skills. State edits do not change tool schemas or require new tokens.
- Keep Home tools/list independent of action scopes; insufficient grants are rejected at invocation. Editing a Home token does not refresh an MCP gateway's discovered, published or authorized tool catalog. Verify the actual Home connection and rediscover new tool definitions in the gateway when upgrading.
- Include real active/archive usage counts only in status catalog reads and saved configuration responses; board/list/detail metadata do not fabricate unqueried counts. Preserve write-only operational receipts and avoid readable error details without read permission.

### Upgrade and rollback

- Add separately maintained SQLite/PostgreSQL migrations 014 (work_statuses) and 015 (integration_token_management). Preserve work items, references, revisions, original creation hashes and existing token secrets/bindings. Existing tokens default to selected permissions and retain their expiry; no implicit expansion to all permissions or permanent validity.
- Back up complete database/data, matching keys and deployment configuration before upgrading; mounted originals require their own backup. Returning to 0.1.1 or earlier requires the matching pre-upgrade restore set. Changing only the image tag or removing migration records is not a rollback. No new mount, service or environment variable is required.

## [0.1.1] - 2026-11-13

### Homepage controls

- Put Library and Board directly in the header, move secondary homepage actions into the avatar menu, and remove the separate More and manual Refresh controls. Retain click statistics, layout, management, card/directory modes, available visitor actions and unsaved-draft guards.
- Provide a dedicated sun/moon theme button and keep the avatar menu in the homepage palette. Remember the viewing preference in the current browser, scoped to account and access mode, without writing page configuration or overriding layout previews. Preserve accessible control names, keyboard menu interaction and responsive layouts.

### Personal avatars

- Add image selection, preview, explicit save/cancel and avatar removal in My profile. Update the account avatar after a confirmed save and retain it across reload and sign-in; failed or conflicting saves keep the draft and existing stored image.
- Add Cookie-authenticated current-account avatar GET/PUT/DELETE endpoints and avatar metadata in user responses (empty strings when no avatar is set). Mutations require CSRF and the expected image digest; reject PAT access, invalid images and stale replacements. Decode and normalize bounded PNG/JPEG uploads before atomic database storage.
- Keep existing display-name/password/session controls and HTTP/MCP work/navigation permissions. Avatars do not become space assets or public images, and no additional MCP tool or credential grant is required.

### Upgrade and rollback

- Add separately maintained SQLite/PostgreSQL migration 013 (account_avatar). Preserve existing accounts, sessions, navigation, documents, work items, page configuration and click records; no new mount, service or environment variable.
- Back up the complete database/data, matching keys and deployment configuration before upgrading, with mounted originals backed up separately. Returning to 0.1.0 or earlier requires the matching pre-upgrade restore set; changing the image tag or removing migration records is not a rollback.

## [0.1.0] - 2026-11-13

### Work board and resource continuity

- Add a lazy-loaded work board in Library, with a Home More entry, shared list/board data, project grouping and search. Four states cover Todo, Doing, Waiting and Done; Needs attention is an independent filter. A title is the only required content field.
- Create work from bookmarks or documents, retain original files, and add optional next steps/results. Archive and restore projects and items separately; project archive keeps open items in All items. Completing work does not require a result form.
- Save fields with per-item revision checks. Move by stable ID and a real destination anchor, preserving hidden and unloaded siblings. Keep drafts on conflicts and uncertain responses for comparison before a deliberate retry.

### HTTP, MCP and private working data

- Reuse HTTP handlers for MCP work operations with independent work:read/work:write actions; existing tokens gain no permissions. Require a signed-in space editor and reject source-bound tokens. Extend discovery with ten uniquely named work tools while retaining the existing catalog, and align its integration acceptance contract.
- Validate bookmark/document references with their respective read scopes and current-space ownership. Work access does not grant document content access. Write-only callers receive operational receipts.
- Use stable creation IDs, replay the same normalized intent without duplicate insertion, and reject ID reuse with different content. Bind pagination cursors to filters and board revision.
- Page column summaries and resource selection, defer board code, and keep Markdown bodies and external service calls out of board reads.

### Upgrade and rollback

- Add SQLite/PostgreSQL migration 012 (work_board) for projects, items, references, revisions and indexes. Preserve existing navigation, documents, page configuration, click history and deployment settings.
- Back up complete database/data, local keys and configuration before upgrading; mounted originals remain separately backed up. Returning to 0.0.11 or earlier requires the matching pre-upgrade backup, not just an image-tag change or removed migration records.
- No additional service, mount, environment variable or AgentOS dependency. Rediscover the upgraded MCP catalog when enabling new actions; old credentials retain their grants.

## [0.0.11] - 2026-11-13

### Homepage bookmark maintenance

- Add bookmark deletion to both homepage cards and the content inspector, using the existing button-side confirmation. Deletion joins the same draft as creation, field edits and moves; Undo, Redo and Cancel apply before one explicit atomic Save.
- Start a bookmark drag from the card body as well as its handle. Keep category, empty-group and sidebar destinations, complete hidden/paginated sibling order, and existing category drag behavior. Favorite cards can move the original bookmark without introducing a separate favorites ordering.
- Compare pending deletions with a fresh navigation read. If another editor changed the bookmark, require a choice to keep it or continue deleting it. A missing bookmark on readback confirms that the deletion is already satisfied; an uncertain response is never automatically replayed.

### Atomic HTTP and MCP editing

- Add optional `deleteLinkIds` to `navigation/batch-edit` and `navigation_batch_edit`, sharing the existing `expectedRevision`, permissions, Cookie CSRF checks and combined 500-operation limit with creates, patches and moves.
- Reject duplicate, missing or foreign deletion IDs, a bookmark both deleted and created/patched/moved, and a deleted move anchor. Validate and commit the complete batch transactionally; a failure rolls back deletions along with every other change.
- Return optional `deletedLinkIds` for confirmed submitted IDs, including write-only receipts. `updatedCount` counts created/changed surviving rows and excludes deleted bookmarks. A changed batch advances navigation revision once. Clients remove those IDs and merge all returned rows into their next baseline.

### Upgrade and rollback

- No new SQLite/PostgreSQL migration, mount, environment variable or deployment setting. Retain existing data, keys, document mounts, language and HTTP/TLS configuration. Gate or other MCP clients using the new batch-delete field must rediscover the running upgraded Home schema.
- Saved bookmark deletion uses existing cascades for click statistics, alternate URLs and document relations; it does not delete original Markdown files or attachments. Undo is available while the deletion remains a draft, not after Save. Reverting the image does not recover deleted records; use a matching data backup when recovery is required.
- Compatibility rules from 0.0.10 still apply when reverting farther back: saved component bindings may contain `auto:true`, which older page validators reject. Preserve a compatible page configuration and matching data backup.

## [0.0.10] - 2026-11-04

### Navigation maintenance and click statistics

- Add categories and bookmarks in homepage Edit, including links in newly drafted categories. Undo, redo and cancel apply to pending creations. One revision-checked `navigation_batch_edit` can create rows with stable IDs, patch fields and apply moves atomically. The same 500-operation limit and write-only receipt rules apply.
- Compare the intended ordering changes on re-read. Adding or rearranging unrelated siblings no longer forces an order decision for a rename; tied legacy order and real field or position conflicts remain protected. A stale revision triggers a read for comparison, never an automatic write retry. A read after an uncertain response recognizes saved creations by their IDs.
- Align bookmark and alternate-link URL inputs with the server’s 4,096-byte UTF-8 limit. A supported long URL no longer blocks an unrelated title or category edit.
- Count actual primary, alternate and related-bookmark opens in Library alongside homepage activations. Keep previews, probes and MCP reads out of the totals; the zero-click label describes missing observations. Preserve the historical recording baseline and existing aggregates without backfilling new entry points.

### Document safety and Library

- Pause original-file mutations after a failed or offline scan, including create, edit, rename, delete and history restore. Browser and MCP destination discovery agree with the server. An unexpectedly empty or largely missing mount retains its last index; check the mount and rescan before resuming writes. A genuinely empty, newly registered healthy directory remains writable. This uses the observed scan state and does not claim continuous mount-identity detection.
- Keep a bookmark note’s revision with its original draft, including across Library refresh, so a newer note cannot be overwritten using a refreshed timestamp. Conflicts retain the draft.
- Start new documents in the selected writable subfolder, use the configured default from the overview, and require a deliberate change of destination when the selected source is not writable. Remove the duplicate Recently updated view; All resources remains sorted by update time.

### Components, tokens and setup

- Reuse compatible enabled sources for single-component insertion in both layout editors. Use a unique match directly; choose between multiple matches, or create a source in context when authorized. Keep the page layout in its existing explicit-save draft.
- Resolve displayed dashboard snapshots only for bindings referenced by a component. Release unreferenced editor-created `auto:true` bindings on removal or rebind; preserve manual and legacy bindings, shared references, hidden views that still reference data, and independent sources/snapshots.
- Let a source-scoped token select `sources:read` and `datasets:write` independently, subject to space access. Selecting an external push source defaults to read-only; existing tokens keep their grants.
- Make the connection test optional during first-run PostgreSQL setup. Saving still validates the target and checks storage conflicts before initialization; SQLite and previously configured installations keep their existing flow.

### Upgrade and rollback

- No new database migration, mount, credential or deployment setting. Keep data, keys, storage selection, mounted originals, language and HTTP/TLS configuration. Recheck gateway tool definitions after upgrading the actual Home instance if batch-create fields are needed.
- New layouts may store `auto:true` on a binding, which older strict page validators reject. Keep a matching pre-upgrade database/data backup and page configuration before updating. Restore a compatible configuration/data set before reverting to the older binary or image; a tag change alone does not restore it. Back up and reconcile mounted Markdown and attachments separately.

## [0.0.9] - 2026-11-04

### MCP space and directory discovery

- Let space-scoped MCP calls omit `spaceId` and use the space of the PAT authenticated for each request, including the first call. Add read-only `space_current` to return that space's ID, name and kind. Explicit IDs retain account, space, source and action checks; existing tokens gain no actions.
- Add `document_sources_list` to discover enabled directories, including empty ones, within authorized working-document access. Return directory IDs, names, read/write availability, defaults and last observed status without absolute mount paths. Document creation uses a configured default or an explicit discovered destination; a missing default and a read-only target return distinct recoverable errors.
- Let read-only list and statistics tools omit optional filter `input` objects. Required resource IDs and mutation inputs remain validated, and explicit `null` is rejected. Optional filter objects emit valid JSON Schema, and document search advertises its supported range.

### Read failures and permission-safe responses

- Make MCP `documents_get` distinguish a genuinely empty file from a missing, unavailable or unsupported original. Retain authorized HTTP library metadata without inventing an empty body; keep history available and offer restoration for eligible missing files. Published readers continue to receive the frozen snapshot.
- Limit write-only navigation and source responses to operational receipts. Read/write callers retain their authorized fields. HTTP and MCP batch errors preserve permitted row/field details while withholding targets not submitted by a write-only caller.

### Upgrade

- Add no database migration or deployment setting. Preserve existing data, keys, storage selection, document roots/mounts, publication choices and click recording history; older installations apply only their missing existing migrations.
- After updating the running Home instance, rediscover its MCP schemas and publish the newly discovered tools to the intended callers in Gate or another gateway. Refresh client definitions and verify authorized calls; publishing a gateway catalog alone does not upgrade Home.

## [0.0.8] - 2026-10-29

### Homepage controls and persistent page chrome

- Reduce the top-right controls to Edit, More and the account menu; place space selection beside the title. Group Library, click statistics, layout editing, refresh and temporary display choices in an accessible, themed menu. Preserve permission checks, native new-tab links and unsaved-draft guards.
- Keep the site header, enabled custom header and footer in view while the page body scrolls. Apply the same bounded layout to content editing and composer previews, keep editor controls available, and reserve space rather than cover the first or last links. Existing header/footer visibility settings remain authoritative.
- Size sticky category areas to the actual content viewport and route category/link drag scrolling through its scrollable ancestors. Bound long custom chrome and conflict feedback so their content remains reachable without pushing the page body out of view.
- Keep the 0.0.7 database schema, click recording baseline, API/MCP contracts and deployment settings unchanged. Earlier releases apply only missing existing migrations; retain the original data, keys, mounts and storage configuration when updating the container.

## [0.0.7] - 2026-10-29

### Homepage content editing

- Make **Edit** on the homepage open a content draft for local navigation. Rename categories inline, edit link/category fields in a compact side panel, and use Undo/Redo, cancel or one explicit revision-checked save. Retain drafts on validation failures, concurrent changes and uncertain responses; read back before retrying and recognize already committed changes.
- Add handle-based sibling category ordering, link ordering and cross-category moves, including empty/uncategorized targets. Preserve complete hidden/paginated link sequences, folder search and paging; keep category subtrees together. Favorites edit original links without creating a separate order.
- Keep the existing page composer at **More editing options → Adjust layout**. Guard unsaved transitions and retain separate content/page revisions and save histories. Existing creation, deletion, imports and bookmark usage notes remain available through management.
- Extend atomic navigation editing with stable-ID moves after field patches. Limit requests to 500 operations while returning every normalized affected row, including large sibling groups. Expose `navigation_get` and `navigation_batch_edit` through the existing scoped MCP transport.

### Link click statistics

- Record local bookmark activation counts, first/last click timestamps and daily UTC aggregates independently of navigation and page revisions. Cover ordinary, keyboard, modified/middle and explicit alternate-entry clicks; editing, previews, folder browsing and external snapshots do not create counts. A click records an opening action, not successful remote loading or a unique visitor.
- Add a signed-in statistics dialog with date/category filters, rankings, zero-click links and pagination, plus a read-only link summary in the content inspector. Expose the same authorized aggregate data through HTTP and `navigation_click_stats` for Agent analysis.
- Add additive SQLite/PostgreSQL migration `011_link_clicks.sql`. Preserve existing business records and mark the recording baseline; dates before it and in the future are untracked. Group history by current link categories and remove a deleted link's counters with that link.
- Use server timestamps and 24-hour idempotency receipts without storing visitor identities, IP addresses, user agents or referrers. Browser reporting requires current space read access and CSRF; bearer reporting is rejected. Reading aggregates requires a signed-in account and readable space, with `navigation:read` for PAT/MCP.
- Keep existing data paths, keys, mounts, storage choices and HTTP/TLS settings. Upgrade counts start at zero without fabricated history. Back up the matching database/data, keys, originals and deployment configuration before upgrading; returning to 0.0.6 requires its pre-011 backup.

### Unraid template maintenance

- Refresh the installation overview for composable document activity and first-run SQLite/PostgreSQL selection. Replace the stale 0.0.5/migration-008 text with a link to release-specific upgrade guidance, and include external databases in the backup requirements.
- Clarify in both Unraid guides how to distinguish Apps/saved-template descriptions from the running Home version, and repository publication from catalog refresh. Template runtime settings and published images are unchanged; existing installations can update their image without replacing the complete saved template.

## [0.0.6] - 2026-10-27

### Composable document activity

- Add three repeatable homepage presets—document heatmap, heatmap with records, and monthly calendar—using one built-in component. Keep existing pages unchanged and expose the same independent per-instance filters and display settings in the homepage inspector and admin layout editor.
- Reuse the 24-column placement model, fit-content/fixed heights, drafts, Undo/Redo and explicit revision-checked saves. Link selected dates only through an explicit interaction group; duplicated activity components start independent, and browsing dates/details never writes shared page configuration.
- Record real document changes with authenticated Web/API/MCP attribution and authorless external observations, including content observed during publication before a scan. Count distinct created/edited/restored documents per local day; retain rename/delete/metadata details separately from heat counts. Initial scans establish a recording baseline without fabricating history from old file timestamps.
- Read activity through one cached, deduplicated provider and a scoped read-only HTTP/MCP query. Shared dashboards expose only an empty schema marker; anonymous and published-snapshot-only readers receive no working-document activity. Preserve existing anonymous open-edit page configuration behavior.
- Add authorized document/space deep links into Library, clear stale previews on read failures, and support activity templates through the existing local binding without external-source credentials.
- Add SQLite/PostgreSQL migration `009_document_activity.sql`, focused regression coverage and [usage/maintenance guidance](docs/DOCUMENT_ACTIVITY.md). Existing pages keep their composition; add the presets through the component library.

### Login retention and personal accounts

- Add temporary 12-hour, remembered 7/30/90 idle-day and Owner-enabled until-sign-out login modes. New browser logins default to 30 idle days; legacy requests and existing sessions retain their original temporary deadlines. Visible user activity can renew a permitted session; background polling and PAT/MCP traffic do not extend it.
- Add versioned Owner session policy and personal session listings/revocation. Tightening a policy constrains existing sessions; relaxing it does not revive expired access. Until-sign-out has no server idle deadline and uses a renewable 365-day cookie; browser storage and explicit account actions still determine access.
- Support display-name maintenance and current-password-verified password changes with stale-edit detection. Rotate the current permitted session and revoke other sessions and access tokens after a successful password change. Do not issue successful cookies for failed handlers or failed transaction commits.
- Preserve accessible private edit drafts across same-account reauthentication without replaying a save. Explicit sign-out and account changes clear those drafts. Serialize cookie-changing operations to prevent renewal responses from undoing a password change or logout.
- Recheck identity before refreshing private content when a tab becomes active. Ignore stale bootstrap/CSRF responses after session changes, retain same-account form drafts, and clear old account activity and homepage drafts after a shared-cookie account switch.

### Inline navigation editing and category folders

- Edit category and bookmark fields directly in the management lists. Keep drafts across pages and both lists, save up to 500 changed records in one atomic revision-checked request, and preserve input after validation errors, conflicts or uncertain responses until server state is reconciled.
- Add field-grouped Undo/Redo, changed-only filtering, Tab/Enter/Shift+Enter navigation, IME composition handling and row-detail changes that join the same draft. Existing bookmark context notes and document associations remain part of their established contracts.
- Preview six bookmarks per category by default, with a folder icon, remaining count and View all entry. Browse the complete category in a responsive multi-column folder with search, 24-item pages and restored focus; favorites retain their full display.
- Expose category preview limits (All, 4, 6, 8, 12, 24) in both layout editors. These presentation limits do not truncate navigation datasets, management lists or exports.

### Storage initialization and recovery

- Add pre-database setup for Docker, Linux and source runs, offering SQLite or external PostgreSQL, read-only connection tests and private atomic storage configuration. Existing explicitly configured or detected SQLite instances retain their storage target when upgraded.
- Preserve database identity, instance leases and local signing/encryption keys across restarts. Refuse silent SQLite fallback, unrelated populated databases and missing provisioned stores; provide same-target recovery without exposing connection secrets.
- Remove forced SQLite from the normal image, Compose example and development launcher so a genuinely new unconfigured instance can choose its database. Keep existing explicit environment/flag precedence and the one-time instance-language behavior.
- Combine the development launcher's verified HTTPS checks with storage setup/recovery states. Certificate failures stop only its newly started child; a reachable database-recovery page keeps its verified process available for retry.

### Management layout and icon clarity

- Merge management page titles into the top bar, place the global space selector beside the account menu, and group content, current-space and site settings. Move space maintenance out of import/export and add personal profile/session entry points.
- Align category labels with controls, keep optional explanations in accessible click-open help, and keep component-library actions within the editor sidebar. Preserve focus when compact drawers hand off to preset/import dialogs.
- Standardize built-in, imported and selected picker icons at 24 by 24 CSS pixels, with fixed even-width cells and consistent labels. Preserve original SVG assets and saved icon references.

### Upgrade and release maintenance

- Keep the published `008_document_library.sql` migration unchanged, add document activity as `009_document_activity.sql`, and introduce login retention as `010_session_retention.sql` for SQLite and PostgreSQL. Preserve original document mounts, database contents, local storage configuration, instance identity and signing/encryption keys.
- Handle the exact previously unshipped `008_session_retention.sql` schema through a validated transactional migration bridge. Verify its original checksum and actual schema before reconciling the official migration chain; reject altered or unknown migrations rather than guessing an upgrade path.
- Add upgrade checks for public 0.0.4 and 0.0.5 images, including existing accounts, navigation, document metadata, publication snapshots/attachments, first-scan activity baselines and post-upgrade writes. Database rollback requires the matching pre-upgrade database/data and original-document backup, not merely an older image tag.
- Include the new frontend core, storage initialization/recovery and external PostgreSQL checks in the release CI. Keep Linux amd64 downloads and the offline Docker archive derived from the same tested image, with matched source, release notes and checksums.
- Upload the four credential-free HTTP/storage acceptance summaries from the hidden runtime directory through an explicit file allowlist, so successful hosted checks retain downloadable evidence without including test databases or private configuration.
- Exercise the extracted Linux bundle's initial storage choice, private saved configuration, instance keys and restart with its actual default paths. Exclude the known private session/inline-edit design file from Git archives, Docker contexts and application/source packages.
- Record the required direct-main workflow in `AGENTS.md`: do not create task branches without an explicit user request, inventory pending local work before releases, and remove task branches after verified integration.

## [0.0.5] - 2026-10-25

### File-backed library and bookmark usage notes

- Keep the navigation homepage and add a unified Library for bookmarks and Markdown, including source/folder filtering, content search, previews, original-file editing, copy creation, tags and bookmark relationships. Add optional `contextMarkdown` usage notes with a narrow revision-checked update endpoint; legacy updates that omit notes preserve them.
- Connect existing Docker/host directories through an explicit `LINGSHU_DOCUMENT_ROOTS` allowlist. Support multiple non-overlapping directories per space, read-only or writable sources, one default write location per space, and centralized directory settings. Owner-session registration is limited to already editable spaces; agents and Members cannot grant themselves server-path access.
- Scan originals without rewriting them. Combine filesystem notifications, periodic scanning and manual checks, retain metadata on disconnect or missing mounts, detect unambiguous external renames, and require confirmation before marking widespread missing files. Collect file contents outside global navigation/database locks and apply bounded index updates separately.
- Check body revisions against original files, protect metadata with a separate revision, retain browser drafts on conflicts, and keep bounded recovery copies before overwrites/deletions. Disconnecting a source never deletes originals. Report file/index partial completion explicitly instead of implying a failed response left the file unchanged.
- Require explicit publication of shared-space documents. Freeze published Markdown, metadata and referenced attachments; later external edits remain private until re-published. Apply document/space authorization to all attachment reads and use safe Markdown rendering without executable raw HTML.
- Add scoped document HTTP/MCP operations and `documents:read` / `documents:write` permissions. Writing requires both; old tokens do not gain scopes automatically. Document text is data, not an authorization instruction.
- Add separately maintained SQLite/PostgreSQL migration `008_document_library.sql`, deployment overrides, backup/rollback instructions and focused filesystem, permission, publication, concurrency, MCP and browser regressions. Back up original document directories together with the database, instance keys and recovery-history directory before upgrading.

### Transport encryption

- Add optional direct HTTPS using `LINGSHU_TLS_CERT_FILE` and `LINGSHU_TLS_KEY_FILE`, with matching flags, certificate-pair validation before opening business storage, TLS 1.2 minimum and no plaintext fallback after a TLS error. Retain loopback HTTP for existing local deployments; direct TLS automatically marks browser cookies Secure.
- Document HTTPS reverse-proxy deployment, protected upstreams, certificate renewal, and the separate host-to-NAS and at-rest encryption boundaries. Do not trust arbitrary forwarded headers or label a bind mount as encrypted.
- Make the development helper verify HTTPS health with normal CA/hostname checks when TLS is configured, and clean up only its own failed startup process. Add real TLS handshake and launcher regressions.

### Docker upgrades and Unraid configuration

- Preserve existing `/data`, account/navigation data, saved instance language, and HTTP startup when upgrading from 0.0.4. Migration 008 runs on first start; document roots remain disabled (`[]`) and direct TLS remains off until configured. Back up data and matching keys first; rollback requires the matching pre-upgrade database/data and old image.
- Extend the Unraid template with optional advanced document-root and TLS certificate/key variables, retain `latest` and the existing HTTP WebUI defaults, and explain multiple document Path mappings and the HTTPS WebUI change. Existing installed containers retain their saved settings; add new mappings/variables explicitly when enabling these features.
- Keep original document mounts and certificates separate from `/data`. Docker/Unraid updates pull and recreate the container with the original storage, ports and settings; a restart alone does not load a new image or mount configuration.
- Extend the actual container gate with a public 0.0.4-to-candidate upgrade using the same data volume, old-data/key comparisons and existing session/PAT checks. Exercise writable/read-only Markdown mounts and verified direct HTTPS on the candidate image, including missing-mount retention and reconnect behavior.
- Let consecutive container checks reuse a just-closed loopback port without treating TCP `TIME_WAIT` connections as an active service; retain rejection of real listeners and cover both cases with socket regressions.

### Release verification

- Keep disposable release-documentation Git fixtures, including shallow clones, free of automatic background maintenance through command-local Git settings. Retain strict temporary-directory cleanup and all release assertions; host Git settings and production release validation are unchanged.

## [0.0.4] - 2026-10-25

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

- Keep the simulated proxy tunnel open until its client closes it. This removes a test-fixture lifetime race between a successful CONNECT and deadline reset under `go test -race`, without changing production routing or destination rules.
- Publish these changes as 0.0.4. The earlier v0.0.3 tag failed this verification gate before packaging; preserve that tag and its failed run, and do not publish a 0.0.3 image or GitHub Release.
- Require every release to update both English and Chinese READMEs and the matching dated CHANGELOG entry. Keep current version, release/download links, fixed-image examples, feature scope and upgrade guidance aligned; release notes are generated from that entry. Enforce this in the repository release checks and document it in AGENTS.md and the release guide.
- Include the navigation-content core regressions in application CI alongside the existing routing, page-preset and startup-space checks.
- This version adds no database migration and retains page Schema 2. Upgrading from 0.0.2 keeps the same database and instance-key paths. Back up before upgrading; if a page saves new component settings, restoring a pre-upgrade database/key backup is the supported way to return to 0.0.2 because its older page validator does not accept these new fields or added built-in icon IDs. Upgrading directly from 0.0.1 still requires migration 007 and retaining the original language on the first upgraded start.

## [0.0.3] - 2026-10-25

### Publication stopped by verification

- The tagged application CI failed the new proxy-boundary fixture under the Go race detector. Packaging, the registry push and GitHub Release publication did not run. The tag and failed workflow remain available for traceability.
- The intended navigation, icon, space and component changes are first released together in 0.0.4 after the fixture correction and complete release verification.

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
