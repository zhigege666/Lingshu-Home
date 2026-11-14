package home

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func scheduleTestRule() WorkScheduleRule {
	return WorkScheduleRule{Frequency: "daily", Time: "09:00", Timezone: "UTC", StartDate: "2026-01-01", DueTime: "18:00"}
}

func scheduleTestBody(name string) map[string]any {
	return map[string]any{"id": newID(), "name": name, "template": map[string]any{"title": name}, "rule": scheduleTestRule(), "enabled": false}
}

func scheduleFromReply(value map[string]any) map[string]any {
	return value["schedule"].(map[string]any)
}
func occurrenceFromReply(value map[string]any) map[string]any {
	return value["occurrence"].(map[string]any)
}

func TestWorkScheduleCalendar(t *testing.T) {
	for _, tc := range []struct {
		name        string
		rule        WorkScheduleRule
		after, want string
	}{
		{"daily-zone", WorkScheduleRule{Frequency: "daily", Time: "09:00", Timezone: "Asia/Shanghai", StartDate: "2026-01-01"}, "2026-01-01T00:00:00Z", "2026-01-01T01:00:00.000000000Z"},
		{"weekdays", WorkScheduleRule{Frequency: "weekdays", Time: "09:00", Timezone: "UTC", StartDate: "2026-01-01"}, "2026-01-02T10:00:00Z", "2026-01-05T09:00:00.000000000Z"},
		{"weekly", WorkScheduleRule{Frequency: "weekly", Time: "09:00", Timezone: "UTC", StartDate: "2026-01-01", Weekdays: []int{7, 1}}, "2026-01-02T10:00:00Z", "2026-01-04T09:00:00.000000000Z"},
		{"monthly-skip", WorkScheduleRule{Frequency: "monthly", Time: "09:00", Timezone: "UTC", StartDate: "2026-01-01", MonthDay: 31, MonthPolicy: "skip"}, "2026-02-01T00:00:00Z", "2026-03-31T09:00:00.000000000Z"},
		{"monthly-last-day", WorkScheduleRule{Frequency: "monthly", Time: "09:00", Timezone: "UTC", StartDate: "2026-01-01", MonthDay: 31, MonthPolicy: "last_day"}, "2026-02-01T00:00:00Z", "2026-02-28T09:00:00.000000000Z"},
		{"dst-generation-gap", WorkScheduleRule{Frequency: "daily", Time: "02:30", Timezone: "America/New_York", StartDate: "2026-03-08"}, "2026-03-08T00:00:00Z", "2026-03-09T06:30:00.000000000Z"},
		{"dst-deadline-gap", WorkScheduleRule{Frequency: "daily", Time: "01:00", Timezone: "America/New_York", StartDate: "2026-03-08", DueTime: "02:30"}, "2026-03-08T00:00:00Z", "2026-03-09T05:00:00.000000000Z"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateWorkScheduleRule(&tc.rule); err != nil {
				t.Fatal(err)
			}
			after, _ := time.Parse(time.RFC3339, tc.after)
			value, found := nextWorkSchedule(tc.rule, after)
			if !found || value.ScheduledAt != tc.want {
				t.Fatalf("got %+v, found=%v; want %s", value, found, tc.want)
			}
		})
	}
	rule := WorkScheduleRule{Frequency: "daily", Time: "01:30", Timezone: "America/New_York", StartDate: "2026-11-01", DueAfterMinutes: 90}
	first, valid := workScheduleDate(rule, "2026-11-01")
	if !valid {
		t.Fatal("repeated wall-clock date disappeared")
	}
	at, _ := time.Parse(time.RFC3339Nano, first.ScheduledAt)
	due, _ := time.Parse(time.RFC3339Nano, first.DueAt)
	next, valid := nextWorkSchedule(rule, at)
	if !valid || next.BusinessDate != "2026-11-02" || due.Sub(at) != 90*time.Minute {
		t.Fatalf("DST repeated date duplicated or relative due changed: %+v / %+v", first, next)
	}
	for _, invalidRule := range []WorkScheduleRule{
		{Frequency: "daily", Time: "24:00", Timezone: "UTC", StartDate: "2026-01-01"},
		{Frequency: "daily", Time: "09:00", Timezone: "Local", StartDate: "2026-01-01"},
		{Frequency: "daily", Time: "09:00", Timezone: "UTC", StartDate: "2026-02-30"},
		{Frequency: "monthly", Time: "09:00", Timezone: "UTC", StartDate: "2026-01-01", MonthDay: 31},
		{Frequency: "weekly", Time: "09:00", Timezone: "UTC", StartDate: "2026-01-01", Weekdays: []int{1, 1}},
		{Frequency: "daily", Time: "09:00", Timezone: "UTC", StartDate: "2026-01-01", DueTime: "18:00", DueAfterMinutes: 20},
	} {
		if validateWorkScheduleRule(&invalidRule) == nil {
			t.Fatalf("accepted invalid rule: %+v", invalidRule)
		}
	}
}

