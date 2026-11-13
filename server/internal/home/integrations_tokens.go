package home

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
)

type integrationTokenActionSpec struct {
	ID, Chinese, English         string
	Requires                     []string
	SourceScoped, Write, Default bool
}

// Token UI, validation and explicitly opted-in all-mode tokens use this catalog.
// These are business actions only; account or credential management is excluded.
var integrationTokenActionSpecs = []integrationTokenActionSpec{
	{ID: "navigation:read", Chinese: "读取导航", English: "Read navigation", Default: true},
	{ID: "navigation:write", Chinese: "编辑导航", English: "Edit navigation", Write: true},
	{ID: "pages:read", Chinese: "读取页面", English: "Read pages", Default: true},
	{ID: "pages:write", Chinese: "编辑页面", English: "Edit pages", Write: true},
	{ID: "sources:read", Chinese: "读取数据源", English: "Read sources", SourceScoped: true},
	{ID: "sources:write", Chinese: "管理数据源", English: "Manage sources", Write: true},
	{ID: "datasets:write", Chinese: "写入数据快照", English: "Write snapshots", SourceScoped: true, Write: true},
	{ID: "documents:read", Chinese: "读取资料", English: "Read documents"},
	{ID: "documents:write", Chinese: "编辑资料", English: "Edit documents", Requires: []string{"documents:read"}, Write: true},
	{ID: "work:read", Chinese: "读取事项", English: "Read work items"},
	{ID: "work:write", Chinese: "管理事项", English: "Manage work items", Write: true},
}

var integrationActions = func() map[string]bool {
	actions := map[string]bool{}
	for _, spec := range integrationTokenActionSpecs {
		actions[spec.ID] = true
	}
	return actions
}()

func requireIntegrationTokenCookie(r *Request) error {
	if r.User == nil {
		return unauthorized()
	}
	if r.Bearer {
		return forbidden()
	}
	return nil
}

func (a *App) listIntegrationTokenActions(r *Request) (*Response, error) {
	if err := requireIntegrationTokenCookie(r); err != nil {
		return nil, err
	}
	items := []map[string]any{}
	defaults := []string{}
	for _, spec := range integrationTokenActionSpecs {
		label := spec.Chinese
		if r.Settings.Language == "en" {
			label = spec.English
		}
		items = append(items, map[string]any{"id": spec.ID, "label": label, "requires": append([]string{}, spec.Requires...), "sourceScoped": spec.SourceScoped, "write": spec.Write})
		if spec.Default {
			defaults = append(defaults, spec.ID)
		}
	}
	return ok(map[string]any{"items": items, "defaultActions": defaults}), nil
}

func integrationAllTokenActions(sourceScoped, canWrite bool) []string {
	allowed := map[string]bool{}
	for _, spec := range integrationTokenActionSpecs {
		if (sourceScoped && !spec.SourceScoped) || (spec.Write && !canWrite) {
			continue
		}
		allowed[spec.ID] = true
	}
	// Dependency closure only removes actions. A prerequisite excluded by the
	// account or source boundary must never be granted to complete another action.
	for changed := true; changed; {
		changed = false
		for _, spec := range integrationTokenActionSpecs {
			if !allowed[spec.ID] {
				continue
			}
			for _, required := range spec.Requires {
				if !allowed[required] {
					delete(allowed, spec.ID)
					changed = true
					break
				}
			}
		}
	}
	actions := []string{}
	for action := range allowed {
		actions = append(actions, action)
	}
	sort.Strings(actions)
	return actions
}

func (a *App) validateIntegrationTokenPermissions(r *Request, spaceID string, sourceID *string, mode string, actions []string) ([]string, error) {
	space, err := r.requireSpace(spaceID, false)
	if err != nil {
		return nil, err
	}
	if sourceID != nil {
		if *sourceID == "" {
			return nil, invalid("sourceId must be null or an existing source")
		}
		source, err := a.loadIntegrationSource(r.HTTP.Context(), r.Q, *sourceID)
		if err != nil {
			return nil, err
		}
		if source.SpaceID != spaceID {
			return nil, missing()
		}
	}
	if mode == "all" {
		if len(actions) != 0 {
			return nil, invalid("all permission mode does not accept a selected actions list")
		}
		_, canWrite := r.spaceAccess(space)
		return integrationAllTokenActions(sourceID != nil, canWrite), nil
	}
	if mode != "selected" {
		return nil, invalid("permissionMode must be selected or all")
	}
	if len(actions) == 0 || len(actions) > len(integrationActions) {
		return nil, invalid("select at least one supported action")
	}
	seen := map[string]bool{}
	for _, action := range actions {
		if !integrationActions[action] || seen[action] {
			return nil, invalid("unknown or duplicate token action")
		}
		seen[action] = true
	}
	write := false
	for _, spec := range integrationTokenActionSpecs {
		if !seen[spec.ID] {
			continue
		}
		if sourceID != nil && !spec.SourceScoped {
			return nil, invalid("source-scoped tokens only allow source-scoped actions")
		}
		for _, required := range spec.Requires {
			if !seen[required] {
				return nil, invalid(spec.ID + " also requires " + required)
			}
		}
		write = write || spec.Write
	}
	if write {
		if _, err = r.requireSpace(spaceID, true); err != nil {
			return nil, err
		}
	}
	result := append([]string{}, actions...)
	sort.Strings(result)
	return result, nil
}

