package home

import (
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
)

type workCreateInput struct {
	ID             string              `json:"id"`
	Title          string              `json:"title"`
	ProjectID      *string             `json:"projectId"`
	Status         string              `json:"status"`
	Description    string              `json:"description"`
	NextStep       string              `json:"nextStep"`
	Result         string              `json:"result"`
	NeedsAttention bool                `json:"needsAttention"`
	BookmarkIDs    []string            `json:"bookmarkIds"`
	DocumentIDs    []string            `json:"documentIds"`
	Placement      workCreatePlacement `json:"placement,omitempty"`
}

// Omitted placement and explicit end retain the original creation hash.
type workCreatePlacement string

func (p *workCreatePlacement) UnmarshalJSON(data []byte) error {
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	switch value {
	case "start":
		*p = "start"
	case "end":
		*p = ""
	default:
		return errors.New("placement must be start or end")
	}
	return nil
}

func validateWorkText(in *workCreateInput) error {
	var err error
	in.Title, err = required(in.Title, "title", 160)
	if err != nil {
		return err
	}
	for _, field := range []struct {
		value, name string
		limit       int
	}{{in.Description, "description", 4000}, {in.NextStep, "nextStep", 1000}, {in.Result, "result", 4000}} {
		if err = bounded(field.value, field.name, field.limit); err != nil {
			return err
		}
	}
	if in.Status != "" && !workStatusValid(in.Status) {
		return invalid("status must be a stable ID from the current space status catalog.")
	}
	if in.ProjectID != nil && !validID(*in.ProjectID) {
		return invalid("projectId must be null or an existing project ID.")
	}
	return nil
}
func (a *App) validateWorkProject(r *Request, space string, id *string) error {
	if id == nil {
		return nil
	}
	p, err := a.workProject(r, space, *id)
	if err != nil {
		return err
	}
	if p.Archived {
		return workConflict("work_project_archived", "Restore the project before adding work to it.", p.Revision)
	}
	return nil
}
func workReferenceTable(kind string) (string, string) {
	if kind == "bookmark" {
		return "work_item_links", "link_id"
	}
	return "work_item_documents", "document_id"
}
func (a *App) storedWorkIDs(r *Request, itemID, kind string) ([]string, error) {
	table, column := workReferenceTable(kind)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+column+" FROM "+table+" WHERE item_id=? ORDER BY "+column), itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
