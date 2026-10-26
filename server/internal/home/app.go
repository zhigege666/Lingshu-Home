package home

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type App struct {
	store            *Store
	config           Config
	mux              *http.ServeMux
	writeGate        chan struct{}
	documentGate     chan struct{}
	documentScanGate chan struct{}
	secret           []byte
	version          string
	limits           *authLimiter
	dummyPassword    string
	ctx              context.Context
	cancel           context.CancelFunc
	workers          sync.WaitGroup
	iconHTTPClient   *http.Client
	iconFetchGate    chan struct{}
	integrationWake  chan struct{}
	autoIconWake     chan struct{}
	autoIconMu       sync.Mutex
	autoIconCancel   context.CancelFunc
	networkProxy     *networkProxyManager
	language         atomic.Value
}

type Request struct {
	SessionInfo         *SessionRecord
	App                 *App
	HTTP                *http.Request
	Writer              http.ResponseWriter
	Q                   Queryer
	Settings            Settings
	User                *User
	SessionToken        string
	Input               json.RawMessage
	Params              map[string]string
	TokenSpaceID        string
	TokenSourceID       string
	AllowedActions      map[string]bool
	Bearer              bool
	WakeIntegrations    bool
	WakeAutoIcons       bool
	CancelAutoIcons     bool
	BearerTokenHash     string
	NetworkProxyUpdate  *networkProxyRuntime
	LanguageUpdate      string
	DocumentFileChanged bool
}

type Response struct {
	Status           int
	Data             any
	Body             []byte
	ContentType      string
	AfterTransaction func() (*Response, error)
}

type handlerFunc func(*Request) (*Response, error)

func ok(data any) *Response { return &Response{Status: 200, Data: data} }

func Open(c Config) (*App, error) {
	return openWithIconHTTPClient(c, nil)
}

// The private constructor lets lifecycle tests supply controlled icon I/O
// before a recovered job can start. Public configuration always uses the
// built-in public-address-only HTTP client.
func openWithIconHTTPClient(c Config, iconClient *http.Client) (*App, error) {
	if err := c.validate(); err != nil {
		return nil, err
	}
	version, err := os.ReadFile(c.VersionFile)
	if err != nil || strings.TrimSpace(string(version)) == "" {
		return nil, errors.New("a nonempty product VERSION file is required")
	}
	parent := c.runtimeContext
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	injectedIconClient := iconClient != nil
	if iconClient == nil {
		iconClient = newIconHTTPClient()
	}
	a := &App{config: c, mux: http.NewServeMux(), writeGate: make(chan struct{}, 1), version: strings.TrimSpace(string(version)), limits: &authLimiter{}, ctx: ctx, cancel: cancel, iconHTTPClient: iconClient, iconFetchGate: make(chan struct{}, 1), integrationWake: make(chan struct{}, 1)}
	a.autoIconWake = make(chan struct{}, 1)
	a.documentGate = make(chan struct{}, 1)
	a.documentScanGate = make(chan struct{}, 1)
	startup, done := context.WithTimeout(ctx, 30*time.Second)
	defer done()
	a.store, err = openStore(startup, c)
	if err != nil {
		cancel()
		return nil, err
	}
	err = a.initializeLanguage(startup)
	if err == nil {
		a.secret, err = readOrCreateKey(filepath.Join(c.DataDir, "csrf.key"))
	}
	if err == nil {
		a.dummyPassword = dummyPasswordHash
		err = a.initializeIntegrations()
	}
	if err == nil {
		err = a.initializeNetworkProxy()
	}
	if err != nil {
		_ = a.Close()
		return nil, err
	}
	if !injectedIconClient {
		a.iconHTTPClient = a.newOutboundIconHTTPClient()
	}
	a.registerRoutes()
	a.registerIntegrationRoutes()
	a.registerIconRoutes()
	a.registerComponentTemplateRoutes()
	a.registerNetworkProxyRoutes()
	a.registerDocumentRoutes()
	a.startIntegrationWorkers()
	a.startAutoIconWorker()
	a.startDocumentWorker()
	return a, nil
}

func (a *App) Close() error {
	a.cancel()
	a.workers.Wait()
	if a.store != nil {
		return a.store.Close()
	}
	return nil
}

func (a *App) ServeHTTP(w http.ResponseWriter, h *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Content-Language", a.currentLanguage())
	if strings.HasPrefix(h.URL.Path, "/api/") || h.URL.Path == "/mcp" || h.URL.Path == "/health" {
		w.Header().Set("Cache-Control", "no-store")
		if err := a.store.CheckLease(h.Context()); err != nil {
			writeError(w, err)
			return
		}
	}
	a.mux.ServeHTTP(w, h)
}