func TestWorkSchedulesHTTPAndMCP(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Schedules", "mode": ModePublicRead, "username": "owner", "password": "schedule fixture password", "seedDemo": false})
			boot := owner.bootstrap()
			space, personal := coreSpace(boot, "shared"), coreSpace(boot, "personal")
			base := "/spaces/" + space + "/work"
			body := scheduleTestBody("Daily sync")
			body["enabled"] = nil
			statusWant(t, owner, 400, "POST", base+"/schedules", body)
			body["enabled"] = false
			created := scheduleFromReply(owner.ok("POST", base+"/schedules", body))
			id := created["id"].(string)
			path := base + "/schedules/" + id
			if created["nextRunAt"] != "" || created["revision"] != "1" {
				t.Fatal("paused creation scheduled or wrong revision", created)
			}
			replayed := owner.ok("POST", base+"/schedules", body)
			if replayed["replayed"] != true {
				t.Fatal("schedule creation not replay-safe", replayed)
			}
			statusWant(t, owner, 404, "GET", "/spaces/"+personal+"/work/schedules/"+id, nil)
			preview := owner.ok("POST", base+"/schedules/preview", map[string]any{"rule": scheduleTestRule(), "after": "2026-01-01T00:00:00Z"})
			if len(preview["items"].([]any)) != 5 {
				t.Fatal("preview did not return five dates")
			}
			first := occurrenceFromReply(owner.ok("POST", path+"/generate", map[string]any{"expectedRevision": "1", "businessDate": "2026-01-02"}))
			if first["result"] != "created" {
				t.Fatalf("generation failed: %v", first)
			}
			itemID := first["itemId"].(string)
			item := owner.ok("GET", workItemPath(space, itemID)+"?activityLimit=10", nil)
			if item["businessDate"] != "2026-01-02" || item["dueAt"] != "2026-01-02T18:00:00.000000000Z" || item["scheduleId"] != id || item["result"] != "" {
				t.Fatal("generated content/provenance incorrect", item)
			}
			activity := item["activity"].(map[string]any)["items"].([]any)
			if len(activity) != 1 || activity[0].(map[string]any)["origin"] != "scheduler" || activity[0].(map[string]any)["session"] != nil {
				t.Fatal("scheduler forged session or lost attribution", activity)
			}
			changedRule := scheduleTestRule()
			changedRule.Time = "10:00"
			updated := scheduleFromReply(owner.ok("PATCH", path, map[string]any{"expectedRevision": "1", "template": map[string]any{"title": "New independent sync"}, "rule": changedRule}))
			second := owner.ok("POST", path+"/generate", map[string]any{"expectedRevision": updated["revision"], "businessDate": "2026-01-02"})
			if second["replayed"] != true || occurrenceFromReply(second)["itemId"] != itemID {
				t.Fatal("template/time change duplicated same business date", second)
			}
			if after := owner.ok("GET", workItemPath(space, itemID), nil); after["title"] != "Daily sync" || after["revision"] != item["revision"] {
				t.Fatal("template mutated historical item", after)
			}
			third := occurrenceFromReply(owner.ok("POST", path+"/generate", map[string]any{"expectedRevision": updated["revision"], "businessDate": "2026-01-03"}))
			if after := owner.ok("GET", workItemPath(space, third["itemId"].(string)), nil); after["title"] != "New independent sync" {
				t.Fatal("future period did not use new template")
			}
			records := owner.ok("GET", path+"/occurrences?limit=1", nil)
			if records["nextCursor"] == nil {
				t.Fatal("missing occurrence cursor")
			}
			page2 := owner.ok("GET", path+"/occurrences?limit=1&cursor="+url.QueryEscape(records["nextCursor"].(string)), nil)
			if page2["items"].([]any)[0].(map[string]any)["businessDate"] != "2026-01-02" {
				t.Fatal("occurrence pagination lost date", page2)
			}
			other := scheduleFromReply(owner.ok("POST", base+"/schedules", scheduleTestBody("Other")))
			statusWant(t, owner, 400, "GET", base+"/schedules/"+other["id"].(string)+"/occurrences?cursor="+url.QueryEscape(records["nextCursor"].(string)), nil)
			listing := owner.ok("GET", base+"/schedules?limit=1", nil)
			statusWant(t, owner, 400, "GET", base+"/schedules?q=changed&cursor="+url.QueryEscape(listing["nextCursor"].(string)), nil)
			// Read-only, write-only, source-bound and cross-space tokens all share
			// the same permission checks through MCP and HTTP handlers.
			auth := &integrationTestBrowser{t: t, base: server.URL, client: owner.client, csrf: owner.csrf}
			caller := integrationBrowser(t, server.URL)
			read, _ := auth.token(space, "", "work:read")
			write, writeID := auth.token(space, "", "work:write")
			both, _ := auth.token(space, "", "work:read", "work:write")
			caller.tool(read, "work_schedules_create", map[string]any{"input": scheduleTestBody("Denied")}, "forbidden")
			caller.tool(write, "work_schedules_get", map[string]any{"id": id}, "forbidden")
			caller.tool(both, "work_schedules_get", map[string]any{"spaceId": personal, "id": id}, "not_found")
			mcpBody := scheduleTestBody("MCP write only")
			receipt := caller.tool(write, "work_schedules_create", map[string]any{"input": mcpBody}, "")
			if receipt["schedule"] != nil || receipt["id"] != mcpBody["id"] || len(receipt) != 3 {
				t.Fatal("write-only schedule leaked template", receipt)
			}
			mcpGenerated := caller.tool(write, "work_schedules_generate", map[string]any{"id": mcpBody["id"], "input": map[string]any{"expectedRevision": "1", "businessDate": "2026-01-04"}}, "")
			if occurrenceFromReply(mcpGenerated)["result"] != "created" {
				t.Fatal("MCP generation did not share HTTP behavior", mcpGenerated)
			}
			// Revocation is rechecked for the saved execution principal. An owner
			// triggering the rule does not bypass the revoked token.
			if _, err := app.store.DB.Exec(app.store.Query("UPDATE integration_tokens SET revoked_at=? WHERE id=?"), nowUTC(), writeID); err != nil {
				t.Fatal(err)
			}
			failed := occurrenceFromReply(owner.ok("POST", base+"/schedules/"+mcpBody["id"].(string)+"/generate", map[string]any{"expectedRevision": "1", "businessDate": "2026-01-05"}))
			if failed["result"] != "failed" || !strings.HasPrefix(failed["reason"].(string), "unauthorized:") {
				t.Fatal("revoked schedule principal still generated", failed)
			}
			blocked := scheduleFromReply(owner.ok("GET", base+"/schedules/"+mcpBody["id"].(string), nil))
			if blocked["lastError"] == "" || blocked["nextRunAt"] != "" {
				t.Fatal("execution error not visible", blocked)
			}
			repaired := scheduleFromReply(owner.ok("PATCH", base+"/schedules/"+mcpBody["id"].(string), map[string]any{"expectedRevision": "1", "name": "Reauthorized"}))
			retry := occurrenceFromReply(owner.ok("POST", base+"/schedules/"+mcpBody["id"].(string)+"/generate", map[string]any{"expectedRevision": repaired["revision"], "businessDate": "2026-01-05"}))
			if retry["result"] != "created" {
				t.Fatal("failed occurrence could not be explicitly retried", retry)
			}
			sourceToken, _ := auth.token(space, "", "work:write")
			source := auth.object("POST", "/api/v1/spaces/"+space+"/sources", map[string]any{"name": "Schedule scope", "kind": "external-push", "schemaId": "navigation.collection", "schemaVersion": 1, "connection": map[string]string{}, "sync": map[string]any{"mode": "push", "staleAfterSeconds": 3600}, "enabled": true}, 201, "")
			if _, err := app.store.DB.Exec(app.store.Query("UPDATE integration_tokens SET source_id=? WHERE token_hash=?"), source["id"], integrationHash(sourceToken)); err != nil {
				t.Fatal(err)
			}
			caller.tool(sourceToken, "work_schedules_create", map[string]any{"input": scheduleTestBody("Source bound")}, "forbidden")
		})
	}
}

