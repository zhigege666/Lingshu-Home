"""Regression checks for the destructive-upgrade assertions used by image CI."""
from __future__ import annotations

import errno
import hashlib
from pathlib import Path
import shutil
import socket
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import check_document_container as check


class ContainerPortTests(unittest.TestCase):
    def test_unused_port_is_available(self):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        check.check_available_port(port)

    def test_active_listener_is_rejected_even_with_address_reuse(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            with self.assertRaises(OSError) as raised:
                check.check_available_port(listener.getsockname()[1])
            self.assertEqual(raised.exception.errno, errno.EADDRINUSE)

    @unittest.skipUnless(sys.platform == "linux", "Linux container port-reuse regression")
    def test_closed_listener_time_wait_does_not_block_next_container(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(2)
                    # Close the server side first to leave its local port in
                    # TIME_WAIT, as the preceding HTTP container can do.
                    connection.shutdown(socket.SHUT_WR)
                    self.assertEqual(client.recv(1), b"")
                    client.shutdown(socket.SHUT_WR)
                    self.assertEqual(connection.recv(1), b"")
        with socket.socket() as old_probe:
            with self.assertRaises(OSError) as raised:
                old_probe.bind(("127.0.0.1", port))
            self.assertEqual(raised.exception.errno, errno.EADDRINUSE)
        check.check_available_port(port)


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
            db.execute("INSERT INTO schema_migrations VALUES('010_session_retention.sql','session-checksum','session-date')")
            for table, names in check.SESSION_COLUMNS.items():
                for name in sorted(names):
                    db.execute(f"ALTER TABLE {table} ADD COLUMN {name} TEXT")
            db.execute("CREATE INDEX sessions_retention ON sessions(session_mode,idle_days)")

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


class ActivityUpgradeEvidenceTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="lingshu-activity-upgrade-assertion-")
        self.addCleanup(folder.cleanup)
        self.before = Path(folder.name) / "before"
        self.after = Path(folder.name) / "after"
        self.before.mkdir()
        for key in ("csrf.key", "integrations.key"):
            (self.before / key).write_bytes(b"disposable-activity-fixture-key-material")
        migrations = check.ROOT / "server/internal/home/migrations/sqlite"
        with sqlite3.connect(self.before / "lingshu-home.db") as db:
            db.execute("CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,checksum TEXT,applied_at TEXT)")
            for migration in sorted(migrations.glob("*.sql"))[:8]:
                body = migration.read_bytes()
                db.executescript(body.decode())
                db.execute("INSERT INTO schema_migrations VALUES(?,?,?)",
                           (migration.name, hashlib.sha256(body).hexdigest(), "old-date"))
                db.commit()
            db.executescript("""
                UPDATE settings SET initialized=1,site_name='Existing instance',mode='private_single',language='zh-CN';
                INSERT INTO users(id,username,normalized_username,display_name,role,is_enabled,password_hash,created_at)
                  VALUES('owner','fixture','fixture','Existing owner','Owner',1,'synthetic-hash','old-date');
                INSERT INTO sessions(token_hash,user_id,auth_epoch,user_version,expires_at)
                  VALUES('existing-session','owner',1,1,'2099-10-25T01:02:03Z');
                INSERT INTO spaces(id,name,kind,published,updated_at) VALUES('space','Existing space','shared',0,'old-date');
                INSERT INTO categories(id,space_id,name,icon) VALUES('category','space','Existing category','lucide:folder');
                INSERT INTO links(id,space_id,category_id,title,url,canonical_url,description,icon,tags,is_favorite,endpoints,updated_at,context_markdown)
                  VALUES('bookmark','space','category','Existing bookmark','https://example.com/','https://example.com/',
                         'Original description','lucide:link','["keep"]',1,'[]','old-date','Existing context');
                INSERT INTO pages(id,space_id,name,config) VALUES('page','space','Existing page','{}');
                INSERT INTO document_sources(id,space_id,name,path,read_only,default_write,status,last_scan_at)
                  VALUES('source','space','Existing source','/documents/existing',0,1,'ready','old-scan');
                INSERT INTO documents(id,source_id,space_id,relative_path,title,revision,metadata_revision,size,updated_at,
                                      tags,search_text,published_revision,published_content,published_title,published_path,
                                      published_source_name,published_at,published_tags,published_bookmarks)
                  VALUES('document','source','space','README.md','Existing document','old-hash',4,15,'old-mtime',
                         '["keep"]','# Existing body','old-hash','# Existing body','Existing document','README.md',
                         'Existing source','old-publication','["keep"]','["bookmark"]');
                INSERT INTO document_bookmarks VALUES('document','bookmark');
                INSERT INTO document_published_assets VALUES('document','attachment.txt','application/octet-stream',X'000102');
            """)
        shutil.copytree(self.before, self.after)
        with sqlite3.connect(self.after / "lingshu-home.db") as db:
            body = (migrations / "009_document_activity.sql").read_bytes()
            db.executescript(body.decode())
            db.execute("INSERT INTO schema_migrations VALUES(?,?,?)",
                       ("009_document_activity.sql", hashlib.sha256(body).hexdigest(), "new-date"))
            db.execute("UPDATE document_sources SET activity_started_at='2026-10-26T10:20:30Z',last_scan_at='new-scan'")
            db.commit()
            body = (migrations / "010_session_retention.sql").read_bytes()
            db.executescript(body.decode())
            db.execute("INSERT INTO schema_migrations VALUES(?,?,?)",
                       ("010_session_retention.sql", hashlib.sha256(body).hexdigest(), "session-date"))

    def verify(self):
        before = check.snapshot(self.before, include_documents=True)
        check.check_activity_upgrade(before, check.snapshot(self.after, before["columns"]))

    def test_additive_activity_migration_and_new_scan_timestamp_preserve_old_data(self):
        self.verify()

    def test_changed_document_metadata_fails(self):
        with sqlite3.connect(self.after / "lingshu-home.db") as db:
            db.execute("UPDATE documents SET tags='[]'")
        with self.assertRaisesRegex(RuntimeError, "documents, metadata"):
            self.verify()

    def test_deleted_published_attachment_fails(self):
        with sqlite3.connect(self.after / "lingshu-home.db") as db:
            db.execute("DELETE FROM document_published_assets")
        with self.assertRaisesRegex(RuntimeError, "published attachments"):
            self.verify()

    def test_missing_migration_009_fails(self):
        with sqlite3.connect(self.after / "lingshu-home.db") as db:
            db.execute("DELETE FROM schema_migrations WHERE version='009_document_activity.sql'")
        with self.assertRaisesRegex(RuntimeError, "009 was not applied"):
            self.verify()

    def test_missing_activity_table_fails(self):
        with sqlite3.connect(self.after / "lingshu-home.db") as db:
            db.execute("DROP TABLE document_activity")
        with self.assertRaisesRegex(RuntimeError, "Activity table was not created"):
            self.verify()

    def test_fabricated_historical_activity_outside_api_date_range_fails(self):
        with sqlite3.connect(self.after / "lingshu-home.db") as db:
            db.execute("""INSERT INTO document_activity(id,document_id,source_id,space_id,action,origin,occurred_at,observed_at)
                          VALUES('fabricated','document','source','space','create','external','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z')""")
        with self.assertRaisesRegex(RuntimeError, "fabricated historical activity"):
            self.verify()

    def test_missing_first_scan_baseline_fails(self):
        with sqlite3.connect(self.after / "lingshu-home.db") as db:
            db.execute("UPDATE document_sources SET activity_started_at=''")
        with self.assertRaisesRegex(RuntimeError, "persist the recording baseline"):
            self.verify()

    def test_missing_session_migration_fails(self):
        with sqlite3.connect(self.after / "lingshu-home.db") as db:
            db.execute("DELETE FROM schema_migrations WHERE version='010_session_retention.sql'")
        with self.assertRaisesRegex(RuntimeError, "010 was not applied"):
            self.verify()

    def test_missing_session_retention_column_fails(self):
        with sqlite3.connect(self.after / "lingshu-home.db") as db:
            db.execute("ALTER TABLE sessions DROP COLUMN user_agent")
        with self.assertRaisesRegex(RuntimeError, "Session retention schema"):
            self.verify()

    def test_changed_existing_session_expiry_fails(self):
        with sqlite3.connect(self.after / "lingshu-home.db") as db:
            db.execute("UPDATE sessions SET expires_at='2099-11-25T01:02:03Z'")
        with self.assertRaisesRegex(RuntimeError, "existing accounts"):
            self.verify()


class ActivityEditEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.activity = {"summary": {"documents": 1, "activeDays": 1},
                         "days": [{"date": "2026-10-26", "count": 1, "created": 0, "updated": 1}],
                         "total": 1, "hasMore": False,
                         "items": [{"documentId": "document", "sourceId": "source", "count": 1,
                                    "actions": ["update"], "origins": ["web"]}]}

    def test_one_post_upgrade_browser_edit_passes(self):
        check.check_recorded_edit(self.activity, "document", "source")

    def test_duplicate_event_hidden_by_daily_document_deduplication_fails(self):
        self.activity["items"][0]["count"] = 2
        with self.assertRaisesRegex(RuntimeError, "duplicated"):
            check.check_recorded_edit(self.activity, "document", "source")


if __name__ == "__main__":
    unittest.main()
