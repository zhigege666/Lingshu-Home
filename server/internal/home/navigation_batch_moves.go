package home

import (
	"encoding/json"
	"slices"
	"sort"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// RawMessage distinguishes a required explicit null (append / Uncategorized)
// from a missing field and lets the shared HTTP/MCP handler reject ambiguous moves.
type navigationEditMove struct {
	Kind       string          `json:"kind"`
	ID         string          `json:"id"`
	BeforeID   json.RawMessage `json:"beforeId"`
	CategoryID json.RawMessage `json:"categoryId"`
}

func navigationMoveID(raw json.RawMessage) (*string, error) {
	if len(raw) == 0 {
		return nil, invalid("An explicit ID or null is required.")
	}
	var id *string
	if err := navigationEditValue(raw, &id, true); err != nil {
		return nil, err
	}
	if id != nil && (strings.TrimSpace(*id) == "" || strings.TrimSpace(*id) != *id) {
		return nil, invalid("An ID cannot be empty or padded with whitespace.")
	}
	return id, nil
}

func navigationOrderKey(id *string) string {
	if id == nil {
		return ""
	}
	return *id
}

// Fields and membership changes have already been merged and validated. Moves
// then operate on complete sibling sequences, never a filtered client projection.
func navigationEditMoves(moves []navigationEditMove, categories map[string]Category, links map[string]Link, locale string) error {
	if len(moves) == 0 {
		return nil
	}
	collator := collate.New(language.Make(locale))
	categoryRows := make([]Category, 0, len(categories))
	linkRows := make([]Link, 0, len(links))
	for _, row := range categories {
		categoryRows = append(categoryRows, row)
	}
	for _, row := range links {
		linkRows = append(linkRows, row)
	}
	sort.Slice(categoryRows, func(i, j int) bool {
		a, b := categoryRows[i], categoryRows[j]
		if a.SortOrder != b.SortOrder {
			return a.SortOrder < b.SortOrder
		}
		if order := collator.CompareString(a.Name, b.Name); order != 0 {
			return order < 0
		}
		return a.ID < b.ID
	})
	sort.Slice(linkRows, func(i, j int) bool {
		a, b := linkRows[i], linkRows[j]
		if a.SortOrder != b.SortOrder {
			return a.SortOrder < b.SortOrder
		}
		if order := collator.CompareString(a.Title, b.Title); order != 0 {
			return order < 0
		}
		return a.ID < b.ID
	})
	groups := map[string]map[string][]string{"category": {}, "link": {}}
	for _, row := range categoryRows {
		key := navigationOrderKey(row.ParentID)
		groups["category"][key] = append(groups["category"][key], row.ID)
	}
	for _, row := range linkRows {
		key := navigationOrderKey(row.CategoryID)
		groups["link"][key] = append(groups["link"][key], row.ID)
	}
	original := map[string]map[string][]string{"category": {}, "link": {}}
	for kind, values := range groups {
		for key, ids := range values {
			original[kind][key] = slices.Clone(ids)
		}
	}
	seen := map[string]bool{}
	for _, move := range moves {
		fail := func(err error, field string) error { return navigationEditError(err, move.Kind, move.ID, field) }
		if move.Kind != "category" && move.Kind != "link" {
			return fail(invalid("Move kind must be category or link."), "kind")
		}
		identity := move.Kind + ":" + move.ID
		if move.ID == "" || seen[identity] {
			return fail(invalid("A move ID is missing or repeated."), "id")
		}
		seen[identity] = true
		before, err := navigationMoveID(move.BeforeID)
		if err != nil {
			return fail(err, "beforeId")
		}
		if before != nil && *before == move.ID {
			return fail(invalid("A move cannot use itself as its anchor."), "beforeId")
		}
		var source, target string
		var targetID *string
		if move.Kind == "category" {
			if len(move.CategoryID) != 0 {
				return fail(invalid("Category moves cannot change their parent; use a parentId patch."), "categoryId")
			}
			row, exists := categories[move.ID]
			if !exists {
				return fail(missing(), "id")
			}
			source, target = navigationOrderKey(row.ParentID), navigationOrderKey(row.ParentID)
			if before != nil {
				anchor, exists := categories[*before]
				if !exists {
					return fail(missing(), "beforeId")
				}
				if !navigationEditSameID(row.ParentID, anchor.ParentID) {
					return fail(invalid("Category anchors must have the same parent after field patches."), "beforeId")
				}
			}
		} else {
			row, exists := links[move.ID]
			if !exists {
				return fail(missing(), "id")
			}
			targetID, err = navigationMoveID(move.CategoryID)
			if err != nil {
				return fail(err, "categoryId")
			}
			if targetID != nil {
				if _, exists := categories[*targetID]; !exists {
					return fail(missing(), "categoryId")
				}
			}
			source, target = navigationOrderKey(row.CategoryID), navigationOrderKey(targetID)
			if before != nil {
				anchor, exists := links[*before]
				if !exists {
					return fail(missing(), "beforeId")
				}
				if !navigationEditSameID(targetID, anchor.CategoryID) {
					return fail(invalid("The link anchor must be in the target category after preceding moves."), "beforeId")
				}
			}
		}
		from := groups[move.Kind][source]
		at := slices.Index(from, move.ID)
		if at < 0 {
			return fail(invalid("The source is not in its expected group."), "id")
		}
		// Leave a true no-op untouched, including legacy tied sortOrder values.
		if source == target && (before == nil && at == len(from)-1 || before != nil && at+1 < len(from) && from[at+1] == *before) {
			continue
		}
		groups[move.Kind][source] = append(from[:at:at], from[at+1:]...)
		to := groups[move.Kind][target]
		index := len(to)
		if before != nil {
			index = slices.Index(to, *before)
			if index < 0 {
				return fail(invalid("The anchor is not in the target group."), "beforeId")
			}
		}
		to = slices.Insert(to, index, move.ID)
		groups[move.Kind][target] = to
		if move.Kind == "link" {
			row := links[move.ID]
			row.CategoryID = navigationEditCopyID(targetID)
			links[move.ID] = row
		}
	}
	for kind, values := range groups {
		for key, ids := range values {
			if slices.Equal(ids, original[kind][key]) {
				continue
			}
			if len(ids) > 1000001 {
				return invalid("The category contains too many records to assign a valid manual order.")
			}
			for rank, id := range ids {
				if kind == "category" {
					row := categories[id]
					row.SortOrder = rank
					categories[id] = row
				} else {
					row := links[id]
					row.SortOrder = rank
					links[id] = row
				}
			}
		}
	}
	return nil
}
