package home

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type integrationTestBrowser struct {
	t          *testing.T
	client     *http.Client
	base, csrf string
}

func integrationBrowser(t *testing.T, base string) *integrationTestBrowser {
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &integrationTestBrowser{t: t, base: base, client: &http.Client{Jar: jar, Timeout: 15 * time.Second}}
}
func (b *integrationTestBrowser) raw(method, path string, input any, token string, headers http.Header) (int, any, http.Header) {
	b.t.Helper()
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			b.t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, b.base+path, body)
	if err != nil {
		b.t.Fatal(err)
	}
	request.Header.Set("Accept", "application/json")
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	} else if method != "GET" && b.csrf != "" {
		request.Header.Set("X-CSRF-TOKEN", b.csrf)
	}
	for name, values := range headers {
		request.Header[name] = values
	}
	response, err := b.client.Do(request)
	if err != nil {
		b.t.Fatalf("HTTP %s %s failed: %v", method, path, err)
	}
	defer response.Body.Close()
	var value any
	raw, err := io.ReadAll(io.LimitReader(response.Body, 16<<20))
	if err != nil {
		b.t.Fatal(err)
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &value); err != nil {
			b.t.Fatalf("HTTP %s %s returned non-JSON (status %d)", method, path, response.StatusCode)
		}
	}
	return response.StatusCode, value, response.Header
}
func (b *integrationTestBrowser) call(method, path string, input any, status int, token string) any {
	b.t.Helper()
	got, value, _ := b.raw(method, path, input, token, nil)
	if got != status {
		code := ""
		if v, ok := value.(map[string]any); ok {
			code, _ = v["code"].(string)
		}
		b.t.Fatalf("HTTP %s %s: got %d (%s), want %d", method, path, got, code, status)
	}
	return value
}
func integrationObject(t *testing.T, v any) map[string]any {
	t.Helper()
	value, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("expected an object, got %T", v)
	}
	return value
}
func (b *integrationTestBrowser) object(method, path string, input any, status int, token string) map[string]any {
	return integrationObject(b.t, b.call(method, path, input, status, token))
}
func (b *integrationTestBrowser) boot() map[string]any {
	boot := b.object("GET", "/api/v1/bootstrap", nil, 200, "")
	b.csrf, _ = boot["csrfToken"].(string)
	if b.csrf == "" {
		b.t.Fatal("bootstrap has no CSRF token")
	}
	return boot
}
func integrationSpace(t *testing.T, boot map[string]any, kind string) string {
	t.Helper()
	for _, raw := range boot["spaces"].([]any) {
		s := raw.(map[string]any)
		if s["kind"] == kind {
			return s["id"].(string)
		}
	}
	t.Fatalf("space %s was not returned", kind)
	return ""
}
func (b *integrationTestBrowser) token(space, source string, actions ...string) (string, string) {
	b.t.Helper()
	var sourceID any
	if source != "" {
		sourceID = source
	}
	expiry := time.Now().UTC().Truncate(time.Second).Add(time.Hour + 123456789*time.Nanosecond)
	result := b.object("POST", "/api/v1/integrations/tokens", map[string]any{"name": "Fixture automation", "spaceId": space, "sourceId": sourceID, "actions": actions, "expiresAt": expiry}, 201, "")
	credential := integrationObject(b.t, result["credential"])
	listed := b.call("GET", "/api/v1/integrations/tokens", nil, 200, "").([]any)
	for _, raw := range listed {
		stored := integrationObject(b.t, raw)
		if stored["id"] == credential["id"] {
			if !reflect.DeepEqual(stored, credential) {
				b.t.Fatal("PAT creation and stored credential differ, including timestamp precision")
			}
			return result["token"].(string), credential["id"].(string)
		}
	}
	b.t.Fatal("created PAT was not listed")
	return "", ""
}
func (b *integrationTestBrowser) source(space, name string) map[string]any {
	return b.object("POST", "/api/v1/spaces/"+space+"/sources", map[string]any{"name": name, "kind": "external-push", "schemaId": "navigation.collection", "schemaVersion": 1, "connection": map[string]string{}, "sync": map[string]any{"mode": "push", "staleAfterSeconds": 3600}, "enabled": true}, 201, "")
}
func integrationSnapshot(id, revision string, sequence any) map[string]any {
	result := map[string]any{"requestId": id, "expectedRevision": revision, "schemaId": "navigation.collection", "schemaVersion": 1, "sourceUpdatedAt": nil, "data": map[string]any{"categories": []any{map[string]any{"externalId": "ops", "name": "Operations", "icon": "lucide:folder", "parentExternalId": nil, "sortOrder": 0}}, "links": []any{map[string]any{"externalId": "project", "categoryExternalId": "ops", "title": "External example", "url": "https://example.org/project", "description": "Synthetic fixture", "icon": "lucide:link", "tags": []string{"external"}, "isFavorite": false, "sortOrder": 0, "endpoints": []any{}}}}}
	if sequence != nil {
		result["sourceSequence"] = sequence
	}
	return result
}
func integrationClone(value map[string]any) map[string]any {
	raw, _ := json.Marshal(value)
	var copy map[string]any
	_ = json.Unmarshal(raw, &copy)
	return copy
}
func (b *integrationTestBrowser) mcp(token, method string, params map[string]any, status int) (map[string]any, http.Header) {
	b.t.Helper()
	params = integrationClone(params)
	params["_meta"] = map[string]any{"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": map[string]any{}, "io.modelcontextprotocol/clientInfo": map[string]any{"name": "integration-fixture", "version": "1"}}
	headers := http.Header{"Accept": []string{"application/json, text/event-stream"}, "Mcp-Protocol-Version": []string{"2026-07-28"}, "Mcp-Method": []string{method}}
	if name, ok := params["name"].(string); ok {
		headers.Set("Mcp-Name", name)
	}
	got, raw, responseHeaders := b.raw("POST", "/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, token, headers)
	if got != status {
		b.t.Fatalf("MCP %s HTTP status %d, want %d", method, got, status)
	}
	if responseHeaders.Get("Cache-Control") != "no-store" {
		b.t.Fatalf("MCP %s did not set no-store", method)
	}
	return integrationObject(b.t, raw), responseHeaders
}
func (b *integrationTestBrowser) tool(token, name string, args map[string]any, wantError string) map[string]any {
	b.t.Helper()
	wire, _ := b.mcp(token, "tools/call", map[string]any{"name": name, "arguments": args}, 200)
	if _, exists := wire["error"]; exists {
		b.t.Fatalf("MCP %s returned a protocol error", name)
	}
	result := integrationObject(b.t, wire["result"])
	data := integrationObject(b.t, result["structuredContent"])
	if wantError != "" {
		if result["isError"] != true || data["code"] != wantError {
			b.t.Fatalf("MCP %s expected application error %s, got code %v", name, wantError, data["code"])
		}
	} else if result["isError"] == true {
		b.t.Fatalf("MCP %s failed: %v", name, data["code"])
	}
	return data
}

// These suites drive worker methods synchronously through injected upstream
// transports. Stop startup workers, then give the still-running HTTP fixture
// its own live operation lifecycle; do not treat an already shut-down App as
// a running server or weaken production shutdown/proxy-generation cancellation.
func stopIntegrationFixtureWorkers(t *testing.T, app *App) {
	t.Helper()
	app.cancel()
	app.workers.Wait()
	app.ctx, app.cancel = context.WithCancel(context.Background())
	if err := app.initializeNetworkProxy(); err != nil {
		_ = app.Close()
		t.Fatal(err)
	}
}

func TestIntegrationHTTPMCPAndTraffic(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			databaseURL := ""
			if provider == "postgres" {
				databaseURL = os.Getenv("LINGSHU_TEST_INTEGRATIONS_POSTGRES_URL")
				if databaseURL == "" {
					t.Skip("requires a dedicated fresh LINGSHU_TEST_INTEGRATIONS_POSTGRES_URL")
				}
			}
			version, err := filepath.Abs("../../../VERSION")
			if err != nil {
				t.Fatal(err)
			}
			config := Config{StorageProvider: provider, DatabaseURL: databaseURL, DataDir: t.TempDir(), WebDir: t.TempDir(), VersionFile: version, Language: "zh-CN"}
			app, err := Open(config)
			if err != nil {
				t.Fatal(err)
			}
			defer app.Close()
			// Deterministic tests call the actual worker path with a fixed upstream transport.
			// Disable its timer so no test credential is ever sent to the public network.
			stopIntegrationFixtureWorkers(t, app)
			server := httptest.NewServer(app)
			defer server.Close()
			owner := integrationBrowser(t, server.URL)
			anonymous := integrationBrowser(t, server.URL)
			if owner.boot()["initialized"] != false {
				t.Fatal("refusing an initialized integration test database")
			}
			owner.object("POST", "/api/v1/setup", map[string]any{"siteName": "Integration fixture", "mode": "private_multi", "username": "integration-owner", "displayName": "Fixture owner", "password": "owner-fixture-password-2026", "seedDemo": false}, 201, "")
			boot := owner.boot()
			shared := integrationSpace(t, boot, "shared")
			personal := integrationSpace(t, boot, "personal")
			allActions := []string{"navigation:read", "navigation:write", "sources:read", "sources:write", "datasets:write", "pages:read", "pages:write"}
			full, fullID := owner.token(shared, "", allActions...)
			var hash string
			if err := app.store.DB.QueryRowContext(context.Background(), app.store.Query("SELECT token_hash FROM integration_tokens WHERE id=?"), fullID).Scan(&hash); err != nil {
				t.Fatal(err)
			}
			if hash == full || len(hash) != 64 {
				t.Fatal("PAT was not stored as a SHA-256 digest")
			}
			listed := owner.call("GET", "/api/v1/integrations/tokens", nil, 200, "")
			encoded, _ := json.Marshal(listed)
			if bytes.Contains(encoded, []byte(full)) || bytes.Contains(encoded, []byte(hash)) {
				t.Fatal("token list leaked secret material")
			}
			owner.call("POST", "/api/v1/integrations/tokens", map[string]any{}, 403, full)
			owner.call("GET", "/api/v1/spaces/"+shared+"/navigation", nil, 401, "invalid")
			anonymous.mcp("", "server/discover", map[string]any{}, 401)
			discovery, _ := anonymous.mcp(full, "server/discover", map[string]any{}, 200)
			discovered := integrationObject(t, discovery["result"])
			versions, _ := discovered["supportedVersions"].([]any)
			if len(versions) != 2 || discovered["cacheScope"] != "private" || discovered["ttlMs"] != float64(0) {
				t.Fatal("MCP discovery protocol/cache contract differs")
			}
			tools, _ := anonymous.mcp(full, "tools/list", map[string]any{}, 200)
			if len(integrationObject(t, tools["result"])["tools"].([]any)) != 20 {
				t.Fatal("MCP tools were not registered")
			}
			legacyHeaders := http.Header{"Accept": []string{"application/json, text/event-stream"}, "Mcp-Protocol-Version": []string{"2025-11-25"}}
			status, legacyRaw, legacyResponse := anonymous.raw("POST", "/mcp", map[string]any{"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-11-25", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "legacy-fixture", "version": "1"}}}, full, legacyHeaders)
			if status != 200 || legacyResponse.Get("Mcp-Session-Id") != "" || integrationObject(t, integrationObject(t, legacyRaw)["result"])["protocolVersion"] != "2025-11-25" {
				t.Fatal("legacy MCP initialize failed")
			}
			status, legacyRaw, _ = anonymous.raw("POST", "/mcp", map[string]any{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": map[string]any{"name": "bookmarks_list", "arguments": map[string]any{"spaceId": shared}}}, full, legacyHeaders)
			if status != 200 {
				t.Fatal("legacy MCP call failed")
			}
			legacyData := integrationObject(t, integrationObject(t, integrationObject(t, legacyRaw)["result"])["structuredContent"])
			if _, ok := legacyData["items"].([]any); !ok {
				t.Fatal("legacy list structuredContent must be an object with items")
			}
			readOnly, _ := owner.token(shared, "", "navigation:read")
			category := anonymous.tool(full, "categories_create", map[string]any{"spaceId": shared, "input": map[string]any{"name": "Local fixture", "icon": "lucide:folder"}}, "")
			categoryID := category["id"].(string)
			linkInput := map[string]any{"categoryId": categoryID, "title": "Local fixture", "url": "https://example.com/local", "icon": "lucide:link", "tags": []string{}, "endpoints": []any{}}
			anonymous.tool(readOnly, "bookmarks_create", map[string]any{"spaceId": shared, "input": linkInput}, "forbidden")
			anonymous.tool(readOnly, "dashboard_get", map[string]any{"spaceId": shared}, "forbidden")
			link := anonymous.tool(full, "bookmarks_create", map[string]any{"spaceId": shared, "input": linkInput}, "")
			linkID := link["id"].(string)
			unsafe := integrationClone(linkInput)
			unsafe["url"] = "javascript:alert(1)"
			anonymous.tool(full, "bookmarks_update", map[string]any{"spaceId": shared, "id": linkID, "input": unsafe}, "validation_error")
			linkInput["title"] = "Updated local fixture"
			anonymous.tool(full, "bookmarks_update", map[string]any{"spaceId": shared, "id": linkID, "input": linkInput}, "")
			anonymous.tool(full, "bookmarks_get", map[string]any{"spaceId": personal, "id": linkID}, "not_found")
			source := owner.source(shared, "Push fixture")
			sourceID := source["id"].(string)
			second := owner.source(shared, "Second fixture")
			private := owner.source(personal, "Private fixture")
			scoped, scopedID := owner.token(shared, sourceID, "sources:read", "datasets:write")
			anonymous.call("GET", "/api/v1/sources/"+second["id"].(string), nil, 404, scoped)
			anonymous.call("GET", "/api/v1/sources/"+private["id"].(string), nil, 404, full)
			anonymous.call("GET", "/api/v1/sources/"+sourceID+"/snapshot", nil, 404, scoped)
			first := integrationSnapshot("first", "0", 10)
			receipt := anonymous.object("PUT", "/api/v1/sources/"+sourceID+"/snapshot", first, 200, scoped)
			firstSnapshot := anonymous.object("GET", "/api/v1/sources/"+sourceID+"/snapshot", nil, 200, scoped)
			if firstSnapshot["meta"].(map[string]any)["receivedAt"] != receipt["receivedAt"] {
				t.Fatal("push receipt and stored snapshot use different receivedAt instants")
			}
			secondPush := integrationSnapshot("second", "1", nil)
			anonymous.object("PUT", "/api/v1/sources/"+sourceID+"/snapshot", secondPush, 200, scoped)
			replay := anonymous.tool(scoped, "sources_snapshot_push", map[string]any{"id": sourceID, "input": first}, "")
			if !reflect.DeepEqual(replay, receipt) {
				t.Fatal("idempotent retry did not return its original receipt")
			}
			changed := integrationClone(first)
			changed["schemaVersion"] = 2
			anonymous.call("PUT", "/api/v1/sources/"+sourceID+"/snapshot", changed, 409, scoped)
			stale := integrationSnapshot("stale", "0", 11)
			anonymous.call("PUT", "/api/v1/sources/"+sourceID+"/snapshot", stale, 409, scoped)
			oldSequence := integrationSnapshot("sequence", "2", 9)
			anonymous.call("PUT", "/api/v1/sources/"+sourceID+"/snapshot", oldSequence, 409, scoped)
			noGuard := integrationSnapshot("unguarded", "2", nil)
			delete(noGuard, "expectedRevision")
			anonymous.call("PUT", "/api/v1/sources/"+sourceID+"/snapshot", noGuard, 400, scoped)
			bad := integrationSnapshot("unsafe", "2", nil)
			bad["data"].(map[string]any)["links"].([]any)[0].(map[string]any)["url"] = "file:///etc/passwd"
			anonymous.call("PUT", "/api/v1/sources/"+sourceID+"/snapshot", bad, 400, scoped)
			badCategory := integrationSnapshot("control-category", "2", nil)
			badCategory["data"].(map[string]any)["categories"].([]any)[0].(map[string]any)["name"] = "Ops\u0001control"
			anonymous.call("PUT", "/api/v1/sources/"+sourceID+"/snapshot", badCategory, 400, scoped)
			snapshot := anonymous.object("GET", "/api/v1/sources/"+sourceID+"/snapshot", nil, 200, scoped)
			if snapshot["revision"] != "2" || snapshot["meta"].(map[string]any)["sourceUpdatedAt"] != nil {
				t.Fatal("snapshot metadata was not preserved")
			}
			external := snapshot["data"].(map[string]any)["links"].([]any)[0].(map[string]any)
			if external["id"] != "source:"+sourceID+":project" {
				t.Fatal("external IDs are not namespaced")
			}
			local := owner.object("GET", "/api/v1/spaces/"+shared+"/navigation", nil, 200, "")
			if len(local["data"].(map[string]any)["links"].([]any)) != 1 {
				t.Fatal("external push changed local bookmark records")
			}
			// Independent HTTP contenders must not both accept the same expected revision.
			var wait sync.WaitGroup
			statuses := make(chan int, 2)
			for i := 0; i < 2; i++ {
				wait.Add(1)
				go func(i int) {
					defer wait.Done()
					status, _, _ := anonymous.raw("PUT", "/api/v1/sources/"+sourceID+"/snapshot", integrationSnapshot(fmt.Sprintf("race-%d", i), "2", 20+i), scoped, nil)
					statuses <- status
				}(i)
			}
			wait.Wait()
			close(statuses)
			success, conflicts := 0, 0
			for code := range statuses {
				if code == 200 {
					success++
				}
				if code == 409 {
					conflicts++
				}
			}
			if success != 1 || conflicts != 1 {
				t.Fatal("concurrent snapshot guards did not produce one winner and one conflict")
			}
			page := owner.object("GET", "/api/v1/spaces/"+shared+"/page", nil, 200, "")
			configJSON := integrationClone(page["config"].(map[string]any))
			configJSON["bindings"].(map[string]any)["external"] = map[string]any{"datasetId": "source:" + sourceID, "space": "current-page-space", "query": map[string]any{}}
			updated := owner.object("PUT", "/api/v1/spaces/"+shared+"/page", map[string]any{"name": page["name"], "expectedRevision": page["revision"], "config": configJSON}, 200, "")
			dashboard := anonymous.tool(full, "dashboard_get", map[string]any{"spaceId": shared}, "")
			if _, ok := dashboard["datasets"].(map[string]any)["external"]; !ok {
				t.Fatal("page-bound source dataset was not resolved")
			}
			configJSON["bindings"].(map[string]any)["external"].(map[string]any)["datasetId"] = "source:" + private["id"].(string)
			owner.call("PUT", "/api/v1/spaces/"+shared+"/page", map[string]any{"name": page["name"], "expectedRevision": updated["revision"], "config": configJSON}, 400, "")
			owner.call("DELETE", "/api/v1/integrations/tokens/"+scopedID, nil, 200, "")
			anonymous.mcp(scoped, "server/discover", map[string]any{}, 401)
			expiring, expiringID := owner.token(shared, "", "navigation:read")
			if _, err := app.store.DB.ExecContext(context.Background(), app.store.Query("UPDATE integration_tokens SET expires_at=? WHERE id=?"), integrationStamp(time.Now().Add(-time.Hour)), expiringID); err != nil {
				t.Fatal(err)
			}
			anonymous.mcp(expiring, "server/discover", map[string]any{}, 401)
			integrationTestTraffic(t, app, owner, shared)
			member := owner.object("POST", "/api/v1/admin/users", map[string]any{"username": "integration-member", "displayName": "Fixture member", "password": "member-fixture-password-2026"}, 201, "")
			memberBrowser := integrationBrowser(t, server.URL)
			memberBrowser.boot()
			memberBrowser.call("POST", "/api/v1/auth/login", map[string]any{"username": "integration-member", "password": "member-fixture-password-2026"}, 200, "")
			memberBoot := memberBrowser.boot()
			memberSpace := integrationSpace(t, memberBoot, "personal")
			memberToken, _ := memberBrowser.token(memberSpace, "", "navigation:read")
			anonymous.tool(memberToken, "bookmarks_list", map[string]any{"spaceId": personal}, "not_found")
			owner.call("PUT", "/api/v1/admin/users/"+member["id"].(string), map[string]any{"displayName": "Fixture member", "isEnabled": true, "password": "reset-member-password-2026"}, 200, "")
			anonymous.mcp(memberToken, "server/discover", map[string]any{}, 401)
			memberBrowser.boot()
			memberBrowser.call("POST", "/api/v1/auth/login", map[string]any{"username": "integration-member", "password": "reset-member-password-2026"}, 200, "")
			memberBrowser.boot()
			memberToken, _ = memberBrowser.token(memberSpace, "", "navigation:read")
			owner.call("PUT", "/api/v1/admin/users/"+member["id"].(string), map[string]any{"displayName": "Fixture member", "isEnabled": false}, 200, "")
			anonymous.mcp(memberToken, "server/discover", map[string]any{}, 401)
			anonymous.tool(full, "bookmarks_delete", map[string]any{"spaceId": shared, "id": linkID}, "")
			anonymous.tool(full, "categories_delete", map[string]any{"spaceId": shared, "id": categoryID}, "")
			owner.call("PUT", "/api/v1/settings", map[string]any{"siteName": "Integration fixture", "mode": "open_edit", "registrationEnabled": false}, 200, "")
			anonymous.mcp(full, "server/discover", map[string]any{}, 401)
			anonymous.mcp("", "server/discover", map[string]any{}, 401)
			anonymous.call("GET", "/api/v1/sources/"+private["id"].(string)+"/snapshot", nil, 404, "")
		})
	}
}

