package home

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func avatarTestImage(t *testing.T, size int, shade color.NRGBA, asJPEG bool) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, size, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < size; x++ {
			img.SetNRGBA(x, y, shade)
		}
	}
	var body bytes.Buffer
	var err error
	if asJPEG {
		err = jpeg.Encode(&body, img, nil)
	} else {
		err = png.Encode(&body, img)
	}
	if err != nil {
		t.Fatal(err)
	}
	return body.Bytes()
}

func avatarTestRead(t *testing.T, client *http.Client, base, path, etag, bearer string) (int, http.Header, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, base+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, response.Header.Clone(), body
}

func TestAccountAvatarHTTP(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			password := "avatar fixture password"
			owner.ok("POST", "/setup", map[string]any{"siteName": "Avatar fixture", "mode": ModePrivateMulti, "username": "owner", "displayName": "Owner", "password": password, "seedDemo": false})
			initial := owner.bootstrap()
			initialUser := initial["user"].(map[string]any)
			if initialUser["avatarUrl"] != "" || initialUser["avatarDigest"] != "" {
				t.Fatal("default avatar fields must be explicit empty strings")
			}
			userID := accountProfileUserID(initial)
			original := readAccountProfileState(t, app, userID)
			picture := avatarTestImage(t, 4, color.NRGBA{R: 20, G: 140, B: 110, A: 255}, false)
			request := func(expected string, content []byte) map[string]any {
				return map[string]any{"expectedAvatar": expected, "mediaType": "image/png", "dataBase64": base64.StdEncoding.EncodeToString(content)}
			}
			token := owner.ok("POST", "/integrations/tokens", map[string]any{"name": "avatar fixture", "spaceId": coreSpace(initial, "personal"), "actions": []string{"navigation:read"}, "expiresAt": time.Now().UTC().Add(time.Hour)})["token"].(string)
			bearerClient := &http.Client{Timeout: 15 * time.Second}
			anonymous := newCoreBrowser(t, server.URL)
			anonymous.bootstrap()
			for _, method := range []string{"PUT", "DELETE"} {
				var body any = request("", picture)
				if method == "DELETE" {
					body = map[string]any{"expectedAvatar": ""}
				}
				status, _ := anonymous.call(method, "/account/avatar", body)
				if status != 401 && status != 403 {
					t.Fatalf("anonymous %s returned %d", method, status)
				}
				if got := accountProfileRawCall(t, owner.client, server.URL, method, "/account/avatar", body, "", ""); got.status != 403 {
					t.Fatalf("missing CSRF %s returned %d", method, got.status)
				}
				if got := accountProfileRawCall(t, bearerClient, server.URL, method, "/account/avatar", body, "", token); got.status != 403 {
					t.Fatalf("PAT %s returned %d", method, got.status)
				}
			}
			saved := owner.ok("PUT", "/account/avatar", request("", picture))
			digest, ok := saved["avatarDigest"].(string)
			if !ok || !iconDigestPattern.MatchString(digest) || saved["avatarUrl"] != accountAvatarURL(digest) || saved["id"] != userID {
				t.Fatal("invalid avatar user response")
			}
			requireAccountProfileNoPrivateFields(t, saved)
			requireAccountProfileUnchanged(t, original, readAccountProfileState(t, app, userID))
			requireSaved := func() {
				t.Helper()
				boot := owner.bootstrap()["user"].(map[string]any)
				if boot["avatarDigest"] != digest || boot["avatarUrl"] != accountAvatarURL(digest) {
					t.Fatal("saved avatar not retained by bootstrap")
				}
				status, headers, body := avatarTestRead(t, owner.client, server.URL, accountAvatarURL(digest), "", "")
				if status != 200 || headers.Get("Content-Type") != "image/png" || headers.Get("Cache-Control") != "private, no-cache" || headers.Get("Vary") != "Cookie, Authorization" {
					t.Fatalf("unsafe avatar response %d", status)
				}
				sum := sha256.Sum256(body)
				if hex.EncodeToString(sum[:]) != digest {
					t.Fatal("avatar bytes and digest disagree")
				}
				if _, err := png.Decode(bytes.NewReader(body)); err != nil {
					t.Fatal("avatar is not normalized PNG")
				}
			}
			requireSaved()
			etag := `"` + digest + `"`
			if status, _, body := avatarTestRead(t, owner.client, server.URL, accountAvatarURL(digest), etag, ""); status != 304 || len(body) != 0 {
				t.Fatal("conditional private avatar read failed")
			}
			if status, _, _ := avatarTestRead(t, anonymous.client, server.URL, accountAvatarURL(digest), etag, ""); status != 401 && status != 403 {
				t.Fatal("anonymous conditional read exposed avatar")
			}
			if status, _, _ := avatarTestRead(t, bearerClient, server.URL, accountAvatarURL(digest), etag, token); status != 403 {
				t.Fatal("PAT read exposed avatar")
			}
			owner.ok("POST", "/admin/users", map[string]any{"username": "member", "displayName": "Member", "password": password})
			member := newCoreBrowser(t, server.URL)
			member.bootstrap()
			member.ok("POST", "/auth/login", map[string]any{"username": "member", "password": password})
			member.bootstrap()
			if status, _, _ := avatarTestRead(t, member.client, server.URL, accountAvatarURL(digest), etag, ""); status != 404 {
				t.Fatal("another user read the owner's avatar")
			}
			foreign := request("", picture)
			foreign["userId"] = userID
			if status, _ := member.call("PUT", "/account/avatar", foreign); status != 400 {
				t.Fatal("foreign account parameter accepted")
			}
			requireSaved()
			for name, body := range map[string]map[string]any{
				"missing_baseline": {"mediaType": "image/png", "dataBase64": base64.StdEncoding.EncodeToString(picture)},
				"invalid_base64":   {"expectedAvatar": digest, "mediaType": "image/png", "dataBase64": "data:image/png;base64,abc"},
				"mime_mismatch":    {"expectedAvatar": digest, "mediaType": "image/jpeg", "dataBase64": base64.StdEncoding.EncodeToString(picture)},
				"svg":              {"expectedAvatar": digest, "mediaType": "image/svg+xml", "dataBase64": base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`))},
				"corrupt":          request(digest, []byte("not an image")),
				"dimensions":       request(digest, avatarTestImage(t, 513, color.NRGBA{A: 255}, false)),
				"oversize":         {"expectedAvatar": digest, "mediaType": "image/png", "dataBase64": strings.Repeat("A", base64.StdEncoding.EncodedLen(iconMaxBytes)+4)},
			} {
				if status, _ := owner.call("PUT", "/account/avatar", body); status != 400 {
					t.Fatalf("invalid upload %s returned %d", name, status)
				}
				requireSaved()
			}
			for _, method := range []string{"PUT", "DELETE"} {
				var body any = request("", picture)
				if method == "DELETE" {
					body = map[string]any{"expectedAvatar": ""}
				}
				status, result := owner.call(method, "/account/avatar", body)
				if status != 409 || result["code"] != "avatar_version_conflict" {
					t.Fatalf("stale %s was not rejected", method)
				}
			}
			// The HTTP transaction must keep the old image on an actual storage failure.
			cleanup := installAvatarUpdateFailure(t, app, provider)
			nextPicture := avatarTestImage(t, 4, color.NRGBA{R: 200, G: 80, B: 60, A: 255}, false)
			if status, _ := owner.call("PUT", "/account/avatar", request(digest, nextPicture)); status != 500 {
				t.Fatal("storage failure did not reach the client")
			}
			requireSaved()
			cleanup()
			jpegBody := request(digest, avatarTestImage(t, 4, color.NRGBA{R: 200, G: 80, B: 60, A: 255}, true))
			jpegBody["mediaType"] = "image/jpeg"
			updated := owner.ok("PUT", "/account/avatar", jpegBody)
			oldURL := accountAvatarURL(digest)
			digest = updated["avatarDigest"].(string)
			requireSaved()
			if status, _, _ := avatarTestRead(t, owner.client, server.URL, oldURL, etag, ""); status != 404 {
				t.Fatal("replaced avatar still readable")
			}

			// Exercise two actual sessions racing from the same baseline on both stores.
			peer := newCoreBrowser(t, server.URL)
			peer.bootstrap()
			peer.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": password})
			peer.bootstrap()
			type outcome struct {
				status int
				body   map[string]any
			}
			start := make(chan struct{})
			results := make(chan outcome, 2)
			for i, browser := range []*coreBrowser{owner, peer} {
				payload := request(digest, avatarTestImage(t, 4, color.NRGBA{R: uint8(60 + i*90), G: uint8(50 + i*40), B: 220, A: 255}, false))
				go func(client *coreBrowser, body map[string]any) {
					<-start
					status, result := client.call("PUT", "/account/avatar", body)
					results <- outcome{status, result}
				}(browser, payload)
			}
			close(start)
			successes, conflicts := 0, 0
			for i := 0; i < 2; i++ {
				result := <-results
				switch result.status {
				case 200:
					successes++
					digest = result.body["avatarDigest"].(string)
				case 409:
					if result.body["code"] != "avatar_version_conflict" {
						t.Fatal("wrong concurrent conflict")
					}
					conflicts++
				default:
					t.Fatalf("concurrent avatar write returned %d", result.status)
				}
			}
			if successes != 1 || conflicts != 1 {
				t.Fatalf("concurrent writes: %d successes and %d conflicts", successes, conflicts)
			}
			requireSaved()
			removed := owner.ok("DELETE", "/account/avatar", map[string]any{"expectedAvatar": digest})
			if removed["avatarDigest"] != "" || removed["avatarUrl"] != "" {
				t.Fatal("delete did not restore the default avatar")
			}
			if status, _, _ := avatarTestRead(t, owner.client, server.URL, accountAvatarURL(digest), "", ""); status != 404 {
				t.Fatal("deleted avatar still readable")
			}
			owner.ok("DELETE", "/account/avatar", map[string]any{"expectedAvatar": ""})
			var count int
			if err := app.store.DB.QueryRow("SELECT COUNT(*) FROM account_avatars").Scan(&count); err != nil || count != 0 {
				t.Fatal("avatar rows remained after reset", err)
			}
		})
	}
}

func installAvatarUpdateFailure(t *testing.T, app *App, provider string) func() {
	t.Helper()
	statements := []string{"CREATE TRIGGER avatar_test_fail_update BEFORE UPDATE ON account_avatars BEGIN SELECT RAISE(ABORT, 'avatar test failure'); END"}
	cleanup := []string{"DROP TRIGGER IF EXISTS avatar_test_fail_update"}
	if provider == "postgres" {
		statements = []string{"CREATE FUNCTION avatar_test_fail_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'avatar test failure'; END $$", "CREATE TRIGGER avatar_test_fail_update BEFORE UPDATE ON account_avatars FOR EACH ROW EXECUTE FUNCTION avatar_test_fail_update_fn()"}
		cleanup = []string{"DROP TRIGGER IF EXISTS avatar_test_fail_update ON account_avatars", "DROP FUNCTION IF EXISTS avatar_test_fail_update_fn()"}
	}
	for _, statement := range statements {
		if _, err := app.store.DB.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	removed := false
	remove := func() {
		if removed {
			return
		}
		removed = true
		for _, statement := range cleanup {
			if _, err := app.store.DB.Exec(statement); err != nil {
				t.Error(err)
			}
		}
	}
	t.Cleanup(remove)
	return remove
}

func TestAccountAvatarMigrationPreservesAndRollsBack(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, rollback := range []bool{false, true} {
			t.Run(fmt.Sprintf("postgres-%v/rollback-%v", postgres, rollback), func(t *testing.T) {
				db, store := documentMigrationDB(t, postgres)
				seedSessionUpgrade(t, db, store, 9, false, nil)
				for _, name := range []string{"010_session_retention.sql", "011_link_clicks.sql", "012_work_board.sql"} {
					body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/" + name)
					if err != nil {
						t.Fatal(err)
					}
					if _, err = db.Exec(string(body)); err != nil {
						t.Fatal(err)
					}
				}
				before := sessionUpgradeDatabaseState(t, db, store.Provider)
				body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/013_account_avatar.sql")
				if err != nil {
					t.Fatal(err)
				}
				tx, err := db.BeginTx(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				statement := string(body)
				if rollback {
					statement += "\nSELECT intentional_avatar_migration_failure();"
				}
				_, err = tx.Exec(statement)
				if rollback {
					if err == nil {
						tx.Rollback()
						t.Fatal("failure injection succeeded")
					}
					if err = tx.Rollback(); err != nil {
						t.Fatal(err)
					}
				} else {
					if err != nil {
						tx.Rollback()
						t.Fatal(err)
					}
					if err = tx.Commit(); err != nil {
						t.Fatal(err)
					}
				}
				for table, original := range before {
					if !reflect.DeepEqual(original, componentCaptureRows(t, db, table, original.columns)) {
						t.Fatalf("migration changed original %s", table)
					}
				}
				var count int
				err = db.QueryRow("SELECT COUNT(*) FROM account_avatars").Scan(&count)
				if rollback {
					if err == nil {
						t.Fatal("failed migration left the avatar table")
					}
				} else if err != nil || count != 0 {
					t.Fatal("new avatar table is not empty", err)
				}
			})
		}
	}
}
