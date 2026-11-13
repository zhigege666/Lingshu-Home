package home

import (
	"net/http"
	"reflect"
	"testing"
)

// Each call is a fresh stateless MCP request. The token, not the owner's
// browser default or the previous caller, determines the space.
func TestMCPBoundSpace(t *testing.T) {
	f := newDocumentFixture(t, false)
	f.source(t, f.shared, "shared", true, map[string]string{"team.md": "shared"})
	f.source(t, f.personal, "personal", true, map[string]string{"mine.md": "private"})
	owner := &integrationTestBrowser{t: t, base: f.server.URL, client: f.owner.client, csrf: f.owner.csrf}
	agent := integrationBrowser(t, f.server.URL)
	boot := owner.boot()
	for _, entry := range boot["spaces"].([]any) {
		space := integrationObject(t, entry)
		id := space["id"].(string)
		token, tokenID := owner.token(id, "", "documents:read", "pages:read", "navigation:read")
		wire, _ := agent.mcp(token, "tools/call", map[string]any{"name": "space_current"}, http.StatusOK)
		got := integrationObject(t, integrationObject(t, wire["result"])["structuredContent"])
		want := map[string]any{"spaceId": id, "name": space["name"], "kind": space["kind"]}
		for field, value := range want {
			if !reflect.DeepEqual(got[field], value) {
				t.Fatalf("space_current.%s = %v, want %v", field, got[field], value)
			}
		}
		if got["contextVersion"] != float64(1) || got["capabilities"] == nil || got["workflow"] == nil || got["modules"] == nil {
			t.Fatalf("space_current did not return its additive context: %v", got)
		}
		dashboard := agent.tool(token, "dashboard_get", map[string]any{}, "")
		if integrationObject(t, dashboard["space"])["id"] != id {
			t.Fatal("dashboard did not use the token-bound space")
		}
		list := agent.tool(token, "documents_list", map[string]any{}, "")
		items := list["items"].([]any)
		filename := map[string]string{f.shared: "team.md", f.personal: "mine.md"}[id]
		if len(items) != 1 || integrationObject(t, items[0])["relativePath"] != filename {
			t.Fatalf("document list for %s did not contain only %q", space["kind"], filename)
		}
		explicit := agent.tool(token, "documents_list", map[string]any{"spaceId": id, "input": map[string]any{}}, "")
		if !reflect.DeepEqual(explicit, list) {
			t.Fatal("implicit and explicit space returned different documents")
		}
		owner.call("DELETE", "/api/v1/integrations/tokens/"+tokenID, nil, http.StatusOK, "")
		agent.mcp(token, "tools/call", map[string]any{"name": "space_current"}, http.StatusUnauthorized)
	}

	token, _ := owner.token(f.shared, "", "navigation:write", "navigation:read")
	args := map[string]any{"input": map[string]any{"name": "Scoped category"}}
	created := agent.tool(token, "categories_create", args, "")
	agent.tool(token, "categories_get", map[string]any{"id": created["id"]}, "")
	args["spaceId"] = f.personal
	agent.tool(token, "categories_create", args, "not_found")
	agent.tool(token, "documents_list", map[string]any{"input": map[string]any{}}, "forbidden")
	agent.tool(token, "dashboard_get", map[string]any{}, "forbidden")
	for _, tc := range []struct {
		name string
		args map[string]any
	}{
		{"categories_list", map[string]any{"spaceId": ""}},
		{"categories_list", map[string]any{"spaceId": nil}},
		{"categories_list", map[string]any{"spaceId": 42}},
		{"categories_get", map[string]any{}},
		{"documents_list", map[string]any{"input": nil}},
		{"categories_create", map[string]any{}},
	} {
		wire, _ := agent.mcp(token, "tools/call", map[string]any{"name": tc.name, "arguments": tc.args}, http.StatusOK)
		// The SDK can reject the arguments before the application handler.
		if wire["error"] == nil && integrationObject(t, wire["result"])["isError"] != true {
			t.Fatalf("%s accepted invalid arguments %v", tc.name, tc.args)
		}
	}

	tools, _ := agent.mcp(token, "tools/list", map[string]any{}, http.StatusOK)
	for _, item := range integrationObject(t, tools["result"])["tools"].([]any) {
		tool := integrationObject(t, item)
		schema := integrationObject(t, tool["inputSchema"])
		switch tool["name"] {
		case "documents_get":
			if !reflect.DeepEqual(schema["required"], []any{"id"}) {
				t.Fatalf("documents_get requires %v, want only id", schema["required"])
			}
		case "documents_list":
			input := integrationObject(t, integrationObject(t, schema["properties"])["input"])
			if v, exists := input["required"]; exists && !reflect.DeepEqual(v, []any{}) {
				t.Fatalf("optional document filters published invalid required member: %#v", v)
			}
		}
	}
}

