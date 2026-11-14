package home

import (
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"time"
)

type WorkAutomationRule struct {
	ID                            string               `json:"id"`
	SpaceID                       string               `json:"spaceId"`
	Name                          string               `json:"name"`
	EventType                     string               `json:"eventType"`
	ProjectID                     *string              `json:"projectId"`
	StatusID                      string               `json:"statusId"`
	Template                      WorkScheduleTemplate `json:"template"`
	ExecutorID                    *string              `json:"executorId"`
	Enabled                       bool                 `json:"enabled"`
	Archived                      bool                 `json:"archived"`
	Revision                      string               `json:"revision"`
	CreatedAt                     string               `json:"createdAt"`
	UpdatedAt                     string               `json:"updatedAt"`
	References                    []WorkReference      `json:"references"`
	userID, tokenHash, createHash string
}

const workAutomationRuleColumns = "id,space_id,name,event_type,project_id,status_id,template_json,executor_id,enabled,archived,revision,created_at,updated_at,COALESCE(user_id,''),token_hash,create_hash"

func scanWorkAutomationRule(row interface{ Scan(...any) error }) (*WorkAutomationRule, error) {
	v := &WorkAutomationRule{References: []WorkReference{}}
	var project, executor sql.NullString
	var template string
	var revision int64
	err := row.Scan(&v.ID, &v.SpaceID, &v.Name, &v.EventType, &project, &v.StatusID, &template, &executor, &v.Enabled, &v.Archived, &revision, &v.CreatedAt, &v.UpdatedAt, &v.userID, &v.tokenHash, &v.createHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, missing()
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal([]byte(template), &v.Template); err != nil {
		return nil, err
	}
	v.ProjectID, v.ExecutorID, v.Revision = automationNullable(project), automationNullable(executor), strconv.FormatInt(revision, 10)
	return v, nil
}

func (a *App) loadWorkAutomationRule(r *Request, space, id string) (*WorkAutomationRule, error) {
	if !validID(id) {
		return nil, missing()
	}
	return scanWorkAutomationRule(r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+workAutomationRuleColumns+" FROM work_automation_rules WHERE id=? AND space_id=?"), id, space))
}

func (a *App) normalizeWorkAutomationRule(r *Request, v, old *WorkAutomationRule) error {
	var err error
	v.Name, err = required(v.Name, "name", 160)
	if err != nil {
		return err
	}
	if strings.HasPrefix(v.EventType, "work.") && v.EventType != "work.created" && v.EventType != "work.status_changed" && v.EventType != "work.completed" {
		return invalid("Unknown reserved work event type.")
	}
	if !workEventTypePattern.MatchString(v.EventType) {
		return invalid("eventType must start with a lowercase letter and contain at most 80 lowercase letters, digits, dots, underscores or hyphens.")
	}
	if old == nil || !reflect.DeepEqual(v.ProjectID, old.ProjectID) {
		if err = a.validateWorkProject(r, v.SpaceID, v.ProjectID); err != nil {
			return err
		}
	}
	if v.StatusID != "" && (old == nil || v.StatusID != old.StatusID) {
		if _, err = a.requireWorkStatus(r, v.SpaceID, v.StatusID); err != nil {
			return err
		}
	}
	var previous *WorkScheduleTemplate
	if old != nil {
		previous = &old.Template
	}
	if err = a.normalizeWorkTemplate(r, v.SpaceID, &v.Template, previous); err != nil {
		return err
	}
	if v.ExecutorID != nil {
		if !workCanExecute(r) {
			return forbidden()
		}
		executor, err := a.loadWorkExecutor(r, v.SpaceID, *v.ExecutorID)
		if err != nil {
			return err
		}
		if executor.Archived || (v.Enabled && (!executor.Enabled || !executor.CredentialConfigured)) {
			return workConflict("work_executor_unavailable", "Choose an available executor with a credential before enabling this rule.", executor.Revision)
		}
	}
	return nil
}

func (a *App) workAutomationRuleReply(r *Request, v *WorkAutomationRule, flags map[string]any) (*Response, error) {
	if !r.workReads("work:read") {
		out := map[string]any{"id": v.ID, "revision": v.Revision}
		for k, value := range flags {
			out[k] = value
		}
		return ok(out), nil
	}
	var err error
	v.References, err = a.workTemplateReferences(r, v.SpaceID, &v.Template)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"rule": v, "canEdit": r.WorkSpaceContext != nil && r.WorkSpaceContext.CanEdit, "canExecute": workCanExecute(r)}
	for k, v := range flags {
		out[k] = v
	}
	return ok(out), nil
}

