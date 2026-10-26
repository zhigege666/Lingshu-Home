package home

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type storagePublicError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type storageBootstrap struct {
	State     string              `json:"state"`
	Provider  string              `json:"provider,omitempty"`
	Source    string              `json:"source"`
	Language  string              `json:"language"`
	CSRFToken string              `json:"csrfToken"`
	Version   string              `json:"version"`
	Error     *storagePublicError `json:"error,omitempty"`
}

// Runtime reserves the existing instance lease before selecting any database.
type Runtime struct {
	mu         sync.RWMutex
	gate       chan struct{}
	config     Config
	app        *App
	lease      *fileLease
	ctx        context.Context
	cancel     context.CancelFunc
	version    string
	token      string
	state      string
	failure    *storagePublicError
	closed     bool
	limitMu    sync.Mutex
	limitStart time.Time
	limitCount int
}

func OpenRuntime(c Config) (*Runtime, error) {
	if c.storageSource == "" {
		if c.StorageProvider != "" || c.DatabaseURL != "" {
			c.storageSource = "cli"
		} else {
			c.storageSource = "default"
		}
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	version, err := os.ReadFile(c.VersionFile)
	if err != nil || strings.TrimSpace(string(version)) == "" {
		return nil, errors.New("a nonempty product VERSION file is required")
	}
	if err := os.MkdirAll(c.DataDir, 0700); err != nil {
		return nil, errors.New("cannot create persistent data directory")
	}
	lease, err := acquireFileLease(filepath.Join(c.DataDir, ".instance.lock"))
	if err != nil {
		return nil, err
	}
	success := false
	ctx, cancel := context.WithCancel(context.Background())
	defer func() {
		if !success {
			cancel()
			_ = lease.Close()
		}
	}()
	c.runtimeLease = lease
	c.runtimeContext = ctx
	c, required, err := resolveRuntimeStorage(c)
	if err != nil {
		return nil, err
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, errors.New("cannot create storage setup protection")
	}
	rt := &Runtime{config: c, lease: lease, ctx: ctx, cancel: cancel, version: strings.TrimSpace(string(version)), token: base64.RawURLEncoding.EncodeToString(secret), state: "required", gate: make(chan struct{}, 1)}
	if !required {
		rt.openConfigured()
	}
	success = true
	return rt, nil
}

func (rt *Runtime) openConfigured() {
	rt.mu.RLock()
	c := rt.config
	rt.mu.RUnlock()
	var app *App
	err := validateRuntimeTarget(c)
	if err == nil {
		app, err = Open(c)
	}
	if err == nil && c.storageSource == "file" {
		if err = markStorageProvisioned(c.DataDir, c); err != nil {
			_ = app.Close()
			app = nil
		}
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if err != nil {
		var failure *APIError
		if !errors.As(err, &failure) {
			failure = storageConnectionError(err)
		}
		rt.app = nil
		rt.state = "error"
		rt.failure = &storagePublicError{Code: failure.Code, Message: failure.Message}
		return
	}
	rt.app = app
	rt.state = "ready"
	rt.failure = nil
}

func (rt *Runtime) StorageProvider() string {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	return rt.config.StorageProvider
}
func (rt *Runtime) snapshot() storageBootstrap {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	language := rt.config.Language
	if rt.app != nil {
		// An empty committed value means the user still needs to choose.
		// currentLanguage includes a rendering fallback, not an instance choice.
		if selected, ok := rt.app.language.Load().(string); ok {
			language = selected
		}
	}
	value := storageBootstrap{State: rt.state, Provider: rt.config.StorageProvider, Source: rt.config.storageSource, Language: language, CSRFToken: rt.token, Version: rt.version}
	if rt.failure != nil {
		copy := *rt.failure
		value.Error = &copy
	}
	return value
}
func storageJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func (rt *Runtime) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	path := r.URL.Path
	if path == "/api/v1/storage/bootstrap" {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writeError(w, &APIError{Status: 405, Code: "method_not_allowed", Message: "Use GET for storage status."})
			return
		}
		storageJSON(w, 200, rt.snapshot())
		return
	}
	switch path {
	case "/api/v1/storage/test", "/api/v1/storage/configure", "/api/v1/storage/retry":
		rt.mutate(w, r)
		return
	}
	rt.mu.RLock()
	app := rt.app
	c := rt.config
	closed := rt.closed
	state := rt.state
	rt.mu.RUnlock()
	if closed {
		writeError(w, &APIError{Status: 503, Code: "storage_closed", Message: "The application is shutting down."})
		return
	}
	if app != nil {
		app.ServeHTTP(w, r)
		return
	}
	if strings.HasPrefix(path, "/api/") || path == "/mcp" || path == "/health" {
		code, message := "storage_setup_required", "Choose and confirm storage before using Home."
		if state == "error" {
			code, message = "storage_unavailable", "Storage is unavailable. Check storage status before retrying."
		}
		writeError(w, &APIError{Status: 503, Code: code, Message: message})
		return
	}
	(&App{config: c}).serveFrontend(w, r)
}
func (rt *Runtime) authorizeMutation(r *http.Request) error {
	if r.Method != http.MethodPost {
		return &APIError{Status: 405, Code: "method_not_allowed", Message: "Use POST for storage setup."}
	}
	if r.Header.Get("Authorization") != "" {
		return forbidden()
	}
	if strings.EqualFold(r.Header.Get("Sec-Fetch-Site"), "cross-site") {
		return forbidden()
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || !strings.EqualFold(parsed.Host, r.Host) || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
			return forbidden()
		}
	}
	token := r.Header.Get("X-CSRF-Token")
	if len(token) != len(rt.token) || subtle.ConstantTimeCompare([]byte(token), []byte(rt.token)) != 1 {
		return forbidden()
	}
	rt.limitMu.Lock()
	defer rt.limitMu.Unlock()
	now := time.Now()
	if rt.limitStart.IsZero() || now.Sub(rt.limitStart) >= time.Minute {
		rt.limitStart = now
		rt.limitCount = 0
	}
	if rt.limitCount >= 40 {
		return &APIError{Status: 429, Code: "storage_rate_limited", Message: "Too many storage connection attempts. Wait one minute before retrying."}
	}
	rt.limitCount++
	return nil
}
func decodeStorageInput(w http.ResponseWriter, r *http.Request) (storageInput, error) {
	var input storageInput
	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return input, invalid("Provide one valid storage configuration object.")
	}
	var extra any
	if !errors.Is(decoder.Decode(&extra), io.EOF) {
		return input, invalid("Provide exactly one storage configuration object.")
	}
	return input, nil
}
func (rt *Runtime) mutate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if err := rt.authorizeMutation(r); err != nil {
		var api *APIError
		if errors.As(err, &api) && api.Status == 429 {
			w.Header().Set("Retry-After", "60")
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
		}
		writeError(w, err)
		return
	}
	select {
	case rt.gate <- struct{}{}:
		defer func() { <-rt.gate }()
	default:
		writeError(w, &APIError{Status: 409, Code: "storage_busy", Message: "A storage operation is already running. Check status before retrying."})
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(rt.ctx, cancel)
	defer func() { stop(); cancel() }()
	rt.mu.RLock()
	state, c, closed := rt.state, rt.config, rt.closed
	rt.mu.RUnlock()
	if closed || rt.ctx.Err() != nil {
		writeError(w, &APIError{Status: 503, Code: "storage_closed", Message: "The application is shutting down."})
		return
	}
	if r.URL.Path == "/api/v1/storage/retry" {
		if state != "error" {
			writeError(w, &APIError{Status: 409, Code: "storage_retry_unavailable", Message: "There is no failed storage connection to retry."})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1024)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		var empty struct{}
		if err := decoder.Decode(&empty); err != nil && !errors.Is(err, io.EOF) {
			writeError(w, invalid("Storage retry does not accept replacement connection settings."))
			return
		}
		var extra any
		if !errors.Is(decoder.Decode(&extra), io.EOF) {
			writeError(w, invalid("Storage retry accepts only an empty request."))
			return
		}
		if err := ctx.Err(); err != nil {
			writeError(w, &APIError{Status: 408, Code: "storage_cancelled", Message: "The storage request was cancelled."})
			return
		}
		rt.openConfigured()
		storageJSON(w, 200, rt.snapshot())
		return
	}
	if state != "required" {
		writeError(w, &APIError{Status: 409, Code: "storage_already_configured", Message: "Storage has already been selected. Changing databases requires a separate migration."})
		return
	}
	input, err := decodeStorageInput(w, r)
	if err != nil {
		writeError(w, err)
		return
	}
	candidate, err := storageInputConfig(c, input)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := probeStorage(ctx, candidate); err != nil {
		writeError(w, err)
		return
	}
	if r.URL.Path == "/api/v1/storage/test" {
		storageJSON(w, 200, map[string]any{"ok": true})
		return
	}
	if err := ctx.Err(); err != nil {
		writeError(w, &APIError{Status: 408, Code: "storage_cancelled", Message: "The storage request was cancelled."})
		return
	}
	if _, err := inspectLegacySQLite(c.DataDir); err != nil {
		writeError(w, &APIError{Status: 409, Code: "storage_files_changed", Message: "Instance files changed during setup. Restart and verify the existing data before continuing."})
		return
	}
	if _, err := os.Lstat(filepath.Join(c.DataDir, "lingshu-home.db")); !errors.Is(err, os.ErrNotExist) {
		writeError(w, &APIError{Status: 409, Code: "storage_files_changed", Message: "An existing database appeared during setup. Restart to use that database."})
		return
	}
	if err := writeStorageConfig(c.DataDir, candidate); err != nil {
		writeError(w, &APIError{Status: 500, Code: "storage_config_write_failed", Message: "Could not save storage configuration. Check the data directory permissions and existing configuration."})
		return
	}
	rt.mu.Lock()
	rt.config = candidate
	rt.state = "error"
	rt.failure = &storagePublicError{Code: "storage_initializing", Message: "Storage initialization is in progress."}
	rt.mu.Unlock()
	rt.openConfigured()
	storageJSON(w, 200, rt.snapshot())
}
func (rt *Runtime) Close() error {
	rt.cancel()
	rt.gate <- struct{}{}
	defer func() { <-rt.gate }()
	rt.mu.Lock()
	if rt.closed {
		rt.mu.Unlock()
		return nil
	}
	rt.closed = true
	rt.state = "error"
	rt.failure = &storagePublicError{Code: "storage_closed", Message: "The application is shutting down."}
	app, lease := rt.app, rt.lease
	rt.app = nil
	rt.lease = nil
	rt.mu.Unlock()
	var appErr, leaseErr error
	if app != nil {
		appErr = app.Close()
	}
	if lease != nil {
		leaseErr = lease.Close()
	}
	return errors.Join(appErr, leaseErr)
}
