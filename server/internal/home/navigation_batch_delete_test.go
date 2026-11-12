package home

import (
	"net/http"
	"reflect"
	"testing"
)

func TestNavigationBatchDeleteAtomic(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Delete fixture", "mode": ModePrivateMulti, "username": "owner", "password": "navigation delete fixture password", "seedDemo": false})
			boot := owner.bootstrap()
			space, personal := coreSpace(boot, "shared"), coreSpace(boot, "personal")
			base := "/spaces/" + space
			path := base + "/navigation/batch-edit"
			category := func(name string) string {
				return owner.ok("POST", base+"/categories", map[string]any{"name": name})["id"].(string)
			}
			source, target := category("Source"), category("Target")
			create := func(group, name string, category any, rank int) string {
				input := coreLink(name, "https://delete.example.invalid/"+newID())
				input["categoryId"], input["sortOrder"], input["iconMode"] = category, rank, "manual"
				input["contextMarkdown"] = "Keep existing usage notes"
				return owner.ok("POST", "/spaces/"+group+"/links", input)["id"].(string)
			}
			removed := create(space, "Removed", source, 10)
			kept := create(space, "Moved", source, 20)
			hidden := create(space, "Hidden", source, 30)
			anchor := create(space, "Anchor", target, 5)
			foreign := create(personal, "Foreign", nil, 0)
			foreignCategory := owner.ok("POST", "/spaces/"+personal+"/categories", map[string]any{"name": "Private"})["id"]
			read := func() map[string]any { return owner.ok("GET", base+"/navigation", nil) }
			unchanged := func(before map[string]any) {
				t.Helper()
				after := read()
				if before["revision"] != after["revision"] || !reflect.DeepEqual(before["data"], after["data"]) {
					t.Fatal("rejected deletion changed navigation")
				}
			}
			// Keep the isolated queue record from starting any outbound icon fetch.
			app.iconFetchGate <- struct{}{}
			defer func() { <-app.iconFetchGate }()
			origin, jobID := "https://delete.example.invalid", newID()
			var authEpoch int64
			if err := app.store.DB.QueryRow("SELECT auth_epoch FROM settings WHERE id=1").Scan(&authEpoch); err != nil {
				t.Fatal(err)
			}
			if _, err := app.store.DB.Exec(app.store.Query("UPDATE links SET icon_mode='auto',icon_origin=? WHERE id=?"), origin, removed); err != nil {
				t.Fatal(err)
			}
			if _, err := app.store.DB.Exec(app.store.Query("INSERT INTO icon_favicon_jobs(space_id,origin,id,auth_epoch,actor_user_id,actor_user_version,token_hash,requested_at) VALUES(?,?,?,?,NULL,0,'',?)"), space, origin, jobID, authEpoch, nowUTC()); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := app.store.DB.Exec(app.store.Query("DELETE FROM icon_favicon_jobs WHERE id=?"), jobID); err != nil {
					t.Error(err)
				}
			}()
			clickCount := func(want int) {
				t.Helper()
				for _, table := range []string{"link_click_totals", "link_click_days", "link_click_receipts"} {
					var n int
					if err := app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM "+table+" WHERE link_id=?"), removed).Scan(&n); err != nil || n != want {
						t.Fatalf("%s count = %d, want %d: %v", table, n, want, err)
					}
				}
			}
			dependentRows := func(want int) {
				t.Helper()
				clickCount(want)
				var n int
				if err := app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM icon_favicon_jobs WHERE id=?"), jobID).Scan(&n); err != nil || n != want {
					t.Fatalf("icon cleanup count = %d, want %d: %v", n, want, err)
				}
			}
			owner.ok("POST", base+"/links/"+removed+"/clicks", map[string]any{"eventId": newID(), "entry": "primary"})
			patch := func(id, title string) map[string]any {
				return map[string]any{"id": id, "patch": map[string]any{"title": title}}
			}
			move := func(id string, before, category any) map[string]any {
				return map[string]any{"kind": "link", "id": id, "beforeId": before, "categoryId": category}
			}
			t.Run("rejects_are_atomic", func(t *testing.T) {
				cases := []struct {
					name   string
					body   map[string]any
					status int
				}{
					{"stale_revision", map[string]any{"expectedRevision": "0"}, 409},
					{"missing_id", map[string]any{"deleteLinkIds": []string{removed, newID()}}, 404},
					{"foreign_id", map[string]any{"deleteLinkIds": []string{removed, foreign}}, 404},
					{"duplicate_id", map[string]any{"deleteLinkIds": []string{removed, removed}}, 400},
					{"invalid_id", map[string]any{"deleteLinkIds": []string{"invalid"}}, 400},
					{"delete_and_patch", map[string]any{"links": []any{patch(removed, "Must not change")}}, 400},
					{"delete_and_create", map[string]any{"createLinks": []any{map[string]any{"id": removed, "title": "Replace", "url": "https://example.invalid/replacement"}}}, 400},
					{"delete_and_move", map[string]any{"moves": []any{move(removed, nil, target)}}, 400},
					{"deleted_anchor", map[string]any{"moves": []any{move(kept, removed, source)}}, 400},
					{"invalid_patch_rolls_back_delete", map[string]any{"links": []any{patch(kept, "")}}, 400},
					{"invalid_move_rolls_back_delete_and_patch", map[string]any{"links": []any{patch(kept, "Must roll back")}, "moves": []any{move(kept, nil, foreignCategory)}}, 404},
					{"invalid_create_rolls_back_delete", map[string]any{"createLinks": []any{map[string]any{"id": newID(), "title": "Bad URL", "url": "javascript:alert(1)"}}}, 400},
				}
				excess := make([]any, 500)
				for i := range excess {
					excess[i] = patch(kept, "Too many")
				}
				cases = append(cases, struct {
					name   string
					body   map[string]any
					status int
				}{"combined_operation_limit", map[string]any{"links": excess}, 400})
				for _, tc := range cases {
					t.Run(tc.name, func(t *testing.T) {
						before := read()
						if _, ok := tc.body["expectedRevision"]; !ok {
							tc.body["expectedRevision"] = before["revision"]
						}
						if _, ok := tc.body["deleteLinkIds"]; !ok {
							tc.body["deleteLinkIds"] = []string{removed}
						}
						status, response := owner.call("POST", path, tc.body)
						if status != tc.status {
							t.Fatalf("status = %d, want %d: %v", status, tc.status, response)
						}
						unchanged(before)
						dependentRows(1)
					})
				}
			})
			t.Run("late_database_failure_restores_every_change", func(t *testing.T) {
				statements := []string{"CREATE TRIGGER home_delete_revision_failure BEFORE UPDATE OF data_revision ON spaces BEGIN SELECT RAISE(ABORT,'intentional revision failure'); END"}
				if provider == "postgres" {
					statements = []string{
						"CREATE FUNCTION home_delete_revision_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional revision failure'; END $$",
						"CREATE TRIGGER home_delete_revision_failure BEFORE UPDATE OF data_revision ON spaces FOR EACH ROW EXECUTE FUNCTION home_delete_revision_fail()",
					}
				}
				for _, statement := range statements {
					if _, err := app.store.DB.Exec(statement); err != nil {
						t.Fatal(err)
					}
				}
				defer func() {
					drop := "DROP TRIGGER home_delete_revision_failure"
					if provider == "postgres" {
						drop += " ON spaces"
					}
					if _, err := app.store.DB.Exec(drop); err != nil {
						t.Error(err)
					}
					if provider == "postgres" {
						if _, err := app.store.DB.Exec("DROP FUNCTION home_delete_revision_fail()"); err != nil {
							t.Error(err)
						}
					}
				}()
				before := read()
				status, result := owner.call("POST", path, map[string]any{
					"expectedRevision": before["revision"], "deleteLinkIds": []string{removed},
					"links": []any{patch(kept, "Must roll back")},
					"moves": []any{move(kept, anchor, target)},
				})
				if status != 500 {
					t.Fatalf("injected failure status = %d: %v", status, result)
				}
				unchanged(before)
				dependentRows(1)
			})
			created := newID()
			t.Run("delete_patch_create_and_move_commit_once", func(t *testing.T) {
				before := read()
				result := owner.ok("POST", path, map[string]any{
					"expectedRevision": before["revision"], "deleteLinkIds": []string{removed},
					"links":       []any{patch(kept, "Moved and renamed")},
					"createLinks": []any{map[string]any{"id": created, "title": "Created", "url": "https://delete.example.invalid/new", "iconMode": "manual"}},
					"moves":       []any{move(kept, anchor, target)},
				})
				after := read()
				navigationEditTestRevision(t, before["revision"], after["revision"], 1)
				if !reflect.DeepEqual(result["deletedLinkIds"], []any{removed}) || result["revision"] != after["revision"] {
					t.Fatalf("unexpected deletion receipt: %v", result)
				}
				if got := navigationMoveTestOrder(after, "links", "categoryId", target); !reflect.DeepEqual(got, []string{kept, anchor}) {
					t.Fatalf("unexpected target ordering: %v", got)
				}
				row := navigationEditTestRow(t, after, "links", kept)
				if row["title"] != "Moved and renamed" || row["contextMarkdown"] != "Keep existing usage notes" {
					t.Fatalf("move/edit altered unrelated fields: %v", row)
				}
				if row := navigationEditTestRow(t, after, "links", hidden); row["sortOrder"] != float64(0) {
					t.Fatal("a cross-category move did not normalize its surviving source sibling")
				}
				for _, raw := range after["data"].(map[string]any)["links"].([]any) {
					if raw.(map[string]any)["id"] == removed {
						t.Fatal("deleted bookmark remains in navigation")
					}
				}
				navigationEditTestRow(t, after, "links", created)
				dependentRows(0)
				if status, _ := owner.call("POST", path, map[string]any{"expectedRevision": before["revision"], "deleteLinkIds": []string{removed}}); status != 409 {
					t.Fatal("replayed old revision did not conflict")
				}
			})
			t.Run("mcp_discovery_permissions_and_write_only_receipt", func(t *testing.T) {
				auth := &integrationTestBrowser{t: t, base: server.URL, client: owner.client, csrf: owner.csrf}
				caller := integrationBrowser(t, server.URL)
				reader, _ := auth.token(space, "", "navigation:read")
				writer, _ := auth.token(space, "", "navigation:write")
				before := read()
				input := map[string]any{"expectedRevision": before["revision"], "deleteLinkIds": []string{created}}
				caller.tool(reader, "navigation_batch_edit", map[string]any{"input": input}, "forbidden")
				caller.tool(writer, "navigation_batch_edit", map[string]any{"spaceId": personal, "input": input}, "not_found")
				unchanged(before)
				listed, _ := caller.mcp(writer, "tools/list", map[string]any{}, http.StatusOK)
				discovered := false
				for _, item := range integrationObject(t, listed["result"])["tools"].([]any) {
					tool := integrationObject(t, item)
					if tool["name"] != "navigation_batch_edit" {
						continue
					}
					props := integrationObject(t, integrationObject(t, tool["inputSchema"])["properties"])
					fields := integrationObject(t, integrationObject(t, props["input"])["properties"])
					ids := integrationObject(t, fields["deleteLinkIds"])
					if ids["type"] != "array" || ids["uniqueItems"] != true || ids["maxItems"] != float64(500) {
						t.Fatalf("deletion schema unavailable: %v", ids)
					}
					discovered = true
				}
				if !discovered {
					t.Fatal("navigation_batch_edit was not discoverable")
				}
				result := caller.tool(writer, "navigation_batch_edit", map[string]any{"input": input}, "")
				if len(result) != 3 || result["updatedCount"] != float64(0) || !reflect.DeepEqual(result["deletedLinkIds"], []any{created}) {
					t.Fatalf("write-only deletion leaked stored rows or used wrong count: %v", result)
				}
				after := read()
				navigationEditTestRevision(t, before["revision"], after["revision"], 1)
				beforeData := before["data"].(map[string]any)
				afterData := after["data"].(map[string]any)
				if !reflect.DeepEqual(beforeData["categories"], afterData["categories"]) {
					t.Fatal("delete changed categories")
				}
				for _, raw := range afterData["links"].([]any) {
					row := raw.(map[string]any)
					if row["id"] == created {
						t.Fatal("MCP delete was not saved")
					}
					if !reflect.DeepEqual(row, navigationEditTestRow(t, before, "links", row["id"].(string))) {
						t.Fatal("delete changed a surviving bookmark")
					}
				}
			})
		})
	}
}
