import importlib
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from process_test_support import ProcessTestIsolation

FAKE = r"""
import argparse, json, os, subprocess, sys, time
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--serve',type=Path)
p.add_argument('--session-id')
a=p.parse_args()
d=a.serve

def write(name, value):
    temp=d/(name+'.tmp')
    temp.write_text(json.dumps(value))
    temp.replace(d/name)
write('ready.json', {'version':1,'session':a.session_id,'status':'ready','timings':{'model_load':0.01}})
while True:
    request=d/'request.json'
    if not request.exists():
        time.sleep(.01)
        continue
    deadline=time.monotonic()+2
    while True:
        try:
            data=json.loads(request.read_text())
            break
        except PermissionError:
            if os.name!='nt' or time.monotonic()>=deadline: raise
            time.sleep(.02)
    request.unlink()
    source=Path(data['input'])
    mode=source.read_text()
    if mode in ('timeout','cancel','crash'):
        marker=source.parent/'escaped'
        ready=source.parent/'child-ready'
        code="from pathlib import Path; import time; Path(%r).touch(); time.sleep(.8); Path(%r).touch()" % (str(ready),str(marker))
        subprocess.Popen([sys.executable,'-c',code])
        while not ready.exists(): time.sleep(.01)
        if mode=='crash': sys.exit(8)
        time.sleep(30)
    if mode=='oversize':
        (d/'response.json').write_text('x'*20000)
        continue
    bad_timings = {} if mode=='missing-timings' else {'separation':10**1000,'trim':.01,'encode':.01} if mode=='huge-timing' else {'separation':float('nan'),'trim':.01,'encode':.01} if mode=='nan-timing' else {'separation':.02,'trim':.01,'encode':.01}
    write('response.json', {'version':1,'id': 'bad-id' if mode=='mismatch' else data['id'],
        'status':'error' if mode=='error' else 'ok', 'error':'SEPARATION_FAILED',
        'timings':bad_timings})
"""


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.isolation = self.enterContext(ProcessTestIsolation())
        self.fake = self.directory / "fake.py"
        self.fake.write_text(FAKE)
        try:
            self.module = importlib.import_module("musicmute_worker.engine")
        except ImportError:
            self.fail("persistent engine not implemented")
        self.engine = self.module.SeparatorEngine(self.fake, self.directory)
        self.addCleanup(self.engine.close)
        self.source = self.directory / "prepared.wav"

    def run_engine(self, mode="ok", **kwargs):
        self.source.write_text(mode)
        return self.engine.run(
            self.source,
            self.directory / "output",
            timeout=kwargs.pop("timeout", 5),
            check=kwargs.pop("check", lambda: None),
        )

    def test_same_child_reused_and_transient_cleanup_does_not_stop_engine(self):
        from musicmute_worker.processes import ProcessRunner

        first = self.run_engine()
        self.assertGreater(first["model_load"], 0)
        with ProcessRunner() as runner:
            runner.run(
                [sys.executable, "-c", "pass"],
                cwd=self.directory,
                timeout=3,
                check=lambda: None,
            )
        second = self.run_engine()
        self.assertEqual(second["model_load"], 0)
        self.assertEqual(second["separation"], 0.02)

    def test_invalid_responses_kill_engine(self):
        for mode in (
            "oversize",
            "mismatch",
            "error",
            "missing-timings",
            "huge-timing",
            "nan-timing",
        ):
            with self.subTest(mode=mode), self.assertRaises(self.module.EngineError):
                self.run_engine(mode)
            self.assertIsNone(self.engine._process)

    def test_timeout_crash_and_cancel_kill_descendants(self):
        for mode in ("timeout", "crash", "cancel"):
            ready, marker = self.directory / "child-ready", self.directory / "escaped"
            ready.unlink(missing_ok=True)
            marker.unlink(missing_ok=True)

            def check(mode=mode, ready=ready):
                if mode == "cancel" and ready.exists():
                    raise InterruptedError("lease lost")

            expected = {
                "timeout": subprocess.TimeoutExpired,
                "crash": self.module.EngineError,
                "cancel": InterruptedError,
            }[mode]
            with self.subTest(mode=mode), self.assertRaises(expected):
                self.run_engine(
                    mode, timeout=0.4 if mode == "timeout" else 5, check=check
                )
            time.sleep(0.9)
            self.assertFalse(marker.exists(), "descendant survived engine cleanup")
            self.assertIsNone(self.engine._process)

    def test_containment_slot_names_are_derived_at_runtime(self):
        from musicmute_worker import processes

        self.assertEqual(processes._job_name("engine"), processes._JOB_NAME + ".engine")
        self.assertEqual(processes._job_name("transient"), processes._JOB_NAME)
        for slot in ("benchmark-1", "benchmark-2"):
            self.assertEqual(
                processes._job_name(slot), processes._JOB_NAME + "." + slot
            )
        with self.assertRaises(ValueError):
            self.module.SeparatorEngine(self.fake, self.directory, slot="other")

    def test_run_rejects_concurrent_request_without_interfering_with_active_job(self):
        checks = []

        def check():
            with self.assertRaisesRegex(self.module.EngineError, "ENGINE_BUSY"):
                self.engine.run(
                    self.source,
                    self.directory / "other-output",
                    timeout=1,
                    check=lambda: None,
                )
            checks.append(True)

        self.run_engine(check=check)
        self.assertTrue(checks)
        self.assertIsNotNone(self.engine._process)

    def test_startup_timeout_and_session_mismatch_are_contained(self):
        for replacement, expected in [
            ("time.sleep(20); write('ready.json',", subprocess.TimeoutExpired),
            ("a.session_id='wrong'; write('ready.json',", self.module.EngineError),
        ]:
            self.fake.write_text(FAKE.replace("write('ready.json',", replacement))
            with self.subTest(expected=expected), self.assertRaises(expected):
                self.run_engine(timeout=0.3)
            self.assertIsNone(self.engine._process)

    def test_close_then_run_starts_fresh_session(self):
        self.run_engine()
        self.engine.close()
        self.engine.close()
        self.assertGreater(self.run_engine()["model_load"], 0)

    def test_recover_stops_every_known_containment_boundary(self):
        from types import SimpleNamespace
        from unittest.mock import Mock, patch

        from musicmute_worker import processes

        kernel = SimpleNamespace(
            OpenJobObjectW=Mock(return_value=42), CloseHandle=Mock()
        )
        with (
            patch.object(processes, "os", SimpleNamespace(name="nt")),
            patch.object(processes, "_kernel32", kernel, create=True),
            patch.object(processes, "_terminate_job", create=True) as terminate,
        ):
            processes.ProcessRunner().recover()
        self.assertEqual(
            [call.args[2] for call in kernel.OpenJobObjectW.call_args_list],
            [
                processes._job_name(slot)
                for slot in ("transient", "engine", "benchmark-1", "benchmark-2")
            ],
        )
        self.assertEqual(terminate.call_count, 4)
        self.assertEqual(kernel.CloseHandle.call_count, 4)

    def test_benchmark_slots_remain_independent_when_one_engine_closes(self):
        first = self.module.SeparatorEngine(
            self.fake, self.directory, slot="benchmark-1"
        )
        second = self.module.SeparatorEngine(
            self.fake, self.directory, slot="benchmark-2"
        )
        self.addCleanup(first.close)
        self.addCleanup(second.close)
        self.source.write_text("ok")
        first.run(self.source, self.directory / "one", timeout=5, check=lambda: None)
        second.run(self.source, self.directory / "two", timeout=5, check=lambda: None)
        first.close()
        self.assertEqual(
            second.run(
                self.source, self.directory / "two", timeout=5, check=lambda: None
            )["model_load"],
            0,
        )

    @unittest.skipUnless(os.name == "nt", "Windows engine Job Object crash containment")
    def test_windows_supervisor_crash_kills_engine_and_descendants(self):
        from musicmute_worker.processes import ProcessRunner, SingleInstance

        self.source.write_text("cancel")
        ready = self.directory / "child-ready"
        code = self.isolation.child_setup + (
            "import os; from pathlib import Path; "
            "from musicmute_worker.engine import SeparatorEngine; "
            "from musicmute_worker.processes import SingleInstance; "
            f"ready=Path({str(ready)!r}); "
            f"engine=SeparatorEngine(Path({str(self.fake)!r}), Path({str(self.directory)!r})); "
            f"lock=SingleInstance(Path({str(self.directory)!r})); lock.__enter__(); "
            f"engine.run(Path({str(self.source)!r}), Path({str(self.directory / 'output')!r}), timeout=10, "
            "check=lambda: os._exit(9) if ready.exists() else None)"
        )
        result = subprocess.run([sys.executable, "-c", code], timeout=5, check=False)
        self.assertEqual(result.returncode, 9)
        time.sleep(1.0)
        escaped = (self.directory / "escaped").exists()
        with SingleInstance(self.directory):
            ProcessRunner().recover()
        self.assertFalse(escaped, "descendant survived supervisor crash")


