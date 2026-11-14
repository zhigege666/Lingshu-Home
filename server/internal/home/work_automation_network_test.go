package home

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A real Owner-configured CONNECT endpoint handles the destination HTTP request
// inside its local tunnel. No client factory, resolver or dialer is replaced;
// destination validation, network-generation capture, CONNECT and wire I/O all
// use production code. The private literal never leaves this fixture proxy.
type workerProductionProxy struct {
	server                *httptest.Server
	connects, posts, gets atomic.Int32
	blockPost             atomic.Bool
	entered, closed       chan struct{}
	enterOnce, closeOnce  sync.Once
	observed              chan error
}

func newWorkerProductionProxy(t *testing.T) *workerProductionProxy {
	t.Helper()
	p := &workerProductionProxy{entered: make(chan struct{}), closed: make(chan struct{}), observed: make(chan error, 16)}
	p.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.connects.Add(1)
		if r.Method != "CONNECT" || r.Host != "10.23.45.67:8080" || r.RequestURI != r.Host || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-CSRF-Token") != "" {
			p.observed <- errors.New("invalid validated CONNECT target or leaked destination credentials")
			w.WriteHeader(400)
			return
		}
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			p.observed <- errors.New("fixture cannot hijack CONNECT")
			return
		}
		conn, buffered, err := hijacker.Hijack()
		if err != nil {
			p.observed <- err
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(8 * time.Second))
		if _, err = io.WriteString(buffered, "HTTP/1.1 200 Connection established\r\n\r\n"); err != nil {
			p.observed <- err
			return
		}
		if err = buffered.Flush(); err != nil {
			p.observed <- err
			return
		}
		request, err := http.ReadRequest(bufio.NewReader(buffered))
		if err != nil {
			p.observed <- err
			return
		}
		defer request.Body.Close()
		if request.Host != "10.23.45.67:8080" || request.Header.Get("Authorization") != "Bearer fixture-executor-secret" || request.Header.Get("Proxy-Authorization") != "" || request.Header.Get("Cookie") != "" || request.Header.Get("X-CSRF-Token") != "" {
			p.observed <- errors.New("destination headers changed across production tunnel")
			return
		}
		id := workerTestRequestID(request)
		state := "succeeded"
		switch request.Method {
		case "POST":
			p.posts.Add(1)
			var payload struct {
				ID   string          `json:"id"`
				Item json.RawMessage `json:"item"`
			}
			if request.URL.Path != "/runs" || json.NewDecoder(request.Body).Decode(&payload) != nil || payload.ID != id || len(payload.Item) == 0 {
				p.observed <- errors.New("production dispatch changed snapshot or idempotency identity")
				return
			}
			state = "running"
			if p.blockPost.Load() {
				p.enterOnce.Do(func() { close(p.entered) })
				var one [1]byte
				_, readErr := conn.Read(one[:])
				p.closeOnce.Do(func() { close(p.closed) })
				if readErr == nil {
					p.observed <- errors.New("generation change left the accepted POST socket open")
				} else {
					p.observed <- nil
				}
				return
			}
		case "GET":
			p.gets.Add(1)
			if !strings.HasPrefix(request.URL.Path, "/runs/") || !validID(id) || request.Header.Get("Idempotency-Key") != "" {
				p.observed <- errors.New("readback was not a GET for the original identity")
				return
			}
		default:
			p.observed <- errors.New("unexpected destination method")
			return
		}
		body, _ := json.Marshal(map[string]string{"id": id, "state": state, "result": "Real production transport", "message": ""})
		_, err = fmt.Fprintf(conn, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", len(body))
		if err == nil {
			_, err = conn.Write(body)
		}
		p.observed <- err
	}))
	t.Cleanup(p.server.Close)
	return p
}
func (p *workerProductionProxy) assertWire(t *testing.T) {
	t.Helper()
	for i := int32(0); i < p.connects.Load(); i++ {
		select {
		case err := <-p.observed:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(8 * time.Second):
			t.Fatal("production proxy observation missing")
		}
	}
}

