package home

import (
	"reflect"
	"strconv"
	"testing"
)

func TestNavigationBatchCreateAtomic(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			_, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Create fixture", "mode": ModePrivateMulti, "username": "owner", "password": "navigation create fixture password", "seedDemo": false})
			boot := owner.bootstrap()
			space, personal := coreSpace(boot, "shared"), coreSpace(boot, "personal")
			path := "/spaces/" + space + "/navigation/batch-edit"
			read := func() map[string]any { return owner.ok("GET", "/spaces/"+space+"/navigation", nil) }
			start := read()["revision"].(string)
			parent, child, link := newID(), newID(), newID()
			body := map[string]any{"expectedRevision": start, "createCategories": []any{map[string]any{"id": parent, "name": "Folder"}, map[string]any{"id": child, "name": "Nested", "parentId": parent}}, "createLinks": []any{map[string]any{"id": link, "categoryId": child, "url": "https://example.invalid/new", "title": "New bookmark", "sortOrder": 22}}, "moves": []any{map[string]any{"kind": "link", "id": link, "beforeId": nil, "categoryId": parent}}}
			auth := &integrationTestBrowser{t: t, base: server.URL, client: owner.client, csrf: owner.csrf}
			caller := integrationBrowser(t, server.URL)
			reader, _ := auth.token(space, "", "navigation:read")
			writer, _ := auth.token(space, "", "navigation:write")
			caller.tool(reader, "navigation_batch_edit", map[string]any{"input": body}, "forbidden")
			result := owner.ok("POST", path, body)
			n, _ := strconv.Atoi(start)
			if result["revision"] != strconv.Itoa(n+1) || result["updatedCount"] != float64(3) || len(result["categories"].([]any)) != 2 || len(result["links"].([]any)) != 1 {
				t.Fatalf("bad receipt: %v", result)
			}
			saved := result["links"].([]any)[0].(map[string]any)
			if saved["id"] != link || saved["categoryId"] != parent {
				t.Fatalf("new link did not use final move: %v", saved)
			}
			if code, _ := owner.call("POST", path, body); code != 409 {
				t.Fatalf("old revision reaccepted: %d", code)
			}
			before := read()
			rev := before["revision"]
			foreign := owner.ok("POST", "/spaces/"+personal+"/categories", map[string]any{"name": "Private"})["id"]
			for _, bad := range []map[string]any{
				{"createLinks": []any{map[string]any{"id": link, "title": "Replace", "url": "https://example.invalid/replace"}}},
				{"createLinks": []any{map[string]any{"id": newID(), "title": "Wrong scope", "url": "https://example.invalid/foreign", "categoryId": foreign}}},
				{"createLinks": []any{map[string]any{"id": "not-an-id", "title": "Bad ID", "url": "https://example.invalid/bad"}}},
				{"moves": []any{map[string]any{"kind": "link", "id": link, "beforeId": foreign, "categoryId": parent}}},
			} {
				bad["createCategories"] = []any{map[string]any{"id": newID(), "name": "Rollback"}}
				bad["expectedRevision"] = rev
				code, _ := owner.call("POST", path, bad)
				if code < 400 || code >= 500 {
					t.Fatalf("unexpected reject status %d", code)
				}
				if actual := read(); actual["revision"] != rev || !reflect.DeepEqual(before["data"], actual["data"]) {
					t.Fatal("failed batch left a partial create or move")
				}
			}
			receipt := caller.tool(writer, "navigation_batch_edit", map[string]any{"input": map[string]any{"expectedRevision": rev, "createLinks": []any{map[string]any{"id": newID(), "title": "Write only", "url": "https://example.invalid/push"}}}}, "")
			if len(receipt) != 2 || receipt["updatedCount"] != float64(1) {
				t.Fatalf("unexpected write-only receipt: %v", receipt)
			}
		})
	}
}
