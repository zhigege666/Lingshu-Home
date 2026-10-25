package home

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestComponentTemplateMultipleDiscoveryAndDirectJSON(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: componentTestTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		if request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
			t.Fatal("discovery forwarded caller credentials")
		}
		if request.URL.Path == "/direct.json" {
			return componentTestResponse(200, "application/json", jsonString(componentTemplateFixture())), nil
		}
		return componentTestResponse(200, "text/html", `<html><head><link rel="lingshu-home-component" href="one.json" title="Calendar &amp; weather"><link rel="alternate lingshu-home-component" href="/two.json"><link rel="lingshu-home-component" href="one.json#duplicate"></head><body><link rel="lingshu-home-component" href="/ignored.json"><script>throw 1</script></body>`), nil
	}), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	result, err := discoverComponentTemplates(context.Background(), client, "https://widgets.example.org/catalog/")
	if err != nil || len(result.Templates) != 2 || calls != 1 || result.Truncated || result.Preview != nil {
		t.Fatalf("multi discovery failed or fetched candidates: %#v %v calls=%d", result, err, calls)
	}
	if result.Templates[0].URL != "https://widgets.example.org/catalog/one.json" || result.Templates[0].Title != "Calendar & weather" {
		t.Fatal("relative URL or title was not preserved")
	}
	direct, err := discoverComponentTemplates(context.Background(), client, "https://widgets.example.org/direct.json")
	if err != nil || direct.Preview == nil || len(direct.Templates) != 0 || len(direct.Preview.SHA256) != 64 || calls != 2 {
		t.Fatalf("direct JSON preview failed: %#v %v", direct, err)
	}
}

func TestComponentTemplateDiscoveryBoundsAndAuthorization(t *testing.T) {
	body := "<head>"
	for i := 0; i < 12; i++ {
		body += fmt.Sprintf(`<link rel="lingshu-home-component" href="/%d.json">`, i)
	}
	client := &http.Client{Transport: componentTestTransport(func(*http.Request) (*http.Response, error) {
		return componentTestResponse(200, "text/html", body+"</head>"), nil
	})}
	result, err := discoverComponentTemplates(context.Background(), client, "https://widgets.example.org/")
	if err != nil || len(result.Templates) != 8 || !result.Truncated {
		t.Fatalf("candidate bound failed: %#v %v", result, err)
	}
	for _, unsafe := range []string{"http://127.0.0.1/secret.json", "http://169.254.169.254/latest/", "javascript:alert(1)", "https://example.org:65536/template", "http://192.168.1.20:8080/template"} {
		body = `<head><link rel="lingshu-home-component" href="` + unsafe + `"></head>`
		if _, err := discoverComponentTemplates(context.Background(), client, "https://widgets.example.org/"); err == nil {
			t.Fatalf("unsafe declaration accepted: %s", unsafe)
		}
	}
	body = "<head></head><body>" + strings.Repeat("x", 1024)
	app, err := openWithIconHTTPClient(coreConfig(t, false), client)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	owner := newAppTestBrowser(t, app)
	owner.bootstrap()
	owner.ok("POST", "/setup", map[string]any{"siteName": "Templates", "mode": ModePublicRead, "username": "owner", "displayName": "Owner", "password": "a valid test password"})
	space := coreSpace(owner.bootstrap(), "shared")
	path := "/spaces/" + space + "/component-templates/discover"
	body = `<head><link rel="lingshu-home-component" href="/one.json"></head>`
	preview := owner.ok("POST", path, map[string]any{"url": "https://widgets.example.org/"})
	if len(preview["templates"].([]any)) != 1 {
		t.Fatal("authorized discovery failed")
	}
	guest := newAppTestBrowser(t, app)
	guest.bootstrap()
	if status, _ := guest.call("POST", path, map[string]any{"url": "https://widgets.example.org/"}); status != 401 {
		t.Fatalf("reader can contact template publisher: %d", status)
	}
	owner.csrf = "invalid"
	if status, _ := owner.call("POST", path, map[string]any{"url": "https://widgets.example.org/"}); status != 403 {
		t.Fatalf("CSRF missing: %d", status)
	}
}
