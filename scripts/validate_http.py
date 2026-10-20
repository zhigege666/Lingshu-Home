#!/usr/bin/env python3
"""Run the HTTP acceptance suite on fresh, owned processes, including real restarts."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=("sqlite", "postgres"), default="sqlite")
    parser.add_argument("--binary", type=Path, default=ROOT / "dist/lingshu-home")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = (args.output_dir or ROOT / ".runtime" / f"acceptance-{args.provider}-{stamp}").resolve()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    output.chmod(0o700)
    results = []
    started = time.monotonic()
    try:
        for scenario, variable in [("full", "LINGSHU_HTTP_POSTGRES_URL"), ("ownerless", "LINGSHU_OWNERLESS_POSTGRES_URL")]:
            if args.provider == "postgres" and not os.environ.get(variable):
                raise RuntimeError(f"Set {variable} to a dedicated fresh PostgreSQL database.")
            folder = output / scenario
            folder.mkdir(mode=0o700)
            with socket.socket() as port_socket:
                port_socket.bind(("127.0.0.1", 0))
                port = port_socket.getsockname()[1]
            url = f"http://127.0.0.1:{port}"
            env = {**os.environ, "LINGSHU_LISTEN": f"127.0.0.1:{port}",
                   "LINGSHU_DATA_DIR": str(folder / "data"), "LINGSHU_STORAGE_PROVIDER": args.provider,
                   "LINGSHU_WEB_DIR": str(ROOT / "web/dist"), "LINGSHU_VERSION_FILE": str(ROOT / "VERSION"),
                   "LINGSHU_SECURE_COOKIES": "false"}
            if args.provider == "postgres":
                env["LINGSHU_DATABASE_URL"] = os.environ[variable]
            else:
                env.pop("LINGSHU_DATABASE_URL", None)
            process: subprocess.Popen | None = None
            # Generated account credentials live only in a private OS temporary directory.
            # Keep human-readable logs/summaries in output-dir, without retaining state secrets there.
            with tempfile.TemporaryDirectory(prefix=f"lingshu-http-state-{scenario}-") as state_dir, \
                    (folder / "server.log").open("ab") as log:
                (folder / "server.log").chmod(0o600)
                state_file = Path(state_dir) / "state.json"

                def start() -> subprocess.Popen:
                    child = subprocess.Popen([str(args.binary.resolve())], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
                    for _ in range(150):
                        if child.poll() is not None:
                            raise RuntimeError(f"{scenario} server exited; inspect its private server.log.")
                        try:
                            with urllib.request.urlopen(url + "/health", timeout=1) as response:
                                if response.status == 200 and child.poll() is None:
                                    return child
                        except OSError:
                            pass
                        time.sleep(0.1)
                    child.terminate()
                    child.wait(timeout=20)
                    raise RuntimeError(f"{scenario} server did not become healthy.")

                try:
                    process = start()
                    for phase in ("exercise", "verify-persistence"):
                        if phase == "verify-persistence":
                            process.terminate()
                            process.wait(timeout=25)
                            process = start()
                        command = [sys.executable, str(ROOT / "tests/http_smoke.py"), "--base-url", url,
                                   "--allow-destructive", "--scenario", scenario, "--phase", phase,
                                   "--state-file", str(state_file)]
                        run_started = time.monotonic()
                        with (folder / f"{phase}.log").open("w") as report:
                            (folder / f"{phase}.log").chmod(0o600)
                            completed = subprocess.run(command, cwd=ROOT, stdout=report, stderr=subprocess.STDOUT)
                        result = {"scenario": scenario, "phase": phase, "status": "passed" if completed.returncode == 0 else "failed",
                                  "durationSeconds": round(time.monotonic() - run_started, 2)}
                        report_text = (folder / f"{phase}.log").read_text("utf-8")
                        counts = re.search(r"^PASS: (\d+) groups; (\d+) assertions\.", report_text, re.MULTILINE)
                        if completed.returncode == 0 and counts:
                            result.update({"groups": int(counts.group(1)), "assertions": int(counts.group(2))})
                        elif completed.returncode == 0:
                            result["status"] = "failed"
                        results.append(result)
                        print(json.dumps(result), flush=True)
                        if result["status"] != "passed":
                            raise RuntimeError(f"{scenario}/{phase} failed; inspect its private report.")
                finally:
                    if process and process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=25)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
        return 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f"Acceptance failed: {exc}", file=sys.stderr)
        return 1
    finally:
        report = {"version": (ROOT / "VERSION").read_text().strip(), "provider": args.provider,
                  "completedAt": datetime.now(timezone.utc).isoformat(),
                  "durationSeconds": round(time.monotonic() - started, 2), "results": results,
                  "passed": len(results) == 4 and all(item["status"] == "passed" for item in results)}
        (output / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
        (output / "summary.json").chmod(0o600)
        print(f"Acceptance summary: {output}/summary.json")


if __name__ == "__main__":
    raise SystemExit(main())
