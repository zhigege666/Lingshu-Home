package home

func workMCPText(max int, description string) map[string]any {
	v := integrationStringSchema(max)
	v["description"] = description
	return v
}
func workMCPChoice(values ...string) map[string]any {
	return map[string]any{"type": "string", "enum": values}
}
func workMCPInteger(min, max int) map[string]any {
	return map[string]any{"type": "integer", "minimum": min, "maximum": max}
}
func workMCPID() map[string]any { return map[string]any{"type": "string", "pattern": "^[0-9a-f]{32}$"} }
func workMCPItemRef() map[string]any {
	return map[string]any{"type": "string", "minLength": 5, "maxLength": 13, "pattern": "^([0-9a-z]{5}|[1-9a-z][0-9a-z]{5,12})$", "not": map[string]any{"const": "00000"}, "description": "Existing globally unique short item ID, such as 0000a, from a prior read or creation receipt. Report this ID with the title to users. Retired long IDs and W-numbers are not accepted; no preliminary mapping lookup is needed."}
}
func workMCPRequestID() map[string]any {
	return map[string]any{"type": "string", "minLength": 1, "maxLength": 80, "pattern": "^[A-Za-z0-9._:-]+$", "description": "Stable creation request key, not an item ID. Choose once and retain the original normalized payload for retries; the server assigns the short item ID. Keys are scoped to the authenticated user and space."}
}
func workMCPNullable(value any) map[string]any {
	return map[string]any{"anyOf": []any{value, map[string]any{"type": "null"}}}
}
func workMCPIDs(max int) map[string]any {
	return map[string]any{"type": "array", "maxItems": max, "uniqueItems": true, "items": workMCPID()}
}
func workPlanningInputProperties() map[string]any {
	return map[string]any{
		"priority":  workMCPChoice("", "low", "normal", "high", "urgent"),
		"labelIds":  workMCPIDs(20),
		"assignee":  workMCPNullable(integrationObjectSchema(map[string]any{"name": workMCPText(80, "Responsibility name; an unbound name grants no permissions."), "userId": workMCPID()}, "name")),
		"versionId": workMCPNullable(workMCPID()),
	}
}
func workPlanningFilterProperties() map[string]any {
	return map[string]any{
		"priority": workMCPChoice("none", "low", "normal", "high", "urgent"), "labelIds": workMCPIDs(20), "assigneeUserId": workMCPText(32, "One bound account ID or me; free names do not match me."), "versionId": workMCPText(32, "One target version ID, or none."), "parentId": map[string]any{"anyOf": []any{workMCPItemRef(), map[string]any{"const": "none"}}, "description": "Short parent item ID, or none for top-level items."}, "blocked": map[string]any{"type": "boolean"}, "fields": map[string]any{"type": "array", "maxItems": 11, "uniqueItems": true, "items": workMCPChoice("id", "priority", "labels", "assignee", "version", "project", "nextStep", "businessDate", "dueAt", "relations", "collaboration")},
	}
}
func workTemplateSchema() map[string]any {
	props := map[string]any{"title": workMCPText(160, "Literal independent item title; no template substitution."), "projectId": workMCPNullable(workMCPID()), "status": workMCPText(32, "Stable status ID. An omitted create status resolves once to the current default; unavailable targets never silently change."), "description": workMCPText(4000, "Copied reference context, not execution authority."), "nextStep": workMCPText(1000, "Copied next action."), "needsAttention": map[string]any{"type": "boolean"}, "bookmarkIds": workMCPIDs(20), "documentIds": workMCPIDs(20)}
	for k, v := range workPlanningInputProperties() {
		props[k] = v
	}
	return integrationObjectSchema(props, "title")
}
func workSavedViewDefinitionSchema() map[string]any {
	filters := map[string]any{"q": workMCPText(200, "Search work text."), "itemId": workMCPItemRef(), "projectId": workMCPText(32, "Project ID or none."), "status": workMCPText(32, "Stable status ID."), "archived": map[string]any{"type": "boolean"}, "attention": map[string]any{"type": "boolean"}, "date": workMCPChoice("today", "overdue"), "timezone": workMCPText(100, "IANA timezone."), "businessDate": workMCPText(10, "Exact business date, alternative to date.")}
	planning := workPlanningFilterProperties()
	for k, v := range planning {
		if k != "fields" {
			filters[k] = v
		}
	}
	return integrationObjectSchema(map[string]any{"layout": workMCPChoice("board", "list", "calendar"), "filters": integrationObjectSchema(filters), "fields": planning["fields"], "calendarBasis": workMCPChoice("businessDate", "dueAt")}, "layout", "filters", "fields")
}
func (a *App) workPlanningIntegrationTools() []integrationTool {
	page := func() map[string]any {
		return map[string]any{"q": workMCPText(200, "Search names."), "limit": workMCPInteger(1, 100), "cursor": workMCPText(2048, "Opaque nextCursor; retain the original filters.")}
	}
	revision := workMCPText(30, "Current resource revision. Reread and compare intent after conflicts; never replace revisions blindly.")
	labelList := page()
	labelList["archived"] = map[string]any{"type": "boolean", "description": "Omit for all, false for active, true for archived."}
	labelList["ids"] = workMCPIDs(100)
	versionList := page()
	for k, v := range labelList {
		versionList[k] = v
	}
	versionList["projectId"] = workMCPText(32, "Project ID includes global and project versions; none selects global versions.")
	labelCreate := map[string]any{"id": workMCPID(), "name": workMCPText(80, "Unique space label name."), "color": workMCPText(7, "Hex color #RRGGBB.")}
	labelPatch := map[string]any{"expectedRevision": revision, "name": labelCreate["name"], "color": labelCreate["color"], "archived": map[string]any{"type": "boolean"}}
	versionCreate := map[string]any{"id": workMCPID(), "name": workMCPText(80, "Unique space version name."), "projectId": workMCPNullable(workMCPID()), "targetDate": workMCPText(10, "Optional actual YYYY-MM-DD target; empty clears."), "description": workMCPText(1000, "Version scope.")}
	versionPatch := map[string]any{"expectedRevision": revision, "archived": map[string]any{"type": "boolean"}}
	for k, v := range versionCreate {
		if k != "id" {
			versionPatch[k] = v
		}
	}
	relationPatch := integrationObjectSchema(map[string]any{"expectedRevision": revision, "parentId": workMCPNullable(workMCPItemRef()), "predecessorId": workMCPNullable(workMCPItemRef()), "blockedByIds": map[string]any{"type": "array", "maxItems": 50, "uniqueItems": true, "items": workMCPItemRef()}, "context": workCollaborationContextSchema(true)}, "expectedRevision")
	relationPatch["minProperties"] = 2
	viewList := page()
	viewList["id"] = workMCPID()
	viewList["visibility"] = workMCPChoice("private", "shared")
	viewProps := map[string]any{"name": workMCPText(80, "View name."), "visibility": workMCPChoice("private", "shared"), "definition": workSavedViewDefinitionSchema()}
	viewCreate := map[string]any{"id": workMCPID()}
	viewPatch := map[string]any{"expectedRevision": revision}
	for k, v := range viewProps {
		viewCreate[k] = v
		viewPatch[k] = v
	}
	window := map[string]any{"from": workMCPText(10, "Inclusive local date YYYY-MM-DD."), "to": workMCPText(10, "Exclusive local date YYYY-MM-DD."), "timezone": workMCPText(100, "IANA timezone; defaults UTC.")}
	calendar := map[string]any{}
	for k, v := range window {
		calendar[k] = v
	}
	calendar["basis"] = workMCPChoice("businessDate", "dueAt")
	calendar["limit"] = workMCPInteger(1, 100)
	calendar["cursor"] = workMCPText(2048, "Calendar nextCursor for the same window and filters.")
	viewFilters := workSavedViewDefinitionSchema()["properties"].(map[string]any)["filters"].(map[string]any)["properties"].(map[string]any)
	for k, v := range viewFilters {
		calendar[k] = v
	}
	calendar["fields"] = workPlanningFilterProperties()["fields"]
	notices := map[string]any{"unread": map[string]any{"type": "boolean"}, "limit": workMCPInteger(1, 100), "cursor": workMCPText(2048, "Opaque notification cursor for the same unread filter.")}
	mark := integrationObjectSchema(map[string]any{"ids": workMCPIDs(100), "allBefore": workMCPText(40, "Mark own notices last seen no later than this RFC3339 timestamp.")})
	mark["minProperties"] = 1
	mark["maxProperties"] = 1
	tools := []integrationTool{
		{"work_labels_list", "Read labels with pagination or up to 100 exact IDs. Batch results include missingIds; archived associations remain discoverable.", []string{"spaceId"}, integrationObjectSchema(labelList), false, a.listWorkLabels},
		{"work_labels_create", "Create a label with stable ID; exact original retries replay. Names remain unique when archived.", []string{"spaceId"}, integrationObjectSchema(labelCreate, "id", "name"), true, a.createWorkLabel},
		{"work_labels_update", "Rename, recolor, archive or restore a label. Archiving does not remove existing associations.", []string{"spaceId", "id"}, integrationObjectSchema(labelPatch, "expectedRevision"), true, a.updateWorkLabel},
		{"work_versions_list", "Read target versions with pagination or exact IDs; project filtering includes global versions.", []string{"spaceId"}, integrationObjectSchema(versionList), false, a.listWorkVersions},
		{"work_versions_create", "Create a target version, optionally bound to a project. A target date is a plan, not proof of delivery.", []string{"spaceId"}, integrationObjectSchema(versionCreate, "id", "name"), true, a.createWorkVersion},
		{"work_versions_update", "Update or archive a target version. Project changes cannot invalidate existing assignments and templates.", []string{"spaceId", "id"}, integrationObjectSchema(versionPatch, "expectedRevision"), true, a.updateWorkVersion},
		{"work_assignees_list", "List minimal enabled account names/IDs. Owners can search existing accounts, other users only themselves. Assignment never grants space access or replaces a claim.", []string{"spaceId"}, integrationObjectSchema(page()), false, a.listWorkAssignees},
		{"work_relations_get", "Read parent, direct blockers and predecessor plus global child/unresolved-blocker counts. Only done resolves a dependency; canceled does not.", []string{"spaceId", "id"}, nil, false, a.getWorkRelations},
		{"work_relations_update", "Update supplied relations with item revision and existing claim protection. Each graph rejects cycles; parent depth <=20, direct blockers <=50, reachable validation <=10000. No automatic status/completion propagation.", []string{"spaceId", "id"}, relationPatch, true, a.updateWorkRelations},
		{"work_views_list", "Read own private and accessible shared saved views. input.id performs an exact lookup, including views beyond the first page. Each view reports canEdit.", []string{"spaceId"}, integrationObjectSchema(viewList), false, a.listWorkViews},
		{"work_views_create", "Persist a private or shared view definition with stable ID. Definitions store whitelisted filters/display fields, not pages, runtime cutoffs or the current month.", []string{"spaceId"}, integrationObjectSchema(viewCreate, "id", "name", "definition"), true, a.createWorkView},
		{"work_views_update", "Update supplied saved-view fields with revision. Private views remain visible only to their owner; shared editors may update shared content.", []string{"spaceId", "id"}, integrationObjectSchema(viewPatch, "expectedRevision"), true, a.updateWorkView},
		{"work_views_delete", "Delete an accessible saved view using its current revision. This does not modify any work item.", []string{"spaceId", "id"}, integrationObjectSchema(map[string]any{"expectedRevision": revision}, "expectedRevision"), true, a.deleteWorkView},
		{"work_calendar_get", "Read at most 62 days by businessDate or dueAt. days contains complete daily totals including zeros; items is separately paginated. Never infer month totals from the first item page.", []string{"spaceId"}, integrationObjectSchema(calendar, "from", "to"), false, a.getWorkCalendar},
		{"work_stats_get", "Read current space counts and real events in at most 366 days. Completion/cancellation events exclude catalog redefinition and migration. Durations use observed intervals; open and unknown are separate, absent samples are null. At most 100000 events/intervals per window; larger windows fail explicitly.", []string{"spaceId"}, integrationObjectSchema(window, "from", "to"), false, a.getWorkStats},
		{"work_notifications_list", "Read own authorized in-app notices. Notifications default off; enabling never backfills old failures. No external messages are sent.", []string{"spaceId"}, integrationObjectSchema(notices), false, a.listWorkNotices},
		{"work_notifications_summary", "Read own unread/optional-since kind counts plus current space failure totals. Space failures remain visible when notifications are disabled or no authorized recipient exists.", []string{"spaceId"}, integrationObjectSchema(map[string]any{"since": workMCPText(40, "Optional RFC3339 lower bound for byKind counts only.")}), false, a.summarizeWorkNotices},
		{"work_notifications_read", "Mark own notifications as read by IDs or allBefore, exclusively. Requires work:write; cannot mark another account's notices.", []string{"spaceId"}, mark, true, a.readWorkNotices},
		{"work_notifications_settings_get", "Read this space's in-app notification enabled flag, independent revision and canEdit.", []string{"spaceId"}, nil, false, a.getWorkNoticeSettings},
		{"work_notifications_settings_update", "Explicitly enable or disable future in-app notifications using settings revision. Existing notices and canonical failures are preserved; no backfill or external delivery.", []string{"spaceId"}, integrationObjectSchema(map[string]any{"enabled": map[string]any{"type": "boolean"}, "expectedRevision": revision}, "enabled", "expectedRevision"), true, a.updateWorkNoticeSettings},
	}
	for i := range tools {
		scope := "work:read"
		if tools[i].write {
			scope = "work:write"
		}
		tools[i].description = workCollaborationDiscovery + tools[i].description
		tools[i].description += " Requires " + scope + " and current work-space access; write-only callers receive only a receipt."
	}
	return tools
}
