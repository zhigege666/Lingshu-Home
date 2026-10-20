package home

import (
	"context"
	"net/http"
	"reflect"
	"testing"
)

func TestPageChromeHTTPRoundTripAndPermissions(t *testing.T) {
	config := coreConfig(t, false)
	app, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.Close() })
	owner := newAppTestBrowser(t, app)
	owner.bootstrap()
	owner.ok("POST", "/setup", map[string]any{"siteName": "Chrome test", "mode": ModePublicRead, "username": "owner", "displayName": "Owner", "password": "a valid test password", "seedDemo": true})
	bootstrap := owner.bootstrap()
	shared := coreSpace(bootstrap, "shared")
	personal := coreSpace(bootstrap, "personal")
	capability := bootstrap["capabilities"].(map[string]any)["pageChrome"].(map[string]any)
	if capability["maxItemsPerSlot"] != float64(8) || !reflect.DeepEqual(capability["itemTypes"], []any{"text", "link", "branding"}) {
		t.Fatalf("wrong chrome capability: %v", capability)
	}
	beforeNavigation := owner.ok("GET", "/spaces/"+shared+"/navigation", nil)
	page := owner.ok("GET", "/dashboard?spaceId="+shared, nil)["page"].(map[string]any)
	draft := cloneConfig(t, page["config"].(map[string]any))
	draft["chrome"] = map[string]any{
		"header": map[string]any{"enabled": true,
			"left":   []any{map[string]any{"id": "welcome", "type": "text", "text": "Welcome\n欢迎来到我的导航"}},
			"center": []any{map[string]any{"id": "documentation", "type": "link", "text": "文档", "url": "https://example.org/docs?q=1#installation"}},
			"right":  []any{map[string]any{"id": "contact", "type": "link", "text": "Contact", "url": "https://example.org/contact", "newTab": false}}},
		"footer": map[string]any{"enabled": true,
			"left":   []any{map[string]any{"id": "copyright", "type": "text", "text": "© 2026 My site"}},
			"center": []any{map[string]any{"id": "notice", "type": "link", "text": "Notice", "url": "https://example.org/notice", "newTab": true}},
			"right":  []any{map[string]any{"id": "home-branding", "type": "branding"}}},
	}
	request := map[string]any{"name": "My composed homepage", "config": draft, "expectedRevision": page["revision"]}
	path := "/spaces/" + shared + "/page"
	csrf := owner.csrf
	owner.csrf = ""
	if status, failure := owner.call("PUT", path, request); status != http.StatusForbidden || failure["code"] != "csrf_invalid" {
		t.Fatalf("missing CSRF was not rejected: %d %v", status, failure)
	}
	owner.csrf = csrf
	guest := newAppTestBrowser(t, app)
	guest.bootstrap()
	if status, _ := guest.call("PUT", path, request); status != http.StatusUnauthorized {
		t.Fatalf("anonymous public-read chrome write accepted: %d", status)
	}
	if status, _ := guest.call("PUT", "/spaces/"+personal+"/page", request); status != http.StatusNotFound {
		t.Fatalf("foreign personal page was exposed through chrome writes: %d", status)
	}
	stored := owner.ok("PUT", path, request)
	if stored["revision"] != "2" || stored["name"] != request["name"] || !reflect.DeepEqual(stored["config"], draft) {
		t.Fatal("saved page did not preserve all six slots, URL fragment, newline, or newTab omission")
	}
	assertUnchanged := func() {
		t.Helper()
		readback := owner.ok("GET", "/dashboard?spaceId="+shared, nil)["page"]
		if !reflect.DeepEqual(readback, stored) {
			t.Fatal("read or rejected write changed the saved page/configuration/revision")
		}
	}
	assertUnchanged()
	if status, failure := owner.call("PUT", path, request); status != http.StatusConflict || failure["code"] != "page_version_conflict" || failure["currentRevision"] != "2" {
		t.Fatalf("stale chrome write did not report the current revision: %d %v", status, failure)
	}
	assertUnchanged()
	invalidConfig := cloneConfig(t, draft)
	invalidConfig["chrome"].(map[string]any)["footer"].(map[string]any)["center"].([]any)[0].(map[string]any)["html"] = "<script>must not be stored</script>"
	if status, failure := owner.call("PUT", path, map[string]any{"name": "Must not change", "config": invalidConfig, "expectedRevision": "2"}); status != http.StatusBadRequest || failure["code"] != "validation_error" {
		t.Fatalf("unknown nested chrome field accepted: %d %v", status, failure)
	}
	assertUnchanged()
	afterNavigation := owner.ok("GET", "/spaces/"+shared+"/navigation", nil)
	if afterNavigation["revision"] != beforeNavigation["revision"] || !reflect.DeepEqual(afterNavigation["data"], beforeNavigation["data"]) {
		t.Fatal("page chrome edits changed authoritative bookmarks or their revision")
	}
}

