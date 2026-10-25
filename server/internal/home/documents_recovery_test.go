package home

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

// A filesystem phase can wait on a NAS indefinitely. Both navigation reads and
// writes must keep working while that phase, and another document write, wait.
func TestDocumentFilePhaseDoesNotBlockNavigation(t *testing.T) {
	f := newDocumentFixture(t, false)
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	f.app.route("POST /api/v1/spaces/{spaceId}/documents-test-file-phase/{phase}", true, func(r *Request) (*Response, error) {
		if _, _, err := r.documentSpace(true); err != nil {
			return nil, err
		}
		return &Response{AfterTransaction: func() (*Response, error) {
			entered <- struct{}{}
			select {
			case <-release:
			case <-r.HTTP.Context().Done():
				return nil, r.HTTP.Context().Err()
			}
			return f.app.documentTransaction(r, func(rr *Request) (*Response, error) {
				var one int
				if err := rr.Q.QueryRowContext(rr.HTTP.Context(), "SELECT 1").Scan(&one); err != nil {
					return nil, err
				}
				return ok(map[string]any{"finished": one == 1}), nil
			})
		}}, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request := func(phase string, finished chan<- error) {
		req, err := http.NewRequestWithContext(ctx, "POST", f.server.URL+"/api/v1/spaces/"+f.shared+"/documents-test-file-phase/"+phase, nil)
		if err != nil {
			finished <- err
			return
		}
		req.Header.Set("X-CSRF-TOKEN", f.owner.csrf)
		response, err := f.owner.client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode != 200 {
				err = fmt.Errorf("deferred request status %d", response.StatusCode)
			}
		}
		finished <- err
	}
	finished := make(chan error, 2)
	go request("first", finished)
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("document request did not reach its filesystem phase")
	}
	go request("second", finished)
	// A separate bounded client shares the authenticated session but cannot
	// accidentally wait until the document request's longer deadline expires.
	navigation := &http.Client{Jar: f.owner.client.Jar, Timeout: 2 * time.Second}
	for _, method := range []string{"GET", "POST"} {
		path := "/navigation"
		var body []byte
		if method == "POST" {
			path = "/links"
			body, _ = json.Marshal(coreLink("Still available", "https://example.invalid/available"))
		}
		req, _ := http.NewRequest(method, f.server.URL+"/api/v1/spaces/"+f.shared+path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-TOKEN", f.owner.csrf)
		response, err := navigation.Do(req)
		if err != nil {
			t.Fatalf("navigation %s was blocked by document filesystem work: %v", method, err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			t.Fatalf("navigation %s returned %d", method, response.StatusCode)
		}
	}
	unblock()
	for range 2 {
		if err := <-finished; err != nil {
			t.Fatal(err)
		}
	}
}

func TestDocumentFileSuccessAndIndexFailureIsRecoverable(t *testing.T) {
	f := newDocumentFixture(t, false)
	s := f.source(t, f.shared, "recoverable", false, map[string]string{"guide.md": "# Before\nOriginal bytes\n"})
	doc := documentByPath(t, f.owner, f.shared, "guide.md")
	path := documentURL(f.shared, doc)
	if _, err := f.app.store.DB.Exec("CREATE TRIGGER fail_document_index BEFORE UPDATE OF revision ON documents BEGIN SELECT RAISE(ABORT, 'injected index failure'); END"); err != nil {
		t.Fatal(err)
	}
	content := "# Saved original\nThe index will be repaired\n"
	result := statusWant(t, f.owner, 503, "PUT", path, map[string]any{"content": content, "expectedRevision": doc["revision"]})
	if result["code"] != "document_index_pending" {
		t.Fatalf("partial completion was not explained: %v", result)
	}
	actual, err := os.ReadFile(filepath.Join(f.root, "recoverable", "guide.md"))
	if err != nil || string(actual) != content {
		t.Fatalf("successful original write was lost: %v", err)
	}
	history := f.owner.ok("GET", path+"/history/"+doc["revision"].(string), nil)
	if history["content"] != "# Before\nOriginal bytes\n" {
		t.Fatal("recovery copy was lost after failed SQL commit")
	}
	if _, err = f.app.store.DB.Exec("DROP TRIGGER fail_document_index"); err != nil {
		t.Fatal(err)
	}
	f.owner.ok("POST", "/spaces/"+f.shared+"/document-sources/"+s["id"].(string)+"/scan", map[string]any{})
	indexed := documentByPath(t, f.owner, f.shared, "guide.md")
	if indexed["id"] != doc["id"] || indexed["revision"] != documentHash(actual) || indexed["title"] != "Saved original" {
		t.Fatalf("rescan did not repair the existing document: %v", indexed)
	}
}

func TestDocumentExternalRenameAndConfirmedMissing(t *testing.T) {
	f := newDocumentFixture(t, false)
	s := f.source(t, f.shared, "external", false, map[string]string{"guide.md": "Content without a heading\n"})
	doc := documentByPath(t, f.owner, f.shared, "guide.md")
	docPath := documentURL(f.shared, doc)
	doc = f.owner.ok("PUT", docPath+"/metadata", map[string]any{"expectedRevision": doc["revision"], "expectedMetadataRevision": doc["metadataRevision"], "tags": []string{"retain-me"}, "linkedBookmarkIds": []string{}})
	if err := os.Rename(filepath.Join(f.root, "external", "guide.md"), filepath.Join(f.root, "external", "renamed.md")); err != nil {
		t.Fatal(err)
	}
	scanPath := "/spaces/" + f.shared + "/document-sources/" + s["id"].(string) + "/scan"
	f.owner.ok("POST", scanPath, map[string]any{})
	renamed := documentByPath(t, f.owner, f.shared, "renamed.md")
	if renamed["id"] != doc["id"] || !reflect.DeepEqual(renamed["tags"], doc["tags"]) {
		t.Fatal("unambiguous external rename lost durable identity or tags")
	}
	if renamed["title"] != "renamed" {
		t.Fatal("external rename left the old filename-based title")
	}
	if err := os.Remove(filepath.Join(f.root, "external", "renamed.md")); err != nil {
		t.Fatal(err)
	}
	result := f.owner.ok("POST", scanPath, map[string]any{})
	if result["status"] != "error" || result["documentCount"] != float64(1) {
		t.Fatalf("empty mount was treated as confirmed deletion: %v", result)
	}
	retained := documentByPath(t, f.owner, f.shared, "renamed.md")
	if retained["status"] != "ready" {
		t.Fatal("unconfirmed missing file changed the stored index")
	}
	result = f.owner.ok("POST", scanPath, map[string]any{"confirmMissing": true})
	if result["status"] != "ready" || result["documentCount"] != float64(0) {
		t.Fatalf("explicit missing confirmation failed: %v", result)
	}
	retained = documentByPath(t, f.owner, f.shared, "renamed.md")
	if retained["id"] != doc["id"] || retained["status"] != "missing" || !reflect.DeepEqual(retained["tags"], doc["tags"]) {
		t.Fatal("confirmed deletion discarded metadata")
	}
}

func TestDocumentCommonMarkAttachmentReferences(t *testing.T) {
	content := []byte("![entity](assets/a&amp;b.png)\n![escaped](assets/a\\(b\\).png)\n[file](assets/a%20b.txt?download=1#section)\n[doc](other.md)\n[external](https://example.invalid/x.png)\n![ref][picture]\n\n[picture]: images/photo.png\n\n<img src=\"secret.png\">\n")
	want := map[string]bool{"assets/a&b.png": true, "assets/a(b).png": true, "assets/a b.txt": true, "images/photo.png": true}
	if got := documentAssetReferences(content); !reflect.DeepEqual(got, want) {
		t.Fatalf("Markdown attachment references differ from rendered destinations: got %v want %v", got, want)
	}
}

func TestDocumentDefaultFolderAppliesOnlyToImplicitSource(t *testing.T) {
	f := newDocumentFixture(t, false)
	s := f.source(t, f.shared, "default", false, map[string]string{})
	f.owner.ok("PUT", "/spaces/"+f.shared+"/document-sources/"+s["id"].(string), map[string]any{"expectedRevision": s["revision"], "name": "default", "readOnly": false, "defaultWrite": true, "defaultFolder": "inbox", "scanIntervalSeconds": 60})
	implicit := f.owner.ok("POST", "/spaces/"+f.shared+"/documents", map[string]any{"relativePath": "implicit.md", "content": "# Default folder\n"})
	if implicit["sourceId"] != s["id"] || implicit["relativePath"] != "inbox/implicit.md" {
		t.Fatalf("implicit source did not use its default folder: %v", implicit)
	}
	explicit := f.owner.ok("POST", "/spaces/"+f.shared+"/documents", map[string]any{"sourceId": s["id"], "relativePath": "inbox/explicit.md", "content": "# Exact path\n"})
	if explicit["relativePath"] != "inbox/explicit.md" {
		t.Fatalf("explicit source applied the default folder twice: %v", explicit)
	}
	for _, relative := range []string{"inbox/implicit.md", "inbox/explicit.md"} {
		if _, err := os.Stat(filepath.Join(f.root, "default", filepath.FromSlash(relative))); err != nil {
			t.Fatal(err)
		}
	}
}
