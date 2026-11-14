package home

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"
	"time"
)

type workMeasuredQueries struct {
	Queryer
	Count int
}

func (q *workMeasuredQueries) QueryContext(c context.Context, s string, args ...any) (*sql.Rows, error) {
	q.Count++
	return q.Queryer.QueryContext(c, s, args...)
}
func (q *workMeasuredQueries) QueryRowContext(c context.Context, s string, args ...any) *sql.Row {
	q.Count++
	return q.Queryer.QueryRowContext(c, s, args...)
}
func workPercentiles(samples []float64) map[string]float64 {
	sort.Float64s(samples)
	return map[string]float64{"p50Ms": samples[len(samples)/2], "p95Ms": samples[(len(samples)*95-1)/100]}
}

// The warmed handler has six fixed reads: space access, board revision,
// grouped item counts, catalog revision, catalog rows and collaboration revision.
// Each status adds its item page and page collaboration revision, plus at most
// one batched claim/session join for a nonempty page. The budget therefore grows
// with status count, never with the number of returned cards. Empty columns and
// future query consolidation may use fewer calls. Authentication and setup are
// measured separately by the opt-in HTTP latency samples.
func workBoardQueryBudget(statusCount int) int {
	return 6 + 3*statusCount
}

// Small deterministic regression coverage for the query contract. This is not
// a replacement for the opt-in 100/1,000/10,000-item latency measurements.
func TestWorkBoardQueryBudget(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := newWorkStatusFixture(t, provider)
			catalog := workStatusTestCatalog(t, f.owner.ok("GET", f.base+"/statuses", nil))
			settings, err := f.app.loadSettings(context.Background(), f.app.store.DB)
			if err != nil {
				t.Fatal(err)
			}
			boot := f.owner.bootstrap()
			user, err := f.app.loadUser(context.Background(), f.app.store.DB, boot["user"].(map[string]any)["id"].(string))
			if err != nil {
				t.Fatal(err)
			}
			seed := func(statuses []WorkStatusDefinition, from, to int) {
				t.Helper()
				tx, err := f.app.store.DB.Begin()
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback()
				stamp := workStamp()
				for _, status := range statuses {
					for i := from; i < to; i++ {
						_, err = tx.Exec(f.app.store.Query("INSERT INTO work_items(id,space_id,title,description,next_step,result,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?)"), newID(), f.space, fmt.Sprintf("Query budget item %d", i), "", "", "", status.ID, false, false, int64(i+1)*workRankStep, stamp, stamp, "query-budget-fixture")
						if err != nil {
							t.Fatal(err)
						}
					}
				}
				if err = tx.Commit(); err != nil {
					t.Fatal(err)
				}
			}
			measure := func(enabled bool, wantStatuses, wantItems int) int {
				t.Helper()
				f.app.config.MCPCollaborationEnabled = enabled
				counted := &workMeasuredQueries{Queryer: f.app.store.DB}
				request := &Request{App: f.app, HTTP: httptest.NewRequest("GET", "http://fixture/work", nil), Q: counted, Settings: settings, User: user, Params: map[string]string{"spaceId": f.space}}
				response, err := f.app.getWorkBoard(request)
				if err != nil {
					t.Fatal(err)
				}
				board := response.Data.(map[string]any)
				statusCount := len(board["statuses"].([]WorkStatusDefinition))
				items := 0
				for _, column := range board["columns"].([]workColumn) {
					items += len(column.Items)
				}
				if statusCount != wantStatuses || items != wantItems {
					t.Fatalf("fixture response has %d statuses/%d cards; want %d/%d", statusCount, items, wantStatuses, wantItems)
				}
				budget := workBoardQueryBudget(statusCount)
				if counted.Count > budget {
					t.Fatalf("board SQL calls=%d exceed budget=%d with collaboration=%v and %d cards", counted.Count, budget, enabled, items)
				}
				t.Logf("collaboration=%v statuses=%d cards=%d SQL calls=%d upper bound=%d", enabled, statusCount, items, counted.Count, budget)
				return counted.Count
			}
			seed(catalog.Items, 0, 1)
			initialCounts := map[bool]int{}
			for _, enabled := range []bool{false, true} {
				initialCounts[enabled] = measure(enabled, len(catalog.Items), len(catalog.Items))
			}
			seed(catalog.Items, 1, 4)
			for _, enabled := range []bool{false, true} {
				if count := measure(enabled, len(catalog.Items), 4*len(catalog.Items)); count > initialCounts[enabled] {
					t.Fatalf("board query count grew with cards: %d to %d", initialCounts[enabled], count)
				}
			}
			// A dynamic fifth column may add its own bounded page work; avoid
			// a fixed four-column assumption in this regression assertion.
			extraID := newID()
			updated := workStatusTestCatalog(t, f.owner.ok("POST", f.base+"/statuses/batch-edit", map[string]any{"expectedRevision": catalog.Revision, "create": []map[string]any{{"id": extraID, "name": "Query budget review", "type": "waiting"}}}))
			seed([]WorkStatusDefinition{{ID: extraID}}, 0, 1)
			for _, enabled := range []bool{false, true} {
				measure(enabled, len(updated.Items), 4*len(catalog.Items)+1)
			}
		})
	}
}

