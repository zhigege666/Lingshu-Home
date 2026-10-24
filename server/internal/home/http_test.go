package home

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
)

type coreBrowser struct {
	t      *testing.T
	base   string
	client *http.Client
	csrf   string
}

func newCoreBrowser(t *testing.T, base string) *coreBrowser {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &coreBrowser{t: t, base: base, client: &http.Client{Jar: jar}}
}

func (b *coreBrowser) call(method, path string, body any) (int, map[string]any) {
	b.t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			b.t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, b.base+"/api/v1"+path, reader)
	if err != nil {
		b.t.Fatal(err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if method != "GET" {
		request.Header.Set("X-CSRF-TOKEN", b.csrf)
	}
	response, err := b.client.Do(request)
	if err != nil {
		b.t.Fatal(err)
	}
	defer response.Body.Close()
	data := map[string]any{}
	if response.StatusCode != 204 {
		contents, err := io.ReadAll(response.Body)
		if err != nil {
			b.t.Fatal(err)
		}
		if len(contents) > 0 {
			if err = json.Unmarshal(contents, &data); err != nil {
				b.t.Fatalf("%s %s: invalid response: %s", method, path, contents)
			}
		}
	}
	return response.StatusCode, data
}

func (b *coreBrowser) ok(method, path string, body any) map[string]any {
	b.t.Helper()
	status, data := b.call(method, path, body)
	if status < 200 || status >= 300 {
		b.t.Fatalf("%s %s returned %d: %v", method, path, status, data)
	}
	return data
}

func (b *coreBrowser) bootstrap() map[string]any {
	b.t.Helper()
	result := b.ok("GET", "/bootstrap", nil)
	token, ok := result["csrfToken"].(string)
	if !ok || token == "" {
		b.t.Fatal("missing CSRF token")
	}
	b.csrf = token
	return result
}

func coreConfig(t *testing.T, postgres bool) Config {
	t.Helper()
	dir := t.TempDir()
	version := filepath.Join(dir, "VERSION")
	if err := os.WriteFile(version, []byte("0.1.0-test"), 0600); err != nil {
		t.Fatal(err)
	}
	c := Config{DataDir: filepath.Join(dir, "data"), StorageProvider: "sqlite", VersionFile: version, WebDir: filepath.Join(dir, "web"), Language: "zh-CN"}
	if postgres {
		c.DatabaseURL = os.Getenv("LINGSHU_TEST_POSTGRES_URL")
		if c.DatabaseURL == "" {
			t.Skip("LINGSHU_TEST_POSTGRES_URL is not set; requires a fresh dedicated database")
		}
		c.StorageProvider = "postgres"
	}
	return c
}

func coreFixture(t *testing.T, postgres bool) (*App, *httptest.Server, Config) {
	t.Helper()
	c := coreConfig(t, postgres)
	a, err := Open(c)
	if err != nil {
		t.Fatal(err)
	}
	s, err := a.loadSettings(context.Background(), a.store.DB)
	if err != nil {
		a.Close()
		t.Fatal(err)
	}
	if s.Initialized {
		a.Close()
		t.Fatal("test database is initialized; supply a fresh dedicated database (tests do not erase it)")
	}
	server := httptest.NewServer(a)
	t.Cleanup(func() { server.Close(); _ = a.Close() })
	return a, server, c
}

func coreSpace(bootstrap map[string]any, kind string) string {
	spaces, _ := bootstrap["spaces"].([]any)
	for _, raw := range spaces {
		space, _ := raw.(map[string]any)
		if space["kind"] == kind {
			return space["id"].(string)
		}
	}
	return ""
}

func coreLink(title, url string) map[string]any {
	return map[string]any{"title": title, "url": url, "description": "", "icon": "lucide:link", "categoryId": nil, "tags": []string{}, "endpoints": []Endpoint{}, "isFavorite": false, "sortOrder": 0}
}

func TestHTTPStorageAndPermissions(t *testing.T)         { testCoreHTTP(t, false) }
func TestHTTPPostgresStorageAndPermissions(t *testing.T) { testCoreHTTP(t, true) }

func testCoreHTTP(t *testing.T, postgres bool) {
	a, server, _ := coreFixture(t, postgres)
	owner := newCoreBrowser(t, server.URL)
	owner.bootstrap()
	owner.ok("POST", "/setup", map[string]any{"siteName": "Test Home", "mode": ModePublicRead, "username": "owner", "displayName": "Owner", "password": "a valid test password", "seedDemo": false})
	boot := owner.bootstrap()
	shared := coreSpace(boot, "shared")
	personal := coreSpace(boot, "personal")
	if shared == "" || personal == "" {
		t.Fatal("setup did not create both spaces")
	}
	for _, values := range [][]string{{""}, {"", "Bearer invalid"}, {"Bearer invalid", "Bearer other"}} {
		request, _ := http.NewRequest("GET", server.URL+"/api/v1/bootstrap", nil)
		request.Header["Authorization"] = values
		response, err := owner.client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 401 {
			t.Fatalf("ambiguous Authorization must not fall back to owner cookie: %d", response.StatusCode)
		}
	}
	anonymous := newCoreBrowser(t, server.URL)
	anonymous.bootstrap()
	anonymous.ok("GET", "/dashboard?spaceId="+shared, nil)
	if status, _ := anonymous.call("POST", "/spaces/"+shared+"/links", coreLink("Denied", "https://example.org/")); status != 401 && status != 403 {
		t.Fatalf("public anonymous write accepted: %d", status)
	}
	if status, _ := anonymous.call("GET", "/dashboard?spaceId="+personal, nil); status != 404 && status != 403 {
		t.Fatalf("owner personal exposed: %d", status)
	}
	link := owner.ok("POST", "/spaces/"+shared+"/links", coreLink("Saved & safe", "https://example.org/one?a=1&b=2"))
	assertLinkReadback := func(expected map[string]any) {
		t.Helper()
		dataset := owner.ok("GET", "/spaces/"+shared+"/navigation", nil)
		links := dataset["data"].(map[string]any)["links"].([]any)
		if len(links) != 1 || !reflect.DeepEqual(links[0], expected) {
			t.Fatal("link write response must exactly match stored fields, including updatedAt")
		}
	}
	assertLinkReadback(link)
	link = owner.ok("PUT", "/spaces/"+shared+"/links/"+link["id"].(string), coreLink("Updated & safe", "https://example.org/one?a=1&b=2"))
	assertLinkReadback(link)
	if status, _ := owner.call("POST", "/spaces/"+shared+"/links", coreLink("Unsafe", "javascript:alert(1)")); status != 400 {
		t.Fatalf("unsafe URL accepted: %d", status)
	}
	page := owner.ok("GET", "/dashboard?spaceId="+shared, nil)["page"].(map[string]any)
	request := map[string]any{"name": "Updated Home", "config": page["config"], "expectedRevision": page["revision"]}
	var wait sync.WaitGroup
	statuses := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			status, _ := owner.call("PUT", "/spaces/"+shared+"/page", request)
			statuses <- status
		}()
	}
	wait.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("concurrent page writes: %v", counts)
	}
	page = owner.ok("GET", "/dashboard?spaceId="+shared, nil)["page"].(map[string]any)
	empty := cloneConfig(t, page["config"].(map[string]any))
	empty["views"] = []any{}
	empty["bindings"] = map[string]any{}
	empty["layout"].(map[string]any)["placements"] = map[string]any{}
	owner.ok("PUT", "/spaces/"+shared+"/page", map[string]any{"name": "Empty", "config": empty, "expectedRevision": page["revision"]})
	dashboard := owner.ok("GET", "/dashboard?spaceId="+shared, nil)
	if len(dashboard["datasets"].(map[string]any)) != 0 {
		t.Fatal("empty composition returned undeclared datasets")
	}
	dataset := owner.ok("GET", "/spaces/"+shared+"/navigation", nil)
	links := dataset["data"].(map[string]any)["links"].([]any)
	if len(links) != 1 || links[0].(map[string]any)["id"] != link["id"] {
		t.Fatal("page edit changed authoritative navigation")
	}
	owner.ok("PUT", "/settings", map[string]any{"siteName": "Test Home", "mode": ModePrivateMulti, "registrationEnabled": false})
	if user := owner.bootstrap()["user"]; user != nil {
		t.Fatal("mode change retained old session")
	}
	owner.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": "a valid test password"})
	owner.bootstrap()
	member := owner.ok("POST", "/admin/users", map[string]any{"username": "member", "displayName": "Member", "password": "another valid test password"})
	memberBrowser := newCoreBrowser(t, server.URL)
	memberBrowser.bootstrap()
	memberBrowser.ok("POST", "/auth/login", map[string]any{"username": "member", "password": "another valid test password"})
	memberBoot := memberBrowser.bootstrap()
	memberSpace := coreSpace(memberBoot, "personal")
	if memberSpace == "" || memberSpace == personal {
		t.Fatal("member personal space missing")
	}
	memberBrowser.ok("POST", "/spaces/"+memberSpace+"/links", coreLink("Private", "https://example.org/member"))
	privateCategory := memberBrowser.ok("POST", "/spaces/"+memberSpace+"/categories", map[string]any{"name": "Private category", "icon": "lucide:folder", "parentId": nil, "sortOrder": 0})
	privateLink := coreLink("Private categorized", "https://example.org/private-category")
	privateLink["categoryId"] = privateCategory["id"]
	memberBrowser.ok("POST", "/spaces/"+memberSpace+"/links", privateLink)
	if status, _ := owner.call("DELETE", "/spaces/"+shared+"/categories/"+privateCategory["id"].(string), nil); status != 404 {
		t.Fatalf("foreign category use must not be exposed through a shared-space delete: %d", status)
	}
	if status, _ := owner.call("GET", "/spaces/"+memberSpace+"/navigation", nil); status != 404 && status != 403 {
		t.Fatalf("owner may not read member personal content: %d", status)
	}
	if status, _ := memberBrowser.call("POST", "/spaces/"+shared+"/links", coreLink("Denied", "https://example.org/member-write")); status != 403 {
		t.Fatalf("member shared write accepted: %d", status)
	}
	owner.ok("PUT", "/admin/users/"+member["id"].(string), map[string]any{"displayName": "Member", "isEnabled": false})
	if user := memberBrowser.bootstrap()["user"]; user != nil {
		t.Fatal("disabled user session was retained")
	}
	if status, _ := memberBrowser.call("GET", "/spaces/"+memberSpace+"/navigation", nil); status != 401 {
		t.Fatalf("disabled session still reads: %d", status)
	}
	if postgres {
		// Reuse this suite's exclusively owned PostgreSQL instance. A cancelled
		// caller must not discard its advisory-lock connection or break later HTTP.
		cancelled, cancel := context.WithCancel(context.Background())
		cancel()
		if err := a.store.CheckLease(cancelled); !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled lease caller returned %v", err)
		}
		if a.store.leaseLost.Load() {
			t.Fatal("request cancellation marked the PostgreSQL lease as lost")
		}
		if err := a.store.CheckLease(context.Background()); err != nil {
			t.Fatalf("request cancellation broke the PostgreSQL lease: %v", err)
		}
		owner.bootstrap()
		if err := a.store.pgLease.Close(); err != nil {
			t.Fatal(err)
		}
		if err := a.store.DB.PingContext(context.Background()); err != nil {
			t.Fatal("normal pool must remain healthy for lease test")
		}
		for range 2 {
			if status, body := owner.call("GET", "/health", nil); status != 503 || body["code"] != "storage_unavailable" {
				t.Fatalf("lost lease must remain fail closed: %d %v", status, body["code"])
			}
			if !a.store.leaseLost.Load() {
				t.Fatal("lost PostgreSQL lease was not latched")
			}
		}
	}
}

