package home

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func automationTestRun(t *testing.T, a *App, id string) {
	t.Helper()
	err := a.integrationTransaction(context.Background(), func(q Queryer) error {
		v, err := scanWorkAutomationEvent(q.QueryRowContext(context.Background(), a.store.Query("SELECT "+workAutomationEventColumns+" FROM work_automation_events WHERE id=?"), id))
		if err != nil {
			return err
		}
		settings, err := a.loadSettings(context.Background(), q)
		if err != nil {
			return err
		}
		h, _ := http.NewRequestWithContext(context.Background(), "POST", "http://localhost/internal/test-event", nil)
		return a.processWorkAutomationEvent(&Request{App: a, Q: q, Settings: settings, HTTP: h}, v)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func automationTestRule(name, event string) map[string]any {
	return map[string]any{"id": newID(), "name": name, "eventType": event, "template": map[string]any{"title": name}, "enabled": true}
}
func automationObject(v map[string]any, key string) map[string]any { return v[key].(map[string]any) }

func TestWorkAutomationEventsAndAtomicity(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			a, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Automation", "mode": ModePublicRead, "username": "owner", "password": "automation fixture password", "seedDemo": false})
			space := coreSpace(owner.bootstrap(), "shared")
			base := "/spaces/" + space + "/work"
			a.cancel()
			a.workers.Wait()
			settings := owner.ok("GET", base+"/automation/settings", nil)
			if settings["enabled"] != false {
				t.Fatal("automation enabled by upgrade")
			}
			ruleBody := automationTestRule("Sync follow-up", "sync.finished")
			rule := automationObject(owner.ok("POST", base+"/automation/rules", ruleBody), "rule")
			ruleID := rule["id"].(string)
			if got := owner.ok("POST", base+"/automation/rules", ruleBody); got["replayed"] != true {
				t.Fatal("rule creation not replay-safe")
			}
			eventBody := map[string]any{"id": newID(), "type": "sync.finished", "summary": "Actual sync result"}
			statusWant(t, owner, 409, "POST", base+"/automation/events", eventBody)
			owner.ok("PATCH", base+"/automation/settings", map[string]any{"expectedRevision": settings["revision"], "enabled": true})
			event := automationObject(owner.ok("POST", base+"/automation/events", eventBody), "event")
			id := event["id"].(string)
			automationTestRun(t, a, id)
			detail := owner.ok("GET", base+"/automation/events/"+id, nil)
			receipts := detail["receipts"].([]any)
			if automationObject(detail, "event")["state"] != "processed" || len(receipts) != 1 {
				t.Fatal("event did not process once", detail)
			}
			receipt := receipts[0].(map[string]any)
			if receipt["result"] != "created" {
				t.Fatal(receipt)
			}
			itemID := receipt["itemId"].(string)
			item := owner.ok("GET", workItemPath(space, itemID)+"?activityLimit=10", nil)
			activity := automationObject(item, "activity")["items"].([]any)[0].(map[string]any)
			if item["title"] != "Sync follow-up" || activity["origin"] != "automation" || activity["session"] != nil {
				t.Fatal("automation lost provenance or forged a session", item)
			}
			automationTestRun(t, a, id)
			replay := owner.ok("POST", base+"/automation/events", eventBody)
			if replay["replayed"] != true || replay["receipts"].([]any)[0].(map[string]any)["itemId"] != itemID {
				t.Fatal("event replay duplicated work", replay)
			}
			changed := map[string]any{"id": id, "type": "sync.finished", "summary": "Different content"}
			statusWant(t, owner, 409, "POST", base+"/automation/events", changed)
			// Server-observed events are emitted once; generated work cannot recurse.
			owner.ok("POST", base+"/automation/rules", automationTestRule("Created follow-up", "work.created"))
			created := owner.ok("POST", base+"/items", map[string]any{"id": newID(), "title": "Actual source"})
			var internal string
			if err := a.store.DB.QueryRow(a.store.Query("SELECT id FROM work_automation_events WHERE source_item_id=? AND event_type='work.created'"), created["id"]).Scan(&internal); err != nil {
				t.Fatal(err)
			}
			automationTestRun(t, a, internal)
			var events int
			if err := a.store.DB.QueryRow("SELECT COUNT(*) FROM work_automation_events WHERE event_type='work.created'").Scan(&events); err != nil || events != 1 {
				t.Fatal("recursive automation emitted more events", events, err)
			}
			statusWant(t, owner, 400, "POST", base+"/automation/events", map[string]any{"id": newID(), "type": "work.completed", "summary": "Cannot forge observed completion"})
			// A storage abort after item/receipt work must roll back both and keep
			// the event queued. This is the same transaction used by the worker.
			atomic := automationObject(owner.ok("POST", base+"/automation/events", map[string]any{"id": newID(), "type": "sync.finished", "summary": "Atomic"}), "event")
			atomicID := atomic["id"].(string)
			sentinel := errors.New("injected commit abort")
			err := a.integrationTransaction(context.Background(), func(q Queryer) error {
				v, err := scanWorkAutomationEvent(q.QueryRowContext(context.Background(), a.store.Query("SELECT "+workAutomationEventColumns+" FROM work_automation_events WHERE id=?"), atomicID))
				if err != nil {
					return err
				}
				settings, err := a.loadSettings(context.Background(), q)
				if err != nil {
					return err
				}
				h, _ := http.NewRequest("POST", "http://localhost/test", nil)
				if err = a.processWorkAutomationEvent(&Request{App: a, Q: q, Settings: settings, HTTP: h}, v); err != nil {
					return err
				}
				return sentinel
			})
			if !errors.Is(err, sentinel) {
				t.Fatal(err)
			}
			after := owner.ok("GET", base+"/automation/events/"+atomicID, nil)
			if automationObject(after, "event")["state"] != "queued" || len(after["receipts"].([]any)) != 0 {
				t.Fatal("aborted event survived", after)
			}
			var count int
			a.store.DB.QueryRow(a.store.Query("SELECT COUNT(*) FROM work_items WHERE id=?"), workAutomationDerivedID("item", atomicID, ruleID)).Scan(&count)
			if count != 0 {
				t.Fatal("aborted item survived")
			}
			automationTestRun(t, a, atomicID)
			// Invalid saved target yields an explicit failure. It never falls back
			// to a default status, and explicit repaired retry reuses a stable ID.
			var template WorkScheduleTemplate
			b, _ := json.Marshal(rule["template"])
			json.Unmarshal(b, &template)
			template.Status = newID()
			if _, err := a.store.DB.Exec(a.store.Query("UPDATE work_automation_rules SET template_json=? WHERE id=?"), jsonString(template), ruleID); err != nil {
				t.Fatal(err)
			}
			failed := automationObject(owner.ok("POST", base+"/automation/events", map[string]any{"id": newID(), "type": "sync.finished", "summary": "Invalid target"}), "event")
			failedID := failed["id"].(string)
			automationTestRun(t, a, failedID)
			failedDetail := owner.ok("GET", base+"/automation/events/"+failedID, nil)
			badReceipt := failedDetail["receipts"].([]any)[0].(map[string]any)
			if badReceipt["result"] != "failed" || badReceipt["itemId"] != nil {
				t.Fatal("failed generation reported success", badReceipt)
			}
			repaired := automationObject(owner.ok("PATCH", base+"/automation/rules/"+ruleID, map[string]any{"expectedRevision": rule["revision"], "template": map[string]any{"title": "Repaired", "status": "todo"}}), "rule")
			retried := owner.ok("POST", base+"/automation/events/"+failedID+"/retry", map[string]any{"expectedRevision": automationObject(failedDetail, "event")["revision"], "ruleId": ruleID, "expectedRuleRevision": repaired["revision"]})
			if retried["receipts"].([]any)[0].(map[string]any)["result"] != "created" {
				t.Fatal("explicit repaired retry failed", retried)
			}
			// Pagination tokens are scoped to unchanged filters and the same space.
			page := owner.ok("GET", base+"/automation/events?limit=1", nil)
			if page["nextCursor"] == nil {
				t.Fatal("missing event cursor")
			}
			statusWant(t, owner, 400, "GET", base+"/automation/events?state=failed&cursor="+url.QueryEscape(page["nextCursor"].(string)), nil)
		})
	}
}

