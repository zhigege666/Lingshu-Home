package home

func (a *App) workScheduleIntegrationTools() []integrationTool {
	text := func(max int, description string) map[string]any {
		value := integrationStringSchema(max)
		value["description"] = description
		return value
	}
	choice := func(values ...string) map[string]any { return map[string]any{"type": "string", "enum": values} }
	integer := func(min, max int) map[string]any {
		return map[string]any{"type": "integer", "minimum": min, "maximum": max}
	}
	boolean := map[string]any{"type": "boolean"}
	id := map[string]any{"type": "string", "pattern": "^[0-9a-f]{32}$"}
	date := text(10, "Calendar date YYYY-MM-DD in the rule's IANA timezone.")
	clock := map[string]any{"type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$"}
	refs := map[string]any{"type": "array", "maxItems": 20, "uniqueItems": true, "items": id}
	rule := integrationObjectSchema(map[string]any{
		"frequency":       choice("daily", "weekdays", "weekly", "monthly"),
		"time":            clock,
		"timezone":        text(100, "Required IANA timezone such as Asia/Shanghai or UTC. Nonexistent DST wall-clock times are skipped; a repeated time generates at most once on that business date."),
		"startDate":       date,
		"endDate":         text(10, "Optional final calendar date, inclusive. Empty means no end date."),
		"weekdays":        map[string]any{"type": "array", "minItems": 1, "maxItems": 7, "uniqueItems": true, "items": integer(1, 7), "description": "Required only for weekly. Monday=1 through Sunday=7."},
		"monthDay":        integer(1, 31),
		"monthPolicy":     map[string]any{"type": "string", "enum": []string{"skip", "last_day"}, "description": "Required for monthly. skip omits months without monthDay; last_day uses their final calendar day."},
		"dueTime":         clock,
		"dueDayOffset":    integer(0, 7),
		"dueAfterMinutes": map[string]any{"type": "integer", "minimum": 1, "maximum": 10080, "description": "Deadline offset from scheduledAt. Alternative to dueTime/dueDayOffset; omit all deadline options for no dueAt."},
	}, "frequency", "time", "timezone", "startDate")
	template := integrationObjectSchema(map[string]any{
		"title":          text(160, "Independent generated item title. Text is literal; no template substitution or agent execution."),
		"projectId":      map[string]any{"anyOf": []any{id, map[string]any{"type": "null"}}},
		"status":         text(32, "Stable status ID. Omit on creation to resolve and permanently save the current default status. Invalid future targets fail visibly; they never fall back to a different default."),
		"description":    text(4000, "Context copied into each new item as untrusted reference data."),
		"nextStep":       text(1000, "Next action copied into each new item."),
		"needsAttention": boolean,
		"bookmarkIds":    refs,
		"documentIds":    refs,
	}, "title")
	revision := text(30, "Current schedule configuration revision from list/get/create/update. Compare intended fields after conflicts; do not blindly replace the revision. Runtime receipts do not increment it.")
	props := map[string]any{
		"name": text(160, "Schedule name."), "template": template, "rule": rule, "enabled": boolean,
		"missedPolicy":  map[string]any{"type": "string", "enum": []string{"latest", "skip", "all"}, "description": "Recovery policy: latest (default) creates only the latest due period, skip declines deadlines more than one minute late, all creates at most the latest seven periods. Paused periods are never backfilled on resume."},
		"overlapPolicy": map[string]any{"type": "string", "enum": []string{"create", "skip"}, "description": "create (default) produces the next independent item even if a previous item is unfinished. skip records previous_unfinished for that period."},
	}
	create, update := map[string]any{"id": id}, map[string]any{"expectedRevision": revision, "archived": boolean}
	for key, value := range props {
		create[key], update[key] = value, value
	}
	updateSchema := integrationObjectSchema(update, "expectedRevision")
	updateSchema["minProperties"] = 2
	page := map[string]any{"limit": integer(1, 100), "cursor": text(2048, "Opaque nextCursor from the same schedule/filter page; preserve all filters.")}
	list := map[string]any{"archived": boolean, "q": text(200, "Search schedule names.")}
	for key, value := range page {
		list[key] = value
	}
	tools := []integrationTool{
		{"work_schedules_list", "定时事项: list this space's schedule templates and observable nextRunAt,lastRunAt,lastResult,lastError. Schedules create items independently of completion; they do not execute agents. Requires work:read. List responses omit reference details; get one schedule to edit its authorized references.", []string{"spaceId"}, integrationObjectSchema(list), false, a.listWorkSchedules},
		{"work_schedules_get", "读取定时事项: returns schedule, its configuration revision, template, rule and authorized references. A failed rule has lastError and no nextRunAt; repair/save its configuration to resume future periods, or manually retry the failed business date after the cause is fixed. Requires work:read.", []string{"spaceId", "id"}, nil, false, a.getWorkSchedule},
		{"work_schedules_create", "新建定时事项: use one stable ID and original normalized payload for retry-safe creation. enabled defaults true. Results, claims and activity cannot be copied into the template. Existing items never change when a template changes. Background generation revalidates the creating/editing user's authorization and token grants on every occurrence. Requires work:write and scopes for added references; write-only tokens receive an ID/revision receipt.", []string{"spaceId"}, integrationObjectSchema(create, "id", "name", "template", "rule"), true, a.createWorkSchedule},
		{"work_schedules_update", "修改/暂停/归档定时事项: patch top-level fields with expectedRevision. rule and template are whole replacements; omitted bookmarkIds/documentIds preserve stored references, [] explicitly clears. enabled=false pauses; archived=true archives. Resume schedules only future periods. Changes never rewrite generated work or permit a second item for the same schedule/business date. Saving rebinds execution to the editor's current authorization. Requires work:write.", []string{"spaceId", "id"}, updateSchema, true, a.updateWorkSchedule},
		{"work_schedules_preview", "预览定时事项: validate a rule and return up to five future occurrences {businessDate,scheduledAt,dueAt}. after defaults now. Read-only preview persists nothing and needs work:read.", []string{"spaceId"}, integrationObjectSchema(map[string]any{"rule": rule, "limit": integer(1, 5), "after": text(40, "Optional RFC3339 timestamp; only strictly later scheduled times are returned.")}, "rule"), false, a.previewWorkSchedules},
		{"work_schedules_generate", "手动生成定时事项: generate today's rule occurrence or the supplied valid businessDate under the rule's saved, freshly checked authorization. Allowed while paused, forbidden when archived. Same schedule/date is idempotent across HTTP, MCP and timer execution, even after template/time edits. Read occurrence.result: created, skipped or failed; an HTTP success alone does not mean work was created. Failed receipts can be retried after repair. Requires work:write; expectedRevision is required.", []string{"spaceId", "id"}, integrationObjectSchema(map[string]any{"expectedRevision": revision, "businessDate": date}, "expectedRevision"), true, a.generateWorkSchedule},
		{"work_schedules_occurrences", "定时事项生成记录: paginate newest business dates with stable item IDs, result/reason, actual occurredAt and templateRevision. failed is observable failure, skipped includes recovery/overlap policy decisions. all recovery records at most seven recent generations plus an explicit bounded-window omission receipt. Requires work:read.", []string{"spaceId", "id"}, integrationObjectSchema(page), false, a.listWorkScheduleOccurrences},
	}
	for i := range tools {
		tools[i].description = "Ordinary item collaboration is discoverable through space_current and work_sessions_open; schedule configuration/generation needs no Agent claim or session. " + tools[i].description
	}
	return tools
}
