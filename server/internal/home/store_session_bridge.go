package home

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
)

const legacySessionMigration = "008_session_retention.sql"
const sessionRetentionMigration = "010_session_retention.sql"

// These are the two exact, previously unpublished migration bodies. The
// official 008 document migration is immutable. A matching filename alone, or
// merely finding some session columns, must never authorize a ledger rewrite.
func legacySessionChecksum(provider string) string {
	if provider == "sqlite" {
		return "d92606a965beb650fd7d8d0b505fe821dd4bd97b1c975d5b11a20e567db5e4ee"
	}
	return "ae7cd7d039b406080f91d248c701c53c8b14c55003f48584179dd646dac5f23a"
}

var sessionLegacyPrefix = []string{
	"001_initial.sql", "002_integrations.sql", "003_icons.sql", "004_component_sources.sql",
	"005_auto_icons.sql", "006_network_routing.sql", "007_instance_language.sql",
}

func legacySessionMismatch() error {
	return errors.New("unpublished session migration does not match the recognized ledger and schema; preserve the database and restore its matching source or backup before starting")
}

// openStore already owns the local instance lease and, for PostgreSQL, the
// database advisory lease. Bridge only the exact seven-release-migration plus
// unpublished-session history. Both missing document migrations and the ledger
// rename commit together; failed validation/DDL leaves the old database intact.
func (s *Store) bridgeLegacySessionRetention(ctx context.Context, contents map[string][]byte, checksums map[string]string) error {
	var checksum string
	err := s.DB.QueryRowContext(ctx, s.Query("SELECT checksum FROM schema_migrations WHERE version=?"), legacySessionMigration).Scan(&checksum)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if checksum != legacySessionChecksum(s.Provider) || checksums[sessionRetentionMigration] != checksum {
		return legacySessionMismatch()
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, "SELECT version,checksum FROM schema_migrations ORDER BY version")
	if err != nil {
		return err
	}
	want := append(append([]string{}, sessionLegacyPrefix...), legacySessionMigration)
	index := 0
	valid := true
	for rows.Next() {
		var version, actual string
		if err = rows.Scan(&version, &actual); err != nil {
			rows.Close()
			return err
		}
		expected := checksums[version]
		if version == legacySessionMigration {
			expected = checksum
		}
		if index >= len(want) || version != want[index] || actual != expected {
			valid = false
		}
		index++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if !valid || index != len(want) {
		return legacySessionMismatch()
	}
	if err = s.checkLegacySessionSchema(ctx, tx, contents); err != nil {
		return err
	}
	for _, name := range []string{"008_document_library.sql", "009_document_activity.sql"} {
		if len(contents[name]) == 0 || checksums[name] == "" {
			return legacySessionMismatch()
		}
		if _, err = tx.ExecContext(ctx, string(contents[name])); err != nil {
			return fmt.Errorf("legacy session bridge failed while applying %s: %w", name, err)
		}
		if _, err = tx.ExecContext(ctx, s.Query("INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)"), name, checksums[name], nowUTC()); err != nil {
			return err
		}
	}
	// Keep the original checksum and applied_at: the exact SQL is now 010 and
	// was already executed. Never run its ALTER TABLE statements a second time.
	result, err := tx.ExecContext(ctx, s.Query("UPDATE schema_migrations SET version=? WHERE version=? AND checksum=?"), sessionRetentionMigration, legacySessionMigration, checksum)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return legacySessionMismatch()
	}
	return tx.Commit()
}

func compactSchemaSQL(value string) string {
	var out strings.Builder
	var quote byte
	for index := 0; index < len(value); index++ {
		character := value[index]
		if quote != 0 {
			out.WriteByte(character)
			if character == quote {
				if index+1 < len(value) && value[index+1] == quote {
					index++
					out.WriteByte(value[index])
				} else {
					quote = 0
				}
			}
			continue
		}
		switch character {
		case '\'', '"':
			quote = character
		case ' ', '\t', '\r', '\n', '\f':
			continue
		}
		out.WriteByte(character)
	}
	return out.String()
}