func TestWorkExecutionProductionNetworkGeneration(t *testing.T) {
	for _, provider := range []string{"sqlite", "postgres"} {
		t.Run(provider, func(t *testing.T) {
			f := workerTestFixture(t, provider)
			a := f.app
			if a.config.workExecutorClientFactory != nil {
				t.Fatal("test must use the production transport")
			}
			firstProxy, secondProxy := newWorkerProductionProxy(t), newWorkerProductionProxy(t)
			network := f.owner.ok("GET", "/network-proxy", nil)
			network = f.owner.ok("PUT", "/network-proxy", map[string]any{"expectedRevision": network["revision"], "mode": "proxy", "url": firstProxy.server.URL})
			executor := automationObject(f.owner.ok("POST", f.base+"/executors", map[string]any{"id": newID(), "name": "Production network executor", "endpoint": "http://10.23.45.67:8080", "allowPrivateNetwork": true, "resourceKey": "production-network", "enabled": true, "pollIntervalSeconds": 2, "timeoutSeconds": 30, "secret": map[string]any{"bearerToken": "fixture-executor-secret"}}), "executor")
			_, first := workerTestQueue(t, f, executor, "Production POST and GET")
			first = workerTestRun(t, a, first.ID)
			if first.State != "running" || firstProxy.posts.Load() != 1 {
				t.Fatal("production POST did not reach the configured network generation", first)
			}
			workerTestPollDue(t, a, first.ID)
			first = workerTestRun(t, a, first.ID)
			if first.State != "succeeded" || firstProxy.gets.Load() != 1 {
				t.Fatal("production readback failed", first)
			}
			// Changing the committed route after acceptance cancels the old socket. The
			// task is uncertain, so its durable receipt must remain unknown without POST.
			firstProxy.blockPost.Store(true)
			_, uncertain := workerTestQueue(t, f, executor, "Route changes after acceptance")
			result := make(chan error, 1)
			go func() { err, _ := a.runWorkExecution(context.Background(), uncertain.ID); result <- err }()
			workerTestReceive(t, firstProxy.entered, "accepted production POST")
			network = f.owner.ok("PUT", "/network-proxy", map[string]any{"expectedRevision": network["revision"], "mode": "direct", "url": ""})
			select {
			case err := <-result:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(8 * time.Second):
				t.Fatal("route change did not cancel old HTTP operation")
			}
			workerTestReceive(t, firstProxy.closed, "old-generation socket closure")
			uncertain = workerTestLoad(t, a, uncertain.ID)
			if uncertain.State != "unknown" || uncertain.NextPollAt != "" || firstProxy.posts.Load() != 2 {
				t.Fatal("route cancellation lost the uncertain dispatch", uncertain)
			}
			workerTestRun(t, a, uncertain.ID)
			if firstProxy.posts.Load() != 2 {
				t.Fatal("uncertain generation automatically re-posted")
			}
			// A fresh GET must capture the newly saved generation, not keep the stale
			// snapshot or fall back to a direct connection to the private destination.
			network = f.owner.ok("PUT", "/network-proxy", map[string]any{"expectedRevision": network["revision"], "mode": "proxy", "url": secondProxy.server.URL})
			f.owner.ok("POST", f.base+"/executions/"+uncertain.ID+"/reconcile", map[string]any{"expectedRevision": uncertain.Revision})
			uncertain = workerTestRun(t, a, uncertain.ID)
			if uncertain.State != "succeeded" || secondProxy.gets.Load() != 1 || secondProxy.posts.Load() != 0 || firstProxy.posts.Load() != 2 {
				t.Fatal("reconciliation did not use current generation with GET only", uncertain)
			}
			_, paused := workerTestQueue(t, f, executor, "Module off and restored network context")
			moduleTestUpdate(t, f.owner, map[string]any{"work": false})
			paused = workerTestRun(t, a, paused.ID)
			if paused.State != "queued" || secondProxy.posts.Load() != 0 {
				t.Fatal("disabled work module performed outbound HTTP", paused)
			}
			moduleTestUpdate(t, f.owner, map[string]any{"work": true})
			paused = workerTestRun(t, a, paused.ID)
			if paused.State != "running" || secondProxy.posts.Load() != 1 {
				t.Fatal("restored module lost current network configuration", paused)
			}
			workerTestPollDue(t, a, paused.ID)
			paused = workerTestRun(t, a, paused.ID)
			if paused.State != "succeeded" || secondProxy.gets.Load() != 2 {
				t.Fatal("restored readback failed", paused)
			}
			firstProxy.assertWire(t)
			secondProxy.assertWire(t)
		})
	}
}