func TestMCPDefaultFiltersAndBatchErrorDetails(t *testing.T) {
	f := newDocumentFixture(t, false)
	owner := &integrationTestBrowser{t: t, base: f.server.URL, client: f.owner.client, csrf: f.owner.csrf}
	agent := integrationBrowser(t, f.server.URL)
	token, _ := owner.token(f.shared, "", "documents:read", "navigation:read", "navigation:write")
	for _, name := range []string{"documents_activity_list", "navigation_click_stats"} {
		implicit := agent.tool(token, name, map[string]any{}, "")
		explicit := agent.tool(token, name, map[string]any{"input": map[string]any{}}, "")
		if !reflect.DeepEqual(implicit, explicit) {
			t.Errorf("%s returned different results for omitted and empty filters", name)
		}
	}

	nav := agent.tool(token, "navigation_get", map[string]any{}, "")
	input := map[string]any{
		"expectedRevision": nav["revision"],
		"categories":       []map[string]any{{"id": "absent-category", "patch": map[string]any{"name": "A"}}},
	}
	httpErr := integrationObject(t, owner.call("POST", "/api/v1/spaces/"+f.shared+"/navigation/batch-edit", input, http.StatusNotFound, token))
	mcpErr := agent.tool(token, "navigation_batch_edit", map[string]any{"input": input}, "not_found")
	if mcpErr["httpStatus"] != float64(http.StatusNotFound) || mcpErr["entity"] != "category" || mcpErr["id"] != "absent-category" || mcpErr["field"] != "id" {
		t.Fatalf("missing MCP batch error details: %v", mcpErr)
	}
	delete(mcpErr, "httpStatus")
	if !reflect.DeepEqual(httpErr, mcpErr) {
		t.Fatalf("REST and MCP error details differ: %v / %v", httpErr, mcpErr)
	}
}

