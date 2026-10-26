package home

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

func defaultPageConfig() map[string]any {
	return map[string]any{
		"schemaVersion": 2, "pageTheme": map[string]any{"id": "builtin/dashboard"},
		"appearance": map[string]any{"colorMode": "system", "density": "comfortable"},
		"chrome":     defaultPageChrome(),
		"bindings":   map[string]any{"navigation": map[string]any{"datasetId": "local-navigation", "space": "current-page-space", "query": map[string]any{}}},
		"views": []any{
			map[string]any{"id": "categories", "panel": map[string]any{"id": "builtin/category-navigation"}, "inputs": map[string]any{"collection": "navigation"}, "interactionScope": "primary-navigation", "settings": map[string]any{}},
			map[string]any{"id": "search", "panel": map[string]any{"id": "builtin/search"}, "inputs": map[string]any{}, "interactionScope": "primary-navigation", "settings": map[string]any{}},
			map[string]any{"id": "favorites", "panel": map[string]any{"id": "builtin/favorites"}, "inputs": map[string]any{"collection": "navigation"}, "interactionScope": "primary-navigation", "settings": map[string]any{"variant": "cards"}},
			map[string]any{"id": "navigation-main", "panel": map[string]any{"id": "builtin/navigation"}, "inputs": map[string]any{"collection": "navigation"}, "interactionScope": "primary-navigation", "settings": map[string]any{"variant": "cards", "groupBy": "category"}},
		},
		"layout": map[string]any{"mode": "regions-grid", "gap": 16, "grid": map[string]any{"columns": 24}, "placements": map[string]any{
			"categories":      map[string]any{"base": map[string]any{"kind": "region", "region": "left", "order": 0}, "overrides": map[string]any{"narrow": map[string]any{"kind": "region", "region": "top", "order": 1}}},
			"search":          map[string]any{"base": map[string]any{"kind": "region", "region": "top", "order": 0, "size": map[string]any{"widthPx": 340, "maxWidthPx": 360}}},
			"favorites":       map[string]any{"base": map[string]any{"kind": "grid", "region": "main", "x": 0, "y": 0, "w": 24, "h": 4, "heightMode": "content", "locked": false}, "overrides": map[string]any{"narrow": map[string]any{"kind": "flow", "region": "main", "order": 0}}},
			"navigation-main": map[string]any{"base": map[string]any{"kind": "grid", "region": "main", "x": 0, "y": 4, "w": 24, "h": 12, "heightMode": "content", "locked": false}, "overrides": map[string]any{"narrow": map[string]any{"kind": "flow", "region": "main", "order": 1}}},
		}},
	}
}

func object(value any) (map[string]any, bool) {
	v, ok := value.(map[string]any)
	return v, ok && v != nil
}
func keysOnly(value map[string]any, allowed ...string) bool {
	for key := range value {
		exists := false
		for _, name := range allowed {
			if key == name {
				exists = true
				break
			}
		}
		if !exists {
			return false
		}
	}
	return true
}
func oneOf(value any, allowed ...string) bool {
	s, ok := value.(string)
	if !ok {
		return false
	}
	for _, v := range allowed {
		if s == v {
			return true
		}
	}
	return false
}

func integer(value any, low, high int) (int, bool) {
	var n float64
	switch v := value.(type) {
	case float64:
		n = v
	case int:
		n = float64(v)
	case int64:
		n = float64(v)
	case json.Number:
		parsed, err := v.Float64()
		if err != nil {
			return 0, false
		}
		n = parsed
	default:
		return 0, false
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) || n < float64(low) || n > float64(high) {
		return 0, false
	}
	return int(n), true
}

func queryStrings(value any, maxLength int) ([]string, bool) {
	var values []any
	switch v := value.(type) {
	case []any:
		values = v
	case []string:
		for _, s := range v {
			values = append(values, s)
		}
	default:
		return nil, false
	}
	if len(values) > 100 {
		return nil, false
	}
	out := []string{}
	seen := map[string]bool{}
	for _, raw := range values {
		s, ok := raw.(string)
		if !ok {
			return nil, false
		}
		trimmed, err := required(s, "query entry", maxLength)
		if err != nil || trimmed != s || seen[s] {
			return nil, false
		}
		seen[s] = true
		out = append(out, s)
	}
	return out, true
}

