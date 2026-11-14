//go:build linux

package home

import "testing"

// Bulk data preparation only: reproduce migration 021 numbering outside every
// measurement window. The published v0.2.7 fixture has no number column. This
// prevents synthetic number=0 rows from understating JSON size or colliding
// with later ordinary HTTP creates in the candidate.
func workPerformanceFinalizeV028Fixture(t *testing.T, app *App, provider, space string) {
	t.Helper()
	query := "SELECT COUNT(*) FROM pragma_table_info('work_items') WHERE name='number'"
	if provider == "postgres" {
		query = "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='work_items' AND column_name='number'"
	}
	var columns int
	if err := app.store.DB.QueryRow(query).Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if columns == 0 {
		return
	}
	if columns != 1 {
		t.Fatalf("unexpected number-column metadata count %d", columns)
	}
	statement := "WITH numbered AS (SELECT id,ROW_NUMBER() OVER(ORDER BY created_at,id) AS n FROM work_items WHERE space_id=?) UPDATE work_items SET number=(SELECT n FROM numbered WHERE numbered.id=work_items.id) WHERE space_id=?"
	if provider == "postgres" {
		statement = "WITH numbered AS (SELECT id,ROW_NUMBER() OVER(ORDER BY created_at,id) AS n FROM work_items WHERE space_id=?) UPDATE work_items AS w SET number=numbered.n FROM numbered WHERE w.id=numbered.id AND w.space_id=?"
	}
	if _, err := app.store.DB.Exec(app.store.Query(statement), space, space); err != nil {
		t.Fatal(err)
	}
	result, err := app.store.DB.Exec(app.store.Query("UPDATE work_spaces SET next_number=1+COALESCE((SELECT MAX(number) FROM work_items WHERE work_items.space_id=work_spaces.space_id),0) WHERE space_id=?"), space)
	if err != nil {
		t.Fatal(err)
	}
	count, err := result.RowsAffected()
	if err != nil || count != 1 {
		t.Fatalf("fixture counter not advanced: rows=%d err=%v", count, err)
	}
}
