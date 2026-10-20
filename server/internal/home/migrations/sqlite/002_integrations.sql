CREATE TABLE integration_sources (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('external-push','github-traffic')),
 schema_id TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version>0),
 connection_json TEXT NOT NULL CHECK(json_valid(connection_json)),
 sync_json TEXT NOT NULL CHECK(json_valid(sync_json)),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 config_revision INTEGER NOT NULL CHECK(config_revision>0),
 credential_cipher TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, next_sync_at TEXT, last_success_at TEXT,
 last_error_json TEXT CHECK(last_error_json IS NULL OR json_valid(last_error_json)),
 UNIQUE(space_id,id)
);
CREATE INDEX integration_sources_space ON integration_sources(space_id);
CREATE TABLE integration_tokens (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, source_id TEXT,
 actions_json TEXT NOT NULL CHECK(json_valid(actions_json)),
 permission_epoch INTEGER NOT NULL, user_version INTEGER NOT NULL,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
 FOREIGN KEY(space_id,source_id) REFERENCES integration_sources(space_id,id) ON DELETE CASCADE
);
CREATE INDEX integration_tokens_user ON integration_tokens(user_id);
CREATE TABLE integration_snapshots (
 source_id TEXT PRIMARY KEY REFERENCES integration_sources(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL CHECK(revision>0), source_sequence INTEGER,
 data_json TEXT NOT NULL CHECK(json_valid(data_json)), source_updated_at TEXT, received_at TEXT NOT NULL
);
CREATE TABLE integration_receipts (
 source_id TEXT NOT NULL REFERENCES integration_sources(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), PRIMARY KEY(source_id,request_id)
);
CREATE TABLE integration_traffic_baselines (
 source_id TEXT PRIMARY KEY REFERENCES integration_sources(id) ON DELETE CASCADE,
 data_json TEXT NOT NULL CHECK(json_valid(data_json))
);
CREATE TABLE integration_traffic_daily (
 source_id TEXT NOT NULL REFERENCES integration_sources(id) ON DELETE CASCADE, day TEXT NOT NULL,
 views_count INTEGER, views_uniques INTEGER, clones_count INTEGER, clones_uniques INTEGER,
 observed_at TEXT NOT NULL, views_observed_at TEXT, clones_observed_at TEXT,
 PRIMARY KEY(source_id,day),
 CHECK((views_count IS NULL AND views_uniques IS NULL) OR (views_count IS NOT NULL AND views_uniques IS NOT NULL AND views_count>=0 AND views_uniques>=0 AND views_uniques<=views_count)),
 CHECK((clones_count IS NULL AND clones_uniques IS NULL) OR (clones_count IS NOT NULL AND clones_uniques IS NOT NULL AND clones_count>=0 AND clones_uniques>=0 AND clones_uniques<=clones_count))
);
