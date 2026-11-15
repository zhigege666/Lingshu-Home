package home

import (
	"context"
	"fmt"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"
)

func planningMultiUser(f *workStatusFixture) {
	f.owner.ok("PUT", "/settings", map[string]any{"siteName": "Planning multi-user", "mode": ModePrivateMulti, "registrationEnabled": false})
	f.owner.bootstrap()
	f.owner.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": "status fixture password"})
	f.owner.bootstrap()
}
func planningItems(v map[string]any) []any { return v["items"].([]any) }
func planningPatch(f *workStatusFixture, item map[string]any, changes map[string]any) map[string]any {
	changes["expectedRevision"] = item["revision"]
	return f.owner.ok("PATCH", workItemPath(f.space, item["id"].(string)), changes)
}
func TestWorkPlanningMetadataHTTPMCP(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			b := f.base
			labelBody := map[string]any{"id": newID(), "name": "Release", "color": "#aabbcc"}
			label := f.owner.ok("POST", b+"/labels", labelBody)
			if replay := f.owner.ok("POST", b+"/labels", labelBody); !reflect.DeepEqual(label, replay) {
				t.Fatal("label creation replay changed", replay)
			}
			second := f.owner.ok("POST", b+"/labels", map[string]any{"id": newID(), "name": "Backend"})
			project := f.owner.ok("POST", b+"/projects", map[string]any{"id": newID(), "name": "Primary"})
			other := f.owner.ok("POST", b+"/projects", map[string]any{"id": newID(), "name": "Other"})
			version := f.owner.ok("POST", b+"/versions", map[string]any{"id": newID(), "name": "v-next", "projectId": project["id"], "targetDate": "2026-12-01"})
			body := map[string]any{"requestId": newID(), "title": "Plan release", "projectId": project["id"], "priority": "high", "labelIds": []any{second["id"], label["id"]}, "versionId": version["id"], "assignee": map[string]any{"name": "Release lead"}}
			item := f.owner.ok("POST", b+"/items", body)
			id := item["id"].(string)
			if item["number"] != nil || item["key"] != nil || item["id"] != "00001" || len(item["labels"].([]any)) != 2 || item["version"].(map[string]any)["name"] != "v-next" {
				t.Fatal("planning data missing", item)
			}
			if replay := f.owner.ok("POST", b+"/items", body); replay["id"] != item["id"] {
				t.Fatal("replay allocated another number")
			}
			if got := f.owner.ok("GET", b+"/items/"+id, nil); got["id"] != id {
				t.Fatal("short item ID did not resolve")
			}
			if got := f.owner.ok("GET", b+"/items?itemId="+id+"&priority=high&labelIds="+label["id"].(string)+"&labelIds="+second["id"].(string), nil); got["total"] != float64(1) {
				t.Fatal("planning filter intersection", got)
			}
			statusWant(t, f.owner, 409, "PATCH", workItemPath(f.space, id), map[string]any{"expectedRevision": item["revision"], "projectId": other["id"]})
			statusWant(t, f.owner, 409, "PATCH", b+"/versions/"+version["id"].(string), map[string]any{"expectedRevision": version["revision"], "projectId": other["id"]})
			label = f.owner.ok("PATCH", b+"/labels/"+label["id"].(string), map[string]any{"expectedRevision": label["revision"], "archived": true})
			item = planningPatch(f, item, map[string]any{"title": "Preserve archived metadata"})
			if len(item["labelIds"].([]any)) != 2 {
				t.Fatal("omission cleared labels")
			}
			statusWant(t, f.owner, 409, "POST", b+"/items", map[string]any{"requestId": newID(), "title": "Cannot newly assign archived label", "labelIds": []any{label["id"]}})
			item = planningPatch(f, item, map[string]any{"priority": "", "labelIds": []any{}, "assignee": nil, "versionId": nil, "projectId": other["id"]})
			for _, field := range []string{"priority", "labelIds", "assignee", "versionId"} {
				if item[field] != nil {
					t.Fatal("explicit clear not applied", field, item[field])
				}
			}
			missingID := newID()
			batch := f.owner.ok("GET", b+"/labels?ids="+label["id"].(string)+"&ids="+missingID, nil)
			if len(planningItems(batch)) != 1 || batch["missingIds"].([]any)[0] != missingID {
				t.Fatal("batch catalog IDs", batch)
			}
			foreign := f.owner.ok("POST", "/spaces/"+f.personal+"/work/labels", map[string]any{"id": newID(), "name": "Private label"})
			statusWant(t, f.owner, 404, "POST", b+"/items", map[string]any{"requestId": newID(), "title": "Cross-space label", "labelIds": []any{foreign["id"]}})
			auth := &integrationTestBrowser{t: t, base: f.owner.base, client: f.owner.client, csrf: f.owner.csrf}
			caller := integrationBrowser(t, f.owner.base)
			read, _ := auth.token(f.space, "", "work:read")
			write, _ := auth.token(f.space, "", "work:write")
			both, _ := auth.token(f.space, "", "work:read", "work:write")
			caller.tool(read, "work_labels_create", map[string]any{"input": map[string]any{"id": newID(), "name": "Denied"}}, "forbidden")
			receipt := caller.tool(write, "work_labels_create", map[string]any{"input": map[string]any{"id": newID(), "name": "Write-only"}}, "")
			if receipt["name"] != nil || receipt["id"] == nil {
				t.Fatal("write-only metadata leaked", receipt)
			}
			caller.tool(write, "work_labels_list", map[string]any{}, "forbidden")
			caller.tool(both, "work_items_get", map[string]any{"id": id}, "")
			statusWant(t, f.owner, 404, "GET", b+"/items/W-1", nil)
			statusWant(t, f.owner, 404, "GET", b+"/items/"+newID(), nil)
			caller.tool(read, "work_labels_list", map[string]any{"spaceId": f.personal}, "not_found")
			source := auth.source(f.space, "Planning scope")
			sourceToken, sourceID := auth.token(f.space, "", "work:read", "work:write")
			if _, err := f.app.store.DB.Exec(f.app.store.Query("UPDATE integration_tokens SET source_id=? WHERE id=?"), source["id"], sourceID); err != nil {
				t.Fatal(err)
			}
			caller.tool(sourceToken, "work_labels_list", map[string]any{}, "forbidden")
			tools := f.app.workPlanningIntegrationTools()
			expected := map[string]bool{}
			for _, name := range []string{"work_labels_list", "work_labels_create", "work_labels_update", "work_versions_list", "work_versions_create", "work_versions_update", "work_assignees_list", "work_relations_get", "work_relations_update", "work_views_list", "work_views_create", "work_views_update", "work_views_delete", "work_calendar_get", "work_stats_get", "work_notifications_list", "work_notifications_summary", "work_notifications_read", "work_notifications_settings_get", "work_notifications_settings_update"} {
				expected[name] = true
			}
			if len(tools) != 20 {
				t.Fatal("wrong planning tool count")
			}
			for _, tool := range tools {
				if !expected[tool.name] {
					t.Fatal("unknown or duplicated planning tool", tool.name)
				}
				delete(expected, tool.name)
			}
			if len(expected) != 0 {
				t.Fatal("missing planning tools", expected)
			}
		})
	}
}
func TestWorkPlanningRelationsViewsCalendarWIP(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			b := f.base
			makeItem := func(title string) map[string]any {
				return f.owner.ok("POST", b+"/items", map[string]any{"requestId": newID(), "title": title, "businessDate": "2026-03-08", "dueAt": "2026-03-08T07:30:00Z"})
			}
			parent, child, blocker := makeItem("Parent"), makeItem("Child"), makeItem("Blocker")
			path := workItemPath(f.space, child["id"].(string))
			child = f.owner.ok("PATCH", path+"/relations", map[string]any{"expectedRevision": child["revision"], "parentId": parent["id"], "blockedByIds": []any{blocker["id"]}, "predecessorId": parent["id"]})
			rel := f.owner.ok("GET", path+"/relations", nil)
			if rel["blockedCount"] != float64(1) || rel["isBlocked"] != true || rel["parent"].(map[string]any)["id"] != parent["id"] {
				t.Fatal("relation details", rel)
			}
			before := parent["revision"]
			statusWant(t, f.owner, 409, "PATCH", workItemPath(f.space, parent["id"].(string))+"/relations", map[string]any{"expectedRevision": before, "parentId": child["id"]})
			if fresh := f.owner.ok("GET", workItemPath(f.space, parent["id"].(string)), nil); fresh["revision"] != before {
				t.Fatal("cycle failure changed revision")
			}
			statusWant(t, f.owner, 409, "PATCH", workItemPath(f.space, parent["id"].(string))+"/relations", map[string]any{"expectedRevision": before, "predecessorId": child["id"]})
			statusWant(t, f.owner, 409, "PATCH", workItemPath(f.space, blocker["id"].(string))+"/relations", map[string]any{"expectedRevision": blocker["revision"], "blockedByIds": []any{child["id"]}})
			blocked := f.owner.ok("GET", b+"/items?blocked=true&fields=relations", nil)
			if blocked["total"] != float64(1) || planningItems(blocked)[0].(map[string]any)["relations"].(map[string]any)["blockedCount"] != float64(1) {
				t.Fatal("batched relation summary", blocked)
			}
			blocker = planningPatch(f, blocker, map[string]any{"status": "done"})
			if rel = f.owner.ok("GET", path+"/relations", nil); rel["blockedCount"] != float64(0) || rel["isBlocked"] != false {
				t.Fatal("completed blocker not resolved", rel)
			}
			catalog := f.owner.ok("GET", b+"/statuses", nil)
			f.owner.ok("POST", b+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog["revision"], "patches": []map[string]any{{"id": "todo", "wipLimit": 1}}})
			board := f.owner.ok("GET", b+"/board?q=Child", nil)
			foundWIP := false
			for _, raw := range board["statuses"].([]any) {
				v := raw.(map[string]any)
				if v["id"] == "todo" {
					w := v["wip"].(map[string]any)
					if w["activeCount"] != float64(2) || w["limit"] != float64(1) || w["exceeded"] != true {
						t.Fatal("WIP used filtered count", w)
					}
					foundWIP = true
				}
			}
			if !foundWIP {
				t.Fatal("missing WIP")
			}
			calPath := b + "/calendar?from=2026-03-07&to=2026-03-10&timezone=America%2FNew_York&basis=dueAt&limit=1"
			cal := f.owner.ok("GET", calPath, nil)
			if cal["total"] != float64(3) || len(cal["items"].([]any)) != 1 || len(cal["days"].([]any)) != 3 || cal["days"].([]any)[1].(map[string]any)["total"] != float64(3) {
				t.Fatal("calendar daily totals were derived from first page", cal)
			}
			page2 := f.owner.ok("GET", calPath+"&cursor="+url.QueryEscape(cal["nextCursor"].(string)), nil)
			if planningItems(page2)[0].(map[string]any)["id"] == planningItems(cal)[0].(map[string]any)["id"] {
				t.Fatal("calendar page duplicated item")
			}
			statusWant(t, f.owner, 400, "GET", strings.Replace(calPath, "to=2026-03-10", "to=2026-03-11", 1)+"&cursor="+url.QueryEscape(cal["nextCursor"].(string)), nil)
			definition := map[string]any{"layout": "calendar", "calendarBasis": "dueAt", "filters": map[string]any{"priority": "high", "assigneeUserId": "me"}, "fields": []string{"id", "relations"}}
			privateBody := map[string]any{"id": newID(), "name": "My calendar", "definition": definition}
			view := f.owner.ok("POST", b+"/views", privateBody)
			if view["visibility"] != "private" || view["canEdit"] != true {
				t.Fatal("private view default", view)
			}
			f.owner.ok("POST", b+"/views", privateBody)
			shared := f.owner.ok("POST", b+"/views", map[string]any{"id": newID(), "name": "Shared", "visibility": "shared", "definition": definition})
			planningMultiUser(f)
			account := f.owner.ok("POST", "/admin/users", map[string]any{"username": "secondowner", "displayName": "Second owner", "password": "second owner fixture password"})
			tx, err := f.app.store.DB.Begin()
			if err != nil {
				t.Fatal(err)
			}
			if _, err = tx.Exec("UPDATE users SET role='Member',version=version+1 WHERE role='Owner'"); err != nil {
				tx.Rollback()
				t.Fatal(err)
			}
			if _, err = tx.Exec(f.app.store.Query("UPDATE users SET role='Owner',version=version+1 WHERE id=?"), account["id"]); err != nil {
				tx.Rollback()
				t.Fatal(err)
			}
			if err = tx.Commit(); err != nil {
				t.Fatal(err)
			}
			second := newCoreBrowser(t, f.owner.base)
			second.bootstrap()
			second.ok("POST", "/auth/login", map[string]any{"username": "secondowner", "password": "second owner fixture password"})
			second.bootstrap()
			if got := second.ok("GET", b+"/views?id="+view["id"].(string), nil); got["total"] != float64(0) {
				t.Fatal("another Owner read private view", got)
			}
			statusWant(t, second, 404, "PATCH", b+"/views/"+view["id"].(string), map[string]any{"expectedRevision": view["revision"], "name": "Private bypass"})
			shared = second.ok("PATCH", b+"/views/"+shared["id"].(string), map[string]any{"expectedRevision": shared["revision"], "name": "Shared revised"})
			if shared["name"] != "Shared revised" {
				t.Fatal("shared editor cannot update")
			}
			statusWant(t, second, 400, "POST", b+"/views", map[string]any{"id": newID(), "name": "Unsafe definition", "definition": map[string]any{"layout": "list", "fields": []string{}, "filters": map[string]any{"cursor": "cannot persist cursor"}}})
		})
	}
}
func TestWorkPlanningRelationClaimProtection(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newCollabCoreFixture(t, provider)
			item, target := f.item("Claimed"), f.item("Parent")
			session := f.session("Planner")
			claim := f.claim(item, session)
			path := workItemPath(f.space, item["id"].(string)) + "/relations"
			body := map[string]any{"expectedRevision": item["revision"], "parentId": target["id"]}
			statusWant(t, f.owner, 409, "PATCH", path, body)
			f.call("PATCH", path, body, 409)
			body["context"] = collabCoreContext(session, claim)
			updated := f.call("PATCH", path, body, 200)
			if updated["revision"] == item["revision"] {
				t.Fatal("claim-protected relation update did not apply")
			}
		})
	}
}

