package home

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const workAutomationConcurrency = 4

type workAutomationJob struct {
	execution WorkExecution
	executor  WorkExecutor
	method    string
	token     string
}
type workExecutionOutcome struct {
	state, code, message, result, nextPoll, finished string
	pollFailures                                     int
}
type workAutomationResult struct {
	id        string
	err       error
	exhausted bool
}

func (a *App) wakeWorkAutomation() {
	select {
	case a.workAutomationWake <- struct{}{}:
	default:
	}
}
func (a *App) startWorkAutomationWorker() {
	a.workers.Add(1)
	go func() { defer a.workers.Done(); a.workAutomationWorker() }()
}

// One coordinator owns the in-flight set; four workers only perform claimed
// jobs. There is no ticker, no unbounded goroutine pool and no HTTP under a DB
// transaction or the write gate.
func (a *App) workAutomationWorker() {
	jobs := make(chan string, workAutomationConcurrency)
	results := make(chan workAutomationResult, workAutomationConcurrency)
	var workers sync.WaitGroup
	for i := 0; i < workAutomationConcurrency; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for id := range jobs {
				err, exhausted := a.runWorkExecution(a.ctx, id)
				results <- workAutomationResult{id, err, exhausted}
			}
		}()
	}
	defer func() { close(jobs); workers.Wait() }()
	inFlight := map[string]bool{}
	scan := true
	paused := false
	recoverPending := false
	failures := 0
	var next time.Time
	storageFailure := func(err error, exhausted bool) {
		failures++
		next = time.Time{}
		scan = false
		log.Printf("work automation storage failure (attempt %d, %T)", failures, err)
		if exhausted || failures >= 3 {
			paused = true
		} else {
			next = time.Now().Add(time.Duration(failures) * 5 * time.Second)
		}
	}
	for a.ctx.Err() == nil {
		if scan && !paused && len(inFlight) < workAutomationConcurrency {
			if recoverPending && len(inFlight) == 0 {
				if err := a.recoverWorkExecutions(a.ctx); err != nil {
					storageFailure(err, false)
				} else {
					recoverPending = false
				}
			}
			if scan && !paused {
				events, ids, deadline, err := a.workAutomationDue(a.ctx, time.Now(), workAutomationConcurrency-len(inFlight), inFlight)
				if err != nil {
					storageFailure(err, false)
				} else {
					next = deadline
					scan = false
					for _, id := range events {
						if err = a.processWorkAutomationEventID(a.ctx, id); err != nil {
							break
						}
					}
					if err != nil {
						storageFailure(err, false)
					} else {
						failures = 0
						for _, id := range ids {
							inFlight[id] = true
							jobs <- id
						}
						if len(events) > 0 {
							scan = true
						}
					}
				}
			}
		}
		if scan && !paused && len(inFlight) < workAutomationConcurrency {
			continue
		}
		if len(inFlight) == workAutomationConcurrency {
			next = time.Time{}
		}
		var timer *time.Timer
		var tick <-chan time.Time
		if !next.IsZero() && !paused {
			timer = time.NewTimer(time.Until(next))
			tick = timer.C
		}
		select {
		case <-a.ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return
		case <-a.workAutomationWake:
			scan = true
			paused = false
			failures = 0
		case result := <-results:
			delete(inFlight, result.id)
			if result.err != nil && a.ctx.Err() == nil {
				recoverPending = true
				storageFailure(result.err, result.exhausted)
			} else if !paused {
				scan = true
			}
		case <-tick:
			scan = true
		}
		if timer != nil {
			timer.Stop()
		}
	}
}

