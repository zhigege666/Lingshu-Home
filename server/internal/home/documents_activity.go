package home

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
)

// Only trusted server dispatch can attach an origin; clients cannot choose an
// actor or make an ordinary bearer request impersonate an MCP connection.
type documentActivityOriginKey struct{}

func withDocumentActivityOrigin(ctx context.Context, origin string) context.Context {
	return context.WithValue(ctx, documentActivityOriginKey{}, origin)
}

func documentActivityOrigin(r *Request) string {
	if origin, _ := r.HTTP.Context().Value(documentActivityOriginKey{}).(string); origin == "mcp" {
		return origin
	}
	if r.Bearer {
		return "api"
	}
	return "web"
}

// Fixed precision makes TEXT comparison identical on SQLite and PostgreSQL,
// including the first second of a local day. Store instants, not local dates.
func documentActivityStamp(at time.Time) string {
	return at.UTC().Format("2006-01-02T15:04:05.000000000Z")
}

// Call only after an actual change, in the transaction updating its index.
// Repeated content revisions are intentionally allowed (A -> B -> A).
func (a *App) recordDocumentActivity(r *Request, documentID, action, origin, before, after string) error {
	if origin == "" {
		origin = documentActivityOrigin(r)
	}
	var actor any
	if origin != "external" && r.User != nil {
		actor = r.User.ID
	}
	at := documentActivityStamp(time.Now())
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO document_activity(id,document_id,source_id,space_id,actor_id,action,origin,occurred_at,observed_at,before_revision,after_revision) SELECT ?,id,source_id,space_id,?,?,?,?,?,?,? FROM documents WHERE id=?"), newID(), actor, action, origin, at, at, before, after, documentID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err == nil && n != 1 {
		return missing()
	}
	return err
}

func (a *App) documentActivityBaseline(r *Request, sourceID string) (string, error) {
	var started string
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT activity_started_at FROM document_sources WHERE id=?"), sourceID).Scan(&started)
	return started, err
}

// An external editor may change a file between indexing and an explicit Home
// operation. Preserve that observation as external rather than attributing it
// to the user who happens to save tags or trigger the next read/scan.
func (a *App) recordObservedDocumentChange(r *Request, d *documentRecord, currentRevision string) error {
	if currentRevision == d.Revision && d.Status == "ready" {
		return nil
	}
	started, err := a.documentActivityBaseline(r, d.SourceID)
	if err != nil || started == "" {
		return err
	}
	action := "update"
	if d.Status != "ready" {
		action = "restore"
	}
	return a.recordDocumentActivity(r, d.ID, action, "external", d.Revision, currentRevision)
}

type documentActivityInput struct {
	From        string   `json:"from"`
	To          string   `json:"to"`
	Timezone    string   `json:"timezone"`
	Perspective string   `json:"perspective"`
	SourceIDs   []string `json:"sourceIds"`
	Date        string   `json:"date"`
	Limit       int      `json:"limit"`
	Offset      int      `json:"offset"`
}

type documentActivityDay struct {
	Date    string `json:"date"`
	Count   int    `json:"count"`
	Created int    `json:"created"`
	Updated int    `json:"updated"`
}

type documentActivityItem struct {
	DocumentID   string   `json:"documentId"`
	Title        string   `json:"title"`
	RelativePath string   `json:"relativePath"`
	SourceID     string   `json:"sourceId"`
	SourceName   string   `json:"sourceName"`
	Date         string   `json:"date"`
	LastAt       string   `json:"lastAt"`
	Count        int      `json:"count"`
	Actions      []string `json:"actions"`
	Origins      []string `json:"origins"`
	Status       string   `json:"status"`
}

type documentActivitySource struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Status       string `json:"status"`
	LastScanAt   string `json:"lastScanAt"`
	RecordedFrom string `json:"recordedFrom"`
}

type documentActivityData struct {
	From         string                   `json:"from"`
	To           string                   `json:"to"`
	Timezone     string                   `json:"timezone"`
	Perspective  string                   `json:"perspective"`
	RecordedFrom string                   `json:"recordedFrom"`
	Days         []documentActivityDay    `json:"days"`
	Summary      documentActivitySummary  `json:"summary"`
	Items        []documentActivityItem   `json:"items"`
	Sources      []documentActivitySource `json:"sources"`
	Total        int                      `json:"total"`
	HasMore      bool                     `json:"hasMore"`
}

type documentActivitySummary struct {
	Documents  int `json:"documents"`
	ActiveDays int `json:"activeDays"`
}

func readDocumentActivityInput(r *Request) (documentActivityInput, error) {
	in := documentActivityInput{Limit: 20}
	if r.Input != nil {
		if err := r.decode(&in); err != nil {
			return in, err
		}
	} else {
		q := r.HTTP.URL.Query()
		in.From, in.To, in.Timezone = q.Get("from"), q.Get("to"), q.Get("timezone")
		in.Perspective, in.Date = q.Get("perspective"), q.Get("date")
		for _, value := range q["sourceIds"] {
			in.SourceIDs = append(in.SourceIDs, strings.Split(value, ",")...)
		}
		for name, target := range map[string]*int{"limit": &in.Limit, "offset": &in.Offset} {
			if value := q.Get(name); value != "" {
				parsed, err := strconv.Atoi(value)
				if err != nil {
					return in, invalid("Activity pagination must use integers.")
				}
				*target = parsed
			}
		}
	}
	return in, nil
}