type integrationRoundTrip func(*http.Request) (*http.Response, error)

func (f integrationRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func integrationFixtureResponse(request *http.Request, status int, value any) *http.Response {
	raw, _ := json.Marshal(value)
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(bytes.NewReader(raw)), Request: request}
}
func integrationTestTraffic(t *testing.T, app *App, owner *integrationTestBrowser, space string) {
	t.Helper()
	const dummy = "fixture-github-token-never-sent-to-network"
	create := map[string]any{"name": "Traffic fixture", "kind": "github-traffic", "schemaId": "github.traffic", "schemaVersion": 1, "connection": map[string]string{"owner": "octocat", "repo": "Hello-World"}, "sync": map[string]any{"mode": "poll", "intervalSeconds": 21600, "staleAfterSeconds": 43200}, "enabled": true, "secret": map[string]any{"token": dummy}}
	created := owner.object("POST", "/api/v1/spaces/"+space+"/sources", create, 201, "")
	id := created["id"].(string)
	encoded, _ := json.Marshal(created)
	if created["credentialConfigured"] != true || bytes.Contains(encoded, []byte(dummy)) {
		t.Fatal("source credential projection is unsafe")
	}
	source, err := app.loadIntegrationSource(context.Background(), app.store.DB, id)
	if err != nil {
		t.Fatal(err)
	}
	if source.credentialCipher == dummy || source.credentialCipher == "" {
		t.Fatal("source credential was not encrypted")
	}
	if _, err := app.decryptIntegrationSecret("another-source", source.credentialCipher); err == nil {
		t.Fatal("credential encryption did not bind its source identity")
	}
	keyPath := filepath.Join(app.config.DataDir, "integrations.key")
	info, err := os.Stat(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatal("credential key permissions are not 0600")
	}
	if err := os.Rename(keyPath, keyPath+".fixture-backup"); err != nil {
		t.Fatal(err)
	}
	_, keyErr := app.integrationAEAD()
	_, statErr := os.Stat(keyPath)
	restoreErr := os.Rename(keyPath+".fixture-backup", keyPath)
	if restoreErr != nil {
		t.Fatal(restoreErr)
	}
	if keyErr == nil || !os.IsNotExist(statErr) {
		t.Fatal("runtime silently regenerated a lost credential key")
	}
	now := time.Now().UTC()
	today := now.Format("2006-01-02")
	earlier := now.AddDate(0, 0, -2).Format("2006-01-02")
	point := func(day string, count, unique int) map[string]any {
		return map[string]any{"timestamp": day + "T00:00:00Z", "count": count, "uniques": unique}
	}
	client := &http.Client{Transport: integrationRoundTrip(func(request *http.Request) (*http.Response, error) {
		if request.URL.Host != "api.github.com" || request.URL.Scheme != "https" || request.Header.Get("Authorization") != "Bearer "+dummy || request.Header.Get("X-GitHub-Api-Version") != "2026-03-10" {
			t.Error("traffic request did not preserve fixed origin and credential contract")
		}
		switch request.URL.Path {
		case "/repos/octocat/Hello-World/traffic/views":
			return integrationFixtureResponse(request, 200, map[string]any{"count": 25, "uniques": 5, "views": []any{point(earlier, 10, 4), point(today, 15, 4)}}), nil
		case "/repos/octocat/Hello-World/traffic/clones":
			return integrationFixtureResponse(request, 200, map[string]any{"count": 3, "uniques": 2, "clones": []any{point(earlier, 3, 2)}}), nil
		case "/repos/octocat/Hello-World/traffic/popular/paths":
			return integrationFixtureResponse(request, 200, []any{map[string]any{"path": "/octocat/Hello-World", "title": "Fixture repository", "count": 5, "uniques": 3}}), nil
		case "/repos/octocat/Hello-World/traffic/popular/referrers":
			return integrationFixtureResponse(request, 200, []any{map[string]any{"referrer": "example.com", "count": 3, "uniques": 2}}), nil
		}
		t.Errorf("unexpected GitHub endpoint %s", request.URL.Path)
		return integrationFixtureResponse(request, 404, map[string]any{}), nil
	})}
	fetched, failure := fetchGitHubTraffic(context.Background(), client, source, dummy)
	if failure != nil {
		t.Fatalf("fixture fetch failed: %s", failure.Code)
	}
	if fetched.window.Views.Uniques != 5 || fetched.window.WindowStart != nil || fetched.window.WindowEnd != nil {
		t.Fatal("rolling unique count/window bounds were invented")
	}
	if err := app.integrationTransaction(context.Background(), func(q Queryer) error { return app.persistGitHubTraffic(context.Background(), q, source, fetched) }); err != nil {
		t.Fatal(err)
	}
	snapshot := owner.object("GET", "/api/v1/sources/"+id+"/snapshot", nil, 200, "")
	data := snapshot["data"].(map[string]any)
	daily := data["daily"].([]any)
	if len(daily) != 3 || daily[1].(map[string]any)["views"] != nil || daily[1].(map[string]any)["observedAt"] != nil || daily[2].(map[string]any)["clones"] != nil || daily[2].(map[string]any)["isPartial"] != true {
		t.Fatal("missing days or partial observations were misrepresented")
	}
	baseline := integrationClone(data["baseline"].(map[string]any))
	fetched.window.CapturedAt = fetched.window.CapturedAt.AddDate(0, 0, 20)
	fetched.window.Views = TrafficMetrics{Count: 30, Uniques: 6}
	futureDay := fetched.window.CapturedAt.Format("2006-01-02")
	fetched.views = map[string]TrafficMetrics{futureDay: {Count: 30, Uniques: 6}}
	fetched.clones = map[string]TrafficMetrics{futureDay: {Count: 3, Uniques: 2}}
	fetched.paths = nil
	fetched.pathsError = integrationTrafficFailure("github_http_403")
	if err := app.integrationTransaction(context.Background(), func(q Queryer) error { return app.persistGitHubTraffic(context.Background(), q, source, fetched) }); err != nil {
		t.Fatal(err)
	}
	snapshot = owner.object("GET", "/api/v1/sources/"+id+"/snapshot", nil, 200, "")
	data = snapshot["data"].(map[string]any)
	if !reflect.DeepEqual(baseline, data["baseline"]) || len(data["daily"].([]any)) <= 20 || len(data["popularPaths"].([]any)) != 1 || data["auxiliaryStatus"].(map[string]any)["paths"].(map[string]any)["state"] != "stale" {
		t.Fatal("baseline/history/auxiliary failure retention failed")
	}
	before := integrationClone(snapshot)
	if _, err := app.store.DB.ExecContext(context.Background(), app.store.Query("UPDATE integration_sources SET next_sync_at=? WHERE id=?"), integrationStamp(time.Now().Add(-time.Minute)), id); err != nil {
		t.Fatal(err)
	}
	job, err := app.claimIntegrationTraffic(context.Background(), id)
	if err != nil || job == nil {
		t.Fatal("manual due source was not claimed")
	}
	denied := &http.Client{Transport: integrationRoundTrip(func(request *http.Request) (*http.Response, error) {
		return integrationFixtureResponse(request, 403, map[string]any{"message": "upstream body must not leak " + dummy}), nil
	})}
	app.runIntegrationTraffic(context.Background(), denied, *job)
	after := owner.object("GET", "/api/v1/sources/"+id+"/snapshot", nil, 200, "")
	if after["revision"] != before["revision"] || !reflect.DeepEqual(after["data"], before["data"]) {
		t.Fatal("required GitHub failure replaced successful traffic data")
	}
	current := owner.object("GET", "/api/v1/sources/"+id, nil, 200, "")
	raw, _ := json.Marshal(current)
	if current["lastError"].(map[string]any)["code"] != "github_http_403" || bytes.Contains(raw, []byte(dummy)) {
		t.Fatal("worker error projection failed")
	}
	update := map[string]any{"expectedConfigRevision": current["configRevision"], "name": "Traffic fixture", "enabled": false, "connection": create["connection"], "sync": create["sync"], "secret": map[string]any{"token": "rotated-fixture-credential-never-used"}}
	owner.call("PUT", "/api/v1/sources/"+id, update, 200, "")
	owner.call("PUT", "/api/v1/sources/"+id, update, 409, "")
	owner.call("POST", "/api/v1/sources/"+id+"/sync", map[string]any{}, 409, "")
}