func TestWorkPerformance(t *testing.T) {
	if os.Getenv("LINGSHU_WORK_PERFORMANCE") != "1" {
		t.Skip("opt-in reproducible work performance sample")
	}
	results := []map[string]any{}
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			for _, size := range []int{100, 1000, 10000} {
				t.Run(fmt.Sprint(size), func(t *testing.T) {
					app, server := newAccountProfileHTTPFixture(t, provider)
					owner := newCoreBrowser(t, server.URL)
					owner.bootstrap()
					owner.ok("POST", "/setup", map[string]any{"siteName": "Work performance", "mode": ModePrivateMulti, "username": "owner", "password": "work performance fixture password", "seedDemo": false})
					boot := owner.bootstrap()
					space := coreSpace(boot, "shared")
					base := "/spaces/" + space + "/work"
					stamp := workStamp()
					tx, err := app.store.DB.Begin()
					if err != nil {
						t.Fatal(err)
					}
					for i := 0; i < size; i++ {
						_, err = tx.Exec(app.store.Query("INSERT INTO work_items(id,space_id,title,description,next_step,result,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?)"), fmt.Sprintf("%032x", i+1), space, fmt.Sprintf("Fixture item %05d", i), strings.Repeat("Description ", 30), "Continue from the linked evidence", strings.Repeat("Result ", 20), workStatuses[i%4], i%11 == 0, false, int64(i/4+1)*workRankStep, stamp, stamp, "performance-fixture")
						if err != nil {
							tx.Rollback()
							t.Fatal(err)
						}
					}
					if err = tx.Commit(); err != nil {
						t.Fatal(err)
					}
					if _, err = app.store.DB.Exec("ANALYZE work_items"); err != nil {
						t.Fatal(err)
					}
					owner.ok("GET", base+"/board", nil)
					metrics := map[string]any{"provider": provider, "items": size, "samples": 25}
					for _, kind := range []string{"board", "filtered", "list"} {
						path := base + "/board"
						if kind == "filtered" {
							path += "?q=Fixture&attention=true"
						}
						if kind == "list" {
							path = base + "/items?limit=30"
						}
						samples := []float64{}
						var response map[string]any
						for i := 0; i < 25; i++ {
							start := time.Now()
							response = owner.ok("GET", path, nil)
							samples = append(samples, float64(time.Since(start).Microseconds())/1000)
						}
						stats := map[string]any{}
						for k, v := range workPercentiles(samples) {
							stats[k] = v
						}
						bytes, _ := json.Marshal(response)
						stats["responseBytes"] = len(bytes)
						metrics[kind] = stats
					}
					item := owner.ok("GET", workItemPath(space, fmt.Sprintf("%032x", 1)), nil)
					samples := []float64{}
					for i := 0; i < 25; i++ {
						start := time.Now()
						item = owner.ok("POST", workItemPath(space, item["id"].(string))+"/move", map[string]any{"expectedRevision": item["revision"], "expectedBoardRevision": item["boardRevision"], "status": workStatuses[(i+1)%4], "beforeId": nil})
						samples = append(samples, float64(time.Since(start).Microseconds())/1000)
					}
					metrics["move"] = workPercentiles(samples)
					// Count application SQL calls, not estimated ORM behavior.
					settings, err := app.loadSettings(context.Background(), app.store.DB)
					if err != nil {
						t.Fatal(err)
					}
					userID := boot["user"].(map[string]any)["id"].(string)
					user, err := app.loadUser(context.Background(), app.store.DB, userID)
					if err != nil {
						t.Fatal(err)
					}
					counted := &workMeasuredQueries{Queryer: app.store.DB}
					request := &Request{App: app, HTTP: httptest.NewRequest("GET", "http://fixture/work", nil), Q: counted, Settings: settings, User: user, Params: map[string]string{"spaceId": space}}
					board, err := app.getWorkBoard(request)
					if err != nil {
						t.Fatal(err)
					}
					statusCount := len(board.Data.(map[string]any)["statuses"].([]WorkStatusDefinition))
					queryBudget := workBoardQueryBudget(statusCount)
					metrics["boardHandlerSQLCalls"] = counted.Count
					metrics["boardHandlerSQLCallUpperBound"] = queryBudget
					metrics["statusCount"] = statusCount
					if counted.Count > queryBudget {
						t.Fatalf("board SQL calls=%d exceed status-bounded budget=%d for %d statuses and %d items", counted.Count, queryBudget, statusCount, size)
					}
					statement := app.store.Query("SELECT id FROM work_items WHERE space_id=? AND archived=? AND status=? ORDER BY sort_order,id LIMIT 31")
					plan := []string{}
					if provider == "sqlite" {
						rows, err := app.store.DB.Query("EXPLAIN QUERY PLAN "+statement, space, false, "todo")
						if err != nil {
							t.Fatal(err)
						}
						for rows.Next() {
							var a, b, c int
							var detail string
							if err = rows.Scan(&a, &b, &c, &detail); err != nil {
								rows.Close()
								t.Fatal(err)
							}
							plan = append(plan, detail)
						}
						err = rows.Err()
						rows.Close()
						if err != nil {
							t.Fatal(err)
						}
					} else {
						rows, err := app.store.DB.Query("EXPLAIN "+statement, space, false, "todo")
						if err != nil {
							t.Fatal(err)
						}
						for rows.Next() {
							var detail string
							if err = rows.Scan(&detail); err != nil {
								rows.Close()
								t.Fatal(err)
							}
							plan = append(plan, detail)
						}
						err = rows.Err()
						rows.Close()
						if err != nil {
							t.Fatal(err)
						}
					}
					metrics["columnQueryPlan"] = plan
					if size >= 1000 && !strings.Contains(strings.Join(plan, " "), "work_items_column") {
						t.Fatal("large column query did not use its ordering index", plan)
					}
					results = append(results, metrics)
					encoded, _ := json.Marshal(metrics)
					t.Log(string(encoded))
				})
			}
		})
	}
	if file := os.Getenv("LINGSHU_WORK_PERFORMANCE_OUTPUT"); file != "" {
		encoded, err := json.MarshalIndent(map[string]any{"method": "25 sequential HTTP samples after warmup; disposable local fixtures, no concurrent load; durations include local HTTP and authorization; no cross-version claim", "results": results}, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(file, encoded, 0644); err != nil {
			t.Fatal(err)
		}
	}
}
