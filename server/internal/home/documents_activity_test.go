package home

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func activityFixture(t *testing.T, postgres bool) *documentFixture {
	t.Helper()
	f := newDocumentFixture(t, postgres)
	stopIntegrationFixtureWorkers(t, f.app)
	return f
}

func activityResult(t *testing.T, f *documentFixture, query string) map[string]any {
	t.Helper()
	return f.owner.ok("GET", "/spaces/"+f.shared+"/document-activity"+query, nil)
}

func activityEventCount(t *testing.T, f *documentFixture) int {
	t.Helper()
	var n int
	if err := f.app.store.DB.QueryRow("SELECT COUNT(*) FROM document_activity").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func activitySummaryWant(t *testing.T, data map[string]any, documents, days int) {
	t.Helper()
	s := data["summary"].(map[string]any)
	if s["documents"] != float64(documents) || s["activeDays"] != float64(days) {
		t.Fatalf("activity summary: got %v, want documents=%d days=%d", s, documents, days)
	}
}

func TestDocumentActivitySQLite(t *testing.T) { testDocumentActivity(t, false) }

func TestDocumentActivityPostgres(t *testing.T) {
	dsn := os.Getenv("LINGSHU_TEST_DOCUMENT_POSTGRES_URL")
	if dsn == "" {
		t.Skip("requires isolated LINGSHU_TEST_DOCUMENT_POSTGRES_URL")
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := "document_activity_" + integrationID()
	if _, err = admin.Exec("CREATE SCHEMA " + schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec("DROP SCHEMA " + schema + " CASCADE"); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	query := u.Query()
	query.Set("search_path", schema)
	u.RawQuery = query.Encode()
	t.Setenv("LINGSHU_TEST_DOCUMENT_POSTGRES_URL", u.String())
	// The original library suite owns the database's application schema.
	// This suite opens and removes only its own randomly named schema.
	testDocumentActivity(t, true)
}

func testDocumentActivity(t *testing.T, postgres bool) {
	f := activityFixture(t, postgres)
	b := f.owner
	s := f.source(t, f.shared, "notes", false, map[string]string{"guide.md": "# A\n"})
	if activityEventCount(t, f) != 0 {
		t.Fatal("initial directory connection created fictitious activity")
	}
	initial := activityResult(t, f, "?timezone=Asia%2FShanghai")
	activitySummaryWant(t, initial, 0, 0)
	if initial["recordedFrom"] == "" || len(initial["sources"].([]any)) != 1 {
		t.Fatal("successful initial scan did not establish its recording baseline")
	}
	doc := documentByPath(t, b, f.shared, "guide.md")
	path := documentURL(f.shared, doc)
	update := func(content string) {
		doc = b.ok("PUT", path, map[string]any{"content": content, "expectedRevision": doc["revision"]})
	}
	update("# B\n")
	update("# B\n") // Saving unchanged bytes is not an edit.
	update("# A\n") // Returning to an earlier revision is a real edit.
	file := filepath.Join(f.root, "notes", "guide.md")
	if err := os.Chtimes(file, time.Now(), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	scanPath := "/spaces/" + f.shared + "/document-sources/" + s["id"].(string) + "/scan"
	b.ok("POST", scanPath, map[string]any{})
	b.ok("POST", scanPath, map[string]any{})
	if n := activityEventCount(t, f); n != 2 {
		t.Fatalf("unchanged saves, mtime or duplicate scans altered event count: %d", n)
	}
	created := b.ok("POST", "/spaces/"+f.shared+"/documents", map[string]any{"sourceId": s["id"], "relativePath": "created.md", "content": "# Created\n"})
	createdPath := documentURL(f.shared, created)
	doc = b.ok("POST", path+"/rename", map[string]any{"relativePath": "moved.md", "expectedRevision": doc["revision"]})
	doc = b.ok("PUT", path+"/metadata", map[string]any{"tags": []string{"one"}, "linkedBookmarkIds": []string{}, "expectedRevision": doc["revision"], "expectedMetadataRevision": doc["metadataRevision"]})
	doc = b.ok("PUT", path+"/metadata", map[string]any{"tags": []string{"one"}, "linkedBookmarkIds": []string{}, "expectedRevision": doc["revision"], "expectedMetadataRevision": doc["metadataRevision"]})
	deleted := b.ok("DELETE", createdPath+"?expectedRevision="+created["revision"].(string), nil)
	if deleted["status"] != "missing" {
		t.Fatal("deletion lost recovery metadata")
	}
	created = b.ok("POST", createdPath+"/restore", map[string]any{"revision": created["revision"], "expectedRevision": created["revision"]})
	created = b.ok("POST", createdPath+"/restore", map[string]any{"revision": created["revision"], "expectedRevision": created["revision"]})
	b.ok("POST", scanPath, map[string]any{})
	if n := activityEventCount(t, f); n != 7 {
		t.Fatalf("expected two edits, create, rename, metadata, delete and restore: %d", n)
	}
	data := activityResult(t, f, "?timezone=Asia%2FShanghai&limit=1")
	activitySummaryWant(t, data, 2, 1)
	if data["total"] != float64(2) || data["hasMore"] != true || len(data["items"].([]any)) != 1 {
		t.Fatalf("daily document pagination: %v", data)
	}
	day := data["days"].([]any)[0].(map[string]any)
	if day["count"] != float64(2) || day["created"] != float64(1) || day["updated"] != float64(1) {
		t.Fatalf("daily breakdown is not disjoint: %v", day)
	}
	second := activityResult(t, f, "?timezone=Asia%2FShanghai&limit=1&offset=1&date="+day["date"].(string))
	if second["hasMore"] != false || len(second["items"].([]any)) != 1 {
		t.Fatal("second page or date details failed")
	}
	activitySummaryWant(t, second, 2, 1)
	filtered := activityResult(t, f, "?sourceIds="+s["id"].(string))
	activitySummaryWant(t, filtered, 2, 1)
	// Unknown/private directory IDs cannot be used to bypass scope checks.
	private := f.source(t, f.personal, "private", false, map[string]string{"private.md": "# Private\n"})
	statusWant(t, b, 404, "GET", "/spaces/"+f.shared+"/document-activity?sourceIds="+private["id"].(string), nil)
	for _, query := range []string{"?timezone=Local", "?timezone=Invalid%2FZone", "?from=2026-02-30", "?from=2024-01-01&to=2026-01-01", "?perspective=anyone", "?limit=0", "?limit=101", "?offset=-1", "?sourceIds=bad", "?from=2026-10-01&to=2026-10-26&date=2026-09-30"} {
		statusWant(t, b, 400, "GET", "/spaces/"+f.shared+"/document-activity"+query, nil)
	}
}

func TestDocumentActivityExternalBaselineAndReconnect(t *testing.T) {
	f := activityFixture(t, false)
	s := f.source(t, f.shared, "external", true, map[string]string{"old.md": "# Before\n", "anchor.md": "# Unchanged\n"})
	sourcePath := "/spaces/" + f.shared + "/document-sources/" + s["id"].(string)
	root := filepath.Join(f.root, "external")
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0640); err != nil {
			t.Fatal(err)
		}
	}
	// Simulate an existing 0.0.5 directory at the first post-upgrade scan.
	if _, err := f.app.store.DB.Exec(f.app.store.Query("UPDATE document_sources SET activity_started_at='' WHERE id=?"), s["id"]); err != nil {
		t.Fatal(err)
	}
	write("old.md", "# Upgrade baseline\n")
	write("already-there.md", "# Already there\n")
	f.owner.ok("POST", sourcePath+"/scan", map[string]any{})
	if activityEventCount(t, f) != 0 {
		t.Fatal("upgrade baseline fabricated historic activity")
	}
	doc := documentByPath(t, f.owner, f.shared, "old.md")
	write("old.md", "# Observed external edit\n")
	write("new.md", "# New external file\n")
	f.owner.ok("POST", sourcePath+"/scan", map[string]any{})
	f.owner.ok("POST", sourcePath+"/scan", map[string]any{})
	activitySummaryWant(t, activityResult(t, f, "?perspective=mine"), 0, 0)
	library := activityResult(t, f, "?perspective=library")
	activitySummaryWant(t, library, 2, 1)
	for _, raw := range library["items"].([]any) {
		if !reflect.DeepEqual(raw.(map[string]any)["origins"], []any{"external"}) {
			t.Fatal("manual scan was attributed to the requesting user")
		}
	}
	if err := os.Rename(filepath.Join(root, "old.md"), filepath.Join(root, "renamed.md")); err != nil {
		t.Fatal(err)
	}
	f.owner.ok("POST", sourcePath+"/scan", map[string]any{})
	if moved := documentByPath(t, f.owner, f.shared, "renamed.md"); moved["id"] != doc["id"] {
		t.Fatal("unambiguous external rename lost identity")
	}
	if n := activityEventCount(t, f); n != 3 {
		t.Fatalf("external rename should add only its rename event: %d", n)
	}
	away := root + "-away"
	if err := os.Rename(root, away); err != nil {
		t.Fatal(err)
	}
	offline := f.owner.ok("POST", sourcePath+"/scan", map[string]any{})
	if offline["status"] != "offline" || activityEventCount(t, f) != 3 {
		t.Fatal("unavailable mount changed activity history")
	}
	activitySummaryWant(t, activityResult(t, f, "?perspective=library"), 2, 1)
	if err := os.Rename(away, root); err != nil {
		t.Fatal(err)
	}
	f.owner.ok("POST", sourcePath+"/scan", map[string]any{})
	f.owner.ok("DELETE", sourcePath+"?expectedRevision="+s["revision"].(string), nil)
	activitySummaryWant(t, activityResult(t, f, "?perspective=library"), 0, 0)
	reconnected := f.owner.ok("PUT", sourcePath, map[string]any{"name": "external", "readOnly": true, "enabled": true, "expectedRevision": "2", "scanIntervalSeconds": 60})
	if reconnected["status"] != "ready" || activityEventCount(t, f) != 3 {
		t.Fatal("reconnecting an unchanged mount fabricated new activity")
	}
	activitySummaryWant(t, activityResult(t, f, "?perspective=library"), 2, 1)
}

func TestDocumentActivityHomeEditBeforeUpgradeBaseline(t *testing.T) {
	f := activityFixture(t, false)
	s := f.source(t, f.shared, "upgrade", false, map[string]string{"old.md": "# Existing\n"})
	if _, err := f.app.store.DB.Exec(f.app.store.Query("UPDATE document_sources SET activity_started_at='' WHERE id=?"), s["id"]); err != nil {
		t.Fatal(err)
	}
	doc := f.owner.ok("POST", "/spaces/"+f.shared+"/documents", map[string]any{"sourceId": s["id"], "relativePath": "known.md", "content": "# Created in Home\n"})
	before := activityResult(t, f, "")
	activitySummaryWant(t, before, 1, 1)
	if before["recordedFrom"] == "" {
		t.Fatal("a known Home event before the first scan was hidden")
	}
	f.owner.ok("POST", "/spaces/"+f.shared+"/document-sources/"+s["id"].(string)+"/scan", map[string]any{})
	if n := activityEventCount(t, f); n != 1 {
		t.Fatalf("upgrade scan duplicated or swallowed the known event: %d", n)
	}
	if after := activityResult(t, f, ""); after["recordedFrom"] != before["recordedFrom"] {
		t.Fatal("baseline moved forward past a known event")
	}
	path := documentURL(f.shared, doc)
	f.owner.ok("DELETE", path+"?expectedRevision="+doc["revision"].(string), nil)
	recreated := f.owner.ok("POST", "/spaces/"+f.shared+"/documents", map[string]any{"sourceId": s["id"], "relativePath": "known.md", "content": "# Recreated\n"})
	if recreated["id"] != doc["id"] {
		t.Fatal("recreating a deleted path lost the document's identity")
	}
	var action string
	if err := f.app.store.DB.QueryRow("SELECT action FROM document_activity ORDER BY occurred_at DESC LIMIT 1").Scan(&action); err != nil || action != "restore" {
		t.Fatalf("recreated identity should be restored: %q %v", action, err)
	}
}

func TestDocumentActivityTimezonesAndDistinctDays(t *testing.T) {
	f := activityFixture(t, false)
	s := f.source(t, f.shared, "timezones", false, nil)
	doc := f.owner.ok("POST", "/spaces/"+f.shared+"/documents", map[string]any{"sourceId": s["id"], "relativePath": "time.md", "content": "# Start\n"})
	path := documentURL(f.shared, doc)
	doc = f.owner.ok("PUT", path, map[string]any{"content": "# Next\n", "expectedRevision": doc["revision"]})
	f.owner.ok("PUT", path, map[string]any{"content": "# Last\n", "expectedRevision": doc["revision"]})
	rows, err := f.app.store.DB.Query("SELECT id FROM document_activity ORDER BY occurred_at,id")
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	stamps := []string{"2026-10-25T15:59:59.999999999Z", "2026-10-25T16:00:00.000000000Z", "2026-10-25T16:00:00.100000000Z"}
	if len(ids) != len(stamps) {
		t.Fatal("fixture did not record all edits")
	}
	for i, id := range ids {
		if _, err = f.app.store.DB.Exec(f.app.store.Query("UPDATE document_activity SET occurred_at=?,observed_at=? WHERE id=?"), stamps[i], stamps[i], id); err != nil {
			t.Fatal(err)
		}
	}
	shanghai := activityResult(t, f, "?from=2026-10-25&to=2026-10-26&timezone=Asia%2FShanghai")
	activitySummaryWant(t, shanghai, 1, 2)
	if len(shanghai["days"].([]any)) != 2 || shanghai["total"] != float64(2) {
		t.Fatal("same document on two local dates was merged")
	}
	day := activityResult(t, f, "?from=2026-10-26&to=2026-10-26&timezone=Asia%2FShanghai")
	activitySummaryWant(t, day, 1, 1)
	if day["items"].([]any)[0].(map[string]any)["count"] != float64(2) {
		t.Fatal("the first fractional second of the local day was excluded")
	}
	utc := activityResult(t, f, "?from=2026-10-25&to=2026-10-26&timezone=UTC")
	activitySummaryWant(t, utc, 1, 1)
	in := documentActivityInput{From: "2026-11-01", To: "2026-11-01", Timezone: "America/New_York", Limit: 20}
	_, from, until, err := validateDocumentActivityInput(&in, time.Now())
	if err != nil || until.Sub(from) != 25*time.Hour {
		t.Fatalf("DST date boundaries did not follow the actual local day: %v %v", until.Sub(from), err)
	}
}

func TestDocumentActivityHTTPMCPAndPermissions(t *testing.T) {
	f := activityFixture(t, false)
	s := f.source(t, f.shared, "mcp", false, nil)
	owner := &integrationTestBrowser{t: t, base: f.server.URL, client: f.owner.client, csrf: f.owner.csrf}
	api := integrationBrowser(t, f.server.URL)
	full, tokenID := owner.token(f.shared, "", "documents:read", "documents:write")
	readOnly, _ := owner.token(f.shared, "", "documents:read")
	wrongScope, _ := owner.token(f.shared, "", "navigation:read")
	doc := api.tool(full, "documents_create", map[string]any{"spaceId": f.shared, "input": map[string]any{"sourceId": s["id"], "relativePath": "agent.md", "content": "# MCP\n"}}, "")
	apiDoc := api.object("POST", "/api/v1/spaces/"+f.shared+"/documents", map[string]any{"sourceId": s["id"], "relativePath": "api.md", "content": "# HTTP API\n"}, 201, full)
	result := api.tool(readOnly, "documents_activity_list", map[string]any{"spaceId": f.shared, "input": map[string]any{"perspective": "mine", "timezone": "Asia/Shanghai", "sourceIds": []string{s["id"].(string)}}}, "")
	activitySummaryWant(t, result, 2, 1)
	origins := map[string]string{}
	for _, raw := range result["items"].([]any) {
		item := raw.(map[string]any)
		origins[item["documentId"].(string)] = item["origins"].([]any)[0].(string)
	}
	if origins[doc["id"].(string)] != "mcp" || origins[apiDoc["id"].(string)] != "api" {
		t.Fatalf("MCP and bearer HTTP sources were conflated: %v", origins)
	}
	api.tool(wrongScope, "documents_activity_list", map[string]any{"spaceId": f.shared, "input": map[string]any{}}, "forbidden")
	api.object("GET", "/api/v1/spaces/"+f.personal+"/document-activity", nil, 404, full)
	visitor := newCoreBrowser(t, f.server.URL)
	visitor.bootstrap()
	statusWant(t, visitor, 401, "GET", "/spaces/"+f.shared+"/document-activity", nil)
	// Existing published content does not grant access to draft activity.
	f.owner.ok("POST", documentURL(f.shared, doc)+"/publish", map[string]any{"expectedRevision": doc["revision"], "expectedMetadataRevision": doc["metadataRevision"]})
	statusWant(t, visitor, 401, "GET", "/spaces/"+f.shared+"/document-activity?perspective=library", nil)
	owner.call("DELETE", "/api/v1/integrations/tokens/"+tokenID, nil, 200, "")
	api.object("GET", "/api/v1/spaces/"+f.shared+"/document-activity", nil, 401, full)
	f.owner.ok("PUT", "/settings", map[string]any{"siteName": "Document library fixture", "mode": ModePrivateMulti, "registrationEnabled": false})
	f.owner.bootstrap()
	f.owner.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": "document fixture password"})
	f.owner.bootstrap()
	member := f.owner.ok("POST", "/admin/users", map[string]any{"username": "activity-member", "displayName": "Activity member", "password": "activity member fixture password"})
	reader := newCoreBrowser(t, f.server.URL)
	reader.bootstrap()
	reader.ok("POST", "/auth/login", map[string]any{"username": "activity-member", "password": "activity member fixture password"})
	memberBoot := reader.bootstrap()
	memberSpace := coreSpace(memberBoot, "personal")
	statusWant(t, reader, 403, "GET", "/spaces/"+f.shared+"/document-activity?perspective=library", nil)
	statusWant(t, reader, 404, "GET", "/spaces/"+f.personal+"/document-activity", nil)
	activitySummaryWant(t, reader.ok("GET", "/spaces/"+memberSpace+"/document-activity", nil), 0, 0)
	f.owner.ok("PUT", "/admin/users/"+member["id"].(string), map[string]any{"displayName": "Activity member", "isEnabled": false})
	statusWant(t, reader, 401, "GET", "/spaces/"+memberSpace+"/document-activity", nil)
}

func TestDocumentActivityFailedCommitAndObservedMetadata(t *testing.T) {
	f := activityFixture(t, false)
	s := f.source(t, f.shared, "failure", false, map[string]string{"guide.md": "# Before\n"})
	doc := documentByPath(t, f.owner, f.shared, "guide.md")
	path := documentURL(f.shared, doc)
	if _, err := f.app.store.DB.Exec("CREATE TRIGGER fail_activity_insert BEFORE INSERT ON document_activity BEGIN SELECT RAISE(ABORT, 'injected activity failure'); END"); err != nil {
		t.Fatal(err)
	}
	failed := statusWant(t, f.owner, 503, "PUT", path, map[string]any{"content": "# File changed\n", "expectedRevision": doc["revision"]})
	if failed["code"] != "document_index_pending" || activityEventCount(t, f) != 0 {
		t.Fatal("failed transaction left a success event or hid partial file completion")
	}
	if _, err := f.app.store.DB.Exec("DROP TRIGGER fail_activity_insert"); err != nil {
		t.Fatal(err)
	}
	f.owner.ok("POST", "/spaces/"+f.shared+"/document-sources/"+s["id"].(string)+"/scan", map[string]any{})
	activitySummaryWant(t, activityResult(t, f, "?perspective=mine"), 0, 0)
	activitySummaryWant(t, activityResult(t, f, "?perspective=library"), 1, 1)
	// A tag save observes an external body change without claiming its author.
	if err := os.WriteFile(filepath.Join(f.root, "failure", "guide.md"), []byte("# Changed outside\n"), 0640); err != nil {
		t.Fatal(err)
	}
	loaded := f.owner.ok("GET", path, nil)
	f.owner.ok("PUT", path+"/metadata", map[string]any{"tags": []string{"tag"}, "linkedBookmarkIds": []string{}, "expectedRevision": loaded["revision"], "expectedMetadataRevision": loaded["metadataRevision"]})
	f.owner.ok("POST", "/spaces/"+f.shared+"/document-sources/"+s["id"].(string)+"/scan", map[string]any{})
	if n := activityEventCount(t, f); n != 3 {
		t.Fatalf("metadata observation should record one external update and one metadata event: %d", n)
	}
	activitySummaryWant(t, activityResult(t, f, "?perspective=mine"), 0, 0)
}

func TestDocumentActivityPublicationObservesExternalChange(t *testing.T) {
	f := activityFixture(t, false)
	source := f.source(t, f.shared, "publish-observation", true, map[string]string{"guide.md": "# A\n"})
	doc := documentByPath(t, f.owner, f.shared, "guide.md")
	path := documentURL(f.shared, doc)
	if activityEventCount(t, f) != 0 {
		t.Fatal("initial scan fabricated an edit")
	}
	if err := os.WriteFile(filepath.Join(f.root, "publish-observation", "guide.md"), []byte("# B\n"), 0640); err != nil {
		t.Fatal(err)
	}
	loaded := f.owner.ok("GET", path, nil)
	if loaded["revision"] == doc["revision"] || loaded["content"] != "# B\n" || activityEventCount(t, f) != 0 {
		t.Fatal("GET did not read the external revision independently of the index/scan")
	}
	input := map[string]any{"expectedRevision": loaded["revision"], "expectedMetadataRevision": loaded["metadataRevision"]}
	f.owner.ok("POST", path+"/publish", input)
	if activityEventCount(t, f) != 1 {
		t.Fatal("publishing before a scan lost or duplicated the observed external change")
	}
	var actor sql.NullString
	var action, origin, before, after string
	if err := f.app.store.DB.QueryRow(f.app.store.Query("SELECT actor_id,action,origin,before_revision,after_revision FROM document_activity WHERE document_id=?"), doc["id"]).Scan(&actor, &action, &origin, &before, &after); err != nil {
		t.Fatal(err)
	}
	if actor.Valid || action != "update" || origin != "external" || before != doc["revision"] || after != loaded["revision"] {
		t.Fatalf("publication claimed or misclassified the external transition: actor=%v action=%s origin=%s before=%s after=%s", actor, action, origin, before, after)
	}
	mine := activityResult(t, f, "?perspective=mine")
	activitySummaryWant(t, mine, 0, 0)
	if mine["total"] != float64(0) {
		t.Fatal("publication itself became the publisher's edit")
	}
	activitySummaryWant(t, activityResult(t, f, "?perspective=library"), 1, 1)
	f.owner.ok("POST", path+"/publish", input)
	f.owner.ok("POST", "/spaces/"+f.shared+"/document-sources/"+source["id"].(string)+"/scan", map[string]any{})
	if activityEventCount(t, f) != 1 {
		t.Fatal("unchanged publication or the following scan duplicated external activity")
	}
}

func TestDocumentActivityMigrationPreservesAndRollsBack(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, rollback := range []bool{false, true} {
			t.Run(fmt.Sprintf("postgres-%v/rollback-%v", postgres, rollback), func(t *testing.T) {
				db, store := documentMigrationDB(t, postgres)
				exec := func(query string, args ...any) {
					t.Helper()
					if _, err := db.Exec(store.Query(query), args...); err != nil {
						t.Fatal(err)
					}
				}
				for _, name := range []string{"001_initial.sql", "002_integrations.sql", "003_icons.sql", "004_component_sources.sql", "005_auto_icons.sql", "006_network_routing.sql", "007_instance_language.sql", "008_document_library.sql"} {
					body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/" + name)
					if err != nil {
						t.Fatal(err)
					}
					exec(string(body))
				}
				stamp := "2026-10-25T01:02:03Z"
				exec("INSERT INTO spaces(id,name,kind,owner_user_id,published,data_revision,updated_at) VALUES(?,?,'shared',NULL,?,?,?)", "old-space", "Original", false, 12, stamp)
				exec("INSERT INTO document_sources(id,space_id,name,path,read_only,enabled) VALUES(?,?,?,?,?,?)", "old-source", "old-space", "Original source", "/original/source", true, true)
				exec("INSERT INTO documents(id,source_id,space_id,relative_path,title,revision,size,updated_at,search_text) VALUES(?,?,?,?,?,?,?,?,?)", "old-document", "old-source", "old-space", "old.md", "Old document", "unchanged-revision", 11, stamp, "# Keep body")
				before := map[string]componentMigrationRows{}
				for _, table := range []string{"settings", "users", "spaces", "pages", "links", "document_sources", "documents", "document_bookmarks", "document_published_assets"} {
					before[table] = componentCaptureRows(t, db, table, nil)
				}
				body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/009_document_activity.sql")
				if err != nil {
					t.Fatal(err)
				}
				tx, err := db.BeginTx(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				statement := string(body)
				if rollback {
					statement += "\nSELECT force_activity_migration_failure();"
				}
				_, err = tx.Exec(statement)
				if rollback {
					if err == nil {
						t.Fatal("injected failure did not fail")
					}
					_ = tx.Rollback()
				} else {
					if err != nil {
						_ = tx.Rollback()
						t.Fatal(err)
					}
					if err = tx.Commit(); err != nil {
						t.Fatal(err)
					}
				}
				for table, want := range before {
					if got := componentCaptureRows(t, db, table, want.columns); !reflect.DeepEqual(got, want) {
						t.Fatalf("migration changed existing %s", table)
					}
				}
				var baseline string
				err = db.QueryRow("SELECT activity_started_at FROM document_sources WHERE id='old-source'").Scan(&baseline)
				if rollback {
					if err == nil {
						t.Fatal("rolled-back baseline column remained")
					}
					if _, err = db.Exec("SELECT * FROM document_activity"); err == nil {
						t.Fatal("rolled-back activity table remained")
					}
					return
				}
				if err != nil || baseline != "" {
					t.Fatalf("existing directories need a new scan baseline: %q %v", baseline, err)
				}
				var n int
				if err = db.QueryRow("SELECT COUNT(*) FROM document_activity").Scan(&n); err != nil || n != 0 {
					t.Fatalf("migration fabricated historical records: %d %v", n, err)
				}
			})
		}
	}
}

func TestDocumentActivityInputSourceIDs(t *testing.T) {
	f := activityFixture(t, false)
	a := f.source(t, f.shared, "first", true, nil)
	b := f.source(t, f.shared, "second", true, nil)
	query := "?sourceIds=" + url.QueryEscape(a["id"].(string)+","+b["id"].(string)) + "&sourceIds=" + a["id"].(string)
	result := activityResult(t, f, query)
	if len(result["sources"].([]any)) != 2 {
		t.Fatal("source selector options were replaced by the current selection")
	}
}
