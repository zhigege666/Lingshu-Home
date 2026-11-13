package home

import (
	"encoding/json"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func workActivityTestPage(t *testing.T, body map[string]any) WorkActivityPage {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	var page WorkActivityPage
	if err = json.Unmarshal(encoded, &page); err != nil {
		t.Fatal(err)
	}
	if page.ItemID == "" || page.Revision == "" || page.Items == nil {
		t.Fatalf("incomplete activity page: %v", body)
	}
	return page
}

func workActivityTestChanges(event WorkActivityEvent) map[string]WorkActivityChange {
	changes := map[string]WorkActivityChange{}
	for _, change := range event.Changes {
		changes[change.Field] = change
	}
	return changes
}

func TestWorkActivityLifecycleAndPagination(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			payload := map[string]any{"id": newID(), "title": "Title must not be copied to history", "description": "Body must not be copied to history"}
			item := f.owner.ok("POST", f.base+"/items", payload)
			path := workItemPath(f.space, item["id"].(string))
			read := func() WorkActivityPage {
				return workActivityTestPage(t, f.owner.ok("GET", path+"/activity?limit=100", nil))
			}
			initial := read()
			if len(initial.Items) != 1 || initial.Items[0].Action != "create" || initial.Items[0].OccurredAt != item["createdAt"] || initial.HistoryStartedAt != item["createdAt"] || !initial.HistoryComplete || initial.Items[0].Actor == nil || initial.Items[0].Origin != "web" {
				t.Fatalf("incorrect creation event or baseline: %+v", initial)
			}
			if f.owner.ok("GET", path, nil)["activity"] != nil {
				t.Fatal("ordinary detail loaded activity implicitly")
			}
			detail := f.owner.ok("GET", path+"?activityLimit=1", nil)
			if workActivityTestPage(t, detail["activity"].(map[string]any)).Items[0].ID != initial.Items[0].ID {
				t.Fatal("optional detail history differs from endpoint")
			}
			replay := f.owner.ok("POST", f.base+"/items", payload)
			noop := f.owner.ok("PATCH", path, map[string]any{"expectedRevision": item["revision"], "title": item["title"], "description": item["description"], "documentIds": []string{}, "bookmarkIds": []string{}})
			if replay["revision"] != item["revision"] || noop["revision"] != item["revision"] || noop["updatedAt"] != item["updatedAt"] || noop["boardRevision"] != item["boardRevision"] || len(read().Items) != 1 {
				t.Fatal("replay/no-op advanced time, revisions or history")
			}
			other := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Successor"})
			move := func(current map[string]any, before any) map[string]any {
				board := f.owner.ok("GET", f.base+"/revision", nil)
				return f.owner.ok("POST", path+"/move", map[string]any{"expectedRevision": current["revision"], "expectedBoardRevision": board["revision"], "status": current["status"], "beforeId": before})
			}
			noop = move(item, other["id"])
			if noop["revision"] != item["revision"] || noop["updatedAt"] != item["updatedAt"] || len(read().Items) != 1 {
				t.Fatal("logical no-op move produced an event")
			}
			item = move(item, nil)
			if read().Items[0].Action != "move" || len(read().Items) != 2 {
				t.Fatal("real reordering was not recorded")
			}
			noop = move(item, nil)
			if noop["revision"] != item["revision"] || len(read().Items) != 2 {
				t.Fatal("moving the existing tail to the end duplicated history")
			}
			project := f.owner.ok("POST", f.base+"/projects", map[string]any{"id": newID(), "name": "Project snapshot"})
			item = f.owner.ok("PATCH", path, map[string]any{"expectedRevision": item["revision"], "title": "New title private canary", "description": "New body private canary", "nextStep": "Next step private canary", "result": "Result private canary", "status": "doing", "projectId": project["id"], "needsAttention": true})
			event := read().Items[0]
			changes := workActivityTestChanges(event)
			if event.Action != "update" || event.OccurredAt != item["updatedAt"] || len(changes) != 7 || string(changes["projectId"].Before) != "null" || string(changes["needsAttention"].Before) != "false" || string(changes["needsAttention"].After) != "true" {
				t.Fatalf("missing safe field changes: %+v", event)
			}
			var oldStatus, newStatus map[string]any
			if json.Unmarshal(changes["status"].Before, &oldStatus) != nil || json.Unmarshal(changes["status"].After, &newStatus) != nil || oldStatus["id"] != "todo" || newStatus["id"] != "doing" || newStatus["type"] != "doing" {
				t.Fatal("status change lacks stable ID/type snapshots")
			}
			item = f.owner.ok("PATCH", path, map[string]any{"expectedRevision": item["revision"], "archived": true})
			if read().Items[0].Action != "archive" {
				t.Fatal("archive missing")
			}
			item = f.owner.ok("PATCH", path, map[string]any{"expectedRevision": item["revision"], "archived": false})
			first := workActivityTestPage(t, f.owner.ok("GET", path+"/activity?limit=2", nil))
			if first.Items[0].Action != "restore" || first.NextCursor == nil {
				t.Fatal("restore or history cursor missing")
			}
			// Appending a newer event must not change the remaining older pages.
			item = f.owner.ok("PATCH", path, map[string]any{"expectedRevision": item["revision"], "nextStep": "Later private canary"})
			seen := map[string]bool{}
			page := first
			previous := int64(1 << 62)
			for {
				if page.Revision != first.Revision {
					t.Fatal("history cursor changed snapshot")
				}
				for _, entry := range page.Items {
					revision, _ := strconv.ParseInt(entry.ItemRevision, 10, 64)
					if seen[entry.ID] || revision >= previous || entry.ItemRevision == item["revision"] {
						t.Fatal("history pages duplicated, reordered or included a later event")
					}
					seen[entry.ID], previous = true, revision
				}
				if page.NextCursor == nil {
					break
				}
				page = workActivityTestPage(t, f.owner.ok("GET", path+"/activity?limit=2&cursor="+url.QueryEscape(*page.NextCursor), nil))
			}
			if len(seen) != 5 || len(read().Items) != 6 {
				t.Fatal("history pages omitted events or refresh missed latest event")
			}
			encoded, _ := json.Marshal(read())
			for _, forbidden := range []string{"Title must not", "Body must not", "private canary"} {
				if strings.Contains(string(encoded), forbidden) {
					t.Fatal("history retained title or long content")
				}
			}
			for _, query := range []string{"limit=0", "limit=101", "limit=bad", "cursor=not-a-cursor"} {
				statusWant(t, f.owner, 400, "GET", path+"/activity?"+query, nil)
			}
			statusWant(t, f.owner, 400, "GET", workItemPath(f.space, other["id"].(string))+"/activity?cursor="+url.QueryEscape(*first.NextCursor), nil)
		})
	}
}