func TestLegacyPageChromeAndLanguageRestartPreserveData(t *testing.T) {
	config := coreConfig(t, false)
	config.Language = "en"
	app, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if app != nil {
			_ = app.Close()
		}
	})
	owner := newAppTestBrowser(t, app)
	owner.bootstrap()
	owner.ok("POST", "/setup", map[string]any{"siteName": "保留我的 Site", "mode": ModePublicRead, "username": "owner", "displayName": "Existing Owner", "password": "a valid test password", "seedDemo": true})
	bootstrap := owner.bootstrap()
	shared := coreSpace(bootstrap, "shared")
	personal := coreSpace(bootstrap, "personal")
	owner.ok("POST", "/spaces/"+shared+"/links", coreLink("用户的网址 / Personal link", "https://example.org/my-project"))
	page := owner.ok("GET", "/dashboard?spaceId="+shared, nil)["page"].(map[string]any)
	legacy := cloneConfig(t, page["config"].(map[string]any))
	delete(legacy, "chrome")
	legacy["appearance"].(map[string]any)["colorMode"] = "dark"
	legacyJSON := jsonString(legacy)
	// This represents bytes already stored by the previous application build,
	// not an automatic migration or a new write through the current endpoint.
	if _, err = app.store.DB.ExecContext(context.Background(), app.store.Query("UPDATE pages SET name=?,config=?,revision=? WHERE space_id=?"), "原有页面 / My page", legacyJSON, 37, shared); err != nil {
		t.Fatal(err)
	}
	beforePage := owner.ok("GET", "/dashboard?spaceId="+shared, nil)["page"]
	beforePersonal := owner.ok("GET", "/dashboard?spaceId="+personal, nil)["page"]
	beforeNavigation := owner.ok("GET", "/spaces/"+shared+"/navigation", nil)
	beforeBootstrap := owner.bootstrap()
	assertLegacy := func() {
		t.Helper()
		if readback := owner.ok("GET", "/dashboard?spaceId="+shared, nil)["page"]; !reflect.DeepEqual(beforePage, readback) {
			t.Fatal("reading an old page injected chrome, changed its name, or advanced its revision")
		}
		if readback := owner.ok("GET", "/dashboard?spaceId="+personal, nil)["page"]; !reflect.DeepEqual(beforePersonal, readback) {
			t.Fatal("language change renamed an existing default page")
		}
		var stored []byte
		var revision int64
		if err := app.store.DB.QueryRowContext(context.Background(), app.store.Query("SELECT config,revision FROM pages WHERE space_id=?"), shared).Scan(&stored, &revision); err != nil {
			t.Fatal(err)
		}
		if string(stored) != legacyJSON || revision != 37 {
			t.Fatal("legacy configuration bytes/revision changed on read")
		}
	}
	assertLegacy()
	assertLegacy()
	if err = app.Close(); err != nil {
		t.Fatal(err)
	}
	app = nil
	config.Language = "zh-CN"
	app, err = Open(config)
	if err != nil {
		t.Fatal(err)
	}
	owner.client.Transport = appTestTransport{app}
	afterBootstrap := owner.bootstrap()
	if afterBootstrap["language"] != "zh-CN" || afterBootstrap["user"] == nil || !reflect.DeepEqual(beforeBootstrap["spaces"], afterBootstrap["spaces"]) || beforeBootstrap["siteName"] != afterBootstrap["siteName"] {
		t.Fatal("language restart changed persisted names, spaces or the existing session")
	}
	assertLegacy()
	afterNavigation := owner.ok("GET", "/spaces/"+shared+"/navigation", nil)
	if afterNavigation["revision"] != beforeNavigation["revision"] || !reflect.DeepEqual(afterNavigation["data"], beforeNavigation["data"]) {
		t.Fatal("language restart translated existing seed data or custom bookmarks")
	}
	legacy["chrome"] = defaultPageChrome()
	updated := owner.ok("PUT", "/spaces/"+shared+"/page", map[string]any{"name": "原有页面 / My page", "config": legacy, "expectedRevision": "37"})
	if updated["revision"] != "38" || !reflect.DeepEqual(updated["config"], legacy) {
		t.Fatal("an explicit chrome save must advance a legacy page exactly once")
	}
}
