package home

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func chromeSlot(chrome map[string]any, region, alignment string) []any {
	return chrome[region].(map[string]any)[alignment].([]any)
}

func TestPageChromeDefaultsAndValidation(t *testing.T) {
	base := cloneConfig(t, defaultPageConfig())
	chrome := base["chrome"].(map[string]any)
	if chrome["header"].(map[string]any)["enabled"] != false || chrome["footer"].(map[string]any)["enabled"] != true {
		t.Fatal("the default must enable only the footer")
	}
	for _, region := range []string{"header", "footer"} {
		for _, alignment := range []string{"left", "center", "right"} {
			items := chromeSlot(chrome, region, alignment)
			if region == "footer" && alignment == "right" {
				if len(items) != 1 || !reflect.DeepEqual(items[0], map[string]any{"id": "home-branding", "type": "branding"}) {
					t.Fatal("default branding must be in the footer's right slot")
				}
			} else if len(items) != 0 {
				t.Fatalf("default %s/%s must be empty", region, alignment)
			}
		}
	}
	if err := validatePageConfig(base); err != nil {
		t.Fatal(err)
	}
	legacy := cloneConfig(t, base)
	delete(legacy, "chrome")
	if err := validatePageConfig(legacy); err != nil {
		t.Fatalf("old Schema 2 pages without chrome remain valid: %v", err)
	}
	if _, changed := legacy["chrome"]; changed {
		t.Fatal("validation must not inject chrome into old configuration")
	}

	// Check every region/alignment, including disabled content. A disabled
	// region must not become a storage bypass for unchecked values.
	for _, region := range []string{"header", "footer"} {
		for _, alignment := range []string{"left", "center", "right"} {
			for _, count := range []int{8, 9} {
				t.Run(fmt.Sprintf("%s/%s/%d", region, alignment, count), func(t *testing.T) {
					config := cloneConfig(t, base)
					area := config["chrome"].(map[string]any)[region].(map[string]any)
					items := []any{}
					for i := 0; i < count; i++ {
						items = append(items, map[string]any{"id": fmt.Sprintf("item-%d", i), "type": "text", "text": "A line\n另一行"})
					}
					area[alignment] = items
					if err := validatePageConfig(config); (err == nil) != (count == 8) {
						t.Fatalf("unexpected %d-item result: %v", count, err)
					}
				})
			}
		}
	}

	validItems := []map[string]any{
		{"id": strings.Repeat("界", 80), "type": "text", "text": strings.Repeat("界", 499) + "\n"},
		{"id": "text-with-lines", "type": "text", "text": "Line one\r\nLine two\t<script>plain text</script>"},
		{"id": "default-new-tab", "type": "link", "text": strings.Repeat("界", 160), "url": "https://example.org/" + strings.Repeat("x", 2028)},
		{"id": "same-tab", "type": "link", "text": "Documentation", "url": "https://example.org/docs?x=1#install", "newTab": false},
		{"id": "new-tab", "type": "link", "text": "Documentation", "url": "http://[::1]:5180/", "newTab": true},
		{"id": "branding", "type": "branding"},
	}
	for _, item := range validItems {
		t.Run("valid-"+item["id"].(string), func(t *testing.T) {
			config := cloneConfig(t, base)
			config["chrome"].(map[string]any)["header"].(map[string]any)["center"] = []any{item}
			before := cloneConfig(t, config)
			if err := validatePageConfig(config); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, config) {
				t.Fatal("validation rewrote user text, URL fragment, or an omitted newTab")
			}
		})
	}
}