func validateDocumentActivityInput(in *documentActivityInput, now time.Time) (*time.Location, time.Time, time.Time, error) {
	if in.Timezone == "" {
		in.Timezone = "UTC"
	}
	if len(in.Timezone) > 100 || in.Timezone == "Local" {
		return nil, time.Time{}, time.Time{}, invalid("Use an IANA timezone or UTC.")
	}
	zone, err := time.LoadLocation(in.Timezone)
	if err != nil {
		return nil, time.Time{}, time.Time{}, invalid("Use an IANA timezone or UTC.")
	}
	if in.Perspective == "" {
		in.Perspective = "mine"
	}
	if in.Perspective != "mine" && in.Perspective != "library" {
		return nil, time.Time{}, time.Time{}, invalid("Activity perspective must be mine or library.")
	}
	if in.To == "" {
		in.To = now.In(zone).Format(time.DateOnly)
	}
	to, err := time.ParseInLocation(time.DateOnly, in.To, zone)
	if err != nil || to.Format(time.DateOnly) != in.To {
		return nil, time.Time{}, time.Time{}, invalid("Activity to must be a valid YYYY-MM-DD date.")
	}
	if in.From == "" {
		in.From = to.AddDate(0, -6, 1).Format(time.DateOnly)
	}
	from, err := time.ParseInLocation(time.DateOnly, in.From, zone)
	if err != nil || from.Format(time.DateOnly) != in.From || from.After(to) || !to.Before(from.AddDate(0, 0, 367)) {
		return nil, time.Time{}, time.Time{}, invalid("Use an inclusive activity date range of at most 367 days.")
	}
	if in.Date != "" {
		day, e := time.ParseInLocation(time.DateOnly, in.Date, zone)
		if e != nil || day.Format(time.DateOnly) != in.Date || day.Before(from) || day.After(to) {
			return nil, time.Time{}, time.Time{}, invalid("The selected date must be within the activity range.")
		}
	}
	if in.Limit < 1 || in.Limit > 100 || in.Offset < 0 || in.Offset > 1000000 || len(in.SourceIDs) > 100 {
		return nil, time.Time{}, time.Time{}, invalid("Use a limit of 1–100, a nonnegative bounded offset, and at most 100 directories.")
	}
	seen := map[string]bool{}
	sources := []string{}
	for _, id := range in.SourceIDs {
		if !validID(id) {
			return nil, time.Time{}, time.Time{}, invalid("Invalid activity directory ID.")
		}
		if !seen[id] {
			sources = append(sources, id)
			seen[id] = true
		}
	}
	in.SourceIDs = sources
	return zone, from, to.AddDate(0, 0, 1), nil
}

func (a *App) listDocumentActivity(r *Request) (*Response, error) {
	s, edit, err := r.documentSpace(false)
	if err != nil {
		return nil, err
	}
	if r.User == nil {
		return nil, unauthorized()
	}
	if !edit {
		return nil, &APIError{Status: 403, Code: "document_activity_forbidden", Message: "Document activity is available only to readers of the working documents."}
	}
	in, err := readDocumentActivityInput(r)
	if err != nil {
		return nil, err
	}
	data, err := a.queryDocumentActivity(r, s.ID, in)
	if err != nil {
		return nil, err
	}
	return ok(data), nil
}

