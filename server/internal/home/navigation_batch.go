package home

import (
	"database/sql"
	"encoding/json"
	"slices"
	"strconv"
	"strings"
)

const maxBatchLinks = 500

type batchLinksInput struct {
	LinkIDs          []string        `json:"linkIds"`
	ExpectedRevision string          `json:"expectedRevision"`
	Operation        string          `json:"operation"`
	CategoryID       json.RawMessage `json:"categoryId"`
	Tags             []string        `json:"tags"`
	IsFavorite       *bool           `json:"isFavorite"`
}

type batchLinkState struct {
	id       string
	category sql.NullString
	tags     []string
	favorite bool
}

// The route's write gate, current authorization and transaction cover the whole
// batch. Never call updateLink here: these edits must preserve URLs, icon intent,
// icon jobs, endpoints and every other unrelated field.
func (a *App) batchUpdateLinks(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), true)
	if err != nil {
		return nil, err
	}
	var in batchLinksInput
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if len(in.LinkIDs) == 0 || len(in.LinkIDs) > maxBatchLinks {
		return nil, invalid("Select between 1 and 500 bookmarks.")
	}
	seenIDs := map[string]bool{}
	for _, id := range in.LinkIDs {
		if !validID(id) || seenIDs[id] {
			return nil, invalid("Bookmark IDs must be valid and unique.")
		}
		seenIDs[id] = true
	}
	if in.ExpectedRevision == "" {
		return nil, invalid("expectedRevision is required.")
	}
	if in.ExpectedRevision != strconv.FormatInt(space.DataRevision, 10) {
		return nil, &APIError{Status: 409, Code: "navigation_version_conflict", Message: "The bookmark list changed. Reload it and select the bookmarks again."}
	}
	var categoryID *string
	tags := []string{}
	switch in.Operation {
	case "move":
		if len(in.CategoryID) == 0 || len(in.Tags) != 0 || in.IsFavorite != nil {
			return nil, invalid("Moving bookmarks requires only categoryId, which may be null.")
		}
		if err = json.Unmarshal(in.CategoryID, &categoryID); err != nil || categoryID != nil && !validID(*categoryID) {
			return nil, invalid("categoryId must be a category ID or null.")
		}
		if categoryID != nil {
			var exists bool
			if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM categories WHERE id=? AND space_id=?)"), *categoryID, space.ID).Scan(&exists); err != nil {
				return nil, err
			}
			if !exists {
				return nil, invalid("Category must belong to the current space.")
			}
		}
	case "add-tags", "remove-tags":
		if len(in.Tags) == 0 || len(in.Tags) > 32 || len(in.CategoryID) != 0 || in.IsFavorite != nil {
			return nil, invalid("Choose between 1 and 32 tags for this operation.")
		}
		seen := map[string]bool{}
		for _, raw := range in.Tags {
			tag, err := required(raw, "tag", 40)
			if err != nil {
				return nil, err
			}
			if !seen[tag] {
				seen[tag] = true
				tags = append(tags, tag)
			}
		}
	case "favorite":
		if in.IsFavorite == nil || len(in.CategoryID) != 0 || len(in.Tags) != 0 {
			return nil, invalid("A favorite operation requires only isFavorite.")
		}
	default:
		return nil, invalid("Unknown bookmark batch operation.")
	}
	args := []any{space.ID}
	for _, id := range in.LinkIDs {
		args = append(args, id)
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(in.LinkIDs)), ",")
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id,category_id,tags,is_favorite FROM links WHERE space_id=? AND id IN ("+placeholders+")"), args...)
	if err != nil {
		return nil, err
	}
	current := []batchLinkState{}
	for rows.Next() {
		var item batchLinkState
		var encoded []byte
		if err = rows.Scan(&item.id, &item.category, &encoded, &item.favorite); err != nil {
			break
		}
		if err = json.Unmarshal(encoded, &item.tags); err != nil {
			break
		}
		if item.tags == nil {
			item.tags = []string{}
		}
		current = append(current, item)
	}
	rowErr := rows.Err()
	closeErr := rows.Close()
	if err != nil {
		return nil, err
	}
	if rowErr != nil {
		return nil, rowErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if len(current) != len(in.LinkIDs) {
		// A foreign ID and a deleted ID are deliberately indistinguishable.
		return nil, missing()
	}
	changes := []batchLinkState{}
	for _, before := range current {
		after := before
		switch in.Operation {
		case "move":
			after.category = sql.NullString{}
			if categoryID != nil {
				after.category = sql.NullString{String: *categoryID, Valid: true}
			}
		case "add-tags":
			after.tags = slices.Clone(before.tags)
			for _, tag := range tags {
				if !slices.Contains(after.tags, tag) {
					after.tags = append(after.tags, tag)
				}
			}
			if len(after.tags) > 32 {
				return nil, invalid("This operation would give a bookmark more than 32 tags. No bookmarks were changed.")
			}
		case "remove-tags":
			after.tags = []string{}
			for _, tag := range before.tags {
				if !slices.Contains(tags, tag) {
					after.tags = append(after.tags, tag)
				}
			}
		case "favorite":
			after.favorite = *in.IsFavorite
		}
		if before.category != after.category || before.favorite != after.favorite || !slices.Equal(before.tags, after.tags) {
			changes = append(changes, after)
		}
	}
	updated := nowUTC()
	for _, item := range changes {
		var result sql.Result
		switch in.Operation {
		case "move":
			var category any
			if item.category.Valid {
				category = item.category.String
			}
			result, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE links SET category_id=?,updated_at=? WHERE id=? AND space_id=?"), category, updated, item.id, space.ID)
		case "add-tags", "remove-tags":
			result, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE links SET tags=?,updated_at=? WHERE id=? AND space_id=?"), jsonString(item.tags), updated, item.id, space.ID)
		case "favorite":
			result, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE links SET is_favorite=?,updated_at=? WHERE id=? AND space_id=?"), item.favorite, updated, item.id, space.ID)
		}
		if err != nil {
			return nil, err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return nil, err
		}
		if n != 1 {
			return nil, conflict("The bookmark list changed. Reload it before retrying.")
		}
	}
	revision := space.DataRevision
	if len(changes) > 0 {
		if err = a.touchNavigation(r, space.ID); err != nil {
			return nil, err
		}
		revision++
	}
	return ok(map[string]any{"selectedCount": len(in.LinkIDs), "updatedCount": len(changes), "revision": strconv.FormatInt(revision, 10)}), nil
}
