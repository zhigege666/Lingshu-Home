package home

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

// Only the private Config hook routes a validated fixture endpoint to the real
// local HTTP server. Production URL validation and the production dialer have
// separate security coverage; this transport exercises HTTP framing and I/O.
type workerTestTransport struct {
	target *url.URL
	base   *http.Transport
}

func (tr *workerTestTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	target := *r.URL
	target.Scheme = tr.target.Scheme
	target.Host = tr.target.Host
	clone.URL = &target
	clone.Host = target.Host
	return tr.base.RoundTrip(clone)
}
func (tr *workerTestTransport) CloseIdleConnections() { tr.base.CloseIdleConnections() }
func workerTestHTTP(t *testing.T, a *App, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(h)
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	transport := &workerTestTransport{target, http.DefaultTransport.(*http.Transport).Clone()}
	a.config.workExecutorClientFactory = func(bool) *http.Client { return &http.Client{Transport: transport} }
	t.Cleanup(func() { server.Close(); transport.CloseIdleConnections() })
	return server
}
func workerTestFixture(t *testing.T, provider string) *workStatusFixture {
	t.Helper()
	f := newWorkStatusFixture(t, provider)
	f.app.cancel()
	f.app.workers.Wait()
	f.app.ctx, f.app.cancel = context.WithCancel(context.Background())
	if err := f.app.initializeNetworkProxy(); err != nil {
		t.Fatal(err)
	}
	return f
}
func workerTestExecutor(t *testing.T, f *workStatusFixture, resource string) map[string]any {
	t.Helper()
	return automationObject(f.owner.ok("POST", f.base+"/executors", map[string]any{"id": newID(), "name": "HTTP fixture " + resource, "endpoint": "https://executor.example.com", "resourceKey": resource, "enabled": true, "pollIntervalSeconds": 2, "timeoutSeconds": 30, "secret": map[string]any{"bearerToken": "fixture-executor-secret"}}), "executor")
}
func workerTestQueue(t *testing.T, f *workStatusFixture, executor map[string]any, title string) (map[string]any, *WorkExecution) {
	t.Helper()
	item := f.owner.ok("POST", f.base+"/items", map[string]any{"requestId": newID(), "title": title})
	v := automationObject(f.owner.ok("POST", f.base+"/executions", map[string]any{"id": newID(), "executorId": executor["id"], "itemId": item["id"], "expectedItemRevision": item["revision"]}), "execution")
	return item, workerTestLoad(t, f.app, v["id"].(string))
}
func workerTestLoad(t *testing.T, a *App, id string) *WorkExecution {
	t.Helper()
	v, err := scanWorkExecution(a.store.DB.QueryRow(a.store.Query("SELECT "+workExecutionColumns+" FROM work_executions WHERE id=?"), id))
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func workerTestRun(t *testing.T, a *App, id string) *WorkExecution {
	t.Helper()
	if err, exhausted := a.runWorkExecution(context.Background(), id); err != nil || exhausted {
		t.Fatalf("execution worker: %v (exhausted=%v)", err, exhausted)
	}
	return workerTestLoad(t, a, id)
}
func workerTestPollDue(t *testing.T, a *App, id string) {
	t.Helper()
	if _, err := a.store.DB.Exec(a.store.Query("UPDATE work_executions SET next_poll_at=? WHERE id=?"), workScheduleStamp(time.Now().Add(-time.Second)), id); err != nil {
		t.Fatal(err)
	}
}
func workerTestWait(t *testing.T, what string, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if ready() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out waiting for " + what)
}
func workerTestReceive(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(8 * time.Second):
		t.Fatal("timed out waiting for " + what)
	}
}
func workerTestReply(w http.ResponseWriter, id, state, result, message string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"id": id, "state": state, "result": result, "message": message})
}
func workerTestRequestID(r *http.Request) string {
	if r.Method == http.MethodPost {
		return r.Header.Get("Idempotency-Key")
	}
	return strings.TrimPrefix(r.URL.Path, "/runs/")
}

