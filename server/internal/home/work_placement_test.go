package home

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"reflect"
	"sync"
	"testing"
)

func workPlacementRank(t *testing.T, f *workStatusFixture, id string) int64 {
	t.Helper()
	var rank int64
	if err := f.app.store.DB.QueryRow(f.app.store.Query("SELECT sort_order FROM work_items WHERE id=?"), id).Scan(&rank); err != nil {
		t.Fatal(err)
	}
	return rank
}

func workPlacementBoardIDs(t *testing.T, board map[string]any) []string {
	t.Helper()
	ids := []string{}
	for _, raw := range board["columns"].([]any) {
		ids = append(ids, workIDsFromPage(raw.(map[string]any))...)
	}
	return ids
}

func TestWorkCreationPlacementOrder(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			project := f.owner.ok("POST", f.base+"/projects", map[string]any{"id": newID(), "name": "First-page project"})
			other := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Empty column", "status": "doing", "placement": "start"})
			archived := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Archived sibling"})
			f.owner.ok("PATCH", workItemPath(f.space, archived["id"].(string)), map[string]any{"expectedRevision": archived["revision"], "archived": true})
			otherRank, archivedRank := workPlacementRank(t, f, other["id"].(string)), workPlacementRank(t, f, archived["id"].(string))
			original := []string{}
			for i := 0; i < 31; i++ {
				body := map[string]any{"id": newID(), "title": fmt.Sprintf("Existing %02d", i)}
				if i%2 == 0 {
					body["projectId"] = project["id"]
				}
				item := f.owner.ok("POST", f.base+"/items", body)
				original = append(original, item["id"].(string))
			}
			// Preserve the existing tail default, including an explicit end choice.
			for _, placement := range []string{"", "end"} {
				body := map[string]any{"id": newID(), "title": "Tail " + placement}
				if placement != "" {
					body["placement"] = placement
				}
				original = append(original, f.owner.ok("POST", f.base+"/items", body)["id"].(string))
			}
			// Exercise first-position rebalance with hidden and unloaded siblings.
			if _, err := f.app.store.DB.Exec(f.app.store.Query("UPDATE work_items SET sort_order=1 WHERE id=?"), original[0]); err != nil {
				t.Fatal(err)
			}
			front := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Created at start", "projectId": project["id"], "placement": "start"})
			want := append([]string{front["id"].(string)}, original...)
			if got := workIDsFromPage(f.owner.ok("GET", f.base+"/items?status=todo&limit=100", nil)); !reflect.DeepEqual(got, want) {
				t.Fatalf("creation changed sibling order: %v want %v", got, want)
			}
			board := f.owner.ok("GET", f.base+"/board?projectId="+project["id"].(string)+"&limit=1", nil)
			if got := workPlacementBoardIDs(t, board); !reflect.DeepEqual(got, []string{front["id"].(string)}) {
				t.Fatalf("new item is not on the filtered first page: %v", got)
			}
			if workPlacementRank(t, f, other["id"].(string)) != otherRank || workPlacementRank(t, f, archived["id"].(string)) != archivedRank {
				t.Fatal("first-position creation changed another status or archive ordering")
			}
			for _, value := range []any{"", "middle", "START", nil, true, float64(1)} {
				statusWant(t, f.owner, 400, "POST", f.base+"/items", map[string]any{"id": newID(), "title": "Invalid placement", "placement": value})
			}
			statusWant(t, f.owner, 400, "PATCH", workItemPath(f.space, front["id"].(string)), map[string]any{"expectedRevision": front["revision"], "title": "Must not save", "placement": "start"})
			current := f.owner.ok("GET", workItemPath(f.space, front["id"].(string)), nil)
			if current["title"] != front["title"] || current["revision"] != front["revision"] || current["boardRevision"] != front["boardRevision"] {
				t.Fatal("rejected placement partially changed work")
			}
		})
	}
}

