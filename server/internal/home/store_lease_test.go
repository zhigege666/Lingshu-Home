package home

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Use database/sql's real dedicated-connection path with an observable Pinger.
// Channels hold an operation at a known point; no timing sleeps are needed.
type leaseTestConnector struct{ conn *leaseTestConn }
type leaseTestDriver struct{}
type leaseTestConn struct {
	pings atomic.Int32
	ping  func(context.Context) error
	exec  func(context.Context) error
}

func (c leaseTestConnector) Connect(context.Context) (driver.Conn, error) { return c.conn, nil }
func (leaseTestConnector) Driver() driver.Driver                          { return leaseTestDriver{} }
func (leaseTestDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("lease fixture uses its connector")
}
func (*leaseTestConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("lease fixture does not prepare statements")
}
func (*leaseTestConn) Begin() (driver.Tx, error) {
	return nil, errors.New("lease fixture does not begin transactions")
}
func (*leaseTestConn) Close() error { return nil }
func (c *leaseTestConn) Ping(ctx context.Context) error {
	c.pings.Add(1)
	if c.ping != nil {
		return c.ping(ctx)
	}
	if ctx.Err() != nil {
		// Match the relevant pgx failure: a cancelled ping discards its connection.
		return driver.ErrBadConn
	}
	return nil
}
func (c *leaseTestConn) ExecContext(ctx context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	if query != "SELECT pg_advisory_unlock($1)" {
		return nil, errors.New("unexpected lease fixture statement")
	}
	if c.exec != nil {
		if err := c.exec(ctx); err != nil {
			return nil, err
		}
	}
	return driver.RowsAffected(1), nil
}

func newLeaseTestStore(t *testing.T, ping func(context.Context) error) (*Store, *leaseTestConn) {
	t.Helper()
	connection := &leaseTestConn{ping: ping}
	db := sql.OpenDB(leaseTestConnector{conn: connection})
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	lease, err := db.Conn(context.Background())
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lease.Close(); _ = db.Close() })
	return &Store{Provider: "postgres", DB: db, pgLease: lease, leaseGate: make(chan struct{}, 1)}, connection
}

func assertLeaseUnavailable(t *testing.T, err error) {
	t.Helper()
	var api *APIError
	if !errors.As(err, &api) || api.Status != 503 || api.Code != "storage_unavailable" {
		t.Fatalf("expected a fail-closed lease error, got %v", err)
	}
}

func leaseTestResult(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("lease operation did not finish")
		return nil
	}
}

func leaseTestEntered(t *testing.T, entered <-chan context.Context) context.Context {
	t.Helper()
	select {
	case ctx := <-entered:
		return ctx
	case <-time.After(5 * time.Second):
		t.Fatal("lease ping did not start")
		return nil
	}
}

func leaseTestRelease(t *testing.T) (<-chan struct{}, func()) {
	t.Helper()
	released := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(released) }) }
	t.Cleanup(release)
	return released, release
}

func TestCheckLeaseAlreadyCancelledDoesNotPing(t *testing.T) {
	for _, expired := range []bool{false, true} {
		name := "cancelled"
		if expired {
			name = "deadline-exceeded"
		}
		t.Run(name, func(t *testing.T) {
			store, connection := newLeaseTestStore(t, nil)
			ctx, cancel := context.WithCancel(context.Background())
			want := error(context.Canceled)
			if expired {
				cancel()
				ctx, cancel = context.WithDeadline(context.Background(), time.Unix(1, 0))
				want = context.DeadlineExceeded
			}
			cancel()
			if err := store.CheckLease(ctx); !errors.Is(err, want) {
				t.Fatalf("cancelled caller returned %v, want %v", err, want)
			}
			if connection.pings.Load() != 0 || store.leaseLost.Load() {
				t.Fatal("an already cancelled caller touched or invalidated the lease")
			}
			if err := store.CheckLease(context.Background()); err != nil || connection.pings.Load() != 1 {
				t.Fatalf("subsequent live caller could not check the lease: %v", err)
			}
		})
	}
}

type leaseTestContextKey struct{}

func TestCheckLeaseInflightCancellation(t *testing.T) {
	for _, failed := range []bool{false, true} {
		name := "healthy-connection"
		if failed {
			name = "real-failure-still-fails-closed"
		}
		t.Run(name, func(t *testing.T) {
			entered := make(chan context.Context, 1)
			var first sync.Once
			var released <-chan struct{}
			store, connection := newLeaseTestStore(t, func(ctx context.Context) error {
				first.Do(func() {
					entered <- ctx
					select {
					case <-released:
					case <-ctx.Done():
					}
				})
				if failed || ctx.Err() != nil {
					return driver.ErrBadConn
				}
				return nil
			})
			var release func()
			released, release = leaseTestRelease(t)
			parent, cancel := context.WithTimeout(context.WithValue(context.Background(), leaseTestContextKey{}, "request-value"), time.Hour)
			defer cancel()
			result := make(chan error, 1)
			go func() { result <- store.CheckLease(parent) }()
			checking := leaseTestEntered(t, entered)
			cancel()
			if checking.Err() != nil || checking.Value(leaseTestContextKey{}) != "request-value" {
				t.Fatal("request cancellation reached the dedicated ping or its values were lost")
			}
			deadline, bounded := checking.Deadline()
			remaining := time.Until(deadline)
			if !bounded || remaining <= 0 || remaining > 3*time.Second {
				t.Fatal("dedicated ping did not receive its own bounded health-check budget")
			}
			release()
			err := leaseTestResult(t, result)
			if failed {
				assertLeaseUnavailable(t, err)
				assertLeaseUnavailable(t, store.CheckLease(context.Background()))
				if !store.leaseLost.Load() || connection.pings.Load() != 1 {
					t.Fatal("a real connection failure was hidden or retried")
				}
			} else {
				if !errors.Is(err, context.Canceled) || store.leaseLost.Load() {
					t.Fatalf("healthy ping did not preserve the caller's cancellation: %v", err)
				}
				if err := store.CheckLease(context.Background()); err != nil || connection.pings.Load() != 2 {
					t.Fatalf("cancelled request broke the next lease check: %v", err)
				}
			}
		})
	}
}

