CREATE TABLE icon_assets (
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 digest TEXT NOT NULL,
 media_type TEXT NOT NULL CHECK(media_type IN ('image/png','image/svg+xml')),
 content BLOB NOT NULL,
 width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 512),
 height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 512),
 created_at TEXT NOT NULL,
 PRIMARY KEY(space_id,digest)
);
CREATE TABLE icon_packs (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 source_url TEXT NOT NULL,
 license TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(space_id,id)
);
CREATE TABLE icon_pack_entries (
 pack_id TEXT NOT NULL,
 space_id TEXT NOT NULL,
 icon_key TEXT NOT NULL,
 label TEXT NOT NULL,
 digest TEXT NOT NULL,
 source_sha256 TEXT NOT NULL,
 PRIMARY KEY(pack_id,icon_key),
 FOREIGN KEY(space_id,pack_id) REFERENCES icon_packs(space_id,id) ON DELETE CASCADE,
 FOREIGN KEY(space_id,digest) REFERENCES icon_assets(space_id,digest)
);
CREATE INDEX icon_pack_entries_asset ON icon_pack_entries(space_id,digest);
CREATE TABLE icon_favicon_cache (
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 origin TEXT NOT NULL,
 digest TEXT,
 source_url TEXT NOT NULL,
 checked_at TEXT NOT NULL,
 retry_at TEXT NOT NULL,
 last_error TEXT NOT NULL,
 PRIMARY KEY(space_id,origin),
 FOREIGN KEY(space_id,digest) REFERENCES icon_assets(space_id,digest)
);
