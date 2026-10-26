package home

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func storageFixtureConfig(t *testing.T) Config {
	t.Helper()
	root := t.TempDir()
	web := filepath.Join(root, "web")
	if err := os.Mkdir(web, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(web, "index.html"), []byte("<!doctype html><html><body>Home</body></html>"), 0600); err != nil {
		t.Fatal(err)
	}
	version := filepath.Join(root, "VERSION")
	if err := os.WriteFile(version, []byte("0.0.3\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return Config{DataDir: filepath.Join(root, "data"), WebDir: web, VersionFile: version, Language: "zh-CN", storageSource: "default"}
}
func storageRequest(rt *Runtime, method, path string, body any, token, origin string) *httptest.ResponseRecorder {
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	r := httptest.NewRequest(method, "http://home.test"+path, bytes.NewReader(data))
	if token != "" {
		r.Header.Set("X-CSRF-Token", token)
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	rt.ServeHTTP(w, r)
	return w
}
func requireNoStorageFile(t *testing.T, c Config, name string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(c.DataDir, name)); !os.IsNotExist(err) {
		t.Fatalf("unexpected %s: %v", name, err)
	}
}
func TestStorageRuntimeSQLiteRoundTrip(t *testing.T) {
	c := storageFixtureConfig(t)
	rt, err := OpenRuntime(c)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	if rt.snapshot().State != "required" {
		t.Fatal(rt.snapshot())
	}
	requireNoStorageFile(t, c, "lingshu-home.db")
	requireNoStorageFile(t, c, storageConfigFilename)
	if got := storageRequest(rt, "GET", "/api/v1/bootstrap", nil, "", ""); got.Code != 503 {
		t.Fatal(got.Code)
	}
	input := storageInput{Provider: "sqlite"}
	if got := storageRequest(rt, "POST", "/api/v1/storage/test", input, rt.token, "http://home.test"); got.Code != 200 {
		t.Fatal(got.Code, got.Body.String())
	}
	requireNoStorageFile(t, c, "lingshu-home.db")
	requireNoStorageFile(t, c, storageConfigFilename)
	for _, bad := range []struct{ token, origin string }{{"", "http://home.test"}, {"invalid", "http://home.test"}, {rt.token, "https://attacker.test"}} {
		if got := storageRequest(rt, "POST", "/api/v1/storage/configure", input, bad.token, bad.origin); got.Code != 403 {
			t.Fatalf("CSRF accepted: %d %s", got.Code, got.Body.String())
		}
	}
	if got := storageRequest(rt, "POST", "/api/v1/storage/configure", input, rt.token, "http://home.test"); got.Code != 200 || rt.snapshot().State != "ready" {
		t.Fatal(got.Code, got.Body.String())
	}
	st, err := os.Stat(filepath.Join(c.DataDir, storageConfigFilename))
	if err != nil || st.Mode().Perm() != 0600 {
		t.Fatal(st, err)
	}
	if got := storageRequest(rt, "POST", "/api/v1/storage/configure", input, rt.token, "http://home.test"); got.Code != 409 {
		t.Fatal("configuration remained writable", got.Code)
	}
	if got := storageRequest(rt, "POST", "/api/v1/storage/test", input, rt.token, "http://home.test"); got.Code != 409 {
		t.Fatal("connection test remained exposed", got.Code)
	}
	if err := rt.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenRuntime(c)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if s := reopened.snapshot(); s.State != "ready" || s.Source != "file" || s.Provider != "sqlite" {
		t.Fatal(s)
	}
}
func TestStorageRuntimeReservesLegacyInstanceLease(t *testing.T) {
	c := storageFixtureConfig(t)
	rt, err := OpenRuntime(c)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	direct := c
	direct.StorageProvider = "sqlite"
	if app, err := Open(direct); err == nil {
		app.Close()
		t.Fatal("legacy process opened the unconfigured runtime directory")
	}
	requireNoStorageFile(t, c, "lingshu-home.db")
	if got := storageRequest(rt, "POST", "/api/v1/storage/configure", storageInput{Provider: "sqlite"}, rt.token, "http://home.test"); got.Code != 200 || rt.snapshot().State != "ready" {
		t.Fatal(got.Code, got.Body.String())
	}
	if err := rt.Close(); err != nil {
		t.Fatal(err)
	}
	app, err := Open(direct)
	if err != nil {
		t.Fatal("runtime did not release the lease", err)
	}
	app.Close()
}
func TestStorageRuntimeExternalFailureCannotReconfigureOrFallback(t *testing.T) {
	c := storageFixtureConfig(t)
	c.StorageProvider = "postgres"
	c.DatabaseURL = "postgres://fixture:do-not-echo-this@127.0.0.1:1/unreachable?sslmode=disable&connect_timeout=1"
	c.storageSource = "environment"
	rt, err := OpenRuntime(c)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	if s := rt.snapshot(); s.State != "error" || s.Source != "environment" || s.Provider != "postgres" {
		t.Fatal(s)
	}
	status := storageRequest(rt, "GET", "/api/v1/storage/bootstrap", nil, "", "")
	if status.Code != 200 || strings.Contains(status.Body.String(), "do-not-echo-this") || strings.Contains(status.Body.String(), "postgres://") {
		t.Fatal(status.Code, status.Body.String())
	}
	requireNoStorageFile(t, c, "lingshu-home.db")
	requireNoStorageFile(t, c, storageConfigFilename)
	if got := storageRequest(rt, "POST", "/api/v1/storage/configure", storageInput{Provider: "sqlite"}, rt.token, "http://home.test"); got.Code != 409 {
		t.Fatal(got.Code, got.Body.String())
	}
	if got := storageRequest(rt, "POST", "/api/v1/storage/retry", nil, rt.token, "http://home.test"); got.Code != 200 || rt.snapshot().State != "error" {
		t.Fatal(got.Code, got.Body.String())
	}
	requireNoStorageFile(t, c, "lingshu-home.db")
	requireNoStorageFile(t, c, storageConfigFilename)
}
func TestStorageRuntimeRejectsIncompleteOrUnknownData(t *testing.T) {
	for _, kind := range []string{"empty", "corrupt", "orphan-key"} {
		t.Run(kind, func(t *testing.T) {
			c := storageFixtureConfig(t)
			if err := os.MkdirAll(c.DataDir, 0700); err != nil {
				t.Fatal(err)
			}
			name, content := "lingshu-home.db", []byte{}
			if kind == "corrupt" {
				content = []byte("not-a-home-database")
			}
			if kind == "orphan-key" {
				name = "integrations.key"
				content = bytes.Repeat([]byte{7}, 32)
			}
			path := filepath.Join(c.DataDir, name)
			if err := os.WriteFile(path, content, 0600); err != nil {
				t.Fatal(err)
			}
			if rt, err := OpenRuntime(c); err == nil {
				rt.Close()
				t.Fatal("unsafe data was treated as a new instance")
			}
			after, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(content, after) {
				t.Fatal("existing data changed", err)
			}
			requireNoStorageFile(t, c, storageConfigFilename)
		})
	}
}
func TestStorageConfigRejectsUnsafeFilesAndDoesNotLeakSecrets(t *testing.T) {
	for _, kind := range []string{"json", "version", "permissions", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, storageConfigFilename)
			data := []byte(`{"version":1,"provider":"postgres","databaseUrl":"postgres://fixture:must-never-appear@127.0.0.1/db"}`)
			mode := os.FileMode(0600)
			switch kind {
			case "json":
				data = []byte(`{"must-never-appear":`)
			case "version":
				data = bytes.Replace(data, []byte(`"version":1`), []byte(`"version":999`), 1)
			case "permissions":
				mode = 0644
			}
			if kind == "symlink" {
				target := filepath.Join(dir, "private.json")
				if err := os.WriteFile(target, data, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Skip(err)
				}
			} else if err := os.WriteFile(path, data, mode); err != nil {
				t.Fatal(err)
			}
			if _, err := readStorageConfig(dir); err == nil || strings.Contains(err.Error(), "must-never-appear") {
				t.Fatal(err)
			}
		})
	}
}
func TestStorageInputPreservesSpecialCredentialsAndRejectsURLHosts(t *testing.T) {
	password := "quotes:'\"@/:?&=# plus + unicode 密码"
	input := storageInput{Provider: "postgres", Postgres: &storagePostgresInput{Host: "127.0.0.1", Port: 55432, Database: "Home Database", Username: "name@tenant", Password: password, SSLMode: "require"}}
	c, err := storageInputConfig(Config{}, input)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(c.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	gotPassword, _ := parsed.User.Password()
	if gotPassword != password || parsed.User.Username() != "name@tenant" || parsed.Query().Get("sslmode") != "require" || parsed.Port() != "55432" {
		t.Fatal("credentials or endpoint changed")
	}
	for _, host := range []string{"http://localhost", "localhost:5432", "/tmp/socket", "host?sslcert=/secret", "host,other"} {
		input.Postgres.Host = host
		if _, err := storageInputConfig(Config{}, input); err == nil {
			t.Fatalf("accepted host %q", host)
		}
	}
}
func TestStorageConfigurationSourcePrecedence(t *testing.T) {
	t.Setenv("LINGSHU_STORAGE_PROVIDER", "")
	t.Setenv("LINGSHU_DATABASE_URL", "")
	dir := t.TempDir()
	saved := Config{StorageProvider: "postgres", DatabaseURL: "postgres://fixture@127.0.0.1/saved?sslmode=disable"}
	if err := writeStorageConfig(dir, saved); err != nil {
		t.Fatal(err)
	}
	c, err := ParseConfig([]string{"--data-dir", dir})
	if err != nil {
		t.Fatal(err)
	}
	resolved, required, err := resolveRuntimeStorage(c)
	if err != nil || required || resolved.storageSource != "file" || resolved.DatabaseURL != saved.DatabaseURL {
		t.Fatal(resolved.storageSource, required, err)
	}
	t.Setenv("LINGSHU_STORAGE_PROVIDER", "postgres")
	t.Setenv("LINGSHU_DATABASE_URL", "postgres://fixture@127.0.0.1/environment?sslmode=disable")
	c, err = ParseConfig([]string{"--data-dir", dir})
	if err != nil {
		t.Fatal(err)
	}
	resolved, required, err = resolveRuntimeStorage(c)
	if err != nil || required || resolved.storageSource != "environment" || !strings.Contains(resolved.DatabaseURL, "/environment?") {
		t.Fatal(resolved.storageSource, required, err)
	}
	c, err = ParseConfig([]string{"--data-dir", dir, "--storage-provider", "sqlite"})
	if err != nil {
		t.Fatal(err)
	}
	resolved, required, err = resolveRuntimeStorage(c)
	if err != nil || required || resolved.storageSource != "cli" || resolved.StorageProvider != "sqlite" {
		t.Fatal(resolved.storageSource, required, err)
	}
}
func TestStorageBootstrapMutationBusyAndRateLimit(t *testing.T) {
	c := storageFixtureConfig(t)
	rt, err := OpenRuntime(c)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	rt.gate <- struct{}{}
	got := storageRequest(rt, http.MethodPost, "/api/v1/storage/test", storageInput{Provider: "sqlite"}, rt.token, "http://home.test")
	<-rt.gate
	if got.Code != 409 {
		t.Fatal(got.Code)
	}
	rt.limitMu.Lock()
	rt.limitCount = 40
	rt.limitMu.Unlock()
	got = storageRequest(rt, http.MethodPost, "/api/v1/storage/test", storageInput{Provider: "sqlite"}, rt.token, "http://home.test")
	if got.Code != 429 || got.Header().Get("Retry-After") == "" {
		t.Fatal(got.Code)
	}
	requireNoStorageFile(t, c, "lingshu-home.db")
}

func TestStorageConfigureConcurrentRequestsChooseOnce(t *testing.T) {
	c := storageFixtureConfig(t)
	rt, err := OpenRuntime(c)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	start := make(chan struct{})
	codes := make(chan int, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			got := storageRequest(rt, "POST", "/api/v1/storage/configure", storageInput{Provider: "sqlite"}, rt.token, "http://home.test")
			codes <- got.Code
		}()
	}
	close(start)
	wg.Wait()
	close(codes)
	success, conflict := 0, 0
	for code := range codes {
		if code == 200 {
			success++
		} else if code == 409 {
			conflict++
		} else {
			t.Fatalf("unexpected configuration status %d", code)
		}
	}
	if success != 1 || conflict != 1 || rt.snapshot().State != "ready" {
		t.Fatalf("success=%d conflict=%d state=%s", success, conflict, rt.snapshot().State)
	}
	saved, err := readStorageConfig(c.DataDir)
	if err != nil || saved == nil || !saved.Provisioned {
		t.Fatal("configuration was not completed", err)
	}
}
func TestStorageProvisionedSQLiteDoesNotRecreateLostData(t *testing.T) {
	c := storageFixtureConfig(t)
	rt, err := OpenRuntime(c)
	if err != nil {
		t.Fatal(err)
	}
	got := storageRequest(rt, "POST", "/api/v1/storage/configure", storageInput{Provider: "sqlite"}, rt.token, "http://home.test")
	if got.Code != 200 || rt.snapshot().State != "ready" {
		rt.Close()
		t.Fatal(got.Code, got.Body.String())
	}
	if err := rt.Close(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"lingshu-home.db", "lingshu-home.db-wal", "lingshu-home.db-shm", "csrf.key", "integrations.key"} {
		if err := os.Remove(filepath.Join(c.DataDir, name)); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}
	if next, err := OpenRuntime(c); err == nil {
		next.Close()
		t.Fatal("completed installation silently recreated missing data")
	}
	requireNoStorageFile(t, c, "lingshu-home.db")
}
func TestStoragePendingSQLiteResumesMigrationLedger(t *testing.T) {
	seed := storageFixtureConfig(t)
	seed.StorageProvider = "sqlite"
	app, err := Open(seed)
	if err != nil {
		t.Fatal(err)
	}
	var ledgerDDL string
	if err := app.store.DB.QueryRow("SELECT sql FROM sqlite_master WHERE name='schema_migrations'").Scan(&ledgerDDL); err != nil {
		app.Close()
		t.Fatal(err)
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"empty-file", "empty-ledger", "unrelated-table"} {
		t.Run(kind, func(t *testing.T) {
			c := storageFixtureConfig(t)
			if err := os.MkdirAll(c.DataDir, 0700); err != nil {
				t.Fatal(err)
			}
			if err := writeStorageConfig(c.DataDir, Config{StorageProvider: "sqlite"}); err != nil {
				t.Fatal(err)
			}
			database := filepath.Join(c.DataDir, "lingshu-home.db")
			if kind == "empty-file" {
				if err := os.WriteFile(database, nil, 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				db, err := sql.Open("sqlite", database)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := db.Exec(ledgerDDL); err != nil {
					db.Close()
					t.Fatal(err)
				}
				if kind == "unrelated-table" {
					if _, err := db.Exec("CREATE TABLE unrelated (id INTEGER)"); err != nil {
						db.Close()
						t.Fatal(err)
					}
				}
				if err := db.Close(); err != nil {
					t.Fatal(err)
				}
			}
			rt, err := OpenRuntime(c)
			if kind == "unrelated-table" {
				if err == nil {
					rt.Close()
					t.Fatal("unrelated pending database was overwritten")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer rt.Close()
			if rt.snapshot().State != "ready" {
				t.Fatal(rt.snapshot())
			}
			saved, err := readStorageConfig(c.DataDir)
			if err != nil || saved == nil || !saved.Provisioned {
				t.Fatal("pending migration did not complete", err)
			}
		})
	}
}
func TestStorageCloseCancelsBlockedProbe(t *testing.T) {
	c := storageFixtureConfig(t)
	rt, err := OpenRuntime(c)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			accepted <- conn
		}
	}()
	address := listener.Addr().(*net.TCPAddr)
	input := storageInput{Provider: "postgres", Postgres: &storagePostgresInput{Host: "127.0.0.1", Port: address.Port, Database: "fixture", Username: "fixture", Password: "fixture-only", SSLMode: "disable"}}
	requestDone := make(chan struct{})
	go func() {
		defer close(requestDone)
		storageRequest(rt, "POST", "/api/v1/storage/test", input, rt.token, "http://home.test")
	}()
	var conn net.Conn
	select {
	case conn = <-accepted:
		defer conn.Close()
	case <-time.After(3 * time.Second):
		t.Fatal("probe did not connect to fixture")
	}
	closed := make(chan error, 1)
	go func() { closed <- rt.Close() }()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		conn.Close()
		<-requestDone
		t.Fatal("runtime cancellation did not interrupt blocked database probe")
	}
	select {
	case <-requestDone:
	case <-time.After(time.Second):
		t.Fatal("probe handler did not exit")
	}
	requireNoStorageFile(t, c, storageConfigFilename)
}
func TestStoragePostgresProbeUsesReadOnlyIsolatedSchema(t *testing.T) {
	dsn := os.Getenv("LINGSHU_TEST_STORAGE_POSTGRES_URL")
	if dsn == "" {
		t.Skip("set LINGSHU_TEST_STORAGE_POSTGRES_URL to a disposable database")
	}
	parsed, err := url.Parse(dsn)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") {
		t.Fatal("storage test database requires a PostgreSQL URL")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal("cannot open storage test database")
	}
	defer admin.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	schema := "storage_probe_" + strings.ReplaceAll(newID(), "-", "")
	quoted := fmt.Sprintf("%q", schema)
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	defer func() {
		clean, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		if _, err := admin.ExecContext(clean, "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
			t.Errorf("cannot remove this test's isolated schema: %v", err)
		}
	}()
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	c := storageFixtureConfig(t)
	c.StorageProvider = "postgres"
	c.DatabaseURL = parsed.String()
	countObjects := func() int {
		t.Helper()
		var count int
		if err := admin.QueryRowContext(ctx, "SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1", schema).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	if err := probeStorage(ctx, c); err != nil {
		t.Fatal(err)
	}
	if count := countObjects(); count != 0 {
		t.Fatalf("connection probe created %d objects", count)
	}
	if err := inspectPostgresIdentity(ctx, c, true); err == nil {
		t.Fatal("empty database passed completed-instance validation")
	}
	if count := countObjects(); count != 0 {
		t.Fatalf("identity check created %d objects", count)
	}
	if _, err := admin.ExecContext(ctx, "CREATE TABLE "+quoted+".unrelated(id integer)"); err != nil {
		t.Fatal(err)
	}
	if err := probeStorage(ctx, c); err == nil {
		t.Fatal("accepted unrelated database")
	}
	if count := countObjects(); count != 1 {
		t.Fatalf("probe changed unrelated objects: %d", count)
	}
	if _, err := admin.ExecContext(ctx, "DROP TABLE "+quoted+".unrelated"); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.ExecContext(ctx, "CREATE TABLE "+quoted+".schema_migrations(version text PRIMARY KEY,checksum text,applied_at timestamptz)"); err != nil {
		t.Fatal(err)
	}
	if err := inspectPostgresIdentity(ctx, c, false); err != nil {
		t.Fatal("pending empty ledger was not recoverable", err)
	}
	if err := inspectPostgresIdentity(ctx, c, true); err == nil {
		t.Fatal("empty ledger passed completed-instance validation")
	}
	requireNoStorageFile(t, c, storageConfigFilename)
}

