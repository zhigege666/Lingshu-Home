package home

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const storageConfigFilename = "storage.json"

type savedStorageConfig struct {
	Version     int    `json:"version"`
	Provisioned bool   `json:"provisioned,omitempty"`
	Provider    string `json:"provider"`
	DatabaseURL string `json:"databaseUrl,omitempty"`
}

// readStorageConfig never includes a connection string in its errors.
func readStorageConfig(dir string) (*savedStorageConfig, error) {
	path := filepath.Join(dir, storageConfigFilename)
	before, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("cannot inspect storage configuration")
	}
	if !before.Mode().IsRegular() || before.Mode().Perm()&0077 != 0 {
		return nil, errors.New("storage configuration must be a private regular file (0600)")
	}
	if before.Size() == 0 || before.Size() > 32768 {
		return nil, errors.New("invalid storage configuration size")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, errors.New("cannot read storage configuration")
	}
	defer f.Close()
	after, err := f.Stat()
	if err != nil || !os.SameFile(before, after) {
		return nil, errors.New("storage configuration changed while being read")
	}
	var saved savedStorageConfig
	dec := json.NewDecoder(io.LimitReader(f, 32769))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&saved); err != nil {
		return nil, errors.New("invalid storage configuration JSON")
	}
	var extra any
	if !errors.Is(dec.Decode(&extra), io.EOF) {
		return nil, errors.New("invalid trailing storage configuration data")
	}
	if saved.Version != 1 {
		return nil, errors.New("unsupported storage configuration version")
	}
	if saved.Provider != "sqlite" && saved.Provider != "postgres" {
		return nil, errors.New("unsupported saved storage provider")
	}
	if saved.Provider == "postgres" && strings.TrimSpace(saved.DatabaseURL) == "" {
		return nil, errors.New("saved PostgreSQL connection is missing")
	}
	if saved.Provider == "sqlite" && saved.DatabaseURL != "" {
		return nil, errors.New("SQLite storage configuration contains a PostgreSQL connection")
	}
	return &saved, nil
}

// Bind a new installation to one target before migrations, including on retry.
func writeStorageConfig(dir string, c Config) error {
	path := filepath.Join(dir, storageConfigFilename)
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return errors.New("storage configuration already exists or cannot be inspected")
	}
	saved := savedStorageConfig{Version: 1, Provider: c.StorageProvider}
	if c.StorageProvider == "postgres" {
		saved.DatabaseURL = c.DatabaseURL
	}
	encoded, err := json.MarshalIndent(saved, "", "  ")
	if err != nil {
		return errors.New("cannot encode storage configuration")
	}
	encoded = append(encoded, '\n')
	temp, err := os.CreateTemp(dir, ".storage-config-*")
	if err != nil {
		return errors.New("cannot create storage configuration")
	}
	name := temp.Name()
	defer os.Remove(name)
	if err = temp.Chmod(0600); err == nil {
		_, err = temp.Write(encoded)
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return errors.New("cannot write storage configuration")
	}
	// Atomic create-if-absent cannot replace a configuration installed meanwhile.
	if err := os.Link(name, path); err != nil {
		return errors.New("cannot install storage configuration; existing configuration was preserved")
	}
	if directory, err := os.Open(dir); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

