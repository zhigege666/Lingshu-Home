package home

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDocumentMCPDestinations(t *testing.T) {
	f := newDocumentFixture(t, false)
	owner := &integrationTestBrowser{t: t, base: f.server.URL, client: f.owner.client, csrf: f.owner.csrf}
	caller := integrationBrowser(t, f.server.URL)
	writer, _ := owner.token(f.shared, "", "documents:read", "documents:write")
	reader, _ := owner.token(f.shared, "", "documents:read")
	navOnly, _ := owner.token(f.shared, "", "navigation:read")
	f.source(t, f.personal, "private", true, nil)
	readOnly := f.source(t, f.shared, "archive", true, nil)
	dir := filepath.Join(f.root, "notes")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	notes := f.owner.ok("POST", "/spaces/"+f.shared+"/document-sources", map[string]any{"name": "notes", "path": dir, "readOnly": false, "defaultWrite": false})
	args := map[string]any{"input": map[string]any{"relativePath": "from-agent.md", "content": ""}}
	caller.tool(writer, "documents_create", args, "document_write_destination_required")
	caller.tool(navOnly, "document_sources_list", map[string]any{}, "forbidden")
	caller.tool(writer, "document_sources_list", map[string]any{"spaceId": f.personal}, "not_found")
	for _, tc := range []struct {
		token string
		write bool
	}{{writer, true}, {reader, false}} {
		dirs := caller.tool(tc.token, "document_sources_list", map[string]any{}, "")["items"].([]any)
		if len(dirs) != 2 {
			t.Fatalf("expected two active shared directories, got %d", len(dirs))
		}
		for _, raw := range dirs {
			d := integrationObject(t, raw)
			if len(d) != 7 || d["path"] != nil || d["defaultWrite"] != false || d["defaultFolder"] != "" || d["status"] != "ready" {
				t.Fatalf("unexpected destination projection: %v", d)
			}
			wantReadOnly := d["id"] == readOnly["id"]
			if !wantReadOnly && d["id"] != notes["id"] || d["readOnly"] != wantReadOnly || d["canWrite"] != (tc.write && !wantReadOnly) {
				t.Fatalf("wrong destination or write permission: %v", d)
			}
		}
	}
	input := args["input"].(map[string]any)
	input["sourceId"] = readOnly["id"]
	caller.tool(writer, "documents_create", args, "document_source_read_only")
	input["sourceId"] = notes["id"]
	caller.tool(reader, "documents_create", args, "forbidden")
	created := caller.tool(writer, "documents_create", args, "")
	if created["sourceId"] != notes["id"] || created["content"] != "" {
		t.Fatal("discovered empty destination could not accept an empty note")
	}

	f.owner.ok("POST", documentURL(f.shared, created)+"/publish", map[string]any{"expectedRevision": created["revision"], "expectedMetadataRevision": created["metadataRevision"]})
	if err := os.Remove(filepath.Join(dir, "from-agent.md")); err != nil {
		t.Fatal(err)
	}

	// A signed-in member can read published snapshots in the shared space
	// without being allowed to inspect its working document directories.
	f.owner.ok("PUT", "/settings", map[string]any{"siteName": "Document library fixture", "mode": ModePrivateMulti, "registrationEnabled": false})
	f.owner.bootstrap()
	f.owner.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": "document fixture password"})
	f.owner.bootstrap()
	f.owner.ok("POST", "/admin/users", map[string]any{"username": "member", "displayName": "Member", "password": "member directory fixture password"})
	member := integrationBrowser(t, f.server.URL)
	member.boot()
	member.call("POST", "/api/v1/auth/login", map[string]any{"username": "member", "password": "member directory fixture password"}, 200, "")
	member.boot()
	memberToken, _ := member.token(f.shared, "", "documents:read")
	caller.tool(memberToken, "document_sources_list", map[string]any{}, "forbidden")
	snapshot := caller.tool(memberToken, "documents_get", map[string]any{"id": created["id"]}, "")
	if snapshot["content"] != "" || snapshot["status"] != "ready" || snapshot["canRestore"] == true {
		t.Fatal("snapshot-only reader must see the published empty body, independent of the missing working file")
	}
}

func TestDocumentMCPUnavailableOriginal(t *testing.T) {
	f := newDocumentFixture(t, false)
	f.source(t, f.shared, "notes", false, map[string]string{"note.md": ""})
	doc := documentByPath(t, f.owner, f.shared, "note.md")
	owner := &integrationTestBrowser{t: t, base: f.server.URL, client: f.owner.client, csrf: f.owner.csrf}
	writer, _ := owner.token(f.shared, "", "documents:read", "documents:write")
	reader, _ := owner.token(f.shared, "", "documents:read")
	caller := integrationBrowser(t, f.server.URL)
	args := map[string]any{"id": doc["id"]}
	empty := caller.tool(writer, "documents_get", args, "")
	if empty["content"] != "" || empty["revision"] != documentHash(nil) || empty["readOnly"] != false {
		t.Fatal("genuinely empty file must return a usable empty body")
	}
	// Retain the empty revision in history, then remove the current file externally.
	caller.tool(writer, "documents_update", map[string]any{"id": doc["id"], "input": map[string]any{"expectedRevision": empty["revision"], "content": "latest"}}, "")
	dir := filepath.Join(f.root, "notes")
	file := filepath.Join(dir, "note.md")
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	caller.tool(reader, "documents_get", args, "document_file_missing")
	detail := f.owner.ok("GET", documentURL(f.shared, doc), nil)
	if _, hasBody := detail["content"]; hasBody || detail["unavailableReason"] != "file_missing" || detail["status"] != "missing" || detail["readOnly"] != true || detail["canRestore"] != true {
		t.Fatalf("unexpected missing-file HTTP view: %v", detail)
	}
	readDetail := caller.object("GET", "/api/v1"+documentURL(f.shared, doc), nil, 200, reader)
	if readDetail["canRestore"] == true {
		t.Fatal("read-only token advertised file restoration")
	}
	restored := f.owner.ok("POST", documentURL(f.shared, doc)+"/restore", map[string]any{"revision": empty["revision"], "expectedRevision": detail["revision"]})
	if restored["content"] != "" || restored["status"] != "ready" {
		t.Fatal("missing-file history recovery regressed")
	}
	if err := os.WriteFile(file, []byte{0}, 0600); err != nil {
		t.Fatal(err)
	}
	caller.tool(reader, "documents_get", args, "document_unsupported_content")
	if err := os.Rename(dir, dir+"-offline"); err != nil {
		t.Fatal(err)
	}
	caller.tool(reader, "documents_get", args, "document_source_unavailable")
}
