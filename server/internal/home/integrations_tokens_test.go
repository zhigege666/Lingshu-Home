package home

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

type integrationTokenFixture struct {
	app             *App
	owner, agent    *integrationTestBrowser
	space, personal string
}

func newIntegrationTokenFixture(t *testing.T, provider string) *integrationTokenFixture {
	t.Helper()
	app, server := newAccountProfileHTTPFixture(t, provider)
	owner := integrationBrowser(t, server.URL)
	owner.boot()
	owner.object("POST", "/api/v1/setup", map[string]any{"siteName": "Token fixture", "mode": ModePrivateMulti, "username": "owner", "password": "token fixture password", "seedDemo": false}, 201, "")
	boot := owner.boot()
	return &integrationTokenFixture{app, owner, integrationBrowser(t, server.URL), integrationSpace(t, boot, "shared"), integrationSpace(t, boot, "personal")}
}

func integrationTokenTestCredential(t *testing.T, owner *integrationTestBrowser, id string) map[string]any {
	t.Helper()
	for _, raw := range owner.call("GET", "/api/v1/integrations/tokens", nil, 200, "").([]any) {
		credential := integrationObject(t, raw)
		if credential["id"] == id {
			return credential
		}
	}
	t.Fatal("token record missing")
	return nil
}

func integrationTokenTestCode(t *testing.T, body map[string]any, code string) {
	t.Helper()
	if body["code"] != code {
		t.Fatalf("error code=%v want=%s", body["code"], code)
	}
}

func integrationTokenTestMember(t *testing.T, f *integrationTokenFixture) *integrationTestBrowser {
	t.Helper()
	f.owner.object("POST", "/api/v1/admin/users", map[string]any{"username": "token-member", "displayName": "Member", "password": "token member password"}, 201, "")
	member := integrationBrowser(t, f.owner.base)
	member.boot()
	member.call("POST", "/api/v1/auth/login", map[string]any{"username": "token-member", "password": "token member password"}, 200, "")
	member.boot()
	return member
}

