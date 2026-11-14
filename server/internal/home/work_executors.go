package home

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

type WorkExecutor struct {
	ID                   string `json:"id"`
	SpaceID              string `json:"spaceId"`
	Name                 string `json:"name"`
	Endpoint             string `json:"endpoint"`
	AllowPrivateNetwork  bool   `json:"allowPrivateNetwork"`
	ResourceKey          string `json:"resourceKey"`
	PollIntervalSeconds  int    `json:"pollIntervalSeconds"`
	TimeoutSeconds       int    `json:"timeoutSeconds"`
	Enabled              bool   `json:"enabled"`
	Archived             bool   `json:"archived"`
	CredentialConfigured bool   `json:"credentialConfigured"`
	Revision             string `json:"revision"`
	CreatedAt            string `json:"createdAt"`
	UpdatedAt            string `json:"updatedAt"`
	credentialCipher     string
	createHash           string
}

const workExecutorColumns = "id,space_id,name,endpoint,private_network,resource_key,poll_seconds,timeout_seconds,enabled,archived,credential_cipher,revision,created_at,updated_at,create_hash"

func scanWorkExecutor(row interface{ Scan(...any) error }) (*WorkExecutor, error) {
	v := &WorkExecutor{}
	var revision int64
	err := row.Scan(&v.ID, &v.SpaceID, &v.Name, &v.Endpoint, &v.AllowPrivateNetwork, &v.ResourceKey, &v.PollIntervalSeconds, &v.TimeoutSeconds, &v.Enabled, &v.Archived, &v.credentialCipher, &revision, &v.CreatedAt, &v.UpdatedAt, &v.createHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, missing()
	}
	if err != nil {
		return nil, err
	}
	v.Revision, v.CredentialConfigured = strconv.FormatInt(revision, 10), v.credentialCipher != ""
	return v, nil
}

