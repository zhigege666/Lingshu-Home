package home

import (
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func activityCompositionConfig(t *testing.T) map[string]any {
	t.Helper()
	config := cloneConfig(t, defaultPageConfig())
	config["bindings"].(map[string]any)["writing"] = map[string]any{"datasetId": "local-document-activity", "space": "current-page-space", "query": map[string]any{}}
	for index, presentation := range []string{"heatmap", "split", "month"} {
		id := "writing-" + presentation
		config["views"] = append(config["views"].([]any), map[string]any{"id": id, "panel": map[string]any{"id": "builtin/document-activity"}, "inputs": map[string]any{"activity": "writing"}, "settings": map[string]any{
			"presentation": presentation, "months": 6, "perspective": "mine", "sourceIds": []any{}, "showSummary": true, "recentLimit": 3, "detailLayout": "auto", "timezone": "local",
		}})
		config["layout"].(map[string]any)["placements"].(map[string]any)[id] = map[string]any{"base": map[string]any{"kind": "grid", "region": "main", "x": 0, "y": 20 + 3*index, "w": 12, "h": 3, "heightMode": "content", "locked": false}}
	}
	return cloneConfig(t, config)
}

func activityCompositionSettings(config map[string]any) map[string]any {
	return config["views"].([]any)[4].(map[string]any)["settings"].(map[string]any)
}

func TestDocumentActivityCompositionValidation(t *testing.T) {
	config := activityCompositionConfig(t)
	before := cloneConfig(t, config)
	if err := validatePageConfig(config); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(config, before) {
		t.Fatal("activity validation mutated existing page, settings, or placements")
	}
	legacy := defaultPageConfig()
	delete(legacy, "chrome")
	if err := validatePageConfig(legacy); err != nil {
		t.Fatalf("legacy page rejected: %v", err)
	}
	for _, test := range []struct {
		name, field string
		value       any
	}{
		{"presentation", "presentation", "year"}, {"perspective", "perspective", "actor:other"}, {"months", "months", 4}, {"fractional month", "months", 3.5},
		{"summary type", "showSummary", "true"}, {"record limit", "recentLimit", 4}, {"detail layout", "detailLayout", "drawer"},
		{"timezone", "timezone", "../private"}, {"server local timezone", "timezone", "Local"}, {"null timezone", "timezone", nil},
		{"source type", "sourceIds", "all"}, {"invalid source", "sourceIds", []any{"foreign"}}, {"duplicate source", "sourceIds", []any{strings.Repeat("a", 32), strings.Repeat("a", 32)}},
		{"layout in settings", "width", 24}, {"unknown setting", "date", "2026-10-01"},
	} {
		t.Run(test.name, func(t *testing.T) {
			invalidConfig := activityCompositionConfig(t)
			activityCompositionSettings(invalidConfig)[test.field] = test.value
			if err := validatePageConfig(invalidConfig); err == nil {
				t.Fatal("invalid activity setting accepted")
			}
		})
	}
	for _, zone := range []string{"local", "UTC", "Asia/Shanghai", "America/New_York"} {
		activityCompositionSettings(config)["timezone"] = zone
		if err := validatePageConfig(config); err != nil {
			t.Fatalf("valid timezone %q rejected: %v", zone, err)
		}
	}
	config = activityCompositionConfig(t)
	config["bindings"].(map[string]any)["writing"].(map[string]any)["query"] = map[string]any{"limit": 3}
	if err := validatePageConfig(config); err == nil {
		t.Fatal("activity filters accepted in shared binding query")
	}
	for _, presentation := range []string{"heatmap", "split", "month"} {
		template := componentTemplateFixture()
		template["renderer"] = "builtin/document-activity"
		template["dataSchema"] = map[string]any{"id": "documents.activity", "version": 1}
		template["settings"] = map[string]any{"presentation": presentation}
		if _, err := parseComponentTemplate([]byte(jsonString(template))); err != nil {
			t.Fatalf("activity template rejected: %v", err)
		}
		template["settings"].(map[string]any)["variant"] = "cards"
		if _, err := parseComponentTemplate([]byte(jsonString(template))); err == nil {
			t.Fatal("navigation setting accepted on activity template")
		}
	}
}

func TestDocumentActivityCompositionHTTPBindingsAndPublicProjection(t *testing.T) {
	config := coreConfig(t, false)
	config.DocumentRoots = []string{t.TempDir()}
	app, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.Close() })
	owner := newAppTestBrowser(t, app)
	owner.bootstrap()
	owner.ok("POST", "/setup", map[string]any{"siteName": "Activity panels", "mode": ModePublicRead, "username": "owner", "password": "activity fixture password", "seedDemo": true})
	boot := owner.bootstrap()
	shared, personal := coreSpace(boot, "shared"), coreSpace(boot, "personal")
	panels := boot["capabilities"].(map[string]any)["panelThemes"].([]any)
	found := false
	for _, panel := range panels {
		if panel == "builtin/document-activity" {
			found = true
		}
	}
	if !found {
		t.Fatal("bootstrap does not advertise document activity")
	}
	createSource := func(space, name string) string {
		root := filepath.Join(config.DocumentRoots[0], name)
		if err := os.MkdirAll(root, 0700); err != nil {
			t.Fatal(err)
		}
		return owner.ok("POST", "/spaces/"+space+"/document-sources", map[string]any{"name": name, "path": root, "readOnly": false, "defaultWrite": true, "scanIntervalSeconds": 60})["id"].(string)
	}
	sharedSource, personalSource := createSource(shared, "Shared writing"), createSource(personal, "Private writing")
	draft := activityCompositionConfig(t)
	activityCompositionSettings(draft)["sourceIds"] = []any{sharedSource}
	beforeNavigation := owner.ok("GET", "/spaces/"+shared+"/navigation", nil)
	page := owner.ok("GET", "/dashboard?spaceId="+shared, nil)["page"].(map[string]any)
	path := "/spaces/" + shared + "/page"
	stored := owner.ok("PUT", path, map[string]any{"name": "Writing dashboard", "config": draft, "expectedRevision": page["revision"]})
	if !reflect.DeepEqual(stored["config"], draft) {
		t.Fatal("activity roundtrip changed composition")
	}
	assertProjection := func(dashboard map[string]any) {
		t.Helper()
		datasets := dashboard["datasets"].(map[string]any)
		marker := datasets["writing"].(map[string]any)
		if marker["datasetId"] != "local-document-activity" || marker["schemaId"] != "documents.activity" || len(marker["data"].(map[string]any)) != 0 {
			t.Fatalf("private activity entered shared projection: %v", marker)
		}
		if datasets["navigation"].(map[string]any)["schemaId"] != "navigation.collection" {
			t.Fatal("activity binding broke other panels")
		}
	}
	guest := newAppTestBrowser(t, app)
	guest.bootstrap()
	assertProjection(guest.ok("GET", "/dashboard?spaceId="+shared, nil))
	integration := integrationBrowser(t, owner.base)
	integration.client, integration.csrf = owner.client, owner.csrf
	token, _ := integration.token(shared, "", "pages:read", "pages:write", "navigation:read")
	assertProjection(integration.object("GET", "/api/v1/dashboard?spaceId="+shared, nil, 200, token))
	body := map[string]any{"name": "Writing dashboard", "config": draft, "expectedRevision": stored["revision"]}
	integration.call("PUT", "/api/v1"+path, body, http.StatusForbidden, token)
	invalidConfig := cloneConfig(t, draft)
	activityCompositionSettings(invalidConfig)["sourceIds"] = []any{personalSource}
	if status, _ := owner.call("PUT", path, map[string]any{"name": "Bad source", "config": invalidConfig, "expectedRevision": stored["revision"]}); status != http.StatusBadRequest {
		t.Fatalf("foreign document directory accepted: %d", status)
	}
	invalidConfig = cloneConfig(t, draft)
	invalidConfig["views"].([]any)[4].(map[string]any)["inputs"] = map[string]any{"activity": "navigation"}
	if status, _ := owner.call("PUT", path, map[string]any{"name": "Bad schema", "config": invalidConfig, "expectedRevision": stored["revision"]}); status != http.StatusBadRequest {
		t.Fatalf("navigation bound as activity: %d", status)
	}
	if after := owner.ok("GET", "/spaces/"+shared+"/navigation", nil); !reflect.DeepEqual(after["data"], beforeNavigation["data"]) || after["revision"] != beforeNavigation["revision"] {
		t.Fatal("activity composition changed bookmarks")
	}
	owner.ok("PUT", "/settings", map[string]any{"siteName": "Activity panels", "mode": ModeOpenEdit, "registrationEnabled": false})
	guest.bootstrap()
	body["name"] = "Anonymous layout edit"
	guest.ok("PUT", path, body)
	assertProjection(guest.ok("GET", "/dashboard?spaceId="+shared, nil))
}