func TestWorkDatesAndLegacyReplay(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Dates", "mode": ModePublicRead, "username": "owner", "password": "schedule fixture password", "seedDemo": false})
			space := coreSpace(owner.bootstrap(), "shared")
			base := "/spaces/" + space + "/work"
			original := map[string]any{"id": newID(), "title": "Old normalized intent"}
			item := owner.ok("POST", base+"/items", original)
			var originalHash string
			if err := app.store.DB.QueryRow(app.store.Query("SELECT create_hash FROM work_items WHERE id=?"), item["id"]).Scan(&originalHash); err != nil {
				t.Fatal(err)
			}
			legacy := struct {
				ID             string              `json:"id"`
				Title          string              `json:"title"`
				ProjectID      *string             `json:"projectId"`
				Status         string              `json:"status"`
				Description    string              `json:"description"`
				NextStep       string              `json:"nextStep"`
				Result         string              `json:"result"`
				NeedsAttention bool                `json:"needsAttention"`
				BookmarkIDs    []string            `json:"bookmarkIds"`
				DocumentIDs    []string            `json:"documentIds"`
				Placement      workCreatePlacement `json:"placement,omitempty"`
			}{ID: original["id"].(string), Title: "Old normalized intent", BookmarkIDs: []string{}, DocumentIDs: []string{}}
			if originalHash != workPayloadHash(legacy) {
				t.Fatal("new empty date fields changed legacy create hash")
			}
			today := time.Now().UTC().Format("2006-01-02")
			due := time.Now().Add(-time.Hour).Format(time.RFC3339Nano)
			updated := owner.ok("PATCH", workItemPath(space, item["id"].(string)), map[string]any{"expectedRevision": item["revision"], "businessDate": today, "dueAt": due})
			if replay := owner.ok("POST", base+"/items", original); replay["id"] != updated["id"] || replay["revision"] != updated["revision"] {
				t.Fatal("legacy replay modified dated item", replay)
			}
			if got := owner.ok("GET", base+"/items?date=today&timezone=UTC", nil); got["total"] != float64(1) {
				t.Fatal("today filter", got)
			}
			if got := owner.ok("GET", base+"/items?date=overdue&timezone=UTC", nil); got["total"] != float64(1) {
				t.Fatal("overdue filter", got)
			}
			updated = owner.ok("PATCH", workItemPath(space, item["id"].(string)), map[string]any{"expectedRevision": updated["revision"], "status": "done"})
			if got := owner.ok("GET", base+"/items?date=overdue", nil); got["total"] != float64(0) {
				t.Fatal("ended item counted overdue", got)
			}
			updated = owner.ok("PATCH", workItemPath(space, item["id"].(string)), map[string]any{"expectedRevision": updated["revision"], "businessDate": "", "dueAt": ""})
			if updated["businessDate"] != nil || updated["dueAt"] != nil {
				t.Fatal("dates not cleared", updated)
			}
			statusWant(t, owner, 400, "POST", base+"/items", map[string]any{"id": newID(), "title": "Bad date", "businessDate": "2026-02-30"})
			statusWant(t, owner, 400, "POST", base+"/items", map[string]any{"id": newID(), "title": "Bad due", "dueAt": "2026-01-01T10:00:00"})
			for i := 0; i < 2; i++ {
				owner.ok("POST", base+"/items", map[string]any{"id": newID(), "title": "Dated", "businessDate": today})
			}
			page := owner.ok("GET", base+"/items?date=today&timezone=UTC&limit=1", nil)
			statusWant(t, owner, 400, "GET", base+"/items?date=overdue&timezone=UTC&cursor="+url.QueryEscape(page["nextCursor"].(string)), nil)
		})
	}
}

