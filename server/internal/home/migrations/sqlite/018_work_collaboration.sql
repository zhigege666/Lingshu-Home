CREATE TABLE work_sessions (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 registration_id TEXT NOT NULL,
 create_hash TEXT NOT NULL,
 agent_name TEXT NOT NULL,
 client_name TEXT NOT NULL DEFAULT '',
 role TEXT NOT NULL DEFAULT '',
 parent_session_id TEXT NOT NULL DEFAULT '',
 resumes_session_id TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL,
 closed_at TEXT NOT NULL DEFAULT '',
 UNIQUE(space_id,user_id,registration_id)
);
CREATE TABLE work_claims (
 item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 claim_id TEXT NOT NULL UNIQUE,
 session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
 generation BIGINT NOT NULL CHECK(generation>=1),
 expires_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL,
 last_progress_at TEXT NOT NULL DEFAULT '',
 released_at TEXT NOT NULL DEFAULT '',
 unresolved BOOLEAN NOT NULL DEFAULT FALSE,
 handoff_json TEXT NOT NULL DEFAULT ''
);
CREATE INDEX work_claims_session ON work_claims(space_id,session_id);
CREATE TABLE work_collaboration_spaces (
 space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
 revision BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE work_collaboration_events (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
 sequence BIGINT NOT NULL CHECK(sequence>=1),
 operation_id TEXT NOT NULL,
 actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 session_json TEXT NOT NULL DEFAULT '',
 kind TEXT NOT NULL,
 body TEXT NOT NULL,
 occurred_at TEXT NOT NULL,
 origin TEXT NOT NULL CHECK(origin IN ('web','api','mcp')),
 handoff_json TEXT NOT NULL DEFAULT '',
 UNIQUE(space_id,sequence)
);
CREATE INDEX work_collaboration_events_page ON work_collaboration_events(space_id,item_id,sequence);
CREATE TABLE work_operation_receipts (
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 operation_id TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 response_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(space_id,user_id,operation_id)
);
ALTER TABLE work_activity ADD COLUMN session_json TEXT NOT NULL DEFAULT '';
