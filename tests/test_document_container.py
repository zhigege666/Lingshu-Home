"""Regression checks for the destructive-upgrade assertions used by image CI."""
from __future__ import annotations

from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import check_document_container as check


class UpgradeEvidenceTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="lingshu-upgrade-assertion-")
        self.addCleanup(folder.cleanup)
        self.before = Path(folder.name) / "before"
        self.after = Path(folder.name) / "after"
        self.before.mkdir()
        for key in ("csrf.key", "integrations.key"):
            (self.before / key).write_bytes(b"disposable-fixture-key-material")
        with sqlite3.connect(self.before / "lingshu-home.db") as db:
            db.execute("CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,checksum TEXT,applied_at TEXT)")
            migrations = ["001_initial.sql", "002_integrations.sql", "003_icons.sql", "004_component_sources.sql",
                          "005_auto_icons.sql", "006_network_routing.sql", "007_instance_language.sql"]
            db.executemany("INSERT INTO schema_migrations VALUES(?,?,?)", [(name, "old-checksum", "old-date") for name in migrations])
            for table in check.PRESERVED_TABLES:
                db.execute(f"CREATE TABLE {table}(id TEXT PRIMARY KEY,fixture_value TEXT)")
                db.execute(f"INSERT INTO {table} VALUES('existing-id','preserve-me')")
        shutil.copytree(self.before, self.after)
        with sqlite3.connect(self.after / "lingshu-home.db") as db:
            db.execute("ALTER TABLE links ADD COLUMN context_markdown TEXT NOT NULL DEFAULT ''")
            db.execute("INSERT INTO schema_migrations VALUES('008_document_library.sql','new-checksum','new-date')")
            for table in check.DOCUMENT_TABLES:
                db.execute(f"CREATE TABLE {table}(id TEXT PRIMARY KEY)")

    def verify(self):
        before = check.snapshot(self.before)
        check.check_upgrade(before, check.snapshot(self.after, before["columns"]))

    def test_additive_migration_passes_with_original_rows_and_keys(self):
        self.verify()

    def test_missing_existing_bookmark_fails_even_when_new_tables_exist(self):
        with sqlite3.connect(self.after / "lingshu-home.db") as db:
            db.execute("DELETE FROM links")
        with self.assertRaisesRegex(RuntimeError, "existing accounts"):
            self.verify()

    def test_replaced_instance_key_fails(self):
        (self.after / "integrations.key").write_bytes(b"unexpected-regenerated-key")
        with self.assertRaisesRegex(RuntimeError, "instance key"):
            self.verify()

    def test_rewritten_migration_checksum_fails(self):
        with sqlite3.connect(self.after / "lingshu-home.db") as db:
            db.execute("UPDATE schema_migrations SET checksum='changed' WHERE version='001_initial.sql'")
        with self.assertRaisesRegex(RuntimeError, "migration records"):
            self.verify()

    def test_missing_migration_008_fails(self):
        with sqlite3.connect(self.after / "lingshu-home.db") as db:
            db.execute("DELETE FROM schema_migrations WHERE version='008_document_library.sql'")
        with self.assertRaisesRegex(RuntimeError, "008 was not applied"):
            self.verify()

    def test_unexpected_bookmark_context_fails(self):
        with sqlite3.connect(self.after / "lingshu-home.db") as db:
            db.execute("UPDATE links SET context_markdown='unexpected replacement'")
        with self.assertRaisesRegex(RuntimeError, "empty usage notes"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
