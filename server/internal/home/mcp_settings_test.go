package home

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func mcpSettingsTestBody(revision any, workflow, collaboration bool) map[string]any {
	return map[string]any{"expectedRevision": revision, "workflowEnabled": workflow, "collaborationEnabled": collaboration}
}

func mcpSettingsTestAssert(t *testing.T, value map[string]any, workflow, collaboration bool, source string) {
	t.Helper()
	if value["workflowEnabled"] != workflow || value["collaborationEnabled"] != collaboration ||
		value["workflowSource"] != source || value["collaborationSource"] != source {
		t.Fatalf("unexpected effective MCP settings: %v", value)
	}
	if revision, ok := value["revision"].(string); !ok || revision == "" {
		t.Fatal("MCP settings revision must remain a nonempty string")
	}
}

func mcpSettingsTestSave(t *testing.T, owner *coreBrowser, workflow, collaboration bool) map[string]any {
	t.Helper()
	current := owner.ok("GET", "/settings/mcp", nil)
	saved := owner.ok("PUT", "/settings/mcp", mcpSettingsTestBody(current["revision"], workflow, collaboration))
	mcpSettingsTestAssert(t, saved, workflow, collaboration, "saved")
	navigationEditTestRevision(t, current["revision"].(string), saved["revision"].(string), 1)
	return saved
}

func TestMCPSettingsAccessAndValidation(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			owner := f.owner
			initial := owner.ok("GET", "/settings/mcp", nil)
			mcpSettingsTestAssert(t, initial, false, false, "startup")
			if initial["canManage"] != true {
				t.Fatal("Owner cannot manage instance MCP settings")
			}
			valid := mcpSettingsTestBody(initial["revision"], true, false)
			visitor := newCoreBrowser(t, owner.base)
			visitor.bootstrap()
			statusWant(t, visitor, http.StatusUnauthorized, "GET", "/settings/mcp", nil)
			statusWant(t, visitor, http.StatusUnauthorized, "PUT", "/settings/mcp", valid)
			ownerAPI := &integrationTestBrowser{t: t, base: owner.base, client: owner.client, csrf: owner.csrf}
			token, _ := ownerAPI.token(f.space, "", "work:read", "work:write")
			agent := integrationBrowser(t, owner.base)
			for _, method := range []string{"GET", "PUT"} {
				var body any
				if method == "PUT" {
					body = valid
				}
				agent.call(method, "/api/v1/settings/mcp", body, http.StatusForbidden, token)
			}
			for _, csrf := range []string{"", "incorrect-csrf"} {
				got := accountProfileRawCall(t, owner.client, owner.base, "PUT", "/settings/mcp", valid, csrf, "")
				if got.status != http.StatusForbidden {
					t.Fatalf("invalid CSRF changed MCP settings: %d", got.status)
				}
			}
			for _, invalid := range []map[string]any{
				{},
				{"expectedRevision": initial["revision"], "workflowEnabled": true},
				{"expectedRevision": initial["revision"], "collaborationEnabled": true},
				{"expectedRevision": initial["revision"], "workflowEnabled": nil, "collaborationEnabled": false},
				{"expectedRevision": initial["revision"], "workflowEnabled": false, "collaborationEnabled": nil},
				{"expectedRevision": initial["revision"], "workflowEnabled": "false", "collaborationEnabled": false},
				{"expectedRevision": initial["revision"], "workflowEnabled": false, "collaborationEnabled": 0},
				{"workflowEnabled": false, "collaborationEnabled": false},
				{"expectedRevision": nil, "workflowEnabled": false, "collaborationEnabled": false},
				{"expectedRevision": 1, "workflowEnabled": false, "collaborationEnabled": false},
				{"expectedRevision": "0", "workflowEnabled": false, "collaborationEnabled": false},
				{"expectedRevision": initial["revision"], "workflowEnabled": false, "collaborationEnabled": false, "mode": ModeOpenEdit},
			} {
				statusWant(t, owner, http.StatusBadRequest, "PUT", "/settings/mcp", invalid)
			}
			if after := owner.ok("GET", "/settings/mcp", nil); !reflect.DeepEqual(after, initial) {
				t.Fatal("rejected access or malformed input mutated settings")
			}
			// These controls remain reachable even when the Work module is disabled.
			moduleTestUpdate(t, owner, map[string]any{"work": false})
			saved := mcpSettingsTestSave(t, owner, true, true)
			if !reflect.DeepEqual(saved, owner.ok("GET", "/settings/mcp", nil)) {
				t.Fatal("saved MCP configuration cannot be read while Work is off")
			}
			owner.ok("PUT", "/settings", map[string]any{"siteName": "MCP permissions", "mode": ModePrivateMulti, "registrationEnabled": false})
			owner.bootstrap()
			owner.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": "status fixture password"})
			owner.bootstrap()
			owner.ok("POST", "/admin/users", map[string]any{"username": "member", "password": "member MCP fixture password", "displayName": "Member"})
			member := newCoreBrowser(t, owner.base)
			member.bootstrap()
			member.ok("POST", "/auth/login", map[string]any{"username": "member", "password": "member MCP fixture password"})
			member.bootstrap()
			read := member.ok("GET", "/settings/mcp", nil)
			mcpSettingsTestAssert(t, read, true, true, "saved")
			if read["canManage"] != false {
				t.Fatal("Member received Owner capability")
			}
			statusWant(t, member, http.StatusForbidden, "PUT", "/settings/mcp", mcpSettingsTestBody(read["revision"], false, false))
			if after := owner.ok("GET", "/settings/mcp", nil); after["revision"] != saved["revision"] || after["workflowEnabled"] != true || after["collaborationEnabled"] != true {
				t.Fatal("Member or unrelated site settings changed instance MCP configuration")
			}
		})
	}
}

