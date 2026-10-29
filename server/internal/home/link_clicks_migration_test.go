package home

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"
)

func TestLinkClickMigrationPreservesAndRollsBack(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, rollback := range []bool{false, true} {
			t.Run(fmt.Sprintf("postgres-%v/rollback-%v", postgres, rollback), func(t *testing.T) {
				db, store := documentMigrationDB(t, postgres)
				// Start with the same seeded 009 legacy state and apply the exact published
				// 010 bytes, including real sessions, notes, documents, assets and revisions.
				seedSessionUpgrade(t, db, store, 9, false, nil)
				previous, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/010_session_retention.sql")
				if err != nil {
					t.Fatal(err)
				}
				if _, err = db.Exec(string(previous)); err != nil {
					t.Fatal(err)
				}
				before := sessionUpgradeDatabaseState(t, db, store.Provider)
				body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/011_link_clicks.sql")
				if err != nil {
					t.Fatal(err)
				}
				tx, err := db.BeginTx(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				statement := string(body)
				if rollback {
					statement += "\nSELECT intentional_click_migration_failure();"
				}
				_, err = tx.Exec(statement)
				if rollback {
					if err == nil {
						_ = tx.Rollback()
						t.Fatal("failure injection unexpectedly succeeded")
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
				for table, original := range before {
					if !reflect.DeepEqual(original, componentCaptureRows(t, db, table, original.columns)) {
						t.Fatalf("click migration rewrote original %s", table)
					}
				}
				if rollback {
					if rows, queryErr := db.Query("SELECT * FROM link_click_tracking"); queryErr == nil {
						_ = rows.Close()
						t.Fatal("failed migration left click tables")
					}
				} else {
					var started string
					if err = db.QueryRow("SELECT recorded_from FROM link_click_tracking WHERE id=1").Scan(&started); err != nil {
						t.Fatal(err)
					}
					instant, err := time.Parse(time.RFC3339Nano, started)
					if err != nil || time.Since(instant) > time.Minute || instant.After(time.Now().Add(time.Second)) {
						t.Fatal("invalid tracking baseline", started, err)
					}
					for _, table := range []string{"link_click_totals", "link_click_days", "link_click_receipts"} {
						var n int
						if err = db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil || n != 0 {
							t.Fatal("upgrade invented historical clicks", table, err)
						}
					}
					// Verify FK cleanup against an actual old bookmark rather than a synthetic
					// parentless counter; rows vanish with the existing bookmark transaction.
					stamp := documentActivityStamp(time.Now())
					for _, operation := range []struct {
						query string
						args  []any
					}{
						{"INSERT INTO link_click_totals VALUES(?,?,1,?,?)", []any{"old-link", "old-space", stamp, stamp}},
						{"INSERT INTO link_click_days VALUES(?,?,?,'primary',1)", []any{"old-link", "old-space", time.Now().UTC().Format(time.DateOnly)}},
						{"INSERT INTO link_click_receipts VALUES(?,?,?,'primary',?)", []any{"old-space", newID(), "old-link", stamp}},
					} {
						if _, err = db.Exec(store.Query(operation.query), operation.args...); err != nil {
							t.Fatal(err)
						}
					}
					if _, err = db.Exec("DELETE FROM links WHERE id='old-link'"); err != nil {
						t.Fatal(err)
					}
					for _, table := range []string{"link_click_totals", "link_click_days", "link_click_receipts"} {
						var n int
						if err = db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil || n != 0 {
							t.Fatal("migration foreign key does not cascade", table, err)
						}
					}
				}
			})
		}
	}
}
