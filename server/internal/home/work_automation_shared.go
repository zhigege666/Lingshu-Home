package home

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const workAutomationQueueLimit = 1000
const workAutomationMatchLimit = 25

var workEventTypePattern = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,79}$`)
var workResourceKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$`)

func (a *App) registerWorkAutomationRoutes() {
	base := "/api/v1/spaces/{spaceId}/work"
	a.route("GET "+base+"/automation/settings", false, a.getWorkAutomationSettings)
	a.route("PATCH "+base+"/automation/settings", true, a.updateWorkAutomationSettings)
	a.route("GET "+base+"/automation/rules", false, a.listWorkAutomationRules)
	a.route("POST "+base+"/automation/rules", true, a.createWorkAutomationRule)
	a.route("GET "+base+"/automation/rules/{id}", false, a.getWorkAutomationRule)
	a.route("PATCH "+base+"/automation/rules/{id}", true, a.updateWorkAutomationRule)
	a.route("GET "+base+"/automation/events", false, a.listWorkAutomationEvents)
	a.route("POST "+base+"/automation/events", true, a.publishWorkAutomationEvent)
	a.route("GET "+base+"/automation/events/{id}", false, a.getWorkAutomationEvent)
	a.route("POST "+base+"/automation/events/{id}/retry", true, a.retryWorkAutomationEvent)
	a.route("GET "+base+"/executors", false, a.listWorkExecutors)
	a.route("POST "+base+"/executors", true, a.createWorkExecutor)
	a.route("GET "+base+"/executors/{id}", false, a.getWorkExecutor)
	a.route("PATCH "+base+"/executors/{id}", true, a.updateWorkExecutor)
	a.route("GET "+base+"/executions", false, a.listWorkExecutions)
	a.route("POST "+base+"/executions", true, a.startWorkExecution)
	a.route("GET "+base+"/executions/{id}", false, a.getWorkExecution)
	a.route("POST "+base+"/executions/{id}/reconcile", true, a.reconcileWorkExecution)
	a.route("POST "+base+"/executions/{id}/resolve", true, a.resolveWorkExecution)
}

func (r *Request) workExecuteSpace() (*Space, error) {
	space, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	if err = r.requireAction("work:read"); err != nil {
		return nil, err
	}
	if err = r.requireAction("work:execute"); err != nil {
		return nil, err
	}
	return space, nil
}

func workCanExecute(r *Request) bool {
	return r.User != nil && (!r.Bearer || (r.AllowedActions["work:read"] && r.AllowedActions["work:write"] && r.AllowedActions["work:execute"]))
}

// This owner check applies only to an explicitly scoped executor operation.
// The global Cookie-only requireOwner remains unchanged.
func requireWorkExecutorOwner(r *Request) error {
	if r.User == nil {
		return unauthorized()
	}
	if r.User.Role != "Owner" || !workCanExecute(r) {
		return forbidden()
	}
	return nil
}

func automationRevision(expected, actual, entity string) error {
	value, err := integrationRevision(expected)
	if err != nil || value < 1 {
		return invalid("expectedRevision must be a canonical positive decimal string.")
	}
	if expected != actual {
		return workConflict("work_"+entity+"_version_conflict", "The record changed. Reload and compare the intended fields before retrying.", actual)
	}
	return nil
}

func automationBool(raw json.RawMessage, current bool) (bool, error) {
	if len(raw) == 0 {
		return current, nil
	}
	var value bool
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil {
		return false, invalid("Boolean fields cannot be null and must be true or false.")
	}
	return value, nil
}

func decodeAutomationJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return invalid("Invalid object or unknown fields.")
	}
	return nil
}

func automationFailure(err error) (code, message string, domain bool) {
	var api *APIError
	if errors.As(err, &api) {
		return api.Code, api.Message, true
	}
	return "", "", false
}

