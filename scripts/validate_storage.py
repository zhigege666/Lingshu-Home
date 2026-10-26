#!/usr/bin/env python3
"""Exercise storage bootstrap using owned processes and disposable databases.

The PostgreSQL option requires a fresh dedicated database in
LINGSHU_STORAGE_ACCEPTANCE_POSTGRES_URL. It never drops an existing database.
Logs and generated instance data stay in the private output directory.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import selectors
import socket
import socketserver
import sqlite3
import stat
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
STORAGE_FILE = "storage.json"


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class Instance:
    def __init__(self, binary, folder, *, overrides=None, flags=()):
        self.binary = Path(binary).resolve()
        self.folder = Path(folder)
        self.folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.data = self.folder / "data"
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("LINGSHU_", "PG"))}
        self.env.update({
            "LINGSHU_LISTEN": f"127.0.0.1:{self.port}",
            "LINGSHU_DATA_DIR": str(self.data),
            "LINGSHU_WEB_DIR": str(ROOT / "web/dist"),
            "LINGSHU_VERSION_FILE": str(ROOT / "VERSION"),
            "LINGSHU_LANGUAGE": "zh-CN",
            "LINGSHU_SECURE_COOKIES": "false",
        })
        self.env.update(overrides or {})
        self.flags = list(flags)
        self.process = None
        self.log = None
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, path, body=None, *, token=None, origin=None, method=None):
        headers = {"Accept": "application/json"}
        if body is not None:
            headers.update({"Content-Type": "application/json"})
        if token is not None:
            headers["X-CSRF-TOKEN"] = token
        if origin is not None:
            headers["Origin"] = origin
        request = urllib.request.Request(
            self.url + path, headers=headers,
            data=json.dumps(body).encode() if body is not None else None,
            method=method)
        try:
            response = self.opener.open(request, timeout=40)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            try:
                value = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                value = None
            return response.status, value, dict(response.headers), raw

    def api(self, path, body=None, *, token=None, expected=200, origin=None):
        status, value, headers, raw = self.request(
            "/api/v1" + path, body, token=token, origin=origin)
        assert status == expected, f"{path}: expected {expected}, received {status}"
        assert headers.get("Cache-Control") == "no-store", f"{path}: missing no-store"
        return value

    def start(self, *, legacy=False, allow_rejection=False):
        assert self.process is None
        self.log = (self.folder / "server.log").open("ab")
        os.chmod(self.folder / "server.log", 0o600)
        self.process = subprocess.Popen(
            [str(self.binary), *self.flags], cwd=ROOT, env=self.env,
            stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 45
        route = "/api/v1/bootstrap" if legacy else "/api/v1/storage/bootstrap"
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                if allow_rejection and self.process.returncode != 0:
                    return None
                raise AssertionError("owned server exited; inspect its private server.log")
            try:
                status, value, _, _ = self.request(route)
                if status in (200, 503) and isinstance(value, dict):
                    return value
            except (OSError, ValueError):
                pass
            time.sleep(0.1)
        raise AssertionError("owned server did not expose its bootstrap state")

    def stop(self):
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=25)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
                    raise AssertionError("owned process required forced termination")
            self.process = None
        if self.log:
            self.log.close()
            self.log = None

    def configure(self, value):
        bootstrap = self.api("/storage/bootstrap")
        assert bootstrap["state"] == "required"
        response = self.api("/storage/configure", value, token=bootstrap["csrfToken"])
        assert response["state"] == "ready"
        return response

    def setup(self, name):
        bootstrap = self.api("/bootstrap")
        if bootstrap.get("languageSelectionRequired"):
            bootstrap = self.api("/setup/language", {"language": "zh-CN"},
                                 token=bootstrap["csrfToken"])
        assert not bootstrap["initialized"]
        self.api("/setup", {
            "siteName": name, "mode": "public_read", "username": "storage_owner",
            "displayName": "Storage fixture owner",
            "password": secrets.token_urlsafe(24), "seedDemo": True,
        }, token=bootstrap["csrfToken"], expected=201)
        return self.fingerprint()

    def fingerprint(self):
        value = self.api("/bootstrap")
        assert value["initialized"], "the original initialized database must remain selected"
        navigation = {}
        pages = {}
        for space in value["spaces"]:
            current = self.api("/spaces/" + space["id"] + "/navigation")
            navigation[space["id"]] = {"revision": current["revision"], "data": current["data"]}
            pages[space["id"]] = self.api("/spaces/" + space["id"] + "/page")
        return {
            "siteName": value["siteName"], "language": value["language"],
            "spaces": sorted((space["id"], space["kind"]) for space in value["spaces"]),
            "owner": value["user"]["id"] if value.get("user") else None,
            "navigation": navigation, "pages": pages,
        }


class Relay(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    block_on_close = False


class RelayHandler(socketserver.BaseRequestHandler):
    def handle(self):
        with self.server.active_lock:
            self.server.active.add(self.request)
        try:
            with socket.create_connection(self.server.target, timeout=5) as upstream:
                with self.server.active_lock:
                    self.server.active.add(upstream)
                try:
                    with selectors.DefaultSelector() as selector:
                        selector.register(self.request, selectors.EVENT_READ, upstream)
                        selector.register(upstream, selectors.EVENT_READ, self.request)
                        while not self.server.stopping.is_set():
                            for key, _ in selector.select(0.2):
                                data = key.fileobj.recv(65536)
                                if not data:
                                    return
                                key.data.sendall(data)
                finally:
                    with self.server.active_lock:
                        self.server.active.discard(upstream)
        except OSError:
            pass
        finally:
            with self.server.active_lock:
                self.server.active.discard(self.request)


class DatabaseRelay:
    def __init__(self, host, port):
        self.target = host, port
        self.port = free_port()
        self.server = None

    def start(self):
        self.server = Relay(("127.0.0.1", self.port), RelayHandler)
        self.server.target = self.target
        self.server.active = set()
        self.server.active_lock = threading.Lock()
        self.server.stopping = threading.Event()
        threading.Thread(target=self.server.serve_forever,
                         kwargs={"poll_interval": 0.1}, daemon=True).start()

    def stop(self):
        if self.server is None:
            return
        self.server.stopping.set()
        self.server.shutdown()
        with self.server.active_lock:
            sockets = list(self.server.active)
        for connection in sockets:
            try:
                connection.shutdown(socket.SHUT_RDWR)
                connection.close()
            except OSError:
                pass
        self.server.server_close()
        self.server = None


def postgres_table_count(url):
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    parsed = urllib.parse.urlsplit(url)
    parameters = urllib.parse.parse_qs(parsed.query)
    env.update({"PGHOST": parsed.hostname or "", "PGPORT": str(parsed.port or 5432),
                "PGUSER": urllib.parse.unquote(parsed.username or ""),
                "PGPASSWORD": urllib.parse.unquote(parsed.password or ""),
                "PGDATABASE": urllib.parse.unquote(parsed.path.lstrip("/")),
                "PGSSLMODE": parameters.get("sslmode", ["require"])[0],
                "PGCONNECT_TIMEOUT": "5"})
    certificate = parameters.get("sslrootcert", [os.environ.get("PGSSLROOTCERT") or os.environ.get("SSL_CERT_FILE", "")])[0]
    if certificate:
        env["PGSSLROOTCERT"] = certificate
    result = subprocess.run([
        os.environ.get("LINGSHU_PSQL", "psql"), "-X", "-A", "-t",
        "-v", "ON_ERROR_STOP=1", "-c",
        "SELECT count(*) FROM information_schema.tables "
        "WHERE table_schema='public' AND table_type='BASE TABLE'",
    ], env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, "could not inspect the dedicated PostgreSQL fixture"
    return int(result.stdout.strip())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--legacy-binary", type=Path)
    parser.add_argument("--postgres", action="store_true")
    parser.add_argument("--tls-fixture", action="store_true",
                        help="also test the dedicated localhost-only TLS fixture; requires SSL_CERT_FILE")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = (args.output_dir or ROOT / ".runtime" / f"storage-acceptance-{stamp}").resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    results = []
    owned = []
    relay = None
    started = time.monotonic()

    @contextmanager
    def case(name):
        began = time.monotonic()
        item = {"scenario": name, "status": "failed"}
        try:
            yield
            item["status"] = "passed"
        finally:
            item["durationSeconds"] = round(time.monotonic() - began, 2)
            results.append(item)
            print(json.dumps(item), flush=True)

    def instance(name, **kwargs):
        item = Instance(args.binary, output / name, **kwargs)
        owned.append(item)
        return item

    passed = False
    try:
        with case("fresh_sqlite_requires_explicit_choice"):
            app = instance("sqlite")
            status = app.start()
            assert status["state"] == "required"
            assert not (app.data / "lingshu-home.db").exists()
            assert not (app.data / STORAGE_FILE).exists()
            assert app.request("/health")[0] == 503
            assert app.request("/")[0] == 200
            assert app.request("/api/v1/bootstrap")[0] == 503

        with case("bootstrap_csrf_and_read_only_connection_test"):
            for token, origin in [(None, None), ("incorrect", app.url),
                                  (status["csrfToken"], "https://other.invalid")]:
                response = app.request("/api/v1/storage/configure", {"provider": "sqlite"},
                                       token=token, origin=origin)
                assert response[0] == 403
            result = app.api("/storage/test", {"provider": "sqlite"},
                             token=status["csrfToken"], origin=app.url)
            assert result["ok"] is True
            assert not (app.data / "lingshu-home.db").exists()
            assert not (app.data / STORAGE_FILE).exists()

        with case("sqlite_save_setup_and_process_restart"):
            app.configure({"provider": "sqlite"})
            config = app.data / STORAGE_FILE
            assert config.is_file() and not (stat.S_IMODE(config.stat().st_mode) & 0o077)
            saved_config = config.read_bytes()
            before = app.setup("SQLite storage fixture")
            keys = {name: (app.data / name).read_bytes()
                    for name in ("csrf.key", "integrations.key")}
            app.stop()
            state = app.start()
            assert state["state"] == "ready" and state["provider"] == "sqlite"
            assert state["source"] == "file"
            assert app.fingerprint() == before
            assert config.read_bytes() == saved_config
            assert all((app.data / key).read_bytes() == value for key, value in keys.items())
            for path in ("/storage/test", "/storage/configure"):
                response = app.request("/api/v1" + path, {"provider": "sqlite"},
                                       token=state.get("csrfToken", ""))
                assert response[0] in (403, 404, 409), "configured instances must refuse reconfiguration"
            app.stop()

        with case("explicit_cli_overrides_environment_without_persisting_it"):
            explicit = instance("cli", overrides={
                "LINGSHU_STORAGE_PROVIDER": "postgres",
                "LINGSHU_DATABASE_URL": "postgres://invalid:invalid@127.0.0.1:1/invalid",
            }, flags=("--storage-provider", "sqlite"))
            state = explicit.start()
            assert state["state"] == "ready" and state["provider"] == "sqlite"
            assert state["source"] == "cli"
            assert not (explicit.data / STORAGE_FILE).exists()
            explicit.stop()

        with case("environment_failure_does_not_override_saved_selection"):
            app.env.update({
                "LINGSHU_STORAGE_PROVIDER": "postgres",
                "LINGSHU_DATABASE_URL": "postgres://fixture:fixture@127.0.0.1:1/missing",
            })
            state = app.start()
            assert state["state"] == "error"
            assert app.request("/health")[0] == 503
            assert app.request("/api/v1/bootstrap")[0] == 503
            assert app.request("/api/v1/storage/configure", {"provider": "sqlite"},
                               token=state["csrfToken"])[0] in (403, 409)
            assert config.read_bytes() == saved_config
            app.stop()
            app.env.pop("LINGSHU_STORAGE_PROVIDER")
            app.env.pop("LINGSHU_DATABASE_URL")
            assert app.start()["state"] == "ready"
            assert app.fingerprint() == before
            app.stop()

        if args.legacy_binary:
            for initialized in (False, True):
                with case("legacy_" + ("initialized" if initialized else "unfinished")):
                    old = instance("legacy-" + str(initialized),
                                   overrides={"LINGSHU_LANGUAGE": "en"})
                    old.binary = args.legacy_binary.resolve()
                    legacy_version_file = old.binary.parent / "VERSION"
                    if legacy_version_file.is_file():
                        old.env["LINGSHU_VERSION_FILE"] = str(legacy_version_file)
                    legacy_state = old.start(legacy=True)
                    legacy_before = old.setup("Existing legacy fixture") if initialized else None
                    old.stop()
                    key_hash = {name: hashlib.sha256((old.data / name).read_bytes()).hexdigest()
                                for name in ("csrf.key", "integrations.key")}
                    assert not (old.data / STORAGE_FILE).exists()
                    old.binary = args.binary.resolve()
                    old.env["LINGSHU_VERSION_FILE"] = str(ROOT / "VERSION")
                    state = old.start()
                    assert state["state"] == "ready" and state["source"] == "legacy"
                    current = old.api("/bootstrap")
                    assert current["initialized"] == initialized
                    assert current["language"] == "en"
                    if initialized:
                        assert old.fingerprint() == legacy_before
                    assert all(hashlib.sha256((old.data / name).read_bytes()).hexdigest() == value
                               for name, value in key_hash.items())
                    old.stop()

        for kind in ("empty", "corrupt", "foreign", "orphan_key"):
            with case("reject_" + kind + "_storage_without_reinitializing"):
                invalid = instance("reject-" + kind)
                invalid.data.mkdir(mode=0o700)
                database = invalid.data / "lingshu-home.db"
                if kind == "empty":
                    database.write_bytes(b"")
                elif kind == "corrupt":
                    database.write_bytes(b"this is not a database")
                elif kind == "foreign":
                    with sqlite3.connect(database) as db:
                        db.execute("CREATE TABLE unrelated(value TEXT)")
                        db.execute("INSERT INTO unrelated VALUES ('preserve')")
                else:
                    (invalid.data / "integrations.key").write_bytes(secrets.token_bytes(32))
                original = {p.name: p.read_bytes() for p in invalid.data.iterdir()}
                state = invalid.start(allow_rejection=True)
                assert state is None or state.get("state") == "error"
                assert all((invalid.data / name).read_bytes() == value
                           for name, value in original.items())
                assert not (invalid.data / STORAGE_FILE).exists()
                if kind == "orphan_key":
                    assert not database.exists()
                invalid.stop()

        if args.postgres:
            url = os.environ.get("LINGSHU_STORAGE_ACCEPTANCE_POSTGRES_URL", "")
            assert url, "set LINGSHU_STORAGE_ACCEPTANCE_POSTGRES_URL to a fresh disposable database"
            assert postgres_table_count(url) == 0, "PostgreSQL fixture must start empty"
            parsed = urllib.parse.urlsplit(url)
            assert parsed.scheme in ("postgres", "postgresql")
            password = urllib.parse.unquote(parsed.password or "")
            input_value = {"provider": "postgres", "postgres": {
                "host": parsed.hostname, "port": parsed.port or 5432,
                "database": parsed.path.lstrip("/"),
                "username": urllib.parse.unquote(parsed.username or ""),
                "password": password, "sslMode": urllib.parse.parse_qs(parsed.query).get("sslmode", ["require"])[0],
            }}
            with case("postgres_bad_credentials_and_read_only_probe"):
                pg = instance("postgres")
                state = pg.start()
                wrong = json.loads(json.dumps(input_value))
                wrong["postgres"]["password"] = "deliberately-wrong-fixture-password"
                status_code, error, _, raw = pg.request(
                    "/api/v1/storage/test", wrong, token=state["csrfToken"])
                assert status_code in (400, 422, 503)
                assert b"deliberately-wrong-fixture-password" not in raw
                assert pg.api("/storage/bootstrap")["state"] == "required"
                assert not (pg.data / STORAGE_FILE).exists()
                assert pg.api("/storage/test", input_value, token=state["csrfToken"])["ok"]
                assert postgres_table_count(url) == 0, "connection testing must not create tables"
                assert not (pg.data / "lingshu-home.db").exists()

            if args.tls_fixture:
                with case("postgres_tls_verification_and_plain_lan_option"):
                    assert os.environ.get("SSL_CERT_FILE"), "TLS fixture requires its trusted certificate"
                    for host, mode, succeeds in [("127.0.0.1", "verify-full", False),
                                                ("localhost", "verify-full", True),
                                                (parsed.hostname, "disable", True)]:
                        trial = json.loads(json.dumps(input_value))
                        trial["postgres"].update({"host": host, "sslMode": mode})
                        code, value, _, raw = pg.request("/api/v1/storage/test", trial,
                                                        token=state["csrfToken"])
                        assert (code == 200) == succeeds, "TLS connection result did not match the certificate fixture"
                        assert password.encode() not in raw
                    assert postgres_table_count(url) == 0
                    assert not (pg.data / STORAGE_FILE).exists()

            with case("postgres_save_restart_and_recover_same_database"):
                relay = DatabaseRelay(parsed.hostname, parsed.port or 5432)
                relay.start()
                via_relay = json.loads(json.dumps(input_value))
                # The dedicated TLS fixture deliberately has only a localhost
                # certificate. Keep that verified identity through the local
                # outage relay instead of changing it to a mismatched IP.
                relay_host = "localhost" if args.tls_fixture else "127.0.0.1"
                via_relay["postgres"].update({"host": relay_host, "port": relay.port})
                pg.configure(via_relay)
                pg_config = pg.data / STORAGE_FILE
                assert pg_config.is_file()
                assert not (stat.S_IMODE(pg_config.stat().st_mode) & 0o077)
                pg_before = pg.setup("PostgreSQL storage fixture")
                assert postgres_table_count(url) > 0
                assert not (pg.data / "lingshu-home.db").exists()
                pg_saved = pg_config.read_bytes()
                pg.stop()
                state = pg.start()
                assert state["state"] == "ready" and state["provider"] == "postgres"
                assert state["source"] == "file"
                assert pg.fingerprint() == pg_before
                pg.stop()
                relay.stop()
                state = pg.start()
                assert state["state"] == "error"
                assert pg.request("/health")[0] == 503
                assert not (pg.data / "lingshu-home.db").exists()
                assert pg_config.read_bytes() == pg_saved
                assert pg.request("/api/v1/storage/configure", {"provider": "sqlite"},
                                  token=state["csrfToken"])[0] in (403, 409)
                relay.start()
                retried = pg.api("/storage/retry", {}, token=state["csrfToken"])
                assert retried["state"] == "ready"
                assert pg.fingerprint() == pg_before
                for path in ("/api/v1/storage/bootstrap", "/api/v1/bootstrap"):
                    raw = pg.request(path)[3]
                    assert password.encode() not in raw
                pg.stop()
                assert password not in (pg.folder / "server.log").read_text()
                relay.stop()

        passed = True
    except (AssertionError, OSError, ValueError, subprocess.SubprocessError) as error:
        # HTTP bodies and connection URLs are deliberately excluded from output.
        message = str(error)
        sensitive = os.environ.get("LINGSHU_STORAGE_ACCEPTANCE_POSTGRES_URL", "")
        if sensitive:
            message = message.replace(sensitive, "[redacted]")
            secret = urllib.parse.unquote(urllib.parse.urlsplit(sensitive).password or "")
            if secret:
                message = message.replace(secret, "[redacted]")
        print(json.dumps({"error": type(error).__name__, "message": message}), flush=True)
    finally:
        for owned_instance in owned:
            try:
                owned_instance.stop()
            except (OSError, AssertionError):
                passed = False
        if relay:
            relay.stop()
        report = {
            "passed": passed, "completedAt": datetime.now(timezone.utc).isoformat(),
            "durationSeconds": round(time.monotonic() - started, 2),
            "legacyExecuted": bool(args.legacy_binary), "postgresExecuted": args.postgres,
            "tlsFixtureExecuted": args.postgres and args.tls_fixture,
            "results": results,
        }
        target = output / "summary.json"
        target.write_text(json.dumps(report, indent=2) + "\n")
        target.chmod(0o600)
        print("Storage acceptance summary: " + str(target), flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