// A blocked resource and an unrequested unknown receipt do not create timers.
// Every SQL collection is bounded, and future polling uses the partial index.
func (a *App) workAutomationDue(ctx context.Context, now time.Time, capacity int, inFlight map[string]bool) ([]string, []string, time.Time, error) {
	if err := a.store.CheckLease(ctx); err != nil {
		return nil, nil, time.Time{}, err
	}
	var enabled bool
	if err := a.store.DB.QueryRowContext(ctx, "SELECT work_enabled FROM settings WHERE id=1").Scan(&enabled); err != nil {
		return nil, nil, time.Time{}, err
	}
	if !enabled || capacity < 1 {
		return nil, nil, time.Time{}, nil
	}
	rows, err := a.store.DB.QueryContext(ctx, "SELECT e.id FROM work_automation_events e JOIN spaces s ON s.id=e.space_id WHERE e.state='queued' AND s.work_automation_enabled=TRUE ORDER BY e.created_at,e.id LIMIT 16")
	if err != nil {
		return nil, nil, time.Time{}, err
	}
	events := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, nil, time.Time{}, err
		}
		events = append(events, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, time.Time{}, err
	}
	exclude := ""
	args := []any{}
	if len(inFlight) > 0 {
		ids := []string{}
		for id := range inFlight {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		slots, values := workPlaceholders(ids)
		exclude = " AND id NOT IN (" + slots + ")"
		args = append(args, values...)
	}
	args = append(args, capacity)
	rows, err = a.store.DB.QueryContext(ctx, a.store.Query("SELECT id,next_poll_at FROM work_executions WHERE state IN ('running','unknown') AND next_poll_at<>''"+exclude+" ORDER BY next_poll_at,id LIMIT ?"), args...)
	if err != nil {
		return nil, nil, time.Time{}, err
	}
	ids := []string{}
	var next time.Time
	for rows.Next() {
		var id, stamp string
		if err = rows.Scan(&id, &stamp); err != nil {
			rows.Close()
			return nil, nil, time.Time{}, err
		}
		at, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil {
			rows.Close()
			return nil, nil, time.Time{}, err
		}
		if at.After(now) {
			next = at
			break
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, time.Time{}, err
	}
	remaining := capacity - len(ids)
	if remaining > 0 {
		exclude = ""
		args = []any{}
		if len(inFlight) > 0 {
			active := []string{}
			for id := range inFlight {
				active = append(active, id)
			}
			sort.Strings(active)
			slots, values := workPlaceholders(active)
			exclude = " AND e.id NOT IN (" + slots + ")"
			args = append(args, values...)
		}
		args = append(args, remaining)
		rows, err = a.store.DB.QueryContext(ctx, a.store.Query("SELECT e.id FROM work_executions e JOIN spaces s ON s.id=e.space_id WHERE e.state='queued' AND (e.event_id IS NULL OR s.work_automation_enabled=TRUE) AND NOT EXISTS(SELECT 1 FROM work_executions held WHERE held.resource_key=e.resource_key AND held.state IN ('dispatching','running','unknown'))"+exclude+" ORDER BY e.created_at,e.id LIMIT ?"), args...)
		if err != nil {
			return nil, nil, time.Time{}, err
		}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return nil, nil, time.Time{}, err
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, nil, time.Time{}, err
		}
	}
	return events, ids, next, nil
}
func automationInternalRequest(ctx context.Context, a *App, q Queryer, settings Settings) *Request {
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://localhost/internal/work-automation", nil)
	return &Request{App: a, HTTP: request, Q: q, Settings: settings}
}
func (a *App) processWorkAutomationEventID(ctx context.Context, id string) error {
	return a.integrationTransaction(ctx, func(q Queryer) error {
		settings, err := a.loadSettings(ctx, q)
		if err != nil || !settings.Modules.Work {
			return err
		}
		r := automationInternalRequest(ctx, a, q, settings)
		event, err := scanWorkAutomationEvent(q.QueryRowContext(ctx, a.store.Query("SELECT "+workAutomationEventColumns+" FROM work_automation_events WHERE id=?"), id))
		if err != nil {
			return err
		}
		if event.State != "queued" {
			return nil
		}
		var enabled bool
		if err = q.QueryRowContext(ctx, a.store.Query("SELECT work_automation_enabled FROM spaces WHERE id=?"), event.SpaceID).Scan(&enabled); err != nil {
			return err
		}
		if !enabled {
			return nil
		}
		return a.processWorkAutomationEvent(r, event)
	})
}

