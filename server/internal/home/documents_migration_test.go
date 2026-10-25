package home

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func documentMigrationDB(t *testing.T, postgres bool) (*sql.DB, *Store) {
	t.Helper()
	driver, dsn, provider := "sqlite", "file:"+filepath.Join(t.TempDir(), "legacy.db")+"?_pragma=foreign_keys(1)", "sqlite"
	if postgres {
		dsn = os.Getenv("LINGSHU_TEST_DOCUMENT_POSTGRES_URL")
		if dsn == "" {
			t.Skip("requires isolated LINGSHU_TEST_DOCUMENT_POSTGRES_URL")
		}
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatal(err)
		}
		admin, err := sql.Open("pgx", dsn)
		if err != nil {
			t.Fatal(err)
		}
		schema := "document_migration_" + integrationID()
		if _, err = admin.Exec("CREATE SCHEMA " + schema); err != nil {
			admin.Close()
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, err := admin.Exec("DROP SCHEMA " + schema + " CASCADE")
			if err != nil {
				t.Error(err)
			}
			admin.Close()
		})
		q := u.Query()
		q.Set("search_path", schema)
		u.RawQuery = q.Encode()
		driver, dsn, provider = "pgx", u.String(), "postgres"
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(1)
	return db, &Store{DB: db, Provider: provider}
}

func TestDocumentMigrationPreservesAndRollsBack(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, rollback := range []bool{false, true} {
			t.Run(fmt.Sprintf("postgres-%v/rollback-%v", postgres, rollback), func(t *testing.T) {
				db, store := documentMigrationDB(t, postgres)
				exec := func(query string, args ...any) {
					t.Helper()
					if _, err := db.Exec(store.Query(query), args...); err != nil {
						t.Fatal(err)
					}
				}
				for _, name := range []string{"001_initial.sql", "002_integrations.sql", "003_icons.sql", "004_component_sources.sql", "005_auto_icons.sql", "006_network_routing.sql", "007_instance_language.sql"} {
					body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/" + name)
					if err != nil {
						t.Fatal(err)
					}
					exec(string(body))
				}
				stamp := "2026-10-25T01:02:03Z"
				exec("UPDATE settings SET initialized=?,site_name=?,mode=?,auth_epoch=?,language=?", true, "Existing Home", ModePrivateMulti, 7, "en")
				exec("INSERT INTO users(id,username,normalized_username,display_name,role,is_enabled,password_hash,version,created_at) VALUES(?,?,?,?,?,?,?,?,?)", "old-owner", "Owner", "owner", "Owner", "Owner", true, "unchanged-hash", 3, stamp)
				exec("INSERT INTO spaces(id,name,kind,owner_user_id,published,data_revision,updated_at) VALUES(?,?,'shared',NULL,?,?,?)", "old-space", "Original", false, 12, stamp)
				exec("INSERT INTO pages(id,space_id,name,revision,config) VALUES(?,?,?,?,?)", "old-page", "old-space", "Original page", 9, jsonString(defaultPageConfig()))
				exec("INSERT INTO links(id,space_id,category_id,title,url,canonical_url,description,icon,tags,is_favorite,sort_order,endpoints,updated_at,icon_mode,icon_origin) VALUES(?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?)", "old-link", "old-space", "Old bookmark", "https://example.com/", "https://example.com/", "keep description", "lucide:link", "[]", false, 4, "[]", stamp, "manual", "")
				before := map[string]componentMigrationRows{}
				for _, table := range []string{"settings", "users", "spaces", "pages", "links", "integration_sources", "integration_tokens", "icon_assets", "network_proxy_config"} {
					before[table] = componentCaptureRows(t, db, table, nil)
				}
				body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/008_document_library.sql")
				if err != nil {
					t.Fatal(err)
				}
				tx, err := db.BeginTx(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				statement := string(body)
				if rollback {
					statement += "\nSELECT force_document_migration_failure();"
				}
				_, err = tx.Exec(statement)
				if rollback {
					if err == nil {
						t.Fatal("injected failure did not fail")
					}
					_ = tx.Rollback()
				} else {
					if err != nil {
						tx.Rollback()
						t.Fatal(err)
					}
					if err = tx.Commit(); err != nil {
						t.Fatal(err)
					}
				}
				for table, want := range before {
					if got := componentCaptureRows(t, db, table, want.columns); !reflect.DeepEqual(got, want) {
						t.Fatalf("migration changed old %s data", table)
					}
				}
				var contextMarkdown string
				err = db.QueryRow("SELECT context_markdown FROM links WHERE id='old-link'").Scan(&contextMarkdown)
				if rollback {
					if err == nil {
						t.Fatal("rolled-back context column remains")
					}
					if _, err = db.Exec("SELECT * FROM document_sources"); err == nil {
						t.Fatal("rolled-back source table remains")
					}
					return
				}
				if err != nil || contextMarkdown != "" {
					t.Fatalf("legacy usage notes default is not empty: %v", err)
				}
				for _, table := range []string{"document_sources", "documents", "document_bookmarks", "document_published_assets"} {
					var count int
					if err = db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
						t.Fatalf("new table %s is not empty: %v", table, err)
					}
				}
			})
		}
	}
}
