package home

import (
	"database/sql"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

type categoryInput struct {
	Name      string  `json:"name"`
	Icon      string  `json:"icon"`
	ParentID  *string `json:"parentId"`
	SortOrder int     `json:"sortOrder"`
}

type linkInput struct {
	CategoryID  *string `json:"categoryId"`
	Title       string  `json:"title"`
	URL         string  `json:"url"`
	Description string  `json:"description"`
	// Nil preserves the existing notes on a legacy PUT; an explicit empty string clears them.
	ContextMarkdown   *string       `json:"contextMarkdown"`
	ExpectedUpdatedAt string        `json:"expectedUpdatedAt"`
	Icon              string        `json:"icon"`
	IconMode          iconModeInput `json:"iconMode"`
	Tags              []string      `json:"tags"`
	IsFavorite        bool          `json:"isFavorite"`
	SortOrder         int           `json:"sortOrder"`
	Endpoints         []Endpoint    `json:"endpoints"`
}

func (a *App) insertSpace(r *Request, name, kind, ownerID string, published bool) (*Space, error) {
	s := &Space{ID: newID(), Name: name, Kind: kind, OwnerUserID: ownerID, Published: published, DataRevision: 1, UpdatedAt: nowUTC()}
	var owner any
	if ownerID != "" {
		owner = ownerID
	}
	_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO spaces(id,name,kind,owner_user_id,published,data_revision,updated_at) VALUES(?,?,?,?,?,?,?)"), s.ID, s.Name, s.Kind, owner, s.Published, s.DataRevision, s.UpdatedAt)
	if err != nil {
		return nil, err
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO pages(id,space_id,name,revision,config) VALUES(?,?,?,?,?)"), newID(), s.ID, a.localized("我的导航", "Home"), 1, jsonString(defaultPageConfig()))
	return s, err
}

func (a *App) touchNavigation(r *Request, spaceID string) error {
	_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE spaces SET data_revision=data_revision+1,updated_at=? WHERE id=?"), nowUTC(), spaceID)
	return err
}

func (a *App) readCategories(r *Request, spaceID string) ([]Category, error) {
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id,space_id,parent_id,name,icon,sort_order FROM categories WHERE space_id=? ORDER BY sort_order,name,id"), spaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Category{}
	for rows.Next() {
		var c Category
		var parent sql.NullString
		if err = rows.Scan(&c.ID, &c.SpaceID, &parent, &c.Name, &c.Icon, &c.SortOrder); err != nil {
			return nil, err
		}
		if parent.Valid {
			value := parent.String
			c.ParentID = &value
		}
		result = append(result, c)
	}
	return result, rows.Err()
}

func (a *App) readNavigation(r *Request, spaceID string) (NavigationData, error) {
	categories, err := a.readCategories(r, spaceID)
	if err != nil {
		return NavigationData{}, err
	}
	data := NavigationData{Categories: categories, Links: []Link{}}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id,space_id,category_id,title,url,description,context_markdown,icon,icon_mode,tags,is_favorite,sort_order,endpoints,updated_at FROM links WHERE space_id=? ORDER BY sort_order,title,id"), spaceID)
	if err != nil {
		return data, err
	}
	defer rows.Close()
	for rows.Next() {
		var link Link
		var category sql.NullString
		var tags, endpoints []byte
		var updated databaseTime
		if err = rows.Scan(&link.ID, &link.SpaceID, &category, &link.Title, &link.URL, &link.Description, &link.ContextMarkdown, &link.Icon, &link.IconMode, &tags, &link.IsFavorite, &link.SortOrder, &endpoints, &updated); err != nil {
			return data, err
		}
		if category.Valid {
			value := category.String
			link.CategoryID = &value
		}
		if err = json.Unmarshal(tags, &link.Tags); err != nil {
			return data, err
		}
		if err = json.Unmarshal(endpoints, &link.Endpoints); err != nil {
			return data, err
		}
		if link.Tags == nil {
			link.Tags = []string{}
		}
		if link.Endpoints == nil {
			link.Endpoints = []Endpoint{}
		}
		link.UpdatedAt = updated.String()
		data.Links = append(data.Links, link)
	}
	return data, rows.Err()
}

func (a *App) localDataset(r *Request, space *Space) (Dataset, error) {
	data, err := a.readNavigation(r, space.ID)
	if err != nil {
		return Dataset{}, err
	}
	updated, err := time.Parse(time.RFC3339Nano, space.UpdatedAt)
	if err != nil {
		return Dataset{}, err
	}
	now := time.Now().UTC()
	return Dataset{DatasetID: "local-navigation", SchemaID: "navigation.collection", SchemaVersion: 1, Revision: strconv.FormatInt(space.DataRevision, 10), Data: data, Meta: DatasetMeta{SourceUpdatedAt: &updated, ReceivedAt: now, LastSuccessAt: now, Freshness: "fresh"}}, nil
}

func (a *App) getNavigation(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), false)
	if err != nil {
		return nil, err
	}
	data, err := a.localDataset(r, space)
	if err != nil {
		return nil, err
	}
	return ok(data), nil
}