func inspectLegacySQLite(dir string) (bool, error) {
	path := filepath.Join(dir, "lingshu-home.db")
	st, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		for _, name := range []string{"csrf.key", "integrations.key", "lingshu-home.db-wal", "lingshu-home.db-shm"} {
			if _, e := os.Lstat(filepath.Join(dir, name)); !errors.Is(e, os.ErrNotExist) {
				return false, errors.New("instance files exist without a database or saved storage configuration; restore the matching database and keys")
			}
		}
		return false, nil
	}
	if err != nil || !st.Mode().IsRegular() || st.Size() < 100 {
		return false, errors.New("existing SQLite database is empty, unsafe or unreadable; restore it before continuing")
	}
	f, err := os.Open(path)
	if err != nil {
		return false, errors.New("cannot inspect existing SQLite database")
	}
	header := make([]byte, 16)
	_, err = io.ReadFull(f, header)
	f.Close()
	if err != nil || !bytes.Equal(header, []byte("SQLite format 3\x00")) {
		return false, errors.New("existing database is not a valid SQLite database")
	}
	address := url.URL{Scheme: "file", Path: path}
	q := address.Query()
	q.Set("mode", "ro")
	q.Add("_pragma", "query_only(1)")
	q.Add("_pragma", "busy_timeout(1500)")
	address.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", address.String())
	if err != nil {
		return false, errors.New("cannot read existing SQLite database")
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var tables, migrations, settings int
	err = db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('schema_migrations','settings')").Scan(&tables)
	if err == nil && tables == 2 {
		err = db.QueryRowContext(ctx, "SELECT count(*) FROM schema_migrations").Scan(&migrations)
	}
	if err == nil && tables == 2 && migrations > 0 {
		err = db.QueryRowContext(ctx, "SELECT count(*) FROM settings WHERE id=1").Scan(&settings)
	}
	if err != nil || tables != 2 || migrations == 0 || settings != 1 {
		return false, errors.New("existing SQLite file is damaged or is not an initialized Home database; it was not modified")
	}
	return true, nil
}

func resolveRuntimeStorage(c Config) (Config, bool, error) {
	if c.storageSource == "" {
		if c.StorageProvider != "" || c.DatabaseURL != "" {
			c.storageSource = "cli"
		} else {
			c.storageSource = "default"
		}
	}
	if err := c.validate(); err != nil {
		return c, false, err
	}
	if c.storageSource == "cli" || c.storageSource == "environment" {
		if c.StorageProvider == "sqlite" {
			_, err := inspectLegacySQLite(c.DataDir)
			return c, false, err
		}
		return c, false, nil
	}
	saved, err := readStorageConfig(c.DataDir)
	if err != nil {
		return c, false, err
	}
	if saved != nil {
		c.StorageProvider, c.DatabaseURL, c.storageSource = saved.Provider, saved.DatabaseURL, "file"
		if err := c.validate(); err != nil {
			return c, false, err
		}
		if c.StorageProvider == "sqlite" {
			return c, false, inspectBoundSQLite(c.DataDir, saved.Provisioned)
		}
		return c, false, nil
	}
	legacy, err := inspectLegacySQLite(c.DataDir)
	if err != nil {
		return c, false, err
	}
	if legacy {
		c.StorageProvider, c.DatabaseURL, c.storageSource = "sqlite", "", "legacy"
		return c, false, nil
	}
	c.StorageProvider, c.DatabaseURL, c.storageSource = "sqlite", "", "default"
	return c, true, nil
}

func markStorageProvisioned(dir string, c Config) error {
	saved, err := readStorageConfig(dir)
	if err != nil || saved == nil {
		return errors.New("cannot verify saved storage configuration")
	}
	if saved.Provider != c.StorageProvider || saved.DatabaseURL != c.DatabaseURL {
		return errors.New("saved storage target changed; restart to load the intended configuration")
	}
	if saved.Provisioned {
		return nil
	}
	path := filepath.Join(dir, storageConfigFilename)
	before, err := os.Lstat(path)
	if err != nil {
		return errors.New("cannot inspect saved storage configuration")
	}
	saved.Provisioned = true
	encoded, err := json.MarshalIndent(saved, "", "  ")
	if err != nil {
		return errors.New("cannot encode storage completion")
	}
	encoded = append(encoded, '\n')
	temp, err := os.CreateTemp(dir, ".storage-complete-*")
	if err != nil {
		return errors.New("cannot persist storage completion")
	}
	name := temp.Name()
	defer os.Remove(name)
	if err = temp.Chmod(0600); err == nil {
		_, err = temp.Write(encoded)
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return errors.New("cannot persist storage completion")
	}
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(before, after) {
		return errors.New("storage configuration changed during completion")
	}
	if err := os.Rename(name, path); err != nil {
		return errors.New("cannot install storage completion")
	}
	if directory, err := os.Open(dir); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}