func TestIntegrationTokenEditingAndLivePermissions(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newIntegrationTokenFixture(t, provider)
			raw, id := f.owner.token(f.space, "", "navigation:read")
			path := "/api/v1/integrations/tokens/" + id
			credential := integrationTokenTestCredential(t, f.owner, id)
			if credential["revision"] != "1" || credential["permissionMode"] != "selected" {
				t.Fatal("legacy creation changed permission mode or omitted the revision")
			}
			immutableColumns := []string{"id", "user_id", "token_hash", "space_id", "source_id", "permission_epoch", "user_version", "created_at"}
			immutable := componentCaptureRows(t, f.app.store.DB, "integration_tokens WHERE id='"+id+"'", immutableColumns)
			board := "/api/v1/spaces/" + f.space + "/work/board"
			f.agent.call("GET", board, nil, 403, raw)
			f.agent.tool(raw, "work_board_get", map[string]any{}, "forbidden")
			credential = f.owner.object("PATCH", path, map[string]any{"expectedRevision": credential["revision"], "name": "Original PAT with work access", "actions": []string{"work:read", "work:write"}}, 200, "")
			if credential["revision"] != "2" || credential["token"] != nil || credential["token_hash"] != nil {
				t.Fatal("edit did not advance the revision or exposed a secret")
			}
			f.agent.call("GET", board, nil, 200, raw)
			f.agent.tool(raw, "work_board_get", map[string]any{}, "")
			f.agent.tool(raw, "work_items_create", map[string]any{"input": map[string]any{"id": newID(), "title": "Created with the original PAT"}}, "")
			credential = f.owner.object("PATCH", path, map[string]any{"expectedRevision": credential["revision"], "actions": []string{"navigation:read"}}, 200, "")
			f.agent.call("GET", board, nil, 403, raw)
			f.agent.tool(raw, "work_items_create", map[string]any{"input": map[string]any{"id": newID(), "title": "Must be rejected immediately"}}, "forbidden")
			if !reflect.DeepEqual(immutable, componentCaptureRows(t, f.app.store.DB, "integration_tokens WHERE id='"+id+"'", immutableColumns)) {
				t.Fatal("editing rotated or rebound the token, or changed its identity epochs")
			}
			conflict := f.owner.object("PATCH", path, map[string]any{"expectedRevision": "1", "name": "Stale overwrite"}, 409, "")
			integrationTokenTestCode(t, conflict, "integration_token_version_conflict")
			if conflict["currentRevision"] != credential["revision"] {
				t.Fatal("conflict omitted the current revision")
			}
			for _, field := range []string{"spaceId", "sourceId", "userVersion", "permissionEpoch", "tokenHash", "createdAt"} {
				f.owner.call("PATCH", path, map[string]any{"expectedRevision": credential["revision"], field: nil}, 400, "")
			}
			withoutCSRF := &integrationTestBrowser{t: t, client: f.owner.client, base: f.owner.base}
			for _, methodPath := range []struct{ method, path string }{{"PATCH", path}, {"DELETE", path}, {"DELETE", path + "/record"}} {
				body := map[string]any{"expectedRevision": credential["revision"], "name": "No CSRF"}
				response := withoutCSRF.object(methodPath.method, methodPath.path, body, 403, "")
				integrationTokenTestCode(t, response, "csrf_invalid")
				f.agent.call(methodPath.method, methodPath.path, body, 403, raw)
			}
			f.agent.call("GET", "/api/v1/integrations/token-actions", nil, 403, raw)
			member := integrationTokenTestMember(t, f)
			member.call("PATCH", path, map[string]any{"expectedRevision": credential["revision"], "name": "Other account"}, 404, "")
			member.call("DELETE", path, nil, 404, "")
			member.call("DELETE", path+"/record", map[string]any{"expectedRevision": credential["revision"]}, 404, "")
			if !reflect.DeepEqual(credential, integrationTokenTestCredential(t, f.owner, id)) {
				t.Fatal("rejected edits changed the token")
			}
			body := f.owner.object("DELETE", path+"/record", map[string]any{"expectedRevision": credential["revision"]}, 409, "")
			integrationTokenTestCode(t, body, "integration_token_not_revoked")
			f.owner.call("DELETE", path, nil, 200, "")
			revoked := integrationTokenTestCredential(t, f.owner, id)
			navigationEditTestRevision(t, credential["revision"], revoked["revision"], 1)
			if revoked["status"] != "revoked" || revoked["revokedAt"] == nil {
				t.Fatal("revocation did not persist")
			}
			f.owner.call("DELETE", path, nil, 200, "")
			if !reflect.DeepEqual(revoked, integrationTokenTestCredential(t, f.owner, id)) {
				t.Fatal("repeated revoke changed the timestamp or revision")
			}
			f.agent.call("GET", board, nil, 401, raw)
			f.agent.mcp(raw, "tools/call", map[string]any{"name": "space_current"}, 401)
			body = f.owner.object("PATCH", path, map[string]any{"expectedRevision": revoked["revision"], "expiresAt": nil, "permissionMode": "all"}, 409, "")
			integrationTokenTestCode(t, body, "integration_token_not_editable")
			body = f.owner.object("DELETE", path+"/record", map[string]any{"expectedRevision": credential["revision"]}, 409, "")
			integrationTokenTestCode(t, body, "integration_token_version_conflict")
			if result := f.owner.object("DELETE", path+"/record", map[string]any{"expectedRevision": revoked["revision"]}, 200, ""); result["success"] != true {
				t.Fatal("record deletion missing success receipt")
			}
			if len(f.owner.call("GET", "/api/v1/integrations/tokens", nil, 200, "").([]any)) != 0 {
				t.Fatal("deleted record remained listed")
			}
			var remaining int
			if err := f.app.store.DB.QueryRow(f.app.store.Query("SELECT COUNT(*) FROM integration_tokens WHERE id=? OR token_hash=?"), id, integrationHash(raw)).Scan(&remaining); err != nil || remaining != 0 {
				t.Fatal("physical deletion retained the credential", err)
			}
			f.agent.mcp(raw, "tools/call", map[string]any{"name": "space_current"}, 401)
		})
	}
}

