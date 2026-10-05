"""Actual no-network flock propagation through the tool guardian and descendants."""
import fcntl
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


class UpdateLeaseTests(unittest.TestCase):
    def start(self, root, code, extra=None):
        environment = {
            "HOME": str(root), "PATH": "/usr/bin:/bin", "MUSICMUTE_LOCAL_ROOT": str(root),
            "MUSICMUTE_LOCAL_APP_RESOURCES": str(ROOT), "MUSICMUTE_LOCAL_PARENT_PID": str(os.getpid()),
        }
        if extra:
            environment.update(extra)
        return subprocess.Popen([
            sys.executable, "-I", "-B", "-S", str(ROOT / "scripts/update-lock.py"), "--run",
            sys.executable, "-I", "-B", "-S", str(ROOT / "engine/local_pipeline.py"),
            "--tool", sys.executable, "--", "-I", "-B", "-S", "-c", code,
        ], env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)

    def test_orphan_tool_holds_update_lease_until_it_exits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            root.chmod(0o700)
            child = self.start(root, "import os,time; fd=int(os.environ['MUSICMUTE_UPDATE_LEASE_FD']); os.fstat(fd); print(os.getpid(),flush=True); time.sleep(60)")
            try:
                descendant = int(child.stdout.readline())
                with open(root / "update.lock", "r+") as lock:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    child.kill()
                    child.wait(timeout=5)
                    os.kill(descendant, 0)
                    # The direct tool owns the same inode even after its guardian dies.
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    os.kill(descendant, signal.SIGKILL)
                    deadline = time.monotonic() + 5
                    while True:
                        try:
                            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            break
                        except BlockingIOError:
                            if time.monotonic() >= deadline:
                                self.fail("lease was not released after owned tool termination")
                            time.sleep(0.02)
            finally:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                child.wait(timeout=5)
                child.stdout.close()
                child.stderr.close()

    def test_closed_or_foreign_descriptor_is_rejected_before_tool(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            root.chmod(0o700)
            result = subprocess.run([
                sys.executable, "-I", "-B", "-S", str(ROOT / "engine/local_pipeline.py"),
                "--tool", sys.executable, "--", "-c", "print('should-not-run')",
            ], env={"MUSICMUTE_LOCAL_APP_RESOURCES": str(ROOT), "MUSICMUTE_LOCAL_ROOT": str(root), "MUSICMUTE_UPDATE_LEASE_FD": "50000"}, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 76)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(result.stderr, b"LOCAL_UPDATE_LEASE_INVALID\n")


if __name__ == "__main__":
    unittest.main()
