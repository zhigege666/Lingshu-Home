package home

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/net/html"
)

func TestParseInstanceLanguage(t *testing.T) {
	t.Setenv("LINGSHU_STORAGE_PROVIDER", "sqlite")
	t.Setenv("LINGSHU_SECURE_COOKIES", "false")
	t.Setenv("LINGSHU_DATA_DIR", t.TempDir())
	for _, test := range []struct {
		name, environment, want string
		unset, invalid          bool
		args                    []string
	}{
		{name: "default", unset: true, want: ""},
		{name: "empty environment", want: ""},
		{name: "empty flag", environment: "en", args: []string{"--language="}, want: ""},
		{name: "English environment", environment: "en", want: "en"},
		{name: "Chinese environment", environment: "zh-CN", want: "zh-CN"},
		{name: "flag overrides environment", environment: "en", args: []string{"--language", "zh-CN"}, want: "zh-CN"},
		{name: "flag overrides invalid environment", environment: "fr", args: []string{"--language=en"}, want: "en"},
		{name: "invalid environment", environment: "fr", invalid: true},
		{name: "invalid flag", environment: "en", args: []string{"--language", "fr"}, invalid: true},
		{name: "unsupported Chinese alias", environment: "zh", invalid: true},
		{name: "unsupported English alias", environment: "en-US", invalid: true},
		{name: "unexpected argument", environment: "en", args: []string{"en"}, invalid: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("LINGSHU_LANGUAGE", test.environment)
			if test.unset {
				if err := os.Unsetenv("LINGSHU_LANGUAGE"); err != nil {
					t.Fatal(err)
				}
			}
			config, err := ParseConfig(test.args)
			if test.invalid {
				if err == nil {
					t.Fatal("invalid startup language/argument accepted")
				}
				return
			}
			if err != nil || config.Language != test.want {
				t.Fatalf("language=%q, error=%v; want %q", config.Language, err, test.want)
			}
		})
	}
	config := Config{DataDir: t.TempDir()}
	if err := config.validate(); err != nil || config.Language != "" {
		t.Fatalf("zero-value Config must leave first-run language undecided: %q %v", config.Language, err)
	}
}

func TestInitialDocumentLanguageAndCacheValidators(t *testing.T) {
	body := `<head><title>Home</title></head><body><div id="root"></div><script type="module" src="/assets/index-test1234.js"></script></body></html>`
	for _, opening := range []string{
		`<!doctype html><html lang="zh-CN">`,
		`<!doctype html><html data-app="Home" lang='en' class="page">`,
		`<!doctype html><!-- <html lang="zh-CN"> --><HTML LANG=zh-CN data-app="Home">`,
		`<!doctype html><html data-app="Home">`,
	} {
		for _, language := range []string{"zh-CN", "en"} {
			t.Run(language+"/"+opening, func(t *testing.T) {
				dir := t.TempDir()
				if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(opening+body), 0600); err != nil {
					t.Fatal(err)
				}
				app := &App{config: Config{WebDir: dir, Language: language}}
				for _, path := range []string{"/", "/index.html", "/admin"} {
					for _, method := range []string{"GET", "HEAD"} {
						request := httptest.NewRequest(method, path, nil)
						// A browser may revalidate the same on-disk build after
						// an instance language change. Never return its old body.
						request.Header.Set("If-Modified-Since", "Fri, 01 Jan 2100 00:00:00 GMT")
						request.Header.Set("If-None-Match", `"old-language-build"`)
						recorder := httptest.NewRecorder()
						app.serveFrontend(recorder, request)
						if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Language") != language || recorder.Header().Get("Cache-Control") != "no-cache" {
							t.Fatalf("%s %s: status=%d headers=%v", method, path, recorder.Code, recorder.Header())
						}
						if recorder.Header().Get("Last-Modified") != "" || recorder.Header().Get("ETag") != "" {
							t.Fatal("HTML must not expose a disk-only cache validator")
						}
						if method == "HEAD" {
							if recorder.Body.Len() != 0 || recorder.Header().Get("Content-Length") == "" {
								t.Fatal("HEAD must report the transformed representation without a body")
							}
							continue
						}
						if !strings.HasSuffix(recorder.Body.String(), body) {
							t.Fatal("localization rewrote the built document body or asset URL")
						}
						if actual := rootDocumentLanguage(t, recorder.Body.Bytes()); actual != language {
							t.Fatalf("initial HTML language=%q, want %q before JavaScript", actual, language)
						}
					}
				}
				original, err := os.ReadFile(filepath.Join(dir, "index.html"))
				if err != nil || string(original) != opening+body {
					t.Fatal("serving a language must not modify static files")
				}
			})
		}
	}
}

