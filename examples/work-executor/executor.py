#!/usr/bin/env python3
"""Reference Home HTTP executor (Python 3.10+, Linux/POSIX, standard library)."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import logging
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import socketserver
import sqlite3
import subprocess
import threading
import time
from urllib.parse import urlsplit

MAX_BODY = 1024 * 1024
RESULT_LIMIT = 4000
MESSAGE_LIMIT = 1000
RUN_ID = re.compile(r"[0-9a-f]{32}")
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(value) for value in
                         ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"))
LOG = logging.getLogger("work-executor")


def receipt(run_id: str, state: str, result: str = "", message: str = "") -> dict:
    return {"id": run_id, "state": state, "result": result, "message": message}


def bounded_text(data: bytes, limit: int, truncated: bool = False) -> str:
    text = data.decode("utf-8", errors="replace")
    truncated = truncated or len(text) > limit
    marker = "\n[output truncated]" if truncated else ""
    return text[:limit-len(marker)] + marker


class ReceiptStore:
    def __init__(self, path: Path):
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock_file = self.path.with_suffix(self.path.suffix + ".lock").open("a+b")
        os.chmod(self.lock_file.name, 0o600)
        try:
            fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock_file.close()
            raise RuntimeError("another executor already owns this database") from None
        try:
            with self.connection() as db, db:
                os.chmod(self.path, 0o600)
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("""CREATE TABLE IF NOT EXISTS runs(
                    id TEXT PRIMARY KEY,
                    request_hash TEXT NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','unknown')),
                    result TEXT NOT NULL DEFAULT '',
                    message TEXT NOT NULL DEFAULT '',
                    updated_at REAL NOT NULL
                )""")
                db.execute("UPDATE runs SET state='unknown',message=?,updated_at=? WHERE state='running'",
                           ("Executor restarted before completion could be confirmed; this run was not restarted.",
                            time.time()))
        except BaseException:
            self.lock_file.close()
            raise

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    def find(self, run_id: str):
        with self.connection() as db:
            return db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()

    @staticmethod
    def public(row) -> dict:
        return receipt(row["id"], row["state"], row["result"], row["message"])

    def insert(self, run_id: str, request_hash: str):
        with self.connection() as db, db:
            db.execute("INSERT INTO runs(id,request_hash,state,updated_at) VALUES(?,?,'running',?)",
                       (run_id, request_hash, time.time()))

    def finish(self, run_id: str, state: str, result: str, message: str):
        with self.connection() as db, db:
            db.execute("UPDATE runs SET state=?,result=?,message=?,updated_at=? WHERE id=? AND state='running'",
                       (state, result, message, time.time(), run_id))

    def close(self):
        self.lock_file.close()


@dataclass(frozen=True)
class CommandConfig:
    argv: tuple[str, ...]
    timeout: float = 60
    workers: int = 2
    cwd: str | None = None


def stop_owned_group(process: subprocess.Popen):
    """Stop this live child's process group; never promise all descendants stopped."""
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            # The receipt remains unknown, including when a child cannot be reaped.
            return


def run_command(config: CommandConfig, payload: bytes, stopping: threading.Event) -> tuple[str, str, str]:
    try:
        process = subprocess.Popen(config.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, cwd=config.cwd, shell=False,
                                   start_new_session=True)
    except OSError:
        return "failed", "", "The configured command could not be started."
    selector = selectors.DefaultSelector()
    stdout, stderr = bytearray(), bytearray()
    overflow = {"stdout": False, "stderr": False}
    streams = (process.stdin, process.stdout, process.stderr)
    for stream in streams:
        os.set_blocking(stream.fileno(), False)
    selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    sent = 0
    deadline = time.monotonic() + config.timeout
    uncertain = ""
    try:
        while process.poll() is None or selector.get_map():
            if stopping.is_set():
                uncertain = "Executor stopped before completion could be confirmed."
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                uncertain = "Execution deadline exceeded."
                break
            for key, _ in selector.select(min(0.1, remaining)):
                stream, kind = key.fileobj, key.data
                if kind == "stdin":
                    try:
                        count = os.write(stream.fileno(), payload[sent:sent+65536])
                        sent += count
                    except BrokenPipeError:
                        sent = len(payload)
                    if sent == len(payload):
                        selector.unregister(stream)
                        stream.close()
                    continue
                chunk = os.read(stream.fileno(), 65536)
                if not chunk:
                    selector.unregister(stream)
                    stream.close()
                    continue
                buffer = stdout if kind == "stdout" else stderr
                maximum = 4 * (RESULT_LIMIT if kind == "stdout" else MESSAGE_LIMIT)
                available = max(0, maximum-len(buffer))
                buffer.extend(chunk[:available])
                overflow[kind] = overflow[kind] or len(chunk) > available
        if uncertain:
            stop_owned_group(process)
            return ("unknown", bounded_text(bytes(stdout), RESULT_LIMIT, overflow["stdout"]),
                    uncertain + " The owned process group was signaled where still live; "
                    "escaped descendants and external effects were not verified.")
        code = process.wait()
        state = "succeeded" if code == 0 else "failed"
        message = f"Configured process exited with code {code}."
        if stderr:
            message += "\n" + bounded_text(bytes(stderr), MESSAGE_LIMIT, overflow["stderr"])
        return (state, bounded_text(bytes(stdout), RESULT_LIMIT, overflow["stdout"]),
                bounded_text(message.encode(), MESSAGE_LIMIT))
    except OSError:
        stop_owned_group(process)
        return "unknown", bounded_text(bytes(stdout), RESULT_LIMIT, overflow["stdout"]), "Command I/O failed; completion could not be confirmed."
    finally:
        selector.close()
        for stream in streams:
            stream.close()