func (a *App) recoverWorkExecutions(ctx context.Context) error {
	return a.integrationTransaction(ctx, func(q Queryer) error {
		settings, err := a.loadSettings(ctx, q)
		if err != nil {
			return err
		}
		r := automationInternalRequest(ctx, a, q, settings)
		rows, err := q.QueryContext(ctx, "SELECT "+workExecutionColumns+" FROM work_executions WHERE state='dispatching' ORDER BY created_at,id")
		if err != nil {
			return err
		}
		values := []*WorkExecution{}
		for rows.Next() {
			v, err := scanWorkExecution(rows)
			if err != nil {
				rows.Close()
				return err
			}
			values = append(values, v)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, v := range values {
			out := workExecutionOutcome{state: "unknown", code: "dispatch_interrupted", message: "Dispatch ended without a durable outcome. Reconcile the same execution ID before resolving it; it will not be posted again."}
			if err = a.writeWorkExecutionOutcome(r, v, out); err != nil {
				return err
			}
		}
		_, err = q.ExecContext(ctx, a.store.Query("UPDATE work_executions SET next_poll_at=?,revision=revision+1 WHERE state='running'"), workScheduleStamp(time.Now()))
		return err
	})
}

func (a *App) prepareWorkExecution(ctx context.Context, id string) (*workAutomationJob, error) {
	var job *workAutomationJob
	err := a.integrationTransaction(ctx, func(q Queryer) error {
		settings, err := a.loadSettings(ctx, q)
		if err != nil || !settings.Modules.Work {
			return err
		}
		r := automationInternalRequest(ctx, a, q, settings)
		value, err := scanWorkExecution(q.QueryRowContext(ctx, a.store.Query("SELECT "+workExecutionColumns+" FROM work_executions WHERE id=?"), id))
		if err != nil {
			return err
		}
		if value.State != "queued" && value.State != "running" && !(value.State == "unknown" && value.NextPollAt != "") {
			return nil
		}
		space, err := scanSpace(q.QueryRowContext(ctx, a.store.Query("SELECT "+spaceColumns+" FROM spaces WHERE id=?"), value.SpaceID))
		if err != nil {
			return err
		}
		r.WorkSpaceContext = space
		if value.State == "queued" && value.EventID != nil && !space.WorkAutomationEnabled {
			return nil
		}
		reject := func(code, message string) error {
			state := "failed"
			finished := workScheduleStamp(time.Now())
			if value.State != "queued" {
				state = "unknown"
				finished = ""
			}
			return a.writeWorkExecutionOutcome(r, value, workExecutionOutcome{state: state, code: code, message: message, finished: finished})
		}
		now := time.Now()
		if value.State != "queued" {
			at, err := time.Parse(time.RFC3339Nano, value.NextPollAt)
			if err != nil {
				return err
			}
			if at.After(now) {
				return nil
			}
			if value.State == "running" && value.DeadlineAt != "" {
				deadline, err := time.Parse(time.RFC3339Nano, value.DeadlineAt)
				if err != nil {
					return err
				}
				if !deadline.After(now) {
					return reject("execution_deadline", "The execution deadline elapsed. The external outcome remains unknown; the resource is still held.")
				}
			}
		}
		actor, authErr := a.workAutomationActorRequest(ctx, q, settings, value.SpaceID, value.userID, value.tokenHash, "automation")
		if errors.Is(authErr, sql.ErrNoRows) {
			authErr = unauthorized()
		}
		if authErr == nil {
			_, authErr = actor.workExecuteSpace()
		}
		if authErr != nil {
			code, message, domain := automationFailure(authErr)
			if !domain {
				return authErr
			}
			return reject("execution_"+code, message)
		}
		executor, err := a.loadWorkExecutor(actor, value.SpaceID, value.ExecutorID)
		if err != nil {
			code, message, domain := automationFailure(err)
			if !domain {
				return err
			}
			return reject("executor_"+code, message)
		}
		if executor.Archived || !executor.CredentialConfigured || (value.State == "queued" && !executor.Enabled) {
			return reject("executor_unavailable", "The executor is unavailable. No new dispatch is permitted.")
		}
		if _, err = integrationRemoteURL(executor.Endpoint, executor.AllowPrivateNetwork); err != nil {
			return reject("executor_address_blocked", "The current executor address is not permitted.")
		}
		token, err := a.decryptIntegrationSecret("work-executor:"+executor.ID, executor.credentialCipher)
		if err != nil {
			return reject("executor_credential_unavailable", "The executor credential could not be read.")
		}
		method := http.MethodGet
		if value.State == "queued" {
			item, err := a.loadWorkItem(actor, value.SpaceID, value.ItemID)
			if err != nil {
				code, message, domain := automationFailure(err)
				if !domain {
					return err
				}
				return reject("item_"+code, message)
			}
			if item.Revision != value.ItemRevision {
				return reject("work_item_version_conflict", "The item changed after this execution was queued. Review its current content before starting a new execution.")
			}
			if item.Archived {
				return reject("work_item_archived", "The item was archived before dispatch.")
			}
			var raw json.RawMessage
			if value.contextJSON != "" {
				raw = json.RawMessage(value.contextJSON)
			}
			mutation, err := decodeWorkMutationContext(raw)
			if err != nil {
				return reject("work_context_invalid", "The saved execution context is invalid.")
			}
			session, err := a.prepareWorkMutationContext(actor, value.SpaceID, mutation)
			if err == nil {
				err = a.guardWorkMutation(actor, item, mutation, session)
			}
			if err != nil {
				code, message, domain := automationFailure(err)
				if !domain {
					return err
				}
				return reject(code, message)
			}
			var held int
			if err = q.QueryRowContext(ctx, a.store.Query("SELECT COUNT(*) FROM work_executions WHERE resource_key=? AND state IN ('dispatching','running','unknown')"), value.ResourceKey).Scan(&held); err != nil {
				return err
			}
			if held > 0 {
				return nil
			}
			started, deadline := workScheduleStamp(now), workScheduleStamp(now.Add(time.Duration(executor.TimeoutSeconds)*time.Second))
			result, err := q.ExecContext(ctx, a.store.Query("UPDATE work_executions SET state='dispatching',started_at=?,deadline_at=?,revision=revision+1 WHERE id=? AND revision=? AND state='queued'"), started, deadline, value.ID, value.Revision)
			if err != nil {
				return err
			}
			n, err := result.RowsAffected()
			if err != nil {
				return err
			}
			if n != 1 {
				return nil
			}
			revision, _ := strconv.ParseInt(value.Revision, 10, 64)
			value.State = "dispatching"
			value.Revision = strconv.FormatInt(revision+1, 10)
			value.StartedAt = started
			value.DeadlineAt = deadline
			method = http.MethodPost
		}
		job = &workAutomationJob{execution: *value, executor: *executor, method: method, token: token}
		return nil
	})
	return job, err
}

func (a *App) runWorkExecution(ctx context.Context, id string) (error, bool) {
	var job *workAutomationJob
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		job, err = a.prepareWorkExecution(ctx, id)
		if err == nil {
			break
		}
		// A commit error after preparing dispatch leaves an uncertain DB outcome.
		// Do not send HTTP or reconstruct a dispatch; explicit wake/restart recovers it.
		if job != nil || attempt == 2 || ctx.Err() != nil {
			return err, true
		}
		timer := time.NewTimer(time.Duration(attempt+1) * 5 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err(), true
		case <-timer.C:
		}
	}
	if job == nil {
		return nil, false
	}
	outcome := a.callWorkExecutor(ctx, job)
	// Only persist retries are allowed. The POST above is never repeated after
	// timeout, network failure, an unknown result, a database failure or restart.
	for attempt := 0; attempt < 3; attempt++ {
		err = a.integrationTransaction(ctx, func(q Queryer) error {
			return a.writeWorkExecutionOutcome(automationInternalRequest(ctx, a, q, Settings{}), &job.execution, outcome)
		})
		if err == nil {
			return nil, false
		}
		if ctx.Err() != nil {
			return err, true
		}
		if attempt == 2 {
			break
		}
		timer := time.NewTimer(time.Duration(attempt+1) * 5 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err(), true
		case <-timer.C:
		}
	}
	return err, true
}

