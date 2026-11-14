//go:build linux

package home

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// This opt-in harness uses only fresh SQLite directories and unique PostgreSQL
// schemas. The scheduler's production transaction path runs with concurrent
// loopback reads. CPU/RSS include the Go test's HTTP clients, not the PG server.
func TestWorkSchedulePerformance(t *testing.T) {
	if os.Getenv("LINGSHU_WORK_SCHEDULE_PERFORMANCE") != "1" {
		t.Skip("opt-in isolated schedule load measurements")
	}
	results := []map[string]any{}
	for _, provider := range []string{"sqlite", "postgres"} {
		for _, size := range []int{100, 1000} {
			t.Run(fmt.Sprintf("%s/%d", provider, size), func(t *testing.T) {
				app, server := newAccountProfileHTTPFixture(t, provider)
				owner := newCoreBrowser(t, server.URL)
				owner.bootstrap()
				owner.ok("POST", "/setup", map[string]any{"siteName": "Schedule performance fixture", "mode": ModePrivateMulti, "username": "owner", "password": "isolated schedule fixture password", "seedDemo": false})
				space := coreSpace(owner.bootstrap(), "shared")
				base := "/spaces/" + space + "/work"
				// Stop autonomous workers without closing the fixture store/lease.
				// This gives the production helper a deterministic controlled clock.
				app.cancel()
				app.workers.Wait()
				ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
				defer cancel()
				ids, next, err := app.workScheduleDue(ctx)
				if err != nil || len(ids) != 0 || !next.IsZero() {
					t.Fatalf("zero-rule idle plan: ids=%d next=%s err=%v", len(ids), next, err)
				}
				now := time.Now().UTC()
				date := now.Format("2006-01-02")
				day, err := time.Parse("2006-01-02", date)
				if err != nil {
					t.Fatal(err)
				}
				seedID := newID()
				owner.ok("POST", base+"/schedules", map[string]any{
					"id": seedID, "name": "Schedule capacity seed", "enabled": false,
					"template": map[string]any{"title": "Generated capacity item", "nextStep": "Verify result"},
					"rule":     map[string]any{"frequency": "daily", "time": "00:00", "timezone": "UTC", "startDate": date, "dueAfterMinutes": 1},
				})
				// A populated ordinary board provides the same fixed page size before
				// and during generation; load is not compared against an empty board.
				txItems, err := app.store.DB.BeginTx(ctx, nil)
				if err != nil {
					t.Fatal(err)
				}
				for i := 0; i < 1000; i++ {
					_, err = txItems.ExecContext(ctx, app.store.Query("INSERT INTO work_items(id,space_id,title,description,next_step,result,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?)"),
						newID(), space, fmt.Sprintf("Ordinary load item %04d", i), strings.Repeat("Description ", 30), "Continue with evidence", "", workStatuses[i%4], false, false, int64(i/4+1)*workRankStep, workStamp(), workStamp(), "schedule-load-fixture")
					if err != nil {
						txItems.Rollback()
						t.Fatal(err)
					}
				}
				if err = txItems.Commit(); err != nil {
					t.Fatal(err)
				}
				if _, err = app.store.DB.ExecContext(ctx, "ANALYZE work_items"); err != nil {
					t.Fatal(err)
				}
				// Copy the validated template inside this disposable fixture only.
				columns := "space_id,template_json,rule_json,enabled,archived,missed_policy,overlap_policy,revision,created_at,updated_at,create_hash,user_id,token_hash,next_run_at,last_run_at,last_result,last_error"
				tx, err := app.store.DB.BeginTx(ctx, nil)
				if err != nil {
					t.Fatal(err)
				}
				for i := 1; i < size; i++ {
					_, err = tx.ExecContext(ctx, app.store.Query("INSERT INTO work_schedules(id,name,"+columns+") SELECT ?,?,"+columns+" FROM work_schedules WHERE id=?"), newID(), fmt.Sprintf("Schedule capacity %d", i), seedID)
					if err != nil {
						tx.Rollback()
						t.Fatal(err)
					}
				}
				if err = tx.Commit(); err != nil {
					t.Fatal(err)
				}
				idlePlans := map[string]any{"zeroRulesNextZero": true}
				measurePlan := func(label string, expectZero bool) {
					t.Helper()
					durations := make([]float64, 0, 25)
					for i := 0; i < 25; i++ {
						start := time.Now()
						due, upcoming, err := app.workScheduleDue(ctx)
						durations = append(durations, float64(time.Since(start).Microseconds())/1000)
						if err != nil || len(due) != 0 || upcoming.IsZero() != expectZero {
							t.Fatalf("%s idle plan: ids=%d next=%s err=%v", label, len(due), upcoming, err)
						}
					}
					idlePlans[label] = schedulePerfQuantiles(durations)
				}
				measurePlan("allPausedNextZero", true)
				future := workScheduleStamp(now.AddDate(1, 0, 0))
				if _, err = app.store.DB.ExecContext(ctx, app.store.Query("UPDATE work_schedules SET enabled=?,next_run_at=?"), true, future); err != nil {
					t.Fatal(err)
				}
				if _, err = app.store.DB.ExecContext(ctx, "ANALYZE work_schedules"); err != nil {
					t.Fatal(err)
				}
				measurePlan("futureNextDeadline", false)
				plan := schedulePerfQueryPlan(t, app)
				if size >= 1000 && !strings.Contains(strings.Join(plan, " "), "work_schedules_due") {
					t.Fatalf("1000-rule due lookup missed its ordering index: %v", plan)
				}
				if _, err = app.store.DB.ExecContext(ctx, app.store.Query("UPDATE settings SET work_enabled=? WHERE id=1"), false); err != nil {
					t.Fatal(err)
				}
				measurePlan("moduleDisabledNextZero", true)
				if _, err = app.store.DB.ExecContext(ctx, app.store.Query("UPDATE settings SET work_enabled=? WHERE id=1"), true); err != nil {
					t.Fatal(err)
				}
				if _, err = app.store.DB.ExecContext(ctx, app.store.Query("UPDATE work_schedules SET next_run_at=?"), workScheduleStamp(day)); err != nil {
					t.Fatal(err)
				}
				transport := &http.Transport{MaxIdleConns: 16, MaxIdleConnsPerHost: 16, MaxConnsPerHost: 16}
				t.Cleanup(transport.CloseIdleConnections)
				client := &http.Client{Transport: transport, Jar: owner.client.Jar, Timeout: 15 * time.Second}
				call := func(method, path string, body []byte) workCapacitySample {
					request, err := http.NewRequestWithContext(ctx, method, server.URL+"/api/v1"+path, bytes.NewReader(body))
					if err != nil {
						return workCapacitySample{Error: err.Error()}
					}
					if body != nil {
						request.Header.Set("Content-Type", "application/json")
						request.Header.Set("X-CSRF-TOKEN", owner.csrf)
					}
					start := time.Now()
					response, err := client.Do(request)
					if err != nil {
						return workCapacitySample{Duration: float64(time.Since(start).Microseconds()) / 1000, Error: err.Error()}
					}
					n, readErr := io.Copy(io.Discard, response.Body)
					closeErr := response.Body.Close()
					sample := workCapacitySample{Duration: float64(time.Since(start).Microseconds()) / 1000, Status: response.StatusCode, Bytes: n}
					if readErr != nil {
						sample.Error = readErr.Error()
					} else if closeErr != nil {
						sample.Error = closeErr.Error()
					}
					return sample
				}
				warmup := call("GET", base+"/board", nil)
				if warmup.Status != 200 || warmup.Error != "" {
					t.Fatalf("read warmup failed: %+v", warmup)
				}
				controlCPUStart := schedulePerfCPU(t)
				controlRSSStart := schedulePerfRSS(t)
				controlStart := time.Now()
				_, waitControl := schedulePerfReaders(call, base, 200)
				controlReads := waitControl()
				controlSeconds := time.Since(controlStart).Seconds()
				controlCPUSeconds := schedulePerfCPU(t) - controlCPUStart
				if schedulePerfReadErrors(controlReads) != 0 {
					t.Fatalf("ordinary read control failed: %v", controlReads)
				}
				cpuBefore := schedulePerfCPU(t)
				rssBefore := schedulePerfRSS(t)
				rssPeak := rssBefore
				start := time.Now()
				stopReads, waitReads := schedulePerfReaders(call, base, 2000)
				processed, batches := 0, 0
				runErr := func() error {
					seen := map[string]bool{}
					for processed < size && batches < (size+49)/50+1 {
						due, _, err := app.workScheduleDue(ctx)
						if err != nil {
							return err
						}
						if len(due) == 0 || len(due) > 50 {
							return fmt.Errorf("due batch size %d before %d/%d complete", len(due), processed, size)
						}
						batches++
						for _, id := range due {
							if seen[id] {
								return fmt.Errorf("due deadline did not advance for %s", id)
							}
							if err := app.processWorkSchedule(ctx, id, now); err != nil {
								return err
							}
							seen[id] = true
							processed++
						}
						rssPeak = max(rssPeak, schedulePerfRSS(t))
					}
					return nil
				}()
				generationSeconds := time.Since(start).Seconds()
				close(stopReads)
				reads := waitReads()
				cpuSeconds := schedulePerfCPU(t) - cpuBefore
				rssAfter := schedulePerfRSS(t)
				rssPeak = max(rssPeak, rssAfter)
				row := map[string]any{
					"provider": provider, "rules": size, "generationSeconds": generationSeconds,
					"generatedPerSecond": float64(processed) / generationSeconds, "processed": processed, "batches": batches,
					"ordinaryItemsBefore": 1000, "readConcurrency": 4,
					"ordinaryReadsWithoutGeneration": controlReads, "ordinaryReadControlSeconds": controlSeconds,
					"ordinaryReadControlCPUSeconds": controlCPUSeconds, "ordinaryReadControlRSSBeforeKiB": controlRSSStart,
					"ordinaryReadsDuringGeneration": reads, "idlePlans": idlePlans, "dueQueryPlan": plan,
					"testProcessCPUSeconds": cpuSeconds, "testProcessRSSBeforeKiB": rssBefore,
					"testProcessRSSAfterKiB": rssAfter, "testProcessRSSPeakObservedKiB": rssPeak,
				}
				results = append(results, row)
				if runErr != nil || processed != size {
					t.Fatalf("due run failed processed=%d expected=%d err=%v", processed, size, runErr)
				}
				if schedulePerfReadErrors(reads) != 0 {
					t.Fatalf("ordinary reads failed during generation: %v", reads)
				}
				var itemCount, occurrenceCount, failedCount, duplicates int
				for _, check := range []struct {
					query string
					dest  *int
				}{
					{"SELECT COUNT(*) FROM work_items", &itemCount},
					{"SELECT COUNT(*) FROM work_schedule_occurrences", &occurrenceCount},
					{"SELECT COUNT(*) FROM work_schedule_occurrences WHERE result<>'created'", &failedCount},
					{"SELECT COUNT(*) FROM (SELECT schedule_id,business_date FROM work_schedule_occurrences GROUP BY schedule_id,business_date HAVING COUNT(*)>1) duplicates", &duplicates},
				} {
					if err := app.store.DB.QueryRowContext(ctx, check.query).Scan(check.dest); err != nil {
						t.Fatal(err)
					}
				}
				row["items"], row["occurrences"], row["nonCreatedOccurrences"], row["duplicateOccurrences"] = itemCount, occurrenceCount, failedCount, duplicates
				if itemCount != 1000+size || occurrenceCount != size || failedCount != 0 || duplicates != 0 {
					t.Fatalf("generation counts disagree: %v", row)
				}
				dateViews := map[string]any{}
				for _, view := range []string{"today", "overdue"} {
					viewSamples := make(chan workCapacitySample, 25)
					for i := 0; i < 25; i++ {
						viewSamples <- call("GET", base+"/board?date="+view+"&timezone=UTC", nil)
					}
					close(viewSamples)
					measured := schedulePerfSamples(viewSamples)
					dateViews[view] = measured
					if measured["errorCount"].(int) != 0 {
						t.Fatalf("%s filtered board failed: %v", view, measured)
					}
				}
				row["dateViewsAfterGeneration"] = dateViews
				// A fresh due rule races one worker against 100 manual requests.
				// Only one new item/receipt may be committed for the current day.
				raceID := newID()
				owner.ok("POST", base+"/schedules", map[string]any{
					"id": raceID, "name": "Same-period concurrency", "enabled": false,
					"template": map[string]any{"title": "Only one concurrent generated item"},
					"rule":     map[string]any{"frequency": "daily", "time": "00:00", "timezone": "UTC", "startDate": date},
				})
				if _, err = app.store.DB.ExecContext(ctx, app.store.Query("UPDATE work_schedules SET enabled=?,next_run_at=? WHERE id=?"), true, workScheduleStamp(day), raceID); err != nil {
					t.Fatal(err)
				}
				body, err := json.Marshal(map[string]any{"expectedRevision": "1", "businessDate": date})
				if err != nil {
					t.Fatal(err)
				}
				raceSamples := make(chan workCapacitySample, 100)
				jobs := make(chan int)
				var racers sync.WaitGroup
				raceStart := time.Now()
				for worker := 0; worker < 8; worker++ {
					racers.Add(1)
					go func() {
						defer racers.Done()
						for range jobs {
							raceSamples <- call("POST", base+"/schedules/"+raceID+"/generate", body)
						}
					}()
				}
				workerError := make(chan error, 1)
				go func() { workerError <- app.processWorkSchedule(ctx, raceID, now) }()
				for i := 0; i < 100; i++ {
					jobs <- i
				}
				close(jobs)
				racers.Wait()
				close(raceSamples)
				race := schedulePerfSamples(raceSamples)
				race["seconds"] = time.Since(raceStart).Seconds()
				race["concurrency"] = 8
				if err := <-workerError; err != nil {
					t.Fatal(err)
				}
				if err := app.store.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM work_items").Scan(&itemCount); err != nil {
					t.Fatal(err)
				}
				if err := app.store.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM work_schedule_occurrences").Scan(&occurrenceCount); err != nil {
					t.Fatal(err)
				}
				race["itemsAfter"], race["occurrencesAfter"] = itemCount, occurrenceCount
				row["samePeriodRace"] = race
				if race["errorCount"].(int) != 0 || itemCount != 1000+size+1 || occurrenceCount != size+1 {
					t.Fatalf("concurrent same-period replay failed: %v", race)
				}
				encoded, err := json.Marshal(row)
				if err != nil {
					t.Fatal(err)
				}
				t.Log(string(encoded))
			})
		}
	}
	if file := os.Getenv("LINGSHU_WORK_SCHEDULE_PERFORMANCE_OUTPUT"); file != "" {
		encoded, err := json.MarshalIndent(map[string]any{
			"method":  "100/1000 due rules, one production scheduler transaction lane plus four loopback HTTP readers; 100 same-period requests racing a worker at concurrency eight; read control on 1000 ordinary items; isolated fixtures; CPU/RSS include HTTP clients in the Go test process and exclude the PostgreSQL server; no claim of maximum capacity",
			"results": results,
		}, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(file, encoded, 0644); err != nil {
			t.Fatal(err)
		}
	}
}

