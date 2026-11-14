ALTER TABLE settings ADD COLUMN mcp_workflow_enabled BOOLEAN CHECK(mcp_workflow_enabled IS NULL OR mcp_workflow_enabled IN (FALSE,TRUE));
ALTER TABLE settings ADD COLUMN mcp_collaboration_enabled BOOLEAN CHECK(mcp_collaboration_enabled IS NULL OR mcp_collaboration_enabled IN (FALSE,TRUE));
ALTER TABLE settings ADD COLUMN mcp_settings_version INTEGER NOT NULL DEFAULT 1 CHECK(mcp_settings_version>=1);