func (r *Request) param(name string) string {
	if value, ok := r.Params[name]; ok {
		return value
	}
	return r.HTTP.PathValue(name)
}

func (r *Request) decode(target any) error {
	var reader io.Reader = r.HTTP.Body
	if r.Input != nil {
		reader = bytes.NewReader(r.Input)
	}
	decoder := json.NewDecoder(io.LimitReader(reader, 12*1024*1024+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return invalid("Invalid JSON request or unknown fields.")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return invalid("Exactly one JSON value is required.")
	}
	return nil
}

func writeError(w http.ResponseWriter, err error) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Del("ETag")
	w.Header().Del("Last-Modified")
	var api *APIError
	if !errors.As(err, &api) {
		// Database errors can contain private SQL parameters; keep server logs generic.
		log.Printf("request failed (%T)", err)
		api = &APIError{Status: 500, Code: "internal_error", Message: "The request could not be completed."}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(api.Status)
	_ = json.NewEncoder(w).Encode(api)
}

func (a *App) route(pattern string, write bool, handler handlerFunc) {
	a.mux.HandleFunc(pattern, func(w http.ResponseWriter, h *http.Request) {
		// Filesystem work is serialized separately from navigation/database work.
		// Take this first: no request may hold the global gate while waiting for
		// an ongoing file operation which will later need a short DB commit.
		if write && (strings.Contains(h.URL.Path, "/documents") || strings.Contains(h.URL.Path, "/document-sources")) {
			select {
			case a.documentGate <- struct{}{}:
				defer func() { <-a.documentGate }()
			case <-h.Context().Done():
				return
			}
		}
		if h.URL.Path == "/api/v1/setup" || h.URL.Path == "/api/v1/setup/language" || h.URL.Path == "/api/v1/auth/login" || h.URL.Path == "/api/v1/auth/register" || h.URL.Path == "/api/v1/account/password" {
			allowed, retry := a.limits.allow(h.RemoteAddr)
			if !allowed {
				w.Header().Set("Retry-After", strconv.Itoa(retry))
				writeError(w, &APIError{Status: 429, Code: "rate_limited", Message: "Too many authentication attempts. Try again after the indicated delay."})
				return
			}
		}
		globalLocked := false
		defer func() {
			if globalLocked {
				<-a.writeGate
			}
		}()
		if write {
			select {
			case a.writeGate <- struct{}{}:
				globalLocked = true
			case <-h.Context().Done():
				return
			}
		}
		if err := a.store.CheckLease(h.Context()); err != nil {
			writeError(w, err)
			return
		}
		options := &sql.TxOptions{}
		if !write && a.store.Provider == "postgres" {
			options.ReadOnly = true
			options.Isolation = sql.LevelRepeatableRead
		}
		tx, err := a.store.DB.BeginTx(h.Context(), options)
		if err != nil {
			writeError(w, err)
			return
		}
		defer tx.Rollback()
		r := &Request{App: a, HTTP: h, Writer: w, Q: tx}
		r.Settings, err = a.loadSettings(h.Context(), tx)
		if err != nil {
			writeError(w, err)
			return
		}
		// Use the same transaction snapshot for both successful and failed
		// responses while another request may be confirming the first language.
		responseLanguage := r.Settings.Language
		if responseLanguage == "" {
			responseLanguage = "zh-CN"
		}
		w.Header().Set("Content-Language", responseLanguage)
		values := h.Header.Values("Authorization")
		if len(values) > 0 {
			auth := h.Header.Get("Authorization")
			if len(values) != 1 || len(auth) < 8 || !strings.EqualFold(auth[:7], "Bearer ") {
				err = unauthorized()
			} else {
				err = a.authenticateBearer(r, strings.TrimSpace(auth[7:]))
			}
		} else {
			err = a.authenticateCookie(r)
		}
		if err == nil && write {
			err = a.checkCSRF(r)
		}
		var response *Response
		if err == nil {
			response, err = handler(r)
		}
		if err != nil {
			// Cookies established by a failed transaction must not replace a
			// browser's still-valid session with an uncommitted token.
			w.Header().Del("Set-Cookie")
			writeError(w, err)
			return
		}
		if err = tx.Commit(); err != nil {
			w.Header().Del("Set-Cookie")
			writeError(w, err)
			return
		}
		if r.LanguageUpdate != "" {
			a.language.Store(r.LanguageUpdate)
			w.Header().Set("Content-Language", r.LanguageUpdate)
		}
		a.afterNetworkProxyCommit(r)
		if r.WakeIntegrations {
			a.wakeIntegrationWorker()
		}
		a.afterAutoIconCommit(r)
		if response != nil && response.AfterTransaction != nil {
			if globalLocked {
				<-a.writeGate
				globalLocked = false
			}
			for response != nil && response.AfterTransaction != nil {
				response, err = response.AfterTransaction()
				if err != nil {
					writeError(w, documentOperationError(r, err))
					return
				}
			}
		}
		if response == nil {
			w.WriteHeader(204)
			return
		}
		status := response.Status
		if status == 0 {
			status = 200
		}
		if response.ContentType != "" {
			w.Header().Set("Content-Type", response.ContentType)
			w.WriteHeader(status)
			_, _ = w.Write(response.Body)
			return
		}
		if status == 204 || status == http.StatusNotModified {
			w.WriteHeader(status)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(response.Data)
	})
}

func (a *App) registerRoutes() {
	for _, path := range []string{"GET /health", "GET /api/v1/health"} {
		a.mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "version": a.version})
		})
	}
	a.route("GET /api/v1/bootstrap", false, a.bootstrap)
	a.route("POST /api/v1/setup", true, a.setup)
	a.route("POST /api/v1/setup/language", true, a.selectSetupLanguage)
	a.route("POST /api/v1/auth/login", true, a.login)
	a.route("GET /api/v1/settings/session-policy", false, a.getSessionPolicy)
	a.route("PUT /api/v1/settings/session-policy", true, a.updateSessionPolicy)
	a.route("POST /api/v1/auth/renew", true, a.renewSession)
	a.route("GET /api/v1/account/sessions", false, a.listBrowserSessions)
	a.route("POST /api/v1/account/sessions/revoke", true, a.revokeBrowserSession)
	a.route("POST /api/v1/account/sessions/revoke-others", true, a.revokeOtherBrowserSessions)
	a.route("POST /api/v1/auth/logout", true, a.logout)
	a.route("POST /api/v1/auth/register", true, a.register)
	a.route("PUT /api/v1/account/profile", true, a.updateAccountProfile)
	a.route("PUT /api/v1/account/password", true, a.updateAccountPassword)
	a.route("GET /api/v1/settings", false, a.getSettings)
	a.route("PUT /api/v1/settings", true, a.updateSettings)
	a.route("PUT /api/v1/settings/navigation", true, a.updateNavigationSettings)
	a.route("GET /api/v1/admin/users", false, a.listUsers)
	a.route("POST /api/v1/admin/users", true, a.createUser)
	a.route("PUT /api/v1/admin/users/{id}", true, a.updateUser)
	a.route("GET /api/v1/dashboard", false, a.dashboard)
	a.route("GET /api/v1/spaces/{spaceId}/navigation", false, a.getNavigation)
	a.route("POST /api/v1/spaces/{spaceId}/navigation/batch-edit", true, a.batchEditNavigation)
	a.route("PUT /api/v1/spaces/{spaceId}", true, a.updateSpace)
	a.route("PUT /api/v1/spaces/{spaceId}/page", true, a.updatePage)
	a.route("POST /api/v1/spaces/{spaceId}/categories", true, a.createCategory)
	a.route("PUT /api/v1/spaces/{spaceId}/categories/{id}", true, a.updateCategory)
	a.route("DELETE /api/v1/spaces/{spaceId}/categories/{id}", true, a.deleteCategory)
	a.route("POST /api/v1/spaces/{spaceId}/links", true, a.createLink)
	a.route("POST /api/v1/spaces/{spaceId}/links/batch", true, a.batchUpdateLinks)
	a.route("PUT /api/v1/spaces/{spaceId}/links/{id}", true, a.updateLink)
	a.route("DELETE /api/v1/spaces/{spaceId}/links/{id}", true, a.deleteLink)
	a.route("POST /api/v1/spaces/{spaceId}/bookmarks/preview", true, a.previewBookmarks)
	a.route("POST /api/v1/spaces/{spaceId}/bookmarks/import", true, a.importBookmarks)
	a.route("GET /api/v1/spaces/{spaceId}/export", false, a.exportNavigation)
	a.mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { writeError(w, missing()) })
	a.mux.HandleFunc("/", a.serveFrontend)
}

func (a *App) serveFrontend(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	clean := filepath.Clean("/" + r.URL.Path)
	path := filepath.Join(a.config.WebDir, clean)
	info, err := os.Stat(path)
	if err == nil && info.Mode().IsRegular() {
		if clean == "/index.html" {
			a.serveIndex(w, r, path)
			return
		}
		serveStaticAsset(w, r, path, clean)
		return
	}
	if filepath.Ext(clean) != "" || strings.HasPrefix(clean, "/icons/") {
		http.NotFound(w, r)
		return
	}
	index := filepath.Join(a.config.WebDir, "index.html")
	a.serveIndex(w, r, index)
}
