package home

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func TestNavigationBatchSQLite(t *testing.T)   { testNavigationBatch(t, false) }
func TestNavigationBatchPostgres(t *testing.T) { testNavigationBatch(t, true) }

func testNavigationBatch(t *testing.T, postgres bool) {
	c := coreConfig(t, false)
	if postgres {
		c.DatabaseURL = os.Getenv("LINGSHU_TEST_NAVIGATION_POSTGRES_URL")
		if c.DatabaseURL == "" {
			t.Skip("requires a fresh dedicated LINGSHU_TEST_NAVIGATION_POSTGRES_URL")
		}
		c.StorageProvider = "postgres"
	}
	a, err := Open(c)
	if err != nil {
		t.Fatal(err)
	}
	settings, err := a.loadSettings(context.Background(), a.store.DB)
	if err != nil || settings.Initialized {
		a.Close()
		t.Fatal("batch tests require a fresh dedicated database; existing data is not erased", err)
	}
	server := httptest.NewServer(a)
	t.Cleanup(func() { server.Close(); _ = a.Close() })
	owner := integrationBrowser(t, server.URL)
	owner.boot()
	owner.object("POST", "/api/v1/setup", map[string]any{"siteName": "Batch fixture", "mode": ModePrivateMulti, "username": "batch-owner", "displayName": "Owner", "password": "batch-fixture-owner-2026", "seedDemo": false}, 201, "")
	boot := owner.boot()
	shared, personal := coreSpace(boot, "shared"), coreSpace(boot, "personal")
	path := "/api/v1/spaces/" + shared
	read := func() map[string]any { t.Helper(); return owner.object("GET", path+"/navigation", nil, 200, "") }
	linksOf := func(snapshot map[string]any) map[string]map[string]any {
		out := map[string]map[string]any{}
		for _, raw := range snapshot["data"].(map[string]any)["links"].([]any) {
			link := raw.(map[string]any)
			out[link["id"].(string)] = link
		}
		return out
	}
	makeCategory := func(space, name string) string {
		t.Helper()
		return owner.object("POST", "/api/v1/spaces/"+space+"/categories", map[string]any{"name": name, "icon": "lucide:folder", "parentId": nil, "sortOrder": 0}, 201, "")["id"].(string)
	}
	category, foreignCategory := makeCategory(shared, "Work"), makeCategory(personal, "Private")
	create := func(space, title string, tags []string) string {
		t.Helper()
		body := coreLink(title, "https://example.org/"+title)
		body["iconMode"] = "manual"
		body["description"] = "Preserve me"
		body["tags"] = tags
		body["sortOrder"] = 7
		body["endpoints"] = []Endpoint{{Label: "Alternative", URL: "https://example.org/alt"}}
		return owner.object("POST", "/api/v1/spaces/"+space+"/links", body, 201, "")["id"].(string)
	}
	first, second, untouched := create(shared, "first", []string{"keep", "remove"}), create(shared, "second", []string{"keep"}), create(shared, "untouched", []string{"keep"})
	foreign := create(personal, "private", []string{})
	ids := []string{first, second}
	batch := func(operation string, values map[string]any) map[string]any {
		t.Helper()
		input := map[string]any{"operation": operation, "linkIds": ids, "expectedRevision": read()["revision"]}
		for key, value := range values {
			input[key] = value
		}
		return input
	}
	expectUnchanged := func(before map[string]any) {
		t.Helper()
		after := read()
		if before["revision"] != after["revision"] || !reflect.DeepEqual(before["data"], after["data"]) || before["meta"].(map[string]any)["sourceUpdatedAt"] != after["meta"].(map[string]any)["sourceUpdatedAt"] {
			t.Fatal("rejected/no-op batch changed persisted navigation")
		}
	}
	apply := func(operation string, values map[string]any, count int) {
		t.Helper()
		before := read()
		result := owner.object("POST", path+"/links/batch", batch(operation, values), 200, "")
		if result["updatedCount"] != float64(count) || result["selectedCount"] != float64(len(ids)) {
			t.Fatalf("wrong batch counts: %v", result)
		}
		after := read()
		rev, _ := strconv.Atoi(before["revision"].(string))
		if count > 0 {
			rev++
		}
		if after["revision"] != strconv.Itoa(rev) || result["revision"] != after["revision"] {
			t.Fatal("batch must advance navigation revision exactly once")
		}
		oldLinks, newLinks := linksOf(before), linksOf(after)
		if !reflect.DeepEqual(oldLinks[untouched], newLinks[untouched]) {
			t.Fatal("unselected link changed")
		}
		for _, id := range ids {
			old, next := integrationClone(oldLinks[id]), integrationClone(newLinks[id])
			delete(old, "updatedAt")
			delete(next, "updatedAt")
			field := "tags"
			if operation == "move" {
				field = "categoryId"
			}
			if operation == "favorite" {
				field = "isFavorite"
			}
			delete(old, field)
			delete(next, field)
			if !reflect.DeepEqual(old, next) {
				t.Fatalf("%s rewrote unrelated bookmark fields", operation)
			}
		}
		if count == 0 {
			expectUnchanged(before)
		}
	}
	deleteBatch := func(t *testing.T, selection []string, token string) map[string]any {
		t.Helper()
		before := read()
		foreignBefore := owner.object("GET", "/api/v1/spaces/"+personal+"/navigation", nil, 200, "")
		input := map[string]any{"operation": "delete", "linkIds": selection, "expectedRevision": before["revision"]}
		result := owner.object("POST", path+"/links/batch", input, 200, token)
		if result["selectedCount"] != float64(len(selection)) || result["deletedCount"] != float64(len(selection)) || result["updatedCount"] != float64(0) {
			t.Fatalf("wrong delete counts: %v", result)
		}
		after := read()
		revision, _ := strconv.Atoi(before["revision"].(string))
		if after["revision"] != strconv.Itoa(revision+1) || result["revision"] != after["revision"] {
			t.Fatal("batch deletion must advance navigation revision exactly once")
		}
		expected := linksOf(before)
		for _, id := range selection {
			if _, exists := expected[id]; !exists {
				t.Fatal("test selected a missing link", id)
			}
			delete(expected, id)
		}
		if !reflect.DeepEqual(expected, linksOf(after)) || !reflect.DeepEqual(before["data"].(map[string]any)["categories"], after["data"].(map[string]any)["categories"]) {
			t.Fatal("batch deletion changed unselected links or categories")
		}
		foreignAfter := owner.object("GET", "/api/v1/spaces/"+personal+"/navigation", nil, 200, "")
		if !reflect.DeepEqual(foreignBefore["data"], foreignAfter["data"]) || foreignBefore["revision"] != foreignAfter["revision"] {
			t.Fatal("batch deletion changed another space")
		}
		return result
	}
	t.Run("targeted-changes-and-noops", func(t *testing.T) {
		apply("move", map[string]any{"categoryId": category}, 2)
		for _, id := range ids {
			if linksOf(read())[id]["categoryId"] != category {
				t.Fatal("move not persisted")
			}
		}
		apply("move", map[string]any{"categoryId": category}, 0)
		apply("move", map[string]any{"categoryId": category, "tags": []string{}, "isFavorite": nil}, 0)
		apply("add-tags", map[string]any{"tags": []string{" new ", "new", "keep"}}, 2)
		for _, id := range ids {
			tags := linksOf(read())[id]["tags"].([]any)
			if tags[len(tags)-1] != "new" {
				t.Fatal("normalized tag missing")
			}
		}
		apply("remove-tags", map[string]any{"tags": []string{"remove", "absent"}}, 1)
		apply("favorite", map[string]any{"isFavorite": true}, 2)
		apply("favorite", map[string]any{"isFavorite": true}, 0)
		apply("favorite", map[string]any{"isFavorite": false}, 2)
		apply("move", map[string]any{"categoryId": nil}, 2)
		for _, id := range ids {
			if linksOf(read())[id]["categoryId"] != nil {
				t.Fatal("uncategorized move failed")
			}
		}
	})
	t.Run("invalid-batches-and-cross-space-atomicity", func(t *testing.T) {
		many := make([]string, 501)
		for i := range many {
			many[i] = fmt.Sprintf("%032x", i+1)
		}
		cases := []struct {
			name   string
			values map[string]any
			status int
		}{
			{"empty", map[string]any{"linkIds": []string{}}, 400},
			{"limit", map[string]any{"linkIds": many}, 400},
			{"duplicate", map[string]any{"linkIds": []string{first, first}}, 400},
			{"invalid-id", map[string]any{"linkIds": []string{"bad"}}, 400},
			{"missing-id", map[string]any{"linkIds": []string{first, strings.Repeat("f", 32)}}, 404},
			{"foreign-id", map[string]any{"linkIds": []string{first, foreign}}, 404},
			{"missing-revision", map[string]any{"expectedRevision": ""}, 400},
			{"stale-revision", map[string]any{"expectedRevision": "0"}, 409},
			{"unknown-field", map[string]any{"title": "must not replace"}, 400},
			{"missing-favorite", map[string]any{"isFavorite": nil}, 400},
			{"invalid-favorite-type", map[string]any{"isFavorite": "true"}, 400},
			{"invalid-tags-type", map[string]any{"tags": "unexpected"}, 400},
			{"invalid-type-before-stale-revision", map[string]any{"isFavorite": "true", "expectedRevision": "0"}, 400},
			{"mixed-operation", map[string]any{"tags": []string{"bad"}}, 400},
			{"unknown-operation", map[string]any{"operation": "remove-all"}, 400},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				before := read()
				input := batch("favorite", map[string]any{"isFavorite": true})
				for key, value := range tc.values {
					input[key] = value
				}
				owner.object("POST", path+"/links/batch", input, tc.status, "")
				expectUnchanged(before)
			})
		}
		for _, value := range []any{foreignCategory, "", 12} {
			before := read()
			owner.object("POST", path+"/links/batch", batch("move", map[string]any{"categoryId": value}), 400, "")
			expectUnchanged(before)
		}
		for _, tags := range [][]string{{}, {""}, {"bad\ncontrol"}, {strings.Repeat("界", 41)}} {
			before := read()
			owner.object("POST", path+"/links/batch", batch("add-tags", map[string]any{"tags": tags}), 400, "")
			expectUnchanged(before)
		}
		before := read()
		owner.object("POST", path+"/links/batch", batch("move", nil), 400, "")
		expectUnchanged(before)
	})
	t.Run("delete-rejects-invalid-selection-and-update-fields", func(t *testing.T) {
		many := make([]string, 501)
		for i := range many {
			many[i] = fmt.Sprintf("%032x", i+1)
		}
		for _, tc := range []struct {
			name   string
			values map[string]any
			status int
		}{
			{"empty", map[string]any{"linkIds": []string{}}, 400},
			{"limit", map[string]any{"linkIds": many}, 400},
			{"duplicate", map[string]any{"linkIds": []string{first, first}}, 400},
			{"invalid-id", map[string]any{"linkIds": []string{first, "bad"}}, 400},
			{"missing-id", map[string]any{"linkIds": []string{first, strings.Repeat("f", 32)}}, 404},
			{"foreign-id", map[string]any{"linkIds": []string{first, foreign}}, 404},
			{"missing-revision", map[string]any{"expectedRevision": ""}, 400},
			{"stale-revision", map[string]any{"expectedRevision": "0"}, 409},
			{"category", map[string]any{"categoryId": category}, 400},
			{"null-category", map[string]any{"categoryId": nil}, 400},
			{"tags", map[string]any{"tags": []string{"keep"}}, 400},
			{"empty-tags", map[string]any{"tags": []string{}}, 400},
			{"null-tags", map[string]any{"tags": nil}, 400},
			{"favorite", map[string]any{"isFavorite": false}, 400},
			{"null-favorite", map[string]any{"isFavorite": nil}, 400},
			{"unknown-field", map[string]any{"title": "unrelated"}, 400},
		} {
			t.Run(tc.name, func(t *testing.T) {
				before := read()
				owner.object("POST", path+"/links/batch", batch("delete", tc.values), tc.status, "")
				expectUnchanged(before)
			})
		}
	})
	t.Run("tag-limit-validates-entire-batch-before-write", func(t *testing.T) {
		tags := make([]string, 32)
		for i := range tags {
			tags[i] = fmt.Sprintf("tag-%d", i)
		}
		full := create(shared, "full", tags)
		originalIDs := ids
		ids = []string{first, full}
		defer func() { ids = originalIDs }()
		before := read()
		owner.object("POST", path+"/links/batch", batch("add-tags", map[string]any{"tags": []string{"overflow"}}), 400, "")
		expectUnchanged(before)
	})
	t.Run("database-failure-rolls-back-earlier-update", func(t *testing.T) {
		sqls := []string{"CREATE TABLE batch_test_calls (id TEXT NOT NULL)"}
		if postgres {
			sqls = append(sqls, "CREATE FUNCTION batch_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO batch_test_calls VALUES (NEW.id); IF (SELECT count(*) FROM batch_test_calls)>=2 THEN RAISE EXCEPTION 'intentional batch test failure'; END IF; RETURN NEW; END $$",
				"CREATE TRIGGER batch_test_failure BEFORE UPDATE OF is_favorite ON links FOR EACH ROW EXECUTE FUNCTION batch_test_fail()")
		} else {
			sqls = append(sqls, "CREATE TRIGGER batch_test_failure BEFORE UPDATE OF is_favorite ON links BEGIN INSERT INTO batch_test_calls VALUES (NEW.id); SELECT CASE WHEN (SELECT count(*) FROM batch_test_calls)>=2 THEN RAISE(ABORT,'intentional batch test failure') END; END")
		}
		for _, statement := range sqls {
			if _, err := a.store.DB.Exec(statement); err != nil {
				t.Fatal(err)
			}
		}
		before := read()
		owner.object("POST", path+"/links/batch", batch("favorite", map[string]any{"isFavorite": true}), 500, "")
		expectUnchanged(before)
		var calls int
		if err := a.store.DB.QueryRow("SELECT count(*) FROM batch_test_calls").Scan(&calls); err != nil || calls != 0 {
			t.Fatal("trigger writes were not rolled back", err)
		}
		drop := "DROP TRIGGER batch_test_failure"
		if postgres {
			drop += " ON links"
		}
		if _, err := a.store.DB.Exec(drop); err != nil {
			t.Fatal(err)
		}
		if postgres {
			if _, err := a.store.DB.Exec("DROP FUNCTION batch_test_fail()"); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := a.store.DB.Exec("DROP TABLE batch_test_calls"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("delete-database-failure-rolls-back-earlier-deletion", func(t *testing.T) {
		statements := []string{"CREATE TABLE batch_delete_calls (id TEXT NOT NULL)"}
		if postgres {
			statements = append(statements, "CREATE FUNCTION batch_delete_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO batch_delete_calls VALUES (OLD.id); IF (SELECT count(*) FROM batch_delete_calls)>=2 THEN RAISE EXCEPTION 'intentional batch delete failure'; END IF; RETURN OLD; END $$",
				"CREATE TRIGGER batch_delete_failure BEFORE DELETE ON links FOR EACH ROW EXECUTE FUNCTION batch_delete_fail()")
		} else {
			statements = append(statements, "CREATE TRIGGER batch_delete_failure BEFORE DELETE ON links BEGIN INSERT INTO batch_delete_calls VALUES (OLD.id); SELECT CASE WHEN (SELECT count(*) FROM batch_delete_calls)>=2 THEN RAISE(ABORT,'intentional batch delete failure') END; END")
		}
		for _, statement := range statements {
			if _, err := a.store.DB.Exec(statement); err != nil {
				t.Fatal(err)
			}
		}
		t.Cleanup(func() {
			drop := "DROP TRIGGER batch_delete_failure"
			if postgres {
				drop += " ON links"
			}
			if _, err := a.store.DB.Exec(drop); err != nil {
				t.Error(err)
			}
			if postgres {
				if _, err := a.store.DB.Exec("DROP FUNCTION batch_delete_fail()"); err != nil {
					t.Error(err)
				}
			}
			if _, err := a.store.DB.Exec("DROP TABLE batch_delete_calls"); err != nil {
				t.Error(err)
			}
		})
		before := read()
		owner.object("POST", path+"/links/batch", batch("delete", nil), 500, "")
		expectUnchanged(before)
		var calls int
		if err := a.store.DB.QueryRow("SELECT count(*) FROM batch_delete_calls").Scan(&calls); err != nil || calls != 0 {
			t.Fatal("delete trigger writes were not rolled back", err)
		}
	})
	t.Run("delete-late-revision-failure-rolls-back-links-and-icon-jobs", func(t *testing.T) {
		firstDelete, secondDelete := create(shared, "delete-rollback-first", []string{}), create(shared, "delete-rollback-second", []string{})
		// Hold the fetch gate so the controlled queue record cannot start network
		// work while this test checks transaction and cleanup behavior.
		a.iconFetchGate <- struct{}{}
		defer func() { <-a.iconFetchGate }()
		origin, jobID := "https://rollback.example.org", newID()
		if _, err := a.store.DB.Exec(a.store.Query("UPDATE links SET icon_mode='auto',icon_origin=? WHERE id=?"), origin, firstDelete); err != nil {
			t.Fatal(err)
		}
		if _, err := a.store.DB.Exec(a.store.Query("INSERT INTO icon_favicon_jobs(space_id,origin,id,auth_epoch,actor_user_id,actor_user_version,token_hash,requested_at) VALUES(?,?,?,?,NULL,0,'',?)"), shared, origin, jobID, settings.AuthEpoch, nowUTC()); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := a.store.DB.Exec(a.store.Query("DELETE FROM icon_favicon_jobs WHERE id=?"), jobID); err != nil {
				t.Error(err)
			}
		}()
		statements := []string{"CREATE TRIGGER batch_delete_revision_failure BEFORE UPDATE OF data_revision ON spaces BEGIN SELECT RAISE(ABORT,'intentional revision failure'); END"}
		if postgres {
			statements = []string{"CREATE FUNCTION batch_delete_revision_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional revision failure'; END $$",
				"CREATE TRIGGER batch_delete_revision_failure BEFORE UPDATE OF data_revision ON spaces FOR EACH ROW EXECUTE FUNCTION batch_delete_revision_fail()"}
		}
		for _, statement := range statements {
			if _, err := a.store.DB.Exec(statement); err != nil {
				t.Fatal(err)
			}
		}
		t.Cleanup(func() {
			drop := "DROP TRIGGER batch_delete_revision_failure"
			if postgres {
				drop += " ON spaces"
			}
			if _, err := a.store.DB.Exec(drop); err != nil {
				t.Error(err)
			}
			if postgres {
				if _, err := a.store.DB.Exec("DROP FUNCTION batch_delete_revision_fail()"); err != nil {
					t.Error(err)
				}
			}
		})
		before := read()
		owner.object("POST", path+"/links/batch", batch("delete", map[string]any{"linkIds": []string{firstDelete, secondDelete}}), 500, "")
		expectUnchanged(before)
		var count int
		if err := a.store.DB.QueryRow(a.store.Query("SELECT count(*) FROM icon_favicon_jobs WHERE id=?"), jobID).Scan(&count); err != nil || count != 1 {
			t.Fatal("late failure did not roll back icon-job cleanup", count, err)
		}
	})
	t.Run("same-revision-concurrent-writes", func(t *testing.T) {
		input := batch("favorite", map[string]any{"isFavorite": true})
		var wg sync.WaitGroup
		statuses := make(chan int, 2)
		for range 2 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				status, _, _ := owner.raw("POST", path+"/links/batch", input, "", nil)
				statuses <- status
			}()
		}
		wg.Wait()
		close(statuses)
		counts := map[int]int{}
		for status := range statuses {
			counts[status]++
		}
		if counts[200] != 1 || counts[409] != 1 {
			t.Fatalf("expected one commit and one version conflict: %v", counts)
		}
	})
	t.Run("permissions-csrf-and-token-scopes", func(t *testing.T) {
		input := batch("favorite", map[string]any{"isFavorite": false})
		anonymous := integrationBrowser(t, server.URL)
		anonymous.boot()
		status, _, _ := anonymous.raw("POST", path+"/links/batch", input, "", nil)
		if status != 401 && status != 403 {
			t.Fatalf("anonymous write accepted: %d", status)
		}
		owner.object("POST", "/api/v1/admin/users", map[string]any{"username": "batch-member", "displayName": "Member", "password": "batch-fixture-member-2026"}, 201, "")
		member := integrationBrowser(t, server.URL)
		member.boot()
		member.object("POST", "/api/v1/auth/login", map[string]any{"username": "batch-member", "password": "batch-fixture-member-2026"}, 200, "")
		member.boot()
		status, _, _ = member.raw("POST", path+"/links/batch", input, "", nil)
		if status != 403 && status != 404 {
			t.Fatalf("member shared write accepted: %d", status)
		}
		status, _, _ = member.raw("POST", "/api/v1/spaces/"+personal+"/links/batch", input, "", nil)
		if status != 403 && status != 404 {
			t.Fatalf("foreign personal write accepted: %d", status)
		}
		before := read()
		status, _, _ = owner.raw("POST", path+"/links/batch", input, "", http.Header{"X-Csrf-Token": []string{"invalid"}})
		if status != 403 {
			t.Fatalf("missing CSRF accepted: %d", status)
		}
		readToken, _ := owner.token(shared, "", "navigation:read")
		status, _, _ = anonymous.raw("POST", path+"/links/batch", input, readToken, nil)
		if status != 403 {
			t.Fatalf("read-only token write accepted: %d", status)
		}
		wrongSpaceToken, _ := owner.token(personal, "", "navigation:write")
		status, _, _ = anonymous.raw("POST", path+"/links/batch", input, wrongSpaceToken, nil)
		if status != 403 && status != 404 {
			t.Fatalf("foreign token write accepted: %d", status)
		}
		expectUnchanged(before)
		writeToken, _ := owner.token(shared, "", "navigation:write")
		anonymous.object("POST", path+"/links/batch", input, 200, writeToken)

		input = batch("delete", nil)
		before = read()
		denyDelete := func(name string, status int, allowed ...int) {
			t.Helper()
			for _, expected := range allowed {
				if status == expected {
					expectUnchanged(before)
					return
				}
			}
			t.Fatalf("%s accepted or misclassified batch deletion: %d", name, status)
		}
		status, _, _ = anonymous.raw("POST", path+"/links/batch", input, "", nil)
		denyDelete("anonymous", status, 401, 403)
		status, _, _ = member.raw("POST", path+"/links/batch", input, "", nil)
		denyDelete("member shared space", status, 403, 404)
		status, _, _ = member.raw("POST", "/api/v1/spaces/"+personal+"/links/batch", input, "", nil)
		denyDelete("foreign personal space", status, 403, 404)
		status, _, _ = owner.raw("POST", path+"/links/batch", input, "", http.Header{"X-Csrf-Token": []string{"invalid"}})
		denyDelete("invalid CSRF", status, 403)
		status, _, _ = anonymous.raw("POST", path+"/links/batch", input, readToken, nil)
		denyDelete("read-only token", status, 403)
		status, _, _ = anonymous.raw("POST", path+"/links/batch", input, wrongSpaceToken, nil)
		denyDelete("wrong-space token", status, 403, 404)
		tokenFirst, tokenSecond := create(shared, "token-delete-first", []string{}), create(shared, "token-delete-second", []string{})
		deleteBatch(t, []string{tokenFirst, tokenSecond}, writeToken)
	})
	t.Run("delete-selected-links-preserves-other-data-and-shared-icon-jobs", func(t *testing.T) {
		uniqueDelete := create(shared, "delete-unique-origin", []string{"selected"})
		sharedDelete := create(shared, "delete-shared-origin", []string{"selected"})
		sharedKeep := create(shared, "keep-shared-origin", []string{"keep"})
		a.iconFetchGate <- struct{}{}
		defer func() { <-a.iconFetchGate }()
		uniqueOrigin, sharedOrigin := "https://deleted.example.org", "https://retained.example.org"
		for id, origin := range map[string]string{uniqueDelete: uniqueOrigin, sharedDelete: sharedOrigin, sharedKeep: sharedOrigin} {
			if _, err := a.store.DB.Exec(a.store.Query("UPDATE links SET icon_mode='auto',icon_origin=?,category_id=? WHERE id=?"), origin, category, id); err != nil {
				t.Fatal(err)
			}
		}
		jobs := []struct{ space, origin, id string }{{shared, uniqueOrigin, newID()}, {shared, sharedOrigin, newID()}, {personal, uniqueOrigin, newID()}}
		defer func() {
			for _, job := range jobs {
				if _, err := a.store.DB.Exec(a.store.Query("DELETE FROM icon_favicon_jobs WHERE id=?"), job.id); err != nil {
					t.Error(err)
				}
			}
		}()
		for _, job := range jobs {
			if _, err := a.store.DB.Exec(a.store.Query("INSERT INTO icon_favicon_jobs(space_id,origin,id,auth_epoch,actor_user_id,actor_user_version,token_hash,requested_at) VALUES(?,?,?,?,NULL,0,'',?)"), job.space, job.origin, job.id, settings.AuthEpoch, nowUTC()); err != nil {
				t.Fatal(err)
			}
		}
		before := read()
		selection := []string{uniqueDelete, sharedDelete}
		result := deleteBatch(t, selection, "")
		for i, job := range jobs {
			var count int
			want := 1
			if i == 0 {
				want = 0
			}
			if err := a.store.DB.QueryRow(a.store.Query("SELECT count(*) FROM icon_favicon_jobs WHERE id=?"), job.id).Scan(&count); err != nil || count != want {
				t.Fatalf("wrong icon-job cleanup for fixture %d: count=%d, want=%d, error=%v", i, count, want, err)
			}
		}
		after := read()
		owner.object("POST", path+"/links/batch", map[string]any{"operation": "delete", "linkIds": selection, "expectedRevision": before["revision"]}, 409, "")
		expectUnchanged(after)
		owner.object("POST", path+"/links/batch", map[string]any{"operation": "delete", "linkIds": selection, "expectedRevision": result["revision"]}, 404, "")
		expectUnchanged(after)
	})
	t.Run("delete-maximum-500-links", func(t *testing.T) {
		selection := make([]string, maxBatchLinks)
		for i := range selection {
			selection[i] = create(shared, fmt.Sprintf("delete-limit-%d", i), []string{})
		}
		deleteBatch(t, selection, "")
	})
	t.Run("public-read-and-open-edit-modes", func(t *testing.T) {
		owner.object("PUT", path, map[string]any{"name": "Shared fixture", "published": true}, 200, "")
		owner.object("PUT", "/api/v1/settings", map[string]any{"siteName": "Batch fixture", "mode": ModePublicRead, "registrationEnabled": false}, 200, "")
		owner.boot()
		owner.object("POST", "/api/v1/auth/login", map[string]any{"username": "batch-owner", "password": "batch-fixture-owner-2026"}, 200, "")
		owner.boot()
		openFirst, openSecond := create(shared, "open-delete-first", []string{}), create(shared, "open-delete-second", []string{})
		anonymous := integrationBrowser(t, server.URL)
		anonymous.boot()
		input := batch("favorite", map[string]any{"isFavorite": true})
		status, _, _ := anonymous.raw("POST", path+"/links/batch", input, "", nil)
		if status != 401 && status != 403 {
			t.Fatalf("public read accepted write: %d", status)
		}
		beforeDelete := read()
		deleteInput := batch("delete", map[string]any{"linkIds": []string{openFirst, openSecond}})
		status, _, _ = anonymous.raw("POST", path+"/links/batch", deleteInput, "", nil)
		if status != 401 && status != 403 {
			t.Fatalf("public read accepted batch deletion: %d", status)
		}
		expectUnchanged(beforeDelete)
		owner.object("PUT", "/api/v1/settings", map[string]any{"siteName": "Batch fixture", "mode": ModeOpenEdit, "registrationEnabled": false}, 200, "")
		anonymous.boot()
		anonymous.object("POST", path+"/links/batch", input, 200, "")
		beforeDelete = read()
		deleteInput["expectedRevision"] = beforeDelete["revision"]
		result := anonymous.object("POST", path+"/links/batch", deleteInput, 200, "")
		if result["deletedCount"] != float64(2) || result["updatedCount"] != float64(0) {
			t.Fatalf("open editing did not delete the selected links: %v", result)
		}
		expected := linksOf(beforeDelete)
		delete(expected, openFirst)
		delete(expected, openSecond)
		if !reflect.DeepEqual(expected, linksOf(read())) {
			t.Fatal("open editing deleted unselected links")
		}
	})
	before := read()
	server.Close()
	_ = a.Close()
	a, err = Open(c)
	if err != nil {
		t.Fatal(err)
	}
	server = httptest.NewServer(a)
	owner = integrationBrowser(t, server.URL)
	owner.boot()
	expectUnchanged(before)
}