func TestWorkCreationPlacementReplay(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			bodies := []map[string]any{}
			for _, version := range []int{1, 2} {
				id, title := newID(), fmt.Sprintf("Historical v%d create", version)
				body := map[string]any{"id": id, "title": title}
				f.owner.ok("POST", f.base+"/items", body)
				status := ""
				if version == 1 {
					status = "todo"
				}
				// Frozen pre-placement wire shape, independent of workCreateInput.
				canonical := fmt.Sprintf(`{"id":%q,"title":%q,"projectId":null,"status":%q,"description":"","nextStep":"","result":"","needsAttention":false,"bookmarkIds":[],"documentIds":[]}`, id, title, status)
				hash := fmt.Sprintf("%x", sha256.Sum256([]byte(canonical)))
				if _, err := f.app.store.DB.Exec(f.app.store.Query("UPDATE work_items SET create_hash=?,create_hash_version=? WHERE id=?"), hash, version, id); err != nil {
					t.Fatal(err)
				}
				// Explicit end is equivalent to the historical omitted position.
				body["placement"] = "end"
				f.owner.ok("POST", f.base+"/items", body)
				bodies = append(bodies, body)
			}
			explicit := map[string]any{"id": newID(), "title": "Explicit start state", "status": "todo", "placement": "start"}
			item := f.owner.ok("POST", f.base+"/items", explicit)
			item = f.owner.ok("POST", workItemPath(f.space, item["id"].(string))+"/move", map[string]any{"expectedRevision": item["revision"], "expectedBoardRevision": item["boardRevision"], "status": "doing", "beforeId": nil})
			f.owner.ok("PATCH", workItemPath(f.space, item["id"].(string)), map[string]any{"expectedRevision": item["revision"], "archived": true})
			omitted := map[string]any{"id": newID(), "title": "Omitted start state", "placement": "start"}
			f.owner.ok("POST", f.base+"/items", omitted)
			bodies = append(bodies, explicit, omitted)
			catalog := workStatusTestCatalog(t, f.owner.ok("GET", f.base+"/statuses", nil))
			f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog.Revision, "defaultStatus": "doing", "deletions": []map[string]any{{"id": "todo", "moveToStatus": "waiting"}}})
			columns := []string{"id", "sort_order", "status", "archived", "revision", "create_hash", "create_hash_version"}
			before := workStatusTestRows(t, f.app.store.DB, "work_items", columns)
			revision := f.owner.ok("GET", f.base+"/revision", nil)
			for _, body := range bodies {
				current := f.owner.ok("GET", workItemPath(f.space, body["id"].(string)), nil)
				replay := f.owner.ok("POST", f.base+"/items", body)
				if !reflect.DeepEqual(current, replay) {
					t.Fatal("replay failed to return the current moved/archived/retired-state item")
				}
			}
			if !reflect.DeepEqual(before, workStatusTestRows(t, f.app.store.DB, "work_items", columns)) || !reflect.DeepEqual(revision, f.owner.ok("GET", f.base+"/revision", nil)) {
				t.Fatal("create replay repositioned or modified existing work")
			}
			statusWant(t, f.owner, 409, "POST", f.base+"/items", map[string]any{"id": omitted["id"], "title": omitted["title"], "placement": "end"})
			statusWant(t, f.owner, 409, "POST", f.base+"/items", map[string]any{"id": bodies[1]["id"], "title": bodies[1]["title"], "placement": "start"})
		})
	}
}

func TestWorkCreationPlacementConcurrent(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			tail := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Existing tail"})
			first := map[string]any{"id": newID(), "title": "Concurrent first", "placement": "start"}
			second := map[string]any{"id": newID(), "title": "Concurrent second", "placement": "start"}
			var wait sync.WaitGroup
			start, codes := make(chan struct{}), make(chan int, 3)
			for _, body := range []map[string]any{first, second, first} {
				wait.Add(1)
				go func(body map[string]any) {
					defer wait.Done()
					<-start
					code, _ := f.owner.call("POST", f.base+"/items", body)
					codes <- code
				}(body)
			}
			close(start)
			wait.Wait()
			close(codes)
			for code := range codes {
				if code != 200 {
					t.Fatalf("concurrent create/replay returned %d", code)
				}
			}
			ids := workIDsFromPage(f.owner.ok("GET", f.base+"/items?status=todo", nil))
			if len(ids) != 3 || ids[2] != tail["id"] || ids[0] == ids[1] || (ids[0] != first["id"] && ids[0] != second["id"]) || (ids[1] != first["id"] && ids[1] != second["id"]) {
				t.Fatalf("concurrent start insertion lost or duplicated an item: %v", ids)
			}
			var ranks int
			if err := f.app.store.DB.QueryRow(f.app.store.Query("SELECT COUNT(DISTINCT sort_order) FROM work_items WHERE space_id=? AND status=? AND archived=?"), f.space, "todo", false).Scan(&ranks); err != nil || ranks != 3 {
				t.Fatalf("concurrent first ranks collided: count=%d err=%v", ranks, err)
			}
			revision := f.owner.ok("GET", f.base+"/revision", nil)
			f.owner.ok("POST", f.base+"/items", first)
			f.owner.ok("POST", f.base+"/items", second)
			if !reflect.DeepEqual(ids, workIDsFromPage(f.owner.ok("GET", f.base+"/items?status=todo", nil))) || !reflect.DeepEqual(revision, f.owner.ok("GET", f.base+"/revision", nil)) {
				t.Fatal("concurrent replay reordered items")
			}
		})
	}
}

