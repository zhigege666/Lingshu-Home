package home

import (
	"database/sql"
	"errors"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var linkClickEventPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$`)

// These are browser activations, not evidence that a remote page loaded. There
// is no actor, IP, user agent, referrer, destination URL or client timestamp in
// a receipt. Short-lived receipts only make transport retries idempotent.
func (a *App) recordLinkClick(r *Request) (*Response, error) {
	if r.Bearer {
		return nil, forbidden()
	}
	space, err := r.navigationSpace(r.param("spaceId"), false)
	if err != nil {
		return nil, err
	}
	var in struct {
		EventID string `json:"eventId"`
		Entry   string `json:"entry"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if !linkClickEventPattern.MatchString(in.EventID) {
		return nil, invalid("eventId must be a random 16 to 128 character identifier.")
	}
	switch in.Entry {
	case "primary", "internal", "external", "additional":
	default:
		return nil, invalid("entry must be primary, internal, external or additional.")
	}
	id := r.param("linkId")
	var exists string
	err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT id FROM links WHERE id=? AND space_id=?"), id, space.ID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, missing()
	}
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	stamp := documentActivityStamp(now)
	if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM link_click_receipts WHERE received_at<?"), documentActivityStamp(now.Add(-24*time.Hour))); err != nil {
		return nil, err
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO link_click_receipts(space_id,event_id,link_id,entry,received_at) VALUES(?,?,?,?,?) ON CONFLICT(space_id,event_id) DO NOTHING"), space.ID, in.EventID, id, in.Entry, stamp)
	if err != nil {
		return nil, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if affected == 0 {
		var oldID, oldEntry string
		if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT link_id,entry FROM link_click_receipts WHERE space_id=? AND event_id=?"), space.ID, in.EventID).Scan(&oldID, &oldEntry); err != nil {
			return nil, err
		}
		if oldID != id || oldEntry != in.Entry {
			return nil, conflict("This eventId was already used for another activation.")
		}
		return ok(map[string]bool{"recorded": false}), nil
	}
	if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO link_click_totals(link_id,space_id,clicks,first_clicked_at,last_clicked_at) VALUES(?,?,1,?,?) ON CONFLICT(link_id) DO UPDATE SET clicks=link_click_totals.clicks+1,last_clicked_at=excluded.last_clicked_at"), id, space.ID, stamp, stamp); err != nil {
		return nil, err
	}
	if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO link_click_days(link_id,space_id,day,entry,clicks) VALUES(?,?,?,?,1) ON CONFLICT(link_id,day,entry) DO UPDATE SET clicks=link_click_days.clicks+1"), id, space.ID, now.Format(time.DateOnly), in.Entry); err != nil {
		return nil, err
	}
	return ok(map[string]bool{"recorded": true}), nil
}

type linkClickStatsInput struct {
	From       string  `json:"from"`
	To         string  `json:"to"`
	CategoryID *string `json:"categoryId"`
	LinkID     string  `json:"linkId"`
	Limit      int     `json:"limit"`
	Offset     int     `json:"offset"`
	Sort       string  `json:"sort"`
}
type linkClickStatsItem struct {
	LinkID         string  `json:"linkId"`
	Title          string  `json:"title"`
	URL            string  `json:"url"`
	CategoryID     *string `json:"categoryId"`
	CategoryName   string  `json:"categoryName"`
	PeriodClicks   int64   `json:"periodClicks"`
	TotalClicks    int64   `json:"totalClicks"`
	FirstClickedAt *string `json:"firstClickedAt"`
	LastClickedAt  *string `json:"lastClickedAt"`
}
type linkClickStatsDay struct {
	Date    string `json:"date"`
	Count   int64  `json:"count"`
	Tracked bool   `json:"tracked"`
}
type linkClickStatsCategory struct {
	CategoryID   *string `json:"categoryId"`
	CategoryName string  `json:"categoryName"`
	PeriodClicks int64   `json:"periodClicks"`
	TotalClicks  int64   `json:"totalClicks"`
	Links        int     `json:"links"`
}
type linkClickStatsSummary struct {
	PeriodClicks      int64 `json:"periodClicks"`
	TotalClicks       int64 `json:"totalClicks"`
	Links             int   `json:"links"`
	ActiveLinks       int   `json:"activeLinks"`
	NeverClickedLinks int   `json:"neverClickedLinks"`
}
type linkClickStatsData struct {
	From         string                   `json:"from"`
	To           string                   `json:"to"`
	Timezone     string                   `json:"timezone"`
	RecordedFrom string                   `json:"recordedFrom"`
	Summary      linkClickStatsSummary    `json:"summary"`
	Days         []linkClickStatsDay      `json:"days"`
	Categories   []linkClickStatsCategory `json:"categories"`
	Items        []linkClickStatsItem     `json:"items"`
	Total        int                      `json:"total"`
	Limit        int                      `json:"limit"`
	Offset       int                      `json:"offset"`
	HasMore      bool                     `json:"hasMore"`
}

