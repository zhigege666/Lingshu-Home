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
	"strings"
	"sync"
	"testing"
	"time"
)

func workAutomationPerfSeedBoard(t *testing.T, app *App, provider, space string) {
	t.Helper()
	tx, err := app.store.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	stamp := workStamp()
	for i := 0; i < 1000; i++ {
		_, err = tx.Exec(app.store.Query("INSERT INTO work_items(id,space_id,title,description,next_step,result,status,needs_attention,archived,sort_order,revision,created_at,updated_at,create_hash) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?)"),
			newID(), space, fmt.Sprintf("Ordinary automation load %04d", i), strings.Repeat("Description ", 30), "Continue with evidence", "", workStatuses[i%4], false, false, int64(i/4+1)*workRankStep, stamp, stamp, "automation-capacity-fixture")
		if err != nil {
			tx.Rollback()
			t.Fatal(err)
		}
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	workPerformanceFinalizeV028Fixture(t, app, provider, space)
	if _, err = app.store.DB.Exec("ANALYZE work_items"); err != nil {
		t.Fatal(err)
	}
}

func workAutomationPerfCaller(ctx context.Context, client *http.Client, serverURL, csrf string) func(string, string, []byte) workCapacitySample {
	return func(method, path string, body []byte) workCapacitySample {
		request, err := http.NewRequestWithContext(ctx, method, serverURL+"/api/v1"+path, bytes.NewReader(body))
		if err != nil {
			return workCapacitySample{Error: err.Error()}
		}
		if body != nil {
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-CSRF-TOKEN", csrf)
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
}

// Production event transactions are processed sequentially, matching the real
// coordinator. HTTP admission and normal reads use actual local HTTP. The
// automatic coordinator is stopped only to give each case an exact queue and
// measurement boundary. This is a bounded burst, not a steady-state SLA.
func TestWorkAutomationCapacityV028(t *testing.T) {
	if os.Getenv("LINGSHU_WORK_AUTOMATION_CAPACITY_V028") != "1" {
		t.Skip("opt-in isolated event and notification measurements")
	}
	results := []map[string]any{}
	cases := []struct {
		name          string
		rules, events int
		matches       bool
		notifications bool
		matchLimit    bool
	}{
		{name: "zero_rules", events: 200},
		{name: "1000_unmatched_rules", rules: 1000, events: 200},
		{name: "25_matching_rules", rules: 25, events: 40, matches: true},
		{name: "match_limit_notices_off", rules: 26, events: 200, matches: true, matchLimit: true},
		{name: "match_limit_notices_on", rules: 26, events: 200, matches: true, notifications: true, matchLimit: true},
	}
	for _, provider := range []string{"sqlite", "postgres"} {
		for _, scenario := range cases {
			t.Run(provider+"/"+scenario.name, func(t *testing.T) {
				app, server := newAccountProfileHTTPFixture(t, provider)
				owner := newCoreBrowser(t, server.URL)
				owner.bootstrap()
				owner.ok("POST", "/setup", map[string]any{"siteName": "Automation capacity", "mode": ModePrivateMulti, "username": "owner", "password": "isolated automation capacity password", "seedDemo": false})
				space := coreSpace(owner.bootstrap(), "shared")
				base := "/spaces/" + space + "/work"
				owner.ok("GET", base+"/statuses", nil)
				app.cancel()
				app.workers.Wait()
				ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
				defer cancel()
				workAutomationPerfSeedBoard(t, app, provider, space)
				owner.ok("PATCH", base+"/automation/settings", map[string]any{"expectedRevision": "1", "enabled": true})
				if scenario.notifications {
					owner.ok("PATCH", base+"/notifications/settings", map[string]any{"expectedRevision": "1", "enabled": true})
				}
				idlePlans := map[string]any{}
				checkIdle := func(label string) {
					t.Helper()
					durations := []float64{}
					for i := 0; i < 25; i++ {
						began := time.Now()
						events, executions, next, err := app.workAutomationDue(ctx, time.Now(), 4, map[string]bool{})
						durations = append(durations, float64(time.Since(began).Microseconds())/1000)
						if err != nil || len(events) != 0 || len(executions) != 0 || !next.IsZero() {
							t.Fatalf("idle plan %s: events=%d executions=%d next=%s err=%v", label, len(events), len(executions), next, err)
						}
					}
					idlePlans[label] = schedulePerfQuantiles(durations)
				}
				checkIdle("zeroRulesNoTimer")
				if scenario.rules > 0 {
					id := newID()
					eventType := "sync.unmatched"
					if scenario.matches {
						eventType = "sync.finished"
					}
					owner.ok("POST", base+"/automation/rules", map[string]any{"id": id, "name": "Capacity seed", "eventType": eventType, "enabled": false, "template": map[string]any{"title": "Generated event capacity item"}})
					columns := "space_id,event_type,project_id,status_id,template_json,executor_id,enabled,archived,revision,user_id,token_hash,created_at,updated_at,create_hash"
					tx, err := app.store.DB.BeginTx(ctx, nil)
					if err != nil {
						t.Fatal(err)
					}
					for i := 1; i < scenario.rules; i++ {
						if _, err = tx.ExecContext(ctx, app.store.Query("INSERT INTO work_automation_rules(id,name,"+columns+") SELECT ?,?,"+columns+" FROM work_automation_rules WHERE id=?"), newID(), fmt.Sprintf("Capacity rule %04d", i), id); err != nil {
							tx.Rollback()
							t.Fatal(err)
						}
					}
					if err = tx.Commit(); err != nil {
						t.Fatal(err)
					}
					checkIdle("allPausedNoTimer")
					if _, err = app.store.DB.ExecContext(ctx, app.store.Query("UPDATE work_automation_rules SET enabled=? WHERE space_id=?"), true, space); err != nil {
						t.Fatal(err)
					}
					if _, err = app.store.DB.ExecContext(ctx, app.store.Query("UPDATE spaces SET work_automation_rule_count=? WHERE id=?"), scenario.rules, space); err != nil {
						t.Fatal(err)
					}
					if _, err = app.store.DB.ExecContext(ctx, "ANALYZE work_automation_rules"); err != nil {
						t.Fatal(err)
					}
					checkIdle("enabledRulesWithoutEventsNoTimer")
				}
				transport := &http.Transport{MaxIdleConns: 16, MaxIdleConnsPerHost: 16, MaxConnsPerHost: 16}
				t.Cleanup(transport.CloseIdleConnections)
				client := &http.Client{Transport: transport, Jar: owner.client.Jar, Timeout: 20 * time.Second}
				call := workAutomationPerfCaller(ctx, client, server.URL, owner.csrf)
				for i := 0; i < 5; i++ {
					if sample := call("GET", base+"/board", nil); sample.Status != 200 || sample.Error != "" {
						t.Fatalf("ordinary warmup failed: %+v", sample)
					}
				}
				controlStart := time.Now()
				_, waitControl := workSustainedReaders(call, base, 200)
				control := waitControl()
				controlSeconds := time.Since(controlStart).Seconds()
				if schedulePerfReadErrors(control) != 0 {
					t.Fatalf("read control failed: %v", control)
				}
				ids := make([]string, scenario.events)
				for i := range ids {
					ids[i] = newID()
				}
				cpuBefore, rssBefore := schedulePerfCPU(t), schedulePerfRSS(t)
				start := time.Now()
				stopReads, waitReads := workSustainedReaders(call, base, 0)
				jobs := make(chan string)
				samples := make(chan workCapacitySample, scenario.events)
				var senders sync.WaitGroup
				for worker := 0; worker < 8; worker++ {
					senders.Add(1)
					go func() {
						defer senders.Done()
						for id := range jobs {
							body, _ := json.Marshal(map[string]any{"id": id, "type": "sync.finished", "summary": "Actual isolated load result"})
							samples <- call("POST", base+"/automation/events", body)
						}
					}()
				}
				for _, id := range ids {
					jobs <- id
				}
				close(jobs)
				senders.Wait()
				close(samples)
				ingestion := schedulePerfSamples(samples)
				ingestionSeconds := time.Since(start).Seconds()
				processingStart := time.Now()
				var processErr error
				processed := 0
				for _, id := range ids {
					if processErr = app.processWorkAutomationEventID(ctx, id); processErr != nil {
						break
					}
					processed++
				}
				processingSeconds := time.Since(processingStart).Seconds()
				activeSeconds := time.Since(start).Seconds()
				close(stopReads)
				reads := waitReads()
				cpuSeconds, rssAfter := schedulePerfCPU(t)-cpuBefore, schedulePerfRSS(t)
				row := map[string]any{
					"provider": provider, "scenario": scenario.name, "rules": scenario.rules, "events": scenario.events,
					"ordinaryItemsBefore": 1000, "notificationsEnabled": scenario.notifications,
					"ingestionConcurrency": 8, "ingestion": ingestion, "ingestionSeconds": ingestionSeconds,
					"processingSeconds": processingSeconds, "activeWindowSeconds": activeSeconds,
					"processedPerSecond":         float64(processed) / activeSeconds,
					"ordinaryReadsWithoutEvents": control, "ordinaryReadControlSeconds": controlSeconds,
					"ordinaryReadsDuringEvents": reads, "testProcessCPUSeconds": cpuSeconds,
					"testProcessRSSBeforeKiB": rssBefore, "testProcessRSSAfterKiB": rssAfter, "idlePlans": idlePlans,
				}
				count := func(statement string, args ...any) int {
					t.Helper()
					var value int
					if err := app.store.DB.QueryRowContext(ctx, app.store.Query(statement), args...).Scan(&value); err != nil {
						t.Fatal(err)
					}
					return value
				}
				processedEvents := count("SELECT COUNT(*) FROM work_automation_events WHERE space_id=? AND state='processed'", space)
				failedEvents := count("SELECT COUNT(*) FROM work_automation_events WHERE space_id=? AND state='failed'", space)
				queuedEvents := count("SELECT COUNT(*) FROM work_automation_events WHERE space_id=? AND state='queued'", space)
				itemCount := count("SELECT COUNT(*) FROM work_items WHERE space_id=?", space)
				receipts := count("SELECT COUNT(*) FROM work_automation_receipts")
				duplicateReceipts := count("SELECT COUNT(*) FROM (SELECT event_id,rule_id FROM work_automation_receipts GROUP BY event_id,rule_id HAVING COUNT(*)>1) repeated")
				notices := count("SELECT COUNT(*) FROM work_notices WHERE space_id=?", space)
				row["processedEvents"], row["failedEvents"], row["queuedEvents"] = processedEvents, failedEvents, queuedEvents
				row["itemsAfter"], row["receipts"], row["duplicateReceipts"], row["noticeRows"] = itemCount, receipts, duplicateReceipts, notices
				wantCreated, wantFailed, wantNotices := 0, 0, 0
				if scenario.matches && !scenario.matchLimit {
					wantCreated = scenario.rules * scenario.events
				}
				if scenario.matchLimit {
					wantFailed = scenario.events
					if scenario.notifications {
						wantNotices = scenario.events
					}
					// Check business failure counters after timing; they must not be
					// inferred from optional inbox rows or unread notification count.
					summary := owner.ok("GET", base+"/notifications/summary", nil)
					list := owner.ok("GET", base+"/notifications?limit=1", nil)
					failures := summary["spaceFailures"].(map[string]any)
					row["notificationSummaryAfterMeasurement"] = summary
					row["notificationListTotalAfterMeasurement"] = list["total"]
					if failures["automationFailed"] != float64(scenario.events) || summary["unreadCount"] != float64(wantNotices) || list["total"] != float64(wantNotices) {
						t.Fatalf("failure/inbox counters disagree: summary=%v list=%v", summary, list)
					}
				}
				results = append(results, row)
				encoded, _ := json.Marshal(row)
				t.Log(string(encoded))
				if processErr != nil || ingestion["errorCount"].(int) != 0 || schedulePerfReadErrors(reads) != 0 || processed != scenario.events || processedEvents != scenario.events-wantFailed || failedEvents != wantFailed || queuedEvents != 0 || itemCount != 1000+wantCreated || receipts != wantCreated || duplicateReceipts != 0 || notices != wantNotices {
					t.Fatalf("event workload failed: processErr=%v row=%v", processErr, row)
				}
				checkIdle("drainedQueueNoTimer")
			})
		}
	}
	if file := os.Getenv("LINGSHU_WORK_AUTOMATION_CAPACITY_V028_OUTPUT"); file != "" {
		encoded, err := json.MarshalIndent(map[string]any{
			"method":  "Disposable SQLite and PostgreSQL fixtures; production event transaction helper, sequential processing as in coordinator; HTTP admission concurrency 8; four ordinary HTTP readers continue throughout the complete admission plus processing window; CPU/RSS include Go HTTP clients and SQLite, exclude PostgreSQL server; bounded workload, not maximum capacity or SLA",
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