func TestStorageBootstrapDoesNotImplyLanguageSelection(t *testing.T) {
	c := storageFixtureConfig(t)
	c.Language = ""
	rt, err := OpenRuntime(c)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	if rt.snapshot().Language != "" {
		t.Fatal("fresh storage implied a language choice")
	}
	response := storageRequest(rt, "POST", "/api/v1/storage/configure", storageInput{Provider: "sqlite"}, rt.token, "http://home.test")
	if response.Code != 200 || rt.snapshot().State != "ready" {
		t.Fatal("storage did not become ready")
	}
	if rt.snapshot().Language != "" {
		t.Fatal("choosing storage implicitly chose the instance language")
	}
	server := httptest.NewServer(rt)
	defer server.Close()
	browser := newCoreBrowser(t, server.URL)
	if browser.bootstrap()["languageSelectionRequired"] != true {
		t.Fatal("instance language choice was skipped")
	}
	browser.ok("POST", "/setup/language", map[string]any{"language": "en"})
	if rt.snapshot().Language != "en" {
		t.Fatal("committed language choice not reflected in storage status")
	}
	server.Close()
	if err := rt.Close(); err != nil {
		t.Fatal(err)
	}
	c.Language = "zh-CN"
	reopened, err := OpenRuntime(c)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.snapshot().Language != "en" {
		t.Fatal("startup language overrode persisted instance choice")
	}
}