func schedulePerfReaders(call func(string, string, []byte) workCapacitySample, base string, limit int) (chan struct{}, func() map[string]any) {
	stop := make(chan struct{})
	board := make(chan workCapacitySample, limit)
	bootstrap := make(chan workCapacitySample, limit)
	var readers sync.WaitGroup
	var sequence atomic.Int64
	for reader := 0; reader < 4; reader++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				index := sequence.Add(1)
				if index > int64(limit) {
					return
				}
				if index%5 == 0 {
					bootstrap <- call("GET", "/bootstrap", nil)
				} else {
					board <- call("GET", base+"/board", nil)
				}
			}
		}()
	}
	return stop, func() map[string]any {
		readers.Wait()
		close(board)
		close(bootstrap)
		return map[string]any{"board": schedulePerfSamples(board), "bootstrap": schedulePerfSamples(bootstrap)}
	}
}

func schedulePerfReadErrors(reads map[string]any) int {
	return reads["board"].(map[string]any)["errorCount"].(int) + reads["bootstrap"].(map[string]any)["errorCount"].(int)
}

func schedulePerfCPU(t *testing.T) float64 {
	t.Helper()
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		t.Fatal(err)
	}
	return float64(usage.Utime.Sec+usage.Stime.Sec) + float64(usage.Utime.Usec+usage.Stime.Usec)/1e6
}

