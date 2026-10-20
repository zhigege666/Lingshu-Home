package home

import (
	"fmt"
	"net/http"
	"reflect"
	"testing"
)

func TestBuiltinPageThemesAndLinkAppearances(t *testing.T) {
	// Omitted appearance/chrome fields in stored Schema 2 pages remain omitted.
	// Theme registration does not normalize them into new persisted defaults.
	for _, theme := range []string{"builtin/dashboard", "builtin/ios"} {
		for _, color := range []string{"light", "dark", "system"} {
			for _, density := range []string{"comfortable", "compact"} {
				for _, appearance := range []string{"", "icon-text", "minimal", "app-icons"} {
					t.Run(fmt.Sprintf("%s/%s/%s/%s", theme, color, density, appearance), func(t *testing.T) {
						config := cloneConfig(t, defaultPageConfig())
						config["pageTheme"] = map[string]any{"id": theme}
						config["appearance"] = map[string]any{"colorMode": color, "density": density}
						delete(config, "chrome")
						if appearance != "" {
							for _, index := range []int{2, 3} {
								settings := config["views"].([]any)[index].(map[string]any)["settings"].(map[string]any)
								settings["linkAppearance"] = appearance
							}
						}
						before := cloneConfig(t, config)
						if err := validatePageConfig(config); err != nil {
							t.Fatalf("valid theme/appearance rejected: %v", err)
						}
						if !reflect.DeepEqual(before, config) {
							t.Fatal("validation injected or changed persisted configuration")
						}
					})
				}
			}
		}
	}
	for _, variant := range []string{"cards", "directory"} {
		config := cloneConfig(t, defaultPageConfig())
		config["pageTheme"] = map[string]any{"id": "builtin/ios"}
		settings := config["views"].([]any)[3].(map[string]any)["settings"].(map[string]any)
		settings["variant"], settings["linkAppearance"] = variant, "app-icons"
		if err := validatePageConfig(config); err != nil {
			t.Fatalf("link appearance must not replace grouping variant %s: %v", variant, err)
		}
	}
}

func TestPageThemeRejectsUnregisteredAndMisplacedSettings(t *testing.T) {
	for _, test := range []struct {
		name string
		edit func(map[string]any)
	}{
		{"unknown theme", func(c map[string]any) { c["pageTheme"] = map[string]any{"id": "third-party/uninstalled"} }},
		{"URL theme", func(c map[string]any) { c["pageTheme"] = map[string]any{"id": "https://example.org/theme.js"} }},
		{"null theme", func(c map[string]any) { c["pageTheme"] = map[string]any{"id": nil} }},
		{"theme options", func(c map[string]any) { c["pageTheme"] = map[string]any{"id": "builtin/ios", "layout": "replace"} }},
		{"unknown link appearance", func(c map[string]any) {
			c["views"].([]any)[3].(map[string]any)["settings"].(map[string]any)["linkAppearance"] = "glass"
		}},
		{"null link appearance", func(c map[string]any) {
			c["views"].([]any)[3].(map[string]any)["settings"].(map[string]any)["linkAppearance"] = nil
		}},
		{"numeric link appearance", func(c map[string]any) {
			c["views"].([]any)[2].(map[string]any)["settings"].(map[string]any)["linkAppearance"] = 1
		}},
		{"category setting ownership", func(c map[string]any) {
			c["views"].([]any)[0].(map[string]any)["settings"].(map[string]any)["linkAppearance"] = "minimal"
		}},
		{"search setting ownership", func(c map[string]any) {
			c["views"].([]any)[1].(map[string]any)["settings"].(map[string]any)["linkAppearance"] = "app-icons"
		}},
		{"appearance is not variant", func(c map[string]any) {
			c["views"].([]any)[3].(map[string]any)["settings"].(map[string]any)["variant"] = "app-icons"
		}},
		{"theme cannot introduce second layout", func(c map[string]any) {
			c["pageTheme"] = map[string]any{"id": "builtin/ios"}
			c["views"].([]any)[3].(map[string]any)["settings"].(map[string]any)["width"] = 400
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			config := cloneConfig(t, defaultPageConfig())
			test.edit(config)
			config = cloneConfig(t, config)
			before := cloneConfig(t, config)
			if err := validatePageConfig(config); err == nil {
				t.Fatal("unsupported theme or misplaced setting accepted")
			}
			if !reflect.DeepEqual(before, config) {
				t.Fatal("rejected validation changed the caller's configuration")
			}
		})
	}
}