// Observing Done proves the caller reached the cancellable gate wait. Merely
// launching its goroutine would also permit a pre-cancelled, non-queued check.
type leaseTestWaitContext struct {
	context.Context
	waiting chan struct{}
	once    sync.Once
}

func (c *leaseTestWaitContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}

func leaseTestWaiter(t *testing.T, store *Store) (<-chan error, context.CancelFunc) {
	t.Helper()
	parent, cancel := context.WithCancel(context.Background())
	ctx := &leaseTestWaitContext{Context: parent, waiting: make(chan struct{})}
	result := make(chan error, 1)
	go func() { result <- store.CheckLease(ctx) }()
	select {
	case <-ctx.waiting:
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("second lease check did not reach the gate wait")
	}
	t.Cleanup(cancel)
	return result, cancel
}

func TestCheckLeaseQueuedCancellationDoesNotPing(t *testing.T) {
	entered := make(chan context.Context, 1)
	var first sync.Once
	var released <-chan struct{}
	store, connection := newLeaseTestStore(t, func(ctx context.Context) error {
		first.Do(func() {
			entered <- ctx
			select {
			case <-released:
			case <-ctx.Done():
			}
		})
		return ctx.Err()
	})
	var release func()
	released, release = leaseTestRelease(t)
	active := make(chan error, 1)
	go func() { active <- store.CheckLease(context.Background()) }()
	checking := leaseTestEntered(t, entered)
	queued, cancel := leaseTestWaiter(t, store)
	cancel()
	if err := leaseTestResult(t, queued); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled gate waiter returned %v", err)
	}
	if connection.pings.Load() != 1 || checking.Err() != nil || store.leaseLost.Load() {
		t.Fatal("cancelled gate waiter reached the driver or disturbed the active lease check")
	}
	release()
	if err := leaseTestResult(t, active); err != nil {
		t.Fatal(err)
	}
	if err := store.CheckLease(context.Background()); err != nil || connection.pings.Load() != 2 {
		t.Fatalf("gate was not usable after a cancelled waiter: %v", err)
	}
}

func TestCheckLeaseCloseRefusesActiveAndQueuedChecks(t *testing.T) {
	entered := make(chan context.Context, 1)
	unlocked := make(chan struct{}, 1)
	var released <-chan struct{}
	store, connection := newLeaseTestStore(t, func(ctx context.Context) error {
		entered <- ctx
		select {
		case <-released:
		case <-ctx.Done():
		}
		return ctx.Err()
	})
	connection.exec = func(ctx context.Context) error {
		unlocked <- struct{}{}
		return ctx.Err()
	}
	var release func()
	released, release = leaseTestRelease(t)
	active := make(chan error, 1)
	go func() { active <- store.CheckLease(context.Background()) }()
	leaseTestEntered(t, entered)
	queued, _ := leaseTestWaiter(t, store)
	closed := make(chan error, 1)
	go func() { closed <- store.Close() }()
	// Wait for an observable shutdown state, not an assumed scheduling delay.
	// The deadline is only a deadlock guard; the active Ping stays channel-held.
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for !store.leaseLost.Load() {
		select {
		case <-deadline.C:
			t.Fatal("Close did not refuse new lease checks")
		default:
			runtime.Gosched()
		}
	}
	select {
	case <-unlocked:
		t.Fatal("Close unlocked the session while its health check was active")
	default:
	}
	assertLeaseUnavailable(t, store.CheckLease(context.Background()))
	release()
	assertLeaseUnavailable(t, leaseTestResult(t, active))
	assertLeaseUnavailable(t, leaseTestResult(t, queued))
	if err := leaseTestResult(t, closed); err != nil {
		t.Fatal(err)
	}
	select {
	case <-unlocked:
	default:
		t.Fatal("Close did not release its advisory lock")
	}
	if connection.pings.Load() != 1 {
		t.Fatal("a queued or new caller pinged the session during shutdown")
	}
	assertLeaseUnavailable(t, store.CheckLease(context.Background()))
}

func TestCheckLeaseUninitializedStoreFailsClosed(t *testing.T) {
	for _, missingGate := range []bool{false, true} {
		store, connection := newLeaseTestStore(t, nil)
		if missingGate {
			store.leaseGate = nil
		} else {
			store.pgLease = nil
		}
		assertLeaseUnavailable(t, store.CheckLease(context.Background()))
		assertLeaseUnavailable(t, store.CheckLease(context.Background()))
		if !store.leaseLost.Load() || connection.pings.Load() != 0 {
			t.Fatal("an incomplete PostgreSQL Store was repaired or allowed to query")
		}
	}
}
