package home

import (
	"bytes"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func assertIconCacheHeaders(t *testing.T, response *httptest.ResponseRecorder, etag string) {
	t.Helper()
	if response.Header().Get("Cache-Control") != "private, no-cache" || response.Header().Get("ETag") != etag || response.Header().Get("Vary") != "Cookie, Authorization" {
		t.Fatal("icon response has an invalid revalidation policy", response.Header())
	}
	if !strings.Contains(response.Header().Get("Content-Security-Policy"), "sandbox") || response.Header().Get("Cross-Origin-Resource-Policy") != "same-origin" {
		t.Fatal("icon response lost its image isolation headers", response.Header())
	}
}

func assertIconCacheDenied(t *testing.T, browser *iconHTTPBrowser, assetURL, etag string, status int, extra http.Header) {
	t.Helper()
	for _, condition := range []string{etag, "*"} {
		headers := extra.Clone()
		if headers == nil {
			headers = http.Header{}
		}
		headers.Set("If-None-Match", condition)
		response := browser.request("GET", assetURL, nil, headers)
		if response.Code != status || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("ETag") != "" {
			t.Fatalf("conditional GET bypassed access/existence checks: got %d, want %d; headers=%v body=%s", response.Code, status, response.Header(), response.Body)
		}
	}
}

func TestIconConditionalGET(t *testing.T) {
	a, err := Open(coreConfig(t, false))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	browser := newIconHTTPBrowser(t, a)
	browser.bootstrap()
	browser.object("POST", "/setup", map[string]any{"siteName": "Icon cache", "mode": ModeOpenEdit, "seedDemo": false}, 201)
	space := coreSpace(browser.bootstrap(), "shared")
	path := "/spaces/" + space + "/icon-packs"
	pack := browser.object("POST", path, iconPackFixture(), 201)
	entry := pack["icons"].([]any)[0].(map[string]any)
	assetURL := entry["url"].(string)
	etag := `"` + entry["sha256"].(string) + `"`
	first := browser.request("GET", assetURL, nil, nil)
	if first.Code != 200 || first.Body.Len() == 0 || first.Header().Get("Content-Type") != "image/svg+xml" {
		t.Fatal("initial icon bytes unavailable", first.Code, first.Header())
	}
	assertIconCacheHeaders(t, first, etag)

	cases := []struct {
		name       string
		conditions []string
		status     int
	}{
		{"strong", []string{etag}, 304},
		{"weak", []string{"W/" + etag}, 304},
		{"list", []string{`"other", W/` + etag + `, "later"`}, 304},
		{"multiple_header_lines", []string{`"other"`, "W/" + etag}, 304},
		{"quoted_comma", []string{`"opaque,tag", ` + etag}, 304},
		{"optional_whitespace", []string{" \tW/" + etag + "\t "}, 304},
		{"empty_list_members", []string{",, " + etag + ", "}, 304},
		{"wildcard", []string{"*"}, 304},
		{"absent", nil, 200},
		{"different", []string{`W/"other"`}, 200},
		{"different_quoted_commas", []string{`"opaque,with,commas"`}, 200},
		{"unquoted", []string{entry["sha256"].(string)}, 200},
		{"unterminated", []string{etag[:len(etag)-1]}, 200},
		{"trailing_junk", []string{etag + "junk"}, 200},
		{"invalid_list_member", []string{etag + ", invalid"}, 200},
		{"invalid_weak_separator", []string{"W/ " + etag}, 200},
		{"invalid_wildcard_list", []string{"*, " + etag}, 200},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			response := browser.request("GET", assetURL, nil, http.Header{"If-None-Match": test.conditions})
			if response.Code != test.status {
				t.Fatalf("conditional GET returned %d, want %d: %s", response.Code, test.status, response.Body)
			}
			assertIconCacheHeaders(t, response, etag)
			if response.Code == 304 {
				if response.Body.Len() != 0 || response.Header().Get("Content-Type") == "application/json; charset=utf-8" {
					t.Fatal("304 must not contain an image or JSON response body", response.Header(), response.Body)
				}
			} else if !bytes.Equal(response.Body.Bytes(), first.Body.Bytes()) {
				t.Fatal("a non-matching validator changed the image response")
			}
		})
	}

	// Fail after the handler has prepared a successful image response. The
	// router must not leave that image's validators on its commit-error JSON.
	a.route("GET /api/v1/icon-cache-commit-failure/{spaceId}/{digest}", false, func(r *Request) (*Response, error) {
		response, err := a.readIconAsset(r)
		if err != nil {
			return nil, err
		}
		r.Writer.Header().Set("Last-Modified", "Mon, 19 Oct 2026 00:00:00 GMT")
		transaction, ok := r.Q.(*sql.Tx)
		if !ok {
			t.Fatal("HTTP fixture did not provide its read transaction")
		}
		if err := transaction.Rollback(); err != nil {
			return nil, err
		}
		return response, nil
	})
	for _, condition := range []string{"", etag} {
		response := browser.request("GET", "/api/v1/icon-cache-commit-failure/"+space+"/"+entry["sha256"].(string), nil, http.Header{"If-None-Match": []string{condition}})
		if response.Code != 500 || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("ETag") != "" || response.Header().Get("Last-Modified") != "" || response.Header().Get("Content-Type") != "application/json; charset=utf-8" {
			t.Fatal("failed read transaction retained successful image cache headers", response.Code, response.Header())
		}
	}

	// A content hash or wildcard never proves that the requested asset exists.
	missingURL := "/api/v1/spaces/" + space + "/icons/" + strings.Repeat("0", 64)
	assertIconCacheDenied(t, browser, missingURL, `"`+strings.Repeat("0", 64)+`"`, 404, nil)
	browser.object("DELETE", path+"/"+pack["id"].(string), nil, 204)
	assertIconCacheDenied(t, browser, assetURL, etag, 404, nil)
}

