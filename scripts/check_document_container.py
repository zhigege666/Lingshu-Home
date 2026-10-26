#!/usr/bin/env python3
"""Exercise published-container upgrades and mounted Markdown over verified HTTPS.

Only synthetic, uniquely named containers/volumes and temporary host directories
are used. Both CI and release packaging call this through check_container.py.
The public baselines are fixed to 0.0.4 and 0.0.5, never the moving latest alias.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parents[1]
BASELINE_IMAGE = "ghcr.io/zhigege666/lingshu-home:0.0.4"
ACTIVITY_BASELINE_IMAGE = "ghcr.io/zhigege666/lingshu-home:0.0.5"
PRESERVED_TABLES = ("settings", "users", "sessions", "spaces", "categories", "links", "pages")
DOCUMENT_TABLES = {"document_sources", "documents", "document_bookmarks", "document_published_assets"}
SESSION_COLUMNS = {"settings": {"default_session_mode", "default_idle_days", "max_idle_days", "allow_until_logout", "session_policy_version"},
                   "sessions": {"session_mode", "idle_days", "created_at", "last_interactive_at", "renewed_at", "user_agent"}}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, base, ca_file=None):
        self.base = base
        self.csrf = ""
        self.cookies = http.cookiejar.CookieJar()
        context = ssl.create_default_context(cafile=str(ca_file) if ca_file else None)
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.cookies),
            urllib.request.HTTPSHandler(context=context), NoRedirect(),
        )

    def api(self, method, path, data=None, *, expected=200, token=None):
        headers = {"Accept": "application/json"}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        elif method not in ("GET", "HEAD"):
            headers["X-CSRF-TOKEN"] = self.csrf
        body = None
        if data is not None:
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + "/api/v1" + path, body, headers, method=method)
        try:
            response = self.opener.open(request, timeout=20)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            value = json.loads(response.read()) if response.status != 204 else None
            code = value.get("code", "") if isinstance(value, dict) else ""
            require(response.status == expected, f"{method} {path}: expected {expected}, got {response.status} ({code})")
            require(response.headers.get("Cache-Control") == "no-store", "API response is cacheable")
        return value

    def boot(self):
        value = self.api("GET", "/bootstrap")
        self.csrf = value["csrfToken"]
        return value

    def ready(self, expected_version):
        for _ in range(150):
            try:
                with self.opener.open(self.base + "/health", timeout=1) as response:
                    value = json.load(response)
                    require(value.get("version") == expected_version, "Health belongs to an unexpected image version")
                    return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("Disposable container did not become healthy")


def snapshot(data_dir, columns=None, *, include_documents=False):
    """Read only a stopped container's copied SQLite files, never its live volume."""
    path = data_dir / "lingshu-home.db"
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        require(db.execute("PRAGMA integrity_check").fetchone() == ("ok",), "SQLite integrity check failed")
        if columns is None:
            preserved = PRESERVED_TABLES + (tuple(sorted(DOCUMENT_TABLES)) if include_documents else ())
            columns = {table: [row[1] for row in db.execute(f'PRAGMA table_info("{table}")')]
                       for table in preserved}
            if include_documents and "last_scan_at" in columns["document_sources"]:
                # A real complete scan advances this observation timestamp.
                # Keep every other old column, including document body hashes,
                # manual metadata, publication snapshots and attachment bytes.
                columns["document_sources"].remove("last_scan_at")
        require(all(columns.values()), "Baseline database is missing an expected table")
        rows = {}
        for table, names in columns.items():
            selected = ",".join('"' + name.replace('"', '""') + '"' for name in names)
            # All selected column names come from the baseline SQLite schema.
            rows[table] = sorted(db.execute(f'SELECT {selected} FROM "{table}"').fetchall(), key=repr)
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        migrations = db.execute("SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version").fetchall()
        has_context = any(row[1] == "context_markdown" for row in db.execute("PRAGMA table_info(links)"))
        contexts = db.execute("SELECT context_markdown FROM links").fetchall() if has_context else None
        event_count = db.execute("SELECT COUNT(*) FROM document_activity").fetchone()[0] if "document_activity" in tables else None
        has_baseline = any(row[1] == "activity_started_at" for row in db.execute("PRAGMA table_info(document_sources)"))
        baselines = db.execute("SELECT id,activity_started_at FROM document_sources WHERE enabled=1 ORDER BY id").fetchall() if has_baseline else None
        session_columns = {table: {row[1] for row in db.execute(f'PRAGMA table_info("{table}")')}
                           for table in SESSION_COLUMNS}
        indexes = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
    keys = {name: hashlib.sha256((data_dir / name).read_bytes()).hexdigest()
            for name in ("csrf.key", "integrations.key")}
    return {"columns": columns, "rows": rows, "migrations": migrations, "tables": tables,
            "contexts": contexts, "keys": keys, "event_count": event_count, "baselines": baselines,
            "session_columns": session_columns, "indexes": indexes}