func TestWorkScheduleRecoveryAndAtomicity(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Recovery", "mode": ModePublicRead, "username": "owner", "password": "schedule fixture password", "seedDemo": false})
			space := coreSpace(owner.bootstrap(), "shared")
			base := "/spaces/" + space + "/work"
			// Stop autonomous wakeups, retain the store lease and exercise the exact
			// production transaction helper with a deterministic recovery timestamp.
			app.cancel()
			app.workers.Wait()
			ctx := context.Background()
			now := time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)
			for _, policy := range []string{"latest", "skip", "all"} {
				body := scheduleTestBody(policy)
				body["missedPolicy"] = policy
				schedule := scheduleFromReply(owner.ok("POST", base+"/schedules", body))
				id := schedule["id"].(string)
				if _, err := app.store.DB.Exec(app.store.Query("UPDATE work_schedules SET enabled=?,next_run_at=? WHERE id=?"), true, workScheduleStamp(now.AddDate(0, 0, -20).Add(-time.Hour)), id); err != nil {
					t.Fatal(err)
				}
				if err := app.processWorkSchedule(ctx, id, now); err != nil {
					t.Fatal(err)
				}
				var count int
				if err := app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM work_items WHERE schedule_id=?"), id).Scan(&count); err != nil {
					t.Fatal(err)
				}
				want := 1
				if policy == "all" {
					want = 7
				}
				if policy == "skip" {
					want = 0
				}
				if count != want {
					t.Fatalf("%s generated %d, want %d", policy, count, want)
				}
				if err := app.processWorkSchedule(ctx, id, now); err != nil {
					t.Fatal(err)
				}
				var again int
				app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM work_items WHERE schedule_id=?"), id).Scan(&again)
				if count != again {
					t.Fatal("recovery restart duplicated work")
				}
			}
			body := scheduleTestBody("Overlap")
			body["overlapPolicy"] = "skip"
			schedule := scheduleFromReply(owner.ok("POST", base+"/schedules", body))
			id := schedule["id"].(string)
			path := base + "/schedules/" + id
			owner.ok("POST", path+"/generate", map[string]any{"expectedRevision": "1", "businessDate": "2026-11-13"})
			skipped := occurrenceFromReply(owner.ok("POST", path+"/generate", map[string]any{"expectedRevision": "1", "businessDate": "2026-11-14"}))
			if skipped["result"] != "skipped" || skipped["reason"] != "previous_unfinished" {
				t.Fatal("overlap policy ignored", skipped)
			}
			if replay := owner.ok("POST", path+"/generate", map[string]any{"expectedRevision": "1", "businessDate": "2026-11-14"}); replay["replayed"] != true {
				t.Fatal("skipped period changed implicitly", replay)
			}
			// Resume recalculates only future deadlines, never paused periods.
			resumed := scheduleFromReply(owner.ok("PATCH", path, map[string]any{"expectedRevision": "1", "enabled": true}))
			next, _ := time.Parse(time.RFC3339Nano, resumed["nextRunAt"].(string))
			if !next.After(time.Now()) {
				t.Fatal("resume backfilled paused periods", resumed)
			}
			archived := scheduleFromReply(owner.ok("PATCH", path, map[string]any{"expectedRevision": resumed["revision"], "archived": true}))
			statusWant(t, owner, 409, "POST", path+"/generate", map[string]any{"expectedRevision": archived["revision"], "businessDate": "2026-11-15"})
			// A transaction which aborts after creation must leave neither receipt,
			// item nor board revision. Explicit retry reuses the stable item ID.
			atomic := scheduleFromReply(owner.ok("POST", base+"/schedules", scheduleTestBody("Atomic")))
			atomicID := atomic["id"].(string)
			before := owner.ok("GET", base+"/revision", nil)
			sentinel := errors.New("injected transaction abort")
			err := app.integrationTransaction(ctx, func(q Queryer) error {
				s, err := scanWorkSchedule(q.QueryRowContext(ctx, app.store.Query("SELECT "+workScheduleColumns+" FROM work_schedules WHERE id=?"), atomicID))
				if err != nil {
					return err
				}
				settings, err := app.loadSettings(ctx, q)
				if err != nil {
					return err
				}
				r, err := app.workScheduleRequest(ctx, q, s, settings)
				if err != nil {
					return err
				}
				planned, _ := workScheduleDate(s.Rule, "2026-11-14")
				occ, _, err := app.createWorkScheduleOccurrence(r, s, planned, now, "")
				if err != nil {
					return err
				}
				if occ.Result != "created" {
					t.Fatalf("creation before injected abort failed: %v", occ)
				}
				return sentinel
			})
			if !errors.Is(err, sentinel) {
				t.Fatal(err)
			}
			after := owner.ok("GET", base+"/revision", nil)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("aborted transaction changed board revision")
			}
			var count int
			app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM work_items WHERE schedule_id=?"), atomicID).Scan(&count)
			if count != 0 {
				t.Fatal("aborted item survived")
			}
			app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM work_schedule_occurrences WHERE schedule_id=?"), atomicID).Scan(&count)
			if count != 0 {
				t.Fatal("aborted occurrence survived")
			}
			var wait sync.WaitGroup
			results := make(chan int, 8)
			for i := 0; i < 8; i++ {
				wait.Add(1)
				go func() {
					defer wait.Done()
					code, _ := owner.call("POST", base+"/schedules/"+atomicID+"/generate", map[string]any{"expectedRevision": "1", "businessDate": "2026-11-14"})
					results <- code
				}()
			}
			wait.Wait()
			close(results)
			for code := range results {
				if code != 200 {
					t.Fatal("concurrent generation failed", code)
				}
			}
			app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM work_items WHERE schedule_id=?"), atomicID).Scan(&count)
			if count != 1 {
				t.Fatal("concurrent period generated duplicate", count)
			}
			app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM work_schedule_occurrences WHERE schedule_id=?"), atomicID).Scan(&count)
			if count != 1 {
				t.Fatal("concurrent period stored duplicate receipts", count)
			}
			// Invalid target state is a visible failure, without fallback to default.
			bad := scheduleFromReply(owner.ok("POST", base+"/schedules", scheduleTestBody("Invalid target")))
			badID := bad["id"].(string)
			template := WorkScheduleTemplate{Title: "Invalid target", Status: newID(), BookmarkIDs: []string{}, DocumentIDs: []string{}}
			encoded, _ := json.Marshal(template)
			if _, err := app.store.DB.Exec(app.store.Query("UPDATE work_schedules SET template_json=?,enabled=?,next_run_at=? WHERE id=?"), string(encoded), true, "2026-11-14T09:00:00.000000000Z", badID); err != nil {
				t.Fatal(err)
			}
			if err := app.processWorkSchedule(ctx, badID, now); err != nil {
				t.Fatal(err)
			}
			failed := scheduleFromReply(owner.ok("GET", base+"/schedules/"+badID, nil))
			if failed["lastResult"] != "failed" || failed["lastError"] == "" || failed["nextRunAt"] != "" {
				t.Fatal("invalid target fell back or lacked observable failure", failed)
			}
		})
	}
}

