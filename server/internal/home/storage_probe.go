package home

import (
	"context"
	"database/sql"
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

type storagePostgresInput struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Database string `json:"database"`
	Username string `json:"username"`
	Password string `json:"password"`
	SSLMode  string `json:"sslMode"`
}
type storageInput struct {
	Provider string                `json:"provider"`
	Postgres *storagePostgresInput `json:"postgres,omitempty"`
}

func storageInputConfig(base Config, input storageInput) (Config, error) {
	c := base
	c.StorageProvider, c.DatabaseURL = input.Provider, ""
	c.storageSource = "file"
	if input.Provider == "sqlite" {
		if input.Postgres != nil {
			return c, invalid("SQLite does not accept PostgreSQL connection fields.")
		}
		return c, nil
	}
	if input.Provider != "postgres" || input.Postgres == nil {
		return c, invalid("Choose SQLite or provide a PostgreSQL connection.")
	}
	p := *input.Postgres
	p.Host, p.Database, p.Username = strings.TrimSpace(p.Host), strings.TrimSpace(p.Database), strings.TrimSpace(p.Username)
	if strings.HasPrefix(p.Host, "[") && strings.HasSuffix(p.Host, "]") {
		p.Host = p.Host[1 : len(p.Host)-1]
	}
	if p.Host == "" || len(p.Host) > 253 || strings.ContainsAny(p.Host, "/\\@?#, \t\r\n\x00%") || (strings.Contains(p.Host, ":") && net.ParseIP(p.Host) == nil) {
		return c, invalid("Enter one database hostname or IP address without a URL or port.")
	}
	if p.Port < 1 || p.Port > 65535 {
		return c, invalid("Database port must be between 1 and 65535.")
	}
	if p.Database == "" || len(p.Database) > 128 || strings.ContainsAny(p.Database, "\x00\r\n") || p.Username == "" || len(p.Username) > 128 || strings.ContainsAny(p.Username, "\x00\r\n") || len(p.Password) > 4096 || strings.ContainsRune(p.Password, '\x00') {
		return c, invalid("Enter a valid database name, username and password.")
	}
	switch p.SSLMode {
	case "disable", "require", "verify-full":
	default:
		return c, invalid("Choose a supported PostgreSQL TLS mode.")
	}
	u := url.URL{Scheme: "postgres", User: url.UserPassword(p.Username, p.Password), Host: net.JoinHostPort(p.Host, strconv.Itoa(p.Port)), Path: "/" + p.Database}
	q := u.Query()
	q.Set("sslmode", p.SSLMode)
	q.Set("connect_timeout", "5")
	u.RawQuery = q.Encode()
	c.DatabaseURL = u.String()
	return c, nil
}

func storageConnectionError(err error) *APIError {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "28P01", "28000":
			return &APIError{Status: 400, Code: "storage_authentication_failed", Message: "Database authentication failed. Check the username and password."}
		case "3D000":
			return &APIError{Status: 400, Code: "storage_database_missing", Message: "The database does not exist. Create a dedicated Home database first."}
		case "42501":
			return &APIError{Status: 400, Code: "storage_permission_denied", Message: "The database account does not have the required permissions."}
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &APIError{Status: 503, Code: "storage_timeout", Message: "The database connection timed out. Check the address, port and network access."}
	}
	description := strings.ToLower(err.Error())
	if strings.Contains(description, "certificate") || strings.Contains(description, "tls") || strings.Contains(description, "ssl") {
		return &APIError{Status: 400, Code: "storage_tls_failed", Message: "Database TLS validation failed. Check the TLS mode, certificate trust and hostname."}
	}
	return &APIError{Status: 503, Code: "storage_unavailable", Message: "Storage is unavailable. Check the connection, database permissions, instance lock and matching key files, then retry."}
}

// The probe never migrates, creates tables, takes a database lease or writes keys.
func probeStorage(ctx context.Context, c Config) error {
	if c.StorageProvider == "sqlite" {
		return nil
	}
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
	var connect, usage, create bool
	err = tx.QueryRowContext(ctx, "SELECT has_database_privilege(current_database(),'CONNECT'), COALESCE(has_schema_privilege(current_schema(),'USAGE'),false), COALESCE(has_schema_privilege(current_schema(),'CREATE'),false)").Scan(&connect, &usage, &create)
	if err != nil {
		return storageConnectionError(err)
	}
	if !connect || !usage || !create {
		return &APIError{Status: 400, Code: "storage_permission_denied", Message: "The database account needs connection, schema usage and schema creation permissions."}
	}
	var ledger, settings bool
	var tables int
	err = tx.QueryRowContext(ctx, postgresIdentitySQL).Scan(&ledger, &settings, &tables)
	if err != nil {
		return storageConnectionError(err)
	}
	if tables > 0 && (!ledger || !settings) {
		return &APIError{Status: 400, Code: "storage_database_not_empty", Message: "Use an empty dedicated database or an existing Home database. No tables were changed."}
	}
	if ledger && settings {
		var applied, rows int
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM schema_migrations").Scan(&applied); err != nil {
			return storageConnectionError(err)
		}
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM settings WHERE id=1").Scan(&rows); err != nil {
			return storageConnectionError(err)
		}
		if applied == 0 || rows != 1 {
			return storageIdentityError()
		}
	}
	return nil
}