// Queries never open or scan original files. Directory names and both summary
// and detail records are read only after the same working-document permission
// check. Disabled sources disappear together with their historical counts.
func (a *App) queryDocumentActivity(r *Request, spaceID string, in documentActivityInput) (*documentActivityData, error) {
	zone, from, until, err := validateDocumentActivityInput(&in, time.Now())
	if err != nil {
		return nil, err
	}
	out := &documentActivityData{From: in.From, To: in.To, Timezone: in.Timezone, Perspective: in.Perspective, Days: []documentActivityDay{}, Items: []documentActivityItem{}, Sources: []documentActivitySource{}}
	wanted := map[string]bool{}
	for _, id := range in.SourceIDs {
		wanted[id] = true
	}
	sources, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id,name,status,last_scan_at,activity_started_at FROM document_sources WHERE space_id=? AND enabled=? ORDER BY name,id"), spaceID, true)
	if err != nil {
		return nil, err
	}
	known := map[string]bool{}
	for sources.Next() {
		var source documentActivitySource
		if err = sources.Scan(&source.ID, &source.Name, &source.Status, &source.LastScanAt, &source.RecordedFrom); err != nil {
			sources.Close()
			return nil, err
		}
		known[source.ID] = true
		out.Sources = append(out.Sources, source)
		if (len(wanted) == 0 || wanted[source.ID]) && source.RecordedFrom != "" && (out.RecordedFrom == "" || source.RecordedFrom < out.RecordedFrom) {
			out.RecordedFrom = source.RecordedFrom
		}
	}
	err = sources.Err()
	sources.Close()
	if err != nil {
		return nil, err
	}
	for id := range wanted {
		if !known[id] {
			return nil, missing()
		}
	}
	where := "e.space_id=? AND s.enabled=?"
	args := []any{spaceID, true}
	if in.Perspective == "mine" {
		where += " AND e.actor_id=?"
		args = append(args, r.User.ID)
	}
	if len(in.SourceIDs) > 0 {
		marks := []string{}
		for _, id := range in.SourceIDs {
			marks = append(marks, "?")
			args = append(args, id)
		}
		where += " AND e.source_id IN (" + strings.Join(marks, ",") + ")"
	}
	// An explicit Home edit can precede the first successful upgrade baseline.
	var first sql.NullString
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT MIN(e.occurred_at) FROM document_activity e JOIN document_sources s ON s.id=e.source_id WHERE "+where), args...).Scan(&first); err != nil {
		return nil, err
	}
	if first.Valid && (out.RecordedFrom == "" || first.String < out.RecordedFrom) {
		out.RecordedFrom = first.String
	}
	where += " AND e.occurred_at>=? AND e.occurred_at<?"
	args = append(args, documentActivityStamp(from), documentActivityStamp(until))
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT e.document_id,d.title,d.relative_path,e.source_id,s.name,d.status,e.occurred_at,e.action,e.origin FROM document_activity e JOIN document_sources s ON s.id=e.source_id JOIN documents d ON d.id=e.document_id WHERE "+where+" ORDER BY e.occurred_at DESC,e.id DESC"), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type dayCounts struct{ all, created, updated map[string]bool }
	counts := map[string]*dayCounts{}
	documents := map[string]bool{}
	items := map[string]*documentActivityItem{}
	read := 0
	for rows.Next() {
		read++
		if read > 250000 {
			return nil, &APIError{Status: 422, Code: "document_activity_window_too_large", Message: "This activity range exceeds 250,000 events. Choose fewer directories or a shorter date range."}
		}
		if err = r.HTTP.Context().Err(); err != nil {
			return nil, err
		}
		var row documentActivityItem
		var action, origin string
		if err = rows.Scan(&row.DocumentID, &row.Title, &row.RelativePath, &row.SourceID, &row.SourceName, &row.Status, &row.LastAt, &action, &origin); err != nil {
			return nil, err
		}
		at, e := time.Parse(time.RFC3339Nano, row.LastAt)
		if e != nil {
			return nil, errors.New("invalid stored activity instant")
		}
		row.Date = at.In(zone).Format(time.DateOnly)
		if action == "create" || action == "update" || action == "restore" {
			day := counts[row.Date]
			if day == nil {
				day = &dayCounts{map[string]bool{}, map[string]bool{}, map[string]bool{}}
				counts[row.Date] = day
			}
			day.all[row.DocumentID] = true
			documents[row.DocumentID] = true
			if action == "create" {
				day.created[row.DocumentID] = true
			} else {
				day.updated[row.DocumentID] = true
			}
		}
		if in.Date != "" && row.Date != in.Date {
			continue
		}
		key := row.Date + ":" + row.DocumentID
		item := items[key]
		if item == nil {
			copy := row
			copy.Actions, copy.Origins = []string{}, []string{}
			item = &copy
			items[key] = item
		}
		item.Count++
		item.Actions = appendActivityValue(item.Actions, action)
		item.Origins = appendActivityValue(item.Origins, origin)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	for date, day := range counts {
		// A document created and later edited that day is one new document;
		// the disjoint breakdown therefore always adds up to the day total.
		updated := 0
		for id := range day.updated {
			if !day.created[id] {
				updated++
			}
		}
		out.Days = append(out.Days, documentActivityDay{Date: date, Count: len(day.all), Created: len(day.created), Updated: updated})
	}
	sort.Slice(out.Days, func(i, j int) bool { return out.Days[i].Date < out.Days[j].Date })
	out.Summary = documentActivitySummary{Documents: len(documents), ActiveDays: len(counts)}
	ordered := make([]documentActivityItem, 0, len(items))
	for _, item := range items {
		sort.Strings(item.Actions)
		sort.Strings(item.Origins)
		ordered = append(ordered, *item)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].LastAt != ordered[j].LastAt {
			return ordered[i].LastAt > ordered[j].LastAt
		}
		return ordered[i].DocumentID < ordered[j].DocumentID
	})
	out.Total = len(ordered)
	start := min(in.Offset, len(ordered))
	end := min(start+in.Limit, len(ordered))
	out.Items = append(out.Items, ordered[start:end]...)
	out.HasMore = end < len(ordered)
	return out, nil
}

func appendActivityValue(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func documentActivitySameValues(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	seen := map[string]bool{}
	for _, value := range left {
		seen[value] = true
	}
	for _, value := range right {
		if !seen[value] {
			return false
		}
	}
	return true
}
