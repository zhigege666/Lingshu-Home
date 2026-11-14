-- Optional planning metadata does not require a new background worker.
ALTER TABLE spaces ADD COLUMN work_notifications_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE spaces ADD COLUMN work_notifications_revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE spaces ADD COLUMN work_relations_count BIGINT NOT NULL DEFAULT 0;
ALTER TABLE work_spaces ADD COLUMN next_number BIGINT NOT NULL DEFAULT 1;
ALTER TABLE work_spaces ADD COLUMN planning_revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE work_spaces ADD COLUMN views_revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE work_spaces ADD COLUMN metrics_started_at TEXT NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN number BIGINT NOT NULL DEFAULT 0;
ALTER TABLE work_items ADD COLUMN priority TEXT NOT NULL DEFAULT '' CHECK(priority IN ('','low','normal','high','urgent'));
ALTER TABLE work_items ADD COLUMN label_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE work_items ADD COLUMN assignee_name TEXT NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN assignee_user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN version_id TEXT NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN parent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN predecessor_id TEXT NOT NULL DEFAULT '';
WITH numbered AS (SELECT id,ROW_NUMBER() OVER(PARTITION BY space_id ORDER BY created_at,id) AS n FROM work_items)
UPDATE work_items SET number=(SELECT n FROM numbered WHERE numbered.id=work_items.id);
UPDATE work_spaces SET next_number=1+COALESCE((SELECT MAX(number) FROM work_items WHERE work_items.space_id=work_spaces.space_id),0),metrics_started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
CREATE UNIQUE INDEX work_items_number ON work_items(space_id,number) WHERE number>0;
CREATE INDEX work_items_priority ON work_items(space_id,archived,priority,status,sort_order,id) WHERE priority<>'';
CREATE INDEX work_items_assignee ON work_items(space_id,assignee_user_id,archived) WHERE assignee_user_id<>'';
CREATE INDEX work_items_version ON work_items(space_id,version_id,archived) WHERE version_id<>'';
CREATE INDEX work_items_parent ON work_items(space_id,parent_id,id) WHERE parent_id<>'';
CREATE INDEX work_items_predecessor ON work_items(space_id,predecessor_id,id) WHERE predecessor_id<>'';
ALTER TABLE work_statuses ADD COLUMN wip_limit INTEGER NOT NULL DEFAULT 0 CHECK(wip_limit BETWEEN 0 AND 10000);
CREATE TABLE work_labels (
 id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,name_key TEXT NOT NULL,color TEXT NOT NULL,archived BOOLEAN NOT NULL DEFAULT FALSE,
 revision BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,create_hash TEXT NOT NULL,
 UNIQUE(space_id,name_key)
);
CREATE INDEX work_labels_page ON work_labels(space_id,id);
CREATE TABLE work_versions (
 id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,name_key TEXT NOT NULL,project_id TEXT REFERENCES work_projects(id),target_date TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',
 archived BOOLEAN NOT NULL DEFAULT FALSE,revision BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,create_hash TEXT NOT NULL,
 UNIQUE(space_id,name_key)
);
CREATE INDEX work_versions_page ON work_versions(space_id,id);
CREATE TABLE work_item_labels (
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
 label_id TEXT NOT NULL REFERENCES work_labels(id),PRIMARY KEY(item_id,label_id)
);
CREATE INDEX work_item_labels_filter ON work_item_labels(space_id,label_id,item_id);
CREATE TABLE work_dependencies (
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
 blocked_by_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,PRIMARY KEY(item_id,blocked_by_id),CHECK(item_id<>blocked_by_id)
);
CREATE INDEX work_dependencies_reverse ON work_dependencies(space_id,blocked_by_id,item_id);
CREATE TABLE work_views (
 id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL,visibility TEXT NOT NULL CHECK(visibility IN ('private','shared')),definition_json TEXT NOT NULL,
 revision BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,create_hash TEXT NOT NULL
);
CREATE INDEX work_views_page ON work_views(space_id,visibility,owner_user_id,id);
CREATE TABLE work_notices (
 id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,subject_type TEXT NOT NULL,subject_id TEXT NOT NULL,occurrence_key TEXT NOT NULL,item_id TEXT NOT NULL DEFAULT '',code TEXT NOT NULL,message TEXT NOT NULL,
 count INTEGER NOT NULL DEFAULT 1,first_at TEXT NOT NULL,last_at TEXT NOT NULL,read_at TEXT NOT NULL DEFAULT '',
 UNIQUE(space_id,user_id,kind,subject_id,occurrence_key)
);
CREATE INDEX work_notices_page ON work_notices(space_id,user_id,last_at DESC,id DESC);
CREATE INDEX work_notices_unread ON work_notices(space_id,user_id,last_at DESC) WHERE read_at='';
CREATE TABLE work_metric_intervals (
 id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('cycle','blocked')),started_at TEXT NOT NULL DEFAULT '',ended_at TEXT NOT NULL DEFAULT '',valid BOOLEAN NOT NULL DEFAULT TRUE,outcome TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX work_metric_open ON work_metric_intervals(item_id,kind) WHERE ended_at='';
CREATE INDEX work_metric_closed ON work_metric_intervals(space_id,kind,ended_at) WHERE ended_at<>'';
CREATE INDEX work_activity_period ON work_activity(space_id,occurred_at,id);
