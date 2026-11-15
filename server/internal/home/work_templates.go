package home

import (
	"encoding/json"
	"reflect"
	"strings"
)

func decodeWorkTemplatePatch(raw json.RawMessage, previous WorkScheduleTemplate) (WorkScheduleTemplate, error) {
	previous.WorkPlanningFields = cloneWorkPlanningFields(previous.WorkPlanningFields)
	value := WorkScheduleTemplate{}
	if err := decodeScheduleObject(raw, &value); err != nil {
		return value, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return value, invalid("Invalid work template.")
	}
	for name, body := range fields {
		if string(body) == "null" && name != "projectId" && name != "assignee" && name != "versionId" {
			return value, invalid(name + " cannot be null.")
		}
	}
	if _, ok := fields["bookmarkIds"]; !ok {
		value.BookmarkIDs = previous.BookmarkIDs
	}
	if _, ok := fields["documentIds"]; !ok {
		value.DocumentIDs = previous.DocumentIDs
	}
	if _, ok := fields["priority"]; !ok {
		value.Priority = previous.Priority
	}
	if _, ok := fields["labelIds"]; !ok {
		value.LabelIDs = previous.LabelIDs
	}
	if _, ok := fields["assignee"]; !ok {
		value.Assignee = previous.Assignee
	}
	if _, ok := fields["versionId"]; !ok {
		value.VersionID = previous.VersionID
	}
	return value, nil
}
func (a *App) normalizeWorkTemplate(r *Request, spaceID string, value *WorkScheduleTemplate, previous *WorkScheduleTemplate) error {
	in := value.workInput()
	if err := validateWorkText(&in); err != nil {
		return err
	}
	value.Title = in.Title
	value.WorkPlanningFields = in.WorkPlanningFields
	var err error
	value.BookmarkIDs, err = workIDs(value.BookmarkIDs)
	if err != nil {
		return err
	}
	value.DocumentIDs, err = workIDs(value.DocumentIDs)
	if err != nil {
		return err
	}
	if value.Status == "" {
		catalog, err := a.loadWorkStatuses(r, spaceID, false)
		if err != nil {
			return err
		}
		value.Status = catalog.DefaultStatus
	}
	if previous == nil || value.Status != previous.Status {
		if _, err = a.requireWorkStatus(r, spaceID, value.Status); err != nil {
			return err
		}
	}
	if previous == nil || !reflect.DeepEqual(value.ProjectID, previous.ProjectID) {
		if err = a.validateWorkProject(r, spaceID, value.ProjectID); err != nil {
			return err
		}
	}
	var oldPlanning *WorkPlanningFields
	var oldProject *string
	var oldLinks, oldDocs []string
	if previous != nil {
		oldPlanning = &previous.WorkPlanningFields
		oldProject = previous.ProjectID
		oldLinks = previous.BookmarkIDs
		oldDocs = previous.DocumentIDs
	}
	if err = a.validateWorkPlanning(r, spaceID, &value.WorkPlanningFields, value.ProjectID, oldPlanning, oldProject); err != nil {
		return err
	}
	for _, refs := range []struct {
		kind     string
		ids, old []string
	}{{"bookmark", value.BookmarkIDs, oldLinks}, {"document", value.DocumentIDs, oldDocs}} {
		if reflect.DeepEqual(refs.ids, refs.old) || len(refs.ids) == 0 && previous == nil {
			continue
		}
		if err = a.validateWorkRefs(r, spaceID, "", refs.kind, refs.ids); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) workTemplateReferences(r *Request, spaceID string, value *WorkScheduleTemplate) ([]WorkReference, error) {
	references := []WorkReference{}
	for _, kind := range []string{"bookmark", "document"} {
		action, ids := "navigation:read", value.BookmarkIDs
		if kind == "document" {
			action, ids = "documents:read", value.DocumentIDs
		}
		if !r.workReads(action) {
			if kind == "document" {
				value.DocumentIDs = []string{}
			} else {
				value.BookmarkIDs = []string{}
			}
			continue
		}
		if len(ids) == 0 {
			continue
		}
		marks := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
		args := []any{spaceID}
		for _, id := range ids {
			args = append(args, id)
		}
		query := "SELECT id,title,url FROM links WHERE space_id=? AND id IN (" + marks + ")"
		if kind == "document" {
			query = "SELECT d.id,d.title,d.relative_path,s.enabled,d.status FROM documents d JOIN document_sources s ON s.id=d.source_id WHERE d.space_id=? AND d.id IN (" + marks + ")"
		}
		rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query(query), args...)
		if err != nil {
			return nil, err
		}
		found := map[string]WorkReference{}
		for rows.Next() {
			ref := WorkReference{Kind: kind, Available: true}
			if kind == "document" {
				var enabled bool
				var status string
				err = rows.Scan(&ref.ID, &ref.Title, &ref.Subtitle, &enabled, &status)
				ref.Available = enabled && status == "ready"
			} else {
				err = rows.Scan(&ref.ID, &ref.Title, &ref.URL)
			}
			if err != nil {
				rows.Close()
				return nil, err
			}
			found[ref.ID] = ref
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			ref, exists := found[id]
			if !exists {
				ref = WorkReference{Kind: kind, ID: id, Available: false}
			}
			references = append(references, ref)
		}
	}
	return references, nil
}