func TestIntegrationTrafficRejectsMissingMetrics(t *testing.T) {
	date := time.Now().UTC().Format("2006-01-02") + "T00:00:00Z"
	for _, fields := range []string{`"uniques":0`, `"count":0`, `"count":null,"uniques":0`} {
		var totals integrationTrafficTotals
		if err := json.Unmarshal([]byte(`{"count":0,"uniques":0,"views":[{"timestamp":"`+date+`",`+fields+`}]}`), &totals); err != nil {
			t.Fatal(err)
		}
		if _, _, err := validateTrafficTotals(totals, "views", time.Now()); err == nil {
			t.Fatal("missing/null upstream metric was silently converted to zero")
		}
	}
}

func TestIntegrationTrafficRejectsMissingOptionalMetrics(t *testing.T) {
	for _, fields := range []string{`"uniques":0`, `"count":0`, `"count":null,"uniques":0`} {
		if _, err := decodeTrafficPaths([]byte(`[{"path":"/fixture",` + fields + `}]`)); err == nil {
			t.Fatal("missing optional path metrics were converted to zero")
		}
		if _, err := decodeTrafficReferrers([]byte(`[{"referrer":"example.com",` + fields + `}]`)); err == nil {
			t.Fatal("missing optional referrer metrics were converted to zero")
		}
	}
}

func TestIntegrationFixedUpstreamTransport(t *testing.T) {
	client := integrationGitHubClient()
	defer client.CloseIdleConnections()
	transport := client.Transport.(*http.Transport)
	if transport.Proxy != nil {
		t.Fatal("traffic client inherited an environment proxy")
	}
	request, _ := http.NewRequest("GET", "https://outside.example/", nil)
	if client.CheckRedirect(request, nil) != http.ErrUseLastResponse {
		t.Fatal("traffic client allowed a redirect")
	}
	if strings.Contains(integrationTrafficFailure("github_http_403").Message, "token=") {
		t.Fatal("failure message contains credential material")
	}
}
