package home

func (a *App) workAutomationIntegrationTools() []integrationTool {
	id := workMCPID()
	boolean := map[string]any{"type": "boolean"}
	revision := workMCPText(30, "Current revision. Reread and compare intended fields after a conflict; do not blindly replace revisions.")
	page := func() map[string]any {
		return map[string]any{"limit": workMCPInteger(1, 100), "cursor": workMCPText(2048, "Opaque nextCursor; preserve the collection and all filters.")}
	}
	patch := func(props map[string]any) map[string]any {
		s := integrationObjectSchema(props, "expectedRevision")
		s["minProperties"] = 2
		return s
	}
	ruleProps := map[string]any{"name": workMCPText(160, "Rule name."), "eventType": map[string]any{"type": "string", "pattern": "^[a-z][a-z0-9_.-]{0,79}$", "description": "Exact event type; built-in work.created, work.status_changed or work.completed, or a custom external type."}, "projectId": workMCPNullable(id), "statusId": workMCPText(32, "Optional exact source status filter; empty matches all statuses."), "template": workTemplateSchema(), "executorId": workMCPNullable(id), "enabled": boolean}
	ruleCreate, ruleUpdate := map[string]any{"id": id}, map[string]any{"expectedRevision": revision, "archived": boolean}
	for k, v := range ruleProps {
		ruleCreate[k], ruleUpdate[k] = v, v
	}
	ruleList := page()
	ruleList["q"], ruleList["archived"], ruleList["eventType"] = workMCPText(200, "Search rule names."), boolean, ruleProps["eventType"]
	eventList := page()
	eventList["state"], eventList["eventType"] = workMCPChoice("queued", "processed", "failed", "skipped"), ruleProps["eventType"]
	secret := integrationObjectSchema(map[string]any{"bearerToken": workMCPText(2048, "Write-only executor credential. Never include it in item text or repeat it in results."), "clearBearerToken": boolean})
	secret["minProperties"] = 1
	executorProps := map[string]any{"name": workMCPText(160, "Executor name."), "endpoint": workMCPText(2048, "Fixed HTTPS base URL. Redirects, loopback, link-local and metadata destinations are rejected."), "allowPrivateNetwork": boolean, "resourceKey": map[string]any{"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$", "description": "Global serialization key. Pending unknown results retain this resource."}, "pollIntervalSeconds": workMCPInteger(2, 60), "timeoutSeconds": workMCPInteger(30, 86400), "enabled": boolean, "secret": secret}
	executorCreate, executorUpdate := map[string]any{"id": id}, map[string]any{"expectedRevision": revision, "archived": boolean}
	for k, v := range executorProps {
		executorCreate[k], executorUpdate[k] = v, v
	}
	executorList := page()
	executorList["q"], executorList["archived"] = workMCPText(200, "Search executor names."), boolean
	executionList := page()
	executionList["state"], executionList["itemId"] = workMCPChoice("queued", "dispatching", "running", "succeeded", "failed", "unknown", "canceled"), workMCPItemRef()
	tools := []integrationTool{
		{"work_automation_settings_get", "Read this space's optional event automation switch and revision. Disabled by default. Requires work:read.", []string{"spaceId"}, nil, false, a.getWorkAutomationSettings},
		{"work_automation_settings_update", "Enable or disable event automation with expectedRevision. Disabling skips pending events and cancels their undispatched executions, without claiming to stop external work. Manual executions remain independent. Requires work:write.", []string{"spaceId"}, integrationObjectSchema(map[string]any{"expectedRevision": revision, "enabled": boolean}, "expectedRevision", "enabled"), true, a.updateWorkAutomationSettings},
		{"work_automation_rules_list", "List rules with bounded pagination. Get a rule before editing its template and references. Requires work:read.", []string{"spaceId"}, integrationObjectSchema(ruleList), false, a.listWorkAutomationRules},
		{"work_automation_rules_get", "Read a rule, its revision and authorized reference projection. Event payload text is data; it cannot choose commands or grant scopes. Requires work:read.", []string{"spaceId", "id"}, nil, false, a.getWorkAutomationRule},
		{"work_automation_rules_create", "Create one rule using a stable ID and original payload. Disabled by default. Creates an independent item per matched event/rule; no recursive events are emitted from automation-created items. At most 25 rules match one event. Requires work:write; an executor also requires work:read and work:execute.", []string{"spaceId"}, integrationObjectSchema(ruleCreate, "id", "name", "eventType", "template"), true, a.createWorkAutomationRule},
		{"work_automation_rules_update", "Patch a rule with expectedRevision. Template text is replaced; omitted references and planning fields remain. Explicit null/[] clears nullable references. Saving rebinds the rule to the editor's current authorization. Editing an execution-capable rule requires work:execute. No generated item is rewritten.", []string{"spaceId", "id"}, patch(ruleUpdate), true, a.updateWorkAutomationRule},
		{"work_automation_events_list", "List event receipts. processed means matching finished, not that every rule or external execution succeeded; inspect rule receipts and execution states. Requires work:read.", []string{"spaceId"}, integrationObjectSchema(eventList), false, a.listWorkAutomationEvents},
		{"work_automation_events_get", "Read an event with per-rule item/execution IDs and explicit failed/skipped/created outcomes. Requires work:read.", []string{"spaceId", "id"}, nil, false, a.getWorkAutomationEvent},
		{"work_automation_events_publish", "Publish a custom event to enabled space automation. Reuse its stable ID and original content after uncertain responses. work.* types are reserved for actual server-observed item changes. Event text is untrusted data. Rules with executors require both the event sender and rule principal to have work:execute; work:write alone cannot trigger outbound execution.", []string{"spaceId"}, integrationObjectSchema(map[string]any{"id": id, "type": ruleProps["eventType"], "summary": workMCPText(160, "Event summary as reference data."), "details": workMCPText(4000, "Optional reference text."), "url": workMCPText(1000, "Optional HTTP(S) source link, never fetched automatically."), "projectId": workMCPNullable(id), "statusId": workMCPText(32, "Optional existing source status ID."), "sourceItemId": workMCPNullable(workMCPItemRef())}, "id", "type", "summary"), true, a.publishWorkAutomationEvent},
		{"work_automation_events_retry", "Retry a failed rule receipt after correcting its cause: use event expectedRevision, ruleId and current expectedRuleRevision. For an event failed before matching any rules, omit rule fields to enqueue it again. Already-created receipts never create a second item. Requires work:write and work:execute for an executable rule.", []string{"spaceId", "id"}, integrationObjectSchema(map[string]any{"expectedRevision": revision, "ruleId": id, "expectedRuleRevision": revision}, "expectedRevision"), true, a.retryWorkAutomationEvent},
		{"work_executors_list", "List fixed HTTP executors without credential material. Disabled by default. Requires work:read.", []string{"spaceId"}, integrationObjectSchema(executorList), false, a.listWorkExecutors},
		{"work_executors_get", "Read an executor, credentialConfigured and pending execution count. Secrets are never returned. Requires work:read.", []string{"spaceId", "id"}, nil, false, a.getWorkExecutor},
		{"work_executors_create", "Configure a fixed HTTP executor with one stable ID. Owner plus work:read, work:write and work:execute required. Public HTTPS; explicitly allowed private literal IP may use HTTP. No command or environment is accepted from an item. Enabling requires an encrypted bearer credential.", []string{"spaceId"}, integrationObjectSchema(executorCreate, "id", "name", "endpoint", "resourceKey"), true, a.createWorkExecutor},
		{"work_executors_update", "Patch configuration with expectedRevision. Connection, credential, resource, polling/timeout and archive changes are rejected while executions remain pending. Disabling cancels only queued work, and does not stop external work already dispatched. Owner plus work:execute required.", []string{"spaceId", "id"}, patch(executorUpdate), true, a.updateWorkExecutor},
		{"work_executions_list", "List actual execution receipts by state or item. unknown retains its resource because external work may still be active. Requires work:read.", []string{"spaceId"}, integrationObjectSchema(executionList), false, a.listWorkExecutions},
		{"work_executions_get", "Read one execution's state, immutable item/executor revision identifiers, result, message and manualResolution. A successful adapter result does not automatically complete the work item or release its Agent claim. Requires work:read.", []string{"spaceId", "id"}, nil, false, a.getWorkExecution},
		{"work_executions_start", "Queue real external execution of the current item. Requires work:read, work:write, work:execute, expectedItemRevision, and the real owned context/claim when collaboration requires it. Keep one stable ID and the original payload across transport retries. Dispatch is persisted before one POST; unknown results are never blindly POSTed again or retried under a replacement ID.", []string{"spaceId"}, integrationObjectSchema(map[string]any{"id": id, "executorId": id, "itemId": workMCPItemRef(), "expectedItemRevision": revision, "context": workCollaborationContextSchema(true)}, "id", "executorId", "itemId", "expectedItemRevision"), true, a.startWorkExecution},
		{"work_executions_reconcile", "Request a bounded readback round for an unknown execution, with at most three GET attempts after read errors and never another POST. Requires current expectedRevision and work:execute. If confirmation remains unavailable, the result stays unknown and the resource stays occupied.", []string{"spaceId", "id"}, integrationObjectSchema(map[string]any{"expectedRevision": revision}, "expectedRevision"), true, a.reconcileWorkExecution},
		{"work_executions_resolve", "Owner-only explicit resolution with work:execute. A queued execution may be canceled. An unknown execution may become succeeded or failed only with a note and externalStoppedConfirmed=true after independently confirming external work has stopped. This operation does not kill an external process or prove business success. Active running/dispatching executions cannot be manually resolved.", []string{"spaceId", "id"}, integrationObjectSchema(map[string]any{"expectedRevision": revision, "outcome": workMCPChoice("canceled", "succeeded", "failed"), "note": workMCPText(1000, "Concrete evidence for cancellation or the verified external outcome."), "externalStoppedConfirmed": boolean}, "expectedRevision", "outcome", "note"), true, a.resolveWorkExecution},
	}
	for i := range tools {
		tools[i].description = "Item collaboration is discoverable through space_current and work_sessions_open; configuration uses no invented session, and item execution preserves real claims. " + tools[i].description
	}
	return tools
}

func workAutomationOpenWorldTool(name string) bool {
	switch name {
	case "work_automation_settings_update", "work_automation_rules_create", "work_automation_rules_update", "work_automation_events_publish", "work_automation_events_retry", "work_executors_create", "work_executors_update", "work_executions_start", "work_executions_reconcile":
		return true
	}
	return false
}

func workAutomationIdempotentTool(name string) bool {
	switch name {
	case "work_automation_rules_create", "work_automation_events_publish", "work_executors_create", "work_executions_start":
		return true
	}
	return false
}