func schedulePerfRSS(t *testing.T) int64 {
	t.Helper()
	body, err := os.ReadFile("/proc/self/status")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(body), "\n") {
		if strings.HasPrefix(line, "VmRSS:") {
			value, err := strconv.ParseInt(strings.Fields(line)[1], 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			return value
		}
	}
	t.Fatal("Linux fixture process lacks VmRSS")
	return 0
}

func schedulePerfQuantiles(durations []float64) map[string]any {
	sort.Float64s(durations)
	result := map[string]any{"samples": len(durations)}
	if len(durations) > 0 {
		result["p50Ms"] = durations[len(durations)/2]
		result["p95Ms"] = durations[(len(durations)*95-1)/100]
		result["maxMs"] = durations[len(durations)-1]
	}
	return result
}

func schedulePerfSamples(samples <-chan workCapacitySample) map[string]any {
	durations := []float64{}
	codes := map[int]int{}
	errors := []string{}
	for sample := range samples {
		durations = append(durations, sample.Duration)
		codes[sample.Status]++
		if sample.Error != "" {
			errors = append(errors, sample.Error)
		} else if sample.Status != 200 {
			errors = append(errors, fmt.Sprintf("HTTP %d", sample.Status))
		}
	}
	result := schedulePerfQuantiles(durations)
	result["statusCounts"], result["errorCount"] = codes, len(errors)
	if len(errors) > 0 {
		result["firstErrors"] = errors[:min(5, len(errors))]
	}
	return result
}

