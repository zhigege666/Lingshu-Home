package home

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNetworkProxyURLAndCredentialPolicy(t *testing.T) {
	valid := map[string]string{
		"":                                 "",
		"http://127.0.0.1:3128":            "http://127.0.0.1:3128",
		"https://Proxy.Example.Org.:0443/": "https://proxy.example.org:443",
		"socks5://[::1]:1080":              "socks5://[::1]:1080",
		"http://192.168.10.20:8080":        "http://192.168.10.20:8080",
		"https://[fd01::123]:8443":         "https://[fd01::123]:8443",
		"http://localhost:8888":            "http://localhost:8888",
		"socks5://forwarder:1080":          "socks5://forwarder:1080",
	}
	for raw, want := range valid {
		u, err := networkProxyURL(raw)
		got := ""
		if u != nil {
			got = u.String()
		}
		if err != nil || got != want {
			t.Errorf("valid proxy endpoint %q: got %q, %v", raw, got, err)
		}
	}
	for _, raw := range []string{
		"http://proxy.example.org", "http://proxy.example.org:0", "http://proxy.example.org:65536",
		"http://proxy.example.org:-1", "http://proxy.example.org:http", "socks5h://proxy.example.org:1080",
		"ftp://proxy.example.org:21", "http://u:p@proxy.example.org:80", "http://proxy.example.org:80/path",
		"http://proxy.example.org:80?", "http://proxy.example.org:80?q=x", "http://proxy.example.org:80#",
		"http://proxy.example.org:80/#fragment", "http://proxy.example.org:80\\@8.8.8.8:80",
		"http://proxy.example.org:80\n", "http://bad_host:80", "http://:80", "http://[fe80::1%25eth0]:80",
		"http://169.254.169.254:80", "http://100.100.100.200:80", "http://[fd00:ec2::254]:80",
		"http://metadata.google.internal:80", "http://x.metadata.google.internal:80", "http://metadata:80",
		"http://0.0.0.0:80", "http://[::]:80", "http://224.0.0.1:80", "http://192.0.2.1:80",
		"http://100.64.1.1:80", "http://198.18.0.1:80", "http://[2001:db8::1]:80",
	} {
		if _, err := networkProxyURL(raw); err == nil {
			t.Errorf("unsafe or malformed proxy endpoint accepted: %q", raw)
		}
	}
	for _, secret := range []networkProxySecret{
		{}, {Username: "u"}, {Password: "p"}, {Username: "u:p", Password: "p"},
		{Username: "u\n", Password: "p"}, {Username: "u", Password: "p\x00"},
		{Username: strings.Repeat("u", 256), Password: "p"}, {Username: "u", Password: strings.Repeat("密", 86)},
	} {
		if validateNetworkProxySecret(secret) == nil {
			t.Error("invalid proxy credential pair accepted")
		}
	}
	if err := validateNetworkProxySecret(networkProxySecret{Username: "fixture-user", Password: "a: valid UTF-8 密码"}); err != nil {
		t.Fatal(err)
	}
}

func TestNetworkProxySQLite(t *testing.T)   { testNetworkProxy(t, false) }
func TestNetworkProxyPostgres(t *testing.T) { testNetworkProxy(t, true) }

