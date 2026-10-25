package home

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

type documentFixture struct {
	app                    *App
	server                 *httptest.Server
	owner                  *coreBrowser
	root, shared, personal string
}

func newDocumentFixture(t *testing.T, postgres bool) *documentFixture {
	t.Helper()
	c := coreConfig(t, false)
	c.DocumentRoots = []string{t.TempDir()}
	if postgres {
		c.DatabaseURL = os.Getenv("LINGSHU_TEST_DOCUMENT_POSTGRES_URL")
		if c.DatabaseURL == "" {
			t.Skip("requires a fresh dedicated LINGSHU_TEST_DOCUMENT_POSTGRES_URL database")
		}
		c.StorageProvider = "postgres"
	}
	a, err := Open(c)
	if err != nil {
		t.Fatal(err)
	}
	settings, err := a.loadSettings(context.Background(), a.store.DB)
	if err != nil || settings.Initialized {
		a.Close()
		t.Fatalf("test requires an unused database: %v", err)
	}
	server := httptest.NewServer(a)
	t.Cleanup(func() { server.Close(); _ = a.Close() })
	owner := newCoreBrowser(t, server.URL)
	owner.bootstrap()
	owner.ok("POST", "/setup", map[string]any{"siteName": "Document library fixture", "mode": ModePublicRead, "username": "owner", "password": "document fixture password", "seedDemo": false})
	boot := owner.bootstrap()
	return &documentFixture{a, server, owner, c.DocumentRoots[0], coreSpace(boot, "shared"), coreSpace(boot, "personal")}
}

func (f *documentFixture) source(t *testing.T, space, name string, readOnly bool, files map[string]string) map[string]any {
	t.Helper()
	root := filepath.Join(f.root, name)
	if err := os.MkdirAll(root, 0750); err != nil {
		t.Fatal(err)
	}
	for file, content := range files {
		p := filepath.Join(root, filepath.FromSlash(file))
		if err := os.MkdirAll(filepath.Dir(p), 0750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0640); err != nil {
			t.Fatal(err)
		}
	}
	return f.owner.ok("POST", "/spaces/"+space+"/document-sources", map[string]any{"name": name, "path": root, "readOnly": readOnly, "defaultWrite": !readOnly, "scanIntervalSeconds": 60})
}

func documentItems(t *testing.T, b *coreBrowser, space, query string) []any {
	t.Helper()
	result := b.ok("GET", "/spaces/"+space+"/documents"+query, nil)
	return result["items"].([]any)
}
func documentByPath(t *testing.T, b *coreBrowser, space, relative string) map[string]any {
	t.Helper()
	items := documentItems(t, b, space, "?relativePath="+url.QueryEscape(relative))
	if len(items) != 1 {
		t.Fatalf("expected one %s: %v", relative, items)
	}
	return items[0].(map[string]any)
}
func documentURL(space string, doc map[string]any) string {
	return "/spaces/" + space + "/documents/" + doc["id"].(string)
}
func statusWant(t *testing.T, b *coreBrowser, want int, method, path string, input any) map[string]any {
	t.Helper()
	status, data := b.call(method, path, input)
	if status != want {
		t.Fatalf("%s %s: status=%d want=%d data=%v", method, path, status, want, data)
	}
	return data
}

func TestDocumentLibrarySQLite(t *testing.T)   { testDocumentLibrary(t, false) }
func TestDocumentLibraryPostgres(t *testing.T) { testDocumentLibrary(t, true) }

