#!/usr/bin/env python3
"""Measure an owned, disposable Home process at idle (Linux, loopback only).

No existing instance, service, database or browser session is accepted.
The output contains process measurements, never the generated login credentials.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import socket
import select
import threading
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request


def snapshot(pid: int) -> dict:
    proc = Path("/proc") / str(pid)
    stat = (proc / "stat").read_text().rsplit(")", 1)[1].split()
    status = {}
    for line in (proc / "status").read_text().splitlines():
        key, _, value = line.partition(":")
        if key in {"VmRSS", "VmHWM", "Threads", "voluntary_ctxt_switches", "nonvoluntary_ctxt_switches"}:
            status[key] = int(value.split()[0])
    io = {}
    for line in (proc / "io").read_text().splitlines():
        key, value = line.split(":")
        io[key] = int(value.strip())
    return {"time": time.monotonic(), "cpuTicks": int(stat[11]) + int(stat[12]),
            "startTicks": stat[19], "status": status, "io": io}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--version-file", type=Path, required=True)
    parser.add_argument("--web-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--seconds", type=int, default=30)
    parser.add_argument("--label", default="zero-rules")
    parser.add_argument("--rules", type=int, default=0,
                        help="create this many isolated schedule rules before sampling (0..5000)")
    parser.add_argument("--schedule-state", choices=("paused", "future"), default="paused")
    parser.add_argument("--disable-work", action="store_true")
    parser.add_argument("--automation-rules", type=int, default=0)
    parser.add_argument("--automation-state", choices=("paused", "enabled"), default="paused")
    parser.add_argument("--enable-notifications", action="store_true")
    parser.add_argument("--executors", type=int, default=0)
    parser.add_argument("--executor-bind", default="")
    args = parser.parse_args()
    if args.seconds < 10 or args.seconds > 120:
        parser.error("measurement window must be 10..120 seconds")
    if args.rules < 0 or args.rules > 5000:
        parser.error("isolated rule count must be 0..5000")
    if not 0 <= args.automation_rules <= 1000 or not 0 <= args.executors <= 4:
        parser.error("automation rules must be 0..1000 and executors 0..4")
    if args.executors and not args.executor_bind:
        parser.error("an existing explicit private interface is required for executor idle observation")
    output = args.output_dir.resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    data_dir = output / "data"
    environment = {key: value for key, value in os.environ.items() if not key.startswith("LINGSHU_")}
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    environment.update({"LINGSHU_LISTEN": f"127.0.0.1:{port}",
                        "LINGSHU_DATA_DIR": str(data_dir),
                        "LINGSHU_STORAGE_PROVIDER": "sqlite",
                        "LINGSHU_LANGUAGE": "zh-CN",
                        "LINGSHU_WEB_DIR": str(args.web_dir.resolve()),
                        "LINGSHU_VERSION_FILE": str(args.version_file.resolve()),
                        "GOMAXPROCS": "4"})
    url = f"http://127.0.0.1:{port}"
    jar = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                        urllib.request.HTTPCookieProcessor(jar))
    csrf = ""
    def request(method: str, path: str, payload: dict | None = None):
        body = json.dumps(payload).encode() if payload is not None else None
        headers = {"Accept": "application/json"}
        if body is not None:
            headers.update({"Content-Type": "application/json", "X-CSRF-TOKEN": csrf})
        req = urllib.request.Request(url + "/api/v1" + path, data=body, headers=headers, method=method)
        with client.open(req, timeout=5) as response:
            return json.load(response)

    listener = None
    listener_thread = None
    listener_stop = threading.Event()
    observed_connections = []
    if args.executors:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind((args.executor_bind, 0))
        listener.listen()
        def watch_listener():
            # This inert private listener counts unexpected outbound probes;
            # it never executes anything. Active tests use the real reference
            # executor and subprocess separately.
            while not listener_stop.is_set():
                readable, _, _ = select.select([listener], [], [], 0.1)
                if readable:
                    connection, _ = listener.accept()
                    observed_connections.append(time.monotonic())
                    connection.close()
        listener_thread = threading.Thread(target=watch_listener, daemon=True)
        listener_thread.start()

    result = {"label": args.label, "provider": "sqlite", "binary": str(args.binary.resolve()),
              "version": args.version_file.read_text().strip(), "state": "starting",
              "hostCPUCount": os.cpu_count(), "loadBefore": os.getloadavg(),
              "rulesRequested": args.rules, "scheduleState": args.schedule_state,
              "workModuleEnabled": not args.disable_work,
              "automationRulesRequested": args.automation_rules,
              "automationState": args.automation_state,
              "notificationsEnabled": args.enable_notifications,
              "configuredIdleExecutors": args.executors}
    log = (output / "server.log").open("w")
    process = subprocess.Popen([str(args.binary.resolve())], env=environment,
                               cwd=output, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
    try:
        for attempt in range(80):
            if process.poll() is not None:
                raise RuntimeError("owned Home process exited during startup")
            try:
                boot = request("GET", "/bootstrap")
                break
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                time.sleep(0.1)
        else:
            raise RuntimeError("owned Home process did not become ready")
        if boot.get("initialized"):
            raise RuntimeError("new disposable fixture unexpectedly already initialized")
        csrf = boot["csrfToken"]
        request("POST", "/setup", {"siteName": "Performance isolated idle fixture", "mode": "private_multi",
                                  "username": "owner", "password": secrets.token_urlsafe(24), "seedDemo": False})
        boot = request("GET", "/bootstrap")
        csrf = boot["csrfToken"]
        shared = next(s["id"] for s in boot["spaces"] if s["kind"] == "shared")
        request("GET", f"/spaces/{shared}/work/board")
        setup_start = time.monotonic()
        future_date = (datetime.now(timezone.utc) + timedelta(days=365)).date().isoformat()
        for number in range(args.rules):
            request("POST", f"/spaces/{shared}/work/schedules",
                    {"id": secrets.token_hex(16), "name": f"Idle fixture {number}",
                     "template": {"title": f"Idle generated item {number}"},
                     "rule": {"frequency": "daily", "time": "09:00", "timezone": "UTC",
                              "startDate": future_date},
                     "enabled": args.schedule_state == "future"})
        if args.automation_rules or args.executors:
            request("PATCH", f"/spaces/{shared}/work/automation/settings",
                    {"expectedRevision": "1", "enabled": True})
        for number in range(args.automation_rules):
            request("POST", f"/spaces/{shared}/work/automation/rules",
                    {"id": secrets.token_hex(16), "name": f"Idle event rule {number}",
                     "eventType": "sync.finished", "template": {"title": f"Idle event item {number}"},
                     "enabled": args.automation_state == "enabled"})
        for number in range(args.executors):
            request("POST", f"/spaces/{shared}/work/executors",
                    {"id": secrets.token_hex(16), "name": f"Idle private executor {number}",
                     "endpoint": f"http://{args.executor_bind}:{listener.getsockname()[1]}",
                     "allowPrivateNetwork": True, "resourceKey": f"idle:{shared}:{number}",
                     "enabled": args.automation_state == "enabled",
                     "secret": {"bearerToken": secrets.token_hex(32)}})
        if args.enable_notifications:
            request("PATCH", f"/spaces/{shared}/work/notifications/settings",
                    {"expectedRevision": "1", "enabled": True})
        if args.disable_work:
            request("PUT", "/settings", {"siteName": "Performance isolated idle fixture",
                                        "mode": "private_multi", "registrationEnabled": False,
                                        "modules": {"work": False}})
            request("GET", "/bootstrap")
        result["fixtureSetupSeconds"] = time.monotonic() - setup_start
        database = data_dir / "lingshu-home.db"
        def fixture_counts():
            # Read only this script's newly-created fixture; outside the sampling window.
            with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
                names = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                return {name: connection.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
                        for name in ("work_items", "work_schedules", "work_schedule_occurrences", "work_automation_rules", "work_automation_events", "work_executors", "work_executions", "work_notices", "work_metric_intervals")
                        if name in names}
        counts_before = fixture_counts()
        if counts_before.get("work_schedules", 0) != args.rules:
            raise RuntimeError("isolated schedule preparation count does not match requested rules")
        if counts_before.get("work_automation_rules", 0) != args.automation_rules or counts_before.get("work_executors", 0) != args.executors:
            raise RuntimeError("isolated automation fixture counts do not match request")
        time.sleep(2)
        snapshots = [snapshot(process.pid)]
        result.update({"state": "sampling", "pid": process.pid, "measurementSeconds": args.seconds,
                       "databaseFiles": [f.name for f in data_dir.glob("*.db")]})
        (output / "status.json").write_text(json.dumps(result, indent=2) + "\n")
        for i in range(args.seconds):
            time.sleep(1)
            if process.poll() is not None:
                raise RuntimeError("owned Home process exited during measurement")
            snapshots.append(snapshot(process.pid))
        first, last = snapshots[0], snapshots[-1]
        elapsed = last["time"] - first["time"]
        cpu_seconds = (last["cpuTicks"] - first["cpuTicks"]) / os.sysconf("SC_CLK_TCK")
        counts_after = fixture_counts()
        if observed_connections:
            raise RuntimeError("configured idle executors caused unexpected outbound connections")
        if counts_before != counts_after:
            raise RuntimeError("future/paused/disabled idle fixture unexpectedly generated items")
        result.update({"state": "complete", "wallSeconds": elapsed, "cpuSeconds": cpu_seconds,
                       "cpuPercentOfOneCore": cpu_seconds / elapsed * 100,
                       "cpuClockTicksPerSecond": os.sysconf("SC_CLK_TCK"),
                       "rssStartKiB": first["status"]["VmRSS"],
                       "rssEndKiB": last["status"]["VmRSS"],
                       "rssPeakObservedKiB": max(s["status"]["VmRSS"] for s in snapshots),
                       "ioDelta": {k: last["io"][k]-first["io"][k] for k in first["io"]},
                       "httpRequestsDuringWindow": 0, "unexpectedExecutorConnections": len(observed_connections), "loadAfter": os.getloadavg(),
                       "fixtureCountsBefore": counts_before, "fixtureCountsAfter": counts_after,
                       "scope": "Owned idle server only, no browser or load requests during observation; CPU tick quantization applies; zero observed disk IO does not independently prove zero SQL queries."})
        (output / "measurements.json").write_text(json.dumps(result, indent=2) + "\n")
        (output / "samples.json").write_text(json.dumps(snapshots, indent=2) + "\n")
    except Exception as exc:
        result.update({"state": "failed", "error": str(exc)})
        raise
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=18)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
                result["forcedOwnedProcessCleanup"] = True
        result["processExitCode"] = process.returncode
        (output / "status.json").write_text(json.dumps(result, indent=2) + "\n")
        log.close()
        listener_stop.set()
        if listener_thread is not None:
            listener_thread.join(timeout=1)
        if listener is not None:
            listener.close()
    print(json.dumps({k: result[k] for k in ("state", "label", "wallSeconds", "cpuSeconds", "rssStartKiB", "rssEndKiB")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
