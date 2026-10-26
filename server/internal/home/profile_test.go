package home

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sort"
	"strings"
	"testing"
	"time"
)

type accountProfileReply struct {
	status  int
	body    map[string]any
	headers http.Header
	raw     []byte
}
type accountProfileState struct {
	displayName, passwordHash string
	version                   int64
	sessions                  [32]byte
	sessionCount              int
}

func newAccountProfileHTTPFixture(t *testing.T, provider string) (*App, *httptest.Server) {
	t.Helper()
	c := coreConfig(t, false)
	if provider == "postgres" {
		dsn := os.Getenv("LINGSHU_TEST_STORAGE_POSTGRES_URL")
		if dsn == "" {
			t.Skip("set LINGSHU_TEST_STORAGE_POSTGRES_URL for PostgreSQL profile coverage")
		}
		parsed, err := url.Parse(dsn)
		if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") {
			t.Fatal("profile fixture requires a PostgreSQL URL")
		}
		admin, err := sql.Open("pgx", dsn)
		if err != nil {
			t.Fatal("cannot open profile PostgreSQL fixture")
		}
		schema := "profile_http_" + strings.ReplaceAll(newID(), "-", "")
		quoted := fmt.Sprintf("%q", schema)
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		_, err = admin.ExecContext(ctx, "CREATE SCHEMA "+quoted)
		cancel()
		if err != nil {
			admin.Close()
			t.Fatal(err)
		}
		t.Cleanup(func() {
			cleanup, done := context.WithTimeout(context.Background(), 15*time.Second)
			defer done()
			if _, err := admin.ExecContext(cleanup, "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
				t.Errorf("cannot remove profile fixture schema: %v", err)
			}
			if err := admin.Close(); err != nil {
				t.Error(err)
			}
		})
		query := parsed.Query()
		query.Set("search_path", schema)
		parsed.RawQuery = query.Encode()
		c.StorageProvider = "postgres"
		c.DatabaseURL = parsed.String()
	}
	app, err := Open(c)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app)
	t.Cleanup(func() {
		server.Close()
		if err := app.Close(); err != nil {
			t.Error(err)
		}
	})
	return app, server
}
func accountProfileRawCall(t *testing.T, client *http.Client, base, method, path string, body any, csrf, bearer string) accountProfileReply {
	t.Helper()
	var encoded []byte
	var err error
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, base+"/api/v1"+path, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if method != "GET" {
		req.Header.Set("Origin", base)
	}
	if csrf != "" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatalf("invalid JSON, status %d", response.StatusCode)
	}
	return accountProfileReply{response.StatusCode, result, response.Header.Clone(), raw}
}
func accountProfileErrorCode(body map[string]any) string {
	value, _ := body["code"].(string)
	return value
}
func accountProfileUserID(body map[string]any) string {
	user, ok := body["user"].(map[string]any)
	if !ok {
		return ""
	}
	id, _ := user["id"].(string)
	return id
}
func requireAccountProfileUser(t *testing.T, body map[string]any, expected string) {
	t.Helper()
	if accountProfileUserID(body) != expected {
		t.Fatal("unexpected authenticated user")
	}
}
func readAccountProfileState(t *testing.T, app *App, userID string) accountProfileState {
	t.Helper()
	var result accountProfileState
	if err := app.store.DB.QueryRow(app.store.Query("SELECT display_name,password_hash,version FROM users WHERE id=?"), userID).Scan(&result.displayName, &result.passwordHash, &result.version); err != nil {
		t.Fatal(err)
	}
	rows, err := app.store.DB.Query(app.store.Query("SELECT * FROM sessions WHERE user_id=?"), userID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	columnBytes, _ := json.Marshal(columns)
	var records []string
	for rows.Next() {
		values := make([]any, len(columns))
		targets := make([]any, len(columns))
		for i := range values {
			targets[i] = &values[i]
		}
		if err := rows.Scan(targets...); err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(values)
		if err != nil {
			t.Fatal(err)
		}
		records = append(records, string(encoded))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	sort.Strings(records)
	result.sessionCount = len(records)
	result.sessions = sha256.Sum256([]byte(string(columnBytes) + "\n" + strings.Join(records, "\n")))
	return result
}
func requireAccountProfileUnchanged(t *testing.T, before, after accountProfileState) {
	t.Helper()
	if before.displayName != after.displayName {
		t.Fatal("display name changed after rejected request")
	}
	if before.passwordHash != after.passwordHash {
		t.Fatal("password hash changed after rejected request")
	}
	if before.version != after.version {
		t.Fatal("security version changed after rejected request")
	}
	if before.sessionCount != after.sessionCount || before.sessions != after.sessions {
		t.Fatal("session rows changed after rejected request")
	}
}
func accountProfileCookieFingerprint(t *testing.T, client *http.Client, base string) [32]byte {
	t.Helper()
	target, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	if client.Jar == nil {
		t.Fatal("fixture has no cookie jar")
	}
	var values []string
	for _, cookie := range client.Jar.Cookies(target) {
		values = append(values, cookie.Name+"="+cookie.Value)
	}
	sort.Strings(values)
	return sha256.Sum256([]byte(strings.Join(values, "\n")))
}
func requireAccountProfileNoPrivateFields(t *testing.T, body map[string]any) {
	t.Helper()
	for _, name := range []string{"version", "Version", "passwordHash", "PasswordHash", "password_hash"} {
		if _, ok := body[name]; ok {
			t.Fatalf("private response field %s", name)
		}
	}
}
func installAccountProfileCommitFailure(t *testing.T, app *App, provider string) func() {
	t.Helper()
	statements := []string{"CREATE TABLE profile_failure_target (id INTEGER PRIMARY KEY)", "CREATE TABLE profile_failure_probe (target_id INTEGER REFERENCES profile_failure_target(id) DEFERRABLE INITIALLY DEFERRED)"}
	var cleanup []string
	if provider == "postgres" {
		statements = append(statements, "CREATE FUNCTION profile_fail_session_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO profile_failure_probe(target_id) VALUES (1); RETURN NEW; END $$", "CREATE TRIGGER profile_force_session_commit_failure AFTER INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION profile_fail_session_insert()")
		cleanup = []string{"DROP TRIGGER IF EXISTS profile_force_session_commit_failure ON sessions", "DROP FUNCTION IF EXISTS profile_fail_session_insert()", "DROP TABLE IF EXISTS profile_failure_probe", "DROP TABLE IF EXISTS profile_failure_target"}
	} else {
		statements = append(statements, "CREATE TRIGGER profile_force_session_commit_failure AFTER INSERT ON sessions BEGIN INSERT INTO profile_failure_probe(target_id) VALUES (1); END")
		cleanup = []string{"DROP TRIGGER IF EXISTS profile_force_session_commit_failure", "DROP TABLE IF EXISTS profile_failure_probe", "DROP TABLE IF EXISTS profile_failure_target"}
	}
	for _, statement := range statements {
		if _, err := app.store.DB.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	remove := func() {
		for _, statement := range cleanup {
			if _, err := app.store.DB.Exec(statement); err != nil {
				t.Errorf("cannot clean fixture: %v", err)
			}
		}
	}
	t.Cleanup(remove)
	return remove
}

func TestAccountProfileAndPasswordHTTP(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			oldPassword := "a valid test password"
			newPassword := "  updated password with spaces  "
			owner.ok("POST", "/setup", map[string]any{"siteName": "profile fixture", "mode": ModePublicRead, "username": "owner", "displayName": "Owner", "password": oldPassword, "seedDemo": false})
			initial := owner.bootstrap()
			userID := accountProfileUserID(initial)
			if userID == "" {
				t.Fatal("setup did not authenticate the owner")
			}
			shared := coreSpace(initial, "shared")
			tokenResult := owner.ok("POST", "/integrations/tokens", map[string]any{"name": "profile fixture", "spaceId": shared, "actions": []string{"navigation:read", "navigation:write"}, "expiresAt": time.Now().UTC().Add(time.Hour)})
			token, ok := tokenResult["token"].(string)
			if !ok || token == "" {
				t.Fatal("token fixture was not issued")
			}
			bearerClient := &http.Client{Timeout: 15 * time.Second}
			navigationPath := "/spaces/" + url.PathEscape(shared) + "/navigation"
			if got := accountProfileRawCall(t, bearerClient, server.URL, "GET", navigationPath, nil, "", token); got.status != 200 {
				t.Fatalf("fresh PAT failed: %d", got.status)
			}
			peer := newCoreBrowser(t, server.URL)
			peer.bootstrap()
			peer.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": oldPassword})
			requireAccountProfileUser(t, peer.bootstrap(), userID)
			before := readAccountProfileState(t, app, userID)
			if before.sessionCount != 2 {
				t.Fatalf("fixture needs two sessions, got %d", before.sessionCount)
			}
			anonymous := newCoreBrowser(t, server.URL)
			anonymous.bootstrap()
			profileBody := map[string]any{"displayName": "Not saved", "expectedDisplayName": "Owner"}
			passwordBody := map[string]any{"currentPassword": oldPassword, "newPassword": newPassword}
			for path, body := range map[string]any{"/account/profile": profileBody, "/account/password": passwordBody} {
				status, _ := anonymous.call("PUT", path, body)
				if status != 401 && status != 403 {
					t.Fatalf("anonymous %s was not denied: %d", path, status)
				}
				noCSRF := accountProfileRawCall(t, owner.client, server.URL, "PUT", path, body, "", "")
				if noCSRF.status != 403 {
					t.Fatalf("missing CSRF %s was not denied: %d", path, noCSRF.status)
				}
				bearer := accountProfileRawCall(t, bearerClient, server.URL, "PUT", path, body, "", token)
				if bearer.status != 403 {
					t.Fatalf("Bearer %s was not denied: %d", path, bearer.status)
				}
			}
			status, _ := owner.call("PUT", "/account/profile", map[string]any{"displayName": "Not saved", "expectedDisplayName": "Owner", "role": "Member"})
			if status != 400 {
				t.Fatalf("unknown profile field accepted: %d", status)
			}
			status, _ = owner.call("PUT", "/account/password", map[string]any{"currentPassword": oldPassword, "newPassword": newPassword, "userId": "another-user"})
			if status != 400 {
				t.Fatalf("unknown password field accepted: %d", status)
			}
			requireAccountProfileUnchanged(t, before, readAccountProfileState(t, app, userID))
			changed := owner.ok("PUT", "/account/profile", map[string]any{"displayName": "Updated Owner", "expectedDisplayName": "Owner"})
			if changed["displayName"] != "Updated Owner" {
				t.Fatal("profile did not return the new display name")
			}
			requireAccountProfileNoPrivateFields(t, changed)
			afterName := readAccountProfileState(t, app, userID)
			if afterName.displayName != "Updated Owner" {
				t.Fatal("display name was not persisted")
			}
			if afterName.version != before.version || afterName.passwordHash != before.passwordHash || afterName.sessions != before.sessions {
				t.Fatal("display name edit changed authentication state")
			}
			requireAccountProfileUser(t, owner.bootstrap(), userID)
			requireAccountProfileUser(t, peer.bootstrap(), userID)
			if got := accountProfileRawCall(t, bearerClient, server.URL, "GET", navigationPath, nil, "", token); got.status != 200 {
				t.Fatalf("display name edit revoked PAT: %d", got.status)
			}
			status, _ = owner.call("PUT", "/account/profile", map[string]any{"displayName": "Stale name", "expectedDisplayName": "Owner"})
			if status != 409 {
				t.Fatalf("stale display name update did not conflict: %d", status)
			}
			requireAccountProfileUnchanged(t, afterName, readAccountProfileState(t, app, userID))
			status, body := owner.call("PUT", "/account/password", map[string]any{"currentPassword": "definitely wrong", "newPassword": newPassword})
			if status != 400 || accountProfileErrorCode(body) != "current_password_incorrect" {
				t.Fatalf("wrong current password returned status=%d code=%s", status, accountProfileErrorCode(body))
			}
			for _, invalid := range []string{oldPassword, "short", strings.Repeat("x", 129), strings.Repeat(" ", 12)} {
				status, _ = owner.call("PUT", "/account/password", map[string]any{"currentPassword": oldPassword, "newPassword": invalid})
				if status != 400 {
					t.Fatalf("invalid/unchanged new password accepted: %d", status)
				}
			}
			requireAccountProfileUnchanged(t, afterName, readAccountProfileState(t, app, userID))
			oldIssuer := newCoreBrowser(t, server.URL)
			cookieURL, err := url.Parse(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			oldIssuer.client.Jar.SetCookies(cookieURL, owner.client.Jar.Cookies(cookieURL))
			requireAccountProfileUser(t, oldIssuer.bootstrap(), userID)
			cookiesBefore := accountProfileCookieFingerprint(t, owner.client, server.URL)
			reply := accountProfileRawCall(t, owner.client, server.URL, "PUT", "/account/password", passwordBody, owner.csrf, "")
			if reply.status < 200 || reply.status >= 300 {
				t.Fatalf("password change failed: status=%d code=%s", reply.status, accountProfileErrorCode(reply.body))
			}
			requireAccountProfileNoPrivateFields(t, reply.body)
			if len(reply.headers.Values("Set-Cookie")) == 0 || accountProfileCookieFingerprint(t, owner.client, server.URL) == cookiesBefore {
				t.Fatal("password change did not rotate the issuer cookie")
			}
			afterPassword := readAccountProfileState(t, app, userID)
			if afterPassword.version != afterName.version+1 || afterPassword.passwordHash == afterName.passwordHash || afterPassword.sessionCount != 1 {
				t.Fatalf("password rotation state is wrong: version=%d sessions=%d", afterPassword.version, afterPassword.sessionCount)
			}
			requireAccountProfileUser(t, owner.bootstrap(), userID)
			requireAccountProfileUser(t, oldIssuer.bootstrap(), "")
			requireAccountProfileUser(t, peer.bootstrap(), "")
			if got := accountProfileRawCall(t, bearerClient, server.URL, "GET", navigationPath, nil, "", token); got.status != 401 {
				t.Fatalf("password change did not revoke old PAT: %d", got.status)
			}
			fresh := newCoreBrowser(t, server.URL)
			fresh.bootstrap()
			for _, wrong := range []string{oldPassword, strings.TrimSpace(newPassword)} {
				status, _ = fresh.call("POST", "/auth/login", map[string]any{"username": "owner", "password": wrong})
				if status != 401 {
					t.Fatalf("old or trimmed password authenticated: %d", status)
				}
			}
			fresh.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": newPassword})
			requireAccountProfileUser(t, fresh.bootstrap(), userID)
		})
	}
}
func TestAccountPasswordDeferredCommitFailureHTTP(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			oldPassword := "a valid test password"
			newPassword := "  password after rollback  "
			owner.ok("POST", "/setup", map[string]any{"siteName": "profile rollback fixture", "mode": ModePublicRead, "username": "owner", "displayName": "Owner", "password": oldPassword, "seedDemo": false})
			state := owner.bootstrap()
			userID := accountProfileUserID(state)
			if userID == "" {
				t.Fatal("setup did not authenticate owner")
			}
			shared := coreSpace(state, "shared")
			tokenResult := owner.ok("POST", "/integrations/tokens", map[string]any{"name": "profile rollback fixture", "spaceId": shared, "actions": []string{"navigation:read", "navigation:write"}, "expiresAt": time.Now().UTC().Add(time.Hour)})
			token, ok := tokenResult["token"].(string)
			if !ok || token == "" {
				t.Fatal("rollback PAT fixture was not issued")
			}
			bearerClient := &http.Client{Timeout: 15 * time.Second}
			navigationPath := "/spaces/" + url.PathEscape(shared) + "/navigation"
			peer := newCoreBrowser(t, server.URL)
			peer.bootstrap()
			peer.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": oldPassword})
			requireAccountProfileUser(t, peer.bootstrap(), userID)
			owner.bootstrap()
			before := readAccountProfileState(t, app, userID)
			if before.sessionCount != 2 {
				t.Fatalf("rollback fixture needs two sessions, got %d", before.sessionCount)
			}
			cookiesBefore := accountProfileCookieFingerprint(t, owner.client, server.URL)
			removeFailure := installAccountProfileCommitFailure(t, app, provider)
			reply := accountProfileRawCall(t, owner.client, server.URL, "PUT", "/account/password", map[string]any{"currentPassword": oldPassword, "newPassword": newPassword}, owner.csrf, "")
			if reply.status != 500 {
				t.Fatalf("deferred commit failure returned status=%d code=%s", reply.status, accountProfileErrorCode(reply.body))
			}
			if len(reply.headers.Values("Set-Cookie")) != 0 {
				t.Fatal("failed transaction sent a replacement or deletion cookie")
			}
			if accountProfileCookieFingerprint(t, owner.client, server.URL) != cookiesBefore {
				t.Fatal("failed transaction changed browser cookies")
			}
			for _, secret := range []string{oldPassword, newPassword, token} {
				if strings.Contains(string(reply.raw), secret) {
					t.Fatal("failed password response exposed a secret")
				}
			}
			requireAccountProfileUnchanged(t, before, readAccountProfileState(t, app, userID))
			var probeRows int
			if err := app.store.DB.QueryRow("SELECT count(*) FROM profile_failure_probe").Scan(&probeRows); err != nil {
				t.Fatal(err)
			}
			if probeRows != 0 {
				t.Fatal("deferred constraint fixture row was not rolled back")
			}
			requireAccountProfileUser(t, owner.bootstrap(), userID)
			requireAccountProfileUser(t, peer.bootstrap(), userID)
			if got := accountProfileRawCall(t, bearerClient, server.URL, "GET", navigationPath, nil, "", token); got.status != 200 {
				t.Fatalf("failed password transaction revoked PAT: %d", got.status)
			}
			removeFailure()
			reply = accountProfileRawCall(t, owner.client, server.URL, "PUT", "/account/password", map[string]any{"currentPassword": oldPassword, "newPassword": newPassword}, owner.csrf, "")
			if reply.status < 200 || reply.status >= 300 {
				t.Fatalf("password change could not recover after rollback: %d", reply.status)
			}
			after := readAccountProfileState(t, app, userID)
			if after.version != before.version+1 || after.passwordHash == before.passwordHash || after.sessionCount != 1 {
				t.Fatal("successful retry did not rotate exactly one durable session")
			}
			requireAccountProfileUser(t, owner.bootstrap(), userID)
			requireAccountProfileUser(t, peer.bootstrap(), "")
			if got := accountProfileRawCall(t, bearerClient, server.URL, "GET", navigationPath, nil, "", token); got.status != 401 {
				t.Fatalf("successful retry did not revoke old PAT: %d", got.status)
			}
		})
	}
}
