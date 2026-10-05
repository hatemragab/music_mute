"""Private subprocess fixtures; no worker, browser, model or user state is used."""

import json
import os
from pathlib import Path
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "native-lock.py"


class NativeLockTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="musicmute-native-lock-")
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / "private root"
        self.root.mkdir(mode=0o700)
        self.helper = self.base / "fixture_helper.py"
        self.helper.write_text(
            "import os,signal,sys,time\n"
            "mode=sys.argv[1]\n"
            "if mode=='exit': sys.exit(0)\n"
            "if mode=='import':\n"
            " sys.path.insert(0,os.path.dirname(__file__));import fixture_import_target;print(fixture_import_target.VALUE);sys.exit(0)\n"
            "if mode=='echo':\n"
            " data=sys.stdin.buffer.read(int(sys.argv[2]));sys.stdout.buffer.write(data);sys.stdout.buffer.flush();sys.stdin.buffer.read();sys.exit(0)\n"
            "if mode=='stubborn': signal.signal(signal.SIGTERM,signal.SIG_IGN)\n"
            "print('READY '+str(os.getpid()),flush=True)\n"
            "while True: time.sleep(0.1)\n",
            encoding="utf8",
        )
        self.processes = []

    def tearDown(self):
        for process in reversed(self.processes):
            self.stop(process)
        self.temporary.cleanup()

    def environment(self, root=None):
        environment = {key: os.environ[key] for key in ("HOME", "PATH", "LANG", "TMPDIR") if key in os.environ}
        environment["MUSICMUTE_LOCAL_ROOT"] = str(root or self.root)
        return environment

    def launch(self, mode="exit", *, root=None, extra=()):
        process = subprocess.Popen(
            [sys.executable, "-I", "-B", str(SCRIPT), sys.executable, "-I", "-B", str(self.helper), mode, *extra],
            env=self.environment(root), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.processes.append(process)
        return process

    @staticmethod
    def stop(process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream:
                stream.close()

    def assert_error(self, process, code):
        output, errors = process.communicate(timeout=4)
        self.assertEqual(errors, b"", "Native lock errors must not leak traceback/path data")
        self.assertEqual(process.returncode, 1)
        self.assertGreaterEqual(len(output), 4)
        length = struct.unpack("<I", output[:4])[0]
        self.assertEqual(len(output), length + 4)
        self.assertLess(length, 1024)
        self.assertEqual(json.loads(output[4:]), {
            "protocol_version": 1, "request_id": "00000000-0000-4000-8000-000000000000",
            "type": "ERROR", "payload": {"error_code": code},
        })

    def test_healthy_lock_retains_busy_frame_and_releases_after_exit(self):
        first = self.launch("hold")
        self.assertEqual(first.stdout.readline(), f"READY {first.pid}\n".encode())
        self.assert_error(self.launch(), "LOCAL_COMPANION_BUSY")
        self.assertEqual(stat.S_IMODE((self.root / "host.lock").stat().st_mode), 0o600)
        self.stop(first)
        next_host = self.launch()
        self.assertEqual(next_host.communicate(timeout=4), (b"", b""))
        self.assertEqual(next_host.returncode, 0)

    def test_native_launch_imports_leave_no_fixture_bytecode(self):
        (self.base / "fixture_import_target.py").write_text("VALUE = 7\n", encoding="utf8")
        host = self.launch("import")
        self.assertEqual(host.communicate(timeout=4), (b"7\n", b""))
        self.assertEqual(host.returncode, 0)
        self.assertEqual(list(self.base.rglob("__pycache__")), [])
        self.assertEqual(list(self.base.rglob("*.pyc")), [])

    def test_symlink_lock_is_rejected_without_modifying_target(self):
        target = self.base / "unrelated fixture"
        target.write_text("fixture original", encoding="utf8")
        target.chmod(0o600)
        (self.root / "host.lock").symlink_to(target)
        self.assert_error(self.launch(), "LOCAL_COMPANION_LOCK_UNSAFE")
        self.assertEqual(target.read_text(encoding="utf8"), "fixture original")

    def test_hardlink_lock_is_rejected_without_modifying_target(self):
        target = self.base / "unrelated fixture"
        target.write_text("fixture original", encoding="utf8")
        target.chmod(0o600)
        os.link(target, self.root / "host.lock")
        self.assert_error(self.launch(), "LOCAL_COMPANION_LOCK_UNSAFE")
        self.assertEqual(target.read_text(encoding="utf8"), "fixture original")

    def test_nonregular_lock_is_rejected_without_blocking_or_replacing_it(self):
        lock = self.root / "host.lock"
        os.mkfifo(lock, mode=0o600)
        self.assert_error(self.launch(), "LOCAL_COMPANION_LOCK_UNSAFE")
        self.assertTrue(stat.S_ISFIFO(lock.stat().st_mode))

    def test_missing_nested_private_root_is_created_with_private_lock(self):
        root = self.base / "new parent" / "new root"
        host = self.launch(root=root)
        self.assertEqual(host.communicate(timeout=4), (b"", b""))
        self.assertEqual(host.returncode, 0)
        for directory in (root.parent, root):
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
            self.assertEqual(directory.stat().st_uid, os.getuid())
        self.assertEqual(stat.S_IMODE((root / "host.lock").stat().st_mode), 0o600)

    def test_nonprivate_lock_and_root_are_rejected_without_chmod(self):
        lock = self.root / "host.lock"
        lock.touch(mode=0o600)
        lock.chmod(0o644)
        self.assert_error(self.launch(), "LOCAL_COMPANION_LOCK_UNSAFE")
        self.assertEqual(stat.S_IMODE(lock.stat().st_mode), 0o644)
        lock.unlink()
        self.root.chmod(0o755)
        self.assert_error(self.launch(), "LOCAL_COMPANION_LOCK_UNSAFE")
        self.assertFalse(lock.exists())
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o755)

    def test_symlink_root_and_ancestor_are_rejected_before_creating_paths(self):
        linked = self.base / "linked-root"
        linked.symlink_to(self.root, target_is_directory=True)
        self.assert_error(self.launch(root=linked), "LOCAL_COMPANION_LOCK_UNSAFE")
        self.assertFalse((self.root / "host.lock").exists())
        self.assert_error(self.launch(root=linked / "unexpected"), "LOCAL_COMPANION_LOCK_UNSAFE")
        self.assertFalse((self.root / "unexpected").exists())

    def test_relative_root_and_exec_failure_have_only_safe_frames(self):
        self.assert_error(self.launch(root=Path("relative-root")), "LOCAL_COMPANION_LOCK_UNSAFE")
        self.assert_error(self.launch(root=self.root / ".." / "escaped-root"), "LOCAL_COMPANION_LOCK_UNSAFE")
        self.assertFalse((self.base / "escaped-root").exists())
        process = subprocess.Popen(
            [sys.executable, "-I", "-B", str(SCRIPT), str(self.base / "missing-private-executable")],
            env=self.environment(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.processes.append(process)
        self.assert_error(process, "LOCAL_COMPANION_START_FAILED")

    def test_guardian_never_consumes_native_bytes(self):
        message = json.dumps({"synthetic": True}).encode()
        frame = struct.pack("<I", len(message)) + message
        process = self.launch("echo", extra=(str(len(frame)),))
        process.stdin.write(frame)
        process.stdin.flush()
        self.assertEqual(process.stdout.read(len(frame)), frame)
        process.stdin.close()
        process.wait(timeout=4)
        self.assertEqual(process.returncode, 0)
        self.assertEqual(process.stderr.read(), b"")

    def test_guardian_exits_after_owned_host_finishes(self):
        host = self.launch("hold")
        self.assertEqual(host.stdout.readline(), f"READY {host.pid}\n".encode())
        children = subprocess.run(
            ["/usr/bin/pgrep", "-P", str(host.pid)], capture_output=True, check=True,
        )
        guardian = int(children.stdout.strip())
        self.stop(host)
        until = time.monotonic() + 3
        while time.monotonic() < until:
            try:
                os.kill(guardian, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)
        self.fail("Lifetime observer outlived its owned native host")

    def assert_released(self, deadline=5):
        until = time.monotonic() + deadline
        while time.monotonic() < until:
            next_host = self.launch()
            output, errors = next_host.communicate(timeout=4)
            if next_host.returncode == 0:
                self.assertEqual((output, errors), (b"", b""))
                return
            time.sleep(0.1)
        self.fail("Native lifetime ended but owned lock was still held")

    def test_stalled_host_is_stopped_after_stdin_closes(self):
        host = self.launch("stubborn")
        self.assertEqual(host.stdout.readline(), f"READY {host.pid}\n".encode())
        host.stdin.close()
        self.assert_released()
        host.wait(timeout=2)

    def test_parent_death_releases_lock_even_if_host_ignores_shutdown(self):
        broker = self.base / "fixture_parent.py"
        broker.write_text(
            "import subprocess,sys,time\n"
            "child=subprocess.Popen(sys.argv[2:],stdin=int(sys.argv[1]),stdout=subprocess.PIPE,stderr=subprocess.PIPE)\n"
            "line=child.stdout.readline()\n"
            "print(child.pid,flush=True)\n"
            "while True: time.sleep(0.1)\n",
            encoding="utf8",
        )
        # Keep the write end alive in the test: this exercises parent lifetime
        # independently of EOF, rather than accidentally relying on pipe closure.
        read_descriptor, write_descriptor = os.pipe()
        parent = subprocess.Popen(
            [sys.executable, "-I", "-B", str(broker), str(read_descriptor), sys.executable, "-I", "-B", str(SCRIPT), sys.executable, "-I", "-B", str(self.helper), "stubborn"],
            env=self.environment(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            pass_fds=(read_descriptor,),
        )
        os.close(read_descriptor)
        self.processes.append(parent)
        pid = int(parent.stdout.readline().strip())
        released = False
        try:
            parent.kill()
            parent.wait(timeout=2)
            self.assert_released()
            released = True
        finally:
            os.close(write_descriptor)
            if not released:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    unittest.main()
