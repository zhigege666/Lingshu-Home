#!/usr/bin/env python3
"""Exercise external PostgreSQL with disposable containers and dedicated empty databases.

Required environment: LINGSHU_CONTAINER_POSTGRES_URL and
LINGSHU_CONTAINER_ENV_POSTGRES_URL. The two databases must be dedicated test
databases. Only this script's uniquely named containers and volumes are removed.
"""
import argparse
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--image", required=True)
parser.add_argument("--output", type=Path)
args = parser.parse_args()
docker = os.environ.get("LINGSHU_DOCKER", "docker")
urls = [os.environ.get("LINGSHU_CONTAINER_POSTGRES_URL", ""), os.environ.get("LINGSHU_CONTAINER_ENV_POSTGRES_URL", "")]
assert all(urls) and urls[0] != urls[1], "Provide two dedicated PostgreSQL test database URLs"
for value in urls:
    parsed = urllib.parse.urlsplit(value)
    assert parsed.scheme in ("postgres", "postgresql") and parsed.hostname and parsed.path.strip("/"), "Invalid test database URL"
    assert "\n" not in value and "\r" not in value, "Invalid environment value"
prefix = "lingshu-storage-pg-test-" + uuid.uuid4().hex[:10]
owned_containers, owned_volumes, checks = set(), set(), []
private_values = urls + [urllib.parse.unquote(urllib.parse.urlsplit(value).password or "") for value in urls]
def command(*words, check=True):
    result = subprocess.run([docker, *words], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
    if check and result.returncode:
        raise RuntimeError("Docker operation failed: " + words[0] + " (exit " + str(result.returncode) + ")")
    return result

def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]

