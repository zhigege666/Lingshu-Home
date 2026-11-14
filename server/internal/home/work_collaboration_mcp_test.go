package home

import (
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestMCPCollaborationConfiguration(t *testing.T) {
	for key, value := range map[string]string{
		"LINGSHU_STORAGE_PROVIDER": "sqlite", "LINGSHU_DATABASE_URL": "", "LINGSHU_SECURE_COOKIES": "false",
		"LINGSHU_LANGUAGE": "en", "LINGSHU_DATA_DIR": t.TempDir(), "LINGSHU_TLS_CERT_FILE": "", "LINGSHU_TLS_KEY_FILE": "",
		"LINGSHU_DOCUMENT_ROOTS": "[]", "LINGSHU_MCP_WORKFLOW_ENABLED": "false", "LINGSHU_MCP_COLLABORATION_ENABLED": "false",
	} {
		t.Setenv(key, value)
	}
	if err := os.Unsetenv("LINGSHU_MCP_COLLABORATION_ENABLED"); err != nil {
		t.Fatal(err)
	}
	config, err := ParseConfig(nil)
	if err != nil || config.MCPCollaborationEnabled || config.MCPWorkflowEnabled {
		t.Fatalf("default collaboration/guidance should remain off: %v", err)
	}
	for _, tc := range []struct {
		name, env, guide         string
		args                     []string
		enabled, guided, invalid bool
	}{
		{name: "environment on", env: "true", guide: "false", enabled: true},
		{name: "guide alone", env: "false", guide: "true", guided: true},
		{name: "flag overrides environment", env: "true", guide: "true", args: []string{"--mcp-collaboration-enabled=false"}, guided: true},
		{name: "flag on with guide off", env: "false", guide: "false", args: []string{"--mcp-collaboration-enabled"}, enabled: true},
		{name: "invalid bool", env: "sometimes", guide: "false", invalid: true},
		{name: "explicit empty", env: "", guide: "false", invalid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("LINGSHU_MCP_COLLABORATION_ENABLED", tc.env)
			t.Setenv("LINGSHU_MCP_WORKFLOW_ENABLED", tc.guide)
			config, err := ParseConfig(tc.args)
			if tc.invalid {
				if err == nil || !strings.Contains(err.Error(), "LINGSHU_MCP_COLLABORATION_ENABLED") {
					t.Fatal("invalid collaboration switch was accepted")
				}
				return
			}
			if err != nil || config.MCPCollaborationEnabled != tc.enabled || config.MCPWorkflowEnabled != tc.guided {
				t.Fatalf("independent switches mismatch: collaboration=%v workflow=%v error=%v", config.MCPCollaborationEnabled, config.MCPWorkflowEnabled, err)
			}
		})
	}
}

// Exercise the same JSON-only response a gateway can preserve without forwarding
// initialize instructions, resources or prompts. Errors must retain recovery data.
func collaborationMCPCall(t *testing.T, agent *integrationTestBrowser, token, name string, args map[string]any, wantError bool) map[string]any {
	t.Helper()
	wire, _ := agent.mcp(token, "tools/call", map[string]any{"name": name, "arguments": args}, http.StatusOK)
	if wire["error"] != nil {
		t.Fatalf("%s unexpectedly returned a protocol error", name)
	}
	result := integrationObject(t, wire["result"])
	data := integrationObject(t, result["structuredContent"])
	var text map[string]any
	blocks, ok := result["content"].([]any)
	if !ok || len(blocks) == 0 {
		t.Fatalf("%s omitted JSON text for gateway passthrough", name)
	}
	body, _ := integrationObject(t, blocks[0])["text"].(string)
	if err := json.Unmarshal([]byte(body), &text); err != nil || !reflect.DeepEqual(text, data) {
		t.Fatalf("%s JSON text and structuredContent differ: %v", name, err)
	}
	if wantError {
		status, _ := data["httpStatus"].(float64)
		if result["isError"] != true || data["code"] == nil || status < 400 || status >= 500 {
			t.Fatalf("%s expected a structured client error, got %v", name, data)
		}
	} else if result["isError"] == true {
		t.Fatalf("%s failed: %v", name, data)
	}
	return data
}

