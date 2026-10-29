package home

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"sort"
	"strconv"
	"strings"
)

type navigationEditRow struct {
	ID    string          `json:"id"`
	Patch json.RawMessage `json:"patch"`
}
type navigationEditInput struct {
	ExpectedRevision string               `json:"expectedRevision"`
	Categories       []navigationEditRow  `json:"categories"`
	Links            []navigationEditRow  `json:"links"`
	Moves            []navigationEditMove `json:"moves"`
}
type navigationEditLink struct {
	Old        Link
	Next       Link
	Canonical  string
	IconIntent bool
}

// The route supplies one authorization snapshot, write gate and transaction.
func (a *App) batchEditNavigation(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), true)
	if err != nil {
		return nil, err
	}
	var input navigationEditInput
	if err = r.decode(&input); err != nil {
		return nil, err
	}
	count := len(input.Categories) + len(input.Links) + len(input.Moves)
	if count == 0 || count > maxBatchLinks {
		return nil, invalid(fmt.Sprintf("A batch must contain between 1 and %d field patches and moves combined.", maxBatchLinks))
	}
	revision := strconv.FormatInt(space.DataRevision, 10)
	if input.ExpectedRevision == "" {
		return nil, invalid("expectedRevision is required.")
	}
	if input.ExpectedRevision != revision {
		return nil, &APIError{Status: 409, Code: "navigation_version_conflict", Message: "The bookmark list changed. Reload it and review your edits.", CurrentRevision: revision}
	}
	data, err := a.readNavigation(r, space.ID)
	if err != nil {
		return nil, err
	}
	categories := map[string]Category{}
	links := map[string]Link{}
	for _, c := range data.Categories {
		categories[c.ID] = c
	}
	for _, l := range data.Links {
		links[l.ID] = l
	}
	changedCategories := make([]Category, 0)
	changedLinks := make([]Link, 0)
	drafts := make([]navigationEditLink, 0)
	canonicalByID := map[string]string{}
	edited := map[string]bool{}
	seenLinks := map[string]bool{}
	for _, row := range input.Categories {
		if row.ID == "" || edited[row.ID] {
			return nil, navigationEditError(invalid("A category ID is missing or repeated."), "category", row.ID, "id")
		}
		edited[row.ID] = true
		old, exists := categories[row.ID]
		if !exists {
			return nil, navigationEditError(missing(), "category", row.ID, "id")
		}
		fields, err := navigationEditPatch(row.Patch, []string{"name", "icon", "parentId", "sortOrder"})
		if err != nil {
			return nil, navigationEditError(err, "category", row.ID, "patch")
		}
		in := categoryInput{Name: old.Name, Icon: old.Icon, ParentID: navigationEditCopyID(old.ParentID), SortOrder: old.SortOrder}
		for _, field := range []string{"name", "icon", "parentId", "sortOrder"} {
			value, ok := fields[field]
			if !ok {
				continue
			}
			var target any
			switch field {
			case "name":
				target = &in.Name
			case "icon":
				target = &in.Icon
			case "parentId":
				target = &in.ParentID
			case "sortOrder":
				target = &in.SortOrder
			}
			if err = navigationEditValue(value, target, field == "parentId"); err != nil {
				return nil, navigationEditError(err, "category", row.ID, field)
			}
		}
		in.ParentID = navigationEditNormalizeID(in.ParentID)
		in.Name, err = required(in.Name, "name", 80)
		if err != nil {
			return nil, navigationEditError(err, "category", row.ID, "name")
		}
		in.Icon, err = a.validSpaceIcon(r, space.ID, in.Icon, "lucide:folder")
		if err != nil {
			return nil, navigationEditError(err, "category", row.ID, "icon")
		}
		if err = sortOrder(in.SortOrder); err != nil {
			return nil, navigationEditError(err, "category", row.ID, "sortOrder")
		}
		next := old
		next.Name, next.Icon, next.ParentID, next.SortOrder = in.Name, in.Icon, in.ParentID, in.SortOrder
		categories[row.ID] = next
	}
	if err = navigationEditCategoryTree(categories, edited); err != nil {
		return nil, err
	}
	for _, row := range input.Links {
		if row.ID == "" || seenLinks[row.ID] {
			return nil, navigationEditError(invalid("A link ID is missing or repeated."), "link", row.ID, "id")
		}
		seenLinks[row.ID] = true
		old, exists := links[row.ID]
		if !exists {
			return nil, navigationEditError(missing(), "link", row.ID, "id")
		}
		fields, err := navigationEditPatch(row.Patch, []string{"categoryId", "title", "url", "description", "icon", "iconMode", "tags", "isFavorite", "sortOrder", "endpoints"})
		if err != nil {
			return nil, navigationEditError(err, "link", row.ID, "patch")
		}
		in := linkInput{CategoryID: navigationEditCopyID(old.CategoryID), Title: old.Title, URL: old.URL, Description: old.Description, Icon: old.Icon, Tags: append([]string(nil), old.Tags...), IsFavorite: old.IsFavorite, SortOrder: old.SortOrder, Endpoints: append([]Endpoint(nil), old.Endpoints...)}
		for _, field := range []string{"categoryId", "title", "url", "description", "icon", "iconMode", "tags", "isFavorite", "sortOrder", "endpoints"} {
			value, ok := fields[field]
			if !ok {
				continue
			}
			var target any
			switch field {
			case "categoryId":
				target = &in.CategoryID
			case "title":
				target = &in.Title
			case "url":
				target = &in.URL
			case "description":
				target = &in.Description
			case "icon":
				target = &in.Icon
			case "iconMode":
				target = &in.IconMode
			case "tags":
				target = &in.Tags
			case "isFavorite":
				target = &in.IsFavorite
			case "sortOrder":
				target = &in.SortOrder
			case "endpoints":
				target = &in.Endpoints
			}
			if err = navigationEditValue(value, target, field == "categoryId"); err != nil {
				return nil, navigationEditError(err, "link", row.ID, field)
			}
		}
		in.CategoryID = navigationEditNormalizeID(in.CategoryID)
		if in.CategoryID != nil {
			if _, ok := categories[*in.CategoryID]; !ok {
				return nil, navigationEditError(missing(), "link", row.ID, "categoryId")
			}
		}
		if in.IconMode == "" {
			in.IconMode = iconModeInput(old.IconMode)
			if in.Icon != "" && in.Icon != old.Icon {
				in.IconMode = "manual"
			}
		}
		if in.Icon == "" {
			in.Icon = old.Icon
		}
		canonical, err := a.validateLink(r, space.ID, &in)
		if err != nil {
			return nil, navigationEditError(err, "link", row.ID, navigationEditLinkField(err))
		}
		next := old
		next.CategoryID, next.Title, next.URL, next.Description = in.CategoryID, in.Title, in.URL, in.Description
		next.Icon, next.IconMode, next.Tags = in.Icon, string(in.IconMode), in.Tags
		next.IsFavorite, next.SortOrder, next.Endpoints = in.IsFavorite, in.SortOrder, in.Endpoints
		links[row.ID] = next
		canonicalByID[row.ID] = canonical
	}
	if err = navigationEditMoves(input.Moves, categories, links, r.Settings.Language); err != nil {
		return nil, err
	}
	// Compare only the final state. Moves can normalize a complete sibling group,
	// including records outside the client's visible page, without a full write payload.
	for _, old := range data.Categories {
		next := categories[old.ID]
		if old.Name != next.Name || old.Icon != next.Icon || old.SortOrder != next.SortOrder || !navigationEditSameID(old.ParentID, next.ParentID) {
			changedCategories = append(changedCategories, next)
		}
	}
	for _, old := range data.Links {
		next := links[old.ID]
		if navigationEditSameLink(old, next) {
			continue
		}
		canonical, exists := canonicalByID[old.ID]
		if !exists {
			canonical, err = canonicalURL(next.URL)
			if err != nil {
				return nil, err
			}
		}
		drafts = append(drafts, navigationEditLink{Old: old, Next: next, Canonical: canonical, IconIntent: old.URL != next.URL || old.Icon != next.Icon || old.IconMode != next.IconMode})
	}
	for _, c := range changedCategories {
		result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE categories SET parent_id=?,name=?,icon=?,sort_order=? WHERE id=? AND space_id=?"), nullableID(c.ParentID), c.Name, c.Icon, c.SortOrder, c.ID, space.ID)
		if err != nil {
			return nil, err
		}
		if err = navigationEditAffected(result); err != nil {
			return nil, navigationEditError(err, "category", c.ID, "")
		}
	}
	origins := map[string]bool{}
	automaticChanged := false
	updatedAt := nowUTC()
	for _, draft := range drafts {
		link := draft.Next
		var oldOrigin string
		if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT icon_origin FROM links WHERE id=? AND space_id=?"), link.ID, space.ID).Scan(&oldOrigin); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, navigationEditError(missing(), "link", link.ID, "id")
			}
			return nil, err
		}
		origin := oldOrigin
		if draft.IconIntent {
			if link.IconMode == "auto" && draft.Old.IconMode == "auto" && automaticIconOrigin(link.URL) != oldOrigin {
				link.Icon = "lucide:link"
			}
			origin, err = a.prepareAutomaticLinkIcon(r, &link)
			if err != nil {
				return nil, navigationEditError(err, "link", link.ID, "icon")
			}
		}
		if navigationEditSameLink(draft.Old, link) {
			continue
		}
		link.UpdatedAt = updatedAt
		result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE links SET category_id=?,title=?,url=?,canonical_url=?,description=?,icon=?,icon_mode=?,icon_origin=?,tags=?,is_favorite=?,sort_order=?,endpoints=?,updated_at=? WHERE id=? AND space_id=?"), nullableID(link.CategoryID), link.Title, link.URL, draft.Canonical, link.Description, link.Icon, link.IconMode, origin, jsonString(link.Tags), link.IsFavorite, link.SortOrder, jsonString(link.Endpoints), link.UpdatedAt, link.ID, space.ID)
		if err != nil {
			return nil, err
		}
		if err = navigationEditAffected(result); err != nil {
			return nil, navigationEditError(err, "link", link.ID, "")
		}
		changedLinks = append(changedLinks, link)
		if draft.IconIntent {
			automaticChanged = true
			if link.IconMode == "auto" && origin != "" {
				origins[origin] = true
			}
		}
	}
	if automaticChanged {
		if err = a.cleanAutomaticIconJobs(r, space.ID); err != nil {
			return nil, err
		}
		for origin := range origins {
			if err = a.queueAutomaticIcon(r, space.ID, origin); err != nil {
				return nil, err
			}
		}
	}
	updatedCount := len(changedCategories) + len(changedLinks)
	if updatedCount > 0 {
		if err = a.touchNavigation(r, space.ID); err != nil {
			return nil, err
		}
		revision = strconv.FormatInt(space.DataRevision+1, 10)
	}
	return ok(map[string]any{"updatedCount": updatedCount, "revision": revision, "categories": changedCategories, "links": changedLinks}), nil
}
func navigationEditPatch(raw json.RawMessage, allowed []string) (map[string]json.RawMessage, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' {
		return nil, invalid("patch must be a non-empty object.")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || len(fields) == 0 {
		return nil, invalid("patch must be a non-empty object.")
	}
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if !slices.Contains(allowed, key) {
			return nil, invalid(fmt.Sprintf("Unknown patch field %q.", key))
		}
	}
	return fields, nil
}
func navigationEditValue(raw json.RawMessage, target any, nullable bool) error {
	if !nullable && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return invalid("This field cannot be null.")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return invalid("Invalid field value: " + err.Error())
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return invalid("A field must contain one JSON value.")
	}
	return nil
}
func navigationEditCopyID(v *string) *string {
	if v == nil {
		return nil
	}
	c := *v
	return &c
}
func navigationEditNormalizeID(v *string) *string {
	if v == nil {
		return nil
	}
	c := strings.TrimSpace(*v)
	if c == "" {
		return nil
	}
	return &c
}
func navigationEditSameID(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
func navigationEditSameLink(a, b Link) bool {
	return navigationEditSameID(a.CategoryID, b.CategoryID) && a.Title == b.Title && a.URL == b.URL && a.Description == b.Description && a.Icon == b.Icon && a.IconMode == b.IconMode && a.IsFavorite == b.IsFavorite && a.SortOrder == b.SortOrder && slices.Equal(a.Tags, b.Tags) && slices.Equal(a.Endpoints, b.Endpoints)
}
func navigationEditError(err error, entity, id, field string) error {
	var api *APIError
	if errors.As(err, &api) {
		copy := *api
		copy.Entity, copy.ID = entity, id
		if field != "" {
			copy.Field = field
		}
		return &copy
	}
	return err
}
func navigationEditLinkField(err error) string {
	var api *APIError
	if !errors.As(err, &api) {
		return ""
	}
	message := strings.ToLower(api.Message)
	for _, item := range []struct{ needle, field string }{{"title", "title"}, {"description", "description"}, {"category", "categoryId"}, {"sort", "sortOrder"}, {"tag", "tags"}, {"endpoint", "endpoints"}, {"probe", "endpoints"}, {"route", "endpoints"}, {"icon", "icon"}, {"url", "url"}} {
		if strings.Contains(message, item.needle) {
			return item.field
		}
	}
	return ""
}
func navigationEditAffected(result sql.Result) error {
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return &APIError{Status: 409, Code: "navigation_version_conflict", Message: "The bookmark list changed. Reload it and review your edits."}
	}
	return nil
}
func navigationEditCategoryTree(categories map[string]Category, edited map[string]bool) error {
	ids := make([]string, 0, len(categories))
	for id := range categories {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, start := range ids {
		path := make([]string, 0, 33)
		seen := map[string]bool{}
		id := start
		for {
			if seen[id] {
				return navigationEditError(invalid("Category parents must not form a cycle."), "category", navigationEditTreeCause(path, edited, start), "parentId")
			}
			seen[id] = true
			c, exists := categories[id]
			if !exists {
				return navigationEditError(missing(), "category", navigationEditTreeCause(path, edited, start), "parentId")
			}
			path = append(path, id)
			if len(path) > 32 {
				return navigationEditError(invalid("Categories cannot be nested more than 32 levels."), "category", navigationEditTreeCause(path, edited, start), "parentId")
			}
			if c.ParentID == nil || *c.ParentID == "" {
				break
			}
			id = *c.ParentID
		}
	}
	return nil
}
func navigationEditTreeCause(path []string, edited map[string]bool, fallback string) string {
	for _, id := range path {
		if edited[id] {
			return id
		}
	}
	return fallback
}
