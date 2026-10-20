package home

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestAutomaticIconMigrationPreservesExistingData(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, rollback := range []bool{false, true} {
			t.Run(fmt.Sprintf("postgres-%v/rollback-%v", postgres, rollback), func(t *testing.T) {
				c := autoIconConfig(t, postgres)
				provider, driver, dsn := "sqlite", "sqlite", "file:"+filepath.Join(t.TempDir(), "legacy.db")+"?_pragma=foreign_keys(1)"
				if postgres {
					provider, driver, dsn = "postgres", "pgx", c.DatabaseURL
				}
				db, err := sql.Open(driver, dsn)
				if err != nil {
					t.Fatal("cannot open isolated migration fixture")
				}
				db.SetMaxOpenConns(1)
				db.SetMaxIdleConns(1)
				t.Cleanup(func() { _ = db.Close() })
				store := &Store{DB: db, Provider: provider}
				exec := func(query string, args ...any) {
					t.Helper()
					if _, err := db.Exec(store.Query(query), args...); err != nil {
						t.Fatal(err)
					}
				}
				// Build the actual immediately preceding schema without running the
				// new application or touching any initialized test database.
				for _, name := range []string{"001_initial.sql", "002_integrations.sql", "003_icons.sql", "004_component_sources.sql"} {
					body, err := migrationFiles.ReadFile("migrations/" + provider + "/" + name)
					if err != nil {
						t.Fatal(err)
					}
					tx, err := db.BeginTx(context.Background(), nil)
					if err != nil {
						t.Fatal(err)
					}
					if _, err = tx.Exec(string(body)); err != nil {
						_ = tx.Rollback()
						t.Fatal(err)
					}
					if err = tx.Commit(); err != nil {
						t.Fatal(err)
					}
				}
				stamp := "2026-10-18T01:02:03.123456Z"
				exec("UPDATE settings SET initialized=?,site_name=?,mode=?,auth_epoch=?", true, "Existing private Home", ModePrivateMulti, 17)
				exec("INSERT INTO users(id,username,normalized_username,display_name,role,is_enabled,password_hash,version,created_at) VALUES(?,?,?,?,?,?,?,?,?)", "legacy-owner", "Legacy", "legacy", "既有用户", "Owner", true, "untouched-private-hash", 9, stamp)
				exec("INSERT INTO spaces(id,name,kind,owner_user_id,published,data_revision,updated_at) VALUES(?,?,'shared',NULL,?,?,?)", "legacy-space", "Existing links", false, 23, stamp)
				exec("INSERT INTO sessions(token_hash,user_id,auth_epoch,user_version,expires_at) VALUES(?,?,?,?,?)", "legacy-session-hash", "legacy-owner", 17, 9, "2027-01-01T00:00:00Z")
				exec("INSERT INTO categories(id,space_id,parent_id,name,icon,sort_order) VALUES(?,?,NULL,?,?,?)", "legacy-category", "legacy-space", "Keep category", "lucide:folder", 4)
				exec("INSERT INTO pages(id,space_id,name,revision,config) VALUES(?,?,?,?,?)", "legacy-page", "legacy-space", "Keep layout", 31, jsonString(defaultPageConfig()))
				digest := strings.Repeat("a", 64)
				exec("INSERT INTO icon_assets(space_id,digest,media_type,content,width,height,created_at) VALUES(?,?,?,?,?,?,?)", "legacy-space", digest, "image/svg+xml", []byte(iconFixtureSVG), 24, 24, stamp)
				exec("INSERT INTO icon_packs(id,space_id,name,source_url,license,created_at) VALUES(?,?,?,?,?,?)", "legacy-pack", "legacy-space", "Keep provenance", "https://icons.example.org/", "Fixture original artwork", stamp)
				exec("INSERT INTO icon_pack_entries(pack_id,space_id,icon_key,label,digest,source_sha256) VALUES(?,?,?,?,?,?)", "legacy-pack", "legacy-space", "home", "Keep source checksum", digest, strings.Repeat("b", 64))
				exec("INSERT INTO icon_favicon_cache(space_id,origin,digest,source_url,checked_at,retry_at,last_error) VALUES(?,?,?,?,?,?,?)", "legacy-space", "https://legacy.example.org/", digest, "https://legacy.example.org/favicon.png", stamp, "2026-10-19T01:02:03Z", "")
				for i, icon := range []string{"lucide:star", "asset:legacy-space:" + digest} {
					exec("INSERT INTO links(id,space_id,category_id,title,url,canonical_url,description,icon,tags,is_favorite,sort_order,endpoints,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", fmt.Sprintf("legacy-link-%d", i), "legacy-space", "legacy-category", fmt.Sprintf("Existing %d", i), fmt.Sprintf("https://legacy.example.org/private/%d?keep=1", i), fmt.Sprintf("https://legacy.example.org/private/%d?keep=1", i), "Preserve notes and intentional icon", icon, `["existing","标签"]`, true, 42+i, `[{"label":"Secondary","url":"https://secondary.example.org/"}]`, stamp)
				}
				tables := []string{"settings", "users", "spaces", "sessions", "categories", "links", "pages", "icon_assets", "icon_packs", "icon_pack_entries", "icon_favicon_cache"}
				before := map[string]componentMigrationRows{}
				for _, table := range tables {
					before[table] = componentCaptureRows(t, db, table, nil)
				}
				migration, err := migrationFiles.ReadFile("migrations/" + provider + "/005_auto_icons.sql")
				if err != nil {
					t.Fatal(err)
				}
				tx, err := db.BeginTx(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				statement := string(migration)
				if rollback {
					statement += "\nSELECT intentional_automatic_icon_migration_failure();"
				}
				_, err = tx.Exec(statement)
				if rollback {
					if err == nil {
						_ = tx.Rollback()
						t.Fatal("migration failure injection unexpectedly succeeded")
					}
					if err = tx.Rollback(); err != nil {
						t.Fatal(err)
					}
				} else {
					if err != nil {
						_ = tx.Rollback()
						t.Fatal(err)
					}
					if err = tx.Commit(); err != nil {
						t.Fatal(err)
					}
				}
				for _, table := range tables {
					if actual := componentCaptureRows(t, db, table, before[table].columns); !reflect.DeepEqual(before[table], actual) {
						t.Fatalf("migration changed existing %s rows, bytes, revision, or metadata", table)
					}
				}
				if !postgres {
					var enabled int
					if err = db.QueryRow("PRAGMA foreign_keys").Scan(&enabled); err != nil || enabled != 1 {
						t.Fatal("migration disabled SQLite foreign keys", err)
					}
					rows, err := db.Query("PRAGMA foreign_key_check")
					if err != nil {
						t.Fatal(err)
					}
					broken := rows.Next()
					_ = rows.Close()
					if broken {
						t.Fatal("migration left broken foreign keys")
					}
				}
				var enabled bool
				var count int
				if rollback {
					if err = db.QueryRow("SELECT auto_fetch_icons FROM settings").Scan(&enabled); err == nil {
						t.Fatal("failed migration retained a new settings column")
					}
					if err = db.QueryRow("SELECT COUNT(*) FROM icon_favicon_jobs").Scan(&count); err == nil {
						t.Fatal("failed migration retained a queue table")
					}
					return
				}
				if err = db.QueryRow("SELECT auto_fetch_icons FROM settings").Scan(&enabled); err != nil || !enabled {
					t.Fatal("new global setting does not default true", err)
				}
				if err = db.QueryRow("SELECT COUNT(*) FROM links WHERE icon_mode='manual' AND icon_origin=''").Scan(&count); err != nil || count != 2 {
					t.Fatal("migration did not preserve legacy manual intent", err)
				}
				if err = db.QueryRow("SELECT COUNT(*) FROM icon_favicon_jobs").Scan(&count); err != nil || count != 0 {
					t.Fatal("migration scheduled an unrequested backfill", err)
				}
				if _, err = db.Exec("UPDATE links SET icon_mode='unknown'"); err == nil {
					t.Fatal("database accepted an invalid icon mode")
				}
				exec("INSERT INTO icon_favicon_jobs(space_id,origin,id,auth_epoch,actor_user_id,actor_user_version,token_hash,requested_at) VALUES(?,?,?,?,?,?,?,?)", "legacy-space", "https://legacy.example.org/", "restorable-job", 17, "legacy-owner", 9, "only-a-hash", stamp)
				exec("DELETE FROM sessions")
				exec("DELETE FROM users WHERE id=?", "legacy-owner")
				if err = db.QueryRow("SELECT COUNT(*) FROM icon_favicon_jobs").Scan(&count); err != nil || count != 0 {
					t.Fatal("deleting a saved task actor did not remove its queued authority", err)
				}
			})
		}
	}
}
