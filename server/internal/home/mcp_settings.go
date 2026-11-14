package home

import (
	"database/sql"
	"net/http"
	"strconv"
)

// MCPSettings is resolved from the same database snapshot as each request.
// Startup defaults remain immutable; explicit webpage values take precedence.
type MCPSettings struct {
	Revision             string `json:"revision"`
	WorkflowEnabled      bool   `json:"workflowEnabled"`
	CollaborationEnabled bool   `json:"collaborationEnabled"`
	WorkflowSource       string `json:"workflowSource"`
	CollaborationSource  string `json:"collaborationSource"`
}

type mcpSettingsResponse struct {
	MCPSettings
	CanManage bool `json:"canManage"`
}

func resolveMCPSettings(config Config, workflow, collaboration sql.NullBool, version int64) MCPSettings {
	settings := MCPSettings{
		Revision:        strconv.FormatInt(version, 10),
		WorkflowEnabled: config.MCPWorkflowEnabled, CollaborationEnabled: config.MCPCollaborationEnabled,
		WorkflowSource: "startup", CollaborationSource: "startup",
	}
	if workflow.Valid {
		settings.WorkflowEnabled, settings.WorkflowSource = workflow.Bool, "saved"
	}
	if collaboration.Valid {
		settings.CollaborationEnabled, settings.CollaborationSource = collaboration.Bool, "saved"
	}
	return settings
}

func mcpSettingsView(r *Request) mcpSettingsResponse {
	return mcpSettingsResponse{MCPSettings: r.Settings.MCP, CanManage: !r.Bearer && r.User != nil && r.User.Role == "Owner"}
}

func (a *App) getMCPSettings(r *Request) (*Response, error) {
	if err := r.requireBrowserSession(); err != nil {
		return nil, err
	}
	return ok(mcpSettingsView(r)), nil
}

func (a *App) updateMCPSettings(r *Request) (*Response, error) {
	if err := r.requireBrowserSession(); err != nil {
		return nil, err
	}
	if err := r.requireOwner(); err != nil {
		return nil, err
	}
	var input struct {
		ExpectedRevision     string `json:"expectedRevision"`
		WorkflowEnabled      *bool  `json:"workflowEnabled"`
		CollaborationEnabled *bool  `json:"collaborationEnabled"`
	}
	if err := r.decode(&input); err != nil {
		return nil, err
	}
	version, err := strconv.ParseInt(input.ExpectedRevision, 10, 64)
	if err != nil || version < 1 || strconv.FormatInt(version, 10) != input.ExpectedRevision {
		return nil, invalid("A current MCP settings revision is required.")
	}
	if input.WorkflowEnabled == nil || input.CollaborationEnabled == nil {
		return nil, invalid("workflowEnabled and collaborationEnabled must both be explicit booleans.")
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE settings SET mcp_workflow_enabled=?,mcp_collaboration_enabled=?,mcp_settings_version=mcp_settings_version+1 WHERE id=1 AND mcp_settings_version=?"), *input.WorkflowEnabled, *input.CollaborationEnabled, version)
	if err != nil {
		return nil, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, &APIError{Status: http.StatusConflict, Code: "mcp_settings_conflict", Message: "MCP settings changed. Read and compare the current values before saving again.", CurrentRevision: r.Settings.MCP.Revision}
	}
	// A successful explicit save owns both values, including saved false, and
	// advances this form's independent revision even when the values match.
	r.Settings.MCP = resolveMCPSettings(a.config,
		sql.NullBool{Bool: *input.WorkflowEnabled, Valid: true},
		sql.NullBool{Bool: *input.CollaborationEnabled, Valid: true}, version+1)
	return ok(mcpSettingsView(r)), nil
}
