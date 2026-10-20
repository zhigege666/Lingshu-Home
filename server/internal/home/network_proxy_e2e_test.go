package home

import (
	"bufio"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The application uses its real default HTTP client and an Owner-saved proxy.
// This local CONNECT server never forwards traffic and never resolves a target;
// it returns a fixed image inside the tunnel itself. Public literal addresses
// let the real destination policy execute without doing external DNS lookups.
func TestNetworkProxyOwnerToDefaultClientAndIconCache(t *testing.T) {
	image := testIconPNG(t, 16, 16)
	const username, password = "proxy-e2e-user", "proxy-e2e-password"
	expectedAuthorization := "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+password))
	var calls atomic.Int32
	var reject atomic.Bool
	observed := make(chan error, 8)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "CONNECT" || r.RequestURI != r.Host || (r.Host != "8.8.8.8:80" && r.Host != "1.1.1.1:80") {
			observed <- errors.New("proxy did not receive a validated literal CONNECT destination")
			http.Error(w, "invalid fixture target", http.StatusBadRequest)
			return
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-CSRF-TOKEN") != "" || r.Header.Get("Proxy-Authorization") != expectedAuthorization {
			observed <- errors.New("CONNECT authentication was missing or contained Home browser credentials")
			http.Error(w, "invalid fixture headers", http.StatusBadRequest)
			return
		}
		if reject.Load() {
			w.WriteHeader(http.StatusProxyAuthRequired)
			observed <- nil
			return
		}
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			observed <- errors.New("fixture cannot hijack CONNECT")
			return
		}
		conn, buffered, err := hijacker.Hijack()
		if err != nil {
			observed <- errors.New("fixture could not establish local tunnel")
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
		if _, err := io.WriteString(buffered, "HTTP/1.1 200 Connection established\r\n\r\n"); err != nil {
			observed <- err
			return
		}
		if err := buffered.Flush(); err != nil {
			observed <- err
			return
		}
		request, err := http.ReadRequest(bufio.NewReader(buffered))
		if err != nil {
			observed <- errors.New("destination request did not enter local CONNECT tunnel")
			return
		}
		if request.Method != "GET" || request.Host != "8.8.8.8" || request.RequestURI != "/" || request.Header.Get("Authorization") != "" || request.Header.Get("Proxy-Authorization") != "" || request.Header.Get("Cookie") != "" || request.Header.Get("X-CSRF-TOKEN") != "" {
			observed <- errors.New("destination request forwarded browser/proxy credentials or bookmark path/query")
			return
		}
		if _, err := fmt.Fprintf(conn, "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", len(image)); err != nil {
			observed <- err
			return
		}
		if err := writeNetworkProxyBytes(conn, image); err != nil {
			observed <- err
			return
		}
		observed <- nil
	}))
	t.Cleanup(proxy.Close)
	a, err := Open(autoIconConfig(t, false))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	b := newIconHTTPBrowser(t, a)
	b.bootstrap()
	b.object("POST", "/setup", map[string]any{"siteName": "Proxy client fixture", "mode": ModePrivateMulti, "username": "proxy-owner", "displayName": "Proxy owner", "password": "proxy-owner-fixture-password-2026", "seedDemo": false}, 201)
	space := coreSpace(b.bootstrap(), "shared")
	saved := b.object("PUT", "/network-proxy", map[string]any{"expectedRevision": "1", "mode": "proxy", "url": proxy.URL, "secret": map[string]any{"username": username, "password": password}}, 200)
	if saved["revision"] != "2" || saved["credentialConfigured"] != true || calls.Load() != 0 {
		t.Fatal("Owner proxy save failed or performed a connectivity probe")
	}
	path := "/spaces/" + space + "/icons/fetch"
	first := b.object("POST", path, map[string]any{"url": "http://8.8.8.8/private/bookmark?token=private-fixture#section"}, 200)
	proxyTestResult(t, observed)
	ref, validRef := first["ref"].(string)
	if calls.Load() != 1 || first["cached"] != false || first["sourceUrl"] != "http://8.8.8.8/" || !validRef || !strings.HasPrefix(ref, "asset:"+space+":") {
		t.Fatal("default App client did not fetch and persist through the saved proxy")
	}
	asset := b.request("GET", first["url"].(string), nil, nil)
	if asset.Code != 200 || asset.Header().Get("Content-Type") != "image/png" || len(asset.Body.Bytes()) == 0 {
		t.Fatal("proxied image was not served through authorized local asset storage")
	}
	warm := b.object("POST", path, map[string]any{"url": "http://8.8.8.8/another-path"}, 200)
	if warm["cached"] != true || warm["ref"] != first["ref"] || calls.Load() != 1 {
		t.Fatal("warm website cache made another proxy request")
	}
	// A reachable proxy's 407 remains an upstream failure. It cannot become a
	// successful direct fetch or replace the first origin's good cached image.
	// The separate pinned-dial tests also assert every failed socket attempt's
	// address, including that none is the destination address.
	reject.Store(true)
	failed := b.object("POST", path, map[string]any{"url": "http://1.1.1.1/private?token=not-forwarded"}, 422)
	proxyTestResult(t, observed)
	proxyTestResult(t, observed)
	if failed["code"] != "favicon_unavailable" || calls.Load() != 3 {
		t.Fatal("proxy refusal did not remain bounded to the origin and favicon fallback attempts")
	}
	var assets, failures int
	if err := a.store.DB.QueryRow("SELECT COUNT(*) FROM icon_assets").Scan(&assets); err != nil {
		t.Fatal(err)
	}
	if err := a.store.DB.QueryRow("SELECT COUNT(*) FROM icon_favicon_cache WHERE last_error<>''").Scan(&failures); err != nil {
		t.Fatal(err)
	}
	if assets != 1 || failures != 1 {
		t.Fatal("proxy refusal corrupted successful cache data or omitted bounded negative cache")
	}
}