func TestStorageRuntimePreservesDocumentConfiguration(t *testing.T) {
	c := storageFixtureConfig(t)
	c.DocumentRoots = []string{t.TempDir()}
	if err := os.WriteFile(filepath.Join(c.DocumentRoots[0], "guide.md"), []byte("# Existing guide\n"), 0600); err != nil {
		t.Fatal(err)
	}
	rt, err := OpenRuntime(c)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	response := storageRequest(rt, "POST", "/api/v1/storage/configure", storageInput{Provider: "sqlite"}, rt.token, "http://home.test")
	if response.Code != 200 || rt.snapshot().State != "ready" {
		t.Fatal("storage did not become ready")
	}
	server := httptest.NewServer(rt)
	defer server.Close()
	owner := newCoreBrowser(t, server.URL)
	owner.bootstrap()
	owner.ok("POST", "/setup", map[string]any{"siteName": "Storage with documents", "mode": ModePrivateMulti, "username": "owner", "password": "valid document fixture password", "seedDemo": false})
	shared := coreSpace(owner.bootstrap(), "shared")
	source := owner.ok("POST", "/spaces/"+shared+"/document-sources", map[string]any{"name": "Existing notes", "path": c.DocumentRoots[0], "readOnly": false, "defaultWrite": true})
	documents := owner.ok("GET", "/spaces/"+shared+"/documents", nil)["items"].([]any)
	if len(documents) != 1 {
		t.Fatal("storage bootstrap lost the configured document root")
	}
	document := documents[0].(map[string]any)
	owner.ok("PUT", "/spaces/"+shared+"/documents/"+document["id"].(string), map[string]any{"content": "# Saved after storage selection\n", "expectedRevision": document["revision"]})
	owner.ok("POST", "/spaces/"+shared+"/document-sources/"+source["id"].(string)+"/scan", map[string]any{})
	activity := owner.ok("GET", "/spaces/"+shared+"/document-activity?perspective=mine", nil)
	items := activity["items"].([]any)
	if activity["total"] != float64(1) || len(items) != 1 || items[0].(map[string]any)["count"] != float64(1) {
		t.Fatal("storage bootstrap lost or duplicated document activity")
	}
	server.Close()
	if err := rt.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenRuntime(c)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.snapshot().State != "ready" || reopened.snapshot().Source != "file" || len(reopened.app.config.DocumentRoots) != 1 || reopened.app.config.DocumentRoots[0] != c.DocumentRoots[0] {
		t.Fatal("saved storage selection changed deployment document roots")
	}
	var count int
	if err := reopened.app.store.DB.QueryRow("SELECT COUNT(*) FROM document_activity").Scan(&count); err != nil || count != 1 {
		t.Fatal("storage runtime restart lost document activity", err)
	}
}
