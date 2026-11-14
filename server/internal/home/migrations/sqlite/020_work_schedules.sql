-- Rules are templates; generated work owns its content and lifecycle.
ALTER TABLE work_items ADD COLUMN business_date TEXT NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN due_at TEXT NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN schedule_id TEXT NOT NULL DEFAULT '';
CREATE INDEX work_items_business_date ON work_items(space_id,archived,business_date,status,sort_order,id) WHERE business_date<>'';
CREATE INDEX work_items_due_at ON work_items(space_id,archived,due_at,id) WHERE due_at<>'';
CREATE INDEX work_items_schedule_date ON work_items(schedule_id,business_date,id) WHERE schedule_id<>'';
CREATE TABLE work_schedules (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 template_json TEXT NOT NULL,
 rule_json TEXT NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 archived BOOLEAN NOT NULL DEFAULT FALSE,
 missed_policy TEXT NOT NULL CHECK(missed_policy IN ('latest','skip','all')),
 overlap_policy TEXT NOT NULL CHECK(overlap_policy IN ('create','skip')),
 revision BIGINT NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 create_hash TEXT NOT NULL,
 user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 token_hash TEXT NOT NULL DEFAULT '',
 next_run_at TEXT NOT NULL DEFAULT '',
 last_run_at TEXT NOT NULL DEFAULT '',
 last_result TEXT NOT NULL DEFAULT '',
 last_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX work_schedules_due ON work_schedules(enabled,archived,next_run_at,id) WHERE next_run_at<>'';
CREATE INDEX work_schedules_space ON work_schedules(space_id,archived,created_at DESC,id DESC);
CREATE TABLE work_schedule_occurrences (
 schedule_id TEXT NOT NULL REFERENCES work_schedules(id) ON DELETE CASCADE,
 business_date TEXT NOT NULL,
 scheduled_at TEXT NOT NULL,
 item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
 result TEXT NOT NULL CHECK(result IN ('created','skipped','failed')),
 reason TEXT NOT NULL DEFAULT '',
 occurred_at TEXT NOT NULL,
 template_revision BIGINT NOT NULL,
 PRIMARY KEY(schedule_id,business_date)
);

-- SQLite CHECK changes require a table rebuild. Preserve all original rows,
-- revisions, attribution and indexes; no synthetic history is introduced.
CREATE TABLE work_activity_next (
 id TEXT PRIMARY KEY,
 item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 action TEXT NOT NULL CHECK(action IN ('create','update','move','archive','restore','status_migrate','status_definition')),
 origin TEXT NOT NULL CHECK(origin IN ('web','api','mcp','scheduler')),
 occurred_at TEXT NOT NULL,
 item_revision BIGINT NOT NULL CHECK(item_revision>=1),
 changes_json TEXT NOT NULL,
 session_json TEXT NOT NULL DEFAULT '',
 UNIQUE(item_id,item_revision)
);
INSERT INTO work_activity_next SELECT id,item_id,space_id,actor_id,action,origin,occurred_at,item_revision,changes_json,session_json FROM work_activity;
DROP TABLE work_activity;
ALTER TABLE work_activity_next RENAME TO work_activity;
CREATE INDEX work_activity_item_page ON work_activity(space_id,item_id,item_revision DESC);
