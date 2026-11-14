package home

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
)

// Text changes record field names, never previous/current bodies or reference
// titles, URLs and paths. Only structural values have safe before/after values.
type WorkActivityChange struct {
	Field   string          `json:"field"`
	Before  json.RawMessage `json:"before,omitempty"`
	After   json.RawMessage `json:"after,omitempty"`
	Added   int             `json:"added,omitempty"`
	Removed int             `json:"removed,omitempty"`
}

type WorkActivityActor struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type WorkActivityEvent struct {
	ID           string                  `json:"id"`
	Action       string                  `json:"action"`
	OccurredAt   string                  `json:"occurredAt"`
	ItemRevision string                  `json:"itemRevision"`
	Actor        *WorkActivityActor      `json:"actor"`
	Origin       string                  `json:"origin"`
	Changes      []WorkActivityChange    `json:"changes"`
	Session      *WorkSessionAttribution `json:"session,omitempty"`
}

type WorkActivityPage struct {
	ItemID           string              `json:"itemId"`
	Revision         string              `json:"revision"`
	HistoryStartedAt string              `json:"historyStartedAt"`
	HistoryComplete  bool                `json:"historyComplete"`
	Items            []WorkActivityEvent `json:"items"`
	NextCursor       *string             `json:"nextCursor"`
}

type workActivityCursor struct {
	Space    string `json:"s"`
	Item     string `json:"i"`
	Snapshot int64  `json:"r"`
	Before   int64  `json:"b"`
}

type workActivityInput struct {
	Limit  int    `json:"limit"`
	Cursor string `json:"cursor"`
}

// The origin helper reads trusted MCP dispatch context. A bearer HTTP request
// is an API request; its token name/secret is never part of the activity record.
func (a *App) recordWorkActivity(r *Request, space, itemID, action, stamp string, changes []WorkActivityChange) error {
	var actor any
	if r.User != nil {
		actor = r.User.ID
	}
	if changes == nil {
		changes = []WorkActivityChange{}
	}
	body, err := json.Marshal(changes)
	if err != nil {
		return err
	}
	sessionJSON := ""
	if session := workRequestSession(r); session != nil {
		sessionJSON = jsonString(workSessionSnapshot(session))
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_activity(id,item_id,space_id,actor_id,action,origin,occurred_at,item_revision,changes_json,session_json) SELECT ?,id,space_id,?,?,?,?,revision,?,? FROM work_items WHERE id=? AND space_id=?"), newID(), actor, action, documentActivityOrigin(r), stamp, string(body), sessionJSON, itemID, space)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err == nil && n != 1 {
		return missing()
	}
	return err
}

func workActivityValue(value any) json.RawMessage {
	// Only fixed structs, booleans or nil are passed by server code.
	encoded, _ := json.Marshal(value)
	return encoded
}

func workActivityStatus(status *WorkStatusDefinition) any {
	return struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Type string `json:"type"`
	}{status.ID, status.Name, status.Type}
}

func workActivityStatusChange(before, after *WorkStatusDefinition) WorkActivityChange {
	return WorkActivityChange{Field: "status", Before: workActivityValue(workActivityStatus(before)), After: workActivityValue(workActivityStatus(after))}
}

func (a *App) workActivityProject(r *Request, space string, id *string) (json.RawMessage, error) {
	if id == nil {
		return workActivityValue(nil), nil
	}
	project, err := a.workProject(r, space, *id)
	if err != nil {
		return nil, err
	}
	return workActivityValue(struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}{project.ID, project.Name}), nil
}

func workActivityReferences(field string, before, after []string) WorkActivityChange {
	change := WorkActivityChange{Field: field}
	old, current := map[string]bool{}, map[string]bool{}
	for _, id := range before {
		old[id] = true
	}
	for _, id := range after {
		current[id] = true
		if !old[id] {
			change.Added++
		}
	}
	for _, id := range before {
		if !current[id] {
			change.Removed++
		}
	}
	return change
}

