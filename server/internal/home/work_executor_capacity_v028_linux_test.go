//go:build linux

package home

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type workPerfOutboundStats struct {
	mu                sync.Mutex
	active, maxActive int
	calls, errors     int
	methods           map[string]int
	statuses          map[int]int
	durations         []float64
}
type workPerfOutboundTransport struct {
	base  http.RoundTripper
	stats *workPerfOutboundStats
}

func (transport *workPerfOutboundTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	s := transport.stats
	s.mu.Lock()
	s.active++
	s.calls++
	s.maxActive = max(s.maxActive, s.active)
	s.methods[request.Method]++
	s.mu.Unlock()
	began := time.Now()
	response, err := transport.base.RoundTrip(request)
	s.mu.Lock()
	s.active--
	s.durations = append(s.durations, float64(time.Since(began).Microseconds())/1000)
	if err != nil {
		s.errors++
	} else {
		s.statuses[response.StatusCode]++
	}
	s.mu.Unlock()
	return response, err
}
func (transport *workPerfOutboundTransport) CloseIdleConnections() {
	if closer, ok := transport.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}
func (s *workPerfOutboundStats) snapshot() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return map[string]any{
		"calls": s.calls, "errors": s.errors, "maximumConcurrentRoundTrips": s.maxActive,
		"methods": s.methods, "statusCounts": s.statuses, "latency": schedulePerfQuantiles(s.durations),
		"scope": "Real private-network HTTP from before RoundTrip until response headers; normal outbound security transport retained; body parsing and database receipt commit excluded",
	}
}

func workPerfExternalCPU(t *testing.T, pid int, ticks float64) (float64, float64, int64) {
	t.Helper()
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		t.Fatal(err)
	}
	closing := strings.LastIndex(string(raw), ")")
	if closing < 0 {
		t.Fatal("invalid process stat")
	}
	fields := strings.Fields(string(raw)[closing+2:])
	values := make([]float64, 4)
	for i := range values {
		value, err := strconv.ParseFloat(fields[11+i], 64)
		if err != nil {
			t.Fatal(err)
		}
		values[i] = value / ticks
	}
	status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		t.Fatal(err)
	}
	var rss int64
	for _, line := range strings.Split(string(status), "\n") {
		if strings.HasPrefix(line, "VmRSS:") {
			value, err := strconv.ParseInt(strings.Fields(line)[1], 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			rss = value
		}
	}
	return values[0] + values[1], values[2] + values[3], rss
}

