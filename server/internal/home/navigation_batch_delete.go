package home

import (
	"encoding/json"
	"strings"
)

// Validate the complete selection before deleting. Surviving siblings keep their
// stored ranks unless a later move normalizes their group in the same transaction.
func (a *App) deleteNavigationRows(r *Request, spaceID string, input navigationEditInput) error {
	if len(input.DeleteLinkIDs) == 0 {
		return nil
	}
	deleted := make(map[string]bool, len(input.DeleteLinkIDs))
	for _, id := range input.DeleteLinkIDs {
		if !validID(id) || deleted[id] {
			return navigationEditError(invalid("Deleted bookmark IDs must be valid and unique."), "link", id, "id")
		}
		deleted[id] = true
	}
	conflicting := func(id string) error {
		return navigationEditError(invalid("A deleted bookmark cannot also be created, edited, moved or used as a move anchor in the same batch."), "link", id, "deleteLinkIds")
	}
	for _, row := range input.CreateLinks {
		if deleted[row.ID] {
			return conflicting(row.ID)
		}
	}
	for _, row := range input.Links {
		if deleted[row.ID] {
			return conflicting(row.ID)
		}
	}
	for _, move := range input.Moves {
		if move.Kind != "link" {
			continue
		}
		if deleted[move.ID] {
			return conflicting(move.ID)
		}
		var anchor string
		if json.Unmarshal(move.BeforeID, &anchor) == nil && deleted[anchor] {
			return conflicting(anchor)
		}
	}
	args := []any{spaceID}
	for _, id := range input.DeleteLinkIDs {
		args = append(args, id)
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(input.DeleteLinkIDs)), ",")
	var count int
	if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM links WHERE space_id=? AND id IN ("+placeholders+")"), args...).Scan(&count); err != nil {
		return err
	}
	if count != len(input.DeleteLinkIDs) {
		// Missing and foreign rows are indistinguishable, including to write-only callers.
		return missing()
	}
	if err := a.recordWorkBookmarkRemovals(r, spaceID, input.DeleteLinkIDs); err != nil {
		return err
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM links WHERE space_id=? AND id IN ("+placeholders+")"), args...)
	if err != nil {
		return err
	}
	countDeleted, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if countDeleted != int64(len(input.DeleteLinkIDs)) {
		return conflict("The bookmark list changed. Reload it before retrying.")
	}
	return nil
}
