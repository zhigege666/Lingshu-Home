package home

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

var workStatuses = []string{"todo", "doing", "waiting", "done"}

const workStatusOrder = "CASE w.status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END"
const workRankStep int64 = 1024

type WorkSummary struct {
	ID             string  `json:"id"`
	SpaceID        string  `json:"spaceId"`
	ProjectID      *string `json:"projectId"`
	ProjectName    string  `json:"projectName"`
	Title          string  `json:"title"`
	Status         string  `json:"status"`
	NextStep       string  `json:"nextStep"`
	NeedsAttention bool    `json:"needsAttention"`
	Archived       bool    `json:"archived"`
	Revision       string  `json:"revision"`
	UpdatedAt      string  `json:"updatedAt"`
	ReferenceCount int     `json:"referenceCount"`
	rank           int64
}
type WorkReference struct {
	Kind      string `json:"kind"`
	ID        string `json:"id"`
	Title     string `json:"title"`
	Subtitle  string `json:"subtitle,omitempty"`
	URL       string `json:"url,omitempty"`
	Available bool   `json:"available"`
}
type WorkItem struct {
	WorkSummary
	Description   string          `json:"description"`
	Result        string          `json:"result"`
	CreatedAt     string          `json:"createdAt"`
	BoardRevision string          `json:"boardRevision"`
	BookmarkIDs   []string        `json:"bookmarkIds"`
	DocumentIDs   []string        `json:"documentIds"`
	References    []WorkReference `json:"references"`
	createHash    string
}
type WorkProject struct {
	ID         string `json:"id"`
	SpaceID    string `json:"spaceId"`
	Name       string `json:"name"`
	Archived   bool   `json:"archived"`
	Revision   string `json:"revision"`
	UpdatedAt  string `json:"updatedAt"`
	createHash string
}

func (a *App) registerWorkRoutes() {
	base := "/api/v1/spaces/{spaceId}/work"
	a.route("GET "+base+"/board", false, a.getWorkBoard)
	a.route("GET "+base+"/items", false, a.listWorkItems)
	a.route("POST "+base+"/items", true, a.createWorkItem)
	a.route("GET "+base+"/items/{id}", false, a.getWorkItem)
	a.route("PATCH "+base+"/items/{id}", true, a.updateWorkItem)
	a.route("POST "+base+"/items/{id}/move", true, a.moveWorkItem)
	a.route("GET "+base+"/projects", false, a.listWorkProjects)
	a.route("POST "+base+"/projects", true, a.createWorkProject)
	a.route("PATCH "+base+"/projects/{id}", true, a.updateWorkProject)
	a.route("GET "+base+"/resources", false, a.searchWorkResources)
}

