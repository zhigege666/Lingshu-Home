package home

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

//go:embed migrations/sqlite/*.sql migrations/postgres/*.sql
var migrationFiles embed.FS

type Queryer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type Store struct {
	DB        *sql.DB
	Provider  string
	lease     *fileLease
	pgLease   *sql.Conn
	leaseGate chan struct{}
	leaseLost atomic.Bool
}

const postgresLeaseID int64 = 741265895235142

func openStore(ctx context.Context, c Config) (*Store, error) {
	if err := os.MkdirAll(c.DataDir, 0700); err != nil {
		return nil, err
	}
	var err error
	var ownedLease *fileLease
	if c.runtimeLease == nil {
		ownedLease, err = acquireFileLease(filepath.Join(c.DataDir, ".instance.lock"))
		if err != nil {
			return nil, err
		}
	}
	// Runtime owns borrowed leases across setup, retries and App replacements.
	s := &Store{Provider: c.StorageProvider, lease: ownedLease}
	if s.Provider == "postgres" {
		s.leaseGate = make(chan struct{}, 1)
	}
	ok := false
	defer func() {
		if !ok {
			s.Close()
		}
	}()
	if s.Provider == "sqlite" {
		u := url.URL{Scheme: "file", Path: filepath.Join(c.DataDir, "lingshu-home.db")}
		values := url.Values{}
		values.Add("_pragma", "foreign_keys(1)")
		values.Add("_pragma", "busy_timeout(15000)")
		values.Add("_pragma", "journal_mode(WAL)")
		u.RawQuery = values.Encode()
		s.DB, err = sql.Open("sqlite", u.String())
		if err != nil {
			return nil, err
		}
		s.DB.SetMaxOpenConns(1)
		s.DB.SetMaxIdleConns(1)
	} else {
		s.DB, err = sql.Open("pgx", c.DatabaseURL)
		if err != nil {
			return nil, errors.New("unable to open PostgreSQL connection")
		}
		s.DB.SetMaxOpenConns(6)
		s.DB.SetMaxIdleConns(3)
		s.DB.SetConnMaxIdleTime(5 * time.Minute)
	}
	if err = s.DB.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("%s database is not reachable", s.Provider)
	}
	if s.Provider == "postgres" {
		s.pgLease, err = s.DB.Conn(ctx)
		if err != nil {
			return nil, err
		}
		var locked bool
		if err = s.pgLease.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", postgresLeaseID).Scan(&locked); err != nil {
			return nil, err
		}
		if !locked {
			return nil, errors.New("another Lingshu-Home instance already holds this database")
		}
	}
	if err = s.migrate(ctx); err != nil {
		return nil, err
	}
	if s.Provider == "sqlite" {
		if err = os.Chmod(filepath.Join(c.DataDir, "lingshu-home.db"), 0600); err != nil {
			return nil, err
		}
	}
	ok = true
	return s, nil
}

// Query translates placeholders only in application-owned SQL, never in user input.
func (s *Store) Query(statement string) string {
	if s.Provider != "postgres" {
		return statement
	}
	var out strings.Builder
	index := 0
	for _, r := range statement {
		if r == '?' {
			index++
			out.WriteByte('$')
			out.WriteString(strconv.Itoa(index))
		} else {
			out.WriteRune(r)
		}
	}
	return out.String()
}

func (s *Store) CheckLease(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.Provider != "postgres" {
		return nil
	}
	if s.leaseLost.Load() {
		return &APIError{Status: 503, Code: "storage_unavailable", Message: "Database instance lock was lost. Restart the service after checking the database."}
	}
	if s.pgLease == nil || s.leaseGate == nil {
		s.leaseLost.Store(true)
		return &APIError{Status: 503, Code: "storage_unavailable", Message: "Database instance lock was lost. Restart the service after checking the database."}
	}
	// Wait outside database/sql's connection mutex so a queued caller cannot
	// exhaust the health-check deadline before its ping has even started.
	select {
	case s.leaseGate <- struct{}{}:
		defer func() { <-s.leaseGate }()
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.leaseLost.Load() {
		return &APIError{Status: 503, Code: "storage_unavailable", Message: "Database instance lock was lost. Restart the service after checking the database."}
	}
	// This dedicated connection owns the database instance lock. Cancelling a
	// caller's ping can discard that connection and stop unrelated requests.
	// Keep the health check bounded, but independent of request cancellation.
	checkCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if err := s.pgLease.PingContext(checkCtx); err != nil {
		s.leaseLost.Store(true)
		return &APIError{Status: 503, Code: "storage_unavailable", Message: "Database instance lock was lost. Restart the service after checking the database."}
	}
	if s.leaseLost.Load() {
		return &APIError{Status: 503, Code: "storage_unavailable", Message: "Database instance lock was lost. Restart the service after checking the database."}
	}
	return ctx.Err()
}

func (s *Store) Close() error {
	if s.Provider == "postgres" {
		// Refuse new checks before waiting for a running ping. Keep unlock and
		// close under the same gate so no caller can validate an unlocked session.
		s.leaseLost.Store(true)
		if s.leaseGate != nil {
			s.leaseGate <- struct{}{}
			defer func() { <-s.leaseGate }()
		}
	}
	if s.pgLease != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, _ = s.pgLease.ExecContext(ctx, "SELECT pg_advisory_unlock($1)", postgresLeaseID)
		cancel()
		_ = s.pgLease.Close()
	}
	var err error
	if s.DB != nil {
		err = s.DB.Close()
	}
	if s.lease != nil {
		if leaseErr := s.lease.Close(); err == nil {
			err = leaseErr
		}
	}
	return err
}

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.DB.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)")
	if err != nil {
		return err
	}
	names, err := fs.Glob(migrationFiles, "migrations/"+s.Provider+"/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	contents := make(map[string][]byte, len(names))
	checksums := make(map[string]string, len(names))
	for _, name := range names {
		body, e := migrationFiles.ReadFile(name)
		if e != nil {
			return e
		}
		base := filepath.Base(name)
		digest := sha256.Sum256(body)
		contents[base] = body
		checksums[base] = hex.EncodeToString(digest[:])
	}
	if err = s.bridgeLegacySessionRetention(ctx, contents, checksums); err != nil {
		return err
	}
	rows, err := s.DB.QueryContext(ctx, "SELECT version,checksum FROM schema_migrations ORDER BY version")
	if err != nil {
		return err
	}
	applied := map[string]bool{}
	latest := ""
	for rows.Next() {
		var version, checksum string
		if err = rows.Scan(&version, &checksum); err != nil {
			rows.Close()
			return err
		}
		expected, exists := checksums[version]
		if !exists || expected != checksum {
			rows.Close()
			return fmt.Errorf("migration %s is unknown or its checksum changed; restore matching source before starting", version)
		}
		applied[version] = true
		latest = version
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, name := range names {
		version := filepath.Base(name)
		if applied[version] {
			continue
		}
		if version < latest {
			return fmt.Errorf("refusing out-of-order migration %s", version)
		}
		tx, e := s.DB.BeginTx(ctx, nil)
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, string(contents[version])); e == nil {
			_, e = tx.ExecContext(ctx, s.Query("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)"), version, checksums[version], nowUTC())
		}
		if e != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration %s failed: %w", version, e)
		}
		if e = tx.Commit(); e != nil {
			return e
		}
	}
	return nil
}