func TestIntegrationTokenExpiryAndInvalidation(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newIntegrationTokenFixture(t, provider)
			raw, id := f.owner.token(f.space, "", "navigation:read")
			path := "/api/v1/integrations/tokens/" + id
			nearExpiry := time.Now().UTC().Add(45 * time.Second).Truncate(time.Microsecond)
			if _, err := f.app.store.DB.Exec(f.app.store.Query("UPDATE integration_tokens SET expires_at=? WHERE id=?"), integrationStamp(nearExpiry), id); err != nil {
				t.Fatal(err)
			}
			credential := f.owner.object("PATCH", path, map[string]any{"expectedRevision": "1", "name": "Near expiry rename"}, 200, "")
			if credential["expiresAt"] != integrationStamp(nearExpiry) {
				t.Fatal("rename changed a near-expiry token's validity")
			}
			if _, err := f.app.store.DB.Exec(f.app.store.Query("UPDATE integration_tokens SET expires_at=? WHERE id=?"), integrationStamp(time.Now().Add(-time.Hour)), id); err != nil {
				t.Fatal(err)
			}
			credential = integrationTokenTestCredential(t, f.owner, id)
			if credential["status"] != "expired" {
				t.Fatal("expired token status missing")
			}
			f.agent.mcp(raw, "tools/call", map[string]any{"name": "space_current"}, 401)
			body := f.owner.object("PATCH", path, map[string]any{"expectedRevision": credential["revision"], "name": "Must explicitly renew"}, 400, "")
			integrationTokenTestCode(t, body, "integration_token_expiry_required")
			f.owner.call("PATCH", path, map[string]any{"expectedRevision": credential["revision"], "expiresAt": time.Now().Add(20 * time.Second)}, 400, "")
			credential = f.owner.object("PATCH", path, map[string]any{"expectedRevision": credential["revision"], "expiresAt": nil}, 200, "")
			if credential["expiresAt"] != nil || credential["status"] != "active" {
				t.Fatal("explicit permanent renewal did not restore valid access")
			}
			f.agent.tool(raw, "bookmarks_list", map[string]any{}, "")
			permanent := credential
			credential = f.owner.object("PATCH", path, map[string]any{"expectedRevision": credential["revision"], "name": "Keep permanent"}, 200, "")
			if credential["expiresAt"] != nil {
				t.Fatal("omitted expiry removed permanent validity")
			}
			finite := time.Now().UTC().Add(2 * time.Hour).Truncate(time.Microsecond)
			credential = f.owner.object("PATCH", path, map[string]any{"expectedRevision": credential["revision"], "expiresAt": finite}, 200, "")
			if credential["expiresAt"] != integrationStamp(finite) || permanent["expiresAt"] != nil {
				t.Fatal("explicit finite expiry was not saved")
			}
			for _, invalidation := range []string{"permission_epoch", "user_version"} {
				created := f.owner.object("POST", "/api/v1/integrations/tokens", map[string]any{"name": "Cannot revive " + invalidation, "spaceId": f.space, "actions": []string{"navigation:read"}, "expiresAt": nil}, 201, "")
				token := created["token"].(string)
				entry := integrationObject(t, created["credential"])
				tokenID := entry["id"].(string)
				if _, err := f.app.store.DB.Exec(f.app.store.Query("UPDATE integration_tokens SET "+invalidation+"="+invalidation+"+1 WHERE id=?"), tokenID); err != nil {
					t.Fatal(err)
				}
				entry = integrationTokenTestCredential(t, f.owner, tokenID)
				if entry["status"] != "invalidated" {
					t.Fatal("permanent token ignored identity invalidation")
				}
				before := componentCaptureRows(t, f.app.store.DB, "integration_tokens WHERE id='"+tokenID+"'", nil)
				body = f.owner.object("PATCH", "/api/v1/integrations/tokens/"+tokenID, map[string]any{"expectedRevision": entry["revision"], "expiresAt": nil, "permissionMode": "all"}, 409, "")
				integrationTokenTestCode(t, body, "integration_token_not_editable")
				if !reflect.DeepEqual(before, componentCaptureRows(t, f.app.store.DB, "integration_tokens WHERE id='"+tokenID+"'", before.columns)) {
					t.Fatal("rejected edit refreshed identity epochs or permissions")
				}
				f.agent.mcp(token, "tools/call", map[string]any{"name": "space_current"}, 401)
			}
		})
	}
}