func validateNavigationQuery(query map[string]any) error {
	if query == nil || !keysOnly(query, "categoryIds", "tags", "favoritesOnly", "search", "sort", "limit") {
		return invalid("Unknown navigation query field.")
	}
	for key, value := range query {
		switch key {
		case "categoryIds":
			if _, ok := queryStrings(value, 256); !ok {
				return invalid("categoryIds must contain up to 100 unique category IDs of at most 256 characters.")
			}
		case "tags":
			if _, ok := queryStrings(value, 40); !ok {
				return invalid("tags must contain up to 100 unique tags of at most 40 characters.")
			}
		case "favoritesOnly":
			if _, ok := value.(bool); !ok {
				return invalid("favoritesOnly must be a boolean.")
			}
		case "search":
			s, ok := value.(string)
			if !ok {
				return invalid("search must be a string.")
			}
			if err := bounded(s, "search", 160); err != nil {
				return err
			}
		case "sort":
			if !oneOf(value, "sortOrder", "title", "updatedAt") {
				return invalid("Unsupported navigation sort.")
			}
		case "limit":
			if _, ok := integer(value, 1, 10000); !ok {
				return invalid("limit must be an integer between 1 and 10000.")
			}
		}
	}
	return nil
}

func filterNavigation(data NavigationData, query map[string]any) NavigationData {
	result := NavigationData{Categories: append([]Category{}, data.Categories...), Links: []Link{}}
	categories, _ := queryStrings(query["categoryIds"], 256)
	tags, _ := queryStrings(query["tags"], 40)
	favorites, _ := query["favoritesOnly"].(bool)
	search, _ := query["search"].(string)
	search = strings.ToLower(strings.TrimSpace(search))
	for _, link := range data.Links {
		if favorites && !link.IsFavorite {
			continue
		}
		if len(categories) > 0 {
			found := false
			for _, id := range categories {
				if link.CategoryID != nil && id == *link.CategoryID {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		tagsMatch := true
		for _, wanted := range tags {
			found := false
			for _, tag := range link.Tags {
				if wanted == tag {
					found = true
					break
				}
			}
			if !found {
				tagsMatch = false
				break
			}
		}
		if !tagsMatch {
			continue
		}
		if search != "" && !strings.Contains(strings.ToLower(link.Title+" "+link.URL+" "+link.Description+" "+strings.Join(link.Tags, " ")), search) {
			continue
		}
		result.Links = append(result.Links, link)
	}
	sortBy, _ := query["sort"].(string)
	if sortBy != "" {
		sort.SliceStable(result.Links, func(i, j int) bool {
			left, right := result.Links[i], result.Links[j]
			switch sortBy {
			case "title":
				return strings.ToLower(left.Title) < strings.ToLower(right.Title)
			case "updatedAt":
				return left.UpdatedAt > right.UpdatedAt
			default:
				return left.SortOrder < right.SortOrder
			}
		})
	}
	if limit, ok := integer(query["limit"], 1, 10000); ok && len(result.Links) > limit {
		result.Links = result.Links[:limit]
	}
	return result
}

func validatePageConfig(config map[string]any) error {
	encoded, err := json.Marshal(config)
	if err != nil || len(encoded) > 64*1024 {
		return invalid("Page configuration must be valid JSON of at most 64 KiB.")
	}
	if !keysOnly(config, "schemaVersion", "pageTheme", "appearance", "chrome", "bindings", "views", "layout") {
		return invalid("Unknown page configuration field.")
	}
	if version, ok := integer(config["schemaVersion"], 2, 2); !ok || version != 2 {
		return invalid("Only page schemaVersion 2 is supported.")
	}
	pageTheme, ok := object(config["pageTheme"])
	if !ok || !keysOnly(pageTheme, "id") || !oneOf(pageTheme["id"], "builtin/dashboard", "builtin/ios") {
		return invalid("Unsupported page theme.")
	}
	appearance, ok := object(config["appearance"])
	if !ok || !keysOnly(appearance, "colorMode", "density") || !oneOf(appearance["colorMode"], "light", "dark", "system") || !oneOf(appearance["density"], "comfortable", "compact") {
		return invalid("Invalid page appearance.")
	}
	if raw, exists := config["chrome"]; exists {
		if err = validatePageChrome(raw); err != nil {
			return err
		}
	}
	bindings, ok := object(config["bindings"])
	if !ok || len(bindings) > 32 {
		return invalid("bindings must be an object with at most 32 entries.")
	}
	for alias, raw := range bindings {
		if !bindingPattern.MatchString(alias) {
			return invalid("Invalid binding identifier.")
		}
		binding, ok := object(raw)
		if !ok || !keysOnly(binding, "datasetId", "space", "query") {
			return invalid("Invalid binding fields.")
		}
		datasetID, ok := binding["datasetId"].(string)
		if !ok || (datasetID != "local-navigation" && datasetID != "local-document-activity" && !(strings.HasPrefix(datasetID, "source:") && validID(strings.TrimPrefix(datasetID, "source:")))) {
			return invalid("Unknown dataset identifier.")
		}
		if binding["space"] != "current-page-space" {
			return invalid("Bindings may only reference the authorized current page space.")
		}
		query, ok := object(binding["query"])
		if !ok {
			return invalid("Binding query must be an object.")
		}
		if datasetID == "local-document-activity" && len(query) != 0 {
			return invalid("Document activity filters belong to each panel settings.")
		}
		if err = validateNavigationQuery(query); err != nil {
			return err
		}
	}
	views, ok := config["views"].([]any)
	if !ok || len(views) > 32 {
		return invalid("views must be an array with at most 32 entries.")
	}
	panels := map[string]string{}
	for _, raw := range views {
		view, ok := object(raw)
		if !ok || !keysOnly(view, "id", "panel", "inputs", "interactionScope", "settings", "template") {
			return invalid("Unknown view field; positions belong only to layout.placements.")
		}
		id, ok := view["id"].(string)
		if !ok || !bindingPattern.MatchString(id) || panels[id] != "" {
			return invalid("View IDs must be unique valid identifiers.")
		}
		panel, ok := object(view["panel"])
		if !ok || !keysOnly(panel, "id") {
			return invalid("Invalid panel reference.")
		}
		panelID, ok := panel["id"].(string)
		if !ok || !oneOf(panelID, "builtin/category-navigation", "builtin/search", "builtin/favorites", "builtin/navigation", "builtin/github-traffic", "builtin/calendar", "builtin/weather", "builtin/metrics", "builtin/status", "builtin/document-activity") {
			return invalid("Panel theme is not registered.")
		}
		if raw, exists := view["template"]; exists {
			if err := validateComponentTemplateReference(raw); err != nil {
				return err
			}
		}
		panels[id] = panelID
		inputs, ok := object(view["inputs"])
		if !ok {
			return invalid("View inputs must be an object.")
		}
		inputName := "collection"
		if _, declaredInput := componentTemplateSchema(panelID); declaredInput != "" {
			inputName = declaredInput
		}
		if panelID == "builtin/search" {
			if len(inputs) != 0 {
				return invalid("The search panel does not accept dataset inputs.")
			}
		} else {
			if len(inputs) != 1 {
				return invalid("Panel requires exactly its declared dataset input.")
			}
			alias, ok := inputs[inputName].(string)
			if !ok {
				return invalid("Panel input name or binding is invalid.")
			}
			if _, exists := bindings[alias]; !exists {
				return invalid("Panel refers to an unknown binding.")
			}
		}
		if scope, exists := view["interactionScope"]; exists {
			s, ok := scope.(string)
			if !ok {
				return invalid("interactionScope must be a string.")
			}
			if _, err = required(s, "interactionScope", 80); err != nil {
				return err
			}
		}
		settings, ok := object(view["settings"])
		if !ok {
			return invalid("Panel settings must be an object.")
		}
		allowed := []string{"title"}
		switch panelID {
		case "builtin/document-activity":
			allowed = append(allowed, "presentation", "months", "perspective", "sourceIds", "showSummary", "recentLimit", "detailLayout", "timezone")
			if err = validateDocumentActivityPanelSettings(settings); err != nil {
				return err
			}
		case "builtin/calendar":
			allowed = append(allowed, "viewMode")
		case "builtin/weather":
			allowed = append(allowed, "forecastDays")
		case "builtin/metrics":
			allowed = append(allowed, "showBars")
		case "builtin/status":
			allowed = append(allowed, "showLatency")
		}
		if panelID == "builtin/navigation" {
			allowed = append(allowed, "variant", "groupBy", "linkAppearance")
		}
		if panelID == "builtin/favorites" {
			allowed = append(allowed, "variant", "linkAppearance")
		}
		if panelID == "builtin/navigation" || panelID == "builtin/favorites" {
			allowed = append(allowed, "maxColumns", "urlDisplay", "descriptionLines", "showTags", "showEndpoints", "showGroupTitles", "showCounts", "density")
		}
		if panelID == "builtin/category-navigation" {
			allowed = append(allowed, "displayMode", "hierarchyMode", "collapsible", "defaultCollapsed", "showCounts")
		}
		if !keysOnly(settings, allowed...) {
			return invalid("Unsupported panel setting or duplicate layout authority.")
		}
		if mode, exists := settings["viewMode"]; exists && !oneOf(mode, "day", "week") {
			return invalid("Calendar viewMode must be day or week.")
		}
		if days, exists := settings["forecastDays"]; exists {
			n, ok := integer(days, 3, 7)
			if !ok || (n != 3 && n != 5 && n != 7) {
				return invalid("Weather forecastDays must be 3, 5 or 7.")
			}
		}
		for _, name := range []string{"showBars", "showLatency"} {
			if value, exists := settings[name]; exists {
				if _, ok := value.(bool); !ok {
					return invalid(name + " must be a boolean.")
				}
			}
		}
		if title, exists := settings["title"]; exists {
			s, ok := title.(string)
			if !ok {
				return invalid("Panel title must be a string.")
			}
			if err = bounded(s, "Panel title", 80); err != nil {
				return err
			}
		}
		if variant, exists := settings["variant"]; exists && !oneOf(variant, "cards", "directory") {
			return invalid("Unknown panel variant.")
		}
		if appearance, exists := settings["linkAppearance"]; exists && !oneOf(appearance, "icon-text", "minimal", "app-icons") {
			return invalid("Unknown link appearance.")
		}
		if columns, exists := settings["maxColumns"]; exists {
			if _, ok := integer(columns, 0, 8); !ok {
				return invalid("maxColumns must be an integer between 0 and 8.")
			}
		}
		if lines, exists := settings["descriptionLines"]; exists {
			if _, ok := integer(lines, 0, 3); !ok {
				return invalid("descriptionLines must be an integer between 0 and 3.")
			}
		}
		if display, exists := settings["urlDisplay"]; exists && !oneOf(display, "fallback", "always", "hidden") {
			return invalid("urlDisplay must be fallback, always or hidden.")
		}
		if density, exists := settings["density"]; exists && !oneOf(density, "inherit", "comfortable", "compact") {
			return invalid("Panel density must be inherit, comfortable or compact.")
		}
		for _, name := range []string{"showTags", "showEndpoints", "showGroupTitles"} {
			if value, exists := settings[name]; exists {
				if _, ok := value.(bool); !ok {
					return invalid(name + " must be a boolean.")
				}
			}
		}
		if group, exists := settings["groupBy"]; exists && group != "category" {
			return invalid("Only category grouping is supported.")
		}
		if display, exists := settings["displayMode"]; exists && !oneOf(display, "icon-text", "icons", "text") {
			return invalid("Unknown category navigation display mode.")
		}
		if hierarchy, exists := settings["hierarchyMode"]; exists && !oneOf(hierarchy, "tree", "flat") {
			return invalid("Unknown category navigation hierarchy mode.")
		}
		for _, name := range []string{"collapsible", "defaultCollapsed", "showCounts"} {
			if value, exists := settings[name]; exists {
				if _, ok := value.(bool); !ok {
					prefix := "Category navigation "
					if panelID != "builtin/category-navigation" {
						prefix = "Panel "
					}
					return invalid(prefix + name + " must be a boolean.")
				}
			}
		}
	}
	layout, ok := object(config["layout"])
	if !ok || !keysOnly(layout, "mode", "gap", "grid", "placements") || layout["mode"] != "regions-grid" {
		return invalid("Unsupported layout.")
	}
	if _, ok = integer(layout["gap"], 8, 24); !ok {
		return invalid("Layout gap must be an integer between 8 and 24.")
	}
	grid, ok := object(layout["grid"])
	if !ok || !keysOnly(grid, "columns") {
		return invalid("Invalid grid settings.")
	}
	if _, ok = integer(grid["columns"], 24, 24); !ok {
		return invalid("The built-in grid uses 24 columns.")
	}
	placements, ok := object(layout["placements"])
	if !ok || len(placements) != len(panels) {
		return invalid("Every view must have exactly one placement.")
	}
	base := map[string]map[string]any{}
	narrow := map[string]map[string]any{}
	for id, raw := range placements {
		panelID, exists := panels[id]
		if !exists {
			return invalid("Placement refers to an unknown view.")
		}
		placement, ok := object(raw)
		if !ok || !keysOnly(placement, "base", "overrides") {
			return invalid("Invalid placement fields.")
		}
		position, ok := object(placement["base"])
		if !ok {
			return invalid("Placement base must be an object.")
		}
		if err = validatePosition(position, panelID); err != nil {
			return err
		}
		base[id] = position
		narrow[id] = position
		if rawOverrides, exists := placement["overrides"]; exists {
			overrides, ok := object(rawOverrides)
			if !ok || !keysOnly(overrides, "narrow") {
				return invalid("Only a narrow breakpoint override is supported.")
			}
			if rawNarrow, exists := overrides["narrow"]; exists {
				position, ok = object(rawNarrow)
				if !ok {
					return invalid("Narrow placement must be an object.")
				}
				if err = validatePosition(position, panelID); err != nil {
					return err
				}
				narrow[id] = position
			}
		}
	}
	if overlap(base) || overlap(narrow) {
		return invalid("Grid placements cannot overlap, including locked and breakpoint placements.")
	}
	return nil
}

// Activity settings describe one view. Position and size remain in placements.
func validateDocumentActivityPanelSettings(settings map[string]any) error {
	for _, field := range []struct {
		name   string
		values []string
	}{
		{"presentation", []string{"heatmap", "split", "month"}},
		{"perspective", []string{"mine", "library"}},
		{"detailLayout", []string{"auto", "side", "below"}},
	} {
		if value, exists := settings[field.name]; exists {
			valid := false
			for _, allowed := range field.values {
				if value == allowed {
					valid = true
				}
			}
			if !valid {
				return invalid("Invalid document activity " + field.name + ".")
			}
		}
	}
	for _, field := range []struct {
		name   string
		values []int
	}{
		{"months", []int{3, 6, 12}}, {"recentLimit", []int{0, 3, 5}},
	} {
		if value, exists := settings[field.name]; exists {
			number, ok := integer(value, 0, 12)
			valid := false
			for _, allowed := range field.values {
				if ok && number == allowed {
					valid = true
				}
			}
			if !valid {
				return invalid("Invalid document activity " + field.name + ".")
			}
		}
	}
	if value, exists := settings["showSummary"]; exists {
		if _, ok := value.(bool); !ok {
			return invalid("Document activity showSummary must be a boolean.")
		}
	}
	if value, exists := settings["timezone"]; exists {
		zone, ok := value.(string)
		if !ok || zone == "" || zone == "Local" || len(zone) > 100 {
			return invalid("Invalid document activity timezone.")
		}
		if zone != "local" {
			if _, err := time.LoadLocation(zone); err != nil {
				return invalid("Use an IANA document activity timezone or local.")
			}
		}
	}
	if value, exists := settings["sourceIds"]; exists {
		ids, ok := value.([]any)
		if !ok || len(ids) > 100 {
			return invalid("Document activity sourceIds must contain at most 100 directory IDs.")
		}
		seen := map[string]bool{}
		for _, value := range ids {
			id, ok := value.(string)
			if !ok || !validID(id) || seen[id] {
				return invalid("Document activity sourceIds must contain unique directory IDs.")
			}
			seen[id] = true
		}
	}
	return nil
}

func validatePosition(position map[string]any, panelID string) error {
	if position["kind"] == "hidden" {
		if !keysOnly(position, "kind") {
			return invalid("Hidden placement cannot also have position or size.")
		}
		return nil
	}
	if !oneOf(position["region"], "top", "left", "right", "main", "bottom") {
		return invalid("Unknown page region.")
	}
	if panelID == "builtin/category-navigation" && position["region"] == "main" {
		return invalid("Category navigation belongs to top, left, right, bottom or hidden.")
	}
	switch position["kind"] {
	case "grid":
		if !keysOnly(position, "kind", "region", "x", "y", "w", "h", "heightMode", "locked") || position["region"] != "main" {
			return invalid("Grid placement must use the main region and grid fields only.")
		}
		x, xOK := integer(position["x"], 0, 23)
		_, yOK := integer(position["y"], 0, 10000)
		w, wOK := integer(position["w"], 1, 24)
		_, hOK := integer(position["h"], 1, 1000)
		if !xOK || !yOK || !wOK || !hOK || x+w > 24 {
			return invalid("Grid bounds or dimensions are invalid.")
		}
		if !oneOf(position["heightMode"], "content", "fixed") {
			return invalid("Grid heightMode must be content or fixed.")
		}
		if _, ok := position["locked"].(bool); !ok {
			return invalid("Grid locked must be a boolean.")
		}
	case "region":
		if !keysOnly(position, "kind", "region", "order", "size", "sticky", "locked") {
			return invalid("Unknown region placement field.")
		}
		if _, ok := integer(position["order"], 0, 10000); !ok {
			return invalid("Region order must be a nonnegative integer.")
		}
		if rawSize, exists := position["size"]; exists {
			size, ok := object(rawSize)
			if !ok || len(size) == 0 || !keysOnly(size, "widthPx", "maxWidthPx") {
				return invalid("Region size supports widthPx and maxWidthPx only.")
			}
			limit := 1600
			if panelID == "builtin/search" {
				limit = 360
			}
			width, maxWidth := 0, 0
			if value, exists := size["widthPx"]; exists {
				width, ok = integer(value, 160, limit)
				if !ok {
					return invalid("Region width is outside the panel's supported bounds.")
				}
			}
			if value, exists := size["maxWidthPx"]; exists {
				maxWidth, ok = integer(value, 160, limit)
				if !ok {
					return invalid("Region maximum width is outside the panel's supported bounds.")
				}
			}
			if width > 0 && maxWidth > 0 && width > maxWidth {
				return invalid("widthPx cannot exceed maxWidthPx.")
			}
		}
		for _, key := range []string{"sticky", "locked"} {
			if v, exists := position[key]; exists {
				if _, ok := v.(bool); !ok {
					return invalid(key + " must be a boolean.")
				}
			}
		}
	case "flow":
		if !keysOnly(position, "kind", "region", "order", "locked") {
			return invalid("Unknown flow placement field.")
		}
		if _, ok := integer(position["order"], 0, 10000); !ok {
			return invalid("Flow order must be a nonnegative integer.")
		}
		if v, exists := position["locked"]; exists {
			if _, ok := v.(bool); !ok {
				return invalid("locked must be a boolean.")
			}
		}
	default:
		return invalid("Unsupported placement kind.")
	}
	return nil
}

func overlap(positions map[string]map[string]any) bool {
	type rect struct{ x, y, w, h int }
	rects := []rect{}
	for _, position := range positions {
		if position["kind"] != "grid" {
			continue
		}
		x, _ := integer(position["x"], 0, 23)
		y, _ := integer(position["y"], 0, 10000)
		w, _ := integer(position["w"], 1, 24)
		h, _ := integer(position["h"], 1, 1000)
		rects = append(rects, rect{x, y, w, h})
	}
	for i, left := range rects {
		for _, right := range rects[i+1:] {
			if left.x < right.x+right.w && right.x < left.x+left.w && left.y < right.y+right.h && right.y < left.y+left.h {
				return true
			}
		}
	}
	return false
}

func (a *App) loadPage(r *Request, spaceID string) (Page, error) {
	var page Page
	var revision int64
	var config []byte
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT id,space_id,name,revision,config FROM pages WHERE space_id=?"), spaceID).Scan(&page.ID, &page.SpaceID, &page.Name, &revision, &config)
	if err != nil {
		return page, storageError(err)
	}
	if err = json.Unmarshal(config, &page.Config); err != nil {
		return page, err
	}
	page.Revision = strconv.FormatInt(revision, 10)
	return page, nil
}

func (a *App) updatePage(r *Request) (*Response, error) {
	if err := r.requireAction("pages:write"); err != nil {
		return nil, err
	}
	space, err := r.requireSpace(r.param("spaceId"), true)
	if err != nil {
		return nil, err
	}
	var in struct {
		Name             string         `json:"name"`
		Config           map[string]any `json:"config"`
		ExpectedRevision string         `json:"expectedRevision"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	page, err := a.loadPage(r, space.ID)
	if err != nil {
		return nil, err
	}
	if in.ExpectedRevision != page.Revision {
		return nil, &APIError{Status: 409, Code: "page_version_conflict", Message: "The page changed. Reload the current revision before saving.", CurrentRevision: page.Revision}
	}
	name, err := required(in.Name, "page name", 80)
	if err != nil {
		return nil, err
	}
	if err = validatePageConfig(in.Config); err != nil {
		return nil, err
	}
	if err = a.validateIntegrationPageBindings(r, in.Config); err != nil {
		return nil, err
	}
	revision, _ := strconv.ParseInt(page.Revision, 10, 64)
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE pages SET name=?,config=?,revision=revision+1 WHERE id=? AND revision=?"), name, jsonString(in.Config), page.ID, revision)
	if err != nil {
		return nil, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if changed != 1 {
		return nil, conflict("Page changed while saving.")
	}
	page.Name = name
	page.Config = in.Config
	page.Revision = strconv.FormatInt(revision+1, 10)
	return ok(page), nil
}
