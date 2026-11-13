package home

import (
	"database/sql"
	"errors"
	"regexp"
	"strconv"
	"strings"
)

const workStatusLimit = 64

var workStatusColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

type WorkStatusDefinition struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	Color       string `json:"color"`
	Description string `json:"description"`
	Position    int    `json:"position"`
	IsDefault   bool   `json:"isDefault"`
	*WorkStatusCounts
}

// Counts are present only when the catalog query actually loads them. Board,
// item and error metadata must not report unqueried counts as an empty state.
type WorkStatusCounts struct {
	Total         int `json:"total"`
	ArchivedTotal int `json:"archivedTotal"`
}

type WorkStatusCatalog struct {
	Revision      string                 `json:"revision"`
	DefaultStatus string                 `json:"defaultStatus"`
	CanEdit       bool                   `json:"canEdit"`
	Items         []WorkStatusDefinition `json:"items"`
}

func (c *WorkStatusCatalog) find(id string) *WorkStatusDefinition {
	for i := range c.Items {
		if c.Items[i].ID == id {
			return &c.Items[i]
		}
	}
	return nil
}

// This runs when a space is created, in the same transaction as its page.
// Reads never initialize or modify data (including PostgreSQL read-only reads).
func (a *App) initializeWorkStatuses(r *Request, space string) error {
	if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_spaces(space_id) VALUES(?)"), space); err != nil {
		return err
	}
	zh := []string{"待办", "进行中", "等待", "完成"}
	en := []string{"Todo", "In progress", "Waiting", "Done"}
	colors := []string{"#8b9790", "#5596bc", "#c99c35", "#50966a"}
	for i, id := range workStatuses {
		name := zh[i]
		if r.Settings.Language == "en" {
			name = en[i]
		}
		if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_statuses(space_id,id,name,name_key,status_type,color,sort_order) VALUES(?,?,?,?,?,?,?)"), space, id, name, strings.ToLower(name), id, colors[i], i); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) loadWorkStatuses(r *Request, space string, counts bool) (*WorkStatusCatalog, error) {
	catalog := &WorkStatusCatalog{Items: []WorkStatusDefinition{}}
	var revision int64
	if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT status_revision,default_status FROM work_spaces WHERE space_id=?"), space).Scan(&revision, &catalog.DefaultStatus); err != nil {
		return nil, err
	}
	catalog.Revision = strconv.FormatInt(revision, 10)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id,name,status_type,color,description,sort_order FROM work_statuses WHERE space_id=? AND retired=? ORDER BY sort_order,id"), space, false)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item WorkStatusDefinition
		if err = rows.Scan(&item.ID, &item.Name, &item.Type, &item.Color, &item.Description, &item.Position); err != nil {
			rows.Close()
			return nil, err
		}
		item.IsDefault = item.ID == catalog.DefaultStatus
		if counts {
			item.WorkStatusCounts = &WorkStatusCounts{}
		}
		catalog.Items = append(catalog.Items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || !counts {
		return catalog, err
	}
	rows, err = r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT status,archived,COUNT(*) FROM work_items WHERE space_id=? GROUP BY status,archived"), space)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var archived bool
		var count int
		if err = rows.Scan(&id, &archived, &count); err != nil {
			return nil, err
		}
		if item := catalog.find(id); item != nil {
			if archived {
				item.ArchivedTotal = count
			} else {
				item.Total = count
			}
		}
	}
	return catalog, rows.Err()
}

func workStatusTypeValid(value string) bool {
	return value == "todo" || value == "doing" || value == "waiting" || value == "done" || value == "canceled"
}

func (a *App) unavailableWorkStatus(r *Request, space, id string, catalog *WorkStatusCatalog) error {
	err := &APIError{Status: 400, Code: "work_status_unavailable", Message: "This status is not available in the current space. Use a stable status ID from work_statuses_get or work_board_get.", Entity: "work_status", ID: id, Field: "status"}
	if r.workReads("work:read") {
		details := map[string]any{"statusRevision": catalog.Revision, "defaultStatus": catalog.DefaultStatus, "availableStatuses": catalog.Items, "recoveryTool": "work_statuses_get"}
		var replacement sql.NullString
		e := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT replacement_id FROM work_statuses WHERE space_id=? AND id=? AND retired=?"), space, id, true).Scan(&replacement)
		if e == nil && replacement.Valid && catalog.find(replacement.String) != nil {
			details["replacementStatus"] = replacement.String
		}
		err.Details = details
	} else {
		err.Message = "This status is not available in the bound space. The credential has no work:read permission to discover current statuses; do not guess other spaces or silently create a status."
	}
	return err
}

