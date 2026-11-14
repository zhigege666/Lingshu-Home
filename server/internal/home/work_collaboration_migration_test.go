package home

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestWorkCollaborationMigrationPreservesAndRollsBack(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, rollback := range []bool{false, true} {
			t.Run(fmt.Sprintf("postgres-%v/rollback-%v", postgres, rollback), func(t *testing.T) {
				db, store := documentMigrationDB(t, postgres)
				exec := func(query string, args ...any) {
					t.Helper()
					if _, err := db.Exec(store.Query(query), args...); err != nil {
						t.Fatal(err)
					}
				}
				seedSessionUpgrade(t, db, store, 9, false, nil)
				entries, err := migrationFiles.ReadDir("migrations/" + store.Provider)
				if err != nil {
					t.Fatal(err)
				}
				stamp := "2026-11-13T01:02:03Z"
				for _, entry := range entries {
					name := entry.Name()
					if name <= "009_document_activity.sql" || name >= "018_work_collaboration.sql" || !strings.HasSuffix(name, ".sql") {
						continue
					}
					body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/" + name)
					if err != nil {
						t.Fatal(err)
					}
					exec(string(body))
					digest := sha256.Sum256(body)
					exec("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)", name, hex.EncodeToString(digest[:]), stamp)
				}
				exec("INSERT INTO work_projects(id,space_id,name,name_key,archived,revision,created_at,updated_at,create_hash) VALUES('old-project','old-space','Preserved project','preserved project',?,3,?,?,'retained-project-hash')", false, stamp, stamp)
				exec("INSERT INTO work_items(id,space_id,project_id,title,description,next_step,result,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash,create_hash_version,activity_started_at) VALUES('old-collaboration-item','old-space','old-project','Preserved work','Original explanation','Original next step','Original result','waiting',?,?,4096,8,?,?,'retained-intent',2,?)", true, false, stamp, stamp, stamp)
				exec("INSERT INTO work_item_links(item_id,link_id) VALUES('old-collaboration-item','old-link')")
				exec("INSERT INTO work_item_documents(item_id,document_id) VALUES('old-collaboration-item','old-document')")
				exec("INSERT INTO work_activity(id,item_id,space_id,actor_id,action,origin,occurred_at,item_revision,changes_json) VALUES('old-work-activity','old-collaboration-item','old-space','old-owner','update','mcp',?,8,'[]')", stamp)
				exec("INSERT INTO integration_tokens(id,user_id,name,token_hash,space_id,actions_json,permission_epoch,user_version,created_at,expires_at) VALUES('old-work-token','old-owner','Retained credential','nonsecret-fixture-token-hash','old-space','[\"work:read\",\"work:write\"]',7,3,?,'2099-11-13T01:02:03Z')", stamp)
				if rollback {
					if postgres {
						exec("CREATE FUNCTION work_collaboration_migration_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version='018_work_collaboration.sql' THEN RAISE EXCEPTION 'intentional collaboration migration failure'; END IF; RETURN NEW; END $$")
						exec("CREATE TRIGGER work_collaboration_migration_fail BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION work_collaboration_migration_fail_fn()")
					} else {
						exec("CREATE TRIGGER work_collaboration_migration_fail BEFORE INSERT ON schema_migrations WHEN NEW.version='018_work_collaboration.sql' BEGIN SELECT RAISE(ABORT,'intentional collaboration migration failure'); END")
					}
				}
				before := sessionUpgradeDatabaseState(t, db, store.Provider)
				for table, old := range before {
					before[table] = workStatusTestRows(t, db, table, old.columns)
				}
				err = store.migrate(context.Background())
				if rollback {
					if err == nil {
						t.Fatal("injected migration failure succeeded")
					}
					after := sessionUpgradeDatabaseState(t, db, store.Provider)
					if len(before) != len(after) {
						t.Fatal("failed migration retained collaboration tables")
					}
					for table, old := range before {
						now, exists := after[table]
						if !exists || !reflect.DeepEqual(old.columns, now.columns) || !reflect.DeepEqual(old, workStatusTestRows(t, db, table, old.columns)) {
							t.Fatalf("failed migration changed %s", table)
						}
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				for table, old := range before {
					if table == "schema_migrations" {
						continue
					}
					if !reflect.DeepEqual(old, workStatusTestRows(t, db, table, old.columns)) {
						t.Fatalf("018 changed original data, token scopes, history, revisions or references in %s", table)
					}
				}
				var attribution string
				if err = db.QueryRow("SELECT session_json FROM work_activity WHERE id='old-work-activity'").Scan(&attribution); err != nil || attribution != "" {
					t.Fatal("upgrade fabricated a session for old activity", err)
				}
				for _, table := range []string{"work_sessions", "work_claims", "work_collaboration_spaces", "work_collaboration_events", "work_operation_receipts"} {
					var count int
					if err = db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
						t.Fatalf("new table %s fabricated records: %v", table, err)
					}
				}
				migrated := sessionUpgradeDatabaseState(t, db, store.Provider)
				for table, old := range migrated {
					migrated[table] = workStatusTestRows(t, db, table, old.columns)
				}
				if err = store.migrate(context.Background()); err != nil {
					t.Fatal("second startup failed", err)
				}
				for table, old := range migrated {
					if !reflect.DeepEqual(workStatusTestRows(t, db, table, old.columns), old) {
						t.Fatalf("second startup changed %s", table)
					}
				}
				var count int
				if err = db.QueryRow("SELECT COUNT(*) FROM schema_migrations WHERE version='018_work_collaboration.sql'").Scan(&count); err != nil || count != 1 {
					t.Fatal("migration was not recorded exactly once", err)
				}
			})
		}
	}
}
