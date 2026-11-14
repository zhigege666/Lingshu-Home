package home

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"
)

type WorkScheduleOccurrence struct {
	BusinessDate     string  `json:"businessDate"`
	ScheduledAt      string  `json:"scheduledAt"`
	ItemID           *string `json:"itemId"`
	Result           string  `json:"result"`
	Reason           string  `json:"reason"`
	OccurredAt       string  `json:"occurredAt"`
	TemplateRevision string  `json:"templateRevision"`
}

const workOccurrenceColumns = "business_date,scheduled_at,item_id,result,reason,occurred_at,template_revision"

func scanWorkOccurrence(row interface{ Scan(...any) error }) (*WorkScheduleOccurrence, error) {
	value := &WorkScheduleOccurrence{}
	var revision int64
	var item sql.NullString
	err := row.Scan(&value.BusinessDate, &value.ScheduledAt, &item, &value.Result, &value.Reason, &value.OccurredAt, &revision)
	if err != nil {
		return nil, err
	}
	if item.Valid {
		value.ItemID = &item.String
	}
	value.TemplateRevision = strconv.FormatInt(revision, 10)
	return value, nil
}

func workScheduledItemID(schedule, date string) string {
	sum := sha256.Sum256([]byte("work-schedule:" + schedule + ":" + date))
	return hex.EncodeToString(sum[:16])
}

