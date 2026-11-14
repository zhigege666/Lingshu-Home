package home

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
)

var workViewFields = map[string]bool{"key": true, "priority": true, "labels": true, "assignee": true, "version": true, "project": true, "nextStep": true, "businessDate": true, "dueAt": true, "relations": true, "collaboration": true}
var workViewFilters = map[string]bool{"q": true, "itemId": true, "projectId": true, "status": true, "archived": true, "attention": true, "date": true, "timezone": true, "businessDate": true, "priority": true, "labelIds": true, "assigneeUserId": true, "versionId": true, "parentId": true, "blocked": true}

type WorkViewDefinition struct {
	Layout        string                     `json:"layout"`
	Filters       map[string]json.RawMessage `json:"filters"`
	Fields        []string                   `json:"fields"`
	CalendarBasis string                     `json:"calendarBasis,omitempty"`
}
type WorkView struct {
	ID          string             `json:"id"`
	Name        string             `json:"name"`
	Visibility  string             `json:"visibility"`
	OwnerUserID string             `json:"ownerUserId"`
	Definition  WorkViewDefinition `json:"definition"`
	Revision    string             `json:"revision"`
	CreatedAt   string             `json:"createdAt"`
	UpdatedAt   string             `json:"updatedAt"`
	CanEdit     bool               `json:"canEdit"`
	createHash  string
}

func validateWorkViewDefinition(r *Request, in *WorkViewDefinition) error {
	if in.Layout != "board" && in.Layout != "list" && in.Layout != "calendar" {
		return invalid("layout must be board, list or calendar.")
	}
	if in.CalendarBasis != "" && in.CalendarBasis != "businessDate" && in.CalendarBasis != "dueAt" {
		return invalid("Invalid calendarBasis.")
	}
	if len(in.Fields) > len(workViewFields) {
		return invalid("Too many view fields.")
	}
	seen := map[string]bool{}
	for _, v := range in.Fields {
		if !workViewFields[v] || seen[v] {
			return invalid("View fields must be unique supported fields.")
		}
		seen[v] = true
	}
	if in.Fields == nil {
		in.Fields = []string{}
	}
	if in.Filters == nil {
		in.Filters = map[string]json.RawMessage{}
	}
	for k, v := range in.Filters {
		if !workViewFilters[k] || string(v) == "null" {
			return invalid("Unsupported view filter: " + k)
		}
	}
	clone := *r
	clone.Input = json.RawMessage(jsonString(in.Filters))
	_, err := readWorkFilter(&clone)
	return err
}
func scanWorkView(row interface{ Scan(...any) error }) (*WorkView, error) {
	v := &WorkView{}
	var body string
	var revision int64
	err := row.Scan(&v.ID, &v.Name, &v.Visibility, &v.OwnerUserID, &body, &revision, &v.CreatedAt, &v.UpdatedAt, &v.createHash)
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal([]byte(body), &v.Definition); err != nil {
		return nil, err
	}
	v.Revision = strconv.FormatInt(revision, 10)
	return v, nil
}

const workViewColumns = "id,name,visibility,owner_user_id,definition_json,revision,created_at,updated_at,create_hash"