func (a *App) loadWorkExecutor(r *Request, space, id string) (*WorkExecutor, error) {
	if !validID(id) {
		return nil, missing()
	}
	return scanWorkExecutor(r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT "+workExecutorColumns+" FROM work_executors WHERE id=? AND space_id=?"), id, space))
}

func normalizeWorkExecutor(v *WorkExecutor) error {
	var err error
	v.Name, err = required(v.Name, "name", 160)
	if err != nil {
		return err
	}
	if !workResourceKeyPattern.MatchString(v.ResourceKey) {
		return invalid("resourceKey must be 1–160 ASCII letters, digits or . _ : / - and start with a letter or digit.")
	}
	if v.PollIntervalSeconds < 2 || v.PollIntervalSeconds > 60 || v.TimeoutSeconds < 30 || v.TimeoutSeconds > 86400 {
		return invalid("Use pollIntervalSeconds 2–60 and timeoutSeconds 30–86400.")
	}
	if err = bounded(v.Endpoint, "endpoint", 2048); err != nil {
		return err
	}
	u, err := integrationRemoteURL(v.Endpoint, v.AllowPrivateNetwork)
	if err != nil {
		return err
	}
	if u.RawQuery != "" || u.ForceQuery {
		return invalid("Executor endpoints cannot contain query parameters.")
	}
	if u.Scheme != "https" {
		ip, parseErr := netip.ParseAddr(u.Hostname())
		if u.Scheme != "http" || !v.AllowPrivateNetwork || parseErr != nil || !ip.IsPrivate() || !integrationAllowedAddress(ip, true) {
			return invalid("Use HTTPS; HTTP is allowed only for an explicitly permitted private IP address.")
		}
	}
	v.Endpoint = strings.TrimRight(u.String(), "/")
	return nil
}

type workExecutorSecretValue struct {
	BearerToken *string `json:"bearerToken,omitempty"`
	Clear       bool    `json:"clearBearerToken,omitempty"`
}

func decodeWorkExecutorSecret(raw json.RawMessage) (workExecutorSecretValue, error) {
	value := workExecutorSecretValue{}
	if len(raw) == 0 {
		return value, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return value, invalid("secret cannot be null.")
	}
	var in struct {
		BearerToken json.RawMessage `json:"bearerToken"`
		Clear       json.RawMessage `json:"clearBearerToken"`
	}
	if err := decodeAutomationJSON(raw, &in); err != nil {
		return value, err
	}
	var err error
	value.Clear, err = automationBool(in.Clear, false)
	if err != nil {
		return value, err
	}
	if len(in.BearerToken) > 0 {
		var token string
		if json.Unmarshal(in.BearerToken, &token) != nil || token == "" || len(token) > 2048 {
			return value, invalid("bearerToken must be a nonempty string of at most 2048 bytes.")
		}
		for _, ch := range token {
			if ch < 33 || ch > 126 {
				return value, invalid("bearerToken must contain printable ASCII without whitespace.")
			}
		}
		value.BearerToken = &token
	}
	if value.Clear && value.BearerToken != nil {
		return value, invalid("Choose a new bearerToken or clearBearerToken, not both.")
	}
	return value, nil
}

func (a *App) setWorkExecutorSecret(v *WorkExecutor, secret workExecutorSecretValue) error {
	if secret.Clear {
		v.credentialCipher = ""
	}
	if secret.BearerToken != nil {
		cipher, err := a.encryptIntegrationSecret("work-executor:"+v.ID, *secret.BearerToken)
		if err != nil {
			return err
		}
		v.credentialCipher = cipher
	}
	v.CredentialConfigured = v.credentialCipher != ""
	if v.Enabled && !v.CredentialConfigured {
		return invalid("An enabled executor requires a configured bearer credential.")
	}
	return nil
}

func (a *App) activeWorkExecutions(r *Request, executor string) (int, error) {
	var count int
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM work_executions WHERE executor_id=? AND state IN ('queued','dispatching','running','unknown')"), executor).Scan(&count)
	return count, err
}

func (a *App) workExecutorReply(r *Request, value *WorkExecutor, flags map[string]any) (*Response, error) {
	active, err := a.activeWorkExecutions(r, value.ID)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"executor": value, "canEdit": r.User.Role == "Owner" && workCanExecute(r), "canExecute": workCanExecute(r), "activeExecutions": active}
	for key, val := range flags {
		out[key] = val
	}
	return ok(out), nil
}

