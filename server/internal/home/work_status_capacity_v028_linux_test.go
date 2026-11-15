//go:build linux

package home

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"testing"
	"time"
)

// This is an opt-in, bounded comparison for the status-observation write path.
// The same file is copied into the exact published baseline source. Every item
// is created through HTTP, and each changes todo -> doing -> done exactly once.
func TestWorkStatusChangeCapacityV028(t *testing.T) {
	if os.Getenv("LINGSHU_WORK_STATUS_CAPACITY_V028") != "1" {
		t.Skip("opt-in isolated status-transition measurements")
	}
	results := []map[string]any{}
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Status transition capacity", "mode": ModePrivateMulti, "username": "owner", "password": "isolated status capacity password", "seedDemo": false})
			space := coreSpace(owner.bootstrap(), "shared")
			base := "/spaces/" + space + "/work"
			const items, concurrency = 200, 8
			ids := make([]string, items)
			for i := range ids {
				item := owner.ok("POST", base+"/items", map[string]any{"requestId": newID(), "title": fmt.Sprintf("Status measurement %03d", i), "status": "todo"})
				ids[i] = item["id"].(string)
				if item["revision"] != "1" || item["status"] != "todo" {
					t.Fatalf("unexpected initial item: %v", item)
				}
			}
			transport := &http.Transport{MaxIdleConns: 16, MaxIdleConnsPerHost: 16, MaxConnsPerHost: 16}
			t.Cleanup(transport.CloseIdleConnections)
			client := &http.Client{Transport: transport, Jar: owner.client.Jar, Timeout: 15 * time.Second}
			call := func(id, status, revision string) workCapacitySample {
				body, _ := json.Marshal(map[string]string{"expectedRevision": revision, "status": status})
				request, err := http.NewRequest("PATCH", server.URL+"/api/v1"+base+"/items/"+id, bytes.NewReader(body))
				if err != nil {
					return workCapacitySample{Error: err.Error()}
				}
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("X-CSRF-TOKEN", owner.csrf)
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
			cpuBefore, rssBefore := schedulePerfCPU(t), schedulePerfRSS(t)
			start := time.Now()
			allSamples := make(chan workCapacitySample, items*2)
			phases := []map[string]any{}
			for phase, status := range []string{"doing", "done"} {
				jobs := make(chan string)
				samples := make(chan workCapacitySample, items)
				phaseStart := time.Now()
				var workers sync.WaitGroup
				for worker := 0; worker < concurrency; worker++ {
					workers.Add(1)
					go func() {
						defer workers.Done()
						for id := range jobs {
							samples <- call(id, status, fmt.Sprint(phase+1))
						}
					}()
				}
				for _, id := range ids {
					jobs <- id
				}
				close(jobs)
				workers.Wait()
				close(samples)
				phaseSamples := make(chan workCapacitySample, items)
				for sample := range samples {
					phaseSamples <- sample
					allSamples <- sample
				}
				close(phaseSamples)
				measured := schedulePerfSamples(phaseSamples)
				measured["targetStatus"] = status
				measured["seconds"] = time.Since(phaseStart).Seconds()
				phases = append(phases, measured)
			}
			elapsed := time.Since(start).Seconds()
			cpuSeconds, rssAfter := schedulePerfCPU(t)-cpuBefore, schedulePerfRSS(t)
			close(allSamples)
			row := schedulePerfSamples(allSamples)
			row["provider"], row["items"], row["concurrency"] = provider, items, concurrency
			row["seconds"], row["requestsPerSecond"] = elapsed, float64(items*2)/elapsed
			row["measuredHTTPRequests"], row["setupHTTPItemCreates"] = items*2, items
			row["testProcessCPUSeconds"], row["testProcessRSSBeforeKiB"], row["testProcessRSSAfterKiB"] = cpuSeconds, rssBefore, rssAfter
			row["phases"] = phases
			var done, wrongRevision int
			if err := app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM work_items WHERE space_id=? AND status='done'"), space).Scan(&done); err != nil {
				t.Fatal(err)
			}
			if err := app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM work_items WHERE space_id=? AND revision<>3"), space).Scan(&wrongRevision); err != nil {
				t.Fatal(err)
			}
			var metricsTables int
			tableQuery := "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='work_metric_intervals'"
			if provider == "postgres" {
				tableQuery = "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='work_metric_intervals'"
			}
			if err := app.store.DB.QueryRow(tableQuery).Scan(&metricsTables); err != nil {
				t.Fatal(err)
			}
			row["completedItems"], row["unexpectedItemRevisions"], row["metricsTablePresent"] = done, wrongRevision, metricsTables == 1
			if metricsTables == 1 {
				var cycles, unfinished int
				if err := app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM work_metric_intervals WHERE space_id=? AND kind='cycle'"), space).Scan(&cycles); err != nil {
					t.Fatal(err)
				}
				if err := app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM work_metric_intervals WHERE space_id=? AND kind='cycle' AND ended_at=''"), space).Scan(&unfinished); err != nil {
					t.Fatal(err)
				}
				row["cycleObservations"], row["unfinishedCycleObservations"] = cycles, unfinished
				if cycles != items || unfinished != 0 {
					t.Fatalf("status observation counts disagree: %v", row)
				}
			}
			results = append(results, row)
			encoded, _ := json.Marshal(row)
			t.Log(string(encoded))
			if row["errorCount"].(int) != 0 || done != items || wrongRevision != 0 {
				t.Fatalf("status-transition workload failed: %v", row)
			}
		})
	}
	if file := os.Getenv("LINGSHU_WORK_STATUS_CAPACITY_V028_OUTPUT"); file != "" {
		encoded, err := json.MarshalIndent(map[string]any{
			"method":  "200 HTTP-created todo items; 200 todo-to-doing PATCH requests followed by 200 doing-to-done PATCH requests, each phase concurrency 8; default settings, no rules, no opened statistics surface; CPU/RSS cover the Go test process including local HTTP clients and SQLite, exclude PostgreSQL server; bounded sample, not an SLA",
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