func TestWorkExecutorHTTPProtocol(t *testing.T) {
	id := newID()
	token := "protocol-test-secret"
	cases := []struct {
		name           string
		status         int
		body, encoding string
		state, code    string
	}{
		{"running", 202, `{"id":"` + id + `","state":"running","result":"","message":"Accepted"}`, "", "running", ""},
		{"succeeded", 200, `{"id":"` + id + `","state":"succeeded","result":"Done","message":""}`, "", "succeeded", ""},
		{"failed", 200, `{"id":"` + id + `","state":"failed","result":"","message":"Task failed"}`, "", "failed", "executor_failed"},
		{"unknown", 200, `{"id":"` + id + `","state":"unknown","result":"","message":"Lost receipt"}`, "", "unknown", "executor_unknown"},
		{"rejected", 429, "busy", "", "failed", "executor_http_429"},
		{"unauthorized", 401, "denied", "", "failed", "executor_http_401"},
		{"ambiguous-timeout", 408, "timeout", "", "unknown", "executor_http_408"},
		{"existing-different-content", 409, "existing run", "", "unknown", "executor_http_409"},
		{"server-failure", 500, "internal", "", "unknown", "executor_http_500"},
		{"redirect", 302, "redirect", "", "unknown", "executor_http_302"},
		{"missing-required", 200, `{"id":"` + id + `","state":"succeeded"}`, "", "unknown", "executor_invalid_response"},
		{"wrong-identity", 200, `{"id":"other","state":"succeeded","result":"","message":""}`, "", "unknown", "executor_invalid_response"},
		{"extra-property", 200, `{"id":"` + id + `","state":"succeeded","result":"","message":"","secret":"extra"}`, "", "unknown", "executor_invalid_response"},
		{"malformed", 200, `{"id":`, "", "unknown", "executor_invalid_response"},
		{"trailing-json", 200, `{"id":"` + id + `","state":"succeeded","result":"","message":""} {}`, "", "unknown", "executor_invalid_response"},
		{"compressed", 200, "compressed body", "gzip", "unknown", "executor_encoding_unsupported"},
		{"oversized", 200, strings.Repeat("x", (64<<10)+1), "", "unknown", "executor_response_incomplete_or_large"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := &App{}
			var requests atomic.Int32
			var requestErr atomic.Value
			workerTestHTTP(t, a, func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				body, _ := io.ReadAll(r.Body)
				if r.Method != "POST" || r.URL.Path != "/runs" || r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Idempotency-Key") != id || string(body) != `{"id":"`+id+`"}` {
					requestErr.Store("dispatch headers or immutable body changed")
				}
				w.Header().Set("Location", "https://another.example/runs")
				if tc.encoding != "" {
					w.Header().Set("Content-Encoding", tc.encoding)
				}
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			})
			job := &workAutomationJob{execution: WorkExecution{ID: id, State: "dispatching", DeadlineAt: workScheduleStamp(time.Now().Add(time.Minute)), snapshotJSON: `{"id":"` + id + `"}`}, executor: WorkExecutor{Endpoint: "https://executor.example.com", PollIntervalSeconds: 2}, method: http.MethodPost, token: token}
			out := a.callWorkExecutor(context.Background(), job)
			if out.state != tc.state || out.code != tc.code {
				t.Fatalf("outcome=%+v want %s/%s", out, tc.state, tc.code)
			}
			if requests.Load() != 1 || requestErr.Load() != nil {
				t.Fatal("invalid or repeated POST", requests.Load(), requestErr.Load())
			}
		})
	}
	t.Run("unicode-and-secret-bound", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"id": id, "state": "failed", "result": token + strings.Repeat("界", 5000), "message": token + strings.Repeat("错", 1500)})
		state, result, message, err := workExecutorResponse(body, id, token)
		if err != nil || state != "failed" || utf8.RuneCountInString(result) != 4000 || utf8.RuneCountInString(message) != 1000 || strings.Contains(result, token) || strings.Contains(message, token) || !strings.HasSuffix(result, " [truncated]") {
			t.Fatal("response bounds/redaction failed", err)
		}
	})
	t.Run("deadline-and-unreachable", func(t *testing.T) {
		a := &App{}
		server := workerTestHTTP(t, a, func(w http.ResponseWriter, r *http.Request) { workerTestReply(w, id, "succeeded", "", "") })
		server.Close()
		job := &workAutomationJob{execution: WorkExecution{ID: id, State: "dispatching", DeadlineAt: workScheduleStamp(time.Now().Add(time.Minute)), snapshotJSON: `{}`}, executor: WorkExecutor{Endpoint: "https://executor.example.com"}, method: http.MethodPost}
		if out := a.callWorkExecutor(context.Background(), job); out.state != "unknown" || out.code != "executor_unreachable" {
			t.Fatal(out)
		}
		job.execution.DeadlineAt = workScheduleStamp(time.Now().Add(-time.Second))
		if out := a.callWorkExecutor(context.Background(), job); out.state != "unknown" {
			t.Fatal("elapsed dispatch fabricated a rejection", out)
		}
	})
}