func schedulePerfQueryPlan(t *testing.T, app *App) []string {
	t.Helper()
	statement := app.store.Query("SELECT id,next_run_at FROM work_schedules WHERE enabled=? AND archived=? AND next_run_at<>'' ORDER BY next_run_at,id LIMIT 50")
	prefix := "EXPLAIN "
	if app.store.Provider == "sqlite" {
		prefix = "EXPLAIN QUERY PLAN "
	}
	rows, err := app.store.DB.Query(prefix+statement, true, false)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	plan := []string{}
	for rows.Next() {
		var detail string
		if app.store.Provider == "sqlite" {
			var a, b, c int
			err = rows.Scan(&a, &b, &c, &detail)
		} else {
			err = rows.Scan(&detail)
		}
		if err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	return plan
}

// Exact SQLite plans compare the production filter builder with and without the
// nonempty predicate required to prove a partial-index condition. No timings
// or maximum-throughput claims are inferred from EXPLAIN.
func TestWorkDateQueryPlans(t *testing.T) {
	if os.Getenv("LINGSHU_WORK_DATE_PLAN") != "1" {
		t.Skip("opt-in SQLite date and overlap query plan evidence")
	}
	app, server := newAccountProfileHTTPFixture(t, "sqlite")
	owner := newCoreBrowser(t, server.URL)
	owner.bootstrap()
	owner.ok("POST", "/setup", map[string]any{"siteName": "Date query plan fixture", "mode": ModePrivateMulti, "username": "owner", "password": "isolated date plan fixture password", "seedDemo": false})
	space := coreSpace(owner.bootstrap(), "shared")
	owner.ok("GET", "/spaces/"+space+"/work/board", nil)
	app.cancel()
	app.workers.Wait()
	now := time.Now().UTC()
	date := now.Format("2006-01-02")
	scheduleID := newID()
	tx, err := app.store.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5100; i++ {
		businessDate, dueAt, origin := "", "", ""
		if i >= 5000 {
			businessDate, dueAt, origin = date, workScheduleStamp(now.Add(-time.Hour)), scheduleID
		}
		_, err = tx.Exec(app.store.Query("INSERT INTO work_items(id,space_id,title,description,next_step,result,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash,business_date,due_at,schedule_id) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)"),
			newID(), space, fmt.Sprintf("Date index item %d", i), "", "", "", "todo", false, false, int64(i+1)*workRankStep, workStamp(), workStamp(), "date-plan-fixture", businessDate, dueAt, origin)
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
	explain := func(statement string, args ...any) []string {
		t.Helper()
		rows, err := app.store.DB.Query("EXPLAIN QUERY PLAN "+app.store.Query(statement), args...)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		plan := []string{}
		for rows.Next() {
			var a, b, c int
			var detail string
			if err := rows.Scan(&a, &b, &c, &detail); err != nil {
				t.Fatal(err)
			}
			plan = append(plan, detail)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return plan
	}
	where, args := (workFilter{BusinessDate: date, Status: "todo"}).where(space)
	without := strings.Replace(where, "w.business_date<>'' AND ", "", 1)
	with := strings.Replace(without, "w.business_date=?", "w.business_date<>'' AND w.business_date=?", 1)
	statement := func(predicate string) string {
		return "SELECT w.id,w.title,w.next_step FROM work_items w WHERE " + predicate + " ORDER BY w.sort_order,w.id LIMIT 31"
	}
	actualPlan := explain(statement(where), args...)
	withoutPlan := explain(statement(without), args...)
	withPlan := explain(statement(with), args...)
	overdueWhere, overdueArgs := (workFilter{Date: "overdue", cutoff: workScheduleStamp(now)}).where(space)
	overduePlan := explain("SELECT COUNT(*) FROM work_items w WHERE "+overdueWhere, overdueArgs...)
	overlap := "SELECT COUNT(*) FROM work_items w JOIN work_statuses s ON s.space_id=w.space_id AND s.id=w.status WHERE w.schedule_id=? AND w.business_date<? AND w.archived=? AND s.status_type NOT IN ('done','canceled')"
	overlapWith := strings.Replace(overlap, "w.schedule_id=?", "w.schedule_id<>'' AND w.schedule_id=?", 1)
	overlapArgs := []any{scheduleID, now.AddDate(0, 0, 1).Format("2006-01-02"), false}
	result := map[string]any{
		"provider": "sqlite", "ordinaryItems": 5000, "datedItems": 100,
		"currentTodayPlan": actualPlan, "todayWithoutNonemptyPlan": withoutPlan, "todayWithNonemptyPlan": withPlan,
		"currentOverduePlan":         overduePlan,
		"overlapWithoutNonemptyPlan": explain(overlap, overlapArgs...),
		"overlapWithNonemptyPlan":    explain(overlapWith, overlapArgs...),
	}
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	t.Log(string(encoded))
	if file := os.Getenv("LINGSHU_WORK_DATE_PLAN_OUTPUT"); file != "" {
		if err := os.WriteFile(file, encoded, 0644); err != nil {
			t.Fatal(err)
		}
	}
	if !strings.Contains(strings.Join(actualPlan, " "), "work_items_business_date") {
		t.Fatal("production exact-date filter did not use its partial date index")
	}
	if !strings.Contains(strings.Join(overduePlan, " "), "work_items_due_at") {
		t.Fatal("production overdue count did not use its partial due index")
	}
	if !strings.Contains(strings.Join(explain(overlapWith, overlapArgs...), " "), "work_items_schedule_date") {
		t.Fatal("explicit schedule origin predicate did not use its partial index")
	}
}
