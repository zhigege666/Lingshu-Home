package home

import (
	"fmt"
	"reflect"
	"testing"
)

func TestNavigationAppearanceSettingsBoundsAndOwnership(t *testing.T) {
	valid := []map[string]any{
		{},
		{"maxColumns": 0, "urlDisplay": "fallback", "descriptionLines": 1, "density": "inherit"},
		{"maxColumns": 1, "urlDisplay": "hidden", "descriptionLines": 0, "showTags": false, "showEndpoints": false, "showGroupTitles": false, "showCounts": false, "density": "compact"},
		{"maxColumns": 8, "urlDisplay": "always", "descriptionLines": 3, "showTags": true, "showEndpoints": true, "showGroupTitles": true, "showCounts": true, "density": "comfortable"},
	}
	for _, index := range []int{2, 3} {
		for _, variant := range []string{"cards", "directory"} {
			for i, values := range valid {
				t.Run(fmt.Sprintf("valid/%d/%s/%d", index, variant, i), func(t *testing.T) {
					config := cloneConfig(t, defaultPageConfig())
					settings := config["views"].([]any)[index].(map[string]any)["settings"].(map[string]any)
					settings["variant"] = variant
					for key, value := range values {
						settings[key] = value
					}
					config = cloneConfig(t, config)
					before := cloneConfig(t, config)
					if err := validatePageConfig(config); err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(config, before) {
						t.Fatal("validation injected defaults or changed saved settings")
					}
				})
			}
		}
	}
	invalidValues := map[string][]any{
		"maxColumns":       {-1, 9, 1.5, "4", nil, true},
		"descriptionLines": {-1, 4, 1.5, "2", nil, false},
		"urlDisplay":       {"full", "", nil, false},
		"density":          {"dense", "", nil, 1},
		"showTags":         {"true", 1, nil},
		"showEndpoints":    {"false", 0, nil},
		"showGroupTitles":  {"true", 1, nil},
		"showCounts":       {"false", 0, nil},
	}
	for _, index := range []int{2, 3} {
		for name, values := range invalidValues {
			for i, value := range values {
				t.Run(fmt.Sprintf("invalid/%d/%s/%d", index, name, i), func(t *testing.T) {
					config := cloneConfig(t, defaultPageConfig())
					config["views"].([]any)[index].(map[string]any)["settings"].(map[string]any)[name] = value
					config = cloneConfig(t, config)
					before := cloneConfig(t, config)
					if err := validatePageConfig(config); err == nil {
						t.Fatal("invalid content setting accepted")
					}
					if !reflect.DeepEqual(config, before) {
						t.Fatal("rejected validation mutated its input")
					}
				})
			}
		}
	}
	for _, index := range []int{0, 1} {
		for name, value := range valid[3] {
			if index == 0 && name == "showCounts" {
				continue // Category navigation already owns a separate showCounts.
			}
			config := cloneConfig(t, defaultPageConfig())
			config["views"].([]any)[index].(map[string]any)["settings"].(map[string]any)[name] = value
			if err := validatePageConfig(cloneConfig(t, config)); err == nil {
				t.Fatalf("unrelated panel %d accepted %s", index, name)
			}
		}
	}
}

func TestNavigationAppearanceSaveReloadAndRestart(t *testing.T) {
	config := coreConfig(t, false)
	app, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if app != nil {
			_ = app.Close()
		}
	})
	browser := newAppTestBrowser(t, app)
	browser.bootstrap()
	browser.ok("POST", "/setup", map[string]any{"siteName": "Navigation presentation", "mode": ModeOpenEdit, "seedDemo": false})
	space := coreSpace(browser.bootstrap(), "shared")
	path := "/spaces/" + space + "/page"
	page := browser.ok("GET", path, nil)
	navigation := browser.ok("GET", "/spaces/"+space+"/navigation", nil)
	updated := cloneConfig(t, page["config"].(map[string]any))
	for _, index := range []int{2, 3} {
		settings := updated["views"].([]any)[index].(map[string]any)["settings"].(map[string]any)
		for key, value := range map[string]any{"maxColumns": 3, "urlDisplay": "hidden", "descriptionLines": 2, "showTags": true, "showEndpoints": false, "showGroupTitles": false, "showCounts": false, "density": "compact"} {
			settings[key] = value
		}
	}
	updated = cloneConfig(t, updated)
	saved := browser.ok("PUT", path, map[string]any{"name": page["name"], "config": updated, "expectedRevision": page["revision"]})
	read := browser.ok("GET", path, nil)
	if !reflect.DeepEqual(read["config"], updated) || read["revision"] != saved["revision"] {
		t.Fatal("content settings did not survive a page read")
	}
	if status, _ := browser.call("PUT", path, map[string]any{"name": page["name"], "config": updated, "expectedRevision": page["revision"]}); status != 409 {
		t.Fatalf("stale settings write returned %d", status)
	}
	invalidConfig := cloneConfig(t, updated)
	invalidConfig["views"].([]any)[3].(map[string]any)["settings"].(map[string]any)["maxColumns"] = 9
	if status, _ := browser.call("PUT", path, map[string]any{"name": page["name"], "config": invalidConfig, "expectedRevision": saved["revision"]}); status != 400 {
		t.Fatalf("invalid settings write returned %d", status)
	}
	if after := browser.ok("GET", path, nil); !reflect.DeepEqual(after, read) {
		t.Fatal("failed writes changed the saved page")
	}
	if after := browser.ok("GET", "/spaces/"+space+"/navigation", nil); after["revision"] != navigation["revision"] || !reflect.DeepEqual(after["data"], navigation["data"]) {
		t.Fatal("presentation settings modified navigation records")
	}
	if err = app.Close(); err != nil {
		t.Fatal(err)
	}
	app = nil
	app, err = Open(config)
	if err != nil {
		t.Fatal(err)
	}
	reopened := newAppTestBrowser(t, app)
	reopened.bootstrap()
	if after := reopened.ok("GET", path, nil); !reflect.DeepEqual(after, read) {
		t.Fatal("content settings did not survive application restart")
	}
}

func TestNavigationCategoryFolderSettings(t *testing.T) {
	for _, value := range []any{0, 4, 6, 8, 12, 24} {
		config := cloneConfig(t, defaultPageConfig())
		for _, raw := range config["views"].([]any) {
			view := raw.(map[string]any)
			if view["panel"].(map[string]any)["id"] == "builtin/navigation" {
				view["settings"].(map[string]any)["groupPreviewCount"] = value
			}
		}
		if err := validatePageConfig(cloneConfig(t, config)); err != nil {
			t.Fatal(value, err)
		}
	}
	for _, value := range []any{-1, 1, 5, 7, 25, 6.5, "6", nil, true} {
		config := cloneConfig(t, defaultPageConfig())
		// The navigation view follows category navigation, search and favorites.
		config["views"].([]any)[3].(map[string]any)["settings"].(map[string]any)["groupPreviewCount"] = value
		if err := validatePageConfig(cloneConfig(t, config)); err == nil {
			t.Fatal("Invalid folder setting accepted", value)
		}
	}
	config := cloneConfig(t, defaultPageConfig())
	config["views"].([]any)[2].(map[string]any)["settings"].(map[string]any)["groupPreviewCount"] = 6
	if err := validatePageConfig(cloneConfig(t, config)); err == nil {
		t.Fatal("Favorites accepted category-only folder setting")
	}
}
