package home

import (
	"encoding/base64"
	"encoding/json"
	"time"
)

type workWindow struct {
	From       string `json:"from"`
	To         string `json:"to"`
	Timezone   string `json:"timezone"`
	location   *time.Location
	start, end time.Time
	dates      []string
}

func normalizeWorkWindow(in *workWindow, maxDays int) error {
	if !validWorkDate(in.From) || !validWorkDate(in.To) || in.From >= in.To {
		return invalid("from/to must be actual calendar dates; to is exclusive and later than from.")
	}
	if in.Timezone == "" {
		in.Timezone = "UTC"
	}
	location, err := workLocation(in.Timezone)
	if err != nil {
		return err
	}
	in.location = location
	in.start, err = time.ParseInLocation("2006-01-02", in.From, location)
	if err != nil {
		return err
	}
	in.end, err = time.ParseInLocation("2006-01-02", in.To, location)
	if err != nil {
		return err
	}
	for day := in.start; day.Before(in.end); day = day.AddDate(0, 0, 1) {
		in.dates = append(in.dates, day.Format("2006-01-02"))
		if len(in.dates) > maxDays {
			return invalid("The requested date window is too large.")
		}
	}
	return nil
}

type workCalendarCursor struct {
	Filter   string `json:"f"`
	Revision string `json:"r"`
	ID       string `json:"i"`
	At       string `json:"a"`
	Cutoff   string `json:"c,omitempty"`
}
type WorkCalendarItem struct {
	WorkSummary
	CalendarDate string `json:"calendarDate"`
}