func (a *App) workAutomationActorRequest(ctx context.Context, q Queryer, settings Settings, space, userID, tokenHash, origin string) (*Request, error) {
	h, err := http.NewRequestWithContext(withDocumentActivityOrigin(ctx, origin), "POST", "http://localhost/internal/work-automation", nil)
	if err != nil {
		return nil, err
	}
	r := &Request{App: a, HTTP: h, Q: q, Settings: settings, Params: map[string]string{"spaceId": space}}
	if tokenHash != "" {
		err = a.authenticateBearerHash(r, tokenHash)
	} else {
		r.User, err = a.loadUser(ctx, q, userID)
		if err == nil && (r.User == nil || !canLogin(r.User, settings)) {
			err = unauthorized()
		}
	}
	if err != nil {
		return r, err
	}
	_, err = r.workSpace(true)
	return r, err
}

type workAutomationPage struct {
	Limit     int    `json:"limit"`
	Cursor    string `json:"cursor"`
	Archived  bool   `json:"archived"`
	Q         string `json:"q"`
	EventType string `json:"eventType"`
	State     string `json:"state"`
	ItemID    string `json:"itemId"`
}

func readWorkAutomationPage(r *Request, kind string) (workAutomationPage, error) {
	in := workAutomationPage{Limit: 30}
	if r.Input != nil {
		if err := r.decode(&in); err != nil {
			return in, err
		}
	} else {
		q := r.HTTP.URL.Query()
		in.Cursor, in.Q, in.EventType, in.State, in.ItemID = q.Get("cursor"), q.Get("q"), q.Get("eventType"), q.Get("state"), q.Get("itemId")
		var err error
		if q.Has("limit") {
			in.Limit, err = strconv.Atoi(q.Get("limit"))
			if err != nil {
				return in, invalid("Invalid limit.")
			}
		}
		if q.Has("archived") {
			if q.Get("archived") != "true" && q.Get("archived") != "false" {
				return in, invalid("Invalid archived filter.")
			}
			in.Archived = q.Get("archived") == "true"
		}
	}
	if in.Limit == 0 {
		in.Limit = 30
	}
	if in.Limit < 1 || in.Limit > 100 || len(in.Cursor) > 2048 || len(in.Q) > 200 {
		return in, invalid("Use limit 1–100, a bounded cursor and search text.")
	}
	if in.EventType != "" && !workEventTypePattern.MatchString(in.EventType) {
		return in, invalid("Invalid eventType.")
	}
	if in.ItemID != "" && kind != "executions" || in.EventType != "" && kind != "rules" && kind != "events" || in.State != "" && kind != "events" && kind != "executions" || in.Archived && kind != "rules" && kind != "executors" {
		return in, invalid("This filter is not supported by this collection.")
	}
	if in.Q != "" && kind != "rules" && kind != "executors" {
		return in, invalid("Text search is supported for rules and executors only.")
	}
	in.Q = strings.TrimSpace(in.Q)
	return in, nil
}

type workAutomationCursor struct {
	Filter string `json:"f"`
	Stamp  string `json:"t"`
	ID     string `json:"i"`
}

func workAutomationPageWhere(kind, space, where string, args []any, in workAutomationPage) (string, []any, string, error) {
	filter := workPayloadHash([]any{kind, space, in.Archived, in.Q, in.EventType, in.State, in.ItemID})
	if in.Cursor != "" {
		var cursor workAutomationCursor
		body, err := base64.RawURLEncoding.DecodeString(in.Cursor)
		if err != nil || json.Unmarshal(body, &cursor) != nil || cursor.Filter != filter || !validID(cursor.ID) {
			return "", nil, "", invalid("Invalid cursor for this collection and filters.")
		}
		stamp, err := time.Parse(time.RFC3339Nano, cursor.Stamp)
		if err != nil || workScheduleStamp(stamp) != cursor.Stamp {
			return "", nil, "", invalid("Invalid cursor timestamp.")
		}
		where += " AND (created_at<? OR (created_at=? AND id<?))"
		args = append(args, cursor.Stamp, cursor.Stamp, cursor.ID)
	}
	return where, append(args, in.Limit+1), filter, nil
}