func rootDocumentLanguage(t *testing.T, content []byte) string {
	t.Helper()
	tokens := html.NewTokenizer(bytes.NewReader(content))
	for {
		kind := tokens.Next()
		if kind == html.ErrorToken {
			t.Fatal("response has no document element")
		}
		if kind == html.StartTagToken {
			tag := tokens.Token()
			if tag.Data == "html" {
				for _, attribute := range tag.Attr {
					if attribute.Key == "lang" {
						return attribute.Val
					}
				}
				t.Fatal("document element has no language")
			}
		}
	}
}

// Use the production HTTP router, transactions, cookies and CSRF flow without
// a listening socket. This also runs in sandboxes that disallow TCP listeners.
type appTestTransport struct{ app *App }

func (transport appTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	request.RemoteAddr = "127.0.0.1:12345"
	recorder := httptest.NewRecorder()
	transport.app.ServeHTTP(recorder, request)
	response := recorder.Result()
	response.Request = request
	return response, nil
}

func newAppTestBrowser(t *testing.T, app *App) *coreBrowser {
	t.Helper()
	browser := newCoreBrowser(t, "http://home.test")
	browser.client.Transport = appTestTransport{app}
	return browser
}

func TestInstanceLanguageDefaultsAndBootstrap(t *testing.T) {
	for _, language := range []string{"zh-CN", "en"} {
		t.Run(language, func(t *testing.T) {
			config := coreConfig(t, false)
			config.Language = language
			if err := os.MkdirAll(config.WebDir, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(config.WebDir, "index.html"), []byte(`<!doctype html><html lang="zh-CN"><body>Home</body></html>`), 0600); err != nil {
				t.Fatal(err)
			}
			app, err := Open(config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = app.Close() })
			browser := newAppTestBrowser(t, app)
			bootstrap := browser.bootstrap()
			if bootstrap["language"] != language {
				t.Fatal("bootstrap does not match startup language")
			}
			for _, path := range []string{"/", "/api/v1/bootstrap", "/health", "/api/v1/unknown"} {
				response, err := browser.client.Get(browser.base + path)
				if err != nil {
					t.Fatal(err)
				}
				body, readErr := io.ReadAll(response.Body)
				_ = response.Body.Close()
				if readErr != nil || response.Header.Get("Content-Language") != language {
					t.Fatalf("response language mismatch for %s: %v %v", path, response.Header, readErr)
				}
				if path == "/" && rootDocumentLanguage(t, body) != bootstrap["language"] {
					t.Fatal("initial HTML and bootstrap disagree")
				}
			}
			setup := map[string]any{"siteName": "My untouched site", "mode": ModePublicRead, "username": "owner", "displayName": "Tester", "password": "a valid test password", "seedDemo": true}
			setup["language"] = "en"
			if status, _ := browser.call("POST", "/setup", setup); status != 400 {
				t.Fatal("setup must reject a persisted language setting")
			}
			delete(setup, "language")
			browser.ok("POST", "/setup", setup)
			bootstrap = browser.bootstrap()
			shared := coreSpace(bootstrap, "shared")
			personal := coreSpace(bootstrap, "personal")
			wantShared, wantPage, wantPersonal, wantCategory, wantLink := "共享空间", "我的导航", "Tester 的空间", "开发工具", "Go 文档"
			if language == "en" {
				wantShared, wantPage, wantPersonal, wantCategory, wantLink = "Shared", "Home", "Tester's space", "Build & develop", "Go documentation"
			}
			for _, space := range bootstrap["spaces"].([]any) {
				s := space.(map[string]any)
				if s["id"] == shared && s["name"] != wantShared || s["id"] == personal && s["name"] != wantPersonal {
					t.Fatalf("wrong newly created space name: %v", s)
				}
			}
			dashboard := browser.ok("GET", "/dashboard?spaceId="+shared, nil)
			if dashboard["page"].(map[string]any)["name"] != wantPage {
				t.Fatal("new page default does not use the instance language")
			}
			navigation := browser.ok("GET", "/spaces/"+shared+"/navigation", nil)["data"].(map[string]any)
			categories := navigation["categories"].([]any)
			if len(categories) != 3 || categories[0].(map[string]any)["name"] != wantCategory {
				t.Fatal("demo category was not localized at creation")
			}
			found := false
			for _, link := range navigation["links"].([]any) {
				if link.(map[string]any)["url"] == "https://go.dev/doc/" {
					found = link.(map[string]any)["title"] == wantLink
				}
			}
			if !found {
				t.Fatal("demo link was not localized at creation")
			}
			if status, _ := browser.call("PUT", "/settings", map[string]any{"siteName": "My untouched site", "mode": ModePublicRead, "registrationEnabled": false, "language": "en"}); status != 400 {
				t.Fatal("settings must reject a persisted language setting")
			}
			if browser.bootstrap()["language"] != language {
				t.Fatal("HTTP settings changed startup language")
			}
		})
	}
}