func (a *App) loadWorkView(r *Request, space, id string) (*WorkView, error) {
	if !validID(id) {
		return nil, missing()
	}
	v, err := scanWorkView(r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+workViewColumns+" FROM work_views WHERE space_id=? AND id=? AND (visibility='shared' OR owner_user_id=?)"), space, id, r.User.ID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, missing()
	}
	if err != nil {
		return nil, err
	}
	v.CanEdit = r.workReads("work:write")
	return v, nil
}
func (a *App) listWorkViews(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	in := struct {
		ID         string `json:"id"`
		Q          string `json:"q"`
		Visibility string `json:"visibility"`
		Limit      int    `json:"limit"`
		Cursor     string `json:"cursor"`
	}{Limit: 30}
	if r.Input != nil {
		if err = r.decode(&in); err != nil {
			return nil, err
		}
	} else {
		q := r.HTTP.URL.Query()
		in.ID = q.Get("id")
		in.Q = q.Get("q")
		in.Visibility = q.Get("visibility")
		in.Cursor = q.Get("cursor")
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
	if in.Limit < 1 || in.Limit > 100 || len(in.Cursor) > 2048 || len(in.Q) > 200 {
		return nil, invalid("Invalid views page.")
	}
	if in.ID != "" && !validID(in.ID) {
		return nil, invalid("Invalid view ID.")
	}
	if in.Visibility != "" && in.Visibility != "private" && in.Visibility != "shared" {
		return nil, invalid("Invalid visibility.")
	}
	revision, err := a.workMetadataRevision(r, s.ID, "views_revision")
	if err != nil {
		return nil, err
	}
	fingerprint := workPayloadHash([]string{s.ID, r.User.ID, in.Q, in.Visibility, in.ID})
	where := "space_id=? AND (visibility='shared' OR owner_user_id=?)"
	args := []any{s.ID, r.User.ID}
	if in.ID != "" {
		where += " AND id=?"
		args = append(args, in.ID)
	}
	if in.Visibility != "" {
		where += " AND visibility=?"
		args = append(args, in.Visibility)
	}
	if in.Q != "" {
		where += " AND LOWER(name) LIKE ? ESCAPE '\\'"
		args = append(args, workLike(in.Q))
	}
	var total int
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_views WHERE "+where), args...).Scan(&total); err != nil {
		return nil, err
	}
	if in.Cursor != "" {
		c, err := decodeWorkSimpleCursor(in.Cursor, fingerprint, revision)
		if err != nil {
			return nil, err
		}
		where += " AND id>?"
		args = append(args, c.ID)
	}
	args = append(args, in.Limit+1)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+workViewColumns+" FROM work_views WHERE "+where+" ORDER BY id LIMIT ?"), args...)
	if err != nil {
		return nil, err
	}
	items := []WorkView{}
	for rows.Next() {
		v, err := scanWorkView(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		v.CanEdit = s.CanEdit
		items = append(items, *v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	var next *string
	if len(items) > in.Limit {
		items = items[:in.Limit]
		v := encodeWorkCursor(workSimpleCursor{Filter: fingerprint, Revision: revision, ID: items[len(items)-1].ID})
		next = &v
	}
	return ok(map[string]any{"items": items, "revision": revision, "canEdit": s.CanEdit, "total": total, "nextCursor": next}), nil
}
func (a *App) createWorkView(r *Request) (*Response, error) { return a.writeWorkView(r, true) }
func (a *App) updateWorkView(r *Request) (*Response, error) { return a.writeWorkView(r, false) }
func (a *App) writeWorkView(r *Request, create bool) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	v := &WorkView{Visibility: "private", OwnerUserID: r.User.ID}
	var raw map[string]json.RawMessage
	if err = r.decode(&raw); err != nil {
		return nil, err
	}
	if !create {
		v, err = a.loadWorkView(r, s.ID, r.param("id"))
		if err != nil {
			return nil, err
		}
	}
	allowed := map[string]bool{"name": true, "definition": true, "visibility": true}
	if create {
		allowed["id"] = true
	} else {
		allowed["expectedRevision"] = true
	}
	for k := range raw {
		if !allowed[k] {
			return nil, invalid("Unknown view field: " + k)
		}
	}
	if body, ok := raw["definition"]; ok {
		v.Definition = WorkViewDefinition{}
		if err = decodeScheduleObject(body, &v.Definition); err != nil {
			return nil, err
		}
	}
	var revision string
	for _, f := range []struct {
		name   string
		target any
	}{{"id", &v.ID}, {"name", &v.Name}, {"visibility", &v.Visibility}, {"definition", &v.Definition}, {"expectedRevision", &revision}} {
		if err = workDecodeField(raw, f.name, f.target, false); err != nil {
			return nil, err
		}
	}
	if !create && (revision == "" || revision != v.Revision) {
		return nil, workConflict("work_view_version_conflict", "The saved view changed. Reload it before saving.", v.Revision)
	}
	if !create && len(raw) < 2 {
		return nil, invalid("Provide a view change.")
	}
	if !validID(v.ID) {
		return nil, invalid("id must be a stable ID.")
	}
	v.Name, err = required(v.Name, "name", 80)
	if err != nil {
		return nil, err
	}
	if v.Visibility != "private" && v.Visibility != "shared" {
		return nil, invalid("visibility must be private or shared.")
	}
	if v.Visibility == "private" && v.OwnerUserID != r.User.ID {
		return nil, forbidden()
	}
	if err = validateWorkViewDefinition(r, &v.Definition); err != nil {
		return nil, err
	}
	hash := workPayloadHash([]any{v.Name, v.Visibility, v.Definition})
	if create {
		var existingSpace, owner, previous string
		err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT space_id,owner_user_id,create_hash FROM work_views WHERE id=?"), v.ID).Scan(&existingSpace, &owner, &previous)
		if err == nil {
			if existingSpace != s.ID || owner != r.User.ID || previous != hash {
				return nil, workConflict("work_view_id_conflict", "This ID belongs to another view creation intent.", "")
			}
			return a.workViewReply(r, s.ID, v.ID)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}
	stamp := workStamp()
	if create {
		_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_views(id,space_id,owner_user_id,name,visibility,definition_json,created_at,updated_at,create_hash) VALUES(?,?,?,?,?,?,?,?,?)"), v.ID, s.ID, r.User.ID, v.Name, v.Visibility, jsonString(v.Definition), stamp, stamp, hash)
	} else {
		_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_views SET name=?,visibility=?,definition_json=?,revision=revision+1,updated_at=? WHERE space_id=? AND id=?"), v.Name, v.Visibility, jsonString(v.Definition), stamp, s.ID, v.ID)
	}
	if err != nil {
		return nil, err
	}
	if err = a.bumpWorkMetadata(r, s.ID, "views_revision"); err != nil {
		return nil, err
	}
	return a.workViewReply(r, s.ID, v.ID)
}
func (a *App) workViewReply(r *Request, space, id string) (*Response, error) {
	v, err := a.loadWorkView(r, space, id)
	if err != nil {
		return nil, err
	}
	if !r.workReads("work:read") {
		return ok(map[string]string{"id": id, "revision": v.Revision}), nil
	}
	return ok(v), nil
}
func (a *App) deleteWorkView(r *Request) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	v, err := a.loadWorkView(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var in struct {
		ExpectedRevision string `json:"expectedRevision"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if in.ExpectedRevision == "" || in.ExpectedRevision != v.Revision {
		return nil, workConflict("work_view_version_conflict", "The saved view changed. Reload it before deleting.", v.Revision)
	}
	if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM work_views WHERE id=? AND space_id=?"), v.ID, s.ID); err != nil {
		return nil, err
	}
	if err = a.bumpWorkMetadata(r, s.ID, "views_revision"); err != nil {
		return nil, err
	}
	return ok(map[string]any{"id": v.ID, "deleted": true}), nil
}
