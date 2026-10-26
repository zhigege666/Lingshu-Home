ALTER TABLE document_sources ADD COLUMN activity_started_at TEXT NOT NULL DEFAULT '';
CREATE TABLE document_activity (
 id TEXT PRIMARY KEY,
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 source_id TEXT NOT NULL REFERENCES document_sources(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 action TEXT NOT NULL CHECK(action IN ('create','update','restore','rename','delete','metadata')),
 origin TEXT NOT NULL CHECK(origin IN ('web','api','mcp','external')),
 occurred_at TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 before_revision TEXT NOT NULL DEFAULT '',
 after_revision TEXT NOT NULL DEFAULT ''
);
CREATE INDEX document_activity_space_time ON document_activity(space_id,occurred_at,document_id);
CREATE INDEX document_activity_actor_time ON document_activity(actor_id,space_id,occurred_at);
CREATE INDEX document_activity_source_time ON document_activity(source_id,occurred_at);