func TestIntegrationTokenCatalogAllModeAndScope(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newIntegrationTokenFixture(t, provider)
			catalog := f.owner.object("GET", "/api/v1/integrations/token-actions", nil, 200, "")
			if !reflect.DeepEqual(catalog["defaultActions"], []any{"navigation:read", "pages:read"}) || len(catalog["items"].([]any)) != len(integrationActions) {
				t.Fatal("metadata drifted from accepted actions or safe defaults")
			}
			for _, item := range catalog["items"].([]any) {
				definition := integrationObject(t, item)
				if definition["requires"] == nil || definition["label"] == "" || definition["write"] != strings.HasSuffix(definition["id"].(string), ":write") {
					t.Fatal("action metadata incomplete")
				}
				if definition["id"] == "documents:write" && !reflect.DeepEqual(definition["requires"], []any{"documents:read"}) {
					t.Fatal("document dependency missing")
				}
			}
			if _, err := f.app.store.DB.Exec("UPDATE settings SET language='en' WHERE id=1"); err != nil {
				t.Fatal(err)
			}
			catalog = f.owner.object("GET", "/api/v1/integrations/token-actions", nil, 200, "")
			if catalog["items"].([]any)[0].(map[string]any)["label"] != "Read navigation" {
				t.Fatal("action labels ignored instance language")
			}
			anonymous := integrationBrowser(t, f.owner.base)
			anonymous.call("GET", "/api/v1/integrations/token-actions", nil, 401, "")
			created := f.owner.object("POST", "/api/v1/integrations/tokens", map[string]any{"name": "All current and future business actions", "spaceId": f.space, "permissionMode": "all", "expiresAt": nil}, 201, "")
			all := created["token"].(string)
			credential := integrationObject(t, created["credential"])
			if credential["expiresAt"] != nil || credential["permissionMode"] != "all" || len(credential["actions"].([]any)) != len(integrationActions) {
				t.Fatal("explicit all/permanent mode was not represented")
			}
			id := credential["id"].(string)
			path := "/api/v1/integrations/tokens/" + id
			f.agent.tool(all, "work_items_create", map[string]any{"input": map[string]any{"id": newID(), "title": "All mode write"}}, "")
			f.agent.call("GET", "/api/v1/integrations/token-actions", nil, 403, all)
			f.agent.call("POST", "/api/v1/integrations/tokens", map[string]any{}, 403, all)
			f.agent.call("POST", "/api/v1/admin/users", map[string]any{}, 403, all)
			f.owner.call("PATCH", path, map[string]any{"expectedRevision": credential["revision"], "permissionMode": "selected"}, 400, "")
			credential = f.owner.object("PATCH", path, map[string]any{"expectedRevision": credential["revision"], "permissionMode": "selected", "actions": []string{"navigation:read"}}, 200, "")
			f.agent.tool(all, "work_board_get", map[string]any{}, "forbidden")
			credential = f.owner.object("PATCH", path, map[string]any{"expectedRevision": credential["revision"], "permissionMode": "all"}, 200, "")
			f.agent.tool(all, "work_board_get", map[string]any{}, "")
			member := integrationTokenTestMember(t, f)
			memberCreated := member.object("POST", "/api/v1/integrations/tokens", map[string]any{"name": "Read-only account all", "spaceId": f.space, "permissionMode": "all", "expiresAt": nil}, 201, "")
			readOnlyAll := memberCreated["token"].(string)
			for _, action := range integrationObject(t, memberCreated["credential"])["actions"].([]any) {
				if strings.HasSuffix(action.(string), ":write") {
					t.Fatal("all mode exceeded account space permissions")
				}
			}
			f.agent.tool(readOnlyAll, "bookmarks_list", map[string]any{}, "")
			f.agent.tool(readOnlyAll, "work_items_create", map[string]any{"input": map[string]any{"id": newID(), "title": "No account write permission"}}, "forbidden")
			member.call("POST", "/api/v1/integrations/tokens", map[string]any{"name": "Cannot select writes", "spaceId": f.space, "actions": []string{"navigation:write"}, "expiresAt": nil}, 403, "")
			source := f.owner.source(f.space, "Scoped all")
			scopedCreated := f.owner.object("POST", "/api/v1/integrations/tokens", map[string]any{"name": "Source-bound all", "spaceId": f.space, "sourceId": source["id"], "permissionMode": "all", "expiresAt": nil}, 201, "")
			scoped := scopedCreated["token"].(string)
			if !reflect.DeepEqual(integrationObject(t, scopedCreated["credential"])["actions"], []any{"datasets:write", "sources:read"}) {
				t.Fatal("source all expanded outside its bound actions")
			}
			f.agent.tool(scoped, "sources_get", map[string]any{"id": source["id"]}, "")
			f.agent.tool(scoped, "bookmarks_list", map[string]any{}, "forbidden")
			f.agent.tool(scoped, "work_board_get", map[string]any{}, "forbidden")
			// A newly supported business action becomes usable only for explicit all.
			selected, _ := f.owner.token(f.space, "", "navigation:read")
			originalSpecs := integrationTokenActionSpecs
			integrationTokenActionSpecs = append(append([]integrationTokenActionSpec{}, originalSpecs...), integrationTokenActionSpec{ID: "future:read"}, integrationTokenActionSpec{ID: "future:write", Write: true}, integrationTokenActionSpec{ID: "future:requires-write", SourceScoped: true, Requires: []string{"navigation:write"}})
			defer func() { integrationTokenActionSpecs = originalSpecs }()
			for _, action := range []string{"future:read", "future:write", "future:requires-write"} {
				action := action
				f.app.route("POST /api/v1/token-fixture/"+action, true, func(r *Request) (*Response, error) {
					if err := r.requireAction(action); err != nil {
						return nil, err
					}
					return ok(map[string]any{"allowed": true}), nil
				})
			}
			for _, action := range []string{"future:read", "future:write", "future:requires-write"} {
				endpoint := "/api/v1/token-fixture/" + action
				f.agent.call("POST", endpoint, nil, 200, all)
				f.agent.call("POST", endpoint, nil, 403, selected)
				f.agent.call("POST", endpoint, nil, 403, scoped)
			}
			f.agent.call("POST", "/api/v1/token-fixture/future:read", nil, 200, readOnlyAll)
			f.agent.call("POST", "/api/v1/token-fixture/future:write", nil, 403, readOnlyAll)
			f.agent.call("POST", "/api/v1/token-fixture/future:requires-write", nil, 403, readOnlyAll)
		})
	}
}

