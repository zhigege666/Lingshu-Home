package home

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestWorkActivityMigrationPreservesAndRollsBack(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, rollback := range []bool{false, true} {
			t.Run(fmt.Sprintf("postgres-%v/rollback-%v", postgres, rollback), func(t *testing.T) {
				db, store := documentMigrationDB(t, postgres)
				seedSessionUpgrade(t, db, store, 9, false, nil)
				entries, err := migrationFiles.ReadDir("migrations/" + store.Provider)
				if err != nil {
					t.Fatal(err)
				}
				for _, entry := range entries {
					name := entry.Name()
					if name <= "009_document_activity.sql" || name >= "016_work_activity.sql" || !strings.HasSuffix(name, ".sql") {
						continue
					}
					body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/" + name)
					if err != nil {
						t.Fatal(err)
					}
					if _, err = db.Exec(string(body)); err != nil {
						t.Fatal(name, err)
					}
				}
				created, updated := "2025-01-02T03:04:05Z", "2025-02-03T04:05:06Z"
				if _, err = db.Exec(store.Query("INSERT INTO work_items(id,space_id,title,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash) VALUES(?,?,?,'todo',?,?,7189,8,?,?,?)"), "old-history-item", "old-space", "Preserved work", true, true, created, updated, "original-hash"); err != nil {
					t.Fatal(err)
				}
				for _, query := range []string{"INSERT INTO work_item_links(item_id,link_id) VALUES('old-history-item','old-link')", "INSERT INTO work_item_documents(item_id,document_id) VALUES('old-history-item','old-document')"} {
					if _, err = db.Exec(query); err != nil {
						t.Fatal(err)
					}
				}
				before := sessionUpgradeDatabaseState(t, db, store.Provider)
				body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/016_work_activity.sql")
				if err != nil {
					t.Fatal(err)
				}
				started := time.Now().UTC().Add(-time.Second)
				tx, err := db.BeginTx(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				statement := string(body)
				if rollback {
					statement += "\nSELECT intentional_activity_migration_failure();"
				}
				_, err = tx.Exec(statement)
				if rollback {
					if err == nil {
						_ = tx.Rollback()
						t.Fatal("migration failure injection succeeded")
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
						t.Fatalf("activity migration changed original %s", table)
					}
				}
				var baseline string
				err = db.QueryRow("SELECT activity_started_at FROM work_items WHERE id='old-history-item'").Scan(&baseline)
				if rollback {
					if err == nil {
						t.Fatal("rolled-back baseline column survived")
					}
					if _, err = db.Exec("SELECT 1 FROM work_activity"); err == nil {
						t.Fatal("rolled-back activity table survived")
					}
					return
				}
				at, parseErr := time.Parse(time.RFC3339Nano, baseline)
				if err != nil || parseErr != nil || at.Before(started) || at.After(time.Now().UTC().Add(time.Second)) {
					t.Fatalf("invalid historical baseline %q: %v / %v", baseline, err, parseErr)
				}
				var count int
				if err = db.QueryRow("SELECT COUNT(*) FROM work_activity").Scan(&count); err != nil || count != 0 {
					t.Fatal("migration fabricated history", err)
				}
			})
		}
	}
}
