package home

import (
	"encoding/json"
	"reflect"
	"sort"
	"strconv"
)

type WorkItemLink struct {
	ID         string `json:"id"`
	Key        string `json:"key"`
	Title      string `json:"title"`
	Status     string `json:"status"`
	StatusType string `json:"statusType"`
	Archived   bool   `json:"archived"`
}
type WorkRelationSummary struct {
	Parent         *WorkItemLink `json:"parent"`
	Predecessor    *WorkItemLink `json:"predecessor"`
	ChildrenCount  int           `json:"childrenCount"`
	BlockedByCount int           `json:"blockedByCount"`
	BlockedCount   int           `json:"blockedCount"`
	IsBlocked      bool          `json:"isBlocked"`
}

func workBlockedPredicate(alias string) string {
	return "EXISTS(SELECT 1 FROM work_statuses own_status WHERE own_status.space_id=" + alias + ".space_id AND own_status.id=" + alias + ".status AND own_status.status_type NOT IN ('done','canceled')) AND EXISTS(SELECT 1 FROM work_dependencies bd JOIN work_items bw ON bw.id=bd.blocked_by_id JOIN work_statuses bs ON bs.space_id=bw.space_id AND bs.id=bw.status WHERE bd.item_id=" + alias + ".id AND bs.status_type<>'done')"
}
func (a *App) workItemLinks(r *Request, space string, ids []string) (map[string]*WorkItemLink, error) {
	result := map[string]*WorkItemLink{}
	if len(ids) == 0 {
		return result, nil
	}
	slots, args := workPlaceholders(ids)
	args = append([]any{space}, args...)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT w.id,w.number,w.title,w.status,s.status_type,w.archived FROM work_items w JOIN work_statuses s ON s.space_id=w.space_id AND s.id=w.status WHERE w.space_id=? AND w.id IN ("+slots+")"), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		v := &WorkItemLink{}
		var number int64
		if err = rows.Scan(&v.ID, &number, &v.Title, &v.Status, &v.StatusType, &v.Archived); err != nil {
			return nil, err
		}
		if number > 0 {
			v.Key = "W-" + strconv.FormatInt(number, 10)
		}
		result[v.ID] = v
	}
	return result, rows.Err()
}
func (a *App) decorateWorkRelations(r *Request, space string, items []*WorkSummary) error {
	if len(items) == 0 {
		return nil
	}
	ids := []string{}
	byID := map[string]*WorkSummary{}
	links := map[string]bool{}
	for _, item := range items {
		ids = append(ids, item.ID)
		byID[item.ID] = item
		item.Relations = &WorkRelationSummary{}
		if item.parentID != "" {
			links[item.parentID] = true
		}
		if item.predecessorID != "" {
			links[item.predecessorID] = true
		}
	}
	slots, args := workPlaceholders(ids)
	args = append([]any{space}, args...)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT w.id,(SELECT COUNT(*) FROM work_items child WHERE child.space_id=w.space_id AND child.parent_id<>'' AND child.parent_id=w.id),(SELECT COUNT(*) FROM work_dependencies d WHERE d.item_id=w.id),(SELECT COUNT(*) FROM work_dependencies d JOIN work_items b ON b.id=d.blocked_by_id JOIN work_statuses bs ON bs.space_id=b.space_id AND bs.id=b.status WHERE d.item_id=w.id AND bs.status_type<>'done'),s.status_type FROM work_items w JOIN work_statuses s ON s.space_id=w.space_id AND s.id=w.status WHERE w.space_id=? AND w.id IN ("+slots+")"), args...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, kind string
		var children, total, blocked int
		if err = rows.Scan(&id, &children, &total, &blocked, &kind); err != nil {
			rows.Close()
			return err
		}
		v := byID[id].Relations
		v.ChildrenCount = children
		v.BlockedByCount = total
		v.BlockedCount = blocked
		v.IsBlocked = blocked > 0 && kind != "done" && kind != "canceled"
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	linkIDs := []string{}
	for id := range links {
		linkIDs = append(linkIDs, id)
	}
	found, err := a.workItemLinks(r, space, linkIDs)
	if err != nil {
		return err
	}
	for _, item := range items {
		item.Relations.Parent = found[item.parentID]
		item.Relations.Predecessor = found[item.predecessorID]
	}
	return nil
}
func (a *App) workBlockedIDs(r *Request, item string) ([]string, error) {
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT blocked_by_id FROM work_dependencies WHERE item_id=? ORDER BY blocked_by_id"), item)
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
func (a *App) getWorkRelations(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	item, err := a.loadWorkItem(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	if err = a.decorateWorkRelations(r, s.ID, []*WorkSummary{&item.WorkSummary}); err != nil {
		return nil, err
	}
	ids, err := a.workBlockedIDs(r, item.ID)
	if err != nil {
		return nil, err
	}
	links, err := a.workItemLinks(r, s.ID, ids)
	if err != nil {
		return nil, err
	}
	blocked := []WorkItemLink{}
	for _, id := range ids {
		if v := links[id]; v != nil {
			blocked = append(blocked, *v)
		}
	}
	return ok(map[string]any{"itemId": item.ID, "revision": item.Revision, "parent": item.Relations.Parent, "predecessor": item.Relations.Predecessor, "blockedBy": blocked, "childrenCount": item.Relations.ChildrenCount, "blockedCount": item.Relations.BlockedCount, "isBlocked": item.Relations.IsBlocked}), nil
}
func (a *App) updateWorkRelations(r *Request) (*Response, error) {
	return a.coordinatedWorkMutation(r, "item.relations", a.updateWorkRelationsValue)
}
func (a *App) updateWorkRelationsValue(r *Request) (*Response, error) {
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
		if k != "expectedRevision" && k != "parentId" && k != "blockedByIds" && k != "predecessorId" {
			return nil, invalid("Unknown relation field: " + k)
		}
	}
	var revision string
	if err = workDecodeField(raw, "expectedRevision", &revision, false); err != nil {
		return nil, err
	}
	if revision == "" || revision != item.Revision {
		return nil, workConflict("work_item_version_conflict", "The item changed. Reload its relations.", item.Revision)
	}
	if len(raw) < 2 {
		return nil, invalid("Provide a relation change.")
	}
	oldBlocked, err := a.workBlockedIDs(r, item.ID)
	if err != nil {
		return nil, err
	}
	blocked := append([]string{}, oldBlocked...)
	var parent, predecessor *string
	if item.parentID != "" {
		v := item.parentID
		parent = &v
	}
	if item.predecessorID != "" {
		v := item.predecessorID
		predecessor = &v
	}
	for _, f := range []struct {
		name     string
		target   any
		nullable bool
	}{{"parentId", &parent, true}, {"predecessorId", &predecessor, true}, {"blockedByIds", &blocked, false}} {
		if err = workDecodeField(raw, f.name, f.target, f.nullable); err != nil {
			return nil, err
		}
	}
	if len(blocked) > 50 {
		return nil, invalid("Use at most 50 blockers.")
	}
	refs := []*string{}
	if parent != nil {
		refs = append(refs, parent)
	}
	if predecessor != nil {
		refs = append(refs, predecessor)
	}
	for i := range blocked {
		refs = append(refs, &blocked[i])
	}
	for _, ref := range refs {
		id, err := a.resolveWorkItemRef(r, s.ID, *ref)
		if err != nil {
			return nil, err
		}
		if id == item.ID {
			return nil, workConflict("work_relation_cycle", "An item cannot refer to itself.", item.Revision)
		}
		*ref = id
	}
	targets := []string{}
	seen := map[string]bool{}
	for _, ref := range refs {
		if !seen[*ref] {
			targets = append(targets, *ref)
			seen[*ref] = true
		}
	}
	found, err := a.workItemLinks(r, s.ID, targets)
	if err != nil {
		return nil, err
	}
	if len(found) != len(targets) {
		return nil, missing()
	}
	sort.Strings(blocked)
	for i := 1; i < len(blocked); i++ {
		if blocked[i] == blocked[i-1] {
			return nil, invalid("Blockers must be unique.")
		}
	}
	parentID, predecessorID := workOptionalID(parent), workOptionalID(predecessor)
	if parentID == item.parentID && predecessorID == item.predecessorID && reflect.DeepEqual(blocked, oldBlocked) {
		return a.workItemReply(r, item, map[string]any{"unchanged": true})
	}
	stamp := workStamp()
	if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_items SET parent_id=?,predecessor_id=?,revision=revision+1,updated_at=? WHERE id=? AND space_id=?"), parentID, predecessorID, stamp, item.ID, s.ID); err != nil {
		return nil, err
	}
	if !reflect.DeepEqual(blocked, oldBlocked) {
		if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM work_dependencies WHERE item_id=?"), item.ID); err != nil {
			return nil, err
		}
		for _, id := range blocked {
			if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_dependencies(space_id,item_id,blocked_by_id) VALUES(?,?,?)"), s.ID, item.ID, id); err != nil {
				return nil, err
			}
		}
	}
	for _, kind := range []string{"parent", "predecessor", "blocked"} {
		if err = a.validateWorkRelationGraph(r, s.ID, item.ID, kind); err != nil {
			return nil, err
		}
	}
	delta := len(blocked) - len(oldBlocked)
	if parentID != "" {
		delta++
	}
	if item.parentID != "" {
		delta--
	}
	if predecessorID != "" {
		delta++
	}
	if item.predecessorID != "" {
		delta--
	}
	if delta != 0 {
		if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE spaces SET work_relations_count=work_relations_count+? WHERE id=?"), delta, s.ID); err != nil {
			return nil, err
		}
		s.WorkRelationsCount += int64(delta)
	}
	change := WorkActivityChange{Field: "relations", Before: workActivityValue(map[string]any{"parentId": item.parentID, "predecessorId": item.predecessorID, "blockedByIds": oldBlocked}), After: workActivityValue(map[string]any{"parentId": parentID, "predecessorId": predecessorID, "blockedByIds": blocked})}
	if err = a.recordWorkActivity(r, s.ID, item.ID, "update", stamp, []WorkActivityChange{change}); err != nil {
		return nil, err
	}
	if err = a.syncWorkBlockedMetrics(r, s.ID, item.ID, stamp, false); err != nil {
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
func (a *App) validateWorkRelationGraph(r *Request, space, item, kind string) error {
	field := "parent_id"
	if kind == "predecessor" {
		field = "predecessor_id"
	}
	query := "WITH RECURSIVE reach(id) AS (SELECT " + field + " FROM work_items WHERE space_id=? AND id=? AND " + field + "<>'' UNION SELECT w." + field + " FROM work_items w JOIN reach x ON w.id=x.id WHERE w." + field + "<>'') SELECT id FROM reach LIMIT 10001"
	if kind == "blocked" {
		query = "WITH RECURSIVE reach(id) AS (SELECT blocked_by_id FROM work_dependencies WHERE space_id=? AND item_id=? UNION SELECT d.blocked_by_id FROM work_dependencies d JOIN reach x ON d.item_id=x.id) SELECT id FROM reach LIMIT 10001"
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query(query), space, item)
	if err != nil {
		return err
	}
	count := 0
	cycle := false
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		count++
		cycle = cycle || id == item
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if cycle {
		return workConflict("work_relation_cycle", "This relationship would create a cycle.", "")
	}
	if count > 10000 {
		return workConflict("work_relation_graph_limit", "The reachable relationship graph exceeds the 10000-item validation limit.", "")
	}
	if kind == "parent" {
		if count > 20 {
			return invalid("Parent depth cannot exceed 20.")
		}
		var depth int
		err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("WITH RECURSIVE children(id,depth) AS (SELECT id,0 FROM work_items WHERE space_id=? AND id=? UNION ALL SELECT w.id,c.depth+1 FROM work_items w JOIN children c ON w.parent_id=c.id WHERE w.parent_id<>'' AND c.depth<21) SELECT COALESCE(MAX(depth),0) FROM children"), space, item).Scan(&depth)
		if err != nil {
			return err
		}
		if depth+count > 20 {
			return invalid("This move would put a descendant beyond the parent depth limit of 20.")
		}
	}
	return nil
}
