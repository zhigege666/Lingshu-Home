package home

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
)

type workStatusFixture struct {
	app      *App
	owner    *coreBrowser
	space    string
	personal string
	base     string
}

func newWorkStatusFixture(t *testing.T, provider string) *workStatusFixture {
	t.Helper()
	app, server := newAccountProfileHTTPFixture(t, provider)
	owner := newCoreBrowser(t, server.URL)
	owner.bootstrap()
	owner.ok("POST", "/setup", map[string]any{"siteName": "Status fixture", "mode": ModePublicRead, "username": "owner", "password": "status fixture password", "seedDemo": false})
	boot := owner.bootstrap()
	space := coreSpace(boot, "shared")
	return &workStatusFixture{app, owner, space, coreSpace(boot, "personal"), "/spaces/" + space + "/work"}
}

func workStatusTestCatalog(t *testing.T, body map[string]any) WorkStatusCatalog {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	var catalog WorkStatusCatalog
	if err = json.Unmarshal(encoded, &catalog); err != nil {
		t.Fatal(err)
	}
	if catalog.Revision == "" || catalog.DefaultStatus == "" || len(catalog.Items) == 0 {
		t.Fatalf("incomplete status catalog: %v", body)
	}
	return catalog
}

func workStatusTestDefinition(t *testing.T, catalog WorkStatusCatalog, id string) WorkStatusDefinition {
	t.Helper()
	for _, item := range catalog.Items {
		if item.ID == id {
			return item
		}
	}
	t.Fatalf("missing status %s", id)
	return WorkStatusDefinition{}
}

func workStatusTestCode(t *testing.T, body map[string]any, want string) map[string]any {
	t.Helper()
	err := navigationEditTestError(body)
	if err["code"] != want {
		t.Fatalf("error code=%v want=%s: %v", err["code"], want, body)
	}
	return err
}

func workStatusTestRows(t *testing.T, db *sql.DB, table string, columns []string) componentMigrationRows {
	t.Helper()
	rows := componentCaptureRows(t, db, table, columns)
	// A composite key's first column is not a deterministic row order.
	sort.Slice(rows.values, func(i, j int) bool {
		left, _ := json.Marshal(rows.values[i])
		right, _ := json.Marshal(rows.values[j])
		return string(left) < string(right)
	})
	return rows
}

func TestWorkStatusesCatalogAndSemantics(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			initial := workStatusTestCatalog(t, f.owner.ok("GET", f.base+"/statuses", nil))
			if len(initial.Items) != 4 || initial.DefaultStatus != "todo" || !initial.CanEdit {
				t.Fatal("new space does not have editable legacy defaults")
			}
			review, accepted, canceled := newID(), newID(), newID()
			order := []string{"todo", "doing", review, "waiting", accepted, "done", canceled}
			catalog := workStatusTestCatalog(t, f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{
				"expectedRevision": initial.Revision,
				"create": []map[string]any{
					{"id": review, "name": "Review", "type": "waiting", "description": "Await a user's acceptance", "color": "#AABBCC"},
					{"id": accepted, "name": "Accepted", "type": "done"},
					{"id": canceled, "name": "Canceled", "type": "canceled"},
				},
				"order": order, "defaultStatus": review,
			}))
			navigationEditTestRevision(t, initial.Revision, catalog.Revision, 1)
			for i, id := range order {
				if catalog.Items[i].ID != id || catalog.Items[i].Position != i || catalog.Items[i].IsDefault != (id == review) {
					t.Fatal("catalog order/default is inconsistent")
				}
			}
			if workStatusTestDefinition(t, catalog, review).Color != "#aabbcc" {
				t.Fatal("color was not normalized")
			}
			item := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Use configured default", "needsAttention": true})
			if item["status"] != review {
				t.Fatal("create ignored dynamic default")
			}
			id := item["id"].(string)
			// Renaming and reordering must preserve the stable key and existing item revision.
			order = []string{review, "todo", "doing", "waiting", accepted, "done", canceled}
			catalog = workStatusTestCatalog(t, f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{
				"expectedRevision": catalog.Revision,
				"patches":          []map[string]any{{"id": review, "name": "Await acceptance", "description": "Wait until the requested checks have been accepted"}},
				"order":            order,
			}))
			current := f.owner.ok("GET", workItemPath(f.space, id), nil)
			if current["status"] != review || current["revision"] != item["revision"] {
				t.Fatal("metadata rename changed an item's identity or revision")
			}
			board := f.owner.ok("GET", f.base+"/board", nil)
			columns := board["columns"].([]any)
			if len(columns) != len(order) || board["statusRevision"] != catalog.Revision || board["defaultStatus"] != review || len(board["statuses"].([]any)) != len(order) {
				t.Fatal("board did not expose the current dynamic catalog")
			}
			for i, id := range order {
				if columns[i].(map[string]any)["status"] != id {
					t.Fatal("board columns did not follow configured order")
				}
			}
			page := f.owner.ok("GET", f.base+"/items?status="+review, nil)
			if page["total"] != float64(1) || page["statusRevision"] != catalog.Revision {
				t.Fatal("dynamic status filter or list metadata is missing")
			}
			for _, target := range []struct{ id, kind string }{{accepted, "done"}, {canceled, "canceled"}} {
				current = f.owner.ok("PATCH", workItemPath(f.space, id), map[string]any{"expectedRevision": current["revision"], "status": target.id})
				definition, ok := current["statusDefinition"].(map[string]any)
				if !ok || definition["type"] != target.kind || current["needsAttention"] != true || current["archived"] != false || current["result"] != "" {
					t.Fatal("terminal meaning, attention, archive or optional result were conflated")
				}
			}
			statusWant(t, f.owner, 400, "POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog.Revision, "patches": []map[string]any{{"id": "done", "type": "doing"}}})
			// A custom semantic change is explicit and invalidates affected item revisions.
			catalog = workStatusTestCatalog(t, f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog.Revision, "patches": []map[string]any{{"id": canceled, "type": "waiting"}}}))
			changed := f.owner.ok("GET", workItemPath(f.space, id), nil)
			if changed["status"] != canceled || changed["revision"] == current["revision"] || workStatusTestDefinition(t, catalog, canceled).Type != "waiting" {
				t.Fatal("explicit semantic change did not invalidate affected items")
			}
		})
	}
}