func TestMCPWorkStatusDiscoveryAndMutation(t *testing.T) {
	f := newDocumentFixture(t, false)
	owner := &integrationTestBrowser{t: t, base: f.server.URL, client: f.owner.client, csrf: f.owner.csrf}
	agent := integrationBrowser(t, f.server.URL)
	old, _ := owner.token(f.shared, "", "navigation:read")
	read, _ := owner.token(f.shared, "", "work:read")
	write, _ := owner.token(f.shared, "", "work:write")
	both, _ := owner.token(f.shared, "", "work:read", "work:write")
	listTools := func(token string) map[string]map[string]any {
		wire, _ := agent.mcp(token, "tools/list", map[string]any{}, http.StatusOK)
		result := map[string]map[string]any{}
		for _, raw := range integrationObject(t, wire["result"])["tools"].([]any) {
			tool := integrationObject(t, raw)
			result[tool["name"].(string)] = tool
		}
		return result
	}
	// Catalog discovery is independent of action grants. Old tokens can see
	// newly registered tools, while the calls still enforce their own scopes.
	toolsBefore := listTools(old)
	for _, name := range []string{
		"work_board_get", "work_items_list", "work_items_get", "work_items_create", "work_items_update", "work_items_move",
		"work_projects_list", "work_projects_create", "work_projects_update", "work_resources_search", "work_statuses_get", "work_statuses_batch_edit",
	} {
		if toolsBefore[name] == nil {
			t.Fatalf("old token did not discover registered tool %s", name)
		}
	}
	for _, name := range []string{"work_items_list", "work_items_create", "work_items_update", "work_items_move"} {
		schema := integrationObject(t, toolsBefore[name]["inputSchema"])
		input := integrationObject(t, integrationObject(t, schema["properties"])["input"])
		status := integrationObject(t, integrationObject(t, input["properties"])["status"])
		if status["type"] != "string" || status["enum"] != nil {
			t.Fatalf("%s still restricts dynamic statuses with its schema: %v", name, status)
		}
	}
	batchSchema := integrationObject(t, toolsBefore["work_statuses_batch_edit"]["inputSchema"])
	batchInput := integrationObject(t, integrationObject(t, batchSchema["properties"])["input"])
	batchFields := integrationObject(t, batchInput["properties"])
	for _, field := range []string{"create", "patches", "deletions"} {
		array := integrationObject(t, batchFields[field])
		if array["type"] != "array" || integrationObject(t, array["items"])["type"] != "object" {
			t.Fatalf("%s must be an array of typed objects: %v", field, array)
		}
	}

	agent.tool(old, "work_statuses_get", map[string]any{}, "forbidden")
	agent.tool(write, "work_statuses_get", map[string]any{}, "forbidden")
	catalog := agent.tool(both, "work_statuses_get", map[string]any{}, "")
	readCatalog := agent.tool(read, "work_statuses_get", map[string]any{}, "")
	if catalog["canEdit"] != true || readCatalog["canEdit"] != false || catalog["defaultStatus"] != "todo" {
		t.Fatalf("status catalog did not preserve token permissions or initial default: %v / %v", catalog, readCatalog)
	}
	agent.tool(both, "work_statuses_get", map[string]any{"spaceId": f.personal}, "not_found")
	customID := newID()
	order := []string{}
	for _, raw := range catalog["items"].([]any) {
		order = append(order, integrationObject(t, raw)["id"].(string))
	}
	order = append(order, customID)
	batch := map[string]any{
		"expectedRevision": catalog["revision"],
		"create": []map[string]any{{
			"id": customID, "name": "待分派", "type": "todo", "color": "#22795E", "description": "尚未安排具体执行者的事项。",
		}},
		"order": order, "defaultStatus": customID,
	}
	agent.tool(read, "work_statuses_batch_edit", map[string]any{"input": batch}, "forbidden")
	catalog = agent.tool(both, "work_statuses_batch_edit", map[string]any{"input": batch}, "")
	if catalog["defaultStatus"] != customID || len(catalog["items"].([]any)) != 5 {
		t.Fatalf("status batch did not return the updated catalog: %v", catalog)
	}
	item := agent.tool(both, "work_items_create", map[string]any{"input": map[string]any{"id": newID(), "title": "Dynamic default through MCP"}}, "")
	if item["status"] != customID {
		t.Fatalf("MCP item did not use the configured default status: %v", item)
	}
	detail := agent.tool(both, "work_items_get", map[string]any{"id": item["id"]}, "")
	if integrationObject(t, detail["statusDefinition"])["id"] != customID {
		t.Fatalf("MCP item detail did not explain its current status: %v", detail)
	}
	page := agent.tool(both, "work_items_list", map[string]any{"input": map[string]any{"status": customID}}, "")
	if page["total"] != float64(1) || page["defaultStatus"] != customID || page["statusRevision"] != catalog["revision"] {
		t.Fatalf("MCP list lost custom status filtering or metadata: %v", page)
	}
	board := agent.tool(both, "work_board_get", map[string]any{}, "")
	if len(board["columns"].([]any)) != 5 || len(board["statuses"].([]any)) != 5 || board["statusRevision"] != catalog["revision"] {
		t.Fatalf("MCP board did not reflect the dynamic catalog: %v", board)
	}
	for _, definition := range board["statuses"].([]any) {
		metadata := integrationObject(t, definition)
		if _, present := metadata["total"]; present {
			t.Fatal("board status metadata must not report unqueried space counts")
		}
	}
	counted := agent.tool(both, "work_statuses_get", map[string]any{}, "")
	for _, definition := range counted["items"].([]any) {
		metadata := integrationObject(t, definition)
		if metadata["total"] == nil || metadata["archivedTotal"] == nil {
			t.Fatal("status directory must explicitly return real active and archived counts")
		}
	}
	if !reflect.DeepEqual(toolsBefore, listTools(old)) {
		t.Fatal("changing status data changed MCP tool schemas and would require rediscovery")
	}

	// A write-only status edit keeps the same receipt boundary as item edits.
	receipt := agent.tool(write, "work_statuses_batch_edit", map[string]any{"input": map[string]any{
		"expectedRevision": catalog["revision"],
		"patches":          []map[string]any{{"id": customID, "name": "待领取"}},
	}}, "")
	if receipt["items"] != nil || receipt["statuses"] != nil || receipt["name"] != nil || receipt["description"] != nil {
		t.Fatalf("write-only status mutation returned readable catalog content: %v", receipt)
	}
	current := agent.tool(both, "work_statuses_get", map[string]any{}, "")
	found := false
	for _, raw := range current["items"].([]any) {
		status := integrationObject(t, raw)
		if status["id"] == customID {
			found = status["name"] == "待领取"
		}
	}
	if !found {
		t.Fatal("write-only catalog edit did not persist")
	}
	// MCP must preserve the handler's error context exactly, including details,
	// while a write-only token must not gain counts through an error response.
	occupiedDeletion := map[string]any{
		"expectedRevision": current["revision"],
		"deletions":        []map[string]any{{"id": customID}},
	}
	httpErr := integrationObject(t, owner.call("POST", "/api/v1/spaces/"+f.shared+"/work/statuses/batch-edit", occupiedDeletion, http.StatusConflict, both))
	mcpErr := agent.tool(both, "work_statuses_batch_edit", map[string]any{"input": occupiedDeletion}, "work_status_in_use")
	details := integrationObject(t, mcpErr["details"])
	if mcpErr["httpStatus"] != float64(http.StatusConflict) || mcpErr["entity"] != "work_status" || mcpErr["id"] != customID || mcpErr["field"] != "moveToStatus" || details["total"] != float64(1) || details["archivedTotal"] != float64(0) {
		t.Fatalf("MCP lost status conflict details: %v", mcpErr)
	}
	delete(mcpErr, "httpStatus")
	if !reflect.DeepEqual(httpErr, mcpErr) {
		t.Fatalf("status HTTP and MCP error details differ: %v / %v", httpErr, mcpErr)
	}
	writeErr := agent.tool(write, "work_statuses_batch_edit", map[string]any{"input": occupiedDeletion}, "work_status_in_use")
	if writeErr["details"] != nil {
		t.Fatalf("write-only status conflict exposed readable counts: %v", writeErr)
	}
	// The SDK must reject stringified JSON instead of accepting an opaque batch.
	wire, _ := agent.mcp(both, "tools/call", map[string]any{"name": "work_statuses_batch_edit", "arguments": map[string]any{"input": map[string]any{
		"expectedRevision": current["revision"], "create": `[{"id":"opaque"}]`,
	}}}, http.StatusOK)
	if wire["error"] == nil && integrationObject(t, wire["result"])["isError"] != true {
		t.Fatal("status batch accepted stringified JSON instead of typed array input")
	}
}
