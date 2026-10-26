package home

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"
)

func retentionTestCookie(t *testing.T, h http.Header) *http.Cookie {
	t.Helper()
	for _, c := range (&http.Response{Header: h}).Cookies() {
		if c.Name == sessionCookie {
			return c
		}
	}
	t.Fatal("session Set-Cookie missing")
	return nil
}
func retentionTestRawToken(t *testing.T, client *http.Client, base string) string {
	t.Helper()
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range client.Jar.Cookies(u) {
		if c.Name == sessionCookie {
			return c.Value
		}
	}
	t.Fatal("session Cookie missing")
	return ""
}
func retentionTestRecord(t *testing.T, a *App, c *http.Client, base string) *SessionRecord {
	t.Helper()
	r, err := a.readSessionRecord(context.Background(), a.store.DB, tokenHash(retentionTestRawToken(t, c, base)))
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func retentionTestSummary(t *testing.T, boot map[string]any, mode string, days int) {
	t.Helper()
	s, ok := boot["session"].(map[string]any)
	if !ok {
		t.Fatal("session summary missing")
	}
	if s["mode"] != mode {
		t.Fatalf("mode %v wanted %s", s["mode"], mode)
	}
	if days > 0 && fmt.Sprint(s["idleDays"]) != fmt.Sprint(days) {
		t.Fatalf("idleDays %v wanted %d", s["idleDays"], days)
	}
}
func retentionTestSetTimes(t *testing.T, a *App, hash string, activity, renewed, expiry time.Time) {
	t.Helper()
	_, err := a.store.DB.Exec(a.store.Query("UPDATE sessions SET last_interactive_at=?,renewed_at=?,expires_at=? WHERE token_hash=?"), sessionTimeString(activity), sessionTimeString(renewed), sessionTimeString(expiry), hash)
	if err != nil {
		t.Fatal(err)
	}
}
func retentionTestPolicyBody(current map[string]any, maxDays int, until bool) map[string]any {
	days := 30
	if maxDays < days {
		days = maxDays
	}
	return map[string]any{"defaultMode": sessionRemember, "defaultIdleDays": days, "maxIdleDays": maxDays, "allowUntilLogout": until, "expectedVersion": current["policyVersion"]}
}
func TestSessionRetentionHTTPMatrix(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			password := "a valid test password"
			setup := accountProfileRawCall(t, owner.client, server.URL, "POST", "/setup", map[string]any{"siteName": "Session retention", "mode": ModePrivateMulti, "username": "owner", "displayName": "Owner", "password": password, "seedDemo": false}, owner.csrf, "")
			if setup.status != 201 {
				t.Fatalf("setup HTTP %d", setup.status)
			}
			temporaryCookie := retentionTestCookie(t, setup.headers)
			if !temporaryCookie.Expires.IsZero() || temporaryCookie.MaxAge != 0 || !temporaryCookie.HttpOnly || temporaryCookie.SameSite != http.SameSiteLaxMode {
				t.Fatal("Legacy cookie persistence/security changed")
			}
			retentionTestSummary(t, owner.bootstrap(), sessionTemporary, 0)
			original := retentionTestRecord(t, app, owner.client, server.URL)
			if left := time.Until(original.ExpiresAt); left < 12*time.Hour-10*time.Second || left > 12*time.Hour+time.Second {
				t.Fatalf("Legacy expiry %s", left)
			}
			options := owner.bootstrap()["sessionOptions"].(map[string]any)
			if options["defaultMode"] != sessionRemember || fmt.Sprint(options["maxIdleDays"]) != "30" || options["allowUntilLogout"] != false {
				t.Fatal("New UI defaults incorrect")
			}
			legacyRaw := randomToken()
			legacyExpiry := sessionNow().Add(time.Hour)
			_, err := app.store.DB.Exec(app.store.Query("INSERT INTO sessions(token_hash,user_id,auth_epoch,user_version,expires_at) VALUES(?,?,?,?,?)"), tokenHash(legacyRaw), original.UserID, original.AuthEpoch, original.UserVersion, sessionTimeString(legacyExpiry))
			if err != nil {
				t.Fatal(err)
			}
			legacy := newCoreBrowser(t, server.URL)
			target, _ := url.Parse(server.URL)
			legacy.client.Jar.SetCookies(target, []*http.Cookie{{Name: sessionCookie, Value: legacyRaw, Path: "/"}})
			retentionTestSummary(t, legacy.bootstrap(), sessionTemporary, 0)
			migrated := retentionTestRecord(t, app, legacy.client, server.URL)
			if !migrated.ExpiresAt.Equal(legacyExpiry) || !migrated.CreatedAt.IsZero() || !migrated.LastInteractiveAt.IsZero() {
				t.Fatal("Legacy metadata invented")
			}
			owner.bootstrap()
			beforeToken := retentionTestRawToken(t, owner.client, server.URL)
			rejected := accountProfileRawCall(t, owner.client, server.URL, "POST", "/auth/login", map[string]any{"username": "owner", "password": password, "sessionMode": sessionRemember, "rememberDays": 90}, owner.csrf, "")
			if rejected.status != 400 {
				t.Fatalf("Over-limit login %d", rejected.status)
			}
			if retentionTestRawToken(t, owner.client, server.URL) != beforeToken || owner.bootstrap()["user"] == nil {
				t.Fatal("Rejected login ended valid session")
			}
			remembered := accountProfileRawCall(t, owner.client, server.URL, "POST", "/auth/login", map[string]any{"username": "owner", "password": password, "sessionMode": sessionRemember, "rememberDays": 30}, owner.csrf, "")
			if remembered.status != 200 {
				t.Fatalf("Remember HTTP %d", remembered.status)
			}
			cookie := retentionTestCookie(t, remembered.headers)
			if cookie.Expires.IsZero() || cookie.MaxAge != 30*24*60*60 || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Secure {
				t.Fatal("Remember cookie incorrect")
			}
			retentionTestSummary(t, owner.bootstrap(), sessionRemember, 30)
			record := retentionTestRecord(t, app, owner.client, server.URL)
			rawBeforeRenew := retentionTestRawToken(t, owner.client, server.URL)
			oldActivity := sessionNow().Add(-20 * time.Minute)
			retentionTestSetTimes(t, app, record.TokenHash, oldActivity, oldActivity, oldActivity.Add(30*24*time.Hour))
			renewed := accountProfileRawCall(t, owner.client, server.URL, "POST", "/auth/renew", map[string]any{}, owner.csrf, "")
			if renewed.status != 200 {
				t.Fatalf("Renew %d", renewed.status)
			}
			if retentionTestRawToken(t, owner.client, server.URL) != rawBeforeRenew {
				t.Fatal("Renew rotated token")
			}
			if retentionTestCookie(t, renewed.headers).MaxAge != 30*24*60*60 {
				t.Fatal("Renew Cookie not persistent")
			}
			afterRenew := retentionTestRecord(t, app, owner.client, server.URL)
			if !afterRenew.LastInteractiveAt.After(oldActivity) || time.Until(afterRenew.ExpiresAt) < 30*24*time.Hour-10*time.Second {
				t.Fatal("Renew did not advance expiry")
			}
			throttled := accountProfileRawCall(t, owner.client, server.URL, "POST", "/auth/renew", map[string]any{}, owner.csrf, "")
			if throttled.status != 200 || len(throttled.headers.Values("Set-Cookie")) != 0 {
				t.Fatal("Throttle wrote cookie")
			}
			after := retentionTestRecord(t, app, owner.client, server.URL)
			if !after.RenewedAt.Equal(afterRenew.RenewedAt) || !after.ExpiresAt.Equal(afterRenew.ExpiresAt) {
				t.Fatal("Throttle wrote DB")
			}
			badCSRF := accountProfileRawCall(t, owner.client, server.URL, "POST", "/auth/renew", map[string]any{}, "invalid-csrf", "")
			if badCSRF.status != 403 || owner.bootstrap()["user"] == nil {
				t.Fatal("Invalid CSRF renew not rejected safely")
			}
			policy := owner.ok("GET", "/settings/session-policy", nil)
			oldPolicy := policy
			policy = owner.ok("PUT", "/settings/session-policy", retentionTestPolicyBody(policy, 90, true))
			stale := accountProfileRawCall(t, owner.client, server.URL, "PUT", "/settings/session-policy", retentionTestPolicyBody(oldPolicy, 7, false), owner.csrf, "")
			if stale.status != 409 {
				t.Fatalf("Stale policy %d", stale.status)
			}
			longBrowser := newCoreBrowser(t, server.URL)
			longBrowser.bootstrap()
			longBrowser.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": password, "sessionMode": sessionRemember, "rememberDays": 90})
			longBrowser.bootstrap()
			longRecord := retentionTestRecord(t, app, longBrowser.client, server.URL)
			twoDaysAgo := sessionNow().Add(-2 * 24 * time.Hour)
			retentionTestSetTimes(t, app, longRecord.TokenHash, twoDaysAgo, twoDaysAgo, twoDaysAgo.Add(90*24*time.Hour))
			permanent := newCoreBrowser(t, server.URL)
			permanent.bootstrap()
			until := accountProfileRawCall(t, permanent.client, server.URL, "POST", "/auth/login", map[string]any{"username": "owner", "password": password, "sessionMode": sessionUntilLogout}, permanent.csrf, "")
			if until.status != 200 {
				t.Fatalf("Until %d", until.status)
			}
			untilCookie := retentionTestCookie(t, until.headers)
			if untilCookie.MaxAge != 365*24*60*60 || untilCookie.Expires.Year() >= 9999 {
				t.Fatal("Database sentinel exposed")
			}
			untilRaw := retentionTestRawToken(t, permanent.client, server.URL)
			untilBoot := permanent.bootstrap()
			retentionTestSummary(t, untilBoot, sessionUntilLogout, 0)
			if _, exists := untilBoot["session"].(map[string]any)["expiresAt"]; exists {
				t.Fatal("Until reported fake expiry")
			}
			policy = owner.ok("PUT", "/settings/session-policy", retentionTestPolicyBody(policy, 7, false))
			owner.bootstrap()
			constrained, err := app.readSessionRecord(context.Background(), app.store.DB, longRecord.TokenHash)
			if err != nil {
				t.Fatal(err)
			}
			if constrained.IdleDays != 7 || !constrained.ExpiresAt.Equal(twoDaysAgo.Add(7*24*time.Hour)) {
				t.Fatal("Policy failed to persist clamp")
			}
			if permanent.bootstrap()["user"] != nil {
				t.Fatal("Until not revoked")
			}
			policy = owner.ok("PUT", "/settings/session-policy", retentionTestPolicyBody(policy, 90, true))
			owner.bootstrap()
			constrained, err = app.readSessionRecord(context.Background(), app.store.DB, longRecord.TokenHash)
			if err != nil {
				t.Fatal(err)
			}
			if constrained.IdleDays != 7 || !constrained.ExpiresAt.Equal(twoDaysAgo.Add(7*24*time.Hour)) {
				t.Fatal("Relaxed policy upgraded old session")
			}
			permanent.client.Jar.SetCookies(target, []*http.Cookie{{Name: sessionCookie, Value: untilRaw, Path: "/"}})
			if permanent.bootstrap()["user"] != nil {
				t.Fatal("Relaxed policy revived until")
			}
			longBrowser.bootstrap()
			longBrowser.ok("POST", "/auth/renew", map[string]any{})
			constrained = retentionTestRecord(t, app, longBrowser.client, server.URL)
			if constrained.IdleDays != 7 || time.Until(constrained.ExpiresAt) > 7*24*time.Hour+time.Second {
				t.Fatal("Renew restored old90-day choice")
			}
			permanent.bootstrap()
			permanent.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": password, "sessionMode": sessionUntilLogout})
			permanent.bootstrap()
			listed := owner.ok("GET", "/account/sessions", nil)["sessions"].([]any)
			if len(listed) < 3 || listed[0].(map[string]any)["current"] != true {
				t.Fatal("Missing current/others")
			}
			var untilID string
			for _, value := range listed {
				row := value.(map[string]any)
				for _, key := range []string{"token", "tokenHash", "TokenHash", "sessionToken", "authEpoch", "userVersion"} {
					if _, ok := row[key]; ok {
						t.Fatal("Private session field exposed")
					}
				}
				if row["id"] == rawBeforeRenew || row["id"] == record.TokenHash {
					t.Fatal("Public id is credential")
				}
				if row["mode"] == sessionUntilLogout {
					untilID = row["id"].(string)
				}
			}
			if untilID == "" {
				t.Fatal("Until missing")
			}
			revoked := owner.ok("POST", "/account/sessions/revoke", map[string]any{"id": untilID})
			if revoked["current"] != false || permanent.bootstrap()["user"] != nil || owner.bootstrap()["user"] == nil {
				t.Fatal("Other revoke not isolated")
			}
			longBrowser.bootstrap()
			expiredAt := sessionNow().Add(-time.Second)
			retentionTestSetTimes(t, app, longRecord.TokenHash, sessionNow().Add(-8*24*time.Hour), sessionNow().Add(-8*24*time.Hour), expiredAt)
			expired := accountProfileRawCall(t, longBrowser.client, server.URL, "POST", "/auth/renew", map[string]any{}, longBrowser.csrf, "")
			if expired.status != 401 && expired.status != 403 {
				t.Fatalf("Expired renew %d", expired.status)
			}
			dead, err := app.readSessionRecord(context.Background(), app.store.DB, longRecord.TokenHash)
			if err != nil {
				t.Fatal(err)
			}
			if !dead.ExpiresAt.Equal(expiredAt) || longBrowser.bootstrap()["user"] != nil {
				t.Fatal("Expired revived")
			}
			owner.bootstrap()
			previousToken := retentionTestRawToken(t, owner.client, server.URL)
			nextPassword := " a rotated remember password "
			changed := accountProfileRawCall(t, owner.client, server.URL, "PUT", "/account/password", map[string]any{"currentPassword": password, "newPassword": nextPassword}, owner.csrf, "")
			if changed.status != 200 || retentionTestCookie(t, changed.headers).MaxAge != 7*24*60*60 {
				t.Fatal("Password rotation lost remembered choice")
			}
			retentionTestSummary(t, owner.bootstrap(), sessionRemember, 7)
			if retentionTestRawToken(t, owner.client, server.URL) == previousToken || legacy.bootstrap()["user"] != nil {
				t.Fatal("Password rotation did not revoke old tokens")
			}
			peer := newCoreBrowser(t, server.URL)
			peer.bootstrap()
			peer.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": nextPassword, "sessionMode": sessionRemember, "rememberDays": 7})
			peer.bootstrap()
			owner.ok("POST", "/account/sessions/revoke-others", map[string]any{})
			if peer.bootstrap()["user"] != nil {
				t.Fatal("Others still authenticated")
			}
			retentionTestSummary(t, owner.bootstrap(), sessionRemember, 7)
			ownList := owner.ok("GET", "/account/sessions", nil)["sessions"].([]any)
			if len(ownList) != 1 || ownList[0].(map[string]any)["current"] != true {
				t.Fatal("Own session not preserved")
			}
			ownID := ownList[0].(map[string]any)["id"].(string)
			self := accountProfileRawCall(t, owner.client, server.URL, "POST", "/account/sessions/revoke", map[string]any{"id": ownID}, owner.csrf, "")
			if self.status != 200 || self.body["current"] != true || retentionTestCookie(t, self.headers).MaxAge >= 0 || owner.bootstrap()["user"] != nil {
				t.Fatal("Current revoke failed")
			}
		})
	}
}
func TestSessionRetentionAuthorization(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Session authorization", "mode": ModePrivateMulti, "username": "owner", "displayName": "Owner", "password": "an owner password", "seedDemo": false, "sessionMode": sessionRemember, "rememberDays": 30})
			boot := owner.bootstrap()
			retentionTestSummary(t, boot, sessionRemember, 30)
			policy := owner.ok("GET", "/settings/session-policy", nil)
			owner.ok("POST", "/admin/users", map[string]any{"username": "member", "displayName": "Member", "password": "a member password"})
			member := newCoreBrowser(t, server.URL)
			member.bootstrap()
			member.ok("POST", "/auth/login", map[string]any{"username": "member", "password": "a member password", "sessionMode": sessionRemember, "rememberDays": 7})
			member.bootstrap()
			memberRecord := retentionTestRecord(t, app, member.client, server.URL)
			for _, method := range []string{"GET", "PUT"} {
				var body any
				if method == "PUT" {
					body = retentionTestPolicyBody(policy, 90, true)
				}
				reply := accountProfileRawCall(t, member.client, server.URL, method, "/settings/session-policy", body, member.csrf, "")
				if reply.status != 403 {
					t.Fatalf("Member policy %s %d", method, reply.status)
				}
			}
			ownerList := owner.ok("GET", "/account/sessions", nil)["sessions"].([]any)
			memberList := member.ok("GET", "/account/sessions", nil)["sessions"].([]any)
			if len(ownerList) != 1 || len(memberList) != 1 {
				t.Fatal("Session inventories not isolated")
			}
			ownerID := ownerList[0].(map[string]any)["id"].(string)
			memberID := memberList[0].(map[string]any)["id"].(string)
			if ownerID == memberID {
				t.Fatal("Session id reused")
			}
			if reply := accountProfileRawCall(t, member.client, server.URL, "POST", "/account/sessions/revoke", map[string]any{"id": ownerID}, member.csrf, ""); reply.status != 404 {
				t.Fatalf("Cross revoke %d", reply.status)
			}
			if reply := accountProfileRawCall(t, owner.client, server.URL, "POST", "/account/sessions/revoke", map[string]any{"id": memberID}, owner.csrf, ""); reply.status != 404 {
				t.Fatalf("Owner cross revoke %d", reply.status)
			}
			pat := owner.ok("POST", "/integrations/tokens", map[string]any{"name": "Session auth fixture", "spaceId": coreSpace(boot, "shared"), "actions": []string{"navigation:read", "navigation:write"}, "expiresAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)})["token"].(string)
			for _, tc := range []struct {
				method, path string
				body         any
			}{{"GET", "/settings/session-policy", nil}, {"PUT", "/settings/session-policy", retentionTestPolicyBody(policy, 90, true)}, {"POST", "/auth/renew", map[string]any{}}, {"GET", "/account/sessions", nil}, {"POST", "/account/sessions/revoke", map[string]any{"id": ownerID}}, {"POST", "/account/sessions/revoke-others", map[string]any{}}} {
				reply := accountProfileRawCall(t, owner.client, server.URL, tc.method, tc.path, tc.body, owner.csrf, pat)
				if reply.status != 403 {
					t.Fatalf("PAT %s %s %d", tc.method, tc.path, reply.status)
				}
			}
			anon := newCoreBrowser(t, server.URL)
			anon.bootstrap()
			if reply := accountProfileRawCall(t, anon.client, server.URL, "POST", "/auth/renew", map[string]any{}, anon.csrf, ""); reply.status != 401 {
				t.Fatalf("Anon renew %d", reply.status)
			}
			if reply := accountProfileRawCall(t, owner.client, server.URL, "POST", "/auth/renew", map[string]any{"sessionMode": sessionUntilLogout}, owner.csrf, ""); reply.status != 400 {
				t.Fatalf("Unknown renew fields %d", reply.status)
			}
			if _, err := app.store.DB.Exec(app.store.Query("UPDATE users SET is_enabled=? WHERE id=?"), false, memberRecord.UserID); err != nil {
				t.Fatal(err)
			}
			if member.bootstrap()["user"] != nil {
				t.Fatal("Disabled member retained login")
			}
			retentionTestSummary(t, owner.bootstrap(), sessionRemember, 30)
		})
	}
}