func (a *App) requireWorkStatus(r *Request, space, id string) (*WorkStatusDefinition, error) {
	catalog, err := a.loadWorkStatuses(r, space, false)
	if err != nil {
		return nil, err
	}
	if status := catalog.find(id); status != nil {
		return status, nil
	}
	return nil, a.unavailableWorkStatus(r, space, id, catalog)
}

func (a *App) getWorkStatuses(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	catalog, err := a.loadWorkStatuses(r, s.ID, true)
	if err != nil {
		return nil, err
	}
	catalog.CanEdit = s.CanEdit
	return ok(catalog), nil
}

func (a *App) getWorkRevision(r *Request) (*Response, error) {
	s, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	var revision, statuses int64
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT revision,status_revision FROM work_spaces WHERE space_id=?"), s.ID).Scan(&revision, &statuses); err != nil {
		return nil, err
	}
	return ok(map[string]string{"revision": strconv.FormatInt(revision, 10), "statusRevision": strconv.FormatInt(statuses, 10)}), nil
}

type workStatusCreate struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	Color       string `json:"color"`
	Description string `json:"description"`
}
type workStatusPatch struct {
	ID          string  `json:"id"`
	Name        *string `json:"name"`
	Type        *string `json:"type"`
	Color       *string `json:"color"`
	Description *string `json:"description"`
}
type workStatusDeletion struct {
	ID           string `json:"id"`
	MoveToStatus string `json:"moveToStatus"`
}
type workStatusEdit struct {
	ExpectedRevision string               `json:"expectedRevision"`
	Create           []workStatusCreate   `json:"create"`
	Patches          []workStatusPatch    `json:"patches"`
	Order            []string             `json:"order"`
	Deletions        []workStatusDeletion `json:"deletions"`
	DefaultStatus    *string              `json:"defaultStatus"`
}

func normalizeWorkStatus(item *WorkStatusDefinition) error {
	var err error
	item.Name, err = required(item.Name, "name", 80)
	if err != nil {
		return err
	}
	if !workStatusTypeValid(item.Type) {
		return invalid("type must be todo, doing, waiting, done or canceled.")
	}
	if !workStatusColor.MatchString(item.Color) {
		return invalid("color must be a six-digit hexadecimal color such as #5596bc.")
	}
	item.Color = strings.ToLower(item.Color)
	return bounded(item.Description, "description", 1000)
}

