package home

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

type WorkNoticeInput struct {
	SpaceID          string
	Enabled          bool
	Kind             string
	SubjectType      string
	SubjectID        string
	OccurrenceKey    string
	ItemID           string
	Code             string
	Message          string
	RecipientUserIDs []string
}

func workNoticeForSpace(space *Space) WorkNoticeInput {
	if space == nil {
		return WorkNoticeInput{}
	}
	return WorkNoticeInput{SpaceID: space.ID, Enabled: space.WorkNotificationsEnabled}
}
func (a *App) recordWorkNotice(r *Request, in WorkNoticeInput) error {
	if !in.Enabled {
		return nil
	}
	switch in.Kind {
	case "schedule_failed", "automation_failed", "execution_failed", "execution_unknown":
	default:
		return invalid("Unknown work notification kind.")
	}
	if !validID(in.SpaceID) || !validID(in.SubjectID) || len(in.RecipientUserIDs) > 100 {
		return invalid("Invalid work notification identity.")
	}
	for _, f := range []struct {
		v, name string
		limit   int
	}{{in.SubjectType, "subjectType", 40}, {in.OccurrenceKey, "occurrenceKey", 200}, {in.Code, "code", 80}, {in.Message, "message", 500}} {
		if err := bounded(f.v, f.name, f.limit); err != nil {
			return err
		}
	}
	space := r.WorkSpaceContext
	if space == nil || space.ID != in.SpaceID {
		var err error
		space, err = scanSpace(r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+spaceColumns+" FROM spaces WHERE id=?"), in.SpaceID))
		if err != nil {
			return err
		}
	}
	seen := map[string]bool{}
	for _, id := range in.RecipientUserIDs {
		if seen[id] || id == "" {
			continue
		}
		seen[id] = true
		user, err := a.loadUser(r.HTTP.Context(), r.Q, id)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if user == nil || !canLogin(user, r.Settings) {
			continue
		}
		recipient := &Request{User: user, Settings: r.Settings}
		_, edit := recipient.spaceAccess(space)
		if !edit {
			continue
		}
		stamp := workScheduleStamp(time.Now())
		if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_notices(id,space_id,user_id,kind,subject_type,subject_id,occurrence_key,item_id,code,message,first_at,last_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(space_id,user_id,kind,subject_id,occurrence_key) DO UPDATE SET count=work_notices.count+1,last_at=excluded.last_at,code=excluded.code,message=excluded.message,read_at=''"), newID(), in.SpaceID, id, in.Kind, in.SubjectType, in.SubjectID, in.OccurrenceKey, in.ItemID, in.Code, in.Message, stamp, stamp); err != nil {
			return err
		}
	}
	return nil
}

type WorkNotice struct {
	ID            string `json:"id"`
	SpaceID       string `json:"spaceId"`
	Kind          string `json:"kind"`
	SubjectType   string `json:"subjectType"`
	SubjectID     string `json:"subjectId"`
	OccurrenceKey string `json:"occurrenceKey"`
	ItemID        string `json:"itemId,omitempty"`
	Code          string `json:"code"`
	Message       string `json:"message"`
	Count         int    `json:"count"`
	FirstAt       string `json:"firstAt"`
	LastAt        string `json:"lastAt"`
	ReadAt        string `json:"readAt"`
}
type WorkFailureSummary struct {
	ScheduleFailed   int `json:"scheduleFailed"`
	AutomationFailed int `json:"automationFailed"`
	ExecutionFailed  int `json:"executionFailed"`
	ExecutionUnknown int `json:"executionUnknown"`
}