func (a *App) validateWorkRefs(r *Request, space, itemID, kind string, ids []string) error {
	if kind == "document" {
		if err := r.requireModule("documents"); err != nil {
			return err
		}
	}
	old, err := a.storedWorkIDs(r, itemID, kind)
	if err != nil {
		return err
	}
	oldSet := map[string]bool{}
	for _, id := range old {
		oldSet[id] = true
	}
	action := "navigation:read"
	if kind == "document" {
		action = "documents:read"
	}
	for _, id := range ids {
		if oldSet[id] {
			continue
		}
		if err = r.requireAction(action); err != nil {
			return err
		}
		var found int
		query := "SELECT COUNT(*) FROM links WHERE id=? AND space_id=?"
		args := []any{id, space}
		if kind == "document" {
			query = "SELECT COUNT(*) FROM documents d JOIN document_sources s ON s.id=d.source_id WHERE d.id=? AND d.space_id=? AND s.enabled=?"
			args = append(args, true)
		}
		if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query(query), args...).Scan(&found); err != nil {
			return err
		}
		if found != 1 {
			return missing()
		}
	}
	return nil
}
func (a *App) replaceWorkRefs(r *Request, itemID, kind string, ids []string) error {
	table, column := workReferenceTable(kind)
	if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM "+table+" WHERE item_id=?"), itemID); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO "+table+"(item_id,"+column+") VALUES(?,?)"), itemID, id); err != nil {
			return err
		}
	}
	return nil
}
func (a *App) normalizeWorkRanks(r *Request, space, status string, archived bool) error {
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id FROM work_items WHERE space_id=? AND status=? AND archived=? ORDER BY sort_order,id"), space, status, archived)
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
	for i, id := range ids {
		if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_items SET sort_order=? WHERE id=?"), int64(i+1)*workRankStep, id); err != nil {
			return err
		}
	}
	return nil
}
func (a *App) appendWorkRank(r *Request, space, status string, archived bool, except string) (int64, error) {
	var rank int64
	query := "SELECT COALESCE(MAX(sort_order),0) FROM work_items WHERE space_id=? AND status=? AND archived=? AND id<>?"
	if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query(query), space, status, archived, except).Scan(&rank); err != nil {
		return 0, err
	}
	if rank > 1<<60 {
		if err := a.normalizeWorkRanks(r, space, status, archived); err != nil {
			return 0, err
		}
		if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query(query), space, status, archived, except).Scan(&rank); err != nil {
			return 0, err
		}
	}
	return rank + workRankStep, nil
}
func (a *App) beforeWorkRank(r *Request, space, status, id, before string) (int64, error) {
	if before == "" {
		return a.appendWorkRank(r, space, status, false, id)
	}
	if before == id {
		return 0, invalid("An item cannot be its own move anchor.")
	}
	for attempt := 0; attempt < 2; attempt++ {
		var target, previous int64
		err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT sort_order FROM work_items WHERE space_id=? AND status=? AND archived=? AND id=?"), space, status, false, before).Scan(&target)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, workConflict("work_move_target_conflict", "The destination item is no longer in this column. Refresh the board.", "")
		}
		if err != nil {
			return 0, err
		}
		err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COALESCE(MAX(sort_order),0) FROM work_items WHERE space_id=? AND status=? AND archived=? AND id<>? AND (sort_order<? OR (sort_order=? AND id<?))"), space, status, false, id, target, target, before).Scan(&previous)
		if err != nil {
			return 0, err
		}
		if target-previous > 1 {
			return previous + (target-previous)/2, nil
		}
		if err = a.normalizeWorkRanks(r, space, status, false); err != nil {
			return 0, err
		}
	}
	return 0, conflict("Unable to place this item. Refresh the board.")
}
func (a *App) createWorkRank(r *Request, space, status, id string, placement workCreatePlacement) (int64, error) {
	var before string
	if placement == "start" {
		err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT id FROM work_items WHERE space_id=? AND status=? AND archived=? ORDER BY sort_order,id LIMIT 1"), space, status, false).Scan(&before)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return 0, err
		}
	}
	return a.beforeWorkRank(r, space, status, id, before)
}
func (a *App) createWorkItem(r *Request) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	// Preserve whether documentIds was supplied, including []/null. Omission
	// must allow plain work creation when the optional document module is off.
	var decoded struct {
		workCreateInput
		DocumentIDs json.RawMessage `json:"documentIds"`
		ContextRaw  json.RawMessage `json:"context"`
	}
	if err = r.decode(&decoded); err != nil {
		return nil, err
	}
	collaborationContext, err := decodeWorkMutationContext(decoded.ContextRaw)
	if err != nil {
		return nil, err
	}
	in := decoded.workCreateInput
	docsSet := decoded.DocumentIDs != nil
	if docsSet {
		if err = json.Unmarshal(decoded.DocumentIDs, &in.DocumentIDs); err != nil {
			return nil, invalid("documentIds must be an array of IDs.")
		}
	}
	if !validID(in.ID) {
		return nil, invalid("id must be 32 lowercase hexadecimal characters.")
	}
	if err = validateWorkText(&in); err != nil {
		return nil, err
	}
	in.BookmarkIDs, err = workIDs(in.BookmarkIDs)
	if err != nil {
		return nil, err
	}
	in.DocumentIDs, err = workIDs(in.DocumentIDs)
	if err != nil {
		return nil, err
	}
	// Hash the caller's normalized intent before resolving the mutable default.
	hash := workPayloadHash(in)
	existing, err := a.existingWorkCreation(r, s.ID, in, hash)
	if err != nil {
		return nil, err
	}
	// Legacy creation replay precedes the collaboration flag: an upgrade must
	// never change an already stored creation intent or demand a new item ID.
	if existing != nil && collaborationContext == nil {
		return a.workItemReply(r, existing, map[string]any{"replayed": true})
	}
	replay, operationHash, err := a.prepareWorkCreation(r, s.ID, in.ID, in, collaborationContext)
	if err != nil || replay != nil {
		return replay, err
	}
	if existing != nil {
		if err = a.finishWorkCreation(r, existing, collaborationContext, operationHash); err != nil {
			return nil, err
		}
		return a.workItemReply(r, existing, map[string]any{"replayed": true})
	}
	if in.Status == "" {
		catalog, err := a.loadWorkStatuses(r, s.ID, false)
		if err != nil {
			return nil, err
		}
		in.Status = catalog.DefaultStatus
	}
	if _, err = a.requireWorkStatus(r, s.ID, in.Status); err != nil {
		return nil, err
	}
	if err = a.validateWorkProject(r, s.ID, in.ProjectID); err != nil {
		return nil, err
	}
	if err = a.validateWorkRefs(r, s.ID, in.ID, "bookmark", in.BookmarkIDs); err != nil {
		return nil, err
	}
	if docsSet {
		if err = a.validateWorkRefs(r, s.ID, in.ID, "document", in.DocumentIDs); err != nil {
			return nil, err
		}
	}
	rank, err := a.createWorkRank(r, s.ID, in.Status, in.ID, in.Placement)
	if err != nil {
		return nil, err
	}
	now := workStamp()
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_items(id,space_id,project_id,title,description,next_step,result,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash,create_hash_version,activity_started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,2,?)"), in.ID, s.ID, in.ProjectID, in.Title, in.Description, in.NextStep, in.Result, in.Status, in.NeedsAttention, false, rank, now, now, hash, now)
	if err != nil {
		return nil, err
	}
	if err = a.replaceWorkRefs(r, in.ID, "bookmark", in.BookmarkIDs); err != nil {
		return nil, err
	}
	if err = a.replaceWorkRefs(r, in.ID, "document", in.DocumentIDs); err != nil {
		return nil, err
	}
	if err = a.recordWorkActivity(r, s.ID, in.ID, "create", now, nil); err != nil {
		return nil, err
	}
	if _, err = a.bumpWorkRevision(r, s.ID); err != nil {
		return nil, err
	}
	item, err := a.loadWorkItem(r, s.ID, in.ID)
	if err != nil {
		return nil, err
	}
	if err = a.finishWorkCreation(r, item, collaborationContext, operationHash); err != nil {
		return nil, err
	}
	return a.workItemReply(r, item, map[string]any{"created": true})
}
func (a *App) updateWorkItemValue(r *Request) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	item, err := a.loadWorkItem(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var raw map[string]json.RawMessage
	if err = r.decode(&raw); err != nil {
		return nil, err
	}
	allowed := map[string]bool{"expectedRevision": true, "title": true, "projectId": true, "status": true, "description": true, "nextStep": true, "result": true, "needsAttention": true, "archived": true, "bookmarkIds": true, "documentIds": true}
	for k := range raw {
		if !allowed[k] {
			return nil, invalid("Unknown item field: " + k)
		}
	}
	var revision string
	if err = workDecodeField(raw, "expectedRevision", &revision, false); err != nil {
		return nil, err
	}
	if revision == "" {
		return nil, invalid("expectedRevision is required.")
	}
	if revision != item.Revision {
		return nil, workConflict("work_item_version_conflict", "The item changed. Reload it before editing.", item.Revision)
	}
	if len(raw) < 2 {
		return nil, invalid("At least one changed field is required.")
	}
	in := workCreateInput{ID: item.ID, Title: item.Title, ProjectID: item.ProjectID, Status: item.Status, Description: item.Description, NextStep: item.NextStep, Result: item.Result, NeedsAttention: item.NeedsAttention}
	archived := item.Archived
	for _, field := range []struct {
		name     string
		target   any
		nullable bool
	}{{"title", &in.Title, false}, {"projectId", &in.ProjectID, true}, {"status", &in.Status, false}, {"description", &in.Description, false}, {"nextStep", &in.NextStep, false}, {"result", &in.Result, false}, {"needsAttention", &in.NeedsAttention, false}, {"archived", &archived, false}, {"bookmarkIds", &in.BookmarkIDs, false}, {"documentIds", &in.DocumentIDs, false}} {
		if err = workDecodeField(raw, field.name, field.target, field.nullable); err != nil {
			return nil, err
		}
	}
	if _, set := raw["status"]; set && in.Status == "" {
		return nil, invalid("Unknown status.")
	}
	if err = validateWorkText(&in); err != nil {
		return nil, err
	}
	if _, err = a.requireWorkStatus(r, s.ID, in.Status); err != nil {
		return nil, err
	}
	if !reflect.DeepEqual(in.ProjectID, item.ProjectID) {
		if err = a.validateWorkProject(r, s.ID, in.ProjectID); err != nil {
			return nil, err
		}
	}
	_, linksSet := raw["bookmarkIds"]
	_, docsSet := raw["documentIds"]
	if linksSet {
		in.BookmarkIDs, err = workIDs(in.BookmarkIDs)
		if err != nil {
			return nil, err
		}
		if err = a.validateWorkRefs(r, s.ID, item.ID, "bookmark", in.BookmarkIDs); err != nil {
			return nil, err
		}
	}
	if docsSet {
		in.DocumentIDs, err = workIDs(in.DocumentIDs)
		if err != nil {
			return nil, err
		}
		if err = a.validateWorkRefs(r, s.ID, item.ID, "document", in.DocumentIDs); err != nil {
			return nil, err
		}
	}
	changes, err := a.workItemChanges(r, item, in, archived, linksSet, docsSet)
	if err != nil {
		return nil, err
	}
	if len(changes) == 0 {
		return a.workItemReply(r, item, map[string]any{"unchanged": true})
	}
	rank := item.rank
	if in.Status != item.Status || archived != item.Archived {
		rank, err = a.appendWorkRank(r, s.ID, in.Status, archived, item.ID)
		if err != nil {
			return nil, err
		}
	}
	now := workStamp()
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_items SET title=?,project_id=?,status=?,description=?,next_step=?,result=?,needs_attention=?,archived=?,sort_order=?,revision=revision+1,updated_at=? WHERE id=? AND space_id=?"), in.Title, in.ProjectID, in.Status, in.Description, in.NextStep, in.Result, in.NeedsAttention, archived, rank, now, item.ID, s.ID)
	if err != nil {
		return nil, err
	}
	if linksSet {
		if err = a.replaceWorkRefs(r, item.ID, "bookmark", in.BookmarkIDs); err != nil {
			return nil, err
		}
	}
	if docsSet {
		if err = a.replaceWorkRefs(r, item.ID, "document", in.DocumentIDs); err != nil {
			return nil, err
		}
	}
	action := "update"
	if archived != item.Archived {
		action = "restore"
		if archived {
			action = "archive"
		}
	}
	if err = a.recordWorkActivity(r, s.ID, item.ID, action, now, changes); err != nil {
		return nil, err
	}
	if _, err = a.bumpWorkRevision(r, s.ID); err != nil {
		return nil, err
	}
	item, err = a.loadWorkItem(r, s.ID, item.ID)
	if err != nil {
		return nil, err
	}
	return a.workItemReply(r, item, nil)
}
func (a *App) moveWorkItemValue(r *Request) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	item, err := a.loadWorkItem(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var raw map[string]json.RawMessage
	if err = r.decode(&raw); err != nil {
		return nil, err
	}
	for k := range raw {
		if k != "expectedRevision" && k != "expectedBoardRevision" && k != "status" && k != "beforeId" {
			return nil, invalid("Unknown move field.")
		}
	}
	for _, key := range []string{"expectedRevision", "expectedBoardRevision", "status", "beforeId"} {
		if _, ok := raw[key]; !ok {
			return nil, invalid(key + " is required.")
		}
	}
	var revision, board, status string
	var before *string
	for _, field := range []struct {
		name     string
		target   any
		nullable bool
	}{{"expectedRevision", &revision, false}, {"expectedBoardRevision", &board, false}, {"status", &status, false}, {"beforeId", &before, true}} {
		if err = workDecodeField(raw, field.name, field.target, field.nullable); err != nil {
			return nil, err
		}
	}
	if revision == "" || board == "" {
		return nil, invalid("Both expected revisions are required.")
	}
	if !workStatusValid(status) || before != nil && !validID(*before) {
		return nil, invalid("Invalid move destination.")
	}
	if revision != item.Revision {
		return nil, workConflict("work_item_version_conflict", "The item changed. Refresh before moving it.", item.Revision)
	}
	if _, err = a.requireWorkStatus(r, s.ID, status); err != nil {
		return nil, err
	}
	actual, err := a.workRevision(r, s.ID)
	if err != nil {
		return nil, err
	}
	if actual != board {
		return nil, workConflict("work_version_conflict", "The board changed. Refresh before moving this item.", actual)
	}
	if item.Archived {
		return nil, invalid("Restore an archived item before moving it.")
	}
	anchor := ""
	if before != nil {
		anchor = *before
	}
	if anchor == item.ID {
		return nil, invalid("An item cannot be its own move anchor.")
	}
	if status == item.Status {
		// Compare logical neighbors, not fractional ranks: placing an item
		// before its existing successor (or leaving the tail at the end) is
		// a no-op even if beforeWorkRank would choose a different number.
		var successor string
		err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT id FROM work_items WHERE space_id=? AND status=? AND archived=? AND (sort_order>? OR (sort_order=? AND id>?)) ORDER BY sort_order,id LIMIT 1"), s.ID, status, false, item.rank, item.rank, item.ID).Scan(&successor)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if successor == anchor {
			return a.workItemReply(r, item, map[string]any{"unchanged": true})
		}
	}
	rank, err := a.beforeWorkRank(r, s.ID, status, item.ID, anchor)
	if err != nil {
		return nil, err
	}
	changes := []WorkActivityChange{{Field: "order"}}
	if status != item.Status {
		oldStatus, err := a.requireWorkStatus(r, s.ID, item.Status)
		if err != nil {
			return nil, err
		}
		newStatus, err := a.requireWorkStatus(r, s.ID, status)
		if err != nil {
			return nil, err
		}
		changes = append([]WorkActivityChange{workActivityStatusChange(oldStatus, newStatus)}, changes...)
	}
	now := workStamp()
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_items SET status=?,sort_order=?,revision=revision+1,updated_at=? WHERE id=? AND space_id=?"), status, rank, now, item.ID, s.ID)
	if err != nil {
		return nil, err
	}
	if err = a.recordWorkActivity(r, s.ID, item.ID, "move", now, changes); err != nil {
		return nil, err
	}
	if _, err = a.bumpWorkRevision(r, s.ID); err != nil {
		return nil, err
	}
	item, err = a.loadWorkItem(r, s.ID, item.ID)
	if err != nil {
		return nil, err
	}
	return a.workItemReply(r, item, nil)
}
