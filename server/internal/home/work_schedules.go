package home

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"time"
)

// A template deliberately cannot contain results, claims or activity history.
type WorkScheduleTemplate struct {
	WorkPlanningFields
	Title          string   `json:"title"`
	ProjectID      *string  `json:"projectId"`
	Status         string   `json:"status"`
	Description    string   `json:"description"`
	NextStep       string   `json:"nextStep"`
	NeedsAttention bool     `json:"needsAttention"`
	BookmarkIDs    []string `json:"bookmarkIds"`
	DocumentIDs    []string `json:"documentIds"`
}

func (in WorkScheduleTemplate) workInput() workCreateInput {
	return workCreateInput{WorkPlanningFields: in.WorkPlanningFields, Title: in.Title, ProjectID: in.ProjectID, Status: in.Status, Description: in.Description, NextStep: in.NextStep, NeedsAttention: in.NeedsAttention, BookmarkIDs: in.BookmarkIDs, DocumentIDs: in.DocumentIDs}
}

type WorkSchedule struct {
	ID                   string               `json:"id"`
	SpaceID              string               `json:"spaceId"`
	Name                 string               `json:"name"`
	Template             WorkScheduleTemplate `json:"template"`
	Rule                 WorkScheduleRule     `json:"rule"`
	Enabled              bool                 `json:"enabled"`
	Archived             bool                 `json:"archived"`
	MissedPolicy         string               `json:"missedPolicy"`
	OverlapPolicy        string               `json:"overlapPolicy"`
	Revision             string               `json:"revision"`
	CreatedAt            string               `json:"createdAt"`
	UpdatedAt            string               `json:"updatedAt"`
	NextRunAt            string               `json:"nextRunAt"`
	LastRunAt            string               `json:"lastRunAt"`
	LastResult           string               `json:"lastResult"`
	LastError            string               `json:"lastError"`
	References           []WorkReference      `json:"references"`
	notificationsEnabled bool
	userID               string
	tokenHash            string
	createHash           string
}

const workScheduleColumns = "id,space_id,name,template_json,rule_json,enabled,archived,missed_policy,overlap_policy,revision,created_at,updated_at,next_run_at,last_run_at,last_result,last_error,COALESCE(user_id,''),token_hash,create_hash,(SELECT work_notifications_enabled FROM spaces WHERE spaces.id=work_schedules.space_id)"

func scanWorkSchedule(row interface{ Scan(...any) error }) (*WorkSchedule, error) {
	value := &WorkSchedule{References: []WorkReference{}}
	var template, rule string
	var revision int64
	err := row.Scan(&value.ID, &value.SpaceID, &value.Name, &template, &rule, &value.Enabled, &value.Archived, &value.MissedPolicy, &value.OverlapPolicy, &revision, &value.CreatedAt, &value.UpdatedAt, &value.NextRunAt, &value.LastRunAt, &value.LastResult, &value.LastError, &value.userID, &value.tokenHash, &value.createHash, &value.notificationsEnabled)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, missing()
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal([]byte(template), &value.Template); err != nil {
		return nil, err
	}
	if err = json.Unmarshal([]byte(rule), &value.Rule); err != nil {
		return nil, err
	}
	value.Revision = strconv.FormatInt(revision, 10)
	return value, nil
}

func (a *App) loadWorkSchedule(r *Request, space, id string) (*WorkSchedule, error) {
	if !validID(id) {
		return nil, missing()
	}
	return scanWorkSchedule(r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+workScheduleColumns+" FROM work_schedules WHERE id=? AND space_id=?"), id, space))
}

func (a *App) registerWorkScheduleRoutes(base string) {
	a.route("GET "+base+"/schedules", false, a.listWorkSchedules)
	a.route("POST "+base+"/schedules", true, a.createWorkSchedule)
	a.route("POST "+base+"/schedules/preview", false, a.previewWorkSchedules)
	a.route("GET "+base+"/schedules/{id}", false, a.getWorkSchedule)
	a.route("PATCH "+base+"/schedules/{id}", true, a.updateWorkSchedule)
	a.route("POST "+base+"/schedules/{id}/generate", true, a.generateWorkSchedule)
	a.route("GET "+base+"/schedules/{id}/occurrences", false, a.listWorkScheduleOccurrences)
}