func TestPageChromeRejectsInvalidFields(t *testing.T) {
	validLink := func() map[string]any {
		return map[string]any{"id": "custom-link", "type": "link", "text": "Docs", "url": "https://example.org/"}
	}
	for _, test := range []struct {
		name string
		edit func(map[string]any)
	}{
		{"unknown item field", func(i map[string]any) { i["html"] = "<b>markup</b>" }},
		{"missing id", func(i map[string]any) { delete(i, "id") }},
		{"id wrong type", func(i map[string]any) { i["id"] = 10 }},
		{"empty id", func(i map[string]any) { i["id"] = "" }},
		{"id whitespace", func(i map[string]any) { i["id"] = " padded " }},
		{"id control", func(i map[string]any) { i["id"] = "one\ntwo" }},
		{"id too long", func(i map[string]any) { i["id"] = strings.Repeat("界", 81) }},
		{"missing type", func(i map[string]any) { delete(i, "type") }},
		{"unknown type", func(i map[string]any) { i["type"] = "html" }},
		{"type wrong type", func(i map[string]any) { i["type"] = map[string]any{} }},
		{"missing text", func(i map[string]any) { delete(i, "text") }},
		{"empty text", func(i map[string]any) { i["text"] = " \t\n" }},
		{"text wrong type", func(i map[string]any) { i["text"] = true }},
		{"text control", func(i map[string]any) { i["text"] = "a\x00b" }},
		{"link text too long", func(i map[string]any) { i["text"] = strings.Repeat("界", 161) }},
		{"missing URL", func(i map[string]any) { delete(i, "url") }},
		{"URL wrong type", func(i map[string]any) { i["url"] = nil }},
		{"URL too long", func(i map[string]any) { i["url"] = "https://example.org/" + strings.Repeat("x", 2029) }},
		{"URL script", func(i map[string]any) { i["url"] = "javascript:alert(1)" }},
		{"URL data", func(i map[string]any) { i["url"] = "data:text/html,x" }},
		{"URL relative", func(i map[string]any) { i["url"] = "/docs" }},
		{"URL credentials", func(i map[string]any) { i["url"] = "https://name:password@example.org/" }},
		{"URL whitespace", func(i map[string]any) { i["url"] = "https://example.org/one\ntwo" }},
		{"URL backslash", func(i map[string]any) { i["url"] = "https://example.org\\path" }},
		{"newTab wrong type", func(i map[string]any) { i["newTab"] = "false" }},
		{"newTab null", func(i map[string]any) { i["newTab"] = nil }},
		{"branding options", func(i map[string]any) { i["type"] = "branding" }},
		{"text link options", func(i map[string]any) { i["type"] = "text" }},
		{"text too long", func(i map[string]any) { i["type"] = "text"; delete(i, "url"); i["text"] = strings.Repeat("界", 501) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			config := cloneConfig(t, defaultPageConfig())
			item := validLink()
			test.edit(item)
			config["chrome"].(map[string]any)["header"].(map[string]any)["left"] = []any{item}
			if err := validatePageConfig(config); err == nil {
				t.Fatal("invalid chrome item accepted")
			}
		})
	}
	for _, test := range []struct {
		name string
		edit func(map[string]any)
	}{
		{"chrome null", func(c map[string]any) { c["chrome"] = nil }},
		{"chrome wrong type", func(c map[string]any) { c["chrome"] = []any{} }},
		{"unknown region", func(c map[string]any) { c["chrome"].(map[string]any)["sidebar"] = map[string]any{} }},
		{"missing region", func(c map[string]any) { delete(c["chrome"].(map[string]any), "footer") }},
		{"unknown region field", func(c map[string]any) { c["chrome"].(map[string]any)["header"].(map[string]any)["sticky"] = true }},
		{"enabled null", func(c map[string]any) { c["chrome"].(map[string]any)["header"].(map[string]any)["enabled"] = nil }},
		{"slot null", func(c map[string]any) { c["chrome"].(map[string]any)["footer"].(map[string]any)["center"] = nil }},
		{"missing slot", func(c map[string]any) { delete(c["chrome"].(map[string]any)["header"].(map[string]any), "left") }},
		{"duplicate across regions", func(c map[string]any) {
			c["chrome"].(map[string]any)["header"].(map[string]any)["left"] = []any{map[string]any{"id": "home-branding", "type": "text", "text": "Duplicate"}}
		}},
		{"duplicate across slots", func(c map[string]any) {
			c["chrome"].(map[string]any)["footer"].(map[string]any)["left"] = []any{map[string]any{"id": "home-branding", "type": "branding"}}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			config := cloneConfig(t, defaultPageConfig())
			test.edit(config)
			if err := validatePageConfig(config); err == nil {
				t.Fatal("invalid chrome structure accepted")
			}
		})
	}
}
