package home

import (
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

type WorkAssignee struct {
	Name   string `json:"name"`
	UserID string `json:"userId,omitempty"`
}
type WorkPlanningFields struct {
	Priority  string        `json:"priority,omitempty"`
	LabelIDs  []string      `json:"labelIds,omitempty"`
	Assignee  *WorkAssignee `json:"assignee,omitempty"`
	VersionID *string       `json:"versionId,omitempty"`
}

func workStringPointerCopy(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
func cloneWorkPlanningFields(value WorkPlanningFields) WorkPlanningFields {
	value.LabelIDs = append([]string{}, value.LabelIDs...)
	value.VersionID = workStringPointerCopy(value.VersionID)
	if value.Assignee != nil {
		copy := *value.Assignee
		value.Assignee = &copy
	}
	return value
}

type WorkLabel struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Color    string `json:"color"`
	Archived bool   `json:"archived"`
	Revision string `json:"revision"`
}
type WorkVersion struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	ProjectID   *string `json:"projectId"`
	TargetDate  string  `json:"targetDate,omitempty"`
	Description string  `json:"description"`
	Archived    bool    `json:"archived"`
	Revision    string  `json:"revision"`
}
type workIDsScanner struct{ ids *[]string }

func (s workIDsScanner) Scan(value any) error {
	var body []byte
	switch v := value.(type) {
	case string:
		body = []byte(v)
	case []byte:
		body = v
	default:
		return errors.New("invalid stored work label list")
	}
	return json.Unmarshal(body, s.ids)
}
func workKeyNumber(ref string) (int64, bool) {
	if !strings.HasPrefix(ref, "W-") {
		return 0, false
	}
	n, err := strconv.ParseInt(strings.TrimPrefix(ref, "W-"), 10, 64)
	return n, err == nil && n > 0 && ref == "W-"+strconv.FormatInt(n, 10)
}
func workItemRefValid(ref string) bool {
	if validID(ref) {
		return true
	}
	_, ok := workKeyNumber(ref)
	return ok
}
func (a *App) resolveWorkItemRef(r *Request, space, ref string) (string, error) {
	if validID(ref) {
		return ref, nil
	}
	n, ok := workKeyNumber(ref)
	if !ok {
		return "", missing()
	}
	var id string
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT id FROM work_items WHERE space_id=? AND number>0 AND number=?"), space, n).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", missing()
	}
	return id, err
}
func normalizeWorkPlanning(in *WorkPlanningFields) error {
	switch in.Priority {
	case "", "low", "normal", "high", "urgent":
	default:
		return invalid("priority must be low, normal, high, urgent or empty.")
	}
	if len(in.LabelIDs) > 20 {
		return invalid("Use at most 20 labels.")
	}
	ids, err := workIDs(in.LabelIDs)
	if err != nil {
		return err
	}
	in.LabelIDs = ids
	if in.VersionID != nil && !validID(*in.VersionID) {
		return invalid("versionId must be an ID or null.")
	}
	if in.Assignee != nil {
		name, err := required(in.Assignee.Name, "assignee.name", 80)
		if err != nil {
			return err
		}
		in.Assignee.Name = name
		if in.Assignee.UserID != "" && !validID(in.Assignee.UserID) {
			return invalid("assignee.userId must be an existing account ID.")
		}
	}
	return nil
}
func (a *App) validateWorkPlanning(r *Request, space string, in *WorkPlanningFields, project *string, old *WorkPlanningFields, oldProject *string) error {
	if err := normalizeWorkPlanning(in); err != nil {
		return err
	}
	previous := map[string]bool{}
	if old != nil {
		for _, id := range old.LabelIDs {
			previous[id] = true
		}
	}
	for _, id := range in.LabelIDs {
		if previous[id] {
			continue
		}
		var archived bool
		err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT archived FROM work_labels WHERE space_id=? AND id=?"), space, id).Scan(&archived)
		if errors.Is(err, sql.ErrNoRows) {
			return missing()
		}
		if err != nil {
			return err
		}
		if archived {
			return workConflict("work_label_archived", "Restore this label before assigning it.", "")
		}
	}
	if in.VersionID != nil && (old == nil || !reflect.DeepEqual(in.VersionID, old.VersionID) || !reflect.DeepEqual(project, oldProject)) {
		var versionProject sql.NullString
		var archived bool
		err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT project_id,archived FROM work_versions WHERE space_id=? AND id=?"), space, *in.VersionID).Scan(&versionProject, &archived)
		if errors.Is(err, sql.ErrNoRows) {
			return missing()
		}
		if err != nil {
			return err
		}
		if archived && (old == nil || !reflect.DeepEqual(in.VersionID, old.VersionID)) {
			return workConflict("work_version_archived", "Restore this target version before assigning it.", "")
		}
		if versionProject.Valid && (project == nil || *project != versionProject.String) {
			return workConflict("work_version_project_conflict", "This target version belongs to another project. Select a compatible version or explicitly clear it.", "")
		}
	}
	if in.Assignee != nil && in.Assignee.UserID != "" && (old == nil || !reflect.DeepEqual(in.Assignee, old.Assignee)) {
		if r.User == nil {
			return unauthorized()
		}
		if r.User.Role != "Owner" && in.Assignee.UserID != r.User.ID {
			return forbidden()
		}
		var name, username string
		var enabled bool
		err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT display_name,username,is_enabled FROM users WHERE id=?"), in.Assignee.UserID).Scan(&name, &username, &enabled)
		if errors.Is(err, sql.ErrNoRows) {
			return missing()
		}
		if err != nil {
			return err
		}
		if !enabled {
			return invalid("The selected account is disabled.")
		}
		if name == "" {
			name = username
		}
		in.Assignee.Name = name
	}
	return nil
}
func workAssigneeValues(v *WorkAssignee) (string, string) {
	if v == nil {
		return "", ""
	}
	return v.Name, v.UserID
}
func workOptionalID(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}
func (a *App) replaceWorkLabels(r *Request, space, item string, ids []string) error {
	if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM work_item_labels WHERE item_id=?"), item); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_item_labels(space_id,item_id,label_id) VALUES(?,?,?)"), space, item, id); err != nil {
			return err
		}
	}
	return nil
}
func workSummaryPointers(items []WorkSummary) []*WorkSummary {
	out := make([]*WorkSummary, 0, len(items))
	for i := range items {
		out = append(out, &items[i])
	}
	return out
}
func workPlaceholders(ids []string) (string, []any) {
	slots := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		slots[i] = "?"
		args[i] = id
	}
	return strings.Join(slots, ","), args
}
func (a *App) decorateWorkPlanning(r *Request, space string, items []*WorkSummary, fields []string) error {
	labels, versions := map[string]bool{}, map[string]bool{}
	for _, item := range items {
		for _, id := range item.LabelIDs {
			labels[id] = true
		}
		if item.VersionID != nil {
			versions[*item.VersionID] = true
		}
	}
	if len(labels) > 0 {
		ids := []string{}
		for id := range labels {
			ids = append(ids, id)
		}
		slots, args := workPlaceholders(ids)
		args = append([]any{space}, args...)
		rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id,name,color,archived,revision FROM work_labels WHERE space_id=? AND id IN ("+slots+")"), args...)
		if err != nil {
			return err
		}
		found := map[string]WorkLabel{}
		for rows.Next() {
			var v WorkLabel
			var revision int64
			if err = rows.Scan(&v.ID, &v.Name, &v.Color, &v.Archived, &revision); err != nil {
				rows.Close()
				return err
			}
			v.Revision = strconv.FormatInt(revision, 10)
			found[v.ID] = v
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, item := range items {
			for _, id := range item.LabelIDs {
				if v, ok := found[id]; ok {
					item.Labels = append(item.Labels, v)
				}
			}
		}
	}
	if len(versions) > 0 {
		ids := []string{}
		for id := range versions {
			ids = append(ids, id)
		}
		slots, args := workPlaceholders(ids)
		args = append([]any{space}, args...)
		rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id,name,project_id,target_date,description,archived,revision FROM work_versions WHERE space_id=? AND id IN ("+slots+")"), args...)
		if err != nil {
			return err
		}
		found := map[string]WorkVersion{}
		for rows.Next() {
			v, err := scanWorkVersion(rows)
			if err != nil {
				rows.Close()
				return err
			}
			found[v.ID] = *v
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, item := range items {
			if item.VersionID != nil {
				if v, ok := found[*item.VersionID]; ok {
					copy := v
					item.Version = &copy
				}
			}
		}
	}
	for _, field := range fields {
		if field == "relations" {
			return a.decorateWorkRelations(r, space, items)
		}
	}
	return nil
}
func scanWorkVersion(row interface{ Scan(...any) error }) (*WorkVersion, error) {
	v := &WorkVersion{}
	var project sql.NullString
	var revision int64
	err := row.Scan(&v.ID, &v.Name, &project, &v.TargetDate, &v.Description, &v.Archived, &revision)
	if project.Valid {
		v.ProjectID = &project.String
	}
	v.Revision = strconv.FormatInt(revision, 10)
	return v, err
}
func workPlanningChanges(before, after WorkPlanningFields) []WorkActivityChange {
	result := []WorkActivityChange{}
	for _, v := range []struct {
		field         string
		before, after any
	}{{"priority", before.Priority, after.Priority}, {"labelIds", before.LabelIDs, after.LabelIDs}, {"assignee", before.Assignee, after.Assignee}, {"versionId", before.VersionID, after.VersionID}} {
		if !reflect.DeepEqual(v.before, v.after) {
			result = append(result, WorkActivityChange{Field: v.field, Before: workActivityValue(v.before), After: workActivityValue(v.after)})
		}
	}
	return result
}
func workPlanningFilterValid(in *workFilter, r *Request) error {
	for _, v := range []struct{ name, value string }{{"itemId", in.ItemID}, {"parentId", in.ParentID}} {
		if v.value != "" && v.value != "none" && !workItemRefValid(v.value) {
			return invalid("Invalid " + v.name)
		}
	}
	switch in.Priority {
	case "", "none", "low", "normal", "high", "urgent":
	default:
		return invalid("Invalid priority filter.")
	}
	if in.VersionID != "" && in.VersionID != "none" && !validID(in.VersionID) {
		return invalid("Invalid versionId filter.")
	}
	if in.AssigneeUserID == "me" {
		if r.User == nil {
			return unauthorized()
		}
		in.AssigneeUserID = r.User.ID
	}
	if in.AssigneeUserID != "" && !validID(in.AssigneeUserID) {
		return invalid("Invalid assigneeUserId filter.")
	}
	if len(in.LabelIDs) > 20 {
		return invalid("Use at most 20 label filters.")
	}
	ids, err := workIDs(in.LabelIDs)
	if err != nil {
		return err
	}
	in.LabelIDs = ids
	for _, field := range in.Fields {
		if !workViewFields[field] {
			return invalid("Unknown display field: " + field)
		}
	}
	sort.Strings(in.Fields)
	return nil
}
func (a *App) resolveWorkFilterRefs(r *Request, space string, in *workFilter) error {
	for _, ref := range []*string{&in.ItemID, &in.ParentID} {
		if *ref == "" || *ref == "none" || validID(*ref) {
			continue
		}
		id, err := a.resolveWorkItemRef(r, space, *ref)
		if err != nil {
			var api *APIError
			if errors.As(err, &api) && api.Status == 404 {
				*ref = "00000000000000000000000000000000"
				continue
			}
			return err
		}
		*ref = id
	}
	return nil
}
