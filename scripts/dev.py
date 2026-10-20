#!/usr/bin/env python3
"""Build and run the development application without installing a system service."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime"
STATE = RUNTIME / "service.json"
LOG = RUNTIME / "service.log"
BINARY = ROOT / "dist" / ("lingshu-home.exe" if os.name == "nt" else "lingshu-home")


def instance_language(value: str) -> str:
    if value == "":
        return "zh-CN"
    if value not in ("zh-CN", "en"):
        raise argparse.ArgumentTypeError("instance language must be zh-CN or en")
    return value


def private_runtime() -> None:
    RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
    RUNTIME.chmod(0o700)


def build() -> None:
    version = (ROOT / "VERSION").read_text().strip()
    for name in ("package.json", "package-lock.json"):
        path = ROOT / "web" / name
        data = json.loads(path.read_text())
        data["version"] = version
        if "packages" in data:
            data["packages"][""]["version"] = version
        path.write_text(json.dumps(data, indent=2) + "\n")
    npm = os.environ.get("LINGSHU_NPM", "npm.cmd" if os.name == "nt" else "npm")
    subprocess.run([npm, "ci", "--no-fund"], cwd=ROOT / "web", check=True)
    subprocess.run([npm, "run", "build"], cwd=ROOT / "web", check=True)
    subprocess.run([os.environ.get("LINGSHU_NODE", "node"), "scripts/collect_node_licenses.mjs"], cwd=ROOT, check=True)
    BINARY.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "CGO_ENABLED": "0"}
    subprocess.run([os.environ.get("LINGSHU_GO", "go"), "build", "-buildvcs=false", "-trimpath",
                    "-ldflags=-s -w", "-o", str(BINARY), "./cmd/lingshu-home"],
                   cwd=ROOT / "server", env=env, check=True)
    subprocess.run([os.environ.get("LINGSHU_GO", "go"), "run", "-buildvcs=false",
                    "../scripts/collect_go_licenses.go", "../dist/licenses/go"],
                   cwd=ROOT / "server", env=env, check=True)
    print(f"Built Lingshu-Home {version}")


def app_environment(args: argparse.Namespace) -> dict[str, str]:
    return {**os.environ, "LINGSHU_LISTEN": args.listen,
            "LINGSHU_DATA_DIR": str(Path(args.data_dir).resolve()),
            "LINGSHU_STORAGE_PROVIDER": args.provider,
            "LINGSHU_LANGUAGE": args.language,
            "LINGSHU_WEB_DIR": str(ROOT / "web" / "dist"),
            "LINGSHU_VERSION_FILE": str(ROOT / "VERSION")}


def process_identity(pid: int) -> dict | None:
    try:
        proc = Path(f"/proc/{pid}")
        stat = (proc / "stat").read_text().rsplit(")", 1)[1].split()
        executable = proc / "exe"
        # The kernel still exposes the running inode after an atomic rebuild,
        # but readlink adds " (deleted)" to its old path. Do not resolve that
        # synthetic filename or compare with the replacement file on disk.
        binary = executable.stat()
        return {"pid": pid, "exe": os.readlink(executable).removesuffix(" (deleted)"),
                "startTicks": stat[19], "exeDevice": binary.st_dev, "exeInode": binary.st_ino}
    except (OSError, IndexError):
        return None


def load_state() -> dict | None:
    if not STATE.exists():
        return None
    data = json.loads(STATE.read_text())
    identity = process_identity(data["pid"])
    if not identity or any(data.get(key) != identity[key] for key in ("pid", "exe", "startTicks")):
        return None
    # Older helper state recorded only PID, start time and path. Keep that
    # original check until the next start records the stronger inode identity.
    if "exeDevice" in data or "exeInode" in data:
        if any(data.get(key) != identity[key] for key in ("exeDevice", "exeInode")):
            return None
    return data


def start(args: argparse.Namespace) -> None:
    if not sys.platform.startswith("linux"):
        raise ValueError("Use 'run' in the foreground on this operating system.")
    private_runtime()
    current = load_state()
    if current:
        print(f"Already running: PID {current['pid']}, {current['url']}")
        return
    host, port = args.listen.rsplit(":", 1)
    host = host.strip("[]")
    probe = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM)
    try:
        # Match the Linux server's restart semantics: closed connections may
        # remain in TIME_WAIT, while an active listener must still refuse bind.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind((host, int(port)))
    finally:
        probe.close()
    if not BINARY.is_file() or not (ROOT / "web/dist/index.html").is_file():
        raise ValueError("Build the application first: python3 scripts/dev.py build")
    with LOG.open("a") as log:
        LOG.chmod(0o600)
        process = subprocess.Popen([str(BINARY)], cwd=ROOT, env=app_environment(args),
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    identity = None
    for _ in range(30):
        identity = process_identity(process.pid)
        if identity and identity["exe"] == str(BINARY.resolve()):
            break
        if process.poll() is not None:
            raise ValueError(f"Service exited. Inspect {LOG}")
        time.sleep(0.05)
    if not identity or identity["exe"] != str(BINARY.resolve()):
        raise ValueError("Could not verify the started process identity.")
    url_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    url = f"http://{'[' + url_host + ']' if ':' in url_host else url_host}:{port}"
    data = {**identity, "url": url, "dataDir": str(Path(args.data_dir).resolve()), "provider": args.provider, "language": args.language}
    STATE.write_text(json.dumps(data, indent=2) + "\n")
    STATE.chmod(0o600)
    for _ in range(100):
        if process.poll() is not None:
            raise ValueError(f"Service exited. Inspect {LOG}")
        try:
            with urllib.request.urlopen(url + "/health", timeout=1) as response:
                if response.status == 200:
                    print(f"Started PID {process.pid}: {url}")
                    return
        except OSError:
            pass
        time.sleep(0.1)
    raise ValueError(f"Service did not become healthy. Inspect {LOG}; recorded process may still be running.")


def stop() -> None:
    data = load_state()
    if not data:
        print("No matching development service is running.")
        return
    os.kill(data["pid"], signal.SIGTERM)
    for _ in range(180):
        if not load_state():
            STATE.unlink(missing_ok=True)
            print("Stopped; application data retained.")
            return
        time.sleep(0.1)
    raise ValueError("Graceful stop timed out; the process was not forcibly killed.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("build", "run", "start", "stop", "status"))
    parser.add_argument("--listen", default=os.environ.get("LINGSHU_LISTEN", "127.0.0.1:5180"))
    parser.add_argument("--data-dir", default=os.environ.get("LINGSHU_DATA_DIR", str(ROOT / "data")))
    parser.add_argument("--provider", choices=("sqlite", "postgres"),
                        default=os.environ.get("LINGSHU_STORAGE_PROVIDER", "sqlite"))
    parser.add_argument("--language", type=instance_language, choices=("zh-CN", "en"),
                        default=os.environ.get("LINGSHU_LANGUAGE", "zh-CN"))
    args = parser.parse_args()
    try:
        if args.action == "build":
            build()
        elif args.action == "start":
            start(args)
        elif args.action == "stop":
            stop()
        elif args.action == "status":
            data = load_state()
            print(json.dumps(data, indent=2) if data else "Not running")
        else:
            if not BINARY.is_file():
                raise ValueError("Build the application first.")
            return subprocess.call([str(BINARY)], cwd=ROOT, env=app_environment(args))
        return 0
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        print(f"Lingshu-Home: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
