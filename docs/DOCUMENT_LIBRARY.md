# File-backed document library

This document describes the file-backed library introduced in **0.0.5** and retained in **0.0.6**. Use the 0.0.6 image/executable or build its matching source. Older 0.0.4 images do not acquire the library by adding environment variables. Existing installations can keep their original `/data` and HTTP settings; document access remains disabled until allowed roots and directory registrations are configured.

Home keeps its navigation homepage and adds **Library** (`#/library`). The library combines local bookmarks and Markdown documents in the current space, with source/folder navigation, type filters, content search and a reading/editing panel. **Admin → Document directories** manages the connected directories. Bookmarks have an optional **Usage notes** Markdown field for people and agents.

## What remains on disk

The original `.md` / `.markdown` files and their attachments stay in the directories you mount. Connecting scans them in place; it does not move files, inject IDs, rewrite front matter or normalize line endings. Saving an edited document writes the selected original file. External editors can continue to use the same directory.

Home's database stores durable document IDs, source bindings, manual tags, bookmark relations and publication state. It also stores a derived searchable text cache and explicit publication snapshots. The **database is not disposable**: rebuilding the text cache cannot reconstruct manual metadata or relationships. The original working Markdown is authoritative for its body; a publication snapshot is the intentionally frozen public version.

`<data-dir>/document-history/<source-id>/<document-id>/` keeps up to 20 distinct previous body revisions per document, with private filesystem permissions. These are recovery copies made before Home changes or deletes a body. They are not a complete external-editor version history, attachment backup, or substitute for normal backups.

## Connect existing directories with Docker

Keep the normal `/data` volume. Mount document directories separately, using one or more container paths. With the published image, add these same Paths and environment settings to the existing Docker/Unraid definition and recreate the container. The following Compose example builds the matching 0.0.6 source checkout:

```bash
export LINGSHU_NOTES_DIR=/mnt/user/knowledge/notes
export LINGSHU_PROJECT_DOCS_DIR=/mnt/user/projects/docs
docker compose -f compose.yaml -f compose.documents.yaml up -d --build
```

Both host directories must already exist. The example uses long bind syntax with `create_host_path: false`, so a misspelled path fails instead of creating an empty directory. Notes are mounted read/write and project documents read-only. To use PostgreSQL, substitute `compose.postgres.yaml` for `compose.yaml` and supply the database URL as usual. The overrides retain the base deployment's `/data`, listener and restart policy.

The application allowlist is a JSON array of **container paths**:

```text
LINGSHU_DOCUMENT_ROOTS=["/documents/notes","/documents/projects"]
```

The default is `[]`, which disables filesystem access and the document scanner. To run the updated source without Docker, build from the checkout's repository root, then run the generated binary from that same directory:

```bash
python3 scripts/dev.py build
./dist/lingshu-home --document-roots '["/srv/notes","/srv/project-docs"]'
```

