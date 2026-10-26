package home

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestNavigationBatchEditHTTP(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Batch edit test", "mode": ModePrivateMulti, "username": "owner", "displayName": "Owner", "password": "batch test password 2026", "seedDemo": false})
			boot := owner.bootstrap()
			shared := coreSpace(boot, "shared")
			personal := coreSpace(boot, "personal")
			path := "/spaces/" + shared + "/navigation/batch-edit"
			create := func(space, name string, parent any) string {
				return owner.ok("POST", "/spaces/"+space+"/categories", map[string]any{"name": name, "icon": "lucide:folder", "parentId": parent, "sortOrder": 0})["id"].(string)
			}
			aID := create(shared, "Alpha", nil)
			bID := create(shared, "Bravo", aID)
			in := coreLink("Original link", "https://batch.example.invalid/start")
			in["categoryId"], in["iconMode"], in["isFavorite"], in["sortOrder"] = bID, "manual", true, 17
			in["description"] = "Keep this description"
			in["tags"] = []string{"keep", "second"}
			in["endpoints"] = []Endpoint{{Label: "Docs", URL: "https://docs.example.invalid/"}}
			link := owner.ok("POST", "/spaces/"+shared+"/links", in)
			linkID := link["id"].(string)
			owner.ok("PUT", "/spaces/"+shared+"/links/"+linkID+"/context", map[string]any{"contextMarkdown": "# Preserve existing usage notes", "expectedUpdatedAt": link["updatedAt"]})
			read := func() map[string]any { return owner.ok("GET", "/spaces/"+shared+"/navigation", nil) }
			row := func(id string, patch any) map[string]any { return map[string]any{"id": id, "patch": patch} }
			post := func(categories, links any) (int, map[string]any) {
				return owner.call("POST", path, map[string]any{"expectedRevision": read()["revision"], "categories": categories, "links": links})
			}
			unchanged := func(t *testing.T, before map[string]any) {
				t.Helper()
				after := read()
				if before["revision"] != after["revision"] || !reflect.DeepEqual(before["data"], after["data"]) {
					t.Fatal("Rejected or unchanged batch modified navigation")
				}
			}
			t.Run("mixed_atomic_update_and_preserved_fields", func(t *testing.T) {
				before := read()
				old := navigationEditTestRow(t, before, "links", linkID)
				status, result := post([]any{row(aID, map[string]any{"name": "  Alpha renamed  "})}, []any{row(linkID, map[string]any{"title": "Updated link"})})
				if status != 200 || result["updatedCount"] != float64(2) {
					t.Fatalf("Mixed result %d %v", status, result)
				}
				after := read()
				navigationEditTestRevision(t, before["revision"], after["revision"], 1)
				if result["revision"] != after["revision"] || len(result["categories"].([]any)) != 1 || len(result["links"].([]any)) != 1 {
					t.Fatal("Incomplete committed response")
				}
				category := navigationEditTestRow(t, after, "categories", aID)
				if category["name"] != "Alpha renamed" {
					t.Fatal("Name normalization lost")
				}
				got := navigationEditTestRow(t, after, "links", linkID)
				if got["title"] != "Updated link" || got["updatedAt"] == old["updatedAt"] {
					t.Fatal("Changed title/time not saved")
				}
				for key, value := range old {
					if key != "title" && key != "updatedAt" && !reflect.DeepEqual(value, got[key]) {
						t.Fatalf("Unedited field changed: %s", key)
					}
				}
				if !reflect.DeepEqual(result["links"].([]any)[0], got) || !reflect.DeepEqual(result["categories"].([]any)[0], category) {
					t.Fatal("Commit response differs from readback")
				}
			})
			t.Run("normalized_noop", func(t *testing.T) {
				before := read()
				status, result := post([]any{row(aID, map[string]any{"name": " Alpha renamed "})}, []any{row(linkID, map[string]any{"title": "Updated link"})})
				if status != 200 || result["updatedCount"] != float64(0) || len(result["categories"].([]any)) != 0 || len(result["links"].([]any)) != 0 {
					t.Fatal("Noop changed records")
				}
				unchanged(t, before)
			})
			t.Run("null_false_zero_and_empty_arrays", func(t *testing.T) {
				status, _ := post([]any{row(bID, map[string]any{"parentId": nil, "sortOrder": 0})}, []any{row(linkID, map[string]any{"categoryId": nil, "description": "", "isFavorite": false, "sortOrder": 0, "tags": []string{}, "endpoints": []Endpoint{}})})
				if status != 200 {
					t.Fatalf("Clear values HTTP %d", status)
				}
				nav := read()
				got := navigationEditTestRow(t, nav, "links", linkID)
				if got["categoryId"] != nil || got["isFavorite"] != false || got["sortOrder"] != float64(0) || got["description"] != "" || len(got["tags"].([]any)) != 0 || len(got["endpoints"].([]any)) != 0 || navigationEditTestRow(t, nav, "categories", bID)["parentId"] != nil {
					t.Fatal("Clear values treated as omitted")
				}
			})
			t.Run("simultaneous_reparenting", func(t *testing.T) {
				if status, _ := post([]any{row(bID, map[string]any{"parentId": aID})}, nil); status != 200 {
					t.Fatal("Prepare tree")
				}
				before := read()
				status, result := post([]any{row(aID, map[string]any{"parentId": bID}), row(bID, map[string]any{"parentId": nil})}, nil)
				if status != 200 || result["updatedCount"] != float64(2) {
					t.Fatal("Valid final tree rejected")
				}
				after := read()
				navigationEditTestRevision(t, before["revision"], after["revision"], 1)
				if navigationEditTestRow(t, after, "categories", aID)["parentId"] != bID || navigationEditTestRow(t, after, "categories", bID)["parentId"] != nil {
					t.Fatal("Wrong final tree")
				}
			})
			t.Run("invalid_batches_are_atomic", func(t *testing.T) {
				cases := []struct {
					name              string
					categories, links any
				}{
					{"self", []any{row(aID, map[string]any{"parentId": aID})}, nil},
					{"cycle", []any{row(bID, map[string]any{"parentId": aID})}, []any{row(linkID, map[string]any{"title": "Rollback"})}},
					{"invalid_link", []any{row(aID, map[string]any{"name": "Rollback"})}, []any{row(linkID, map[string]any{"title": ""})}},
					{"duplicate_category", []any{row(aID, map[string]any{"name": "One"}), row(aID, map[string]any{"name": "Two"})}, nil},
					{"duplicate_link", nil, []any{row(linkID, map[string]any{"title": "One"}), row(linkID, map[string]any{"title": "Two"})}},
					{"unknown", nil, []any{row(linkID, map[string]any{"unexpected": true})}},
					{"endpoint_unknown", nil, []any{row(linkID, map[string]any{"endpoints": []any{map[string]any{"label": "Docs", "url": "https://docs.example.invalid", "unexpected": true}}})}},
					{"empty_patch", nil, []any{row(linkID, map[string]any{})}},
					{"nonobject", nil, []any{row(linkID, []string{"bad"})}},
					{"null_scalar", nil, []any{row(linkID, map[string]any{"title": nil})}},
					{"fraction", nil, []any{row(linkID, map[string]any{"sortOrder": 0.5})}},
					{"empty_batch", nil, nil},
				}
				for _, tc := range cases {
					t.Run(tc.name, func(t *testing.T) {
						before := read()
						status, _ := post(tc.categories, tc.links)
						if status != 400 {
							t.Fatalf("Invalid batch HTTP %d", status)
						}
						unchanged(t, before)
					})
				}
			})
			t.Run("depth_32_and_33", func(t *testing.T) {
				var parent any
				for i := 0; i < 32; i++ {
					id := fmt.Sprintf("batch-depth-%02d", i)
					navigationEditTestInsertCategory(t, app, shared, id, fmt.Sprintf("Depth %02d", i), parent)
					parent = id
				}
				outside := create(shared, "Depth outside", nil)
				before := read()
				status, result := post([]any{row("batch-depth-00", map[string]any{"parentId": outside})}, nil)
				if status != 400 || navigationEditTestError(result)["field"] != "parentId" {
					t.Fatal("Depth33 not field rejected")
				}
				unchanged(t, before)
				if status, _ := post([]any{row("batch-depth-31", map[string]any{"name": "Depth 32 valid"})}, nil); status != 200 {
					t.Fatal("Depth32 rejected")
				}
			})
			t.Run("foreign_rows_and_references", func(t *testing.T) {
				foreignCategory := create(personal, "Private category", nil)
				input := coreLink("Private link", "https://private.example.invalid/")
				input["iconMode"] = "manual"
				foreignLink := owner.ok("POST", "/spaces/"+personal+"/links", input)["id"].(string)
				cases := []struct{ categories, links any }{
					{[]any{row(foreignCategory, map[string]any{"name": "Forbidden"})}, nil},
					{nil, []any{row(foreignLink, map[string]any{"title": "Forbidden"})}},
					{[]any{row(aID, map[string]any{"parentId": foreignCategory})}, nil},
					{nil, []any{row(linkID, map[string]any{"categoryId": foreignCategory})}},
				}
				for _, tc := range cases {
					before := read()
					if status, _ := post(tc.categories, tc.links); status != 404 {
						t.Fatalf("Cross-space HTTP %d", status)
					}
					unchanged(t, before)
				}
			})
			t.Run("stale_revision", func(t *testing.T) {
				before := read()
				status, result := owner.call("POST", path, map[string]any{"expectedRevision": "0", "links": []any{row(linkID, map[string]any{"title": "Stale"})}})
				api := navigationEditTestError(result)
				if status != 409 || api["code"] != "navigation_version_conflict" || api["currentRevision"] != before["revision"] {
					t.Fatalf("Conflict contract %d %v", status, result)
				}
				unchanged(t, before)
			})
			t.Run("anonymous_csrf_member_and_pat_permissions", func(t *testing.T) {
				before := read()
				body := map[string]any{"expectedRevision": before["revision"], "links": []any{row(linkID, map[string]any{"title": "Unauthorized"})}}
				anon := newCoreBrowser(t, server.URL)
				anon.bootstrap()
				if status, _ := anon.call("POST", path, body); status != 401 {
					t.Fatalf("Anon HTTP %d", status)
				}
				result := navigationEditTestRequest(server.URL, owner.client, owner.csrf+"-invalid", "", path, body)
				if result.err != nil || result.status != 403 {
					t.Fatalf("CSRF %d %v", result.status, result.err)
				}
				owner.ok("POST", "/admin/users", map[string]any{"username": "batchmember", "displayName": "Batch member", "password": "member test password 2026"})
				member := newCoreBrowser(t, server.URL)
				member.bootstrap()
				member.ok("POST", "/auth/login", map[string]any{"username": "batchmember", "password": "member test password 2026"})
				member.bootstrap()
				if status, _ := member.call("POST", path, body); status != 403 {
					t.Fatalf("Member HTTP %d", status)
				}
				unchanged(t, before)
				issue := func(name string, actions []string) string {
					return owner.ok("POST", "/integrations/tokens", map[string]any{"name": name, "spaceId": shared, "actions": actions, "expiresAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)})["token"].(string)
				}
				readonly := issue("Readonly", []string{"navigation:read"})
				result = navigationEditTestRequest(server.URL, nil, "", readonly, path, body)
				if result.err != nil || result.status != 403 {
					t.Fatalf("Readonly PAT %d %v", result.status, result.err)
				}
				unchanged(t, before)
				writable := issue("Writable", []string{"navigation:read", "navigation:write"})
				body["links"] = []any{row(linkID, map[string]any{"title": "Scoped PAT update"})}
				result = navigationEditTestRequest(server.URL, nil, "", writable, path, body)
				if result.err != nil || result.status != 200 {
					t.Fatalf("Writable PAT %d %v", result.status, result.err)
				}
				navigationEditTestRevision(t, before["revision"], read()["revision"], 1)
				input := coreLink("Scoped private link", "https://scope.example.invalid/")
				input["iconMode"] = "manual"
				privateLink := owner.ok("POST", "/spaces/"+personal+"/links", input)["id"].(string)
				privateBefore := owner.ok("GET", "/spaces/"+personal+"/navigation", nil)
				result = navigationEditTestRequest(server.URL, nil, "", writable, "/spaces/"+personal+"/navigation/batch-edit", map[string]any{"expectedRevision": privateBefore["revision"], "links": []any{row(privateLink, map[string]any{"title": "Forbidden PAT space"})}})
				if result.err != nil || result.status != 404 {
					t.Fatalf("Foreign PAT %d %v", result.status, result.err)
				}
				privateAfter := owner.ok("GET", "/spaces/"+personal+"/navigation", nil)
				if privateBefore["revision"] != privateAfter["revision"] || !reflect.DeepEqual(privateBefore["data"], privateAfter["data"]) {
					t.Fatal("Out-of-scope changed private data")
				}
			})
			t.Run("concurrent_one_winner", func(t *testing.T) {
				before := read()
				results := make(chan navigationEditHTTPResult, 2)
				for _, title := range []string{"Concurrent A", "Concurrent B"} {
					body := map[string]any{"expectedRevision": before["revision"], "links": []any{row(linkID, map[string]any{"title": title})}}
					go func() { results <- navigationEditTestRequest(server.URL, owner.client, owner.csrf, "", path, body) }()
				}
				statuses := []int{}
				for i := 0; i < 2; i++ {
					result := <-results
					if result.err != nil {
						t.Fatal(result.err)
					}
					statuses = append(statuses, result.status)
				}
				sort.Ints(statuses)
				if !reflect.DeepEqual(statuses, []int{200, 409}) {
					t.Fatalf("Concurrent %v", statuses)
				}
				navigationEditTestRevision(t, before["revision"], read()["revision"], 1)
			})
			t.Run("500_and_501", func(t *testing.T) {
				rows := make([]any, 0, 501)
				for i := 0; i < 501; i++ {
					id := fmt.Sprintf("batch-limit-%03d", i)
					navigationEditTestInsertCategory(t, app, shared, id, fmt.Sprintf("Before %03d", i), nil)
					rows = append(rows, row(id, map[string]any{"name": fmt.Sprintf("After %03d", i)}))
				}
				before := read()
				status, result := post(rows[:500], nil)
				if status != 200 || result["updatedCount"] != float64(500) || len(result["categories"].([]any)) != 500 {
					t.Fatalf("500: %d %v", status, result["updatedCount"])
				}
				after := read()
				navigationEditTestRevision(t, before["revision"], after["revision"], 1)
				for i := 0; i < 500; i++ {
					if navigationEditTestRow(t, after, "categories", fmt.Sprintf("batch-limit-%03d", i))["name"] != fmt.Sprintf("After %03d", i) {
						t.Fatal("Missed batch row")
					}
				}
				if status, _ := post(rows, nil); status != 400 {
					t.Fatalf("501 HTTP %d", status)
				}
				unchanged(t, after)
			})
			t.Run("automatic_icon_preserved_without_queue", func(t *testing.T) {
				input := coreLink("Auto before", "https://auto.example.invalid/start")
				input["iconMode"] = "manual"
				id := owner.ok("POST", "/spaces/"+shared+"/links", input)["id"].(string)
				_, err := app.store.DB.ExecContext(context.Background(), app.store.Query("UPDATE links SET icon=?,icon_mode=?,icon_origin=? WHERE id=? AND space_id=?"), "lucide:star", "auto", "https://auto.example.invalid", id, shared)
				if err != nil {
					t.Fatal(err)
				}
				jobs := navigationEditTestJobCount(t, app, shared)
				status, result := post(nil, []any{row(id, map[string]any{"title": "Auto after"})})
				if status != 200 || result["updatedCount"] != float64(1) {
					t.Fatal("Title update failed")
				}
				got := navigationEditTestRow(t, read(), "links", id)
				if got["icon"] != "lucide:star" || got["iconMode"] != "auto" || got["url"] != input["url"] {
					t.Fatal("Title update changed auto icon")
				}
				if navigationEditTestJobCount(t, app, shared) != jobs {
					t.Fatal("Title update queued work")
				}
			})
			t.Run("commit_failure_rolls_back_everything", func(t *testing.T) {
				navigationEditTestCommitFailure(t, app, provider)
				before := read()
				jobs := navigationEditTestJobCount(t, app, shared)
				status, _ := post([]any{row(aID, map[string]any{"name": "Rollback"})}, []any{row(linkID, map[string]any{"title": "Rollback", "url": "https://commit-failure.example.invalid/new", "iconMode": "auto"})})
				if status != 500 {
					t.Fatalf("Commit failure HTTP %d", status)
				}
				unchanged(t, before)
				if navigationEditTestJobCount(t, app, shared) != jobs {
					t.Fatal("Failed commit retained icon work")
				}
				var n int
				if err := app.store.DB.QueryRow("SELECT COUNT(*) FROM navigation_failure_probe").Scan(&n); err != nil || n != 0 {
					t.Fatalf("Rollback probe %d %v", n, err)
				}
			})
		})
	}
}