func TestWorkExecutionResourceReadbackAndNotices(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := workerTestFixture(t, provider)
			a := f.app
			var posts, gets atomic.Int32
			var mode atomic.Int32
			workerTestHTTP(t, a, func(w http.ResponseWriter, r *http.Request) {
				id := workerTestRequestID(r)
				if r.Method == "POST" {
					n := posts.Add(1)
					if n == 1 {
						workerTestReply(w, id, "unknown", strings.Repeat("界", 4500), "fixture-executor-secret"+strings.Repeat("错", 1200))
						return
					}
					workerTestReply(w, id, "running", "", "")
					return
				}
				gets.Add(1)
				if mode.Load() == 1 {
					w.WriteHeader(404)
					return
				}
				workerTestReply(w, id, "succeeded", "Recorded result", "")
			})
			noticeSettings := f.owner.ok("GET", f.base+"/notifications/settings", nil)
			f.owner.ok("PATCH", f.base+"/notifications/settings", map[string]any{"expectedRevision": noticeSettings["revision"], "enabled": true})
			executor := workerTestExecutor(t, f, "shared-resource")
			firstItem, first := workerTestQueue(t, f, executor, "First resource holder")
			first = workerTestRun(t, a, first.ID)
			if first.State != "unknown" || first.NextPollAt != "" || utf8.RuneCountInString(first.Result) != 4000 || utf8.RuneCountInString(first.Message) != 1000 || strings.Contains(first.Message, "fixture-executor-secret") {
				t.Fatal("unknown receipt was not safely durable", first)
			}
			notices := f.owner.ok("GET", f.base+"/notifications", nil)["items"].([]any)
			if len(notices) != 1 || notices[0].(map[string]any)["kind"] != "execution_unknown" || utf8.RuneCountInString(notices[0].(map[string]any)["message"].(string)) > 500 {
				t.Fatal("bounded failure notification missing", notices)
			}
			// Resource locks are global, including different spaces/executor records.
			other := &workStatusFixture{app: a, owner: f.owner, space: f.personal, base: "/spaces/" + f.personal + "/work"}
			otherExecutor := workerTestExecutor(t, other, "shared-resource")
			secondItem, second := workerTestQueue(t, other, otherExecutor, "Second space waits")
			if got := workerTestRun(t, a, second.ID); got.State != "queued" {
				t.Fatal("unknown released the global resource", got)
			}
			events, ids, next, err := a.workAutomationDue(context.Background(), time.Now(), 4, nil)
			if err != nil || len(events) != 0 || len(ids) != 0 || !next.IsZero() {
				t.Fatal("blocked resource created automatic polling", events, ids, next, err)
			}
			workerTestRun(t, a, first.ID)
			if posts.Load() != 1 || gets.Load() != 0 {
				t.Fatal("unknown execution retried without reconciliation")
			}
			f.owner.ok("POST", f.base+"/executions/"+first.ID+"/reconcile", map[string]any{"expectedRevision": first.Revision})
			if got := workerTestRun(t, a, first.ID); got.State != "succeeded" {
				t.Fatal("read-only reconciliation failed", got)
			}
			second = workerTestRun(t, a, second.ID)
			if second.State != "running" || posts.Load() != 2 || gets.Load() != 1 {
				t.Fatal("released resource did not dispatch exactly once", second)
			}
			// Disabling an executor prohibits new work but preserves readback of accepted runs.
			other.owner.ok("PATCH", other.base+"/executors/"+otherExecutor["id"].(string), map[string]any{"expectedRevision": otherExecutor["revision"], "enabled": false})
			mode.Store(1)
			for attempt := 1; attempt <= 3; attempt++ {
				workerTestPollDue(t, a, second.ID)
				second = workerTestRun(t, a, second.ID)
				if second.pollFailures != attempt {
					t.Fatal("GET failures did not advance bounded counter", second)
				}
				if attempt < 3 && (second.State != "running" || second.NextPollAt == "") {
					t.Fatal("readback stopped early", second)
				}
			}
			if second.State != "unknown" || second.NextPollAt != "" || posts.Load() != 2 || gets.Load() != 4 {
				t.Fatal("three failed GETs did not stop safely", second, posts.Load(), gets.Load())
			}
			workerTestRun(t, a, second.ID)
			if gets.Load() != 4 {
				t.Fatal("unknown kept polling without explicit reconciliation")
			}
			if _, err = a.store.DB.Exec(a.store.Query("UPDATE work_executions SET deadline_at=? WHERE id=?"), workScheduleStamp(time.Now().Add(-time.Minute)), second.ID); err != nil {
				t.Fatal(err)
			}
			mode.Store(0)
			other.owner.ok("POST", other.base+"/executions/"+second.ID+"/reconcile", map[string]any{"expectedRevision": second.Revision})
			second = workerTestRun(t, a, second.ID)
			if second.State != "succeeded" || posts.Load() != 2 || gets.Load() != 5 {
				t.Fatal("expired unknown was not reconciled by GET", second)
			}
			for _, entry := range []struct {
				space string
				item  map[string]any
			}{{f.space, firstItem}, {f.personal, secondItem}} {
				current := f.owner.ok("GET", workItemPath(entry.space, entry.item["id"].(string)), nil)
				if current["status"] != "todo" || current["revision"] != entry.item["revision"] || current["result"] != "" {
					t.Fatal("external receipt silently completed or edited work", current)
				}
			}
		})
	}
}

