import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import urllib.error
import urllib.request
import urllib.parse

import executor as reference

HERE = Path(__file__).resolve().parent
CHILD = r'''
import json, os, pathlib, subprocess, sys, time
mode, counter = sys.argv[1:]
payload = json.load(sys.stdin)
counter = pathlib.Path(counter)
with counter.open("a") as stream:
    stream.write(json.dumps({"id": payload["id"], "pid": os.getpid(), "argv": sys.argv[1:], "item": payload["item"]}) + "\n")
if mode == "slow":
    time.sleep(1)
elif mode == "timeout":
    time.sleep(30)
elif mode == "escape":
    marker = str(counter) + ".escaped"
    code = "import pathlib,sys,time; time.sleep(.4); pathlib.Path(sys.argv[1]).write_text('done')"
    process = subprocess.Popen([sys.executable, "-c", code, marker], stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    pathlib.Path(str(counter) + ".escape-pid").write_text(str(process.pid))
    time.sleep(30)
elif mode == "flood":
    sys.stdout.buffer.write(("汉字🙂" * 100000).encode("utf-8"))
    sys.stderr.buffer.write(b"B" * 262144)
    sys.stdout.flush()
    sys.stderr.flush()
    sys.exit(0)
elif mode == "fail":
    print("expected command failure", file=sys.stderr)
    sys.exit(7)
print(json.dumps(payload, ensure_ascii=False))
'''


def wait_until(condition, timeout=5):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = condition()
        if value:
            return value
        time.sleep(0.025)
    raise AssertionError("controlled executor fixture did not reach the expected state")


