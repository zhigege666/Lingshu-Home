package home

import (
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func sessionMigrationColumns(t *testing.T, db *sql.DB, table string) []string {
	t.Helper()
	rows, err := db.Query("SELECT * FROM " + table + " WHERE 1=0")
	if err != nil {
		t.Fatal(err)
	}
	columns, err := rows.Columns()
	closeErr := rows.Close()
	if err != nil {
		t.Fatal(err)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	return columns
}
func TestSessionRetentionMigrationPreservesLegacyAndRollsBack(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			for _, rollback := range []bool{false, true} {
				name := "upgrade"
				if rollback {
					name = "rollback"
				}
				t.Run(name, func(t *testing.T) {
					driver, dsn := "sqlite", "file:"+filepath.Join(t.TempDir(), "legacy.db")+"?_pragma=foreign_keys(1)"
					if provider == "postgres" {
						c := autoIconConfig(t, true)
						driver, dsn = "pgx", c.DatabaseURL
					}
					db, err := sql.Open(driver, dsn)
					if err != nil {
						t.Fatal(err)
					}
					defer db.Close()
					db.SetMaxOpenConns(1)
					store := &Store{DB: db, Provider: provider}
					for _, name := range []string{"001_initial.sql", "002_integrations.sql", "003_icons.sql", "004_component_sources.sql", "005_auto_icons.sql", "006_network_routing.sql", "007_instance_language.sql", "008_document_library.sql", "009_document_activity.sql"} {
						body, err := migrationFiles.ReadFile("migrations/" + provider + "/" + name)
						if err != nil {
							t.Fatal(err)
						}
						tx, err := db.BeginTx(context.Background(), nil)
						if err != nil {
							t.Fatal(err)
						}
						if _, err = tx.Exec(string(body)); err != nil {
							tx.Rollback()
							t.Fatal(err)
						}
						if err = tx.Commit(); err != nil {
							t.Fatal(err)
						}
					}
					now := sessionNow()
					userID := "legacy-session-owner"
					_, err = db.Exec(store.Query("INSERT INTO users(id,username,normalized_username,display_name,role,is_enabled,password_hash,version,created_at) VALUES(?,?,?,?,?,?,?,?,?)"), userID, "legacy_owner", "legacy_owner", "Legacy Owner", "Owner", true, "retained-old-password-hash", int64(3), sessionTimeString(now.Add(-time.Hour)))
					if err != nil {
						t.Fatal(err)
					}
					_, err = db.Exec(store.Query("UPDATE settings SET initialized=?,site_name=?,mode=?,registration_enabled=?,auth_epoch=?,language=? WHERE id=1"), true, "Legacy session site", ModePrivateMulti, false, int64(7), "en")
					if err != nil {
						t.Fatal(err)
					}
					validHash, expiredHash := tokenHash(randomToken()), tokenHash(randomToken())
					validExpiry, expiredExpiry := now.Add(11*time.Hour), now.Add(-time.Hour)
					for _, item := range []struct {
						hash   string
						expiry time.Time
					}{{validHash, validExpiry}, {expiredHash, expiredExpiry}} {
						_, err = db.Exec(store.Query("INSERT INTO sessions(token_hash,user_id,auth_epoch,user_version,expires_at) VALUES(?,?,?,?,?)"), item.hash, userID, int64(7), int64(3), sessionTimeString(item.expiry))
						if err != nil {
							t.Fatal(err)
						}
					}
					settingsBefore := componentCaptureRows(t, db, "settings", nil)
					usersBefore := componentCaptureRows(t, db, "users", nil)
					sessionsBefore := componentCaptureRows(t, db, "sessions", nil)
					settingsCols := sessionMigrationColumns(t, db, "settings")
					sessionCols := sessionMigrationColumns(t, db, "sessions")
					body, err := migrationFiles.ReadFile("migrations/" + provider + "/010_session_retention.sql")
					if err != nil {
						t.Fatal(err)
					}
					tx, err := db.BeginTx(context.Background(), nil)
					if err != nil {
						t.Fatal(err)
					}
					statement := string(body)
					if rollback {
						statement += "\nSELECT intentional_session_migration_failure();"
					}
					_, err = tx.Exec(statement)
					if rollback {
						if err == nil {
							tx.Rollback()
							t.Fatal("Injected failure succeeded")
						}
						if err = tx.Rollback(); err != nil {
							t.Fatal(err)
						}
					} else {
						if err != nil {
							tx.Rollback()
							t.Fatal(err)
						}
						if err = tx.Commit(); err != nil {
							t.Fatal(err)
						}
					}
					if !reflect.DeepEqual(settingsBefore, componentCaptureRows(t, db, "settings", settingsBefore.columns)) || !reflect.DeepEqual(usersBefore, componentCaptureRows(t, db, "users", usersBefore.columns)) || !reflect.DeepEqual(sessionsBefore, componentCaptureRows(t, db, "sessions", sessionsBefore.columns)) {
						t.Fatal("Migration changed existing columns")
					}
					if rollback {
						if !reflect.DeepEqual(settingsCols, sessionMigrationColumns(t, db, "settings")) || !reflect.DeepEqual(sessionCols, sessionMigrationColumns(t, db, "sessions")) {
							t.Fatal("Rollback retained schema changes")
						}
					} else {
						var p SessionPolicy
						err = db.QueryRow("SELECT default_session_mode,default_idle_days,max_idle_days,allow_until_logout,session_policy_version FROM settings WHERE id=1").Scan(&p.DefaultMode, &p.DefaultIdleDays, &p.MaxIdleDays, &p.AllowUntilLogout, &p.PolicyVersion)
						if err != nil {
							t.Fatal(err)
						}
						if p.DefaultMode != sessionRemember || p.DefaultIdleDays != 30 || p.MaxIdleDays != 30 || p.AllowUntilLogout || p.PolicyVersion != 1 {
							t.Fatal("Wrong new-login defaults")
						}
						for _, item := range []struct {
							hash   string
							expiry time.Time
							valid  bool
						}{{validHash, validExpiry, true}, {expiredHash, expiredExpiry, false}} {
							record, err := scanSessionRecord(db.QueryRow(store.Query("SELECT "+retentionSessionColumns+" FROM sessions WHERE token_hash=?"), item.hash))
							if err != nil {
								t.Fatal(err)
							}
							if record.Mode != sessionTemporary || record.IdleDays != 0 || !record.CreatedAt.IsZero() || !record.LastInteractiveAt.IsZero() || !record.RenewedAt.IsZero() || record.UserAgent != "" || !record.ExpiresAt.Equal(item.expiry) {
								t.Fatal("Legacy session metadata/lifetime changed")
							}
							if usableSession(record, p, now) != item.valid {
								t.Fatal("Legacy validity changed")
							}
							s := sessionSummary(record, p, now)
							if s.Mode != sessionTemporary || s.IdleDays != 0 || s.RenewAfterSeconds != 0 {
								t.Fatal("Old session upgraded")
							}
						}
					}
					if provider == "sqlite" {
						var enabled int
						if err := db.QueryRow("PRAGMA foreign_keys").Scan(&enabled); err != nil || enabled != 1 {
							t.Fatal("Foreign keys disabled", err)
						}
						rows, err := db.Query("PRAGMA foreign_key_check")
						if err != nil {
							t.Fatal(err)
						}
						violation := rows.Next()
						rowErr := rows.Err()
						rows.Close()
						if rowErr != nil || violation {
							t.Fatal("Foreign key violation", rowErr)
						}
					}
				})
			}
		})
	}
}