func TestWorkScheduleReferencesAndModules(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "References", "mode": ModePublicRead, "username": "owner", "password": "schedule fixture password", "seedDemo": false})
			boot := owner.bootstrap()
			space := coreSpace(boot, "shared")
			base := "/spaces/" + space + "/work"
			app.config.DocumentRoots = []string{t.TempDir()}
			fixture := &documentFixture{app: app, server: server, owner: owner, root: app.config.DocumentRoots[0], shared: space, personal: coreSpace(boot, "personal")}
			fixture.source(t, space, "schedule-notes", false, map[string]string{"guide.md": "# Schedule guide\nPrivate body should never be in a schedule response\n"})
			document := documentByPath(t, owner, space, "guide.md")
			link := owner.ok("POST", "/spaces/"+space+"/links", coreLink("Schedule reference", "https://example.com/schedule"))
			body := scheduleTestBody("References")
			body["template"] = map[string]any{"title": "References", "bookmarkIds": []string{link["id"].(string)}, "documentIds": []string{document["id"].(string)}}
			schedule := scheduleFromReply(owner.ok("POST", base+"/schedules", body))
			id := schedule["id"].(string)
			path := base + "/schedules/" + id
			if len(schedule["references"].([]any)) != 2 {
				t.Fatal("authorized references missing", schedule)
			}
			encoded, _ := json.Marshal(schedule)
			if strings.Contains(string(encoded), "Private body") || strings.Contains(string(encoded), fixture.root) {
				t.Fatal("reference body/mount leaked")
			}
			auth := &integrationTestBrowser{t: t, base: server.URL, client: owner.client, csrf: owner.csrf}
			read, _ := auth.token(space, "", "work:read")
			weak := scheduleFromReply(integrationBrowser(t, server.URL).tool(read, "work_schedules_get", map[string]any{"id": id}, ""))
			if len(weak["references"].([]any)) != 0 || len(weak["template"].(map[string]any)["documentIds"].([]any)) != 0 || len(weak["template"].(map[string]any)["bookmarkIds"].([]any)) != 0 {
				t.Fatal("read-only work scope leaked resource IDs", weak)
			}
			owner.ok("PUT", "/settings", map[string]any{"siteName": "References", "mode": ModePublicRead, "registrationEnabled": false, "modules": map[string]any{"documents": false}})
			updated := scheduleFromReply(owner.ok("PATCH", path, map[string]any{"expectedRevision": "1", "template": map[string]any{"title": "References retained"}}))
			var saved string
			app.store.DB.QueryRow(app.store.Query("SELECT template_json FROM work_schedules WHERE id=?"), id).Scan(&saved)
			if !strings.Contains(saved, document["id"].(string)) || !strings.Contains(saved, link["id"].(string)) {
				t.Fatal("omitted references were cleared with documents disabled")
			}
			statusWant(t, owner, 403, "PATCH", path, map[string]any{"expectedRevision": updated["revision"], "template": map[string]any{"title": "Do not clear silently", "documentIds": []string{}}})
			failed := occurrenceFromReply(owner.ok("POST", path+"/generate", map[string]any{"expectedRevision": updated["revision"], "businessDate": "2026-11-14"}))
			if failed["result"] != "failed" || !strings.HasPrefix(failed["reason"].(string), "module_disabled:") {
				t.Fatal("disabled document target failed silently", failed)
			}
			owner.ok("PUT", "/settings", map[string]any{"siteName": "References", "mode": ModePublicRead, "registrationEnabled": false, "modules": map[string]any{"documents": true}})
			fixed := occurrenceFromReply(owner.ok("POST", path+"/generate", map[string]any{"expectedRevision": updated["revision"], "businessDate": "2026-11-14"}))
			if fixed["result"] != "created" {
				t.Fatal("explicit retry after module repair failed", fixed)
			}
			owner.ok("PUT", "/settings", map[string]any{"siteName": "References", "mode": ModePublicRead, "registrationEnabled": false, "modules": map[string]any{"work": false}})
			statusWant(t, owner, 403, "GET", base+"/schedules", nil)
			ids, next, err := app.workScheduleDue(context.Background())
			if err != nil || len(ids) != 0 || !next.IsZero() {
				t.Fatal("disabled module scheduled work", ids, next, err)
			}
		})
	}
}

