package home

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Every automatic-icon fixture installs its transport before recovered work
// starts. Tests never contact a website or depend on public DNS/network timing.
type autoIconTransport struct {
	mu    sync.Mutex
	fn    func(*http.Request) (*http.Response, error)
	calls atomic.Int32
}

func (d *autoIconTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	d.calls.Add(1)
	d.mu.Lock()
	fn := d.fn
	d.mu.Unlock()
	if fn == nil {
		return nil, errors.New("offline automatic-icon fixture")
	}
	return fn(r)
}

func (d *autoIconTransport) set(fn func(*http.Request) (*http.Response, error)) {
	d.mu.Lock()
	d.fn = fn
	d.mu.Unlock()
}

func autoIconResponse(body []byte) *http.Response {
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: io.NopCloser(bytes.NewReader(body))}
}

// Reuse the dedicated icon test database without sharing or erasing its data.
// A random schema is the complete lifetime and cleanup boundary of each case.
func autoIconConfig(t *testing.T, postgres bool) Config {
	t.Helper()
	c := coreConfig(t, false)
	if !postgres {
		return c
	}
	dsn := os.Getenv("LINGSHU_TEST_ICONS_POSTGRES_URL")
	if dsn == "" {
		t.Skip("requires isolated LINGSHU_TEST_ICONS_POSTGRES_URL")
	}
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		t.Fatal("icon fixture requires a PostgreSQL URL")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal("cannot open isolated icon fixture database")
	}
	schema := "auto_icons_" + integrationID()
	if _, err = admin.Exec("CREATE SCHEMA " + schema); err != nil {
		_ = admin.Close()
		t.Fatal("cannot create isolated icon fixture schema")
	}
	t.Cleanup(func() {
		if _, err := admin.Exec("DROP SCHEMA " + schema + " CASCADE"); err != nil {
			t.Error("cannot remove isolated icon fixture schema")
		}
		_ = admin.Close()
	})
	query := u.Query()
	query.Set("search_path", schema)
	u.RawQuery = query.Encode()
	c.StorageProvider, c.DatabaseURL = "postgres", u.String()
	return c
}

type autoIconFixture struct {
	a         *App
	c         Config
	b         *iconHTTPBrowser
	space     string
	transport *autoIconTransport
}

func newAutoIconFixture(t *testing.T, postgres, owner, seed bool) *autoIconFixture {
	t.Helper()
	f := &autoIconFixture{c: autoIconConfig(t, postgres), transport: &autoIconTransport{}}
	var err error
	f.a, err = openWithIconHTTPClient(f.c, &http.Client{Transport: f.transport})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if f.a != nil {
			_ = f.a.Close()
		}
	})
	f.b = newIconHTTPBrowser(t, f.a)
	if f.b.bootstrap()["autoFetchIcons"] != true {
		t.Fatal("automatic icons must default on before setup")
	}
	input := map[string]any{"siteName": "Automatic icons", "mode": ModeOpenEdit, "seedDemo": seed}
	if owner {
		input["mode"], input["username"], input["password"], input["displayName"] = ModePrivateMulti, "auto-owner", "automatic-icon-owner-fixture-2026", "Auto owner"
	}
	f.b.object("POST", "/setup", input, 201)
	f.space = coreSpace(f.b.bootstrap(), "shared")
	return f
}

func (f *autoIconFixture) count(t *testing.T, table string) int {
	t.Helper()
	var count int
	if err := f.a.store.DB.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func autoIconWait(t *testing.T, description string, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for " + description)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func autoIconSignal(t *testing.T, ch <-chan string) string {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(6 * time.Second):
		t.Fatal("automatic fetch did not start")
		return ""
	}
}

func autoIconDrainGate(t *testing.T, a *App) {
	t.Helper()
	select {
	case a.iconFetchGate <- struct{}{}:
		<-a.iconFetchGate
	case <-time.After(6 * time.Second):
		t.Fatal("automatic fetch did not release the shared gate")
	}
}