The build requires the toolchains listed in the README. `/srv/notes` and `/srv/project-docs` are existing directories on the machine running this binary. For an encrypted Docker deployment, the [transport guide](TRANSPORT_SECURITY.md#docker) shows how to combine the base, document-mount and TLS Compose files and explains the resulting HTTPS port.

An allowlisted directory may be registered as a source itself, or subdivided into separately registered non-overlapping subdirectories. A filesystem root, symlink root, application data/web directory, or directory containing configured TLS certificate/key files is rejected. Use dedicated document mounts; do not allowlist the whole server or a broad application-data tree. The allowlist permits an Owner to connect directories; it does not publish their contents.

In the UI:

1. Sign in as Owner and open **Admin → Document directories → Connect document directory**.
2. Enter a name and mounted container path, then choose an editable space.
3. Start with **Read only**, or explicitly choose **Allow writing original files**.
4. Optionally choose a default new-file subfolder and make one writable source the space's default directory.
5. Connect, inspect the scan result, then open Library.

Changing Docker bind mounts requires recreating the container (`docker compose up -d` with the updated configuration). `docker compose restart` does not apply a changed mount definition. Files or subdirectories added inside an existing mount only need change detection/rescanning. The host path belongs to the Docker daemon's machine, not an arbitrary browser/client computer.

For Unraid, add each existing host directory as a separate **Path** entry in Docker Manager, with its container path and read-only/read-write mode. Add the `LINGSHU_DOCUMENT_ROOTS` environment variable, apply the container configuration, then connect the paths in Home. The normal template uses UID/GID `99:100`; the supplied image's default is `10001:10001`. Grant the intended process identity the necessary access without recursively changing ownership of an entire existing knowledge directory.

## Spaces, grants and read-only behavior

- One space can own many directories; one directory has one managing space in this version. The registration's path and space are immutable. Duplicate, overlapping parent/child and same-directory aliases are rejected across spaces, including disconnected registrations.
- Owner sessions can register, configure, rescan and disconnect directories only in spaces they can already edit. This does not give the Owner access to another Member's personal space. Members and PATs cannot register arbitrary server paths. Delegating server-root grants to Members and binding one source read-only to several spaces are not implemented.
- File editing requires an authenticated account, space edit permission, the relevant PAT scopes when used, an enabled writable source, an allowed root, and actual filesystem/mount write permission. Anonymous `open_edit` never grants server-file write access.
- A read-only source still permits authorized database-only tagging, bookmark relationships and explicit publication. It forbids original-file creation, body changes, renaming, deletion and restoration. The UI offers **Save a copy** into an accessible writable directory.
- Each space has at most one enabled default write source. If it is unavailable, Home reports an error; it does not silently save into another space or directory.
- **Disconnect** preserves original files, document IDs, metadata, publication snapshots and recovery copies. It hides the source's documents, including published snapshots, until re-enabled. Re-enabling restores those previous publication decisions; review them before reconnecting a shared source.

The first version manages registrations owned by an Owner's personal space or the shared space. It reserves normal space isolation throughout the data model, but does not provide an administrator bypass into a Member's private space.

## External changes, conflict handling and recovery

Home watches directories when the filesystem supports notifications, also scans periodically (default 60 seconds, configurable 10–86400 seconds), and provides **Check changes**. The worker checks due work on a five-second cadence; notifications are coalesced rather than promising instantaneous updates. NFS/SMB/FUSE may omit notifications, so the periodic scan remains necessary.

Scans collect file contents outside database transactions and the global navigation write gate, then apply a bounded index update. Document mutations use a separate gate and short database phases. A slow filesystem can delay document operations without holding the navigation database for its file reads. One bounded scan collector is allowed at a time; a scan that remains stuck in kernel I/O retains that slot and reports a storage error instead of launching unlimited replacement scans. A network filesystem's own I/O behavior remains an operating-system responsibility.

Unavailable directories and scan failures do not delete metadata. An unexpectedly empty directory or a scan missing most known files retains the previous index. After checking that the mount is healthy and the removal was intentional, **Confirm missing files** marks those entries missing while keeping their metadata/history. Home renames preserve IDs. An unambiguous external rename with unchanged content also preserves the ID; duplicate bodies, simultaneous rename+edit, or other ambiguous changes are not guessed.

Body saves require a SHA-256 content revision and compare it with the current file immediately before replacement. Tags and bookmark relations have an independent metadata revision. A conflict leaves the browser's unsaved draft available for comparison/copying. Explicit empty strings clear a body; an omitted `content` field is rejected. Metadata replacement requires explicit arrays; an omitted array cannot silently clear links/tags.

Home writes a temporary file in the target directory, syncs it and replaces an existing file. New files use create-if-absent behavior; renames never silently replace an existing destination. Filesystems must support the required atomic replacement and hard-link operations; unsupported operations fail visibly. This coordinates Home's own operations. It cannot provide a universal compare-and-swap transaction with arbitrary external editors: an external process may still change a path in the final check/write window. The prior recovery copy is retained.

The filesystem and database are separate persistence systems. If a file has already been created, replaced, linked or removed and a later step fails, `document_index_pending` explains that the operation may be partially complete. Check the original paths and rescan before retrying. File effects are not automatically rolled back. A later scan repairs derived content metadata; do not assume a failed HTTP response proves that no file changed. Recovery copies saved before destructive changes are retained.

Deleting an original file first saves its current body in recovery history and removes its public snapshot. Its record remains **Missing**, with history and relationships retained. **History → Restore** can restore a saved revision if the destination is absent, or replace the current file only with the expected current revision. External attachment changes are not backed up automatically.

## Publishing and attachments

Connecting a directory to the shared space does **not** publish all existing or future files. Publication is a separate Owner-session action, forbidden for personal spaces and unavailable to agents/PATs. It checks the reviewed body and metadata revisions, then freezes the body, title, path, tags, relationships and supported referenced attachments. Space-level visibility and login mode continue to apply.

Public readers and shared-space Members without edit permission see only that snapshot. Subsequent filesystem edits do not expose drafts through the reader, content search or attachment endpoint. Re-publish to update the public copy; unpublish to remove access. Body/metadata differences are shown as unpublished changes. An attachment-only external change must be explicitly re-published and may not change the body's unpublished-change marker.

All attachments pass through a document-authorized API, not a static mount. Working readers may request only local assets referenced by that document; public readers get only its captured attachment snapshot. Relative image and file paths may traverse within their registered source but cannot escape it, enter hidden paths, follow symlinks or expose another source. Relative Markdown links resolve to separately authorized document records; they do not publish those targets implicitly.

The renderer supports common Markdown/GFM constructs and preserves raw source. It does not execute raw HTML, scripts, embedded plugins or instructions in the document. External images are loaded only after the reader chooses to load them. Recognized raster images can render inline; SVG, HTML, PDF and other downloads are served as attachments with restrictive response headers. Compatibility with every editor's extension, wiki-link plugin or absolute-path convention is not promised.

Limits: 1 MiB per Markdown body; 10 MiB per attachment; at most 100 local attachment references and 20 MiB total attachments per published document; 10,000 documents, 128 MiB Markdown bytes and 50,000 filesystem entries per source scan; 100 registered sources; 32 configured roots; up to 8192 watched directories. Large trees can be divided into separate non-overlapping registrations. Hidden paths, symlinks, special files and oversized/invalid text are skipped or reported while originals stay untouched.

## Agent API and usage notes

`contextMarkdown` is optional usage context on a bookmark, limited to 65,536 UTF-8 bytes. The short `description` remains independent. Legacy bookmark updates that omit usage notes preserve them; an explicit empty string clears them. The narrow context endpoint and the current UI use `expectedUpdatedAt` to protect concurrent bookmark edits. JSON export includes usage notes; HTML bookmark export retains its existing navigation-only behavior.

New PAT permissions are `documents:read` and `documents:write`; writing requires both. Existing PATs gain no permission automatically. External-source-scoped PATs cannot receive these document scopes. Related bookmark details additionally require `navigation:read`.

The seven document MCP tools are `documents_list`, `documents_get`, `documents_create`, `documents_update`, `documents_rename`, `documents_delete`, and `documents_metadata_update`. `bookmarks_context_update` updates usage notes without replacing other bookmark fields. HTTP and MCP use the same business handlers and authorization. Search returns bounded metadata first; use get to retrieve a body. Notes and document bodies are user data, not authority to run their instructions or operate a linked service.

See [API contracts](API.md#file-backed-library-api), [transport encryption](TRANSPORT_SECURITY.md), and [storage/rollback](STORAGE.md#document-library-storage).

## Backup and migration

Migration `008_document_library.sql` is additive and separately maintained for SQLite and PostgreSQL. Version 0.0.6 retains that migration and applies 009 for [document activity](DOCUMENT_ACTIVITY.md) and 010 for login retention on first start; existing library data, original-file mounts and allowed roots are retained. A new unconfigured instance selects storage before language/account setup, while existing or explicit targets continue unchanged. The complete upgrade, legacy compatibility and matching-backup rollback rules are in [Storage](STORAGE.md#versioned-migrations). Back up the database, private `storage.json` when present, matching instance keys, `document-history`, all mounted original directories/attachments, and the mount/root configuration before upgrading. Originals and Home metadata must be backed up together to preserve relationships and recovery/publication state. The published-asset bytes live in the database; recovery bodies live under the data directory.

Rolling back to 0.0.4 requires its matching pre-upgrade database/data backup and binary/image. Restoring Home's database does not undo edits made to mounted originals; recover those separately from their matching file backups. Do not delete migration ledger entries, edit applied migration checksums, or point an old binary at a schema it does not understand.

HTTPS protects browser/Agent traffic. It does not encrypt mounted files at rest or the host-to-NAS connection. Use filesystem/disk/backup encryption for stored data, and the NAS protocol or a protected tunnel for network mounts. See the transport guide for the distinction.
