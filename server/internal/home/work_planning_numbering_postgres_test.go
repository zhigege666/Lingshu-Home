package home

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// Upgrade a real 020 schema, including tied creation times and several spaces.
// EXPLAIN does not execute the former quadratic query; only the current full
// production migration chain executes against the ten thousand legacy items.
func TestWorkPlanningPostgresNumberingScale(t *testing.T) {
	db, store := documentMigrationDB(t, true)
	seedSessionUpgrade(t, db, store, 9, false, nil)
	exec := func(statement string, args ...any) {
		t.Helper()
		if _, err := db.Exec(store.Query(statement), args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO users(id,username,normalized_username,display_name,role,is_enabled,password_hash,version,created_at) VALUES('empty-owner','empty','empty','Empty','Member',TRUE,'retained-hash',1,'2025-01-01T00:00:00Z')")
	exec("INSERT INTO spaces(id,name,kind,owner_user_id,published,data_revision,updated_at) VALUES('old-personal','Personal','personal','old-owner',FALSE,5,'2025-01-01T00:00:00Z'),('old-empty','Empty','personal','empty-owner',FALSE,7,'2025-01-01T00:00:00Z')")
	entries, err := migrationFiles.ReadDir("migrations/postgres")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if name <= "009_document_activity.sql" || name >= "021_work_planning.sql" || !strings.HasSuffix(name, ".sql") {
			continue
		}
		body, err := migrationFiles.ReadFile("migrations/postgres/" + name)
		if err != nil {
			t.Fatal(err)
		}
		exec(string(body))
		sum := sha256.Sum256(body)
		exec("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)", name, hex.EncodeToString(sum[:]), "2026-01-01T00:00:00Z")
	}
	exec(`INSERT INTO work_items(id,space_id,title,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash)
 SELECT lpad(to_hex(i),32,'0'),CASE WHEN i%2=0 THEN 'old-space' ELSE 'old-personal' END,
 'Preserve legacy item '||i,'todo',i%5=0,i%3=0,10000-i,7,
 '2025-01-'||lpad((1+(i/1000)%20)::text,2,'0')||'T00:00:00Z','2025-02-01T00:00:00Z','legacy-hash-'||i
 FROM generate_series(1,10000) AS i ORDER BY i DESC`)
	columns := sessionMigrationColumns(t, db, "work_items")
	for i, column := range columns {
		columns[i] = fmt.Sprintf("%q", column)
	}
	checksumQuery := "SELECT md5(string_agg(row_to_json(original)::text,'' ORDER BY original.id)) FROM (SELECT " + strings.Join(columns, ",") + " FROM work_items) original"
	var before string
	if err = db.QueryRow(checksumQuery).Scan(&before); err != nil {
		t.Fatal(err)
	}
	expected := map[string]int64{}
	spaceCounts := map[string]int64{}
	rows, err := db.Query("SELECT id,space_id FROM work_items ORDER BY space_id,created_at,id")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id, space string
		if err = rows.Scan(&id, &space); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		spaceCounts[space]++
		expected[id] = spaceCounts[space]
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(expected) != 10000 {
		t.Fatal("invalid legacy fixture", len(expected), err)
	}
	exec("ANALYZE work_items")
	migration, err := migrationFiles.ReadFile("migrations/postgres/021_work_planning.sql")
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(migration), "WITH numbered AS")
	if start < 0 {
		t.Fatal("missing migration numbering operation")
	}
	end := strings.Index(string(migration)[start:], ";")
	if end < 0 {
		t.Fatal("unterminated migration numbering operation")
	}
	numbering := string(migration)[start : start+end+1]
	old := "WITH numbered AS (SELECT id,ROW_NUMBER() OVER(PARTITION BY space_id ORDER BY created_at,id) AS n FROM work_items) UPDATE work_items SET number=(SELECT n FROM numbered WHERE numbered.id=work_items.id)"
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.Exec("ALTER TABLE work_items ADD COLUMN number BIGINT NOT NULL DEFAULT 0"); err != nil {
		t.Fatal(err)
	}
	for _, query := range []struct{ name, sql string }{{"previous", old}, {"current", numbering}} {
		var raw []byte
		if err = tx.QueryRow("EXPLAIN(FORMAT JSON) " + query.sql).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var plan []struct {
			Plan map[string]any `json:"Plan"`
		}
		if err = json.Unmarshal(raw, &plan); err != nil || len(plan) != 1 {
			t.Fatal("invalid plan", err)
		}
		t.Logf("numbering_%s_plan=%s", query.name, raw)
		if query.name == "current" {
			windows := 0
			var visit func(map[string]any, bool)
			visit = func(node map[string]any, inSubPlan bool) {
				inSubPlan = inSubPlan || node["Parent Relationship"] == "SubPlan"
				if node["Node Type"] == "WindowAgg" {
					windows++
					if inSubPlan {
						t.Fatal("numbering repeats a window inside a per-row subplan")
					}
				}
				children, _ := node["Plans"].([]any)
				for _, child := range children {
					visit(child.(map[string]any), inSubPlan)
				}
			}
			visit(plan[0].Plan, false)
			if windows != 1 {
				t.Fatalf("numbering plan has %d window computations, want one", windows)
			}
		}
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	started := time.Now()
	if err = store.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(started)
	var after string
	if err = db.QueryRow(checksumQuery).Scan(&after); err != nil || after != before {
		t.Fatal("migration changed legacy work fields", err)
	}
	rows, err = db.Query("SELECT id,number FROM work_items")
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	for rows.Next() {
		var id string
		var number int64
		if err = rows.Scan(&id, &number); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		if number != expected[id] || number < 1 {
			rows.Close()
			t.Fatalf("unstable numbering for %s: got %d want %d", id, number, expected[id])
		}
		seen++
	}
	err = rows.Err()
	rows.Close()
	if err != nil || seen != 10000 {
		t.Fatal("numbering lost records", seen, err)
	}
	for space, count := range map[string]int64{"old-space": 5000, "old-personal": 5000, "old-empty": 0} {
		var next int64
		if err = db.QueryRow(store.Query("SELECT next_number FROM work_spaces WHERE space_id=?"), space).Scan(&next); err != nil || next != count+1 {
			t.Fatal("next number diverged", space, next, err)
		}
	}
	t.Logf("numbering_upgrade rows=%d populated_spaces=2 empty_spaces=1 elapsed_ms=%.3f all_legacy_fields_preserved=true deterministic_numbers=true", seen, float64(elapsed)/float64(time.Millisecond))
}
