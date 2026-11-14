package home

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

type workCapacitySample struct {
	Duration float64
	Status   int
	Bytes    int64
	Error    string
}

// Opt-in local HTTP load test. Every run creates its own disposable fixture.
// Both the old-source snapshot and the candidate use this exact harness.
func TestWorkCapacityPerformance(t *testing.T) {
	if os.Getenv("LINGSHU_WORK_CAPACITY") != "1" {
		t.Skip("opt-in HTTP capacity measurements")
	}
	results := []map[string]any{}
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			app, server := newAccountProfileHTTPFixture(t, provider)
			owner := newCoreBrowser(t, server.URL)
			owner.bootstrap()
			owner.ok("POST", "/setup", map[string]any{"siteName": "Work capacity isolated fixture", "mode": ModePrivateMulti, "username": "owner", "password": "work capacity fixture password", "seedDemo": false})
			boot := owner.bootstrap()
			space := coreSpace(boot, "shared")
			base := "/spaces/" + space + "/work"
			stamp := workStamp()
			tx, err := app.store.DB.Begin()
			if err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 10000; i++ {
				_, err = tx.Exec(app.store.Query("INSERT INTO work_items(id,space_id,title,description,next_step,result,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?)"),
					fmt.Sprintf("%032x", i+1), space, fmt.Sprintf("Capacity item %05d", i), strings.Repeat("Description ", 30), "Continue with evidence", strings.Repeat("Result ", 20), workStatuses[i%4], i%11 == 0, false, int64(i/4+1)*workRankStep, stamp, stamp, "capacity-fixture")
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
			transport := &http.Transport{MaxIdleConns: 32, MaxIdleConnsPerHost: 32, MaxConnsPerHost: 32}
			t.Cleanup(transport.CloseIdleConnections)
			client := &http.Client{Transport: transport, Jar: owner.client.Jar, Timeout: 20 * time.Second}
			call := func(method, path string, body []byte) workCapacitySample {
				request, err := http.NewRequest(method, server.URL+"/api/v1"+path, bytes.NewReader(body))
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
			for _, kind := range []string{"board", "bootstrap", "mixed"} {
				for i := 0; i < 5; i++ {
					sample := call("GET", base+"/board", nil)
					if sample.Status != 200 || sample.Error != "" {
						t.Fatalf("warmup failed: %+v", sample)
					}
				}
				const concurrency = 8
				const requests = 200
				jobs := make(chan int)
				samples := make(chan workCapacitySample, requests)
				var wg sync.WaitGroup
				start := time.Now()
				for worker := 0; worker < concurrency; worker++ {
					wg.Add(1)
					go func() {
						defer wg.Done()
						for i := range jobs {
							method, path := "GET", base+"/board"
							var body []byte
							if kind == "bootstrap" {
								path = "/bootstrap"
							}
							if kind == "mixed" {
								if i%5 == 0 {
									method = "POST"
									path = base + "/items"
									body, _ = json.Marshal(map[string]any{"id": newID(), "title": fmt.Sprintf("Capacity created %d", i), "nextStep": "Check result"})
								} else if i%2 == 0 {
									path = base + "/items?limit=30"
								}
							}
							samples <- call(method, path, body)
						}
					}()
				}
				for i := 0; i < requests; i++ {
					jobs <- i
				}
				close(jobs)
				wg.Wait()
				close(samples)
				elapsed := time.Since(start).Seconds()
				durations := make([]float64, 0, requests)
				codes := map[int]int{}
				errors := []string{}
				var responseBytes int64
				for sample := range samples {
					durations = append(durations, sample.Duration)
					codes[sample.Status]++
					responseBytes += sample.Bytes
					if sample.Error != "" {
						errors = append(errors, sample.Error)
					} else if sample.Status < 200 || sample.Status >= 300 {
						errors = append(errors, fmt.Sprintf("HTTP %d", sample.Status))
					}
				}
				sort.Float64s(durations)
				row := map[string]any{"provider": provider, "items": 10000, "kind": kind, "concurrency": concurrency, "requests": requests, "seconds": elapsed, "requestsPerSecond": float64(requests) / elapsed, "p50Ms": durations[len(durations)/2], "p95Ms": durations[(len(durations)*95-1)/100], "maxMs": durations[len(durations)-1], "statusCounts": codes, "errorCount": len(errors), "responseBytes": responseBytes}
				results = append(results, row)
				encoded, _ := json.Marshal(row)
				t.Log(string(encoded))
				if len(errors) > 0 {
					t.Fatalf("%s errors: %v", kind, errors[:min(len(errors), 5)])
				}
			}
			var count int
			if err = app.store.DB.QueryRow(app.store.Query("SELECT COUNT(*) FROM work_items WHERE space_id=?"), space).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 10040 {
				t.Fatalf("expected exactly 40 ordinary created items; total=%d", count)
			}
		})
	}
	if file := os.Getenv("LINGSHU_WORK_CAPACITY_OUTPUT"); file != "" {
		encoded, err := json.MarshalIndent(map[string]any{"method": "200 loopback HTTP requests per workload, concurrency 8, 10000 seeded items; includes authorization; mixed workload includes 40 ordinary writes and 160 reads; not maximum capacity or WAN latency", "results": results}, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(file, encoded, 0644); err != nil {
			t.Fatal(err)
		}
	}
}
