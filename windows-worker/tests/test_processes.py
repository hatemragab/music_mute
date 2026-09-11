import importlib
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cwd = Path(self.temp.name)
        try:
            self.module = importlib.import_module("musicmute_worker.processes")
        except ModuleNotFoundError:
            self.fail("process containment module is not implemented")
        try:
            from process_test_support import ProcessTestIsolation
        except ModuleNotFoundError:
            self.fail("process tests do not yet isolate Windows OS objects")
        self.isolation = self.enterContext(ProcessTestIsolation())

    def run_code(self, code, **kwargs):
        with self.module.ProcessRunner() as runner:
            return runner.run(
                [sys.executable, "-c", code],
                cwd=self.cwd,
                timeout=kwargs.pop("timeout", 5),
                check=kwargs.pop("check", lambda: None),
                **kwargs,
            )

    def test_capture_both_streams_and_cwd(self):
        result = self.run_code(
            "import os,sys; print(os.getcwd()); print('error', file=sys.stderr)",
            capture=True,
        )
        self.assertEqual(result.stdout.strip(), str(self.cwd.resolve()))
        self.assertEqual(result.stderr, "error\n")
        self.assertEqual(result.returncode, 0)

    def test_capture_normalizes_windows_and_bare_carriage_returns(self):
        result = self.run_code(
            "import os; os.write(1, b'a\\r\\nb\\rc\\n')",
            capture=True,
        )
        self.assertEqual(result.stdout, "a\nb\nc\n")

    def test_test_namespace_does_not_target_production_objects(self):
        self.assertNotEqual(self.module._JOB_NAME, self.isolation.production_job)
        self.assertNotEqual(self.module._MUTEX_NAME, self.isolation.production_mutex)
        child = self.isolation.child_setup + (
            "print(processes._JOB_NAME); print(processes._MUTEX_NAME)"
        )
        result = subprocess.run(
            [sys.executable, "-c", child],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(
            result.stdout.splitlines(),
            [
                self.module._JOB_NAME,
                self.module._MUTEX_NAME,
            ],
        )

    def test_nonzero_raises_with_capture(self):
        with self.assertRaises(subprocess.CalledProcessError) as error:
            self.run_code("import sys; print('failed'); sys.exit(7)", capture=True)
        self.assertEqual(error.exception.returncode, 7)
        self.assertEqual(error.exception.output, "failed\n")

    def test_capture_rejects_large_output_without_pipe_deadlock(self):
        with self.assertRaises(ValueError):
            self.run_code("import sys; sys.stdout.write('x' * 2000000)", capture=True)

    def test_timeout_stops_process(self):
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_code("import time; time.sleep(20)", timeout=0.3)
        self.assertLess(time.monotonic() - started, 3)

    def test_discard_output(self):
        result = self.run_code(
            "import sys; print('stdout'); print('stderr', file=sys.stderr)"
        )
        self.assertIsNone(result.stdout)
        self.assertIsNone(result.stderr)

    def test_recover_is_idempotent_without_previous_process(self):
        with (
            self.module.SingleInstance(self.cwd),
            self.module.ProcessRunner() as runner,
        ):
            runner.recover()
            runner.recover()

    def test_cancel_terminates_descendant(self):
        self._check_descendant(cancel=True)

    def test_normal_parent_exit_terminates_descendant(self):
        self._check_descendant(cancel=False)

    def _check_descendant(self, cancel):
        marker = self.cwd / "descendant-finished"
        ready = self.cwd / "descendant-ready"
        child = (
            f"import time; from pathlib import Path; Path({str(ready)!r}).write_text('ready'); "
            f"time.sleep(0.7); Path({str(marker)!r}).write_text('escaped')"
        )
        parent = (
            "import subprocess,sys,time; from pathlib import Path; "
            f"subprocess.Popen([sys.executable, '-c', {child!r}]); "
            f"ready=Path({str(ready)!r}); "
            "exec('while not ready.exists(): time.sleep(0.01)'); "
            + ("time.sleep(20)" if cancel else "")
        )

        class Cancelled(Exception):
            pass

        def check():
            if ready.exists():
                raise Cancelled()

        if cancel:
            with self.assertRaises(Cancelled):
                self.run_code(parent, check=check)
        else:
            self.run_code(parent)
        self.assertTrue(ready.exists())
        time.sleep(0.9)
        self.assertFalse(marker.exists(), "descendant survived runner cleanup")

    def test_check_prevents_spawn(self):
        marker = self.cwd / "started"

        def check():
            raise RuntimeError("lease lost")

        with self.assertRaisesRegex(RuntimeError, "lease lost"):
            self.run_code(
                f"from pathlib import Path; Path({str(marker)!r}).touch()", check=check
            )
        self.assertFalse(marker.exists())

    def test_single_instance_rejects_duplicate_and_releases(self):
        with (
            self.module.SingleInstance(self.cwd),
            self.assertRaises(RuntimeError),
            self.module.SingleInstance(self.cwd),
        ):
            self.fail("duplicate lock acquired")
        with self.module.SingleInstance(self.cwd):
            pass

    @unittest.skipUnless(os.name == "nt", "Windows machine-wide mutex")
    def test_windows_lock_spans_different_state_folders(self):
        with (
            self.module.SingleInstance(self.cwd),
            self.assertRaises(RuntimeError),
            self.module.SingleInstance(self.cwd / "other-folder"),
        ):
            self.fail("duplicate worker acquired machine-wide lock")

    @unittest.skipUnless(os.name == "nt", "Windows Job Object crash containment")
    def test_worker_crash_kills_children(self):
        marker = self.cwd / "escaped"
        ready = self.cwd / "ready"
        child = f"import time; from pathlib import Path; Path({str(ready)!r}).touch(); time.sleep(1); Path({str(marker)!r}).touch()"
        worker = self.isolation.child_setup + (
            "import os,sys; from pathlib import Path; from musicmute_worker.processes import ProcessRunner; "
            f"ready=Path({str(ready)!r}); "
            f"ProcessRunner().run([sys.executable,'-c',{child!r}], cwd=Path({str(self.cwd)!r}), timeout=10, "
            "check=lambda: os._exit(9) if ready.exists() else None)"
        )
        result = subprocess.run([sys.executable, "-c", worker], timeout=5, check=False)
        self.assertEqual(result.returncode, 9)
        with self.module.SingleInstance(self.cwd):
            self.module.ProcessRunner().recover()
        time.sleep(1.2)
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