func TestMCPSettingsConcurrentAndIndependentWrites(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			before := f.owner.ok("GET", "/settings/mcp", nil)
			site := f.owner.ok("GET", "/settings", nil)
			policy := f.owner.ok("GET", "/settings/session-policy", nil)
			api := &integrationTestBrowser{t: t, base: f.owner.base, client: f.owner.client, csrf: f.owner.csrf}
			type result struct {
				status                  int
				body                    map[string]any
				workflow, collaboration bool
			}
			output := make(chan result, 2)
			start := make(chan struct{})
			var wg sync.WaitGroup
			for _, pair := range [][2]bool{{true, false}, {false, true}} {
				wg.Add(1)
				go func(pair [2]bool) {
					defer wg.Done()
					<-start
					status, value, _ := api.raw("PUT", "/api/v1/settings/mcp", mcpSettingsTestBody(before["revision"], pair[0], pair[1]), "", nil)
					output <- result{status, integrationObject(t, value), pair[0], pair[1]}
				}(pair)
			}
			close(start)
			wg.Wait()
			close(output)
			var winner, conflict result
			wins := 0
			for out := range output {
				if out.status == http.StatusOK {
					winner = out
					wins++
				} else if out.status == http.StatusConflict {
					conflict = out
				} else {
					t.Fatalf("unexpected concurrent save status: %d", out.status)
				}
			}
			if wins != 1 || conflict.body["code"] != "mcp_settings_conflict" || conflict.body["currentRevision"] != winner.body["revision"] {
				t.Fatalf("expected one atomic save and one revision conflict: successes=%d conflict=%v", wins, conflict.body)
			}
			current := f.owner.ok("GET", "/settings/mcp", nil)
			mcpSettingsTestAssert(t, current, winner.workflow, winner.collaboration, "saved")
			navigationEditTestRevision(t, before["revision"].(string), current["revision"].(string), 1)
			if got := f.owner.ok("GET", "/settings/session-policy", nil); !reflect.DeepEqual(got, policy) {
				t.Fatal("MCP save changed the independent login-policy settings")
			}
			// A preexisting site form cannot erase either MCP field or its revision.
			siteInput := moduleTestSettingsBody(site, map[string]any{"documents": false})
			siteInput["siteName"] = "Unrelated site edit"
			f.owner.ok("PUT", "/settings", siteInput)
			f.owner.ok("PUT", "/settings/session-policy", map[string]any{
				"defaultMode": policy["defaultMode"], "defaultIdleDays": policy["defaultIdleDays"],
				"maxIdleDays": policy["maxIdleDays"], "allowUntilLogout": policy["allowUntilLogout"],
				"expectedVersion": policy["policyVersion"],
			})
			if after := f.owner.ok("GET", "/settings/mcp", nil); !reflect.DeepEqual(after, current) {
				t.Fatal("site or login-policy save overwrote independent MCP settings")
			}
			if revision := f.owner.ok("GET", f.base+"/revision", nil); revision["mcpSettingsRevision"] != current["revision"] {
				t.Fatal("unrelated settings changed the work poll MCP revision")
			}
			// Retrying an old form must not overwrite a more recent save.
			statusWant(t, f.owner, http.StatusConflict, "PUT", "/settings/mcp", mcpSettingsTestBody(before["revision"], false, false))
			if after := f.owner.ok("GET", "/settings/mcp", nil); !reflect.DeepEqual(after, current) {
				t.Fatal("stale save changed persisted settings")
			}
			mcpSettingsTestSave(t, f.owner, false, false)
			afterSite := f.owner.ok("GET", "/settings", nil)
			if afterSite["siteName"] != "Unrelated site edit" || integrationObject(t, afterSite["modules"])["documents"] != false {
				t.Fatal("narrow MCP save overwrote site or module state")
			}
		})
	}
}

