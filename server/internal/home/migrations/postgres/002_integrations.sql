CREATE TABLE integration_sources (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('external-push','github-traffic')),
 schema_id TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version>0),
 connection_json JSONB NOT NULL, sync_json JSONB NOT NULL,
 enabled BOOLEAN NOT NULL, config_revision BIGINT NOT NULL CHECK(config_revision>0),
 credential_cipher TEXT,
 created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 next_sync_at TIMESTAMPTZ, last_success_at TIMESTAMPTZ, last_error_json JSONB,
 UNIQUE(space_id,id)
);
CREATE INDEX integration_sources_space ON integration_sources(space_id);
CREATE TABLE integration_tokens (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, source_id TEXT,
 actions_json JSONB NOT NULL, permission_epoch BIGINT NOT NULL, user_version BIGINT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ,
 FOREIGN KEY(space_id,source_id) REFERENCES integration_sources(space_id,id) ON DELETE CASCADE
);
CREATE INDEX integration_tokens_user ON integration_tokens(user_id);
CREATE TABLE integration_snapshots (
 source_id TEXT PRIMARY KEY REFERENCES integration_sources(id) ON DELETE CASCADE,
 revision BIGINT NOT NULL CHECK(revision>0), source_sequence BIGINT,
 data_json JSONB NOT NULL, source_updated_at TIMESTAMPTZ, received_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE integration_receipts (
 source_id TEXT NOT NULL REFERENCES integration_sources(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, receipt_json JSONB NOT NULL,
 PRIMARY KEY(source_id,request_id)
);
CREATE TABLE integration_traffic_baselines (
 source_id TEXT PRIMARY KEY REFERENCES integration_sources(id) ON DELETE CASCADE, data_json JSONB NOT NULL
);
CREATE TABLE integration_traffic_daily (
 source_id TEXT NOT NULL REFERENCES integration_sources(id) ON DELETE CASCADE, day TEXT NOT NULL,
 views_count BIGINT, views_uniques BIGINT, clones_count BIGINT, clones_uniques BIGINT,
 observed_at TIMESTAMPTZ NOT NULL, views_observed_at TIMESTAMPTZ, clones_observed_at TIMESTAMPTZ,
 PRIMARY KEY(source_id,day),
 CHECK((views_count IS NULL AND views_uniques IS NULL) OR (views_count IS NOT NULL AND views_uniques IS NOT NULL AND views_count>=0 AND views_uniques>=0 AND views_uniques<=views_count)),
 CHECK((clones_count IS NULL AND clones_uniques IS NULL) OR (clones_count IS NOT NULL AND clones_uniques IS NOT NULL AND clones_count>=0 AND clones_uniques>=0 AND clones_uniques<=clones_count))
);
