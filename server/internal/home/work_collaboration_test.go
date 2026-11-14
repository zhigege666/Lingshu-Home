package home

import (
	"fmt"
	"net/url"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"
)

type collabCoreFixture struct {
	*workStatusFixture
	api   *integrationTestBrowser
	token string
}

func newCollabCoreFixture(t *testing.T, provider string) *collabCoreFixture {
	f := newWorkStatusFixture(t, provider)
	owner := &integrationTestBrowser{t: t, base: f.owner.base, client: f.owner.client, csrf: f.owner.csrf}
	token, _ := owner.token(f.space, "", "work:read", "work:write")
	f.app.config.MCPCollaborationEnabled = true
	return &collabCoreFixture{f, integrationBrowser(t, f.owner.base), token}
}
func (f *collabCoreFixture) call(method, path string, in any, status int) map[string]any {
	return f.api.object(method, "/api/v1"+path, in, status, f.token)
}
func (f *collabCoreFixture) session(name string) map[string]any {
	return f.call("POST", f.base+"/sessions", map[string]any{"registrationId": newID(), "agentName": name, "clientName": "Core test", "role": "implementation"}, 200)
}
func (f *collabCoreFixture) item(title string) map[string]any {
	return f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": title})
}
func collabCoreContext(session, claim map[string]any) map[string]any {
	return map[string]any{"sessionId": session["id"], "claimId": claim["claimId"], "claimGeneration": claim["generation"], "operationId": newID()}
}
func (f *collabCoreFixture) claim(item, session map[string]any) map[string]any {
	return f.call("POST", workItemPath(f.space, item["id"].(string))+"/claim", map[string]any{"sessionId": session["id"], "operationId": newID(), "expectedRevision": item["revision"], "expectedGeneration": "0"}, 200)
}
func collabCoreAssertBusiness(t *testing.T, before, after map[string]any) {
	t.Helper()
	for _, key := range []string{"revision", "updatedAt", "boardRevision", "status", "title"} {
		if !reflect.DeepEqual(before[key], after[key]) {
			t.Fatalf("business %s changed during collaboration: before=%v after=%v", key, before[key], after[key])
		}
	}
}
func (f *collabCoreFixture) expire(t *testing.T, id string) {
	t.Helper()
	if _, err := f.app.store.DB.Exec(f.app.store.Query("UPDATE work_claims SET expires_at=? WHERE item_id=?"), time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano), id); err != nil {
		t.Fatal(err)
	}
}