func TestWorkStatusesRetirementReferencesAndReplay(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			catalog := workStatusTestCatalog(t, f.owner.ok("GET", f.base+"/statuses", nil))
			review := newID()
			catalog = workStatusTestCatalog(t, f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog.Revision, "create": []map[string]any{{"id": review, "name": "Review", "type": "waiting"}}}))
			link := f.owner.ok("POST", "/spaces/"+f.space+"/links", coreLink("Retain bookmark", "https://example.com/status-reference"))
			f.app.config.DocumentRoots = []string{t.TempDir()}
			docFixture := &documentFixture{app: f.app, owner: f.owner, root: f.app.config.DocumentRoots[0], shared: f.space, personal: f.personal}
			docFixture.source(t, f.space, "notes", false, map[string]string{"status.md": "# Preserved original\n"})
			document := documentByPath(t, f.owner, f.space, "status.md")
			omittedBody := map[string]any{"id": newID(), "title": "Original default request"}
			original := f.owner.ok("POST", f.base+"/items", omittedBody)
			legacyBody := map[string]any{"id": newID(), "title": "Legacy omitted-status request"}
			legacy := f.owner.ok("POST", f.base+"/items", legacyBody)
			// Version 0.1.1 hashed its resolved default, before hash-version metadata existed.
			legacyHash := workPayloadHash(workCreateInput{ID: legacy["id"].(string), Title: legacyBody["title"].(string), Status: "todo", BookmarkIDs: []string{}, DocumentIDs: []string{}})
			if _, err := f.app.store.DB.Exec(f.app.store.Query("UPDATE work_items SET create_hash=?,create_hash_version=1 WHERE id=?"), legacyHash, legacy["id"]); err != nil {
				t.Fatal(err)
			}
			linkedBody := map[string]any{"id": newID(), "title": "Linked active request", "status": review, "bookmarkIds": []string{link["id"].(string)}, "documentIds": []string{document["id"].(string)}, "needsAttention": true}
			active := f.owner.ok("POST", f.base+"/items", linkedBody)
			archived := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Archived review", "status": review})
			archived = f.owner.ok("PATCH", workItemPath(f.space, archived["id"].(string)), map[string]any{"expectedRevision": archived["revision"], "archived": true})
			existingTail := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Existing target tail", "status": "waiting"})
			catalog = workStatusTestCatalog(t, f.owner.ok("GET", f.base+"/statuses", nil))
			if status := workStatusTestDefinition(t, catalog, review); status.Total != 1 || status.ArchivedTotal != 1 {
				t.Fatal("retirement counts omitted active or archived items")
			}
			errBody := statusWant(t, f.owner, 409, "POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog.Revision, "deletions": []map[string]any{{"id": review}}})
			workStatusTestCode(t, errBody, "work_status_in_use")
			catalog = workStatusTestCatalog(t, f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog.Revision, "defaultStatus": review}))
			for _, body := range []map[string]any{omittedBody, legacyBody} {
				replayed := f.owner.ok("POST", f.base+"/items", body)
				if replayed["status"] != "todo" || replayed["revision"] != original["revision"] {
					t.Fatal("new default reinterpreted a successful omitted-status creation")
				}
			}
			deletions := []map[string]any{{"id": review, "moveToStatus": "waiting"}, {"id": "todo", "moveToStatus": "waiting"}}
			errBody = statusWant(t, f.owner, 400, "POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog.Revision, "deletions": deletions})
			workStatusTestCode(t, errBody, "work_default_status_required")
			catalog = workStatusTestCatalog(t, f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog.Revision, "deletions": deletions, "defaultStatus": "doing"}))
			if len(catalog.Items) != 3 || catalog.DefaultStatus != "doing" {
				t.Fatal("retirement retained deleted columns or lost the new default")
			}
			for _, record := range []map[string]any{active, archived, original, legacy} {
				current := f.owner.ok("GET", workItemPath(f.space, record["id"].(string)), nil)
				if current["status"] != "waiting" || current["archived"] != record["archived"] || current["revision"] == record["revision"] {
					t.Fatal("retirement did not migrate both active and archived items")
				}
			}
			beforeReplay := f.owner.ok("GET", f.base+"/revision", nil)
			for _, body := range []map[string]any{omittedBody, legacyBody, linkedBody} {
				current := f.owner.ok("POST", f.base+"/items", body)
				if current["id"] != body["id"] || current["status"] != "waiting" {
					t.Fatal("retry after retirement duplicated or resurrected an old state")
				}
			}
			if !reflect.DeepEqual(beforeReplay, f.owner.ok("GET", f.base+"/revision", nil)) {
				t.Fatal("successful replay changed revisions")
			}
			if count := f.owner.ok("GET", f.base+"/items", nil)["total"]; count != float64(4) {
				t.Fatalf("retries duplicated active items: %v", count)
			}
			ids := workIDsFromPage(f.owner.ok("GET", f.base+"/items?status=waiting", nil))
			if !reflect.DeepEqual(ids, []string{existingTail["id"].(string), active["id"].(string), original["id"].(string), legacy["id"].(string)}) {
				t.Fatalf("migration failed to preserve the target tail: %v", ids)
			}
			current := f.owner.ok("GET", workItemPath(f.space, active["id"].(string)), nil)
			if current["referenceCount"] != float64(2) || len(current["references"].([]any)) != 2 || current["needsAttention"] != true {
				t.Fatal("state migration altered references or attention")
			}
			originalFile, err := os.ReadFile(filepath.Join(docFixture.root, "notes", "status.md"))
			if err != nil || string(originalFile) != "# Preserved original\n" {
				t.Fatal("state migration altered the original document", err)
			}
			errBody = statusWant(t, f.owner, 400, "POST", f.base+"/items", map[string]any{"id": newID(), "title": "Retired key", "status": review})
			unavailable := workStatusTestCode(t, errBody, "work_status_unavailable")
			details, ok := unavailable["details"].(map[string]any)
			if !ok || details["replacementStatus"] != "waiting" || details["statusRevision"] != catalog.Revision {
				t.Fatal("retired key error did not explain recovery")
			}
			errBody = statusWant(t, f.owner, 409, "POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog.Revision, "create": []map[string]any{{"id": review, "name": "Different meaning", "type": "done"}}})
			workStatusTestCode(t, errBody, "work_status_id_conflict")
		})
	}
}

