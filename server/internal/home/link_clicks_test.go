package home

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestLinkClicksHTTP(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Click fixture", "mode": ModePrivateMulti, "username": "owner", "displayName": "Owner", "password": "click fixture password 2026", "seedDemo": false})
			boot := owner.bootstrap()
			shared, personal := coreSpace(boot, "shared"), coreSpace(boot, "personal")
			base := "/spaces/" + shared
			statsPath := base + "/navigation/click-stats"
			category := func(name string) string {
				return owner.ok("POST", base+"/categories", map[string]any{"name": name, "icon": "lucide:folder", "parentId": nil, "sortOrder": 0})["id"].(string)
			}
			catA, catB := category("Alpha"), category("Bravo")
			makeLink := func(space, title string, cat any) map[string]any {
				in := coreLink(title, "https://click.example.invalid/"+newID())
				in["iconMode"] = "manual"
				in["categoryId"] = cat
				return owner.ok("POST", "/spaces/"+space+"/links", in)
			}
			link := makeLink(shared, "Clicked", catA)
			id := link["id"].(string)
			zero := makeLink(shared, "Never clicked", nil)
			zeroID := zero["id"].(string)
			private := makeLink(personal, "Private", nil)
			privateID := private["id"].(string)
			clickPath := base + "/links/" + id + "/clicks"
			click := func(event, entry string) map[string]any { return map[string]any{"eventId": event, "entry": entry} }
			stats := func(query string) map[string]any { return owner.ok("GET", statsPath+query, nil) }
			total := func() float64 { return stats("")["summary"].(map[string]any)["totalClicks"].(float64) }
			beforeNav := owner.ok("GET", base+"/navigation", nil)
			beforePage := owner.ok("GET", base+"/page", nil)
			t.Run("baseline_and_idempotent_activation", func(t *testing.T) {
				initial := stats("")
				if initial["total"] != float64(2) || len(initial["items"].([]any)) != 2 || initial["summary"].(map[string]any)["neverClickedLinks"] != float64(2) || initial["recordedFrom"] == "" {
					t.Fatalf("bad empty baseline: %v", initial)
				}
				days := initial["days"].([]any)
				if days[0].(map[string]any)["tracked"] != false || days[len(days)-1].(map[string]any)["tracked"] != true {
					t.Fatal("pre-install days incorrectly represented as observed zeros")
				}
				item := initial["items"].([]any)[0].(map[string]any)
				if item["lastClickedAt"] != nil || item["firstClickedAt"] != nil {
					t.Fatal("invented historical click")
				}
				event := newID()
				if owner.ok("POST", clickPath, click(event, "primary"))["recorded"] != true {
					t.Fatal("first click not recorded")
				}
				if owner.ok("POST", clickPath, click(event, "primary"))["recorded"] != false || total() != 1 {
					t.Fatal("retry counted twice")
				}
				if status, _ := owner.call("POST", clickPath, click(event, "additional")); status != 409 {
					t.Fatal("event identity reused for another activation")
				}
				if status, _ := owner.call("POST", base+"/links/"+zeroID+"/clicks", click(event, "primary")); status != 409 {
					t.Fatal("event identity reused for another link")
				}
				for _, entry := range []string{"internal", "external", "additional"} {
					owner.ok("POST", clickPath, click(newID(), entry))
				}
				got := stats("")
				row := got["items"].([]any)[0].(map[string]any)
				if total() != 4 || row["linkId"] != id || row["periodClicks"] != float64(4) || row["lastClickedAt"] == nil || row["firstClickedAt"] == nil {
					t.Fatalf("wrong aggregate %v", got)
				}
				if !reflect.DeepEqual(beforeNav["data"], owner.ok("GET", base+"/navigation", nil)["data"]) || beforeNav["revision"] != owner.ok("GET", base+"/navigation", nil)["revision"] || !reflect.DeepEqual(beforePage, owner.ok("GET", base+"/page", nil)) {
					t.Fatal("click changed content metadata/revision or layout")
				}
			})
			t.Run("parallel_counts_and_receipt_retention", func(t *testing.T) {
				initial := total()
				event := newID()
				replies := make(chan navigationEditHTTPResult, 20)
				for i := 0; i < 20; i++ {
					go func(i int) {
						eventID := event
						if i >= 10 {
							eventID = newID()
						}
						replies <- navigationEditTestRequest(server.URL, owner.client, owner.csrf, "", clickPath, click(eventID, "primary"))
					}(i)
				}
				for i := 0; i < 20; i++ {
					result := <-replies
					if result.err != nil || result.status != 200 {
						t.Fatalf("concurrent click failed %d %v", result.status, result.err)
					}
				}
				if total() != initial+11 {
					t.Fatalf("parallel count lost or duplicated: %v", total())
				}
				// An expired receipt is safely reclaimed without changing its historical
				// aggregate. The documented 24-hour retry window is intentionally bounded.
				if _, err := app.store.DB.Exec(app.store.Query("UPDATE link_click_receipts SET received_at=? WHERE event_id=?"), documentActivityStamp(time.Now().Add(-25*time.Hour)), event); err != nil {
					t.Fatal(err)
				}
				owner.ok("POST", clickPath, click(newID(), "primary"))
				var count int
				if err := app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM link_click_receipts WHERE event_id=?"), event).Scan(&count); err != nil || count != 0 {
					t.Fatal("expired receipt retained", err)
				}
				if total() != initial+12 {
					t.Fatal("receipt cleanup changed totals")
				}
			})
			t.Run("utc_ranges_zero_days_pagination_and_current_categories", func(t *testing.T) {
				date := time.Now().UTC().AddDate(0, 0, -40).Format(time.DateOnly)
				stamp := date + "T12:00:00.000000000Z"
				if _, err := app.store.DB.Exec(app.store.Query("UPDATE link_click_tracking SET recorded_from=? WHERE id=1"), date+"T00:00:00Z"); err != nil {
					t.Fatal(err)
				}
				if _, err := app.store.DB.Exec(app.store.Query("INSERT INTO link_click_days(link_id,space_id,day,entry,clicks) VALUES(?,?,?,'primary',7)"), id, shared, date); err != nil {
					t.Fatal(err)
				}
				if _, err := app.store.DB.Exec(app.store.Query("UPDATE link_click_totals SET clicks=clicks+7,first_clicked_at=? WHERE link_id=?"), stamp, id); err != nil {
					t.Fatal(err)
				}
				historical := stats("?from=" + date + "&to=" + date)
				if historical["summary"].(map[string]any)["periodClicks"] != float64(7) || len(historical["days"].([]any)) != 1 || historical["days"].([]any)[0].(map[string]any)["count"] != float64(7) {
					t.Fatal("inclusive UTC daily aggregate wrong")
				}
				emptyDate := time.Now().UTC().AddDate(0, 0, -39).Format(time.DateOnly)
				empty := stats("?from=" + emptyDate + "&to=" + emptyDate)
				if empty["summary"].(map[string]any)["periodClicks"] != float64(0) || empty["days"].([]any)[0].(map[string]any)["count"] != float64(0) {
					t.Fatal("missing zero day")
				}
				first := stats("?limit=1&offset=0")
				second := stats("?limit=1&offset=1")
				if first["hasMore"] != true || second["hasMore"] != false || second["items"].([]any)[0].(map[string]any)["linkId"] != zeroID || len(stats("?offset=10")["items"].([]any)) != 0 {
					t.Fatal("pagination/zero-click link missing")
				}
				if stats("?sort=lastClicked")["items"].([]any)[0].(map[string]any)["linkId"] != id {
					t.Fatal("last-click sort wrong")
				}
				if stats("?categoryId=")["total"] != float64(1) || stats("?categoryId=" + catB)["total"] != float64(0) {
					t.Fatal("empty/current category filters wrong")
				}
				in := coreLink("Clicked renamed", link["url"].(string))
				in["iconMode"] = "manual"
				in["categoryId"] = catB
				owner.ok("PUT", base+"/links/"+id, in)
				if stats("?categoryId=" + catA)["total"] != float64(0) || stats("?categoryId=" + catB)["summary"].(map[string]any)["totalClicks"] != total() {
					t.Fatal("moving/renaming link lost or duplicated counts")
				}
				if stats("?linkId=" + id)["items"].([]any)[0].(map[string]any)["title"] != "Clicked renamed" {
					t.Fatal("stale link metadata in statistics")
				}
				for _, query := range []string{"?from=not-a-date", "?from=2026-02-29", "?from=2025-01-01&to=2026-01-02", "?from=2026-10-02&to=2026-10-01", "?limit=0", "?limit=201", "?offset=-1", "?sort=title", "?limit=1&limit=2", "?unknown=1"} {
					if status, _ := owner.call("GET", statsPath+query, nil); status != 400 {
						t.Fatalf("invalid filter %s: %d", query, status)
					}
				}
			})
			t.Run("csrf_space_read_only_member_and_pat_scope", func(t *testing.T) {
				initial := total()
				anon := newCoreBrowser(t, server.URL)
				anon.bootstrap()
				if status, _ := anon.call("POST", clickPath, click(newID(), "primary")); status != 401 {
					t.Fatal("private anonymous click accepted")
				}
				if status, _ := anon.call("GET", statsPath, nil); status != 401 {
					t.Fatal("anonymous aggregate exposed")
				}
				result := accountProfileRawCall(t, owner.client, server.URL, "POST", clickPath, click(newID(), "primary"), "bad-csrf", "")
				if result.status != 403 {
					t.Fatal("missing CSRF protection")
				}
				for _, body := range []any{click("short", "primary"), click(newID(), "unknown"), map[string]any{"eventId": newID(), "entry": "primary", "userId": "injected"}} {
					if status, _ := owner.call("POST", clickPath, body); status != 400 {
						t.Fatal("invalid click input accepted")
					}
				}
				if status, _ := owner.call("POST", base+"/links/"+privateID+"/clicks", click(newID(), "primary")); status != 404 {
					t.Fatal("cross-space link click accepted")
				}
				if status, _ := owner.call("GET", statsPath+"?linkId="+privateID, nil); status != 404 {
					t.Fatal("cross-space link exposed")
				}
				owner.ok("POST", "/admin/users", map[string]any{"username": "clickmember", "displayName": "Member", "password": "click member password 2026"})
				member := newCoreBrowser(t, server.URL)
				member.bootstrap()
				member.ok("POST", "/auth/login", map[string]any{"username": "clickmember", "password": "click member password 2026"})
				member.bootstrap()
				member.ok("POST", clickPath, click(newID(), "primary"))
				member.ok("GET", statsPath, nil)
				if status, _ := member.call("GET", "/spaces/"+personal+"/navigation/click-stats", nil); status != 404 {
					t.Fatal("member sees another personal space")
				}
				if status, _ := member.call("POST", "/spaces/"+personal+"/links/"+privateID+"/clicks", click(newID(), "primary")); status != 404 {
					t.Fatal("member writes another personal count")
				}
				ib := integrationBrowser(t, server.URL)
				ib.client = owner.client
				ib.csrf = owner.csrf
				token, _ := ib.token(shared, "", "navigation:read")
				reply := accountProfileRawCall(t, owner.client, server.URL, "GET", statsPath, nil, "", token)
				if reply.status != 200 || reply.headers.Get("Cache-Control") != "no-store" {
					t.Fatal("read-only PAT cannot read private noncached stats")
				}
				reply = accountProfileRawCall(t, owner.client, server.URL, "POST", clickPath, click(newID(), "primary"), "", token)
				if reply.status != 403 {
					t.Fatal("PAT fabricated a human activation")
				}
				reply = accountProfileRawCall(t, owner.client, server.URL, "GET", "/spaces/"+personal+"/navigation/click-stats", nil, "", token)
				if reply.status != 404 {
					t.Fatal("PAT scope leaked stats")
				}
				unrelated, _ := ib.token(shared, "", "pages:read")
				reply = accountProfileRawCall(t, owner.client, server.URL, "GET", statsPath, nil, "", unrelated)
				if reply.status != 403 {
					t.Fatal("missing navigation:read accepted")
				}
				resultMCP := ib.tool(token, "navigation_click_stats", map[string]any{"spaceId": shared, "input": map[string]any{"linkId": id}}, "")
				if resultMCP["total"] != float64(1) || resultMCP["summary"].(map[string]any)["totalClicks"] != total() {
					t.Fatal("MCP/HTTP statistics diverged")
				}
				ib.tool(token, "navigation_click_stats", map[string]any{"spaceId": personal, "input": map[string]any{}}, "not_found")
				if total() != initial+1 {
					t.Fatal("rejected requests changed count")
				}
			})
			t.Run("delete_cascades_and_public_read_activation", func(t *testing.T) {
				doomed := makeLink(shared, "To delete", nil)["id"].(string)
				owner.ok("POST", base+"/links/"+doomed+"/clicks", click(newID(), "primary"))
				owner.ok("DELETE", base+"/links/"+doomed, nil)
				for _, table := range []string{"link_click_totals", "link_click_days", "link_click_receipts"} {
					var n int
					if err := app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM "+table+" WHERE link_id=?"), doomed).Scan(&n); err != nil || n != 0 {
						t.Fatal("deleted link retained statistics", table, err)
					}
				}
				if status, _ := owner.call("POST", base+"/links/"+doomed+"/clicks", click(newID(), "primary")); status != 404 {
					t.Fatal("deleted link resurrected")
				}
				owner.ok("PUT", "/settings", map[string]any{"siteName": "Click fixture", "mode": ModePublicRead, "registrationEnabled": false})
				owner.bootstrap()
				owner.ok("POST", "/auth/login", map[string]any{"username": "owner", "password": "click fixture password 2026"})
				owner.bootstrap()
				owner.ok("PUT", base, map[string]any{"name": "Shared", "published": true})
				anon := newCoreBrowser(t, server.URL)
				anon.bootstrap()
				anon.ok("POST", clickPath, click(newID(), "primary"))
				if status, _ := anon.call("GET", statsPath, nil); status != 401 {
					t.Fatal("public browsing exposes analytics")
				}
				if status, _ := anon.call("POST", "/spaces/"+personal+"/links/"+privateID+"/clicks", click(newID(), "primary")); status != 404 {
					t.Fatal("anonymous personal count accepted")
				}
				raw := accountProfileRawCall(t, anon.client, server.URL, "POST", clickPath, click(newID(), "primary"), "", "")
				if raw.status != 403 {
					t.Fatal("public click bypasses CSRF")
				}
			})
			t.Run("receipt_storage_has_no_visitor_identifiers", func(t *testing.T) {
				rows, err := app.store.DB.Query("SELECT * FROM link_click_receipts LIMIT 1")
				if err != nil {
					t.Fatal(err)
				}
				columns, err := rows.Columns()
				_ = rows.Close()
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(columns, []string{"space_id", "event_id", "link_id", "entry", "received_at"}) {
					t.Fatalf("unexpected receipt identifiers: %v", columns)
				}
			})
		})
	}
}

func TestLinkClickStatsInput(t *testing.T) {
	now := time.Date(2026, 10, 29, 2, 3, 4, 0, time.UTC)
	in := linkClickStatsInput{Limit: 50, Sort: "clicks"}
	from, to, err := validateLinkClickStatsInput(&in, now)
	if err != nil || from.Format(time.DateOnly) != "2026-09-30" || to.Format(time.DateOnly) != "2026-10-29" {
		t.Fatal("default inclusive 30 days", in, err)
	}
	in = linkClickStatsInput{From: "2024-01-01", To: "2024-12-31", Limit: 200, Sort: "lastClicked"}
	if _, _, err = validateLinkClickStatsInput(&in, now); err != nil {
		t.Fatal("366 day leap year rejected")
	}
	for _, event := range []string{"", strings.Repeat("a", 15), strings.Repeat("a", 129), "abcdefghijklmnop\n", "abcdefghijklmn op"} {
		if linkClickEventPattern.MatchString(event) {
			t.Fatalf("bad receipt ID accepted: %q", event)
		}
	}
	if !linkClickEventPattern.MatchString(newID()) {
		t.Fatal("UUID receipt rejected")
	}
}
