package home

import (
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestMCPWorkflowConfiguration(t *testing.T) {
	t.Setenv("LINGSHU_STORAGE_PROVIDER", "sqlite")
	t.Setenv("LINGSHU_SECURE_COOKIES", "false")
	t.Setenv("LINGSHU_LANGUAGE", "en")
	t.Setenv("LINGSHU_DATA_DIR", t.TempDir())
	t.Setenv("LINGSHU_TLS_CERT_FILE", "")
	t.Setenv("LINGSHU_TLS_KEY_FILE", "")
	t.Setenv("LINGSHU_DOCUMENT_ROOTS", "[]")
	t.Setenv("LINGSHU_MCP_WORKFLOW_ENABLED", "false")
	if err := os.Unsetenv("LINGSHU_MCP_WORKFLOW_ENABLED"); err != nil {
		t.Fatal(err)
	}
	config, err := ParseConfig(nil)
	if err != nil || config.MCPWorkflowEnabled {
		t.Fatalf("missing environment value must preserve disabled guidance: %v", err)
	}
	for _, tc := range []struct {
		env              string
		args             []string
		enabled, invalid bool
	}{
		{env: "false"}, {env: "true", enabled: true},
		{env: "true", args: []string{"--mcp-workflow-enabled=false"}},
		{env: "false", args: []string{"--mcp-workflow-enabled"}, enabled: true},
		{env: "sometimes", invalid: true}, {env: "", invalid: true},
	} {
		t.Setenv("LINGSHU_MCP_WORKFLOW_ENABLED", tc.env)
		config, err := ParseConfig(tc.args)
		if tc.invalid {
			if err == nil || !strings.Contains(err.Error(), "LINGSHU_MCP_WORKFLOW_ENABLED") {
				t.Fatal("invalid workflow switch was accepted")
			}
		} else if err != nil || config.MCPWorkflowEnabled != tc.enabled {
			t.Fatalf("workflow configuration=%v want=%v: %v", config.MCPWorkflowEnabled, tc.enabled, err)
		}
	}
}

func TestMCPWorkflowContextAndGatewayDiscovery(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			owner := &integrationTestBrowser{t: t, base: f.owner.base, client: f.owner.client, csrf: f.owner.csrf}
			agent := integrationBrowser(t, f.owner.base)
			full, _ := owner.token(f.space, "", "work:read", "work:write", "documents:read", "documents:write", "navigation:read", "navigation:write")
			context := agent.tool(full, "space_current", map[string]any{}, "")
			if integrationObject(t, context["workflow"])["enabled"] != false {
				t.Fatal("default workflow must be off")
			}
			// Set the fixture's effective startup configuration before the guided
			// requests; production does not expose runtime workflow mutation.
			f.app.config.MCPWorkflowEnabled = true
			for _, tc := range []struct {
				name                                     string
				actions                                  []string
				workRead, workWrite, docsRead, docsWrite bool
				guide                                    string
			}{
				{"navigation only", []string{"navigation:read"}, false, false, false, false, "当前没有可用的事项权限"},
				{"work read", []string{"work:read"}, true, false, false, false, "当前只能读取事项"},
				{"work write", []string{"work:write"}, false, true, false, false, "只写"},
				{"full work and document read", []string{"work:read", "work:write", "documents:read"}, true, true, true, false, "当前文档仅可读取"},
			} {
				t.Run(tc.name, func(t *testing.T) {
					token, _ := owner.token(f.space, "", tc.actions...)
					data := agent.tool(token, "space_current", map[string]any{}, "")
					caps := integrationObject(t, data["capabilities"])
					work, documents := integrationObject(t, caps["work"]), integrationObject(t, caps["documents"])
					if work["read"] != tc.workRead || work["write"] != tc.workWrite || documents["read"] != tc.docsRead || documents["write"] != tc.docsWrite {
						t.Fatalf("incorrect effective capabilities: %v", caps)
					}
					workflow := integrationObject(t, data["workflow"])
					if workflow["enabled"] != true || workflow["version"] != mcpWorkflowVersion || !strings.Contains(workflow["guide"].(string), tc.guide) {
						t.Fatalf("guide ignores effective permissions: %v", workflow)
					}
					entries := integrationObject(t, data["entrypoints"])
					if !tc.workRead && entries["work"] != nil || !tc.docsRead && entries["documents"] != nil || !tc.docsWrite && entries["createDocument"] != nil {
						t.Fatalf("unauthorized entrypoint: %v", entries)
					}
				})
			}
			// Gateway-only bootstrap needs no initialize/discover/resources call.
			wire, _ := agent.mcp(full, "tools/call", map[string]any{"name": "space_current"}, http.StatusOK)
			result := integrationObject(t, wire["result"])
			structured := integrationObject(t, result["structuredContent"])
			var textContent map[string]any
			textBlock := integrationObject(t, result["content"].([]any)[0])
			if err := json.Unmarshal([]byte(textBlock["text"].(string)), &textContent); err != nil || !reflect.DeepEqual(structured, textContent) {
				t.Fatalf("gateway JSON text differs from structured result: %v", err)
			}
			guide := integrationObject(t, structured["workflow"])["guide"].(string)
			for _, invariant := range []string{"语义去重", "没有仓库绑定", "不得只替换 revision", "不自动修改共享状态目录", "不擅自挂载目录或发布文档"} {
				if !strings.Contains(guide, invariant) {
					t.Fatalf("workflow omitted %s", invariant)
				}
			}
			tools, _ := agent.mcp(full, "tools/list", map[string]any{}, http.StatusOK)
			for _, raw := range integrationObject(t, tools["result"])["tools"].([]any) {
				tool := integrationObject(t, raw)
				if !strings.HasPrefix(tool["name"].(string), "work_") {
					continue
				}
				prefix := []rune(tool["description"].(string))
				if len(prefix) > 300 {
					prefix = prefix[:300]
				}
				if !strings.Contains(string(prefix), "space_current") {
					t.Fatalf("gateway summary cannot discover workflow from %s", tool["name"])
				}
			}
			discover, _ := agent.mcp(full, "server/discover", map[string]any{}, http.StatusOK)
			if !strings.Contains(integrationObject(t, discover["result"])["instructions"].(string), "space_current") {
				t.Fatal("2026 discovery omitted context entrypoint")
			}
			status, legacy, _ := agent.raw("POST", "/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-11-25", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "legacy-workflow-fixture", "version": "1"}}}, full, http.Header{"Accept": []string{"application/json, text/event-stream"}, "Mcp-Protocol-Version": []string{"2025-11-25"}})
			if status != http.StatusOK || !strings.Contains(integrationObject(t, integrationObject(t, legacy)["result"])["instructions"].(string), "space_current") {
				t.Fatal("2025 initialization omitted context entrypoint")
			}
			moduleTestUpdate(t, f.owner, map[string]any{"work": false, "documents": false})
			context = agent.tool(full, "space_current", map[string]any{}, "")
			caps := integrationObject(t, context["capabilities"])
			if integrationObject(t, caps["work"])["read"] != false || integrationObject(t, caps["documents"])["write"] != false || integrationObject(t, caps["navigation"])["read"] != true {
				t.Fatal("module switches did not reduce capabilities independently")
			}
			guide = integrationObject(t, context["workflow"])["guide"].(string)
			if !strings.Contains(guide, "事项模块已关闭") || !strings.Contains(guide, "资料库模块已关闭") {
				t.Fatal("guide did not explain disabled modules")
			}
			moduleTestUpdate(t, f.owner, map[string]any{"work": true, "documents": true})
			context = agent.tool(full, "space_current", map[string]any{}, "")
			if integrationObject(t, integrationObject(t, context["capabilities"])["work"])["write"] != true {
				t.Fatal("unchanged token failed after module re-enable")
			}
			// A token bound to an integration source never gains work access.
			source := owner.source(f.space, "Bound source")
			scoped, _ := owner.token(f.space, source["id"].(string), "sources:read")
			context = agent.tool(scoped, "space_current", map[string]any{}, "")
			if integrationObject(t, integrationObject(t, context["capabilities"])["work"])["read"] != false {
				t.Fatal("source-bound token gained work access")
			}
		})
	}
}
