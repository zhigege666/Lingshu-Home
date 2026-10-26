package home

import (
	"net/http"
	"testing"
	"time"
)

func installSessionRetentionCommitFailure(t *testing.T, a *App, provider, kind string) func() {
	t.Helper()
	table, column := "sessions", "renewed_at"
	if kind == "policy" {
		table, column = "settings", "session_policy_version"
	}
	statements := []string{"CREATE TABLE session_retention_commit_parent(id INTEGER PRIMARY KEY)", "CREATE TABLE session_retention_commit_child(parent_id INTEGER NOT NULL REFERENCES session_retention_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)"}
	cleanup := []string{}
	if provider == "postgres" {
		statements = append(statements, "CREATE FUNCTION session_retention_commit_failure() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN INSERT INTO session_retention_commit_child(parent_id) VALUES(1); RETURN NEW; END; $$", "CREATE TRIGGER session_retention_commit_failure AFTER UPDATE OF "+column+" ON "+table+" FOR EACH ROW EXECUTE FUNCTION session_retention_commit_failure()")
		cleanup = append(cleanup, "DROP TRIGGER IF EXISTS session_retention_commit_failure ON "+table, "DROP FUNCTION IF EXISTS session_retention_commit_failure()")
	} else {
		statements = append(statements, "CREATE TRIGGER session_retention_commit_failure AFTER UPDATE OF "+column+" ON "+table+" BEGIN INSERT INTO session_retention_commit_child(parent_id) VALUES(1); END")
		cleanup = append(cleanup, "DROP TRIGGER IF EXISTS session_retention_commit_failure")
	}
	cleanup = append(cleanup, "DROP TABLE IF EXISTS session_retention_commit_child", "DROP TABLE IF EXISTS session_retention_commit_parent")
	for _, s := range statements {
		if _, err := a.store.DB.Exec(s); err != nil {
			t.Fatal(err)
		}
	}
	remove := func() {
		for _, s := range cleanup {
			if _, err := a.store.DB.Exec(s); err != nil {
				t.Errorf("remove owned failure fixture: %v", err)
			}
		}
	}
	t.Cleanup(remove)
	return remove
}
func TestSessionRetentionPolicyCommitFailure(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			a, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			password := "an owner commit password"
			owner.ok("POST", "/setup", map[string]any{"siteName": "Policy commit failure", "mode": ModePrivateMulti, "username": "owner", "displayName": "Owner", "password": password, "seedDemo": false, "sessionMode": sessionRemember, "rememberDays": 30})
			owner.bootstrap()
			policy := owner.ok("GET", "/settings/session-policy", nil)
			policy = owner.ok("PUT", "/settings/session-policy", retentionTestPolicyBody(policy, 90, true))
			owner.bootstrap()
			peer := newCoreBrowser(t, server.URL)
			peer.bootstrap()
			peer.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": password, "sessionMode": sessionRemember, "rememberDays": 90})
			peer.bootstrap()
			peerBefore := retentionTestRecord(t, a, peer.client, server.URL)
			owner.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": password, "sessionMode": sessionUntilLogout})
			owner.bootstrap()
			raw := retentionTestRawToken(t, owner.client, server.URL)
			before := retentionTestRecord(t, a, owner.client, server.URL)
			remove := installSessionRetentionCommitFailure(t, a, provider, "policy")
			reply := accountProfileRawCall(t, owner.client, server.URL, "PUT", "/settings/session-policy", retentionTestPolicyBody(policy, 7, false), owner.csrf, "")
			if reply.status != http.StatusInternalServerError || len(reply.headers.Values("Set-Cookie")) != 0 {
				t.Fatalf("Failed policy cookie/status %d", reply.status)
			}
			if retentionTestRawToken(t, owner.client, server.URL) != raw {
				t.Fatal("Failed policy removed caller cookie")
			}
			retentionTestSummary(t, owner.bootstrap(), sessionUntilLogout, 0)
			actual := owner.ok("GET", "/settings/session-policy", nil)
			if actual["policyVersion"] != policy["policyVersion"] || actual["maxIdleDays"] != policy["maxIdleDays"] || actual["allowUntilLogout"] != true {
				t.Fatal("Failed policy mutated settings")
			}
			after := retentionTestRecord(t, a, owner.client, server.URL)
			peerAfter := retentionTestRecord(t, a, peer.client, server.URL)
			if after.Mode != sessionUntilLogout || !after.ExpiresAt.Equal(before.ExpiresAt) || peerAfter.IdleDays != 90 || !peerAfter.ExpiresAt.Equal(peerBefore.ExpiresAt) {
				t.Fatal("Failed policy deleted/shortened sessions")
			}
			var n int
			if err := a.store.DB.QueryRow("SELECT count(*) FROM session_retention_commit_child").Scan(&n); err != nil || n != 0 {
				t.Fatalf("Rollback probe %d %v", n, err)
			}
			remove()
			success := accountProfileRawCall(t, owner.client, server.URL, "PUT", "/settings/session-policy", retentionTestPolicyBody(policy, 7, false), owner.csrf, "")
			if success.status != 200 || retentionTestCookie(t, success.headers).MaxAge >= 0 || owner.bootstrap()["user"] != nil {
				t.Fatal("Successful policy did not revoke current until")
			}
			retentionTestSummary(t, peer.bootstrap(), sessionRemember, 7)
		})
	}
}
func TestSessionRetentionRenewCommitFailure(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			a, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Renew rollback", "mode": ModePrivateMulti, "username": "owner", "displayName": "Owner", "password": "a renewal test password", "seedDemo": false, "sessionMode": sessionRemember, "rememberDays": 30})
			owner.bootstrap()
			record := retentionTestRecord(t, a, owner.client, server.URL)
			activity := sessionNow().Add(-20 * time.Minute)
			retentionTestSetTimes(t, a, record.TokenHash, activity, activity, activity.Add(30*24*time.Hour))
			before := retentionTestRecord(t, a, owner.client, server.URL)
			raw := retentionTestRawToken(t, owner.client, server.URL)
			remove := installSessionRetentionCommitFailure(t, a, provider, "renew")
			reply := accountProfileRawCall(t, owner.client, server.URL, "POST", "/auth/renew", map[string]any{}, owner.csrf, "")
			if reply.status != 500 || len(reply.headers.Values("Set-Cookie")) != 0 || retentionTestRawToken(t, owner.client, server.URL) != raw {
				t.Fatal("Failed renew changed cookie")
			}
			retentionTestSummary(t, owner.bootstrap(), sessionRemember, 30)
			after := retentionTestRecord(t, a, owner.client, server.URL)
			if !after.ExpiresAt.Equal(before.ExpiresAt) || !after.LastInteractiveAt.Equal(before.LastInteractiveAt) || !after.RenewedAt.Equal(before.RenewedAt) {
				t.Fatal("Failed renew changed DB deadlines")
			}
			var n int
			if err := a.store.DB.QueryRow("SELECT count(*) FROM session_retention_commit_child").Scan(&n); err != nil || n != 0 {
				t.Fatalf("Rollback probe %d %v", n, err)
			}
			remove()
			success := accountProfileRawCall(t, owner.client, server.URL, "POST", "/auth/renew", map[string]any{}, owner.csrf, "")
			if success.status != 200 || retentionTestCookie(t, success.headers).MaxAge != 30*24*60*60 {
				t.Fatal("Renew did not recover")
			}
			after = retentionTestRecord(t, a, owner.client, server.URL)
			if !after.ExpiresAt.After(before.ExpiresAt) || !after.RenewedAt.After(before.RenewedAt) {
				t.Fatal("Renew retry not stored")
			}
		})
	}
}
