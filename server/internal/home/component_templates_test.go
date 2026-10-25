package home

import (
	"context"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func componentTemplateFixture() map[string]any {
	return map[string]any{
		"format": "lingshu-home-component", "manifestVersion": 1, "id": "example/bookmarks",
		"version": "1.0.0", "name": "My useful links", "license": "Apache-2.0",
		"renderer": "builtin/navigation", "dataSchema": map[string]any{"id": "navigation.collection", "version": 1},
		"settings": map[string]any{"variant": "cards", "groupBy": "category"},
		"layout":   map[string]any{"width": 12, "height": 6},
	}
}

func TestComponentTemplateValidationAndNoExecutableFields(t *testing.T) {
	raw := []byte(jsonString(componentTemplateFixture()))
	if _, err := parseComponentTemplate(raw); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name string
		edit func(map[string]any)
	}{
		{"script", func(m map[string]any) { m["script"] = "https://example.org/widget.js" }},
		{"connection", func(m map[string]any) { m["connection"] = map[string]any{"token": "private"} }},
		{"unregistered renderer", func(m map[string]any) { m["renderer"] = "remote/exec" }},
		{"incompatible schema", func(m map[string]any) { m["dataSchema"] = map[string]any{"id": "weather.forecast", "version": 1} }},
		{"future format", func(m map[string]any) { m["manifestVersion"] = 2 }},
		{"unknown settings", func(m map[string]any) { m["settings"] = map[string]any{"html": "<script>alert(1)</script>"} }},
		{"oversize title", func(m map[string]any) { m["settings"] = map[string]any{"title": strings.Repeat("x", 81)} }},
		{"unsafe homepage", func(m map[string]any) { m["homepage"] = "javascript:alert(1)" }},
		{"oversize geometry", func(m map[string]any) { m["layout"] = map[string]any{"width": 25, "height": 6} }},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := componentTemplateFixture()
			test.edit(fixture)
			if _, err := parseComponentTemplate([]byte(jsonString(fixture))); err == nil {
				t.Fatal("unsupported or unsafe template accepted")
			}
		})
	}
	for _, content := range [][]byte{append(raw, raw...), []byte("null"), []byte(strings.Repeat(" ", 64<<10) + "{}")} {
		if _, err := parseComponentTemplate(content); err == nil {
			t.Fatal("invalid or unbounded input accepted")
		}
	}
}

type componentTestTransport func(*http.Request) (*http.Response, error)

func (transport componentTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func componentTestResponse(status int, mediaType, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{mediaType}},
		Body: io.NopCloser(strings.NewReader(body)), ContentLength: int64(len(body))}
}

func TestComponentTemplatePublicFetchAndHeadDiscovery(t *testing.T) {
	calls := []string{}
	client := &http.Client{Transport: componentTestTransport(func(request *http.Request) (*http.Response, error) {
		calls = append(calls, request.URL.String())
		if request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
			t.Fatal("browser or source credentials forwarded to publisher")
		}
		switch request.URL.Path {
		case "/page":
			return componentTestResponse(200, "text/html", `<html><head><link rel="lingshu-home-component" href="/component.json"></head><body><script>throw 1</script></body></html>`), nil
		case "/component.json":
			return componentTestResponse(200, "application/json", jsonString(componentTemplateFixture())), nil
		default:
			t.Fatal("unexpected upstream URL")
			return nil, nil
		}
	}), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	result, err := fetchComponentTemplate(context.Background(), client, "https://widgets.example.org/page")
	if err != nil || result.Manifest.ID != "example/bookmarks" || result.SourceURL != "https://widgets.example.org/component.json" || len(result.SHA256) != 64 {
		t.Fatalf("discovery failed: %#v %v", result, err)
	}
	if len(calls) != 2 {
		t.Fatalf("unexpected publisher request count: %v", calls)
	}
}

