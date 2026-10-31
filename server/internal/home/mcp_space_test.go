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
		got := integrationObject(t, wire["result"])["structuredContent"]
		want := map[string]any{"spaceId": id, "name": space["name"], "kind": space["kind"]}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("space_current = %v, want only %v", got, want)
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
