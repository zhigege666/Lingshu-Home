"""Linux launcher regressions using owned processes and ephemeral loopback ports."""
from __future__ import annotations

import argparse
import contextlib
import errno
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import dev


class DevelopmentLanguageTests(unittest.TestCase):
    def test_language_defaults_environment_and_flag_precedence(self):
        for environment, flags, expected in (
            ({}, [], "zh-CN"),
            ({"LINGSHU_LANGUAGE": ""}, [], "zh-CN"),
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
                self.assertEqual(dev.app_environment(args)["LINGSHU_LANGUAGE"], expected)

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
