package home

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestComponentDataValidation(t *testing.T) {
	valid := map[string]string{
		"calendar.events":   `{"timezone":"Asia/Shanghai","windowStart":1792324800,"windowEnd":1792497600,"events":[{"id":"event-1","title":"Meeting","startAt":1792382400,"endAt":1792386000,"allDay":false}]}`,
		"weather.forecast":  `{"timezone":"UTC","latitude":0,"longitude":0,"current":{"time":1792382400,"temperature":0,"weatherCode":0,"isDay":false},"daily":[]}`,
		"metrics.summary":   `{"metrics":[{"id":"cpu","label":"CPU","value":null,"unit":"%"}]}`,
		"status.collection": `{"items":[{"id":"api","label":"API","status":"unknown"}]}`,
	}
	for schema, raw := range valid {
		if _, err := normalizeComponentData(schema, []byte(raw)); err != nil {
			t.Fatalf("valid %s rejected: %v", schema, err)
		}
	}
	d, err := normalizeComponentData("metrics.summary", []byte(valid["metrics.summary"]))
	if err != nil {
		t.Fatal(err)
	}
	m := d.(MetricsData).Metrics[0]
	if m.Value != nil || m.Status != "unknown" {
		t.Fatal("unknown metric was converted to zero")
	}
	for _, item := range []struct{ schema, raw string }{
		{"metrics.summary", `{"metrics":[{"id":"cpu","label":"CPU"}]}`},
		{"metrics.summary", `{"metrics":[{"id":"cpu","label":"CPU","value":1,"script":"fetch(secret)"}]}`},
		{"metrics.summary", `{"metrics":[{"id":"cpu","label":"CPU","value":1,"min":5,"max":5}]}`},
		{"weather.forecast", `{"timezone":"UTC","latitude":0,"longitude":0,"current":{"time":1792382400,"weatherCode":0,"isDay":true},"daily":[]}`},
		{"weather.forecast", `{"timezone":"UTC","latitude":null,"longitude":0,"daily":[]}`},
		{"calendar.events", `{"timezone":"UTC","windowStart":1792324800,"windowEnd":1792497600,"events":[{"id":"e","title":"Bad","startAt":1792382400,"endAt":1792386000,"allDay":false,"url":"javascript:alert(1)"}]}`},
		{"status.collection", `{"items":[{"id":"api","label":"API","status":"up","latencyMs":-1}]}`},
	} {
		if _, err := normalizeComponentData(item.schema, []byte(item.raw)); err == nil {
			t.Errorf("unsafe %s accepted: %s", item.schema, item.raw)
		}
	}
}

func TestComponentNormalizedSizeAndCalendarBoundaries(t *testing.T) {
	start := time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC).Unix()
	calendar := CalendarData{Timezone: "UTC", WindowStart: start, WindowEnd: start + 2*86400, Events: []CalendarEvent{}}
	for i := 0; i < 400; i++ {
		calendar.Events = append(calendar.Events, CalendarEvent{ID: fmt.Sprintf("event-%d", i), Title: "Event", StartAt: start + 3600, EndAt: start + 7200, Description: strings.Repeat("<", 1500)})
	}
	var input bytes.Buffer
	encoder := json.NewEncoder(&input)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(calendar); err != nil {
		t.Fatal(err)
	}
	if input.Len() >= 1<<20 {
		t.Fatal("fixture must exercise post-normalization expansion")
	}
	_, err := (&App{}).acceptIntegrationSnapshot(&Request{}, IntegrationSource{SchemaID: "calendar.events"}, integrationPushInput{RequestID: "encoded-limit", SchemaID: "calendar.events", SchemaVersion: 1, Data: input.Bytes()}, "")
	if err == nil || !strings.Contains(err.Error(), "1 MiB") {
		t.Fatalf("expanded normalized snapshot was not rejected before storage: %v", err)
	}
	calendar.Events = []CalendarEvent{{ID: "mismatched-day", Title: "Bad day", StartAt: start + 3600, EndAt: start + 7200, AllDay: true, StartDate: "0001-01-01", EndDate: "9999-12-31"}}
	raw, _ := json.Marshal(calendar)
	if _, err := normalizeComponentData("calendar.events", raw); err == nil {
		t.Fatal("all-day date/time mismatch accepted")
	}
	calendar.Events = []CalendarEvent{{ID: "point", Title: "Outside point", StartAt: start - 1, EndAt: start - 1}}
	raw, _ = json.Marshal(calendar)
	if _, err := normalizeComponentData("calendar.events", raw); err == nil {
		t.Fatal("point event before window was accepted")
	}
	calendar.Events[0].StartAt = start
	calendar.Events[0].EndAt = start
	raw, _ = json.Marshal(calendar)
	if _, err := normalizeComponentData("calendar.events", raw); err != nil {
		t.Fatal("point event at inclusive window start was rejected")
	}
	calendar.Events = []CalendarEvent{}
	calendar.WindowEnd = start + 91*86400
	raw, _ = json.Marshal(calendar)
	if _, err := normalizeComponentData("calendar.events", raw); err == nil {
		t.Fatal("91-day calendar window accepted")
	}
	zone, _ := time.LoadLocation("Europe/Berlin")
	first := time.Date(2026, 9, 1, 0, 0, 0, 0, zone)
	calendar.Timezone = zone.String()
	calendar.WindowStart = first.Unix()
	calendar.WindowEnd = first.AddDate(0, 0, 90).Unix()
	raw, _ = json.Marshal(calendar)
	if _, err := normalizeComponentData("calendar.events", raw); err != nil {
		t.Fatalf("90 local days crossing DST rejected: %v", err)
	}
}

