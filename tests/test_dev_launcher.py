"""Linux launcher regressions using owned processes and ephemeral loopback ports."""
from __future__ import annotations

import argparse
import contextlib
import errno
import io
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import dev


class DevelopmentLanguageTests(unittest.TestCase):
    def test_language_omission_environment_and_flag_precedence(self):
        for environment, flags, expected in (
            ({}, [], None),
            ({"LINGSHU_LANGUAGE": ""}, [], None),
            ({}, ["--language", ""], None),
            ({"LINGSHU_LANGUAGE": "en"}, ["--language="], None),
            ({}, ["--language", "en"], "en"),
            ({"LINGSHU_LANGUAGE": "en"}, [], "en"),
            ({"LINGSHU_LANGUAGE": "zh-CN"}, [], "zh-CN"),
            ({"LINGSHU_LANGUAGE": "en"}, ["--language", "zh-CN"], "zh-CN"),
            ({"LINGSHU_LANGUAGE": "invalid"}, ["--language=en"], "en"),
        ):
            with self.subTest(environment=environment, flags=flags), \
                    mock.patch.dict(os.environ, environment, clear=True), \
                    mock.patch.object(sys, "argv", ["dev.py", "start", *flags]), \
                    mock.patch.object(dev, "start") as launch:
                self.assertEqual(dev.main(), 0)
                launch.assert_called_once()
                args = launch.call_args.args[0]
                self.assertEqual(args.language, expected)
                environment = dev.app_environment(args)
                if expected is None:
                    self.assertNotIn("LINGSHU_LANGUAGE", environment)
                else:
                    self.assertEqual(environment["LINGSHU_LANGUAGE"], expected)

    def test_invalid_language_fails_before_starting_any_process(self):
        for environment, flags in (
            ({"LINGSHU_LANGUAGE": "fr"}, []),
            ({"LINGSHU_LANGUAGE": "zh"}, []),
            ({"LINGSHU_LANGUAGE": "en-US"}, []),
            ({"LINGSHU_LANGUAGE": "en"}, ["--language", "fr"]),
        ):
            with self.subTest(environment=environment, flags=flags), \
                    mock.patch.dict(os.environ, environment, clear=True), \
                    mock.patch.object(sys, "argv", ["dev.py", "start", *flags]), \
                    mock.patch.object(dev, "start") as launch, \
                    contextlib.redirect_stderr(io.StringIO()), \
                    self.assertRaises(SystemExit) as exit_status:
                dev.main()
            self.assertEqual(exit_status.exception.code, 2)
            launch.assert_not_called()


@unittest.skipUnless(shutil.which("openssl"), "requires OpenSSL to generate temporary TLS test certificates")
class DevelopmentTLSHealthTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="lingshu-tls-health-test-")
        self.addCleanup(folder.cleanup)
        self.cert, self.key = Path(folder.name) / "cert.pem", Path(folder.name) / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
                        "-nodes", "-days", "1", "-subj", "/CN=localhost",
                        "-addext", "subjectAltName=DNS:localhost", "-keyout", str(self.key),
                        "-out", str(self.cert)], check=True, capture_output=True)

        class HealthHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200 if self.path == "/health" else 404)
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), HealthHandler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(self.cert, self.key)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = str(self.server.server_port)
        self.environment = {"LINGSHU_TLS_CERT_FILE": str(self.cert), "LINGSHU_TLS_KEY_FILE": str(self.key)}

    def test_https_health_check_trusts_configured_ca_and_ignores_proxy_environment(self):
        with mock.patch.dict(os.environ, {"SSL_CERT_FILE": str(self.cert), "HTTPS_PROXY": "http://127.0.0.1:1",
                                          "https_proxy": "http://127.0.0.1:1", "NO_PROXY": "", "no_proxy": ""}):
            url, client = dev.health_connection("localhost", self.port, self.environment)
            self.assertEqual(url, "https://localhost:" + self.port)
            with client.open(url + "/health", timeout=3) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), b"ok")

    def test_untrusted_ca_and_wrong_hostname_are_rejected(self):
        for trusted, host in ((False, "localhost"), (True, "127.0.0.1")):
            with self.subTest(trusted=trusted, host=host), \
                    mock.patch.dict(os.environ, {"SSL_CERT_FILE": str(self.cert) if trusted else str(self.cert.parent / "missing-ca.pem")}):
                url, client = dev.health_connection(host, self.port, self.environment)
                with self.assertRaises(urllib.error.URLError) as refused:
                    client.open(url + "/health", timeout=3)
                self.assertIsInstance(refused.exception.reason, ssl.SSLCertVerificationError)

    def test_incomplete_tls_is_rejected_and_http_mode_is_preserved(self):
        with self.assertRaisesRegex(ValueError, "configured together"):
            dev.health_connection("localhost", self.port, {"LINGSHU_TLS_CERT_FILE": str(self.cert)})
        url, _ = dev.health_connection("0.0.0.0", self.port, {})
        self.assertEqual(url, "http://127.0.0.1:" + self.port)


@unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux TCP reuse semantics")
class DevelopmentPortProbeTests(unittest.TestCase):
    def start_without_build(self, address: tuple[str, int]) -> None:
        with tempfile.TemporaryDirectory(prefix="lingshu-port-probe-test-") as folder:
            root = Path(folder)
            runtime = root / ".runtime"
            args = argparse.Namespace(listen=f"{address[0]}:{address[1]}",
                                      data_dir=str(root / "data"), provider="sqlite")
            with mock.patch.multiple(dev, ROOT=root, RUNTIME=runtime,
                                     STATE=runtime / "service.json", LOG=runtime / "service.log",
                                     BINARY=root / "missing-binary"), \
                    mock.patch.object(dev, "load_state", return_value=None), \
                    mock.patch.object(dev.subprocess, "Popen") as launch:
                try:
                    dev.start(args)
                finally:
                    launch.assert_not_called()

    def test_recently_closed_listener_passes_probe_despite_time_wait(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.settimeout(3)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            address = listener.getsockname()
            with socket.create_connection(address, timeout=3) as client:
                connection, _ = listener.accept()
                # The server closes first; receiving EOF before client close
                # leaves the accepted server endpoint in TCP TIME_WAIT.
                connection.close()
                self.assertEqual(client.recv(1), b"")

        # Prove this fixture exercises the old failure rather than a free port.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as old_probe:
            with self.assertRaises(OSError) as refused:
                old_probe.bind(address)
        self.assertEqual(refused.exception.errno, errno.EADDRINUSE)
        with self.assertRaisesRegex(ValueError, "Build the application first"):
            self.start_without_build(address)

    def test_active_listener_still_refuses_start(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            with self.assertRaises(OSError) as refused:
                self.start_without_build(listener.getsockname())
            self.assertEqual(refused.exception.errno, errno.EADDRINUSE)


@unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("sleep"),
                     "requires Linux /proc and a local sleep executable")
class DevelopmentLauncherTests(unittest.TestCase):
    def wait_for_owned_executable(self, process: subprocess.Popen, binary: Path) -> dict:
        deadline = time.monotonic() + 3
        last_error = None
        while time.monotonic() < deadline:
            self.assertIsNone(process.poll(), "owned fixture exited before its executable became observable")
            identity = dev.process_identity(process.pid)
            if identity and identity["exe"] == str(binary):
                return identity
            try:
                executable = Path(f"/proc/{process.pid}/exe")
                os.readlink(executable)
                executable.stat()
                last_error = None
            except OSError as exc:
                last_error = exc
            time.sleep(0.02)
        if isinstance(last_error, PermissionError):
            self.fail("execution environment denies /proc/PID/exe access for this test's own child; "
                      "run this Linux regression where own-process inspection is permitted")
        self.fail("owned executable identity was not observable within the bounded startup wait")

    def test_tls_verification_failure_stops_only_new_child_and_removes_its_state(self):
        with tempfile.TemporaryDirectory(prefix="lingshu-failed-start-test-") as folder:
            root = Path(folder)
            runtime = root / ".runtime"
            binary = root / "sleep"
            shutil.copy2(shutil.which("sleep"), binary)
            (root / "web/dist").mkdir(parents=True)
            (root / "web/dist/index.html").write_text("test")
            with socket.socket() as port_probe:
                port_probe.bind(("127.0.0.1", 0))
                port = port_probe.getsockname()[1]
            args = argparse.Namespace(listen=f"127.0.0.1:{port}", data_dir=str(root / "data"),
                                      provider="sqlite", language=None)
            original_popen = subprocess.Popen
            children = []

            def launch_owned_child(command, **kwargs):
                self.assertEqual(command, [str(binary)])
                child = original_popen([str(binary), "30"], **kwargs)
                children.append(child)
                return child

            health = mock.Mock()
            health.open.side_effect = urllib.error.URLError(ssl.SSLCertVerificationError(1, "hostname mismatch"))
            other = original_popen([shutil.which("sleep"), "30"])
            try:
                with mock.patch.multiple(dev, ROOT=root, RUNTIME=runtime, STATE=runtime / "service.json",
                                         LOG=runtime / "service.log", BINARY=binary), \
                        mock.patch.object(dev, "health_connection", return_value=(f"https://127.0.0.1:{port}", health)), \
                        mock.patch.object(dev.subprocess, "Popen", side_effect=launch_owned_child), \
                        self.assertRaisesRegex(ValueError, "certificate verification failed.*hostname mismatch"):
                    dev.start(args)
                self.assertEqual(len(children), 1)
                self.assertEqual(children[0].returncode, -15)
                self.assertFalse((runtime / "service.json").exists())
                self.assertIsNone(other.poll(), "startup cleanup must not stop unrelated processes")
            finally:
                for child in [*children, other]:
                    if child.poll() is None:
                        child.terminate()
                    child.wait(timeout=5)

    def test_replaced_executable_keeps_owned_identity_and_can_be_stopped(self):
        with tempfile.TemporaryDirectory(prefix="lingshu-launcher-test-") as folder:
            root = Path(folder)
            # Multicall coreutils (including Ubuntu's uutils) dispatch by argv[0].
            binary = root / "sleep"
            replacement = root / "replacement"
            state = root / "service.json"
            shutil.copy2(shutil.which("sleep"), binary)
            process = subprocess.Popen([str(binary), "30"])
            try:
                identity = self.wait_for_owned_executable(process, binary)
                self.assertEqual(identity["exe"], str(binary))
                record = {**identity, "url": "http://127.0.0.1:1", "dataDir": str(root / "data"), "provider": "sqlite"}
                state.write_text(json.dumps(record))
                state.chmod(0o600)
                with mock.patch.object(dev, "STATE", state):
                    self.assertEqual(dev.load_state(), record)
                    shutil.copy2(shutil.which("sleep"), replacement)
                    replacement.replace(binary)
                    self.assertTrue(os.readlink(f"/proc/{process.pid}/exe").endswith(" (deleted)"))
                    self.assertNotEqual(binary.stat().st_ino, identity["exeInode"])
                    self.assertEqual(dev.process_identity(process.pid), identity)
                    self.assertEqual(dev.load_state(), record)

                    for changes in ({"startTicks": str(int(identity["startTicks"]) + 1)},
                                    {"exeInode": identity["exeInode"] + 1},
                                    {"exeDevice": identity["exeDevice"] + 1},
                                    {"exe": str(root / "different-program")}):
                        with self.subTest(changes=changes):
                            state.write_text(json.dumps({**record, **changes}))
                            self.assertIsNone(dev.load_state())
                            with contextlib.redirect_stdout(io.StringIO()):
                                dev.stop()
                            self.assertIsNone(process.poll(), "mismatched identity must never be signalled")

                    legacy = {key: value for key, value in record.items() if key not in ("exeDevice", "exeInode")}
                    state.write_text(json.dumps(legacy))
                    self.assertEqual(dev.load_state(), legacy)
                    state.write_text(json.dumps(record))
                    with contextlib.redirect_stdout(io.StringIO()):
                        dev.stop()
                    self.assertEqual(process.wait(timeout=5), -15)
                    self.assertFalse(state.exists())
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