func TestWorkCollaborationContentionRecoveryAndOffProtection(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newCollabCoreFixture(t, provider)
			one, two := f.session("one"), f.session("two")
			item := f.item("One shared task")
			path := workItemPath(f.space, item["id"].(string))
			type attempt struct {
				status  int
				body    map[string]any
				input   map[string]any
				session map[string]any
			}
			out := make(chan attempt, 2)
			var wg sync.WaitGroup
			for _, session := range []map[string]any{one, two} {
				wg.Add(1)
				go func(session map[string]any) {
					defer wg.Done()
					in := map[string]any{"sessionId": session["id"], "operationId": newID(), "expectedRevision": item["revision"], "expectedGeneration": "0"}
					status, body, _ := f.api.raw("POST", "/api/v1"+path+"/claim", in, f.token, nil)
					out <- attempt{status, integrationObject(t, body), in, session}
				}(session)
			}
			wg.Wait()
			close(out)
			var winner, loser attempt
			success := 0
			for result := range out {
				if result.status == 200 {
					winner = result
					success++
				} else {
					loser = result
					if result.status != 409 {
						t.Fatalf("unexpected claim status %d", result.status)
					}
				}
			}
			if success != 1 {
				t.Fatalf("exactly one of two same-token sessions must claim; got %d", success)
			}
			replay := f.call("POST", path+"/claim", winner.input, 200)
			if !reflect.DeepEqual(replay, winner.body) {
				t.Fatal("claim retry did not return original receipt")
			}
			bad := map[string]any{}
			for k, v := range winner.input {
				bad[k] = v
			}
			bad["leaseSeconds"] = 300
			f.call("POST", path+"/claim", bad, 409)
			current := f.owner.ok("GET", path, nil)
			collabCoreAssertBusiness(t, item, current)
			statusWant(t, f.owner, 409, "PATCH", path, map[string]any{"expectedRevision": current["revision"], "title": "human bypass"})
			f.call("PATCH", path, map[string]any{"expectedRevision": current["revision"], "archived": true}, 409)
			f.call("POST", f.base+"/sessions/"+winner.session["id"].(string)+"/close", map[string]any{"operationId": newID()}, 409)
			rev := f.owner.ok("GET", f.base+"/revision", nil)
			renew := collabCoreContext(winner.session, winner.body)
			renew["leaseSeconds"] = 300
			f.call("POST", path+"/claim/renew", renew, 200)
			afterRenew := f.owner.ok("GET", path, nil)
			collabCoreAssertBusiness(t, current, afterRenew)
			if !reflect.DeepEqual(rev, f.owner.ok("GET", f.base+"/revision", nil)) {
				t.Fatal("heartbeat changed a business or collaboration revision")
			}
			f.expire(t, item["id"].(string))
			renew["operationId"] = newID()
			f.call("POST", path+"/claim/renew", renew, 409)
			recovery := map[string]any{"sessionId": loser.session["id"], "operationId": newID(), "expectedRevision": item["revision"], "expectedGeneration": winner.body["generation"]}
			f.call("POST", path+"/claim", recovery, 409)
			recovery["recovery"] = map[string]any{"reason": "Checked external operation result; previous worker stopped.", "externalOperationsStopped": true}
			next := f.call("POST", path+"/claim", recovery, 200)
			oldContext := collabCoreContext(winner.session, winner.body)
			f.call("PATCH", path, map[string]any{"expectedRevision": afterRenew["revision"], "title": "stale worker", "context": oldContext}, 409)
			f.app.config.MCPCollaborationEnabled = false
			statusWant(t, f.owner, 409, "PATCH", path, map[string]any{"expectedRevision": afterRenew["revision"], "title": "off bypass"})
			f.call("PATCH", path, map[string]any{"expectedRevision": afterRenew["revision"], "title": "token off bypass"}, 409)
			f.call("POST", path+"/claim/renew", collabCoreContext(loser.session, next), 200)
			handoff := collabCoreContext(loser.session, next)
			handoff["handoff"] = map[string]any{"completed": "Prepared source", "workspace": "test checkout", "nextStep": "Verify remote publish", "unknowns": "Publish outcome unknown"}
			handoff["reason"] = "pause"
			released := f.call("POST", path+"/claim/release", handoff, 200)
			if released["state"] != "released" || released["unresolved"] != true {
				t.Fatal("uncertain handoff did not remain unresolved")
			}
			f.call("POST", f.base+"/sessions/"+loser.session["id"].(string)+"/close", map[string]any{"operationId": newID()}, 409)
			statusWant(t, f.owner, 409, "PATCH", path, map[string]any{"expectedRevision": afterRenew["revision"], "title": "unresolved bypass"})
			resolve := map[string]any{"operationId": newID(), "expectedGeneration": released["generation"], "reason": "Verified publish stopped and result recorded", "externalOperationsStopped": true}
			f.call("POST", path+"/claim/resolve", resolve, 403)
			resolved := f.owner.ok("POST", path+"/claim/resolve", resolve)
			if resolved["unresolved"] != false || resolved["generation"] == released["generation"] {
				t.Fatal("human recovery did not invalidate the old generation")
			}
			f.call("POST", f.base+"/sessions/"+loser.session["id"].(string)+"/close", map[string]any{"operationId": newID()}, 200)
			f.owner.ok("PATCH", path, map[string]any{"expectedRevision": afterRenew["revision"], "title": "Resolved human edit"})
			f.call("POST", f.base+"/sessions", map[string]any{"registrationId": newID(), "agentName": "disabled"}, 409)
			f.call("POST", path+"/claim", map[string]any{"sessionId": winner.session["id"], "operationId": newID(), "expectedRevision": "2", "expectedGeneration": resolved["generation"]}, 409)
		})
	}
}

