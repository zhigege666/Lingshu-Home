package home

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var integrationTokenPattern = regexp.MustCompile(`^lhp_[A-Za-z0-9_-]{43}$`)
var integrationExternalID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var integrationOwnerPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$`)
var integrationRepoPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)

type IntegrationSync struct {
	Mode              string `json:"mode"`
	IntervalSeconds   int    `json:"intervalSeconds,omitempty"`
	StaleAfterSeconds int    `json:"staleAfterSeconds"`
}
type IntegrationFailure struct {
	Code    string    `json:"code"`
	Message string    `json:"message"`
	At      time.Time `json:"at"`
}
type IntegrationSource struct {
	ID                   string              `json:"id"`
	SpaceID              string              `json:"spaceId"`
	Name                 string              `json:"name"`
	Kind                 string              `json:"kind"`
	SchemaID             string              `json:"schemaId"`
	SchemaVersion        int                 `json:"schemaVersion"`
	DatasetID            string              `json:"datasetId"`
	Connection           map[string]string   `json:"connection"`
	Sync                 IntegrationSync     `json:"sync"`
	Enabled              bool                `json:"enabled"`
	ConfigRevision       string              `json:"configRevision"`
	Revision             string              `json:"revision"`
	CredentialConfigured bool                `json:"credentialConfigured"`
	CreatedAt            time.Time           `json:"createdAt"`
	UpdatedAt            time.Time           `json:"updatedAt"`
	NextSyncAt           *time.Time          `json:"nextSyncAt"`
	LastSuccessAt        *time.Time          `json:"lastSuccessAt"`
	LastError            *IntegrationFailure `json:"lastError"`
	createdBy            string
	credentialCipher     string
}
type IntegrationCredential struct {
	ID             string     `json:"id"`
	Revision       string     `json:"revision"`
	Name           string     `json:"name"`
	SpaceID        string     `json:"spaceId"`
	SourceID       *string    `json:"sourceId"`
	Actions        []string   `json:"actions"`
	PermissionMode string     `json:"permissionMode"`
	CreatedAt      time.Time  `json:"createdAt"`
	ExpiresAt      *time.Time `json:"expiresAt"`
	RevokedAt      *time.Time `json:"revokedAt"`
	Status         string     `json:"status"`
}
type integrationTime struct {
	Time  time.Time
	Valid bool
}

func (v *integrationTime) Scan(src any) error {
	if src == nil {
		v.Valid = false
		return nil
	}
	if t, ok := src.(time.Time); ok {
		v.Time = t.UTC()
		v.Valid = true
		return nil
	}
	var s string
	switch x := src.(type) {
	case string:
		s = x
	case []byte:
		s = string(x)
	default:
		return fmt.Errorf("unsupported integration timestamp %T", src)
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999-07:00", "2006-01-02 15:04:05.999999999+00:00", "2006-01-02 15:04:05.999999999"} {
		if t, err := time.Parse(layout, s); err == nil {
			v.Time = t.UTC()
			v.Valid = true
			return nil
		}
	}
	return errors.New("invalid integration timestamp")
}
func (v integrationTime) Pointer() *time.Time {
	if !v.Valid {
		return nil
	}
	t := v.Time
	return &t
}
func integrationStamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }
func integrationNullableTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return integrationStamp(*t)
}
func integrationNullableString(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}
func integrationHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
func integrationID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func integrationRevision(s string) (int64, error) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 || strconv.FormatInt(n, 10) != s {
		return 0, invalid("revision must be a canonical nonnegative decimal string")
	}
	return n, nil
}
func integrationCapabilities() map[string]any {
	return map[string]any{
		"sourceKinds":     []string{"local-navigation", "local-document-activity", "external-push", "github-traffic", "calendar-ics", "weather-open-meteo", "external-json"},
		"deliveryModes":   []string{"push", "poll"},
		"componentImport": map[string]any{"manifestVersion": 1, "executable": false, "inputModes": []string{"url", "json"}},
		"websocket":       map[string]any{"supported": false, "enabled": false},
		"datasetSchemas":  []map[string]any{{"id": "navigation.collection", "version": 1}, {"id": "github.traffic", "version": 1}, {"id": "calendar.events", "version": 1}, {"id": "weather.forecast", "version": 1}, {"id": "metrics.summary", "version": 1}, {"id": "status.collection", "version": 1}, {"id": "documents.activity", "version": 1}},
		"mcp":             map[string]any{"endpoint": "/mcp", "transport": "streamable-http", "authentication": "bearer", "protocolVersions": []string{"2026-07-28", "2025-11-25"}},
	}
}

func (a *App) initializeIntegrations() error {
	path := filepath.Join(a.config.DataDir, "integrations.key")
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		var count int
		if err := a.store.DB.QueryRowContext(context.Background(), "SELECT (SELECT COUNT(*) FROM integration_sources WHERE credential_cipher IS NOT NULL)+(SELECT COUNT(*) FROM network_proxy_config WHERE credential_cipher IS NOT NULL)").Scan(&count); err != nil {
			return err
		}
		if count > 0 {
			return errors.New("integrations.key is missing; restore the matching key backup before starting")
		}
	} else if err != nil {
		return err
	}
	_, err := a.integrationAEADWithCreate(true)
	return err
}
func (a *App) integrationAEAD() (cipher.AEAD, error) { return a.integrationAEADWithCreate(false) }
func (a *App) integrationAEADWithCreate(create bool) (cipher.AEAD, error) {
	path := filepath.Join(a.config.DataDir, "integrations.key")
	if create {
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err == nil {
			key := make([]byte, 32)
			_, err = rand.Read(key)
			if err == nil {
				_, err = f.Write(key)
			}
			if err == nil {
				err = f.Sync()
			}
			closeErr := f.Close()
			if err != nil {
				return nil, err
			}
			if closeErr != nil {
				return nil, closeErr
			}
		} else if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, errors.New("integration credential key is unavailable")
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("integration credential key must be a private regular file (0600)")
	}
	key, err := os.ReadFile(path)
	if err != nil || len(key) != 32 {
		return nil, errors.New("integration credential key is invalid")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func (a *App) encryptIntegrationSecret(id, plain string) (string, error) {
	ae, err := a.integrationAEAD()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, ae.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	blob := ae.Seal(nonce, nonce, []byte(plain), []byte("Lingshu-Home/source/v1/"+id))
	return base64.RawStdEncoding.EncodeToString(blob), nil
}
func (a *App) decryptIntegrationSecret(id, encoded string) (string, error) {
	ae, err := a.integrationAEAD()
	if err != nil {
		return "", err
	}
	blob, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil || len(blob) < ae.NonceSize()+ae.Overhead() {
		return "", errors.New("integration credential is unavailable")
	}
	plain, err := ae.Open(nil, blob[:ae.NonceSize()], blob[ae.NonceSize():], []byte("Lingshu-Home/source/v1/"+id))
	if err != nil {
		return "", errors.New("integration credential is unavailable")
	}
	return string(plain), nil
}

func (a *App) authenticateBearer(r *Request, raw string) error {
	if !integrationTokenPattern.MatchString(raw) {
		return unauthorized()
	}
	return a.authenticateBearerHash(r, integrationHash(raw))
}

// Background jobs retain a token hash, never the bearer credential itself.
// Authorization is still checked against the current token and account rows.
func (a *App) authenticateBearerHash(r *Request, hash string) error {
	var userID, spaceID string
	var source sql.NullString
	var actions []byte
	var epoch, version int64
	var neverExpires bool
	var permissionMode string
	var expires, revoked integrationTime
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query(`SELECT user_id,space_id,source_id,actions_json,permission_epoch,user_version,expires_at,revoked_at,never_expires,permission_mode FROM integration_tokens WHERE token_hash=?`), hash).Scan(&userID, &spaceID, &source, &actions, &epoch, &version, &expires, &revoked, &neverExpires, &permissionMode)
	if errors.Is(err, sql.ErrNoRows) {
		return unauthorized()
	}
	if err != nil {
		return err
	}
	if (!neverExpires && (!expires.Valid || !expires.Time.After(time.Now()))) || revoked.Valid || epoch != r.Settings.AuthEpoch {
		return unauthorized()
	}
	user, err := a.loadUser(r.HTTP.Context(), r.Q, userID)
	if err != nil {
		return err
	}
	if user == nil || !canLogin(user, r.Settings) || user.Version != version {
		return unauthorized()
	}
	var scopes []string
	if err := json.Unmarshal(actions, &scopes); err != nil {
		return err
	}
	r.User = user
	r.Bearer = true
	r.BearerTokenHash = hash
	r.TokenSpaceID = spaceID
	r.TokenSourceID = source.String
	r.AllowedActions = map[string]bool{}
	space, err := r.requireSpace(spaceID, false)
	if err != nil {
		return unauthorized()
	}
	if permissionMode == "all" {
		_, canWrite := r.spaceAccess(space)
		scopes = integrationAllTokenActions(source.Valid, canWrite)
	} else if permissionMode != "selected" {
		return unauthorized()
	}
	for _, scope := range scopes {
		r.AllowedActions[scope] = true
	}
	return nil
}

const integrationSourceColumns = `s.id,s.space_id,s.created_by,s.name,s.kind,s.schema_id,s.schema_version,s.connection_json,s.sync_json,s.enabled,s.config_revision,s.credential_cipher,s.created_at,s.updated_at,s.next_sync_at,s.last_success_at,s.last_error_json,COALESCE(p.revision,0)`

func scanIntegrationSource(row interface{ Scan(...any) error }) (IntegrationSource, error) {
	var s IntegrationSource
	var connection, syncJSON, lastError []byte
	var credential sql.NullString
	var created, updated, next, success integrationTime
	var revision, configRevision int64
	err := row.Scan(&s.ID, &s.SpaceID, &s.createdBy, &s.Name, &s.Kind, &s.SchemaID, &s.SchemaVersion, &connection, &syncJSON, &s.Enabled, &configRevision, &credential, &created, &updated, &next, &success, &lastError, &revision)
	if errors.Is(err, sql.ErrNoRows) {
		return s, missing()
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(connection, &s.Connection); err != nil {
		return s, err
	}
	if err := json.Unmarshal(syncJSON, &s.Sync); err != nil {
		return s, err
	}
	if len(lastError) > 0 {
		if err := json.Unmarshal(lastError, &s.LastError); err != nil {
			return s, err
		}
	}
	s.DatasetID = "source:" + s.ID
	s.Revision = strconv.FormatInt(revision, 10)
	s.ConfigRevision = strconv.FormatInt(configRevision, 10)
	s.CreatedAt = created.Time
	s.UpdatedAt = updated.Time
	s.NextSyncAt = next.Pointer()
	s.LastSuccessAt = success.Pointer()
	s.credentialCipher = credential.String
	s.CredentialConfigured = credential.Valid && credential.String != ""
	return s, nil
}
func (a *App) loadIntegrationSource(ctx context.Context, q Queryer, id string) (IntegrationSource, error) {
	return scanIntegrationSource(q.QueryRowContext(ctx, a.store.Query("SELECT "+integrationSourceColumns+" FROM integration_sources s LEFT JOIN integration_snapshots p ON p.source_id=s.id WHERE s.id=?"), id))
}
func (a *App) requireIntegrationSource(r *Request, id, action string, write bool) (IntegrationSource, error) {
	if err := r.requireAction(action); err != nil {
		return IntegrationSource{}, err
	}
	if r.TokenSourceID != "" && r.TokenSourceID != id {
		return IntegrationSource{}, missing()
	}
	s, err := a.loadIntegrationSource(r.HTTP.Context(), r.Q, id)
	if err != nil {
		return s, err
	}
	if _, err := r.requireSpace(s.SpaceID, write); err != nil {
		return IntegrationSource{}, err
	}
	return s, nil
}
func (a *App) listIntegrationSources(r *Request) (*Response, error) {
	if err := r.requireAction("sources:read"); err != nil {
		return nil, err
	}
	space := r.param("spaceId")
	if _, err := r.requireSpace(space, false); err != nil {
		return nil, err
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT "+integrationSourceColumns+" FROM integration_sources s LEFT JOIN integration_snapshots p ON p.source_id=s.id WHERE s.space_id=? ORDER BY s.created_at,s.id"), space)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []IntegrationSource{}
	for rows.Next() {
		s, err := scanIntegrationSource(rows)
		if err != nil {
			return nil, err
		}
		if r.TokenSourceID == "" || r.TokenSourceID == s.ID {
			items = append(items, s)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ok(items), nil
}
func (a *App) getIntegrationSource(r *Request) (*Response, error) {
	s, err := a.requireIntegrationSource(r, r.param("id"), "sources:read", false)
	if err != nil {
		return nil, err
	}
	return ok(s), nil
}

type integrationSecretInput struct {
	Token            string `json:"token,omitempty"`
	URL              string `json:"url,omitempty"`
	BearerToken      string `json:"bearerToken,omitempty"`
	APIKey           string `json:"apiKey,omitempty"`
	ClearBearerToken bool   `json:"clearBearerToken,omitempty"`
}
type integrationSourceInput struct {
	Name          string                  `json:"name"`
	Kind          string                  `json:"kind"`
	SchemaID      string                  `json:"schemaId"`
	SchemaVersion int                     `json:"schemaVersion"`
	Connection    map[string]string       `json:"connection"`
	Sync          IntegrationSync         `json:"sync"`
	Enabled       *bool                   `json:"enabled"`
	Secret        *integrationSecretInput `json:"secret,omitempty"`
}

func validateIntegrationConfiguration(name, kind, schema string, version int, connection map[string]string, syncConfig *IntegrationSync, secret *integrationSecretInput) error {
	validatedName, nameErr := required(name, "source name", 100)
	if nameErr != nil {
		return nameErr
	}
	if validatedName != name {
		return invalid("source name must not contain surrounding whitespace")
	}
	if version != 1 {
		return invalid("unsupported source schema version")
	}
	if connection == nil {
		return invalid("connection must be an object")
	}
	switch kind {
	case "external-push":
		if (schema != "navigation.collection" && !integrationComponentSchema(schema)) || syncConfig.Mode != "push" || len(connection) != 0 || syncConfig.IntervalSeconds != 0 || secret != nil {
			return invalid("external-push requires a supported schema@1, empty connection, push mode and no secret")
		}
		if syncConfig.StaleAfterSeconds == 0 {
			syncConfig.StaleAfterSeconds = 86400
		}
	case "github-traffic":
		if schema != "github.traffic" || syncConfig.Mode != "poll" || len(connection) != 2 || !integrationOwnerPattern.MatchString(connection["owner"]) || !integrationRepoPattern.MatchString(connection["repo"]) || connection["repo"] == "." || connection["repo"] == ".." {
			return invalid("github-traffic requires github.traffic@1, poll mode and a valid owner/repo connection")
		}
		if syncConfig.IntervalSeconds == 0 {
			syncConfig.IntervalSeconds = 21600
		}
		if syncConfig.IntervalSeconds < 300 || syncConfig.IntervalSeconds > 604800 {
			return invalid("poll interval must be between 300 and 604800 seconds")
		}
		if syncConfig.StaleAfterSeconds == 0 {
			syncConfig.StaleAfterSeconds = 2 * syncConfig.IntervalSeconds
		}
		if secret != nil {
			if secret.ClearBearerToken || secret.URL != "" || secret.APIKey != "" || secret.BearerToken != "" || len(secret.Token) < 8 || len(secret.Token) > 512 {
				return invalid("GitHub token must contain 8–512 bytes")
			}
			for _, ch := range secret.Token {
				if ch <= 32 || ch == 127 {
					return invalid("GitHub token must not contain whitespace or control characters")
				}
			}
		}
	case "calendar-ics", "weather-open-meteo", "external-json":
		if err := validateComponentConfiguration(kind, schema, connection, syncConfig, secret); err != nil {
			return err
		}
	default:
		return invalid("unsupported source kind")
	}
	if syncConfig.StaleAfterSeconds < 60 || syncConfig.StaleAfterSeconds > 2592000 {
		return invalid("staleAfterSeconds must be between 60 and 2592000")
	}
	return nil
}

// A writer needs the source ID and revision for its next guarded update.
// Reading stored connection details and sync history requires sources:read.
func (r *Request) sourceWriteResult(s IntegrationSource) any {
	if r.Bearer && !r.AllowedActions["sources:read"] {
		return map[string]string{"id": s.ID, "configRevision": s.ConfigRevision}
	}
	return s
}

func (a *App) createIntegrationSource(r *Request) (*Response, error) {
	if r.User == nil {
		return nil, unauthorized()
	}
	if r.TokenSourceID != "" {
		return nil, forbidden()
	}
	if err := r.requireAction("sources:write"); err != nil {
		return nil, err
	}
	space := r.param("spaceId")
	if _, err := r.requireSpace(space, true); err != nil {
		return nil, err
	}
	var in integrationSourceInput
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	in.Name = strings.TrimSpace(in.Name)
	if integrationSecretEmpty(in.Secret) {
		in.Secret = nil
	}
	if err := validateIntegrationConfiguration(in.Name, in.Kind, in.SchemaID, in.SchemaVersion, in.Connection, &in.Sync, in.Secret); err != nil {
		return nil, err
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	if enabled && !integrationHasRequiredSecret(in.Kind, in.Connection, in.Secret) {
		return nil, invalid("an enabled source requires its subscription URL or credential")
	}
	var count int
	if err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT COUNT(*) FROM integration_sources WHERE space_id=?"), space).Scan(&count); err != nil {
		return nil, err
	}
	if count >= 64 {
		return nil, conflict("maximum 64 external sources per space")
	}
	id := integrationID()
	now := time.Now().UTC()
	var encrypted any
	if in.Secret != nil {
		ciphertext, err := a.encryptIntegrationSecret(id, integrationSecretPlain(in.Kind, in.Secret))
		if err != nil {
			return nil, err
		}
		encrypted = ciphertext
	}
	var next any
	if enabled && integrationPollingKind(in.Kind) {
		next = integrationStamp(now)
	}
	conn, _ := json.Marshal(in.Connection)
	syncJSON, _ := json.Marshal(in.Sync)
	_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query(`INSERT INTO integration_sources(id,space_id,created_by,name,kind,schema_id,schema_version,connection_json,sync_json,enabled,config_revision,credential_cipher,created_at,updated_at,next_sync_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`), id, space, r.User.ID, in.Name, in.Kind, in.SchemaID, in.SchemaVersion, string(conn), string(syncJSON), enabled, encrypted, integrationStamp(now), integrationStamp(now), next)
	if err != nil {
		return nil, err
	}
	s, err := a.loadIntegrationSource(r.HTTP.Context(), r.Q, id)
	if err != nil {
		return nil, err
	}
	r.WakeIntegrations = true
	return &Response{Status: 201, Data: r.sourceWriteResult(s)}, nil
}
func (a *App) updateIntegrationSource(r *Request) (*Response, error) {
	if r.User == nil {
		return nil, unauthorized()
	}
	s, err := a.requireIntegrationSource(r, r.param("id"), "sources:write", true)
	if err != nil {
		return nil, err
	}
	var in struct {
		ExpectedConfigRevision string                  `json:"expectedConfigRevision"`
		Name                   string                  `json:"name"`
		Enabled                *bool                   `json:"enabled"`
		Connection             map[string]string       `json:"connection"`
		Sync                   IntegrationSync         `json:"sync"`
		Secret                 *integrationSecretInput `json:"secret,omitempty"`
	}
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	if _, err := integrationRevision(in.ExpectedConfigRevision); err != nil {
		return nil, err
	}
	if in.ExpectedConfigRevision != s.ConfigRevision {
		return nil, &APIError{Status: 409, Code: "source_config_conflict", Message: "source configuration changed; reload before saving", CurrentRevision: s.ConfigRevision}
	}
	if in.Enabled == nil {
		return nil, invalid("enabled is required")
	}
	in.Name = strings.TrimSpace(in.Name)
	if integrationSecretEmpty(in.Secret) {
		in.Secret = nil
	}
	if err := validateIntegrationConfiguration(in.Name, s.Kind, s.SchemaID, s.SchemaVersion, in.Connection, &in.Sync, in.Secret); err != nil {
		return nil, err
	}
	if s.Kind == "github-traffic" && s.Revision != "0" && (in.Connection["owner"] != s.Connection["owner"] || in.Connection["repo"] != s.Connection["repo"]) {
		return nil, conflict("create a new source to change a repository after its first snapshot")
	}
	encrypted := s.credentialCipher
	if in.Secret != nil {
		var plain string
		secretSource := s
		secretSource.Connection = in.Connection
		plain, err = a.mergeIntegrationSecret(secretSource, in.Secret)
		if err != nil {
			return nil, err
		}
		encrypted, err = a.encryptIntegrationSecret(s.ID, plain)
		if err != nil {
			return nil, err
		}
	}
	if integrationSecretRequired(s.Kind, in.Connection) && *in.Enabled && encrypted == "" {
		return nil, invalid("an enabled source requires its subscription URL or credential")
	}
	if s.Kind != "github-traffic" && encrypted != "" {
		raw, e := a.decryptIntegrationSecret(s.ID, encrypted)
		var effective integrationSecretInput
		if e != nil || json.Unmarshal([]byte(raw), &effective) != nil {
			return nil, invalid("source credential is unavailable")
		}
		if *in.Enabled && !integrationHasRequiredSecret(s.Kind, in.Connection, &effective) {
			return nil, invalid("source credential is incomplete")
		}
		if effective.URL != "" {
			if _, e = integrationRemoteURL(effective.URL, in.Connection["allowPrivateNetwork"] == "true"); e != nil {
				return nil, e
			}
		}
	}
	conn, _ := json.Marshal(in.Connection)
	syncJSON, _ := json.Marshal(in.Sync)
	now := time.Now().UTC()
	var next, credential any
	if integrationPollingKind(s.Kind) && *in.Enabled {
		next = integrationStamp(now)
	}
	if encrypted != "" {
		credential = encrypted
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query(`UPDATE integration_sources SET name=?,connection_json=?,sync_json=?,enabled=?,credential_cipher=?,config_revision=config_revision+1,updated_at=?,next_sync_at=? WHERE id=?`), in.Name, string(conn), string(syncJSON), *in.Enabled, credential, integrationStamp(now), next, s.ID)
	if err != nil {
		return nil, err
	}
	s, err = a.loadIntegrationSource(r.HTTP.Context(), r.Q, s.ID)
	if err != nil {
		return nil, err
	}
	r.WakeIntegrations = true
	return ok(r.sourceWriteResult(s)), nil
}
func (a *App) queueIntegrationSync(r *Request) (*Response, error) {
	if r.User == nil {
		return nil, unauthorized()
	}
	s, err := a.requireIntegrationSource(r, r.param("id"), "sources:write", true)
	if err != nil {
		return nil, err
	}
	var in struct{}
	if err := r.decode(&in); err != nil {
		return nil, err
	}
	if !integrationPollingKind(s.Kind) {
		return nil, invalid("manual sync is only available for polling sources")
	}
	if !s.Enabled {
		return nil, conflict("source is disabled")
	}
	now := time.Now().UTC()
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE integration_sources SET next_sync_at=? WHERE id=?"), integrationStamp(now), s.ID)
	if err != nil {
		return nil, err
	}
	s.NextSyncAt = &now
	r.WakeIntegrations = true
	return &Response{Status: 202, Data: map[string]any{"queued": true, "source": r.sourceWriteResult(s)}}, nil
}

func (a *App) integrationTransaction(ctx context.Context, fn func(Queryer) error) error {
	select {
	case a.writeGate <- struct{}{}:
		defer func() { <-a.writeGate }()
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := a.store.CheckLease(ctx); err != nil {
		return err
	}
	tx, err := a.store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}
