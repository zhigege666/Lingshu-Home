package home

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func seedSessionUpgrade(t *testing.T, db *sql.DB, store *Store, count int, legacy bool, alterLegacy func(string) string) {
	t.Helper()
	exec := func(statement string, args ...any) {
		t.Helper()
		if _, err := db.Exec(store.Query(statement), args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)")
	names := append(append([]string{}, sessionLegacyPrefix...), "008_document_library.sql", "009_document_activity.sql")
	for _, name := range names[:count] {
		body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/" + name)
		if err != nil {
			t.Fatal(err)
		}
		exec(string(body))
		digest := sha256.Sum256(body)
		exec("INSERT INTO schema_migrations VALUES(?,?,?)", name, hex.EncodeToString(digest[:]), "2026-10-25T01:02:03Z")
	}
	if legacy {
		body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/" + sessionRetentionMigration)
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(body)
		if hex.EncodeToString(digest[:]) != legacySessionChecksum(store.Provider) {
			t.Fatal("010 must retain the recognized unpublished SQL bytes")
		}
		statement := string(body)
		if alterLegacy != nil {
			statement = alterLegacy(statement)
		}
		exec(statement)
		exec("INSERT INTO schema_migrations VALUES(?,?,?)", legacySessionMigration, hex.EncodeToString(digest[:]), "2026-10-25T02:03:04Z")
	}
	stamp := "2026-10-25T01:02:03Z"
	exec("UPDATE settings SET initialized=?,site_name=?,mode=?,auth_epoch=?,language=?", true, "Preserved upgrade instance", ModePrivateMulti, 7, "en")
	exec("INSERT INTO users(id,username,normalized_username,display_name,role,is_enabled,password_hash,version,created_at) VALUES(?,?,?,?,?,?,?,?,?)", "old-owner", "Owner", "owner", "Original Owner", "Owner", true, "retained-password-hash", 3, stamp)
	exec("INSERT INTO sessions(token_hash,user_id,auth_epoch,user_version,expires_at) VALUES(?,?,?,?,?)", "existing-session", "old-owner", 7, 3, "2099-10-25T01:02:03Z")
	exec("INSERT INTO spaces(id,name,kind,published,data_revision,updated_at) VALUES(?,?,'shared',?,?,?)", "old-space", "Original shared space", false, 12, stamp)
	exec("INSERT INTO pages(id,space_id,name,revision,config) VALUES(?,?,?,?,?)", "old-page", "old-space", "Existing page", 9, jsonString(defaultPageConfig()))
	exec("INSERT INTO links(id,space_id,title,url,canonical_url,description,icon,tags,is_favorite,endpoints,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", "old-link", "old-space", "Original bookmark", "https://example.com/", "https://example.com/", "Retain description", "lucide:link", "[\"keep\"]", true, "[]", stamp)
	if legacy {
		exec("UPDATE settings SET default_session_mode='remember',default_idle_days=90,max_idle_days=90,allow_until_logout=?,session_policy_version=9", true)
		exec("UPDATE sessions SET session_mode='remember',idle_days=90,created_at=?,last_interactive_at=?,renewed_at=?,user_agent=?", stamp, stamp, stamp, "Preserved device")
	}
	if count >= 8 {
		exec("UPDATE links SET context_markdown=?", "Existing usage notes")
		exec("INSERT INTO document_sources(id,space_id,name,path,read_only,status,last_scan_at) VALUES(?,?,?,?,?,'ready',?)", "old-source", "old-space", "Original directory", "/original/notes", true, stamp)
		exec("INSERT INTO documents(id,source_id,space_id,relative_path,title,revision,size,updated_at,tags,published_revision,published_content) VALUES(?,?,?,?,?,?,?,?,?,?,?)", "old-document", "old-source", "old-space", "guide.md", "Original guide", "old-hash", 15, stamp, "[\"keep\"]", "old-hash", "# Original guide")
		exec("INSERT INTO document_bookmarks(document_id,bookmark_id) VALUES(?,?)", "old-document", "old-link")
		exec("INSERT INTO document_published_assets(document_id,path,mime_type,content) VALUES(?,?,?,?)", "old-document", "attachment.bin", "application/octet-stream", []byte{0, 1, 2})
	}
	if count == 9 {
		exec("UPDATE document_sources SET activity_started_at=?", stamp)
		exec("INSERT INTO document_activity(id,document_id,source_id,space_id,action,origin,occurred_at,observed_at,before_revision,after_revision) VALUES(?,?,?,?,'update','external',?,?,?,?)", "old-event", "old-document", "old-source", "old-space", stamp, stamp, "earlier-hash", "old-hash")
	}
}

func sessionUpgradeDatabaseState(t *testing.T, db *sql.DB, provider string) map[string]componentMigrationRows {
	t.Helper()
	query := "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
	if provider == "postgres" {
		query = "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'"
	}
	rows, err := db.Query(query)
	if err != nil {
		t.Fatal(err)
	}
	tables := []string{}
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		tables = append(tables, table)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(tables)
	result := map[string]componentMigrationRows{}
	for _, table := range tables {
		var columns []string
		if provider == "postgres" {
			// DDL changes SELECT *'s result type. Use explicit projections so
			// pgx's statement cache can retain its normal production behavior.
			rows, err := db.Query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position", table)
			if err != nil {
				t.Fatal(err)
			}
			for rows.Next() {
				var column string
				if err = rows.Scan(&column); err != nil {
					rows.Close()
					t.Fatal(err)
				}
				columns = append(columns, column)
			}
			err = rows.Err()
			rows.Close()
			if err != nil || len(columns) == 0 {
				t.Fatal("cannot capture migration table columns", err)
			}
		}
		result[table] = componentCaptureRows(t, db, table, columns)
	}
	return result
}

func TestSessionMigrationUpgradeChains(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, scenario := range []struct {
			name   string
			count  int
			legacy bool
		}{{"official-0.0.4", 7, false}, {"official-0.0.5", 8, false}, {"activity-009", 9, false}, {"unpublished-session-008", 7, true}} {
			t.Run(fmt.Sprintf("postgres-%v/%s", postgres, scenario.name), func(t *testing.T) {
				db, store := documentMigrationDB(t, postgres)
				seedSessionUpgrade(t, db, store, scenario.count, scenario.legacy, nil)
				before := sessionUpgradeDatabaseState(t, db, store.Provider)
				if err := store.migrate(context.Background()); err != nil {
					t.Fatal(err)
				}
				for table, original := range before {
					if table != "schema_migrations" && !reflect.DeepEqual(original, componentCaptureRows(t, db, table, original.columns)) {
						t.Fatalf("upgrade changed original %s data", table)
					}
				}
				var total, legacy int
				migrations, err := migrationFiles.ReadDir("migrations/" + store.Provider)
				if err != nil {
					t.Fatal(err)
				}
				if err := db.QueryRow("SELECT COUNT(*) FROM schema_migrations").Scan(&total); err != nil || total != len(migrations) {
					t.Fatalf("expected the complete migration chain: %d of %d %v", total, len(migrations), err)
				}
				if err := db.QueryRow(store.Query("SELECT COUNT(*) FROM schema_migrations WHERE version=?"), legacySessionMigration).Scan(&legacy); err != nil || legacy != 0 {
					t.Fatal("unpublished ledger entry was not reconciled", err)
				}
				for _, name := range append([]string{}, sessionLegacyPrefix...) {
					var applied string
					if err := db.QueryRow(store.Query("SELECT applied_at FROM schema_migrations WHERE version=?"), name).Scan(&applied); err != nil || applied != "2026-10-25T01:02:03Z" {
						t.Fatal("published migration history was rewritten", err)
					}
				}
				if scenario.legacy {
					var applied, checksum string
					if err := db.QueryRow(store.Query("SELECT checksum,applied_at FROM schema_migrations WHERE version=?"), sessionRetentionMigration).Scan(&checksum, &applied); err != nil || checksum != legacySessionChecksum(store.Provider) || applied != "2026-10-25T02:03:04Z" {
						t.Fatal("bridge lost the original session migration evidence", err)
					}
				}
				complete := sessionUpgradeDatabaseState(t, db, store.Provider)
				if err := store.migrate(context.Background()); err != nil {
					t.Fatal("restart failed after upgrade", err)
				}
				if !reflect.DeepEqual(complete, sessionUpgradeDatabaseState(t, db, store.Provider)) {
					t.Fatal("a repeated startup changed the upgraded database")
				}
			})
		}
	}
}