def check_session_upgrade(after):
    require(any(row[0] == "010_session_retention.sql" for row in after["migrations"]), "Migration 010 was not applied")
    require(all(names <= after["session_columns"][table] for table, names in SESSION_COLUMNS.items())
            and "sessions_retention" in after["indexes"], "Session retention schema was not created")


def check_upgrade(before, after):
    require(len(before["migrations"]) == 7 and before["migrations"][-1][0] == "007_instance_language.sql",
            "The upgrade fixture is not a real pre-library schema 007 database")
    require(after["rows"] == before["rows"], "Upgrade changed existing accounts, settings, spaces, navigation or pages")
    require(after["keys"] == before["keys"], "Upgrade changed an instance key")
    require(after["migrations"][:7] == before["migrations"], "Upgrade rewrote old migration records")
    require(any(row[0] == "008_document_library.sql" for row in after["migrations"]), "Migration 008 was not applied")
    require(DOCUMENT_TABLES <= after["tables"], "Document tables were not created")
    require(after["contexts"] is not None and all(row == ("",) for row in after["contexts"]),
            "Legacy bookmarks did not receive empty usage notes")
    check_session_upgrade(after)


def check_activity_upgrade(before, after):
    require(len(before["migrations"]) == 8 and before["migrations"][-1][0] == "008_document_library.sql"
            and "document_activity" not in before["tables"],
            "The activity upgrade fixture is not a real pre-activity schema 008 database")
    require(all(before["rows"].get(table) for table in DOCUMENT_TABLES),
            "The baseline must contain registered documents, bookmark relationships and published attachments")
    require(after["rows"] == before["rows"],
            "Activity upgrade changed existing accounts, navigation, documents, metadata or published attachments")
    require(after["keys"] == before["keys"], "Activity upgrade changed an instance key")
    require(after["migrations"][:8] == before["migrations"], "Activity upgrade rewrote old migration records")
    require(any(row[0] == "009_document_activity.sql" for row in after["migrations"]), "Migration 009 was not applied")
    require("document_activity" in after["tables"], "Activity table was not created")
    require(after["event_count"] == 0, "Activity upgrade or its first scan fabricated historical activity")
    require(after["baselines"] and all(stamp for _, stamp in after["baselines"]),
            "The first complete scan did not persist the recording baseline")
    check_session_upgrade(after)


def check_recorded_edit(activity, document_id, source_id):
    require(activity["summary"] == {"documents": 1, "activeDays": 1}, "The real post-upgrade edit was not aggregated")
    require(len(activity["days"]) == 1 and activity["days"][0]["count"] == 1
            and activity["days"][0]["created"] == 0 and activity["days"][0]["updated"] == 1,
            "An existing document edit was not counted as one updated document")
    require(activity["total"] == 1 and len(activity["items"]) == 1 and activity["hasMore"] is False,
            "Post-upgrade activity contains unexpected document/day groups")
    item = activity["items"][0]
    require(item["documentId"] == document_id and item["sourceId"] == source_id
            and item["count"] == 1 and item["actions"] == ["update"] and item["origins"] == ["web"],
            "The saved edit was lost, duplicated or assigned the wrong action/origin")


