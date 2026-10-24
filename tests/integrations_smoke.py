#!/usr/bin/env python3
"""Real HTTP + MCP checks for an EMPTY, disposable loopback Home instance.

Standard library only. The initialized synthetic instance is left for inspection.
GitHub network traffic is not used: this script creates only a disabled source
without a credential. Deterministic worker tests live in integrations_test.go.
An undecided empty instance selects Chinese for the fixture; a fixed language
is preserved.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import copy
from datetime import datetime, timedelta, timezone
import http.cookiejar
import ipaddress
import json
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class Failure(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def checked_url(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        raise Failure("Use a loopback http(s) URL without credentials.")
    if parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise Failure("The test URL must not have a path, query, or fragment.")
    try:
        loopback = ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        loopback = (parsed.hostname or "").lower() == "localhost"
    if not loopback:
        raise Failure("Refusing a non-loopback test host.")
    try:
        parsed.port
    except ValueError as exc:
        raise Failure("Invalid test port.") from exc
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def require(condition, message):
    if not condition:
        raise Failure(message)


class Client:
    def __init__(self, base):
        self.base = base
        self.csrf = None
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
            NoRedirect(),
        )

    def request(self, method, path, data=None, *, token=None, expected=200, headers=None):
        request_headers = {"Accept": "application/json"}
        encoded = None
        if data is not None:
            encoded = json.dumps(data, ensure_ascii=False).encode()
            request_headers["Content-Type"] = "application/json"
        if token is not None:
            request_headers["Authorization"] = "Bearer " + token
        elif method not in ("GET", "HEAD") and self.csrf:
            request_headers["X-CSRF-TOKEN"] = self.csrf
        request_headers.update(headers or {})
        request = urllib.request.Request(self.base + path, encoded, request_headers, method=method)
        try:
            with self.opener.open(request, timeout=25) as response:
                status, response_headers, body = response.status, response.headers, response.read(16 << 20)
        except urllib.error.HTTPError as response:
            status, response_headers, body = response.code, response.headers, response.read(16 << 20)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            raise Failure(f"{method} {path}: transport failed ({type(exc).__name__}).") from exc
        try:
            value = json.loads(body) if body else None
        except json.JSONDecodeError as exc:
            raise Failure(f"{method} {path}: expected JSON, HTTP {status}.") from exc
        if expected is not None and status != expected:
            code = value.get("code", "") if isinstance(value, dict) else ""
            raise Failure(f"{method} {path}: expected {expected}, got {status} ({code}).")
        return status, value, response_headers

    def api(self, method, path, data=None, **kwargs):
        return self.request(method, "/api/v1" + path, data, **kwargs)[1]

    def boot(self):
        result = self.api("GET", "/bootstrap")
        self.csrf = result["csrfToken"]
        require(bool(self.csrf), "Bootstrap did not supply a CSRF token.")
        return result

    def mcp(self, token, method, params=None, expected=200):
        params = copy.deepcopy(params or {})
        params["_meta"] = {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {"name": "lingshu-smoke", "version": "1"},
        }
        headers = {"Accept": "application/json, text/event-stream", "Mcp-Protocol-Version": "2026-07-28", "Mcp-Method": method}
        if "name" in params:
            headers["Mcp-Name"] = params["name"]
        _, response, received = self.request("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, token=token, expected=expected, headers=headers)
        require(received.get("Cache-Control") == "no-store", "MCP response must not be cacheable.")
        return response

    def tool(self, token, name, arguments, error=None):
        response = self.mcp(token, "tools/call", {"name": name, "arguments": arguments})
        require("error" not in response, f"{name} returned a protocol error.")
        result = response["result"]
        data = result.get("structuredContent")
        require(isinstance(data, dict), f"{name} must return object structuredContent.")
        if error:
            require(result.get("isError") is True and data.get("code") == error, f"{name}: expected application error {error}.")
        else:
            require(result.get("isError") is not True, f"{name}: application error {data.get('code', '')}.")
        return data


def space(boot, kind):
    return next(item["id"] for item in boot["spaces"] if item["kind"] == kind)


def mint(client, space_id, actions, source_id=None):
    return client.api("POST", "/integrations/tokens", {
        "name": "Synthetic integration check", "spaceId": space_id, "sourceId": source_id,
        "actions": actions, "expiresAt": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
    }, expected=201)


def source(client, space_id, name):
    return client.api("POST", f"/spaces/{space_id}/sources", {
        "name": name, "kind": "external-push", "schemaId": "navigation.collection", "schemaVersion": 1,
        "connection": {}, "sync": {"mode": "push", "staleAfterSeconds": 3600}, "enabled": True,
    }, expected=201)


def payload(request_id, revision, sequence=None):
    result = {
        "requestId": request_id, "expectedRevision": revision,
        "schemaId": "navigation.collection", "schemaVersion": 1, "sourceUpdatedAt": None,
        "data": {
            "categories": [{"externalId": "ops", "parentExternalId": None, "name": "Operations", "icon": "lucide:folder", "sortOrder": 0}],
            "links": [{"externalId": "project", "categoryExternalId": "ops", "title": "External fixture", "url": "https://example.org/project", "description": "Synthetic HTTP fixture", "icon": "lucide:link", "tags": ["external"], "isFavorite": False, "sortOrder": 0, "endpoints": []}],
        },
    }
    if sequence is not None:
        result["sourceSequence"] = sequence
    return result


def run(base):
    started = time.monotonic()
    owner, anon = Client(base), Client(base)
    boot = owner.boot()
    require(boot["initialized"] is False, "Refusing an initialized instance; use a new isolated data directory/database.")
    require(boot.get("user") is None and boot.get("spaces") == [],
            "Refusing a supposedly empty instance that already exposes accounts or spaces.")
    if boot.get("languageSelectionRequired") is True:
        owner.api("POST", "/setup/language", {"language": "zh-CN"})
        boot = owner.boot()
        require(boot.get("language") == "zh-CN", "First-run fixture language was not persisted.")
    require(boot.get("languageSelectionRequired") is False and boot.get("language") in ("zh-CN", "en"),
            "The disposable instance must have a fixed language before setup.")
    require(boot["initialized"] is False and boot.get("user") is None and boot.get("spaces") == [],
            "Language selection must not initialize the instance or create account/navigation data.")
    language = boot["language"]
    username = "smoke-" + secrets.token_hex(5)
    owner.api("POST", "/setup", {"siteName": "Integration HTTP fixture", "mode": "private_multi", "username": username, "displayName": "Fixture owner", "password": secrets.token_urlsafe(24), "seedDemo": False}, expected=201)
    boot = owner.boot()
    require(boot.get("language") == language and boot.get("languageSelectionRequired") is False,
            "Setup changed the fixture's fixed language.")
    shared, personal = space(boot, "shared"), space(boot, "personal")
    actions = ["navigation:read", "navigation:write", "sources:read", "sources:write", "datasets:write", "pages:read", "pages:write"]
    full = mint(owner, shared, actions)["token"]
    readonly = mint(owner, shared, ["navigation:read"])["token"]
    tokens = owner.api("GET", "/integrations/tokens")
    require(full not in json.dumps(tokens) and "token_hash" not in json.dumps(tokens), "Token listing exposes credential material.")
    owner.api("POST", "/integrations/tokens", {}, token=full, expected=403)
    owner.api("GET", f"/spaces/{shared}/navigation", token="malformed", expected=401)
    anon.mcp(None, "server/discover", expected=401)
    discovered = anon.mcp(full, "server/discover")["result"]
    require(set(discovered["supportedVersions"]) == {"2026-07-28", "2025-11-25"}, "MCP supported versions differ from the contract.")
    require(discovered["cacheScope"] == "private" and discovered["ttlMs"] == 0, "MCP discovery must be private and uncached.")
    require(len(anon.mcp(full, "tools/list")["result"]["tools"]) == 20, "The expected MCP tool surface is incomplete.")
    anon.tool(readonly, "dashboard_get", {"spaceId": shared}, error="forbidden")
    category = anon.tool(full, "categories_create", {"spaceId": shared, "input": {"name": "Local fixture", "icon": "lucide:folder"}})
    link_input = {"categoryId": category["id"], "title": "Local fixture", "url": "https://example.com/local", "icon": "lucide:link", "tags": [], "endpoints": []}
    anon.tool(readonly, "bookmarks_create", {"spaceId": shared, "input": link_input}, error="forbidden")
    link = anon.tool(full, "bookmarks_create", {"spaceId": shared, "input": link_input})
    anon.tool(full, "bookmarks_get", {"spaceId": personal, "id": link["id"]}, error="not_found")
    unsafe = dict(link_input, url="javascript:alert(1)")
    anon.tool(full, "bookmarks_update", {"spaceId": shared, "id": link["id"], "input": unsafe}, error="validation_error")
    print("PASS authenticated MCP discovery, shared handlers, token scopes and local navigation")

    first_source = source(owner, shared, "Push fixture")
    second_source = source(owner, shared, "Second fixture")
    private_source = source(owner, personal, "Private fixture")
    source_id = first_source["id"]
    scoped_credential = mint(owner, shared, ["sources:read", "datasets:write"], source_id)
    scoped = scoped_credential["token"]
    listed = anon.api("GET", f"/spaces/{shared}/sources", token=scoped)
    require([item["id"] for item in listed] == [source_id], "Source-scoped token can list unrelated sources.")
    anon.api("GET", f"/sources/{second_source['id']}", token=scoped, expected=404)
    anon.api("GET", f"/sources/{private_source['id']}", token=full, expected=404)
    snapshot_path = f"/sources/{source_id}/snapshot"
    anon.api("GET", snapshot_path, token=scoped, expected=404)
    first = payload("first", "0", 10)
    original = anon.api("PUT", snapshot_path, first, token=scoped)

    def contender(number):
        client = Client(base)
        return client.request("PUT", "/api/v1" + snapshot_path, payload(f"race-{number}", "1", 11 + number), token=scoped, expected=None)[0]

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        statuses = sorted(pool.map(contender, (0, 1)))
    require(statuses == [200, 409], "Concurrent pushes must produce exactly one winner and one conflict.")
    require(anon.tool(scoped, "sources_snapshot_push", {"id": source_id, "input": first}) == original, "A retry after later revisions must return the original receipt.")
    changed = copy.deepcopy(first)
    changed["schemaVersion"] = 2
    anon.api("PUT", snapshot_path, changed, token=scoped, expected=409)
    anon.api("PUT", snapshot_path, payload("stale", "0", 15), token=scoped, expected=409)
    anon.api("PUT", snapshot_path, payload("old-sequence", "2", 9), token=scoped, expected=409)
    unguarded = payload("unguarded", "2")
    del unguarded["expectedRevision"]
    anon.api("PUT", snapshot_path, unguarded, token=scoped, expected=400)
    unsafe_push = payload("unsafe", "2")
    unsafe_push["data"]["links"][0]["url"] = "file:///etc/passwd"
    anon.api("PUT", snapshot_path, unsafe_push, token=scoped, expected=400)
    snapshot = anon.api("GET", snapshot_path, token=scoped)
    require(snapshot["revision"] == "2" and snapshot["meta"]["sourceUpdatedAt"] is None, "Snapshot metadata differs from accepted state.")
    require(snapshot["data"]["links"][0]["id"] == f"source:{source_id}:project", "External identifier has no source namespace.")
    local = owner.api("GET", f"/spaces/{shared}/navigation")
    require([item["id"] for item in local["data"]["links"]] == [link["id"]], "External snapshot modified local bookmarks.")
    print("PASS snapshot isolation, namespace, idempotency, optimistic concurrency and unsafe URL rejection")

    page = owner.api("GET", f"/spaces/{shared}/page")
    config = copy.deepcopy(page["config"])
    config["bindings"]["external"] = {"datasetId": f"source:{source_id}", "space": "current-page-space", "query": {}}
    for view in config["views"]:
        if view["panel"]["id"] == "builtin/navigation":
            view["inputs"]["collection"] = "external"
    updated = owner.api("PUT", f"/spaces/{shared}/page", {"name": page["name"], "expectedRevision": page["revision"], "config": config})
    dashboard = anon.tool(full, "dashboard_get", {"spaceId": shared})
    require(dashboard["datasets"]["external"]["datasetId"] == f"source:{source_id}", "Dashboard did not resolve its external binding.")
    config["bindings"]["external"]["datasetId"] = f"source:{private_source['id']}"
    owner.api("PUT", f"/spaces/{shared}/page", {"name": page["name"], "expectedRevision": updated["revision"], "config": config}, expected=400)
    traffic = owner.api("POST", f"/spaces/{shared}/sources", {"name": "Disabled Traffic fixture", "kind": "github-traffic", "schemaId": "github.traffic", "schemaVersion": 1, "connection": {"owner": "octocat", "repo": "Hello-World"}, "sync": {"mode": "poll", "intervalSeconds": 21600, "staleAfterSeconds": 43200}, "enabled": False}, expected=201)
    require(traffic["credentialConfigured"] is False and traffic["revision"] == "0", "Traffic draft fabricated credentials or data.")
    owner.api("POST", f"/sources/{traffic['id']}/sync", {}, expected=409)
    owner.api("PUT", f"/sources/{traffic['id']}", {"expectedConfigRevision": traffic["configRevision"], "name": traffic["name"], "enabled": True, "connection": traffic["connection"], "sync": traffic["sync"]}, expected=400)
    owner.api("DELETE", f"/integrations/tokens/{scoped_credential['credential']['id']}")
    anon.mcp(scoped, "server/discover", expected=401)
    anon.tool(full, "bookmarks_delete", {"spaceId": shared, "id": link["id"]})
    anon.tool(full, "categories_delete", {"spaceId": shared, "id": category["id"]})
    owner.api("PUT", "/settings", {"siteName": "Integration HTTP fixture", "mode": "open_edit", "registrationEnabled": False})
    anon.mcp(full, "server/discover", expected=401)
    anon.mcp(None, "server/discover", expected=401)
    anon.api("GET", f"/sources/{private_source['id']}/snapshot", expected=404)
    print("PASS page bindings, credential-free Traffic drafts, explicit revocation and mode invalidation")
    print(json.dumps({"status": "passed", "protocol": "2026-07-28", "githubNetwork": "not-used", "syntheticInstanceRetained": True, "durationSeconds": round(time.monotonic() - started, 3)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--allow-destructive", action="store_true", help="Authorize initialization and synthetic changes to a fresh disposable service.")
    args = parser.parse_args()
    try:
        if not args.allow_destructive:
            raise Failure("Explicit --allow-destructive is required; use only an empty disposable test instance.")
        run(checked_url(args.base_url))
    except (Failure, KeyError, StopIteration, TypeError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
