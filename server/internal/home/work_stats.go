package home

import (
	"database/sql"
	"encoding/json"
	"math"
	"sort"
	"time"
)

type WorkDurationStats struct {
	Samples       int      `json:"samples"`
	Unknown       int      `json:"unknown"`
	Open          int      `json:"open"`
	TotalSeconds  *float64 `json:"totalSeconds"`
	MedianSeconds *float64 `json:"medianSeconds"`
	P95Seconds    *float64 `json:"p95Seconds"`
}

func finishWorkDurations(values []float64, out *WorkDurationStats) {
	out.Samples = len(values)
	if len(values) == 0 {
		return
	}
	sort.Float64s(values)
	total := 0.0
	for _, v := range values {
		total += v
	}
	median := values[len(values)/2]
	if len(values)%2 == 0 {
		median = (values[len(values)/2-1] + median) / 2
	}
	p95 := values[int(math.Ceil(float64(len(values))*.95))-1]
	out.TotalSeconds = &total
	out.MedianSeconds = &median
	out.P95Seconds = &p95
}
func workStatsTooLarge() error {
	return &APIError{Status: 422, Code: "work_stats_window_too_large", Message: "This window exceeds 100000 recorded events or intervals. Select a shorter window; partial statistics are not returned."}
}
func (a *App) getWorkStats(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	window, err := readWorkWindow(r, 366)
	if err != nil {
		return nil, err
	}
	start, end := workScheduleStamp(window.start), workScheduleStamp(window.end)
	current := map[string]int{"total": 0, "unarchived": 0, "unfinished": 0, "attention": 0, "overdue": 0, "blocked": 0}
	type statusCount struct {
		Status     string `json:"status"`
		Type       string `json:"type"`
		Unarchived int    `json:"unarchived"`
		Archived   int    `json:"archived"`
	}
	byStatus := []statusCount{}
	byID := map[string]int{}
	blocked := "0"
	if s.WorkRelationsCount > 0 {
		blocked = "CASE WHEN " + workBlockedPredicate("w") + " THEN 1 ELSE 0 END"
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT w.status,st.status_type,w.archived,COUNT(*),SUM(CASE WHEN w.needs_attention THEN 1 ELSE 0 END),SUM(CASE WHEN w.due_at<>'' AND w.due_at<? AND st.status_type NOT IN ('done','canceled') THEN 1 ELSE 0 END),SUM("+blocked+") FROM work_items w JOIN work_statuses st ON st.space_id=w.space_id AND st.id=w.status WHERE w.space_id=? GROUP BY w.status,st.status_type,w.archived ORDER BY w.status,w.archived"), workScheduleStamp(time.Now()), s.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var status, kind string
		var archived bool
		var count, attention, overdue, blocking int
		if err = rows.Scan(&status, &kind, &archived, &count, &attention, &overdue, &blocking); err != nil {
			rows.Close()
			return nil, err
		}
		current["total"] += count
		i, ok := byID[status]
		if !ok {
			i = len(byStatus)
			byID[status] = i
			byStatus = append(byStatus, statusCount{Status: status, Type: kind})
		}
		if archived {
			byStatus[i].Archived = count
		} else {
			byStatus[i].Unarchived = count
			current["unarchived"] += count
			current["attention"] += attention
			current["overdue"] += overdue
			current["blocked"] += blocking
			if kind != "done" && kind != "canceled" {
				current["unfinished"] += count
			}
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	type dayCount struct {
		Date               string `json:"date"`
		Created            int    `json:"created"`
		CompletionEvents   int    `json:"completionEvents"`
		CancellationEvents int    `json:"cancellationEvents"`
	}
	days := make([]dayCount, len(window.dates))
	dayIndex := map[string]int{}
	for i, date := range window.dates {
		days[i].Date = date
		dayIndex[date] = i
	}
	period := map[string]int{"created": 0, "completedItems": 0, "completionEvents": 0, "cancellationEvents": 0}
	completed := map[string]bool{}
	rows, err = r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT item_id,action,occurred_at,changes_json FROM work_activity WHERE space_id=? AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at,id LIMIT 100001"), s.ID, start, end)
	if err != nil {
		return nil, err
	}
	events := 0
	for rows.Next() {
		events++
		if events > 100000 {
			rows.Close()
			return nil, workStatsTooLarge()
		}
		var item, action, stamp, body string
		if err = rows.Scan(&item, &action, &stamp, &body); err != nil {
			rows.Close()
			return nil, err
		}
		at, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil {
			rows.Close()
			return nil, err
		}
		index, ok := dayIndex[at.In(window.location).Format("2006-01-02")]
		if !ok {
			continue
		}
		if action == "create" {
			period["created"]++
			days[index].Created++
			continue
		}
		if action != "update" && action != "move" {
			continue
		}
		var changes []WorkActivityChange
		if err = json.Unmarshal([]byte(body), &changes); err != nil {
			rows.Close()
			return nil, err
		}
		for _, change := range changes {
			if change.Field != "status" {
				continue
			}
			var before, after struct {
				Type string `json:"type"`
			}
			if err = json.Unmarshal(change.Before, &before); err != nil {
				rows.Close()
				return nil, err
			}
			if err = json.Unmarshal(change.After, &after); err != nil {
				rows.Close()
				return nil, err
			}
			if before.Type != after.Type && after.Type == "done" {
				period["completionEvents"]++
				days[index].CompletionEvents++
				completed[item] = true
			}
			if before.Type != after.Type && after.Type == "canceled" {
				period["cancellationEvents"]++
				days[index].CancellationEvents++
			}
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	period["completedItems"] = len(completed)
	durations := map[string]*WorkDurationStats{"cycle": {}, "blocked": {}}
	values := map[string][]float64{"cycle": {}, "blocked": {}}
	rows, err = r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT kind,started_at,ended_at,valid FROM work_metric_intervals WHERE space_id=? AND ended_at<>'' AND ended_at>=? AND ended_at<? AND ((kind='cycle' AND outcome='done') OR (kind='blocked' AND outcome='resolved')) ORDER BY ended_at,id LIMIT 100001"), s.ID, start, end)
	if err != nil {
		return nil, err
	}
	intervals := 0
	for rows.Next() {
		intervals++
		if intervals > 100000 {
			rows.Close()
			return nil, workStatsTooLarge()
		}
		var kind, from, to string
		var valid bool
		if err = rows.Scan(&kind, &from, &to, &valid); err != nil {
			rows.Close()
			return nil, err
		}
		if !valid || from == "" {
			durations[kind].Unknown++
			continue
		}
		fromAt, e := time.Parse(time.RFC3339Nano, from)
		if e != nil {
			rows.Close()
			return nil, e
		}
		toAt, e := time.Parse(time.RFC3339Nano, to)
		if e != nil {
			rows.Close()
			return nil, e
		}
		if toAt.Before(fromAt) {
			rows.Close()
			return nil, &APIError{Status: 500, Code: "work_stats_invalid_interval", Message: "A recorded interval has reversed timestamps."}
		}
		values[kind] = append(values[kind], toAt.Sub(fromAt).Seconds())
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for kind, value := range durations {
		finishWorkDurations(values[kind], value)
	}
	durations["cycle"].Unknown = period["completionEvents"] - durations["cycle"].Samples
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_metric_intervals m JOIN work_items w ON w.id=m.item_id JOIN work_statuses st ON st.space_id=w.space_id AND st.id=w.status WHERE m.space_id=? AND m.kind='cycle' AND m.ended_at='' AND m.valid=? AND m.started_at<>'' AND w.archived=? AND st.status_type NOT IN ('done','canceled')"), s.ID, true, false).Scan(&durations["cycle"].Open); err != nil {
		return nil, err
	}
	durations["blocked"].Open = current["blocked"]
	var activityFrom sql.NullString
	var blockingFrom string
	var unknownCompleted, unknownBlocked int
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT MIN(occurred_at) FROM work_activity WHERE space_id=?"), s.ID).Scan(&activityFrom); err != nil {
		return nil, err
	}
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT metrics_started_at FROM work_spaces WHERE space_id=?"), s.ID).Scan(&blockingFrom); err != nil {
		return nil, err
	}
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_items w JOIN work_statuses st ON st.space_id=w.space_id AND st.id=w.status WHERE w.space_id=? AND st.status_type='done' AND NOT EXISTS(SELECT 1 FROM work_metric_intervals m WHERE m.item_id=w.id AND m.kind='cycle' AND m.outcome='done' AND m.ended_at<>'')"), s.ID).Scan(&unknownCompleted); err != nil {
		return nil, err
	}
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_metric_intervals m JOIN work_items w ON w.id=m.item_id WHERE m.space_id=? AND m.kind='blocked' AND m.ended_at='' AND m.started_at='' AND w.archived=?"), s.ID, false).Scan(&unknownBlocked); err != nil {
		return nil, err
	}
	var activity any
	if activityFrom.Valid {
		activity = activityFrom.String
	}
	var blocking any
	if blockingFrom != "" {
		blocking = blockingFrom
	}
	currentJSON := map[string]any{}
	for k, v := range current {
		currentJSON[k] = v
	}
	currentJSON["byStatus"] = byStatus
	return ok(map[string]any{"from": window.From, "to": window.To, "timezone": window.Timezone, "current": currentJSON, "period": period, "days": days, "durations": durations, "coverage": map[string]any{"activityFrom": activity, "blockingFrom": blocking, "unknownCompletedAt": unknownCompleted, "unknownBlockedAt": unknownBlocked}}), nil
}
