package home

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func cloneConfig(t *testing.T, config map[string]any) map[string]any {
	t.Helper()
	body, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err = json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestPageConfigurationSingleAuthority(t *testing.T) {
	base := cloneConfig(t, defaultPageConfig())
	if err := validatePageConfig(base); err != nil {
		t.Fatal(err)
	}
	for _, position := range []string{"top", "left", "right", "bottom", "hidden"} {
		config := cloneConfig(t, base)
		placement := config["layout"].(map[string]any)["placements"].(map[string]any)["categories"].(map[string]any)
		if position == "hidden" {
			placement["base"] = map[string]any{"kind": "hidden"}
		} else {
			placement["base"] = map[string]any{"kind": "region", "region": position, "order": 0}
		}
		if err := validatePageConfig(config); err != nil {
			t.Fatalf("valid %s: %v", position, err)
		}
	}
	cases := map[string]func(map[string]any){
		"schema":           func(c map[string]any) { c["schemaVersion"] = 1 },
		"second position":  func(c map[string]any) { c["views"].([]any)[0].(map[string]any)["slot"] = "left" },
		"unknown page key": func(c map[string]any) { c["theme"] = map[string]any{"id": "legacy"} },
		"duplicate view": func(c map[string]any) {
			views := c["views"].([]any)
			views[1].(map[string]any)["id"] = views[0].(map[string]any)["id"]
		},
		"foreign space": func(c map[string]any) {
			c["bindings"].(map[string]any)["navigation"].(map[string]any)["space"] = "other-space"
		},
		"unknown query": func(c map[string]any) {
			c["bindings"].(map[string]any)["navigation"].(map[string]any)["query"] = map[string]any{"url": "https://example.org"}
		},
		"overlap": func(c map[string]any) {
			c["layout"].(map[string]any)["placements"].(map[string]any)["navigation-main"].(map[string]any)["base"].(map[string]any)["y"] = 0
		},
		"fractional": func(c map[string]any) {
			c["layout"].(map[string]any)["placements"].(map[string]any)["navigation-main"].(map[string]any)["base"].(map[string]any)["w"] = 4.5
		},
		"main category": func(c map[string]any) {
			c["layout"].(map[string]any)["placements"].(map[string]any)["categories"].(map[string]any)["base"].(map[string]any)["region"] = "main"
		},
		"unknown breakpoint": func(c map[string]any) {
			c["layout"].(map[string]any)["placements"].(map[string]any)["categories"].(map[string]any)["overrides"].(map[string]any)["wide"] = map[string]any{"kind": "hidden"}
		},
		"search too wide": func(c map[string]any) {
			c["layout"].(map[string]any)["placements"].(map[string]any)["search"].(map[string]any)["base"].(map[string]any)["size"].(map[string]any)["widthPx"] = 900
		},
		"panel actual width": func(c map[string]any) {
			c["views"].([]any)[0].(map[string]any)["settings"].(map[string]any)["widthPx"] = 240
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			config := cloneConfig(t, base)
			mutate(config)
			if err := validatePageConfig(config); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
	empty := cloneConfig(t, base)
	empty["views"] = []any{}
	empty["bindings"] = map[string]any{}
	empty["layout"].(map[string]any)["placements"] = map[string]any{}
	if err := validatePageConfig(empty); err != nil {
		t.Fatalf("empty composition must be valid: %v", err)
	}
	query := map[string]any{"categoryIds": []any{"source:" + strings.Repeat("a", 32) + ":" + strings.Repeat("b", 128)}}
	if err := validateNavigationQuery(query); err != nil {
		t.Fatalf("valid namespaced external category rejected: %v", err)
	}
}

func TestSafeURLs(t *testing.T) {
	for _, raw := range []string{"https://example.org/", "HTTPS://Example.org:443/path?q=1#fragment", "http://[::1]:5180/", "https://example.org/你好"} {
		if _, err := canonicalURL(raw); err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
	}
	for _, raw := range []string{"javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "/relative", "//example.org/", "https://user:pass@example.org/", "https://example.org:99999/", "https://example.org:0/", "https://example.org/a\nb", "https://example.org\\x"} {
		if _, err := canonicalURL(raw); err == nil {
			t.Fatalf("unsafe URL accepted: %q", raw)
		}
	}
	left, _ := canonicalURL("HTTPS://Example.org:443/#one")
	right, _ := canonicalURL("https://example.org/")
	if left != right {
		t.Fatalf("canonical URL differs: %q %q", left, right)
	}
}

func TestChromeBookmarkParser(t *testing.T) {
	html, err := os.ReadFile("../../../tests/fixtures/bookmarks.html")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parseBookmarks(string(html))
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Items) != 9 || len(parsed.Folders) != 2 {
		t.Fatalf("items=%d folders=%v", len(parsed.Items), parsed.Folders)
	}
	valid := 0
	nested := false
	for _, item := range parsed.Items {
		if item.Status != "invalid" {
			valid++
		}
		if strings.Contains(item.URL, "/nested?") {
			nested = len(item.FolderPath) == 2 && item.FolderPath[0] == "Team & Ops" && item.FolderPath[1] == "Nested <Folder>"
		}
	}
	if valid != 5 || !nested {
		t.Fatalf("valid=%d nested=%v items=%+v", valid, nested, parsed.Items)
	}
	var many strings.Builder
	many.WriteString("<DL>")
	for i := 0; i < 10001; i++ {
		many.WriteString(`<DT><A HREF="https://example.org/">x</A>`)
	}
	many.WriteString("</DL>")
	if _, err = parseBookmarks(many.String()); err == nil {
		t.Fatal("over-10000 import accepted")
	}
	if _, err = parseBookmarks(strings.Repeat("x", 2*1024*1024+1)); err == nil {
		t.Fatal("over-2MiB import accepted")
	}
}