// SQLite retains CREATE TABLE text, including all CHECK/default/FK clauses.
// Derive the expected text from the fixed embedded migration bodies instead of
// accepting a subset of column names. No business or temporary table is written.
func expectedLegacySQLiteTable(contents map[string][]byte, table string) (string, error) {
	var definition string
	for _, statement := range strings.Split(string(contents["001_initial.sql"]), ";") {
		statement = strings.TrimSpace(statement)
		if strings.HasPrefix(statement, "CREATE TABLE "+table+" (") {
			definition = statement
			break
		}
	}
	if definition == "" {
		return "", legacySessionMismatch()
	}
	for _, name := range append(append([]string{}, sessionLegacyPrefix[1:]...), sessionRetentionMigration) {
		for _, statement := range strings.Split(string(contents[name]), ";") {
			prefix := "ALTER TABLE " + table + " ADD COLUMN "
			statement = strings.TrimSpace(statement)
			if strings.HasPrefix(statement, prefix) {
				definition = strings.TrimSuffix(strings.TrimSpace(definition), ")") + "," + strings.TrimPrefix(statement, prefix) + ")"
			}
		}
	}
	return compactSchemaSQL(definition), nil
}

func (s *Store) checkLegacySessionSchema(ctx context.Context, tx *sql.Tx, contents map[string][]byte) error {
	if s.Provider == "postgres" {
		return checkLegacyPostgresSessionSchema(ctx, tx)
	}
	for _, table := range []string{"settings", "sessions"} {
		want, err := expectedLegacySQLiteTable(contents, table)
		if err != nil {
			return err
		}
		var actual string
		if err = tx.QueryRowContext(ctx, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&actual); err != nil || compactSchemaSQL(actual) != want {
			return legacySessionMismatch()
		}
	}
	for _, name := range []string{"sessions_user", "sessions_retention"} {
		column := "user_id"
		if name == "sessions_retention" {
			column = "session_mode,idle_days"
		}
		var actual string
		if err := tx.QueryRowContext(ctx, "SELECT sql FROM sqlite_master WHERE type='index' AND name=? AND tbl_name='sessions'", name).Scan(&actual); err != nil || compactSchemaSQL(actual) != compactSchemaSQL("CREATE INDEX "+name+" ON sessions("+column+")") {
			return legacySessionMismatch()
		}
	}
	return nil
}

type legacySessionColumn struct {
	name, kind, fallback string
	required             bool
}

