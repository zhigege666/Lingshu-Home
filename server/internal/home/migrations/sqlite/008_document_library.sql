ALTER TABLE links ADD COLUMN context_markdown TEXT NOT NULL DEFAULT '';
CREATE TABLE document_sources (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 path TEXT NOT NULL UNIQUE,
 read_only INTEGER NOT NULL DEFAULT 1 CHECK(read_only IN (0,1)),
 default_write INTEGER NOT NULL DEFAULT 0 CHECK(default_write IN (0,1)),
 default_folder TEXT NOT NULL DEFAULT '',
 scan_interval_seconds INTEGER NOT NULL DEFAULT 60,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 status TEXT NOT NULL DEFAULT 'pending',
 last_scan_at TEXT NOT NULL DEFAULT '',
 last_error TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX document_sources_space ON document_sources(space_id);
CREATE UNIQUE INDEX document_default_write ON document_sources(space_id) WHERE default_write=1 AND enabled=1;
CREATE TABLE documents (
 id TEXT PRIMARY KEY,
 source_id TEXT NOT NULL REFERENCES document_sources(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 relative_path TEXT NOT NULL,
 title TEXT NOT NULL,
 revision TEXT NOT NULL,
 metadata_revision INTEGER NOT NULL DEFAULT 1,
 size INTEGER NOT NULL,
 updated_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'ready',
 tags TEXT NOT NULL DEFAULT '[]',
 search_text TEXT NOT NULL DEFAULT '',
 published_revision TEXT NOT NULL DEFAULT '',
 published_content TEXT NOT NULL DEFAULT '',
 published_title TEXT NOT NULL DEFAULT '',
 published_path TEXT NOT NULL DEFAULT '',
 published_source_name TEXT NOT NULL DEFAULT '',
 published_at TEXT NOT NULL DEFAULT '',
 published_tags TEXT NOT NULL DEFAULT '[]',
 published_bookmarks TEXT NOT NULL DEFAULT '[]',
 UNIQUE(source_id,relative_path)
);
CREATE INDEX documents_space ON documents(space_id,updated_at);
CREATE TABLE document_bookmarks (
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 bookmark_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 PRIMARY KEY(document_id,bookmark_id)
);
CREATE TABLE document_published_assets (
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 path TEXT NOT NULL,
 mime_type TEXT NOT NULL,
 content BLOB NOT NULL,
 PRIMARY KEY(document_id,path)
);
