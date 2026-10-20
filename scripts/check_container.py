#!/usr/bin/env python3
"""Verify the built container on a fresh local port and named volume."""
import argparse
import gzip
import http.cookiejar
import json
import os
import re
import subprocess
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
            "-e", f"LINGSHU_LISTEN=127.0.0.1:{args.port}", "-v", prefix + ":/data", args.image)
    created = True
    ready()
    bootstrap = api("/bootstrap")
    assert bootstrap["initialized"] is False, "Container must start with fresh data"
    api("/setup", {"siteName": "Container persistence check", "mode": "open_edit", "seedDemo": False}, bootstrap["csrfToken"])
    before = api("/bootstrap")
    assert before["initialized"] is True
    command("restart", prefix)
    ready()
    after = api("/bootstrap")
    assert after["initialized"] is True and after["siteName"] == before["siteName"]
    with opener.open(url + "/", timeout=10) as response:
        html = response.read()
        assert response.status == 200 and b"<html" in html.lower(), "Frontend assets must be served"
        assert response.headers.get("Cache-Control") == "no-cache", "HTML must revalidate after updates"
    assets = set(re.findall(rb'(?:src|href)="(/assets/[^"?]+\.(?:js|css))"', html))
    assert len(assets) >= 2, "Built HTML must reference script and style assets"
    for asset in assets:
        asset_url = url + asset.decode()
        with opener.open(urllib.request.Request(asset_url, headers={"Accept-Encoding": "identity"}), timeout=10) as response:
            original = response.read()
            assert response.headers.get("Content-Encoding") is None
        with opener.open(urllib.request.Request(asset_url, headers={"Accept-Encoding": "gzip"}), timeout=10) as response:
            assert response.headers.get("Content-Encoding") == "gzip", "Build-time gzip sidecar must be served"
            assert "Accept-Encoding" in response.headers.get("Vary", "")
            assert response.headers.get("Cache-Control") == "public, max-age=31536000, immutable"
            assert gzip.decompress(response.read()) == original, "Compressed bytes must match final hashed assets"
    user = command("inspect", "--format", "{{.Config.User}}", prefix)
    assert user == "10001:10001", "Container must run as the unprivileged application user"
    print("Container health, setup, static frontend, gzip integrity/cache boundaries, non-root user and restart persistence passed.")
finally:
    if created:
        subprocess.run([docker, "rm", "-f", prefix], stdout=subprocess.DEVNULL, check=False)
    subprocess.run([docker, "volume", "rm", prefix], stdout=subprocess.DEVNULL, check=False)