func TestWorkExecutorsPermissionsAndReceipts(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			a, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Executions", "mode": ModePublicRead, "username": "owner", "password": "automation fixture password", "seedDemo": false})
			space := coreSpace(owner.bootstrap(), "shared")
			base := "/spaces/" + space + "/work"
			a.cancel()
			a.workers.Wait()
			body := map[string]any{"id": newID(), "name": "Private runner", "endpoint": "http://192.168.25.20:39999", "allowPrivateNetwork": true, "resourceKey": "test:resource", "enabled": true, "secret": map[string]any{"bearerToken": "example-test-secret"}}
			executor := automationObject(owner.ok("POST", base+"/executors", body), "executor")
			id := executor["id"].(string)
			if executor["credentialConfigured"] != true {
				t.Fatal(executor)
			}
			encoded, _ := json.Marshal(executor)
			if strings.Contains(string(encoded), "example-test-secret") || strings.Contains(string(encoded), "credentialCipher") {
				t.Fatal("executor disclosed credential")
			}
			var cipher string
			if err := a.store.DB.QueryRow(a.store.Query("SELECT credential_cipher FROM work_executors WHERE id=?"), id).Scan(&cipher); err != nil || cipher == "" || strings.Contains(cipher, "example-test-secret") {
				t.Fatal("executor secret not encrypted", err)
			}
			if got := owner.ok("POST", base+"/executors", body); got["replayed"] != true {
				t.Fatal("executor creation not idempotent")
			}
			for _, endpoint := range []string{"http://127.0.0.1:80", "https://169.254.169.254", "http://example.com", "https://user:password@example.com", "https://example.com?token=secret"} {
				bad := map[string]any{"id": newID(), "name": "Bad", "endpoint": endpoint, "resourceKey": "bad", "allowPrivateNetwork": true}
				statusWant(t, owner, 400, "POST", base+"/executors", bad)
			}
			statusWant(t, owner, 400, "PATCH", base+"/executors/"+id, map[string]any{"expectedRevision": "1", "timeoutSeconds": nil})
			item := owner.ok("POST", base+"/items", map[string]any{"id": newID(), "title": "Execute once"})
			start := map[string]any{"id": newID(), "executorId": id, "itemId": item["id"], "expectedItemRevision": item["revision"]}
			execution := automationObject(owner.ok("POST", base+"/executions", start), "execution")
			executionID := execution["id"].(string)
			if execution["state"] != "queued" {
				t.Fatal(execution)
			}
			statusWant(t, owner, 409, "PATCH", base+"/executors/"+id, map[string]any{"expectedRevision": "1", "resourceKey": "another-resource"})
			statusWant(t, owner, 409, "POST", base+"/executions", map[string]any{"id": newID(), "executorId": id, "itemId": item["id"], "expectedItemRevision": item["revision"]})
			item = owner.ok("PATCH", workItemPath(space, item["id"].(string)), map[string]any{"expectedRevision": item["revision"], "nextStep": "Changed after queuing"})
			if got := owner.ok("POST", base+"/executions", start); got["replayed"] != true || automationObject(got, "execution")["id"] != executionID {
				t.Fatal("execution replay lost original receipt", got)
			}
			resolved := automationObject(owner.ok("POST", base+"/executions/"+executionID+"/resolve", map[string]any{"expectedRevision": execution["revision"], "outcome": "canceled", "note": "Canceled before any dispatch"}), "execution")
			if resolved["state"] != "canceled" || resolved["manualResolution"] != true {
				t.Fatal(resolved)
			}
			current := owner.ok("GET", workItemPath(space, item["id"].(string)), nil)
			if current["status"] != "todo" || current["revision"] != item["revision"] {
				t.Fatal("execution resolution changed business result", current)
			}
			auth := &integrationTestBrowser{t: t, base: server.URL, client: owner.client, csrf: owner.csrf}
			caller := integrationBrowser(t, server.URL)
			read, _ := auth.token(space, "", "work:read")
			write, _ := auth.token(space, "", "work:write")
			both, _ := auth.token(space, "", "work:read", "work:write")
			full, _ := auth.token(space, "", "work:read", "work:write", "work:execute")
			caller.tool(read, "work_executors_create", map[string]any{"input": body}, "forbidden")
			caller.tool(both, "work_executions_start", map[string]any{"input": start}, "forbidden")
			caller.tool(write, "work_automation_rules_get", map[string]any{"id": newID()}, "forbidden")
			minimal := caller.tool(write, "work_automation_rules_create", map[string]any{"input": automationTestRule("Write-only", "test.finished")}, "")
			if minimal["rule"] != nil || minimal["id"] == nil {
				t.Fatal("write-only rule leaked existing content", minimal)
			}
			caller.tool(full, "work_executors_get", map[string]any{"id": id}, "")
			// A caller without execute cannot trigger an executable rule indirectly.
			owner.ok("PATCH", base+"/automation/settings", map[string]any{"expectedRevision": "1", "enabled": true})
			ruleBody := automationTestRule("Privileged rule", "external.finished")
			ruleBody["executorId"] = id
			owner.ok("POST", base+"/automation/rules", ruleBody)
			eventBody := map[string]any{"id": newID(), "type": "external.finished", "summary": "Write scope is insufficient"}
			caller.tool(write, "work_automation_events_publish", map[string]any{"input": eventBody}, "")
			automationTestRun(t, a, eventBody["id"].(string))
			event := owner.ok("GET", base+"/automation/events/"+eventBody["id"].(string), nil)
			receipt := event["receipts"].([]any)[0].(map[string]any)
			if receipt["result"] != "failed" || receipt["code"] != "forbidden" || receipt["itemId"] != nil || receipt["executionId"] != nil {
				t.Fatal("write-only token caused indirect execution", event)
			}
			var enabled bool
			var count int
			if err := a.store.DB.QueryRow(a.store.Query("SELECT work_automation_enabled,work_automation_rule_count FROM spaces WHERE id=?"), space).Scan(&enabled, &count); err != nil || !enabled || count != 2 {
				t.Fatal("materialized rule count diverged", enabled, count, err)
			}
		})
	}
}

