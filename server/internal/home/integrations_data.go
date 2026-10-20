package home

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

type integrationCategoryInput struct {
	ExternalID       string  `json:"externalId"`
	ParentExternalID *string `json:"parentExternalId"`
	Name             string  `json:"name"`
	Icon             string  `json:"icon"`
	SortOrder        int     `json:"sortOrder"`
}
type integrationLinkInput struct {
	ExternalID         string     `json:"externalId"`
	CategoryExternalID *string    `json:"categoryExternalId"`
	Title              string     `json:"title"`
	URL                string     `json:"url"`
	Description        string     `json:"description"`
	Icon               string     `json:"icon"`
	Tags               []string   `json:"tags"`
	IsFavorite         bool       `json:"isFavorite"`
	SortOrder          int        `json:"sortOrder"`
	Endpoints          []Endpoint `json:"endpoints"`
}
type integrationNavigationInput struct {
	Categories []integrationCategoryInput `json:"categories"`
	Links      []integrationLinkInput     `json:"links"`
}
type integrationPushInput struct {
	RequestID        string          `json:"requestId"`
	ExpectedRevision *string         `json:"expectedRevision,omitempty"`
	SourceSequence   *int64          `json:"sourceSequence,omitempty"`
	SchemaID         string          `json:"schemaId"`
	SchemaVersion    int             `json:"schemaVersion"`
	SourceUpdatedAt  *time.Time      `json:"sourceUpdatedAt"`
	Data             json.RawMessage `json:"data"`
}
type IntegrationReceipt struct {
	SourceID       string    `json:"sourceId"`
	DatasetID      string    `json:"datasetId"`
	RequestID      string    `json:"requestId"`
	Revision       string    `json:"revision"`
	SourceSequence *int64    `json:"sourceSequence"`
	ReceivedAt     time.Time `json:"receivedAt"`
}

func (a *App) normalizeIntegrationNavigation(r *Request, s IntegrationSource, in integrationNavigationInput, now time.Time) (NavigationData, error) {
	out := NavigationData{Categories: []Category{}, Links: []Link{}}
	if in.Categories == nil || in.Links == nil {
		return out, invalid("data.categories and data.links must both be arrays")
	}
	if len(in.Categories) > 5000 || len(in.Links) > 10000 {
		return out, invalid("a navigation snapshot may contain at most 5000 categories and 10000 links")
	}
	categories := map[string]integrationCategoryInput{}
	links := map[string]bool{}
	namespace := "source:" + s.ID + ":"
	for _, c := range in.Categories {
		if !integrationExternalID.MatchString(c.ExternalID) {
			return out, invalid("category externalId is invalid")
		}
		if _, exists := categories[c.ExternalID]; exists {
			return out, invalid("duplicate category externalId")
		}
		name, err := required(c.Name, "name", 80)
		if err != nil {
			return out, err
		}
		c.Name = name
		if err := sortOrder(c.SortOrder); err != nil {
			return out, err
		}
		icon, err := a.validSpaceIcon(r, s.SpaceID, c.Icon, "lucide:folder")
		if err != nil {
			return out, err
		}
		c.Icon = icon
		if c.ParentExternalID != nil && !integrationExternalID.MatchString(*c.ParentExternalID) {
			return out, invalid("parentExternalId is invalid")
		}
		categories[c.ExternalID] = c
	}
	for _, c := range categories {
		visited := map[string]bool{c.ExternalID: true}
		parent := c.ParentExternalID
		depth := 1
		for parent != nil {
			p, exists := categories[*parent]
			if !exists {
				return out, invalid("category parent must occur in the same snapshot")
			}
			depth++
			if visited[*parent] || depth > 32 {
				return out, invalid("category hierarchy must be acyclic and at most 32 levels deep")
			}
			visited[*parent] = true
			parent = p.ParentExternalID
		}
		var parentID *string
		if c.ParentExternalID != nil {
			id := namespace + *c.ParentExternalID
			parentID = &id
		}
		out.Categories = append(out.Categories, Category{ID: namespace + c.ExternalID, SpaceID: s.SpaceID, ParentID: parentID, Name: c.Name, Icon: c.Icon, SortOrder: c.SortOrder, ExternalID: c.ExternalID, SourceID: s.ID})
	}
	for _, l := range in.Links {
		if !integrationExternalID.MatchString(l.ExternalID) || links[l.ExternalID] {
			return out, invalid("link externalId is invalid or duplicated")
		}
		links[l.ExternalID] = true
		var categoryID *string
		if l.CategoryExternalID != nil {
			if _, exists := categories[*l.CategoryExternalID]; !exists {
				return out, invalid("link category must occur in the same snapshot")
			}
			id := namespace + *l.CategoryExternalID
			categoryID = &id
		}
		// Reuse the local navigation validator, with external category references already checked.
		// A remote snapshot cannot authorize the browser to probe local networks.
		// Local navigation writes have a separate, explicit endpoint contract.
		for _, endpoint := range l.Endpoints {
			if endpoint.Route != "" || endpoint.ProbePath != "" {
				return out, invalid("External navigation endpoints support label and url only; configure automatic routing in local bookmarks.")
			}
		}
		body := linkInput{CategoryID: nil, Title: l.Title, URL: l.URL, Description: l.Description, Icon: l.Icon, Tags: l.Tags, IsFavorite: l.IsFavorite, SortOrder: l.SortOrder, Endpoints: l.Endpoints}
		if _, err := a.validateLink(r, s.SpaceID, &body); err != nil {
			return out, err
		}
		out.Links = append(out.Links, Link{ID: namespace + l.ExternalID, SpaceID: s.SpaceID, CategoryID: categoryID, Title: body.Title, URL: body.URL, Description: body.Description, Icon: body.Icon, IconMode: "manual", Tags: body.Tags, IsFavorite: body.IsFavorite, SortOrder: body.SortOrder, Endpoints: body.Endpoints, UpdatedAt: integrationStamp(now), ExternalID: l.ExternalID, SourceID: s.ID})
	}
	sort.Slice(out.Categories, func(i, j int) bool {
		a, b := out.Categories[i], out.Categories[j]
		if a.SortOrder != b.SortOrder {
			return a.SortOrder < b.SortOrder
		}
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		return a.ID < b.ID
	})
	sort.Slice(out.Links, func(i, j int) bool {
		a, b := out.Links[i], out.Links[j]
		if a.SortOrder != b.SortOrder {
			return a.SortOrder < b.SortOrder
		}
		if a.Title != b.Title {
			return a.Title < b.Title
		}
		return a.ID < b.ID
	})
	return out, nil
}