func (a *App) dashboard(r *Request) (*Response, error) {
	if err := r.requireAction("pages:read"); err != nil {
		return nil, err
	}
	spaceID := r.HTTP.URL.Query().Get("spaceId")
	if override := r.param("spaceId"); override != "" {
		spaceID = override
	}
	if spaceID == "" {
		spaces, err := a.accessibleSpaces(r)
		if err != nil {
			return nil, err
		}
		for _, space := range spaces {
			if spaceID == "" || r.User != nil && space.Kind == "personal" {
				spaceID = space.ID
			}
		}
	}
	space, err := r.navigationSpace(spaceID, false)
	if err != nil {
		return nil, err
	}
	page, err := a.loadPage(r, spaceID)
	if err != nil {
		return nil, err
	}
	dashboard := Dashboard{Space: *space, Page: page, Datasets: map[string]Dataset{}}
	bindings, _ := page.Config["bindings"].(map[string]any)
	var local *Dataset
	for alias, value := range bindings {
		binding, _ := value.(map[string]any)
		if binding["datasetId"] == "local-document-activity" {
			// This is only a public renderer contract. Personal activity is read
			// by the separate, document-authorized endpoint, never this snapshot.
			now := time.Now().UTC()
			dashboard.Datasets[alias] = Dataset{DatasetID: "local-document-activity", SchemaID: "documents.activity", SchemaVersion: 1, Revision: "1", Data: map[string]any{}, Meta: DatasetMeta{ReceivedAt: now, LastSuccessAt: now, Freshness: "fresh"}}
			continue
		}
		if binding["datasetId"] != "local-navigation" {
			continue
		}
		if local == nil {
			dataset, err := a.localDataset(r, space)
			if err != nil {
				return nil, err
			}
			local = &dataset
		}
		copy := *local
		query, _ := binding["query"].(map[string]any)
		copy.Data = filterNavigation(local.Data.(NavigationData), query)
		dashboard.Datasets[alias] = copy
	}
	if err = a.appendIntegrationDatasets(r, &dashboard); err != nil {
		return nil, err
	}
	return ok(dashboard), nil
}

