package home

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

const shortIDMigrationName = "023_work_short_ids.sql"

func seedShortIDUpgrade(t *testing.T, db *sql.DB, store *Store) {
	t.Helper()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(store.Query(query), args...); err != nil {
			t.Fatal(err)
		}
	}
	seedSessionUpgrade(t, db, store, 9, false, nil)
	stamp := "2026-01-01T00:00:00Z"
	exec("INSERT INTO spaces(id,name,kind,owner_user_id,published,data_revision,updated_at) VALUES('old-personal','Personal','personal','old-owner',FALSE,9,?)", stamp)
	entries, err := migrationFiles.ReadDir("migrations/" + store.Provider)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if name <= "009_document_activity.sql" || name >= shortIDMigrationName || !strings.HasSuffix(name, ".sql") {
			continue
		}
		body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/" + name)
		if err != nil {
			t.Fatal(err)
		}
		exec(string(body))
		sum := sha256.Sum256(body)
		exec("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)", name, hex.EncodeToString(sum[:]), stamp)
	}
	id := func(n int) string { return fmt.Sprintf("%032x", n) }
	// Reverse insertion and tied timestamps prove stable global ordering. Both
	// spaces contain W-1, and forty items cover 00009 -> 0000a and 0000z -> 00010.
	for n := 40; n >= 1; n-- {
		space := "old-space"
		if n%2 == 0 {
			space = "old-personal"
		}
		exec("INSERT INTO work_items(id,space_id,title,description,next_step,result,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash,create_hash_version,activity_started_at,number) VALUES(?,?,?,?,?,?,'doing',?,?,?,8,?,?,?,2,?,?)",
			id(n), space, "Card "+strconv.Itoa(n), id(3), "Preserve next step", "Preserve result", n%3 == 0, n%7 == 0, 4096+n, stamp, stamp, "original-hash-"+strconv.Itoa(n), stamp, (n+1)/2)
	}
	// These tied ranks sort by old ID, while their new IDs follow reversed creation order.
	exec("UPDATE work_items SET sort_order=7777 WHERE id IN (?,?)", id(37), id(39))
	exec("UPDATE work_items SET created_at='2026-01-02T00:00:00Z' WHERE id=?", id(37))
	exec("UPDATE work_items SET parent_id=?,predecessor_id=? WHERE id=?", id(3), id(3), id(1))
	exec("INSERT INTO work_item_links(item_id,link_id) VALUES(?,'old-link')", id(1))
	exec("INSERT INTO work_item_documents(item_id,document_id) VALUES(?,'old-document')", id(1))
	changes := []any{
		map[string]any{"field": "relations", "before": map[string]any{"parentId": "", "predecessorId": "", "blockedByIds": []string{}}, "after": map[string]any{"parentId": id(3), "predecessorId": id(3), "blockedByIds": []string{id(3)}}},
		map[string]any{"field": "project", "before": map[string]any{"id": id(3), "name": "Unrelated identity"}, "after": nil},
	}
	exec("INSERT INTO work_activity(id,item_id,space_id,actor_id,action,origin,occurred_at,item_revision,changes_json,session_json) VALUES('activity',?,'old-space','old-owner','update','mcp',?,8,?,'{\"id\":\"session\"}')", id(1), stamp, jsonString(changes))
	exec("INSERT INTO work_sessions(id,space_id,user_id,registration_id,create_hash,agent_name,created_at,last_seen_at) VALUES('session','old-space','old-owner','registration','session-hash','Agent',?,?)", stamp, stamp)
	exec("INSERT INTO work_claims(item_id,space_id,claim_id,session_id,generation,expires_at,last_seen_at,handoff_json) VALUES(?,'old-space','claim','session',7,'2099-01-01T00:00:00Z',?,?)", id(1), stamp, jsonString(map[string]string{"nextStep": id(3)}))
	exec("INSERT INTO work_collaboration_spaces(space_id,revision) VALUES('old-space',17)")
	exec("INSERT INTO work_collaboration_events(id,space_id,item_id,sequence,operation_id,actor_id,kind,body,occurred_at,origin) VALUES('collaboration-event','old-space',?,1,'event-operation','old-owner','progress',?,?,'mcp')", id(1), id(3), stamp)
	exec("INSERT INTO work_operation_receipts(space_id,user_id,operation_id,request_hash,response_json,created_at) VALUES('old-space','old-owner','card-receipt','retained-card-hash',?,?)",
		jsonString(map[string]any{"id": id(1), "revision": "8", "boardRevision": "12", "replayed": true}), stamp)
	// Root id here identifies an event, despite deliberately sharing a card's
	// textual value. Only itemId is a card reference in this response shape.
	exec("INSERT INTO work_operation_receipts(space_id,user_id,operation_id,request_hash,response_json,created_at) VALUES('old-space','old-owner','event-receipt','retained-event-hash',?,?)",
		jsonString(map[string]any{"id": id(1), "itemId": id(3), "kind": "progress"}), stamp)
	exec("INSERT INTO work_operation_receipts(space_id,user_id,operation_id,request_hash,response_json,created_at) VALUES('old-space','old-owner','session-receipt','retained-session-hash',?,?)",
		"{ \"id\" : \""+id(3)+"\", \"agentName\" : \"Unrelated session\" }", stamp)
	exec("INSERT INTO work_schedules(id,space_id,name,template_json,rule_json,missed_policy,overlap_policy,created_at,updated_at,create_hash) VALUES('schedule','old-space','Schedule','{}','{}','all','create',?,?,'schedule-hash')", stamp, stamp)
	exec("INSERT INTO work_schedule_occurrences(schedule_id,business_date,scheduled_at,item_id,result,occurred_at,template_revision) VALUES('schedule','2026-01-01',?,?,'created',?,5)", stamp, id(1), stamp)
	exec("INSERT INTO work_labels(id,space_id,name,name_key,color,created_at,updated_at,create_hash) VALUES('label','old-space','Label','label','#123456',?,?,'label-hash')", stamp, stamp)
	exec("INSERT INTO work_item_labels(space_id,item_id,label_id) VALUES('old-space',?,'label')", id(1))
	exec("INSERT INTO work_dependencies(space_id,item_id,blocked_by_id) VALUES('old-space',?,?)", id(1), id(3))
	exec("INSERT INTO work_metric_intervals(id,space_id,item_id,kind,started_at) VALUES('metric','old-space',?,'cycle',?)", id(1), stamp)
	for n, space := range []string{"old-space", "old-personal"} {
		filters := map[string]any{"itemId": "W-1", "q": id(3)}
		if n == 0 {
			filters["parentId"] = id(3)
		}
		exec("INSERT INTO work_views(id,space_id,owner_user_id,name,visibility,definition_json,created_at,updated_at,create_hash) VALUES(?,?,'old-owner','Saved view','shared',?,?,?,'view-hash')",
			"view-"+strconv.Itoa(n), space, jsonString(map[string]any{"layout": "board", "filters": filters, "fields": []string{"key", "priority", "id"}}), stamp, stamp)
	}
	exec("INSERT INTO work_executors(id,space_id,name,endpoint,resource_key,poll_seconds,timeout_seconds,created_at,updated_at,create_hash) VALUES('executor','old-space','Executor','https://example.invalid/executor','resource',2,60,?,?,'executor-hash')", stamp, stamp)
	exec("INSERT INTO work_automation_events(id,space_id,event_type,source_item_id,origin,payload_json,state,created_at,create_hash) VALUES('automation-event','old-space','work.created',?,'work',?,'processed',?,'event-hash')",
		id(1), jsonString(map[string]string{"summary": id(3), "details": "Unchanged text", "url": ""}), stamp)
	exec("INSERT INTO work_automation_rules(id,space_id,name,event_type,template_json,executor_id,created_at,updated_at,create_hash) VALUES('rule','old-space','Rule','work.created','{}','executor',?,?,'rule-hash')", stamp, stamp)
	for _, execution := range []struct{ id, item, state, snapshot string }{
		{"queued-execution", id(1), "queued", jsonString(map[string]any{"id": "queued-execution", "item": map[string]any{"id": id(1), "key": "W-1", "title": id(3)}})},
		{"sent-execution", id(3), "running", " { \"id\" : \"sent-execution\", \"item\" : { \"id\" : \"" + id(3) + "\", \"key\" : \"W-2\" } } "},
	} {
		exec("INSERT INTO work_executions(id,space_id,item_id,executor_id,executor_name,executor_revision,item_revision,resource_key,state,snapshot_json,context_json,create_hash,created_at) VALUES(?,'old-space',?,'executor','Executor',4,8,'resource',?,?,?,'execution-hash',?)",
			execution.id, execution.item, execution.state, execution.snapshot, jsonString(map[string]any{"operationId": id(3)}), stamp)
	}
	exec("INSERT INTO work_automation_receipts(event_id,rule_id,rule_revision,item_id,execution_id,result,occurred_at) VALUES('automation-event','rule',4,?,'queued-execution','created',?)", id(1), stamp)
	exec("INSERT INTO work_notices(id,space_id,user_id,kind,subject_type,subject_id,occurrence_key,item_id,code,message,first_at,last_at) VALUES('notice','old-space','old-owner','execution_unknown','execution','sent-execution','sent-execution',?,'unknown',?,?,?)", id(3), id(3), stamp, stamp)
}