func TestIntegrationTokenCreateAndEditShareValidation(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newIntegrationTokenFixture(t, provider)
			_, id := f.owner.token(f.space, "", "navigation:read")
			credential := integrationTokenTestCredential(t, f.owner, id)
			for _, actions := range [][]string{{"documents:write"}, {"unknown:read"}, {"navigation:read", "navigation:read"}, {}} {
				f.owner.call("POST", "/api/v1/integrations/tokens", map[string]any{"name": "Invalid selection", "spaceId": f.space, "actions": actions, "expiresAt": nil}, 400, "")
				f.owner.call("PATCH", "/api/v1/integrations/tokens/"+id, map[string]any{"expectedRevision": credential["revision"], "actions": actions}, 400, "")
			}
			f.owner.call("POST", "/api/v1/integrations/tokens", map[string]any{"name": "No implicit permanent validity", "spaceId": f.space, "actions": []string{"navigation:read"}}, 400, "")
			f.owner.call("POST", "/api/v1/integrations/tokens", map[string]any{"name": "Ambiguous all", "spaceId": f.space, "permissionMode": "all", "actions": []string{"navigation:read"}, "expiresAt": nil}, 400, "")
			f.owner.call("PATCH", "/api/v1/integrations/tokens/"+id, map[string]any{"expectedRevision": credential["revision"], "permissionMode": "all", "actions": []string{"navigation:read"}}, 400, "")
			source := f.owner.source(f.space, "Scope validation")
			_, scopedID := f.owner.token(f.space, source["id"].(string), "sources:read")
			scoped := integrationTokenTestCredential(t, f.owner, scopedID)
			f.owner.call("POST", "/api/v1/integrations/tokens", map[string]any{"name": "Cannot widen source", "spaceId": f.space, "sourceId": source["id"], "actions": []string{"work:read"}, "expiresAt": nil}, 400, "")
			f.owner.call("PATCH", "/api/v1/integrations/tokens/"+scopedID, map[string]any{"expectedRevision": scoped["revision"], "actions": []string{"work:read"}}, 400, "")
			f.owner.call("POST", "/api/v1/integrations/tokens", map[string]any{"name": "Foreign source", "spaceId": f.personal, "sourceId": source["id"], "permissionMode": "all", "expiresAt": nil}, 404, "")
			if !reflect.DeepEqual(credential, integrationTokenTestCredential(t, f.owner, id)) || !reflect.DeepEqual(scoped, integrationTokenTestCredential(t, f.owner, scopedID)) {
				t.Fatal("rejected selection changed stored permissions")
			}
		})
	}
}

