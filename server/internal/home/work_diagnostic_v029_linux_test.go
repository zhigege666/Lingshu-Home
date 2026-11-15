//go:build linux

package home

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"strings"
	"testing"
	"time"
)

// Optional profiles cover only warmed request phases. Setup, migration,
// fixture seeding, and profile flushing are outside the reported phase.
// CPU/allocations include the in-process HTTP load client, not PostgreSQL.
func workDiagnosticWindowV029(t *testing.T, app *App, label string) func() map[string]any {
	t.Helper()
	directory := os.Getenv("LINGSHU_WORK_DIAGNOSTIC_PROFILE_DIR")
	selected := os.Getenv("LINGSHU_WORK_DIAGNOSTIC_PROFILE_PHASE")
	profiled := directory != "" && (selected == "" || selected == label)
	var cpuFile *os.File
	writeAlloc := func(suffix string) {
		t.Helper()
		file, err := os.OpenFile(filepath.Join(directory, label+"-"+suffix+".allocs.pprof"), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		if err = pprof.Lookup("allocs").WriteTo(file, 0); err != nil {
			file.Close()
			t.Fatal(err)
		}
		if err = file.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if profiled {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
		// Forced GC belongs only to diagnostic profiles, never normal latency
		// comparisons. It makes the two cumulative allocation profiles useful.
		runtime.GC()
		writeAlloc("before")
		var err error
		cpuFile, err = os.OpenFile(filepath.Join(directory, label+".cpu.pprof"), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		if err = pprof.StartCPUProfile(cpuFile); err != nil {
			cpuFile.Close()
			t.Fatal(err)
		}
	}
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	dbBefore := app.store.DB.Stats()
	cpuBefore, rssBefore := schedulePerfCPU(t), schedulePerfRSS(t)
	started := time.Now()
	return func() map[string]any {
		elapsed := time.Since(started).Seconds()
		cpuAfter, rssAfter := schedulePerfCPU(t), schedulePerfRSS(t)
		dbAfter := app.store.DB.Stats()
		var after runtime.MemStats
		runtime.ReadMemStats(&after)
		result := map[string]any{
			"profileEnabled": profiled, "measuredPhaseSeconds": elapsed,
			"measuredPhaseCPUSeconds":   cpuAfter - cpuBefore,
			"measuredPhaseRSSBeforeKiB": rssBefore, "measuredPhaseRSSAfterKiB": rssAfter,
			"allocatedBytes":           after.TotalAlloc - before.TotalAlloc,
			"allocationCount":          after.Mallocs - before.Mallocs,
			"freedAllocationCount":     after.Frees - before.Frees,
			"gcCycles":                 after.NumGC - before.NumGC,
			"gcPauseNanoseconds":       after.PauseTotalNs - before.PauseTotalNs,
			"heapAllocatedBytesBefore": before.HeapAlloc, "heapAllocatedBytesAfter": after.HeapAlloc,
			"dbWaitCount":             dbAfter.WaitCount - dbBefore.WaitCount,
			"dbWaitNanoseconds":       (dbAfter.WaitDuration - dbBefore.WaitDuration).Nanoseconds(),
			"dbMaxOpenConnections":    dbAfter.MaxOpenConnections,
			"dbOpenConnectionsBefore": dbBefore.OpenConnections, "dbOpenConnectionsAfter": dbAfter.OpenConnections,
			"dbInUseBefore": dbBefore.InUse, "dbInUseAfter": dbAfter.InUse,
		}
		if profiled {
			pprof.StopCPUProfile()
			if err := cpuFile.Close(); err != nil {
				t.Fatal(err)
			}
			runtime.GC()
			writeAlloc("after")
		}
		return result
	}
}

func workDiagnosticMergeV029(row, metrics map[string]any, requests int) {
	for key, value := range metrics {
		row[key] = value
	}
	if requests > 0 {
		row["allocatedBytesPerRequest"] = float64(metrics["allocatedBytes"].(uint64)) / float64(requests)
		row["allocationsPerRequest"] = float64(metrics["allocationCount"].(uint64)) / float64(requests)
	}
}

// Count one isolated handler call, not the surrounding HTTP authentication or
// transaction entry. SQL text has placeholders; parameter values are not kept.
type workDiagnosticQueriesV029 struct {
	Queryer
	reads, writes int
	statements    map[string]int
}

func (q *workDiagnosticQueriesV029) record(statement string) {
	if q.statements == nil {
		q.statements = map[string]int{}
	}
	q.statements[strings.Join(strings.Fields(statement), " ")]++
}
func (q *workDiagnosticQueriesV029) QueryContext(ctx context.Context, statement string, args ...any) (*sql.Rows, error) {
	q.reads++
	q.record(statement)
	return q.Queryer.QueryContext(ctx, statement, args...)
}
func (q *workDiagnosticQueriesV029) QueryRowContext(ctx context.Context, statement string, args ...any) *sql.Row {
	q.reads++
	q.record(statement)
	return q.Queryer.QueryRowContext(ctx, statement, args...)
}
func (q *workDiagnosticQueriesV029) ExecContext(ctx context.Context, statement string, args ...any) (sql.Result, error) {
	q.writes++
	q.record(statement)
	return q.Queryer.ExecContext(ctx, statement, args...)
}
func (q *workDiagnosticQueriesV029) result() map[string]any {
	return map[string]any{"reads": q.reads, "writes": q.writes, "calls": q.reads + q.writes, "statements": q.statements,
		"scope": "one direct handler with existing settings/user, excluding HTTP authentication and transaction entry"}
}
func workDiagnosticIdentityV029(t *testing.T, app *App, boot map[string]any) (Settings, *User) {
	t.Helper()
	settings, err := app.loadSettings(context.Background(), app.store.DB)
	if err != nil {
		t.Fatal(err)
	}
	user, err := app.loadUser(context.Background(), app.store.DB, boot["user"].(map[string]any)["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	return settings, user
}
func workDiagnosticBoardSQLV029(t *testing.T, app *App, boot map[string]any, space string) map[string]any {
	t.Helper()
	settings, user := workDiagnosticIdentityV029(t, app, boot)
	counted := &workDiagnosticQueriesV029{Queryer: app.store.DB}
	r := &Request{App: app, HTTP: httptest.NewRequest("GET", "http://fixture/work", nil), Q: counted, Settings: settings, User: user, Params: map[string]string{"spaceId": space}}
	reply, err := app.getWorkBoard(r)
	if err != nil {
		t.Fatal(err)
	}
	board := reply.Data.(map[string]any)
	cards := 0
	for _, column := range board["columns"].([]workColumn) {
		cards += len(column.Items)
	}
	statuses := len(board["statuses"].([]WorkStatusDefinition))
	if cards != 120 || statuses != 4 {
		t.Fatalf("diagnostic board fixture: %d cards, %d statuses", cards, statuses)
	}
	result := counted.result()
	result["cards"], result["statuses"] = cards, statuses
	return result
}

// Two real handler transitions occur in one rolled-back transaction. This
// leaves the measured HTTP fixture at todo/revision 1 with no extra intervals.
func workDiagnosticStatusSQLV029(t *testing.T, app *App, boot map[string]any, space, id string) []map[string]any {
	t.Helper()
	settings, user := workDiagnosticIdentityV029(t, app, boot)
	tx, err := app.store.DB.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	rows := []map[string]any{}
	for phase, status := range []string{"doing", "done"} {
		body, err := json.Marshal(map[string]string{"expectedRevision": fmt.Sprint(phase + 1), "status": status})
		if err != nil {
			t.Fatal(err)
		}
		counted := &workDiagnosticQueriesV029{Queryer: tx}
		r := &Request{App: app, HTTP: httptest.NewRequest("PATCH", "http://fixture/work", bytes.NewReader(body)), Q: counted, Settings: settings, User: user, Params: map[string]string{"spaceId": space, "id": id}, Input: body}
		if _, err = app.updateWorkItem(r); err != nil {
			t.Fatal(err)
		}
		row := counted.result()
		row["targetStatus"] = status
		row["rolledBackAfterProbe"] = true
		rows = append(rows, row)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	return rows
}