func TestLegacySessionBridgeRejectsMismatchAndRollsBack(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, scenario := range []string{"session-checksum", "published-checksum", "missing-prefix", "column", "constraint", "index", "literal-default", "document-ddl-failure"} {
			t.Run(fmt.Sprintf("postgres-%v/%s", postgres, scenario), func(t *testing.T) {
				db, store := documentMigrationDB(t, postgres)
				alter := func(body string) string {
					switch scenario {
					case "constraint":
						return strings.Replace(body, "CHECK(idle_days IN (0,7,30,90))", "CHECK(idle_days>=0)", 1)
					case "index":
						return strings.Replace(body, "ON sessions(session_mode,idle_days)", "ON sessions(idle_days,session_mode)", 1)
					case "literal-default":
						return strings.Replace(body, "user_agent TEXT NOT NULL DEFAULT ''", "user_agent TEXT NOT NULL DEFAULT ' '", 1)
					default:
						return body
					}
				}
				seedSessionUpgrade(t, db, store, 7, true, alter)
				var change string
				switch scenario {
				case "session-checksum":
					change = "UPDATE schema_migrations SET checksum='changed' WHERE version='008_session_retention.sql'"
				case "published-checksum":
					change = "UPDATE schema_migrations SET checksum='changed' WHERE version='001_initial.sql'"
				case "missing-prefix":
					change = "DELETE FROM schema_migrations WHERE version='007_instance_language.sql'"
				case "column":
					change = "ALTER TABLE sessions DROP COLUMN user_agent"
				case "document-ddl-failure":
					change = "CREATE TABLE document_activity (preserved TEXT)"
				}
				if change != "" {
					if _, err := db.Exec(change); err != nil {
						t.Fatal(err)
					}
				}
				before := sessionUpgradeDatabaseState(t, db, store.Provider)
				if err := store.migrate(context.Background()); err == nil {
					t.Fatal("unrecognized or conflicting legacy state was accepted")
				}
				if !reflect.DeepEqual(before, sessionUpgradeDatabaseState(t, db, store.Provider)) {
					t.Fatal("failed bridge changed table columns, data or migration records")
				}
			})
		}
	}
}

