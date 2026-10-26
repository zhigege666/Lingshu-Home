package home

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

const postgresIdentitySQL = "SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname='schema_migrations' AND c.relkind IN ('r','p')), EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname='settings' AND c.relkind IN ('r','p')), (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','f','S'))"

func storageKeysExist(dir string) bool {
	for _, name := range []string{"csrf.key", "integrations.key"} {
		if _, err := os.Lstat(filepath.Join(dir, name)); !errors.Is(err, os.ErrNotExist) {
			return true
		}
	}
	return false
}
func storageIdentityError() error {
	return &APIError{Status: 409, Code: "storage_data_missing", Message: "The selected database is missing its expected Home data or contains unrelated tables. Restore the matching database and keys; no new instance was created."}
}
func inspectBoundSQLite(dir string, provisioned bool) error {
	path := filepath.Join(dir, "lingshu-home.db")
	st, err := os.Lstat(path)
	requireHome := provisioned || storageKeysExist(dir)
	if errors.Is(err, os.ErrNotExist) {
		if requireHome {
			return storageIdentityError()
		}
		for _, name := range []string{"lingshu-home.db-wal", "lingshu-home.db-shm"} {
			if _, err := os.Lstat(filepath.Join(dir, name)); !errors.Is(err, os.ErrNotExist) {
				return storageIdentityError()
			}
		}
		return nil
	}
	if err != nil || !st.Mode().IsRegular() {
		return storageIdentityError()
	}
	address := url.URL{Scheme: "file", Path: path}
	q := address.Query()
	q.Set("mode", "ro")
	q.Add("_pragma", "query_only(1)")
	q.Add("_pragma", "busy_timeout(1500)")
	address.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", address.String())
	if err != nil {
		return storageIdentityError()
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var tables, ledger, settings int
	err = db.QueryRowContext(ctx, "SELECT count(*),COALESCE(sum(name='schema_migrations'),0),COALESCE(sum(name='settings'),0) FROM sqlite_master WHERE type IN ('table','view','trigger','index') AND name NOT GLOB 'sqlite_*'").Scan(&tables, &ledger, &settings)
	if err != nil {
		return storageIdentityError()
	}
	if tables == 0 && !requireHome {
		return nil
	}
	var applied, rows int
	if ledger == 1 {
		if err := db.QueryRowContext(ctx, "SELECT count(*) FROM schema_migrations").Scan(&applied); err != nil {
			return storageIdentityError()
		}
	}
	if !requireHome && tables == 1 && ledger == 1 && applied == 0 {
		return nil
	}
	if ledger != 1 || settings != 1 || applied == 0 {
		return storageIdentityError()
	}
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM settings WHERE id=1").Scan(&rows); err != nil || rows != 1 {
		return storageIdentityError()
	}
	return nil
}
func inspectPostgresIdentity(ctx context.Context, c Config, requireHome bool) error {
	db, err := sql.Open("pgx", c.DatabaseURL)
	if err != nil {
		return storageConnectionError(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return storageConnectionError(err)
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return storageConnectionError(err)
	}
	defer tx.Rollback()
	var ledger, settings bool
	var tables, applied, rows int
	err = tx.QueryRowContext(ctx, postgresIdentitySQL).Scan(&ledger, &settings, &tables)
	if err != nil {
		return storageConnectionError(err)
	}
	if tables == 0 && !requireHome {
		return nil
	}
	if ledger {
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM schema_migrations").Scan(&applied); err != nil {
			return storageIdentityError()
		}
	}
	if !requireHome && tables == 1 && ledger && applied == 0 {
		return nil
	}
	if !ledger || !settings || applied == 0 {
		return storageIdentityError()
	}
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM settings WHERE id=1").Scan(&rows); err != nil || rows != 1 {
		return storageIdentityError()
	}
	return nil
}
func validateRuntimeTarget(c Config) error {
	provisioned := false
	if c.storageSource == "file" {
		saved, err := readStorageConfig(c.DataDir)
		if err != nil {
			return err
		}
		if saved == nil || saved.Provider != c.StorageProvider || saved.DatabaseURL != c.DatabaseURL {
			return errors.New("saved storage target changed; restart to load its configuration")
		}
		provisioned = saved.Provisioned
	}
	if c.StorageProvider == "sqlite" {
		if c.storageSource == "file" {
			return inspectBoundSQLite(c.DataDir, provisioned)
		}
		_, err := inspectLegacySQLite(c.DataDir)
		return err
	}
	ctx := c.runtimeContext
	if ctx == nil {
		ctx = context.Background()
	}
	return inspectPostgresIdentity(ctx, c, provisioned || storageKeysExist(c.DataDir))
}