func TestWorkExecutionAuthorityAndClaimAtDispatch(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := workerTestFixture(t, provider)
			a := f.app
			var posts, gets atomic.Int32
			var acceptedRunning atomic.Bool
			workerTestHTTP(t, a, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" {
					posts.Add(1)
				} else {
					gets.Add(1)
				}
				state := "succeeded"
				if acceptedRunning.Load() {
					state = "running"
				}
				workerTestReply(w, workerTestRequestID(r), state, "", "")
			})
			executor := workerTestExecutor(t, f, "auth-resource")
			item, stale := workerTestQueue(t, f, executor, "Changed while queued")
			f.owner.ok("PATCH", workItemPath(f.space, item["id"].(string)), map[string]any{"expectedRevision": item["revision"], "nextStep": "New instructions"})
			if got := workerTestRun(t, a, stale.ID); got.State != "failed" || got.Code != "work_item_version_conflict" {
				t.Fatal("stale item was dispatched", got)
			}
			a.config.MCPCollaborationEnabled = true
			auth := &integrationTestBrowser{t: t, base: f.owner.base, client: f.owner.client, csrf: f.owner.csrf}
			token, tokenID := auth.token(f.space, "", "work:read", "work:write", "work:execute")
			cf := &collabCoreFixture{f, integrationBrowser(t, f.owner.base), token}
			session := cf.session("Real executor caller")
			queueClaimed := func(title string) (map[string]any, map[string]any, *WorkExecution) {
				item := cf.item(title)
				claim := cf.claim(item, session)
				receipt := automationObject(cf.call("POST", f.base+"/executions", map[string]any{"id": newID(), "executorId": executor["id"], "itemId": item["id"], "expectedItemRevision": item["revision"], "context": collabCoreContext(session, claim)}, 200), "execution")
				return item, claim, workerTestLoad(t, a, receipt["id"].(string))
			}
			completed, claim, execution := queueClaimed("Claim remains after execution")
			execution = workerTestRun(t, a, execution.ID)
			if execution.State != "succeeded" {
				t.Fatal(execution)
			}
			current := f.owner.ok("GET", workItemPath(f.space, completed["id"].(string)), nil)
			collaboration := current["collaboration"].(map[string]any)
			if current["status"] != "todo" || current["revision"] != completed["revision"] || collaboration["generation"] != claim["generation"] {
				t.Fatal("successful receipt altered business work or claim", current)
			}
			var released string
			if err := a.store.DB.QueryRow(a.store.Query("SELECT released_at FROM work_claims WHERE item_id=?"), completed["id"]).Scan(&released); err != nil || released != "" {
				t.Fatal("worker released the claim", released, err)
			}
			expired, _, expiredExecution := queueClaimed("Claim expires before dispatch")
			cf.expire(t, expired["id"].(string))
			expiredExecution = workerTestRun(t, a, expiredExecution.ID)
			if expiredExecution.State != "failed" || !strings.HasPrefix(expiredExecution.Code, "work_claim_") {
				t.Fatal("expired claim was bypassed", expiredExecution)
			}
			_, _, revoked := queueClaimed("Principal revoked before dispatch")
			if _, err := a.store.DB.Exec(a.store.Query("UPDATE integration_tokens SET revoked_at=? WHERE id=?"), nowUTC(), tokenID); err != nil {
				t.Fatal(err)
			}
			revoked = workerTestRun(t, a, revoked.ID)
			if revoked.State != "failed" || !strings.Contains(revoked.Code, "unauthorized") {
				t.Fatal("revoked queued principal dispatched", revoked)
			}
			if posts.Load() != 1 || gets.Load() != 0 {
				t.Fatal("rejected queue paths made HTTP requests", posts.Load(), gets.Load())
			}
			// A revoked in-flight principal cannot authorize a new readback. Its outcome
			// remains unknown, and the occupied resource is retained for explicit recovery.
			token, tokenID = auth.token(f.space, "", "work:read", "work:write", "work:execute")
			cf.token = token
			session = cf.session("Replacement authorized caller")
			_, _, running := queueClaimed("Readback requires current authority")
			acceptedRunning.Store(true)
			running = workerTestRun(t, a, running.ID)
			if running.State != "running" {
				t.Fatal(running)
			}
			if _, err := a.store.DB.Exec(a.store.Query("UPDATE integration_tokens SET revoked_at=? WHERE id=?"), nowUTC(), tokenID); err != nil {
				t.Fatal(err)
			}
			workerTestPollDue(t, a, running.ID)
			running = workerTestRun(t, a, running.ID)
			if running.State != "unknown" || running.NextPollAt != "" || posts.Load() != 2 || gets.Load() != 0 {
				t.Fatal("in-flight authority loss was treated as safe completion", running)
			}
		})
	}
}