func TestWorkActivityPermissionsAndMCP(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			f.app.config.DocumentRoots = []string{t.TempDir()}
			docs := &documentFixture{app: f.app, owner: f.owner, root: f.app.config.DocumentRoots[0], shared: f.space, personal: f.personal}
			docs.source(t, f.space, "notes", false, map[string]string{"private-path.md": "# Private document canary\nNever copy this body\n"})
			document := documentByPath(t, f.owner, f.space, "private-path.md")
			link := f.owner.ok("POST", "/spaces/"+f.space+"/links", coreLink("Private bookmark canary", "https://example.com/private-canary"))
			item := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Scoped history", "bookmarkIds": []string{link["id"].(string)}, "documentIds": []string{document["id"].(string)}})
			id, path := item["id"].(string), workItemPath(f.space, item["id"].(string))
			auth := &integrationTestBrowser{t: t, base: f.owner.base, client: f.owner.client, csrf: f.owner.csrf}
			caller := integrationBrowser(t, f.owner.base)
			read, _ := auth.token(f.space, "", "work:read")
			write, _ := auth.token(f.space, "", "work:write")
			full, fullID := auth.token(f.space, "", "work:read", "work:write", "documents:read", "navigation:read")
			caller.tool(write, "work_items_update", map[string]any{"id": id, "input": map[string]any{"expectedRevision": item["revision"], "bookmarkIds": []string{}, "documentIds": []string{}}}, "")
			fullDetail := caller.tool(full, "work_items_get", map[string]any{"id": id, "input": map[string]any{"activityLimit": 1}}, "")
			page := workActivityTestPage(t, fullDetail["activity"].(map[string]any))
			if page.Items[0].Origin != "mcp" || len(page.Items[0].Changes) != 2 || page.Items[0].Actor == nil {
				t.Fatal("MCP write origin or reference deltas missing")
			}
			weak := caller.tool(read, "work_items_get", map[string]any{"id": id, "input": map[string]any{"activityLimit": 20}}, "")
			weakPage := workActivityTestPage(t, weak["activity"].(map[string]any))
			if len(weakPage.Items[0].Changes) != 0 {
				t.Fatal("reference activity exposed without corresponding read scopes")
			}
			encoded, _ := json.Marshal(fullDetail["activity"])
			for _, forbidden := range []string{"Private document canary", "Private bookmark canary", "private-path.md", "https://", docs.root, full, write} {
				if strings.Contains(string(encoded), forbidden) {
					t.Fatal("history exposed reference content, a path or credential")
				}
			}
			caller.object("GET", "/api/v1"+path+"/activity", nil, 403, write)
			caller.tool(write, "work_items_get", map[string]any{"id": id, "input": map[string]any{"activityLimit": 20}}, "forbidden")
			if caller.tool(read, "work_items_get", map[string]any{"id": id}, "")["activity"] != nil {
				t.Fatal("legacy MCP get gained an unsolicited history payload")
			}
			anonymous := newCoreBrowser(t, f.owner.base)
			anonymous.bootstrap()
			statusWant(t, anonymous, 401, "GET", path+"/activity", nil)
			foreign := f.owner.ok("POST", "/spaces/"+f.personal+"/work/items", map[string]any{"id": newID(), "title": "Personal canary"})
			caller.object("GET", "/api/v1"+workItemPath(f.space, foreign["id"].(string))+"/activity", nil, 404, read)
			current := f.owner.ok("GET", path, nil)
			caller.object("PATCH", "/api/v1"+path, map[string]any{"expectedRevision": current["revision"], "nextStep": "Direct bearer API"}, 200, full)
			page = workActivityTestPage(t, caller.object("GET", "/api/v1"+path+"/activity?limit=1", nil, 200, read))
			if page.Items[0].Origin != "api" {
				t.Fatal("ordinary bearer request was mislabeled MCP")
			}
			// A malformed legacy source-bound token must not gain item history.
			source := auth.source(f.space, "History source scope")
			if _, err := f.app.store.DB.Exec(f.app.store.Query("UPDATE integration_tokens SET source_id=? WHERE id=?"), source["id"], fullID); err != nil {
				t.Fatal(err)
			}
			caller.tool(full, "work_items_get", map[string]any{"id": id, "input": map[string]any{"activityLimit": 20}}, "forbidden")
		})
	}
}

