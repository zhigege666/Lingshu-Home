package home

import "testing"

func TestCategoryNavigationSettings(t *testing.T) {
	// Old stored pages omit all new keys and must keep loading without a migration.
	if err := validatePageConfig(cloneConfig(t, defaultPageConfig())); err != nil {
		t.Fatal(err)
	}
	for _, display := range []string{"icon-text", "icons", "text"} {
		for _, hierarchy := range []string{"tree", "flat"} {
			for _, flag := range []bool{true, false} {
				config := cloneConfig(t, defaultPageConfig())
				config["views"].([]any)[0].(map[string]any)["settings"] = map[string]any{
					"displayMode": display, "hierarchyMode": hierarchy,
					"collapsible": flag, "defaultCollapsed": flag, "showCounts": flag,
				}
				if err := validatePageConfig(config); err != nil {
					t.Fatalf("valid %s/%s/%v: %v", display, hierarchy, flag, err)
				}
			}
		}
	}
	for _, test := range []struct {
		name, key  string
		value      any
		panelIndex int
	}{
		{"unknown display", "displayMode", "emoji", 0},
		{"null display", "displayMode", nil, 0},
		{"unknown hierarchy", "hierarchyMode", "infinite", 0},
		{"string collapsible", "collapsible", "true", 0},
		{"number default", "defaultCollapsed", 1, 0},
		{"null counts", "showCounts", nil, 0},
		{"search rejects category setting", "displayMode", "icons", 1},
		{"favorites rejects category setting", "showCounts", true, 2},
		{"navigation rejects category setting", "hierarchyMode", "flat", 3},
		{"unknown key", "collapsed", true, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			config := cloneConfig(t, defaultPageConfig())
			config["views"].([]any)[test.panelIndex].(map[string]any)["settings"].(map[string]any)[test.key] = test.value
			if err := validatePageConfig(config); err == nil {
				t.Fatal("invalid settings accepted")
			}
		})
	}
}