func workAutomationNextCursor(filter, stamp, id string) *string {
	body, _ := json.Marshal(workAutomationCursor{filter, stamp, id})
	value := base64.RawURLEncoding.EncodeToString(body)
	return &value
}

func (a *App) getWorkAutomationSettings(r *Request) (*Response, error) {
	space, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	return ok(map[string]any{"enabled": space.WorkAutomationEnabled, "revision": strconv.FormatInt(space.WorkAutomationRevision, 10), "canEdit": space.CanEdit}), nil
}

func (a *App) updateWorkAutomationSettings(r *Request) (*Response, error) {
	space, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	var in struct {
		ExpectedRevision string          `json:"expectedRevision"`
		Enabled          json.RawMessage `json:"enabled"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if len(in.Enabled) == 0 {
		return nil, invalid("enabled is required.")
	}
	if err = automationRevision(in.ExpectedRevision, strconv.FormatInt(space.WorkAutomationRevision, 10), "automation_settings"); err != nil {
		return nil, err
	}
	enabled, err := automationBool(in.Enabled, false)
	if err != nil {
		return nil, err
	}
	if enabled != space.WorkAutomationEnabled {
		if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE spaces SET work_automation_enabled=?,work_automation_revision=work_automation_revision+1 WHERE id=?"), enabled, space.ID); err != nil {
			return nil, err
		}
		space.WorkAutomationEnabled, space.WorkAutomationRevision = enabled, space.WorkAutomationRevision+1
		if !enabled {
			stamp := workScheduleStamp(time.Now())
			if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_automation_events SET state='skipped',code='automation_disabled',message='Event rules were disabled before processing.',processed_at=?,revision=revision+1 WHERE space_id=? AND state='queued'"), stamp, space.ID); err != nil {
				return nil, err
			}
			if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_executions SET state='canceled',code='automation_disabled',message='Event rules were disabled before dispatch.',finished_at=?,revision=revision+1 WHERE space_id=? AND state='queued' AND event_id IS NOT NULL"), stamp, space.ID); err != nil {
				return nil, err
			}
		}
		r.WakeWorkAutomation = true
	}
	r.WakeWorkAutomation = true // An explicit save also resumes a worker after its bounded storage-error budget.
	return ok(map[string]any{"enabled": enabled, "revision": strconv.FormatInt(space.WorkAutomationRevision, 10), "canEdit": true}), nil
}

func (a *App) workAutomationFailureSummary(r *Request, space string) (automationFailed, executionFailed, executionUnknown int, err error) {
	err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_automation_events WHERE space_id=? AND state='failed'"), space).Scan(&automationFailed)
	if err != nil {
		return
	}
	var receipts int
	err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_automation_receipts ar JOIN work_automation_events e ON e.id=ar.event_id WHERE e.space_id=? AND e.state<>'failed' AND ar.result='failed'"), space).Scan(&receipts)
	automationFailed += receipts
	if err != nil {
		return
	}
	rows, queryErr := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT e.state,COUNT(*) FROM work_executions e WHERE e.space_id=? AND e.state IN ('failed','unknown') AND NOT EXISTS (SELECT 1 FROM work_executions n WHERE n.item_id=e.item_id AND (n.created_at>e.created_at OR (n.created_at=e.created_at AND n.id>e.id))) GROUP BY e.state"), space)
	if queryErr != nil {
		err = queryErr
		return
	}
	defer rows.Close()
	for rows.Next() {
		var state string
		var count int
		if err = rows.Scan(&state, &count); err != nil {
			return
		}
		if state == "failed" {
			executionFailed = count
		} else {
			executionUnknown = count
		}
	}
	err = rows.Err()
	return
}

func automationNullable(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}
