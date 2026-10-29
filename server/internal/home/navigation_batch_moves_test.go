package home

import (
	"fmt"
	"reflect"
	"sort"
	"testing"
	"time"
)

func TestNavigationBatchMovesHTTPAndMCP(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Home edit moves", "mode": ModePrivateMulti, "username": "owner", "password": "home edit test password 2026", "seedDemo": false})
			boot := owner.bootstrap()
			space, personal := coreSpace(boot, "shared"), coreSpace(boot, "personal")
			path := "/spaces/" + space + "/navigation/batch-edit"
			createCategory := func(name, group string, parent any) string {
				return owner.ok("POST", "/spaces/"+group+"/categories", map[string]any{"name": name, "parentId": parent, "sortOrder": 0})["id"].(string)
			}
			first, second := createCategory("First", space, nil), createCategory("Second", space, nil)
			child := createCategory("Child", space, first)
			foreign := createCategory("Private", personal, nil)
			ids := []string{}
			for i, name := range []string{"A", "B", "C", "D", "E"} {
				input := coreLink(name, fmt.Sprintf("https://moves.example.invalid/%d", i))
				input["categoryId"], input["sortOrder"], input["iconMode"] = first, i, "manual"
				input["contextMarkdown"] = "Preserve reference notes"
				ids = append(ids, owner.ok("POST", "/spaces/"+space+"/links", input)["id"].(string))
			}
			read := func() map[string]any { return owner.ok("GET", "/spaces/"+space+"/navigation", nil) }
			move := func(kind, id string, before any, target ...any) map[string]any {
				value := map[string]any{"kind": kind, "id": id, "beforeId": before}
				if len(target) > 0 {
					value["categoryId"] = target[0]
				}
				return value
			}
			patch := func(id string, fields any) map[string]any { return map[string]any{"id": id, "patch": fields} }
			post := func(body map[string]any) (int, map[string]any) {
				if _, exists := body["expectedRevision"]; !exists {
					body["expectedRevision"] = read()["revision"]
				}
				return owner.call("POST", path, body)
			}
			unchanged := func(t *testing.T, before map[string]any) {
				t.Helper()
				if after := read(); !reflect.DeepEqual(before["data"], after["data"]) || before["revision"] != after["revision"] {
					t.Fatal("Rejected/no-op move changed stored navigation")
				}
			}
			t.Run("hidden_siblings_and_one_revision", func(t *testing.T) {
				before := read()
				status, result := post(map[string]any{"links": []any{patch(ids[4], map[string]any{"title": "E renamed"})}, "moves": []any{move("link", ids[4], ids[2], first), move("category", second, first)}})
				if status != 200 {
					t.Fatalf("Move %d %v", status, result)
				}
				after := read()
				navigationEditTestRevision(t, before["revision"], after["revision"], 1)
				if got := navigationMoveTestOrder(after, "links", "categoryId", first); !reflect.DeepEqual(got, []string{ids[0], ids[1], ids[4], ids[2], ids[3]}) {
					t.Fatalf("Hidden siblings were reordered: %v", got)
				}
				if got := navigationMoveTestOrder(after, "categories", "parentId", nil); !reflect.DeepEqual(got, []string{second, first}) {
					t.Fatalf("Category move %v", got)
				}
				for _, id := range ids {
					old, next := navigationEditTestRow(t, before, "links", id), navigationEditTestRow(t, after, "links", id)
					for key, value := range old {
						if key != "sortOrder" && key != "updatedAt" && !(id == ids[4] && key == "title") && !reflect.DeepEqual(value, next[key]) {
							t.Fatalf("Move altered %s", key)
						}
					}
				}
			})
			t.Run("noop_move", func(t *testing.T) {
				before := read()
				status, result := post(map[string]any{"moves": []any{move("link", ids[4], ids[2], first), move("category", second, first)}})
				if status != 200 || result["updatedCount"] != float64(0) {
					t.Fatalf("No-op %d %v", status, result)
				}
				unchanged(t, before)
			})
			t.Run("patch_memberships_then_right_to_left_moves", func(t *testing.T) {
				status, result := post(map[string]any{
					"categories": []any{patch(child, map[string]any{"parentId": nil})},
					"links":      []any{patch(ids[0], map[string]any{"categoryId": second}), patch(ids[1], map[string]any{"categoryId": second})},
					"moves":      []any{move("category", child, first), move("link", ids[0], nil, second), move("link", ids[1], ids[0], second)},
				})
				if status != 200 {
					t.Fatalf("Patched memberships %d %v", status, result)
				}
				after := read()
				if got := navigationMoveTestOrder(after, "links", "categoryId", second); !reflect.DeepEqual(got, []string{ids[1], ids[0]}) {
					t.Fatalf("Final link order %v", got)
				}
				if got := navigationMoveTestOrder(after, "categories", "parentId", nil); !reflect.DeepEqual(got, []string{second, child, first}) {
					t.Fatalf("Final category order %v", got)
				}
			})
			t.Run("move_only_cross_category_and_uncategorized", func(t *testing.T) {
				status, result := post(map[string]any{"moves": []any{move("link", ids[4], ids[0], second), move("link", ids[3], nil, nil)}})
				if status != 200 {
					t.Fatalf("Move-only cross category %d %v", status, result)
				}
				after := read()
				if got := navigationMoveTestOrder(after, "links", "categoryId", second); !reflect.DeepEqual(got, []string{ids[1], ids[4], ids[0]}) {
					t.Fatalf("Cross category order %v", got)
				}
				if navigationEditTestRow(t, after, "links", ids[3])["categoryId"] != nil {
					t.Fatal("Uncategorized move did not clear category")
				}
			})
			t.Run("invalid_moves_roll_back_patches_and_prior_moves", func(t *testing.T) {
				cases := []struct {
					name   string
					moves  any
					status int
				}{
					{"missing_row", []any{move("link", "missing", nil, first)}, 404},
					{"foreign_target", []any{move("link", ids[0], nil, foreign)}, 404},
					{"foreign_anchor", []any{move("category", second, foreign)}, 404},
					{"anchor_wrong_group", []any{move("link", ids[0], ids[2], second)}, 400},
					{"self_anchor", []any{move("link", ids[0], ids[0], second)}, 400},
					{"duplicate", []any{move("link", ids[0], nil, first), move("link", ids[0], nil, second)}, 400},
					{"kind", []any{move("unknown", ids[0], nil)}, 400},
					{"missing_before", []any{map[string]any{"kind": "category", "id": first}}, 400},
					{"missing_target", []any{move("link", ids[0], nil)}, 400},
					{"category_target", []any{move("category", first, nil, nil)}, 400},
					{"late_bad_move", []any{move("link", ids[0], nil, first), move("category", second, "missing")}, 404},
				}
				for _, tc := range cases {
					t.Run(tc.name, func(t *testing.T) {
						before := read()
						status, result := post(map[string]any{"links": []any{patch(ids[0], map[string]any{"title": "Must roll back"})}, "moves": tc.moves})
						if status != tc.status {
							t.Fatalf("HTTP %d want %d: %v", status, tc.status, result)
						}
						unchanged(t, before)
					})
				}
			})
			t.Run("stale_revision", func(t *testing.T) {
				before := read()
				status, result := post(map[string]any{"expectedRevision": "0", "moves": []any{move("link", ids[0], nil, first)}})
				if status != 409 || navigationEditTestError(result)["code"] != "navigation_version_conflict" {
					t.Fatalf("Stale move %d %v", status, result)
				}
				unchanged(t, before)
			})
			t.Run("mcp_discovery_revision_and_authorization", func(t *testing.T) {
				issue := func(actions []string) string {
					return owner.ok("POST", "/integrations/tokens", map[string]any{"name": "Moves agent", "spaceId": space, "actions": actions, "expiresAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)})["token"].(string)
				}
				full, readonly := issue([]string{"navigation:read", "navigation:write"}), issue([]string{"navigation:read"})
				api := integrationBrowser(t, server.URL)
				before := api.tool(full, "navigation_get", map[string]any{"spaceId": space}, "")
				input := map[string]any{"expectedRevision": before["revision"], "moves": []any{move("link", ids[0], nil, first)}}
				api.tool(readonly, "navigation_batch_edit", map[string]any{"spaceId": space, "input": input}, "forbidden")
				unchanged(t, before)
				result := api.tool(full, "navigation_batch_edit", map[string]any{"spaceId": space, "input": input}, "")
				if result["revision"] == before["revision"] {
					t.Fatal("MCP move did not commit")
				}
				api.tool(full, "navigation_batch_edit", map[string]any{"spaceId": space, "input": input}, "navigation_version_conflict")
				api.tool(full, "navigation_get", map[string]any{"spaceId": personal}, "not_found")
			})
			t.Run("500_operations_can_reorder_larger_groups", func(t *testing.T) {
				parent := createCategory("Large group", space, nil)
				moves := make([]any, 0, 501)
				for i := 0; i < 501; i++ {
					id := fmt.Sprintf("moves-limit-%03d", i)
					navigationEditTestInsertCategory(t, app, space, id, fmt.Sprintf("Item %03d", i), parent)
					moves = append(moves, move("category", id, nil))
				}
				if _, err := app.store.DB.Exec(app.store.Query("UPDATE categories SET sort_order=1000 WHERE parent_id=? AND space_id=?"), parent, space); err != nil {
					t.Fatal(err)
				}
				status, result := post(map[string]any{"moves": moves[:500]})
				if status != 200 || result["updatedCount"].(float64) <= 500 {
					t.Fatalf("500 operations on 501 siblings %d %v", status, result["updatedCount"])
				}
				before := read()
				status, _ = post(map[string]any{"moves": moves})
				if status != 400 {
					t.Fatalf("501 moves accepted: %d", status)
				}
				unchanged(t, before)
				status, _ = post(map[string]any{"categories": []any{patch(parent, map[string]any{"name": "Too many"})}, "moves": moves[:500]})
				if status != 400 {
					t.Fatalf("501 mixed operations accepted: %d", status)
				}
				unchanged(t, before)
			})
		})
	}
}

func navigationMoveTestOrder(nav map[string]any, kind, groupField string, group any) []string {
	rows := []map[string]any{}
	for _, raw := range nav["data"].(map[string]any)[kind].([]any) {
		row := raw.(map[string]any)
		if reflect.DeepEqual(row[groupField], group) {
			rows = append(rows, row)
		}
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i]["sortOrder"].(float64) < rows[j]["sortOrder"].(float64) })
	ids := make([]string, len(rows))
	for i, row := range rows {
		ids[i] = row["id"].(string)
	}
	return ids
}