func TestWorkCollaborationEventsSnapshotAndIsolation(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newCollabCoreFixture(t, provider)
			one, two := f.session("one"), f.session("reviewer")
			item := f.item("Event ledger")
			path := workItemPath(f.space, item["id"].(string))
			before := f.owner.ok("GET", path, nil)
			var wg sync.WaitGroup
			for i := 0; i < 8; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					session := one
					if i%2 == 1 {
						session = two
					}
					f.call("POST", path+"/events", map[string]any{"sessionId": session["id"], "operationId": newID(), "kind": "note", "body": fmt.Sprintf("parallel %d", i)}, 200)
				}(i)
			}
			wg.Wait()
			first := f.call("GET", path+"/events?limit=3", nil, 200)
			watermark := first["highWatermark"].(string)
			if first["nextCursor"] == nil {
				t.Fatal("expected stable event cursor")
			}
			cursor := first["nextCursor"].(string)
			f.call("GET", path+"/events?cursor="+url.QueryEscape(cursor+"x"), nil, 400)
			other := f.item("Other item")
			f.call("GET", workItemPath(f.space, other["id"].(string))+"/events?cursor="+url.QueryEscape(cursor), nil, 400)
			appendInput := map[string]any{"sessionId": two["id"], "operationId": newID(), "kind": "review", "body": "arrived after the snapshot"}
			late := f.call("POST", path+"/events", appendInput, 200)
			if late["operationId"] != appendInput["operationId"] {
				t.Fatal("event has no original operation ID")
			}
			if !reflect.DeepEqual(late, f.call("POST", path+"/events", appendInput, 200)) {
				t.Fatal("append event retry duplicated or changed its receipt")
			}
			seen := map[string]bool{}
			page := first
			for {
				if page["highWatermark"] != watermark {
					t.Fatal("pagination snapshot changed")
				}
				for _, raw := range page["items"].([]any) {
					event := raw.(map[string]any)
					id := event["id"].(string)
					if seen[id] || id == late["id"] {
						t.Fatal("snapshot duplicated or included a later event")
					}
					seen[id] = true
				}
				if page["nextCursor"] == nil {
					break
				}
				page = f.call("GET", path+"/events?cursor="+url.QueryEscape(page["nextCursor"].(string)), nil, 200)
			}
			if len(seen) != 8 {
				t.Fatalf("snapshot lost append events: %d", len(seen))
			}
			increment := f.call("GET", path+"/events?after="+watermark, nil, 200)
			if len(increment["items"].([]any)) != 1 || increment["items"].([]any)[0].(map[string]any)["id"] != late["id"] {
				t.Fatal("after watermark did not return the later event")
			}
			// The space-bound token cannot reuse an item, cursor, or session in another space.
			f.call("GET", "/spaces/"+f.personal+"/work/items/"+item["id"].(string)+"/events", nil, 404)
			statusWant(t, f.owner, 404, "GET", "/spaces/"+f.personal+"/work/sessions/"+one["id"].(string), nil)
			statusWant(t, f.owner, 404, "POST", "/spaces/"+f.personal+"/work/sessions", map[string]any{"registrationId": newID(), "agentName": "wrong parent", "parentSessionId": one["id"]})
			// A web note has real human attribution without pretending to be an Agent.
			note := f.owner.ok("POST", path+"/events", map[string]any{"operationId": newID(), "kind": "note", "body": "Human verified the output"})
			if note["origin"] != "web" || note["session"] != nil || note["actor"] == nil {
				t.Fatal("web note attribution is incorrect")
			}
			// Adding other items affects the board, but independent events must not edit this item.
			after := f.owner.ok("GET", path, nil)
			for _, key := range []string{"revision", "updatedAt", "status", "title"} {
				if before[key] != after[key] {
					t.Fatalf("events changed item field %s", key)
				}
			}
		})
	}
}

func TestWorkCollaborationTerminalReleaseAtomicAndReplay(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newCollabCoreFixture(t, provider)
			session := f.session("implementer")
			create := map[string]any{"id": newID(), "title": "Atomic completion", "context": map[string]any{"sessionId": session["id"], "operationId": newID()}}
			item := f.call("POST", f.base+"/items", create, 200)
			path := workItemPath(f.space, item["id"].(string))
			claim := f.claim(item, session)
			input := map[string]any{"expectedRevision": item["revision"], "status": "done", "result": "Verified deliverable", "context": collabCoreContext(session, claim)}
			trigger := "CREATE TRIGGER fail_collaboration_event BEFORE INSERT ON work_collaboration_events BEGIN SELECT RAISE(ABORT,'intentional collaboration failure'); END"
			if provider == "postgres" {
				trigger = "CREATE FUNCTION fail_collaboration_event_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional collaboration failure'; END $$; CREATE TRIGGER fail_collaboration_event BEFORE INSERT ON work_collaboration_events FOR EACH ROW EXECUTE FUNCTION fail_collaboration_event_fn()"
			}
			if _, err := f.app.store.DB.Exec(trigger); err != nil {
				t.Fatal(err)
			}
			f.call("PATCH", path, input, 500)
			rollback := f.owner.ok("GET", path, nil)
			collabCoreAssertBusiness(t, item, rollback)
			if rollback["collaboration"].(map[string]any)["state"] != "active" {
				t.Fatal("failed terminal event released claim outside the item transaction")
			}
			if _, err := f.app.store.DB.Exec("DROP TRIGGER fail_collaboration_event" + map[string]string{"postgres": " ON work_collaboration_events"}[provider]); err != nil {
				t.Fatal(err)
			}
			done := f.call("PATCH", path, input, 200)
			if done["status"] != "done" || done["collaboration"].(map[string]any)["state"] != "released" {
				t.Fatal("terminal update did not atomically release claim")
			}
			replay := f.call("PATCH", path, input, 200)
			if replay["replayed"] != true || replay["revision"] != done["revision"] || replay["references"] != nil {
				t.Fatal("mutation retry is not a scope-safe original receipt")
			}
			late := map[string]any{"expectedRevision": done["revision"], "description": "late owner", "context": collabCoreContext(session, claim)}
			f.call("PATCH", path, late, 409)
			f.call("POST", path+"/claim", map[string]any{"sessionId": session["id"], "operationId": newID(), "expectedRevision": done["revision"], "expectedGeneration": claim["generation"]}, 409)
			activity := f.owner.ok("GET", path+"/activity", nil)
			events := activity["items"].([]any)
			if len(events) != 2 {
				t.Fatal("failed terminal mutation left extra activity")
			}
			for _, raw := range events {
				event := raw.(map[string]any)
				if event["session"].(map[string]any)["id"] != session["id"] || event["actor"] == nil || event["origin"] != "api" {
					t.Fatal("session activity replaced or lost the trusted principal")
				}
			}
			f.call("POST", f.base+"/sessions/"+session["id"].(string)+"/close", map[string]any{"operationId": newID()}, 200)
			// Same creation request must be replayable after flag changes and session close.
			f.app.config.MCPCollaborationEnabled = false
			createdAgain := f.call("POST", f.base+"/items", create, 200)
			if createdAgain["id"] != item["id"] {
				t.Fatal("create receipt changed identity")
			}
		})
	}
}