func testDocumentLibrary(t *testing.T, postgres bool) {
	f := newDocumentFixture(t, postgres)
	b := f.owner
	original := "---\r\ncustom: untouched\r\n---\r\n# Original notes\r\n\r\nInitial search text\r\n"
	notes := f.source(t, f.shared, "notes", false, map[string]string{"README.md": original, "nested/other.md": "# Other\n"})
	projects := f.source(t, f.shared, "projects", true, map[string]string{"README.md": "# Project read only\n"})
	private := f.source(t, f.personal, "private", false, map[string]string{"secret.md": "# Personal secret\nprivate-canary-47\n"})
	if notes["status"] != "ready" || projects["status"] != "ready" || private["status"] != "ready" {
		t.Fatalf("scan failed: %v %v %v", notes, projects, private)
	}
	got, _ := os.ReadFile(filepath.Join(f.root, "notes", "README.md"))
	if string(got) != original {
		t.Fatal("initial scan rewrote the original Markdown")
	}
	items := documentItems(t, b, f.shared, "")
	if len(items) != 3 {
		t.Fatalf("multiple roots did not aggregate: %v", items)
	}
	var doc, readOnly map[string]any
	for _, item := range items {
		value := item.(map[string]any)
		if value["sourceId"] == notes["id"] && value["relativePath"] == "README.md" {
			doc = value
		}
		if value["sourceId"] == projects["id"] {
			readOnly = value
		}
	}
	if doc == nil || readOnly == nil {
		t.Fatal("duplicate README paths were merged")
	}
	docPath := documentURL(f.shared, doc)
	visitor := newCoreBrowser(t, f.server.URL)
	visitor.bootstrap()
	if len(documentItems(t, visitor, f.shared, "")) != 0 {
		t.Fatal("newly connected documents were published automatically")
	}
	statusWant(t, visitor, 404, "GET", docPath, nil)
	privateDoc := documentByPath(t, b, f.personal, "secret.md")
	statusWant(t, visitor, 404, "GET", documentURL(f.personal, privateDoc), nil)
	statusWant(t, visitor, 401, "GET", "/spaces/"+f.shared+"/document-sources", nil)
	// Registering a parent, child or another-space alias must not create a second owner.
	for _, root := range []string{filepath.Join(f.root, "notes"), filepath.Join(f.root, "notes", "nested"), f.root} {
		statusWant(t, b, 409, "POST", "/spaces/"+f.personal+"/document-sources", map[string]any{"name": "overlap", "path": root, "readOnly": true})
	}
	statusWant(t, b, 403, "PUT", documentURL(f.shared, readOnly), map[string]any{"content": "bad", "expectedRevision": readOnly["revision"]})
	// Required field omissions must never be interpreted as destructive clears.
	statusWant(t, b, 400, "PUT", docPath, map[string]any{"expectedRevision": doc["revision"]})
	got, _ = os.ReadFile(filepath.Join(f.root, "notes", "README.md"))
	if string(got) != original {
		t.Fatal("omitted content cleared file")
	}
	bookmark := b.ok("POST", "/spaces/"+f.shared+"/links", coreLink("Reference", "https://example.com/docs"))
	metadata := map[string]any{"expectedRevision": doc["revision"], "expectedMetadataRevision": doc["metadataRevision"], "tags": []string{"ops"}, "linkedBookmarkIds": []string{bookmark["id"].(string)}}
	doc = b.ok("PUT", docPath+"/metadata", metadata)
	statusWant(t, b, 409, "PUT", docPath+"/metadata", metadata)
	statusWant(t, b, 400, "PUT", docPath+"/metadata", map[string]any{"expectedRevision": doc["revision"], "expectedMetadataRevision": doc["metadataRevision"]})
	if len(documentItems(t, b, f.shared, "?linkedBookmarkId="+bookmark["id"].(string))) != 1 {
		t.Fatal("bookmark relation filter failed")
	}
	// Concurrent external changes are checked against the file, not the cached index.
	external := "# Changed externally\nexternal-canary-92\n"
	if err := os.WriteFile(filepath.Join(f.root, "notes", "README.md"), []byte(external), 0640); err != nil {
		t.Fatal(err)
	}
	statusWant(t, b, 409, "PUT", docPath, map[string]any{"content": "stale overwrite", "expectedRevision": doc["revision"]})
	loaded := b.ok("GET", docPath, nil)
	if loaded["content"] != external {
		t.Fatal("reads returned the stale index instead of original file")
	}
	// Saving metadata immediately after reloading an external edit must compare
	// the original's revision, not require waiting for a scheduled index scan.
	doc = b.ok("PUT", docPath+"/metadata", map[string]any{"expectedRevision": loaded["revision"], "expectedMetadataRevision": loaded["metadataRevision"], "tags": []string{"ops"}, "linkedBookmarkIds": []string{bookmark["id"].(string)}})
	if doc["revision"] != loaded["revision"] || doc["content"] != external {
		t.Fatal("metadata save did not retain the external revision")
	}
	doc = b.ok("PUT", docPath, map[string]any{"content": "# Saved in Home\nSearch goldenneedle\n", "expectedRevision": loaded["revision"]})
	got, _ = os.ReadFile(filepath.Join(f.root, "notes", "README.md"))
	if string(got) != doc["content"] {
		t.Fatal("save did not reach the original file")
	}
	if len(documentItems(t, b, f.shared, "?q=goldenneedle")) != 1 {
		t.Fatal("full-content search failed")
	}
	history := b.ok("GET", docPath+"/history", nil)["items"].([]any)
	if len(history) != 1 {
		t.Fatalf("old content not retained: %v", history)
	}
	previous := history[0].(map[string]any)["revision"].(string)
	if b.ok("GET", docPath+"/history/"+previous, nil)["content"] != external {
		t.Fatal("history bytes changed")
	}
	statusWant(t, visitor, 404, "GET", docPath+"/history", nil)
	// Home rename keeps the durable ID and metadata.
	doc = b.ok("POST", docPath+"/rename", map[string]any{"relativePath": "moved/guide.md", "expectedRevision": doc["revision"]})
	if doc["relativePath"] != "moved/guide.md" || len(doc["linkedBookmarkIds"].([]any)) != 1 {
		t.Fatal("rename lost metadata")
	}
	created := b.ok("POST", "/spaces/"+f.shared+"/documents", map[string]any{"sourceId": notes["id"], "relativePath": "new.md", "content": "# New\n"})
	statusWant(t, b, 409, "POST", "/spaces/"+f.shared+"/documents", map[string]any{"sourceId": notes["id"], "relativePath": "new.md", "content": "overwrite"})
	statusWant(t, b, 403, "POST", "/spaces/"+f.shared+"/documents", map[string]any{"sourceId": projects["id"], "relativePath": "new.md", "content": "bad"})
	statusWant(t, b, 404, "POST", "/spaces/"+f.shared+"/documents", map[string]any{"sourceId": private["id"], "relativePath": "new.md", "content": "cross space"})
	// Delete is distinct from unbind, and the recovery copy can restore the file.
	removed := b.ok("DELETE", docPath+"?expectedRevision="+doc["revision"].(string), nil)
	if removed["status"] != "missing" {
		t.Fatal("deleted file was not retained for recovery")
	}
	doc = b.ok("POST", docPath+"/restore", map[string]any{"revision": previous, "expectedRevision": doc["revision"]})
	if doc["content"] != external {
		t.Fatal("history restore failed")
	}
	// Missing mount is not deletion, and unbind preserves every original.
	root := filepath.Join(f.root, "notes")
	away := filepath.Join(f.root, "notes-disconnected")
	if err := os.Rename(root, away); err != nil {
		t.Fatal(err)
	}
	sourcePath := "/spaces/" + f.shared + "/document-sources/" + notes["id"].(string)
	scanned := b.ok("POST", sourcePath+"/scan", map[string]any{})
	if scanned["status"] != "offline" {
		t.Fatalf("offline source: %v", scanned)
	}
	if b.ok("GET", docPath, nil)["unavailableReason"] != "source_unavailable" {
		t.Fatal("offline read did not explain missing source")
	}
	if err := os.Rename(away, root); err != nil {
		t.Fatal(err)
	}
	b.ok("POST", sourcePath+"/scan", map[string]any{})
	statusWant(t, b, 204, "DELETE", sourcePath+"?expectedRevision="+notes["revision"].(string), nil)
	if _, err := os.Stat(filepath.Join(root, "new.md")); err != nil {
		t.Fatal("unbind deleted original files")
	}
	statusWant(t, b, 404, "GET", documentURL(f.shared, created), nil)
	if _, err := f.app.store.DB.ExecContext(context.Background(), "SELECT 1"); err != nil {
		t.Fatal(err)
	}
}