type navigationEditHTTPResult struct {
	status int
	body   map[string]any
	err    error
}

func navigationEditTestRequest(base string, client *http.Client, csrf, token, path string, body any) navigationEditHTTPResult {
	payload, err := json.Marshal(body)
	if err != nil {
		return navigationEditHTTPResult{err: err}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(base, "/")+"/api/v1"+path, bytes.NewReader(payload))
	if err != nil {
		return navigationEditHTTPResult{err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", base)
	if csrf != "" {
		req.Header.Set("X-CSRF-TOKEN", csrf)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(req)
	if err != nil {
		return navigationEditHTTPResult{err: err}
	}
	defer response.Body.Close()
	result := navigationEditHTTPResult{status: response.StatusCode}
	if err := json.NewDecoder(response.Body).Decode(&result.body); err != nil {
		result.err = fmt.Errorf("HTTP %d decode: %w", response.StatusCode, err)
	}
	return result
}
func navigationEditTestRow(t *testing.T, navigation map[string]any, collection, id string) map[string]any {
	t.Helper()
	for _, raw := range navigation["data"].(map[string]any)[collection].([]any) {
		row := raw.(map[string]any)
		if row["id"] == id {
			return row
		}
	}
	t.Fatalf("Missing %s %s", collection, id)
	return nil
}
func navigationEditTestRevision(t *testing.T, before, after any, increment int64) {
	t.Helper()
	old, err := strconv.ParseInt(before.(string), 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	current, err := strconv.ParseInt(after.(string), 10, 64)
	if err != nil || current != old+increment {
		t.Fatalf("Revision %v -> %v wanted +%d", before, after, increment)
	}
}
func navigationEditTestError(body map[string]any) map[string]any {
	if nested, ok := body["error"].(map[string]any); ok {
		return nested
	}
	return body
}
func navigationEditTestInsertCategory(t *testing.T, app *App, space, id, name string, parent any) {
	t.Helper()
	_, err := app.store.DB.Exec(app.store.Query("INSERT INTO categories(id,space_id,parent_id,name,icon,sort_order) VALUES(?,?,?,?,?,?)"), id, space, parent, name, "lucide:folder", 0)
	if err != nil {
		t.Fatal(err)
	}
}
func navigationEditTestJobCount(t *testing.T, app *App, space string) int {
	t.Helper()
	var n int
	if err := app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM icon_favicon_jobs WHERE space_id=?"), space).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
func navigationEditTestCommitFailure(t *testing.T, app *App, provider string) {
	t.Helper()
	statements := []string{"CREATE TABLE navigation_failure_target(id INTEGER PRIMARY KEY)", "CREATE TABLE navigation_failure_probe(target_id INTEGER REFERENCES navigation_failure_target(id) DEFERRABLE INITIALLY DEFERRED)"}
	if provider == "sqlite" {
		statements = append(statements, "CREATE TRIGGER navigation_batch_commit_failure AFTER UPDATE ON links BEGIN INSERT INTO navigation_failure_probe(target_id) VALUES(1); END")
	} else {
		statements = append(statements, "CREATE FUNCTION navigation_batch_force_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO navigation_failure_probe(target_id) VALUES(1); RETURN NEW; END; $$", "CREATE TRIGGER navigation_batch_commit_failure AFTER UPDATE ON links FOR EACH ROW EXECUTE FUNCTION navigation_batch_force_failure()")
	}
	for _, s := range statements {
		if _, err := app.store.DB.Exec(s); err != nil {
			t.Fatal(err)
		}
	}
}