func TestWorkCollaborationLegacyCompatibilityAndStatusGuard(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newCollabCoreFixture(t, provider)
			f.app.config.MCPCollaborationEnabled = false
			input := map[string]any{"id": newID(), "title": "Original create before upgrade"}
			item := f.call("POST", f.base+"/items", input, 200)
			f.app.config.MCPCollaborationEnabled = true
			same := f.call("POST", f.base+"/items", input, 200)
			if same["id"] != item["id"] || same["revision"] != item["revision"] {
				t.Fatal("legacy hash changed after collaboration enabled")
			}
			f.call("POST", f.base+"/items", map[string]any{"id": newID(), "title": "New without session"}, 409)
			registration := map[string]any{"registrationId": newID(), "agentName": "Session name"}
			session := f.call("POST", f.base+"/sessions", registration, 200)
			if !reflect.DeepEqual(session, f.call("POST", f.base+"/sessions", registration, 200)) {
				t.Fatal("session registration replay changed identity")
			}
			registration["agentName"] = "Different"
			f.call("POST", f.base+"/sessions", registration, 409)
			catalog := f.owner.ok("GET", f.base+"/statuses", nil)
			statusID := newID()
			catalog = f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog["revision"], "create": []map[string]any{{"id": statusID, "name": "Agent running", "type": "doing"}}})
			item = f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Protected custom state", "status": statusID})
			claim := f.claim(item, session)
			path := workItemPath(f.space, item["id"].(string))
			for _, change := range []map[string]any{{"expectedRevision": catalog["revision"], "patches": []map[string]any{{"id": statusID, "type": "done"}}}, {"expectedRevision": catalog["revision"], "deletions": []map[string]any{{"id": statusID, "moveToStatus": "done"}}}} {
				statusWant(t, f.owner, 409, "POST", f.base+"/statuses/batch-edit", change)
			}
			// A name/description edit remains available without changing the task's meaning.
			catalog = f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog["revision"], "patches": []map[string]any{{"id": statusID, "name": "In progress", "description": "Entry and exit checked"}}})
			badContext := collabCoreContext(session, claim)
			badContext["force"] = true
			f.call("PATCH", path, map[string]any{"expectedRevision": item["revision"], "title": "unknown context field", "context": badContext}, 400)
			for _, lease := range []any{0, nil, 299, 7201, 300.5, "300"} {
				f.call("POST", path+"/claim/renew", map[string]any{"sessionId": session["id"], "claimId": claim["claimId"], "claimGeneration": claim["generation"], "operationId": newID(), "leaseSeconds": lease}, 400)
			}
			f.owner.ok("POST", path+"/claim/resolve", map[string]any{"operationId": newID(), "expectedGeneration": claim["generation"], "reason": "Worker stopped before changing the shared workflow", "externalOperationsStopped": true})
			f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog["revision"], "patches": []map[string]any{{"id": statusID, "type": "done"}}})
			current := f.owner.ok("GET", path, nil)
			if current["statusDefinition"].(map[string]any)["type"] != "done" {
				t.Fatal("resolved status change did not apply")
			}
			if generation, err := strconv.Atoi(current["collaboration"].(map[string]any)["generation"].(string)); err != nil || generation < 2 {
				t.Fatal("resolved claim did not retain a fencing generation")
			}
		})
	}
}