// This test keeps the actual coordinator and four-worker pool running. The
// reference server runs the same fixed Python subprocess for every snapshot;
// it never uses task text as code. Polling intervals retain production limits.
func TestWorkExecutorCapacityV028(t *testing.T) {
	if os.Getenv("LINGSHU_WORK_EXECUTOR_CAPACITY_V028") != "1" {
		t.Skip("opt-in real HTTP executor capacity measurements")
	}
	exampleDir, bind := os.Getenv("LINGSHU_WORK_EXECUTOR_EXAMPLE_DIR"), os.Getenv("WORK_EXECUTOR_TEST_BIND")
	if exampleDir == "" || bind == "" {
		t.Fatal("set the reference example directory and an existing private test interface")
	}
	if _, err := os.Stat(filepath.Join(exampleDir, "executor.py")); err != nil {
		t.Fatal(err)
	}
	clock, err := exec.Command("getconf", "CLK_TCK").Output()
	if err != nil {
		t.Fatal(err)
	}
	ticks, err := strconv.ParseFloat(strings.TrimSpace(string(clock)), 64)
	if err != nil || ticks <= 0 {
		t.Fatal("invalid process clock tick rate")
	}
	results := []map[string]any{}
	for _, provider := range []string{"sqlite", "postgres"} {
		for _, resources := range []int{4, 1} {
			t.Run(fmt.Sprintf("%s/%d_resources", provider, resources), func(t *testing.T) {
				app, server := newAccountProfileHTTPFixture(t, provider)
				owner := newCoreBrowser(t, server.URL)
				owner.bootstrap()
				owner.ok("POST", "/setup", map[string]any{"siteName": "Real executor capacity", "mode": ModePrivateMulti, "username": "owner", "password": "isolated executor capacity password", "seedDemo": false})
				space := coreSpace(owner.bootstrap(), "shared")
				base := "/spaces/" + space + "/work"
				owner.ok("GET", base+"/statuses", nil)
				workAutomationPerfSeedBoard(t, app, provider, space)
				temp := t.TempDir()
				token := newID() + newID()
				tokenFile, argvFile, readyFile := filepath.Join(temp, "token"), filepath.Join(temp, "argv.json"), filepath.Join(temp, "ready.json")
				journal, commandFile := filepath.Join(temp, "subprocess.jsonl"), filepath.Join(temp, "fixed-command.py")
				commandSource := "import json,os,sys,time\nvalue=json.load(sys.stdin)\nrun=value['id']\n" +
					"def record(phase):\n fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)\n os.write(fd,(json.dumps({'id':run,'phase':phase,'at':time.monotonic()})+'\\n').encode())\n os.close(fd)\n" +
					"record('start')\ntime.sleep(0.25)\nrecord('finish')\nprint('Controlled subprocess completed '+run)\n"
				argv, _ := json.Marshal([]string{"python3", commandFile, journal})
				for path, body := range map[string][]byte{tokenFile: []byte(token), argvFile: argv, commandFile: []byte(commandSource)} {
					if err := os.WriteFile(path, body, 0600); err != nil {
						t.Fatal(err)
					}
				}
				logFile, err := os.Create(filepath.Join(temp, "reference.log"))
				if err != nil {
					t.Fatal(err)
				}
				command := exec.Command("python3", filepath.Join(exampleDir, "executor.py"), "--bind", bind, "--port", "0", "--data-dir", filepath.Join(temp, "reference"), "--token-file", tokenFile, "--argv-file", argvFile, "--workers", "4", "--timeout", "5", "--ready-file", readyFile)
				command.Stdout, command.Stderr = logFile, logFile
				command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
				if err := command.Start(); err != nil {
					logFile.Close()
					t.Fatal(err)
				}
				exit := make(chan error, 1)
				go func() { exit <- command.Wait() }()
				t.Cleanup(func() {
					app.cancel()
					app.workers.Wait()
					_ = command.Process.Signal(syscall.SIGTERM)
					select {
					case <-exit:
					case <-time.After(3 * time.Second):
						_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
						<-exit
					}
					logFile.Close()
				})
				var ready struct {
					Endpoint string `json:"endpoint"`
					PID      int    `json:"pid"`
				}
				startupDeadline := time.Now().Add(5 * time.Second)
				for ready.Endpoint == "" && time.Now().Before(startupDeadline) {
					raw, err := os.ReadFile(readyFile)
					if err == nil {
						if err = json.Unmarshal(raw, &ready); err != nil {
							t.Fatal(err)
						}
						break
					}
					if !os.IsNotExist(err) {
						t.Fatal(err)
					}
					time.Sleep(20 * time.Millisecond)
				}
				if ready.Endpoint == "" || ready.PID != command.Process.Pid {
					t.Fatal("reference executor did not become ready")
				}
				executors := make([]string, resources)
				for i := range executors {
					executors[i] = newID()
					owner.ok("POST", base+"/executors", map[string]any{
						"id": executors[i], "name": fmt.Sprintf("Capacity resource %d", i),
						"endpoint": ready.Endpoint, "allowPrivateNetwork": true, "enabled": true,
						"resourceKey":         "perf:" + space + ":" + strconv.Itoa(i),
						"pollIntervalSeconds": 2, "timeoutSeconds": 30, "secret": map[string]any{"bearerToken": token},
					})
				}
				const total = 12
				itemIDs, executionIDs := make([]string, total), make([]string, total)
				resourceForExecution := map[string]int{}
				for i := 0; i < total; i++ {
					itemIDs[i], executionIDs[i] = newID(), newID()
					resourceForExecution[executionIDs[i]] = i % resources
					owner.ok("POST", base+"/items", map[string]any{"id": itemIDs[i], "title": fmt.Sprintf("Fixed-command load %02d", i)})
				}
				outbound := &workPerfOutboundStats{methods: map[string]int{}, statuses: map[int]int{}}
				app.config.workExecutorClientFactory = func(private bool) *http.Client {
					client := app.newOutboundIntegrationHTTPClient(private)
					if client.Transport == nil {
						panic("expected configured production outbound transport")
					}
					client.Transport = &workPerfOutboundTransport{base: client.Transport, stats: outbound}
					return client
				}
				ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
				defer cancel()
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
				referenceCPU, childCPU, referenceRSS := workPerfExternalCPU(t, ready.PID, ticks)
				cpuBefore, rssBefore := schedulePerfCPU(t), schedulePerfRSS(t)
				start := time.Now()
				stopReads, waitReads := workSustainedReaders(call, base, 0)
				jobs, samples := make(chan int), make(chan workCapacitySample, total)
				var senders sync.WaitGroup
				for i := 0; i < 8; i++ {
					senders.Add(1)
					go func() {
						defer senders.Done()
						for index := range jobs {
							body, _ := json.Marshal(map[string]any{"id": executionIDs[index], "executorId": executors[index%resources], "itemId": itemIDs[index], "expectedItemRevision": "1"})
							samples <- call("POST", base+"/executions", body)
						}
					}()
				}
				for i := 0; i < total; i++ {
					jobs <- i
				}
				close(jobs)
				senders.Wait()
				close(samples)
				admission := schedulePerfSamples(samples)
				admissionSeconds := time.Since(start).Seconds()
				maxQueued, maxHeld, stateObservations := 0, 0, 0
				states := map[string]int{}
				var observeErr error
				for {
					rows, err := app.store.DB.QueryContext(ctx, app.store.Query("SELECT state,COUNT(*) FROM work_executions WHERE space_id=? GROUP BY state"), space)
					if err != nil {
						observeErr = err
						break
					}
					states = map[string]int{}
					for rows.Next() {
						var state string
						var n int
						if err = rows.Scan(&state, &n); err != nil {
							break
						}
						states[state] = n
					}
					if err == nil {
						err = rows.Err()
					}
					rows.Close()
					if err != nil {
						observeErr = err
						break
					}
					stateObservations++
					maxQueued = max(maxQueued, states["queued"])
					maxHeld = max(maxHeld, states["dispatching"]+states["running"]+states["unknown"])
					terminal := states["succeeded"] + states["failed"] + states["canceled"]
					if terminal == total || states["unknown"] > 0 {
						break
					}
					select {
					case <-ctx.Done():
						observeErr = ctx.Err()
					case <-time.After(100 * time.Millisecond):
					}
					if observeErr != nil {
						break
					}
				}
				activeSeconds := time.Since(start).Seconds()
				close(stopReads)
				reads := waitReads()
				cpuSeconds, rssAfter := schedulePerfCPU(t)-cpuBefore, schedulePerfRSS(t)
				referenceAfter, childrenAfter, referenceRSSAfter := workPerfExternalCPU(t, ready.PID, ticks)
				row := map[string]any{
					"provider": provider, "resources": resources, "executions": total, "referenceCommandSeconds": 0.25,
					"referenceWorkers": 4, "homeWorkers": 4, "pollIntervalSeconds": 2, "activeWindowSeconds": activeSeconds,
					"admission": admission, "admissionSeconds": admissionSeconds, "admissionConcurrency": 8,
					"terminalStates": states, "maximumObservedQueued": maxQueued, "maximumObservedHeld": maxHeld,
					"stateObservationQueries": stateObservations, "stateObservationIntervalMs": 100,
					"ordinaryItemsBefore": 1012, "ordinaryReadsWithoutExecutions": control, "ordinaryReadControlSeconds": controlSeconds,
					"ordinaryReadsDuringExecutions": reads, "testProcessCPUSeconds": cpuSeconds,
					"testProcessRSSBeforeKiB": rssBefore, "testProcessRSSAfterKiB": rssAfter,
					"referenceServerCPUSeconds": referenceAfter - referenceCPU, "referenceWaitedSubprocessCPUSeconds": childrenAfter - childCPU,
					"referenceRSSBeforeKiB": referenceRSS, "referenceRSSAfterKiB": referenceRSSAfter,
					"outboundHTTP": outbound.snapshot(),
				}
				rows, err := app.store.DB.QueryContext(ctx, app.store.Query("SELECT created_at,started_at,finished_at FROM work_executions WHERE space_id=?"), space)
				if err != nil {
					t.Fatal(err)
				}
				queueTimes, totalTimes := []float64{}, []float64{}
				for rows.Next() {
					var created, started, finished string
					if err = rows.Scan(&created, &started, &finished); err != nil {
						rows.Close()
						t.Fatal(err)
					}
					c, err := time.Parse(time.RFC3339Nano, created)
					if err != nil {
						rows.Close()
						t.Fatal(err)
					}
					if started != "" {
						s, err := time.Parse(time.RFC3339Nano, started)
						if err != nil {
							rows.Close()
							t.Fatal(err)
						}
						queueTimes = append(queueTimes, float64(s.Sub(c).Microseconds())/1000)
					}
					if finished != "" {
						f, err := time.Parse(time.RFC3339Nano, finished)
						if err != nil {
							rows.Close()
							t.Fatal(err)
						}
						totalTimes = append(totalTimes, float64(f.Sub(c).Microseconds())/1000)
					}
				}
				err = rows.Err()
				rows.Close()
				if err != nil {
					t.Fatal(err)
				}
				row["queueWait"], row["executionEndToEnd"] = schedulePerfQuantiles(queueTimes), schedulePerfQuantiles(totalTimes)
				type observedCommand struct {
					ID    string  `json:"id"`
					Phase string  `json:"phase"`
					At    float64 `json:"at"`
				}
				raw, err := os.ReadFile(journal)
				if err != nil && !os.IsNotExist(err) {
					t.Fatal(err)
				}
				observations := []observedCommand{}
				for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
					if line == "" {
						continue
					}
					var observation observedCommand
					if err := json.Unmarshal([]byte(line), &observation); err != nil {
						t.Fatal(err)
					}
					observations = append(observations, observation)
				}
				sort.Slice(observations, func(i, j int) bool { return observations[i].At < observations[j].At })
				starts, finishes := map[string]int{}, map[string]int{}
				activeByResource, maximumByResource := map[int]int{}, map[int]int{}
				activeCommands, maximumCommands := 0, 0
				for _, observation := range observations {
					resource, ok := resourceForExecution[observation.ID]
					if !ok {
						t.Fatal("unexpected reference subprocess id")
					}
					switch observation.Phase {
					case "start":
						starts[observation.ID]++
						activeCommands++
						activeByResource[resource]++
						maximumCommands = max(maximumCommands, activeCommands)
						maximumByResource[resource] = max(maximumByResource[resource], activeByResource[resource])
					case "finish":
						finishes[observation.ID]++
						activeCommands--
						activeByResource[resource]--
					default:
						t.Fatal("unexpected reference subprocess phase")
					}
				}
				row["referenceSubprocessStarts"], row["referenceSubprocessFinishes"] = len(starts), len(finishes)
				row["maximumConcurrentSubprocesses"], row["maximumSubprocessesPerResource"] = maximumCommands, maximumByResource
				results = append(results, row)
				encoded, _ := json.Marshal(row)
				t.Log(string(encoded))
				if observeErr != nil || admission["errorCount"].(int) != 0 || schedulePerfReadErrors(reads) != 0 || states["succeeded"] != total || len(starts) != total || len(finishes) != total || activeCommands != 0 || maximumCommands > resources || outbound.maxActive > 4 || outbound.methods["POST"] != total || outbound.errors != 0 {
					t.Fatalf("real executor workload failed: observeErr=%v row=%v", observeErr, row)
				}
				for _, id := range executionIDs {
					if starts[id] != 1 || finishes[id] != 1 {
						t.Fatalf("reference command was not executed exactly once: starts=%d finishes=%d", starts[id], finishes[id])
					}
				}
				for resource, maxActive := range maximumByResource {
					if maxActive != 1 {
						t.Fatalf("resource %d ran %d subprocesses at once", resource, maxActive)
					}
				}
			})
		}
	}
	if file := os.Getenv("LINGSHU_WORK_EXECUTOR_CAPACITY_V028_OUTPUT"); file != "" {
		encoded, err := json.MarshalIndent(map[string]any{
			"method":  "Actual Home worker plus private-network reference HTTP executor and fixed Python subprocess; 12 executions per case, production minimum 2-second receipt polling, four resources versus one shared resource; four ordinary HTTP readers remain active until all terminal or first unknown/deadline boundary; process CPU scopes recorded separately and PostgreSQL server excluded; bounded load, not maximum capacity or SLA",
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
