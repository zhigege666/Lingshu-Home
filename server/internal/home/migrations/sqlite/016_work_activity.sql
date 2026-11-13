ALTER TABLE work_items ADD COLUMN activity_started_at TEXT NOT NULL DEFAULT '';
-- The installation time is the honest baseline for existing items. Their
-- known created_at / updated_at values are retained, without invented events.
UPDATE work_items SET activity_started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
CREATE TABLE work_activity (
 id TEXT PRIMARY KEY,
 item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 action TEXT NOT NULL CHECK(action IN ('create','update','move','archive','restore','status_migrate','status_definition')),
 origin TEXT NOT NULL CHECK(origin IN ('web','api','mcp')),
 occurred_at TEXT NOT NULL,
 item_revision BIGINT NOT NULL CHECK(item_revision>=1),
 changes_json TEXT NOT NULL,
 UNIQUE(item_id,item_revision)
);
CREATE INDEX work_activity_item_page ON work_activity(space_id,item_id,item_revision DESC);