class Containers:
    def __init__(self, docker, prefix, port):
        self.docker, self.prefix, self.port = docker, prefix, port
        self.names = []
        self.volume_created = False

    def command(self, *words):
        return subprocess.check_output([self.docker, *words], text=True).strip()

    def create_volume(self):
        self.command("volume", "create", self.prefix)
        self.volume_created = True

    def start(self, suffix, image, *, environment=(), mounts=()):
        name = self.prefix + "-" + suffix
        self.names.append(name)
        words = ["run", "-d", "--name", name, "--network=host", "--cap-drop=ALL",
                 "--security-opt=no-new-privileges", "-e", f"LINGSHU_LISTEN=127.0.0.1:{self.port}",
                 "-e", "LINGSHU_LANGUAGE=zh-CN", "--mount", f"type=volume,source={self.prefix},target=/data"]
        for value in environment:
            words.extend(["-e", value])
        for source, target, readonly in mounts:
            words.extend(["--mount", f"type=bind,source={source},target={target}" + (",readonly" if readonly else "")])
        self.command(*words, image)
        return name

    def stop(self, name):
        self.command("stop", "--time", "30", name)

    def copy_stopped_data(self, name, destination):
        require(self.command("inspect", "--format", "{{.State.Running}}", name) == "false",
                "Refusing to copy a live SQLite database")
        destination.mkdir()
        self.command("cp", name + ":/data/.", str(destination))

    def close(self):
        for name in reversed(self.names):
            subprocess.run([self.docker, "rm", "-f", name], stdout=subprocess.DEVNULL, check=False)
        if self.volume_created:
            subprocess.run([self.docker, "volume", "rm", self.prefix], stdout=subprocess.DEVNULL, check=False)


def test_certificate(folder):
    cert, key = folder / "fullchain.pem", folder / "privkey.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
                    "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext",
                    "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", str(key), "-out", str(cert)],
                   check=True, capture_output=True)
    # Disposable certificates only; the container's unprivileged UID must read them.
    cert.chmod(0o644)
    key.chmod(0o644)
    return cert


def verify_tls_boundary(base, port, certificate):
    untrusted = Client(base)
    try:
        untrusted.opener.open(base + "/health", timeout=5)
    except urllib.error.URLError as exc:
        require(isinstance(exc.reason, ssl.SSLCertVerificationError), "Untrusted TLS failed for an unexpected reason")
    else:
        raise RuntimeError("HTTPS accepted an untrusted fixture certificate")
    context = ssl.create_default_context(cafile=str(certificate))
    with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
        try:
            with context.wrap_socket(connection, server_hostname="not-this-fixture.invalid"):
                pass
        except ssl.SSLCertVerificationError:
            pass
        else:
            raise RuntimeError("HTTPS accepted a hostname outside the certificate")
    plain = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with plain.open(f"http://127.0.0.1:{port}/health", timeout=5):
            raise RuntimeError("TLS listener served successful plaintext HTTP")
    except urllib.error.HTTPError as exc:
        require(exc.code == 400, "Unexpected plaintext response on TLS listener")


def check_available_port(port):
    with socket.socket() as probe:
        # The preceding container suite has just closed this port. Match Go's
        # listener reuse policy so its TIME_WAIT connections do not look like
        # an active listener; a process still listening must continue to fail.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(("127.0.0.1", port))


