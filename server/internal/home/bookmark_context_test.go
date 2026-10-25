package home

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestBookmarkContextAndAgentScopes(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			config := coreConfig(t, false)
			documentsPath := t.TempDir()
			config.DocumentRoots = []string{documentsPath}
			if provider == "postgres" {
				config.DatabaseURL = os.Getenv("LINGSHU_TEST_BOOKMARK_CONTEXT_POSTGRES_URL")
				if config.DatabaseURL == "" {
					t.Skip("requires a fresh dedicated LINGSHU_TEST_BOOKMARK_CONTEXT_POSTGRES_URL")
				}
				config.StorageProvider = provider
			}
			app, err := Open(config)
			if err != nil {
				t.Fatal(err)
			}
			defer app.Close()
			server := httptest.NewServer(app)
			defer server.Close()
			owner := integrationBrowser(t, server.URL)
			if owner.boot()["initialized"] != false {
				t.Fatal("refusing an initialized test database")
			}
			owner.object("POST", "/api/v1/setup", map[string]any{"siteName": "Notes test", "mode": ModePrivateMulti, "username": "notes-owner", "password": "notes-test-password-2026", "seedDemo": false}, http.StatusCreated, "")
			boot := owner.boot()
			shared := integrationSpace(t, boot, "shared")
			personal := integrationSpace(t, boot, "personal")
			base := "/api/v1/spaces/" + shared
			input := coreLink("A deployment reference", "https://example.org/deploy")
			notes := "# 使用说明\n\n适用于发布前检查。\n\n```sh\nprintf 'reference only'\n```\n"
			input["contextMarkdown"] = notes
			created := owner.object("POST", base+"/links", input, http.StatusCreated, "")
			id := created["id"].(string)
			if created["contextMarkdown"] != notes {
				t.Fatal("create did not retain Markdown verbatim")
			}
			legacy := coreLink("Updated title only", "https://example.org/deploy")
			updated := owner.object("PUT", base+"/links/"+id, legacy, http.StatusOK, "")
			if updated["contextMarkdown"] != notes {
				t.Fatal("legacy PUT erased usage notes")
			}
			before := integrationClone(updated)
			replacement := "## Current notes\nKeep the original URL and tags.\n"
			patched := owner.object("PUT", base+"/links/"+id+"/context", map[string]any{"contextMarkdown": replacement, "expectedUpdatedAt": updated["updatedAt"]}, http.StatusOK, "")
			for key, value := range before {
				if key != "contextMarkdown" && key != "updatedAt" && !reflect.DeepEqual(patched[key], value) {
					t.Fatalf("context-only update changed %s", key)
				}
			}
			if patched["contextMarkdown"] != replacement {
				t.Fatal("context-only update lost content")
			}
			owner.object("PUT", base+"/links/"+id+"/context", map[string]any{"contextMarkdown": "stale", "expectedUpdatedAt": before["updatedAt"]}, http.StatusConflict, "")
			owner.object("PUT", base+"/links/"+id+"/context", map[string]any{"contextMarkdown": "missing revision"}, http.StatusBadRequest, "")
			owner.object("PUT", base+"/links/"+id+"/context", map[string]any{"expectedUpdatedAt": patched["updatedAt"]}, http.StatusBadRequest, "")
			owner.object("PUT", base+"/links/"+id+"/context", map[string]any{"contextMarkdown": strings.Repeat("中", 22000), "expectedUpdatedAt": patched["updatedAt"]}, http.StatusBadRequest, "")
			noop := owner.object("PUT", base+"/links/"+id+"/context", map[string]any{"contextMarkdown": replacement, "expectedUpdatedAt": patched["updatedAt"]}, http.StatusOK, "")
			if noop["updatedAt"] != patched["updatedAt"] {
				t.Fatal("no-op changed bookmark revision")
			}
			legacy["contextMarkdown"] = "outdated editor notes"
			legacy["expectedUpdatedAt"] = before["updatedAt"]
			owner.object("PUT", base+"/links/"+id, legacy, http.StatusConflict, "")
			delete(legacy, "expectedUpdatedAt")
			legacy["contextMarkdown"] = ""
			cleared := owner.object("PUT", base+"/links/"+id, legacy, http.StatusOK, "")
			if cleared["contextMarkdown"] != "" {
				t.Fatal("explicit empty notes did not clear")
			}
			oversize := coreLink("Too large", "https://example.org/oversize")
			oversize["contextMarkdown"] = strings.Repeat("a", 65537)
			owner.object("POST", base+"/links", oversize, http.StatusBadRequest, "")
			oversize["contextMarkdown"] = "invalid\x00control"
			owner.object("POST", base+"/links", oversize, http.StatusBadRequest, "")

			readToken, _ := owner.token(shared, "", "navigation:read", "pages:read")
			writeToken, _ := owner.token(shared, "", "navigation:write")
			agent := integrationBrowser(t, server.URL)
			patched = agent.tool(writeToken, "bookmarks_context_update", map[string]any{"spaceId": shared, "id": id, "input": map[string]any{"contextMarkdown": notes, "expectedUpdatedAt": cleared["updatedAt"]}}, "")
			if patched["contextMarkdown"] != notes {
				t.Fatal("MCP context update lost Markdown")
			}
			agent.tool(readToken, "bookmarks_context_update", map[string]any{"spaceId": shared, "id": id, "input": map[string]any{"contextMarkdown": "unauthorized", "expectedUpdatedAt": patched["updatedAt"]}}, "forbidden")
			agent.tool(writeToken, "bookmarks_context_update", map[string]any{"spaceId": personal, "id": id, "input": map[string]any{"contextMarkdown": "wrong space", "expectedUpdatedAt": patched["updatedAt"]}}, "not_found")
			// An HTML import with skip must leave existing usage notes intact.
			imported := owner.object("POST", base+"/bookmarks/import", map[string]any{"html": `<DL><DT><A HREF="https://example.org/deploy">Imported title</A></DL>`, "duplicatePolicy": "skip"}, http.StatusOK, "")
			if imported["imported"] != float64(0) {
				t.Fatal("duplicate import changed the bookmark")
			}
			fetched := agent.tool(readToken, "bookmarks_get", map[string]any{"spaceId": shared, "id": id}, "")
			if fetched["contextMarkdown"] != notes {
				t.Fatal("agent read lacks usage notes")
			}
			exported := owner.object("GET", base+"/export?format=json", nil, http.StatusOK, "")
			if exported["links"].([]any)[0].(map[string]any)["contextMarkdown"] != notes {
				t.Fatal("JSON export lost notes")
			}

			// Adding new actions must neither upgrade older tokens nor permit an
			// external-source token to address arbitrary document directories.
			owner.object("POST", "/api/v1/integrations/tokens", map[string]any{"name": "Incomplete write grant", "spaceId": shared, "actions": []string{"documents:write"}, "expiresAt": time.Now().UTC().Add(time.Hour)}, http.StatusBadRequest, "")
			docRead, _ := owner.token(shared, "", "documents:read")
			agent.tool(readToken, "documents_list", map[string]any{"spaceId": shared, "input": map[string]any{}}, "forbidden")
			agent.tool(docRead, "bookmarks_get", map[string]any{"spaceId": shared, "id": id}, "forbidden")
			agent.tool(docRead, "documents_list", map[string]any{"spaceId": personal, "input": map[string]any{}}, "not_found")
			agent.tool(docRead, "documents_list", map[string]any{"spaceId": shared, "input": map[string]any{"limit": 5}}, "")
			source := owner.source(shared, "External fixture")
			for _, action := range []string{"documents:read", "documents:write"} {
				owner.object("POST", "/api/v1/integrations/tokens", map[string]any{"name": "Invalid directory grant", "spaceId": shared, "sourceId": source["id"], "actions": []string{action}, "expiresAt": time.Now().UTC().Add(time.Hour)}, http.StatusBadRequest, "")
			}

			// Exercise the real new MCP schemas and file-backed handlers together.
			directory := owner.object("POST", base+"/document-sources", map[string]any{"name": "Agent files", "path": documentsPath, "readOnly": false, "defaultWrite": true, "defaultFolder": "inbox", "scanIntervalSeconds": 3600}, http.StatusCreated, "")
			docToken, _ := owner.token(shared, "", "documents:read", "documents:write", "navigation:read")
			doc := agent.tool(docToken, "documents_create", map[string]any{"spaceId": shared, "input": map[string]any{"sourceId": directory["id"], "relativePath": "agent.md", "content": "# Agent reference\n\nOriginal text.\n"}}, "")
			docID := doc["id"].(string)
			oldRevision := doc["revision"]
			if doc["published"] != false {
				t.Fatal("new agent-created document was published automatically")
			}
			readDocument := agent.tool(docRead, "documents_get", map[string]any{"spaceId": shared, "id": docID}, "")
			if readDocument["content"] != doc["content"] {
				t.Fatal("MCP document body differs from saved content")
			}
			agent.tool(docRead, "documents_update", map[string]any{"spaceId": shared, "id": docID, "input": map[string]any{"content": "denied", "expectedRevision": oldRevision}}, "forbidden")
			content := "# Agent reference\n\nUpdated through the scoped API.\n"
			doc = agent.tool(docToken, "documents_update", map[string]any{"spaceId": shared, "id": docID, "input": map[string]any{"content": content, "expectedRevision": oldRevision}}, "")
			agent.tool(docToken, "documents_update", map[string]any{"spaceId": shared, "id": docID, "input": map[string]any{"content": "stale overwrite", "expectedRevision": oldRevision}}, "document_version_conflict")
			metaInput := map[string]any{"tags": []string{"agent"}, "linkedBookmarkIds": []string{id}, "expectedRevision": doc["revision"], "expectedMetadataRevision": doc["metadataRevision"]}
			doc = agent.tool(docToken, "documents_metadata_update", map[string]any{"spaceId": shared, "id": docID, "input": metaInput}, "")
			if !reflect.DeepEqual(doc["linkedBookmarkIds"], []any{id}) {
				t.Fatal("MCP document relation was not saved")
			}
			agent.tool(docToken, "documents_metadata_update", map[string]any{"spaceId": shared, "id": docID, "input": metaInput}, "document_metadata_conflict")
			listedDocuments := agent.tool(docToken, "documents_list", map[string]any{"spaceId": shared, "input": map[string]any{"q": "Updated through", "linkedBookmarkId": id}}, "")
			if listedDocuments["total"] != float64(1) {
				t.Fatal("MCP full-text and bookmark filtering did not find the document")
			}
			privateLinks := agent.tool(docRead, "documents_list", map[string]any{"spaceId": shared, "input": map[string]any{}}, "")
			if len(privateLinks["items"].([]any)[0].(map[string]any)["linkedBookmarkIds"].([]any)) != 0 {
				t.Fatal("documents-only scope disclosed bookmark IDs")
			}
			doc = agent.tool(docToken, "documents_rename", map[string]any{"spaceId": shared, "id": docID, "input": map[string]any{"relativePath": "renamed/agent.md", "expectedRevision": doc["revision"]}}, "")
			if doc["id"] != docID || doc["relativePath"] != "renamed/agent.md" {
				t.Fatal("MCP rename changed stable identity")
			}
			body, err := os.ReadFile(filepath.Join(documentsPath, "renamed", "agent.md"))
			if err != nil || string(body) != content {
				t.Fatal("MCP mutations did not save the original file")
			}
			if _, err := os.Stat(filepath.Join(documentsPath, "agent.md")); !os.IsNotExist(err) {
				t.Fatal("rename retained the old path")
			}
			agent.tool(docToken, "documents_delete", map[string]any{"spaceId": shared, "id": docID, "input": map[string]any{"expectedRevision": doc["revision"]}}, "")
			if _, err := os.Stat(filepath.Join(documentsPath, "renamed", "agent.md")); !os.IsNotExist(err) {
				t.Fatal("MCP deletion did not remove the original path")
			}
			history := owner.object("GET", base+"/documents/"+docID+"/history", nil, http.StatusOK, "")
			if len(history["items"].([]any)) == 0 {
				t.Fatal("MCP deletion did not retain recovery content")
			}
			defaultContent := "# Default directory\n"
			defaultDocument := agent.tool(docToken, "documents_create", map[string]any{"spaceId": shared, "input": map[string]any{"relativePath": "default.md", "content": defaultContent}}, "")
			if defaultDocument["sourceId"] != directory["id"] || defaultDocument["relativePath"] != "inbox/default.md" {
				t.Fatal("MCP omitted source did not use the default directory and folder")
			}
			body, err = os.ReadFile(filepath.Join(documentsPath, "inbox", "default.md"))
			if err != nil || string(body) != defaultContent {
				t.Fatal("MCP default-directory creation did not save the expected original file")
			}
		})
	}
}