func TestSessionRetentionRegistration(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Registration retention", "mode": ModePrivateMulti, "username": "owner", "displayName": "Owner", "password": "an owner registration password", "seedDemo": false})
			owner.bootstrap()
			if _, err := app.store.DB.Exec(app.store.Query("UPDATE settings SET registration_enabled=? WHERE id=1"), true); err != nil {
				t.Fatal(err)
			}
			for _, choice := range []struct {
				name, mode string
				days       int
			}{{"remember_registration", sessionRemember, 7}, {"temporary_registration", "", 0}} {
				browser := newCoreBrowser(t, server.URL)
				browser.bootstrap()
				body := map[string]any{"username": choice.name, "displayName": "Registration", "password": "a registration test password"}
				if choice.mode != "" {
					body["sessionMode"] = choice.mode
					body["rememberDays"] = choice.days
				}
				reply := accountProfileRawCall(t, browser.client, server.URL, "POST", "/auth/register", body, browser.csrf, "")
				if reply.status < 200 || reply.status >= 300 {
					t.Fatalf("Registration HTTP %d", reply.status)
				}
				cookie := retentionTestCookie(t, reply.headers)
				if choice.mode == sessionRemember {
					if cookie.MaxAge != 7*24*60*60 || cookie.Expires.IsZero() || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
						t.Fatal("Registration persistent cookie mismatch")
					}
					retentionTestSummary(t, browser.bootstrap(), sessionRemember, 7)
				} else {
					if cookie.MaxAge != 0 || !cookie.Expires.IsZero() {
						t.Fatal("Legacy registration became persistent")
					}
					retentionTestSummary(t, browser.bootstrap(), sessionTemporary, 0)
					record := retentionTestRecord(t, app, browser.client, server.URL)
					remaining := time.Until(record.ExpiresAt)
					if remaining < 12*time.Hour-10*time.Second || remaining > 12*time.Hour+time.Second {
						t.Fatal("Legacy registration lifetime changed")
					}
				}
			}
			browser := newCoreBrowser(t, server.URL)
			browser.bootstrap()
			var before int
			if err := app.store.DB.QueryRow("SELECT count(*) FROM users").Scan(&before); err != nil {
				t.Fatal(err)
			}
			body := map[string]any{"username": "rejected_registration", "displayName": "Rejected", "password": "a rejected registration password", "sessionMode": sessionRemember, "rememberDays": 90}
			reply := accountProfileRawCall(t, browser.client, server.URL, "POST", "/auth/register", body, browser.csrf, "")
			if reply.status != 400 {
				t.Fatalf("Invalid registration HTTP %d", reply.status)
			}
			for _, cookie := range (&http.Response{Header: reply.headers}).Cookies() {
				if cookie.Name == sessionCookie {
					t.Fatal("Rejected registration issued a session cookie")
				}
			}
			var after, matching int
			if err := app.store.DB.QueryRow("SELECT count(*) FROM users").Scan(&after); err != nil {
				t.Fatal(err)
			}
			if err := app.store.DB.QueryRow(app.store.Query("SELECT count(*) FROM users WHERE username=?"), "rejected_registration").Scan(&matching); err != nil {
				t.Fatal(err)
			}
			if after != before || matching != 0 || browser.bootstrap()["user"] != nil {
				t.Fatal("Rejected registration left an account or login")
			}
			body["rememberDays"] = 7
			browser.ok("POST", "/auth/register", body)
			retentionTestSummary(t, browser.bootstrap(), sessionRemember, 7)
		})
	}
}