func TestWorkStatusesConcurrencyAndScope(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			catalog := workStatusTestCatalog(t, f.owner.ok("GET", f.base+"/statuses", nil))
			var wait sync.WaitGroup
			codes := make(chan int, 2)
			start := make(chan struct{})
			for _, name := range []string{"First edit", "Second edit"} {
				wait.Add(1)
				go func(name string) {
					defer wait.Done()
					<-start
					code, body := f.owner.call("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog.Revision, "patches": []map[string]any{{"id": "todo", "name": name}}})
					if code == 409 && navigationEditTestError(body)["code"] != "work_status_version_conflict" {
						t.Errorf("unexpected concurrent failure: %v", body)
					}
					codes <- code
				}(name)
			}
			close(start)
			wait.Wait()
			close(codes)
			counts := map[int]int{}
			for code := range codes {
				counts[code]++
			}
			if counts[200] != 1 || counts[409] != 1 {
				t.Fatalf("configuration lost a concurrent update: %v", counts)
			}
			current := workStatusTestCatalog(t, f.owner.ok("GET", f.base+"/statuses", nil))
			navigationEditTestRevision(t, catalog.Revision, current.Revision, 1)
			privateBase := "/spaces/" + f.personal + "/work"
			privateCatalog := workStatusTestCatalog(t, f.owner.ok("GET", privateBase+"/statuses", nil))
			foreign := newID()
			f.owner.ok("POST", privateBase+"/statuses/batch-edit", map[string]any{"expectedRevision": privateCatalog.Revision, "create": []map[string]any{{"id": foreign, "name": "Private status canary", "type": "waiting"}}})
			errBody := statusWant(t, f.owner, 400, "POST", f.base+"/items", map[string]any{"id": newID(), "title": "Foreign status", "status": foreign})
			workStatusTestCode(t, errBody, "work_status_unavailable")
			encoded, _ := json.Marshal(errBody)
			if strings.Contains(string(encoded), "Private status canary") {
				t.Fatal("foreign status lookup disclosed another space's catalog")
			}
			auth := &integrationTestBrowser{t: t, base: f.owner.base, client: f.owner.client, csrf: f.owner.csrf}
			caller := integrationBrowser(t, f.owner.base)
			read, _ := auth.token(f.space, "", "work:read")
			write, _ := auth.token(f.space, "", "work:write")
			readCatalog := caller.object("GET", "/api/v1"+f.base+"/statuses", nil, 200, read)
			if readCatalog["canEdit"] != false {
				t.Fatal("read-only credential was advertised as able to configure states")
			}
			patch := map[string]any{"expectedRevision": current.Revision, "patches": []map[string]any{{"id": "todo", "description": "Configured with write scope"}}}
			caller.object("POST", "/api/v1"+f.base+"/statuses/batch-edit", patch, 403, read)
			receipt := caller.object("POST", "/api/v1"+f.base+"/statuses/batch-edit", patch, 200, write)
			if receipt["applied"] != true || receipt["revision"] == nil || receipt["boardRevision"] == nil || len(receipt) != 3 {
				t.Fatalf("write-only catalog update leaked data or lacked a receipt: %v", receipt)
			}
			caller.object("GET", "/api/v1"+f.base+"/statuses", nil, 403, write)
			body := caller.object("POST", "/api/v1"+f.base+"/items", map[string]any{"id": newID(), "title": "Unknown write-only status", "status": foreign}, 400, write)
			unavailable := workStatusTestCode(t, body, "work_status_unavailable")
			if unavailable["details"] != nil {
				t.Fatal("write-only error disclosed readable state metadata")
			}
			anonymous := newCoreBrowser(t, f.owner.base)
			anonymous.bootstrap()
			statusWant(t, anonymous, 401, "GET", f.base+"/statuses", nil)
		})
	}
}