func TestMCPSettingsRuntimeContextAndClaimCleanup(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			api := &integrationTestBrowser{t: t, base: f.owner.base, client: f.owner.client, csrf: f.owner.csrf}
			token, _ := api.token(f.space, "", "work:read", "work:write")
			agent := integrationBrowser(t, f.owner.base)
			catalogBefore, _ := agent.mcp(token, "tools/list", map[string]any{}, http.StatusOK)
			checkContext := func(workflow, collaboration bool) {
				t.Helper()
				data := collaborationMCPCall(t, agent, token, "space_current", map[string]any{}, false)
				if data["contextVersion"] != float64(1) || integrationObject(t, data["workflow"])["enabled"] != workflow || integrationObject(t, data["collaboration"])["enabled"] != collaboration {
					t.Fatalf("MCP context did not follow persisted settings: %v", data)
				}
				mcp := agent.tool(token, "work_collaboration_get", map[string]any{}, "")
				httpValue := f.owner.ok("GET", f.base+"/collaboration", nil)
				if mcp["enabled"] != collaboration || mcp["effectiveEnabled"] != collaboration || httpValue["enabled"] != collaboration {
					t.Fatal("HTTP and MCP disagree about collaboration configuration")
				}
			}
			checkContext(false, false)
			mcpSettingsTestSave(t, f.owner, true, false)
			checkContext(true, false)
			agent.tool(token, "work_items_create", map[string]any{"input": map[string]any{"id": newID(), "title": "Guidance does not require a claim"}}, "")
			mcpSettingsTestSave(t, f.owner, false, true)
			checkContext(false, true)
			collaborationMCPCall(t, agent, token, "work_items_create", map[string]any{"input": map[string]any{"id": newID(), "title": "Cannot bypass enabled coordination"}}, true)
			session := agent.tool(token, "work_sessions_open", map[string]any{"input": map[string]any{"registrationId": newID(), "agentName": "Settings fixture"}}, "")
			item := f.owner.ok("POST", f.base+"/items", map[string]any{"id": newID(), "title": "Keep claim during disable"})
			itemPath := workItemPath(f.space, item["id"].(string))
			claim := agent.tool(token, "work_claims_acquire", map[string]any{"id": item["id"], "input": map[string]any{"sessionId": session["id"], "operationId": newID(), "expectedRevision": item["revision"], "expectedGeneration": "0"}}, "")
			beforeOffRevision := f.owner.ok("GET", f.base+"/revision", nil)
			beforeOffItem := f.owner.ok("GET", itemPath, nil)
			savedOff := mcpSettingsTestSave(t, f.owner, false, false)
			afterOffRevision := f.owner.ok("GET", f.base+"/revision", nil)
			if afterOffRevision["mcpSettingsRevision"] != savedOff["revision"] || beforeOffRevision["mcpSettingsRevision"] == afterOffRevision["mcpSettingsRevision"] {
				t.Fatal("work polling did not observe the saved MCP configuration")
			}
			for key, before := range beforeOffRevision {
				if key != "mcpSettingsRevision" && !reflect.DeepEqual(before, afterOffRevision[key]) {
					t.Fatalf("MCP setting changed unrelated work revision %s", key)
				}
			}
			collabCoreAssertBusiness(t, beforeOffItem, f.owner.ok("GET", itemPath, nil))
			checkContext(false, false)
			collaborationMCPCall(t, agent, token, "work_sessions_open", map[string]any{"input": map[string]any{"registrationId": newID(), "agentName": "Disabled new session"}}, true)
			collaborationMCPCall(t, agent, token, "work_claims_acquire", map[string]any{"id": item["id"], "input": map[string]any{"sessionId": session["id"], "operationId": newID(), "expectedRevision": item["revision"], "expectedGeneration": claim["generation"]}}, true)
			statusWant(t, f.owner, http.StatusConflict, "PATCH", itemPath, map[string]any{"expectedRevision": item["revision"], "title": "No human bypass while off"})
			collaborationMCPCall(t, agent, token, "work_items_update", map[string]any{"id": item["id"], "input": map[string]any{"expectedRevision": item["revision"], "title": "No token bypass while off"}}, true)
			agent.tool(token, "work_claims_renew", map[string]any{"id": item["id"], "input": collabCoreContext(session, claim)}, "")
			handoff := collabCoreContext(session, claim)
			handoff["handoff"] = map[string]any{"completed": "Configuration change checked", "workspace": "disposable fixture", "nextStep": "Finished", "unknowns": ""}
			released := agent.tool(token, "work_claims_release", map[string]any{"id": item["id"], "input": handoff}, "")
			if released["state"] != "released" || released["unresolved"] != false {
				t.Fatal("disabled collaboration prevented clean handoff")
			}
			agent.tool(token, "work_sessions_close", map[string]any{"id": session["id"], "input": map[string]any{"operationId": newID()}}, "")
			agent.tool(token, "work_items_update", map[string]any{"id": item["id"], "input": map[string]any{"expectedRevision": item["revision"], "nextStep": "Legacy write restored after cleanup"}}, "")
			catalogAfter, _ := agent.mcp(token, "tools/list", map[string]any{}, http.StatusOK)
			if !reflect.DeepEqual(integrationObject(t, catalogBefore["result"])["tools"], integrationObject(t, catalogAfter["result"])["tools"]) {
				t.Fatal("runtime setting changed static tool schema and required rediscovery")
			}
			if f.app.config.MCPWorkflowEnabled || f.app.config.MCPCollaborationEnabled {
				t.Fatal("saving runtime settings mutated startup Config")
			}
		})
	}
}

