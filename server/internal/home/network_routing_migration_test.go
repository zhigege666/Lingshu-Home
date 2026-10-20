package home

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
)

func TestNetworkRoutingMigrationPreservesAndRollsBack(t *testing.T) {
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
					t.Fatal("cannot open isolated migration database")
				}
				defer db.Close()
				db.SetMaxOpenConns(1)
				db.SetMaxIdleConns(1)
				store := &Store{DB: db, Provider: provider}
				exec := func(query string, args ...any) {
					t.Helper()
					if _, err := db.Exec(store.Query(query), args...); err != nil {
						t.Fatal(err)
					}
				}
				for _, name := range []string{"001_initial.sql", "002_integrations.sql", "003_icons.sql", "004_component_sources.sql", "005_auto_icons.sql"} {
					body, err := migrationFiles.ReadFile("migrations/" + provider + "/" + name)
					if err != nil {
						t.Fatal(err)
					}
					exec(string(body))
				}
				stamp := "2026-10-19T01:02:03Z"
				exec("UPDATE settings SET initialized=?,site_name=?,mode=?,auth_epoch=?,auto_fetch_icons=?", true, "Existing private Home", ModePrivateMulti, 23, false)
				exec("INSERT INTO users(id,username,normalized_username,display_name,role,is_enabled,password_hash,version,created_at) VALUES(?,?,?,?,?,?,?,?,?)", "existing-owner", "Owner", "owner", "Existing", "Owner", true, "keep-private-hash", 7, stamp)
				exec("INSERT INTO spaces(id,name,kind,owner_user_id,published,data_revision,updated_at) VALUES(?,?,'shared',NULL,?,?,?)", "existing-space", "Keep", false, 19, stamp)
				exec("INSERT INTO pages(id,space_id,name,revision,config) VALUES(?,?,?,?,?)", "existing-page", "existing-space", "Keep page", 29, jsonString(defaultPageConfig()))
				exec("INSERT INTO links(id,space_id,category_id,title,url,canonical_url,description,icon,tags,is_favorite,sort_order,endpoints,updated_at,icon_mode,icon_origin) VALUES(?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?)", "existing-link", "existing-space", "NAS", "https://nas.example.org/", "https://nas.example.org/", "keep", "lucide:link", "[]", false, 5, `[{"label":"Manual LAN","url":"http://192.168.1.5/"}]`, stamp, "manual", "")
				before := map[string]componentMigrationRows{}
				for _, table := range []string{"settings", "users", "spaces", "pages", "links", "icon_favicon_jobs", "integration_sources", "integration_tokens", "integration_snapshots"} {
					before[table] = componentCaptureRows(t, db, table, nil)
				}
				body, err := migrationFiles.ReadFile("migrations/" + provider + "/006_network_routing.sql")
				if err != nil {
					t.Fatal(err)
				}
				tx, err := db.BeginTx(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				statement := string(body)
				if rollback {
					statement += "\nSELECT force_migration_failure();"
				}
				_, err = tx.Exec(statement)
				if rollback {
					if err == nil {
						t.Fatal("injected migration failure did not fail")
					}
					_ = tx.Rollback()
				} else {
					if err != nil {
						_ = tx.Rollback()
						t.Fatal(err)
					}
					if err = tx.Commit(); err != nil {
						t.Fatal(err)
					}
				}
				for table, want := range before {
					if got := componentCaptureRows(t, db, table, want.columns); !reflect.DeepEqual(want, got) {
						t.Fatalf("migration changed existing %s", table)
					}
				}
				var enabled bool
				err = db.QueryRow("SELECT auto_select_endpoint FROM settings WHERE id=1").Scan(&enabled)
				if rollback {
					if err == nil {
						t.Fatal("rolled-back preference column remains")
					}
					if _, err = db.Exec("SELECT * FROM network_proxy_config"); err == nil {
						t.Fatal("rolled-back proxy table remains")
					}
					return
				}
				if err != nil || !enabled {
					t.Fatal("migration did not default automatic routing on")
				}
				var revision int64
				var mode, endpoint string
				var secret sql.NullString
				if err = db.QueryRow("SELECT revision,mode,url,credential_cipher FROM network_proxy_config WHERE id=1").Scan(&revision, &mode, &endpoint, &secret); err != nil || revision != 1 || mode != "direct" || endpoint != "" || secret.Valid {
					t.Fatal("migration did not create a direct, credential-free proxy configuration")
				}
			})
		}
	}
}
