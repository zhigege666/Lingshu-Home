package home

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type WorkAutomationEventPayload struct {
	Summary string `json:"summary"`
	Details string `json:"details"`
	URL     string `json:"url"`
}

type WorkAutomationEvent struct {
	ID                            string                     `json:"id"`
	SpaceID                       string                     `json:"spaceId"`
	EventType                     string                     `json:"eventType"`
	ProjectID                     *string                    `json:"projectId"`
	StatusID                      string                     `json:"statusId"`
	SourceItemID                  *string                    `json:"sourceItemId"`
	Origin                        string                     `json:"origin"`
	Payload                       WorkAutomationEventPayload `json:"payload"`
	State                         string                     `json:"state"`
	Revision                      string                     `json:"revision"`
	CreatedAt                     string                     `json:"createdAt"`
	ProcessedAt                   string                     `json:"processedAt"`
	Code                          string                     `json:"code"`
	Message                       string                     `json:"message"`
	userID, tokenHash, createHash string
}

type WorkAutomationReceipt struct {
	RuleID       string  `json:"ruleId"`
	RuleRevision string  `json:"ruleRevision"`
	ItemID       *string `json:"itemId"`
	ExecutionID  *string `json:"executionId"`
	Result       string  `json:"result"`
	Code         string  `json:"code"`
	Message      string  `json:"message"`
	OccurredAt   string  `json:"occurredAt"`
}

const workAutomationEventColumns = "id,space_id,event_type,project_id,status_id,source_item_id,origin,payload_json,state,revision,COALESCE(user_id,''),token_hash,created_at,processed_at,code,message,create_hash"
const workAutomationReceiptColumns = "rule_id,rule_revision,item_id,execution_id,result,code,message,occurred_at"

func scanWorkAutomationEvent(row interface{ Scan(...any) error }) (*WorkAutomationEvent, error) {
	v := &WorkAutomationEvent{}
	var project, item sql.NullString
	var payload string
	var revision int64
	err := row.Scan(&v.ID, &v.SpaceID, &v.EventType, &project, &v.StatusID, &item, &v.Origin, &payload, &v.State, &revision, &v.userID, &v.tokenHash, &v.CreatedAt, &v.ProcessedAt, &v.Code, &v.Message, &v.createHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, missing()
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal([]byte(payload), &v.Payload); err != nil {
		return nil, err
	}
	v.ProjectID, v.SourceItemID, v.Revision = automationNullable(project), automationNullable(item), strconv.FormatInt(revision, 10)
	return v, nil
}

func scanWorkAutomationReceipt(row interface{ Scan(...any) error }) (*WorkAutomationReceipt, error) {
	v := &WorkAutomationReceipt{}
	var item, execution sql.NullString
	var revision int64
	err := row.Scan(&v.RuleID, &revision, &item, &execution, &v.Result, &v.Code, &v.Message, &v.OccurredAt)
	if err != nil {
		return nil, err
	}
	v.RuleRevision, v.ItemID, v.ExecutionID = strconv.FormatInt(revision, 10), automationNullable(item), automationNullable(execution)
	return v, nil
}

func (a *App) loadWorkAutomationEvent(r *Request, space, id string) (*WorkAutomationEvent, error) {
	if !validID(id) {
		return nil, missing()
	}
	return scanWorkAutomationEvent(r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+workAutomationEventColumns+" FROM work_automation_events WHERE id=? AND space_id=?"), id, space))
}