func TestWorkExecutionHTTPOutsideTransactionAndLateCAS(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := workerTestFixture(t, provider)
			a := f.app
			postEntered, postRelease, getEntered, getRelease := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
			var postOnce, getOnce, postReleaseOnce, getReleaseOnce sync.Once
			var phase atomic.Int32
			releasePost := func() { postReleaseOnce.Do(func() { close(postRelease) }) }
			releaseGet := func() { getReleaseOnce.Do(func() { close(getRelease) }) }
			defer releasePost()
			defer releaseGet()
			workerTestHTTP(t, a, func(w http.ResponseWriter, r *http.Request) {
				id := workerTestRequestID(r)
				if phase.Load() == 0 {
					postOnce.Do(func() { close(postEntered) })
					<-postRelease
					workerTestReply(w, id, "succeeded", "Trusted receipt after module change", "")
					return
				}
				if r.Method == "POST" {
					workerTestReply(w, id, "unknown", "", "Uncertain first response")
					return
				}
				getOnce.Do(func() { close(getEntered) })
				<-getRelease
				workerTestReply(w, id, "succeeded", "Late external readback", "")
			})
			executor := workerTestExecutor(t, f, "blocked-http")
			_, first := workerTestQueue(t, f, executor, "Module changes during HTTP")
			unrelated := f.owner.ok("POST", f.base+"/items", map[string]any{"requestId": newID(), "title": "Unrelated writer"})
			result := make(chan error, 1)
			go func() { err, _ := a.runWorkExecution(context.Background(), first.ID); result <- err }()
			workerTestReceive(t, postEntered, "accepted HTTP request")
			// These writes have a short real deadline; an HTTP call holding the write gate
			// would fail here rather than pass after the external response is released.
			oldTimeout := f.owner.client.Timeout
			f.owner.client.Timeout = 2 * time.Second
			f.owner.ok("PATCH", workItemPath(f.space, unrelated["id"].(string)), map[string]any{"expectedRevision": unrelated["revision"], "nextStep": "Write while HTTP waits"})
			moduleTestUpdate(t, f.owner, map[string]any{"work": false})
			f.owner.client.Timeout = oldTimeout
			releasePost()
			select {
			case err := <-result:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(8 * time.Second):
				t.Fatal("trusted receipt did not persist")
			}
			if got := workerTestLoad(t, a, first.ID); got.State != "succeeded" {
				t.Fatal("module toggle discarded a trusted in-flight receipt", got)
			}
			events, ids, next, err := a.workAutomationDue(context.Background(), time.Now(), 4, nil)
			if err != nil || len(events) != 0 || len(ids) != 0 || !next.IsZero() {
				t.Fatal("disabled module retained worker timers", err)
			}
			moduleTestUpdate(t, f.owner, map[string]any{"work": true})
			phase.Store(1)
			_, second := workerTestQueue(t, f, executor, "Explicit resolution wins")
			second = workerTestRun(t, a, second.ID)
			f.owner.ok("POST", f.base+"/executions/"+second.ID+"/reconcile", map[string]any{"expectedRevision": second.Revision})
			second = workerTestLoad(t, a, second.ID)
			go func() { err, _ := a.runWorkExecution(context.Background(), second.ID); result <- err }()
			workerTestReceive(t, getEntered, "readback GET")
			resolved := automationObject(f.owner.ok("POST", f.base+"/executions/"+second.ID+"/resolve", map[string]any{"expectedRevision": second.Revision, "outcome": "failed", "externalStoppedConfirmed": true, "note": "Verified external process stopped; retain manual decision"}), "execution")
			releaseGet()
			select {
			case err := <-result:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(8 * time.Second):
				t.Fatal("late GET failed to return")
			}
			got := workerTestLoad(t, a, second.ID)
			if got.State != "failed" || !got.ManualResolution || got.Revision != resolved["revision"] || got.Result != "" {
				t.Fatal("late GET overwrote explicit resolution", got)
			}
		})
	}
}