func TestWorkPlanningMetricsNoticesAndRestart(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			b := f.base
			create := func(title, status string) map[string]any {
				return f.owner.ok("POST", b+"/items", map[string]any{"requestId": newID(), "title": title, "status": status})
			}
			observed := create("Observed cycle", "doing")
			var start string
			if err := f.app.store.DB.QueryRow(f.app.store.Query("SELECT started_at FROM work_metric_intervals WHERE item_id=? AND kind='cycle' AND ended_at=''"), observed["id"]).Scan(&start); err != nil {
				t.Fatal(err)
			}
			observed = planningPatch(f, observed, map[string]any{"status": "waiting"})
			observed = planningPatch(f, observed, map[string]any{"status": "doing"})
			var kept string
			if err := f.app.store.DB.QueryRow(f.app.store.Query("SELECT started_at FROM work_metric_intervals WHERE item_id=? AND kind='cycle' AND ended_at=''"), observed["id"]).Scan(&kept); err != nil || kept != start {
				t.Fatal("doing re-entry reset the existing cycle", err)
			}
			planningPatch(f, observed, map[string]any{"status": "done"})
			missingStart := create("Completion without doing", "todo")
			planningPatch(f, missingStart, map[string]any{"status": "done"})
			create("Initially done", "done")
			canceled := create("Canceled cycle", "doing")
			catalog := f.owner.ok("GET", b+"/statuses", nil)
			canceledID := newID()
			f.owner.ok("POST", b+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog["revision"], "create": []map[string]any{{"id": canceledID, "name": "Canceled", "type": "canceled"}}})
			planningPatch(f, canceled, map[string]any{"status": canceledID})
			child, blocker := create("Blocked child", "todo"), create("Blocker", "todo")
			child = f.owner.ok("PATCH", workItemPath(f.space, child["id"].(string))+"/relations", map[string]any{"expectedRevision": child["revision"], "blockedByIds": []any{blocker["id"]}})
			today := time.Now().UTC()
			window := "?from=" + today.Format("2006-01-02") + "&to=" + today.AddDate(0, 0, 1).Format("2006-01-02") + "&timezone=UTC"
			open := f.owner.ok("GET", b+"/stats"+window, nil)
			if open["durations"].(map[string]any)["blocked"].(map[string]any)["open"] != float64(1) {
				t.Fatal("ongoing block not separately reported", open)
			}
			planningPatch(f, blocker, map[string]any{"status": "done"})
			stats := f.owner.ok("GET", b+"/stats"+window, nil)
			period := stats["period"].(map[string]any)
			if period["completionEvents"] != float64(3) || period["completedItems"] != float64(3) || period["cancellationEvents"] != float64(1) {
				t.Fatal("invented or missing completion events", period)
			}
			durations := stats["durations"].(map[string]any)
			cycle := durations["cycle"].(map[string]any)
			blocked := durations["blocked"].(map[string]any)
			if cycle["samples"] != float64(1) || cycle["unknown"] != float64(2) || cycle["medianSeconds"] == nil || blocked["samples"] != float64(1) || blocked["open"] != float64(0) || blocked["totalSeconds"] == nil {
				t.Fatal("duration evidence was fabricated or lost", durations)
			}
			empty := f.owner.ok("GET", b+"/stats?from=2000-01-01&to=2000-01-02", nil)
			if empty["durations"].(map[string]any)["cycle"].(map[string]any)["medianSeconds"] != nil {
				t.Fatal("empty duration reported as zero")
			}
			settings := f.owner.ok("GET", b+"/notifications/settings", nil)
			if settings["enabled"] != false {
				t.Fatal("notifications did not default off")
			}
			statusWant(t, f.owner, 400, "PATCH", b+"/notifications/settings", map[string]any{"expectedRevision": settings["revision"], "enabled": nil})
			project := f.owner.ok("POST", b+"/projects", map[string]any{"id": newID(), "name": "Failure target"})
			body := scheduleTestBody("Visible failure")
			body["template"] = map[string]any{"title": "Fail visibly", "projectId": project["id"]}
			schedule := scheduleFromReply(f.owner.ok("POST", b+"/schedules", body))
			path := b + "/schedules/" + schedule["id"].(string)
			f.owner.ok("PATCH", b+"/projects/"+project["id"].(string), map[string]any{"expectedRevision": project["revision"], "archived": true})
			generate := map[string]any{"expectedRevision": schedule["revision"], "businessDate": "2026-01-05"}
			failure := occurrenceFromReply(f.owner.ok("POST", path+"/generate", generate))
			if failure["result"] != "failed" {
				t.Fatal("failed target unexpectedly generated")
			}
			if got := f.owner.ok("GET", b+"/notifications", nil); got["total"] != float64(0) {
				t.Fatal("disabled notices were inserted")
			}
			if summary := f.owner.ok("GET", b+"/notifications/summary", nil); summary["spaceFailures"].(map[string]any)["scheduleFailed"] != float64(1) {
				t.Fatal("disabled notices hid canonical failures", summary)
			}
			settings = f.owner.ok("PATCH", b+"/notifications/settings", map[string]any{"expectedRevision": settings["revision"], "enabled": true})
			f.owner.ok("POST", path+"/generate", generate)
			f.owner.ok("POST", path+"/generate", generate)
			notices := f.owner.ok("GET", b+"/notifications?unread=true", nil)
			if notices["total"] != float64(1) || planningItems(notices)[0].(map[string]any)["count"] != float64(2) {
				t.Fatal("notices did not deduplicate", notices)
			}
			notice := planningItems(notices)[0].(map[string]any)
			auth := &integrationTestBrowser{t: t, base: f.owner.base, client: f.owner.client, csrf: f.owner.csrf}
			caller := integrationBrowser(t, f.owner.base)
			read, _ := auth.token(f.space, "", "work:read")
			caller.tool(read, "work_notifications_read", map[string]any{"input": map[string]any{"ids": []any{notice["id"]}}}, "forbidden")
			f.owner.ok("POST", b+"/notifications/read", map[string]any{"allBefore": notice["lastAt"]})
			if got := f.owner.ok("GET", b+"/notifications?unread=true", nil); got["total"] != float64(0) {
				t.Fatal("allBefore did not mark exact timestamp")
			}
			planningMultiUser(f)
			member := f.owner.ok("POST", "/admin/users", map[string]any{"username": "ineligible", "displayName": "No work access", "password": "ineligible notice password"})
			if _, err := f.app.store.DB.Exec(f.app.store.Query("UPDATE work_schedules SET user_id=? WHERE id=?"), member["id"], schedule["id"]); err != nil {
				t.Fatal(err)
			}
			f.owner.ok("POST", path+"/generate", generate)
			var memberNotices int
			if err := f.app.store.DB.QueryRow(f.app.store.Query("SELECT COUNT(*) FROM work_notices WHERE user_id=?"), member["id"]).Scan(&memberNotices); err != nil || memberNotices != 0 {
				t.Fatal("unauthorized assignee received a notice", err)
			}
			view := f.owner.ok("POST", b+"/views", map[string]any{"id": newID(), "name": "Persistent", "definition": map[string]any{"layout": "list", "filters": map[string]any{}, "fields": []string{"id"}}})
			configuration := f.app.config
			if err := f.app.Close(); err != nil {
				t.Fatal(err)
			}
			f.app.store = nil
			reopened, err := Open(configuration)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			server := httptest.NewServer(reopened)
			defer server.Close()
			browser := newCoreBrowser(t, server.URL)
			browser.bootstrap()
			browser.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": "status fixture password"})
			if got := browser.ok("GET", b+"/notifications/settings", nil); got["enabled"] != true || got["revision"] != settings["revision"] {
				t.Fatal("notification settings lost across restart", got)
			}
			if got := browser.ok("GET", b+"/views?id="+view["id"].(string), nil); got["total"] != float64(1) {
				t.Fatal("saved view lost across restart")
			}
			if got := browser.ok("GET", b+"/items/"+observed["id"].(string), nil); got["id"] != observed["id"] {
				t.Fatal("short ID changed across restart")
			}
		})
	}
}
func TestWorkPlanningAtomicityAndTemplateReuse(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			b := f.base
			label := f.owner.ok("POST", b+"/labels", map[string]any{"id": newID(), "name": "Preserved"})
			body := scheduleTestBody("Planning template")
			body["template"] = map[string]any{"title": "Independent", "priority": "urgent", "labelIds": []any{label["id"]}, "assignee": map[string]any{"name": "Coordinator"}}
			schedule := scheduleFromReply(f.owner.ok("POST", b+"/schedules", body))
			path := b + "/schedules/" + schedule["id"].(string)
			schedule = scheduleFromReply(f.owner.ok("PATCH", path, map[string]any{"expectedRevision": schedule["revision"], "template": map[string]any{"title": "Edited text"}}))
			template := schedule["template"].(map[string]any)
			if template["priority"] != "urgent" || len(template["labelIds"].([]any)) != 1 || template["assignee"] == nil {
				t.Fatal("template omission cleared planning metadata", template)
			}
			occurrence := occurrenceFromReply(f.owner.ok("POST", path+"/generate", map[string]any{"expectedRevision": schedule["revision"], "businessDate": "2026-01-02"}))
			if occurrence["result"] != "created" {
				t.Fatal("template generation failed", occurrence)
			}
			item := f.owner.ok("GET", workItemPath(f.space, occurrence["itemId"].(string)), nil)
			if item["priority"] != "urgent" || item["assignee"].(map[string]any)["name"] != "Coordinator" {
				t.Fatal("planning fields were not copied")
			}
			schedule = scheduleFromReply(f.owner.ok("PATCH", path, map[string]any{"expectedRevision": schedule["revision"], "template": map[string]any{"title": "Cleared", "priority": "", "labelIds": []any{}, "assignee": nil, "versionId": nil}}))
			if template = schedule["template"].(map[string]any); template["priority"] != nil || template["labelIds"] != nil || template["assignee"] != nil {
				t.Fatal("template explicit clear failed", template)
			}
			if old := f.owner.ok("GET", workItemPath(f.space, item["id"].(string)), nil); old["priority"] != "urgent" {
				t.Fatal("template edit rewrote generated work")
			}
			var next int64
			if err := f.app.store.DB.QueryRow("SELECT next_number FROM work_item_sequence WHERE id=1").Scan(&next); err != nil {
				t.Fatal(err)
			}
			trigger := "CREATE TRIGGER fail_planning_activity BEFORE INSERT ON work_activity BEGIN SELECT RAISE(ABORT,'intentional planning rollback'); END"
			if provider == "postgres" {
				trigger = "CREATE FUNCTION fail_planning_activity_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional planning rollback'; END $$; CREATE TRIGGER fail_planning_activity BEFORE INSERT ON work_activity FOR EACH ROW EXECUTE FUNCTION fail_planning_activity_fn()"
			}
			if _, err := f.app.store.DB.Exec(trigger); err != nil {
				t.Fatal(err)
			}
			input := map[string]any{"requestId": newID(), "title": "Atomic allocation", "labelIds": []any{label["id"]}, "status": "doing"}
			statusWant(t, f.owner, 500, "POST", b+"/items", input)
			var after int64
			var count int
			if err := f.app.store.DB.QueryRow("SELECT next_number FROM work_item_sequence WHERE id=1").Scan(&after); err != nil {
				t.Fatal(err)
			}
			if err := f.app.store.DB.QueryRow(f.app.store.Query("SELECT COUNT(*) FROM work_item_labels WHERE item_id=?"), formatWorkItemID(next)).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if next != after || count != 0 {
				t.Fatal("failed transaction leaked number or associations", next, after, count)
			}
			drop := "DROP TRIGGER fail_planning_activity"
			if provider == "postgres" {
				drop = "DROP TRIGGER fail_planning_activity ON work_activity; DROP FUNCTION fail_planning_activity_fn()"
			}
			if _, err := f.app.store.DB.Exec(drop); err != nil {
				t.Fatal(err)
			}
			created := f.owner.ok("POST", b+"/items", input)
			if created["id"] != formatWorkItemID(next) {
				t.Fatal("rollback consumed or reused an unrelated number", created)
			}
		})
	}
}
func TestWorkPlanningMigrationPreservesAndRollsBack(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, rollback := range []bool{false, true} {
			t.Run(fmt.Sprintf("postgres-%v/rollback-%v", postgres, rollback), func(t *testing.T) {
				db, store := documentMigrationDB(t, postgres)
				seedSessionUpgrade(t, db, store, 9, false, nil)
				entries, err := migrationFiles.ReadDir("migrations/" + store.Provider)
				if err != nil {
					t.Fatal(err)
				}
				for _, entry := range entries {
					name := entry.Name()
					if name <= "009_document_activity.sql" || name >= "021_work_planning.sql" || !strings.HasSuffix(name, ".sql") {
						continue
					}
					body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/" + name)
					if err != nil {
						t.Fatal(err)
					}
					if _, err = db.Exec(string(body)); err != nil {
						t.Fatal(name, err)
					}
				}
				for _, id := range []string{"older-b", "older-a"} {
					if _, err = db.Exec(store.Query("INSERT INTO work_items(id,space_id,title,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash) VALUES(?,?,'Old','todo',?,?,1024,7,?,?,?)"), id, "old-space", false, true, "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", "old-create-hash"); err != nil {
						t.Fatal(err)
					}
				}
				before := sessionUpgradeDatabaseState(t, db, store.Provider)
				body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/021_work_planning.sql")
				if err != nil {
					t.Fatal(err)
				}
				tx, err := db.BeginTx(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				statement := string(body)
				if rollback {
					statement += "\nSELECT intentional_planning_migration_failure();"
				}
				_, err = tx.Exec(statement)
				if rollback {
					if err == nil {
						tx.Rollback()
						t.Fatal("failure injection did not fail")
					}
					if err = tx.Rollback(); err != nil {
						t.Fatal(err)
					}
				} else {
					if err != nil {
						tx.Rollback()
						t.Fatal(err)
					}
					if err = tx.Commit(); err != nil {
						t.Fatal(err)
					}
				}
				for table, original := range before {
					if !reflect.DeepEqual(original, componentCaptureRows(t, db, table, original.columns)) {
						t.Fatalf("planning migration changed original %s", table)
					}
				}
				var number int64
				err = db.QueryRow("SELECT number FROM work_items WHERE id='older-a'").Scan(&number)
				if rollback {
					if err == nil {
						t.Fatal("rolled back number survived")
					}
					if _, err = db.Exec("SELECT 1 FROM work_views"); err == nil {
						t.Fatal("rolled back views survived")
					}
					return
				}
				if err != nil || number != 1 {
					t.Fatal("deterministic migration numbering", number, err)
				}
				if err = db.QueryRow("SELECT number FROM work_items WHERE id='older-b'").Scan(&number); err != nil || number != 2 {
					t.Fatal("deterministic tied creation ordering", number, err)
				}
				var enabled bool
				if err = db.QueryRow("SELECT work_notifications_enabled FROM spaces WHERE id='old-space'").Scan(&enabled); err != nil || enabled {
					t.Fatal("migration enabled notifications", err)
				}
				var events int
				if err = db.QueryRow("SELECT COUNT(*) FROM work_metric_intervals").Scan(&events); err != nil || events != 0 {
					t.Fatal("migration fabricated time intervals", err)
				}
			})
		}
	}
}