def run(image, port):
    check_available_port(port)
    expected_version = (ROOT / "VERSION").read_text().strip()
    containers = Containers(os.environ.get("LINGSHU_DOCKER", "docker"),
                            "lingshu-upgrade-test-" + uuid.uuid4().hex[:10], port)
    with tempfile.TemporaryDirectory(prefix="lingshu-container-upgrade-") as temp:
        work = Path(temp)
        work.chmod(0o755)
        try:
            containers.create_volume()
            old = containers.start("old", BASELINE_IMAGE)
            client = Client(f"http://127.0.0.1:{port}")
            client.ready("0.0.4")
            require(client.boot()["initialized"] is False, "Refusing to seed an existing instance")
            password = secrets.token_urlsafe(24)
            client.api("POST", "/setup", {"siteName": "Container upgrade fixture", "mode": "private_single",
                       "username": "upgrade-owner", "password": password, "seedDemo": False}, expected=201)
            boot = client.boot()
            shared = next(space["id"] for space in boot["spaces"] if space["kind"] == "shared")
            category = client.api("POST", f"/spaces/{shared}/categories",
                                  {"name": "Preserved category", "icon": "lucide:folder"}, expected=201)
            bookmark = client.api("POST", f"/spaces/{shared}/links", {"categoryId": category["id"],
                                  "title": "Preserved bookmark", "url": "https://example.com/upgrade-fixture",
                                  "description": "Old description", "icon": "lucide:link", "iconMode": "manual",
                                  "tags": ["upgrade"], "isFavorite": True, "endpoints": []}, expected=201)
            token = client.api("POST", "/integrations/tokens", {"name": "Upgrade fixture", "spaceId": shared,
                               "sourceId": None, "actions": ["navigation:read"],
                               "expiresAt": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()}, expected=201)["token"]
            containers.stop(old)
            containers.copy_stopped_data(old, work / "before")
            before = snapshot(work / "before")

            upgraded = containers.start("upgraded", image)
            client.ready(expected_version)
            upgraded_boot = client.boot()
            require(upgraded_boot["user"]["id"] == boot["user"]["id"], "Existing login session was lost")
            require(upgraded_boot["siteName"] == boot["siteName"] and upgraded_boot["language"] == "zh-CN",
                    "Upgrade changed instance identity or language")
            navigation = client.api("GET", f"/spaces/{shared}/navigation", token=token)
            require(navigation["data"]["links"][0]["id"] == bookmark["id"], "Existing PAT or bookmark did not survive")
            roots = client.api("GET", f"/spaces/{shared}/document-sources")
            require(roots["roots"] == [] and roots["items"] == [], "Upgrade enabled filesystem access by default")
            client.api("POST", f"/spaces/{shared}/document-sources",
                       {"name": "Unauthorized root", "path": "/documents/notes"}, expected=503)
            containers.stop(upgraded)
            containers.copy_stopped_data(upgraded, work / "after")
            check_upgrade(before, snapshot(work / "after", before["columns"]))
            print("PASS real 0.0.4 image → candidate upgrade: document and session migrations through 010, unchanged data/keys, session/PAT and HTTP defaults", flush=True)

            notes, projects, certs = (work / name for name in ("notes", "projects", "certs"))
            for folder in (notes, projects, certs):
                folder.mkdir(mode=0o755)
            notes.chmod(0o777)
            projects.chmod(0o777)  # Only the actual read-only bind must deny the probe below.
            original = b"---\r\ncustom: preserve\r\n---\r\n# Mounted original\r\n"
            (notes / "README.md").write_bytes(original)
            (projects / "README.md").write_text("# Read-only project\n")
            certificate = test_certificate(certs)
            environment = ['LINGSHU_DOCUMENT_ROOTS=["/documents/notes","/documents/projects"]',
                           "LINGSHU_TLS_CERT_FILE=/certs/fullchain.pem", "LINGSHU_TLS_KEY_FILE=/certs/privkey.pem"]
            mounts = [(notes, "/documents/notes", False), (projects, "/documents/projects", True), (certs, "/certs", True)]
            encrypted = containers.start("tls", image, environment=environment, mounts=mounts)
            secure = Client(f"https://127.0.0.1:{port}", certificate)
            secure.ready(expected_version)
            verify_tls_boundary(secure.base, port, certificate)
            secure.boot()
            secure.api("POST", "/auth/login", {"username": "upgrade-owner", "password": password})
            secure.boot()
            require(len(secure.cookies) >= 2 and all(cookie.secure for cookie in secure.cookies), "TLS cookies are not Secure")
            source_base = f"/spaces/{shared}/document-sources"
            source = secure.api("POST", source_base, {"name": "Writable notes", "path": "/documents/notes",
                                "readOnly": False, "defaultWrite": True}, expected=201)
            denied = secure.api("POST", source_base, {"name": "Cannot bypass read-only mount",
                                "path": "/documents/projects", "readOnly": False}, expected=403)
            require(denied["code"] == "document_file_read_only", "Docker read-only bind did not enforce write denial")
            readonly = secure.api("POST", source_base, {"name": "Read-only projects", "path": "/documents/projects"}, expected=201)
            require((notes / "README.md").read_bytes() == original, "Import rewrote the mounted Markdown original")
            document_base = f"/spaces/{shared}/documents"
            documents = secure.api("GET", document_base)["items"]
            require(len(documents) == 2, "Multiple mounted sources did not aggregate")
            document = next(doc for doc in documents if doc["sourceId"] == source["id"])
            protected = next(doc for doc in documents if doc["sourceId"] == readonly["id"])
            path = document_base + "/" + document["id"]
            saved = secure.api("PUT", path, {"content": "# Saved through HTTPS\n", "expectedRevision": document["revision"]})
            require((notes / "README.md").read_bytes() == saved["content"].encode(), "HTTPS save did not update the host original")
            history = secure.api("GET", path + "/history")["items"]
            require(len(history) == 1 and secure.api("GET", path + "/history/" + history[0]["revision"])["content"].encode() == original,
                    "Container recovery history did not retain the original bytes")
            secure.api("PUT", document_base + "/" + protected["id"],
                       {"content": "forbidden", "expectedRevision": protected["revision"]}, expected=403)
            saved = secure.api("PUT", path + "/metadata", {"expectedRevision": saved["revision"],
                               "expectedMetadataRevision": saved["metadataRevision"], "tags": ["survives-mount-loss"],
                               "linkedBookmarkIds": [bookmark["id"]]})
            # An empty-but-present mount must not mark its known documents missing.
            (notes / "README.md").rename(work / "held-original.md")
            scan = secure.api("POST", source_base + "/" + source["id"] + "/scan", {})
            require(scan["status"] == "error", "Unexpectedly empty mount did not trigger the missing-file guard")
            retained = secure.api("GET", document_base)["items"]
            require(next(doc for doc in retained if doc["id"] == document["id"])["status"] == "ready",
                    "Empty mount erased the known document state")
            (work / "held-original.md").rename(notes / "README.md")
            secure.api("POST", source_base + "/" + source["id"] + "/scan", {})
            containers.stop(encrypted)

            # Recreate with the same data/config but one mount omitted, as a disconnected NAS might appear.
            offline = containers.start("offline", image, environment=environment, mounts=mounts[1:])
            secure.ready(expected_version)
            secure.boot()
            scan = secure.api("POST", source_base + "/" + source["id"] + "/scan", {})
            require(scan["status"] == "offline", "Missing mount was not reported offline")
            missing = secure.api("GET", path)
            require(missing["unavailableReason"] == "source_unavailable" and missing["tags"] == saved["tags"]
                    and missing["linkedBookmarkIds"] == [bookmark["id"]], "Missing mount discarded document metadata")
            require(secure.api("GET", f"/spaces/{shared}/navigation")["data"]["links"][0]["id"] == bookmark["id"],
                    "Missing mount interrupted existing navigation")
            containers.stop(offline)
            containers.start("reconnected", image, environment=environment, mounts=mounts)
            secure.ready(expected_version)
            secure.boot()
            secure.api("POST", source_base + "/" + source["id"] + "/scan", {})
            restored = secure.api("GET", path)
            require(restored["id"] == saved["id"] and restored["content"] == saved["content"]
                    and restored["tags"] == saved["tags"], "Reconnect lost original bytes or durable document metadata")
            print("PASS container bind mounts + verified HTTPS: originals, read-only enforcement, history, empty/offline retention and reconnect", flush=True)
        finally:
            containers.close()
    run_activity_upgrade(image, port)


