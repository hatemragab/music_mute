"""Temporary filesystem and child-process fixtures for the update replacement gate."""
import fcntl
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/update-lock.py"
API = runpy.run_path(str(SCRIPT))

class UpdateLockTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="musicmute-update-fixture-")
        self.root = Path(self.temporary.name).resolve() / "private"
        self.root.mkdir(mode=0o700)
        self.descriptors = []
    def tearDown(self):
        for descriptor in self.descriptors:
            os.close(descriptor)
        self.temporary.cleanup()
    def acquire(self, exclusive=False):
        descriptor = API["acquire"](self.root, exclusive)
        self.descriptors.append(descriptor)
        return descriptor
    def test_multiple_helpers_are_shared_and_exclusive_update_waits(self):
        self.acquire()
        self.acquire()
        with self.assertRaises(BlockingIOError):
            self.acquire(True)
    def test_exclusive_update_fences_new_helpers(self):
        self.acquire(True)
        with self.assertRaises(BlockingIOError):
            self.acquire()
        result = subprocess.run([sys.executable, "-I", "-B", "-S", str(SCRIPT), "--run", sys.executable, "-c", "print('SHOULD_NOT_RUN')"], env={"MUSICMUTE_LOCAL_ROOT": str(self.root)}, capture_output=True, timeout=3)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (75, b"", b""))
    def test_private_mode_and_symlink_collision_are_rejected(self):
        foreign = self.root.parent / "foreign"
        foreign.write_text("unchanged")
        (self.root / "update.lock").symlink_to(foreign)
        with self.assertRaises((ValueError, OSError)):
            self.acquire()
        self.assertEqual(foreign.read_text(), "unchanged")
        (self.root / "update.lock").unlink()
        self.root.chmod(0o755)
        with self.assertRaises(ValueError):
            self.acquire()
    def test_exec_wrapper_retains_lease_through_process_lifetime(self):
        process = subprocess.Popen([sys.executable, "-I", "-B", "-S", str(SCRIPT), "--run", sys.executable, "-I", "-B", "-c", "import sys;print('READY',flush=True);sys.stdin.read()"], env={"MUSICMUTE_LOCAL_ROOT": str(self.root)}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertEqual(process.stdout.readline(), b"READY\n")
            with self.assertRaises(BlockingIOError):
                self.acquire(True)
            process.communicate(timeout=3)
            self.assertEqual(process.returncode, 0)
            self.acquire(True)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
    def test_guardian_releases_after_verified_parent_exit_and_replacement(self):
        info = self.root.stat()
        with patch.object(sys, "argv", [str(SCRIPT), "--guard", "12345", str(self.root), str(info.st_dev), str(info.st_ino + 1)]), patch("os.kill", side_effect=ProcessLookupError), patch("builtins.print"), patch("os.close"):
            self.assertEqual(API["main"](), 0)
    def test_guardian_acknowledges_before_install_and_keeps_inherited_exclusive_lease(self):
        descriptor = self.acquire(True)
        info = self.root.stat()
        process = subprocess.Popen([sys.executable, "-I", "-B", "-S", str(SCRIPT), "--guard", str(os.getpid()), str(self.root), str(info.st_dev), str(info.st_ino)], stdin=descriptor, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertEqual(process.stdout.readline(), b"READY\n")
            os.close(descriptor)
            self.descriptors.remove(descriptor)
            with self.assertRaises(BlockingIOError):
                self.acquire()
        finally:
            process.terminate()
            output, errors = process.communicate(timeout=3)
            self.assertEqual((output, errors), (b"", b""))
        self.acquire()
    def test_guardian_waits_for_live_installer_then_recovers_failed_update(self):
        info = self.root.stat()
        listings = [subprocess.CompletedProcess([], 0, "/temporary/Updater\n"), subprocess.CompletedProcess([], 0, "/usr/bin/fixture\n"), subprocess.CompletedProcess([], 0, ""), subprocess.CompletedProcess([], 0, "")]
        with patch.object(sys, "argv", [str(SCRIPT), "--guard", "12345", str(self.root), str(info.st_dev), str(info.st_ino)]), patch("os.kill", side_effect=ProcessLookupError), patch("subprocess.run", side_effect=listings) as observe, patch("time.monotonic", side_effect=[0, 1, 3]), patch("time.sleep"), patch("builtins.print"), patch("os.close"):
            self.assertEqual(API["main"](), 0)
            self.assertEqual(observe.call_count, 4)
    def test_guardian_does_not_release_during_installer_startup_gap(self):
        info = self.root.stat()
        listings = [subprocess.CompletedProcess([], 0, value) for value in ["", "/temporary/Autoupdate\n", "", "", ""]]
        with patch.object(sys, "argv", [str(SCRIPT), "--guard", "12345", str(self.root), str(info.st_dev), str(info.st_ino)]), patch("os.kill", side_effect=ProcessLookupError), patch("subprocess.run", side_effect=listings) as observe, patch("time.monotonic", side_effect=[0, 0.1, 0.2, 3]), patch("time.sleep"), patch("builtins.print"), patch("os.close"):
            self.assertEqual(API["main"](), 0)
            self.assertEqual(observe.call_count, 5)

if __name__ == "__main__":
    unittest.main()