func TestDocumentPublicationAndAttachments(t *testing.T) {
	f := newDocumentFixture(t, false)
	b := f.owner
	content := "# Published manual\n\n中文内容\n\n[Download](assets/manual.txt)\n\n![Picture](assets/pixel.png)\n"
	s := f.source(t, f.shared, "public", true, map[string]string{"guide.md": content, "assets/manual.txt": "published attachment v1"})
	png := []byte("\x89PNG\r\n\x1a\nfixture")
	if err := os.WriteFile(filepath.Join(f.root, "public", "assets", "pixel.png"), png, 0640); err != nil {
		t.Fatal(err)
	}
	doc := documentByPath(t, b, f.shared, "guide.md")
	docPath := documentURL(f.shared, doc)
	doc = b.ok("POST", docPath+"/publish", map[string]any{"expectedRevision": doc["revision"], "expectedMetadataRevision": doc["metadataRevision"]})
	visitor := newCoreBrowser(t, f.server.URL)
	visitor.bootstrap()
	if visitor.ok("GET", docPath, nil)["content"] != content {
		t.Fatal("published snapshot differs")
	}
	publicList := documentItems(t, visitor, f.shared, "")
	if len(publicList) != 1 || publicList[0].(map[string]any)["size"] != float64(len(content)) {
		t.Fatal("metadata-only public list lost the UTF-8 snapshot byte size")
	}
	assetURL := f.server.URL + "/api/v1" + docPath + "/asset?path=" + url.QueryEscape("assets/manual.txt")
	readAsset := func(want string) {
		t.Helper()
		response, err := visitor.client.Get(assetURL)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, _ := io.ReadAll(response.Body)
		if response.StatusCode != 200 || string(data) != want {
			t.Fatalf("snapshot asset: %d %s", response.StatusCode, data)
		}
		if response.Header.Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(response.Header.Get("Content-Disposition"), "attachment") {
			t.Fatal("active attachment was not sandboxed as a download")
		}
	}
	readAsset("published attachment v1")
	_ = os.WriteFile(filepath.Join(f.root, "public", "guide.md"), []byte("# Unpublished secret\nsecret-after-publish\n[Download](assets/manual.txt)\n"), 0640)
	_ = os.WriteFile(filepath.Join(f.root, "public", "assets", "manual.txt"), []byte("unpublished attachment v2"), 0640)
	b.ok("POST", "/spaces/"+f.shared+"/document-sources/"+s["id"].(string)+"/scan", map[string]any{})
	if visitor.ok("GET", docPath, nil)["content"] != content {
		t.Fatal("external edit leaked through published body")
	}
	readAsset("published attachment v1")
	if len(documentItems(t, visitor, f.shared, "?q=secret-after-publish")) != 0 {
		t.Fatal("search leaked unpublished content")
	}
	if !b.ok("GET", docPath, nil)["hasUnpublishedChanges"].(bool) {
		t.Fatal("unpublished changes not reported")
	}
	statusWant(t, visitor, 404, "GET", docPath+"/asset?path=unreferenced.txt", nil)
	statusWant(t, visitor, 400, "GET", docPath+"/asset?path=../../outside.txt", nil)
	statusWant(t, visitor, 404, "GET", docPath+"/history", nil)
	b.ok("DELETE", docPath+"/publish", nil)
	statusWant(t, visitor, 404, "GET", docPath, nil)
	response, err := visitor.client.Get(assetURL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 404 {
		t.Fatal("unpublish left attachment accessible")
	}
}

func TestDocumentPathsAndSpecialFiles(t *testing.T) {
	f := newDocumentFixture(t, false)
	s := f.source(t, f.shared, "notes", false, map[string]string{"safe.md": "# Safe\n"})
	root := filepath.Join(f.root, "notes")
	for _, relative := range []string{"../outside.md", "/absolute.md", ".env.md", "sub/../../outside.md", "sub\\outside.md", "a/./b.md", "file.txt", "a\x00.md"} {
		statusWant(t, f.owner, 400, "POST", "/spaces/"+f.shared+"/documents", map[string]any{"sourceId": s["id"], "relativePath": relative, "content": "bad"})
	}
	outside := filepath.Join(t.TempDir(), "private.md")
	_ = os.WriteFile(outside, []byte("outside canary"), 0600)
	if err := os.Symlink(outside, filepath.Join(root, "alias.md")); err != nil {
		t.Fatal(err)
	}
	f.owner.ok("POST", "/spaces/"+f.shared+"/document-sources/"+s["id"].(string)+"/scan", map[string]any{})
	if len(documentItems(t, f.owner, f.shared, "?q=outside%20canary")) != 0 {
		t.Fatal("symlink escaped document boundary")
	}
	doc := documentByPath(t, f.owner, f.shared, "safe.md")
	_ = os.Remove(filepath.Join(root, "safe.md"))
	_ = os.Symlink(outside, filepath.Join(root, "safe.md"))
	statusWant(t, f.owner, 400, "PUT", documentURL(f.shared, doc), map[string]any{"content": "attack", "expectedRevision": doc["revision"]})
	data, _ := os.ReadFile(outside)
	if string(data) != "outside canary" {
		t.Fatal("write escaped source root")
	}
	// A named pipe masquerading as Markdown must fail without blocking the write gate.
	fifo := filepath.Join(root, "pipe.md")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	done := make(chan error, 1)
	go func() { _, _, err := readDocumentFile(r, "pipe.md", maxDocumentBytes); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("accepted special file")
		}
	case <-time.After(time.Second):
		t.Fatal("blocked opening special file")
	}
}

