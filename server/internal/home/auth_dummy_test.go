package home

import (
	"encoding/base64"
	"strings"
	"testing"
)

// This input and the fixed dummy hash are public verification fixtures. They
// never identify an account or authorize a session.
const dummyPasswordFixture = "Lingshu Home dummy verification only"

func TestDummyPasswordHashPolicyAndVerification(t *testing.T) {
	current, err := hashPassword("current password policy fixture")
	if err != nil {
		t.Fatal(err)
	}
	want, got := strings.Split(current, "$"), strings.Split(dummyPasswordHash, "$")
	if len(want) != 6 || len(got) != 6 || got[0] != "" || got[1] != "argon2id" || got[2] != "v=19" {
		t.Fatal("dummy hash must be a complete Argon2id v19 encoding")
	}
	if strings.Join(got[1:4], "$") != strings.Join(want[1:4], "$") {
		t.Fatal("dummy hash and current password hashes must use the same work parameters")
	}
	salt, err := base64.RawStdEncoding.DecodeString(got[4])
	if err != nil || len(salt) != 16 {
		t.Fatal("dummy hash must have a valid 16-byte salt")
	}
	digest, err := base64.RawStdEncoding.DecodeString(got[5])
	if err != nil || len(digest) != 32 {
		t.Fatal("dummy hash must have a valid 32-byte digest")
	}
	if !verifyPassword(dummyPasswordFixture, dummyPasswordHash) {
		t.Fatal("public dummy fixture must take the complete password verification path")
	}
	if verifyPassword("a different public fixture", dummyPasswordHash) {
		t.Fatal("dummy verification accepted a different input")
	}
}

func TestUnknownAccountWithDummyPasswordIsUnauthorized(t *testing.T) {
	a, server, _ := coreFixture(t, false)
	if a.dummyPassword != dummyPasswordHash {
		t.Fatal("startup must provide the complete fixed dummy hash")
	}
	owner := newCoreBrowser(t, server.URL)
	owner.bootstrap()
	const ownerPassword = "actual owner fixture password"
	owner.ok("POST", "/setup", map[string]any{
		"siteName": "Dummy verification fixture", "mode": ModePrivateMulti,
		"username": "dummy-owner", "displayName": "Owner", "password": ownerPassword,
		"seedDemo": false,
	})
	var sessionsBefore int
	if err := a.store.DB.QueryRow("SELECT COUNT(*) FROM sessions").Scan(&sessionsBefore); err != nil {
		t.Fatal(err)
	}
	visitor := newCoreBrowser(t, server.URL)
	visitor.bootstrap()
	for _, username := range []string{"missing-dummy-user", "dummy-owner"} {
		status, _ := visitor.call("POST", "/auth/login", map[string]any{
			"username": username, "password": dummyPasswordFixture,
		})
		if status != 401 {
			t.Fatalf("dummy input authorized %q: got HTTP %d, want 401", username, status)
		}
		if visitor.bootstrap()["user"] != nil {
			t.Fatal("rejected dummy login authenticated the browser")
		}
		var sessionsAfter int
		if err := a.store.DB.QueryRow("SELECT COUNT(*) FROM sessions").Scan(&sessionsAfter); err != nil {
			t.Fatal(err)
		}
		if sessionsAfter != sessionsBefore {
			t.Fatal("rejected dummy login created a session")
		}
	}
	visitor.ok("POST", "/auth/login", map[string]any{"username": "dummy-owner", "password": ownerPassword})
	user, ok := visitor.bootstrap()["user"].(map[string]any)
	if !ok || user["username"] != "dummy-owner" {
		t.Fatal("a valid real password did not authenticate its account")
	}
}
