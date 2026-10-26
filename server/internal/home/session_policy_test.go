package home

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSessionRetentionChoiceCompatibility(t *testing.T) {
	p := SessionPolicy{DefaultMode: sessionRemember, DefaultIdleDays: 30, MaxIdleDays: 30, PolicyVersion: 1}
	cases := []struct {
		name    string
		choice  SessionChoice
		mode    string
		days    int
		allowed bool
	}{
		{"legacy", SessionChoice{}, sessionTemporary, 0, true}, {"temporary", SessionChoice{SessionMode: sessionTemporary}, sessionTemporary, 0, true}, {"seven", SessionChoice{SessionMode: sessionRemember, RememberDays: 7}, sessionRemember, 7, true}, {"thirty", SessionChoice{SessionMode: sessionRemember, RememberDays: 30}, sessionRemember, 30, true},
		{"over_limit", SessionChoice{SessionMode: sessionRemember, RememberDays: 90}, "", 0, false}, {"unsupported", SessionChoice{SessionMode: sessionRemember, RememberDays: 8}, "", 0, false}, {"negative", SessionChoice{SessionMode: sessionRemember, RememberDays: -7}, "", 0, false}, {"missing", SessionChoice{SessionMode: sessionRemember}, "", 0, false}, {"no_mode", SessionChoice{RememberDays: 7}, "", 0, false}, {"temporary_days", SessionChoice{SessionMode: sessionTemporary, RememberDays: 7}, "", 0, false}, {"until_disabled", SessionChoice{SessionMode: sessionUntilLogout}, "", 0, false}, {"unknown", SessionChoice{SessionMode: "forever"}, "", 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, d, e := resolveSessionChoice(p, c.choice)
			if (e == nil) != c.allowed {
				t.Fatalf("Allowed=%v err=%v", c.allowed, e)
			}
			if c.allowed && (m != c.mode || d != c.days) {
				t.Fatalf("Got %s/%d", m, d)
			}
		})
	}
	p.AllowUntilLogout = true
	p.MaxIdleDays = 90
	if m, d, e := resolveSessionChoice(p, SessionChoice{SessionMode: sessionUntilLogout}); e != nil || m != sessionUntilLogout || d != 0 {
		t.Fatal("Allowed until choice rejected")
	}
	if _, d, e := resolveSessionChoice(p, SessionChoice{SessionMode: sessionRemember, RememberDays: 90}); e != nil || d != 90 {
		t.Fatal("Allowed90 rejected")
	}
}
func TestSessionRetentionDeadlineAndRenewalSummary(t *testing.T) {
	now := time.Date(2026, 10, 25, 9, 0, 0, 0, time.UTC)
	p := SessionPolicy{DefaultMode: sessionRemember, DefaultIdleDays: 30, MaxIdleDays: 30, PolicyVersion: 1}
	r := &SessionRecord{Mode: sessionRemember, IdleDays: 30, LastInteractiveAt: now.Add(-30 * 24 * time.Hour), RenewedAt: now.Add(-30 * 24 * time.Hour), ExpiresAt: now.Add(time.Hour)}
	if usableSession(r, p, now) {
		t.Fatal("Exact idle deadline did not expire")
	}
	r.LastInteractiveAt = r.LastInteractiveAt.Add(time.Microsecond)
	if !usableSession(r, p, now) {
		t.Fatal("Microsecond before deadline rejected")
	}
	r.IdleDays = 90
	r.LastInteractiveAt = now.Add(-8 * 24 * time.Hour)
	r.RenewedAt = r.LastInteractiveAt
	r.ExpiresAt = now.Add(82 * 24 * time.Hour)
	p.MaxIdleDays = 7
	if usableSession(r, p, now) {
		t.Fatal("Policy clamp ignored")
	}
	r.IdleDays = 7
	r.ExpiresAt = r.LastInteractiveAt.Add(7 * 24 * time.Hour)
	p.MaxIdleDays = 90
	if usableSession(r, p, now) {
		t.Fatal("Relax revived expired row")
	}
	r.Mode = sessionUntilLogout
	r.ExpiresAt = untilLogoutDatabaseExpiry
	if usableSession(r, p, now) {
		t.Fatal("Sentinel alone granted until")
	}
	p.AllowUntilLogout = true
	if !usableSession(r, p, now) {
		t.Fatal("Allowed until rejected")
	}
	r.Mode = "unexpected"
	if usableSession(r, p, now) {
		t.Fatal("Unknown stored mode accepted")
	}
	r = &SessionRecord{Mode: sessionRemember, IdleDays: 30, ExpiresAt: now.Add(30 * 24 * time.Hour), LastInteractiveAt: now, RenewedAt: now}
	if sessionSummary(r, p, now.Add(10*time.Minute)).RenewAfterSeconds != 300 || sessionSummary(r, p, now.Add(15*time.Minute)).RenewAfterSeconds != 0 || sessionSummary(r, p, now.Add(899500*time.Millisecond)).RenewAfterSeconds != 1 {
		t.Fatal("Remaining renewal delay incorrect")
	}
	r.Mode = sessionUntilLogout
	s := sessionSummary(r, p, now)
	if s.ExpiresAt != "" || s.IdleDays != 0 {
		t.Fatal("Until exposed deadline")
	}
	r.Mode = sessionTemporary
	if sessionSummary(r, p, now).RenewAfterSeconds != 0 {
		t.Fatal("Temporary offered renew")
	}
	p.MaxIdleDays = 30
	c := sessionChoiceAfterPasswordChange(&SessionRecord{Mode: sessionRemember, IdleDays: 90}, p)
	if c.SessionMode != sessionRemember || c.RememberDays != 30 {
		t.Fatal("Password choice not clamped")
	}
}
func TestSessionRetentionCookieAttributes(t *testing.T) {
	now := time.Date(2026, 10, 25, 9, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		name, scheme, mode string
		secure             bool
		maxAge             int
	}{
		{"temporary_http", "http", sessionTemporary, false, 0}, {"remember_http", "http", sessionRemember, false, 7 * 24 * 60 * 60}, {"remember_https", "https", sessionRemember, false, 7 * 24 * 60 * 60}, {"forced_secure", "http", sessionRemember, true, 7 * 24 * 60 * 60}, {"until_logout", "https", sessionUntilLogout, false, 365 * 24 * 60 * 60},
	} {
		t.Run(c.name, func(t *testing.T) {
			app := &App{}
			app.config.SecureCookies = c.secure
			writer := httptest.NewRecorder()
			request := httptest.NewRequest("POST", c.scheme+"://home.test/api/v1/auth/login", nil)
			expiry := now.Add(7 * 24 * time.Hour)
			if c.mode == sessionUntilLogout {
				expiry = untilLogoutDatabaseExpiry
			}
			app.setRetainedSessionCookie(&Request{HTTP: request, Writer: writer}, "fixture-token", &SessionRecord{Mode: c.mode, ExpiresAt: expiry}, now)
			cookies := writer.Result().Cookies()
			if len(cookies) != 1 {
				t.Fatal("Wrong cookie count")
			}
			cookie := cookies[0]
			if cookie.Name != sessionCookie || cookie.Path != "/" || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Secure != (c.secure || c.scheme == "https") || cookie.MaxAge != c.maxAge {
				t.Fatal("Cookie attributes incorrect")
			}
			if c.mode == sessionTemporary && !cookie.Expires.IsZero() {
				t.Fatal("Temporary became persistent")
			}
			if c.mode != sessionTemporary && cookie.Expires.IsZero() {
				t.Fatal("Persistent missing expiry")
			}
			if c.mode == sessionUntilLogout && cookie.Expires.Year() == 9999 {
				t.Fatal("Sentinel leaked")
			}
		})
	}
}