func TestWorkActivityBulkChangesAndAtomicity(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			catalog := f.owner.ok("GET", f.base+"/statuses", nil)
			custom := newID()
			catalog = f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog["revision"], "create": []map[string]any{{"id": custom, "name": "Custom original", "type": "todo"}}})
			active := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Active", "status": custom})
			archived := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Archived", "status": custom})
			archived = f.owner.ok("PATCH", workItemPath(f.space, archived["id"].(string)), map[string]any{"expectedRevision": archived["revision"], "archived": true})
			read := func(id string) WorkActivityPage {
				return workActivityTestPage(t, f.owner.ok("GET", workItemPath(f.space, id)+"/activity?limit=100", nil))
			}
			catalog = f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog["revision"], "patches": []map[string]any{{"id": custom, "name": "Renamed only"}}})
			if len(read(active["id"].(string)).Items) != 1 || len(read(archived["id"].(string)).Items) != 2 {
				t.Fatal("catalog rename fabricated item events")
			}
			catalog = f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog["revision"], "patches": []map[string]any{{"id": custom, "type": "waiting"}}})
			for _, item := range []map[string]any{active, archived} {
				if read(item["id"].(string)).Items[0].Action != "status_definition" {
					t.Fatal("semantic type change missed an active/archived item")
				}
			}
			f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog["revision"], "deletions": []map[string]any{{"id": custom, "moveToStatus": "doing"}}})
			for _, item := range []map[string]any{active, archived} {
				event := read(item["id"].(string)).Items[0]
				if event.Action != "status_migrate" || !strings.Contains(string(event.Changes[0].Before), custom) || !strings.Contains(string(event.Changes[0].After), "doing") {
					t.Fatal("status retirement missed actual item migration")
				}
			}
			// Every bookmark deletion entry point records actual FK removals once.
			for _, operation := range []string{"single", "batch", "batch-edit"} {
				links := []string{}
				count := 2
				if operation == "single" {
					count = 1
				}
				for i := 0; i < count; i++ {
					link := f.owner.ok("POST", "/spaces/"+f.space+"/links", coreLink("Reference", "https://example.com/"+newID()))
					links = append(links, link["id"].(string))
				}
				item := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Delete references", "bookmarkIds": links})
				path := "/spaces/" + f.space
				switch operation {
				case "single":
					statusWant(t, f.owner, 204, "DELETE", path+"/links/"+links[0], nil)
				case "batch":
					nav := f.owner.ok("GET", path+"/navigation", nil)
					f.owner.ok("POST", path+"/links/batch", map[string]any{"linkIds": links, "expectedRevision": nav["revision"], "operation": "delete"})
				case "batch-edit":
					nav := f.owner.ok("GET", path+"/navigation", nil)
					f.owner.ok("POST", path+"/navigation/batch-edit", map[string]any{"deleteLinkIds": links, "expectedRevision": nav["revision"]})
				}
				page := read(item["id"].(string))
				if len(page.Items) != 2 || page.Items[0].Action != "update" || page.Items[0].Changes[0].Field != "bookmarkIds" || page.Items[0].Changes[0].Removed != count {
					t.Fatalf("%s deletion did not record exactly one aggregate delta: %+v", operation, page)
				}
			}
			// An activity write failure rolls back the item, references and board.
			current := f.owner.ok("GET", workItemPath(f.space, active["id"].(string)), nil)
			before := read(active["id"].(string))
			trigger := "CREATE TRIGGER fail_work_activity BEFORE INSERT ON work_activity BEGIN SELECT RAISE(ABORT,'intentional activity failure'); END"
			if provider == "postgres" {
				trigger = "CREATE FUNCTION fail_work_activity_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional activity failure'; END $$; CREATE TRIGGER fail_work_activity BEFORE INSERT ON work_activity FOR EACH ROW EXECUTE FUNCTION fail_work_activity_fn()"
			}
			if _, err := f.app.store.DB.Exec(trigger); err != nil {
				t.Fatal(err)
			}
			statusWant(t, f.owner, 500, "PATCH", workItemPath(f.space, active["id"].(string)), map[string]any{"expectedRevision": current["revision"], "description": "Must roll back"})
			latest := f.owner.ok("GET", workItemPath(f.space, active["id"].(string)), nil)
			if !reflect.DeepEqual(latest, current) || !reflect.DeepEqual(read(active["id"].(string)), before) {
				t.Fatal("failed activity write partially committed its mutation")
			}
			if _, err := f.app.store.DB.Exec("DROP TRIGGER fail_work_activity" + map[string]string{"postgres": " ON work_activity"}[provider]); err != nil {
				t.Fatal(err)
			}
		})
	}
}