class Executor:
    def __init__(self, store: ReceiptStore, config: CommandConfig):
        self.store, self.config = store, config
        self.slots = threading.BoundedSemaphore(config.workers)
        self.guard = threading.Lock()
        self.stopping = threading.Event()
        self.threads: set[threading.Thread] = set()

    def submit(self, run_id: str, canonical: bytes) -> tuple[int, dict]:
        request_hash = hashlib.sha256(canonical).hexdigest()
        with self.guard:
            existing = self.store.find(run_id)
            if existing is not None:
                if not hmac.compare_digest(existing["request_hash"], request_hash):
                    return 409, receipt(run_id, "unknown", message="This id belongs to a different request.")
                return 200, self.store.public(existing)
            if self.stopping.is_set():
                return 503, receipt(run_id, "unknown", message="Executor is stopping; request was not accepted.")
            if not self.slots.acquire(blocking=False):
                return 429, receipt(run_id, "unknown", message="All command slots are occupied; request was not accepted.")
            try:
                self.store.insert(run_id, request_hash)
            except BaseException:
                self.slots.release()
                raise
            thread = threading.Thread(target=self._execute, args=(run_id, canonical), daemon=True)
            self.threads.add(thread)
            try:
                thread.start()
            except RuntimeError:
                self.threads.discard(thread)
                self.slots.release()
                self.store.finish(run_id, "failed", "", "The configured command could not be scheduled.")
        return 202, self.store.public(self.store.find(run_id))

    def _execute(self, run_id: str, canonical: bytes):
        try:
            state, result, message = run_command(self.config, canonical, self.stopping)
            try:
                self.store.finish(run_id, state, result, message)
            except sqlite3.Error:
                # Do not claim completion when its durable receipt could not be saved.
                LOG.error("Could not persist the outcome for run %s.", run_id)
        finally:
            self.slots.release()
            with self.guard:
                self.threads.discard(threading.current_thread())

    def close(self):
        self.stopping.set()
        with self.guard:
            running = tuple(self.threads)
        for thread in running:
            thread.join(timeout=3)
        self.store.close()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "HomeReferenceExecutor/1"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *_):
        # Do not log credentials, payloads, command argv or output.
        pass

    def send_receipt(self, status: int, value: dict):
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if status == 401:
            self.send_header("WWW-Authenticate", "Bearer")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        expected = ("Bearer " + self.server.token).encode()
        supplied = self.headers.get("Authorization", "").encode()
        if hmac.compare_digest(supplied, expected):
            return True
        self.close_connection = True
        self.send_receipt(401, receipt("", "unknown", message="Bearer authentication is required."))
        return False

    def do_GET(self):
        if not self.authorized():
            return
        path = urlsplit(self.path)
        run_id = path.path.removeprefix("/runs/")
        if path.query or path.path != "/runs/" + run_id or RUN_ID.fullmatch(run_id) is None:
            self.send_receipt(404, receipt("", "unknown", message="Unknown receipt path."))
            return
        try:
            row = self.server.executor.store.find(run_id)
        except sqlite3.Error:
            self.send_receipt(503, receipt(run_id, "unknown", message="Receipt storage is unavailable."))
            return
        if row is None:
            self.send_receipt(404, receipt(run_id, "unknown", message="No request was accepted with this id."))
        else:
            self.send_receipt(200, self.server.executor.store.public(row))

    def do_POST(self):
        if not self.authorized():
            return
        run_id = ""
        try:
            if self.path != "/runs":
                self.close_connection = True
                self.send_receipt(404, receipt("", "unknown", message="Unknown request path."))
                return
            if self.headers.get("Transfer-Encoding") is not None:
                raise ValueError("Transfer-Encoding is not supported.")
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise ValueError("Content-Type must be application/json.")
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > MAX_BODY:
                raise ValueError("Content-Length must be between 1 and 1048576 bytes.")
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete request body.")
            value = json.loads(raw, object_pairs_hook=unique_object)
            if not isinstance(value, dict) or set(value) - {"id", "item", "event"}:
                raise ValueError("Use only id, item and optional event.")
            run_id = value.get("id", "")
            if not isinstance(run_id, str) or RUN_ID.fullmatch(run_id) is None:
                run_id = ""
                raise ValueError("id must be 32 lowercase hexadecimal characters.")
            if self.headers.get("Idempotency-Key") != run_id:
                raise ValueError("Idempotency-Key must equal id.")
            if not isinstance(value.get("item"), dict) or "event" in value and not isinstance(value["event"], dict):
                raise ValueError("item and optional event must be JSON objects.")
            canonical = json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False,
                                   separators=(",", ":")).encode()
        except (ValueError, UnicodeError, TimeoutError) as exc:
            self.close_connection = True
            self.send_receipt(400, receipt(run_id, "unknown", message=str(exc)[:160]))
            return
        try:
            status, result = self.server.executor.submit(run_id, canonical)
        except (sqlite3.Error, OSError, RuntimeError):
            status, result = 503, receipt(run_id, "unknown", message="Request acceptance could not be confirmed; read this id before taking further action.")
        self.send_receipt(status, result)


class ExecutorServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, executor: Executor, token: str):
        if ipaddress.ip_address(address[0]).version == 6:
            self.address_family = socket.AF_INET6
        self.executor, self.token = executor, token
        super().__init__(address, Handler)

    def server_bind(self):
        # The protocol requires a literal private IP; reverse DNS is unnecessary
        # and must not delay startup or contact a separate resolver.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


def private_bind(value: str) -> str:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        raise argparse.ArgumentTypeError("bind must be an explicit RFC1918 or ULA IP address") from None
    if not any(address.version == network.version and address in network for network in PRIVATE_NETWORKS):
        raise argparse.ArgumentTypeError("bind must be RFC1918 or ULA; loopback, wildcard and public addresses are not accepted")
    return str(address)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", type=private_bind, required=True)
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--argv-file", type=Path, required=True)
    parser.add_argument("--working-directory", type=Path)
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--ready-file", type=Path)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535 or not 0.05 <= args.timeout <= 86400 or not 1 <= args.workers <= 8:
        parser.error("use port 0..65535, timeout 0.05..86400 seconds and workers 1..8")
    token = args.token_file.read_text().strip()
    if args.token_file.stat().st_mode & 0o077 or len(token) < 32 or any(not 33 <= ord(c) <= 126 for c in token):
        parser.error("token file must be owner-only and contain at least 32 non-whitespace ASCII characters")
    argv = json.loads(args.argv_file.read_text())
    if not isinstance(argv, list) or not argv or any(not isinstance(x, str) or not x or "\x00" in x for x in argv):
        parser.error("argv file must contain a nonempty JSON array of fixed nonempty strings")
    os.umask(0o077)
    store = ReceiptStore(args.data_dir / "receipts.sqlite3")
    executor = Executor(store, CommandConfig(tuple(argv), args.timeout, args.workers,
                                             str(args.working_directory.resolve()) if args.working_directory else None))
    try:
        server = ExecutorServer((args.bind, args.port), executor, token)
    except BaseException:
        executor.close()
        raise
    host = f"[{args.bind}]" if ":" in args.bind else args.bind
    ready = {"endpoint": f"http://{host}:{server.server_address[1]}", "pid": os.getpid()}
    if args.ready_file:
        temporary = args.ready_file.with_suffix(args.ready_file.suffix + ".tmp")
        temporary.write_text(json.dumps(ready) + "\n")
        temporary.replace(args.ready_file)
    print(json.dumps(ready), flush=True)
    def shutdown(_signum, _frame):
        if not executor.stopping.is_set():
            executor.stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        executor.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
