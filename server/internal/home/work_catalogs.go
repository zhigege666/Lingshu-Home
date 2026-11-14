package home

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"
)

func (a *App) registerWorkPlanningRoutes(base string) {
	a.route("GET "+base+"/labels", false, a.listWorkLabels)
	a.route("POST "+base+"/labels", true, a.createWorkLabel)
	a.route("PATCH "+base+"/labels/{id}", true, a.updateWorkLabel)
	a.route("GET "+base+"/versions", false, a.listWorkVersions)
	a.route("POST "+base+"/versions", true, a.createWorkVersion)
	a.route("PATCH "+base+"/versions/{id}", true, a.updateWorkVersion)
	a.route("GET "+base+"/assignees", false, a.listWorkAssignees)
	a.route("GET "+base+"/items/{id}/relations", false, a.getWorkRelations)
	a.route("PATCH "+base+"/items/{id}/relations", true, a.updateWorkRelations)
	a.route("GET "+base+"/views", false, a.listWorkViews)
	a.route("POST "+base+"/views", true, a.createWorkView)
	a.route("PATCH "+base+"/views/{id}", true, a.updateWorkView)
	a.route("DELETE "+base+"/views/{id}", true, a.deleteWorkView)
	a.route("GET "+base+"/calendar", false, a.getWorkCalendar)
	a.route("GET "+base+"/stats", false, a.getWorkStats)
	a.route("GET "+base+"/notifications/settings", false, a.getWorkNoticeSettings)
	a.route("PATCH "+base+"/notifications/settings", true, a.updateWorkNoticeSettings)
	a.route("GET "+base+"/notifications", false, a.listWorkNotices)
	a.route("GET "+base+"/notifications/summary", false, a.summarizeWorkNotices)
	a.route("POST "+base+"/notifications/read", true, a.readWorkNotices)
}

type workCatalogFilter struct {
	Q         string   `json:"q"`
	Archived  *bool    `json:"archived"`
	ProjectID string   `json:"projectId"`
	IDs       []string `json:"ids"`
	Limit     int      `json:"limit"`
	Cursor    string   `json:"cursor"`
}
type workSimpleCursor struct {
	Filter   string `json:"f"`
	Revision string `json:"r"`
	ID       string `json:"i"`
	At       string `json:"a,omitempty"`
}