func (a *App) getWorkExecutor(r *Request) (*Response, error) {
	space, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	v, err := a.loadWorkExecutor(r, space.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	return a.workExecutorReply(r, v, nil)
}

func (a *App) createWorkExecutor(r *Request) (*Response, error) {
	space, err := r.workExecuteSpace()
	if err != nil {
		return nil, err
	}
	if err = requireWorkExecutorOwner(r); err != nil {
		return nil, err
	}
	var in struct {
		ID                  string          `json:"id"`
		Name                string          `json:"name"`
		Endpoint            string          `json:"endpoint"`
		ResourceKey         string          `json:"resourceKey"`
		AllowPrivateNetwork json.RawMessage `json:"allowPrivateNetwork"`
		Enabled             json.RawMessage `json:"enabled"`
		PollIntervalSeconds json.RawMessage `json:"pollIntervalSeconds"`
		TimeoutSeconds      json.RawMessage `json:"timeoutSeconds"`
		Secret              json.RawMessage `json:"secret"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if !validID(in.ID) {
		return nil, invalid("id must be 32 lowercase hexadecimal characters.")
	}
	private, err := automationBool(in.AllowPrivateNetwork, false)
	if err != nil {
		return nil, err
	}
	enabled, err := automationBool(in.Enabled, false)
	if err != nil {
		return nil, err
	}
	poll, timeout := 5, 3600
	if len(in.PollIntervalSeconds) > 0 && (string(in.PollIntervalSeconds) == "null" || json.Unmarshal(in.PollIntervalSeconds, &poll) != nil) {
		return nil, invalid("pollIntervalSeconds must be an integer.")
	}
	if len(in.TimeoutSeconds) > 0 && (string(in.TimeoutSeconds) == "null" || json.Unmarshal(in.TimeoutSeconds, &timeout) != nil) {
		return nil, invalid("timeoutSeconds must be an integer.")
	}
	secret, err := decodeWorkExecutorSecret(in.Secret)
	if err != nil {
		return nil, err
	}
	v := &WorkExecutor{ID: in.ID, SpaceID: space.ID, Name: in.Name, Endpoint: in.Endpoint, ResourceKey: in.ResourceKey, AllowPrivateNetwork: private, Enabled: enabled, PollIntervalSeconds: poll, TimeoutSeconds: timeout}
	if err = normalizeWorkExecutor(v); err != nil {
		return nil, err
	}
	hash := workPayloadHash([]any{v.ID, v.Name, v.Endpoint, v.ResourceKey, v.AllowPrivateNetwork, v.Enabled, v.PollIntervalSeconds, v.TimeoutSeconds, secret})
	old, loadErr := a.loadWorkExecutor(r, space.ID, v.ID)
	if loadErr == nil {
		if old.createHash != hash {
			return nil, conflict("This executor ID was already used with different content.")
		}
		return a.workExecutorReply(r, old, map[string]any{"replayed": true})
	}
	if code, _, domain := automationFailure(loadErr); !domain || code != "not_found" {
		return nil, loadErr
	}
	if err = a.setWorkExecutorSecret(v, secret); err != nil {
		return nil, err
	}
	v.Revision, v.CreatedAt, v.UpdatedAt, v.createHash = "1", workScheduleStamp(time.Now()), "", hash
	v.UpdatedAt = v.CreatedAt
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_executors(id,space_id,name,endpoint,private_network,resource_key,poll_seconds,timeout_seconds,enabled,archived,credential_cipher,revision,created_at,updated_at,create_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"), v.ID, space.ID, v.Name, v.Endpoint, private, v.ResourceKey, v.PollIntervalSeconds, v.TimeoutSeconds, enabled, false, v.credentialCipher, 1, v.CreatedAt, v.UpdatedAt, hash)
	if err != nil {
		return nil, err
	}
	return a.workExecutorReply(r, v, map[string]any{"created": true})
}

func (a *App) updateWorkExecutor(r *Request) (*Response, error) {
	space, err := r.workExecuteSpace()
	if err != nil {
		return nil, err
	}
	if err = requireWorkExecutorOwner(r); err != nil {
		return nil, err
	}
	old, err := a.loadWorkExecutor(r, space.ID, r.param("id"))
	if err != nil {
		return nil, err
	}
	var raw map[string]json.RawMessage
	if err = r.decode(&raw); err != nil {
		return nil, err
	}
	allowed := map[string]bool{"expectedRevision": true, "name": true, "endpoint": true, "resourceKey": true, "pollIntervalSeconds": true, "timeoutSeconds": true, "allowPrivateNetwork": true, "enabled": true, "archived": true, "secret": true}
	for key := range raw {
		if !allowed[key] {
			return nil, invalid("Unknown executor field: " + key)
		}
	}
	if len(raw) < 2 {
		return nil, invalid("At least one executor field is required.")
	}
	var expected string
	if err = workDecodeField(raw, "expectedRevision", &expected, false); err != nil {
		return nil, err
	}
	if err = automationRevision(expected, old.Revision, "executor"); err != nil {
		return nil, err
	}
	v := *old
	for _, field := range []struct {
		name   string
		target any
	}{{"name", &v.Name}, {"endpoint", &v.Endpoint}, {"resourceKey", &v.ResourceKey}, {"pollIntervalSeconds", &v.PollIntervalSeconds}, {"timeoutSeconds", &v.TimeoutSeconds}, {"allowPrivateNetwork", &v.AllowPrivateNetwork}, {"enabled", &v.Enabled}, {"archived", &v.Archived}} {
		if err = workDecodeField(raw, field.name, field.target, false); err != nil {
			return nil, err
		}
	}
	secret, err := decodeWorkExecutorSecret(raw["secret"])
	if err != nil {
		return nil, err
	}
	if err = normalizeWorkExecutor(&v); err != nil {
		return nil, err
	}
	connectionChanged := v.Endpoint != old.Endpoint || v.AllowPrivateNetwork != old.AllowPrivateNetwork || v.ResourceKey != old.ResourceKey || v.PollIntervalSeconds != old.PollIntervalSeconds || v.TimeoutSeconds != old.TimeoutSeconds || secret.BearerToken != nil || secret.Clear || (v.Archived && !old.Archived)
	if connectionChanged {
		active, err := a.activeWorkExecutions(r, v.ID)
		if err != nil {
			return nil, err
		}
		if active > 0 {
			return nil, &APIError{Status: 409, Code: "work_executor_in_use", Message: "Finish or explicitly resolve pending executions before changing the connection, credential, resource or archive state.", Details: map[string]any{"activeExecutions": active}}
		}
	}
	if err = a.setWorkExecutorSecret(&v, secret); err != nil {
		return nil, err
	}
	if v.Name == old.Name && v.Endpoint == old.Endpoint && v.ResourceKey == old.ResourceKey && v.PollIntervalSeconds == old.PollIntervalSeconds && v.TimeoutSeconds == old.TimeoutSeconds && v.AllowPrivateNetwork == old.AllowPrivateNetwork && v.Enabled == old.Enabled && v.Archived == old.Archived && !connectionChanged {
		return a.workExecutorReply(r, old, map[string]any{"unchanged": true})
	}
	revision, _ := strconv.ParseInt(old.Revision, 10, 64)
	v.Revision, v.UpdatedAt = strconv.FormatInt(revision+1, 10), workScheduleStamp(time.Now())
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_executors SET name=?,endpoint=?,private_network=?,resource_key=?,poll_seconds=?,timeout_seconds=?,enabled=?,archived=?,credential_cipher=?,revision=revision+1,updated_at=? WHERE id=?"), v.Name, v.Endpoint, v.AllowPrivateNetwork, v.ResourceKey, v.PollIntervalSeconds, v.TimeoutSeconds, v.Enabled, v.Archived, v.credentialCipher, v.UpdatedAt, v.ID)
	if err != nil {
		return nil, err
	}
	if old.Enabled && !v.Enabled {
		_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_executions SET state='canceled',code='executor_disabled',message='The executor was disabled before dispatch.',finished_at=?,revision=revision+1 WHERE executor_id=? AND state='queued'"), v.UpdatedAt, v.ID)
		if err != nil {
			return nil, err
		}
	}
	r.WakeWorkAutomation = true
	return a.workExecutorReply(r, &v, nil)
}

func (a *App) listWorkExecutors(r *Request) (*Response, error) {
	space, err := r.workSpace(false)
	if err != nil {
		return nil, err
	}
	in, err := readWorkAutomationPage(r, "executors")
	if err != nil {
		return nil, err
	}
	where, args := "space_id=? AND archived=?", []any{space.ID, in.Archived}
	if in.Q != "" {
		where += " AND LOWER(name) LIKE ? ESCAPE '\\'"
		args = append(args, "%"+automationEscapeLike(strings.ToLower(in.Q))+"%")
	}
	where, args, filter, err := workAutomationPageWhere("executors", space.ID, where, args, in)
	if err != nil {
		return nil, err
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+workExecutorColumns+" FROM work_executors WHERE "+where+" ORDER BY created_at DESC,id DESC LIMIT ?"), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []*WorkExecutor{}
	for rows.Next() {
		value, err := scanWorkExecutor(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, value)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	var cursor *string
	if len(items) > in.Limit {
		items = items[:in.Limit]
		last := items[len(items)-1]
		cursor = workAutomationNextCursor(filter, last.CreatedAt, last.ID)
	}
	return ok(map[string]any{"items": items, "nextCursor": cursor, "canEdit": r.User.Role == "Owner" && workCanExecute(r), "canExecute": workCanExecute(r)}), nil
}
