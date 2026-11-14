-- Optional event automation and externally executed work. No rule/executor is enabled by migration.
ALTER TABLE spaces ADD COLUMN work_automation_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE spaces ADD COLUMN work_automation_revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE spaces ADD COLUMN work_automation_rule_count INTEGER NOT NULL DEFAULT 0 CHECK(work_automation_rule_count>=0);

CREATE TABLE work_executors (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 endpoint TEXT NOT NULL,
 private_network BOOLEAN NOT NULL DEFAULT FALSE,
 resource_key TEXT NOT NULL,
 poll_seconds INTEGER NOT NULL,
 timeout_seconds INTEGER NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 archived BOOLEAN NOT NULL DEFAULT FALSE,
 credential_cipher TEXT NOT NULL DEFAULT '',
 revision BIGINT NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 create_hash TEXT NOT NULL
);
CREATE INDEX work_executors_space ON work_executors(space_id,archived,created_at DESC,id DESC);

CREATE TABLE work_automation_rules (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 event_type TEXT NOT NULL,
 project_id TEXT,
 status_id TEXT NOT NULL DEFAULT '',
 template_json TEXT NOT NULL,
 executor_id TEXT REFERENCES work_executors(id),
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 archived BOOLEAN NOT NULL DEFAULT FALSE,
 revision BIGINT NOT NULL DEFAULT 1,
 user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 token_hash TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 create_hash TEXT NOT NULL
);
CREATE INDEX work_automation_rules_match ON work_automation_rules(space_id,event_type,project_id,status_id,id) WHERE enabled=TRUE AND archived=FALSE;
CREATE INDEX work_automation_rules_space ON work_automation_rules(space_id,archived,created_at DESC,id DESC);

CREATE TABLE work_automation_events (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 event_type TEXT NOT NULL,
 project_id TEXT,
 status_id TEXT NOT NULL DEFAULT '',
 source_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
 origin TEXT NOT NULL CHECK(origin IN ('external','work')),
 payload_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','processed','failed','skipped')),
 revision BIGINT NOT NULL DEFAULT 1,
 user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 token_hash TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 processed_at TEXT NOT NULL DEFAULT '',
 code TEXT NOT NULL DEFAULT '',
 message TEXT NOT NULL DEFAULT '',
 create_hash TEXT NOT NULL
);
CREATE INDEX work_automation_events_pending ON work_automation_events(created_at,id) WHERE state='queued';
CREATE INDEX work_automation_events_space ON work_automation_events(space_id,created_at DESC,id DESC);

CREATE TABLE work_executions (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
 executor_id TEXT NOT NULL REFERENCES work_executors(id),
 executor_name TEXT NOT NULL,
 executor_revision BIGINT NOT NULL,
 item_revision BIGINT NOT NULL,
 resource_key TEXT NOT NULL,
 event_id TEXT REFERENCES work_automation_events(id),
 state TEXT NOT NULL CHECK(state IN ('queued','dispatching','running','succeeded','failed','unknown','canceled')),
 revision BIGINT NOT NULL DEFAULT 1,
 snapshot_json TEXT NOT NULL,
 context_json TEXT NOT NULL DEFAULT '',
 user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 token_hash TEXT NOT NULL DEFAULT '',
 create_hash TEXT NOT NULL,
 created_at TEXT NOT NULL,
 started_at TEXT NOT NULL DEFAULT '',
 finished_at TEXT NOT NULL DEFAULT '',
 next_poll_at TEXT NOT NULL DEFAULT '',
 deadline_at TEXT NOT NULL DEFAULT '',
 poll_failures INTEGER NOT NULL DEFAULT 0,
 code TEXT NOT NULL DEFAULT '',
 message TEXT NOT NULL DEFAULT '',
 result TEXT NOT NULL DEFAULT '',
 manual_resolution BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX work_execution_resource ON work_executions(resource_key) WHERE state IN ('dispatching','running','unknown');
CREATE UNIQUE INDEX work_execution_item_pending ON work_executions(item_id) WHERE state IN ('queued','dispatching','running','unknown');
CREATE INDEX work_execution_queue ON work_executions(created_at,id) WHERE state='queued';
CREATE INDEX work_execution_poll ON work_executions(next_poll_at,id) WHERE state IN ('running','unknown') AND next_poll_at<>'';
CREATE INDEX work_executions_space ON work_executions(space_id,created_at DESC,id DESC);
CREATE INDEX work_executions_executor ON work_executions(executor_id,state);
CREATE INDEX work_executions_item ON work_executions(item_id,created_at DESC,id DESC);
CREATE INDEX work_executions_failures ON work_executions(space_id,state,created_at);

CREATE TABLE work_automation_receipts (
 event_id TEXT NOT NULL REFERENCES work_automation_events(id) ON DELETE CASCADE,
 rule_id TEXT NOT NULL REFERENCES work_automation_rules(id),
 rule_revision BIGINT NOT NULL,
 item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
 execution_id TEXT REFERENCES work_executions(id) ON DELETE SET NULL,
 result TEXT NOT NULL CHECK(result IN ('created','failed','skipped')),
 code TEXT NOT NULL DEFAULT '',
 message TEXT NOT NULL DEFAULT '',
 occurred_at TEXT NOT NULL,
 PRIMARY KEY(event_id,rule_id)
);

ALTER TABLE work_activity DROP CONSTRAINT work_activity_origin_check;
ALTER TABLE work_activity ADD CONSTRAINT work_activity_origin_check CHECK(origin IN ('web','api','mcp','scheduler','automation'));
