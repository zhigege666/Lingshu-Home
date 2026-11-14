package home

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

type WorkExecution struct {
	ID                                                       string  `json:"id"`
	SpaceID                                                  string  `json:"spaceId"`
	ItemID                                                   string  `json:"itemId"`
	ExecutorID                                               string  `json:"executorId"`
	ExecutorName                                             string  `json:"executorName"`
	ExecutorRevision                                         string  `json:"executorRevision"`
	ItemRevision                                             string  `json:"itemRevision"`
	ResourceKey                                              string  `json:"resourceKey"`
	EventID                                                  *string `json:"eventId"`
	State                                                    string  `json:"state"`
	Revision                                                 string  `json:"revision"`
	CreatedAt                                                string  `json:"createdAt"`
	StartedAt                                                string  `json:"startedAt"`
	FinishedAt                                               string  `json:"finishedAt"`
	NextPollAt                                               string  `json:"nextPollAt"`
	DeadlineAt                                               string  `json:"deadlineAt"`
	Code                                                     string  `json:"code"`
	Message                                                  string  `json:"message"`
	Result                                                   string  `json:"result"`
	ManualResolution                                         bool    `json:"manualResolution"`
	snapshotJSON, contextJSON, userID, tokenHash, createHash string
	pollFailures                                             int
}

const workExecutionColumns = "id,space_id,item_id,executor_id,executor_name,executor_revision,item_revision,resource_key,event_id,state,revision,snapshot_json,context_json,COALESCE(user_id,''),token_hash,create_hash,created_at,started_at,finished_at,next_poll_at,deadline_at,poll_failures,code,message,result,manual_resolution"

func scanWorkExecution(row interface{ Scan(...any) error }) (*WorkExecution, error) {
	v := &WorkExecution{}
	var event sql.NullString
	var revision, itemRevision, executorRevision int64
	err := row.Scan(&v.ID, &v.SpaceID, &v.ItemID, &v.ExecutorID, &v.ExecutorName, &executorRevision, &itemRevision, &v.ResourceKey, &event, &v.State, &revision, &v.snapshotJSON, &v.contextJSON, &v.userID, &v.tokenHash, &v.createHash, &v.CreatedAt, &v.StartedAt, &v.FinishedAt, &v.NextPollAt, &v.DeadlineAt, &v.pollFailures, &v.Code, &v.Message, &v.Result, &v.ManualResolution)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, missing()
	}
	if err != nil {
		return nil, err
	}
	v.EventID = automationNullable(event)
	v.Revision = strconv.FormatInt(revision, 10)
	v.ItemRevision = strconv.FormatInt(itemRevision, 10)
	v.ExecutorRevision = strconv.FormatInt(executorRevision, 10)
	return v, nil
}

func (a *App) loadWorkExecution(r *Request, space, id string) (*WorkExecution, error) {
	if !validID(id) {
		return nil, missing()
	}
	return scanWorkExecution(r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+workExecutionColumns+" FROM work_executions WHERE id=? AND space_id=?"), id, space))
}

func workExecutionReply(r *Request, v *WorkExecution, flags map[string]any) *Response {
	out := map[string]any{"execution": v, "canExecute": workCanExecute(r), "canResolve": r.User != nil && r.User.Role == "Owner" && workCanExecute(r)}
	for k, v := range flags {
		out[k] = v
	}
	return ok(out)
}

