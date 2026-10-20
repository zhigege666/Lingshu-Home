package home

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestNavigationRoutingSettingsAndEndpoints(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		t.Run(fmt.Sprintf("postgres-%v", postgres), func(t *testing.T) {
			config := autoIconConfig(t, postgres)
			app, err := Open(config)
			if err != nil {
				t.Fatal(err)
			}
			defer app.Close()
			owner := newAppTestBrowser(t, app)
			if owner.bootstrap()["autoSelectEndpoint"] != true {
				t.Fatal("new instance must default to automatic selection")
			}
			owner.ok("POST", "/setup", map[string]any{"siteName": "Routing", "mode": ModeOpenEdit, "username": "owner", "displayName": "Owner", "password": "a valid test password"})
			space := coreSpace(owner.bootstrap(), "shared")
			before, err := app.loadSettings(context.Background(), app.store.DB)
			if err != nil {
				t.Fatal(err)
			}
			owner.ok("PUT", "/settings/navigation", map[string]any{"autoSelectEndpoint": false})
			after, err := app.loadSettings(context.Background(), app.store.DB)
			if err != nil {
				t.Fatal(err)
			}
			want := before
			want.AutoSelectEndpoint = false
			if !reflect.DeepEqual(want, after) {
				t.Fatal("navigation preference changed unrelated settings or security epoch")
			}
			owner.ok("PUT", "/settings", map[string]any{"siteName": "Renamed", "mode": ModeOpenEdit, "registrationEnabled": false})
			if owner.bootstrap()["autoSelectEndpoint"] != false {
				t.Fatal("legacy settings mutation reset omitted preference")
			}
			guest := newAppTestBrowser(t, app)
			guest.bootstrap()
			if status, _ := guest.call("PUT", "/settings/navigation", map[string]any{"autoSelectEndpoint": true}); status != 401 && status != 403 {
				t.Fatalf("guest changed instance routing: %d", status)
			}
			for _, value := range []map[string]any{{}, {"autoSelectEndpoint": nil}, {"autoSelectEndpoint": "true"}, {"autoSelectEndpoint": true, "mode": ModePublicRead}} {
				if status, _ := owner.call("PUT", "/settings/navigation", value); status != 400 {
					t.Fatalf("invalid narrow mutation accepted: %d", status)
				}
			}
			input := map[string]any{"title": "NAS", "url": "https://external.example.org/private?token=keep#fragment", "icon": "lucide:link", "iconMode": "manual", "endpoints": []map[string]any{{"label": "LAN", "url": "http://192.168.1.10:5000/private?token=keep", "route": "internal", "probePath": "/healthz"}, {"label": "WAN", "url": "https://external.example.org/", "route": "external"}, {"label": "Docs", "url": "https://docs.example.org/"}}}
			created := owner.ok("POST", "/spaces/"+space+"/links", input)
			endpoints := created["endpoints"].([]any)
			if len(endpoints) != 3 || endpoints[0].(map[string]any)["route"] != "internal" || endpoints[0].(map[string]any)["probePath"] != "/healthz" {
				t.Fatal("routing fields did not round-trip")
			}
			if len(endpoints[2].(map[string]any)) != 2 {
				t.Fatal("legacy endpoint projection changed")
			}
			if err := app.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := Open(config)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			persisted, err := reopened.loadSettings(context.Background(), reopened.store.DB)
			if err != nil || persisted.AutoSelectEndpoint {
				t.Fatal("routing preference did not survive restart")
			}
			var raw string
			if err = reopened.store.DB.QueryRow(reopened.store.Query("SELECT endpoints FROM links WHERE id=?"), created["id"]).Scan(&raw); err != nil {
				t.Fatal(err)
			}
			var saved []any
			if json.Unmarshal([]byte(raw), &saved) != nil || !reflect.DeepEqual(endpoints, saved) {
				t.Fatal("bookmark routing data changed on restart")
			}
		})
	}
}

func TestNavigationRoutingOwnerlessAndBearerBoundary(t *testing.T) {
	app, err := Open(coreConfig(t, false))
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	browser := newAppTestBrowser(t, app)
	browser.bootstrap()
	browser.ok("POST", "/setup", map[string]any{"siteName": "Open", "mode": ModeOpenEdit})
	browser.ok("PUT", "/settings/navigation", map[string]any{"autoSelectEndpoint": false})
	if browser.bootstrap()["autoSelectEndpoint"] != false {
		t.Fatal("ownerless open-edit preference did not save")
	}
	r := &Request{Bearer: true, Settings: Settings{Initialized: true, Mode: ModeOpenEdit}}
	if _, err := app.updateNavigationSettings(r); err == nil {
		t.Fatal("PAT can administer instance routing")
	}
}

func TestNavigationProbePathAndExternalDatasetBoundary(t *testing.T) {
	for _, path := range []string{"", "/", "/favicon.ico", "/healthz", "/api/health", "/v1/health-check~ready"} {
		if err := validateEndpointRouting(&Endpoint{Route: "internal", ProbePath: path}); err != nil {
			t.Fatalf("valid path rejected: %s", path)
		}
	}
	for _, endpoint := range []Endpoint{{Route: "LAN"}, {ProbePath: "/health"}, {Route: "internal", ProbePath: "//host/path"}, {Route: "internal", ProbePath: "/../health"}, {Route: "internal", ProbePath: "/a/./health"}, {Route: "internal", ProbePath: "/%2e%2e/health"}, {Route: "internal", ProbePath: "/health?token=secret"}, {Route: "internal", ProbePath: "/health#fragment"}, {Route: "internal", ProbePath: "/a\\b"}, {Route: "internal", ProbePath: "/空白"}, {Route: "internal", ProbePath: "/" + strings.Repeat("x", 256)}} {
		if err := validateEndpointRouting(&endpoint); err == nil {
			t.Fatalf("unsafe probe path/route accepted: %#v", endpoint)
		}
	}
	app, err := Open(coreConfig(t, false))
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	r := &Request{App: app, HTTP: httptest.NewRequest("GET", "/", nil), Q: app.store.DB}
	in := integrationNavigationInput{Categories: []integrationCategoryInput{}, Links: []integrationLinkInput{{ExternalID: "remote", Title: "External", URL: "https://example.org", Icon: "lucide:link", Endpoints: []Endpoint{{Label: "LAN", URL: "http://192.168.1.10", Route: "internal"}}}}}
	if _, err := app.normalizeIntegrationNavigation(r, IntegrationSource{ID: "source", SpaceID: "space"}, in, time.Now()); err == nil {
		t.Fatal("remote dataset authorized browser network probes")
	}
}