func TestIconConditionalGETRechecksAuthorization(t *testing.T) {
	a, err := Open(coreConfig(t, false))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	owner := newIconHTTPBrowser(t, a)
	owner.bootstrap()
	credentials := map[string]any{"username": "icon-cache-owner", "password": "icon cache owner password"}
	owner.object("POST", "/setup", map[string]any{"siteName": "Private icons", "mode": ModePrivateMulti, "username": credentials["username"], "password": credentials["password"], "seedDemo": false}, 201)
	boot := owner.bootstrap()
	shared, personal := coreSpace(boot, "shared"), coreSpace(boot, "personal")
	pack := owner.object("POST", "/spaces/"+shared+"/icon-packs", iconPackFixture(), 201)
	entry := pack["icons"].([]any)[0].(map[string]any)
	assetURL := entry["url"].(string)
	etag := `"` + entry["sha256"].(string) + `"`
	personalPack := owner.object("POST", "/spaces/"+personal+"/icon-packs", iconPackFixture(), 201)
	personalURL := personalPack["icons"].([]any)[0].(map[string]any)["url"].(string)
	if response := owner.request("GET", assetURL, nil, http.Header{"If-None-Match": []string{etag}}); response.Code != 304 {
		t.Fatal("authorized owner could not revalidate an existing icon", response.Code)
	}
	anonymous := newIconHTTPBrowser(t, a)
	anonymous.bootstrap()
	assertIconCacheDenied(t, anonymous, assetURL, etag, 401, nil)

	readCredential := owner.object("POST", "/integrations/tokens", map[string]any{"name": "Read cached icons", "spaceId": shared, "actions": []string{"navigation:read"}, "expiresAt": time.Now().UTC().Add(time.Hour)}, 201)
	readHeaders := http.Header{"Authorization": []string{"Bearer " + readCredential["token"].(string)}, "If-None-Match": []string{"W/" + etag}}
	if response := anonymous.request("GET", assetURL, nil, readHeaders); response.Code != 304 || response.Body.Len() != 0 {
		t.Fatal("scoped read credential could not revalidate the icon", response.Code)
	}
	// The identical bytes and ETag exist in another space; the read credential
	// must still be denied there before any 304 response.
	assertIconCacheDenied(t, anonymous, personalURL, etag, 404, readHeaders)
	writeCredential := owner.object("POST", "/integrations/tokens", map[string]any{"name": "Write without read", "spaceId": shared, "actions": []string{"navigation:write"}, "expiresAt": time.Now().UTC().Add(time.Hour)}, 201)
	assertIconCacheDenied(t, anonymous, assetURL, etag, 403, http.Header{"Authorization": []string{"Bearer " + writeCredential["token"].(string)}})
	owner.object("DELETE", "/integrations/tokens/"+readCredential["credential"].(map[string]any)["id"].(string), nil, 200)
	assertIconCacheDenied(t, anonymous, assetURL, etag, 401, readHeaders)
	assertIconCacheDenied(t, owner, assetURL, etag, 401, http.Header{"Authorization": []string{"Bearer invalid"}})

	owner.object("POST", "/auth/logout", map[string]any{}, 200)
	assertIconCacheDenied(t, owner, assetURL, etag, 401, nil)
	owner.bootstrap()
	owner.object("POST", "/auth/login", credentials, 200)
	owner.bootstrap()
	owner.object("PUT", "/spaces/"+shared, map[string]any{"name": "Published icons", "published": true}, 200)
	owner.object("PUT", "/settings", map[string]any{"siteName": "Public icons", "mode": ModePublicRead, "registrationEnabled": false}, 200)
	if response := anonymous.request("GET", assetURL, nil, http.Header{"If-None-Match": []string{etag}}); response.Code != 304 {
		t.Fatal("a public viewer could not revalidate a published icon", response.Code)
	}
	assertIconCacheDenied(t, anonymous, personalURL, etag, 404, nil)
	owner.bootstrap()
	owner.object("POST", "/auth/login", credentials, 200)
	owner.bootstrap()
	owner.object("PUT", "/spaces/"+shared, map[string]any{"name": "Unpublished icons", "published": false}, 200)
	assertIconCacheDenied(t, anonymous, assetURL, etag, 404, nil)
	owner.object("PUT", "/spaces/"+shared, map[string]any{"name": "Published icons", "published": true}, 200)
	owner.object("PUT", "/settings", map[string]any{"siteName": "Private again", "mode": ModePrivateMulti, "registrationEnabled": false}, 200)
	assertIconCacheDenied(t, anonymous, assetURL, etag, 401, nil)
	assertIconCacheDenied(t, owner, assetURL, etag, 401, nil)
}