func TestWorkExecutionRestartDoesNotRedispatch(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := workerTestFixture(t, provider)
			a := f.app
			var posts, gets atomic.Int32
			workerTestHTTP(t, a, func(w http.ResponseWriter, r *http.Request) {
				id := workerTestRequestID(r)
				if r.Method == "GET" {
					gets.Add(1)
					workerTestReply(w, id, "succeeded", "Recovered receipt", "")
					return
				}
				n := posts.Add(1)
				state := "running"
				if n == 2 {
					state = "unknown"
				}
				workerTestReply(w, id, state, "", "")
			})
			executorA := workerTestExecutor(t, f, "interrupted-resource")
			_, interrupted := workerTestQueue(t, f, executorA, "Dispatch intent persisted")
			job, err := a.prepareWorkExecution(context.Background(), interrupted.ID)
			if err != nil || job == nil || job.method != "POST" {
				t.Fatal("failed to stage dispatch", err)
			}
			_, blocked := workerTestQueue(t, f, executorA, "Wait for interrupted owner")
			executorB := workerTestExecutor(t, f, "running-resource")
			_, running := workerTestQueue(t, f, executorB, "Accepted before restart")
			running = workerTestRun(t, a, running.ID)
			executorC := workerTestExecutor(t, f, "unknown-resource")
			_, unknown := workerTestQueue(t, f, executorC, "Unknown before restart")
			unknown = workerTestRun(t, a, unknown.ID)
			if running.State != "running" || unknown.State != "unknown" {
				t.Fatal("invalid restart fixture")
			}
			config := a.config
			if err = a.Close(); err != nil {
				t.Fatal(err)
			}
			a.store = nil
			reopened, err := Open(config)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			workerTestWait(t, "running receipt recovery", func() bool { return workerTestLoad(t, reopened, running.ID).State == "succeeded" })
			interrupted = workerTestLoad(t, reopened, interrupted.ID)
			unknown = workerTestLoad(t, reopened, unknown.ID)
			blocked = workerTestLoad(t, reopened, blocked.ID)
			if interrupted.State != "unknown" || interrupted.Code != "dispatch_interrupted" || interrupted.NextPollAt != "" || unknown.State != "unknown" || unknown.NextPollAt != "" || blocked.State != "queued" {
				t.Fatal("restart reconstructed an uncertain dispatch", interrupted, unknown, blocked)
			}
			if posts.Load() != 2 || gets.Load() != 1 {
				t.Fatal("restart reposted or repeatedly polled an unknown execution", posts.Load(), gets.Load())
			}
			events, ids, next, err := reopened.workAutomationDue(context.Background(), time.Now(), 4, nil)
			if err != nil || len(events) != 0 || len(ids) != 0 || !next.IsZero() {
				t.Fatal("unknown/blocked queue has a wake timer", events, ids, next, err)
			}
		})
	}
}