func TestComponentNetworkBoundary(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "198.18.0.1", "::1", "fe80::1", "fd00:ec2::254", "::ffff:169.254.169.254", "64:ff9b::a00:1"} {
		for _, private := range []bool{false, true} {
			if integrationAllowedAddress(netip.MustParseAddr(raw), private) {
				t.Fatalf("blocked address accepted: %s private=%v", raw, private)
			}
		}
	}
	for _, raw := range []string{"10.2.3.4", "192.168.1.1", "fd10::1"} {
		ip := netip.MustParseAddr(raw)
		if integrationAllowedAddress(ip, false) || !integrationAllowedAddress(ip, true) {
			t.Fatalf("private opt-in failed: %s", raw)
		}
	}
	resolver := &iconTestResolver{ips: []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("169.254.169.254")}}
	calls := 0
	dial := func(context.Context, string, string) (net.Conn, error) {
		calls++
		return nil, errors.New("fixture dial")
	}
	if _, err := integrationPinnedDial(resolver, dial, true)(context.Background(), "tcp", "source.example.com:8080"); err == nil || calls != 0 {
		t.Fatal("mixed DNS result reached a forbidden address")
	}
	resolver.ips = []netip.Addr{netip.MustParseAddr("8.8.8.8")}
	var address string
	_, _ = integrationPinnedDial(resolver, func(_ context.Context, _ string, target string) (net.Conn, error) {
		address = target
		return nil, errors.New("fixture")
	}, false)(context.Background(), "tcp", "source.example.com:8080")
	if address != "8.8.8.8:8080" {
		t.Fatal("dial performed an unpinned second DNS lookup")
	}
	for _, raw := range []string{"file:///etc/passwd", "http://metadata.google.internal/", "http://user:pass@example.com/", "https://example.com/feed#token"} {
		if _, err := integrationRemoteURL(raw, true); err == nil {
			t.Fatalf("unsafe URL accepted: %s", raw)
		}
	}
}