func TestMCPCollaborationDiscoveryAndCapabilities(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			owner := &integrationTestBrowser{t: t, base: f.owner.base, client: f.owner.client, csrf: f.owner.csrf}
			agent := integrationBrowser(t, f.owner.base)
			full, _ := owner.token(f.space, "", "work:read", "work:write")
			data := collaborationMCPCall(t, agent, full, "space_current", map[string]any{}, false)
			collaboration := integrationObject(t, data["collaboration"])
			if data["contextVersion"] != float64(2) || collaboration["version"] != "1" || collaboration["enabled"] != false || collaboration["effectiveEnabled"] != false || collaboration["reason"] != "disabled" || collaboration["existingClaimsEnforced"] != true {
				t.Fatalf("default collaboration context differs: %v", collaboration)
			}
			if integrationObject(t, collaboration["entrypoints"])["openSession"] != nil || integrationObject(t, collaboration["entrypoints"])["releaseClaim"] != "work_claims_release" {
				t.Fatal("disabled collaboration advertised new sessions or hid cleanup")
			}
			legacy := agent.tool(full, "work_items_create", map[string]any{"input": map[string]any{"id": newID(), "title": "Legacy default-off task"}}, "")
			agent.tool(full, "work_items_update", map[string]any{"id": legacy["id"], "input": map[string]any{"expectedRevision": legacy["revision"], "nextStep": "Legacy updates remain available"}}, "")
			collaborationMCPCall(t, agent, full, "work_sessions_open", map[string]any{"input": map[string]any{"registrationId": newID(), "agentName": "Disabled"}}, true)
			// Startup flags are fixed in production; fixture mutations isolate the
			// independent combinations without adding any runtime configuration API.
			f.app.config.MCPCollaborationEnabled = true
			context := agent.tool(full, "space_current", map[string]any{}, "")
			if integrationObject(t, context["workflow"])["enabled"] != false || integrationObject(t, context["collaboration"])["effectiveEnabled"] != true {
				t.Fatal("workflow guidance incorrectly gates collaboration")
			}
			capabilities := agent.tool(full, "work_collaboration_get", map[string]any{}, "")
			if capabilities["enabled"] != true || capabilities["effectiveEnabled"] != true || capabilities["version"] != "1" || capabilities["serverTime"] == nil {
				t.Fatalf("recovery context differs: %v", capabilities)
			}
			for _, tc := range []struct {
				name, reason string
				actions      []string
				read, write  bool
			}{
				{"navigation only", "work_access_denied", []string{"navigation:read"}, false, false},
				{"read only", "work_write_required", []string{"work:read"}, true, false},
				{"write only", "work_read_required", []string{"work:write"}, false, true},
				{"read and write", "enabled", []string{"work:read", "work:write"}, true, true},
			} {
				t.Run(tc.name, func(t *testing.T) {
					token, _ := owner.token(f.space, "", tc.actions...)
					current := agent.tool(token, "space_current", map[string]any{}, "")
					collaboration := integrationObject(t, current["collaboration"])
					entries := integrationObject(t, collaboration["entrypoints"])
					if collaboration["enabled"] != true || collaboration["effectiveEnabled"] != (tc.read && tc.write) || collaboration["reason"] != tc.reason {
						t.Fatalf("collaboration overstated effective capability: %v", collaboration)
					}
					if !tc.read && len(entries) != 0 || !tc.write && entries["openSession"] != nil {
						t.Fatalf("unauthorized collaboration entrypoints: %v", entries)
					}
					if !tc.read && integrationObject(t, current["entrypoints"])["createWork"] != nil {
						t.Fatal("enabled collaboration advertised item creation without read capability")
					}
					if !tc.read || !tc.write {
						collaborationMCPCall(t, agent, token, "work_sessions_open", map[string]any{"input": map[string]any{"registrationId": newID(), "agentName": "Scope check"}}, true)
					}
				})
			}
			moduleTestUpdate(t, f.owner, map[string]any{"work": false})
			context = agent.tool(full, "space_current", map[string]any{}, "")
			if c := integrationObject(t, context["collaboration"]); c["enabled"] != true || c["effectiveEnabled"] != false || c["reason"] != "work_module_disabled" || len(integrationObject(t, c["entrypoints"])) != 0 {
				t.Fatalf("disabled module still advertises collaboration: %v", c)
			}
			collaborationMCPCall(t, agent, full, "work_sessions_open", map[string]any{"input": map[string]any{"registrationId": newID(), "agentName": "Module check"}}, true)
			moduleTestUpdate(t, f.owner, map[string]any{"work": true})
			source := owner.source(f.space, "Collaboration source boundary")
			scoped, _ := owner.token(f.space, source["id"].(string), "sources:read")
			context = agent.tool(scoped, "space_current", map[string]any{}, "")
			if c := integrationObject(t, context["collaboration"]); c["effectiveEnabled"] != false || c["reason"] != "work_access_denied" {
				t.Fatal("source-bound token gained collaboration access")
			}
			collaborationMCPCall(t, agent, scoped, "work_sessions_open", map[string]any{"input": map[string]any{"registrationId": newID(), "agentName": "Source check"}}, true)
			tools, _ := agent.mcp(full, "tools/list", map[string]any{}, http.StatusOK)
			catalog := map[string]map[string]any{}
			for _, raw := range integrationObject(t, tools["result"])["tools"].([]any) {
				tool := integrationObject(t, raw)
				name := tool["name"].(string)
				catalog[name] = tool
				if !strings.HasPrefix(name, "work_") {
					continue
				}
				prefix := []rune(tool["description"].(string))
				if len(prefix) > 300 {
					prefix = prefix[:300]
				}
				if !strings.Contains(string(prefix), "space_current") || !strings.Contains(string(prefix), "work_sessions_open") {
					t.Fatalf("gateway search prefix lost collaboration discovery: %s", name)
				}
			}
			if len(catalog) != 55 || catalog["work_claims_resolve"] != nil {
				t.Fatal("MCP exposed a human-only override or unexpected tool catalog")
			}
			for _, name := range []string{"work_items_create", "work_items_update", "work_items_move"} {
				schema := integrationObject(t, catalog[name]["inputSchema"])
				props := integrationObject(t, schema["properties"])
				context := integrationObject(t, integrationObject(t, integrationObject(t, props["input"])["properties"])["context"])
				contextProps := integrationObject(t, context["properties"])
				if props["session_id"] != nil || props["sessionId"] != nil || contextProps["sessionId"] == nil || contextProps["operationId"] == nil || context["additionalProperties"] != false {
					t.Fatalf("%s confused application context with transport session", name)
				}
				if name != "work_items_create" && (contextProps["claimId"] == nil || contextProps["claimGeneration"] == nil) {
					t.Fatalf("%s omitted fencing context", name)
				}
			}
			for _, name := range []string{"work_sessions_open", "work_sessions_close", "work_claims_acquire", "work_claims_renew", "work_claims_release", "work_events_append"} {
				if integrationObject(t, catalog[name]["annotations"])["idempotentHint"] != true {
					t.Fatalf("stable-operation tool %s lost replay annotation", name)
				}
			}
			// A gateway may add its own session_id to its envelope, but it cannot
			// forward that key as an application argument to Home.
			invalid, _ := agent.mcp(full, "tools/call", map[string]any{"name": "work_collaboration_get", "arguments": map[string]any{"session_id": newID()}}, http.StatusOK)
			if invalid["error"] == nil && integrationObject(t, invalid["result"])["isError"] != true {
				t.Fatal("gateway transport session_id was accepted as a Home argument")
			}
		})
	}
}