func (f *autoIconFixture) link(t *testing.T, id string) (string, string, string) {
	t.Helper()
	var icon, mode, origin string
	if err := f.a.store.DB.QueryRow(f.a.store.Query("SELECT icon,icon_mode,icon_origin FROM links WHERE id=?"), id).Scan(&icon, &mode, &origin); err != nil {
		t.Fatal(err)
	}
	return icon, mode, origin
}

func (f *autoIconFixture) settings(t *testing.T) Settings {
	t.Helper()
	s, err := f.a.loadSettings(context.Background(), f.a.store.DB)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func (f *autoIconFixture) toggle(enabled bool) {
	s := f.settings(f.b.t)
	f.b.object("PUT", "/settings", map[string]any{"siteName": s.SiteName, "mode": s.Mode, "registrationEnabled": s.RegistrationEnabled, "autoFetchIcons": enabled}, 200)
}

func TestAutomaticIconsSQLite(t *testing.T)   { testAutomaticIcons(t, false) }
func TestAutomaticIconsPostgres(t *testing.T) { testAutomaticIcons(t, true) }

func testAutomaticIcons(t *testing.T, postgres bool) {
	t.Run("defaults-settings-import-and-mode", func(t *testing.T) {
		f := newAutoIconFixture(t, postgres, false, true)
		if f.count(t, "links") == 0 {
			t.Fatal("starter fixture is empty")
		}
		var automatic int
		if err := f.a.store.DB.QueryRow("SELECT COUNT(*) FROM links WHERE icon_mode<>'manual'").Scan(&automatic); err != nil || automatic != 0 || f.count(t, "icon_favicon_jobs") != 0 || f.transport.calls.Load() != 0 {
			t.Fatal("offline starter icons scheduled external work", err)
		}
		epoch := f.settings(t).AuthEpoch
		f.toggle(false)
		if f.settings(t).AuthEpoch != epoch {
			t.Fatal("icon-only toggle changed the authentication epoch")
		}
		f.b.object("PUT", "/settings", map[string]any{"siteName": "Renamed", "mode": ModeOpenEdit, "registrationEnabled": false}, 200)
		if f.b.bootstrap()["autoFetchIcons"] != false {
			t.Fatal("omitted setting did not preserve false")
		}
		f.b.object("PUT", "/settings", map[string]any{"siteName": "Renamed", "mode": ModeOpenEdit, "autoFetchIcons": nil}, 400)
		base := "/spaces/" + f.space
		in := coreLink("Default icon intent", "https://default.example.org/private?query=private")
		delete(in, "icon")
		link := f.b.object("POST", base+"/links", in, 201)
		if link["iconMode"] != "auto" || link["icon"] != "lucide:link" {
			t.Fatal("absent icon did not choose automatic fallback", link)
		}
		id := link["id"].(string)
		in["title"] = "Still automatic"
		if f.b.object("PUT", base+"/links/"+id, in, 200)["iconMode"] != "auto" {
			t.Fatal("ordinary edit changed icon intent")
		}
		in["icon"] = "lucide:star"
		if f.b.object("PUT", base+"/links/"+id, in, 200)["iconMode"] != "manual" {
			t.Fatal("explicit changed icon did not choose manual intent")
		}
		for _, bad := range []any{nil, "", "AUTO", true} {
			in["iconMode"] = bad
			f.b.object("PUT", base+"/links/"+id, in, 400)
		}
		markup := `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://import.example.org/a">Imported</A></DL>`
		f.b.object("POST", base+"/bookmarks/import", map[string]any{"html": markup, "duplicatePolicy": "skip"}, 200)
		if err := f.a.store.DB.QueryRow("SELECT COUNT(*) FROM links WHERE icon_mode='auto'").Scan(&automatic); err != nil || automatic != 1 {
			t.Fatal("bookmark import did not preserve explicit automatic intent", err)
		}
		f.toggle(true)
		if f.count(t, "icon_favicon_jobs") != 0 || f.transport.calls.Load() != 0 {
			t.Fatal("reenabling scanned old links")
		}
		// Private addresses remain valid navigation entries without remote work.
		private := coreLink("Local service", "http://127.0.0.1:8090/")
		delete(private, "icon")
		f.b.object("POST", base+"/links", private, 201)
		if f.count(t, "icon_favicon_jobs") != 0 {
			t.Fatal("private navigation URL was queued for retrieval")
		}
	})

	t.Run("inflight-origin-deduplication-and-cache", func(t *testing.T) {
		f := newAutoIconFixture(t, postgres, false, false)
		png := testIconPNG(t, 16, 16)
		started, release := make(chan string, 8), make(chan struct{})
		f.transport.set(func(r *http.Request) (*http.Response, error) {
			started <- r.URL.String()
			select {
			case <-release:
				return autoIconResponse(png), nil
			case <-r.Context().Done():
				return nil, r.Context().Err()
			}
		})
		base := "/spaces/" + f.space + "/links"
		one := coreLink("First", "https://same.example.org/private?token=never-forward#secret")
		delete(one, "icon")
		first := f.b.object("POST", base, one, 201)
		if first["icon"] != "lucide:link" || autoIconSignal(t, started) != "https://same.example.org/" {
			t.Fatal("save waited for network or forwarded private URL parts")
		}
		var jobID string
		var requested databaseTime
		if err := f.a.store.DB.QueryRow("SELECT id,requested_at FROM icon_favicon_jobs").Scan(&jobID, &requested); err != nil {
			t.Fatal(err)
		}
		two := coreLink("Second", "https://same.example.org/different")
		two["iconMode"] = "auto"
		second := f.b.object("POST", base, two, 201)
		one["title"] = "Edited while loading"
		f.b.object("PUT", base+"/"+first["id"].(string), one, 200)
		var afterID string
		var afterTime databaseTime
		if err := f.a.store.DB.QueryRow("SELECT id,requested_at FROM icon_favicon_jobs").Scan(&afterID, &afterTime); err != nil || afterID != jobID || !requested.Equal(afterTime.Time) {
			t.Fatal("same-origin write replaced an active task or its FIFO position", err)
		}
		manual := f.b.object("POST", base, coreLink("Manual", "https://same.example.org/manual"), 201)
		var beforeRevision int64
		if err := f.a.store.DB.QueryRow(f.a.store.Query("SELECT data_revision FROM spaces WHERE id=?"), f.space).Scan(&beforeRevision); err != nil {
			t.Fatal(err)
		}
		close(release)
		autoIconWait(t, "one deduplicated completed job", func() bool { return f.count(t, "icon_favicon_jobs") == 0 })
		ref, mode, origin := f.link(t, first["id"].(string))
		other, _, _ := f.link(t, second["id"].(string))
		kept, manualMode, _ := f.link(t, manual["id"].(string))
		if !strings.HasPrefix(ref, "asset:"+f.space+":") || ref != other || mode != "auto" || origin != "https://same.example.org/" || kept != "lucide:link" || manualMode != "manual" || f.transport.calls.Load() != 1 {
			t.Fatal("deduplicated result did not update exactly the automatic links")
		}
		var afterRevision int64
		if err := f.a.store.DB.QueryRow(f.a.store.Query("SELECT data_revision FROM spaces WHERE id=?"), f.space).Scan(&afterRevision); err != nil || afterRevision != beforeRevision+1 {
			t.Fatal("one origin completion must advance navigation once", err)
		}
		warm := coreLink("Warm", "https://same.example.org/warm")
		delete(warm, "icon")
		if f.b.object("POST", base, warm, 201)["icon"] != ref || f.count(t, "icon_favicon_jobs") != 0 || f.transport.calls.Load() != 1 {
			t.Fatal("warm origin cache performed another fetch")
		}
	})

	t.Run("negative-cache-and-explicit-later-retry", func(t *testing.T) {
		f := newAutoIconFixture(t, postgres, false, false)
		base := "/spaces/" + f.space + "/links"
		in := coreLink("Unavailable", "https://unavailable.example.org/path")
		delete(in, "icon")
		first := f.b.object("POST", base, in, 201)
		autoIconWait(t, "negative cache", func() bool { return f.count(t, "icon_favicon_jobs") == 0 && f.count(t, "icon_favicon_cache") == 1 })
		calls := f.transport.calls.Load()
		var failure string
		var checked, retry databaseTime
		if err := f.a.store.DB.QueryRow("SELECT last_error,checked_at,retry_at FROM icon_favicon_cache").Scan(&failure, &checked, &retry); err != nil || failure != "favicon_unavailable" || retry.Sub(checked.Time) < 29*time.Minute {
			t.Fatal("negative result did not persist bounded retry metadata", err)
		}
		in["title"] = "Still unavailable"
		f.b.object("PUT", base+"/"+first["id"].(string), in, 200)
		if f.transport.calls.Load() != calls || f.count(t, "icon_favicon_jobs") != 0 {
			t.Fatal("save bypassed negative cache")
		}
		if _, err := f.a.store.DB.Exec(f.a.store.Query("UPDATE icon_favicon_cache SET retry_at=?"), time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)); err != nil {
			t.Fatal(err)
		}
		if job, err := f.a.nextAutomaticIconJob(context.Background()); err != nil || job != nil {
			t.Fatal("cache expiry itself scheduled work", err)
		}
		png := testIconPNG(t, 16, 16)
		f.transport.set(func(*http.Request) (*http.Response, error) { return autoIconResponse(png), nil })
		f.b.object("PUT", base+"/"+first["id"].(string), in, 200)
		autoIconWait(t, "explicit save after negative-cache expiry", func() bool { ref, _, _ := f.link(t, first["id"].(string)); return strings.HasPrefix(ref, "asset:") })
		if f.transport.calls.Load() != calls+1 {
			t.Fatal("retry performed unexpected extra requests")
		}
		previous, _, _ := f.link(t, first["id"].(string))
		if _, err := f.a.store.DB.Exec(f.a.store.Query("UPDATE icon_favicon_cache SET retry_at=?"), time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)); err != nil {
			t.Fatal(err)
		}
		f.transport.set(nil)
		f.b.object("PUT", base+"/"+first["id"].(string), in, 200)
		autoIconWait(t, "failed refresh of saved image", func() bool { return f.count(t, "icon_favicon_jobs") == 0 })
		kept, _, _ := f.link(t, first["id"].(string))
		if kept != previous {
			t.Fatal("failed refresh removed the last saved image")
		}
		if err := f.a.store.DB.QueryRow("SELECT last_error FROM icon_favicon_cache").Scan(&failure); err != nil || failure != "favicon_unavailable" {
			t.Fatal("failed refresh omitted negative-cache metadata", err)
		}
	})

	t.Run("disable-cancel-no-backfill-and-restart", func(t *testing.T) {
		f := newAutoIconFixture(t, postgres, false, false)
		started, cancelled := make(chan string, 8), make(chan string, 8)
		f.transport.set(func(r *http.Request) (*http.Response, error) {
			started <- r.URL.String()
			<-r.Context().Done()
			cancelled <- r.URL.String()
			return nil, r.Context().Err()
		})
		in := coreLink("Cancellable", "https://cancel.example.org/")
		delete(in, "icon")
		base := "/spaces/" + f.space + "/links"
		created := f.b.object("POST", base, in, 201)
		autoIconSignal(t, started)
		epoch := f.settings(t).AuthEpoch
		f.toggle(false)
		autoIconSignal(t, cancelled)
		autoIconDrainGate(t, f.a)
		if f.count(t, "icon_favicon_jobs") != 0 || f.count(t, "icon_favicon_cache") != 0 || f.settings(t).AuthEpoch != epoch {
			t.Fatal("disable did not cancel and clear only automatic work")
		}
		f.toggle(true)
		if f.count(t, "icon_favicon_jobs") != 0 || f.transport.calls.Load() != 1 {
			t.Fatal("reenable backfilled cancelled work")
		}
		f.b.object("PUT", base+"/"+created["id"].(string), in, 200)
		autoIconSignal(t, started)
		var jobID string
		if err := f.a.store.DB.QueryRow("SELECT id FROM icon_favicon_jobs").Scan(&jobID); err != nil {
			t.Fatal(err)
		}
		if err := f.a.Close(); err != nil {
			t.Fatal(err)
		}
		f.a = nil
		png := testIconPNG(t, 16, 16)
		f.transport.set(func(*http.Request) (*http.Response, error) { return autoIconResponse(png), nil })
		var err error
		f.a, err = openWithIconHTTPClient(f.c, &http.Client{Transport: f.transport})
		if err != nil {
			t.Fatal(err)
		}
		f.b.a = f.a
		autoIconWait(t, "durable job recovered on ordinary restart", func() bool { return f.count(t, "icon_favicon_jobs") == 0 && f.count(t, "icon_favicon_cache") == 1 })
		ref, mode, _ := f.link(t, created["id"].(string))
		if !strings.HasPrefix(ref, "asset:") || mode != "auto" || f.transport.calls.Load() != 3 || jobID == "" {
			t.Fatal("ordinary restart lost pending icon intent")
		}
	})

	t.Run("late-results-cannot-overwrite-new-intent", func(t *testing.T) {
		f := newAutoIconFixture(t, postgres, false, false)
		png := testIconPNG(t, 16, 16)
		for _, change := range []string{"manual", "origin", "delete"} {
			started, release := make(chan string, 8), make(chan struct{})
			f.transport.set(func(r *http.Request) (*http.Response, error) {
				started <- r.URL.String()
				select {
				case <-release:
					return autoIconResponse(png), nil
				case <-r.Context().Done():
					return nil, r.Context().Err()
				}
			})
			in := coreLink(change, "https://late-"+change+".example.org/")
			delete(in, "icon")
			base := "/spaces/" + f.space + "/links"
			link := f.b.object("POST", base, in, 201)
			autoIconSignal(t, started)
			if change == "delete" {
				f.b.object("DELETE", base+"/"+link["id"].(string), nil, 204)
			} else {
				if change == "manual" {
					in["icon"], in["iconMode"] = "lucide:star", "manual"
				} else {
					in["url"] = "http://127.0.0.1:8090/new"
				}
				f.b.object("PUT", base+"/"+link["id"].(string), in, 200)
			}
			close(release)
			autoIconDrainGate(t, f.a)
			if change == "delete" {
				var exists bool
				if err := f.a.store.DB.QueryRow(f.a.store.Query("SELECT EXISTS(SELECT 1 FROM links WHERE id=?)"), link["id"]).Scan(&exists); err != nil || exists || f.count(t, "icon_favicon_cache") != 0 || f.count(t, "icon_favicon_jobs") != 0 {
					t.Fatal("late result recreated deleted intent", err)
				}
				continue
			}
			icon, mode, origin := f.link(t, link["id"].(string))
			if change == "manual" && (icon != "lucide:star" || mode != "manual") || change == "origin" && (icon != "lucide:link" || mode != "auto" || origin != "") || f.count(t, "icon_favicon_cache") != 0 || f.count(t, "icon_favicon_jobs") != 0 {
				t.Fatal("late old-origin result replaced new icon intent")
			}
		}
	})

	t.Run("actor-version-rechecked-after-network", func(t *testing.T) {
		f := newAutoIconFixture(t, postgres, true, false)
		png := testIconPNG(t, 16, 16)
		started, release := make(chan string, 8), make(chan struct{})
		f.transport.set(func(r *http.Request) (*http.Response, error) {
			started <- r.URL.String()
			select {
			case <-release:
				return autoIconResponse(png), nil
			case <-r.Context().Done():
				return nil, r.Context().Err()
			}
		})
		in := coreLink("Revoked actor", "https://actor.example.org/")
		delete(in, "icon")
		link := f.b.object("POST", "/spaces/"+f.space+"/links", in, 201)
		autoIconSignal(t, started)
		if _, err := f.a.store.DB.Exec("UPDATE users SET version=version+1 WHERE role='Owner'"); err != nil {
			t.Fatal(err)
		}
		close(release)
		autoIconDrainGate(t, f.a)
		icon, mode, _ := f.link(t, link["id"].(string))
		if icon != "lucide:link" || mode != "auto" || f.count(t, "icon_favicon_cache") != 0 || f.count(t, "icon_favicon_jobs") != 0 {
			t.Fatal("actor version revocation was not rechecked after fetch")
		}
	})

	t.Run("authorization-epoch-token-and-mcp", func(t *testing.T) {
		f := newAutoIconFixture(t, postgres, true, false)
		epoch := f.settings(t).AuthEpoch
		f.toggle(false)
		if f.settings(t).AuthEpoch != epoch || f.b.bootstrap()["user"] == nil {
			t.Fatal("icon-only setting signed out the Owner")
		}
		f.toggle(true)
		png := testIconPNG(t, 16, 16)
		started, release := make(chan string, 8), make(chan struct{})
		f.transport.set(func(r *http.Request) (*http.Response, error) {
			started <- r.URL.String()
			select {
			case <-release:
				return autoIconResponse(png), nil
			case <-r.Context().Done():
				return nil, r.Context().Err()
			}
		})
		credential := f.b.object("POST", "/integrations/tokens", map[string]any{"name": "Automatic icons fixture", "spaceId": f.space, "actions": []string{"navigation:write"}, "expiresAt": time.Now().UTC().Add(time.Hour)}, 201)
		token := credential["token"].(string)
		id := credential["credential"].(map[string]any)["id"].(string)
		in := coreLink("Token save", "https://token.example.org/private")
		in["iconMode"] = "auto"
		w := f.b.request("POST", "/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "bookmarks_create", "arguments": map[string]any{"spaceId": f.space, "input": in}}}, http.Header{"Authorization": []string{"Bearer " + token}, "Accept": []string{"application/json, text/event-stream"}, "Mcp-Protocol-Version": []string{"2025-11-25"}})
		var mcp map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &mcp); err != nil || w.Code != 200 {
			t.Fatal("MCP automatic link request failed")
		}
		result, _ := mcp["result"].(map[string]any)
		if result["isError"] == true {
			t.Fatal("MCP automatic link save rejected")
		}
		autoIconSignal(t, started)
		var hash string
		if err := f.a.store.DB.QueryRow("SELECT token_hash FROM icon_favicon_jobs").Scan(&hash); err != nil || hash != integrationHash(token) || hash == token {
			t.Fatal("task did not retain only the scoped token hash", err)
		}
		f.b.object("DELETE", "/integrations/tokens/"+id, nil, 200)
		close(release)
		autoIconDrainGate(t, f.a)
		if f.count(t, "icon_favicon_cache") != 0 || f.count(t, "icon_favicon_jobs") != 0 {
			t.Fatal("revoked token's in-flight result was applied")
		}
		// Keep the worker behind its gate while asserting the epoch change's
		// transactional queue cleanup; no per-job grace delay may be required.
		f.a.iconFetchGate <- struct{}{}
		in["url"] = "https://epoch.example.org/"
		f.b.object("POST", "/spaces/"+f.space+"/links", in, 201)
		if f.count(t, "icon_favicon_jobs") != 1 {
			t.Fatal("epoch fixture was not queued")
		}
		f.b.object("PUT", "/settings", map[string]any{"siteName": "Automatic icons", "mode": ModeOpenEdit, "registrationEnabled": false}, 200)
		if f.count(t, "icon_favicon_jobs") != 0 || f.settings(t).AuthEpoch != epoch+1 {
			t.Fatal("security change did not atomically discard old-epoch tasks")
		}
		<-f.a.iconFetchGate
		anonymous := newIconHTTPBrowser(t, f.a)
		anonymous.bootstrap()
		anonymous.object("PUT", "/settings", map[string]any{"siteName": "Automatic icons", "mode": ModeOpenEdit, "registrationEnabled": false, "autoFetchIcons": false}, 401)
		f.b.bootstrap()
		f.b.object("POST", "/auth/login", map[string]any{"username": "auto-owner", "password": "automatic-icon-owner-fixture-2026"}, 200)
		f.b.bootstrap()
		f.toggle(false)
		// The global automatic policy must not disable an explicit, authorized
		// manual fetch, and the queue stays empty.
		f.transport.set(func(*http.Request) (*http.Response, error) { return autoIconResponse(png), nil })
		f.b.object("POST", "/spaces/"+f.space+"/icons/fetch", map[string]any{"url": "https://manual.example.org/"}, 200)
		if f.count(t, "icon_favicon_jobs") != 0 {
			t.Fatal("manual fetch created automatic work")
		}
	})
}