func TestMCPSettingsStartupDefaultsAndRestartPersistence(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		t.Run(fmt.Sprintf("postgres-%v", postgres), func(t *testing.T) {
			config := autoIconConfig(t, postgres)
			config.MCPWorkflowEnabled, config.MCPCollaborationEnabled = true, false
			app, err := Open(config)
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(app)
			t.Cleanup(func() {
				if server != nil {
					server.Close()
				}
				if app != nil {
					if err := app.Close(); err != nil {
						t.Error(err)
					}
				}
			})
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Persist MCP config", "mode": ModePublicRead, "username": "owner", "password": "MCP persistence fixture password", "seedDemo": false})
			owner.bootstrap()
			initial := owner.ok("GET", "/settings/mcp", nil)
			mcpSettingsTestAssert(t, initial, true, false, "startup")
			// Persisting unchanged effective values still records an explicit choice.
			saved := mcpSettingsTestSave(t, owner, true, false)
			restart := func(workflow, collaboration bool) {
				t.Helper()
				server.Close()
				server = nil
				if err := app.Close(); err != nil {
					t.Fatal(err)
				}
				app = nil
				config.MCPWorkflowEnabled, config.MCPCollaborationEnabled = workflow, collaboration
				app, err = Open(config)
				if err != nil {
					t.Fatal(err)
				}
				server = httptest.NewServer(app)
				owner = newCoreBrowser(t, server.URL)
				owner.bootstrap()
				owner.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": "MCP persistence fixture password"})
				owner.bootstrap()
			}
			restart(false, true)
			current := owner.ok("GET", "/settings/mcp", nil)
			mcpSettingsTestAssert(t, current, true, false, "saved")
			if current["revision"] != saved["revision"] {
				t.Fatal("restart changed MCP revision")
			}
			saved = mcpSettingsTestSave(t, owner, false, false)
			restart(true, true)
			current = owner.ok("GET", "/settings/mcp", nil)
			mcpSettingsTestAssert(t, current, false, false, "saved")
			if current["revision"] != saved["revision"] {
				t.Fatal("explicit false or independent revision did not survive restart")
			}
		})
	}
}