func TestWorkAutomationWorkerConcurrencyAndScheduleWake(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := workerTestFixture(t, provider)
			a := f.app
			release := make(chan struct{})
			var releaseOnce sync.Once
			defer releaseOnce.Do(func() { close(release) })
			var active, maximum, posts atomic.Int32
			entered := make(chan struct{}, 8)
			workerTestHTTP(t, a, func(w http.ResponseWriter, r *http.Request) {
				n := active.Add(1)
				defer active.Add(-1)
				for old := maximum.Load(); n > old && !maximum.CompareAndSwap(old, n); old = maximum.Load() {
				}
				posts.Add(1)
				entered <- struct{}{}
				<-release
				workerTestReply(w, workerTestRequestID(r), "succeeded", "", "")
			})
			executions := []string{}
			for i := 0; i < 6; i++ {
				ex := workerTestExecutor(t, f, fmt.Sprintf("concurrent-%d", i))
				_, v := workerTestQueue(t, f, ex, fmt.Sprintf("HTTP slot %d", i))
				executions = append(executions, v.ID)
			}
			a.startWorkAutomationWorker()
			for i := 0; i < 4; i++ {
				workerTestReceive(t, entered, "one of four HTTP slots")
			}
			select {
			case <-entered:
				t.Fatal("worker exceeded four simultaneous HTTP requests")
			case <-time.After(100 * time.Millisecond):
			}
			f.owner.ok("GET", f.base+"/board", nil)
			releaseOnce.Do(func() { close(release) })
			workerTestWait(t, "all bounded HTTP workers", func() bool {
				for _, id := range executions {
					if workerTestLoad(t, a, id).State != "succeeded" {
						return false
					}
				}
				return true
			})
			if posts.Load() != 6 || maximum.Load() != 4 {
				t.Fatal("unexpected worker concurrency", posts.Load(), maximum.Load())
			}
			// Observe the real post-commit wake from both public manual generation and
			// the production schedule batch transaction. Do not call processEvent here.
			f.owner.ok("PATCH", f.base+"/automation/settings", map[string]any{"expectedRevision": "1", "enabled": true})
			f.owner.ok("POST", f.base+"/automation/rules", automationTestRule("Scheduled follow-up", "work.created"))
			manual := scheduleFromReply(f.owner.ok("POST", f.base+"/schedules", scheduleTestBody("Manual schedule source")))
			occurrence := occurrenceFromReply(f.owner.ok("POST", f.base+"/schedules/"+manual["id"].(string)+"/generate", map[string]any{"expectedRevision": "1", "businessDate": "2026-01-02"}))
			if occurrence["result"] != "created" {
				t.Fatal(occurrence)
			}
			receiptCount := func() int {
				var n int
				if err := a.store.DB.QueryRow("SELECT COUNT(*) FROM work_automation_receipts WHERE result='created'").Scan(&n); err != nil {
					t.Fatal(err)
				}
				return n
			}
			workerTestWait(t, "manual schedule event wake", func() bool { return receiptCount() == 1 })
			automatic := scheduleFromReply(f.owner.ok("POST", f.base+"/schedules", scheduleTestBody("Background schedule source")))
			date := time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")
			scheduled, ok := workScheduleDate(scheduleTestRule(), date)
			if !ok {
				t.Fatal("invalid schedule fixture")
			}
			if _, err := a.store.DB.Exec(a.store.Query("UPDATE work_schedules SET enabled=TRUE,next_run_at=? WHERE id=?"), scheduled.ScheduledAt, automatic["id"]); err != nil {
				t.Fatal(err)
			}
			// Allow finite initial scans caused by rule/schedule setup to settle, so the
			// only wake capable of processing this new event comes from the commit below.
			time.Sleep(50 * time.Millisecond)
			if err := a.processWorkSchedule(context.Background(), automatic["id"].(string), time.Now()); err != nil {
				t.Fatal(err)
			}
			workerTestWait(t, "background schedule event wake", func() bool { return receiptCount() == 2 })
			var followups, events int
			if err := a.store.DB.QueryRow("SELECT COUNT(*) FROM work_items WHERE title='Scheduled follow-up'").Scan(&followups); err != nil {
				t.Fatal(err)
			}
			if err := a.store.DB.QueryRow("SELECT COUNT(*) FROM work_automation_events WHERE event_type='work.created'").Scan(&events); err != nil {
				t.Fatal(err)
			}
			if followups != 2 || events != 2 {
				t.Fatal("schedule event was missing or recursively duplicated", followups, events)
			}
		})
	}
}