func TestWorkScheduleRestartRecovery(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Restart", "mode": ModePublicRead, "username": "owner", "password": "schedule fixture password", "seedDemo": false})
			space := coreSpace(owner.bootstrap(), "shared")
			base := "/spaces/" + space + "/work"
			body := scheduleTestBody("Recovered after restart")
			rule := scheduleTestRule()
			rule.StartDate = time.Now().UTC().AddDate(0, 0, -10).Format("2006-01-02")
			body["rule"] = rule
			schedule := scheduleFromReply(owner.ok("POST", base+"/schedules", body))
			id := schedule["id"].(string)
			app.cancel()
			app.workers.Wait()
			if _, err := app.store.DB.Exec(app.store.Query("UPDATE work_schedules SET enabled=?,next_run_at=? WHERE id=?"), true, workScheduleStamp(time.Now().UTC().AddDate(0, 0, -3)), id); err != nil {
				t.Fatal(err)
			}
			configuration := app.config
			server.Close()
			if err := app.Close(); err != nil {
				t.Fatal(err)
			}
			app.store = nil // The fixture cleanup still owns this already closed App.
			reopened, err := Open(configuration)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			deadline := time.Now().Add(5 * time.Second)
			count := 0
			for count == 0 && time.Now().Before(deadline) {
				if err = reopened.store.DB.QueryRow(reopened.store.Query("SELECT COUNT(*) FROM work_items WHERE schedule_id=?"), id).Scan(&count); err != nil {
					t.Fatal(err)
				}
				if count == 0 {
					time.Sleep(10 * time.Millisecond)
				}
			}
			if count != 1 {
				t.Fatal("restart did not recover exactly the latest occurrence", count)
			}
			var next, lastResult string
			if err = reopened.store.DB.QueryRow(reopened.store.Query("SELECT next_run_at,last_result FROM work_schedules WHERE id=?"), id).Scan(&next, &lastResult); err != nil {
				t.Fatal(err)
			}
			if next == "" || lastResult != "created" {
				t.Fatal("restart did not atomically advance deadline", next, lastResult)
			}
		})
	}
}

