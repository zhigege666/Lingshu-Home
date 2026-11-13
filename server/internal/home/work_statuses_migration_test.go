package home

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"reflect"
	"testing"
)

func TestWorkStatusesMigrationPreservesAndRollsBack(t *testing.T) {
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
				stamp := "2026-11-13T00:00:00Z"
				for _, name := range []string{"010_session_retention.sql", "011_link_clicks.sql", "012_work_board.sql", "013_account_avatar.sql"} {
					body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/" + name)
					if err != nil {
						t.Fatal(err)
					}
					exec(string(body))
					digest := sha256.Sum256(body)
					exec("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)", name, hex.EncodeToString(digest[:]), stamp)
				}
				// Include an existing space that has never initialized its work board.
				exec("INSERT INTO spaces(id,name,kind,owner_user_id,published,data_revision,updated_at) VALUES(?,?,'personal',?,?,?,?)", "empty-space", "Unused work board", "old-owner", false, 7, stamp)
				exec("INSERT INTO work_spaces(space_id,revision) VALUES(?,?)", "old-space", 17)
				exec("INSERT INTO work_projects(id,space_id,name,name_key,archived,revision,created_at,updated_at,create_hash) VALUES(?,?,?,?,?,5,?,?,?)", "old-project", "old-space", "Preserved project", "preserved project", false, stamp, stamp, "retained-project-hash")
				items := []struct {
					id, status string
					archived   bool
					rank       int64
				}{
					{"legacy-todo", "todo", false, 17},
					{"legacy-doing", "doing", false, 91},
					{"legacy-waiting", "waiting", false, 2048},
					{"legacy-done", "done", false, 8192},
					{"legacy-archived", "waiting", true, 8},
				}
				for i, item := range items {
					exec("INSERT INTO work_items(id,space_id,project_id,title,description,next_step,result,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", item.id, "old-space", "old-project", "Retain "+item.id, "Original description", "Original next step", "Original result", item.status, i%2 == 0, item.archived, item.rank, i+3, stamp, stamp, "retained-create-hash-"+item.id)
					exec("INSERT INTO work_item_links(item_id,link_id) VALUES(?,?)", item.id, "old-link")
					exec("INSERT INTO work_item_documents(item_id,document_id) VALUES(?,?)", item.id, "old-document")
				}
				if rollback {
					// Fail only when the migration records its success, after all DDL and
					// row copies have run. The real migration runner must roll everything back.
					if postgres {
						exec("CREATE FUNCTION work_status_migration_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version='014_work_statuses.sql' THEN RAISE EXCEPTION 'intentional status migration failure'; END IF; RETURN NEW; END $$")
						exec("CREATE TRIGGER work_status_migration_fail BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION work_status_migration_fail_fn()")
					} else {
						exec("CREATE TRIGGER work_status_migration_fail BEFORE INSERT ON schema_migrations WHEN NEW.version='014_work_statuses.sql' BEGIN SELECT RAISE(ABORT,'intentional status migration failure'); END")
					}
				}
				before := sessionUpgradeDatabaseState(t, db, store.Provider)
				for table, original := range before {
					before[table] = workStatusTestRows(t, db, table, original.columns)
				}
				err := store.migrate(context.Background())
				if rollback {
					if err == nil {
						t.Fatal("injected migration failure succeeded")
					}
					after := sessionUpgradeDatabaseState(t, db, store.Provider)
					if len(after) != len(before) {
						t.Fatal("failed migration retained or removed tables")
					}
					for table, original := range before {
						current, exists := after[table]
						if !exists || !reflect.DeepEqual(original.columns, current.columns) || !reflect.DeepEqual(original, workStatusTestRows(t, db, table, original.columns)) {
							t.Fatalf("failed migration changed original %s", table)
						}
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				for table, original := range before {
					if table == "schema_migrations" {
						continue
					}
					projection := table
					if table == "work_spaces" {
						projection += " WHERE space_id='old-space'"
					}
					if !reflect.DeepEqual(original, workStatusTestRows(t, db, projection, original.columns)) {
						t.Fatalf("upgrade changed original rows, references, ranks or revisions in %s", table)
					}
				}
				for _, space := range []string{"old-space", "empty-space"} {
					var boardRevision, statusRevision int64
					var defaultStatus string
					if err = db.QueryRow(store.Query("SELECT revision,status_revision,default_status FROM work_spaces WHERE space_id=?"), space).Scan(&boardRevision, &statusRevision, &defaultStatus); err != nil {
						t.Fatal(err)
					}
					wantBoardRevision := int64(1)
					if space == "old-space" {
						wantBoardRevision = 17
					}
					if boardRevision != wantBoardRevision || statusRevision != 1 || defaultStatus != "todo" {
						t.Fatal("upgrade reset a board revision or omitted a space's defaults")
					}
					rows, err := db.Query(store.Query("SELECT id,name,status_type,sort_order,retired FROM work_statuses WHERE space_id=? ORDER BY sort_order,id"), space)
					if err != nil {
						t.Fatal(err)
					}
					count := 0
					for rows.Next() {
						var id, name, kind string
						var position int
						var retired bool
						if err = rows.Scan(&id, &name, &kind, &position, &retired); err != nil {
							rows.Close()
							t.Fatal(err)
						}
						if count >= 4 || id != []string{"todo", "doing", "waiting", "done"}[count] || name != []string{"Todo", "In progress", "Waiting", "Done"}[count] || kind != id || position != count || retired {
							rows.Close()
							t.Fatal("legacy status meaning, locale or order changed")
						}
						count++
					}
					err = rows.Err()
					rows.Close()
					if err != nil || count != 4 {
						t.Fatalf("incomplete backfilled status catalog: count=%d err=%v", count, err)
					}
				}
				var count int
				if err = db.QueryRow("SELECT COUNT(*) FROM work_items WHERE create_hash_version=1").Scan(&count); err != nil || count != len(items) {
					t.Fatal("legacy creation hashes lost their interpretation", err)
				}
				if err = db.QueryRow("SELECT COUNT(*) FROM schema_migrations WHERE version='014_work_statuses.sql'").Scan(&count); err != nil || count != 1 {
					t.Fatal("successful migration was not recorded once", err)
				}
				if err = store.migrate(context.Background()); err != nil {
					t.Fatal("reopening a migrated database failed", err)
				}
				foreign := newID()
				exec("INSERT INTO work_statuses(space_id,id,name,name_key,status_type,color,sort_order) VALUES(?,?,?,?,?,?,?)", "empty-space", foreign, "Foreign only", "foreign only", "waiting", "#5596bc", 4)
				if _, err = db.Exec(store.Query("UPDATE work_items SET status=? WHERE id=?"), foreign, "legacy-todo"); err == nil {
					t.Fatal("rebuilt work table accepted a status belonging to another space")
				}
				exec("DELETE FROM work_items WHERE id=?", "legacy-todo")
				for _, table := range []string{"work_item_links", "work_item_documents"} {
					if err = db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != len(items)-1 {
						t.Fatal("recreated reference table lost its item cascade", table, err)
					}
				}
				for _, table := range []string{"links", "documents"} {
					if err = db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 1 {
						t.Fatal("item deletion destroyed original source data", table, err)
					}
				}
			})
		}
	}
}
