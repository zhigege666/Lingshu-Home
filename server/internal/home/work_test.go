package home

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func workItemPath(space, id string) string { return "/spaces/" + space + "/work/items/" + id }
func workIDsFromPage(value map[string]any) []string {
	ids := []string{}
	for _, raw := range value["items"].([]any) {
		ids = append(ids, raw.(map[string]any)["id"].(string))
	}
	return ids
}
func TestWorkBoardHTTPAndMCP(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Work fixture", "mode": ModePublicRead, "username": "owner", "password": "work fixture password", "seedDemo": false})
			boot := owner.bootstrap()
			space, personal := coreSpace(boot, "shared"), coreSpace(boot, "personal")
			base := "/spaces/" + space + "/work"
			anonymous := newCoreBrowser(t, server.URL)
			anonymous.bootstrap()
			statusWant(t, anonymous, 401, "GET", base+"/board", nil)
			statusWant(t, anonymous, 401, "POST", base+"/items", map[string]any{"id": newID(), "title": "Anonymous"})
			projectBody := map[string]any{"id": newID(), "name": "Home"}
			project := owner.ok("POST", base+"/projects", projectBody)
			replayProject := owner.ok("POST", base+"/projects", projectBody)
			if project["id"] != replayProject["id"] {
				t.Fatal("project replay duplicated")
			}
			statusWant(t, owner, 409, "POST", base+"/projects", map[string]any{"id": newID(), "name": " home "})
			link := owner.ok("POST", "/spaces/"+space+"/links", coreLink("Reference title", "https://example.com/work"))
			foreign := owner.ok("POST", "/spaces/"+personal+"/links", coreLink("Private canary", "https://private.example/work"))
			app.config.DocumentRoots = []string{t.TempDir()}
			fixture := &documentFixture{app: app, server: server, owner: owner, root: app.config.DocumentRoots[0], shared: space, personal: personal}
			fixture.source(t, space, "notes", false, map[string]string{"guide.md": "# Reference guide\nBody canary must never be embedded in board\n"})
			document := documentByPath(t, owner, space, "guide.md")
			body := map[string]any{"id": newID(), "title": "Visible alpha", "projectId": project["id"], "description": "private description needle", "nextStep": "Verify result", "result": "result canary", "needsAttention": true, "bookmarkIds": []string{link["id"].(string)}, "documentIds": []string{document["id"].(string)}}
			first := owner.ok("POST", base+"/items", body)
			id := first["id"].(string)
			if first["referenceCount"] != float64(2) || len(first["references"].([]any)) != 2 {
				t.Fatal("references missing")
			}
			replay := owner.ok("POST", base+"/items", body)
			if first["revision"] != replay["revision"] || first["boardRevision"] != replay["boardRevision"] {
				t.Fatal("create replay mutated state")
			}
			changed := map[string]any{"id": id, "title": "Different payload"}
			statusWant(t, owner, 409, "POST", base+"/items", changed)
			statusWant(t, owner, 404, "POST", base+"/items", map[string]any{"id": newID(), "title": "Foreign reference", "bookmarkIds": []string{foreign["id"].(string)}})
			board := owner.ok("GET", base+"/board", nil)
			encoded, _ := json.Marshal(board)
			if strings.Contains(string(encoded), "private description") || strings.Contains(string(encoded), "result canary") || strings.Contains(string(encoded), "Body canary") {
				t.Fatal("board summary included details")
			}
			if columns := board["columns"].([]any); len(columns) != 4 || columns[0].(map[string]any)["status"] != "todo" {
				t.Fatal("missing stable four columns")
			}
			page := owner.ok("GET", base+"/items?attention=true&q=needle", nil)
			if page["total"] != float64(1) {
				t.Fatal("attention/search filter failed")
			}
			resources := owner.ok("GET", base+"/resources?kind=document&q=guide&limit=1", nil)
			if len(resources["items"].([]any)) != 1 {
				t.Fatal("resource picker missing document")
			}
			resourceBytes, _ := json.Marshal(resources)
			if strings.Contains(string(resourceBytes), "Body canary") || strings.Contains(string(resourceBytes), fixture.root) {
				t.Fatal("picker leaked body or mount")
			}
			// The same item revision can win only once across concurrent browser edits.
			var wait sync.WaitGroup
			codes := make(chan int, 2)
			for _, title := range []string{"Concurrent one", "Concurrent two"} {
				wait.Add(1)
				go func(title string) {
					defer wait.Done()
					code, _ := owner.call("PATCH", workItemPath(space, id), map[string]any{"expectedRevision": first["revision"], "title": title})
					codes <- code
				}(title)
			}
			wait.Wait()
			close(codes)
			counts := map[int]int{}
			for code := range codes {
				counts[code]++
			}
			if counts[200] != 1 || counts[409] != 1 {
				t.Fatalf("concurrent writes: %v", counts)
			}
			first = owner.ok("GET", workItemPath(space, id), nil)
			beforeRevision := first["boardRevision"]
			statusWant(t, owner, 404, "PATCH", workItemPath(space, id), map[string]any{"expectedRevision": first["revision"], "title": "Must roll back", "bookmarkIds": []string{foreign["id"].(string)}})
			first = owner.ok("GET", workItemPath(space, id), nil)
			if first["title"] == "Must roll back" || first["boardRevision"] != beforeRevision {
				t.Fatal("failed patch partially committed")
			}
			statusWant(t, owner, 400, "PATCH", workItemPath(space, id), map[string]any{"expectedRevision": first["revision"], "archived": nil})
			// Source filtering must not lose hidden siblings or confuse column tail with loaded tail.
			hidden := owner.ok("POST", base+"/items", map[string]any{"id": newID(), "title": "Hidden sibling"})
			tail := owner.ok("POST", base+"/items", map[string]any{"id": newID(), "title": "Visible omega"})
			first = owner.ok("PATCH", workItemPath(space, id), map[string]any{"expectedRevision": first["revision"], "title": "Visible alpha"})
			firstPage := owner.ok("GET", base+"/items?status=todo&limit=1", nil)
			cursor := firstPage["nextCursor"].(string)
			next := owner.ok("GET", base+"/items?status=todo&limit=1&cursor="+url.QueryEscape(cursor), nil)
			if workIDsFromPage(firstPage)[0] == workIDsFromPage(next)[0] {
				t.Fatal("cursor duplicated item")
			}
			statusWant(t, owner, 400, "GET", base+"/items?status=doing&cursor="+url.QueryEscape(cursor), nil)
			board = owner.ok("GET", base+"/board?q=Visible&limit=1", nil)
			first = owner.ok("POST", workItemPath(space, id)+"/move", map[string]any{"expectedRevision": first["revision"], "expectedBoardRevision": board["revision"], "status": "todo", "beforeId": nil})
			order := workIDsFromPage(owner.ok("GET", base+"/items?status=todo", nil))
			if !reflect.DeepEqual(order, []string{hidden["id"].(string), tail["id"].(string), id}) {
				t.Fatalf("filtered append lost true tail: %v", order)
			}
			statusWant(t, owner, 409, "GET", base+"/items?status=todo&limit=1&cursor="+url.QueryEscape(cursor), nil)
			first = owner.ok("POST", workItemPath(space, id)+"/move", map[string]any{"expectedRevision": first["revision"], "expectedBoardRevision": first["boardRevision"], "status": "todo", "beforeId": tail["id"]})
			order = workIDsFromPage(owner.ok("GET", base+"/items?status=todo", nil))
			if !reflect.DeepEqual(order, []string{hidden["id"].(string), id, tail["id"].(string)}) {
				t.Fatal("anchor move damaged hidden order")
			}
			// Force adjacent ranks, exercising the bounded column rebalance branch.
			_, err := app.store.DB.Exec(app.store.Query("UPDATE work_items SET sort_order=? WHERE id=?"), int64(1), hidden["id"])
			if err != nil {
				t.Fatal(err)
			}
			first = owner.ok("POST", workItemPath(space, id)+"/move", map[string]any{"expectedRevision": first["revision"], "expectedBoardRevision": first["boardRevision"], "status": "todo", "beforeId": hidden["id"]})
			order = workIDsFromPage(owner.ok("GET", base+"/items?status=todo", nil))
			if order[0] != id {
				t.Fatal("rank rebalance misplaced card")
			}
			// Explicit business completion and attention remain independent.
			first = owner.ok("PATCH", workItemPath(space, id), map[string]any{"expectedRevision": first["revision"], "status": "done", "result": ""})
			if first["needsAttention"] != true || first["result"] != "" {
				t.Fatal("status inferred attention or forced a result")
			}
			first = owner.ok("PATCH", workItemPath(space, id), map[string]any{"expectedRevision": first["revision"], "archived": true})
			if owner.ok("GET", base+"/items?archived=true", nil)["total"] != float64(1) {
				t.Fatal("archive missing")
			}
			first = owner.ok("PATCH", workItemPath(space, id), map[string]any{"expectedRevision": first["revision"], "archived": false})
			project = owner.ok("PATCH", base+"/projects/"+project["id"].(string), map[string]any{"expectedRevision": project["revision"], "archived": true})
			if owner.ok("GET", workItemPath(space, id), nil)["archived"] != false {
				t.Fatal("project archive cascaded to item")
			}
			statusWant(t, owner, 409, "POST", base+"/items", map[string]any{"id": newID(), "title": "Archived target", "projectId": project["id"]})
			project = owner.ok("PATCH", base+"/projects/"+project["id"].(string), map[string]any{"expectedRevision": project["revision"], "archived": false, "name": "Home renamed"})
			if owner.ok("GET", workItemPath(space, id), nil)["projectName"] != "Home renamed" {
				t.Fatal("rename did not reach view")
			}
			// MCP and bearer HTTP keep action scopes separate from content permission.
			auth := &integrationTestBrowser{t: t, base: server.URL, client: owner.client, csrf: owner.csrf}
			caller := integrationBrowser(t, server.URL)
			read, _ := auth.token(space, "", "work:read")
			write, writeTokenID := auth.token(space, "", "work:write")
			both, _ := auth.token(space, "", "work:read", "work:write", "navigation:read", "documents:read")
			old, _ := auth.token(space, "", "navigation:read", "documents:read")
			caller.tool(old, "work_board_get", map[string]any{}, "forbidden")
			caller.tool(read, "work_items_update", map[string]any{"id": id, "input": map[string]any{"expectedRevision": first["revision"], "title": "No write"}}, "forbidden")
			weakDetail := caller.tool(read, "work_items_get", map[string]any{"id": id}, "")
			if len(weakDetail["bookmarkIds"].([]any)) != 0 || len(weakDetail["documentIds"].([]any)) != 0 || len(weakDetail["references"].([]any)) != 0 || weakDetail["referenceCount"] != float64(0) {
				t.Fatal("missing content scope exposed references")
			}
			caller.tool(read, "work_resources_search", map[string]any{"input": map[string]any{"kind": "document"}}, "forbidden")
			writeBody := map[string]any{"id": newID(), "title": "Write-only private canary"}
			receipt := caller.tool(write, "work_items_create", map[string]any{"input": writeBody}, "")
			if receipt["id"] != writeBody["id"] || receipt["title"] != nil || receipt["references"] != nil || len(receipt) != 4 {
				t.Fatalf("write-only receipt leaked fields: %v", receipt)
			}
			receipt2 := caller.tool(write, "work_items_create", map[string]any{"input": writeBody}, "")
			if receipt2["id"] != receipt["id"] || receipt2["replayed"] != true {
				t.Fatal("MCP replay not stable")
			}
			caller.tool(write, "work_items_create", map[string]any{"input": map[string]any{"id": newID(), "title": "No content read", "bookmarkIds": []string{link["id"].(string)}}}, "forbidden")
			// A write-only caller can remove or preserve references without reading them.
			removed := caller.tool(write, "work_items_update", map[string]any{"id": id, "input": map[string]any{"expectedRevision": first["revision"], "bookmarkIds": []string{}, "documentIds": []string{}}}, "")
			if removed["title"] != nil {
				t.Fatal("write-only update leaked fields")
			}
			first = owner.ok("GET", workItemPath(space, id), nil)
			if len(first["references"].([]any)) != 0 {
				t.Fatal("clear did not work")
			}
			caller.tool(both, "work_items_update", map[string]any{"id": id, "input": map[string]any{"expectedRevision": first["revision"], "bookmarkIds": []string{link["id"].(string)}, "documentIds": []string{document["id"].(string)}}}, "")
			// Emulate a legacy/malformed source-scoped token; handler must reject it too.
			source := auth.object("POST", "/api/v1/spaces/"+space+"/sources", map[string]any{"name": "Work scope fixture", "kind": "external-push", "schemaId": "navigation.collection", "schemaVersion": 1, "connection": map[string]string{}, "sync": map[string]any{"mode": "push", "staleAfterSeconds": 3600}, "enabled": true}, 201, "")
			_, err = app.store.DB.Exec(app.store.Query("UPDATE integration_tokens SET source_id=? WHERE id=?"), source["id"], writeTokenID)
			if err != nil {
				t.Fatal(err)
			}
			caller.tool(write, "work_items_create", map[string]any{"input": map[string]any{"id": newID(), "title": "Scoped"}}, "forbidden")
			// CSRF remains required for browser work writes.
			reply := accountProfileRawCall(t, owner.client, server.URL, "POST", base+"/items", map[string]any{"id": newID(), "title": "Bad CSRF"}, "", "")
			if reply.status != 403 {
				t.Fatalf("missing CSRF status=%d", reply.status)
			}
			// Same-space resources stay intact after item archive/restore.
			if _, err = os.Stat(filepath.Join(fixture.root, "notes", "guide.md")); err != nil {
				t.Fatal("work altered original Markdown")
			}
			original, err := os.ReadFile(filepath.Join(fixture.root, "notes", "guide.md"))
			if err != nil || !strings.Contains(string(original), "Body canary") {
				t.Fatal("original document changed")
			}
			nav := owner.ok("GET", "/spaces/"+space+"/navigation", nil)
			if len(nav["data"].(map[string]any)["links"].([]any)) != 1 {
				t.Fatal("work altered navigation")
			}
			owner.ok("PUT", "/settings", map[string]any{"siteName": "Work private users", "mode": ModePrivateMulti, "registrationEnabled": false})
			owner.bootstrap()
			owner.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": "work fixture password"})
			owner.bootstrap()
			owner.ok("POST", "/admin/users", map[string]any{"username": "member", "password": "member work fixture password", "displayName": "Member"})
			member := newCoreBrowser(t, server.URL)
			member.bootstrap()
			member.ok("POST", "/auth/login", map[string]any{"username": "member", "password": "member work fixture password"})
			memberBoot := member.bootstrap()
			memberSpace := coreSpace(memberBoot, "personal")
			statusWant(t, member, 403, "GET", base+"/board", nil)
			statusWant(t, member, 404, "GET", "/spaces/"+personal+"/work/board", nil)
			own := member.ok("POST", "/spaces/"+memberSpace+"/work/items", map[string]any{"id": newID(), "title": "Member private"})
			statusWant(t, owner, 404, "GET", workItemPath(memberSpace, own["id"].(string)), nil)
			// Anonymous open-edit remains public navigation only, not private work.
			owner.ok("PUT", "/settings", map[string]any{"siteName": "Open navigation", "mode": ModeOpenEdit, "registrationEnabled": false})
			anonymous.bootstrap()
			statusWant(t, anonymous, 401, "GET", base+"/board", nil)
			if err = app.store.DB.PingContext(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
	}
}