func (a *App) workItemChanges(r *Request, before *WorkItem, after workCreateInput, archived, linksSet, docsSet bool) ([]WorkActivityChange, error) {
	changes := []WorkActivityChange{}
	for _, text := range []struct{ field, before, after string }{
		{"title", before.Title, after.Title},
		{"description", before.Description, after.Description},
		{"nextStep", before.NextStep, after.NextStep},
		{"result", before.Result, after.Result},
	} {
		if text.before != text.after {
			changes = append(changes, WorkActivityChange{Field: text.field})
		}
	}
	if before.Status != after.Status {
		oldStatus, err := a.requireWorkStatus(r, before.SpaceID, before.Status)
		if err != nil {
			return nil, err
		}
		newStatus, err := a.requireWorkStatus(r, before.SpaceID, after.Status)
		if err != nil {
			return nil, err
		}
		changes = append(changes, workActivityStatusChange(oldStatus, newStatus))
	}
	if !reflect.DeepEqual(before.ProjectID, after.ProjectID) {
		oldProject, err := a.workActivityProject(r, before.SpaceID, before.ProjectID)
		if err != nil {
			return nil, err
		}
		newProject, err := a.workActivityProject(r, before.SpaceID, after.ProjectID)
		if err != nil {
			return nil, err
		}
		changes = append(changes, WorkActivityChange{Field: "projectId", Before: oldProject, After: newProject})
	}
	for _, flag := range []struct {
		field         string
		before, after bool
	}{{"needsAttention", before.NeedsAttention, after.NeedsAttention}, {"archived", before.Archived, archived}} {
		if flag.before != flag.after {
			changes = append(changes, WorkActivityChange{Field: flag.field, Before: workActivityValue(flag.before), After: workActivityValue(flag.after)})
		}
	}
	for _, refs := range []struct {
		field, kind string
		set         bool
		ids         []string
	}{{"bookmarkIds", "bookmark", linksSet, after.BookmarkIDs}, {"documentIds", "document", docsSet, after.DocumentIDs}} {
		if !refs.set {
			continue
		}
		old, err := a.storedWorkIDs(r, before.ID, refs.kind)
		if err != nil {
			return nil, err
		}
		change := workActivityReferences(refs.field, old, refs.ids)
		if change.Added != 0 || change.Removed != 0 {
			changes = append(changes, change)
		}
	}
	return changes, nil
}