func TestOwnerlessPersistenceAndSingleton(t *testing.T) {
	c := coreConfig(t, false)
	a, err := Open(c)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(a)
	guest := newCoreBrowser(t, server.URL)
	guest.bootstrap()
	guest.ok("POST", "/setup", map[string]any{"siteName": "Open Home", "mode": ModeOpenEdit, "seedDemo": false})
	boot := guest.bootstrap()
	shared := coreSpace(boot, "shared")
	if boot["user"] != nil || shared == "" {
		t.Fatal("ownerless setup must remain anonymous")
	}
	guest.ok("POST", "/spaces/"+shared+"/links", coreLink("Persistent", "https://example.org/persistent"))
	if duplicate, err := Open(c); err == nil {
		duplicate.Close()
		t.Fatal("same data directory allowed a second instance")
	}
	guest.ok("PUT", "/settings", map[string]any{"siteName": "Private Home", "mode": ModePrivateSingle, "registrationEnabled": false, "owner": map[string]any{"username": "owner", "displayName": "Owner", "password": "a valid test password"}})
	if guest.bootstrap()["user"] == nil {
		t.Fatal("new owner was not signed in")
	}
	server.Close()
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	a, err = Open(c)
	if err != nil {
		t.Fatal(err)
	}
	server = httptest.NewServer(a)
	defer server.Close()
	defer a.Close()
	guest.base = server.URL
	boot = guest.bootstrap()
	if boot["mode"] != ModePrivateSingle || boot["user"] == nil {
		t.Fatal("persistent mode/account/session not restored")
	}
	data := guest.ok("GET", "/spaces/"+shared+"/navigation", nil)["data"].(map[string]any)
	if len(data["links"].([]any)) != 1 {
		t.Fatal("navigation did not survive restart")
	}
	_, err = a.store.DB.ExecContext(context.Background(), "UPDATE schema_migrations SET checksum='changed' WHERE version='001_initial.sql'")
	if err != nil {
		t.Fatal(err)
	}
	server.Close()
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	if changed, err := Open(c); err == nil {
		changed.Close()
		t.Fatal("modified migration checksum accepted")
	}
}

func TestAuthLimiter(t *testing.T) {
	limiter := &authLimiter{}
	for i := 0; i < 20; i++ {
		if ok, _ := limiter.allow("127.0.0.1:9000"); !ok {
			t.Fatal("limited too early")
		}
	}
	if ok, retry := limiter.allow("127.0.0.1:9001"); ok || retry < 1 {
		t.Fatal("rate limit must key by IP, not port")
	}
	if ok, _ := limiter.allow("127.0.0.2:9000"); !ok {
		t.Fatal("independent client incorrectly rate limited")
	}
	if strings.TrimSpace(tokenHash("test")) == "test" {
		t.Fatal("tokens must be hashed")
	}
}
