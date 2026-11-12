package home

import (
	"context"
	"fmt"
	"reflect"
	"testing"
)

func TestWorkMigrationPreservesAndRollsBack(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, rollback := range []bool{false, true} {
			t.Run(fmt.Sprintf("postgres-%v/rollback-%v", postgres, rollback), func(t *testing.T) {
				db, store := documentMigrationDB(t, postgres)
				seedSessionUpgrade(t, db, store, 9, false, nil)
				for _, name := range []string{"010_session_retention.sql", "011_link_clicks.sql"} {
					body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/" + name)
					if err != nil {
						t.Fatal(err)
					}
					if _, err = db.Exec(string(body)); err != nil {
						t.Fatal(err)
					}
				}
				before := sessionUpgradeDatabaseState(t, db, store.Provider)
				body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/012_work_board.sql")
				if err != nil {
					t.Fatal(err)
				}
				tx, err := db.BeginTx(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				statement := string(body)
				if rollback {
					statement += "\nSELECT intentional_work_migration_failure();"
				}
				_, err = tx.Exec(statement)
				if rollback {
					if err == nil {
						tx.Rollback()
						t.Fatal("failure injection succeeded")
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
				for table, original := range before {
					if !reflect.DeepEqual(original, componentCaptureRows(t, db, table, original.columns)) {
						t.Fatalf("migration changed original %s", table)
					}
				}
				for _, table := range []string{"work_spaces", "work_projects", "work_items", "work_item_links", "work_item_documents"} {
					var n int
					err = db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n)
					if rollback {
						if err == nil {
							t.Fatal("rollback left", table)
						}
					} else if err != nil || n != 0 {
						t.Fatal("new table not empty", table, err)
					}
				}
				if !rollback {
					stamp := "2026-11-13T00:00:00Z"
					_, err = db.Exec(store.Query("INSERT INTO work_items(id,space_id,title,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash) VALUES(?,?,?,'todo',?,?,1024,1,?,?,?)"), "work-test", "old-space", "Preserved source", false, false, stamp, stamp, "fixture")
					if err != nil {
						t.Fatal(err)
					}
					_, err = db.Exec(store.Query("INSERT INTO work_item_links(item_id,link_id) VALUES(?,?)"), "work-test", "old-link")
					if err != nil {
						t.Fatal(err)
					}
					if _, err = db.Exec("DELETE FROM links WHERE id='old-link'"); err != nil {
						t.Fatal(err)
					}
					var itemCount, referenceCount int
					if err = db.QueryRow("SELECT COUNT(*) FROM work_items").Scan(&itemCount); err != nil {
						t.Fatal(err)
					}
					if err = db.QueryRow("SELECT COUNT(*) FROM work_item_links").Scan(&referenceCount); err != nil {
						t.Fatal(err)
					}
					if itemCount != 1 || referenceCount != 0 {
						t.Fatal("bookmark removal destroyed work or retained dangling reference")
					}
				}
			})
		}
	}
}
