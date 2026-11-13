package home

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestModuleMigrationPreservesAndRollsBack(t *testing.T) {
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
					if name <= "009_document_activity.sql" || name >= "017_modules.sql" || !strings.HasSuffix(name, ".sql") {
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
				stamp := "2026-11-13T00:00:00Z"
				if _, err = db.Exec(store.Query("INSERT INTO work_items(id,space_id,title,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash) VALUES(?,?,?,'todo',?,?,1024,1,?,?,?)"), "module-old-item", "old-space", "Retained work", false, false, stamp, stamp, "original-create-hash"); err != nil {
					t.Fatal(err)
				}
				if _, err = db.Exec("INSERT INTO work_item_documents(item_id,document_id) VALUES('module-old-item','old-document')"); err != nil {
					t.Fatal(err)
				}
				before := sessionUpgradeDatabaseState(t, db, store.Provider)
				body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/017_modules.sql")
				if err != nil {
					t.Fatal(err)
				}
				tx, err := db.BeginTx(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				statement := string(body)
				if rollback {
					statement += "\nSELECT intentional_module_migration_failure();"
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
						t.Fatalf("module migration changed original %s", table)
					}
				}
				var documents, work bool
				err = db.QueryRow("SELECT documents_enabled,work_enabled FROM settings WHERE id=1").Scan(&documents, &work)
				if rollback {
					if err == nil {
						t.Fatal("rolled-back module columns survived")
					}
				} else if err != nil || !documents || !work {
					t.Fatalf("upgraded modules must default enabled: %v", err)
				}
			})
		}
	}
}