func (a *App) normalizeWorkSchedule(r *Request, value *WorkSchedule, previous *WorkSchedule) error {
	var err error
	value.Name, err = required(value.Name, "name", 160)
	if err != nil {
		return err
	}
	if err = validateWorkScheduleRule(&value.Rule); err != nil {
		return err
	}
	if value.MissedPolicy != "latest" && value.MissedPolicy != "skip" && value.MissedPolicy != "all" {
		return invalid("missedPolicy must be latest, skip or all (at most seven recent occurrences).")
	}
	if value.OverlapPolicy != "create" && value.OverlapPolicy != "skip" {
		return invalid("overlapPolicy must be create or skip.")
	}
	var old *WorkScheduleTemplate
	if previous != nil {
		old = &previous.Template
	}
	return a.normalizeWorkTemplate(r, value.SpaceID, &value.Template, old)
}

func (a *App) createWorkSchedule(r *Request) (*Response, error) {
	space, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	var in struct {
		ID            string               `json:"id"`
		Name          string               `json:"name"`
		Template      WorkScheduleTemplate `json:"template"`
		Rule          WorkScheduleRule     `json:"rule"`
		Enabled       json.RawMessage      `json:"enabled"`
		MissedPolicy  string               `json:"missedPolicy"`
		OverlapPolicy string               `json:"overlapPolicy"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if !validID(in.ID) {
		return nil, invalid("id must be 32 lowercase hexadecimal characters.")
	}
	if in.MissedPolicy == "" {
		in.MissedPolicy = "latest"
	}
	if in.OverlapPolicy == "" {
		in.OverlapPolicy = "create"
	}
	enabled := true
	if in.Enabled != nil {
		if string(in.Enabled) == "null" {
			return nil, invalid("enabled cannot be null.")
		}
		if err = json.Unmarshal(in.Enabled, &enabled); err != nil {
			return nil, invalid("enabled must be a boolean.")
		}
	}
	in.Enabled = json.RawMessage(strconv.FormatBool(enabled))
	// The creation identity uses normalized caller intent before resolving the
	// mutable default status, just as ordinary work creation does.
	in.Name, err = required(in.Name, "name", 160)
	if err != nil {
		return nil, err
	}
	template := in.Template.workInput()
	if err = validateWorkText(&template); err != nil {
		return nil, err
	}
	in.Template.Title = template.Title
	in.Template.WorkPlanningFields = template.WorkPlanningFields
	in.Template.BookmarkIDs, err = workIDs(in.Template.BookmarkIDs)
	if err != nil {
		return nil, err
	}
	in.Template.DocumentIDs, err = workIDs(in.Template.DocumentIDs)
	if err != nil {
		return nil, err
	}
	if err = validateWorkScheduleRule(&in.Rule); err != nil {
		return nil, err
	}
	hash := workPayloadHash(in)
	old, err := a.loadWorkSchedule(r, space.ID, in.ID)
	if err == nil {
		if old.createHash != hash {
			return nil, workConflict("work_schedule_id_conflict", "The schedule ID already belongs to another creation intent.", old.Revision)
		}
		return a.workScheduleReply(r, old, map[string]any{"replayed": true})
	}
	var api *APIError
	if !errors.As(err, &api) || api.Status != 404 {
		return nil, err
	}
	value := &WorkSchedule{ID: in.ID, SpaceID: space.ID, Name: in.Name, Template: in.Template, Rule: in.Rule, Enabled: enabled, MissedPolicy: in.MissedPolicy, OverlapPolicy: in.OverlapPolicy, Revision: "1", createHash: hash, userID: r.User.ID, tokenHash: r.BearerTokenHash}
	if err = a.normalizeWorkSchedule(r, value, nil); err != nil {
		return nil, err
	}
	now := time.Now()
	value.CreatedAt, value.UpdatedAt = workScheduleStamp(now), workScheduleStamp(now)
	if value.Enabled {
		value.NextRunAt = nextWorkScheduleStamp(value.Rule, now)
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_schedules(id,space_id,name,template_json,rule_json,enabled,archived,missed_policy,overlap_policy,revision,created_at,updated_at,create_hash,user_id,token_hash,next_run_at) VALUES(?,?,?,?,?,?,?, ?,?,1,?,?,?,?,?,?)"), value.ID, value.SpaceID, value.Name, jsonString(value.Template), jsonString(value.Rule), value.Enabled, value.Archived, value.MissedPolicy, value.OverlapPolicy, value.CreatedAt, value.UpdatedAt, hash, value.userID, value.tokenHash, value.NextRunAt)
	if err != nil {
		return nil, err
	}
	r.WakeWorkSchedules = true
	return a.workScheduleReply(r, value, map[string]any{"created": true})
}

func (a *App) updateWorkSchedule(r *Request) (*Response, error) {
	space, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	old, err := a.loadWorkSchedule(r, space.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var raw map[string]json.RawMessage
	if err = r.decode(&raw); err != nil {
		return nil, err
	}
	allowed := map[string]bool{"expectedRevision": true, "name": true, "template": true, "rule": true, "enabled": true, "archived": true, "missedPolicy": true, "overlapPolicy": true}
	for key := range raw {
		if !allowed[key] {
			return nil, invalid("Unknown schedule field: " + key)
		}
	}
	var revision string
	if err = workDecodeField(raw, "expectedRevision", &revision, false); err != nil {
		return nil, err
	}
	if revision == "" {
		return nil, invalid("expectedRevision is required.")
	}
	if revision != old.Revision {
		return nil, workConflict("work_schedule_version_conflict", "The schedule changed. Reload and compare before editing.", old.Revision)
	}
	if len(raw) < 2 {
		return nil, invalid("At least one schedule field is required.")
	}
	value := *old
	for _, field := range []struct {
		name   string
		target any
	}{{"name", &value.Name}, {"enabled", &value.Enabled}, {"archived", &value.Archived}, {"missedPolicy", &value.MissedPolicy}, {"overlapPolicy", &value.OverlapPolicy}} {
		if err = workDecodeField(raw, field.name, field.target, false); err != nil {
			return nil, err
		}
	}
	if body, supplied := raw["rule"]; supplied {
		value.Rule = WorkScheduleRule{}
		if err = decodeScheduleObject(body, &value.Rule); err != nil {
			return nil, err
		}
	}
	if body, supplied := raw["template"]; supplied {
		value.Template, err = decodeWorkTemplatePatch(body, old.Template)
		if err != nil {
			return nil, err
		}
	}

	if err = a.normalizeWorkSchedule(r, &value, old); err != nil {
		return nil, err
	}
	unchanged := value.Name == old.Name && reflect.DeepEqual(value.Template, old.Template) && reflect.DeepEqual(value.Rule, old.Rule) && value.Enabled == old.Enabled && value.Archived == old.Archived && value.MissedPolicy == old.MissedPolicy && value.OverlapPolicy == old.OverlapPolicy
	// Saving an unchanged failed rule explicitly retries its future execution
	// under the editor's current authorization, without replaying paused dates.
	if unchanged && old.LastError == "" {
		return a.workScheduleReply(r, old, map[string]any{"unchanged": true})
	}
	now := time.Now()
	if !value.Enabled || value.Archived {
		value.NextRunAt = ""
	} else if !old.Enabled || old.Archived || old.LastError != "" || !reflect.DeepEqual(value.Rule, old.Rule) {
		value.NextRunAt = nextWorkScheduleStamp(value.Rule, now)
	}
	value.LastError = ""
	value.UpdatedAt = workScheduleStamp(now)
	rev, _ := strconv.ParseInt(old.Revision, 10, 64)
	value.Revision = strconv.FormatInt(rev+1, 10)
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_schedules SET name=?,template_json=?,rule_json=?,enabled=?,archived=?,missed_policy=?,overlap_policy=?,revision=revision+1,updated_at=?,user_id=?,token_hash=?,next_run_at=?,last_error='' WHERE id=? AND space_id=?"), value.Name, jsonString(value.Template), jsonString(value.Rule), value.Enabled, value.Archived, value.MissedPolicy, value.OverlapPolicy, value.UpdatedAt, r.User.ID, r.BearerTokenHash, value.NextRunAt, value.ID, value.SpaceID)
	if err != nil {
		return nil, err
	}
	r.WakeWorkSchedules = true
	return a.workScheduleReply(r, &value, nil)
}

func decodeScheduleObject(body json.RawMessage, target any) error {
	if len(body) == 0 || body[0] != '{' {
		return invalid("Expected a work configuration object.")
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return invalid("Invalid work configuration object: " + err.Error())
	}
	return nil
}

func (a *App) getWorkSchedule(r *Request) (*Response, error) {
	space, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	value, err := a.loadWorkSchedule(r, space.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	return a.workScheduleReply(r, value, nil)
}

func (a *App) workScheduleReply(r *Request, stored *WorkSchedule, flags map[string]any) (*Response, error) {
	result := map[string]any{"id": stored.ID, "revision": stored.Revision}
	if r.workReads("work:read") {
		value := *stored
		if err := a.workScheduleReferences(r, &value); err != nil {
			return nil, err
		}
		result = map[string]any{"schedule": &value, "canEdit": !r.Bearer || r.AllowedActions["work:write"]}
	}
	for key, flag := range flags {
		result[key] = flag
	}
	return ok(result), nil
}

func (a *App) workScheduleReferences(r *Request, value *WorkSchedule) error {
	refs, err := a.workTemplateReferences(r, value.SpaceID, &value.Template)
	if err != nil {
		return err
	}
	value.References = refs
	return nil
}

type workScheduleListInput struct {
	Archived bool   `json:"archived"`
	Q        string `json:"q"`
	Limit    int    `json:"limit"`
	Cursor   string `json:"cursor"`
}

type workScheduleCursor struct {
	Filter string `json:"f"`
	Stamp  string `json:"s"`
	ID     string `json:"i"`
}

func (a *App) listWorkSchedules(r *Request) (*Response, error) {
	space, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	in := workScheduleListInput{Limit: 30}
	if r.Input != nil {
		if err = r.decode(&in); err != nil {
			return nil, err
		}
	} else {
		q := r.HTTP.URL.Query()
		in.Q, in.Cursor = q.Get("q"), q.Get("cursor")
		if text := q.Get("archived"); text != "" {
			if text != "true" && text != "false" {
				return nil, invalid("archived must be true or false.")
			}
			in.Archived = text == "true"
		}
		if q.Get("limit") != "" {
			in.Limit, err = strconv.Atoi(q.Get("limit"))
			if err != nil {
				return nil, invalid("Invalid limit.")
			}
		}
	}
	if in.Limit == 0 {
		in.Limit = 30
	}
	in.Q = strings.TrimSpace(in.Q)
	if in.Limit < 1 || in.Limit > 100 || len(in.Cursor) > 2048 {
		return nil, invalid("Use limit 1–100 and a bounded cursor.")
	}
	if err = bounded(in.Q, "q", 200); err != nil {
		return nil, err
	}
	where, args := "space_id=? AND archived=?", []any{space.ID, in.Archived}
	if in.Q != "" {
		where += " AND LOWER(name) LIKE ? ESCAPE '\\'"
		args = append(args, workLike(in.Q))
	}
	var total int
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_schedules WHERE "+where), args...).Scan(&total); err != nil {
		return nil, err
	}
	fingerprint := workPayloadHash([]any{space.ID, in.Archived, in.Q})
	if in.Cursor != "" {
		var cursor workScheduleCursor
		body, err := base64.RawURLEncoding.DecodeString(in.Cursor)
		if err != nil || json.Unmarshal(body, &cursor) != nil || cursor.Filter != fingerprint || !validID(cursor.ID) {
			return nil, invalid("Invalid schedule cursor for these filters.")
		}
		where += " AND (created_at<? OR (created_at=? AND id<?))"
		args = append(args, cursor.Stamp, cursor.Stamp, cursor.ID)
	}
	args = append(args, in.Limit+1)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+workScheduleColumns+" FROM work_schedules WHERE "+where+" ORDER BY created_at DESC,id DESC LIMIT ?"), args...)
	if err != nil {
		return nil, err
	}
	items := []*WorkSchedule{}
	for rows.Next() {
		value, err := scanWorkSchedule(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		if !r.workReads("navigation:read") {
			value.Template.BookmarkIDs = []string{}
		}
		if !r.workReads("documents:read") {
			value.Template.DocumentIDs = []string{}
		}
		items = append(items, value)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	var next *string
	if len(items) > in.Limit {
		items = items[:in.Limit]
		last := items[len(items)-1]
		body, _ := json.Marshal(workScheduleCursor{fingerprint, last.CreatedAt, last.ID})
		cursor := base64.RawURLEncoding.EncodeToString(body)
		next = &cursor
	}
	return ok(map[string]any{"items": items, "total": total, "nextCursor": next, "canEdit": space.CanEdit}), nil
}

func (a *App) previewWorkSchedules(r *Request) (*Response, error) {
	if _, err := r.workSpace(false); err != nil {
		return nil, err
	}
	var in struct {
		Rule  WorkScheduleRule `json:"rule"`
		Limit int              `json:"limit"`
		After string           `json:"after"`
	}
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	if err := validateWorkScheduleRule(&in.Rule); err != nil {
		return nil, err
	}
	if in.Limit == 0 {
		in.Limit = 5
	}
	if in.Limit < 1 || in.Limit > 5 {
		return nil, invalid("Preview limit must be 1–5.")
	}
	after := time.Now()
	if in.After != "" {
		var err error
		after, err = time.Parse(time.RFC3339Nano, in.After)
		if err != nil {
			return nil, invalid("after must be an RFC3339 timestamp.")
		}
	}
	items := []WorkSchedulePreview{}
	for len(items) < in.Limit {
		occurrence, found := nextWorkSchedule(in.Rule, after)
		if !found {
			break
		}
		items = append(items, occurrence)
		after, _ = time.Parse(time.RFC3339Nano, occurrence.ScheduledAt)
	}
	return ok(map[string]any{"items": items, "timezone": in.Rule.Timezone}), nil
}
