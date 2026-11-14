ALTER TABLE settings ADD COLUMN mcp_workflow_enabled BOOLEAN;
ALTER TABLE settings ADD COLUMN mcp_collaboration_enabled BOOLEAN;
ALTER TABLE settings ADD COLUMN mcp_settings_version BIGINT NOT NULL DEFAULT 1 CHECK(mcp_settings_version>=1);
