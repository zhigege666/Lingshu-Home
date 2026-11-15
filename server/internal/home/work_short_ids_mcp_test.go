package home

import (
	"net/http"
	"regexp"
	"strings"
	"testing"
)

// Exercise the published MCP schemas and handlers together: compact item IDs
// must survive create/read/move/relations, while other resources keep their IDs.
func TestMCPWorkShortIDContract(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			owner := &integrationTestBrowser{t: t, base: f.owner.base, client: f.owner.client, csrf: f.owner.csrf}
			agent := integrationBrowser(t, f.owner.base)
			token, _ := owner.token(f.space, "", "work:read", "work:write")
			call := func(name string, args map[string]any) map[string]any {
				return collaborationMCPCall(t, agent, token, name, args, false)
			}
			reject := func(name string, args map[string]any) {
				t.Helper()
				wire, _ := agent.mcp(token, "tools/call", map[string]any{"name": name, "arguments": args}, http.StatusOK)
				if wire["error"] == nil && integrationObject(t, wire["result"])["isError"] != true {
					t.Fatalf("%s accepted invalid short-ID contract input", name)
				}
			}
			wire, _ := agent.mcp(token, "tools/list", map[string]any{}, http.StatusOK)
			catalog := map[string]map[string]any{}
			for _, raw := range integrationObject(t, wire["result"])["tools"].([]any) {
				entry := integrationObject(t, raw)
				catalog[entry["name"].(string)] = entry
			}
			propsFor := func(name string) map[string]any {
				t.Helper()
				return integrationObject(t, integrationObject(t, catalog[name]["inputSchema"])["properties"])
			}
			inputFor := func(name string) map[string]any {
				t.Helper()
				return integrationObject(t, propsFor(name)["input"])
			}
			createSchema := inputFor("work_items_create")
			createProps := integrationObject(t, createSchema["properties"])
			required := map[string]bool{}
			for _, value := range createSchema["required"].([]any) {
				required[value.(string)] = true
			}
			if createProps["id"] != nil || !required["requestId"] || !required["title"] || createSchema["additionalProperties"] != false {
				t.Fatal("item creation still exposes a caller-selected item ID or lacks the request key")
			}
			if integrationObject(t, inputFor("work_items_list")["properties"])["requestId"] == nil {
				t.Fatal("uncertain creation has no requestId lookup")
			}
			for _, name := range []string{"work_items_get", "work_items_update", "work_items_move", "work_claims_acquire", "work_claims_renew", "work_claims_release", "work_events_list", "work_events_append", "work_relations_get", "work_relations_update"} {
				ref := integrationObject(t, propsFor(name)["id"])
				pattern, ok := ref["pattern"].(string)
				if !ok {
					t.Fatalf("%s omitted the short item ID schema", name)
				}
				re, err := regexp.Compile(pattern)
				if err != nil || !re.MatchString("0000a") || re.MatchString(strings.Repeat("a", 32)) || re.MatchString("W-10") || ref["maxLength"] != float64(13) {
					t.Fatalf("%s did not distinguish short item references from retired IDs", name)
				}
				if integrationObject(t, ref["not"])["const"] != "00000" {
					t.Fatalf("%s advertises reserved item number 00000", name)
				}
			}
			if integrationObject(t, propsFor("work_sessions_get")["id"])["pattern"] != "^[0-9a-f]{32}$" {
				t.Fatal("item migration changed the separate session ID contract")
			}
			if integrationObject(t, integrationObject(t, inputFor("work_projects_create")["properties"])["id"])["pattern"] != "^[0-9a-f]{32}$" {
				t.Fatal("item migration changed project creation IDs")
			}
			request := map[string]any{"input": map[string]any{"requestId": "mcp-short-item:one", "title": "Compact task"}}
			item := call("work_items_create", request)
			id, _ := item["id"].(string)
			if !regexp.MustCompile("^[0-9a-z]{5,13}$").MatchString(id) || id == "00000" || item["number"] != nil || item["key"] != nil || item["requestId"] != nil {
				t.Fatalf("creation leaked a retired or secondary item identity: %v", item)
			}
			if replay := call("work_items_create", request); replay["id"] != id {
				t.Fatal("creation retry allocated another short item ID")
			}
			page := call("work_items_list", map[string]any{"input": map[string]any{"requestId": "mcp-short-item:one"}})
			items := page["items"].([]any)
			if len(items) != 1 || integrationObject(t, items[0])["id"] != id {
				t.Fatal("requestId lookup did not recover the created item")
			}
			reject("work_items_create", map[string]any{"input": map[string]any{"requestId": "mcp-short-item:one", "title": "Changed creation intent"}})
			reject("work_items_create", map[string]any{"input": map[string]any{"id": newID(), "requestId": "mcp-short-item:legacy", "title": "Retired caller ID"}})
			reject("work_items_create", map[string]any{"input": map[string]any{"requestId": "", "title": "Empty creation key"}})
			for _, bad := range []string{newID(), "W-1", "00000"} {
				reject("work_items_get", map[string]any{"id": bad})
				reject("work_events_list", map[string]any{"id": bad})
				reject("work_items_list", map[string]any{"input": map[string]any{"itemId": bad}})
			}
			parent := call("work_items_create", map[string]any{"input": map[string]any{"requestId": "mcp-short-item:parent", "title": "Parent task"}})
			item = call("work_items_get", map[string]any{"id": id})
			item = call("work_items_update", map[string]any{"id": id, "input": map[string]any{"expectedRevision": item["revision"], "nextStep": "Check the compact reference"}})
			item = call("work_items_move", map[string]any{"id": id, "input": map[string]any{"expectedRevision": item["revision"], "expectedBoardRevision": item["boardRevision"], "status": parent["status"], "beforeId": parent["id"]}})
			call("work_relations_update", map[string]any{"id": id, "input": map[string]any{"expectedRevision": item["revision"], "parentId": parent["id"]}})
			relations := call("work_relations_get", map[string]any{"id": id})
			if relation := integrationObject(t, relations["parent"]); relation["id"] != parent["id"] || relation["key"] != nil {
				t.Fatalf("relations did not preserve short item IDs: %v", relations)
			}
			item = call("work_items_get", map[string]any{"id": id})
			if item["id"] != id || item["nextStep"] != "Check the compact reference" || item["number"] != nil || item["key"] != nil {
				t.Fatalf("short item read/write chain changed identity: %v", item)
			}
		})
	}
}
