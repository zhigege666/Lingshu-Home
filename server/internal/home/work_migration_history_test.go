package home

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
)

// Historical schema tests stop at the migration they describe. Later intentional
// schema changes (such as replacing card IDs) must not change their assertions.
// The latest-chain and failure-atomicity tests still exercise Store.migrate.
func applyHistoricalWorkMigration(ctx context.Context, store *Store, version string) error {
	body, err := migrationFiles.ReadFile("migrations/" + store.Provider + "/" + version)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(body)
	checksum := hex.EncodeToString(sum[:])
	var applied string
	err = store.DB.QueryRowContext(ctx, store.Query("SELECT checksum FROM schema_migrations WHERE version=?"), version).Scan(&applied)
	if err == nil {
		if applied != checksum {
			return fmt.Errorf("historical migration %s checksum changed", version)
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	tx, err := store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, string(body)); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, store.Query("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)"), version, checksum, nowUTC()); err != nil {
		return err
	}
	return tx.Commit()
}