func TestComponentTemplateNetworkBoundsAndRedirects(t *testing.T) {
	count := 0
	client := &http.Client{Transport: componentTestTransport(func(request *http.Request) (*http.Response, error) {
		count++
		response := componentTestResponse(302, "text/plain", "")
		response.Header.Set("Location", "http://169.254.169.254/latest/meta-data/")
		return response, nil
	}), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for _, target := range []string{"http://127.0.0.1/", "http://169.254.169.254/", "file:///etc/passwd", "http://localhost/", "https://example.org:65536/"} {
		if _, err := fetchComponentTemplate(context.Background(), client, target); err == nil {
			t.Fatalf("unsafe target accepted: %s", target)
		}
	}
	if count != 0 {
		t.Fatal("reserved or invalid targets reached the transport")
	}
	if _, err := fetchComponentTemplate(context.Background(), client, "https://widgets.example.org/redirect"); err == nil || count != 1 {
		t.Fatal("unsafe redirect was followed")
	}
	client.Transport = componentTestTransport(func(request *http.Request) (*http.Response, error) {
		return componentTestResponse(200, "application/json", strings.Repeat("x", (64<<10)+1)), nil
	})
	if _, err := fetchComponentTemplate(context.Background(), client, "https://widgets.example.org/large"); err == nil {
		t.Fatal("oversize template accepted")
	}
	client.Transport = componentTestTransport(func(request *http.Request) (*http.Response, error) {
		return componentTestResponse(200, "text/html", "<html><head></head><body>Ordinary website</body></html>"), nil
	})
	if _, err := fetchComponentTemplate(context.Background(), client, "https://widgets.example.org/"); err == nil {
		t.Fatal("ordinary website was treated as an installable component")
	}
}

func TestComponentTemplatePreviewAuthorizesWithoutSavingPage(t *testing.T) {
	app, err := Open(coreConfig(t, false))
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	owner := newAppTestBrowser(t, app)
	owner.bootstrap()
	owner.ok("POST", "/setup", map[string]any{"siteName": "Template test", "mode": ModePublicRead, "username": "owner",
		"displayName": "Owner", "password": "a valid test password", "seedDemo": true})
	bootstrap := owner.bootstrap()
	space := coreSpace(bootstrap, "shared")
	before := owner.ok("GET", "/dashboard?spaceId="+space, nil)["page"]
	path := "/spaces/" + space + "/component-templates/preview"
	preview := owner.ok("POST", path, map[string]any{"manifest": componentTemplateFixture()})
	if len(preview["sha256"].(string)) != 64 {
		t.Fatal("missing immutable content digest")
	}
	if !reflect.DeepEqual(before, owner.ok("GET", "/dashboard?spaceId="+space, nil)["page"]) {
		t.Fatal("preview modified the page")
	}
	guest := newAppTestBrowser(t, app)
	guest.bootstrap()
	if status, _ := guest.call("POST", path, map[string]any{"manifest": componentTemplateFixture()}); status != 401 {
		t.Fatalf("public reader could fetch component templates: %d", status)
	}
	owner.csrf = "invalid"
	if status, _ := owner.call("POST", path, map[string]any{"manifest": componentTemplateFixture()}); status != 403 {
		t.Fatalf("missing CSRF was accepted: %d", status)
	}
}

func TestComponentTemplateReferenceIsBoundedData(t *testing.T) {
	ref := map[string]any{"id": "example/bookmarks", "version": "1.0.0", "sha256": strings.Repeat("a", 64), "sourceUrl": "https://example.org/component.json"}
	if err := validateComponentTemplateReference(ref); err != nil {
		t.Fatal(err)
	}
	ref["script"] = "https://example.org/execute.js"
	if err := validateComponentTemplateReference(ref); err == nil {
		t.Fatal("executable reference metadata accepted")
	}
	delete(ref, "script")
	ref["sourceUrl"] = "http://127.0.0.1/"
	if err := validateComponentTemplateReference(ref); err == nil {
		t.Fatal("private source URL accepted")
	}
}