func TestWorkAutomationDisabledHookAndSchema(t *testing.T) {
	// A nil Queryer makes any accidental disabled-path SQL fail immediately.
	a := &App{}
	h, _ := http.NewRequest("POST", "http://localhost/test", nil)
	for _, space := range []*Space{nil, {WorkAutomationEnabled: false, WorkAutomationRuleCount: 2}, {WorkAutomationEnabled: true, WorkAutomationRuleCount: 0}} {
		r := &Request{App: a, HTTP: h, WorkSpaceContext: space}
		if err := a.enqueueWorkActivityAutomation(r, "space", "item", "activity", "create", "", nil); err != nil {
			t.Fatal(err)
		}
		if r.WakeWorkAutomation {
			t.Fatal("disabled hook woke a worker")
		}
	}
	tools := a.workAutomationIntegrationTools()
	names := map[string]bool{}
	for _, tool := range tools {
		if names[tool.name] {
			t.Fatal("duplicate tool", tool.name)
		}
		names[tool.name] = true
		if tool.input != nil && tool.input["additionalProperties"] != false {
			t.Fatal("non-strict automation schema", tool.name)
		}
	}
	if len(names) != 19 {
		t.Fatal("wrong automation tool inventory", len(names))
	}
	if !reflect.DeepEqual(names["work_automation_events_publish"], true) || names["work_events_publish"] {
		t.Fatal("automation collides with collaboration event tools")
	}
}