func workExecutorBoundText(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	suffix := " [truncated]"
	runes := []rune(value)
	return string(runes[:limit-utf8.RuneCountInString(suffix)]) + suffix
}
func workExecutorResponse(body []byte, id, token string) (state, result, message string, err error) {
	var value struct {
		ID      *string `json:"id"`
		State   *string `json:"state"`
		Result  *string `json:"result"`
		Message *string `json:"message"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&value); err != nil {
		return "", "", "", err
	}
	var extra any
	if err = decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return "", "", "", errors.New("executor response contains multiple values")
	}
	if value.ID == nil || value.State == nil || value.Result == nil || value.Message == nil || *value.ID != id {
		return "", "", "", errors.New("executor response identity or required fields are invalid")
	}
	switch *value.State {
	case "running", "succeeded", "failed", "unknown":
	default:
		return "", "", "", errors.New("executor response state is invalid")
	}
	result, message = *value.Result, *value.Message
	if token != "" {
		result = strings.ReplaceAll(result, token, "[redacted]")
		message = strings.ReplaceAll(message, token, "[redacted]")
	}
	return *value.State, workExecutorBoundText(result, 4000), workExecutorBoundText(message, 1000), nil
}
func workExecutorDefiniteRejection(status int) bool {
	switch status {
	case 400, 401, 403, 404, 405, 413, 415, 422, 429:
		return true
	}
	return false
}
func (a *App) callWorkExecutor(ctx context.Context, job *workAutomationJob) workExecutionOutcome {
	// Capture one committed outbound configuration for this HTTP operation. A
	// generation change cancels its sockets; the caller still persists the
	// confirmed or unknown execution outcome using its original parent context.
	ctx, finishNetwork := a.beginNetworkOperation(ctx)
	defer finishNetwork()
	value := &job.execution
	now := time.Now()
	timeout := 15 * time.Second
	if value.State != "unknown" && value.DeadlineAt != "" {
		deadline, err := time.Parse(time.RFC3339Nano, value.DeadlineAt)
		if err == nil && time.Until(deadline) < timeout {
			timeout = time.Until(deadline)
		}
	}
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	baseClient := a.newOutboundIntegrationHTTPClient(job.executor.AllowPrivateNetwork)
	if a.config.workExecutorClientFactory != nil {
		baseClient = a.config.workExecutorClientFactory(job.executor.AllowPrivateNetwork)
	}
	client := *baseClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	defer client.CloseIdleConnections()
	target := job.executor.Endpoint + "/runs"
	var payload io.Reader
	if job.method == http.MethodPost {
		payload = strings.NewReader(value.snapshotJSON)
	} else {
		target += "/" + value.ID
	}
	request, err := http.NewRequestWithContext(requestCtx, job.method, target, payload)
	if err != nil {
		return a.workExecutorFailureOutcome(job, "executor_invalid_request", now)
	}
	request.Header.Set("Authorization", "Bearer "+job.token)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "Lingshu-Home/work-executor")
	if job.method == http.MethodPost {
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", value.ID)
	}
	response, err := client.Do(request)
	if err != nil {
		return a.workExecutorFailureOutcome(job, "executor_unreachable", time.Now())
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if job.method == http.MethodPost && workExecutorDefiniteRejection(response.StatusCode) {
			return workExecutionOutcome{state: "failed", code: "executor_http_" + strconv.Itoa(response.StatusCode), message: "The executor rejected the request without accepting this run.", finished: workScheduleStamp(time.Now())}
		}
		return a.workExecutorFailureOutcome(job, "executor_http_"+strconv.Itoa(response.StatusCode), time.Now())
	}
	if encoding := response.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		return a.workExecutorFailureOutcome(job, "executor_encoding_unsupported", time.Now())
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
	if err != nil || len(body) > 64<<10 {
		return a.workExecutorFailureOutcome(job, "executor_response_incomplete_or_large", time.Now())
	}
	state, result, message, err := workExecutorResponse(body, value.ID, job.token)
	if err != nil {
		return a.workExecutorFailureOutcome(job, "executor_invalid_response", time.Now())
	}
	out := workExecutionOutcome{state: state, result: result, message: message}
	switch state {
	case "succeeded":
		out.finished = workScheduleStamp(time.Now())
	case "failed":
		out.code = "executor_failed"
		out.finished = workScheduleStamp(time.Now())
	case "unknown":
		out.code = "executor_unknown"
	case "running":
		out.nextPoll = workExecutionNextPoll(value, &job.executor, time.Now())
		if out.nextPoll == "" {
			out.state = "unknown"
			out.code = "execution_deadline"
			out.message = "The execution deadline elapsed while the executor still reports running. The resource remains held."
		}
	}
	return out
}
func workExecutionNextPoll(value *WorkExecution, executor *WorkExecutor, now time.Time) string {
	next := now.Add(time.Duration(executor.PollIntervalSeconds) * time.Second)
	if value.DeadlineAt != "" {
		deadline, err := time.Parse(time.RFC3339Nano, value.DeadlineAt)
		if err != nil || !deadline.After(now) {
			return ""
		}
		if deadline.Before(next) {
			next = deadline
		}
	}
	return workScheduleStamp(next)
}
func (a *App) workExecutorFailureOutcome(job *workAutomationJob, code string, now time.Time) workExecutionOutcome {
	out := workExecutionOutcome{state: "unknown", code: code, message: "The executor outcome could not be confirmed. Reconcile this same execution ID; no automatic POST retry is permitted."}
	if job.method == http.MethodGet {
		out.pollFailures = job.execution.pollFailures + 1
		if out.pollFailures < 3 {
			out.nextPoll = workExecutionNextPoll(&job.execution, &job.executor, now)
			if out.nextPoll == "" && job.execution.State == "unknown" {
				out.nextPoll = workScheduleStamp(now.Add(time.Duration(job.executor.PollIntervalSeconds) * time.Second))
			}
			if out.nextPoll != "" {
				out.state = job.execution.State
				out.message = "Executor readback failed. A bounded readback retry is scheduled."
			}
		}
	}
	return out
}
func (a *App) writeWorkExecutionOutcome(r *Request, value *WorkExecution, out workExecutionOutcome) error {
	// CAS prevents a late HTTP response from overwriting explicit human resolution
	// or a newer reconciliation. Module state is deliberately not a write guard:
	// a trusted response still has to be recorded after work was disabled.
	var notifications bool
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("UPDATE work_executions SET state=?,code=?,message=?,result=?,next_poll_at=?,finished_at=?,poll_failures=?,revision=revision+1 WHERE id=? AND revision=? AND state=? RETURNING (SELECT work_notifications_enabled FROM spaces WHERE spaces.id=work_executions.space_id)"), out.state, out.code, out.message, out.result, out.nextPoll, out.finished, out.pollFailures, value.ID, value.Revision, value.State).Scan(&notifications)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if notifications && (out.state == "failed" || out.state == "unknown" && out.nextPoll == "") {
		settings, err := a.loadSettings(r.HTTP.Context(), r.Q)
		if err != nil {
			return err
		}
		r.Settings = settings
		in := WorkNoticeInput{SpaceID: value.SpaceID, Enabled: true, Kind: "execution_" + out.state, SubjectType: "execution", SubjectID: value.ID, OccurrenceKey: value.ID, ItemID: value.ItemID, Code: out.code, Message: workExecutorBoundText(out.message, 500), RecipientUserIDs: []string{value.userID}}
		if err = a.recordWorkNotice(r, in); err != nil {
			return err
		}
	}
	return nil
}