class Fixture:
    def __init__(self, bind):
        self.temp = tempfile.TemporaryDirectory(prefix="home-reference-executor-")
        self.root = Path(self.temp.name)
        self.bind = bind
        self.token = secrets.token_urlsafe(32)
        (self.root / "token").write_text(self.token)
        (self.root / "token").chmod(0o600)
        (self.root / "task.py").write_text(CHILD)
        self.counter = self.root / "calls.jsonl"
        self.ready = self.root / "ready.json"
        self.log = self.root / "server.log"
        self.port = 0
        self.process = None
        self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def command(self, timeout=3, workers=2, port=None, ready=None):
        return [sys.executable, str(HERE / "executor.py"),
                "--bind", self.bind, "--port", str(self.port if port is None else port),
                "--data-dir", str(self.root / "data"), "--token-file", str(self.root / "token"),
                "--argv-file", str(self.root / "argv.json"), "--timeout", str(timeout),
                "--workers", str(workers), "--ready-file", str(ready or self.ready)]

    def start(self, mode="echo", timeout=3, workers=2):
        (self.root / "argv.json").write_text(json.dumps(
            [sys.executable, str(self.root / "task.py"), mode, str(self.counter)]))
        self.ready.unlink(missing_ok=True)
        with self.log.open("ab") as log:
            self.process = subprocess.Popen(self.command(timeout, workers), stdin=subprocess.DEVNULL,
                                            stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        def ready():
            if self.process.poll() is not None:
                raise AssertionError("reference executor failed to start: " + self.log.read_text())
            if self.ready.exists():
                return json.loads(self.ready.read_text())
        info = wait_until(ready)
        self.endpoint = info["endpoint"]
        self.port = int(urllib.parse.urlsplit(self.endpoint).port)

    def stop(self, crash=False):
        if self.process is not None and self.process.poll() is None:
            if crash:
                self.process.kill()
            else:
                self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)

    def calls(self):
        if not self.counter.exists():
            return []
        return [json.loads(line) for line in self.counter.read_text().splitlines()]

    def request(self, method, path, payload=None, token=None, key=None, raw=None):
        body = raw if raw is not None else json.dumps(payload).encode() if payload is not None else None
        headers = {"Authorization": "Bearer " + (self.token if token is None else token)}
        if body is not None:
            headers["Content-Type"] = "application/json"
            headers["Idempotency-Key"] = key if key is not None else payload.get("id", "") if payload else ""
        req = urllib.request.Request(self.endpoint + path, data=body, method=method, headers=headers)
        try:
            response = self.client.open(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status, value = response.status, json.load(response)
        if set(value) != {"id", "state", "result", "message"} or any(not isinstance(x, str) for x in value.values()):
            raise AssertionError("receipt shape differs from the four-string-field protocol")
        return status, value

    def terminal(self, run_id):
        def done():
            status, value = self.request("GET", "/runs/" + run_id)
            if status == 200 and value["state"] != "running":
                return value
        return wait_until(done)

    def cleanup(self):
        self.stop()
        pids = [row["pid"] for row in self.calls()]
        escaped = Path(str(self.counter) + ".escape-pid")
        if escaped.exists():
            pids.append(int(escaped.read_text()))
        for pid in pids:
            cmdline = Path(f"/proc/{pid}/cmdline")
            try:
                owned = str(self.root).encode() in cmdline.read_bytes()
                if owned:
                    os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except FileNotFoundError:
                pass
        if self.log.exists() and self.token in self.log.read_text():
            raise AssertionError("server log exposed the bearer token")
        self.temp.cleanup()


class PrivateBindTests(unittest.TestCase):
    def test_only_explicit_rfc1918_or_ula(self):
        for address in ("10.1.2.3", "172.16.0.8", "192.168.1.3", "fd12::4"):
            self.assertEqual(reference.private_bind(address), address)
        for address in ("127.0.0.1", "0.0.0.0", "::1", "::", "fe80::1", "8.8.8.8", "100.64.1.2", "localhost"):
            with self.assertRaises(argparse.ArgumentTypeError):
                reference.private_bind(address)


class ExecutorHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bind = os.environ.get("WORK_EXECUTOR_TEST_BIND")
        if not cls.bind:
            raise unittest.SkipTest("set WORK_EXECUTOR_TEST_BIND to a private IP assigned to this test host")
        reference.private_bind(cls.bind)

    def setUp(self):
        self.fixture = Fixture(self.bind)
        self.addCleanup(self.fixture.cleanup)

    def payload(self, title="fixture"):
        return {"id": secrets.token_hex(16), "item": {"id": secrets.token_hex(16), "title": title},
                "event": {"kind": "item.created"}}

    def test_private_binding_does_not_resolve_hostname(self):
        f = self.fixture
        store = reference.ReceiptStore(f.root / "bind-only.sqlite3")
        executor = reference.Executor(store, reference.CommandConfig((sys.executable, "-V")))
        try:
            with mock.patch("socket.getfqdn", side_effect=AssertionError("unexpected reverse DNS")):
                server = reference.ExecutorServer((self.bind, 0), executor, f.token)
            server.server_close()
        finally:
            executor.close()

    def test_auth_validation_and_unknown_id(self):
        f = self.fixture
        f.start()
        payload = self.payload()
        self.assertEqual(f.request("POST", "/runs", payload, token="invalid")[0], 401)
        self.assertEqual(f.request("GET", "/runs/" + payload["id"], token="invalid")[0], 401)
        self.assertEqual(f.request("GET", "/runs/" + payload["id"])[0], 404)
        self.assertEqual(f.request("POST", "/runs", payload, key="different")[0], 400)
        for invalid in [
            {"id": "../invalid", "item": {}},
            {"id": secrets.token_hex(16), "item": "text"},
            {"id": secrets.token_hex(16), "item": {}, "event": None},
            {"id": secrets.token_hex(16), "item": {}, "command": "ignored"},
        ]:
            self.assertEqual(f.request("POST", "/runs", invalid)[0], 400)
        raw = b'{"id":"' + payload["id"].encode() + b'","id":"' + payload["id"].encode() + b'","item":{}}'
        self.assertEqual(f.request("POST", "/runs", key=payload["id"], raw=raw)[0], 400)
        self.assertEqual(f.calls(), [])

    def test_fixed_argv_and_stdin_snapshot(self):
        f = self.fixture
        f.start()
        injected = f.root / "must-not-exist"
        payload = self.payload("; touch " + str(injected) + "; $(echo do-not-execute)")
        # A later edit of the argv file does not change this server's fixed command.
        (f.root / "argv.json").write_text(json.dumps(["/definitely/not/the/command"]))
        status, value = f.request("POST", "/runs", payload)
        self.assertEqual(status, 202)
        done = f.terminal(payload["id"])
        self.assertEqual(done["state"], "succeeded")
        self.assertEqual(json.loads(done["result"]), payload)
        self.assertEqual(len(f.calls()), 1)
        self.assertFalse(injected.exists())

    def test_concurrent_idempotency_canonical_json_and_conflict(self):
        f = self.fixture
        f.start("slow")
        payload = self.payload()
        with ThreadPoolExecutor(max_workers=8) as pool:
            responses = list(pool.map(lambda _: f.request("POST", "/runs", payload), range(8)))
        self.assertEqual(sum(status == 202 for status, _ in responses), 1)
        self.assertTrue(all(status in (200, 202) for status, _ in responses))
        self.assertEqual(f.request("POST", "/runs", dict(reversed(list(payload.items()))))[0], 200)
        conflict = {**payload, "item": {"title": "different"}}
        self.assertEqual(f.request("POST", "/runs", conflict)[0], 409)
        self.assertEqual(f.terminal(payload["id"])["state"], "succeeded")
        self.assertEqual(len(f.calls()), 1)

    def test_completed_receipt_survives_restart(self):
        f = self.fixture
        f.start()
        payload = self.payload()
        f.request("POST", "/runs", payload)
        before = f.terminal(payload["id"])
        f.stop()
        f.start()
        status, after = f.request("POST", "/runs", payload)
        self.assertEqual(status, 200)
        self.assertEqual(before, after)
        self.assertEqual(len(f.calls()), 1)

    def test_running_restart_becomes_unknown_without_second_execution(self):
        f = self.fixture
        f.start("slow")
        payload = self.payload()
        f.request("POST", "/runs", payload)
        wait_until(lambda: len(f.calls()) == 1)
        f.stop(crash=True)
        f.start("slow")
        status, value = f.request("POST", "/runs", payload)
        self.assertEqual(status, 200)
        self.assertEqual(value["state"], "unknown")
        self.assertEqual(f.request("GET", "/runs/" + payload["id"])[1]["state"], "unknown")
        time.sleep(1.1)
        self.assertEqual(len(f.calls()), 1)

    def test_timeout_is_unknown_and_does_not_claim_escaped_child_stopped(self):
        f = self.fixture
        f.start("escape", timeout=0.15)
        payload = self.payload()
        f.request("POST", "/runs", payload)
        done = f.terminal(payload["id"])
        self.assertEqual(done["state"], "unknown")
        self.assertIn("external effects were not verified", done["message"])
        wait_until(lambda: Path(str(f.counter) + ".escaped").exists())
        self.assertEqual(f.request("POST", "/runs", payload)[0], 200)
        self.assertEqual(len(f.calls()), 1)

    def test_output_is_drained_and_bounded(self):
        f = self.fixture
        f.start("flood")
        payload = self.payload()
        f.request("POST", "/runs", payload)
        done = f.terminal(payload["id"])
        self.assertEqual(done["state"], "succeeded")
        self.assertEqual(len(done["result"]), reference.RESULT_LIMIT)
        self.assertLessEqual(len(done["message"]), reference.MESSAGE_LIMIT)
        self.assertLess(len(json.dumps(done, ensure_ascii=False).encode()), 65536)
        self.assertIn("[output truncated]", done["result"])
        self.assertIn("[output truncated]", done["message"])

    def test_capacity_rejection_does_not_accept_new_id(self):
        f = self.fixture
        f.start("slow", workers=1)
        first, second = self.payload("first"), self.payload("second")
        self.assertEqual(f.request("POST", "/runs", first)[0], 202)
        self.assertEqual(f.request("POST", "/runs", first)[0], 200)
        self.assertEqual(f.request("POST", "/runs", second)[0], 429)
        self.assertEqual(f.request("GET", "/runs/" + second["id"])[0], 404)
        f.terminal(first["id"])
        self.assertEqual(f.request("POST", "/runs", second)[0], 202)
        f.terminal(second["id"])
        self.assertEqual(len(f.calls()), 2)

    def test_nonzero_exit_is_failed_with_durable_output(self):
        f = self.fixture
        f.start("fail")
        payload = self.payload()
        f.request("POST", "/runs", payload)
        done = f.terminal(payload["id"])
        self.assertEqual(done["state"], "failed")
        self.assertIn("code 7", done["message"])
        self.assertIn("expected command failure", done["message"])
        self.assertEqual(f.request("POST", "/runs", payload)[0], 200)
        self.assertEqual(len(f.calls()), 1)

    def test_second_process_cannot_reset_a_live_database(self):
        f = self.fixture
        f.start("slow")
        payload = self.payload()
        f.request("POST", "/runs", payload)
        other = subprocess.run(f.command(port=0, ready=f.root / "second-ready.json"),
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, timeout=3)
        self.assertNotEqual(other.returncode, 0)
        self.assertIn(b"another executor already owns", other.stdout)
        self.assertNotEqual(f.request("GET", "/runs/" + payload["id"])[1]["state"], "unknown")
        self.assertEqual(f.terminal(payload["id"])["state"], "succeeded")


if __name__ == "__main__":
    unittest.main()