func (a *App) workScheduleRequest(ctx context.Context, q Queryer, value *WorkSchedule, settings Settings) (*Request, error) {
	httpRequest, err := http.NewRequestWithContext(withDocumentActivityOrigin(ctx, "scheduler"), "POST", "http://localhost/internal/work-scheduler", nil)
	if err != nil {
		return nil, err
	}
	r := &Request{App: a, HTTP: httpRequest, Q: q, Settings: settings, Params: map[string]string{"spaceId": value.SpaceID}}
	if value.tokenHash != "" {
		err = a.authenticateBearerHash(r, value.tokenHash)
	} else {
		r.User, err = a.loadUser(ctx, q, value.userID)
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

// Creation, the occurrence receipt and the next timer are committed by one
// writeGate/lease protected transaction. Failed domain validation is recorded;
// storage failures abort the transaction and are retried only by the worker's
// bounded retry schedule. No failed write is reported as successful creation.
func (a *App) createWorkScheduleOccurrence(r *Request, value *WorkSchedule, planned WorkSchedulePreview, now time.Time, forcedSkip string) (*WorkScheduleOccurrence, bool, error) {
	old, err := scanWorkOccurrence(r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+workOccurrenceColumns+" FROM work_schedule_occurrences WHERE schedule_id=? AND business_date=?"), value.ID, planned.BusinessDate))
	if err == nil && old.Result != "failed" {
		return old, true, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, false, err
	}
	occurrence := &WorkScheduleOccurrence{BusinessDate: planned.BusinessDate, ScheduledAt: planned.ScheduledAt, OccurredAt: workScheduleStamp(now), TemplateRevision: value.Revision, Result: "created"}
	if forcedSkip != "" {
		occurrence.Result, occurrence.Reason = "skipped", forcedSkip
	} else {
		execution, runErr := a.workScheduleRequest(r.HTTP.Context(), r.Q, value, r.Settings)
		if runErr == nil && value.OverlapPolicy == "skip" {
			var unfinished int
			runErr = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_items w JOIN work_statuses s ON s.space_id=w.space_id AND s.id=w.status WHERE w.schedule_id<>'' AND w.schedule_id=? AND w.business_date<? AND w.archived=? AND s.status_type NOT IN ('done','canceled')"), value.ID, planned.BusinessDate, false).Scan(&unfinished)
			if runErr == nil && unfinished > 0 {
				occurrence.Result, occurrence.Reason = "skipped", "previous_unfinished"
			}
		}
		if runErr == nil && occurrence.Result == "created" {
			in := value.Template.workInput(workScheduledItemID(value.ID, planned.BusinessDate))
			in.BusinessDate, in.DueAt = planned.BusinessDate, planned.DueAt
			if _, err = r.Q.ExecContext(r.HTTP.Context(), "SAVEPOINT work_schedule_create"); err != nil {
				return nil, false, err
			}
			var item *WorkItem
			item, runErr = a.insertWorkItem(execution, value.SpaceID, in, workPayloadHash(in), len(in.DocumentIDs) > 0, value.ID)
			if runErr == nil && execution.WakeWorkAutomation {
				r.WakeWorkAutomation = true
			}
			if runErr != nil {
				if _, err = r.Q.ExecContext(r.HTTP.Context(), "ROLLBACK TO SAVEPOINT work_schedule_create"); err != nil {
					return nil, false, err
				}
			} else {
				occurrence.ItemID = &item.ID
			}
			if _, err = r.Q.ExecContext(r.HTTP.Context(), "RELEASE SAVEPOINT work_schedule_create"); err != nil {
				return nil, false, err
			}
		}
		if runErr != nil {
			var api *APIError
			if !errors.As(runErr, &api) {
				return nil, false, runErr
			}
			occurrence.Result, occurrence.Reason = "failed", api.Code+": "+api.Message
		}
	}
	revision, _ := strconv.ParseInt(value.Revision, 10, 64)
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_schedule_occurrences(schedule_id,business_date,scheduled_at,item_id,result,reason,occurred_at,template_revision) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(schedule_id,business_date) DO UPDATE SET scheduled_at=excluded.scheduled_at,item_id=excluded.item_id,result=excluded.result,reason=excluded.reason,occurred_at=excluded.occurred_at,template_revision=excluded.template_revision"), value.ID, occurrence.BusinessDate, occurrence.ScheduledAt, occurrence.ItemID, occurrence.Result, occurrence.Reason, occurrence.OccurredAt, revision)
	if err != nil {
		return nil, false, err
	}
	value.LastRunAt, value.LastResult = occurrence.OccurredAt, occurrence.Result
	value.LastError = ""
	if occurrence.Result == "failed" {
		value.LastError, value.NextRunAt = occurrence.Reason, ""
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_schedules SET last_run_at=?,last_result=?,last_error=?,next_run_at=? WHERE id=?"), value.LastRunAt, value.LastResult, value.LastError, value.NextRunAt, value.ID)
	if err != nil {
		return nil, false, err
	}
	if err = a.recordWorkScheduleNotice(r, value, occurrence); err != nil {
		return nil, false, err
	}
	return occurrence, false, nil
}

func (a *App) generateWorkSchedule(r *Request) (*Response, error) {
	space, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	value, err := a.loadWorkSchedule(r, space.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var in struct {
		BusinessDate     string `json:"businessDate"`
		ExpectedRevision string `json:"expectedRevision"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if in.ExpectedRevision == "" {
		return nil, invalid("expectedRevision is required.")
	}
	if in.ExpectedRevision != value.Revision {
		return nil, workConflict("work_schedule_version_conflict", "The schedule changed. Reload before generating an occurrence.", value.Revision)
	}
	if value.Archived {
		return nil, workConflict("work_schedule_archived", "Restore the schedule before generating work.", value.Revision)
	}
	if in.BusinessDate == "" {
		location, _ := workLocation(value.Rule.Timezone)
		in.BusinessDate = time.Now().In(location).Format("2006-01-02")
	}
	planned, matches := workScheduleDate(value.Rule, in.BusinessDate)
	if !matches {
		return nil, invalid("businessDate must be an occurrence of this rule within its date range.")
	}
	blocked := value.LastError != ""
	occurrence, replayed, err := a.createWorkScheduleOccurrence(r, value, planned, time.Now(), "")
	if err != nil {
		return nil, err
	}
	if !replayed {
		if blocked && occurrence.Result != "failed" && value.Enabled {
			value.NextRunAt = nextWorkScheduleStamp(value.Rule, time.Now())
			if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_schedules SET next_run_at=? WHERE id=?"), value.NextRunAt, value.ID); err != nil {
				return nil, err
			}
		}
		r.WakeWorkSchedules = true
	}
	return ok(map[string]any{"occurrence": occurrence, "replayed": replayed}), nil
}

func (a *App) listWorkScheduleOccurrences(r *Request) (*Response, error) {
	space, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	value, err := a.loadWorkSchedule(r, space.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var in struct {
		Limit  int    `json:"limit"`
		Cursor string `json:"cursor"`
	}
	in.Limit = 30
	if r.Input != nil {
		if err = r.decode(&in); err != nil {
			return nil, err
		}
	} else {
		q := r.HTTP.URL.Query()
		in.Cursor = q.Get("cursor")
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
	if in.Limit < 1 || in.Limit > 100 || len(in.Cursor) > 2048 {
		return nil, invalid("Use limit 1–100 and a bounded cursor.")
	}
	where, args := "schedule_id=?", []any{value.ID}
	filter := workPayloadHash([]any{space.ID, value.ID})
	if in.Cursor != "" {
		var cursor workScheduleCursor
		body, err := base64.RawURLEncoding.DecodeString(in.Cursor)
		if err != nil || json.Unmarshal(body, &cursor) != nil || cursor.Filter != filter || !validWorkDate(cursor.Stamp) {
			return nil, invalid("Invalid occurrence cursor for this schedule.")
		}
		where += " AND business_date<?"
		args = append(args, cursor.Stamp)
	}
	args = append(args, in.Limit+1)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+workOccurrenceColumns+" FROM work_schedule_occurrences WHERE "+where+" ORDER BY business_date DESC LIMIT ?"), args...)
	if err != nil {
		return nil, err
	}
	items := []*WorkScheduleOccurrence{}
	for rows.Next() {
		item, err := scanWorkOccurrence(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	var next *string
	if len(items) > in.Limit {
		items = items[:in.Limit]
		body, _ := json.Marshal(workScheduleCursor{Filter: filter, Stamp: items[len(items)-1].BusinessDate})
		cursor := base64.RawURLEncoding.EncodeToString(body)
		next = &cursor
	}
	return ok(map[string]any{"items": items, "nextCursor": next}), nil
}

func (a *App) wakeWorkScheduleWorker() {
	select {
	case a.workScheduleWake <- struct{}{}:
	default:
	}
}

// No enabled rule (or the work module disabled) means no timer and no periodic
// SQL. The next actual occurrence is the only normal wakeup. Configuration
// writes wake this channel after commit; ordinary reads/writes do not.
func (a *App) startWorkScheduleWorker() {
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		failures := 0
		wakeAt := time.Now()
		for a.ctx.Err() == nil {
			ids, next, err := a.workScheduleDueAt(a.ctx, wakeAt)
			if err == nil && len(ids) > 0 {
				for _, id := range ids {
					if err = a.processWorkSchedule(a.ctx, id, wakeAt); err != nil {
						break
					}
				}
				if err == nil {
					failures = 0
					continue
				}
			}
			if err != nil && a.ctx.Err() == nil {
				failures++
				log.Printf("work scheduler storage failure (attempt %d, %T); configuration wake or restart resumes after the retry budget", failures, err)
				next = time.Time{}
				// Three total storage attempts, then wait for explicit configuration
				// wake/restart. Domain failures are persisted and never retried here.
				if failures < 3 {
					next = time.Now().Add(time.Duration(failures) * 5 * time.Second)
				}
			} else if err == nil {
				failures = 0
			}
			var timer *time.Timer
			var tick <-chan time.Time
			if !next.IsZero() {
				timer = time.NewTimer(time.Until(next))
				tick = timer.C
			}
			select {
			case <-a.ctx.Done():
				if timer != nil {
					timer.Stop()
				}
				return
			case <-a.workScheduleWake:
				failures = 0
			case <-tick:
			}
			if timer != nil {
				timer.Stop()
			}
			wakeAt = time.Now()
		}
	}()
}

func (a *App) workScheduleDue(ctx context.Context) ([]string, time.Time, error) {
	return a.workScheduleDueAt(ctx, time.Now())
}

func (a *App) workScheduleDueAt(ctx context.Context, now time.Time) ([]string, time.Time, error) {
	if err := a.store.CheckLease(ctx); err != nil {
		return nil, time.Time{}, err
	}
	var enabled bool
	if err := a.store.DB.QueryRowContext(ctx, "SELECT work_enabled FROM settings WHERE id=1").Scan(&enabled); err != nil {
		return nil, time.Time{}, err
	}
	if !enabled {
		return nil, time.Time{}, nil
	}
	// The partial index excludes paused, blocked and exhausted rules by their
	// empty deadline. LIMIT bounds work/memory even with a large due backlog.
	rows, err := a.store.DB.QueryContext(ctx, a.store.Query("SELECT id,next_run_at FROM work_schedules WHERE enabled=? AND archived=? AND next_run_at<>'' ORDER BY next_run_at,id LIMIT 50"), true, false)
	if err != nil {
		return nil, time.Time{}, err
	}
	defer rows.Close()
	ids := []string{}
	var next time.Time
	for rows.Next() {
		var id, stamp string
		if err = rows.Scan(&id, &stamp); err != nil {
			return nil, time.Time{}, err
		}
		at, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil {
			return nil, time.Time{}, err
		}
		if !at.After(now) {
			ids = append(ids, id)
		} else {
			next = at
			break
		}
	}
	return ids, next, rows.Err()
}

func (a *App) processWorkSchedule(ctx context.Context, id string, now time.Time) error {
	wakeAutomation := false
	err := a.integrationTransaction(ctx, func(q Queryer) error {
		settings, err := a.loadSettings(ctx, q)
		if err != nil || !settings.Modules.Work {
			return err
		}
		value, err := scanWorkSchedule(q.QueryRowContext(ctx, a.store.Query("SELECT "+workScheduleColumns+" FROM work_schedules WHERE id=?"), id))
		if err != nil {
			return err
		}
		if !value.Enabled || value.Archived || value.NextRunAt == "" {
			return nil
		}
		since, err := time.Parse(time.RFC3339Nano, value.NextRunAt)
		if err != nil {
			return err
		}
		if since.After(now) {
			return nil
		}
		request, err := http.NewRequestWithContext(ctx, "POST", "http://localhost/internal/work-scheduler", nil)
		if err != nil {
			return err
		}
		r := &Request{App: a, HTTP: request, Q: q, Settings: settings}
		defer func() { wakeAutomation = r.WakeWorkAutomation }()
		limit := 1
		if value.MissedPolicy == "all" {
			limit = 7
		}
		planned := recentWorkSchedules(value.Rule, since, now, limit)
		value.NextRunAt = nextWorkScheduleStamp(value.Rule, now)
		// Record one explicit bounded-window skip for the oldest missed date;
		// do not materialize an unbounded number of receipts after long downtime.
		if len(planned) > 0 {
			location, _ := workLocation(value.Rule.Timezone)
			oldest := since.In(location).Format("2006-01-02")
			if oldest < planned[0].BusinessDate {
				old, matches := workScheduleDate(value.Rule, oldest)
				if matches {
					if _, _, err = a.createWorkScheduleOccurrence(r, value, old, now, "missed_window: earlier periods omitted by "+value.MissedPolicy+" policy"); err != nil {
						return err
					}
				}
			}
		}
		for _, occurrence := range planned {
			reason := ""
			at, _ := time.Parse(time.RFC3339Nano, occurrence.ScheduledAt)
			// One minute permits ordinary wake/queue jitter. skip deliberately
			// declines a deadline recovered more than one minute late.
			if value.MissedPolicy == "skip" && now.Sub(at) > time.Minute {
				reason = "missed_period"
			}
			result, _, err := a.createWorkScheduleOccurrence(r, value, occurrence, now, reason)
			if err != nil {
				return err
			}
			if result.Result == "failed" {
				return nil
			}
		}
		_, err = q.ExecContext(ctx, a.store.Query("UPDATE work_schedules SET next_run_at=? WHERE id=?"), value.NextRunAt, id)
		return err
	})
	if err == nil && wakeAutomation {
		a.wakeWorkAutomation()
	}
	return err
}
