package home

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestWorkScheduleMigrationPreservesAndRollsBack(t *testing.T) {
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
					if name <= "009_document_activity.sql" || name >= "020_work_schedules.sql" || !strings.HasSuffix(name, ".sql") {
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
				_, err = db.Exec(store.Query("INSERT INTO work_items(id,space_id,title,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash,activity_started_at) VALUES(?,?,?,'todo',?,?,7189,8,?,?,?,?)"), "old-scheduled-work", "old-space", "Preserve old work", true, true, "2025-01-02T03:04:05Z", "2025-02-03T04:05:06Z", "original-create-hash", "2025-01-02T03:04:05Z")
				if err != nil {
					t.Fatal(err)
				}
				_, err = db.Exec("INSERT INTO work_activity(id,item_id,space_id,action,origin,occurred_at,item_revision,changes_json,session_json) VALUES('old-event','old-scheduled-work','old-space','update','mcp','2025-02-03T04:05:06Z',8,'[]','{\"id\":\"old-session\"}')")
				if err != nil {
					t.Fatal(err)
				}
				before := sessionUpgradeDatabaseState(t, db, store.Provider)
				body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/020_work_schedules.sql")
				if err != nil {
					t.Fatal(err)
				}
				tx, err := db.BeginTx(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				statement := string(body)
				if rollback {
					statement += "\nSELECT intentional_work_schedule_migration_failure();"
				}
				_, err = tx.Exec(statement)
				if rollback {
					if err == nil {
						tx.Rollback()
						t.Fatal("migration failure injection unexpectedly succeeded")
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
						t.Fatalf("schedule migration changed original %s", table)
					}
				}
				var businessDate, dueAt, scheduleID string
				err = db.QueryRow("SELECT business_date,due_at,schedule_id FROM work_items WHERE id='old-scheduled-work'").Scan(&businessDate, &dueAt, &scheduleID)
				if rollback {
					if err == nil {
						t.Fatal("rolled-back date columns survived")
					}
					if _, err = db.Exec("SELECT 1 FROM work_schedules"); err == nil {
						t.Fatal("rolled-back schedule table survived")
					}
					return
				}
				if err != nil || businessDate != "" || dueAt != "" || scheduleID != "" {
					t.Fatal("migration invented dates/origins for legacy work", err)
				}
				if _, err = db.Exec("INSERT INTO work_activity(id,item_id,space_id,action,origin,occurred_at,item_revision,changes_json,session_json) VALUES('new-scheduler-event','old-scheduled-work','old-space','update','scheduler','2026-01-01T00:00:00Z',9,'[]','')"); err != nil {
					t.Fatal("scheduler origin unavailable after migration", err)
				}
			})
		}
	}
}