func TestWorkOverduePaginationSnapshot(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			_, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Overdue snapshot", "mode": ModePublicRead, "username": "owner", "password": "schedule fixture password", "seedDemo": false})
			space := coreSpace(owner.bootstrap(), "shared")
			base := "/spaces/" + space + "/work"
			first := owner.ok("POST", base+"/items", map[string]any{"id": newID(), "title": "First overdue", "dueAt": workScheduleStamp(time.Now().Add(-time.Hour))})
			deadline := time.Now().Add(2 * time.Second)
			owner.ok("POST", base+"/items", map[string]any{"id": newID(), "title": "Becomes overdue between pages", "dueAt": workScheduleStamp(deadline)})
			last := owner.ok("POST", base+"/items", map[string]any{"id": newID(), "title": "Second original overdue", "dueAt": workScheduleStamp(time.Now().Add(-time.Hour))})
			page := owner.ok("GET", base+"/items?date=overdue&timezone=UTC&limit=1", nil)
			if page["total"] != float64(2) || page["items"].([]any)[0].(map[string]any)["id"] != first["id"] {
				t.Fatal("initial overdue page", page)
			}
			if wait := time.Until(deadline) + 10*time.Millisecond; wait > 0 {
				time.Sleep(wait)
			}
			second := owner.ok("GET", base+"/items?date=overdue&timezone=UTC&limit=1&cursor="+url.QueryEscape(page["nextCursor"].(string)), nil)
			if second["total"] != float64(2) || second["items"].([]any)[0].(map[string]any)["id"] != last["id"] || second["revision"] != page["revision"] {
				t.Fatal("time changed a cursor's original membership/total", second)
			}
			refreshed := owner.ok("GET", base+"/items?date=overdue&timezone=UTC&limit=1", nil)
			if refreshed["total"] != float64(3) {
				t.Fatal("new first page did not observe newly overdue work", refreshed)
			}
			statusWant(t, owner, 400, "GET", base+"/items?date=overdue&timezone=Asia%2FShanghai&cursor="+url.QueryEscape(page["nextCursor"].(string)), nil)
		})
	}
}
