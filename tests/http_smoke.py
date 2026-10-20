#!/usr/bin/env python3
"""Destructive HTTP acceptance checks for an EMPTY, disposable Home instance.

Python 3.10+; standard library only. Never run against a user's populated service.
The script deliberately refuses non-loopback URLs and an initialized database.
It creates no fixtures in the application other than randomly named test data.
"""

from __future__ import annotations

import argparse
import concurrent.futures
from datetime import datetime
import http.cookiejar
import ipaddress
import json
import os
from pathlib import Path
import secrets
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


class Failure(Exception):
    """An acceptance or safety requirement was not met."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def checked_base_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ("http", "https"):
        raise Failure("The test URL must use http or https.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise Failure("Credentials, queries, and fragments are forbidden in the test URL.")
    host = parsed.hostname or ""
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host.lower() == "localhost"
    if not loopback:
        raise Failure("Refusing a non-loopback host. Run this script on the disposable service host.")
    try:
        parsed.port
    except ValueError as exc:
        raise Failure("Invalid test URL port.") from exc
    path = parsed.path.rstrip("/")
    if path not in ("", "/api/v1"):
        raise Failure("The URL path must be empty or /api/v1.")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/api/v1", "", ""))


class Response:
    def __init__(self, status: int, headers, body: bytes):
        self.status = status
        self.headers = headers
        self.body = body
        self.text = body.decode("utf-8", errors="replace")
        try:
            self.data = json.loads(self.text) if self.text else None
        except json.JSONDecodeError:
            self.data = None


class Client:
    def __init__(self, base_url: str, timeout: float):
        self.base_url = base_url
        self.timeout = timeout
        self.cookies = http.cookiejar.CookieJar()
        # No environment proxies: loopback test traffic must remain local.
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(self.cookies),
            NoRedirect(),
        )
        self.csrf = None

    def request(self, method: str, path: str, body=None, *, csrf: bool = True,
                token: str | None = None) -> Response:
        headers = {"Accept": "application/json", "User-Agent": "Lingshu-Home-HTTP-smoke"}
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        if method not in ("GET", "HEAD") and csrf and (token or self.csrf):
            headers["X-CSRF-TOKEN"] = token or self.csrf
        for attempt in range(3):
            request = urllib.request.Request(self.base_url + path, data, headers, method=method)
            try:
                with self.opener.open(request, timeout=self.timeout) as response:
                    result = Response(response.status, response.headers, response.read(16 * 1024 * 1024))
            except urllib.error.HTTPError as error:
                result = Response(error.code, error.headers, error.read(16 * 1024 * 1024))
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                raise Failure(f"Transport failed for {method} {path}: {type(error).__name__}") from error
            if (result.status != 429 or method != "POST" or
                    path not in ("/setup", "/auth/login", "/auth/register") or attempt == 2):
                return result
            # Keep the real production rate limit enabled. Only a documented rejection
            # before auth execution is retryable; never retry CRUD writes or transport errors.
            if not isinstance(result.data, dict) or result.data.get("code") != "rate_limited":
                return result
            try:
                retry_after = float(result.headers.get("Retry-After", ""))
            except ValueError:
                raise Failure("Auth rate limiter returned 429 without a numeric Retry-After.")
            if not 0 <= retry_after <= 60:
                raise Failure("Auth Retry-After is outside the supported 0–60 second window.")
            print(f"[WAIT] Auth rate limit is active; respecting Retry-After ({retry_after:g}s).", flush=True)
            remaining = max(retry_after, 0.1) + 0.1
            while remaining > 0:
                chunk = min(10.0, remaining)
                time.sleep(chunk)
                remaining -= chunk
        raise Failure("Unreachable HTTP retry state.")

    def bootstrap(self) -> dict:
        response = self.request("GET", "/bootstrap")
        require_success(response, "GET /bootstrap")
        if not isinstance(response.data, dict):
            raise Failure("Bootstrap did not return a JSON object.")
        self.csrf = response.data.get("csrfToken")
        if not isinstance(self.csrf, str) or not self.csrf:
            raise Failure("Bootstrap did not provide a CSRF token.")
        return response.data

    def login(self, username: str, password: str) -> dict:
        self.bootstrap()
        require_success(self.request("POST", "/auth/login", {
            "username": username, "password": password,
        }), "login")
        return self.bootstrap()


def response_hint(response: Response) -> str:
    # Report only stable machine codes, never response bodies or credentials.
    code = response.data.get("code") if isinstance(response.data, dict) else None
    safe_code = str(code)[:80] if isinstance(code, (str, int)) else "non-JSON/error code absent"
    return f"HTTP {response.status}, code={safe_code}"


def require_success(response: Response, action: str) -> Response:
    if not 200 <= response.status < 300:
        raise Failure(f"{action}: expected success, got {response_hint(response)}")
    return response


class Suite:
    def __init__(self, args):
        self.args = args
        self.base = checked_base_url(args.base_url)
        self.run_id = secrets.token_hex(6)
        self.passes = 0
        self.assertions = 0
        self.owner = self.client()
        self.owner_username = "smk_" + self.run_id + "_o"
        self.owner_password = secrets.token_urlsafe(30)
        self.personal = ""
        self.shared = ""
        self.shared_link = None
        self.private_link = None
        self.members = {}
        self.retained_link = None

    def client(self) -> Client:
        return Client(self.base, self.args.timeout)

    def check(self, value, message: str):
        self.assertions += 1
        if not value:
            raise Failure(message)

    def step(self, name: str, fn):
        print(f"[RUN] {name}", flush=True)
        fn()
        self.passes += 1
        print(f"[PASS] {name}", flush=True)

    def ok(self, client: Client, method: str, path: str, body=None) -> Response:
        response = client.request(method, path, body)
        self.assertions += 1
        return require_success(response, f"{method} {path}")

    def denied(self, response: Response, action: str, statuses=(400, 401, 403, 404, 409, 422)):
        self.check(response.status in statuses,
                   f"{action}: expected rejection {statuses}, got {response_hint(response)}")
        if response.status in (401, 403):
            self.check(isinstance(response.data, dict) and
                       isinstance(response.data.get("code"), str) and
                       isinstance(response.data.get("message"), str),
                       f"{action}: authentication rejection must be JSON code/message, without redirect.")

    def dash(self, client: Client, space: str) -> dict:
        path = "/dashboard?" + urllib.parse.urlencode({"spaceId": space})
        response = self.ok(client, "GET", path)
        self.check(isinstance(response.data, dict), "Dashboard must be a JSON object.")
        self.check(response.data.get("space", {}).get("id") == space,
                   "Dashboard returned another space.")
        raw = response.data
        self.check("links" not in raw and "categories" not in raw,
                   "Dashboard must use dataset envelopes, not the obsolete top-level navigation fields.")
        page = raw.get("page")
        self.check(isinstance(page, dict) and page.get("spaceId") == space and
                   isinstance(page.get("id"), str) and bool(page["id"]) and
                   isinstance(page.get("revision"), str) and bool(page["revision"]),
                   "Dashboard page must include its identity, space and opaque revision.")
        config = page.get("config", {})
        self.check(config.get("schemaVersion") == 2, "Dashboard must return page Schema 2.")
        bindings = config.get("bindings", {})
        datasets = raw.get("datasets")
        self.check(isinstance(bindings, dict) and isinstance(datasets, dict),
                   "Page bindings and dashboard datasets must be objects.")
        self.check(set(datasets).issubset(bindings), "Dashboard returned an undeclared dataset alias.")
        for alias, binding in bindings.items():
            if binding.get("datasetId") == "local-navigation":
                self.check(alias in datasets, "A declared local navigation binding is missing.")
        for alias, dataset in datasets.items():
            self.validate_navigation_dataset(dataset, space, bindings[alias]["datasetId"])
        # Existing business scenarios deliberately use the separate authoritative endpoint.
        # These convenience fields are test-local; the actual dashboard shape was checked above.
        local = self.navigation(client, space)
        return {**raw, "links": local["data"]["links"], "categories": local["data"]["categories"]}

    def validate_navigation_dataset(self, dataset: dict, space: str,
                                    dataset_id="local-navigation"):
        self.check(isinstance(dataset, dict) and dataset.get("datasetId") == dataset_id and
                   dataset.get("schemaId") == "navigation.collection" and dataset.get("schemaVersion") == 1,
                   "Navigation dataset must declare the correct ID and semantic schema.")
        self.check(isinstance(dataset.get("revision"), str) and bool(dataset["revision"]),
                   "Dataset revision must be a nonempty opaque string.")
        data = dataset.get("data", {})
        self.check(isinstance(data, dict) and isinstance(data.get("links"), list) and
                   isinstance(data.get("categories"), list), "Navigation data must contain arrays.")
        self.check(all(item.get("spaceId") == space for item in data["links"] + data["categories"]),
                   "A navigation dataset contains another space's data.")
        meta = dataset.get("meta", {})
        self.check(isinstance(meta, dict) and meta.get("freshness") == "fresh",
                   "Authoritative local navigation must have a fresh metadata envelope.")
        for field in ("sourceUpdatedAt", "receivedAt", "lastSuccessAt"):
            value = meta.get(field)
            self.check(isinstance(value, str) and bool(value), f"Local metadata must include {field}.")
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                valid = parsed.tzinfo is not None and parsed.utcoffset().total_seconds() == 0
            except (ValueError, TypeError, AttributeError):
                valid = False
            self.check(valid, f"{field} must be an explicit UTC timestamp.")

    def navigation(self, client: Client, space: str) -> dict:
        result = self.ok(client, "GET", f"/spaces/{space}/navigation").data
        self.validate_navigation_dataset(result, space)
        return result

    def page(self, client: Client, space: str) -> dict:
        result = self.ok(client, "GET", f"/spaces/{space}/page").data
        self.check(isinstance(result, dict) and result.get("spaceId") == space and
                   isinstance(result.get("id"), str) and isinstance(result.get("revision"), str) and
                   result.get("config", {}).get("schemaVersion") == 2,
                   "Page endpoint returned an invalid Schema 2 page DTO.")
        return result

    def save_page(self, client: Client, space: str, config: dict, name="Smoke Home") -> dict:
        before = self.page(client, space)
        result = self.ok(client, "PUT", f"/spaces/{space}/page", {
            "name": name, "config": config, "expectedRevision": before["revision"],
        }).data
        self.check(result.get("id") == before["id"] and result.get("spaceId") == space,
                   "Page update replaced its identity or space.")
        self.check(isinstance(result.get("revision"), str) and result["revision"] != before["revision"],
                   "Successful page update must return a new opaque revision.")
        self.check(result.get("config") == config and result.get("name") == name,
                   "Page update did not return the saved configuration and name.")
        return result

    def dashboard_denied(self, client: Client, space: str, action: str):
        response = client.request("GET", "/dashboard?" + urllib.parse.urlencode({"spaceId": space}))
        self.denied(response, action, (401, 403, 404))

    def link_payload(self, title: str, path: str, category=None) -> dict:
        return {
            "title": title, "url": f"https://smoke.example.invalid/{self.run_id}/{path}",
            "description": "Disposable HTTP acceptance data", "icon": "lucide:link",
            "tags": ["smoke", self.run_id], "isFavorite": False, "sortOrder": 0,
            "categoryId": category, "endpoints": [],
        }

    def add_link(self, client: Client, space: str, payload: dict) -> dict:
        response = self.ok(client, "POST", f"/spaces/{space}/links", payload)
        self.check(isinstance(response.data, dict) and response.data.get("id"),
                   "Link creation must return a link DTO with id.")
        return response.data

    def add_category(self, client: Client, space: str, name: str, parent=None) -> dict:
        response = self.ok(client, "POST", f"/spaces/{space}/categories", {
            "name": name, "icon": "lucide:folder", "parentId": parent, "sortOrder": 0,
        })
        self.check(isinstance(response.data, dict) and response.data.get("id"),
                   "Category creation must return a category DTO with id.")
        return response.data

    def owner_login(self):
        bootstrap = self.owner.login(self.owner_username, self.owner_password)
        self.check(bootstrap.get("user", {}).get("role") == "Owner", "Owner login lost its role.")
        return bootstrap

    def settings(self, **changes):
        current = self.ok(self.owner, "GET", "/settings").data
        body = {key: current[key] for key in ("siteName", "mode", "registrationEnabled")}
        body.update(changes)
        self.owner.bootstrap()
        self.ok(self.owner, "PUT", "/settings", body)
        return self.owner.bootstrap()

    def mode(self, mode: str):
        observer = self.client()
        observer.login(self.owner_username, self.owner_password)
        after = self.settings(mode=mode, registrationEnabled=False)
        self.check(after.get("mode") == mode, "Mode change was not persisted.")
        self.check(after.get("user") is None, "Mode change must revoke the caller's old session.")
        self.check(observer.bootstrap().get("user") is None,
                   "Mode change did not revoke another existing Owner session.")
        self.owner_login()

    def preflight(self):
        self.check(self.args.allow_destructive, "Supply --allow-destructive for an EMPTY disposable instance.")
        health = self.ok(self.owner, "GET", "/health").data
        self.check(isinstance(health, dict) and health.get("status") == "ok" and health.get("version"),
                   "Health must report ok and the running version.")
        bootstrap = self.owner.bootstrap()
        self.check(bootstrap.get("initialized") is False,
                   "REFUSING TO MODIFY an initialized instance. Use a fresh disposable data directory.")
        self.check(bootstrap.get("user") is None, "An uninitialized service unexpectedly has a user.")
        capabilities = bootstrap.get("capabilities", {})
        self.check(set(capabilities.get("authModes", [])) ==
                   {"open_edit", "public_read", "private_single", "private_multi"},
                   "Bootstrap must advertise exactly the four implemented access modes.")
        self.check(set(capabilities.get("sourceKinds", [])) ==
                   {"local-navigation", "external-push", "github-traffic",
                    "calendar-ics", "weather-open-meteo", "external-json"} and
                   set(capabilities.get("deliveryModes", [])) == {"push", "poll"},
                   "Bootstrap must advertise the implemented source kinds and external delivery modes.")
        self.check(capabilities.get("websocket") == {"supported": False, "enabled": False},
                   "Bootstrap must report WebSocket delivery as unsupported and disabled.")
        self.check(capabilities.get("componentImport") == {
            "manifestVersion": 1, "executable": False, "inputModes": ["url", "json"],
        }, "Component imports must advertise only the implemented declarative manifest inputs.")
        self.check(capabilities.get("pageSchemaVersions") == [2] and
                   capabilities.get("themePackages") == ["builtin"] and
                   capabilities.get("pageThemes") == ["builtin/dashboard", "builtin/ios"] and
                   capabilities.get("layoutModes") == ["regions-grid"],
                   "Page schema, package, page-theme and layout capabilities must be distinct and accurate.")
        self.check(set(capabilities.get("panelThemes", [])) == {
            "builtin/category-navigation", "builtin/search", "builtin/favorites",
            "builtin/navigation", "builtin/github-traffic",
            "builtin/calendar", "builtin/weather", "builtin/metrics", "builtin/status",
        }, "Bootstrap panel theme registry is incomplete or reports an unknown panel.")
        self.check({(entry.get("id"), entry.get("version"))
                    for entry in capabilities.get("datasetSchemas", [])} ==
                   {("navigation.collection", 1), ("github.traffic", 1),
                    ("calendar.events", 1), ("weather.forecast", 1),
                    ("metrics.summary", 1), ("status.collection", 1)},
                   "Dataset schemas must be separately versioned from page schemas.")
        self.check(bootstrap.get("version") == health["version"] and bootstrap.get("spaces") == [],
                   "Bootstrap version must match health and an empty instance must expose no spaces.")
        self.denied(self.owner.request("POST", "/setup", {
            "siteName": "Rejected missing CSRF", "mode": "open_edit", "seedDemo": False,
        }, csrf=False), "setup without CSRF", (400, 403))
        self.check(self.owner.bootstrap().get("initialized") is False,
                   "Rejected setup still initialized the instance.")

    def setup_atomic(self):
        second = self.client()
        second.bootstrap()
        candidates = [(self.owner, self.owner_username, self.owner_password),
                      (second, "smk_" + self.run_id + "_other", secrets.token_urlsafe(30))]

        def attempt(candidate):
            client, username, password = candidate
            return client.request("POST", "/setup", {
                "siteName": "Lingshu HTTP " + self.run_id, "mode": "public_read",
                "username": username, "displayName": "Smoke Owner", "password": password,
                "seedDemo": False,
            })

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(attempt, candidates))
        winners = [index for index, response in enumerate(results) if 200 <= response.status < 300]
        self.check(len(winners) == 1,
                   "Concurrent setup must have exactly one success; got " +
                   ", ".join(str(response.status) for response in results))
        winner = winners[0]
        self.denied(results[1 - winner], "second concurrent setup", (400, 409))
        self.owner, self.owner_username, self.owner_password = candidates[winner]
        bootstrap = self.owner.bootstrap()
        self.check(bootstrap.get("initialized") is True and
                   (bootstrap.get("user") or {}).get("role") == "Owner",
                   "Setup must atomically initialize and sign in the winning Owner.")
        shared = [space for space in bootstrap["spaces"] if space["kind"] == "shared"]
        personal = [space for space in bootstrap["spaces"] if space["kind"] == "personal"]
        self.check(len(shared) == 1 and len(personal) == 1,
                   "Setup must create one shared and one Owner personal space.")
        self.shared, self.personal = shared[0]["id"], personal[0]["id"]
        self.check(bootstrap.get("defaultSpaceId") == self.personal,
                   "Signed-in Owner should default to the personal space.")
        for space_id in (self.shared, self.personal):
            self.check(self.dash(self.owner, space_id)["links"] == [],
                       "seedDemo=false must not create example links.")
        rejected, rejected_username, rejected_password = candidates[1 - winner]
        rejected.bootstrap()
        self.denied(rejected.request("POST", "/auth/login", {
            "username": rejected_username, "password": rejected_password,
        }), "losing concurrent setup must not leave an account", (401, 403))
        self.denied(self.owner.request("POST", "/setup", {
            "siteName": "Must not replace", "mode": "open_edit", "seedDemo": False,
        }), "repeat setup", (400, 409))
        self.ok(self.owner, "PUT", f"/spaces/{self.shared}", {"name": "Shared smoke", "published": True})

    def csrf_and_cookies(self):
        client = self.client()
        client.bootstrap()
        body = {"username": self.owner_username, "password": self.owner_password}
        self.denied(client.request("POST", "/auth/login", body, csrf=False),
                    "login without CSRF", (400, 403))
        self.denied(client.request("POST", "/auth/login", body, token="invalid-csrf-value"),
                    "login with forged CSRF", (400, 403))
        self.check(client.bootstrap().get("user") is None, "Rejected login created a session.")
        pre_login_cookie_names = {cookie.name for cookie in client.cookies}
        client.login(self.owner_username, self.owner_password)
        self.denied(client.request("POST", f"/spaces/{self.shared}/links",
                                   self.link_payload("No CSRF", "csrf"), csrf=False),
                    "authenticated mutation without CSRF", (400, 403))
        auth_cookies = [cookie for cookie in client.cookies if cookie.name not in pre_login_cookie_names]
        self.check(bool(auth_cookies), "Successful login must establish a new authentication cookie.")
        for cookie in auth_cookies:
            attributes = {key.lower(): value for key, value in cookie._rest.items()}
            self.check("httponly" in attributes, "Authentication must use an HttpOnly cookie.")
            self.check(str(attributes.get("samesite", "")).lower() in ("strict", "lax"),
                       "Authentication cookie must use SameSite=Lax or Strict.")
        self.ok(client, "POST", "/auth/logout", {})
        self.check(client.bootstrap().get("user") is None, "Logout left an authenticated session.")
        self.denied(client.request("GET", "/settings"), "settings after logout", (401, 403))

    def navigation_crud(self):
        category = self.add_category(self.owner, self.shared, "Smoke <category>")
        self.shared_category = category["id"]
        private_category = self.add_category(self.owner, self.personal, "Owner private")
        self.private_category = private_category["id"]
        payload = self.link_payload('Shared <unsafe> & "quotes"', "shared", category["id"])
        payload["isFavorite"] = True
        payload["endpoints"] = [{"label": "管理", "url": payload["url"] + "/admin"}]
        self.shared_link = self.add_link(self.owner, self.shared, payload)
        created_readback = next(link for link in self.navigation(self.owner, self.shared)["data"]["links"]
                                if link["id"] == self.shared_link["id"])
        self.check(created_readback == self.shared_link,
                   "Link creation response differs from its stored fields, including updatedAt.")
        self.private_link = self.add_link(self.owner, self.personal,
                                          self.link_payload("Private sentinel " + self.run_id,
                                                            "owner-private", self.private_category))
        edited = dict(payload, description="Updated description", sortOrder=7, tags=["updated", self.run_id])
        updated_response = self.ok(self.owner, "PUT", f"/spaces/{self.shared}/links/{self.shared_link['id']}", edited).data
        observed = next(link for link in self.dash(self.owner, self.shared)["links"]
                        if link["id"] == self.shared_link["id"])
        self.check(observed == updated_response,
                   "Link update response differs from its stored fields, including updatedAt.")
        for key in ("title", "description", "sortOrder", "tags", "endpoints", "isFavorite"):
            self.check(observed.get(key) == edited[key], f"Link update lost field {key}.")
        self.shared_link = observed
        self.ok(self.owner, "PUT", f"/spaces/{self.shared}/categories/{category['id']}", {
            "name": "Renamed category", "icon": "lucide:server", "parentId": None, "sortOrder": 3,
        })
        child = self.add_category(self.owner, self.shared, "Child", category["id"])
        self.denied(self.owner.request("DELETE", f"/spaces/{self.shared}/categories/{category['id']}"),
                    "delete category with links/children", (400, 409, 422))
        self.denied(self.owner.request("PUT", f"/spaces/{self.shared}/categories/{category['id']}", {
            "name": "Cycle", "icon": "lucide:folder", "parentId": child["id"], "sortOrder": 0,
        }), "category cycle")
        self.ok(self.owner, "DELETE", f"/spaces/{self.shared}/categories/{child['id']}")
        for changes, label in [({"url": "javascript:alert(1)"}, "unsafe main URL"),
                               ({"url": "/relative"}, "relative main URL"),
                               ({"title": ""}, "empty title"),
                               ({"icon": "unknown:script"}, "unregistered icon"),
                               ({"endpoints": [{"label": "bad", "url": "file:///tmp/file"}]},
                                "unsafe endpoint URL"),
                               ({"categoryId": self.private_category}, "cross-space category")]:
            bad = dict(self.link_payload("Invalid", "invalid"), **changes)
            self.denied(self.owner.request("POST", f"/spaces/{self.shared}/links", bad), label)
        self.denied(self.owner.request("PUT", f"/spaces/{self.shared}/links/{self.private_link['id']}",
                                       self.link_payload("Cross-space overwrite", "overwrite")),
                    "cross-space link overwrite", (403, 404))
        self.denied(self.owner.request("DELETE", f"/spaces/{self.shared}/links/{self.private_link['id']}"),
                    "cross-space link delete", (403, 404))
        self.denied(self.owner.request("PUT", f"/spaces/{self.personal}", {
            "name": "Private", "published": True,
        }), "publish personal space", (400, 403, 422))
        removed = self.add_link(self.owner, self.shared, self.link_payload("Delete me", "delete"))
        self.ok(self.owner, "DELETE", f"/spaces/{self.shared}/links/{removed['id']}")
        self.check(all(link["id"] != removed["id"] for link in self.dash(self.owner, self.shared)["links"]),
                   "Deleted link still appears.")

    def page_config(self, variant="cards", slot="left", color="light", density="comfortable") -> dict:
        prefix = "smk-" + secrets.token_hex(3)
        category, search, favorites, navigation = (prefix + "-" + name
                                                   for name in ("categories", "search", "favorites", "navigation"))
        category_base = ({"kind": "hidden"} if slot == "hidden" else
                         {"kind": "region", "region": slot, "order": 0})
        category_narrow = ({"kind": "hidden"} if slot == "hidden" else
                           {"kind": "region", "region": "top", "order": 1})
        return {
            "schemaVersion": 2,
            "pageTheme": {"id": "builtin/dashboard"},
            "appearance": {"colorMode": color, "density": density},
            "bindings": {"navigation": {"datasetId": "local-navigation",
                                          "space": "current-page-space", "query": {}}},
            "views": [
                {"id": category, "panel": {"id": "builtin/category-navigation"},
                 "inputs": {"collection": "navigation"}, "interactionScope": "primary-navigation", "settings": {}},
                {"id": search, "panel": {"id": "builtin/search"}, "inputs": {},
                 "interactionScope": "primary-navigation", "settings": {}},
                {"id": favorites, "panel": {"id": "builtin/favorites"},
                 "inputs": {"collection": "navigation"}, "interactionScope": "primary-navigation",
                 "settings": {"variant": variant}},
                {"id": navigation, "panel": {"id": "builtin/navigation"},
                 "inputs": {"collection": "navigation"}, "interactionScope": "primary-navigation",
                 "settings": {"variant": variant, "groupBy": "category"}},
            ],
            "layout": {"mode": "regions-grid", "gap": 16, "grid": {"columns": 24},
                       "placements": {
                           category: {"base": category_base, "overrides": {"narrow": category_narrow}},
                           search: {"base": {"kind": "region", "region": "top", "order": 0,
                                             "size": {"widthPx": 340, "maxWidthPx": 360}}},
                           favorites: {"base": {"kind": "grid", "region": "main", "x": 0, "y": 0,
                                                "w": 24, "h": 4, "heightMode": "content", "locked": False},
                                       "overrides": {"narrow": {"kind": "flow", "region": "main", "order": 0}}},
                           navigation: {"base": {"kind": "grid", "region": "main", "x": 0, "y": 4,
                                                 "w": 24, "h": 12, "heightMode": "content", "locked": False},
                                        "overrides": {"narrow": {"kind": "flow", "region": "main", "order": 1}}},
                       }},
        }

    def layouts(self):
        before = self.dash(self.owner, self.shared)
        original_links = before["links"]
        original_page_id = before["page"]["id"]
        original_navigation = self.navigation(self.owner, self.shared)
        for slot in ("top", "left", "right", "bottom", "hidden"):
            for variant, color, density in (("cards", "dark", "comfortable"),
                                            ("directory", "light", "compact"),
                                            ("cards", "light", "compact"),
                                            ("directory", "dark", "comfortable")):
                config = self.page_config(variant, slot, color, density)
                saved = self.save_page(self.owner, self.shared, config)
                after = self.dash(self.owner, self.shared)
                self.check(after["page"]["id"] == original_page_id, "A layout change replaced the page identity.")
                self.check(after["page"] == saved, "Saved layout config and revision did not round-trip.")
                self.check(after["links"] == original_links, "A layout/theme change mutated navigation data.")
                dataset = after["datasets"]["navigation"]
                self.check(dataset["revision"] == original_navigation["revision"] and
                           dataset["meta"]["sourceUpdatedAt"] == original_navigation["meta"]["sourceUpdatedAt"],
                           "Changing only a page must not rewrite the navigation revision or source timestamp.")
        invalid_configs = []
        value = self.page_config(); value["schemaVersion"] = 1
        invalid_configs.append((value, "unknown layout schema"))
        value = self.page_config(); value["pageTheme"]["id"] = "unknown-theme"
        invalid_configs.append((value, "unknown theme"))
        value = self.page_config(); value["appearance"]["colorMode"] = "neon"
        invalid_configs.append((value, "unknown color mode"))
        value = self.page_config(); value["layout"]["placements"][value["views"][0]["id"]]["base"]["region"] = "main"
        invalid_configs.append((value, "category slot main"))
        value = self.page_config(); value["views"][1]["id"] = value["views"][0]["id"]
        invalid_configs.append((value, "duplicate view IDs"))
        value = self.page_config(); value["views"][1]["panel"]["id"] = "arbitrary-html"
        invalid_configs.append((value, "unregistered panel type"))
        value = self.page_config(); value["bindings"]["navigation"]["datasetId"] = "remote-script"
        invalid_configs.append((value, "unimplemented data source"))
        value = self.page_config(); value["views"][0]["slot"] = "left"
        invalid_configs.append((value, "obsolete view slot is a second position authority"))
        value = self.page_config(); value["views"][-1]["settings"]["widthPx"] = 300
        invalid_configs.append((value, "panel settings cannot duplicate actual layout size"))
        value = self.page_config(); value["layout"]["placements"][value["views"][-1]["id"]]["base"]["x"] = 23
        invalid_configs.append((value, "grid exceeds its 24-column bounds"))
        value = self.page_config(); value["layout"]["placements"][value["views"][-1]["id"]]["base"].update({"y": 0, "locked": True})
        invalid_configs.append((value, "locked grid blocks cannot overlap"))
        value = self.page_config(); value["layout"]["placements"][value["views"][0]["id"]]["overrides"]["wide"] = {"kind": "hidden"}
        invalid_configs.append((value, "unknown breakpoint"))
        value = self.page_config(); value["views"][-1]["inputs"]["collection"] = "missing-alias"
        invalid_configs.append((value, "input must reference a declared binding"))
        value = self.page_config(); value["bindings"]["navigation"]["space"] = self.personal
        invalid_configs.append((value, "binding cannot choose another space"))
        good = self.page(self.owner, self.shared)
        for config, label in invalid_configs:
            self.denied(self.owner.request("PUT", f"/spaces/{self.shared}/page", {
                "name": "Rejected", "config": config, "expectedRevision": good["revision"],
            }), label, (400, 422))
            self.check(self.page(self.owner, self.shared) == good,
                       f"Rejected layout update changed the saved page: {label}.")

    def page_bindings_and_concurrency(self):
        before = self.navigation(self.owner, self.shared)
        current = self.page(self.owner, self.shared)
        observer = self.client()
        observer.login(self.owner_username, self.owner_password)
        choices = [(self.owner, "Concurrent A", self.page_config("cards", "top", "light")),
                   (observer, "Concurrent B", self.page_config("directory", "right", "dark"))]

        def attempt(choice):
            client, name, config = choice
            return client.request("PUT", f"/spaces/{self.shared}/page", {
                "name": name, "config": config, "expectedRevision": current["revision"],
            })

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(attempt, choices))
        winner_indices = [i for i, response in enumerate(results) if 200 <= response.status < 300]
        self.check(len(winner_indices) == 1 and sum(response.status == 409 for response in results) == 1,
                   "Concurrent page writes with one revision must produce one success and one conflict.")
        winner = winner_indices[0]
        saved = results[winner].data
        conflict = results[1 - winner]
        self.check(conflict.data.get("code") == "page_version_conflict" and
                   conflict.data.get("currentRevision") == saved["revision"],
                   "Page conflict must return the winner's current revision.")
        self.check(self.page(self.owner, self.shared) == saved and
                   saved["config"] == choices[winner][2] and saved["name"] == choices[winner][1],
                   "Losing concurrent page write overwrote the winning configuration.")

        config = self.page_config()
        config["bindings"]["favorites-only"] = {
            "datasetId": "local-navigation", "space": "current-page-space", "query": {"favoritesOnly": True},
        }
        config["views"][2]["inputs"]["collection"] = "favorites-only"
        self.save_page(self.owner, self.shared, config, "Filtered binding")
        dashboard = self.dash(self.owner, self.shared)
        self.check(set(dashboard["datasets"]) == {"navigation", "favorites-only"},
                   "Dashboard must return every declared local binding under its own alias.")
        expected_favorites = [link for link in before["data"]["links"] if link["isFavorite"]]
        self.check(dashboard["datasets"]["favorites-only"]["data"]["links"] == expected_favorites and
                   dashboard["datasets"]["navigation"]["data"] == before["data"],
                   "Binding queries must filter a view without copying or mutating local navigation.")

        config = self.page_config()
        config["bindings"]["renamed"] = config["bindings"].pop("navigation")
        for view in config["views"]:
            if "collection" in view["inputs"]:
                view["inputs"]["collection"] = "renamed"
        self.save_page(self.owner, self.shared, config, "Renamed binding")
        dashboard = self.dash(self.owner, self.shared)
        self.check(set(dashboard["datasets"]) == {"renamed"},
                   "The host must not secretly force an undeclared navigation alias into a page.")
        self.check(dashboard["links"] == before["data"]["links"],
                   "Renaming a homepage binding changed the independent admin data.")

        empty = self.page_config()
        empty["bindings"] = {}; empty["views"] = []; empty["layout"]["placements"] = {}
        self.save_page(self.owner, self.shared, empty, "Empty composition")
        dashboard = self.dash(self.owner, self.shared)
        self.check(dashboard["datasets"] == {}, "An empty composition must not include implicit datasets.")
        after = self.navigation(self.owner, self.shared)
        self.check(after["data"] == before["data"] and after["revision"] == before["revision"] and
                   after["meta"]["sourceUpdatedAt"] == before["meta"]["sourceUpdatedAt"],
                   "Empty/renamed/filtered layouts changed authoritative local navigation.")
        self.save_page(self.owner, self.shared, self.page_config(), "Restored composition")

    def bookmark_import(self):
        self.add_link(self.owner, self.shared, self.link_payload("Already present", "existing"))
        html = (Path(__file__).parent / "fixtures" / "bookmarks.html").read_text("utf-8")
        html = html.replace("__RUN_ID__", self.run_id)
        body = {"html": html, "duplicatePolicy": "skip", "targetCategoryId": None}
        before = self.dash(self.owner, self.shared)
        preview = self.ok(self.owner, "POST", f"/spaces/{self.shared}/bookmarks/preview", body).data
        self.check(preview.get("total") == 9 and preview.get("valid") == 5 and preview.get("invalid") == 4 and
                   preview.get("duplicates") == 2,
                   "Preview counts must detect 9 bookmarks, 4 invalid URLs, and 2 duplicates.")
        self.check(preview.get("truncated") is False and len(preview.get("items", [])) == 9,
                   "The small bookmark preview must be complete.")
        self.check(self.dash(self.owner, self.shared)["links"] == before["links"],
                   "Bookmark preview mutated links.")
        imported = self.ok(self.owner, "POST", f"/spaces/{self.shared}/bookmarks/import", body).data
        self.check(imported.get("imported") == 3 and imported.get("skipped") == 2 and imported.get("invalid") == 4,
                   "Skip import must create exactly three safe, distinct bookmarks.")
        after = self.dash(self.owner, self.shared)
        self.check(len(after["links"]) == len(before["links"]) + 3, "Import link count is wrong.")
        nested = next((link for link in after["links"] if "/nested?" in link["url"]), None)
        self.check(nested and nested["title"] == 'Nested <Title> "quoted"' and "x=1&y=2" in nested["url"],
                   "Bookmark text/entities or query were not preserved.")
        category_by_id = {category["id"]: category for category in after["categories"]}
        nested_category = category_by_id.get(nested["categoryId"], {})
        self.check(nested_category.get("name") == "Nested <Folder>" and
                   category_by_id.get(nested_category.get("parentId"), {}).get("name") == "Team & Ops",
                   "Nested bookmark folder hierarchy was lost.")
        for link in after["links"]:
            self.check(urllib.parse.urlsplit(link["url"]).scheme in ("http", "https"),
                       "Import saved an unsafe URL scheme.")
        again = self.ok(self.owner, "POST", f"/spaces/{self.shared}/bookmarks/import", body).data
        self.check(again.get("imported") == 0, "Repeated skip import created duplicate links.")
        repeated = self.dash(self.owner, self.shared)
        self.check(len(repeated["links"]) == len(after["links"]) and
                   len(repeated["categories"]) == len(after["categories"]),
                   "Repeated import duplicated links or folders.")
        self.denied(self.owner.request("POST", f"/spaces/{self.shared}/bookmarks/import", dict(
            body, targetCategoryId=self.private_category)), "cross-space import target")
        self.denied(self.owner.request("POST", f"/spaces/{self.shared}/bookmarks/import", dict(
            body, duplicatePolicy="overwrite")), "unknown duplicate policy", (400, 422))
        keep = self.ok(self.owner, "POST", f"/spaces/{self.shared}/bookmarks/import",
                       dict(body, duplicatePolicy="keep")).data
        self.check(keep.get("imported") == 5 and keep.get("invalid") == 4,
                   "Keep policy must retain all five safe bookmark entries.")
        many_html = "<DL>" + "".join(
            f'<DT><A HREF="https://smoke.example.invalid/{self.run_id}/preview-{number}">Item {number}</A>'
            for number in range(201)) + "</DL>"
        many = self.ok(self.owner, "POST", f"/spaces/{self.shared}/bookmarks/preview",
                       dict(body, html=many_html)).data
        self.check(many.get("total") == 201 and many.get("truncated") is True and
                   len(many.get("items", [])) == 200, "Preview must cap returned items at 200.")
        oversized = dict(body, html="x" * (2 * 1024 * 1024 + 1))
        too_many = dict(body, html="<DL>" +
                        '<DT><A HREF="https://smoke.example.invalid/over-limit">x</A>' * 10001 + "</DL>")
        before_limits = self.navigation(self.owner, self.shared)
        for operation in ("preview", "import"):
            self.denied(self.owner.request("POST", f"/spaces/{self.shared}/bookmarks/{operation}", oversized),
                        f"over-2-MiB bookmark {operation}", (400, 413, 422))
            self.denied(self.owner.request("POST", f"/spaces/{self.shared}/bookmarks/{operation}", too_many),
                        f"over-10000-link bookmark {operation}", (400, 413, 422))
        after_limits = self.navigation(self.owner, self.shared)
        self.check(after_limits["data"] == before_limits["data"] and
                   after_limits["revision"] == before_limits["revision"],
                   "Rejected oversized bookmark files left a partial import or changed the data revision.")

    def concurrent_import(self):
        clients = [self.client(), self.client()]
        for client in clients:
            client.login(self.owner_username, self.owner_password)
        url = f"https://smoke.example.invalid/{self.run_id}/concurrent-import"
        body = {"html": f'<DL><DT><A HREF="{url}">Concurrent</A></DL>',
                "duplicatePolicy": "skip", "targetCategoryId": None}

        def attempt(client):
            return client.request("POST", f"/spaces/{self.shared}/bookmarks/import", body)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(attempt, clients))
        for response in results:
            require_success(response, "concurrent skip import")
        self.check(sum(response.data.get("imported", -1) for response in results) == 1,
                   "Concurrent skip imports must atomically import one link in total.")
        self.check(sum(link["url"] == url for link in self.dash(self.owner, self.shared)["links"]) == 1,
                   "Concurrent skip import saved duplicate URLs.")

    def export_and_public(self):
        guest = self.client()
        boot = guest.bootstrap()
        self.check(boot["user"] is None and all(space["kind"] == "shared" and space["published"]
                                               for space in boot["spaces"]),
                   "Anonymous bootstrap exposed a personal or unpublished space.")
        dashboard = self.dash(guest, self.shared)
        self.check(dashboard["space"]["canEdit"] is False, "public_read advertised anonymous edit access.")
        self.check(self.private_link["id"] not in json.dumps(dashboard), "Public dashboard leaked private data.")
        self.dashboard_denied(guest, self.personal, "anonymous Owner personal dashboard")
        self.denied(guest.request("GET", f"/spaces/{self.personal}/export?format=json"),
                    "anonymous private export", (401, 403, 404))
        self.denied(guest.request("POST", f"/spaces/{self.shared}/links",
                                  self.link_payload("Must reject", "guest-write")),
                    "public_read anonymous write", (401, 403))
        exported = self.ok(guest, "GET", f"/spaces/{self.shared}/export?format=json")
        self.check(isinstance(exported.data, dict) and self.private_link["id"] not in exported.text,
                   "Public JSON export leaked private data or is not JSON.")
        html = self.ok(guest, "GET", f"/spaces/{self.shared}/export?format=html")
        self.check("&lt;unsafe&gt;" in html.text and "&amp;" in html.text and "<unsafe>" not in html.text,
                   "HTML export did not escape bookmark titles.")
        self.check(self.private_link["id"] not in html.text and "owner-private" not in html.text,
                   "Public HTML export leaked private links.")
        self.check("attachment" in html.headers.get("Content-Disposition", "").lower(),
                   "Export must be returned as a download.")

    def member_create(self, suffix: str):
        username = "smk_" + self.run_id + "_" + suffix
        password = secrets.token_urlsafe(30)
        response = self.ok(self.owner, "POST", "/admin/users", {
            "username": username, "displayName": "Smoke " + suffix, "password": password,
        })
        self.check(isinstance(response.data, dict) and response.data.get("id"),
                   "Create member must return a user DTO.")
        client = self.client()
        boot = client.login(username, password)
        spaces = [space for space in boot["spaces"] if space["kind"] == "personal"]
        self.check(len(spaces) == 1 and boot["user"]["role"] == "Member",
                   "Member must have one own personal space and the Member role.")
        self.check(boot["defaultSpaceId"] == spaces[0]["id"], "Member default space must be personal.")
        member = {"id": response.data["id"], "username": username, "password": password,
                  "client": client, "space": spaces[0]["id"], "displayName": "Smoke " + suffix}
        self.members[suffix] = member
        return member

    def multiuser_isolation(self):
        self.mode("private_multi")
        guest = self.client(); guest.bootstrap()
        self.dashboard_denied(guest, self.shared, "private_multi anonymous shared dashboard")
        self.denied(guest.request("POST", "/auth/register", {
            "username": "smk_" + self.run_id + "_blocked", "displayName": "Blocked",
            "password": secrets.token_urlsafe(30),
        }), "registration defaults off", (401, 403, 404, 409))
        alpha = self.member_create("a")
        beta = self.member_create("b")
        for member in (alpha, beta):
            client = member["client"]
            bootstrap = client.bootstrap()
            self.check(self.personal not in {space["id"] for space in bootstrap["spaces"]},
                       "Member bootstrap exposed Owner private space.")
            self.check(self.dash(client, self.shared)["space"]["canEdit"] is False,
                       "Member may read shared data but must not edit it.")
            self.dashboard_denied(client, self.personal, "member reads Owner private space")
            self.dashboard_denied(self.owner, member["space"], "Owner reads member private space")
            self.denied(client.request("POST", f"/spaces/{self.shared}/links",
                                       self.link_payload("Forbidden", "member-shared")),
                        "member shared mutation", (403,))
            self.denied(client.request("GET", "/admin/users"), "member lists all accounts", (403,))
            self.denied(client.request("PUT", "/settings", {
                "siteName": "Takeover", "mode": "open_edit", "registrationEnabled": False,
            }), "member changes instance mode", (403,))
            self.denied(client.request("GET", f"/spaces/{self.personal}/export?format=html"),
                        "member exports Owner private links", (403, 404))
        alpha_link = self.add_link(alpha["client"], alpha["space"],
                                   self.link_payload("Member A private " + self.run_id, "member-a"))
        self.member_private_link = alpha_link
        self.dashboard_denied(beta["client"], alpha["space"], "member reads another member's dashboard")
        self.denied(beta["client"].request("DELETE", f"/spaces/{alpha['space']}/links/{alpha_link['id']}"),
                    "member deletes another member's link", (403, 404))
        self.ok(alpha["client"], "GET", f"/spaces/{alpha['space']}/export?format=json")
        account_list = self.ok(self.owner, "GET", "/admin/users").data
        self.check(isinstance(account_list, list), "Account list should be a user array.")
        self.check(not any("password" in key.lower() or "hash" in key.lower()
                           for account in account_list for key in account),
                   "Admin list returned password material.")

    def registration(self):
        after = self.settings(registrationEnabled=True)
        if after.get("user") is None:
            self.owner_login()
        registrant = self.client(); registrant.bootstrap()
        payload = {"username": "smk_" + self.run_id + "_reg", "displayName": "Self registration",
                   "password": secrets.token_urlsafe(30), "role": "Owner"}
        injected = registrant.request("POST", "/auth/register", payload)
        if not 200 <= injected.status < 300:
            self.denied(injected, "registration request with unrecognized role field", (400, 403, 422))
            self.check(registrant.bootstrap().get("user") is None,
                       "Rejected registration still created a logged-in identity.")
            payload.pop("role")
            self.ok(registrant, "POST", "/auth/register", payload)
        bootstrap = registrant.bootstrap()
        if bootstrap.get("user") is None:
            bootstrap = registrant.login(payload["username"], payload["password"])
        self.check(bootstrap["user"]["role"] == "Member", "Registration accepted injected Owner role.")
        self.denied(registrant.request("GET", "/admin/users"), "registered member admin access", (403,))
        after = self.settings(registrationEnabled=False)
        if after.get("user") is None:
            self.owner_login()
        self.check(after.get("registrationEnabled") is False, "Registration disable was not persisted.")

    def revocation(self):
        alpha, beta = self.members["a"], self.members["b"]
        alpha["client"].login(alpha["username"], alpha["password"])
        self.ok(self.owner, "PUT", f"/admin/users/{alpha['id']}", {
            "displayName": alpha["displayName"], "isEnabled": False,
        })
        self.check(alpha["client"].bootstrap().get("user") is None,
                   "Disabling an account did not revoke its existing session.")
        self.dashboard_denied(alpha["client"], alpha["space"], "disabled account old session")
        self.denied(alpha["client"].request("POST", "/auth/login", {
            "username": alpha["username"], "password": alpha["password"],
        }), "disabled account login", (401, 403))
        self.ok(self.owner, "PUT", f"/admin/users/{alpha['id']}", {
            "displayName": alpha["displayName"], "isEnabled": True,
        })
        alpha["client"].login(alpha["username"], alpha["password"])
        observer = self.client(); observer.login(alpha["username"], alpha["password"])
        old_password = alpha["password"]
        alpha["password"] = secrets.token_urlsafe(30)
        self.ok(self.owner, "PUT", f"/admin/users/{alpha['id']}", {
            "displayName": alpha["displayName"], "isEnabled": True, "password": alpha["password"],
        })
        self.check(alpha["client"].bootstrap().get("user") is None and observer.bootstrap().get("user") is None,
                   "Password reset did not revoke all old sessions.")
        self.denied(observer.request("POST", "/auth/login", {
            "username": alpha["username"], "password": old_password,
        }), "old password after reset", (401, 403))
        alpha["client"].login(alpha["username"], alpha["password"])
        self.ok(self.owner, "PUT", f"/admin/users/{beta['id']}", {
            "displayName": beta["displayName"], "isEnabled": False,
        })
        owner_id = self.owner.bootstrap()["user"]["id"]
        self.denied(self.owner.request("PUT", f"/admin/users/{owner_id}", {
            "displayName": "Owner", "isEnabled": False,
        }), "disable last Owner", (400, 403, 409))
        self.check(self.owner.bootstrap().get("user", {}).get("role") == "Owner",
                   "Rejected Owner disable changed current authentication.")

    def single_and_restore(self):
        alpha, beta = self.members["a"], self.members["b"]
        self.mode("private_single")
        self.check(alpha["client"].bootstrap().get("user") is None,
                   "Switch to single-user mode failed to revoke Member session.")
        self.denied(alpha["client"].request("POST", "/auth/login", {
            "username": alpha["username"], "password": alpha["password"],
        }), "Member login in single-user mode", (401, 403))
        self.check(self.owner.bootstrap().get("registrationEnabled") is False,
                   "Single-user mode must not advertise open registration.")
        guest = self.client(); guest.bootstrap()
        self.dashboard_denied(guest, self.shared, "private_single anonymous read")
        self.mode("private_multi")
        bootstrap = alpha["client"].login(alpha["username"], alpha["password"])
        self.check(bootstrap["user"]["id"] == alpha["id"], "Restoring multi-user mode recreated a Member.")
        self.check(any(link["id"] == self.member_private_link["id"]
                       for link in self.dash(alpha["client"], alpha["space"])["links"]),
                   "Mode changes lost Member private data.")
        beta["client"].bootstrap()
        self.denied(beta["client"].request("POST", "/auth/login", {
            "username": beta["username"], "password": beta["password"],
        }), "manually disabled Member after restoring multi-user mode", (401, 403))

    def public_and_open(self):
        alpha = self.members["a"]
        original_shared_ids = {link["id"] for link in self.dash(self.owner, self.shared)["links"]}
        self.ok(self.owner, "PUT", f"/spaces/{self.shared}", {"name": "Shared smoke", "published": False})
        self.mode("public_read")
        guest = self.client()
        bootstrap = guest.bootstrap()
        self.check(bootstrap["spaces"] == [], "Public mode automatically published previously hidden data.")
        self.dashboard_denied(guest, self.shared, "unpublished shared space")
        self.dashboard_denied(guest, self.personal, "public mode Owner private space")
        self.dashboard_denied(guest, alpha["space"], "public mode Member private space")
        self.ok(self.owner, "PUT", f"/spaces/{self.shared}", {"name": "Shared smoke", "published": True})
        self.dash(guest, self.shared)
        self.mode("open_edit")
        guest.bootstrap()
        opened = self.dash(guest, self.shared)
        self.check(opened["space"]["canEdit"] is True, "open_edit did not grant public-space maintenance.")
        self.dashboard_denied(guest, self.personal, "open_edit Owner private data")
        self.dashboard_denied(guest, alpha["space"], "open_edit Member private data")
        self.denied(guest.request("POST", f"/spaces/{self.personal}/links",
                                  self.link_payload("Forbidden", "open-private")),
                    "open_edit anonymous private mutation", (401, 403, 404))
        added = self.add_link(guest, self.shared, self.link_payload("Anonymous edit", "open-edit"))
        self.ok(guest, "DELETE", f"/spaces/{self.shared}/links/{added['id']}")
        config = self.page_config("cards", "right", "dark")
        self.save_page(guest, self.shared, config, "Open shared")
        self.denied(guest.request("PUT", "/settings", {
            "siteName": "Must not switch", "mode": "private_multi", "registrationEnabled": False,
        }), "anonymous mode change with existing Owner", (401, 403))
        self.denied(guest.request("PUT", "/settings", {
            "siteName": "Must not take over", "mode": "private_multi", "registrationEnabled": False,
            "owner": {"username": "attacker_" + self.run_id, "displayName": "Not Owner",
                      "password": secrets.token_urlsafe(30)},
        }), "anonymous takeover of existing Owner", (400, 401, 403))
        self.denied(guest.request("POST", "/admin/users", {
            "username": "attacker_" + self.run_id, "displayName": "Not a Member",
            "password": secrets.token_urlsafe(30),
        }), "anonymous account creation with existing Owner", (401, 403))
        self.check(self.owner.bootstrap()["mode"] == "open_edit", "Rejected takeover changed instance mode.")
        self.mode("private_multi")
        self.dashboard_denied(guest, self.shared, "old open_edit client after private mode change")
        self.check({link["id"] for link in self.dash(self.owner, self.shared)["links"]} == original_shared_ids,
                   "Public/open/private mode changes modified existing shared links.")
        self.check(any(link["id"] == self.private_link["id"]
                       for link in self.dash(self.owner, self.personal)["links"]),
                   "Public/open/private mode changes lost the Owner's private links.")
        alpha["client"].login(alpha["username"], alpha["password"])
        self.check(any(link["id"] == self.member_private_link["id"]
                       for link in self.dash(alpha["client"], alpha["space"])["links"]),
                   "Public/open/private mode changes lost a Member's private links.")
        self.retained_link = self.add_link(self.owner, self.personal,
                                           self.link_payload("Persistence marker " + self.run_id, "persist"))
        self.persisted_config = self.page_config("directory", "bottom", "dark")
        self.persisted_page = self.save_page(self.owner, self.personal, self.persisted_config, "Persistence page")

    def ownerless(self):
        self.ok(self.owner, "POST", "/setup", {
            "siteName": "Ownerless HTTP " + self.run_id, "mode": "open_edit", "seedDemo": False,
        })
        bootstrap = self.owner.bootstrap()
        self.check(bootstrap["user"] is None and bootstrap["mode"] == "open_edit",
                   "Ownerless setup should remain anonymous in open_edit mode.")
        shared = [space for space in bootstrap["spaces"] if space["kind"] == "shared"]
        self.check(len(shared) == 1 and shared[0]["canEdit"], "Ownerless setup needs an editable shared space.")
        self.shared = shared[0]["id"]
        self.check(self.ok(self.owner, "GET", "/settings").data.get("hasOwner") is False,
                   "Ownerless setup secretly created an account.")
        retained = self.add_link(self.owner, self.shared, self.link_payload("Before Owner", "before-owner"))
        self.denied(self.owner.request("POST", "/setup", {
            "siteName": "Second setup", "mode": "open_edit", "seedDemo": False,
        }), "repeat ownerless setup", (400, 409))
        self.denied(self.owner.request("PUT", "/settings", {
            "siteName": "Needs Owner", "mode": "private_multi", "registrationEnabled": False,
        }), "ownerless switch to authenticated mode without credentials", (400, 409, 422))
        self.check(self.owner.bootstrap()["mode"] == "open_edit", "Rejected mode switch changed mode.")
        self.ok(self.owner, "PUT", "/settings", {
            "siteName": "Owner created", "mode": "private_multi", "registrationEnabled": False,
            "owner": {"username": self.owner_username, "displayName": "Created Owner",
                      "password": self.owner_password},
        })
        self.owner.bootstrap()
        bootstrap = self.owner_login()
        self.check(bootstrap["mode"] == "private_multi", "Owner creation did not apply requested mode.")
        personal = [space for space in bootstrap["spaces"] if space["kind"] == "personal"]
        self.check(len(personal) == 1, "Creating the first Owner did not create its personal space.")
        self.personal = personal[0]["id"]
        self.check(any(link["id"] == retained["id"] for link in self.dash(self.owner, self.shared)["links"]),
                   "Creating the Owner lost prior open navigation.")
        self.check(self.ok(self.owner, "GET", "/settings").data.get("hasOwner") is True,
                   "Owner creation did not persist hasOwner.")
        guest = self.client(); guest.bootstrap()
        self.dashboard_denied(guest, self.shared, "anonymous after first Owner and private mode")
        self.retained_link = self.add_link(self.owner, self.personal,
                                           self.link_payload("Persistence marker " + self.run_id, "persist"))
        self.persisted_config = self.page_config("directory", "bottom", "dark")
        self.persisted_page = self.save_page(self.owner, self.personal, self.persisted_config, "Persistence page")

    def save_state(self):
        if not self.args.state_file:
            return
        path = secure_state_path(self.args.state_file, existing=False)
        navigation = self.navigation(self.owner, self.personal)
        marker = next((link for link in navigation["data"]["links"]
                       if link["id"] == self.retained_link["id"]), None)
        self.check(marker == self.retained_link,
                   "Persistence marker creation response differs from storage before restart.")
        state = {"schemaVersion": 2, "baseUrl": self.base, "runId": self.run_id,
                 "ownerUsername": self.owner_username, "ownerPassword": self.owner_password,
                 "personalSpaceId": self.personal, "sharedSpaceId": self.shared,
                 "marker": self.retained_link, "page": self.persisted_page,
                 "navigationRevision": navigation["revision"],
                 "navigationSourceUpdatedAt": navigation["meta"]["sourceUpdatedAt"],
                 "expectedMode": "private_multi"}
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(path, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        print("Persistence state written with owner-only permissions. It contains test credentials.", flush=True)

    def verify_persistence(self):
        if not self.args.state_file:
            raise Failure("--phase verify-persistence requires --state-file from a successful exercise.")
        path = secure_state_path(self.args.state_file, existing=True)
        state = json.loads(path.read_text("utf-8"))
        self.check(state.get("schemaVersion") == 2 and state.get("baseUrl") == self.base,
                   "Persistence state schema or target URL does not match.")
        self.check(state.get("ownerUsername", "").startswith("smk_" + state.get("runId", "") + "_"),
                   "State does not identify a generated smoke-test account.")
        bootstrap = self.owner.bootstrap()
        self.check(bootstrap.get("initialized") is True and bootstrap.get("mode") == state["expectedMode"],
                   "Initialization or access mode did not survive restart.")
        bootstrap = self.owner.login(state["ownerUsername"], state["ownerPassword"])
        self.check(bootstrap["user"]["role"] == "Owner", "Persisted Owner cannot log in after restart.")
        dashboard = self.dash(self.owner, state["personalSpaceId"])
        marker = next((link for link in dashboard["links"] if link["id"] == state["marker"]["id"]), None)
        differences = ("missing link" if marker is None else ", ".join(sorted(
            key for key in marker.keys() | state["marker"].keys() if marker.get(key) != state["marker"].get(key))))
        self.check(marker == state["marker"],
                   "Persisted link data changed across restart; differing fields: " + differences)
        self.check(dashboard["page"] == state["page"],
                   "Page identity, revision, name or layout did not survive restart.")
        navigation = self.navigation(self.owner, state["personalSpaceId"])
        self.check(navigation["revision"] == state["navigationRevision"] and
                   navigation["meta"]["sourceUpdatedAt"] == state["navigationSourceUpdatedAt"],
                   "Restart changed the local data revision or pretended source data was newly modified.")
        guest = self.client(); guest.bootstrap()
        self.dashboard_denied(guest, state["personalSpaceId"], "private permissions after restart")
        self.dashboard_denied(guest, state["sharedSpaceId"], "shared authentication after restart")

    def run(self):
        if self.args.phase == "verify-persistence":
            self.step("Persisted data, layout, Owner, and authorization after external restart", self.verify_persistence)
        else:
            if self.args.state_file:
                secure_state_path(self.args.state_file, existing=False)
            self.step("Loopback, disposable empty instance, health, capabilities, setup CSRF", self.preflight)
            if self.args.scenario == "ownerless":
                self.step("Anonymous start, navigation maintenance, and atomic first-Owner transition", self.ownerless)
            else:
                steps = [
                    ("Concurrent setup produces exactly one Owner and no demo data", self.setup_atomic),
                    ("CSRF enforcement, HttpOnly authentication, and logout", self.csrf_and_cookies),
                    ("Navigation CRUD, validation, references, cycles, and space boundaries", self.navigation_crud),
                    ("Five category positions, independent themes, and immutable link data", self.layouts),
                    ("Schema 2 bindings, local admin authority, and concurrent page revision conflicts", self.page_bindings_and_concurrency),
                    ("Bookmark folders, unsafe URLs, preview limits, duplicate policies", self.bookmark_import),
                    ("Concurrent bookmark imports deduplicate atomically", self.concurrent_import),
                    ("Public read-only behavior and private-safe escaped downloads", self.export_and_public),
                    ("Multi-user Owner/Member permissions and personal-space isolation", self.multiuser_isolation),
                    ("Optional self registration cannot request Owner privileges", self.registration),
                    ("Disable/reset revoke sessions and protect the last Owner", self.revocation),
                    ("Single-user suspension and safe multi-user restoration", self.single_and_restore),
                    ("Public/open mode privacy, anonymous maintenance, and takeover denial", self.public_and_open),
                ]
                for name, fn in steps:
                    self.step(name, fn)
            self.save_state()
        print(f"PASS: {self.passes} groups; {self.assertions} assertions. No production data was used.", flush=True)


def secure_state_path(value: str, *, existing: bool) -> Path:
    path = Path(value).absolute()
    parent = path.parent
    temporary_root = Path(tempfile.gettempdir()).resolve()
    if path.is_symlink() or parent.is_symlink():
        raise Failure("State path and its parent must not be symbolic links.")
    try:
        resolved_parent = parent.resolve(strict=True)
    except OSError as exc:
        raise Failure("Create a private temporary directory before using --state-file.") from exc
    if temporary_root not in resolved_parent.parents or resolved_parent == temporary_root:
        raise Failure("State file must be inside a dedicated private directory under the system temp directory.")
    info = resolved_parent.stat()
    if info.st_mode & 0o077:
        raise Failure("State directory must have mode 0700; it will hold random test credentials.")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise Failure("State directory must belong to the current OS user.")
    if existing:
        if not path.is_file():
            raise Failure("Persistence state file does not exist.")
        state_info = path.stat()
        if not stat.S_ISREG(state_info.st_mode) or state_info.st_mode & 0o077:
            raise Failure("Persistence state must be a regular owner-only file (mode 0600).")
        if hasattr(os, "getuid") and state_info.st_uid != os.getuid():
            raise Failure("Persistence state file must belong to the current OS user.")
    elif path.exists():
        raise Failure("Refusing to overwrite an existing persistence state file.")
    return resolved_parent / path.name


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="Loopback origin, for example http://127.0.0.1:5188")
    parser.add_argument("--allow-destructive", action="store_true", help="Confirm a fresh disposable test database")
    parser.add_argument("--scenario", choices=("full", "ownerless"), default="full")
    parser.add_argument("--phase", choices=("exercise", "verify-persistence"), default="exercise")
    parser.add_argument("--state-file", help="Optional 0600 state in an existing dedicated 0700 temporary directory")
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()
    started = time.monotonic()
    try:
        if args.timeout <= 0 or args.timeout > 120:
            raise Failure("Timeout must be greater than zero and no more than 120 seconds.")
        Suite(args).run()
    except (Failure, KeyError, StopIteration, TypeError, ValueError, OSError) as error:
        if isinstance(error, Failure):
            message = str(error)
        else:
            message = f"Unexpected API shape or test state: {type(error).__name__}"
        print(f"FAIL: {message}", file=sys.stderr, flush=True)
        return 1
    print(f"Elapsed: {time.monotonic() - started:.2f}s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