func TestMCPSettingsMigrationPreservesAndRollsBack(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, rollback := range []bool{false, true} {
			t.Run(fmt.Sprintf("postgres-%v/rollback-%v", postgres, rollback), func(t *testing.T) {
				db, store := documentMigrationDB(t, postgres)
				exec := func(query string, args ...any) {
					t.Helper()
					if _, err := db.Exec(store.Query(query), args...); err != nil {
						t.Fatal(err)
					}
				}
				seedSessionUpgrade(t, db, store, 9, false, nil)
				entries, err := migrationFiles.ReadDir("migrations/" + store.Provider)
				if err != nil {
					t.Fatal(err)
				}
				stamp := "2026-11-14T01:02:03Z"
				for _, entry := range entries {
					name := entry.Name()
					if name <= "009_document_activity.sql" || name >= "019_mcp_settings.sql" || !strings.HasSuffix(name, ".sql") {
						continue
					}
					body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/" + name)
					if err != nil {
						t.Fatal(err)
					}
					exec(string(body))
					digest := sha256.Sum256(body)
					exec("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)", name, hex.EncodeToString(digest[:]), stamp)
				}
				exec("UPDATE settings SET documents_enabled=?,work_enabled=?,session_policy_version=9", false, true)
				exec("INSERT INTO work_items(id,space_id,title,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash,create_hash_version,activity_started_at) VALUES('mcp-settings-old-item','old-space','Retained claimed work','todo',?,?,1024,8,?,?,'original-intent',2,?)", true, false, stamp, stamp, stamp)
				exec("INSERT INTO work_item_documents(item_id,document_id) VALUES('mcp-settings-old-item','old-document')")
				exec("INSERT INTO work_sessions(id,space_id,user_id,registration_id,create_hash,agent_name,created_at,last_seen_at) VALUES('old-work-session','old-space','old-owner','old-registration','old-create-hash','Existing Agent',?,?)", stamp, stamp)
				exec("INSERT INTO work_claims(item_id,space_id,claim_id,session_id,generation,expires_at,last_seen_at,unresolved) VALUES('mcp-settings-old-item','old-space','old-claim','old-work-session',7,'2099-11-14T01:02:03Z',?,?)", stamp, true)
				exec("INSERT INTO work_collaboration_spaces(space_id,revision) VALUES('old-space',12)")
				exec("INSERT INTO work_collaboration_events(id,space_id,item_id,sequence,operation_id,actor_id,kind,body,occurred_at,origin) VALUES('old-collaboration-event','old-space','mcp-settings-old-item',12,'old-operation','old-owner','progress','Retained progress',?,'mcp')", stamp)
				exec("INSERT INTO work_operation_receipts(space_id,user_id,operation_id,request_hash,response_json,created_at) VALUES('old-space','old-owner','old-operation','old-request-hash','{}',?)", stamp)
				exec("INSERT INTO integration_tokens(id,user_id,name,token_hash,space_id,actions_json,permission_epoch,user_version,created_at,expires_at) VALUES('old-mcp-settings-token','old-owner','Retained token','fixture-not-a-secret','old-space',?,7,3,?,'2099-11-14T01:02:03Z')", jsonString([]string{"work:read", "work:write"}), stamp)
				if rollback {
					if postgres {
						exec("CREATE FUNCTION mcp_settings_migration_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version='019_mcp_settings.sql' THEN RAISE EXCEPTION 'intentional MCP settings migration failure'; END IF; RETURN NEW; END $$")
						exec("CREATE TRIGGER mcp_settings_migration_fail BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION mcp_settings_migration_fail_fn()")
					} else {
						exec("CREATE TRIGGER mcp_settings_migration_fail BEFORE INSERT ON schema_migrations WHEN NEW.version='019_mcp_settings.sql' BEGIN SELECT RAISE(ABORT,'intentional MCP settings migration failure'); END")
					}
				}
				before := sessionUpgradeDatabaseState(t, db, store.Provider)
				for table, row := range before {
					before[table] = workStatusTestRows(t, db, table, row.columns)
				}
				err = store.migrate(context.Background())
				if rollback {
					if err == nil {
						t.Fatal("injected late migration failure succeeded")
					}
					after := sessionUpgradeDatabaseState(t, db, store.Provider)
					if len(before) != len(after) {
						t.Fatal("failed migration changed table inventory")
					}
					for table, row := range before {
						now, exists := after[table]
						if !exists || !reflect.DeepEqual(row.columns, now.columns) || !reflect.DeepEqual(row, workStatusTestRows(t, db, table, row.columns)) {
							t.Fatalf("failed migration changed original table %s", table)
						}
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				for table, row := range before {
					if table != "schema_migrations" && !reflect.DeepEqual(row, workStatusTestRows(t, db, table, row.columns)) {
						t.Fatalf("019 changed existing settings, claims, credentials or business history in %s", table)
					}
				}
				var workflow, collaboration sql.NullBool
				var version int64
				if err = db.QueryRow("SELECT mcp_workflow_enabled,mcp_collaboration_enabled,mcp_settings_version FROM settings WHERE id=1").Scan(&workflow, &collaboration, &version); err != nil || workflow.Valid || collaboration.Valid || version != 1 {
					t.Fatalf("migration did not preserve startup inheritance: %v", err)
				}
				migrated := sessionUpgradeDatabaseState(t, db, store.Provider)
				for table, row := range migrated {
					migrated[table] = workStatusTestRows(t, db, table, row.columns)
				}
				if err = store.migrate(context.Background()); err != nil {
					t.Fatal("second startup failed", err)
				}
				for table, row := range migrated {
					if !reflect.DeepEqual(row, workStatusTestRows(t, db, table, row.columns)) {
						t.Fatalf("second startup changed %s", table)
					}
				}
			})
		}
	}
}
