package home

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func moduleTestSettingsBody(settings map[string]any, modules any) map[string]any {
	return map[string]any{"siteName": settings["siteName"], "mode": settings["mode"], "registrationEnabled": settings["registrationEnabled"], "modules": modules}
}

func moduleTestUpdate(t *testing.T, owner *coreBrowser, modules any) map[string]any {
	t.Helper()
	return owner.ok("PUT", "/settings", moduleTestSettingsBody(owner.ok("GET", "/settings", nil), modules))
}

func moduleTestDisabled(t *testing.T, body map[string]any, module string) {
	t.Helper()
	if body["code"] != "module_disabled" || integrationObject(t, body["details"])["module"] != module {
		t.Fatalf("expected disabled %s module: %v", module, body)
	}
}

func TestModuleSettingsOwnerControl(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Modules", "mode": ModeOpenEdit, "username": "owner", "password": "module fixture password", "seedDemo": false})
			boot := owner.bootstrap()
			if !reflect.DeepEqual(boot["modules"], map[string]any{"documents": true, "work": true}) {
				t.Fatalf("modules must default enabled: %v", boot["modules"])
			}
			settings := owner.ok("GET", "/settings", nil)
			visitor := newCoreBrowser(t, server.URL)
			visitor.bootstrap()
			statusWant(t, visitor, http.StatusUnauthorized, "PUT", "/settings", moduleTestSettingsBody(settings, map[string]any{"documents": false}))
			for _, value := range []any{nil, true, "off", []any{}, map[string]any{"documents": nil}, map[string]any{"work": "false"}, map[string]any{"unknown": true}} {
				statusWant(t, owner, http.StatusBadRequest, "PUT", "/settings", moduleTestSettingsBody(settings, value))
			}
			before, err := app.loadSettings(context.Background(), app.store.DB)
			if err != nil {
				t.Fatal(err)
			}
			changed := moduleTestUpdate(t, owner, map[string]any{"documents": false})
			if !reflect.DeepEqual(changed["modules"], map[string]any{"documents": false, "work": true}) {
				t.Fatal("partial module update changed the omitted module")
			}
			omitted := moduleTestSettingsBody(settings, nil)
			delete(omitted, "modules")
			if got := owner.ok("PUT", "/settings", omitted); !reflect.DeepEqual(got["modules"], changed["modules"]) {
				t.Fatal("legacy settings update reset module switches")
			}
			after, err := app.loadSettings(context.Background(), app.store.DB)
			if err != nil || before.AuthEpoch != after.AuthEpoch {
				t.Fatalf("module settings invalidated credentials: %v", err)
			}
			if got := visitor.bootstrap()["modules"]; !reflect.DeepEqual(got, changed["modules"]) {
				t.Fatal("public bootstrap did not reflect module settings")
			}
			api := &integrationTestBrowser{t: t, base: server.URL, client: owner.client, csrf: owner.csrf}
			token, _ := api.token(coreSpace(boot, "shared"), "", "navigation:read", "work:read", "work:write")
			api.call("PUT", "/api/v1/settings", moduleTestSettingsBody(settings, map[string]any{"work": false}), http.StatusForbidden, token)
			moduleTestUpdate(t, owner, map[string]any{"documents": true})
			api.tool(token, "work_items_list", map[string]any{}, "")

			// A signed-in Member also cannot change instance-wide modules.
			owner.ok("PUT", "/settings", map[string]any{"siteName": "Modules", "mode": ModePrivateMulti, "registrationEnabled": false})
			owner.bootstrap()
			owner.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": "module fixture password"})
			owner.bootstrap()
			owner.ok("POST", "/admin/users", map[string]any{"username": "member", "password": "member module password", "displayName": "Member"})
			member := newCoreBrowser(t, server.URL)
			member.bootstrap()
			member.ok("POST", "/auth/login", map[string]any{"username": "member", "password": "member module password"})
			member.bootstrap()
			statusWant(t, member, http.StatusForbidden, "PUT", "/settings", map[string]any{"siteName": "Modules", "mode": ModePrivateMulti, "registrationEnabled": false, "modules": map[string]any{"work": false}})
		})
	}
}