func (a *App) getWorkExecution(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	v, err := a.loadWorkExecution(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	return workExecutionReply(r, v, nil), nil
}

type workExecutionStartInput struct {
	ID                   string          `json:"id"`
	ExecutorID           string          `json:"executorId"`
	ItemID               string          `json:"itemId"`
	ExpectedItemRevision string          `json:"expectedItemRevision"`
	Context              json.RawMessage `json:"context,omitempty"`
}

// The outgoing item is an immutable, explicit projection. It contains neither
// reference bodies, credentials, session transport metadata nor a claim grant.
func workExecutionPayload(id string, item *WorkItem, event *WorkAutomationEvent) (string, error) {
	body, err := json.Marshal(item)
	if err != nil {
		return "", err
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(body, &fields); err != nil {
		return "", err
	}
	projection := map[string]json.RawMessage{}
	for _, key := range []string{"id", "key", "revision", "title", "description", "nextStep", "projectId", "status", "businessDate", "dueAt", "priority", "labelIds", "assignee", "versionId"} {
		if v, ok := fields[key]; ok {
			projection[key] = v
		}
	}
	out := map[string]any{"id": id, "item": projection}
	if event != nil {
		out["event"] = map[string]any{"id": event.ID, "type": event.EventType, "summary": event.Payload.Summary, "details": event.Payload.Details, "url": event.Payload.URL, "origin": event.Origin}
	}
	return jsonString(out), nil
}

func (a *App) queueWorkExecution(r *Request, s *Space, item *WorkItem, executor *WorkExecutor, in workExecutionStartInput, event *WorkAutomationEvent, hash string) (*WorkExecution, error) {
	if !executor.Enabled || executor.Archived || !executor.CredentialConfigured {
		return nil, workConflict("work_executor_unavailable", "Enable a configured executor before starting work.", executor.Revision)
	}
	if item.Archived {
		return nil, workConflict("work_item_archived", "Restore the item before executing it.", item.Revision)
	}
	var count int
	if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_executions WHERE item_id=? AND state IN ('queued','dispatching','running','unknown')"), item.ID).Scan(&count); err != nil {
		return nil, err
	}
	if count > 0 {
		return nil, workConflict("work_execution_pending", "This item already has a pending execution. Read its receipt before starting another.", item.Revision)
	}
	if err := r.Q.QueryRowContext(r.HTTP.Context(), "SELECT COUNT(*) FROM work_executions WHERE state='queued'").Scan(&count); err != nil {
		return nil, err
	}
	if count >= workAutomationQueueLimit {
		return nil, &APIError{Status: 429, Code: "work_execution_queue_full", Message: "The execution queue is full. Wait for queued work to finish before submitting more."}
	}
	snapshot, err := workExecutionPayload(in.ID, item, event)
	if err != nil {
		return nil, err
	}
	v := &WorkExecution{ID: in.ID, SpaceID: s.ID, ItemID: item.ID, ExecutorID: executor.ID, ExecutorName: executor.Name, ExecutorRevision: executor.Revision, ItemRevision: item.Revision, ResourceKey: executor.ResourceKey, State: "queued", Revision: "1", CreatedAt: workScheduleStamp(time.Now()), snapshotJSON: snapshot, userID: r.User.ID, tokenHash: r.BearerTokenHash, createHash: hash}
	if event != nil {
		v.EventID = &event.ID
	}
	if len(in.Context) > 0 {
		v.contextJSON = string(in.Context)
	}
	execRev, _ := strconv.ParseInt(v.ExecutorRevision, 10, 64)
	itemRev, _ := strconv.ParseInt(v.ItemRevision, 10, 64)
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_executions(id,space_id,item_id,executor_id,executor_name,executor_revision,item_revision,resource_key,event_id,state,revision,snapshot_json,context_json,user_id,token_hash,create_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,'queued',1,?,?,?,?,?,?)"), v.ID, s.ID, v.ItemID, v.ExecutorID, v.ExecutorName, execRev, itemRev, v.ResourceKey, v.EventID, v.snapshotJSON, v.contextJSON, v.userID, v.tokenHash, hash, v.CreatedAt)
	if err != nil {
		return nil, err
	}
	r.WakeWorkAutomation = true
	return v, nil
}

func (a *App) startWorkExecution(r *Request) (*Response, error) {
	s, err := r.workExecuteSpace()
	if err != nil {
		return nil, err
	}
	var in workExecutionStartInput
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if !validID(in.ID) || !validID(in.ExecutorID) {
		return nil, invalid("id and executorId must be 32 lowercase hexadecimal characters.")
	}
	if _, err = integrationRevision(in.ExpectedItemRevision); err != nil || in.ExpectedItemRevision == "0" {
		return nil, invalid("expectedItemRevision is required.")
	}
	c, err := decodeWorkMutationContext(in.Context)
	if err != nil {
		return nil, err
	}
	hash := workPayloadHash(in)
	old, err := a.loadWorkExecution(r, s.ID, in.ID)
	if err == nil {
		if old.createHash != hash {
			return nil, workConflict("work_execution_id_conflict", "This execution ID already identifies different input. Do not generate a new ID to retry an uncertain dispatch.", old.Revision)
		}
		return workExecutionReply(r, old, map[string]any{"replayed": true}), nil
	}
	if code, _, domain := automationFailure(err); !domain || code != "not_found" {
		return nil, err
	}
	item, err := a.loadWorkItem(r, s.ID, in.ItemID)
	if err != nil {
		return nil, err
	}
	if err = automationRevision(in.ExpectedItemRevision, item.Revision, "item"); err != nil {
		return nil, err
	}
	session, err := a.prepareWorkMutationContext(r, s.ID, c)
	if err != nil {
		return nil, err
	}
	if err = a.guardWorkMutation(r, item, c, session); err != nil {
		return nil, err
	}
	executor, err := a.loadWorkExecutor(r, s.ID, in.ExecutorID)
	if err != nil {
		return nil, err
	}
	v, err := a.queueWorkExecution(r, s, item, executor, in, nil, hash)
	if err != nil {
		return nil, err
	}
	return workExecutionReply(r, v, map[string]any{"created": true}), nil
}

func (a *App) reconcileWorkExecution(r *Request) (*Response, error) {
	s, err := r.workExecuteSpace()
	if err != nil {
		return nil, err
	}
	v, err := a.loadWorkExecution(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var in struct {
		ExpectedRevision string `json:"expectedRevision"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if err = automationRevision(in.ExpectedRevision, v.Revision, "execution"); err != nil {
		return nil, err
	}
	if v.State != "unknown" {
		return nil, workConflict("work_execution_state_conflict", "Only an unknown execution requires explicit reconciliation.", v.Revision)
	}
	if v.NextPollAt != "" {
		return workExecutionReply(r, v, map[string]any{"unchanged": true}), nil
	}
	v.NextPollAt = workScheduleStamp(time.Now())
	revision, _ := strconv.ParseInt(v.Revision, 10, 64)
	v.Revision = strconv.FormatInt(revision+1, 10)
	// Reconciliation renews the principal for a readback; it never sends POST.
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_executions SET next_poll_at=?,poll_failures=0,user_id=?,token_hash=?,revision=revision+1 WHERE id=?"), v.NextPollAt, r.User.ID, r.BearerTokenHash, v.ID)
	if err != nil {
		return nil, err
	}
	r.WakeWorkAutomation = true
	return workExecutionReply(r, v, nil), nil
}

func (a *App) resolveWorkExecution(r *Request) (*Response, error) {
	s, err := r.workExecuteSpace()
	if err != nil {
		return nil, err
	}
	if err = requireWorkExecutorOwner(r); err != nil {
		return nil, err
	}
	v, err := a.loadWorkExecution(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var in struct {
		ExpectedRevision         string          `json:"expectedRevision"`
		Outcome                  string          `json:"outcome"`
		Note                     string          `json:"note"`
		ExternalStoppedConfirmed json.RawMessage `json:"externalStoppedConfirmed"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if err = automationRevision(in.ExpectedRevision, v.Revision, "execution"); err != nil {
		return nil, err
	}
	in.Note, err = required(in.Note, "note", 1000)
	if err != nil {
		return nil, err
	}
	confirmed, err := automationBool(in.ExternalStoppedConfirmed, false)
	if err != nil {
		return nil, err
	}
	if v.State == "queued" {
		if in.Outcome != "canceled" {
			return nil, invalid("A queued execution can only be canceled.")
		}
	} else if v.State == "unknown" {
		if !confirmed || (in.Outcome != "succeeded" && in.Outcome != "failed") {
			return nil, invalid("Confirm external work has stopped and explicitly choose succeeded or failed.")
		}
	} else {
		return nil, workConflict("work_execution_state_conflict", "Resolve only queued or unknown executions. Active external work must finish or become unknown first.", v.Revision)
	}
	v.State, v.Code, v.Message, v.FinishedAt, v.NextPollAt, v.ManualResolution = in.Outcome, "manually_resolved", in.Note, workScheduleStamp(time.Now()), "", true
	rev, _ := strconv.ParseInt(v.Revision, 10, 64)
	v.Revision = strconv.FormatInt(rev+1, 10)
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_executions SET state=?,code=?,message=?,finished_at=?,next_poll_at='',manual_resolution=TRUE,revision=revision+1 WHERE id=?"), v.State, v.Code, v.Message, v.FinishedAt, v.ID)
	if err != nil {
		return nil, err
	}
	r.WakeWorkAutomation = true
	return workExecutionReply(r, v, nil), nil
}

func (a *App) listWorkExecutions(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	in, err := readWorkAutomationPage(r, "executions")
	if err != nil {
		return nil, err
	}
	if in.State != "" && !workExecutionState(in.State) {
		return nil, invalid("Invalid execution state.")
	}
	where, args := "space_id=?", []any{s.ID}
	if in.State != "" {
		where += " AND state=?"
		args = append(args, in.State)
	}
	if in.ItemID != "" {
		item, err := a.loadWorkItem(r, s.ID, in.ItemID)
		if err != nil {
			return nil, err
		}
		where += " AND item_id=?"
		args = append(args, item.ID)
	}
	where, args, filter, err := workAutomationPageWhere("executions", s.ID, where, args, in)
	if err != nil {
		return nil, err
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+workExecutionColumns+" FROM work_executions WHERE "+where+" ORDER BY created_at DESC,id DESC LIMIT ?"), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []*WorkExecution{}
	for rows.Next() {
		v, err := scanWorkExecution(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, v)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	var cursor *string
	if len(items) > in.Limit {
		items = items[:in.Limit]
		last := items[len(items)-1]
		cursor = workAutomationNextCursor(filter, last.CreatedAt, last.ID)
	}
	return ok(map[string]any{"items": items, "nextCursor": cursor, "canExecute": workCanExecute(r), "canResolve": r.User != nil && r.User.Role == "Owner" && workCanExecute(r)}), nil
}

func workExecutionState(value string) bool {
	switch value {
	case "queued", "dispatching", "running", "succeeded", "failed", "unknown", "canceled":
		return true
	}
	return false
}