func TestIntegrationTokenMigrationPreservesLegacyTokens(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		t.Run(fmt.Sprintf("postgres-%v", postgres), func(t *testing.T) {
			db, store := documentMigrationDB(t, postgres)
			seedSessionUpgrade(t, db, store, 9, false, nil)
			for _, name := range []string{"010_session_retention.sql", "011_link_clicks.sql", "012_work_board.sql", "013_account_avatar.sql", "014_work_statuses.sql"} {
				body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/" + name)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = db.Exec(string(body)); err != nil {
					t.Fatal(err)
				}
				digest := sha256.Sum256(body)
				if _, err = db.Exec(store.Query("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)"), name, hex.EncodeToString(digest[:]), "2026-11-13T00:00:00Z"); err != nil {
					t.Fatal(err)
				}
			}
			// The session fixture's old-source is a document source, not an integration source.
			// Give the legacy tokens a real same-space source for their composite foreign key.
			_, err := db.Exec(store.Query("INSERT INTO integration_sources(id,space_id,created_by,name,kind,schema_id,schema_version,connection_json,sync_json,enabled,config_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"), "old-token-source", "old-space", "old-owner", "Token migration fixture", "external-push", "navigation.collection", 1, `{}`, `{"mode":"push","staleAfterSeconds":3600}`, true, 1, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z")
			if err != nil {
				t.Fatal(err)
			}
			for i, name := range []string{"active", "expired", "revoked", "invalidated"} {
				expiry, version := "2099-01-01T00:00:00Z", 3
				var revoked any
				if name == "expired" {
					expiry = "2020-01-01T00:00:00Z"
				}
				if name == "revoked" {
					revoked = "2026-11-01T00:00:00Z"
				}
				if name == "invalidated" {
					version = 2
				}
				_, err := db.Exec(store.Query("INSERT INTO integration_tokens(id,user_id,name,token_hash,space_id,source_id,actions_json,permission_epoch,user_version,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"), "legacy-token-"+name, "old-owner", name, fmt.Sprintf("retained-hash-%d", i), "old-space", "old-token-source", `["sources:read"]`, 7, version, "2026-10-01T00:00:00Z", expiry, revoked)
				if err != nil {
					t.Fatal(err)
				}
			}
			before := sessionUpgradeDatabaseState(t, db, store.Provider)
			if err := store.migrate(context.Background()); err != nil {
				t.Fatal(err)
			}
			for table, original := range before {
				if table == "schema_migrations" {
					continue
				}
				if !reflect.DeepEqual(original, componentCaptureRows(t, db, table, original.columns)) {
					t.Fatalf("token migration changed existing %s", table)
				}
			}
			var count int
			if err := db.QueryRow("SELECT COUNT(*) FROM integration_tokens WHERE revision=1 AND never_expires=FALSE AND permission_mode='selected'").Scan(&count); err != nil || count != 4 {
				t.Fatal("migration widened or changed legacy token semantics", err)
			}
		})
	}
}
