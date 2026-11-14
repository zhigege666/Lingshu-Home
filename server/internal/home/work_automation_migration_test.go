package home

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestWorkAutomationMigrationPreservesAndRollsBack(t *testing.T) {
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
					if name <= "009_document_activity.sql" || name >= "022_work_automation.sql" || !strings.HasSuffix(name, ".sql") {
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
				_, err = db.Exec(store.Query("INSERT INTO work_items(id,space_id,title,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash,activity_started_at,number,priority) VALUES(?,?,?,'doing',?,?,7189,8,?,?,?,?,17,'high')"), "automation-old-item", "old-space", "Preserved planning item", true, false, "2025-01-02T03:04:05Z", "2025-02-03T04:05:06Z", "original-create-hash", "2025-01-02T03:04:05Z")
				if err != nil {
					t.Fatal(err)
				}
				_, err = db.Exec("INSERT INTO work_activity(id,item_id,space_id,action,origin,occurred_at,item_revision,changes_json,session_json) VALUES('automation-old-activity','automation-old-item','old-space','update','mcp','2025-02-03T04:05:06Z',8,'[]','{\"id\":\"real-old-session\"}')")
				if err != nil {
					t.Fatal(err)
				}
				_, err = db.Exec("INSERT INTO work_metric_intervals(id,space_id,item_id,kind,started_at) VALUES('automation-old-interval','old-space','automation-old-item','cycle','2025-02-03T04:05:06Z')")
				if err != nil {
					t.Fatal(err)
				}
				before := sessionUpgradeDatabaseState(t, db, store.Provider)
				body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/022_work_automation.sql")
				if err != nil {
					t.Fatal(err)
				}
				tx, err := db.BeginTx(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				statement := string(body)
				if rollback {
					statement += "\nSELECT intentional_automation_migration_failure();"
				}
				_, err = tx.Exec(statement)
				if rollback {
					if err == nil {
						tx.Rollback()
						t.Fatal("failure injection unexpectedly succeeded")
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
						t.Fatalf("automation migration changed original %s", table)
					}
				}
				var enabled bool
				var count, revision int
				err = db.QueryRow("SELECT work_automation_enabled,work_automation_rule_count,work_automation_revision FROM spaces WHERE id='old-space'").Scan(&enabled, &count, &revision)
				if rollback {
					if err == nil {
						t.Fatal("rolled-back automation flags survived")
					}
					if _, err = db.Exec("SELECT 1 FROM work_executions"); err == nil {
						t.Fatal("rolled-back execution table survived")
					}
					return
				}
				if err != nil || enabled || count != 0 || revision != 1 {
					t.Fatal("migration enabled or populated automation", enabled, count, revision, err)
				}
				if _, err = db.Exec("INSERT INTO work_activity(id,item_id,space_id,action,origin,occurred_at,item_revision,changes_json) VALUES('automation-new-activity','automation-old-item','old-space','update','automation','2026-01-01T00:00:00Z',9,'[]')"); err != nil {
					t.Fatal("automation origin rejected", err)
				}
				if _, err = db.Exec("INSERT INTO work_activity(id,item_id,space_id,action,origin,occurred_at,item_revision,changes_json) VALUES('automation-duplicate-activity','automation-old-item','old-space','update','automation','2026-01-01T00:00:00Z',9,'[]')"); err == nil {
					t.Fatal("activity item/revision uniqueness lost")
				}
				var indexes int
				query := "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('work_activity_item_page','work_activity_period')"
				if postgres {
					query = "SELECT COUNT(*) FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('work_activity_item_page','work_activity_period')"
				}
				if err = db.QueryRow(query).Scan(&indexes); err != nil || indexes != 2 {
					t.Fatal("activity indexes lost", indexes, err)
				}
			})
		}
	}
}
