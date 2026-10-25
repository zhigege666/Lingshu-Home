#!/usr/bin/env python3
"""Exercise a 0.0.4 container upgrade and mounted Markdown over verified HTTPS.

Only synthetic, uniquely named containers/volumes and temporary host directories
are used. Both CI and release packaging call this through check_container.py.
The public baseline image is fixed to 0.0.4, never the moving latest alias.
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
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parents[1]
BASELINE_IMAGE = "ghcr.io/zhigege666/lingshu-home:0.0.4"
PRESERVED_TABLES = ("settings", "users", "spaces", "categories", "links", "pages")
DOCUMENT_TABLES = {"document_sources", "documents", "document_bookmarks", "document_published_assets"}


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


def snapshot(data_dir, columns=None):
    """Read only a stopped container's copied SQLite files, never its live volume."""
    path = data_dir / "lingshu-home.db"
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        require(db.execute("PRAGMA integrity_check").fetchone() == ("ok",), "SQLite integrity check failed")
        if columns is None:
            columns = {table: [row[1] for row in db.execute(f'PRAGMA table_info("{table}")')]
                       for table in PRESERVED_TABLES}
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
    keys = {name: hashlib.sha256((data_dir / name).read_bytes()).hexdigest()
            for name in ("csrf.key", "integrations.key")}
    return {"columns": columns, "rows": rows, "migrations": migrations, "tables": tables,
            "contexts": contexts, "keys": keys}


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


def run(image, port):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", port))
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
            print("PASS real 0.0.4 image → candidate upgrade: schema 008, unchanged data/keys, session/PAT and HTTP defaults", flush=True)

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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Exact candidate image already built by CI or release packaging")
    parser.add_argument("--port", type=int, default=5190)
    args = parser.parse_args()
    require(1024 <= args.port <= 65535, "Use an unprivileged loopback test port")
    run(args.image, args.port)


if __name__ == "__main__":
    main()