func TestWorkShortIDsMigrationPreservesAndRollsBack(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		for _, rollback := range []bool{false, true} {
			t.Run(fmt.Sprintf("postgres-%v/rollback-%v", postgres, rollback), func(t *testing.T) {
				db, store := documentMigrationDB(t, postgres)
				seedShortIDUpgrade(t, db, store)
				exec := func(query string, args ...any) {
					t.Helper()
					if _, err := db.Exec(store.Query(query), args...); err != nil {
						t.Fatal(err)
					}
				}
				if rollback {
					if postgres {
						exec("CREATE FUNCTION short_id_migration_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version='023_work_short_ids.sql' THEN RAISE EXCEPTION 'intentional short identifier migration failure'; END IF; RETURN NEW; END $$")
						exec("CREATE TRIGGER short_id_migration_fail BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION short_id_migration_fail_fn()")
					} else {
						exec("CREATE TRIGGER short_id_migration_fail BEFORE INSERT ON schema_migrations WHEN NEW.version='023_work_short_ids.sql' BEGIN SELECT RAISE(ABORT,'intentional short identifier migration failure'); END")
					}
				}
				before := sessionUpgradeDatabaseState(t, db, store.Provider)
				for table, snapshot := range before {
					before[table] = workStatusTestRows(t, db, table, snapshot.columns)
				}

				expectedIDs := map[string]string{}
				rows, err := db.Query("SELECT title FROM work_items ORDER BY created_at,id")
				if err != nil {
					t.Fatal(err)
				}
				ordinal := int64(0)
				for rows.Next() {
					var title string
					if err = rows.Scan(&title); err != nil {
						rows.Close()
						t.Fatal(err)
					}
					ordinal++
					encoded := strconv.FormatInt(ordinal, 36)
					expectedIDs[title] = strings.Repeat("0", 5-len(encoded)) + encoded
				}
				if err = rows.Err(); err != nil {
					rows.Close()
					t.Fatal(err)
				}
				rows.Close()
				cardOrder := func() []string {
					t.Helper()
					rows, err := db.Query("SELECT title FROM work_items ORDER BY space_id,archived,status,sort_order,id")
					if err != nil {
						t.Fatal(err)
					}
					defer rows.Close()
					order := []string{}
					for rows.Next() {
						var title string
						if err = rows.Scan(&title); err != nil {
							t.Fatal(err)
						}
						order = append(order, title)
					}
					if err = rows.Err(); err != nil {
						t.Fatal(err)
					}
					return order
				}
				expectedOrder := cardOrder()
				err = store.migrate(context.Background())
				if rollback {
					if err == nil || !strings.Contains(err.Error(), "intentional short identifier migration failure") {
						t.Fatalf("did not reach the injected migration failure: %v", err)
					}
					after := sessionUpgradeDatabaseState(t, db, store.Provider)
					if len(before) != len(after) {
						t.Fatal("rollback retained new tables")
					}
					for table, snapshot := range before {
						if !reflect.DeepEqual(snapshot, workStatusTestRows(t, db, table, snapshot.columns)) {
							t.Fatalf("rollback changed %s", table)
						}
					}
					if _, err = db.Exec("SELECT 1 FROM work_item_id_map"); err == nil {
						t.Fatal("legacy identity map survived rollback")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				readString := func(query string, args ...any) string {
					t.Helper()
					var value string
					if err := db.QueryRow(store.Query(query), args...).Scan(&value); err != nil {
						t.Fatal(err)
					}
					return value
				}
				readJSON := func(query string) map[string]any {
					t.Helper()
					var value map[string]any
					if err := json.Unmarshal([]byte(readString(query)), &value); err != nil {
						t.Fatal(err)
					}
					return value
				}
				var total, distinct, next int
				if err := db.QueryRow("SELECT COUNT(*),COUNT(DISTINCT id) FROM work_items").Scan(&total, &distinct); err != nil || total != 40 || distinct != 40 {
					t.Fatal("lost or duplicated cards", total, distinct, err)
				}
				for n := 1; n <= 40; n++ {
					expected := expectedIDs["Card "+strconv.Itoa(n)]
					if got := readString("SELECT id FROM work_items WHERE title=?", "Card "+strconv.Itoa(n)); got != expected {
						t.Fatalf("unstable identifier %s want %s", got, expected)
					}
				}
				if actual := cardOrder(); !reflect.DeepEqual(actual, expectedOrder) {
					t.Fatal("identifier migration reordered cards", expectedOrder, actual)
				}
				for _, ref := range []struct{ table, column string }{
					{"work_item_links", "item_id"}, {"work_item_documents", "item_id"}, {"work_activity", "item_id"},
					{"work_claims", "item_id"}, {"work_collaboration_events", "item_id"}, {"work_schedule_occurrences", "item_id"},
					{"work_item_labels", "item_id"}, {"work_dependencies", "item_id"}, {"work_metric_intervals", "item_id"},
					{"work_automation_events", "source_item_id"}, {"work_automation_receipts", "item_id"},
				} {
					if got := readString("SELECT " + ref.column + " FROM " + ref.table); got != "00001" {
						t.Fatalf("lost relationship %s.%s: %s", ref.table, ref.column, got)
					}
				}
				for _, query := range []string{
					"SELECT blocked_by_id FROM work_dependencies",
					"SELECT parent_id FROM work_items WHERE id='00001'",
					"SELECT predecessor_id FROM work_items WHERE id='00001'",
					"SELECT item_id FROM work_notices",
					"SELECT item_id FROM work_executions WHERE id='sent-execution'",
				} {
					if got := readString(query); got != "00003" {
						t.Fatal("unmigrated relation", query, got)
					}
				}
				if got := readString("SELECT item_id FROM work_executions WHERE id='queued-execution'"); got != "00001" {
					t.Fatal("queued execution lost its card", got)
				}
				var changes []map[string]any
				if err = json.Unmarshal([]byte(readString("SELECT changes_json FROM work_activity")), &changes); err != nil {
					t.Fatal(err)
				}
				relation := changes[0]["after"].(map[string]any)
				if relation["parentId"] != "00003" || relation["predecessorId"] != "00003" || relation["blockedByIds"].([]any)[0] != "00003" {
					t.Fatal("activity relations retained legacy IDs", relation)
				}
				if changes[1]["before"].(map[string]any)["id"] != fmt.Sprintf("%032x", 3) {
					t.Fatal("migration rewrote an unrelated historical identity")
				}
				for n, expected := range []string{"00001", "00002"} {
					v := readJSON(fmt.Sprintf("SELECT definition_json FROM work_views WHERE id='view-%d'", n))
					filters := v["filters"].(map[string]any)
					if filters["itemId"] != expected || filters["q"] != fmt.Sprintf("%032x", 3) || !reflect.DeepEqual(v["fields"], []any{"id", "priority"}) {
						t.Fatal("saved view fields or space-local W reference diverged", v)
					}
					if n == 0 && filters["parentId"] != "00003" {
						t.Fatal("saved parent filter not migrated")
					}
				}
				card := readJSON("SELECT response_json FROM work_operation_receipts WHERE operation_id='card-receipt'")
				event := readJSON("SELECT response_json FROM work_operation_receipts WHERE operation_id='event-receipt'")
				if card["id"] != "00001" || event["itemId"] != "00003" || event["id"] != fmt.Sprintf("%032x", 1) {
					t.Fatal("receipt shape migration diverged", card, event)
				}
				queued := readJSON("SELECT snapshot_json FROM work_executions WHERE id='queued-execution'")
				item := queued["item"].(map[string]any)
				if item["id"] != "00001" || item["key"] != nil || item["title"] != fmt.Sprintf("%032x", 3) {
					t.Fatal("queued projection changed unrelated content", queued)
				}
				if got := readString("SELECT snapshot_json FROM work_executions WHERE id='sent-execution'"); got != " { \"id\" : \"sent-execution\", \"item\" : { \"id\" : \""+fmt.Sprintf("%032x", 3)+"\", \"key\" : \"W-2\" } } " {
					t.Fatal("already sent projection was rewritten")
				}
				for _, table := range []string{"users", "sessions", "spaces", "links", "documents", "document_sources", "document_activity", "work_sessions", "work_schedules", "work_labels", "work_automation_rules", "work_executors"} {
					snapshot := before[table]
					if !reflect.DeepEqual(snapshot, workStatusTestRows(t, db, table, snapshot.columns)) {
						t.Fatalf("unrelated state changed in %s", table)
					}
				}
				if got := readString("SELECT request_hash FROM work_operation_receipts WHERE operation_id='card-receipt'"); got != "retained-card-hash" {
					t.Fatal("rewrote an opaque operation hash")
				}
				if got := readString("SELECT body FROM work_collaboration_events"); got != fmt.Sprintf("%032x", 3) {
					t.Fatal("rewrote free-form evidence")
				}
				if got := readString("SELECT description FROM work_items WHERE id='00001'"); got != fmt.Sprintf("%032x", 3) {
					t.Fatal("rewrote card text")
				}
				if got := readString("SELECT subject_id FROM work_notices"); got != "sent-execution" {
					t.Fatal("rewrote a non-card notification subject")
				}
				if err = db.QueryRow("SELECT next_number FROM work_item_sequence WHERE id=1").Scan(&next); err != nil || next != 41 {
					t.Fatal("incorrect global next number", next, err)
				}
				if _, err = db.Exec("SELECT number FROM work_items"); err == nil {
					t.Fatal("obsolete per-space number column survived")
				}
				if _, err = db.Exec("SELECT next_number FROM work_spaces"); err == nil {
					t.Fatal("obsolete per-space counter survived")
				}
				if _, err = db.Exec("SELECT 1 FROM work_item_id_map"); err == nil {
					t.Fatal("legacy identity lookup survived")
				}
				if _, err = db.Exec("INSERT INTO work_item_links(item_id,link_id) VALUES('absent','old-link')"); err == nil {
					t.Fatal("foreign-key enforcement was disabled")
				}
				if !postgres {
					rows, err := db.Query("PRAGMA foreign_key_check")
					if err != nil {
						t.Fatal(err)
					}
					if rows.Next() {
						rows.Close()
						t.Fatal("migration left a dangling foreign key")
					}
					if err = rows.Err(); err != nil {
						rows.Close()
						t.Fatal(err)
					}
					rows.Close()
				} else {
					var deferred int
					if err = db.QueryRow("SELECT COUNT(*) FROM pg_constraint WHERE conrelid IN (SELECT oid FROM pg_class WHERE relnamespace=current_schema()::regnamespace) AND contype='f' AND condeferrable").Scan(&deferred); err != nil || deferred != 0 {
						t.Fatal("migration left foreign keys deferred", deferred, err)
					}
				}
				// Counter and create receipt scope are transactional, not a MAX(id)+1 lookup.
				tx, err := db.Begin()
				if err != nil {
					t.Fatal(err)
				}
				if err = tx.QueryRow("UPDATE work_item_sequence SET next_number=next_number+1 WHERE id=1 RETURNING next_number-1").Scan(&next); err != nil || next != 41 {
					tx.Rollback()
					t.Fatal("counter allocation failed", next, err)
				}
				if err = tx.Rollback(); err != nil {
					t.Fatal(err)
				}
				if err = db.QueryRow("SELECT next_number FROM work_item_sequence WHERE id=1").Scan(&next); err != nil || next != 41 {
					t.Fatal("rolled-back allocation consumed state", next, err)
				}
				exec("UPDATE work_items SET create_user_id='old-owner',create_request_id='request-one' WHERE id='00001'")
				if _, err = db.Exec("UPDATE work_items SET create_user_id='old-owner',create_request_id='request-one' WHERE id='00003'"); err == nil {
					t.Fatal("duplicate principal/space request accepted")
				}
				exec("UPDATE work_items SET create_user_id='old-owner',create_request_id='request-one' WHERE id='00002'")
				exec("UPDATE work_items SET create_user_id='another-user',create_request_id='request-one' WHERE id='00003'")
				complete := sessionUpgradeDatabaseState(t, db, store.Provider)
				if err = store.migrate(context.Background()); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(complete, sessionUpgradeDatabaseState(t, db, store.Provider)) {
					t.Fatal("repeat startup reassigned identifiers or changed records")
				}
			})
		}
	}
}
