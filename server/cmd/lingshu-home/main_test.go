package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zhigege666/Lingshu-Home/server/internal/home"
)

func waitForSignal(t *testing.T, signal <-chan struct{}, description string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for " + description)
	}
}

func testHTTPListener(t *testing.T) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener
}

func testHTTPClient(t *testing.T) *http.Client {
	t.Helper()
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: 10 * time.Second}
}

func TestServeHTTPWaitsForRequestDrainBeforeReturning(t *testing.T) {
	listener := testHTTPListener(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	resourcesClosed := make(chan struct{})
	var releaseOnce sync.Once
	releaseHandler := func() { releaseOnce.Do(func() { close(release) }) }
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		select {
		case <-resourcesClosed:
			http.Error(w, "application closed before request completed", http.StatusServiceUnavailable)
			return
		default:
		}
		_, _ = io.WriteString(w, "completed with application still open")
	})}
	t.Cleanup(func() { _ = server.Close() })
	t.Cleanup(releaseHandler)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	serveReturned := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- func() error {
			defer close(resourcesClosed)
			return serveHTTP(ctx, server, func() error {
				err := server.Serve(listener)
				close(serveReturned)
				return err
			}, 5*time.Second)
		}()
	}()
	type response struct {
		status int
		body   string
		err    error
	}
	responseDone := make(chan response, 1)
	client := testHTTPClient(t)
	go func() {
		result, err := client.Get("http://" + listener.Addr().String())
		if err != nil {
			responseDone <- response{err: err}
			return
		}
		defer result.Body.Close()
		body, err := io.ReadAll(result.Body)
		responseDone <- response{status: result.StatusCode, body: string(body), err: err}
	}()
	waitForSignal(t, entered, "the controlled in-flight request")
	cancel()
	waitForSignal(t, serveReturned, "Serve to return after its listener closed")
	// The request is deliberately blocked. This is an ordering assertion,
	// not a latency target: even after Serve returns, shutdown cannot return
	// or release App resources until the handler is explicitly released.
	select {
	case <-resourcesClosed:
		t.Fatal("application resources were released while Shutdown was draining")
	case <-time.After(50 * time.Millisecond):
	}
	releaseHandler()
	select {
	case result := <-responseDone:
		if result.err != nil || result.status != http.StatusOK || result.body != "completed with application still open" {
			t.Fatalf("in-flight request did not finish successfully: status=%d body=%q error=%v", result.status, result.body, result.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("in-flight request never completed")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("graceful shutdown failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("graceful shutdown never returned")
	}
	waitForSignal(t, resourcesClosed, "application resource cleanup after drain")
}

func TestServeHTTPTimeoutForcesConnectionsClosedWithoutClaimingHandlerJoin(t *testing.T) {
	listener := testHTTPListener(t)
	entered := make(chan struct{})
	requestCanceled := make(chan struct{})
	release := make(chan struct{})
	handlerFinished := make(chan struct{})
	var releaseOnce sync.Once
	releaseHandler := func() { releaseOnce.Do(func() { close(release) }) }
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerFinished)
		close(entered)
		<-r.Context().Done()
		close(requestCanceled)
		// Deliberately continue after cancellation. Server.Close must not be
		// reported as proof that arbitrary handler code has finished.
		<-release
	})}
	t.Cleanup(func() { _ = server.Close() })
	t.Cleanup(releaseHandler)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- serveHTTP(ctx, server, func() error { return server.Serve(listener) }, 20*time.Millisecond)
	}()
	client := testHTTPClient(t)
	responseDone := make(chan error, 1)
	go func() {
		response, err := client.Get("http://" + listener.Addr().String())
		if response != nil {
			_ = response.Body.Close()
		}
		responseDone <- err
	}()
	waitForSignal(t, entered, "the timeout fixture request")
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "forced connection close attempted") {
			t.Fatalf("forced shutdown must retain the deadline error and explicit forced-close outcome: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("forced shutdown waited indefinitely for an uncooperative handler")
	}
	waitForSignal(t, requestCanceled, "forced close to cancel the HTTP request")
	select {
	case <-handlerFinished:
		t.Fatal("the controlled handler was unexpectedly released")
	default:
	}
	select {
	case err := <-responseDone:
		if err == nil {
			t.Fatal("an unfinished HTTP response unexpectedly succeeded after forced close")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("forced close left the client connection open")
	}
	releaseHandler()
	waitForSignal(t, handlerFinished, "explicit cleanup of the uncooperative fixture handler")
}

func TestServeHTTPListenFailureDoesNotWaitForSignal(t *testing.T) {
	occupied := testHTTPListener(t)
	server := &http.Server{Addr: occupied.Addr().String()}
	t.Cleanup(func() { _ = server.Close() })
	done := make(chan error, 1)
	go func() {
		done <- serveHTTP(context.Background(), server, server.ListenAndServe, time.Second)
	}()
	select {
	case err := <-done:
		if err == nil || errors.Is(err, http.ErrServerClosed) {
			t.Fatalf("listen failure must be retained: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("listen failure waited for a signal that will never be sent")
	}
}

func TestRunListenFailureReturnsNonzeroAndReleasesApplication(t *testing.T) {
	occupied := testHTTPListener(t)
	directory := t.TempDir()
	versionFile := filepath.Join(directory, "VERSION")
	if err := os.WriteFile(versionFile, []byte("0.1.0-test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	dataDir := filepath.Join(directory, "data")
	webDir := filepath.Join(directory, "web")
	t.Setenv("LINGSHU_SECURE_COOKIES", "false")
	args := []string{
		"-listen", occupied.Addr().String(), "-storage-provider", "sqlite",
		"-data-dir", dataDir, "-database-url", "", "-web-dir", webDir,
		"-version-file", versionFile, "-language", "en", "-secure-cookies=false",
	}
	done := make(chan int, 1)
	go func() { done <- run(args) }()
	select {
	case exitCode := <-done:
		if exitCode != 1 {
			t.Fatalf("listen failure exit code = %d; want 1", exitCode)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("run did not return after a listen failure")
	}
	if _, err := os.Stat(filepath.Join(dataDir, "lingshu-home.db")); err != nil {
		t.Fatalf("fixture must have opened its real isolated application database before the listen failure: %v", err)
	}
	// A second Open of the same isolated directory succeeds only after run's
	// deferred App.Close releases its instance lock and closes the store.
	app, err := home.Open(home.Config{
		Listen: occupied.Addr().String(), StorageProvider: "sqlite", DataDir: dataDir,
		WebDir: webDir, VersionFile: versionFile, Language: "en",
	})
	if err != nil {
		t.Fatalf("listen failure leaked application resources or its instance lock: %v", err)
	}
	if err := app.Close(); err != nil {
		t.Fatalf("close reopened fixture application: %v", err)
	}
}