func TestPageThemeHTTPRoundTripPreservesComposition(t *testing.T) {
	config := coreConfig(t, false)
	app, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.Close() })
	owner := newAppTestBrowser(t, app)
	owner.bootstrap()
	owner.ok("POST", "/setup", map[string]any{"siteName": "Theme test", "mode": ModePublicRead, "username": "owner", "displayName": "Owner", "password": "a valid test password", "seedDemo": true})
	bootstrap := owner.bootstrap()
	if themes := bootstrap["capabilities"].(map[string]any)["pageThemes"]; !reflect.DeepEqual(themes, []any{"builtin/dashboard", "builtin/ios"}) {
		t.Fatalf("bootstrap must advertise exactly the implemented themes: %v", themes)
	}
	shared := coreSpace(bootstrap, "shared")
	path := "/spaces/" + shared + "/page"
	beforeNavigation := owner.ok("GET", "/spaces/"+shared+"/navigation", nil)
	page := owner.ok("GET", "/dashboard?spaceId="+shared, nil)["page"].(map[string]any)
	original := cloneConfig(t, page["config"].(map[string]any))
	// User chrome and explicit per-panel appearance must survive both switches.
	original["chrome"].(map[string]any)["header"].(map[string]any)["enabled"] = true
	original["chrome"].(map[string]any)["header"].(map[string]any)["center"] = []any{map[string]any{"id": "my-heading", "type": "text", "text": "My page / 我的页面"}}
	original["chrome"].(map[string]any)["footer"].(map[string]any)["right"] = []any{}
	original["views"].([]any)[2].(map[string]any)["settings"].(map[string]any)["linkAppearance"] = "minimal"
	page = owner.ok("PUT", path, map[string]any{"name": "Original page / 原页", "config": original, "expectedRevision": page["revision"]})
	for _, theme := range []string{"builtin/ios", "builtin/dashboard"} {
		draft := cloneConfig(t, original)
		draft["pageTheme"] = map[string]any{"id": theme}
		request := map[string]any{"name": page["name"], "config": draft, "expectedRevision": page["revision"]}
		guest := newAppTestBrowser(t, app)
		guest.bootstrap()
		if status, _ := guest.call("PUT", path, request); status != http.StatusUnauthorized {
			t.Fatalf("anonymous public-read theme write accepted: %d", status)
		}
		stored := owner.ok("PUT", path, request)
		readback := owner.ok("GET", "/dashboard?spaceId="+shared, nil)["page"].(map[string]any)
		if !reflect.DeepEqual(stored, readback) || stored["name"] != page["name"] || !reflect.DeepEqual(stored["config"], draft) {
			t.Fatal("theme save/read changed names, panel settings, bindings, layout, chrome, or removed branding")
		}
		if status, failure := owner.call("PUT", path, request); status != http.StatusConflict || failure["code"] != "page_version_conflict" {
			t.Fatalf("stale theme save was not rejected: %d %v", status, failure)
		}
		page = stored
	}
	if !reflect.DeepEqual(page["config"], original) {
		t.Fatal("switching back to the original theme changed the saved composition")
	}
	bad := cloneConfig(t, original)
	bad["pageTheme"] = map[string]any{"id": "builtin/unregistered"}
	if status, _ := owner.call("PUT", path, map[string]any{"name": "Must not be stored", "config": bad, "expectedRevision": page["revision"]}); status != http.StatusBadRequest {
		t.Fatalf("unregistered theme was persisted: %d", status)
	}
	if readback := owner.ok("GET", "/dashboard?spaceId="+shared, nil)["page"]; !reflect.DeepEqual(page, readback) {
		t.Fatal("rejected theme write changed the saved page")
	}
	afterNavigation := owner.ok("GET", "/spaces/"+shared+"/navigation", nil)
	if beforeNavigation["revision"] != afterNavigation["revision"] || !reflect.DeepEqual(beforeNavigation["data"], afterNavigation["data"]) {
		t.Fatal("theme switches changed authoritative bookmarks, categories, favorites, or their revision")
	}
}