func TestDocumentConfigAndRootBoundary(t *testing.T) {
	c := coreConfig(t, false)
	c.DocumentRoots = []string{"/"}
	if err := c.validate(); err == nil {
		t.Fatal("accepted filesystem root")
	}
	c = coreConfig(t, false)
	c.DocumentRoots = []string{c.DataDir}
	if err := c.validate(); err == nil {
		t.Fatal("exposed application data")
	}
	c = coreConfig(t, false)
	root := t.TempDir()
	_ = os.WriteFile(filepath.Join(root, "secret.pem"), []byte("test key"), 0600)
	alias := filepath.Join(t.TempDir(), "key.pem")
	_ = os.Symlink(filepath.Join(root, "secret.pem"), alias)
	c.TLSCertFile = alias
	c.TLSKeyFile = alias
	c.DocumentRoots = []string{root}
	if err := c.validate(); err == nil {
		t.Fatal("exposed resolved TLS key")
	}
	if _, err := ParseConfig([]string{"--document-roots", "not-json"}); err == nil {
		t.Fatal("invalid root configuration accepted")
	}
}

func TestDocumentWriteOnlyScopeCannotTouchFiles(t *testing.T) {
	f := newDocumentFixture(t, false)
	s := f.source(t, f.shared, "notes", false, map[string]string{"guide.md": "untouched"})
	_ = s
	doc := documentByPath(t, f.owner, f.shared, "guide.md")
	token := f.owner.ok("POST", "/integrations/tokens", map[string]any{"name": "legacy test", "spaceId": f.shared, "actions": []string{"documents:read", "documents:write"}, "expiresAt": time.Now().UTC().Add(time.Hour)})
	// Recreate an old/malformed scope combination directly in this disposable DB.
	_, err := f.app.store.DB.ExecContext(context.Background(), f.app.store.Query("UPDATE integration_tokens SET actions_json=? WHERE id=?"), `["documents:write"]`, token["credential"].(map[string]any)["id"])
	if err != nil {
		t.Fatal(err)
	}
	var value string
	for _, key := range []string{"token", "value"} {
		if v, ok := token[key].(string); ok {
			value = v
		}
	}
	if value == "" {
		t.Fatalf("missing test token: keys %v", token)
	}
	encoded, _ := json.Marshal(map[string]any{"content": "must not save", "expectedRevision": doc["revision"]})
	request, _ := http.NewRequest("PUT", f.server.URL+"/api/v1"+documentURL(f.shared, doc), bytes.NewReader(encoded))
	request.Header.Set("Authorization", "Bearer "+value)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatalf("write-only scope status=%d", response.StatusCode)
	}
	content, _ := os.ReadFile(filepath.Join(f.root, "notes", "guide.md"))
	if string(content) != "untouched" {
		t.Fatal("file changed before response authorization")
	}
}