func TestWorkItemExactFilter(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			project := f.owner.ok("POST", f.base+"/projects", map[string]any{"id": newID(), "name": "Located project"})
			first := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Locate first"})
			second := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Locate second", "projectId": project["id"], "needsAttention": true})
			foreign := f.owner.ok("POST", "/spaces/"+f.personal+"/work/items", map[string]any{"id": newID(), "title": "Personal canary"})
			id := second["id"].(string)
			if got := workIDsFromPage(f.owner.ok("GET", f.base+"/items?itemId="+id, nil)); !reflect.DeepEqual(got, []string{id}) {
				t.Fatalf("exact list did not find the later item: %v", got)
			}
			if got := workPlacementBoardIDs(t, f.owner.ok("GET", f.base+"/board?itemId="+id, nil)); !reflect.DeepEqual(got, []string{id}) {
				t.Fatalf("exact board did not find the later item: %v", got)
			}
			for _, query := range []string{"itemId=" + newID(), "itemId=" + foreign["id"].(string), "itemId=" + id + "&q=absent", "itemId=" + id + "&projectId=none", "itemId=" + id + "&status=doing", "itemId=" + id + "&archived=true", "itemId=" + first["id"].(string) + "&attention=true"} {
				if page := f.owner.ok("GET", f.base+"/items?"+query, nil); page["total"] != float64(0) || len(workIDsFromPage(page)) != 0 {
					t.Fatalf("exact item filter bypassed another filter: %s", query)
				}
			}
			statusWant(t, f.owner, 400, "GET", f.base+"/items?itemId=invalid", nil)
			statusWant(t, f.owner, 400, "GET", f.base+"/board?itemId=invalid", nil)
			page := f.owner.ok("GET", f.base+"/items?status=todo&limit=1", nil)
			cursor := page["nextCursor"].(string)
			statusWant(t, f.owner, 400, "GET", f.base+"/items?status=todo&limit=1&itemId="+id+"&cursor="+url.QueryEscape(cursor), nil)
			// A saved cursor from before itemId existed retains its fingerprint.
			raw, err := base64.RawURLEncoding.DecodeString(cursor)
			if err != nil {
				t.Fatal(err)
			}
			var legacy workCursor
			if err = json.Unmarshal(raw, &legacy); err != nil {
				t.Fatal(err)
			}
			legacy.Filter = workPayloadHash([]any{f.space, "", "", "todo", false, false})
			raw, err = json.Marshal(legacy)
			if err != nil {
				t.Fatal(err)
			}
			next := f.owner.ok("GET", f.base+"/items?status=todo&limit=1&cursor="+url.QueryEscape(base64.RawURLEncoding.EncodeToString(raw)), nil)
			if got := workIDsFromPage(next); !reflect.DeepEqual(got, []string{id}) {
				t.Fatalf("legacy cursor changed its remaining results: %v", got)
			}
			f.owner.ok("PATCH", workItemPath(f.space, first["id"].(string)), map[string]any{"expectedRevision": first["revision"], "archived": true})
			if got := workIDsFromPage(f.owner.ok("GET", f.base+"/items?itemId="+first["id"].(string)+"&archived=true", nil)); !reflect.DeepEqual(got, []string{first["id"].(string)}) {
				t.Fatal("exact lookup could not locate archived work with its explicit archive filter")
			}
			auth := &integrationTestBrowser{t: t, base: f.owner.base, client: f.owner.client, csrf: f.owner.csrf}
			caller := integrationBrowser(t, f.owner.base)
			read, _ := auth.token(f.space, "", "work:read")
			write, _ := auth.token(f.space, "", "work:write")
			old, _ := auth.token(f.space, "", "navigation:read")
			located := caller.object("GET", "/api/v1"+f.base+"/items?itemId="+id, nil, 200, read)
			if located["canEdit"] != false || !reflect.DeepEqual(workIDsFromPage(located), []string{id}) {
				t.Fatal("exact filter changed read-only token access")
			}
			mcpBoard := caller.tool(read, "work_board_get", map[string]any{"input": map[string]any{"itemId": id}}, "")
			if got := workPlacementBoardIDs(t, mcpBoard); !reflect.DeepEqual(got, []string{id}) {
				t.Fatal("MCP did not apply the exact item filter")
			}
			mcpForeign := caller.tool(read, "work_board_get", map[string]any{"input": map[string]any{"itemId": foreign["id"]}}, "")
			if len(workPlacementBoardIDs(t, mcpForeign)) != 0 {
				t.Fatal("MCP exact lookup disclosed a different space's item")
			}
			caller.tool(write, "work_items_list", map[string]any{"input": map[string]any{"itemId": id}}, "forbidden")
			caller.tool(old, "work_items_list", map[string]any{"input": map[string]any{"itemId": id}}, "forbidden")
			anonymous := newCoreBrowser(t, f.owner.base)
			anonymous.bootstrap()
			statusWant(t, anonymous, 401, "GET", f.base+"/board?itemId="+id, nil)
			createdID := newID()
			receipt := caller.tool(write, "work_items_create", map[string]any{"input": map[string]any{"id": createdID, "title": "MCP first", "placement": "start"}}, "")
			if receipt["id"] != createdID || receipt["created"] != true || receipt["title"] != nil || len(receipt) != 4 {
				t.Fatalf("placement changed the write-only receipt boundary: %v", receipt)
			}
			if got := workIDsFromPage(f.owner.ok("GET", f.base+"/items?status=todo&limit=1", nil)); !reflect.DeepEqual(got, []string{createdID}) {
				t.Fatal("MCP placement did not insert at the beginning")
			}
		})
	}
}