func encodeWorkCursor(value any) string {
	body, _ := json.Marshal(value)
	return base64.RawURLEncoding.EncodeToString(body)
}
func decodeWorkSimpleCursor(value, filter, revision string) (workSimpleCursor, error) {
	var c workSimpleCursor
	b, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || json.Unmarshal(b, &c) != nil || c.Filter != filter || !validID(c.ID) {
		return c, invalid("Invalid cursor for these filters.")
	}
	if revision != "" && c.Revision != revision {
		return c, workConflict("work_metadata_version_conflict", "This collection changed. Refresh its first page.", revision)
	}
	return c, nil
}
func (a *App) workMetadataRevision(r *Request, space, column string) (string, error) {
	var revision int64
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+column+" FROM work_spaces WHERE space_id=?"), space).Scan(&revision)
	return strconv.FormatInt(revision, 10), err
}
func (a *App) bumpWorkMetadata(r *Request, space, column string) error {
	_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_spaces SET "+column+"="+column+"+1 WHERE space_id=?"), space)
	return err
}
func (a *App) listWorkLabels(r *Request) (*Response, error) { return a.listWorkCatalog(r, "labels") }
func (a *App) listWorkVersions(r *Request) (*Response, error) {
	return a.listWorkCatalog(r, "versions")
}
func (a *App) createWorkLabel(r *Request) (*Response, error) {
	return a.writeWorkCatalog(r, "labels", true)
}
func (a *App) updateWorkLabel(r *Request) (*Response, error) {
	return a.writeWorkCatalog(r, "labels", false)
}
func (a *App) createWorkVersion(r *Request) (*Response, error) {
	return a.writeWorkCatalog(r, "versions", true)
}
func (a *App) updateWorkVersion(r *Request) (*Response, error) {
	return a.writeWorkCatalog(r, "versions", false)
}
func (a *App) listWorkCatalog(r *Request, kind string) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	in := workCatalogFilter{Limit: 30}
	if r.Input != nil {
		if err = r.decode(&in); err != nil {
			return nil, err
		}
	} else {
		q := r.HTTP.URL.Query()
		in.Q = q.Get("q")
		in.ProjectID = q.Get("projectId")
		in.IDs = q["ids"]
		in.Cursor = q.Get("cursor")
		if v := q.Get("limit"); v != "" {
			in.Limit, err = strconv.Atoi(v)
			if err != nil {
				return nil, invalid("Invalid limit.")
			}
		}
		if v := q.Get("archived"); v != "" {
			if v != "true" && v != "false" {
				return nil, invalid("archived must be true or false.")
			}
			b := v == "true"
			in.Archived = &b
		}
	}
	if in.Limit == 0 {
		in.Limit = 30
	}
	in.Q = strings.TrimSpace(in.Q)
	if in.Limit < 1 || in.Limit > 100 || len(in.IDs) > 100 || len(in.Cursor) > 2048 {
		return nil, invalid("Use limit 1–100, at most 100 IDs and a bounded cursor.")
	}
	if err = bounded(in.Q, "q", 200); err != nil {
		return nil, err
	}
	if in.ProjectID != "" && (kind != "versions" || in.ProjectID != "none" && !validID(in.ProjectID)) {
		return nil, invalid("Invalid projectId filter.")
	}
	if len(in.IDs) > 0 && in.Cursor != "" {
		return nil, invalid("Batch IDs cannot be combined with a cursor.")
	}
	revision, err := a.workMetadataRevision(r, s.ID, "planning_revision")
	if err != nil {
		return nil, err
	}
	fingerprint := workPayloadHash([]any{s.ID, kind, in.Q, in.Archived, in.ProjectID, in.IDs})
	where := "space_id=?"
	args := []any{s.ID}
	if in.Archived != nil {
		where += " AND archived=?"
		args = append(args, *in.Archived)
	}
	if in.Q != "" {
		where += " AND LOWER(name) LIKE ? ESCAPE '\\'"
		args = append(args, workLike(in.Q))
	}
	if in.ProjectID == "none" {
		where += " AND project_id IS NULL"
	} else if in.ProjectID != "" {
		where += " AND (project_id IS NULL OR project_id=?)"
		args = append(args, in.ProjectID)
	}
	if len(in.IDs) > 0 {
		seen := map[string]bool{}
		for _, id := range in.IDs {
			if !validID(id) || seen[id] {
				return nil, invalid("ids must contain unique valid IDs.")
			}
			seen[id] = true
		}
		slots, values := workPlaceholders(in.IDs)
		where += " AND id IN (" + slots + ")"
		args = append(args, values...)
		in.Limit = 100
	}
	var total int
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_"+kind+" WHERE "+where), args...).Scan(&total); err != nil {
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
	columns := "id,name,color,archived,revision"
	if kind == "versions" {
		columns = "id,name,project_id,target_date,description,archived,revision"
	}
	args = append(args, in.Limit+1)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+columns+" FROM work_"+kind+" WHERE "+where+" ORDER BY id LIMIT ?"), args...)
	if err != nil {
		return nil, err
	}
	items := []any{}
	ids := []string{}
	for rows.Next() {
		if kind == "labels" {
			var v WorkLabel
			var rev int64
			err = rows.Scan(&v.ID, &v.Name, &v.Color, &v.Archived, &rev)
			v.Revision = strconv.FormatInt(rev, 10)
			items = append(items, v)
			ids = append(ids, v.ID)
		} else {
			v, e := scanWorkVersion(rows)
			err = e
			if err == nil {
				items = append(items, *v)
				ids = append(ids, v.ID)
			}
		}
		if err != nil {
			rows.Close()
			return nil, err
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	var next *string
	if len(items) > in.Limit {
		items = items[:in.Limit]
		v := encodeWorkCursor(workSimpleCursor{Filter: fingerprint, Revision: revision, ID: ids[in.Limit-1]})
		next = &v
	}
	result := map[string]any{"items": items, "revision": revision, "canEdit": s.CanEdit, "total": total, "nextCursor": next}
	if len(in.IDs) > 0 {
		found := map[string]bool{}
		for _, id := range ids {
			found[id] = true
		}
		missingIDs := []string{}
		for _, id := range in.IDs {
			if !found[id] {
				missingIDs = append(missingIDs, id)
			}
		}
		result["missingIds"] = missingIDs
	}
	return ok(result), nil
}

type workCatalogValue struct {
	ID               string  `json:"id"`
	Name             string  `json:"name"`
	Color            string  `json:"color,omitempty"`
	ProjectID        *string `json:"projectId,omitempty"`
	TargetDate       string  `json:"targetDate,omitempty"`
	Description      string  `json:"description,omitempty"`
	Archived         bool    `json:"archived"`
	ExpectedRevision string  `json:"expectedRevision,omitempty"`
}

func (a *App) writeWorkCatalog(r *Request, kind string, create bool) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	var raw map[string]json.RawMessage
	if err = r.decode(&raw); err != nil {
		return nil, err
	}
	allowed := map[string]bool{"name": true}
	if create {
		allowed["id"] = true
	} else {
		allowed["expectedRevision"] = true
		allowed["archived"] = true
	}
	if kind == "labels" {
		allowed["color"] = true
	} else {
		allowed["projectId"] = true
		allowed["targetDate"] = true
		allowed["description"] = true
	}
	for k := range raw {
		if !allowed[k] {
			return nil, invalid("Unknown catalog field: " + k)
		}
	}
	value := workCatalogValue{}
	var oldProject *string
	var oldRevision int64
	var oldHash string
	if !create {
		value.ID = r.param("id")
		if !validID(value.ID) {
			return nil, missing()
		}
		columns := "name,color,archived,revision,create_hash"
		targets := []any{&value.Name, &value.Color, &value.Archived, &oldRevision, &oldHash}
		var project sql.NullString
		if kind == "versions" {
			columns = "name,project_id,target_date,description,archived,revision,create_hash"
			targets = []any{&value.Name, &project, &value.TargetDate, &value.Description, &value.Archived, &oldRevision, &oldHash}
		}
		err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+columns+" FROM work_"+kind+" WHERE space_id=? AND id=?"), s.ID, value.ID).Scan(targets...)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, missing()
		}
		if err != nil {
			return nil, err
		}
		if project.Valid {
			value.ProjectID = &project.String
		}
		oldProject = workStringPointerCopy(value.ProjectID)
	}
	for _, field := range []struct {
		name     string
		target   any
		nullable bool
	}{{"id", &value.ID, false}, {"name", &value.Name, false}, {"color", &value.Color, false}, {"projectId", &value.ProjectID, true}, {"targetDate", &value.TargetDate, false}, {"description", &value.Description, false}, {"archived", &value.Archived, false}, {"expectedRevision", &value.ExpectedRevision, false}} {
		if err = workDecodeField(raw, field.name, field.target, field.nullable); err != nil {
			return nil, err
		}
	}
	if !validID(value.ID) {
		return nil, invalid("id must be a stable ID.")
	}
	value.Name, err = required(value.Name, "name", 80)
	if err != nil {
		return nil, err
	}
	if !create && (value.ExpectedRevision == "" || value.ExpectedRevision != strconv.FormatInt(oldRevision, 10)) {
		return nil, workConflict("work_metadata_version_conflict", "The entry changed. Reload it before saving.", strconv.FormatInt(oldRevision, 10))
	}
	if !create && len(raw) < 2 {
		return nil, invalid("Provide a changed field.")
	}
	if kind == "labels" {
		if create && value.Color == "" {
			value.Color = "#5596bc"
		}
		if !workStatusColor.MatchString(value.Color) {
			return nil, invalid("color must be #RRGGBB.")
		}
		value.Color = strings.ToLower(value.Color)
	} else {
		if value.ProjectID != nil && !validID(*value.ProjectID) {
			return nil, invalid("Invalid projectId.")
		}
		if value.TargetDate != "" && !validWorkDate(value.TargetDate) {
			return nil, invalid("targetDate must be an actual YYYY-MM-DD date.")
		}
		if err = bounded(value.Description, "description", 1000); err != nil {
			return nil, err
		}
	}
	hash := workPayloadHash(value)
	if create {
		var existingSpace string
		err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT space_id,create_hash,revision FROM work_"+kind+" WHERE id=?"), value.ID).Scan(&existingSpace, &oldHash, &oldRevision)
		if err == nil {
			if existingSpace != s.ID || hash != oldHash {
				return nil, workConflict("work_metadata_id_conflict", "This ID belongs to another creation intent.", "")
			}
			return a.workCatalogReply(r, s.ID, kind, value.ID, true)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}
	if kind == "versions" && (create || !reflect.DeepEqual(oldProject, value.ProjectID)) {
		if err = a.validateWorkProject(r, s.ID, value.ProjectID); err != nil {
			return nil, err
		}
		if !create && value.ProjectID != nil {
			var count int
			err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_items WHERE space_id=? AND version_id<>'' AND version_id=? AND (project_id IS NULL OR project_id<>?)"), s.ID, value.ID, *value.ProjectID).Scan(&count)
			if err != nil {
				return nil, err
			}
			if count > 0 {
				return nil, workConflict("work_version_project_conflict", "Existing items would become incompatible with this project's version.", "")
			}
			if err = a.validateWorkTemplateVersionProject(r, s.ID, value.ID, *value.ProjectID); err != nil {
				return nil, err
			}
		}
	}
	var duplicate int
	err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_"+kind+" WHERE space_id=? AND name_key=? AND id<>?"), s.ID, strings.ToLower(value.Name), value.ID).Scan(&duplicate)
	if err != nil {
		return nil, err
	}
	if duplicate > 0 {
		return nil, workConflict("work_metadata_name_conflict", "An entry with this name already exists, including archived entries.", "")
	}
	stamp := workStamp()
	if create {
		if kind == "labels" {
			_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_labels(id,space_id,name,name_key,color,created_at,updated_at,create_hash) VALUES(?,?,?,?,?,?,?,?)"), value.ID, s.ID, value.Name, strings.ToLower(value.Name), value.Color, stamp, stamp, hash)
		} else {
			_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_versions(id,space_id,name,name_key,project_id,target_date,description,created_at,updated_at,create_hash) VALUES(?,?,?,?,?,?,?,?,?,?)"), value.ID, s.ID, value.Name, strings.ToLower(value.Name), value.ProjectID, value.TargetDate, value.Description, stamp, stamp, hash)
		}
	} else {
		if kind == "labels" {
			_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_labels SET name=?,name_key=?,color=?,archived=?,revision=revision+1,updated_at=? WHERE id=? AND space_id=?"), value.Name, strings.ToLower(value.Name), value.Color, value.Archived, stamp, value.ID, s.ID)
		} else {
			_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_versions SET name=?,name_key=?,project_id=?,target_date=?,description=?,archived=?,revision=revision+1,updated_at=? WHERE id=? AND space_id=?"), value.Name, strings.ToLower(value.Name), value.ProjectID, value.TargetDate, value.Description, value.Archived, stamp, value.ID, s.ID)
		}
	}
	if err != nil {
		return nil, err
	}
	if err = a.bumpWorkMetadata(r, s.ID, "planning_revision"); err != nil {
		return nil, err
	}
	return a.workCatalogReply(r, s.ID, kind, value.ID, false)
}
func (a *App) workCatalogReply(r *Request, space, kind, id string, replayed bool) (*Response, error) {
	if kind == "labels" {
		var v WorkLabel
		var revision int64
		err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT id,name,color,archived,revision FROM work_labels WHERE space_id=? AND id=?"), space, id).Scan(&v.ID, &v.Name, &v.Color, &v.Archived, &revision)
		if err != nil {
			return nil, err
		}
		v.Revision = strconv.FormatInt(revision, 10)
		if !r.workReads("work:read") {
			return ok(map[string]any{"id": id, "revision": v.Revision, "replayed": replayed}), nil
		}
		return ok(v), nil
	}
	v, err := scanWorkVersion(r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT id,name,project_id,target_date,description,archived,revision FROM work_versions WHERE space_id=? AND id=?"), space, id))
	if err != nil {
		return nil, err
	}
	if !r.workReads("work:read") {
		return ok(map[string]any{"id": id, "revision": v.Revision, "replayed": replayed}), nil
	}
	return ok(v), nil
}
func (a *App) validateWorkTemplateVersionProject(r *Request, space, version, project string) error {
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT template_json FROM work_schedules WHERE space_id=? AND template_json LIKE ? UNION ALL SELECT template_json FROM work_automation_rules WHERE space_id=? AND template_json LIKE ?"), space, "%"+version+"%", space, "%"+version+"%")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			return err
		}
		var template WorkScheduleTemplate
		if err = json.Unmarshal([]byte(raw), &template); err != nil {
			return err
		}
		if template.VersionID != nil && *template.VersionID == version && (template.ProjectID == nil || *template.ProjectID != project) {
			return workConflict("work_version_project_conflict", "A saved work template would become incompatible with this project.", "")
		}
	}
	return rows.Err()
}
func (a *App) listWorkAssignees(r *Request) (*Response, error) {
	_, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	in := struct {
		Q      string `json:"q"`
		Limit  int    `json:"limit"`
		Cursor string `json:"cursor"`
	}{Limit: 20}
	if r.Input != nil {
		if err = r.decode(&in); err != nil {
			return nil, err
		}
	} else {
		q := r.HTTP.URL.Query()
		in.Q = q.Get("q")
		in.Cursor = q.Get("cursor")
		if v := q.Get("limit"); v != "" {
			in.Limit, err = strconv.Atoi(v)
			if err != nil {
				return nil, invalid("Invalid limit.")
			}
		}
	}
	if in.Limit == 0 {
		in.Limit = 20
	}
	if in.Limit < 1 || in.Limit > 50 || len(in.Q) > 200 || len(in.Cursor) > 2048 {
		return nil, invalid("Invalid assignee page.")
	}
	where := "is_enabled=?"
	args := []any{true}
	if r.User.Role != "Owner" {
		where += " AND id=?"
		args = append(args, r.User.ID)
	}
	if in.Q != "" {
		where += " AND (LOWER(display_name) LIKE ? ESCAPE '\\' OR LOWER(username) LIKE ? ESCAPE '\\')"
		args = append(args, workLike(in.Q), workLike(in.Q))
	}
	fingerprint := workPayloadHash([]string{r.User.ID, in.Q})
	if in.Cursor != "" {
		c, err := decodeWorkSimpleCursor(in.Cursor, fingerprint, "")
		if err != nil {
			return nil, err
		}
		where += " AND id>?"
		args = append(args, c.ID)
	}
	args = append(args, in.Limit+1)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id,CASE WHEN display_name='' THEN username ELSE display_name END FROM users WHERE "+where+" ORDER BY id LIMIT ?"), args...)
	if err != nil {
		return nil, err
	}
	items := []map[string]string{}
	for rows.Next() {
		var id, name string
		if err = rows.Scan(&id, &name); err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, map[string]string{"id": id, "name": name})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	var next *string
	if len(items) > in.Limit {
		items = items[:in.Limit]
		v := encodeWorkCursor(workSimpleCursor{Filter: fingerprint, ID: items[len(items)-1]["id"]})
		next = &v
	}
	return ok(map[string]any{"items": items, "nextCursor": next}), nil
}