func (a *App) batchEditWorkStatuses(r *Request) (*Response, error) {
	s, err := r.workSpace(true)
	if err != nil {
		return nil, err
	}
	var in workStatusEdit
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if in.ExpectedRevision == "" || len(in.Create) > workStatusLimit || len(in.Patches) > workStatusLimit || len(in.Deletions) > workStatusLimit || len(in.Order) > workStatusLimit {
		return nil, invalid("expectedRevision is required; each status operation list is limited to 64 entries.")
	}
	if len(in.Create)+len(in.Patches)+len(in.Deletions) == 0 && in.Order == nil && in.DefaultStatus == nil {
		return nil, invalid("At least one status change is required.")
	}
	catalog, err := a.loadWorkStatuses(r, s.ID, true)
	if err != nil {
		return nil, err
	}
	if catalog.Revision != in.ExpectedRevision {
		return nil, &APIError{Status: 409, Code: "work_status_version_conflict", Message: "Status settings changed. Read work_statuses_get, compare your changes and keep the current stable IDs; do not replace the revision and blindly resend.", CurrentRevision: catalog.Revision, Entity: "work_statuses", Field: "expectedRevision"}
	}
	final := map[string]WorkStatusDefinition{}
	order := []string{}
	for _, item := range catalog.Items {
		final[item.ID] = item
		order = append(order, item.ID)
	}
	changed := map[string]bool{}
	for _, create := range in.Create {
		if !validID(create.ID) || changed[create.ID] {
			return nil, invalid("A new status requires a unique 32-character lowercase hexadecimal ID.")
		}
		var exists int
		if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_statuses WHERE space_id=? AND id=?"), s.ID, create.ID).Scan(&exists); err != nil {
			return nil, err
		}
		if exists != 0 {
			return nil, &APIError{Status: 409, Code: "work_status_id_conflict", Message: "This status ID already exists or was retired. Read the catalog to check an unconfirmed creation; retired IDs cannot be reused.", Entity: "work_status", ID: create.ID}
		}
		color := create.Color
		if color == "" {
			color = "#5596bc"
		}
		final[create.ID] = WorkStatusDefinition{ID: create.ID, Name: create.Name, Type: create.Type, Color: color, Description: create.Description}
		changed[create.ID] = true
		order = append(order, create.ID)
	}
	for _, patch := range in.Patches {
		item, exists := final[patch.ID]
		if !exists || changed[patch.ID] {
			return nil, invalid("Each patch must identify one existing status, once, in the current space.")
		}
		if patch.Name == nil && patch.Type == nil && patch.Color == nil && patch.Description == nil {
			return nil, invalid("Each status patch requires a changed field.")
		}
		if patch.Name != nil {
			item.Name = *patch.Name
		}
		if patch.Color != nil {
			item.Color = *patch.Color
		}
		if patch.Description != nil {
			item.Description = *patch.Description
		}
		if patch.Type != nil {
			if !validID(item.ID) && *patch.Type != item.Type {
				return nil, invalid("Built-in status types keep their original meaning. Rename them or create a custom status of the required type.")
			}
			item.Type = *patch.Type
		}
		final[patch.ID] = item
		changed[patch.ID] = true
	}
	deleted := map[string]bool{}
	for _, deletion := range in.Deletions {
		item := catalog.find(deletion.ID)
		if item == nil || changed[deletion.ID] || deleted[deletion.ID] {
			return nil, invalid("A deletion must identify an existing status once, without also patching it.")
		}
		if item.Total+item.ArchivedTotal > 0 && deletion.MoveToStatus == "" {
			e := &APIError{Status: 409, Code: "work_status_in_use", Message: "Choose moveToStatus to migrate both active and archived items before removing this status.", Entity: "work_status", ID: deletion.ID, Field: "moveToStatus"}
			if r.workReads("work:read") {
				e.Details = map[string]int{"total": item.Total, "archivedTotal": item.ArchivedTotal}
			}
			return nil, e
		}
		deleted[deletion.ID] = true
		delete(final, deletion.ID)
	}
	if len(final) < 1 || len(final) > workStatusLimit {
		return nil, invalid("Keep between 1 and 64 active statuses.")
	}
	for _, deletion := range in.Deletions {
		if deletion.MoveToStatus != "" {
			if _, exists := final[deletion.MoveToStatus]; !exists {
				return nil, invalid("moveToStatus must be a surviving status in this space, not another deleted status.")
			}
		}
	}
	defaultStatus := catalog.DefaultStatus
	if in.DefaultStatus != nil {
		defaultStatus = *in.DefaultStatus
	}
	if _, exists := final[defaultStatus]; !exists {
		return nil, &APIError{Status: 400, Code: "work_default_status_required", Message: "Choose defaultStatus from the surviving statuses in the same batch.", Field: "defaultStatus"}
	}
	if in.Order != nil {
		order = in.Order
	} else {
		kept := []string{}
		for _, id := range order {
			if !deleted[id] {
				kept = append(kept, id)
			}
		}
		order = kept
	}
	if len(order) != len(final) {
		return nil, invalid("order must contain every surviving status ID exactly once.")
	}
	seen, names := map[string]bool{}, map[string]bool{}
	for i, id := range order {
		item, exists := final[id]
		if !exists || seen[id] {
			return nil, invalid("order must contain every surviving status ID exactly once.")
		}
		seen[id] = true
		if err = normalizeWorkStatus(&item); err != nil {
			return nil, err
		}
		key := strings.ToLower(item.Name)
		if names[key] {
			return nil, &APIError{Status: 409, Code: "work_status_name_conflict", Message: "Active status names must be unique within the space.", Field: "name"}
		}
		names[key] = true
		item.Position, item.IsDefault = i, id == defaultStatus
		final[id] = item
	}
	// Temporary non-user keys allow swapping two names under the unique index.
	// The entire operation (including item migration) shares the request transaction.
	staging := strings.Repeat("_", 81) + newID()
	for _, item := range catalog.Items {
		if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_statuses SET name_key=? WHERE space_id=? AND id=?"), staging+item.ID, s.ID, item.ID); err != nil {
			return nil, err
		}
	}
	for _, deletion := range in.Deletions {
		var target any
		if deletion.MoveToStatus != "" {
			target = deletion.MoveToStatus
		}
		if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_statuses SET retired=?,replacement_id=? WHERE space_id=? AND id=?"), true, target, s.ID, deletion.ID); err != nil {
			return nil, err
		}
	}
	for _, id := range order {
		item := final[id]
		if catalog.find(id) == nil {
			_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_statuses(space_id,id,name,name_key,status_type,color,description,sort_order) VALUES(?,?,?,?,?,?,?,?)"), s.ID, id, item.Name, strings.ToLower(item.Name), item.Type, item.Color, item.Description, item.Position)
		} else {
			_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_statuses SET name=?,name_key=?,status_type=?,color=?,description=?,sort_order=? WHERE space_id=? AND id=?"), item.Name, strings.ToLower(item.Name), item.Type, item.Color, item.Description, item.Position, s.ID, id)
		}
		if err != nil {
			return nil, err
		}
		if old := catalog.find(id); old != nil && old.Type != item.Type {
			stamp := workStamp()
			if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_items SET revision=revision+1,updated_at=? WHERE space_id=? AND status=?"), stamp, s.ID, id); err != nil {
				return nil, err
			}
			if err = a.recordWorkStatusDefinitionChanges(r, s.ID, stamp, old, &item); err != nil {
				return nil, err
			}
		}
	}
	migrated := 0
	for _, deletion := range in.Deletions {
		if deletion.MoveToStatus == "" {
			continue
		}
		for _, archived := range []bool{false, true} {
			rows, e := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id FROM work_items WHERE space_id=? AND status=? AND archived=? ORDER BY sort_order,id"), s.ID, deletion.ID, archived)
			if e != nil {
				return nil, e
			}
			ids := []string{}
			for rows.Next() {
				var id string
				if e = rows.Scan(&id); e != nil {
					rows.Close()
					return nil, e
				}
				ids = append(ids, id)
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return nil, e
			}
			rank, e := a.appendWorkRank(r, s.ID, deletion.MoveToStatus, archived, "")
			if e != nil {
				return nil, e
			}
			for _, id := range ids {
				stamp := workStamp()
				if _, e = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_items SET status=?,sort_order=?,revision=revision+1,updated_at=? WHERE id=? AND space_id=?"), deletion.MoveToStatus, rank, stamp, id, s.ID); e != nil {
					return nil, e
				}
				newStatus := final[deletion.MoveToStatus]
				if e = a.recordWorkActivity(r, s.ID, id, "status_migrate", stamp, []WorkActivityChange{workActivityStatusChange(catalog.find(deletion.ID), &newStatus)}); e != nil {
					return nil, e
				}
				rank += workRankStep
				migrated++
			}
		}
	}
	if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_spaces SET status_revision=status_revision+1,default_status=? WHERE space_id=?"), defaultStatus, s.ID); err != nil {
		return nil, err
	}
	boardRevision, err := a.bumpWorkRevision(r, s.ID)
	if err != nil {
		return nil, err
	}
	updated, err := a.loadWorkStatuses(r, s.ID, r.workReads("work:read"))
	if err != nil {
		return nil, err
	}
	if !r.workReads("work:read") {
		return ok(map[string]any{"revision": updated.Revision, "boardRevision": boardRevision, "applied": true}), nil
	}
	updated.CanEdit = s.CanEdit
	_ = migrated // Counts are reflected in the returned catalog without exposing write-only data.
	return ok(updated), nil
}

// Preserve the original interpretation of legacy requests during creation replay.
func legacyWorkCreateHash(in workCreateInput) string {
	if in.Status == "" {
		in.Status = "todo"
	}
	return workPayloadHash(in)
}

func (a *App) existingWorkCreation(r *Request, space string, in workCreateInput, hash string) (*WorkItem, error) {
	var existingSpace, existingHash string
	var version int
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT space_id,create_hash,create_hash_version FROM work_items WHERE id=?"), in.ID).Scan(&existingSpace, &existingHash, &version)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if version == 1 {
		hash = legacyWorkCreateHash(in)
	}
	if existingSpace != space || existingHash != hash {
		return nil, workConflict("work_id_conflict", "This ID is already used by a different create request.", "")
	}
	return a.loadWorkItem(r, space, in.ID)
}