func (a *App) getWorkAutomationRule(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	v, err := a.loadWorkAutomationRule(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	return a.workAutomationRuleReply(r, v, nil)
}

func (a *App) createWorkAutomationRule(r *Request) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	var in struct {
		ID         string               `json:"id"`
		Name       string               `json:"name"`
		EventType  string               `json:"eventType"`
		ProjectID  *string              `json:"projectId"`
		StatusID   string               `json:"statusId"`
		Template   WorkScheduleTemplate `json:"template"`
		ExecutorID *string              `json:"executorId"`
		Enabled    json.RawMessage      `json:"enabled"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if !validID(in.ID) {
		return nil, invalid("id must be 32 lowercase hexadecimal characters.")
	}
	enabled, err := automationBool(in.Enabled, false)
	if err != nil {
		return nil, err
	}
	in.Name, err = required(in.Name, "name", 160)
	if err != nil {
		return nil, err
	}
	text := in.Template.workInput("")
	if err = validateWorkText(&text); err != nil {
		return nil, err
	}
	in.Template.Title = text.Title
	in.Template.WorkPlanningFields = text.WorkPlanningFields
	in.Template.BookmarkIDs, err = workIDs(in.Template.BookmarkIDs)
	if err != nil {
		return nil, err
	}
	in.Template.DocumentIDs, err = workIDs(in.Template.DocumentIDs)
	if err != nil {
		return nil, err
	}
	in.Enabled = json.RawMessage(strconv.FormatBool(enabled))
	hash := workPayloadHash(in)
	old, err := a.loadWorkAutomationRule(r, s.ID, in.ID)
	if err == nil {
		if old.createHash != hash {
			return nil, workConflict("work_automation_rule_id_conflict", "This ID already identifies different rule creation content.", old.Revision)
		}
		return a.workAutomationRuleReply(r, old, map[string]any{"replayed": true})
	}
	if code, _, domain := automationFailure(err); !domain || code != "not_found" {
		return nil, err
	}
	v := &WorkAutomationRule{ID: in.ID, SpaceID: s.ID, Name: in.Name, EventType: in.EventType, ProjectID: in.ProjectID, StatusID: in.StatusID, Template: in.Template, ExecutorID: in.ExecutorID, Enabled: enabled, Revision: "1", CreatedAt: workScheduleStamp(time.Now()), userID: r.User.ID, tokenHash: r.BearerTokenHash, createHash: hash}
	if err = a.normalizeWorkAutomationRule(r, v, nil); err != nil {
		return nil, err
	}
	v.UpdatedAt = v.CreatedAt
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_automation_rules(id,space_id,name,event_type,project_id,status_id,template_json,executor_id,enabled,archived,revision,user_id,token_hash,created_at,updated_at,create_hash) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)"), v.ID, s.ID, v.Name, v.EventType, v.ProjectID, v.StatusID, jsonString(v.Template), v.ExecutorID, v.Enabled, false, v.userID, v.tokenHash, v.CreatedAt, v.UpdatedAt, hash)
	if err != nil {
		return nil, err
	}
	if v.Enabled {
		if err = a.changeWorkAutomationRuleCount(r, s, 1); err != nil {
			return nil, err
		}
	}
	r.WakeWorkAutomation = true
	return a.workAutomationRuleReply(r, v, map[string]any{"created": true})
}

func (a *App) changeWorkAutomationRuleCount(r *Request, s *Space, delta int) error {
	_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE spaces SET work_automation_rule_count=work_automation_rule_count+? WHERE id=?"), delta, s.ID)
	if err == nil {
		s.WorkAutomationRuleCount += delta
	}
	return err
}

func (a *App) updateWorkAutomationRule(r *Request) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	old, err := a.loadWorkAutomationRule(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var raw map[string]json.RawMessage
	if err = r.decode(&raw); err != nil {
		return nil, err
	}
	allowed := map[string]bool{"expectedRevision": true, "name": true, "eventType": true, "projectId": true, "statusId": true, "template": true, "executorId": true, "enabled": true, "archived": true}
	for key := range raw {
		if !allowed[key] {
			return nil, invalid("Unknown rule field: " + key)
		}
	}
	if len(raw) < 2 {
		return nil, invalid("At least one rule field is required.")
	}
	var expected string
	if err = workDecodeField(raw, "expectedRevision", &expected, false); err != nil {
		return nil, err
	}
	if err = automationRevision(expected, old.Revision, "automation_rule"); err != nil {
		return nil, err
	}
	v := *old
	if old.ProjectID != nil {
		value := *old.ProjectID
		v.ProjectID = &value
	}
	if old.ExecutorID != nil {
		value := *old.ExecutorID
		v.ExecutorID = &value
	}
	for _, field := range []struct {
		name     string
		target   any
		nullable bool
	}{{"name", &v.Name, false}, {"eventType", &v.EventType, false}, {"projectId", &v.ProjectID, true}, {"statusId", &v.StatusID, false}, {"executorId", &v.ExecutorID, true}, {"enabled", &v.Enabled, false}, {"archived", &v.Archived, false}} {
		if err = workDecodeField(raw, field.name, field.target, field.nullable); err != nil {
			return nil, err
		}
	}
	if body, supplied := raw["template"]; supplied {
		v.Template, err = decodeWorkTemplatePatch(body, old.Template)
		if err != nil {
			return nil, err
		}
	}
	// Removing an executor is still a change to an execution-capable rule.
	if old.ExecutorID != nil && !workCanExecute(r) {
		return nil, forbidden()
	}
	if err = a.normalizeWorkAutomationRule(r, &v, old); err != nil {
		return nil, err
	}
	if reflect.DeepEqual(v, *old) && old.userID == r.User.ID && old.tokenHash == r.BearerTokenHash {
		return a.workAutomationRuleReply(r, old, map[string]any{"unchanged": true})
	}
	rev, _ := strconv.ParseInt(old.Revision, 10, 64)
	v.Revision, v.UpdatedAt = strconv.FormatInt(rev+1, 10), workScheduleStamp(time.Now())
	v.userID, v.tokenHash = r.User.ID, r.BearerTokenHash
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_automation_rules SET name=?,event_type=?,project_id=?,status_id=?,template_json=?,executor_id=?,enabled=?,archived=?,revision=revision+1,user_id=?,token_hash=?,updated_at=? WHERE id=?"), v.Name, v.EventType, v.ProjectID, v.StatusID, jsonString(v.Template), v.ExecutorID, v.Enabled, v.Archived, v.userID, v.tokenHash, v.UpdatedAt, v.ID)
	if err != nil {
		return nil, err
	}
	was, now := old.Enabled && !old.Archived, v.Enabled && !v.Archived
	if was != now {
		delta := -1
		if now {
			delta = 1
		}
		if err = a.changeWorkAutomationRuleCount(r, s, delta); err != nil {
			return nil, err
		}
	}
	r.WakeWorkAutomation = true
	return a.workAutomationRuleReply(r, &v, nil)
}

func (a *App) listWorkAutomationRules(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	in, err := readWorkAutomationPage(r, "rules")
	if err != nil {
		return nil, err
	}
	where, args := "space_id=? AND archived=?", []any{s.ID, in.Archived}
	if in.Q != "" {
		where += " AND LOWER(name) LIKE ? ESCAPE '\\'"
		args = append(args, "%"+automationEscapeLike(strings.ToLower(in.Q))+"%")
	}
	if in.EventType != "" {
		where += " AND event_type=?"
		args = append(args, in.EventType)
	}
	where, args, filter, err := workAutomationPageWhere("rules", s.ID, where, args, in)
	if err != nil {
		return nil, err
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+workAutomationRuleColumns+" FROM work_automation_rules WHERE "+where+" ORDER BY created_at DESC,id DESC LIMIT ?"), args...)
	if err != nil {
		return nil, err
	}
	items := []*WorkAutomationRule{}
	for rows.Next() {
		v, e := scanWorkAutomationRule(rows)
		if e != nil {
			rows.Close()
			return nil, e
		}
		items = append(items, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	var cursor *string
	if len(items) > in.Limit {
		items = items[:in.Limit]
		last := items[len(items)-1]
		cursor = workAutomationNextCursor(filter, last.CreatedAt, last.ID)
	}
	// List cards omit reference projections; the detail endpoint resolves them lazily.
	for _, v := range items {
		v.Template.BookmarkIDs = []string{}
		v.Template.DocumentIDs = []string{}
	}
	return ok(map[string]any{"items": items, "nextCursor": cursor, "canEdit": s.CanEdit, "canExecute": workCanExecute(r)}), nil
}

func automationEscapeLike(value string) string {
	return strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(value)
}