func TestModuleBoundariesPreserveDataAndNavigation(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			f.app.config.DocumentRoots = []string{t.TempDir()}
			docs := &documentFixture{app: f.app, owner: f.owner, root: f.app.config.DocumentRoots[0], shared: f.space, personal: f.personal}
			source := docs.source(t, f.space, "notes", false, map[string]string{"guide.md": "# Retained guide\nOriginal body\n"})
			doc := documentByPath(t, f.owner, f.space, "guide.md")
			docPath := documentURL(f.space, doc)
			f.owner.ok("POST", docPath+"/publish", map[string]any{"expectedRevision": doc["revision"], "expectedMetadataRevision": doc["metadataRevision"]})
			link := f.owner.ok("POST", "/spaces/"+f.space+"/links", coreLink("Retained bookmark", "https://example.com/modules"))
			item := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Retained work", "documentIds": []any{doc["id"]}, "bookmarkIds": []any{link["id"]}})
			page := integrationObject(t, f.owner.ok("GET", "/dashboard?spaceId="+f.space, nil)["page"])
			f.owner.ok("PUT", "/spaces/"+f.space+"/page", map[string]any{"name": "Modules dashboard", "expectedRevision": page["revision"], "config": activityCompositionConfig(t)})
			api := &integrationTestBrowser{t: t, base: f.owner.base, client: f.owner.client, csrf: f.owner.csrf}
			agent := integrationBrowser(t, f.owner.base)
			full, _ := api.token(f.space, "", "navigation:read", "navigation:write", "pages:read", "documents:read", "documents:write", "work:read", "work:write")
			read, _ := api.token(f.space, "", "work:read")
			catalogBefore, _ := agent.mcp(full, "tools/list", map[string]any{}, http.StatusOK)
			moduleTestUpdate(t, f.owner, map[string]any{"work": false})
			for _, path := range []string{"/board", "/items", "/projects", "/statuses", "/revision"} {
				moduleTestDisabled(t, statusWant(t, f.owner, http.StatusForbidden, "GET", f.base+path, nil), "work")
			}
			moduleTestDisabled(t, statusWant(t, f.owner, http.StatusForbidden, "POST", f.base+"/items", map[string]any{"id": newID(), "title": "Must not create"}), "work")
			moduleTestDisabled(t, agent.tool(full, "work_items_get", map[string]any{"id": item["id"]}, "module_disabled"), "work")
			// Missing write permission retains its existing error before module state.
			agent.tool(read, "work_items_create", map[string]any{"input": map[string]any{"id": newID(), "title": "Forbidden"}}, "forbidden")
			visitor := newCoreBrowser(t, f.owner.base)
			visitor.bootstrap()
			statusWant(t, visitor, http.StatusUnauthorized, "GET", f.base+"/board", nil)
			f.owner.ok("GET", docPath, nil)
			moduleTestUpdate(t, f.owner, map[string]any{"work": true, "documents": false})
			for _, path := range []string{"/documents", "/document-sources", "/document-activity", "/documents/" + doc["id"].(string), "/documents/" + doc["id"].(string) + "/history", "/documents/" + doc["id"].(string) + "/asset?path=asset.png"} {
				moduleTestDisabled(t, statusWant(t, f.owner, http.StatusForbidden, "GET", "/spaces/"+f.space+path, nil), "documents")
			}
			for _, mutation := range []struct {
				method, path string
				body         any
			}{
				{"POST", "/spaces/" + f.space + "/documents", map[string]any{"relativePath": "new.md", "content": "No write"}},
				{"PUT", docPath, map[string]any{"expectedRevision": doc["revision"], "content": "No write"}},
				{"DELETE", docPath, map[string]any{"expectedRevision": doc["revision"]}},
				{"POST", docPath + "/publish", map[string]any{"expectedRevision": doc["revision"]}},
				{"POST", "/spaces/" + f.space + "/document-sources/" + source["id"].(string) + "/scan", nil},
			} {
				moduleTestDisabled(t, statusWant(t, f.owner, http.StatusForbidden, mutation.method, mutation.path, mutation.body), "documents")
			}
			moduleTestDisabled(t, statusWant(t, visitor, http.StatusForbidden, "GET", docPath, nil), "documents")
			moduleTestDisabled(t, agent.tool(full, "documents_list", map[string]any{}, "module_disabled"), "documents")
			moduleTestDisabled(t, agent.tool(full, "documents_update", map[string]any{"id": doc["id"], "input": map[string]any{"expectedRevision": doc["revision"], "content": "No MCP write"}}, "module_disabled"), "documents")
			moduleTestDisabled(t, statusWant(t, f.owner, http.StatusForbidden, "GET", f.base+"/resources?kind=document", nil), "documents")
			itemPath := workItemPath(f.space, item["id"].(string))
			visible := f.owner.ok("GET", itemPath, nil)
			if len(visible["documentIds"].([]any)) != 0 || visible["referenceCount"] != float64(1) {
				t.Fatal("disabled document references were exposed")
			}
			moduleTestDisabled(t, statusWant(t, f.owner, http.StatusForbidden, "PATCH", itemPath, map[string]any{"expectedRevision": visible["revision"], "documentIds": []any{}}), "documents")
			f.owner.ok("PATCH", itemPath, map[string]any{"expectedRevision": visible["revision"], "nextStep": "Preserve hidden document relation"})
			f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Work without document references remains available"})
			f.owner.ok("GET", f.base+"/resources?kind=bookmark", nil)
			agent.tool(full, "navigation_get", map[string]any{}, "")
			link = f.owner.ok("PUT", "/spaces/"+f.space+"/links/"+link["id"].(string)+"/context", map[string]any{"contextMarkdown": "Navigation notes remain available", "expectedUpdatedAt": link["updatedAt"]})
			if link["contextMarkdown"] != "Navigation notes remain available" {
				t.Fatal("document module disabled bookmark notes")
			}
			dashboard := f.owner.ok("GET", "/dashboard?spaceId="+f.space, nil)
			marker := integrationObject(t, integrationObject(t, dashboard["datasets"])["writing"])
			if integrationObject(t, marker["data"])["moduleDisabled"] != true {
				t.Fatal("dashboard lost disabled activity marker")
			}
			sources, err := f.app.enabledDocumentSources(context.Background())
			if err != nil || len(sources) != 0 {
				t.Fatalf("disabled document scanner remained active: %v", err)
			}
			if _, applied := f.app.scanDocumentInBackground(context.Background(), &DocumentSource{ID: source["id"].(string)}); applied {
				t.Fatal("disabled module allowed a background scan")
			}
			var refs int
			if err = f.app.store.DB.QueryRow(f.app.store.Query("SELECT COUNT(*) FROM work_item_documents WHERE item_id=?"), item["id"]).Scan(&refs); err != nil || refs != 1 {
				t.Fatalf("toggle removed document relation: %v", err)
			}
			body, err := os.ReadFile(filepath.Join(docs.root, "notes", "guide.md"))
			if err != nil || string(body) != "# Retained guide\nOriginal body\n" {
				t.Fatalf("toggle or blocked write changed original file: %v", err)
			}
			catalogAfter, _ := agent.mcp(full, "tools/list", map[string]any{}, http.StatusOK)
			if !reflect.DeepEqual(integrationObject(t, catalogBefore["result"])["tools"], integrationObject(t, catalogAfter["result"])["tools"]) {
				t.Fatal("module switch changed tool schemas")
			}
			moduleTestUpdate(t, f.owner, map[string]any{"documents": true})
			if restored := f.owner.ok("GET", itemPath, nil); len(restored["documentIds"].([]any)) != 1 {
				t.Fatal("re-enabling did not restore existing reference visibility")
			}
			agent.tool(full, "documents_get", map[string]any{"id": doc["id"]}, "")
		})
	}
}
