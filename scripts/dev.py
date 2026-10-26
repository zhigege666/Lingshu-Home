#!/usr/bin/env python3
"""Build and run the development application without installing a system service."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime"
STATE = RUNTIME / "service.json"
LOG = RUNTIME / "service.log"
BINARY = ROOT / "dist" / ("lingshu-home.exe" if os.name == "nt" else "lingshu-home")


def instance_language(value: str) -> str | None:
    if value == "":
        return None
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
    environment = {**os.environ, "LINGSHU_LISTEN": args.listen,
                   "LINGSHU_DATA_DIR": str(Path(args.data_dir).resolve()),
                   "LINGSHU_WEB_DIR": str(ROOT / "web" / "dist"),
                   "LINGSHU_VERSION_FILE": str(ROOT / "VERSION")}
    if args.provider is not None:
        environment["LINGSHU_STORAGE_PROVIDER"] = args.provider
    # Do not turn the server's first-run language choice into an implicit
    # startup override. Omission also lets an existing instance reuse its
    # persisted language after the helper restarts it.
    if args.language is None:
        environment.pop("LINGSHU_LANGUAGE", None)
    else:
        environment["LINGSHU_LANGUAGE"] = args.language
    return environment


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


def health_connection(host: str, port: str, environment: dict[str, str]):
    certificate = environment.get("LINGSHU_TLS_CERT_FILE", "")
    key = environment.get("LINGSHU_TLS_KEY_FILE", "")
    if bool(certificate) != bool(key):
        raise ValueError("LINGSHU_TLS_CERT_FILE and LINGSHU_TLS_KEY_FILE must be configured together.")
    scheme = "https" if certificate else "http"
    # Keep certificate and hostname verification enabled. The standard trust
    # configuration also supports SSL_CERT_FILE for an explicitly trusted CA.
    context = ssl.create_default_context() if certificate else None
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                        urllib.request.HTTPSHandler(context=context))
    url_host = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(host, host)
    url = f"{scheme}://{'[' + url_host + ']' if ':' in url_host else url_host}:{port}"
    return url, client


def cleanup_failed_start(process: subprocess.Popen, record: dict | None) -> None:
    # This is only the Popen child created by this invocation, never a PID
    # loaded from disk. Give Home's 15-second graceful shutdown time to drain.
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=18)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if record is not None and STATE.exists():
        try:
            current = json.loads(STATE.read_text())
        except (OSError, ValueError):
            return
        if all(current.get(key) == record.get(key) for key in ("pid", "exe", "startTicks", "exeDevice", "exeInode")):
            STATE.unlink(missing_ok=True)


class StorageSetupError(ValueError):
    """The owned server is serving its recovery UI and must remain running."""


def probe_startup(url: str, timeout: float = 1.0, *, client=None) -> tuple[str, str]:
    """Probe setup and health through the same verified connection."""
    base_url = url.rstrip("/")
    open_url = client.open if client is not None else urllib.request.urlopen
    try:
        with open_url(base_url + "/api/v1/storage/bootstrap", timeout=timeout) as response:
            if response.status != 200:
                return "pending", ""
            bootstrap = json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            return "pending", ""
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, ssl.SSLCertVerificationError):
            raise
        return "pending", ""
    except ssl.SSLCertVerificationError:
        raise
    except (OSError, ValueError):
        return "pending", ""
    else:
        if not isinstance(bootstrap, dict):
            return "pending", ""
        state = bootstrap.get("state")
        if state == "required":
            return "required", ""
        if state == "error":
            detail = bootstrap.get("error")
            message = detail.get("message") if isinstance(detail, dict) else None
            return "error", message if isinstance(message, str) and message else "Storage initialization failed."
        if state != "ready":
            return "pending", ""
    try:
        with open_url(base_url + "/health", timeout=timeout) as response:
            return ("ready", "") if response.status == 200 else ("pending", "")
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, ssl.SSLCertVerificationError):
            raise
        return "pending", ""
    except ssl.SSLCertVerificationError:
        raise
    except OSError:
        return "pending", ""


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
    environment = app_environment(args)
    url, client = health_connection(host, port, environment)
    process, data = None, None
    try:
        with LOG.open("a") as log:
            LOG.chmod(0o600)
            process = subprocess.Popen([str(BINARY)], cwd=ROOT, env=environment,
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
        data = {**identity, "url": url, "dataDir": str(Path(args.data_dir).resolve()), "provider": environment.get("LINGSHU_STORAGE_PROVIDER"), "language": args.language}
        STATE.write_text(json.dumps(data, indent=2) + "\n")
        STATE.chmod(0o600)
        last_error = "No successful health response."
        for _ in range(100):
            if process.poll() is not None:
                raise ValueError(f"Service exited. Inspect {LOG}")
            try:
                readiness, detail = probe_startup(url, client=client)
                if readiness == "required":
                    print(f"Started PID {process.pid}: {url}; choose the database in the browser to finish storage setup.")
                    return
                if readiness == "ready":
                    print(f"Started PID {process.pid}: {url}")
                    return
                if readiness == "error":
                    raise StorageSetupError(f"Storage is not ready: {detail} Open {url} to retry. "
                                            "The recorded process is still running and can be stopped with this launcher.")
                last_error = "Storage or health endpoint is not ready."
            except urllib.error.URLError as exc:
                if isinstance(exc.reason, ssl.SSLCertVerificationError):
                    raise ValueError(f"HTTPS health check certificate verification failed for {url}: {exc.reason}. "
                                     "Trust the issuing CA and use a listening hostname/IP covered by the certificate.") from exc
                last_error = str(exc)
            except ssl.SSLCertVerificationError as exc:
                raise ValueError(f"HTTPS health check certificate verification failed for {url}: {exc}") from exc
            except OSError as exc:
                last_error = str(exc)
            time.sleep(0.1)
        raise ValueError(f"Service did not become healthy: {last_error} Inspect {LOG}.")
    except StorageSetupError:
        # A reachable recovery page is useful even while the selected database
        # is unavailable. Keep its verified process/state for retry or stop.
        raise
    except BaseException as exc:
        if process is not None:
            try:
                cleanup_failed_start(process, data)
            except (OSError, subprocess.TimeoutExpired) as cleanup_error:
                raise ValueError(f"Startup failed ({exc}); could not confirm cleanup of the newly started PID "
                                 f"{process.pid}. Inspect {LOG} before starting again.") from cleanup_error
        raise


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
                        default=None, help="Select storage explicitly; omit to use environment, saved storage or first-run setup")
    parser.add_argument("--language", type=instance_language, metavar="{zh-CN,en}",
                        default=os.environ.get("LINGSHU_LANGUAGE") or None,
                        help="Set the instance language; omit to choose on first setup or reuse its saved language")
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