def run_activity_upgrade(image, port):
    """Upgrade real 0.0.5 document data using the same volume and bind mount."""
    check_available_port(port)
    expected_version = (ROOT / "VERSION").read_text().strip()
    containers = Containers(os.environ.get("LINGSHU_DOCKER", "docker"),
                            "lingshu-activity-upgrade-" + uuid.uuid4().hex[:10], port)
    with tempfile.TemporaryDirectory(prefix="lingshu-activity-upgrade-") as temp:
        work = Path(temp)
        work.chmod(0o755)
        notes = work / "notes"
        notes.mkdir()
        notes.chmod(0o777)  # Disposable originals only, writable by the image's unprivileged UID.
        original = b"---\r\ncustom: retain-before-activity\r\n---\r\n# Existing guide\r\n[Attachment](attachment.txt)\r\n"
        attachment = b"Published attachment from 0.0.5\n"
        (notes / "README.md").write_bytes(original)
        (notes / "attachment.txt").write_bytes(attachment)
        os.utime(notes / "README.md", (946684800, 946684800))
        environment = ['LINGSHU_DOCUMENT_ROOTS=["/documents/existing"]']
        mounts = [(notes, "/documents/existing", False)]
        try:
            containers.create_volume()
            old = containers.start("old", ACTIVITY_BASELINE_IMAGE, environment=environment, mounts=mounts)
            client = Client(f"http://127.0.0.1:{port}")
            client.ready("0.0.5")
            require(client.boot()["initialized"] is False, "Refusing to seed an existing instance")
            client.api("POST", "/setup", {"siteName": "Document activity upgrade fixture", "mode": "private_single",
                       "username": "activity-owner", "password": secrets.token_urlsafe(24), "seedDemo": False}, expected=201)
            boot = client.boot()
            shared = next(space["id"] for space in boot["spaces"] if space["kind"] == "shared")
            category = client.api("POST", f"/spaces/{shared}/categories",
                                  {"name": "Existing documents", "icon": "lucide:folder"}, expected=201)
            bookmark = client.api("POST", f"/spaces/{shared}/links", {"categoryId": category["id"],
                                  "title": "Existing related bookmark", "url": "https://example.com/activity-upgrade",
                                  "description": "Retain navigation and document relationship", "icon": "lucide:link",
                                  "iconMode": "manual", "tags": ["existing"], "isFavorite": True, "endpoints": []}, expected=201)
            token = client.api("POST", "/integrations/tokens", {"name": "Existing document reader", "spaceId": shared,
                               "sourceId": None, "actions": ["navigation:read", "documents:read"],
                               "expiresAt": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()}, expected=201)["token"]
            source_base = f"/spaces/{shared}/document-sources"
            source = client.api("POST", source_base, {"name": "Existing mounted notes", "path": "/documents/existing",
                                "readOnly": False, "defaultWrite": True, "scanIntervalSeconds": 86400}, expected=201)
            document_base = f"/spaces/{shared}/documents"
            documents = client.api("GET", document_base)["items"]
            require(len(documents) == 1 and documents[0]["sourceId"] == source["id"],
                    "The published 0.0.5 fixture did not index its mounted original")
            document = documents[0]
            path = document_base + "/" + document["id"]
            document = client.api("PUT", path + "/metadata", {"expectedRevision": document["revision"],
                                  "expectedMetadataRevision": document["metadataRevision"], "tags": ["preserved-before-activity"],
                                  "linkedBookmarkIds": [bookmark["id"]]})
            client.api("POST", path + "/publish", {"expectedRevision": document["revision"],
                       "expectedMetadataRevision": document["metadataRevision"]})
            require((notes / "README.md").read_bytes() == original and (notes / "attachment.txt").read_bytes() == attachment,
                    "The published baseline image rewrote its original or attachment")
            containers.stop(old)
            containers.copy_stopped_data(old, work / "before")
            before = snapshot(work / "before", include_documents=True)

            upgraded = containers.start("upgraded", image, environment=environment, mounts=mounts)
            client.ready(expected_version)
            upgraded_boot = client.boot()
            require(upgraded_boot["user"]["id"] == boot["user"]["id"], "Activity upgrade lost the existing login session")
            require(all(upgraded_boot[key] == boot[key] for key in ("siteName", "mode", "language")),
                    "Activity upgrade changed instance identity, mode or language")
            navigation = client.api("GET", f"/spaces/{shared}/navigation", token=token)
            require(navigation["data"]["links"][0]["id"] == bookmark["id"], "Activity upgrade lost the existing PAT or navigation")
            retained = client.api("GET", path, token=token)
            require(retained["id"] == document["id"] and retained["content"].encode() == original
                    and retained["tags"] == document["tags"] and retained["linkedBookmarkIds"] == [bookmark["id"]]
                    and retained["published"] is True, "Activity upgrade lost original content, metadata or publication")
            scan_path = source_base + "/" + source["id"] + "/scan"
            require(client.api("POST", scan_path, {})["status"] == "ready", "The upgraded source could not complete its baseline scan")
            now = datetime.now(timezone.utc)
            query = urllib.parse.urlencode({"from": (now - timedelta(days=1)).date().isoformat(),
                                            "to": (now + timedelta(days=1)).date().isoformat(),
                                            "timezone": "UTC", "sourceIds": source["id"]})
            activity_path = f"/spaces/{shared}/document-activity?{query}"
            baseline = client.api("GET", activity_path + "&perspective=library")
            require(baseline["summary"] == {"documents": 0, "activeDays": 0} and baseline["days"] == []
                    and baseline["items"] == [] and baseline["total"] == 0 and baseline["hasMore"] is False,
                    "The first post-upgrade scan fabricated document activity")
            require(baseline["recordedFrom"] and len(baseline["sources"]) == 1
                    and baseline["sources"][0]["id"] == source["id"]
                    and baseline["sources"][0]["recordedFrom"] == baseline["recordedFrom"],
                    "The upgraded source did not expose its recording baseline")
            require((notes / "README.md").read_bytes() == original and (notes / "attachment.txt").read_bytes() == attachment,
                    "Activity upgrade or its baseline scan changed original files")
            containers.stop(upgraded)
            containers.copy_stopped_data(upgraded, work / "after-baseline")
            check_activity_upgrade(before, snapshot(work / "after-baseline", before["columns"]))

            # Reopen the same volume so the next edit also tests a durable baseline.
            containers.command("start", upgraded)
            client.ready(expected_version)
            client.boot()
            saved = client.api("PUT", path, {"content": original.decode() + "Saved after upgrade.\n",
                               "expectedRevision": retained["revision"]})
            require((notes / "README.md").read_bytes() == saved["content"].encode()
                    and (notes / "attachment.txt").read_bytes() == attachment,
                    "Post-upgrade save did not preserve the mounted file contract")
            require(saved["tags"] == document["tags"] and saved["linkedBookmarkIds"] == [bookmark["id"]]
                    and saved["published"] is True, "Post-upgrade save discarded existing manual metadata or publication")
            check_recorded_edit(client.api("GET", activity_path + "&perspective=mine"), document["id"], source["id"])
            require(client.api("POST", scan_path, {})["status"] == "ready", "Post-save scan failed")
            after_scan = client.api("GET", activity_path + "&perspective=library")
            check_recorded_edit(after_scan, document["id"], source["id"])
            require(after_scan["recordedFrom"] == baseline["recordedFrom"], "Restart or save reset the recording baseline")
            containers.stop(upgraded)
            containers.copy_stopped_data(upgraded, work / "after-edit")
            require(snapshot(work / "after-edit")["event_count"] == 1,
                    "The persisted activity log lost or duplicated the post-upgrade edit")
            print("PASS real 0.0.5 image → candidate upgrade: activity/session migrations 009/010, existing documents/metadata/attachments/sessions/keys, zero-event baseline, real edit and scan deduplication", flush=True)
        finally:
            containers.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Exact candidate image already built by CI or release packaging")
    parser.add_argument("--port", type=int, default=5190)
    args = parser.parse_args()
    require(1024 <= args.port <= 65535, "Use an unprivileged loopback test port")
    run(args.image, args.port)


if __name__ == "__main__":
    main()