func TestLegacySessionBridgeRetainsBrowserSessionAndPolicyCAS(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		t.Run(fmt.Sprintf("postgres-%v", postgres), func(t *testing.T) {
			c := autoIconConfig(t, postgres)
			c.Language = "en"
			if err := os.MkdirAll(c.DataDir, 0700); err != nil {
				t.Fatal(err)
			}
			key := bytes.Repeat([]byte{42}, 32)
			for _, name := range []string{"csrf.key", "integrations.key"} {
				if err := os.WriteFile(filepath.Join(c.DataDir, name), key, 0600); err != nil {
					t.Fatal(err)
				}
			}
			driver, dsn := "sqlite", "file:"+filepath.Join(c.DataDir, "lingshu-home.db")+"?_pragma=foreign_keys(1)"
			if postgres {
				driver, dsn = "pgx", c.DatabaseURL
			}
			db, err := sql.Open(driver, dsn)
			if err != nil {
				t.Fatal(err)
			}
			db.SetMaxOpenConns(1)
			defer db.Close()
			store := &Store{DB: db, Provider: c.StorageProvider}
			seedSessionUpgrade(t, db, store, 7, true, nil)
			raw := randomToken()
			now := sessionNow()
			_, err = db.Exec(store.Query("UPDATE sessions SET token_hash=?,created_at=?,last_interactive_at=?,renewed_at=?,expires_at=?"), tokenHash(raw), sessionTimeString(now.Add(-time.Hour)), sessionTimeString(now), sessionTimeString(now), sessionTimeString(now.Add(90*24*time.Hour)))
			if err != nil {
				db.Close()
				t.Fatal(err)
			}
			before := sessionUpgradeDatabaseState(t, db, store.Provider)
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			rt, err := OpenRuntime(c)
			if err != nil {
				t.Fatal(err)
			}
			defer rt.Close()
			if rt.snapshot().State != "ready" {
				t.Fatal("legacy runtime failed to upgrade", rt.snapshot().Error)
			}
			server := httptest.NewServer(rt)
			defer server.Close()
			browser := newCoreBrowser(t, server.URL)
			target, _ := url.Parse(server.URL)
			browser.client.Jar.SetCookies(target, []*http.Cookie{{Name: sessionCookie, Value: raw, Path: "/"}})
			boot := browser.bootstrap()
			user, ok := boot["user"].(map[string]any)
			if !ok || user["id"] != "old-owner" || boot["siteName"] != "Preserved upgrade instance" {
				t.Fatal("the original browser cookie no longer authenticates after the bridge")
			}
			retentionTestSummary(t, boot, sessionRemember, 90)
			if retentionTestRawToken(t, browser.client, server.URL) != raw {
				t.Fatal("upgrade rotated the existing browser token")
			}
			for table, original := range before {
				if table != "schema_migrations" && !reflect.DeepEqual(original, componentCaptureRows(t, rt.app.store.DB, table, original.columns)) {
					t.Fatalf("browser bootstrap after the bridge changed old %s data", table)
				}
			}
			for _, name := range []string{"csrf.key", "integrations.key"} {
				body, err := os.ReadFile(filepath.Join(c.DataDir, name))
				if err != nil || !bytes.Equal(body, key) {
					t.Fatal("bridge replaced an instance key", err)
				}
			}
			policy := browser.ok("GET", "/settings/session-policy", nil)
			if policy["policyVersion"] != float64(9) || policy["maxIdleDays"] != float64(90) || policy["allowUntilLogout"] != true {
				t.Fatal("the old session policy or its CAS version was reset")
			}
			change := retentionTestPolicyBody(policy, 90, true)
			change["expectedVersion"] = 8
			if status, reply := browser.call("PUT", "/settings/session-policy", change); status != 409 || reply["code"] != "session_policy_conflict" {
				t.Fatal("stale pre-upgrade policy version was accepted")
			}
			change["expectedVersion"] = 9
			if updated := browser.ok("PUT", "/settings/session-policy", change); updated["policyVersion"] != float64(10) {
				t.Fatal("the retained policy CAS version could not advance normally")
			}
			retentionTestSummary(t, browser.bootstrap(), sessionRemember, 90)
		})
	}
}

func TestLegacySessionBridgeRejectsAdditionalPostgresConstraint(t *testing.T) {
	db, store := documentMigrationDB(t, true)
	seedSessionUpgrade(t, db, store, 7, true, nil)
	if _, err := db.Exec("ALTER TABLE sessions ADD CONSTRAINT unexpected_session_uniqueness UNIQUE(user_agent)"); err != nil {
		t.Fatal(err)
	}
	before := sessionUpgradeDatabaseState(t, db, store.Provider)
	if err := store.migrate(context.Background()); err == nil {
		t.Fatal("additional unique constraint was ignored while excluding PostgreSQL 18 not-null entries")
	}
	if !reflect.DeepEqual(before, sessionUpgradeDatabaseState(t, db, store.Provider)) {
		t.Fatal("rejected additional constraint changed existing data or the migration ledger")
	}
}