func TestComponentHTTPRedirectAndBodyLimits(t *testing.T) {
	for _, mode := range []string{"redirect", "oversize", "failure", "valid"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Header.Get("Authorization") != "Bearer private-fixture" {
					t.Fatal("missing source bearer")
				}
				if mode == "failure" {
					return nil, fmt.Errorf("url https://example.com/?token=must-not-leak")
				}
				resp := &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"metrics":[]}`)), Request: r}
				if mode == "redirect" {
					resp.StatusCode = 302
					resp.Header.Set("Location", "http://169.254.169.254/latest/meta-data/")
				}
				if mode == "oversize" {
					resp.Body = io.NopCloser(strings.NewReader(strings.Repeat("x", (1<<20)+1)))
				}
				return resp, nil
			}), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			_, failure := fetchIntegrationBody(context.Background(), client, "https://source.example.com/data?token=must-not-leak", true, "private-fixture")
			if mode == "valid" {
				if failure != nil {
					t.Fatal(failure)
				}
			} else if failure == nil {
				t.Fatal("unsafe response accepted")
			}
			if failure != nil && (strings.Contains(failure.Error(), "must-not-leak") || strings.Contains(failure.Error(), "private-fixture")) {
				t.Fatal("failure leaked source credentials")
			}
			if calls != 1 {
				t.Fatal("blocked redirect was followed")
			}
		})
	}
}

func TestComponentWeatherProviderDayAcrossDST(t *testing.T) {
	source := IntegrationSource{Connection: map[string]string{"timezone": "Europe/Berlin", "latitude": "52.52", "longitude": "13.41"}}
	for _, test := range []struct {
		date   string
		offset int
	}{{"2026-10-26", 7200}, {"2026-03-30", 3600}} {
		midnight, _ := time.Parse("2006-01-02", test.date)
		stamp := midnight.Unix() - int64(test.offset)
		fixture := map[string]any{"utc_offset_seconds": test.offset, "current": map[string]any{"time": stamp, "temperature_2m": 0, "weather_code": 0, "is_day": 0}, "daily": map[string]any{"time": []int64{stamp}, "weather_code": []int{0}, "temperature_2m_max": []float64{2}, "temperature_2m_min": []float64{-1}}}
		raw, _ := json.Marshal(fixture)
		d, err := normalizeOpenMeteo(raw, source)
		if err != nil {
			t.Fatal(err)
		}
		if d.Daily[0].Date != test.date || d.Current.Time != stamp {
			t.Fatalf("provider date/instant changed across DST: %#v", d)
		}
		delete(fixture, "utc_offset_seconds")
		raw, _ = json.Marshal(fixture)
		if _, err = normalizeOpenMeteo(raw, source); err == nil {
			t.Fatal("missing UTC offset silently inferred")
		}
	}
}

func TestComponentSourceHTTP(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) { testComponentSourceHTTP(t, provider) })
	}
}
func testComponentSourceHTTP(t *testing.T, provider string) {
	c := coreConfig(t, false)
	c.StorageProvider = provider
	if provider == "postgres" {
		c.DatabaseURL = os.Getenv("LINGSHU_TEST_COMPONENTS_POSTGRES_URL")
		if c.DatabaseURL == "" {
			t.Skip("requires fresh LINGSHU_TEST_COMPONENTS_POSTGRES_URL")
		}
	}
	app, openErr := Open(c)
	if openErr != nil {
		t.Fatal(openErr)
	}
	stopIntegrationFixtureWorkers(t, app)
	server := httptest.NewServer(app)
	t.Cleanup(func() { server.Close(); _ = app.Close() })
	b := integrationBrowser(t, server.URL)
	b.boot()
	b.object("POST", "/api/v1/setup", map[string]any{"siteName": "Component fixture", "mode": "private_multi", "username": "component-owner", "displayName": "Owner", "password": "component-fixture-password", "seedDemo": false}, 201, "")
	space := integrationSpace(t, b.boot(), "shared")
	ids, next, err := app.integrationSchedule(context.Background())
	if err != nil || len(ids) != 0 || !next.IsZero() {
		t.Fatalf("empty sources created a timer: %v %v %v", ids, next, err)
	}
	create := func(schema string) map[string]any {
		return b.object("POST", "/api/v1/spaces/"+space+"/sources", map[string]any{"name": schema, "kind": "external-push", "schemaId": schema, "schemaVersion": 1, "connection": map[string]string{}, "sync": map[string]any{"mode": "push"}, "enabled": true}, 201, "")
	}
	source := create("metrics.summary")
	id := source["id"].(string)
	sourceToken, _ := b.token(space, id, "sources:read", "datasets:write")
	push := map[string]any{"requestId": "first-metrics", "expectedRevision": "0", "schemaId": "metrics.summary", "schemaVersion": 1, "data": map[string]any{"metrics": []any{map[string]any{"id": "cpu", "label": "CPU", "value": nil}}}}
	receipt := b.object("PUT", "/api/v1/sources/"+id+"/snapshot", push, 200, "")
	replay := b.object("PUT", "/api/v1/sources/"+id+"/snapshot", push, 200, "")
	if !reflect.DeepEqual(receipt, replay) {
		t.Fatal("push replay changed its receipt")
	}
	push["requestId"] = "stale-revision"
	b.call("PUT", "/api/v1/sources/"+id+"/snapshot", push, 409, "")
	current := b.object("GET", "/api/v1/sources/"+id+"/snapshot", nil, 200, "")
	if current["revision"] != "1" {
		t.Fatal("failed push overwrote snapshot")
	}
	// Expired replay IDs cannot bypass the snapshot revision guard. Retention is
	// bounded during accepted pushes without creating an idle cleanup timer.
	if _, err := app.store.DB.Exec(app.store.Query("UPDATE integration_receipts SET received_at=? WHERE source_id=?"), "2000-01-01T00:00:00Z", id); err != nil {
		t.Fatal(err)
	}
	push["requestId"] = "first-metrics"
	b.call("PUT", "/api/v1/sources/"+id+"/snapshot", push, 409, "")
	tx, err := app.store.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 260; i++ {
		_, err = tx.Exec(app.store.Query("INSERT INTO integration_receipts(source_id,request_id,payload_hash,receipt_json,received_at) VALUES(?,?,?,?,?)"), id, fmt.Sprintf("retention-%03d", i), "fixture-hash", `{}`, integrationStamp(time.Now().Add(-time.Hour)))
		if err != nil {
			_ = tx.Rollback()
			t.Fatal(err)
		}
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	push["requestId"] = "new-revision"
	push["expectedRevision"] = "1"
	b.call("PUT", "/api/v1/sources/"+id+"/snapshot", push, 200, "")
	var retained int
	if err = app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM integration_receipts WHERE source_id=?"), id).Scan(&retained); err != nil || retained != 256 {
		t.Fatalf("receipt retention: %d %v", retained, err)
	}
	// Credentials never cross origins implicitly. Tests stop the real worker,
	// exercise its claimed-job storage path and never contact a public endpoint.
	privateBearer := "fixture-bearer-never-send-to-network"
	poll := b.object("POST", "/api/v1/spaces/"+space+"/sources", map[string]any{"name": "Status poll", "kind": "external-json", "schemaId": "status.collection", "schemaVersion": 1, "connection": map[string]string{}, "sync": map[string]any{"mode": "poll"}, "enabled": true, "secret": map[string]any{"url": "https://old.example.com/status?token=fixture-url-secret", "bearerToken": privateBearer}}, 201, "")
	pollID := poll["id"].(string)
	projection, _ := json.Marshal(poll)
	if bytes.Contains(projection, []byte(privateBearer)) || bytes.Contains(projection, []byte("fixture-url-secret")) {
		t.Fatal("source projection leaked credentials")
	}
	update := map[string]any{"expectedConfigRevision": "1", "name": poll["name"], "enabled": true, "connection": poll["connection"], "sync": poll["sync"], "secret": map[string]any{"url": "https://new.example.com/status"}}
	b.call("PUT", "/api/v1/sources/"+pollID, update, 400, "")
	unchanged := b.object("GET", "/api/v1/sources/"+pollID, nil, 200, "")
	if unchanged["configRevision"] != "1" {
		t.Fatal("rejected secret rotation mutated configuration")
	}
	update["secret"] = map[string]any{"url": "https://new.example.com/status", "clearBearerToken": true}
	poll = b.object("PUT", "/api/v1/sources/"+pollID, update, 200, "")
	stored, err := app.loadIntegrationSource(context.Background(), app.store.DB, pollID)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := app.decryptIntegrationSecret(pollID, stored.credentialCipher)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plain, privateBearer) || strings.Contains(plain, "clearBearerToken") {
		t.Fatal("cleared credential or control flag remained in encrypted source payload")
	}
	job, err := app.claimIntegrationTraffic(context.Background(), pollID)
	if err != nil || job == nil {
		t.Fatalf("enabled source did not yield a job: %v", err)
	}
	good := StatusData{Items: []StatusItem{{ID: "api", Label: "API", Status: "up"}}}
	if err = app.persistComponentIntegration(context.Background(), *job, good, nil); err != nil {
		t.Fatal(err)
	}
	if err = app.persistComponentIntegration(context.Background(), *job, StatusData{}, nil); err != nil {
		t.Fatal(err)
	}
	last := b.object("GET", "/api/v1/sources/"+pollID+"/snapshot", nil, 200, "")
	meta := last["meta"].(map[string]any)
	if last["revision"] != "1" || meta["freshness"] != "stale" || meta["lastError"] == nil {
		t.Fatal("invalid normalized job did not preserve snapshot and record lastError")
	}
	update["expectedConfigRevision"] = poll["configRevision"]
	update["enabled"] = false
	delete(update, "secret")
	b.object("PUT", "/api/v1/sources/"+pollID, update, 200, "")
	if err = app.persistComponentIntegration(context.Background(), *job, good, nil); err != nil {
		t.Fatal(err)
	}
	last = b.object("GET", "/api/v1/sources/"+pollID+"/snapshot", nil, 200, "")
	if last["revision"] != "1" || last["meta"].(map[string]any)["freshness"] != "disabled" {
		t.Fatal("disabled source accepted a stale in-flight result")
	}
	calendar := create("calendar.events")
	calendarID := calendar["id"].(string)
	day := time.Now().UTC().Add(24 * time.Hour).Format("20060102")
	ics := "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Home//Test//EN\r\nBEGIN:VEVENT\r\nUID:one\r\nDTSTART:" + day + "T090000Z\r\nDTEND:" + day + "T100000Z\r\nSUMMARY:Test meeting\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	importBody := map[string]any{"requestId": "ics-import-1", "expectedRevision": "0", "icsText": ics, "timezone": "UTC"}
	importReceipt := b.object("POST", "/api/v1/sources/"+calendarID+"/calendar-import", importBody, 200, "")
	if replay := b.object("POST", "/api/v1/sources/"+calendarID+"/calendar-import", importBody, 200, ""); !reflect.DeepEqual(importReceipt, replay) {
		t.Fatal("ICS replay changed its receipt")
	}
	importBody["icsText"] = strings.ReplaceAll(ics, "Test meeting", "Changed meeting")
	b.call("POST", "/api/v1/sources/"+calendarID+"/calendar-import", importBody, 409, "")
	var snapshot string
	if err := app.store.DB.QueryRow(app.store.Query("SELECT data_json FROM integration_snapshots WHERE source_id=?"), calendarID).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(snapshot, "BEGIN:VCALENDAR") {
		t.Fatal("raw ICS persisted")
	}
	// A saved component prevents deletion even when its placement is hidden.
	page := b.object("GET", "/api/v1/spaces/"+space+"/page", nil, 200, "")
	config := page["config"].(map[string]any)
	bindings := config["bindings"].(map[string]any)
	bindings["external-metrics"] = map[string]any{"datasetId": "source:" + id, "space": "current-page-space", "query": map[string]any{}}
	view := map[string]any{"id": "metrics-fixture", "panel": map[string]any{"id": "builtin/metrics"}, "inputs": map[string]any{"metrics": "external-metrics"}, "settings": map[string]any{"showBars": true}}
	config["views"] = append(config["views"].([]any), view)
	config["layout"].(map[string]any)["placements"].(map[string]any)["metrics-fixture"] = map[string]any{"base": map[string]any{"kind": "hidden"}}
	page = b.object("PUT", "/api/v1/spaces/"+space+"/page", map[string]any{"name": page["name"], "expectedRevision": page["revision"], "config": config}, 200, "")
	b.call("DELETE", "/api/v1/sources/"+id, map[string]any{"expectedConfigRevision": "1", "detachUnusedBindings": true}, 409, "")
	config = page["config"].(map[string]any)
	views := config["views"].([]any)
	config["views"] = views[:len(views)-1]
	delete(config["layout"].(map[string]any)["placements"].(map[string]any), "metrics-fixture")
	page = b.object("PUT", "/api/v1/spaces/"+space+"/page", map[string]any{"name": page["name"], "expectedRevision": page["revision"], "config": config}, 200, "")
	b.call("DELETE", "/api/v1/sources/"+id, map[string]any{"expectedConfigRevision": "1"}, 409, "")
	b.call("DELETE", "/api/v1/sources/"+id, map[string]any{"expectedConfigRevision": "1", "detachUnusedBindings": true}, 204, "")
	b.call("GET", "/api/v1/sources/"+id, nil, 401, sourceToken)
	after := b.object("GET", "/api/v1/spaces/"+space+"/page", nil, 200, "")
	if after["revision"] == page["revision"] {
		t.Fatal("binding detach failed to bump page revision")
	}
	encoded, _ := json.Marshal(after["config"])
	if bytes.Contains(encoded, []byte("source:"+id)) {
		t.Fatal("orphaned binding survived source deletion")
	}
	for _, table := range []string{"integration_sources", "integration_snapshots", "integration_receipts", "integration_tokens"} {
		column := "source_id"
		if table == "integration_sources" {
			column = "id"
		}
		var count int
		if err := app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM "+table+" WHERE "+column+"=?"), id).Scan(&count); err != nil || count != 0 {
			t.Fatalf("source deletion left %s data: %v count=%d", table, err, count)
		}
	}
}