class Fixture:
    def __init__(self, label, directory, settings=None):
        self.name = prefix + "-" + label
        self.volume = self.name
        self.port = free_port()
        self.url = "http://127.0.0.1:" + str(self.port)
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        )
        self.envfile = Path(directory) / (label + ".env")
        values = {"LINGSHU_LISTEN": "127.0.0.1:" + str(self.port), "LINGSHU_LANGUAGE": "en"}
        values.update(settings or {})
        self.envfile.write_text("".join(key + "=" + value + "\n" for key, value in values.items()))
        self.envfile.chmod(0o600)
        command("volume", "create", self.volume)
        owned_volumes.add(self.volume)
        self.start()
    def start(self):
        # Docker can create the named container before failing to start it.
        # Keep cleanup ownership even when run returns a nonzero status.
        owned_containers.add(self.name)
        command("run", "-d", "--name", self.name, "--network=host", "--cap-drop=ALL",
                "--security-opt=no-new-privileges", "--env-file", str(self.envfile),
                "-v", self.volume + ":/data", args.image)
    def request(self, route, body=None, token=None, expected=200, method=None):
        headers = {"Accept": "application/json", "Origin": self.url}
        if body is not None:
            headers.update({"Content-Type": "application/json", "X-CSRF-Token": token or ""})
        request = urllib.request.Request(self.url + route, data=json.dumps(body).encode() if body is not None else None,
                                         headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            assert response.status == expected, "Unexpected HTTP status on " + route + ": " + str(response.status)
            assert not any(secret and secret.encode() in raw for secret in private_values), "Connection secret appeared in response"
            return json.loads(raw) if raw else None
    def api(self, route, body=None, expected=200, method=None):
        state = self.request("/api/v1/bootstrap")
        return self.request("/api/v1" + route, body, state["csrfToken"], expected, method)
    def storage(self):
        for _ in range(150):
            try:
                return self.request("/api/v1/storage/bootstrap")
            except (OSError, urllib.error.URLError):
                time.sleep(0.1)
        raise RuntimeError("Container storage bootstrap did not start")
    def no_sqlite(self):
        assert command("exec", self.name, "test", "!", "-e", "/data/lingshu-home.db", check=False).returncode == 0, "Unexpected SQLite fallback"
    def keys(self):
        result = command("exec", self.name, "sha256sum", "/data/csrf.key", "/data/integrations.key").stdout
        return hashlib.sha256(result.encode()).hexdigest()
    def clean_logs(self):
        result = command("logs", self.name)
        data = result.stdout + result.stderr
        assert not any(secret and secret in data for secret in private_values), "Connection secret appeared in container log"
    def recreate(self):
        command("rm", "-f", self.name)
        owned_containers.discard(self.name)
        self.start()

report = {"passed": False, "checks": checks}
try:
    report["imageId"] = command("image", "inspect", "--format", "{{.Id}}", args.image).stdout.strip()
    with tempfile.TemporaryDirectory(prefix=prefix + "-") as temporary:
        fixture = Fixture("web", temporary)
        status = fixture.storage()
        assert status["state"] == "required"
        parsed = urllib.parse.urlsplit(urls[0])
        query = urllib.parse.parse_qs(parsed.query)
        settings = {"provider": "postgres", "postgres": {
            "host": parsed.hostname, "port": parsed.port or 5432,
            "database": urllib.parse.unquote(parsed.path.lstrip("/")),
            "username": urllib.parse.unquote(parsed.username or ""),
            "password": urllib.parse.unquote(parsed.password or ""),
            "sslMode": query.get("sslmode", ["require"])[0],
        }}
        assert fixture.request("/api/v1/storage/test", settings, status["csrfToken"])["ok"] is True
        assert fixture.request("/api/v1/storage/configure", settings, status["csrfToken"])["state"] == "ready"
        fixture.no_sqlite()
        assert command("exec", fixture.name, "stat", "-c", "%a", "/data/storage.json").stdout.strip() == "600", "Storage settings permissions are not private"
        owner_password = secrets.token_urlsafe(24)
        private_values.append(owner_password)
        fixture.api("/setup", {"siteName": "External PostgreSQL container fixture", "mode": "public_read",
                               "username": "container_fixture", "displayName": "Container owner",
                               "password": owner_password, "seedDemo": False}, expected=201)
        before = fixture.api("/bootstrap")
        shared = next(space for space in before["spaces"] if space["kind"] == "shared")
        category = fixture.api("/spaces/" + shared["id"] + "/categories",
                               {"name": "Persisted container category", "parentId": None, "sortOrder": 7, "icon": "lucide:folder"},
                               expected=201)
        fingerprint = fixture.keys()
        command("restart", fixture.name)
        status = fixture.storage()
        assert status["state"] == "ready" and status["provider"] == "postgres" and status["source"] == "file"
        assert fixture.keys() == fingerprint, "Restart replaced local signing or integration keys"
        fixture.recreate()
        status = fixture.storage()
        assert status["state"] == "ready" and status["provider"] == "postgres" and status["source"] == "file"
        after = fixture.api("/bootstrap")
        assert after["siteName"] == before["siteName"] and after["user"]["id"] == before["user"]["id"], "Recreation lost site data or the existing session"
        data = fixture.api("/spaces/" + shared["id"] + "/navigation")
        assert any(item["id"] == category["id"] and item["name"] == category["name"] for item in data["data"]["categories"]), "Recreation lost navigation data"
        assert fixture.keys() == fingerprint
        fixture.no_sqlite()
        assert command("inspect", "--format", "{{.Config.User}}", fixture.name).stdout.strip() == "10001:10001"
        fixture.clean_logs()
        checks.append("web_configured_postgres_restart_and_container_recreation")
        print("PASS " + checks[-1])

        explicit = Fixture("environment", temporary, {"LINGSHU_STORAGE_PROVIDER": "postgres", "LINGSHU_DATABASE_URL": urls[1]})
        status = explicit.storage()
        assert status["state"] == "ready" and status["source"] == "environment" and status["provider"] == "postgres"
        explicit.no_sqlite()
        assert command("exec", explicit.name, "test", "!", "-e", "/data/storage.json", check=False).returncode == 0, "Environment settings were copied into the data directory"
        explicit.request("/api/v1/storage/configure", {"provider": "sqlite"}, status["csrfToken"], expected=409)
        explicit.recreate()
        assert explicit.storage()["state"] == "ready"
        explicit.clean_logs()
        checks.append("explicit_postgres_environment_and_recreation")
        print("PASS " + checks[-1])

        unavailable = "postgres://unavailable:container-fixture-secret@127.0.0.1:1/unavailable?sslmode=disable&connect_timeout=1"
        private_values += [unavailable, "container-fixture-secret"]
        broken = Fixture("unavailable", temporary, {"LINGSHU_STORAGE_PROVIDER": "postgres", "LINGSHU_DATABASE_URL": unavailable})
        status = broken.storage()
        assert status["state"] == "error" and status["provider"] == "postgres" and status["source"] == "environment"
        broken.request("/health", expected=503)
        broken.request("/api/v1/storage/configure", {"provider": "sqlite"}, status["csrfToken"], expected=409)
        retried = broken.request("/api/v1/storage/retry", {}, status["csrfToken"])
        assert retried["state"] == "error" and retried["provider"] == "postgres"
        broken.no_sqlite()
        broken.clean_logs()
        checks.append("unavailable_external_database_never_falls_back")
        print("PASS " + checks[-1])
    report["passed"] = True
finally:
    for name in owned_containers:
        command("rm", "-f", name, check=False)
    for name in owned_volumes:
        command("volume", "rm", name, check=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
print("External PostgreSQL container acceptance passed.")