// A semantic status type change already invalidates affected item revisions.
// Capture it as an item change; name/color/description/order-only catalog edits
// do not fan out to unrelated item revisions or produce synthetic history.
func (a *App) recordWorkStatusDefinitionChanges(r *Request, space, stamp string, before, after *WorkStatusDefinition) error {
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id FROM work_items WHERE space_id=? AND status=? ORDER BY id"), space, after.ID)
	if err != nil {
		return err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	changes := []WorkActivityChange{workActivityStatusChange(before, after)}
	for _, id := range ids {
		if err = a.recordWorkActivity(r, space, id, "status_definition", stamp, changes); err != nil {
			return err
		}
	}
	return nil
}

func workActivityVisibleChanges(r *Request, changes []WorkActivityChange) []WorkActivityChange {
	visible := []WorkActivityChange{}
	for _, change := range changes {
		if change.Field == "bookmarkIds" && !r.workReads("navigation:read") || change.Field == "documentIds" && !r.workReads("documents:read") {
			continue
		}
		visible = append(visible, change)
	}
	return visible
}

func validateWorkActivityInput(in workActivityInput) error {
	if in.Limit < 1 || in.Limit > 100 || len(in.Cursor) > 1024 {
		return invalid("Use an activity limit of 1–100 and a bounded cursor.")
	}
	return nil
}

func (a *App) getWorkActivity(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	item, err := a.loadWorkItem(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	in := workActivityInput{Limit: 20}
	q := r.HTTP.URL.Query()
	in.Cursor = q.Get("cursor")
	if values, set := q["limit"]; set {
		if len(values) != 1 {
			return nil, invalid("Use one activity limit.")
		}
		in.Limit, err = strconv.Atoi(values[0])
		if err != nil {
			return nil, invalid("Invalid activity limit.")
		}
	}
	page, err := a.loadWorkActivity(r, item, in)
	return ok(page), err
}

// Detail remains small by default. HTTP and MCP callers can opt into the same
// bounded page without a separate tool or an unbounded item response.
func workDetailActivityInput(r *Request) (*workActivityInput, error) {
	var in struct {
		Limit  *int   `json:"activityLimit"`
		Cursor string `json:"activityCursor"`
	}
	if r.Input != nil {
		if err := r.decode(&in); err != nil {
			return nil, err
		}
	} else {
		q := r.HTTP.URL.Query()
		in.Cursor = q.Get("activityCursor")
		if values, set := q["activityLimit"]; set {
			if len(values) != 1 {
				return nil, invalid("Use one activity limit.")
			}
			limit, err := strconv.Atoi(values[0])
			if err != nil {
				return nil, invalid("Invalid activity limit.")
			}
			in.Limit = &limit
		}
	}
	if in.Limit == nil && in.Cursor == "" {
		return nil, nil
	}
	page := &workActivityInput{Limit: 20, Cursor: in.Cursor}
	if in.Limit != nil {
		page.Limit = *in.Limit
	}
	return page, validateWorkActivityInput(*page)
}

func (a *App) loadWorkActivity(r *Request, item *WorkItem, in workActivityInput) (*WorkActivityPage, error) {
	if err := validateWorkActivityInput(in); err != nil {
		return nil, err
	}
	current, err := strconv.ParseInt(item.Revision, 10, 64)
	if err != nil {
		return nil, err
	}
	cursor := workActivityCursor{Space: item.SpaceID, Item: item.ID, Snapshot: current}
	if in.Cursor != "" {
		body, decodeErr := base64.RawURLEncoding.DecodeString(in.Cursor)
		if decodeErr != nil || json.Unmarshal(body, &cursor) != nil || cursor.Space != item.SpaceID || cursor.Item != item.ID || cursor.Snapshot < 1 || cursor.Snapshot > current || cursor.Before < 1 || cursor.Before > cursor.Snapshot {
			return nil, invalid("Invalid activity cursor for this item.")
		}
	}
	page := &WorkActivityPage{ItemID: item.ID, Revision: strconv.FormatInt(cursor.Snapshot, 10), HistoryStartedAt: item.activityStartedAt, Items: []WorkActivityEvent{}}
	var complete int
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_activity WHERE space_id=? AND item_id=? AND item_revision=1 AND action='create'"), item.SpaceID, item.ID).Scan(&complete); err != nil {
		return nil, err
	}
	page.HistoryComplete = complete == 1
	where := "a.space_id=? AND a.item_id=? AND a.item_revision<=?"
	args := []any{item.SpaceID, item.ID, cursor.Snapshot}
	if cursor.Before > 0 {
		where += " AND a.item_revision<?"
		args = append(args, cursor.Before)
	}
	args = append(args, in.Limit+1)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT a.id,a.action,a.origin,a.occurred_at,a.item_revision,a.actor_id,COALESCE(NULLIF(u.display_name,''),u.username,''),a.changes_json,a.session_json FROM work_activity a LEFT JOIN users u ON u.id=a.actor_id WHERE "+where+" ORDER BY a.item_revision DESC LIMIT ?"), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var event WorkActivityEvent
		var revision int64
		var actor sql.NullString
		var name, changes, sessionJSON string
		if err = rows.Scan(&event.ID, &event.Action, &event.Origin, &event.OccurredAt, &revision, &actor, &name, &changes, &sessionJSON); err != nil {
			return nil, err
		}
		if sessionJSON != "" {
			if err = json.Unmarshal([]byte(sessionJSON), &event.Session); err != nil {
				return nil, err
			}
		}
		event.ItemRevision = strconv.FormatInt(revision, 10)
		if actor.Valid {
			event.Actor = &WorkActivityActor{ID: actor.String, Name: name}
		}
		if err = json.Unmarshal([]byte(changes), &event.Changes); err != nil {
			return nil, err
		}
		event.Changes = workActivityVisibleChanges(r, event.Changes)
		page.Items = append(page.Items, event)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(page.Items) > in.Limit {
		page.Items = page.Items[:in.Limit]
		cursor.Before, _ = strconv.ParseInt(page.Items[len(page.Items)-1].ItemRevision, 10, 64)
		encoded, err := json.Marshal(cursor)
		if err != nil {
			return nil, err
		}
		next := base64.RawURLEncoding.EncodeToString(encoded)
		page.NextCursor = &next
	}
	return page, nil
}

// Deleting a bookmark legitimately removes its work references by FK cascade.
// Preserve the navigation caller's authorization and response: this internal
// bookkeeping does not grant work access or require the optional work module.
// Call before the DELETE, in its transaction. Each affected item changes once.
func (a *App) recordWorkBookmarkRemovals(r *Request, space string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	args := []any{space}
	for _, id := range ids {
		args = append(args, id)
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT w.id,COUNT(*) FROM work_items w JOIN work_item_links refs ON refs.item_id=w.id WHERE w.space_id=? AND refs.link_id IN ("+placeholders+") GROUP BY w.id ORDER BY w.id"), args...)
	if err != nil {
		return err
	}
	type affectedItem struct {
		id    string
		count int
	}
	items := []affectedItem{}
	for rows.Next() {
		var item affectedItem
		if err = rows.Scan(&item.id, &item.count); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(items) == 0 {
		return err
	}
	stamp := workStamp()
	for _, item := range items {
		if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_items SET revision=revision+1,updated_at=? WHERE id=? AND space_id=?"), stamp, item.id, space); err != nil {
			return err
		}
		if err = a.recordWorkActivity(r, space, item.id, "update", stamp, []WorkActivityChange{{Field: "bookmarkIds", Removed: item.count}}); err != nil {
			return err
		}
	}
	_, err = a.bumpWorkRevision(r, space)
	return err
}