func TestAutomaticIconRollbackAndAdmission(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		t.Run(fmt.Sprintf("postgres-%v", postgres), func(t *testing.T) {
			f := newAutoIconFixture(t, postgres, false, false)
			ctx := context.Background()
			// A failed compound operation must roll back the queue alongside the
			// bookmark; post-commit dispatch is deliberately never invoked.
			tx, err := f.a.store.DB.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			s, err := f.a.loadSettings(ctx, tx)
			if err != nil {
				_ = tx.Rollback()
				t.Fatal(err)
			}
			r := &Request{App: f.a, HTTP: httptest.NewRequest("POST", "http://home.test/fixture", nil), Q: tx, Settings: s}
			if _, err = f.a.insertLink(r, f.space, linkInput{Title: "Rollback", URL: "https://rollback.example.org/", IconMode: "auto"}); err != nil {
				_ = tx.Rollback()
				t.Fatal(err)
			}
			if !r.WakeAutoIcons {
				_ = tx.Rollback()
				t.Fatal("transaction omitted automatic intent")
			}
			if err = tx.Rollback(); err != nil {
				t.Fatal(err)
			}
			if f.count(t, "links") != 0 || f.count(t, "icon_favicon_jobs") != 0 || f.transport.calls.Load() != 0 {
				t.Fatal("rollback leaked a bookmark or background fetch")
			}
			// Fill the per-space cache budget with tiny metadata rows. A queued
			// refresh of an already cached origin must count only once.
			err = f.a.integrationTransaction(ctx, func(q Queryer) error {
				for i := 0; i < 512; i++ {
					_, err := q.ExecContext(ctx, f.a.store.Query("INSERT INTO icon_favicon_cache(space_id,origin,digest,source_url,checked_at,retry_at,last_error) VALUES(?,?,NULL,'',?,?,?)"), f.space, fmt.Sprintf("https://cache-%d.example.org/", i), nowUTC(), time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano), "favicon_unavailable")
					if err != nil {
						return err
					}
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			in := coreLink("Capacity fallback", "https://full.example.org/")
			delete(in, "icon")
			if f.b.object("POST", "/spaces/"+f.space+"/links", in, 201)["icon"] != "lucide:link" || f.count(t, "icon_favicon_jobs") != 0 || f.transport.calls.Load() != 0 {
				t.Fatal("full cache blocked a link save or started network")
			}
			f.a.iconFetchGate <- struct{}{}
			defer func() { <-f.a.iconFetchGate }()
			in["url"] = "https://cache-0.example.org/"
			f.b.object("POST", "/spaces/"+f.space+"/links", in, 201)
			if f.count(t, "icon_favicon_jobs") != 1 {
				t.Fatal("cache+pending UNION double-counted an existing origin")
			}
			if _, err = f.a.store.DB.Exec("DELETE FROM icon_favicon_jobs; DELETE FROM icon_favicon_cache"); err != nil {
				t.Fatal(err)
			}
			// Admission reserves one maximum icon before any network work. A
			// synthetic near-limit blob avoids thousands of pointless requests.
			if _, err = f.a.store.DB.Exec(f.a.store.Query("INSERT INTO icon_assets(space_id,digest,media_type,content,width,height,created_at) VALUES(?,?,?,?,?,?,?)"), f.space, strings.Repeat("a", 64), "image/png", make([]byte, iconSpaceMaxBytes-iconMaxBytes+1), 1, 1, nowUTC()); err != nil {
				t.Fatal(err)
			}
			in["url"] = "https://no-headroom.example.org/"
			f.b.object("POST", "/spaces/"+f.space+"/links", in, 201)
			if f.count(t, "icon_favicon_jobs") != 0 || f.transport.calls.Load() != 0 {
				t.Fatal("image capacity reservation happened after network")
			}
			f.b.object("POST", "/spaces/"+f.space+"/icons/fetch", map[string]any{"url": "https://no-headroom.example.org/"}, 400)
			if f.transport.calls.Load() != 0 {
				t.Fatal("explicit fetch ignored the image headroom check")
			}
			if _, err = f.a.store.DB.Exec("DELETE FROM icon_assets"); err != nil {
				t.Fatal(err)
			}
			// The global queue budget spans independent personal spaces. These
			// synthetic task owners have no raw credentials or external I/O.
			err = f.a.integrationTransaction(ctx, func(q Queryer) error {
				for spaceIndex := 0; spaceIndex < 4; spaceIndex++ {
					user, space := fmt.Sprintf("limit-user-%d", spaceIndex), fmt.Sprintf("limit-space-%d", spaceIndex)
					if _, err := q.ExecContext(ctx, f.a.store.Query("INSERT INTO users(id,username,normalized_username,display_name,role,is_enabled,password_hash,version,created_at) VALUES(?,?,?,?,'Member',?,'fixture',1,?)"), user, user, user, user, true, nowUTC()); err != nil {
						return err
					}
					if _, err := q.ExecContext(ctx, f.a.store.Query("INSERT INTO spaces(id,name,kind,owner_user_id,published,data_revision,updated_at) VALUES(?,?,'personal',?,?,1,?)"), space, space, user, false, nowUTC()); err != nil {
						return err
					}
					for i := 0; i < 512; i++ {
						if _, err := q.ExecContext(ctx, f.a.store.Query("INSERT INTO icon_favicon_jobs(space_id,origin,id,auth_epoch,actor_user_id,actor_user_version,token_hash,requested_at) VALUES(?,?,?,?,?,1,'',?)"), space, fmt.Sprintf("https://pending-%d.example.org/", i), newID(), s.AuthEpoch, user, nowUTC()); err != nil {
							return err
						}
					}
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			in["url"] = "https://global-full.example.org/"
			f.b.object("POST", "/spaces/"+f.space+"/links", in, 201)
			if f.count(t, "icon_favicon_jobs") != automaticIconPendingLimit {
				t.Fatal("global queue limit rejected save or exceeded its bound")
			}
			if _, err = f.a.store.DB.Exec("DELETE FROM icon_favicon_jobs"); err != nil {
				t.Fatal(err)
			}
		})
	}
}