func checkLegacyPostgresSessionSchema(ctx context.Context, tx *sql.Tx) error {
	columns := map[string][]legacySessionColumn{
		"settings": {
			{"id", "integer", "", true}, {"initialized", "boolean", "false", true},
			{"site_name", "text", "'Lingshu-Home'::text", true}, {"mode", "text", "'public_read'::text", true},
			{"registration_enabled", "boolean", "false", true}, {"auth_epoch", "bigint", "1", true},
			{"auto_fetch_icons", "boolean", "true", true}, {"auto_select_endpoint", "boolean", "true", true},
			{"language", "text", "''::text", true}, {"default_session_mode", "text", "'remember'::text", true},
			{"default_idle_days", "integer", "30", true}, {"max_idle_days", "integer", "30", true},
			{"allow_until_logout", "boolean", "false", true}, {"session_policy_version", "bigint", "1", true},
		},
		"sessions": {
			{"token_hash", "text", "", true}, {"user_id", "text", "", true}, {"auth_epoch", "bigint", "", true},
			{"user_version", "bigint", "", true}, {"expires_at", "timestamp with time zone", "", true},
			{"session_mode", "text", "'temporary'::text", true}, {"idle_days", "integer", "0", true},
			{"created_at", "timestamp with time zone", "", false}, {"last_interactive_at", "timestamp with time zone", "", false},
			{"renewed_at", "timestamp with time zone", "", false}, {"user_agent", "text", "''::text", true},
		},
	}
	constraints := map[string][]string{
		"settings": {
			"PRIMARY KEY (id)", "CHECK ((id = 1))",
			"CHECK ((mode = ANY (ARRAY['open_edit'::text, 'public_read'::text, 'private_single'::text, 'private_multi'::text])))",
			"CHECK ((language = ANY (ARRAY[''::text, 'zh-CN'::text, 'en'::text])))",
			"CHECK ((default_session_mode = ANY (ARRAY['temporary'::text, 'remember'::text, 'until_logout'::text])))",
			"CHECK ((default_idle_days = ANY (ARRAY[7, 30, 90])))", "CHECK ((max_idle_days = ANY (ARRAY[7, 30, 90])))",
			"CHECK ((session_policy_version >= 1))",
		},
		"sessions": {
			"PRIMARY KEY (token_hash)", "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
			"CHECK ((session_mode = ANY (ARRAY['temporary'::text, 'remember'::text, 'until_logout'::text])))",
			"CHECK ((idle_days = ANY (ARRAY[0, 7, 30, 90])))",
		},
	}
	for _, table := range []string{"settings", "sessions"} {
		rows, err := tx.QueryContext(ctx, `SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),
COALESCE(pg_catalog.pg_get_expr(d.adbin,d.adrelid),''),a.attnotnull,a.attidentity,a.attgenerated
FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, table)
		if err != nil {
			return err
		}
		actual := []legacySessionColumn{}
		for rows.Next() {
			var column legacySessionColumn
			var identity, generated string
			if err = rows.Scan(&column.name, &column.kind, &column.fallback, &column.required, &identity, &generated); err != nil {
				rows.Close()
				return err
			}
			if identity != "" || generated != "" {
				rows.Close()
				return legacySessionMismatch()
			}
			actual = append(actual, column)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(actual, columns[table]) {
			return legacySessionMismatch()
		}
		// PostgreSQL 18 also catalogs table NOT NULL constraints here. The
		// column comparison above already verifies every attnotnull value.
		// Exclude only n: unexpected unique/exclusion/trigger constraints must
		// still fail this exact-shape check rather than being silently ignored.
		rows, err = tx.QueryContext(ctx, "SELECT pg_catalog.pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint WHERE conrelid=to_regclass($1) AND contype<>'n'", table)
		if err != nil {
			return err
		}
		actualConstraints := []string{}
		for rows.Next() {
			var definition string
			if err = rows.Scan(&definition); err != nil {
				rows.Close()
				return err
			}
			actualConstraints = append(actualConstraints, compactSchemaSQL(definition))
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		want := make([]string, 0, len(constraints[table]))
		for _, definition := range constraints[table] {
			want = append(want, compactSchemaSQL(definition))
		}
		sort.Strings(want)
		sort.Strings(actualConstraints)
		if !reflect.DeepEqual(actualConstraints, want) {
			return legacySessionMismatch()
		}
	}
	for name, columns := range map[string][]string{"sessions_user": {"user_id"}, "sessions_retention": {"session_mode", "idle_days"}} {
		var valid bool
		err := tx.QueryRowContext(ctx, `SELECT i.indrelid=to_regclass('sessions') AND NOT i.indisunique
AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
AND i.indnatts=$2 AND i.indnkeyatts=$2 AND am.amname='btree'
FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
JOIN pg_catalog.pg_am am ON am.oid=c.relam WHERE i.indexrelid=to_regclass($1)`, name, len(columns)).Scan(&valid)
		if err != nil || !valid {
			return legacySessionMismatch()
		}
		for index, column := range columns {
			var actual string
			if err := tx.QueryRowContext(ctx, "SELECT pg_catalog.pg_get_indexdef(to_regclass($1),$2,true)", name, index+1).Scan(&actual); err != nil || actual != column {
				return legacySessionMismatch()
			}
		}
	}
	return nil
}