func TestWorkStatusesLateFailureRollsBackBatch(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			catalog := workStatusTestCatalog(t, f.owner.ok("GET", f.base+"/statuses", nil))
			review := newID()
			catalog = workStatusTestCatalog(t, f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog.Revision, "create": []map[string]any{{"id": review, "name": "Review", "type": "waiting"}}}))
			link := f.owner.ok("POST", "/spaces/"+f.space+"/links", coreLink("Rollback link", "https://example.com/rollback"))
			for _, archived := range []bool{false, true} {
				item := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Migrate atomically", "status": review, "bookmarkIds": []string{link["id"].(string)}})
				if archived {
					f.owner.ok("PATCH", workItemPath(f.space, item["id"].(string)), map[string]any{"expectedRevision": item["revision"], "archived": true})
				}
			}
			before := map[string]componentMigrationRows{}
			for _, table := range []string{"work_spaces", "work_statuses", "work_items", "work_item_links", "work_item_documents"} {
				before[table] = workStatusTestRows(t, f.app.store.DB, table, nil)
			}
			// This runs after definitions and item migrations have been written, immediately
			// before the configuration revision would make the operation visible.
			statements := []string{"CREATE TRIGGER status_batch_fail BEFORE UPDATE OF status_revision ON work_spaces BEGIN SELECT RAISE(ABORT,'intentional status batch failure'); END"}
			if provider == "postgres" {
				statements = []string{"CREATE FUNCTION status_batch_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional status batch failure'; END $$", "CREATE TRIGGER status_batch_fail BEFORE UPDATE OF status_revision ON work_spaces FOR EACH ROW EXECUTE FUNCTION status_batch_fail_fn()"}
			}
			for _, statement := range statements {
				if _, err := f.app.store.DB.Exec(statement); err != nil {
					t.Fatal(err)
				}
			}
			statusWant(t, f.owner, 500, "POST", f.base+"/statuses/batch-edit", map[string]any{
				"expectedRevision": catalog.Revision,
				"create":           []map[string]any{{"id": newID(), "name": "Must not remain", "type": "done"}},
				"patches":          []map[string]any{{"id": "waiting", "name": "Must roll back"}},
				"deletions":        []map[string]any{{"id": review, "moveToStatus": "waiting"}},
				"defaultStatus":    "doing",
			})
			for table, original := range before {
				if !reflect.DeepEqual(original, workStatusTestRows(t, f.app.store.DB, table, original.columns)) {
					t.Fatalf("late failure partially changed %s", table)
				}
			}
		})
	}
}