func (a *App) getWorkCalendar(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	window := workWindow{}
	basis, cursor := "businessDate", ""
	clone := *r
	if r.Input != nil {
		var raw map[string]json.RawMessage
		if err = r.decode(&raw); err != nil {
			return nil, err
		}
		for _, f := range []struct {
			name   string
			target any
		}{{"from", &window.From}, {"to", &window.To}, {"timezone", &window.Timezone}, {"basis", &basis}, {"cursor", &cursor}} {
			if err = workDecodeField(raw, f.name, f.target, false); err != nil {
				return nil, err
			}
		}
		delete(raw, "from")
		delete(raw, "to")
		delete(raw, "basis")
		delete(raw, "cursor")
		clone.Input = json.RawMessage(jsonString(raw))
	} else {
		q := r.HTTP.URL.Query()
		window.From = q.Get("from")
		window.To = q.Get("to")
		window.Timezone = q.Get("timezone")
		cursor = q.Get("cursor")
		if v := q.Get("basis"); v != "" {
			basis = v
		}
		req := r.HTTP.Clone(r.HTTP.Context())
		q.Del("cursor")
		req.URL.RawQuery = q.Encode()
		clone.HTTP = req
	}
	if err = normalizeWorkWindow(&window, 62); err != nil {
		return nil, err
	}
	if basis != "businessDate" && basis != "dueAt" {
		return nil, invalid("basis must be businessDate or dueAt.")
	}
	if len(cursor) > 2048 {
		return nil, invalid("Invalid calendar cursor.")
	}
	filter, err := readWorkFilter(&clone)
	if err != nil {
		return nil, err
	}
	if err = a.resolveWorkFilterRefs(r, s.ID, &filter); err != nil {
		return nil, err
	}
	revision, err := a.workRevision(r, s.ID)
	if err != nil {
		return nil, err
	}
	fingerprint := workPayloadHash([]any{s.ID, window.From, window.To, window.Timezone, basis, filter.fingerprint(s.ID)})
	var page workCalendarCursor
	if cursor != "" {
		raw, e := base64.RawURLEncoding.DecodeString(cursor)
		if e != nil || json.Unmarshal(raw, &page) != nil || page.Filter != fingerprint || !validID(page.ID) {
			return nil, invalid("Invalid calendar cursor for this window.")
		}
		if page.Revision != revision {
			return nil, workConflict("work_version_conflict", "The calendar changed. Refresh its first page.", revision)
		}
		if filter.Date == "overdue" {
			at, e := time.Parse(time.RFC3339Nano, page.Cutoff)
			if e != nil || page.Cutoff != workScheduleStamp(at) || at.After(time.Now()) {
				return nil, invalid("Invalid overdue calendar snapshot.")
			}
			filter.cutoff = page.Cutoff
		}
	}
	where, args := filter.where(s.ID)
	column := "w.business_date"
	lower, upper := window.From, window.To
	if basis == "dueAt" {
		column = "w.due_at"
		lower = workScheduleStamp(window.start)
		upper = workScheduleStamp(window.end)
	}
	where += " AND " + column + "<>'' AND " + column + ">=? AND " + column + "<?"
	args = append(args, lower, upper)
	counts := map[string]int{}
	if basis == "businessDate" {
		rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT w.business_date,COUNT(*) FROM work_items w WHERE "+where+" GROUP BY w.business_date"), args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var day string
			var n int
			if err = rows.Scan(&day, &n); err != nil {
				rows.Close()
				return nil, err
			}
			counts[day] = n
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	} else {
		values := ""
		dayArgs := []any{}
		for i, date := range window.dates {
			if i > 0 {
				values += ","
			}
			values += "(?,?,?)"
			start, _ := time.ParseInLocation("2006-01-02", date, window.location)
			dayArgs = append(dayArgs, date, workScheduleStamp(start), workScheduleStamp(start.AddDate(0, 0, 1)))
		}
		dayArgs = append(dayArgs, args...)
		rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("WITH calendar_days(day,start_at,end_at) AS (VALUES "+values+") SELECT c.day,COUNT(w.id) FROM calendar_days c LEFT JOIN work_items w ON "+where+" AND w.due_at>=c.start_at AND w.due_at<c.end_at GROUP BY c.day"), dayArgs...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var day string
			var n int
			if err = rows.Scan(&day, &n); err != nil {
				rows.Close()
				return nil, err
			}
			counts[day] = n
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	days := []map[string]any{}
	total := 0
	for _, date := range window.dates {
		days = append(days, map[string]any{"date": date, "total": counts[date]})
		total += counts[date]
	}
	if cursor != "" {
		where += " AND (" + column + ">? OR (" + column + "=? AND w.id>?))"
		args = append(args, page.At, page.At, page.ID)
	}
	args = append(args, filter.Limit+1)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+a.workSummaryColumns(r)+" FROM work_items w LEFT JOIN work_projects p ON p.id=w.project_id WHERE "+where+" ORDER BY "+column+",w.id LIMIT ?"), args...)
	if err != nil {
		return nil, err
	}
	items := []WorkCalendarItem{}
	for rows.Next() {
		v := WorkCalendarItem{}
		targets, project, rev := workSummaryScan(&v.WorkSummary)
		if err = rows.Scan(targets...); err != nil {
			rows.Close()
			return nil, err
		}
		finishWorkSummary(&v.WorkSummary, project, rev)
		v.CalendarDate = v.BusinessDate
		if basis == "dueAt" {
			at, err := time.Parse(time.RFC3339Nano, v.DueAt)
			if err != nil {
				rows.Close()
				return nil, err
			}
			v.CalendarDate = at.In(window.location).Format("2006-01-02")
		}
		items = append(items, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	var next *string
	if len(items) > filter.Limit {
		items = items[:filter.Limit]
		last := items[len(items)-1]
		at := last.BusinessDate
		if basis == "dueAt" {
			at = last.DueAt
		}
		v := encodeWorkCursor(workCalendarCursor{Filter: fingerprint, Revision: revision, ID: last.ID, At: at, Cutoff: filter.cutoff})
		next = &v
	}
	summaries := make([]WorkSummary, len(items))
	for i := range items {
		summaries[i] = items[i].WorkSummary
	}
	if err = a.decorateWorkCollaboration(r, s.ID, summaries); err != nil {
		return nil, err
	}
	if err = a.decorateWorkPlanning(r, s.ID, workSummaryPointers(summaries), filter.Fields); err != nil {
		return nil, err
	}
	for i := range items {
		items[i].WorkSummary = summaries[i]
	}
	return ok(map[string]any{"revision": revision, "from": window.From, "to": window.To, "timezone": window.Timezone, "basis": basis, "items": items, "days": days, "total": total, "nextCursor": next}), nil
}

func readWorkWindow(r *Request, maxDays int) (workWindow, error) {
	in := workWindow{}
	if r.Input != nil {
		if err := r.decode(&in); err != nil {
			return in, err
		}
	} else {
		q := r.HTTP.URL.Query()
		in.From = q.Get("from")
		in.To = q.Get("to")
		in.Timezone = q.Get("timezone")
	}
	return in, normalizeWorkWindow(&in, maxDays)
}
