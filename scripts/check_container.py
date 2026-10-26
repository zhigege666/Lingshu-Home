#!/usr/bin/env python3
"""Verify the built container on a fresh local port and named volume."""
import argparse
import gzip
import http.cookiejar
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--image", default="lingshu-home:ci")
parser.add_argument("--port", type=int, default=5190)
args = parser.parse_args()
prefix = "lingshu-home-test-" + uuid.uuid4().hex[:10]
docker = os.environ.get("LINGSHU_DOCKER", "docker")
url = f"http://127.0.0.1:{args.port}"
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def command(*words):
    return subprocess.run([docker, *words], check=True, text=True, stdout=subprocess.PIPE).stdout.strip()

def ready():
    for _ in range(100):
        try:
            with opener.open(url + "/health", timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        time.sleep(0.1)
    raise RuntimeError("Container health check timed out")

def storage_ready():
    for _ in range(100):
        try:
            with opener.open(url + "/api/v1/storage/bootstrap", timeout=1) as response:
                if response.status == 200:
                    return json.load(response)
        except OSError:
            pass
        time.sleep(0.1)
    raise RuntimeError("Container storage bootstrap timed out")

def api(path, data=None, token=None):
    headers = {"Accept": "application/json"}
    if data is not None:
        headers.update({"Content-Type": "application/json", "X-CSRF-TOKEN": token or ""})
    request = urllib.request.Request(url + "/api/v1" + path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
    with opener.open(request, timeout=10) as response:
        assert response.headers.get("Cache-Control") == "no-store", "API responses must not be cached"
        return json.load(response)

created = False
try:
    command("volume", "create", prefix)
    command("run", "-d", "--name", prefix, "--network=host", "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "-e", f"LINGSHU_LISTEN=127.0.0.1:{args.port}", "-e", "LINGSHU_LANGUAGE=zh-CN",
            "-v", prefix + ":/data", args.image)
    created = True
    storage = storage_ready()
    assert storage["state"] == "required", "A new default container must offer storage selection"
    tested = api("/storage/test", {"provider": "sqlite"}, storage["csrfToken"])
    assert tested["ok"] is True
    configured = api("/storage/configure", {"provider": "sqlite"}, storage["csrfToken"])
    assert configured["state"] == "ready"
    ready()
    bootstrap = api("/bootstrap")
    assert bootstrap["initialized"] is False, "Container must start with fresh data"
    assert bootstrap["language"] == "zh-CN", "The explicit fixture language must be applied"
    api("/setup", {"siteName": "Container persistence check", "mode": "open_edit", "seedDemo": False}, bootstrap["csrfToken"])
    before = api("/bootstrap")
    assert before["initialized"] is True
    command("restart", prefix)
    ready()
    saved_storage = storage_ready()
    assert saved_storage["state"] == "ready" and saved_storage["provider"] == "sqlite"
    assert saved_storage["source"] == "file", "Container restart must load persisted storage configuration"
    after = api("/bootstrap")
    assert after["initialized"] is True and after["siteName"] == before["siteName"]
    assert after["language"] == before["language"] == "zh-CN", "Container restart must retain the instance language"
    with opener.open(url + "/", timeout=10) as response:
        html = response.read()
        assert response.status == 200 and b"<html" in html.lower(), "Frontend assets must be served"
        assert response.headers.get("Cache-Control") == "no-cache", "HTML must revalidate after updates"
    assets = set(re.findall(rb'(?:src|href)="(/assets/[^"?]+\.(?:js|css))"', html))
    assert len(assets) >= 2, "Built HTML must reference script and style assets"
    compressed_count = 0
    for asset in assets:
        asset_url = url + asset.decode()
        with opener.open(urllib.request.Request(asset_url, headers={"Accept-Encoding": "identity"}), timeout=10) as response:
            original = response.read()
            assert response.headers.get("Content-Encoding") is None
        with opener.open(urllib.request.Request(asset_url, headers={"Accept-Encoding": "gzip"}), timeout=10) as response:
            encoding = response.headers.get("Content-Encoding")
            assert response.headers.get("Cache-Control") == "public, max-age=31536000, immutable"
            # The build deliberately leaves tiny or incompressible preloads plain.
            eligible = len(original) >= 1024 and len(gzip.compress(original, compresslevel=9)) < len(original)
            assert encoding == ("gzip" if eligible else None), "Static encoding must match the build compression policy"
            payload = response.read()
            if eligible:
                assert "Accept-Encoding" in response.headers.get("Vary", "")
                compressed_count += 1
                payload = gzip.decompress(payload)
            assert payload == original, "Static bytes must match final hashed assets"
    assert compressed_count >= 2, "Main script and stylesheet must use build-time compression"
    user = command("inspect", "--format", "{{.Config.User}}", prefix)
    assert user == "10001:10001", "Container must run as the unprivileged application user"
    print("Container storage choice, persisted provider, health, setup, static frontend, gzip integrity/cache boundaries, non-root user and restart persistence passed.")
finally:
    if created:
        subprocess.run([docker, "rm", "-f", prefix], stdout=subprocess.DEVNULL, check=False)
    subprocess.run([docker, "volume", "rm", prefix], stdout=subprocess.DEVNULL, check=False)

# The exact image exercised above must also preserve a real old /data volume
# and support the optional document mounts/HTTPS configuration before packaging.
subprocess.run([sys.executable, str(Path(__file__).with_name("check_document_container.py")),
                "--image", args.image, "--port", str(args.port)], check=True)