func readLinkClickStatsInput(r *Request) (linkClickStatsInput, error) {
	in := linkClickStatsInput{Limit: 50, Sort: "clicks"}
	if r.Input != nil {
		err := r.decode(&in)
		return in, err
	}
	q := r.HTTP.URL.Query()
	for key, values := range q {
		if len(values) != 1 {
			return in, invalid("Click statistics parameters must not be repeated.")
		}
		switch key {
		case "from", "to", "categoryId", "linkId", "limit", "offset", "sort":
		default:
			return in, invalid("Unknown click statistics parameter.")
		}
	}
	in.From, in.To, in.LinkID = q.Get("from"), q.Get("to"), q.Get("linkId")
	if q.Has("categoryId") {
		value := q.Get("categoryId")
		in.CategoryID = &value
	}
	if q.Has("sort") {
		in.Sort = q.Get("sort")
	}
	for key, target := range map[string]*int{"limit": &in.Limit, "offset": &in.Offset} {
		if q.Has(key) {
			value, err := strconv.Atoi(q.Get(key))
			if err != nil {
				return in, invalid("Click statistics pagination must use integers.")
			}
			*target = value
		}
	}
	return in, nil
}
func validateLinkClickStatsInput(in *linkClickStatsInput, now time.Time) (time.Time, time.Time, error) {
	var zero time.Time
	if in.To == "" {
		in.To = now.UTC().Format(time.DateOnly)
	}
	to, err := time.Parse(time.DateOnly, in.To)
	if err != nil {
		return zero, zero, invalid("to must be a UTC date in YYYY-MM-DD format.")
	}
	if in.From == "" {
		in.From = to.AddDate(0, 0, -29).Format(time.DateOnly)
	}
	from, err := time.Parse(time.DateOnly, in.From)
	if err != nil {
		return zero, zero, invalid("from must be a UTC date in YYYY-MM-DD format.")
	}
	if from.After(to) || to.Sub(from) >= 366*24*time.Hour {
		return zero, zero, invalid("Choose an inclusive range of 1 to 366 UTC days.")
	}
	if in.Limit < 1 || in.Limit > 200 || in.Offset < 0 || in.Offset > 1000000 {
		return zero, zero, invalid("limit must be 1 to 200 and offset 0 to 1000000.")
	}
	if in.Sort != "clicks" && in.Sort != "lastClicked" {
		return zero, zero, invalid("sort must be clicks or lastClicked.")
	}
	if in.LinkID != "" && !validID(in.LinkID) {
		return zero, zero, missing()
	}
	if in.CategoryID != nil && *in.CategoryID != "" && !validID(*in.CategoryID) {
		return zero, zero, missing()
	}
	return from, to, nil
}