@unittest.skipUnless(os.name == "posix", "POSIX-only process exit race")
class PosixCloseRaceTests(unittest.TestCase):
    def test_reaps_exited_leader_before_retrying_permission_error(self):
        from unittest.mock import Mock, patch

        from musicmute_worker import processes

        child = processes._PosixProcess.__new__(processes._PosixProcess)
        child.process = Mock(pid=1234)
        child.process.poll.side_effect = [None, 0]
        with patch.object(
            processes.os,
            "killpg",
            side_effect=[PermissionError(), ProcessLookupError()],
        ) as kill:
            child.close()
        self.assertEqual(kill.call_count, 2)
        child.process.wait.assert_called_once_with(timeout=10)

    def test_permission_error_on_live_process_is_never_attested_stopped(self):
        from unittest.mock import Mock, patch

        from musicmute_worker import processes

        child = processes._PosixProcess.__new__(processes._PosixProcess)
        child.process = Mock(pid=1234)
        child.process.poll.return_value = None
        with (
            patch.object(processes.os, "killpg", side_effect=PermissionError()),
            self.assertRaises(PermissionError),
        ):
            child.close()
        child.process.wait.assert_not_called()


@unittest.skipUnless(os.name == "nt", "Windows Job Object handle lifecycle")
class WindowsHandleTests(unittest.TestCase):
    def test_failed_stop_retains_handles_until_termination_is_verified(self):
        from unittest.mock import Mock, patch

        from musicmute_worker import processes

        child = processes._WindowsProcess.__new__(processes._WindowsProcess)
        child.job, child.process = 123, 456
        kernel = Mock()
        with (
            patch.object(processes, "_kernel32", kernel),
            patch.object(
                processes,
                "_terminate_job",
                side_effect=[RuntimeError("stop not verified"), None],
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "stop not verified"):
                child.close()
            self.assertEqual((child.job, child.process), (123, 456))
            kernel.CloseHandle.assert_not_called()
            child.close()
            self.assertEqual((child.job, child.process), (None, None))
            self.assertEqual(kernel.CloseHandle.call_count, 2)


class ContainedCloseTests(unittest.TestCase):
    def test_failed_stop_retains_process_and_stream_ownership_for_retry(self):
        from unittest.mock import Mock

        from musicmute_worker.processes import ContainedProcess

        contained = ContainedProcess.__new__(ContainedProcess)
        child = Mock()
        child.close.side_effect = [RuntimeError("stop not verified"), None]
        contained._process = child
        contained._stack = Mock()
        with self.assertRaisesRegex(RuntimeError, "termination could not be verified"):
            contained.close()
        self.assertIs(contained._process, child)
        contained._stack.close.assert_not_called()
        contained.close()
        self.assertIsNone(contained._process)
        contained._stack.close.assert_called_once()


@unittest.skipUnless(os.name == "nt", "Windows native process termination handles")
class WindowsTerminationTests(unittest.TestCase):
    def test_close_waits_for_every_process_handle_to_signal(self):
        self._assert_terminated(recover=False)

    def test_recover_waits_for_every_process_handle_to_signal(self):
        self._assert_terminated(recover=True)

    def _assert_terminated(self, *, recover):
        import ctypes
        from ctypes import wintypes as w

        from musicmute_worker import processes

        class ProcessIds(ctypes.Structure):
            _fields_ = [
                ("assigned", w.DWORD),
                ("count", w.DWORD),
                ("ids", ctypes.c_size_t * 256),
            ]

        kernel = processes._kernel32
        kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
        kernel.OpenProcess.restype = w.HANDLE
        with ProcessTestIsolation(), tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            ready = directory / "descendant-ready"
            descendant = f"import time; from pathlib import Path; Path({str(ready)!r}).touch(); time.sleep(20)"
            code = f'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",{descendant!r}]); time.sleep(20)'
            with processes.SingleInstance(directory):
                child = processes.ContainedProcess(
                    [sys.executable, "-c", code], cwd=directory, slot="engine"
                )
                handles = []
                try:
                    deadline = time.monotonic() + 5
                    while not ready.exists():
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(0.01)
                    members = ProcessIds()
                    processes._checked(
                        kernel.QueryInformationJobObject(
                            child._process.job,
                            3,
                            ctypes.byref(members),
                            ctypes.sizeof(members),
                            None,
                        )
                    )
                    self.assertGreaterEqual(members.count, 2)
                    for pid in members.ids[: members.count]:
                        handles.append(
                            processes._checked(kernel.OpenProcess(0x100000, False, pid))
                        )
                    if recover:
                        processes.ProcessRunner().recover()
                    else:
                        child.close()
                    self.assertEqual(
                        [kernel.WaitForSingleObject(handle, 0) for handle in handles],
                        [0] * len(handles),
                        "Job accounting reached zero before process resource cleanup completed",
                    )
                finally:
                    child.close()
                    for handle in handles:
                        kernel.WaitForSingleObject(handle, 5000)
                        kernel.CloseHandle(handle)


class ProtocolSharingTests(unittest.TestCase):
    def _engine(self):
        from unittest.mock import Mock

        from musicmute_worker.engine import SeparatorEngine

        engine = SeparatorEngine(Path("fake.py"), Path("."))
        engine._directory = Path(".")
        engine._process = Mock()
        engine._process.poll.return_value = None
        return engine

    def test_windows_message_open_sharing_race_retries_on_next_poll(self):
        import io
        from types import SimpleNamespace
        from unittest.mock import patch

        from musicmute_worker import engine as module

        engine = self._engine()
        checks = []
        with (
            patch.object(module, "os", SimpleNamespace(name="nt")),
            patch.object(
                Path,
                "open",
                side_effect=[
                    PermissionError("sharing race"),
                    io.BytesIO(b'{"version":1,"status":"ready"}'),
                ],
            ),
        ):
            response = engine._wait(
                "ready.json", time.monotonic() + 5, 5, lambda: checks.append(True)
            )
        self.assertEqual(response, {"version": 1, "status": "ready"})
        self.assertGreaterEqual(len(checks), 2)

    def test_permission_denied_is_not_hidden_on_posix(self):
        from types import SimpleNamespace
        from unittest.mock import patch

        from musicmute_worker import engine as module

        engine = self._engine()
        with (
            patch.object(module, "os", SimpleNamespace(name="posix")),
            patch.object(Path, "open", side_effect=PermissionError("denied")),
            self.assertRaises(PermissionError),
        ):
            engine._wait("ready.json", time.monotonic() + 5, 5, lambda: None)

    def test_permanent_windows_sharing_denial_has_short_bound(self):
        from types import SimpleNamespace
        from unittest.mock import patch

        from musicmute_worker import engine as module

        engine = self._engine()
        with (
            patch.object(module, "os", SimpleNamespace(name="nt")),
            patch.object(module, "_SHARING_TIMEOUT", 0.05),
            patch.object(Path, "open", side_effect=PermissionError("denied")),
            self.assertRaisesRegex(module.EngineError, "ENGINE_IPC_UNAVAILABLE"),
        ):
            engine._wait("ready.json", time.monotonic() + 5, 5, lambda: None)

    def test_sharing_retry_checks_cancellation_before_reading_again(self):
        from types import SimpleNamespace
        from unittest.mock import patch

        from musicmute_worker import engine as module

        engine = self._engine()
        checks = []

        def check():
            checks.append(True)
            if len(checks) == 2:
                raise InterruptedError("cancelled")

        with (
            patch.object(module, "os", SimpleNamespace(name="nt")),
            patch.object(
                Path, "open", side_effect=PermissionError("denied")
            ) as opening,
            self.assertRaises(InterruptedError),
        ):
            engine._wait("ready.json", time.monotonic() + 5, 5, check)
        self.assertEqual(opening.call_count, 1)


class ContainmentFailureTests(unittest.TestCase):
    def test_failed_transient_close_is_fatal_and_owner_is_recovered(self):
        from types import SimpleNamespace
        from unittest.mock import Mock, patch

        from musicmute_worker import processes

        error = getattr(processes, "ContainmentError", None)
        self.assertIsNotNone(error, "Containment errors must not become media errors")
        child = Mock()
        child.poll.return_value = 0
        child.close.side_effect = [OSError("native stop failed"), None]
        with (
            patch.object(
                processes, "os", SimpleNamespace(name="posix", devnull=os.devnull)
            ),
            patch.object(processes, "_PosixProcess", return_value=child),
            patch.object(processes, "_FAILED_PROCESSES", []),
        ):
            runner = processes.ProcessRunner()
            with self.assertRaises(error):
                runner.run(["test-child"], cwd=Path("."), timeout=1, check=lambda: None)
            self.assertEqual(processes._FAILED_PROCESSES, [child])
            runner.recover()
            self.assertEqual(processes._FAILED_PROCESSES, [])
            self.assertEqual(child.close.call_count, 2)

    def test_engine_close_preserves_owner_and_sanitizes_native_failure(self):
        from unittest.mock import Mock

        from musicmute_worker import processes

        error = getattr(processes, "ContainmentError", None)
        self.assertIsNotNone(error, "Containment errors must not become media errors")
        contained = processes.ContainedProcess.__new__(processes.ContainedProcess)
        contained._process = Mock()
        contained._process.close.side_effect = [
            OSError("sensitive native detail"),
            None,
        ]
        contained._stack = Mock()
        with self.assertRaises(error) as failure:
            contained.close()
        self.assertNotIn("sensitive native detail", str(failure.exception))
        self.assertIsNotNone(contained._process)
        contained._stack.close.assert_not_called()
        contained.close()
        self.assertIsNone(contained._process)


@unittest.skipUnless(os.name == "nt", "Windows stop snapshot state")
class WindowsStopFailureTests(unittest.TestCase):
    def test_partial_snapshot_never_becomes_verified_on_retry(self):
        from unittest.mock import Mock, patch

        from musicmute_worker import processes

        kernel = Mock()
        kernel.OpenProcess.side_effect = [111, OSError("snapshot open failed")]
        with (
            patch.object(processes, "_kernel32", kernel),
            patch.object(
                processes, "_job_process_ids", return_value=[11, 22]
            ) as members,
            patch.object(processes, "_STOP_HANDLES", {}),
            patch.object(processes, "_INCOMPLETE_STOPS", set()),
        ):
            with self.assertRaises(processes.ContainmentError):
                processes._terminate_job(7)
            self.assertEqual(processes._STOP_HANDLES, {7: {11: 111}})
            self.assertEqual(processes._INCOMPLETE_STOPS, {7})
            with self.assertRaises(processes.ContainmentError):
                processes._terminate_job(7)
            self.assertEqual(members.call_count, 1)
            kernel.WaitForSingleObject.assert_not_called()
            kernel.CloseHandle.assert_not_called()

    def test_wait_failure_retains_complete_snapshot_for_verified_retry(self):
        from unittest.mock import Mock, patch

        from musicmute_worker import processes

        kernel = Mock()
        kernel.OpenProcess.return_value = 111
        kernel.WaitForSingleObject.side_effect = [258, 0]
        with (
            patch.object(processes, "_kernel32", kernel),
            patch.object(processes, "_job_process_ids", side_effect=[[11], []]),
            patch.object(processes, "_STOP_HANDLES", {}),
            patch.object(processes, "_INCOMPLETE_STOPS", set()),
            patch.object(processes.time, "monotonic", side_effect=[0, 11, 0]),
        ):
            with self.assertRaises(processes.ContainmentError):
                processes._terminate_job(7)
            self.assertEqual(processes._STOP_HANDLES, {7: {11: 111}})
            self.assertFalse(processes._INCOMPLETE_STOPS)
            kernel.CloseHandle.assert_not_called()
            processes._terminate_job(7)
            self.assertEqual(processes._STOP_HANDLES, {})
            kernel.CloseHandle.assert_called_once_with(111)