// Work is unpublished working material. Public navigation permission never
// exposes it, including anonymous open-edit mode.
func (r *Request) workSpace(write bool) (*Space, error) {
	action := "work:read"
	if write {
		action = "work:write"
	}
	if err := r.requireAction(action); err != nil {
		return nil, err
	}
	if r.User == nil {
		return nil, unauthorized()
	}
	if r.TokenSourceID != "" {
		return nil, forbidden()
	}
	s, err := r.requireSpace(r.param("spaceId"), write)
	if err != nil {
		return nil, err
	}
	_, edit := r.spaceAccess(s)
	if !edit {
		return nil, forbidden()
	}
	s.CanEdit = !r.Bearer || r.AllowedActions["work:write"]
	return s, nil
}
func (r *Request) workReads(action string) bool { return !r.Bearer || r.AllowedActions[action] }
func workStatusValid(status string) bool {
	for _, value := range workStatuses {
		if value == status {
			return true
		}
	}
	return false
}
func workOrdinal(status string) int {
	for i, value := range workStatuses {
		if value == status {
			return i
		}
	}
	return -1
}
func workStamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func workConflict(code, message, revision string) error {
	return &APIError{Status: http.StatusConflict, Code: code, Message: message, CurrentRevision: revision}
}
func workPayloadHash(value any) string {
	sum := sha256.Sum256([]byte(jsonString(value)))
	return hex.EncodeToString(sum[:])
}
func (a *App) workRevision(r *Request, space string) (string, error) {
	var revision int64
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT revision FROM work_spaces WHERE space_id=?"), space).Scan(&revision)
	if errors.Is(err, sql.ErrNoRows) {
		return "1", nil
	}
	return strconv.FormatInt(revision, 10), err
}
func (a *App) bumpWorkRevision(r *Request, space string) (string, error) {
	_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_spaces(space_id,revision) VALUES(?,2) ON CONFLICT(space_id) DO UPDATE SET revision=work_spaces.revision+1"), space)
	if err != nil {
		return "", err
	}
	return a.workRevision(r, space)
}
func (a *App) workSummaryColumns(r *Request) string {
	count := "0"
	if r.workReads("navigation:read") {
		count += "+(SELECT COUNT(*) FROM work_item_links wl WHERE wl.item_id=w.id)"
	}
	if r.workReads("documents:read") {
		count += "+(SELECT COUNT(*) FROM work_item_documents wd WHERE wd.item_id=w.id)"
	}
	return "w.id,w.space_id,w.project_id,COALESCE(p.name,''),w.title,w.status,w.next_step,w.needs_attention,w.archived,w.revision,w.updated_at,w.sort_order,(" + count + ")"
}
func workSummaryScan(s *WorkSummary) ([]any, *sql.NullString, *int64) {
	var project sql.NullString
	var revision int64
	return []any{&s.ID, &s.SpaceID, &project, &s.ProjectName, &s.Title, &s.Status, &s.NextStep, &s.NeedsAttention, &s.Archived, &revision, &s.UpdatedAt, &s.rank, &s.ReferenceCount}, &project, &revision
}
func finishWorkSummary(s *WorkSummary, project *sql.NullString, revision *int64) {
	s.Revision = strconv.FormatInt(*revision, 10)
	if project.Valid {
		value := project.String
		s.ProjectID = &value
	}
}
func (a *App) loadWorkItem(r *Request, space, id string) (*WorkItem, error) {
	if !validID(id) {
		return nil, missing()
	}
	item := &WorkItem{BookmarkIDs: []string{}, DocumentIDs: []string{}, References: []WorkReference{}}
	targets, project, revision := workSummaryScan(&item.WorkSummary)
	targets = append(targets, &item.Description, &item.Result, &item.CreatedAt, &item.createHash)
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+a.workSummaryColumns(r)+",w.description,w.result,w.created_at,w.create_hash FROM work_items w LEFT JOIN work_projects p ON p.id=w.project_id WHERE w.id=? AND w.space_id=?"), id, space).Scan(targets...)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, missing()
	}
	if err != nil {
		return nil, err
	}
	finishWorkSummary(&item.WorkSummary, project, revision)
	return item, nil
}
func (a *App) loadWorkReferences(r *Request, item *WorkItem) error {
	if r.workReads("navigation:read") {
		rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT l.id,l.title,l.url FROM work_item_links wl JOIN links l ON l.id=wl.link_id WHERE wl.item_id=? AND l.space_id=? ORDER BY l.title,l.id"), item.ID, item.SpaceID)
		if err != nil {
			return err
		}
		for rows.Next() {
			ref := WorkReference{Kind: "bookmark", Available: true}
			if err = rows.Scan(&ref.ID, &ref.Title, &ref.URL); err != nil {
				rows.Close()
				return err
			}
			item.BookmarkIDs = append(item.BookmarkIDs, ref.ID)
			item.References = append(item.References, ref)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
	}
	if r.workReads("documents:read") {
		rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT d.id,d.title,d.relative_path,s.enabled,d.status FROM work_item_documents wd JOIN documents d ON d.id=wd.document_id JOIN document_sources s ON s.id=d.source_id WHERE wd.item_id=? AND d.space_id=? ORDER BY d.title,d.id"), item.ID, item.SpaceID)
		if err != nil {
			return err
		}
		for rows.Next() {
			ref := WorkReference{Kind: "document"}
			var enabled bool
			var status string
			if err = rows.Scan(&ref.ID, &ref.Title, &ref.Subtitle, &enabled, &status); err != nil {
				rows.Close()
				return err
			}
			ref.Available = enabled && status == "ready"
			item.DocumentIDs = append(item.DocumentIDs, ref.ID)
			item.References = append(item.References, ref)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
	}
	item.ReferenceCount = len(item.References)
	return nil
}
func (a *App) workItemReply(r *Request, item *WorkItem, flags map[string]any) (*Response, error) {
	revision, err := a.workRevision(r, item.SpaceID)
	if err != nil {
		return nil, err
	}
	if !r.workReads("work:read") {
		result := map[string]any{"id": item.ID, "revision": item.Revision, "boardRevision": revision}
		for k, v := range flags {
			result[k] = v
		}
		return ok(result), nil
	}
	item.BoardRevision = revision
	if err = a.loadWorkReferences(r, item); err != nil {
		return nil, err
	}
	return ok(item), nil
}
func (a *App) getWorkItem(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	item, err := a.loadWorkItem(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	return a.workItemReply(r, item, nil)
}
func (a *App) workProject(r *Request, space, id string) (*WorkProject, error) {
	if !validID(id) {
		return nil, missing()
	}
	p := &WorkProject{}
	var revision int64
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT id,space_id,name,archived,revision,updated_at,create_hash FROM work_projects WHERE space_id=? AND id=?"), space, id).Scan(&p.ID, &p.SpaceID, &p.Name, &p.Archived, &revision, &p.UpdatedAt, &p.createHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, missing()
	}
	p.Revision = strconv.FormatInt(revision, 10)
	return p, err
}
func (a *App) workProjectReply(r *Request, p *WorkProject, flags map[string]any) (*Response, error) {
	revision, err := a.workRevision(r, p.SpaceID)
	if err != nil {
		return nil, err
	}
	if !r.workReads("work:read") {
		receipt := map[string]any{"id": p.ID, "revision": p.Revision, "boardRevision": revision}
		for k, v := range flags {
			receipt[k] = v
		}
		return ok(receipt), nil
	}
	return ok(p), nil
}
func (a *App) listWorkProjects(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id,space_id,name,archived,revision,updated_at FROM work_projects WHERE space_id=? ORDER BY archived,name_key,id"), s.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []WorkProject{}
	for rows.Next() {
		p := WorkProject{}
		var rev int64
		if err = rows.Scan(&p.ID, &p.SpaceID, &p.Name, &p.Archived, &rev, &p.UpdatedAt); err != nil {
			return nil, err
		}
		p.Revision = strconv.FormatInt(rev, 10)
		items = append(items, p)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return ok(map[string]any{"items": items}), nil
}
func (a *App) createWorkProject(r *Request) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	var in struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if !validID(in.ID) {
		return nil, invalid("id must be 32 lowercase hexadecimal characters.")
	}
	in.Name, err = required(in.Name, "name", 80)
	if err != nil {
		return nil, err
	}
	hash := workPayloadHash(in)
	var existingSpace, existingHash string
	err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT space_id,create_hash FROM work_projects WHERE id=?"), in.ID).Scan(&existingSpace, &existingHash)
	if err == nil {
		if existingSpace != s.ID || existingHash != hash {
			return nil, workConflict("work_id_conflict", "This ID is already used by a different create request.", "")
		}
		p, err := a.workProject(r, s.ID, in.ID)
		if err != nil {
			return nil, err
		}
		return a.workProjectReply(r, p, map[string]any{"replayed": true})
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	var exists int
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_projects WHERE space_id=? AND name_key=?"), s.ID, strings.ToLower(in.Name)).Scan(&exists); err != nil {
		return nil, err
	}
	if exists > 0 {
		return nil, workConflict("work_project_name_conflict", "A project with this name already exists. Include archived projects when searching.", "")
	}
	now := workStamp()
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_projects(id,space_id,name,name_key,archived,revision,created_at,updated_at,create_hash) VALUES(?,?,?,?,?,1,?,?,?)"), in.ID, s.ID, in.Name, strings.ToLower(in.Name), false, now, now, hash)
	if err != nil {
		return nil, err
	}
	if _, err = a.bumpWorkRevision(r, s.ID); err != nil {
		return nil, err
	}
	p, err := a.workProject(r, s.ID, in.ID)
	if err != nil {
		return nil, err
	}
	return a.workProjectReply(r, p, map[string]any{"created": true})
}
func (a *App) updateWorkProject(r *Request) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	p, err := a.workProject(r, s.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var raw map[string]json.RawMessage
	if err = r.decode(&raw); err != nil {
		return nil, err
	}
	for k := range raw {
		if k != "expectedRevision" && k != "name" && k != "archived" {
			return nil, invalid("Unknown project field.")
		}
	}
	var revision string
	if err = workDecodeField(raw, "expectedRevision", &revision, false); err != nil {
		return nil, err
	}
	if revision == "" {
		return nil, invalid("expectedRevision is required.")
	}
	if revision != p.Revision {
		return nil, workConflict("work_project_version_conflict", "The project changed. Reload it before editing.", p.Revision)
	}
	if len(raw) < 2 {
		return nil, invalid("At least one changed field is required.")
	}
	if _, ok := raw["name"]; ok {
		if err = workDecodeField(raw, "name", &p.Name, false); err != nil {
			return nil, err
		}
		p.Name, err = required(p.Name, "name", 80)
		if err != nil {
			return nil, err
		}
	}
	if _, ok := raw["archived"]; ok {
		if err = workDecodeField(raw, "archived", &p.Archived, false); err != nil {
			return nil, err
		}
	}
	var exists int
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_projects WHERE space_id=? AND name_key=? AND id<>?"), s.ID, strings.ToLower(p.Name), p.ID).Scan(&exists); err != nil {
		return nil, err
	}
	if exists > 0 {
		return nil, workConflict("work_project_name_conflict", "A project with this name already exists.", "")
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_projects SET name=?,name_key=?,archived=?,revision=revision+1,updated_at=? WHERE id=? AND space_id=?"), p.Name, strings.ToLower(p.Name), p.Archived, workStamp(), p.ID, s.ID)
	if err != nil {
		return nil, err
	}
	if _, err = a.bumpWorkRevision(r, s.ID); err != nil {
		return nil, err
	}
	p, err = a.workProject(r, s.ID, p.ID)
	if err != nil {
		return nil, err
	}
	return a.workProjectReply(r, p, nil)
}
func workDecodeField(raw map[string]json.RawMessage, key string, target any, nullable bool) error {
	value, ok := raw[key]
	if !ok {
		return nil
	}
	if !nullable && strings.TrimSpace(string(value)) == "null" {
		return invalid(key + " cannot be null.")
	}
	if err := json.Unmarshal(value, target); err != nil {
		return invalid("Invalid " + key + ".")
	}
	return nil
}
func workIDs(ids []string) ([]string, error) {
	if len(ids) > 20 {
		return nil, invalid("At most 20 references of each kind are allowed.")
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if !validID(id) || seen[id] {
			return nil, invalid("Reference IDs must be valid and unique.")
		}
		seen[id] = true
		out = append(out, id)
	}
	sort.Strings(out)
	return out, nil
}