func integrationTokenExpiry(raw json.RawMessage, now time.Time) (*time.Time, error) {
	if len(raw) == 0 {
		return nil, invalid("expiresAt is required; use null for a permanent token")
	}
	if strings.TrimSpace(string(raw)) == "null" {
		return nil, nil
	}
	var expiry time.Time
	if err := json.Unmarshal(raw, &expiry); err != nil {
		return nil, invalid("expiresAt must be an RFC3339 timestamp or null")
	}
	expiry = expiry.UTC().Truncate(time.Microsecond)
	if !expiry.After(now.Add(time.Minute)) || expiry.After(now.Add(365*24*time.Hour)) {
		return nil, invalid("token expiry must be between one minute and 365 days in the future")
	}
	return &expiry, nil
}

type integrationTokenRecord struct {
	IntegrationCredential
	storedExpiry time.Time
	revision     int64
}

const integrationTokenColumns = `id,name,space_id,source_id,actions_json,created_at,expires_at,revoked_at,permission_epoch,user_version,revision,never_expires,permission_mode`

func scanIntegrationToken(r *Request, row interface{ Scan(...any) error }, now time.Time) (*integrationTokenRecord, error) {
	c := &integrationTokenRecord{}
	var source sql.NullString
	var actions []byte
	var created, expires, revoked integrationTime
	var epoch, version int64
	var neverExpires bool
	err := row.Scan(&c.ID, &c.Name, &c.SpaceID, &source, &actions, &created, &expires, &revoked, &epoch, &version, &c.revision, &neverExpires, &c.PermissionMode)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, missing()
	}
	if err != nil {
		return nil, err
	}
	if source.Valid {
		c.SourceID = &source.String
	}
	if err = json.Unmarshal(actions, &c.Actions); err != nil {
		return nil, err
	}
	c.CreatedAt, c.storedExpiry, c.RevokedAt = created.Time, expires.Time, revoked.Pointer()
	if !neverExpires {
		c.ExpiresAt = expires.Pointer()
	}
	c.Revision = strconv.FormatInt(c.revision, 10)
	c.Status = "active"
	if revoked.Valid {
		c.Status = "revoked"
	} else if epoch != r.Settings.AuthEpoch || version != r.User.Version {
		c.Status = "invalidated"
	} else if !neverExpires && (!expires.Valid || !expires.Time.After(now)) {
		c.Status = "expired"
	}
	return c, nil
}

func (a *App) ownIntegrationToken(r *Request, id string) (*integrationTokenRecord, error) {
	return scanIntegrationToken(r, r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+integrationTokenColumns+" FROM integration_tokens WHERE id=? AND user_id=?"), id, r.User.ID), time.Now())
}

func (a *App) integrationTokenCredential(r *Request, c *integrationTokenRecord) (IntegrationCredential, error) {
	if c.PermissionMode == "all" {
		space, err := r.requireSpace(c.SpaceID, false)
		if err != nil {
			return IntegrationCredential{}, err
		}
		_, canWrite := r.spaceAccess(space)
		c.Actions = integrationAllTokenActions(c.SourceID != nil, canWrite)
	}
	return c.IntegrationCredential, nil
}