func (a *App) workAutomationEventReply(r *Request, v *WorkAutomationEvent, flags map[string]any) (*Response, error) {
	if !r.workReads("work:read") {
		out := map[string]any{"id": v.ID, "revision": v.Revision}
		for k, value := range flags {
			out[k] = value
		}
		return ok(out), nil
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+workAutomationReceiptColumns+" FROM work_automation_receipts WHERE event_id=? ORDER BY rule_id"), v.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	receipts := []*WorkAutomationReceipt{}
	for rows.Next() {
		value, err := scanWorkAutomationReceipt(rows)
		if err != nil {
			return nil, err
		}
		receipts = append(receipts, value)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	out := map[string]any{"event": v, "receipts": receipts, "canEdit": r.WorkSpaceContext != nil && r.WorkSpaceContext.CanEdit, "canExecute": workCanExecute(r)}
	for k, v := range flags {
		out[k] = v
	}
	return ok(out), nil
}

func (a *App) getWorkAutomationEvent(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	v, err := a.loadWorkAutomationEvent(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	return a.workAutomationEventReply(r, v, nil)
}

func (a *App) enqueueWorkAutomationEvent(r *Request, v *WorkAutomationEvent) error {
	var pending int
	if err := r.Q.QueryRowContext(r.HTTP.Context(), "SELECT COUNT(*) FROM work_automation_events WHERE state='queued'").Scan(&pending); err != nil {
		return err
	}
	if pending >= workAutomationQueueLimit {
		return &APIError{Status: 429, Code: "work_automation_queue_full", Message: "The event queue is full. Wait for pending events to finish before retrying this operation."}
	}
	_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_automation_events(id,space_id,event_type,project_id,status_id,source_item_id,origin,payload_json,state,revision,user_id,token_hash,created_at,create_hash) VALUES(?,?,?,?,?,?,?,?,'queued',1,?,?,?,?)"), v.ID, v.SpaceID, v.EventType, v.ProjectID, v.StatusID, v.SourceItemID, v.Origin, jsonString(v.Payload), v.userID, v.tokenHash, v.CreatedAt, v.createHash)
	if err == nil {
		r.WakeWorkAutomation = true
	}
	return err
}

func (a *App) publishWorkAutomationEvent(r *Request) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	var in struct {
		ID           string  `json:"id"`
		Type         string  `json:"type"`
		Summary      string  `json:"summary"`
		Details      string  `json:"details"`
		URL          string  `json:"url"`
		ProjectID    *string `json:"projectId"`
		StatusID     string  `json:"statusId"`
		SourceItemID *string `json:"sourceItemId"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if !validID(in.ID) || !workEventTypePattern.MatchString(in.Type) || strings.HasPrefix(in.Type, "work.") {
		return nil, invalid("Use a stable 32-character ID and a custom event type; work.* is reserved for actual item activity.")
	}
	in.Summary, err = required(in.Summary, "summary", 160)
	if err != nil {
		return nil, err
	}
	if err = bounded(in.Details, "details", 4000); err != nil {
		return nil, err
	}
	if err = bounded(in.URL, "url", 1000); err != nil {
		return nil, err
	}
	if in.URL != "" {
		u, e := url.Parse(in.URL)
		if e != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
			return nil, invalid("url must be an HTTP or HTTPS link without credentials.")
		}
	}
	hash := workPayloadHash(in)
	old, err := a.loadWorkAutomationEvent(r, s.ID, in.ID)
	if err == nil {
		if old.createHash != hash {
			return nil, workConflict("work_automation_event_id_conflict", "This event ID already identifies different content.", old.Revision)
		}
		return a.workAutomationEventReply(r, old, map[string]any{"replayed": true})
	}
	if code, _, domain := automationFailure(err); !domain || code != "not_found" {
		return nil, err
	}
	if !s.WorkAutomationEnabled {
		return nil, workConflict("work_automation_disabled", "Enable event automation for this space before publishing events.", strconv.FormatInt(s.WorkAutomationRevision, 10))
	}
	if err = a.validateWorkProject(r, s.ID, in.ProjectID); err != nil {
		return nil, err
	}
	if in.StatusID != "" {
		if _, err = a.requireWorkStatus(r, s.ID, in.StatusID); err != nil {
			return nil, err
		}
	}
	if in.SourceItemID != nil {
		item, err := a.loadWorkItem(r, s.ID, *in.SourceItemID)
		if err != nil {
			return nil, err
		}
		in.SourceItemID = &item.ID
	}
	v := &WorkAutomationEvent{ID: in.ID, SpaceID: s.ID, EventType: in.Type, ProjectID: in.ProjectID, StatusID: in.StatusID, SourceItemID: in.SourceItemID, Origin: "external", Payload: WorkAutomationEventPayload{in.Summary, in.Details, in.URL}, State: "queued", Revision: "1", CreatedAt: workScheduleStamp(time.Now()), userID: r.User.ID, tokenHash: r.BearerTokenHash, createHash: hash}
	if err = a.enqueueWorkAutomationEvent(r, v); err != nil {
		return nil, err
	}
	return a.workAutomationEventReply(r, v, map[string]any{"created": true})
}

func workAutomationDerivedID(kind, first, second string) string {
	hash := sha256.Sum256([]byte("work-automation:" + kind + ":" + first + ":" + second))
	return hex.EncodeToString(hash[:16])
}

// The disabled path reads only flags already loaded by workSpace. It performs
// no SQL, allocates no event payload and never starts a polling timer.
func (a *App) enqueueWorkActivityAutomation(r *Request, space, itemID, activityID, action, stamp string, changes []WorkActivityChange) error {
	s := r.WorkSpaceContext
	if s == nil || !s.WorkAutomationEnabled || s.WorkAutomationRuleCount == 0 || workActivityOrigin(r) == "automation" {
		return nil
	}
	types := []string{}
	if action == "create" {
		types = append(types, "work.created")
	} else if action == "update" || action == "move" {
		for _, change := range changes {
			if change.Field != "status" {
				continue
			}
			var before, after struct {
				ID   string `json:"id"`
				Type string `json:"type"`
			}
			if json.Unmarshal(change.Before, &before) != nil || json.Unmarshal(change.After, &after) != nil {
				return errors.New("invalid stored status activity")
			}
			if before.ID != after.ID {
				types = append(types, "work.status_changed")
				if after.Type == "done" && before.Type != "done" {
					types = append(types, "work.completed")
				}
			}
			break
		}
	}
	if len(types) == 0 {
		return nil
	}
	var title, description, status string
	var project sql.NullString
	if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT title,description,project_id,status FROM work_items WHERE id=? AND space_id=?"), itemID, space).Scan(&title, &description, &project, &status); err != nil {
		return err
	}
	for _, kind := range types {
		v := &WorkAutomationEvent{ID: workAutomationDerivedID("activity", activityID, kind), SpaceID: space, EventType: kind, ProjectID: automationNullable(project), StatusID: status, SourceItemID: &itemID, Origin: "work", Payload: WorkAutomationEventPayload{Summary: title, Details: description}, State: "queued", Revision: "1", CreatedAt: workScheduleStamp(time.Now()), userID: r.User.ID, tokenHash: r.BearerTokenHash}
		v.createHash = workPayloadHash([]any{activityID, kind})
		if err := a.enqueueWorkAutomationEvent(r, v); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) finishWorkAutomationEvent(r *Request, v *WorkAutomationEvent, state, code, message string) error {
	v.State, v.Code, v.Message, v.ProcessedAt = state, code, message, workScheduleStamp(time.Now())
	revision, _ := strconv.ParseInt(v.Revision, 10, 64)
	v.Revision = strconv.FormatInt(revision+1, 10)
	_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_automation_events SET state=?,code=?,message=?,processed_at=?,revision=revision+1 WHERE id=?"), state, code, message, v.ProcessedAt, v.ID)
	return err
}

func (a *App) workAutomationFailureNotice(r *Request, space *Space, eventID, ruleID, code, message, userID string) error {
	in := workNoticeForSpace(space)
	in.Kind = "automation_failed"
	in.SubjectType = "automation_event"
	in.SubjectID = eventID
	in.OccurrenceKey = eventID + ":" + ruleID
	in.Code = code
	in.Message = message
	in.RecipientUserIDs = []string{userID}
	return a.recordWorkNotice(r, in)
}

// This function runs inside the worker's short transaction. Rule creation and
// its receipt are atomic; no network call occurs while the write gate is held.
func (a *App) processWorkAutomationEvent(r *Request, v *WorkAutomationEvent) error {
	actor, err := a.workAutomationActorRequest(r.HTTP.Context(), r.Q, r.Settings, v.SpaceID, v.userID, v.tokenHash, "automation")
	if err != nil {
		code, message, domain := automationFailure(err)
		if !domain {
			return err
		}
		return a.finishWorkAutomationEvent(r, v, "failed", code, message)
	}
	s := actor.WorkSpaceContext
	if !s.WorkAutomationEnabled {
		return a.finishWorkAutomationEvent(r, v, "skipped", "automation_disabled", "Event rules were disabled before processing.")
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+workAutomationRuleColumns+" FROM work_automation_rules WHERE space_id=? AND enabled=TRUE AND archived=FALSE AND event_type=? AND (project_id IS NULL OR project_id=?) AND (status_id='' OR status_id=?) ORDER BY id LIMIT ?"), v.SpaceID, v.EventType, v.ProjectID, v.StatusID, workAutomationMatchLimit+1)
	if err != nil {
		return err
	}
	rules := []*WorkAutomationRule{}
	for rows.Next() {
		rule, e := scanWorkAutomationRule(rows)
		if e != nil {
			rows.Close()
			return e
		}
		rules = append(rules, rule)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(rules) > workAutomationMatchLimit {
		if err = a.workAutomationFailureNotice(r, s, v.ID, "", "work_automation_match_limit", "More than 25 rules match this event. Narrow the rules before retrying.", v.userID); err != nil {
			return err
		}
		return a.finishWorkAutomationEvent(r, v, "failed", "work_automation_match_limit", "More than 25 rules match this event. Narrow the rules before retrying.")
	}
	for _, rule := range rules {
		if _, err = a.applyWorkAutomationRule(actor, v, rule, false); err != nil {
			return err
		}
	}
	return a.finishWorkAutomationEvent(r, v, "processed", "", "")
}

func (a *App) applyWorkAutomationRule(actor *Request, event *WorkAutomationEvent, rule *WorkAutomationRule, retry bool) (*WorkAutomationReceipt, error) {
	old, err := scanWorkAutomationReceipt(actor.Q.QueryRowContext(actor.HTTP.Context(), a.store.Query("SELECT "+workAutomationReceiptColumns+" FROM work_automation_receipts WHERE event_id=? AND rule_id=?"), event.ID, rule.ID))
	if err == nil && (!retry || old.Result != "failed") {
		return old, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	receipt := &WorkAutomationReceipt{RuleID: rule.ID, RuleRevision: rule.Revision, Result: "created", OccurredAt: workScheduleStamp(time.Now())}
	if !rule.Enabled || rule.Archived {
		return nil, workConflict("work_automation_rule_disabled", "Enable this rule before retrying its failed receipt.", rule.Revision)
	}
	r, runErr := a.workAutomationActorRequest(actor.HTTP.Context(), actor.Q, actor.Settings, rule.SpaceID, rule.userID, rule.tokenHash, "automation")
	var executor *WorkExecutor
	if runErr == nil && rule.ExecutorID != nil {
		if !workCanExecute(actor) || !workCanExecute(r) {
			runErr = forbidden()
		} else {
			executor, runErr = a.loadWorkExecutor(r, rule.SpaceID, *rule.ExecutorID)
		}
		if runErr == nil && (!executor.Enabled || executor.Archived || !executor.CredentialConfigured) {
			runErr = workConflict("work_executor_unavailable", "The rule's executor is disabled or unavailable.", executor.Revision)
		}
		if runErr == nil && r.Bearer && r.Settings.MCP.CollaborationEnabled {
			runErr = workCollabError("work_claim_required", "This bearer requires a real work session and claim. Create the item with the rule, then start execution with an explicit work context.")
		}
	}
	if runErr == nil {
		if _, err = actor.Q.ExecContext(actor.HTTP.Context(), "SAVEPOINT work_automation_rule"); err != nil {
			return nil, err
		}
		in := rule.Template.workInput()
		var item *WorkItem
		item, runErr = a.insertWorkItem(r, rule.SpaceID, in, workPayloadHash(in), len(in.DocumentIDs) > 0, "")
		if runErr == nil {
			receipt.ItemID = &item.ID
			if executor != nil {
				start := workExecutionStartInput{ID: workAutomationDerivedID("execution", event.ID, rule.ID), ExecutorID: executor.ID, ItemID: item.ID, ExpectedItemRevision: item.Revision}
				var execution *WorkExecution
				execution, runErr = a.queueWorkExecution(r, r.WorkSpaceContext, item, executor, start, event, workPayloadHash(start))
				if runErr == nil {
					receipt.ExecutionID = &execution.ID
					actor.WakeWorkAutomation = true
				}
			}
		}
		if runErr != nil {
			if _, err = actor.Q.ExecContext(actor.HTTP.Context(), "ROLLBACK TO SAVEPOINT work_automation_rule"); err != nil {
				return nil, err
			}
			receipt.ItemID, receipt.ExecutionID = nil, nil
		}
		if _, err = actor.Q.ExecContext(actor.HTTP.Context(), "RELEASE SAVEPOINT work_automation_rule"); err != nil {
			return nil, err
		}
	}
	if runErr != nil {
		code, message, domain := automationFailure(runErr)
		if !domain {
			return nil, runErr
		}
		receipt.Result, receipt.Code, receipt.Message = "failed", code, message
	}
	revision, _ := strconv.ParseInt(rule.Revision, 10, 64)
	_, err = actor.Q.ExecContext(actor.HTTP.Context(), a.store.Query("INSERT INTO work_automation_receipts(event_id,rule_id,rule_revision,item_id,execution_id,result,code,message,occurred_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id,rule_id) DO UPDATE SET rule_revision=excluded.rule_revision,item_id=excluded.item_id,execution_id=excluded.execution_id,result=excluded.result,code=excluded.code,message=excluded.message,occurred_at=excluded.occurred_at"), event.ID, rule.ID, revision, receipt.ItemID, receipt.ExecutionID, receipt.Result, receipt.Code, receipt.Message, receipt.OccurredAt)
	if err != nil {
		return nil, err
	}
	if receipt.Result == "failed" {
		if err = a.workAutomationFailureNotice(actor, actor.WorkSpaceContext, event.ID, rule.ID, receipt.Code, receipt.Message, event.userID); err != nil {
			return nil, err
		}
	}
	return receipt, nil
}

func (a *App) retryWorkAutomationEvent(r *Request) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	v, err := a.loadWorkAutomationEvent(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var in struct {
		ExpectedRevision     string `json:"expectedRevision"`
		RuleID               string `json:"ruleId"`
		ExpectedRuleRevision string `json:"expectedRuleRevision"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if err = automationRevision(in.ExpectedRevision, v.Revision, "automation_event"); err != nil {
		return nil, err
	}
	if !s.WorkAutomationEnabled {
		return nil, workConflict("work_automation_disabled", "Enable event automation before retrying.", strconv.FormatInt(s.WorkAutomationRevision, 10))
	}
	if in.RuleID == "" {
		if in.ExpectedRuleRevision != "" || v.State != "failed" {
			return nil, invalid("Choose a failed rule receipt, or retry an event that failed before matching any rules.")
		}
		var count int
		if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_automation_receipts WHERE event_id=?"), v.ID).Scan(&count); err != nil {
			return nil, err
		}
		if count != 0 {
			return nil, invalid("Retry an individual failed rule receipt.")
		}
		_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_automation_events SET state='queued',processed_at='',code='',message='',user_id=?,token_hash=?,revision=revision+1 WHERE id=?"), r.User.ID, r.BearerTokenHash, v.ID)
		if err != nil {
			return nil, err
		}
		r.WakeWorkAutomation = true
	} else {
		rule, err := a.loadWorkAutomationRule(r, s.ID, in.RuleID)
		if err != nil {
			return nil, err
		}
		if err = automationRevision(in.ExpectedRuleRevision, rule.Revision, "automation_rule"); err != nil {
			return nil, err
		}
		receipt, err := scanWorkAutomationReceipt(r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+workAutomationReceiptColumns+" FROM work_automation_receipts WHERE event_id=? AND rule_id=?"), v.ID, rule.ID))
		if errors.Is(err, sql.ErrNoRows) {
			return nil, missing()
		}
		if err != nil {
			return nil, err
		}
		if receipt.Result != "failed" {
			return a.workAutomationEventReply(r, v, map[string]any{"replayed": true})
		}
		if _, err = a.applyWorkAutomationRule(r, v, rule, true); err != nil {
			return nil, err
		}
		if err = a.finishWorkAutomationEvent(r, v, "processed", "", ""); err != nil {
			return nil, err
		}
		r.WakeWorkAutomation = true
	}
	v, err = a.loadWorkAutomationEvent(r, s.ID, v.ID)
	if err != nil {
		return nil, err
	}
	return a.workAutomationEventReply(r, v, nil)
}

func (a *App) listWorkAutomationEvents(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	in, err := readWorkAutomationPage(r, "events")
	if err != nil {
		return nil, err
	}
	if in.State != "" && in.State != "queued" && in.State != "processed" && in.State != "failed" && in.State != "skipped" {
		return nil, invalid("Invalid event state.")
	}
	where, args := "space_id=?", []any{s.ID}
	if in.EventType != "" {
		where += " AND event_type=?"
		args = append(args, in.EventType)
	}
	if in.State != "" {
		where += " AND state=?"
		args = append(args, in.State)
	}
	where, args, filter, err := workAutomationPageWhere("events", s.ID, where, args, in)
	if err != nil {
		return nil, err
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+workAutomationEventColumns+" FROM work_automation_events WHERE "+where+" ORDER BY created_at DESC,id DESC LIMIT ?"), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []*WorkAutomationEvent{}
	for rows.Next() {
		v, err := scanWorkAutomationEvent(rows)
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
	return ok(map[string]any{"items": items, "nextCursor": cursor, "canEdit": s.CanEdit, "canExecute": workCanExecute(r)}), nil
}