func TestWorkExecutionMasterOffAndPersistenceRecovery(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := workerTestFixture(t, provider)
			a := f.app
			var posts, gets atomic.Int32
			workerTestHTTP(t, a, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" {
					posts.Add(1)
				} else {
					gets.Add(1)
				}
				workerTestReply(w, workerTestRequestID(r), "succeeded", "Confirmed external result", "")
			})
			executor := workerTestExecutor(t, f, "persistence-resource")
			settings := f.owner.ok("PATCH", f.base+"/automation/settings", map[string]any{"expectedRevision": "1", "enabled": true})
			rule := automationTestRule("Event execution", "sync.finished")
			rule["executorId"] = executor["id"]
			f.owner.ok("POST", f.base+"/automation/rules", rule)
			event := automationObject(f.owner.ok("POST", f.base+"/automation/events", map[string]any{"id": newID(), "type": "sync.finished", "summary": "Real external completion"}), "event")
			if err := a.processWorkAutomationEventID(context.Background(), event["id"].(string)); err != nil {
				t.Fatal(err)
			}
			detail := f.owner.ok("GET", f.base+"/automation/events/"+event["id"].(string), nil)
			receipts := detail["receipts"].([]any)
			if len(receipts) != 1 || receipts[0].(map[string]any)["executionId"] == nil {
				t.Fatal("event did not queue execution", detail)
			}
			automaticID := receipts[0].(map[string]any)["executionId"].(string)
			settings = f.owner.ok("PATCH", f.base+"/automation/settings", map[string]any{"expectedRevision": settings["revision"], "enabled": false})
			if got := workerTestRun(t, a, automaticID); got.State != "canceled" || got.Code != "automation_disabled" {
				t.Fatal("master-off did not cancel undispatched event-derived work", got)
			}
			events, ids, next, err := a.workAutomationDue(context.Background(), time.Now(), 4, nil)
			if err != nil || len(events) != 0 || len(ids) != 0 || !next.IsZero() {
				t.Fatal("master-off event queue created a timer", events, ids, next, err)
			}
			_, manual := workerTestQueue(t, f, executor, "Explicit manual execution while master is off")
			if got := workerTestRun(t, a, manual.ID); got.State != "succeeded" || posts.Load() != 1 {
				t.Fatal("master switch incorrectly blocked explicit manual work", got)
			}
			f.owner.ok("PATCH", f.base+"/automation/settings", map[string]any{"expectedRevision": settings["revision"], "enabled": true})
			if got := workerTestRun(t, a, automaticID); got.State != "canceled" || posts.Load() != 1 {
				t.Fatal("reenabling replayed canceled work", got)
			}
			resumed := automationObject(f.owner.ok("POST", f.base+"/automation/events", map[string]any{"id": newID(), "type": "sync.finished", "summary": "A new event after enabling"}), "event")
			if err = a.processWorkAutomationEventID(context.Background(), resumed["id"].(string)); err != nil {
				t.Fatal(err)
			}
			resumedDetail := f.owner.ok("GET", f.base+"/automation/events/"+resumed["id"].(string), nil)
			resumedID := resumedDetail["receipts"].([]any)[0].(map[string]any)["executionId"].(string)
			if got := workerTestRun(t, a, resumedID); got.State != "succeeded" || posts.Load() != 2 {
				t.Fatal("new event execution did not dispatch after enabling", got)
			}
			// Abort the durable receipt after a real successful POST. Retrying storage
			// must not repeat the network operation; restart conservatively keeps unknown.
			_, failedWrite := workerTestQueue(t, f, executor, "Receipt write interrupted")
			trigger := "CREATE TRIGGER fail_execution_receipt BEFORE UPDATE ON work_executions WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'intentional execution receipt failure'); END"
			if provider == "postgres" {
				trigger = "CREATE FUNCTION fail_execution_receipt_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional execution receipt failure'; END $$; CREATE TRIGGER fail_execution_receipt BEFORE UPDATE ON work_executions FOR EACH ROW WHEN (NEW.state='succeeded') EXECUTE FUNCTION fail_execution_receipt_fn()"
			}
			if _, err = a.store.DB.Exec(trigger); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			err, exhausted := a.runWorkExecution(ctx, failedWrite.ID)
			cancel()
			if err == nil || !exhausted || posts.Load() != 3 || gets.Load() != 0 {
				t.Fatal("receipt failure repeated or lost the POST boundary", err, exhausted, posts.Load(), gets.Load())
			}
			if got := workerTestLoad(t, a, failedWrite.ID); got.State != "dispatching" {
				t.Fatal("failed transaction partially wrote a receipt", got)
			}
			drop := "DROP TRIGGER fail_execution_receipt"
			if provider == "postgres" {
				drop = "DROP TRIGGER fail_execution_receipt ON work_executions; DROP FUNCTION fail_execution_receipt_fn()"
			}
			if _, err = a.store.DB.Exec(drop); err != nil {
				t.Fatal(err)
			}
			if err = a.recoverWorkExecutions(context.Background()); err != nil {
				t.Fatal(err)
			}
			failedWrite = workerTestRun(t, a, failedWrite.ID)
			if failedWrite.State != "unknown" || failedWrite.NextPollAt != "" || posts.Load() != 3 {
				t.Fatal("recovery reconstructed an interrupted POST", failedWrite)
			}
			f.owner.ok("POST", f.base+"/executions/"+failedWrite.ID+"/reconcile", map[string]any{"expectedRevision": failedWrite.Revision})
			failedWrite = workerTestRun(t, a, failedWrite.ID)
			if failedWrite.State != "succeeded" || posts.Load() != 3 || gets.Load() != 1 {
				t.Fatal("explicit recovery did not reuse external execution identity", failedWrite, posts.Load(), gets.Load())
			}
		})
	}
}