func (a *App) pushIntegrationSnapshot(r *Request) (*Response, error) {
	if r.User == nil {
		return nil, unauthorized()
	}
	s, err := a.requireIntegrationSource(r, r.param("id"), "datasets:write", true)
	if err != nil {
		return nil, err
	}
	if s.Kind != "external-push" {
		return nil, invalid("only external-push sources accept pushed snapshots")
	}
	var in integrationPushInput
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	return a.acceptIntegrationSnapshot(r, s, in, "")
}

func (a *App) acceptIntegrationSnapshot(r *Request, s IntegrationSource, in integrationPushInput, requestDigest string) (*Response, error) {
	if !integrationExternalID.MatchString(in.RequestID) {
		return nil, invalid("requestId must be 1–128 letters, digits or ._:- and start with a letter or digit")
	}
	var navigationInput integrationNavigationInput
	var component any
	if in.SchemaID == "navigation.collection" {
		d := json.NewDecoder(bytes.NewReader(in.Data))
		d.DisallowUnknownFields()
		if err := d.Decode(&navigationInput); err != nil {
			return nil, invalid("invalid navigation data or unknown fields")
		}
		in.Data, _ = json.Marshal(navigationInput)
	} else {
		var err error
		component, err = normalizeComponentData(in.SchemaID, in.Data)
		if err != nil {
			return nil, err
		}
		in.Data, _ = json.Marshal(component)
		if len(in.Data) > 1<<20 {
			return nil, invalid("normalized component snapshot exceeds the 1 MiB storage limit")
		}
	}
	canonical, err := json.Marshal(in)
	if err != nil {
		return nil, invalid("snapshot cannot be encoded")
	}
	if len(canonical) > 8<<20 {
		return nil, invalid("snapshot exceeds the 8 MiB limit")
	}
	digest := integrationHash(string(canonical))
	if requestDigest != "" {
		digest = requestDigest
	}
	if replay, err := a.integrationReplayReceipt(r, s.ID, in.RequestID, digest); err != nil || replay != nil {
		return replay, err
	}
	if !s.Enabled {
		return nil, conflict("source is disabled")
	}
	if in.SchemaID != s.SchemaID || in.SchemaVersion != s.SchemaVersion {
		return nil, invalid("snapshot schema does not match the source")
	}
	if in.ExpectedRevision == nil && in.SourceSequence == nil {
		return nil, invalid("expectedRevision or sourceSequence is required")
	}
	if in.ExpectedRevision != nil {
		if _, err := integrationRevision(*in.ExpectedRevision); err != nil {
			return nil, err
		}
	}
	if in.SourceSequence != nil && *in.SourceSequence <= 0 {
		return nil, invalid("sourceSequence must be a positive integer")
	}
	// Keep the immutable JSON receipt and the SQL snapshot metadata identical
	// across both storage providers. Existing receipts remain unchanged.
	now := time.Now().UTC().Truncate(time.Microsecond)
	if in.SourceUpdatedAt != nil && in.SourceUpdatedAt.After(now.Add(5*time.Minute)) {
		return nil, invalid("sourceUpdatedAt must not be more than five minutes in the future")
	}
	var revision int64
	var sequence sql.NullInt64
	err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT revision,source_sequence FROM integration_snapshots WHERE source_id=?"), s.ID).Scan(&revision, &sequence)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if in.ExpectedRevision != nil && *in.ExpectedRevision != strconv.FormatInt(revision, 10) {
		return nil, &APIError{Status: 409, Code: "snapshot_version_conflict", Message: "snapshot revision changed", CurrentRevision: strconv.FormatInt(revision, 10)}
	}
	if in.SourceSequence != nil && sequence.Valid && *in.SourceSequence <= sequence.Int64 {
		return nil, conflict("sourceSequence must be greater than the last accepted source sequence")
	}
	if revision == math.MaxInt64 {
		return nil, conflict("snapshot revision limit reached")
	}
	var normalized any = component
	if s.SchemaID == "navigation.collection" {
		normalized, err = a.normalizeIntegrationNavigation(r, s, navigationInput, now)
		if err != nil {
			return nil, err
		}
	}
	data, err := json.Marshal(normalized)
	if s.SchemaID != "navigation.collection" && len(data) > 1<<20 {
		return nil, invalid("normalized component snapshot exceeds the 1 MiB storage limit")
	}
	if err != nil {
		return nil, err
	}
	var storedSequence any
	if sequence.Valid {
		storedSequence = sequence.Int64
	}
	if in.SourceSequence != nil {
		storedSequence = *in.SourceSequence
	}
	receipt := IntegrationReceipt{SourceID: s.ID, DatasetID: s.DatasetID, RequestID: in.RequestID, Revision: strconv.FormatInt(revision+1, 10), SourceSequence: in.SourceSequence, ReceivedAt: now}
	receiptJSON, _ := json.Marshal(receipt)
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query(`INSERT INTO integration_snapshots(source_id,revision,source_sequence,data_json,source_updated_at,received_at) VALUES(?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,source_sequence=excluded.source_sequence,data_json=excluded.data_json,source_updated_at=excluded.source_updated_at,received_at=excluded.received_at`), s.ID, revision+1, storedSequence, string(data), integrationNullableTime(in.SourceUpdatedAt), integrationStamp(now))
	if err != nil {
		return nil, err
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM integration_receipts WHERE source_id=? AND received_at<?"), s.ID, integrationStamp(now.Add(-7*24*time.Hour)))
	if err != nil {
		return nil, err
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO integration_receipts(source_id,request_id,payload_hash,receipt_json,received_at) VALUES(?,?,?,?,?)"), s.ID, in.RequestID, digest, string(receiptJSON), integrationStamp(now))
	if err != nil {
		return nil, err
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE integration_sources SET last_success_at=?,last_error_json=NULL WHERE id=?"), integrationStamp(now), s.ID)
	if err != nil {
		return nil, err
	}
	if err = a.pruneIntegrationReceipts(r, s.ID, now); err != nil {
		return nil, err
	}
	return ok(receipt), nil
}
func (a *App) integrationDataset(r *Request, s IntegrationSource) (Dataset, error) {
	var revision int64
	var data []byte
	var sourceUpdated, received integrationTime
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT revision,data_json,source_updated_at,received_at FROM integration_snapshots WHERE source_id=?"), s.ID).Scan(&revision, &data, &sourceUpdated, &received)
	if errors.Is(err, sql.ErrNoRows) {
		return Dataset{}, missing()
	}
	if err != nil {
		return Dataset{}, err
	}
	freshness := "fresh"
	if s.LastError != nil || time.Since(received.Time) > time.Duration(s.Sync.StaleAfterSeconds)*time.Second {
		freshness = "stale"
	}
	if !s.Enabled {
		freshness = "disabled"
	}
	return Dataset{DatasetID: s.DatasetID, SchemaID: s.SchemaID, SchemaVersion: s.SchemaVersion, Revision: strconv.FormatInt(revision, 10), Data: json.RawMessage(data), Meta: DatasetMeta{SourceUpdatedAt: sourceUpdated.Pointer(), ReceivedAt: received.Time, LastSuccessAt: received.Time, Freshness: freshness, LastError: s.LastError, Attribution: integrationAttribution(s)}}, nil
}
func (a *App) getIntegrationSnapshot(r *Request) (*Response, error) {
	s, err := a.requireIntegrationSource(r, r.param("id"), "sources:read", false)
	if err != nil {
		return nil, err
	}
	d, err := a.integrationDataset(r, s)
	if err != nil {
		return nil, err
	}
	return ok(d), nil
}

func (a *App) appendIntegrationDatasets(r *Request, d *Dashboard) error {
	if r.Bearer && !r.AllowedActions["sources:read"] {
		return nil
	}
	bindings, _ := d.Page.Config["bindings"].(map[string]any)
	cached := map[string]Dataset{}
	missingSnapshots := map[string]bool{}
	for alias, raw := range bindings {
		binding, _ := raw.(map[string]any)
		datasetID, _ := binding["datasetId"].(string)
		if !strings.HasPrefix(datasetID, "source:") {
			continue
		}
		id := strings.TrimPrefix(datasetID, "source:")
		if r.TokenSourceID != "" && r.TokenSourceID != id {
			continue
		}
		if missingSnapshots[id] {
			continue
		}
		if cachedDataset, exists := cached[id]; exists {
			if cachedDataset.SchemaID == "navigation.collection" {
				query, _ := binding["query"].(map[string]any)
				cachedDataset.Data = filterNavigation(cachedDataset.Data.(NavigationData), query)
			}
			d.Datasets[alias] = cachedDataset
			continue
		}
		source, err := a.loadIntegrationSource(r.HTTP.Context(), r.Q, id)
		if err != nil {
			return err
		}
		if source.SpaceID != d.Space.ID {
			return invalid("page references a source outside its space")
		}
		dataset, err := a.integrationDataset(r, source)
		if err != nil {
			var api *APIError
			if errors.As(err, &api) && api.Status == 404 {
				missingSnapshots[id] = true
				continue
			}
			return err
		}
		if source.SchemaID == "navigation.collection" {
			var navigation NavigationData
			if err := json.Unmarshal(dataset.Data.(json.RawMessage), &navigation); err != nil {
				return err
			}
			dataset.Data = navigation
			cached[id] = dataset
			query, _ := binding["query"].(map[string]any)
			dataset.Data = filterNavigation(navigation, query)
		} else {
			cached[id] = dataset
		}
		d.Datasets[alias] = dataset
	}
	return nil
}
func (a *App) validateIntegrationPageBindings(r *Request, config map[string]any) error {
	bindings, _ := config["bindings"].(map[string]any)
	schemas := map[string]string{}
	for alias, raw := range bindings {
		binding, _ := raw.(map[string]any)
		datasetID, _ := binding["datasetId"].(string)
		if datasetID == "local-navigation" {
			if err := r.requireAction("navigation:read"); err != nil {
				return err
			}
			schemas[alias] = "navigation.collection"
			continue
		}
		if !strings.HasPrefix(datasetID, "source:") {
			return invalid("unknown dataset binding")
		}
		if err := r.requireAction("sources:read"); err != nil {
			return err
		}
		id := strings.TrimPrefix(datasetID, "source:")
		if r.TokenSourceID != "" && r.TokenSourceID != id {
			return invalid("binding is outside the token's source scope")
		}
		source, err := a.loadIntegrationSource(r.HTTP.Context(), r.Q, id)
		if err != nil {
			var api *APIError
			if errors.As(err, &api) && api.Status == 404 {
				return invalid("binding source does not exist in this page's space")
			}
			return err
		}
		if source.SpaceID != r.param("spaceId") {
			return invalid("binding source does not exist in this page's space")
		}
		schemas[alias] = source.SchemaID
		query, _ := binding["query"].(map[string]any)
		if source.SchemaID != "navigation.collection" && len(query) != 0 {
			return invalid("component bindings do not accept navigation query fields")
		}
	}
	views, _ := config["views"].([]any)
	for _, raw := range views {
		view, _ := raw.(map[string]any)
		panel, _ := view["panel"].(map[string]any)
		panelID, _ := panel["id"].(string)
		inputs, _ := view["inputs"].(map[string]any)
		for name, value := range inputs {
			alias, _ := value.(string)
			expected := "navigation.collection"
			if schema, input := componentTemplateSchema(panelID); schema != "" && input == name {
				expected = schema
			}
			if schemas[alias] != expected {
				return invalid("panel input schema is incompatible with its bound dataset")
			}
		}
	}
	return nil
}
func (a *App) getIntegrationPage(r *Request) (*Response, error) {
	if err := r.requireAction("pages:read"); err != nil {
		return nil, err
	}
	if _, err := r.requireSpace(r.param("spaceId"), false); err != nil {
		return nil, err
	}
	p, err := a.loadPage(r, r.param("spaceId"))
	if err != nil {
		return nil, err
	}
	return ok(p), nil
}