func (a *App) workFailureSummary(r *Request, space string) (WorkFailureSummary, error) {
	value := WorkFailureSummary{}
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_schedules WHERE space_id=? AND archived=? AND last_error<>''"), space, false).Scan(&value.ScheduleFailed)
	if err != nil {
		return value, err
	}
	value.AutomationFailed, value.ExecutionFailed, value.ExecutionUnknown, err = a.workAutomationFailureSummary(r, space)
	return value, err
}
func (a *App) getWorkNoticeSettings(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	return ok(map[string]any{"enabled": s.WorkNotificationsEnabled, "revision": strconv.FormatInt(s.WorkNotificationsRevision, 10), "canEdit": s.CanEdit}), nil
}
func (a *App) updateWorkNoticeSettings(r *Request) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	var in struct {
		Enabled          json.RawMessage `json:"enabled"`
		ExpectedRevision string          `json:"expectedRevision"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if len(in.Enabled) == 0 || string(in.Enabled) == "null" {
		return nil, invalid("enabled must be an explicit boolean.")
	}
	var enabled bool
	if json.Unmarshal(in.Enabled, &enabled) != nil {
		return nil, invalid("enabled must be a boolean.")
	}
	revision := strconv.FormatInt(s.WorkNotificationsRevision, 10)
	if in.ExpectedRevision == "" || in.ExpectedRevision != revision {
		return nil, workConflict("work_notifications_version_conflict", "The notification settings changed. Reload before saving.", revision)
	}
	if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE spaces SET work_notifications_enabled=?,work_notifications_revision=work_notifications_revision+1 WHERE id=?"), enabled, s.ID); err != nil {
		return nil, err
	}
	s.WorkNotificationsEnabled = enabled
	s.WorkNotificationsRevision++
	if !r.workReads("work:read") {
		return ok(map[string]any{"revision": strconv.FormatInt(s.WorkNotificationsRevision, 10)}), nil
	}
	return ok(map[string]any{"enabled": enabled, "revision": strconv.FormatInt(s.WorkNotificationsRevision, 10), "canEdit": true}), nil
}
func (a *App) listWorkNotices(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	in := struct {
		Unread bool   `json:"unread"`
		Limit  int    `json:"limit"`
		Cursor string `json:"cursor"`
	}{Limit: 30}
	if r.Input != nil {
		if err = r.decode(&in); err != nil {
			return nil, err
		}
	} else {
		q := r.HTTP.URL.Query()
		in.Cursor = q.Get("cursor")
		if v := q.Get("unread"); v != "" {
			if v != "true" && v != "false" {
				return nil, invalid("unread must be true or false.")
			}
			in.Unread = v == "true"
		}
		if v := q.Get("limit"); v != "" {
			in.Limit, err = strconv.Atoi(v)
			if err != nil {
				return nil, invalid("Invalid limit.")
			}
		}
	}
	if in.Limit == 0 {
		in.Limit = 30
	}
	if in.Limit < 1 || in.Limit > 100 || len(in.Cursor) > 2048 {
		return nil, invalid("Invalid notification page.")
	}
	where := "space_id=? AND user_id=?"
	args := []any{s.ID, r.User.ID}
	if in.Unread {
		where += " AND read_at=''"
	}
	var total int
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_notices WHERE "+where), args...).Scan(&total); err != nil {
		return nil, err
	}
	fingerprint := workPayloadHash([]any{s.ID, r.User.ID, in.Unread})
	if in.Cursor != "" {
		c, err := decodeWorkSimpleCursor(in.Cursor, fingerprint, "")
		if err != nil {
			return nil, err
		}
		if _, err = time.Parse(time.RFC3339Nano, c.At); err != nil {
			return nil, invalid("Invalid notification cursor timestamp.")
		}
		where += " AND (last_at<? OR (last_at=? AND id<?))"
		args = append(args, c.At, c.At, c.ID)
	}
	args = append(args, in.Limit+1)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id,space_id,kind,subject_type,subject_id,occurrence_key,item_id,code,message,count,first_at,last_at,read_at FROM work_notices WHERE "+where+" ORDER BY last_at DESC,id DESC LIMIT ?"), args...)
	if err != nil {
		return nil, err
	}
	items := []WorkNotice{}
	for rows.Next() {
		var v WorkNotice
		if err = rows.Scan(&v.ID, &v.SpaceID, &v.Kind, &v.SubjectType, &v.SubjectID, &v.OccurrenceKey, &v.ItemID, &v.Code, &v.Message, &v.Count, &v.FirstAt, &v.LastAt, &v.ReadAt); err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, v)
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
		v := encodeWorkCursor(workSimpleCursor{Filter: fingerprint, ID: last.ID, At: last.LastAt})
		next = &v
	}
	return ok(map[string]any{"enabled": s.WorkNotificationsEnabled, "items": items, "total": total, "nextCursor": next}), nil
}
func (a *App) summarizeWorkNotices(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	var in struct {
		Since string `json:"since"`
	}
	if r.Input != nil {
		if err = r.decode(&in); err != nil {
			return nil, err
		}
	} else {
		in.Since = r.HTTP.URL.Query().Get("since")
	}
	if in.Since != "" {
		at, err := time.Parse(time.RFC3339Nano, in.Since)
		if err != nil {
			return nil, invalid("since must be RFC3339.")
		}
		in.Since = workScheduleStamp(at)
	}
	var unread int
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_notices WHERE space_id=? AND user_id=? AND read_at=''"), s.ID, r.User.ID).Scan(&unread); err != nil {
		return nil, err
	}
	where := "space_id=? AND user_id=?"
	args := []any{s.ID, r.User.ID}
	if in.Since != "" {
		where += " AND last_at>=?"
		args = append(args, in.Since)
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT kind,COUNT(*),SUM(CASE WHEN read_at='' THEN 1 ELSE 0 END) FROM work_notices WHERE "+where+" GROUP BY kind ORDER BY kind"), args...)
	if err != nil {
		return nil, err
	}
	byKind := []map[string]any{}
	for rows.Next() {
		var kind string
		var total, unread int
		if err = rows.Scan(&kind, &total, &unread); err != nil {
			rows.Close()
			return nil, err
		}
		byKind = append(byKind, map[string]any{"kind": kind, "total": total, "unread": unread})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	failures, err := a.workFailureSummary(r, s.ID)
	if err != nil {
		return nil, err
	}
	return ok(map[string]any{"enabled": s.WorkNotificationsEnabled, "unreadCount": unread, "byKind": byKind, "spaceFailures": failures}), nil
}
func (a *App) readWorkNotices(r *Request) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	var in struct {
		IDs       []string `json:"ids"`
		AllBefore string   `json:"allBefore"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if len(in.IDs) > 100 || (len(in.IDs) == 0) == (in.AllBefore == "") {
		return nil, invalid("Supply 1–100 IDs or allBefore, exclusively.")
	}
	where := "space_id=? AND user_id=? AND read_at=''"
	args := []any{workStamp(), s.ID, r.User.ID}
	if len(in.IDs) > 0 {
		seen := map[string]bool{}
		for _, id := range in.IDs {
			if !validID(id) || seen[id] {
				return nil, invalid("Notification IDs must be unique valid IDs.")
			}
			seen[id] = true
		}
		slots, ids := workPlaceholders(in.IDs)
		where += " AND id IN (" + slots + ")"
		args = append(args, ids...)
	} else {
		at, err := time.Parse(time.RFC3339Nano, in.AllBefore)
		if err != nil {
			return nil, invalid("allBefore must be RFC3339.")
		}
		where += " AND last_at<=?"
		args = append(args, workScheduleStamp(at))
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_notices SET read_at=? WHERE "+where), args...)
	if err != nil {
		return nil, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	return ok(map[string]any{"updated": n}), nil
}
func (a *App) recordWorkScheduleNotice(r *Request, value *WorkSchedule, occurrence *WorkScheduleOccurrence) error {
	if occurrence.Result != "failed" {
		return nil
	}
	in := WorkNoticeInput{SpaceID: value.SpaceID, Enabled: value.notificationsEnabled, Kind: "schedule_failed", SubjectType: "schedule", SubjectID: value.ID, OccurrenceKey: occurrence.BusinessDate, Code: strings.SplitN(occurrence.Reason, ":", 2)[0], Message: occurrence.Reason, RecipientUserIDs: []string{value.userID}}
	return a.recordWorkNotice(r, in)
}