func (a *App) updateSpace(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), true)
	if err != nil {
		return nil, err
	}
	var in struct {
		Name      string `json:"name"`
		Published bool   `json:"published"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	name, err := required(in.Name, "name", 80)
	if err != nil {
		return nil, err
	}
	if in.Published && space.Kind == "personal" {
		return nil, invalid("Personal spaces cannot be published.")
	}
	if in.Published != space.Published {
		if err = r.requireOwner(); err != nil {
			return nil, err
		}
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE spaces SET name=?,published=? WHERE id=?"), name, in.Published, space.ID)
	if err != nil {
		return nil, err
	}
	space.Name = name
	space.Published = in.Published
	return ok(space), nil
}

func (a *App) validateCategory(r *Request, spaceID, id string, in *categoryInput) error {
	var err error
	in.Name, err = required(in.Name, "name", 80)
	if err != nil {
		return err
	}
	in.Icon, err = a.validSpaceIcon(r, spaceID, in.Icon, "lucide:folder")
	if err != nil {
		return err
	}
	if err = sortOrder(in.SortOrder); err != nil {
		return err
	}
	if in.ParentID != nil && *in.ParentID == "" {
		in.ParentID = nil
	}
	categories, err := a.readCategories(r, spaceID)
	if err != nil {
		return err
	}
	parents := map[string]*string{}
	for _, c := range categories {
		parents[c.ID] = c.ParentID
	}
	if in.ParentID != nil {
		if _, exists := parents[*in.ParentID]; !exists {
			return invalid("Parent category must belong to the current space.")
		}
	}
	parents[id] = in.ParentID
	for current := range parents {
		seen := map[string]bool{}
		depth := 0
		for current != "" {
			if seen[current] {
				return invalid("Category hierarchy cannot contain a cycle.")
			}
			seen[current] = true
			depth++
			if depth > 32 {
				return invalid("Category hierarchy is limited to 32 levels.")
			}
			parent := parents[current]
			if parent == nil {
				break
			}
			current = *parent
		}
	}
	return nil
}

func (a *App) createCategory(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), true)
	if err != nil {
		return nil, err
	}
	var in categoryInput
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	id := newID()
	if err = a.validateCategory(r, space.ID, id, &in); err != nil {
		return nil, err
	}
	category := Category{ID: id, SpaceID: space.ID, ParentID: in.ParentID, Name: in.Name, Icon: in.Icon, SortOrder: in.SortOrder}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO categories(id,space_id,parent_id,name,icon,sort_order) VALUES(?,?,?,?,?,?)"), id, space.ID, nullableID(in.ParentID), in.Name, in.Icon, in.SortOrder)
	if err != nil {
		return nil, err
	}
	if err = a.touchNavigation(r, space.ID); err != nil {
		return nil, err
	}
	return &Response{Status: 201, Data: category}, nil
}

func (a *App) updateCategory(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), true)
	if err != nil {
		return nil, err
	}
	id := r.param("id")
	var exists bool
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM categories WHERE id=? AND space_id=?)"), id, space.ID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, missing()
	}
	var in categoryInput
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if err = a.validateCategory(r, space.ID, id, &in); err != nil {
		return nil, err
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE categories SET parent_id=?,name=?,icon=?,sort_order=? WHERE id=? AND space_id=?"), nullableID(in.ParentID), in.Name, in.Icon, in.SortOrder, id, space.ID)
	if err != nil {
		return nil, err
	}
	if err = a.touchNavigation(r, space.ID); err != nil {
		return nil, err
	}
	return ok(Category{ID: id, SpaceID: space.ID, ParentID: in.ParentID, Name: in.Name, Icon: in.Icon, SortOrder: in.SortOrder}), nil
}

func (a *App) deleteCategory(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), true)
	if err != nil {
		return nil, err
	}
	id := r.param("id")
	var exists bool
	err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM categories WHERE id=? AND space_id=?)"), id, space.ID).Scan(&exists)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, missing()
	}
	var inUse bool
	err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM categories WHERE parent_id=?) OR EXISTS(SELECT 1 FROM links WHERE category_id=?)"), id, id).Scan(&inUse)
	if err != nil {
		return nil, err
	}
	if inUse {
		return nil, conflict("Move linked bookmarks and child categories before deleting this category.")
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM categories WHERE id=? AND space_id=?"), id, space.ID)
	if err != nil {
		return nil, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, missing()
	}
	if err = a.touchNavigation(r, space.ID); err != nil {
		return nil, err
	}
	return &Response{Status: 204}, nil
}

func (a *App) validateLink(r *Request, spaceID string, in *linkInput) (string, error) {
	var err error
	in.Title, err = required(in.Title, "title", 160)
	if err != nil {
		return "", err
	}
	in.URL = strings.TrimSpace(in.URL)
	canonical, err := canonicalURL(in.URL)
	if err != nil {
		return "", err
	}
	if err = bounded(in.Description, "description", 2000); err != nil {
		return "", err
	}
	if in.ContextMarkdown != nil {
		if len(*in.ContextMarkdown) > 64*1024 {
			return "", invalid("contextMarkdown must be at most 64 KiB of UTF-8 text.")
		}
		if err = bounded(*in.ContextMarkdown, "contextMarkdown", 64*1024); err != nil {
			return "", err
		}
	}
	in.Icon, err = a.validSpaceIcon(r, spaceID, in.Icon, "lucide:link")
	if err != nil {
		return "", err
	}
	if err = sortOrder(in.SortOrder); err != nil {
		return "", err
	}
	if in.CategoryID != nil && *in.CategoryID == "" {
		in.CategoryID = nil
	}
	if in.CategoryID != nil {
		var exists bool
		if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT EXISTS(SELECT 1 FROM categories WHERE id=? AND space_id=?)"), *in.CategoryID, spaceID).Scan(&exists); err != nil {
			return "", err
		}
		if !exists {
			return "", invalid("Category must belong to the current space.")
		}
	}
	if len(in.Tags) > 32 {
		return "", invalid("A bookmark may have at most 32 tags.")
	}
	tags := []string{}
	seen := map[string]bool{}
	for _, tag := range in.Tags {
		tag, err = required(tag, "tag", 40)
		if err != nil {
			return "", err
		}
		if !seen[tag] {
			seen[tag] = true
			tags = append(tags, tag)
		}
	}
	in.Tags = tags
	if len(in.Endpoints) > 12 {
		return "", invalid("A bookmark may have at most 12 extra endpoints.")
	}
	if in.Endpoints == nil {
		in.Endpoints = []Endpoint{}
	}
	for i := range in.Endpoints {
		in.Endpoints[i].Label, err = required(in.Endpoints[i].Label, "endpoint label", 40)
		if err != nil {
			return "", err
		}
		in.Endpoints[i].URL = strings.TrimSpace(in.Endpoints[i].URL)
		if _, err = canonicalURL(in.Endpoints[i].URL); err != nil {
			return "", err
		}
		if err = validateEndpointRouting(&in.Endpoints[i]); err != nil {
			return "", err
		}
	}
	return canonical, nil
}

func (a *App) insertLink(r *Request, spaceID string, in linkInput) (Link, error) {
	if in.IconMode == "" {
		in.IconMode = "manual"
		if in.Icon == "" {
			in.IconMode = "auto"
		}
	}
	canonical, err := a.validateLink(r, spaceID, &in)
	if err != nil {
		return Link{}, err
	}
	link := Link{ID: newID(), SpaceID: spaceID, CategoryID: in.CategoryID, Title: in.Title, URL: in.URL, Description: in.Description, Icon: in.Icon, IconMode: string(in.IconMode), Tags: in.Tags, IsFavorite: in.IsFavorite, SortOrder: in.SortOrder, Endpoints: in.Endpoints, UpdatedAt: nowUTC()}
	if in.ContextMarkdown != nil {
		link.ContextMarkdown = *in.ContextMarkdown
	}
	origin, err := a.prepareAutomaticLinkIcon(r, &link)
	if err != nil {
		return Link{}, err
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO links(id,space_id,category_id,title,url,canonical_url,description,context_markdown,icon,icon_mode,icon_origin,tags,is_favorite,sort_order,endpoints,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"), link.ID, spaceID, nullableID(link.CategoryID), link.Title, link.URL, canonical, link.Description, link.ContextMarkdown, link.Icon, link.IconMode, origin, jsonString(link.Tags), link.IsFavorite, link.SortOrder, jsonString(link.Endpoints), link.UpdatedAt)
	if err == nil {
		err = a.queueAutomaticIcon(r, spaceID, origin)
	}
	return link, err
}

func (a *App) createLink(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), true)
	if err != nil {
		return nil, err
	}
	var in linkInput
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	link, err := a.insertLink(r, space.ID, in)
	if err != nil {
		return nil, err
	}
	if err = a.touchNavigation(r, space.ID); err != nil {
		return nil, err
	}
	return &Response{Status: 201, Data: link}, nil
}

func (a *App) updateLink(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), true)
	if err != nil {
		return nil, err
	}
	var in linkInput
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	var oldIcon, oldMode, oldOrigin, oldContext string
	var oldUpdated databaseTime
	err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT icon,icon_mode,icon_origin,context_markdown,updated_at FROM links WHERE id=? AND space_id=?"), r.param("id"), space.ID).Scan(&oldIcon, &oldMode, &oldOrigin, &oldContext, &oldUpdated)
	if err == sql.ErrNoRows {
		return nil, missing()
	}
	if err != nil {
		return nil, err
	}
	if in.ExpectedUpdatedAt != "" && in.ExpectedUpdatedAt != oldUpdated.String() {
		return nil, &APIError{Status: 409, Code: "bookmark_version_conflict", Message: "The bookmark changed. Reload it before saving.", CurrentRevision: oldUpdated.String()}
	}
	if in.IconMode == "" {
		in.IconMode = iconModeInput(oldMode)
		if in.Icon != "" && in.Icon != oldIcon {
			in.IconMode = "manual"
		}
	}
	if in.Icon == "" {
		in.Icon = oldIcon
	}
	if in.ContextMarkdown == nil {
		in.ContextMarkdown = &oldContext
	}
	canonical, err := a.validateLink(r, space.ID, &in)
	if err != nil {
		return nil, err
	}
	link := Link{ID: r.param("id"), SpaceID: space.ID, CategoryID: in.CategoryID, Title: in.Title, URL: in.URL, Description: in.Description, Icon: in.Icon, IconMode: string(in.IconMode), Tags: in.Tags, IsFavorite: in.IsFavorite, SortOrder: in.SortOrder, Endpoints: in.Endpoints, UpdatedAt: nowUTC()}
	link.ContextMarkdown = *in.ContextMarkdown
	if link.IconMode == "auto" && oldMode == "auto" && automaticIconOrigin(link.URL) != oldOrigin {
		link.Icon = "lucide:link"
	}
	origin, err := a.prepareAutomaticLinkIcon(r, &link)
	if err != nil {
		return nil, err
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE links SET category_id=?,title=?,url=?,canonical_url=?,description=?,context_markdown=?,icon=?,icon_mode=?,icon_origin=?,tags=?,is_favorite=?,sort_order=?,endpoints=?,updated_at=? WHERE id=? AND space_id=?"), nullableID(link.CategoryID), link.Title, link.URL, canonical, link.Description, link.ContextMarkdown, link.Icon, link.IconMode, origin, jsonString(link.Tags), link.IsFavorite, link.SortOrder, jsonString(link.Endpoints), link.UpdatedAt, link.ID, space.ID)
	if err != nil {
		return nil, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, missing()
	}
	if err = a.cleanAutomaticIconJobs(r, space.ID); err != nil {
		return nil, err
	}
	if err = a.queueAutomaticIcon(r, space.ID, origin); err != nil {
		return nil, err
	}
	if err = a.touchNavigation(r, space.ID); err != nil {
		return nil, err
	}
	return ok(link), nil
}

// updateLinkContext edits only usage notes, preserving navigation and icon fields.
// Content is reference data for people and agents; it never changes authorization.
func (a *App) updateLinkContext(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), true)
	if err != nil {
		return nil, err
	}
	var in struct {
		ContextMarkdown   *string `json:"contextMarkdown"`
		ExpectedUpdatedAt string  `json:"expectedUpdatedAt"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if in.ContextMarkdown == nil || in.ExpectedUpdatedAt == "" {
		return nil, invalid("contextMarkdown and expectedUpdatedAt are required.")
	}
	if len(*in.ContextMarkdown) > 64*1024 {
		return nil, invalid("contextMarkdown must be at most 64 KiB of UTF-8 text.")
	}
	if err = bounded(*in.ContextMarkdown, "contextMarkdown", 64*1024); err != nil {
		return nil, err
	}
	var updated databaseTime
	var oldContext string
	err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT context_markdown,updated_at FROM links WHERE id=? AND space_id=?"), r.param("id"), space.ID).Scan(&oldContext, &updated)
	if err == sql.ErrNoRows {
		return nil, missing()
	}
	if err != nil {
		return nil, err
	}
	if in.ExpectedUpdatedAt != updated.String() {
		return nil, &APIError{Status: 409, Code: "bookmark_version_conflict", Message: "The bookmark changed. Reload it before saving usage notes.", CurrentRevision: updated.String()}
	}
	if oldContext != *in.ContextMarkdown {
		next := time.Now().UTC().Truncate(time.Microsecond)
		if !next.After(updated.Time) {
			next = updated.Time.Add(time.Microsecond)
		}
		_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE links SET context_markdown=?,updated_at=? WHERE id=? AND space_id=?"), *in.ContextMarkdown, next.Format(time.RFC3339Nano), r.param("id"), space.ID)
		if err != nil {
			return nil, err
		}
		if err = a.touchNavigation(r, space.ID); err != nil {
			return nil, err
		}
	}
	data, err := a.readNavigation(r, space.ID)
	if err != nil {
		return nil, err
	}
	for _, link := range data.Links {
		if link.ID == r.param("id") {
			return ok(link), nil
		}
	}
	return nil, missing()
}

func (a *App) deleteLink(r *Request) (*Response, error) {
	space, err := r.navigationSpace(r.param("spaceId"), true)
	if err != nil {
		return nil, err
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM links WHERE id=? AND space_id=?"), r.param("id"), space.ID)
	if err != nil {
		return nil, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, missing()
	}
	if err = a.cleanAutomaticIconJobs(r, space.ID); err != nil {
		return nil, err
	}
	if err = a.touchNavigation(r, space.ID); err != nil {
		return nil, err
	}
	return &Response{Status: 204}, nil
}