func (a *App) listIntegrationTokens(r *Request) (*Response, error) {
	if err := requireIntegrationTokenCookie(r); err != nil {
		return nil, err
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+integrationTokenColumns+" FROM integration_tokens WHERE user_id=? ORDER BY created_at,id"), r.User.ID)
	if err != nil {
		return nil, err
	}
	records := []*integrationTokenRecord{}
	now := time.Now()
	for rows.Next() {
		c, err := scanIntegrationToken(r, rows, now)
		if err != nil {
			rows.Close()
			return nil, err
		}
		records = append(records, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	items := []IntegrationCredential{}
	for _, c := range records {
		item, err := a.integrationTokenCredential(r, c)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return ok(items), nil
}

func (a *App) createIntegrationToken(r *Request) (*Response, error) {
	if err := requireIntegrationTokenCookie(r); err != nil {
		return nil, err
	}
	var in struct {
		Name           string          `json:"name"`
		SpaceID        string          `json:"spaceId"`
		SourceID       *string         `json:"sourceId"`
		Actions        []string        `json:"actions"`
		PermissionMode string          `json:"permissionMode"`
		ExpiresAt      json.RawMessage `json:"expiresAt"`
	}
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	name, err := required(in.Name, "token name", 100)
	if err != nil {
		return nil, err
	}
	if in.PermissionMode == "" {
		in.PermissionMode = "selected"
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	expiry, err := integrationTokenExpiry(in.ExpiresAt, now)
	if err != nil {
		return nil, err
	}
	actions, err := a.validateIntegrationTokenPermissions(r, in.SpaceID, in.SourceID, in.PermissionMode, in.Actions)
	if err != nil {
		return nil, err
	}
	var count int
	if err = r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM integration_tokens WHERE user_id=? AND revoked_at IS NULL"), r.User.ID).Scan(&count); err != nil {
		return nil, err
	}
	if count >= 64 {
		return nil, conflict("revoke an existing token before creating another; maximum 64 non-revoked tokens")
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		return nil, err
	}
	raw := "lhp_" + base64.RawURLEncoding.EncodeToString(secret)
	c := IntegrationCredential{ID: integrationID(), Revision: "1", Name: name, SpaceID: in.SpaceID, SourceID: in.SourceID, Actions: actions, PermissionMode: in.PermissionMode, CreatedAt: now, ExpiresAt: expiry, Status: "active"}
	storedActions := actions
	if in.PermissionMode == "all" {
		storedActions = []string{}
	}
	encoded, _ := json.Marshal(storedActions)
	// never_expires carries permanent validity. The legacy NOT NULL timestamp
	// retains a real instant, not an artificial far-future expiry.
	storedExpiry := now
	if expiry != nil {
		storedExpiry = *expiry
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query(`INSERT INTO integration_tokens(id,user_id,name,token_hash,space_id,source_id,actions_json,permission_epoch,user_version,created_at,expires_at,never_expires,permission_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`), c.ID, r.User.ID, c.Name, integrationHash(raw), c.SpaceID, integrationNullableString(c.SourceID), string(encoded), r.Settings.AuthEpoch, r.User.Version, integrationStamp(now), integrationStamp(storedExpiry), expiry == nil, in.PermissionMode)
	if err != nil {
		return nil, err
	}
	return &Response{Status: 201, Data: map[string]any{"token": raw, "credential": c}}, nil
}

func integrationTokenVersionConflict(revision string) error {
	return &APIError{Status: 409, Code: "integration_token_version_conflict", Message: "This token changed. Reload it and review the changes before saving.", CurrentRevision: revision}
}

func requireIntegrationTokenRevision(expected, current string) error {
	value, err := integrationRevision(expected)
	if err != nil || value < 1 {
		return invalid("expectedRevision must be a canonical positive decimal string")
	}
	if expected != current {
		return integrationTokenVersionConflict(current)
	}
	return nil
}

func (a *App) updateIntegrationToken(r *Request) (*Response, error) {
	if err := requireIntegrationTokenCookie(r); err != nil {
		return nil, err
	}
	var in struct {
		ExpectedRevision string          `json:"expectedRevision"`
		Name             json.RawMessage `json:"name"`
		Actions          json.RawMessage `json:"actions"`
		PermissionMode   json.RawMessage `json:"permissionMode"`
		ExpiresAt        json.RawMessage `json:"expiresAt"`
	}
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	c, err := a.ownIntegrationToken(r, r.param("id"))
	if err != nil {
		return nil, err
	}
	if err = requireIntegrationTokenRevision(in.ExpectedRevision, c.Revision); err != nil {
		return nil, err
	}
	if c.Status == "revoked" || c.Status == "invalidated" {
		return nil, &APIError{Status: 409, Code: "integration_token_not_editable", Message: "Revoked or invalidated tokens cannot be reactivated. Create a new token when access is needed."}
	}
	if len(in.Name)+len(in.Actions)+len(in.PermissionMode)+len(in.ExpiresAt) == 0 {
		return nil, invalid("Provide at least one token field to change")
	}
	if c.Status == "expired" && len(in.ExpiresAt) == 0 {
		return nil, &APIError{Status: 400, Code: "integration_token_expiry_required", Message: "An expired token needs an explicit new expiresAt, or null for permanent validity."}
	}
	if len(in.Name) > 0 {
		if err = json.Unmarshal(in.Name, &c.Name); err != nil || strings.TrimSpace(string(in.Name)) == "null" {
			return nil, invalid("name must be a string")
		}
		c.Name, err = required(c.Name, "token name", 100)
		if err != nil {
			return nil, err
		}
	}
	mode := c.PermissionMode
	if len(in.PermissionMode) > 0 {
		if err = json.Unmarshal(in.PermissionMode, &mode); err != nil || strings.TrimSpace(string(in.PermissionMode)) == "null" {
			return nil, invalid("permissionMode must be selected or all")
		}
	}
	actions := c.Actions
	if len(in.Actions) > 0 {
		if err = json.Unmarshal(in.Actions, &actions); err != nil || strings.TrimSpace(string(in.Actions)) == "null" {
			return nil, invalid("actions must be an array")
		}
	} else if mode == "all" {
		actions = []string{}
	} else if c.PermissionMode == "all" && mode == "selected" {
		return nil, invalid("Switching to selected permission mode requires an explicit actions list")
	}
	actions, err = a.validateIntegrationTokenPermissions(r, c.SpaceID, c.SourceID, mode, actions)
	if err != nil {
		return nil, err
	}
	if len(in.ExpiresAt) > 0 {
		c.ExpiresAt, err = integrationTokenExpiry(in.ExpiresAt, time.Now().UTC())
		if err != nil {
			return nil, err
		}
		if c.ExpiresAt != nil {
			c.storedExpiry = *c.ExpiresAt
		}
	}
	if mode == "all" {
		actions = []string{}
	}
	encoded, _ := json.Marshal(actions)
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE integration_tokens SET name=?,actions_json=?,permission_mode=?,expires_at=?,never_expires=?,revision=revision+1 WHERE id=? AND user_id=? AND revision=? AND revoked_at IS NULL"), c.Name, string(encoded), mode, integrationStamp(c.storedExpiry), c.ExpiresAt == nil, c.ID, r.User.ID, c.revision)
	if err != nil {
		return nil, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n != 1 {
		return nil, integrationTokenVersionConflict(c.Revision)
	}
	c, err = a.ownIntegrationToken(r, c.ID)
	if err != nil {
		return nil, err
	}
	credential, err := a.integrationTokenCredential(r, c)
	if err != nil {
		return nil, err
	}
	return ok(credential), nil
}

func (a *App) revokeIntegrationToken(r *Request) (*Response, error) {
	if err := requireIntegrationTokenCookie(r); err != nil {
		return nil, err
	}
	c, err := a.ownIntegrationToken(r, r.param("id"))
	if err != nil {
		return nil, err
	}
	if c.RevokedAt == nil {
		if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE integration_tokens SET revoked_at=?,revision=revision+1 WHERE id=? AND user_id=? AND revoked_at IS NULL"), integrationStamp(time.Now().UTC().Truncate(time.Microsecond)), c.ID, r.User.ID); err != nil {
			return nil, err
		}
	}
	return ok(map[string]any{"success": true}), nil
}

func (a *App) deleteIntegrationTokenRecord(r *Request) (*Response, error) {
	if err := requireIntegrationTokenCookie(r); err != nil {
		return nil, err
	}
	var in struct {
		ExpectedRevision string `json:"expectedRevision"`
	}
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	c, err := a.ownIntegrationToken(r, r.param("id"))
	if err != nil {
		return nil, err
	}
	if err = requireIntegrationTokenRevision(in.ExpectedRevision, c.Revision); err != nil {
		return nil, err
	}
	if c.RevokedAt == nil {
		return nil, &APIError{Status: 409, Code: "integration_token_not_revoked", Message: "Revoke this token before deleting its record."}
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM integration_tokens WHERE id=? AND user_id=? AND revision=? AND revoked_at IS NOT NULL"), c.ID, r.User.ID, c.revision)
	if err != nil {
		return nil, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n != 1 {
		return nil, integrationTokenVersionConflict(c.Revision)
	}
	return ok(map[string]any{"success": true}), nil
}
