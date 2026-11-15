package home

import (
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

type workFilter struct {
	Priority         string   `json:"priority"`
	LabelIDs         []string `json:"labelIds"`
	AssigneeUserID   string   `json:"assigneeUserId"`
	VersionID        string   `json:"versionId"`
	ParentID         string   `json:"parentId"`
	Blocked          *bool    `json:"blocked"`
	Fields           []string `json:"fields"`
	Date             string   `json:"date"`
	Timezone         string   `json:"timezone"`
	BusinessDate     string   `json:"businessDate"`
	cutoff           string
	Q                string `json:"q"`
	ItemID           string `json:"itemId"`
	RequestID        string `json:"requestId"`
	requestUserID    string
	allArchiveStates bool
	ProjectID        string `json:"projectId"`
	Status           string `json:"status"`
	Archived         bool   `json:"archived"`
	Attention        bool   `json:"attention"`
	Limit            int    `json:"limit"`
	Cursor           string `json:"cursor"`
}
type workCursor struct {
	Cutoff   string `json:"a,omitempty"`
	Revision string `json:"r"`
	Filter   string `json:"f"`
	Status   string `json:"s"`
	Rank     int64  `json:"p"`
	ID       string `json:"i"`
}
type workPage struct {
	Statuses              []WorkStatusDefinition `json:"statuses"`
	StatusRevision        string                 `json:"statusRevision"`
	DefaultStatus         string                 `json:"defaultStatus"`
	Revision              string                 `json:"revision"`
	CollaborationRevision string                 `json:"collaborationRevision"`
	CanEdit               bool                   `json:"canEdit"`
	Items                 []WorkSummary          `json:"items"`
	Total                 int                    `json:"total"`
	NextCursor            *string                `json:"nextCursor"`
}
type workColumn struct {
	Status     string        `json:"status"`
	Total      int           `json:"total"`
	Items      []WorkSummary `json:"items"`
	NextCursor *string       `json:"nextCursor"`
}

func readWorkFilter(r *Request) (workFilter, error) {
	in := workFilter{Limit: 30}
	archiveExplicit := false
	if r.Input != nil {
		if err := r.decode(&in); err != nil {
			return in, err
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(r.Input, &fields); err != nil {
			return in, err
		}
		_, archiveExplicit = fields["archived"]
	} else {
		q := r.HTTP.URL.Query()
		in.Q = q.Get("q")
		in.Priority = q.Get("priority")
		in.LabelIDs = q["labelIds"]
		in.AssigneeUserID = q.Get("assigneeUserId")
		in.VersionID = q.Get("versionId")
		in.ParentID = q.Get("parentId")
		in.Fields = q["fields"]
		if v := q.Get("blocked"); v != "" {
			if v != "true" && v != "false" {
				return in, invalid("blocked must be true or false.")
			}
			b := v == "true"
			in.Blocked = &b
		}
		in.Date = q.Get("date")
		in.Timezone = q.Get("timezone")
		in.BusinessDate = q.Get("businessDate")
		in.ItemID = q.Get("itemId")
		in.RequestID = q.Get("requestId")
		archiveExplicit = q.Has("archived")
		in.ProjectID = q.Get("projectId")
		in.Status = q.Get("status")
		in.Cursor = q.Get("cursor")
		for name, target := range map[string]*bool{"archived": &in.Archived, "attention": &in.Attention} {
			if value := q.Get(name); value != "" {
				if value != "true" && value != "false" {
					return in, invalid(name + " must be true or false.")
				}
				*target = value == "true"
			}
		}
		if value := q.Get("limit"); value != "" {
			n, err := strconv.Atoi(value)
			if err != nil {
				return in, invalid("Invalid limit.")
			}
			in.Limit = n
		}
	}
	if in.Limit == 0 {
		in.Limit = 30
	}
	in.Q = strings.TrimSpace(in.Q)
	if in.Limit < 1 || in.Limit > 100 || len(in.Cursor) > 2048 {
		return in, invalid("Use a limit of 1–100 and a bounded cursor.")
	}
	if err := bounded(in.Q, "q", 200); err != nil {
		return in, err
	}
	if in.Status != "" && !workStatusValid(in.Status) {
		return in, invalid("Unknown status.")
	}
	if in.ProjectID != "" && in.ProjectID != "none" && !validID(in.ProjectID) {
		return in, invalid("Invalid projectId.")
	}
	if in.ItemID != "" && !workItemRefValid(in.ItemID) {
		return in, invalid("Invalid itemId.")
	}
	if in.RequestID != "" {
		if !validWorkRequestID(in.RequestID) {
			return in, invalid("Invalid requestId.")
		}
		if r.User == nil {
			return in, unauthorized()
		}
		in.requestUserID = r.User.ID
		in.allArchiveStates = !archiveExplicit
	}
	if in.Date != "" && in.Date != "today" && in.Date != "overdue" {
		return in, invalid("date must be today or overdue.")
	}
	if in.BusinessDate != "" && !validWorkDate(in.BusinessDate) {
		return in, invalid("businessDate must be an actual YYYY-MM-DD date.")
	}
	if in.Date != "" && in.BusinessDate != "" {
		return in, invalid("Use date or businessDate, not both.")
	}
	if in.Timezone == "" && in.Date != "" {
		in.Timezone = "UTC"
	}
	if in.Timezone != "" {
		location, err := workLocation(in.Timezone)
		if err != nil {
			return in, err
		}
		if in.Date == "today" {
			in.BusinessDate = time.Now().In(location).Format("2006-01-02")
		}
	}
	if in.Date == "overdue" {
		in.cutoff = workScheduleStamp(time.Now())
		if in.Cursor != "" {
			// Time alone can change overdue membership without a board revision.
			// Keep both total and rows at the first page's cutoff until refresh.
			var cursor workCursor
			body, err := base64.RawURLEncoding.DecodeString(in.Cursor)
			if err != nil || json.Unmarshal(body, &cursor) != nil {
				return in, invalid("Invalid overdue cursor.")
			}
			cutoff, err := time.Parse(time.RFC3339Nano, cursor.Cutoff)
			if err != nil || cursor.Cutoff != workScheduleStamp(cutoff) || cutoff.After(time.Now()) {
				return in, invalid("Invalid overdue snapshot. Refresh the first page.")
			}
			in.cutoff = cursor.Cutoff
		}
	}
	if err := workPlanningFilterValid(&in, r); err != nil {
		return in, err
	}
	return in, nil
}
func (in workFilter) fingerprint(space string) string {
	values := []any{space, in.Q, in.ProjectID, in.Status, in.Archived, in.Attention}
	if in.ItemID != "" {
		values = append(values, in.ItemID)
	}
	if in.RequestID != "" {
		values = append(values, in.RequestID, in.requestUserID, in.allArchiveStates)
	}
	if in.Date != "" || in.BusinessDate != "" || in.Timezone != "" {
		values = append(values, in.Date, in.BusinessDate, in.Timezone)
	}
	if in.Priority != "" || len(in.LabelIDs) > 0 || in.AssigneeUserID != "" || in.VersionID != "" || in.ParentID != "" || in.Blocked != nil {
		values = append(values, in.Priority, in.LabelIDs, in.AssigneeUserID, in.VersionID, in.ParentID, in.Blocked)
	}
	return workPayloadHash(values)
}
func workLike(value string) string {
	return "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(strings.ToLower(value)) + "%"
}
func (in workFilter) where(space string) (string, []any) {
	where := "w.space_id=?"
	args := []any{space}
	if !in.allArchiveStates {
		where += " AND w.archived=?"
		args = append(args, in.Archived)
	}
	if in.RequestID != "" {
		where += " AND w.create_request_id<>'' AND w.create_request_id=? AND w.create_user_id=?"
		args = append(args, in.RequestID, in.requestUserID)
	}
	if in.BusinessDate != "" {
		where += " AND w.business_date<>'' AND w.business_date=?"
		args = append(args, in.BusinessDate)
	}
	if in.Date == "overdue" {
		where += " AND w.due_at<>'' AND w.due_at<? AND EXISTS (SELECT 1 FROM work_statuses ds WHERE ds.space_id=w.space_id AND ds.id=w.status AND ds.status_type NOT IN ('done','canceled'))"
		args = append(args, in.cutoff)
	}
	if in.ItemID != "" {
		where += " AND w.id=?"
		args = append(args, in.ItemID)
	}
	if in.Status != "" {
		where += " AND w.status=?"
		args = append(args, in.Status)
	}
	if in.ProjectID == "none" {
		where += " AND w.project_id IS NULL"
	} else if in.ProjectID != "" {
		where += " AND w.project_id=?"
		args = append(args, in.ProjectID)
	}
	if in.Attention {
		where += " AND w.needs_attention=?"
		args = append(args, true)
	}
	if in.Priority == "none" {
		where += " AND w.priority=''"
	} else if in.Priority != "" {
		where += " AND w.priority<>'' AND w.priority=?"
		args = append(args, in.Priority)
	}
	for _, label := range in.LabelIDs {
		where += " AND EXISTS(SELECT 1 FROM work_item_labels il WHERE il.item_id=w.id AND il.label_id=?)"
		args = append(args, label)
	}
	if in.AssigneeUserID != "" {
		where += " AND w.assignee_user_id<>'' AND w.assignee_user_id=?"
		args = append(args, in.AssigneeUserID)
	}
	if in.VersionID == "none" {
		where += " AND w.version_id=''"
	} else if in.VersionID != "" {
		where += " AND w.version_id<>'' AND w.version_id=?"
		args = append(args, in.VersionID)
	}
	if in.ParentID == "none" {
		where += " AND w.parent_id=''"
	} else if in.ParentID != "" {
		where += " AND w.parent_id<>'' AND w.parent_id=?"
		args = append(args, in.ParentID)
	}
	if in.Blocked != nil {
		if *in.Blocked {
			where += " AND " + workBlockedPredicate("w")
		} else {
			where += " AND NOT (" + workBlockedPredicate("w") + ")"
		}
	}
	if in.Q != "" {
		where += " AND (w.id=? OR LOWER(w.title) LIKE ? ESCAPE '\\' OR LOWER(w.next_step) LIKE ? ESCAPE '\\' OR LOWER(w.description) LIKE ? ESCAPE '\\' OR LOWER(w.result) LIKE ? ESCAPE '\\')"
		value := workLike(in.Q)
		args = append(args, strings.ToLower(in.Q), value, value, value, value)
	}
	return where, args
}
func (a *App) queryWorkPage(r *Request, s *Space, in workFilter, revision string, total *int, catalog *WorkStatusCatalog) (*workPage, error) {
	result := &workPage{Revision: revision, CanEdit: s.CanEdit, Items: []WorkSummary{}, Statuses: catalog.Items, StatusRevision: catalog.Revision, DefaultStatus: catalog.DefaultStatus}
	if in.Status != "" && catalog.find(in.Status) == nil {
		return nil, a.unavailableWorkStatus(r, s.ID, in.Status, catalog)
	}
	where, args := in.where(s.ID)
	if total == nil {
		if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_items w WHERE "+where), args...).Scan(&result.Total); err != nil {
			return nil, err
		}
	} else {
		result.Total = *total
	}
	if in.Cursor != "" {
		var cursor workCursor
		data, err := base64.RawURLEncoding.DecodeString(in.Cursor)
		if err != nil || json.Unmarshal(data, &cursor) != nil || cursor.Filter != in.fingerprint(s.ID) || !workItemRefValid(cursor.ID) || !workStatusValid(cursor.Status) || cursor.Rank < 0 {
			return nil, invalid("Invalid cursor for these filters.")
		}
		if cursor.Revision != revision {
			return nil, workConflict("work_version_conflict", "The board changed. Refresh before loading another page.", revision)
		}
		if in.Status != "" {
			if cursor.Status != in.Status {
				return nil, invalid("Invalid status cursor.")
			}
			where += " AND (w.sort_order>? OR (w.sort_order=? AND w.id>?))"
			args = append(args, cursor.Rank, cursor.Rank, cursor.ID)
		} else {
			where += " AND (" + workStatusOrder + ",w.sort_order,w.id)>(?,?,?)"
			definition := catalog.find(cursor.Status)
			if definition == nil {
				return nil, invalid("Invalid status cursor.")
			}
			args = append(args, definition.Position, cursor.Rank, cursor.ID)
		}
	}
	order := "w.sort_order,w.id"
	if in.Status == "" {
		order = workStatusOrder + "," + order
	}
	args = append(args, in.Limit+1)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+a.workSummaryColumns(r)+" FROM work_items w JOIN work_statuses ws ON ws.space_id=w.space_id AND ws.id=w.status LEFT JOIN work_projects p ON p.id=w.project_id WHERE "+where+" ORDER BY "+order+" LIMIT ?"), args...)
	if err != nil {
		return nil, err
	}
	result.Items = make([]WorkSummary, 0, min(result.Total, in.Limit+1))
	for rows.Next() {
		result.Items = append(result.Items, WorkSummary{})
		item := &result.Items[len(result.Items)-1]
		targets, project, rev := workSummaryScan(item)
		if err = rows.Scan(targets...); err != nil {
			rows.Close()
			return nil, err
		}
		finishWorkSummary(item, project, rev)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(result.Items) > in.Limit {
		result.Items = result.Items[:in.Limit]
		last := result.Items[len(result.Items)-1]
		encoded, _ := json.Marshal(workCursor{Cutoff: in.cutoff, Revision: revision, Filter: in.fingerprint(s.ID), Status: last.Status, Rank: last.rank, ID: last.ID})
		cursor := base64.RawURLEncoding.EncodeToString(encoded)
		result.NextCursor = &cursor
	}
	return result, nil
}
func (a *App) listWorkItems(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	in, err := readWorkFilter(r)
	if err != nil {
		return nil, err
	}
	revision, err := a.workRevision(r, s.ID)
	if err != nil {
		return nil, err
	}
	catalog, err := a.loadWorkStatuses(r, s.ID, false)
	if err != nil {
		return nil, err
	}
	page, err := a.queryWorkPage(r, s, in, revision, nil, catalog)
	if err != nil {
		return nil, err
	}
	items := workSummaryPointers(page.Items)
	if err = a.decorateWorkCollaboration(r, s.ID, items); err != nil {
		return nil, err
	}
	page.CollaborationRevision, err = a.workCollaborationRevision(r, s.ID)
	if err != nil {
		return nil, err
	}
	if err = a.decorateWorkPlanning(r, s.ID, items, in.Fields); err != nil {
		return nil, err
	}
	if err = a.decorateWorkWIP(r, s.ID, catalog); err != nil {
		return nil, err
	}
	page.Statuses = catalog.Items
	return ok(page), nil
}
func (a *App) getWorkBoard(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	in, err := readWorkFilter(r)
	if err != nil {
		return nil, err
	}
	if in.Status != "" || in.Cursor != "" {
		return nil, invalid("Use items for status-specific or cursor requests.")
	}
	revision, err := a.workRevision(r, s.ID)
	if err != nil {
		return nil, err
	}
	where, args := in.where(s.ID)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT w.status,COUNT(*) FROM work_items w WHERE "+where+" GROUP BY w.status"), args...)
	if err != nil {
		return nil, err
	}
	counts := map[string]int{}
	for rows.Next() {
		var status string
		var n int
		if err = rows.Scan(&status, &n); err != nil {
			rows.Close()
			return nil, err
		}
		counts[status] = n
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	catalog, err := a.loadWorkStatuses(r, s.ID, false)
	if err != nil {
		return nil, err
	}
	columns := make([]workColumn, 0, len(catalog.Items))
	visibleItems := 0
	for _, definition := range catalog.Items {
		status := definition.ID
		in.Status = status
		total := counts[status]
		page, err := a.queryWorkPage(r, s, in, revision, &total, catalog)
		if err != nil {
			return nil, err
		}
		columns = append(columns, workColumn{Status: status, Total: page.Total, Items: page.Items, NextCursor: page.NextCursor})
		visibleItems += len(page.Items)
	}
	all := make([]*WorkSummary, 0, visibleItems)
	for i := range columns {
		for j := range columns[i].Items {
			all = append(all, &columns[i].Items[j])
		}
	}
	if err = a.decorateWorkCollaboration(r, s.ID, all); err != nil {
		return nil, err
	}
	if err = a.decorateWorkPlanning(r, s.ID, all, in.Fields); err != nil {
		return nil, err
	}
	if err = a.decorateWorkWIP(r, s.ID, catalog); err != nil {
		return nil, err
	}
	collaborationRevision, err := a.workCollaborationRevision(r, s.ID)
	if err != nil {
		return nil, err
	}
	return ok(map[string]any{"revision": revision, "collaborationRevision": collaborationRevision, "canEdit": s.CanEdit, "columns": columns, "statuses": catalog.Items, "statusRevision": catalog.Revision, "defaultStatus": catalog.DefaultStatus}), nil
}

type workResourceFilter struct {
	Kind   string `json:"kind"`
	Q      string `json:"q"`
	Limit  int    `json:"limit"`
	Cursor string `json:"cursor"`
}

func (a *App) searchWorkResources(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	in := workResourceFilter{Limit: 20}
	if r.Input != nil {
		if err = r.decode(&in); err != nil {
			return nil, err
		}
	} else {
		q := r.HTTP.URL.Query()
		in.Kind = q.Get("kind")
		in.Q = q.Get("q")
		in.Cursor = q.Get("cursor")
		if value := q.Get("limit"); value != "" {
			in.Limit, err = strconv.Atoi(value)
			if err != nil {
				return nil, invalid("Invalid limit.")
			}
		}
	}
	if in.Limit == 0 {
		in.Limit = 20
	}
	in.Q = strings.TrimSpace(in.Q)
	if in.Limit < 1 || in.Limit > 50 || len(in.Cursor) > 1024 {
		return nil, invalid("Use a resource limit of 1–50.")
	}
	if err = bounded(in.Q, "q", 200); err != nil {
		return nil, err
	}
	if in.Kind != "bookmark" && in.Kind != "document" {
		return nil, invalid("kind must be bookmark or document.")
	}
	action := "navigation:read"
	if in.Kind == "document" {
		action = "documents:read"
	}
	if err = r.requireAction(action); err != nil {
		return nil, err
	}
	if in.Kind == "document" {
		if err = r.requireModule("documents"); err != nil {
			return nil, err
		}
	}
	fingerprint := workPayloadHash([]string{s.ID, in.Kind, in.Q})
	after := ""
	if in.Cursor != "" {
		var cursor struct {
			Filter string `json:"f"`
			ID     string `json:"i"`
		}
		data, err := base64.RawURLEncoding.DecodeString(in.Cursor)
		if err != nil || json.Unmarshal(data, &cursor) != nil || cursor.Filter != fingerprint || !validID(cursor.ID) {
			return nil, invalid("Invalid resource cursor.")
		}
		after = cursor.ID
	}
	items := []WorkReference{}
	if in.Kind == "bookmark" {
		where := "space_id=?"
		args := []any{s.ID}
		if in.Q != "" {
			where += " AND (LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(url) LIKE ? ESCAPE '\\')"
			like := workLike(in.Q)
			args = append(args, like, like)
		}
		if after != "" {
			where += " AND id>?"
			args = append(args, after)
		}
		args = append(args, in.Limit+1)
		rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id,title,url FROM links WHERE "+where+" ORDER BY id LIMIT ?"), args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			ref := WorkReference{Kind: "bookmark", Available: true}
			if err = rows.Scan(&ref.ID, &ref.Title, &ref.URL); err != nil {
				rows.Close()
				return nil, err
			}
			items = append(items, ref)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	} else {
		where := "d.space_id=? AND s.enabled=?"
		args := []any{s.ID, true}
		if in.Q != "" {
			where += " AND (LOWER(d.title) LIKE ? ESCAPE '\\' OR LOWER(d.relative_path) LIKE ? ESCAPE '\\')"
			like := workLike(in.Q)
			args = append(args, like, like)
		}
		if after != "" {
			where += " AND d.id>?"
			args = append(args, after)
		}
		args = append(args, in.Limit+1)
		rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT d.id,d.title,d.relative_path,d.status FROM documents d JOIN document_sources s ON s.id=d.source_id WHERE "+where+" ORDER BY d.id LIMIT ?"), args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			ref := WorkReference{Kind: "document"}
			var status string
			if err = rows.Scan(&ref.ID, &ref.Title, &ref.Subtitle, &status); err != nil {
				rows.Close()
				return nil, err
			}
			ref.Available = status == "ready"
			items = append(items, ref)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	var next *string
	if len(items) > in.Limit {
		items = items[:in.Limit]
		cursor := base64.RawURLEncoding.EncodeToString([]byte(jsonString(map[string]string{"f": fingerprint, "i": items[len(items)-1].ID})))
		next = &cursor
	}
	return ok(map[string]any{"items": items, "nextCursor": next}), nil
}