func TestMCPCollaborationSameTokenWorkflow(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			f.app.config.MCPCollaborationEnabled = true
			owner := &integrationTestBrowser{t: t, base: f.owner.base, client: f.owner.client, csrf: f.owner.csrf}
			agent := integrationBrowser(t, f.owner.base)
			token, tokenID := owner.token(f.space, "", "work:read", "work:write")
			call := func(name string, args map[string]any) map[string]any {
				return collaborationMCPCall(t, agent, token, name, args, false)
			}
			reject := func(name string, args map[string]any) map[string]any {
				return collaborationMCPCall(t, agent, token, name, args, true)
			}
			openA := map[string]any{"input": map[string]any{"registrationId": newID(), "agentName": "Builder", "clientName": "Gateway fixture", "role": "implementation"}}
			a := call("work_sessions_open", openA)
			if replay := call("work_sessions_open", openA); replay["id"] != a["id"] {
				t.Fatal("registration replay created another session")
			}
			b := call("work_sessions_open", map[string]any{"input": map[string]any{"registrationId": newID(), "agentName": "Reviewer", "clientName": "Gateway fixture", "role": "review", "parentSessionId": a["id"]}})
			if a["id"] == b["id"] || integrationObject(t, a["actor"])["id"] != integrationObject(t, b["actor"])["id"] {
				t.Fatal("same-token sessions did not preserve distinct labels and trusted principal")
			}
			call("work_sessions_get", map[string]any{"id": a["id"]})
			create := map[string]any{"input": map[string]any{"id": newID(), "title": "Independent sessions coordinate one fixture", "context": map[string]any{"sessionId": a["id"], "operationId": newID()}}}
			item := call("work_items_create", create)
			if replay := call("work_items_create", create); replay["id"] != item["id"] || replay["revision"] != item["revision"] {
				t.Fatal("nested create context was not replay-safe")
			}
			reject("work_items_create", map[string]any{"input": map[string]any{"id": newID(), "title": "Missing collaboration context"}})
			id := item["id"]
			get := func() map[string]any { return call("work_items_get", map[string]any{"id": id}) }
			item = get()
			initial := integrationClone(item)
			claimA := call("work_claims_acquire", map[string]any{"id": id, "input": map[string]any{"sessionId": a["id"], "operationId": newID(), "expectedRevision": item["revision"], "expectedGeneration": integrationObject(t, item["collaboration"])["generation"], "leaseSeconds": 900}})
			if claimA["state"] != "active" || integrationObject(t, claimA["session"])["id"] != a["id"] {
				t.Fatalf("claim did not identify its owning session: %v", claimA)
			}
			item = get()
			if item["revision"] != initial["revision"] || item["updatedAt"] != initial["updatedAt"] || item["boardRevision"] != initial["boardRevision"] {
				t.Fatal("claim acquisition changed business revisions or update time")
			}
			reject("work_claims_acquire", map[string]any{"id": id, "input": map[string]any{"sessionId": b["id"], "operationId": newID(), "expectedRevision": item["revision"], "expectedGeneration": claimA["generation"]}})
			contextFor := func(session, claim map[string]any) map[string]any {
				return map[string]any{"sessionId": session["id"], "claimId": claim["claimId"], "claimGeneration": claim["generation"], "operationId": newID()}
			}
			reject("work_items_update", map[string]any{"id": id, "input": map[string]any{"expectedRevision": item["revision"], "nextStep": "Unowned overwrite", "context": contextFor(b, claimA)}})
			reject("work_items_update", map[string]any{"id": id, "input": map[string]any{"expectedRevision": item["revision"], "nextStep": "Missing claim"}})
			// No token, including the token already authorized to own this item,
			// can invoke the human-only force-resolution endpoint.
			agent.object("POST", "/api/v1/spaces/"+f.space+"/work/items/"+id.(string)+"/claim/resolve", map[string]any{"operationId": newID(), "expectedGeneration": claimA["generation"], "reason": "Bearer must not bypass current owner", "externalOperationsStopped": true}, http.StatusForbidden, token)
			// Existing sessions never cache token permissions. Narrowing this same
			// credential must immediately deny writes and heartbeats using old IDs.
			credential := integrationTokenTestCredential(t, owner, tokenID)
			credential = owner.object("PATCH", "/api/v1/integrations/tokens/"+tokenID, map[string]any{"expectedRevision": credential["revision"], "actions": []string{"work:write"}}, http.StatusOK, "")
			reject("work_items_update", map[string]any{"id": id, "input": map[string]any{"expectedRevision": item["revision"], "nextStep": "Stale permission overwrite", "context": contextFor(a, claimA)}})
			reject("work_claims_renew", map[string]any{"id": id, "input": contextFor(a, claimA)})
			owner.object("PATCH", "/api/v1/integrations/tokens/"+tokenID, map[string]any{"expectedRevision": credential["revision"], "actions": []string{"work:read", "work:write"}}, http.StatusOK, "")
			if current := get(); current["revision"] != item["revision"] {
				t.Fatal("narrowed token changed the item through a saved session")
			}
			reviewArgs := map[string]any{"id": id, "input": map[string]any{"sessionId": b["id"], "operationId": newID(), "kind": "review", "body": "Review evidence, without changing the builder's fields."}}
			review := call("work_events_append", reviewArgs)
			if replay := call("work_events_append", reviewArgs); replay["id"] != review["id"] {
				t.Fatal("event retry appended a duplicate")
			}
			if current := get(); current["revision"] != item["revision"] || current["updatedAt"] != item["updatedAt"] {
				t.Fatal("participant event changed business revision or update time")
			}
			progress := call("work_events_append", map[string]any{"id": id, "input": map[string]any{"sessionId": a["id"], "operationId": newID(), "kind": "progress", "body": "Targeted fixture verification completed."}})
			if integrationObject(t, progress["session"])["agentName"] != "Builder" || integrationObject(t, review["session"])["agentName"] != "Reviewer" {
				t.Fatal("event attribution collapsed same-token sessions")
			}
			update := map[string]any{"id": id, "input": map[string]any{"expectedRevision": item["revision"], "nextStep": "Hand over verified work", "context": contextFor(a, claimA)}}
			item = call("work_items_update", update)
			if replay := call("work_items_update", update); replay["revision"] != item["revision"] {
				t.Fatal("item mutation replay advanced revision twice")
			}
			beforeRenew := get()
			call("work_claims_renew", map[string]any{"id": id, "input": contextFor(a, claimA)})
			if current := get(); current["revision"] != beforeRenew["revision"] || current["updatedAt"] != beforeRenew["updatedAt"] || current["boardRevision"] != beforeRenew["boardRevision"] {
				t.Fatal("heartbeat changed business data")
			}
			page := call("work_events_list", map[string]any{"id": id, "input": map[string]any{"limit": 1}})
			high, nextAfter := page["highWatermark"], page["nextAfter"]
			seen := map[string]bool{}
			var sequence int64
			for pages := 0; ; pages++ {
				if pages > 30 {
					t.Fatal("event pagination did not terminate")
				}
				if page["highWatermark"] != high {
					t.Fatal("event snapshot watermark changed across cursor pages")
				}
				for _, raw := range page["items"].([]any) {
					event := integrationObject(t, raw)
					n, err := strconv.ParseInt(event["sequence"].(string), 10, 64)
					if err != nil || n <= sequence || seen[event["id"].(string)] {
						t.Fatal("events were duplicated or not ascending")
					}
					sequence = n
					seen[event["id"].(string)] = true
				}
				nextAfter = page["nextAfter"]
				if page["nextCursor"] == nil || page["nextCursor"] == "" {
					break
				}
				page = call("work_events_list", map[string]any{"id": id, "input": map[string]any{"limit": 1, "cursor": page["nextCursor"]}})
			}
			if !seen[review["id"].(string)] || !seen[progress["id"].(string)] {
				t.Fatal("paged collaboration history omitted participants")
			}
			note := call("work_events_append", map[string]any{"id": id, "input": map[string]any{"sessionId": b["id"], "operationId": newID(), "kind": "note", "body": "New event after snapshot."}})
			incremental := call("work_events_list", map[string]any{"id": id, "input": map[string]any{"after": nextAfter}})
			found := false
			for _, raw := range incremental["items"].([]any) {
				if integrationObject(t, raw)["id"] == note["id"] {
					found = true
				}
			}
			if !found {
				t.Fatal("after cursor did not expose new collaboration evidence")
			}
			reject("work_sessions_close", map[string]any{"id": a["id"], "input": map[string]any{"operationId": newID()}})
			releaseInput := contextFor(a, claimA)
			releaseInput["reason"] = "handoff"
			releaseInput["handoff"] = map[string]any{"completed": "Fixture implementation verified", "workspace": "Isolated test database", "nextStep": "Reviewer completes acceptance", "unknowns": ""}
			released := call("work_claims_release", map[string]any{"id": id, "input": releaseInput})
			item = get()
			claimB := call("work_claims_acquire", map[string]any{"id": id, "input": map[string]any{"sessionId": b["id"], "operationId": newID(), "expectedRevision": item["revision"], "expectedGeneration": released["generation"]}})
			if claimB["generation"] == claimA["generation"] {
				t.Fatal("new owner reused the previous fencing generation")
			}
			reject("work_items_update", map[string]any{"id": id, "input": map[string]any{"expectedRevision": item["revision"], "nextStep": "Stale builder overwrite", "context": contextFor(a, claimA)}})
			// Turning off either guide or new-session admission cannot remove a
			// persisted claim or permit a token to overwrite its current owner.
			f.app.config.MCPCollaborationEnabled = false
			currentContext := call("space_current", map[string]any{})
			if c := integrationObject(t, currentContext["collaboration"]); c["enabled"] != false || c["effectiveEnabled"] != false || c["existingClaimsEnforced"] != true || integrationObject(t, c["entrypoints"])["renewClaim"] != "work_claims_renew" {
				t.Fatal("disabled switch lost persisted-claim protection or cleanup")
			}
			reject("work_sessions_open", map[string]any{"input": map[string]any{"registrationId": newID(), "agentName": "No new admission"}})
			reject("work_items_update", map[string]any{"id": id, "input": map[string]any{"expectedRevision": item["revision"], "nextStep": "Flag-off overwrite"}})
			call("work_claims_renew", map[string]any{"id": id, "input": contextFor(b, claimB)})
			catalog := call("work_statuses_get", map[string]any{})
			done := ""
			for _, raw := range catalog["items"].([]any) {
				s := integrationObject(t, raw)
				if s["type"] == "done" {
					done = s["id"].(string)
				}
			}
			if done == "" {
				t.Fatal("fixture has no semantic completion status")
			}
			completed := call("work_items_update", map[string]any{"id": id, "input": map[string]any{"expectedRevision": item["revision"], "status": done, "result": "Synthetic acceptance complete", "context": contextFor(b, claimB)}})
			if completed["status"] != done || integrationObject(t, completed["collaboration"])["state"] == "active" {
				t.Fatal("completion did not atomically release its owner")
			}
			f.app.config.MCPCollaborationEnabled = true
			reject("work_claims_acquire", map[string]any{"id": id, "input": map[string]any{"sessionId": a["id"], "operationId": newID(), "expectedRevision": completed["revision"], "expectedGeneration": integrationObject(t, completed["collaboration"])["generation"]}})
			for _, session := range []map[string]any{a, b} {
				call("work_sessions_close", map[string]any{"id": session["id"], "input": map[string]any{"operationId": newID()}})
			}
			owner.object("DELETE", "/api/v1/integrations/tokens/"+tokenID, nil, http.StatusOK, "")
			agent.mcp(token, "tools/call", map[string]any{"name": "work_sessions_get", "arguments": map[string]any{"id": a["id"]}}, http.StatusUnauthorized)
		})
	}
}