func (a *App) getLinkClickStats(r *Request) (*Response, error) {
	if r.User == nil {
		return nil, unauthorized()
	}
	space, err := r.navigationSpace(r.param("spaceId"), false)
	if err != nil {
		return nil, err
	}
	in, err := readLinkClickStatsInput(r)
	if err != nil {
		return nil, err
	}
	from, to, err := validateLinkClickStatsInput(&in, time.Now())
	if err != nil {
		return nil, err
	}
	// A supplied identifier must belong to this exact authorized space, including
	// an empty category which legitimately has no links to return yet.
	for _, filter := range []struct{ table, id string }{{"links", in.LinkID}, {"categories", linkClickString(in.CategoryID)}} {
		if filter.id == "" {
			continue
		}
		var id string
		err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT id FROM "+filter.table+" WHERE id=? AND space_id=?"), filter.id, space.ID).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, missing()
		}
		if err != nil {
			return nil, err
		}
	}
	out := linkClickStatsData{From: in.From, To: in.To, Timezone: "UTC", Days: []linkClickStatsDay{}, Categories: []linkClickStatsCategory{}, Items: []linkClickStatsItem{}, Limit: in.Limit, Offset: in.Offset}
	if err = r.Q.QueryRowContext(r.HTTP.Context(), "SELECT recorded_from FROM link_click_tracking WHERE id=1").Scan(&out.RecordedFrom); err != nil {
		return nil, err
	}
	recordedAt, err := time.Parse(time.RFC3339Nano, out.RecordedFrom)
	if err != nil {
		return nil, err
	}
	recordedDay := recordedAt.UTC().Format(time.DateOnly)
	today := time.Now().UTC().Format(time.DateOnly)
	where, args := "l.space_id=?", []any{space.ID}
	if in.CategoryID != nil {
		if *in.CategoryID == "" {
			where += " AND l.category_id IS NULL"
		} else {
			where += " AND l.category_id=?"
			args = append(args, *in.CategoryID)
		}
	}
	if in.LinkID != "" {
		where += " AND l.id=?"
		args = append(args, in.LinkID)
	}
	query := "SELECT l.id,l.title,l.url,l.category_id,COALESCE(c.name,''),COALESCE(p.clicks,0),COALESCE(t.clicks,0),t.first_clicked_at,t.last_clicked_at FROM links l LEFT JOIN categories c ON c.id=l.category_id LEFT JOIN link_click_totals t ON t.link_id=l.id LEFT JOIN (SELECT link_id,SUM(clicks) AS clicks FROM link_click_days WHERE space_id=? AND day>=? AND day<=? GROUP BY link_id) p ON p.link_id=l.id WHERE " + where
	queryArgs := append([]any{space.ID, in.From, in.To}, args...)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query(query), queryArgs...)
	if err != nil {
		return nil, err
	}
	items := []linkClickStatsItem{}
	categoryMap := map[string]*linkClickStatsCategory{}
	for rows.Next() {
		var item linkClickStatsItem
		var category, first, last sql.NullString
		if err = rows.Scan(&item.LinkID, &item.Title, &item.URL, &category, &item.CategoryName, &item.PeriodClicks, &item.TotalClicks, &first, &last); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if category.Valid {
			item.CategoryID = &category.String
		}
		if first.Valid {
			item.FirstClickedAt = &first.String
		}
		if last.Valid {
			item.LastClickedAt = &last.String
		}
		items = append(items, item)
		out.Summary.PeriodClicks += item.PeriodClicks
		out.Summary.TotalClicks += item.TotalClicks
		out.Summary.Links++
		if item.PeriodClicks > 0 {
			out.Summary.ActiveLinks++
		}
		if item.TotalClicks == 0 {
			out.Summary.NeverClickedLinks++
		}
		group := categoryMap[category.String]
		if group == nil {
			group = &linkClickStatsCategory{CategoryID: item.CategoryID, CategoryName: item.CategoryName}
			categoryMap[category.String] = group
		}
		group.PeriodClicks += item.PeriodClicks
		group.TotalClicks += item.TotalClicks
		group.Links++
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	for _, group := range categoryMap {
		out.Categories = append(out.Categories, *group)
	}
	sort.Slice(out.Categories, func(i, j int) bool {
		a, b := out.Categories[i], out.Categories[j]
		if a.PeriodClicks != b.PeriodClicks {
			return a.PeriodClicks > b.PeriodClicks
		}
		if a.CategoryName != b.CategoryName {
			return a.CategoryName < b.CategoryName
		}
		return linkClickString(a.CategoryID) < linkClickString(b.CategoryID)
	})
	sort.Slice(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if in.Sort == "lastClicked" {
			if linkClickString(a.LastClickedAt) != linkClickString(b.LastClickedAt) {
				return linkClickString(a.LastClickedAt) > linkClickString(b.LastClickedAt)
			}
		} else if a.PeriodClicks != b.PeriodClicks {
			return a.PeriodClicks > b.PeriodClicks
		}
		if a.Title != b.Title {
			return strings.Compare(a.Title, b.Title) < 0
		}
		return a.LinkID < b.LinkID
	})
	out.Total = len(items)
	end := min(in.Offset+in.Limit, len(items))
	out.HasMore = end < len(items)
	if in.Offset < len(items) {
		out.Items = items[in.Offset:end]
	}
	dayQuery := "SELECT d.day,SUM(d.clicks) FROM link_click_days d JOIN links l ON l.id=d.link_id WHERE " + where + " AND d.day>=? AND d.day<=? GROUP BY d.day"
	dayArgs := append(append([]any{}, args...), in.From, in.To)
	rows, err = r.Q.QueryContext(r.HTTP.Context(), a.store.Query(dayQuery), dayArgs...)
	if err != nil {
		return nil, err
	}
	days := map[string]int64{}
	for rows.Next() {
		var date string
		var count int64
		if err = rows.Scan(&date, &count); err != nil {
			_ = rows.Close()
			return nil, err
		}
		days[date] = count
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	for day := from; !day.After(to); day = day.AddDate(0, 0, 1) {
		date := day.Format(time.DateOnly)
		out.Days = append(out.Days, linkClickStatsDay{Date: date, Count: days[date], Tracked: date >= recordedDay && date <= today})
	}
	if r.Writer != nil {
		r.Writer.Header().Set("Cache-Control", "no-store")
	}
	return ok(out), nil
}
func linkClickString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// Include this spec in integrationTools. Read-only PATs may analyze aggregate
// usage, while reporting a human browser activation is deliberately not a tool.
func (a *App) linkClickStatsIntegrationTool() integrationTool {
	return integrationTool{"navigation_click_stats", "Read aggregate browser link activations in a readable space (navigation:read). UTC dates are inclusive, default last 30 days, maximum 366. Includes zero-click links and current-category grouping; does not count remote page loads or unique people. Empty categoryId selects uncategorized links. History starts at recordedFrom (a partial first UTC day). Days before it have tracked=false, not observed zero activity. neverClickedLinks means no clicks since recording began; no actor or client identifiers are collected.", []string{"spaceId"}, integrationObjectSchema(map[string]any{
		"from": integrationStringSchema(10), "to": integrationStringSchema(10), "categoryId": integrationStringSchema(128), "linkId": integrationStringSchema(128),
		"limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 200}, "offset": map[string]any{"type": "integer", "minimum": 0, "maximum": 1000000},
		"sort": map[string]any{"type": "string", "enum": []string{"clicks", "lastClicked"}},
	}), false, a.getLinkClickStats}
}
