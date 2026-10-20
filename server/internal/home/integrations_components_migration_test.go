package home

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

var componentMigrationTables = []string{"integration_sources", "integration_tokens", "integration_snapshots", "integration_receipts", "integration_traffic_baselines", "integration_traffic_daily"}

type componentMigrationRows struct {
	columns []string
	values  [][]any
}

func componentCaptureRows(t *testing.T, db *sql.DB, table string, columns []string) componentMigrationRows {
	t.Helper()
	projection := "*"
	if len(columns) > 0 {
		projection = strings.Join(columns, ",")
	}
	rows, err := db.Query("SELECT " + projection + " FROM " + table + " ORDER BY 1")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if len(columns) == 0 {
		columns, err = rows.Columns()
		if err != nil {
			t.Fatal(err)
		}
	}
	out := componentMigrationRows{columns: columns, values: [][]any{}}
	for rows.Next() {
		values := make([]any, len(columns))
		ptrs := make([]any, len(columns))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err = rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		for i, v := range values {
			if b, ok := v.([]byte); ok {
				values[i] = string(b)
			}
		}
		out.values = append(out.values, values)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}
func TestComponentSourceMigrationPreservesRows(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		for _, rollback := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/rollback-%v", provider, rollback), func(t *testing.T) {
				var db *sql.DB
				var err error
				if provider == "sqlite" {
					db, err = sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "upgrade.db")+"?_pragma=foreign_keys(1)")
				} else {
					connection := os.Getenv("LINGSHU_TEST_COMPONENT_MIGRATION_POSTGRES_URL")
					if connection == "" {
						t.Skip("requires isolated LINGSHU_TEST_COMPONENT_MIGRATION_POSTGRES_URL")
					}
					db, err = sql.Open("pgx", connection)
				}
				if err != nil {
					t.Fatal(err)
				}
				db.SetMaxOpenConns(1)
				db.SetMaxIdleConns(1)
				if provider == "postgres" {
					schema := "component_migration_" + integrationID()
					if _, err = db.Exec("CREATE SCHEMA " + schema); err != nil {
						db.Close()
						t.Fatal(err)
					}
					if _, err = db.Exec("SET search_path TO " + schema); err != nil {
						db.Close()
						t.Fatal(err)
					}
					t.Cleanup(func() { _, _ = db.Exec("DROP SCHEMA " + schema + " CASCADE"); _ = db.Close() })
				} else {
					t.Cleanup(func() { _ = db.Close() })
				}
				store := &Store{DB: db, Provider: provider}
				exec := func(statement string, args ...any) {
					t.Helper()
					if _, err := db.Exec(store.Query(statement), args...); err != nil {
						t.Fatalf("fixture SQL failed: %v", err)
					}
				}
				exec("CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE spaces(id TEXT PRIMARY KEY)")
				exec("INSERT INTO users(id) VALUES(?)", "fixture-user")
				exec("INSERT INTO spaces(id) VALUES(?)", "fixture-space")
				old, err := migrationFiles.ReadFile("migrations/" + provider + "/002_integrations.sql")
				if err != nil {
					t.Fatal(err)
				}
				exec(string(old))
				truth := any(true)
				if provider == "sqlite" {
					truth = 1
				}
				exec(`INSERT INTO integration_sources(id,space_id,created_by,name,kind,schema_id,schema_version,connection_json,sync_json,enabled,config_revision,credential_cipher,created_at,updated_at,next_sync_at,last_success_at,last_error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, "fixture-source", "fixture-space", "fixture-user", "Fixture source", "github-traffic", "github.traffic", 1, `{"owner":"fixture","repo":"private"}`, `{"mode":"poll","intervalSeconds":21600,"staleAfterSeconds":43200}`, truth, 17, "encrypted-fixture-keep-exact", "2026-10-18T00:00:00Z", "2026-10-18T01:00:00Z", "2026-10-19T02:00:00Z", "2026-10-18T01:30:00Z", `{"code":"fixture","message":"keep metadata","at":"2026-10-18T01:31:00Z"}`)
				exec(`INSERT INTO integration_tokens(id,user_id,name,token_hash,space_id,source_id,actions_json,permission_epoch,user_version,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, "scoped-token", "fixture-user", "Scoped fixture", "fixture-hash", "fixture-space", "fixture-source", `["sources:read"]`, 7, 3, "2026-10-18T00:00:00Z", "2027-01-01T00:00:00Z", nil)
				exec(`INSERT INTO integration_tokens(id,user_id,name,token_hash,space_id,source_id,actions_json,permission_epoch,user_version,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, "space-token", "fixture-user", "Space fixture", "fixture-space-hash", "fixture-space", nil, `["sources:read","sources:write"]`, 7, 3, "2026-10-18T00:00:00Z", "2027-01-01T00:00:00Z", nil)
				exec(`INSERT INTO integration_snapshots(source_id,revision,source_sequence,data_json,source_updated_at,received_at) VALUES(?,?,?,?,?,?)`, "fixture-source", 123, 99, `{"sample":"snapshot","nullable":null,"nested":[1,2,3]}`, "2026-10-18T01:00:00Z", "2026-10-18T01:30:00Z")
				exec(`INSERT INTO integration_receipts(source_id,request_id,payload_hash,receipt_json) VALUES(?,?,?,?)`, "fixture-source", "request-old", "payload-fixture-hash", `{"sourceId":"fixture-source","revision":"123","receivedAt":"2026-10-18T01:30:00Z"}`)
				exec(`INSERT INTO integration_traffic_baselines(source_id,data_json) VALUES(?,?)`, "fixture-source", `{"views":{"count":12,"uniques":7},"clones":{"count":9,"uniques":3}}`)
				exec(`INSERT INTO integration_traffic_daily(source_id,day,views_count,views_uniques,clones_count,clones_uniques,observed_at,views_observed_at,clones_observed_at) VALUES(?,?,?,?,?,?,?,?,?)`, "fixture-source", "2026-10-18", 12, 7, nil, nil, "2026-10-18T01:30:00Z", "2026-10-18T01:30:00Z", nil)
				before := map[string]componentMigrationRows{}
				for _, table := range componentMigrationTables {
					before[table] = componentCaptureRows(t, db, table, nil)
				}
				migration, err := migrationFiles.ReadFile("migrations/" + provider + "/004_component_sources.sql")
				if err != nil {
					t.Fatal(err)
				}
				tx, err := db.BeginTx(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				statement := string(migration)
				if rollback {
					statement += "\nSELECT force_fixture_migration_failure();"
				}
				_, err = tx.Exec(statement)
				if rollback {
					if err == nil {
						_ = tx.Rollback()
						t.Fatal("failure injection unexpectedly succeeded")
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
				for _, table := range componentMigrationTables {
					actual := componentCaptureRows(t, db, table, before[table].columns)
					if !reflect.DeepEqual(before[table], actual) {
						t.Fatalf("migration changed existing %s rows or metadata", table)
					}
				}
				if provider == "sqlite" {
					var fk int
					if err = db.QueryRow("PRAGMA foreign_keys").Scan(&fk); err != nil || fk != 1 {
						t.Fatalf("foreign keys were not left enabled: %d %v", fk, err)
					}
					rows, err := db.Query("PRAGMA foreign_key_check")
					if err != nil {
						t.Fatal(err)
					}
					bad := rows.Next()
					rows.Close()
					if bad {
						t.Fatal("migration left a broken foreign key")
					}
				}
				if !rollback {
					var received string
					if err = db.QueryRow("SELECT received_at FROM integration_receipts WHERE request_id='request-old'").Scan(&received); err != nil || received != "2026-10-18T01:30:00Z" {
						t.Fatal("receipt retention timestamp was not backfilled")
					}
					exec("UPDATE integration_sources SET kind=? WHERE id=?", "calendar-ics", "fixture-source")
					if _, err = db.Exec(store.Query("UPDATE integration_sources SET kind=? WHERE id=?"), "unregistered-kind", "fixture-source"); err == nil {
						t.Fatal("new source CHECK constraint accepted an unknown adapter")
					}
				} else {
					if _, err = db.Exec(store.Query("UPDATE integration_sources SET kind=? WHERE id=?"), "calendar-ics", "fixture-source"); err == nil {
						t.Fatal("failed migration left the new source constraint behind")
					}
				}
			})
		}
	}
}