func testNetworkProxy(t *testing.T, postgres bool) {
	t.Run("owner-only-encrypted-revision-and-key-recovery", func(t *testing.T) {
		f := newAutoIconFixture(t, postgres, true, false)
		initial := f.b.object("GET", "/network-proxy", nil, 200)
		if len(initial) != 4 || initial["revision"] != "1" || initial["mode"] != "direct" || initial["url"] != "" || initial["credentialConfigured"] != false {
			t.Fatal("new instances must expose only the default direct projection")
		}
		input := map[string]any{"expectedRevision": "1", "mode": "proxy", "url": "http://Proxy.Example.Org:3128/", "secret": map[string]any{"username": "fixture-proxy-user", "password": "fixture-proxy-password"}}
		if w := f.b.request("PUT", "/api/v1/network-proxy", input, http.Header{"X-Csrf-Token": []string{"invalid"}}); w.Code != 403 {
			t.Fatal("proxy write accepted without current CSRF")
		}
		anonymous := newIconHTTPBrowser(t, f.a)
		anonymous.bootstrap()
		anonymous.object("GET", "/network-proxy", nil, 401)
		anonymous.object("PUT", "/network-proxy", input, 401)
		pat := f.b.object("POST", "/integrations/tokens", map[string]any{"name": "Proxy permission fixture", "spaceId": f.space, "actions": []string{"navigation:read", "navigation:write"}, "expiresAt": time.Now().UTC().Add(time.Hour)}, 201)["token"].(string)
		for _, method := range []string{"GET", "PUT"} {
			var body any
			if method == "PUT" {
				body = input
			}
			if w := anonymous.request(method, "/api/v1/network-proxy", body, http.Header{"Authorization": []string{"Bearer " + pat}}); w.Code != 403 {
				t.Fatal("Owner PAT gained server proxy administration", method, w.Code)
			}
		}
		f.b.object("POST", "/admin/users", map[string]any{"username": "proxy-member", "displayName": "Proxy member", "password": "network-proxy-member-fixture-2026"}, 201)
		member := newIconHTTPBrowser(t, f.a)
		member.bootstrap()
		member.object("POST", "/auth/login", map[string]any{"username": "proxy-member", "password": "network-proxy-member-fixture-2026"}, 200)
		member.bootstrap()
		member.object("GET", "/network-proxy", nil, 403)
		member.object("PUT", "/network-proxy", input, 403)

		epoch := f.settings(t).AuthEpoch
		ctx, finish := f.a.beginNetworkOperation(context.Background())
		defer finish()
		saved := f.b.object("PUT", "/network-proxy", input, 200)
		if len(saved) != 4 || saved["revision"] != "2" || saved["url"] != "http://proxy.example.org:3128" || saved["credentialConfigured"] != true {
			t.Fatal("proxy save returned incorrect projection")
		}
		encoded, _ := json.Marshal(saved)
		if strings.Contains(string(encoded), "fixture-proxy") || f.settings(t).AuthEpoch != epoch || f.transport.calls.Load() != 0 {
			t.Fatal("saving proxy leaked credentials, reset authentication or performed network I/O")
		}
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
			t.Fatal("proxy revision did not cancel captured operations")
		}
		if !errors.Is(context.Cause(ctx), errNetworkProxyChanged) {
			t.Fatal("proxy cancellation lost its cause")
		}
		var api *APIError
		if err := f.a.checkNetworkOperation(ctx, f.a.store.DB); !errors.As(err, &api) || api.Code != "network_proxy_changed" || api.Status != 409 {
			t.Fatal("old operation did not fail closed with version conflict", err)
		}
		// net/http can detach a shared dial's request cancellation. Its context
		// value still identifies the generation, which must remain authoritative.
		if conn, err := f.a.dialNetworkTarget(context.WithoutCancel(ctx), "tcp", "8.8.8.8:443"); err == nil || conn != nil {
			if conn != nil {
				_ = conn.Close()
			}
			t.Fatal("detached old-generation dial was accepted")
		}
		current, done := f.a.beginNetworkOperation(context.Background())
		if err := f.a.checkNetworkOperation(current, f.a.store.DB); err != nil {
			t.Fatal("new operation did not use committed proxy revision", err)
		}
		done()

		var cipher string
		if err := f.a.store.DB.QueryRow("SELECT credential_cipher FROM network_proxy_config WHERE id=1").Scan(&cipher); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(cipher, "fixture-proxy") {
			t.Fatal("proxy credentials were stored as plaintext")
		}
		secret, err := f.a.decryptNetworkProxySecret(cipher)
		if err != nil || secret.Username != "fixture-proxy-user" || secret.Password != "fixture-proxy-password" {
			t.Fatal("saved proxy credential did not decrypt")
		}
		if _, err := f.a.decryptIntegrationSecret("proxy", cipher); err == nil {
			t.Fatal("proxy ciphertext was accepted under source-credential AAD")
		}
		conflict := f.b.object("PUT", "/network-proxy", input, 409)
		if conflict["code"] != "network_proxy_version_conflict" || conflict["currentRevision"] != "2" {
			t.Fatal("stale proxy save omitted exact conflict revision")
		}
		bad := map[string]any{"expectedRevision": "2", "mode": "proxy", "url": "http://other.example.org:3128"}
		f.b.object("PUT", "/network-proxy", bad, 400)
		if f.b.object("GET", "/network-proxy", nil, 200)["revision"] != "2" {
			t.Fatal("rejected cross-endpoint secret inheritance modified configuration")
		}
		// Turning off routing retains the same encrypted endpoint credentials.
		off := f.b.object("PUT", "/network-proxy", map[string]any{"expectedRevision": "2", "mode": "direct", "url": "http://proxy.example.org:3128"}, 200)
		if off["revision"] != "3" || off["credentialConfigured"] != true {
			t.Fatal("direct mode unexpectedly deleted saved credentials")
		}
		if err := f.a.Close(); err != nil {
			t.Fatal(err)
		}
		f.a = nil
		key := filepath.Join(f.c.DataDir, "integrations.key")
		backup := key + ".proxy-fixture-backup"
		if err := os.Rename(key, backup); err != nil {
			t.Fatal(err)
		}
		broken, err := openWithIconHTTPClient(f.c, &http.Client{Transport: f.transport})
		if err == nil {
			_ = broken.Close()
			t.Fatal("missing key with only proxy ciphertext did not block startup")
		}
		if _, err := os.Stat(key); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("missing proxy credential key was silently regenerated")
		}
		if err := os.Rename(backup, key); err != nil {
			t.Fatal(err)
		}
		f.a, err = openWithIconHTTPClient(f.c, &http.Client{Transport: f.transport})
		if err != nil {
			t.Fatal(err)
		}
		f.b.a = f.a
		if got := f.b.object("GET", "/network-proxy", nil, 200); got["revision"] != "3" || got["credentialConfigured"] != true || got["mode"] != "direct" {
			t.Fatal("restored proxy configuration or Owner session was lost")
		}
		cleared := f.b.object("PUT", "/network-proxy", map[string]any{"expectedRevision": "3", "mode": "proxy", "url": "socks5://127.0.0.1:1080", "clearCredentials": true}, 200)
		if cleared["revision"] != "4" || cleared["credentialConfigured"] != false {
			t.Fatal("explicit credential clear did not accompany endpoint replacement")
		}
		var count int
		if err := f.a.store.DB.QueryRow("SELECT COUNT(*) FROM network_proxy_config WHERE credential_cipher IS NOT NULL").Scan(&count); err != nil || count != 0 {
			t.Fatal("cleared credentials remained in persistent storage", err)
		}
	})

	t.Run("strict-input-and-ownerless", func(t *testing.T) {
		f := newAutoIconFixture(t, postgres, true, false)
		cases := []map[string]any{
			{"expectedRevision": "1", "mode": "proxy", "url": ""},
			{"expectedRevision": "1", "mode": "direct", "url": nil},
			{"expectedRevision": "1", "mode": "direct", "url": "", "secret": nil},
			{"expectedRevision": "1", "mode": "direct", "url": "", "clearCredentials": nil},
			{"expectedRevision": "1", "mode": "proxy", "url": "http://proxy.example.org:80", "secret": map[string]any{"username": "u"}},
			{"expectedRevision": "1", "mode": "proxy", "url": "http://proxy.example.org:80", "secret": map[string]any{"username": "u", "password": "p", "other": true}},
			{"expectedRevision": "1", "mode": "proxy", "url": "http://proxy.example.org:80", "secret": map[string]any{"username": "u", "password": "p"}, "clearCredentials": true},
			{"expectedRevision": "1", "mode": "direct", "url": "", "secret": map[string]any{"username": "u", "password": "p"}},
			{"expectedRevision": "1", "mode": "proxy", "url": "http://u:p@proxy.example.org:80"},
			{"expectedRevision": "1", "mode": "auto", "url": ""},
			{"expectedRevision": "0", "mode": "direct", "url": ""},
			{"expectedRevision": "1", "mode": "direct", "url": "", "environment": true},
		}
		for _, input := range cases {
			f.b.object("PUT", "/network-proxy", input, 400)
		}
		if f.b.object("GET", "/network-proxy", nil, 200)["revision"] != "1" || f.transport.calls.Load() != 0 {
			t.Fatal("rejected inputs modified config or contacted a proxy")
		}
		// PostgreSQL deliberately holds one advisory instance lease per test
		// database, even when fixture data uses separate random schemas.
		if err := f.a.Close(); err != nil {
			t.Fatal(err)
		}
		f.a = nil
		ownerless := newAutoIconFixture(t, postgres, false, false)
		ownerless.b.object("GET", "/network-proxy", nil, 401)
		ownerless.b.object("PUT", "/network-proxy", map[string]any{"expectedRevision": "1", "mode": "direct", "url": ""}, 401)
	})

	t.Run("manual-inflight-change-cannot-cache-result", func(t *testing.T) {
		f := newAutoIconFixture(t, postgres, true, false)
		started := make(chan string, 1)
		f.transport.set(func(r *http.Request) (*http.Response, error) {
			select {
			case started <- r.URL.String():
			default:
			}
			<-r.Context().Done()
			return nil, r.Context().Err()
		})
		fetchBrowser := newIconHTTPBrowser(t, f.a)
		fetchBrowser.csrf = f.b.csrf
		for k, v := range f.b.cookies {
			copy := *v
			fetchBrowser.cookies[k] = &copy
		}
		result := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			result <- fetchBrowser.request("POST", "/api/v1/spaces/"+f.space+"/icons/fetch", map[string]any{"url": "https://proxy-cancel.example.org/private?token=not-transmitted"}, nil)
		}()
		autoIconSignal(t, started)
		f.b.object("PUT", "/network-proxy", map[string]any{"expectedRevision": "1", "mode": "proxy", "url": "http://127.0.0.1:3128"}, 200)
		select {
		case response := <-result:
			var body map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != 409 || body["code"] != "network_proxy_changed" {
				t.Fatal("in-flight manual fetch did not report configuration change", response.Code, err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("proxy update failed to cancel in-flight favicon fetch")
		}
		if f.count(t, "icon_assets") != 0 || f.count(t, "icon_favicon_cache") != 0 {
			t.Fatal("obsolete proxy result or failure was cached")
		}
	})
}
