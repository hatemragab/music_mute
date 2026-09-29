from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from musicmute_engine.benchmark_coordinator import CoordinationError, run_cohort
from musicmute_engine.capacity_benchmark import compare_audio, peak_resident_bytes


def synthetic_task(argument, ready, measured) -> None:
    root = Path(argument["root"])
    index = argument["index"]
    (root / f"worker-{index}.pid").write_text(str(os.getpid()))
    if argument.get("descendant"):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        (root / "descendant.pid").write_text(str(child.pid))
    if argument.get("fail"):
        raise RuntimeError("Synthetic failure")
    time.sleep(argument.get("warmup", 0))
    (root / f"ready-{index}").write_text(str(time.perf_counter()))
    ready()
    start = time.perf_counter()
    time.sleep(argument.get("measure", 0.1))
    measured(time.perf_counter() - start)
    (root / f"start-{index}").write_text(str(start))
    time.sleep(argument.get("finalize", 0))


class BenchmarkCoordinatorTests(unittest.TestCase):
    def test_cli_lifetime_pipe_stops_the_coordinator_and_descendants(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            code = (
                f"import sys,json; sys.path.insert(0,{str(Path(__file__).parent)!r}); "
                "from pathlib import Path; from argparse import Namespace; "
                "from test_benchmark_coordinator import synthetic_task; "
                "from musicmute_engine.benchmark_coordinator import run_cohort; "
                "import musicmute_engine.capacity_benchmark as capacity; "
                "argument=json.loads(sys.argv[1]); "
                "capacity.parse_args=lambda: Namespace(watch_parent=True, report=Path(argument['root'])/'report.json'); "
                "capacity.run_capacity=lambda _: run_cohort(synthetic_task,[argument]); "
                "raise SystemExit(capacity.main())"
            )
            coordinator = subprocess.Popen(
                [sys.executable, "-c", code, json.dumps({"root": directory, "index": 0, "descendant": True, "warmup": 60})],
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            try:
                deadline = time.monotonic() + 20
                while not (root / "descendant.pid").exists() and time.monotonic() < deadline:
                    if coordinator.poll() is not None:
                        self.fail("Fixture coordinator exited before its child started")
                    time.sleep(0.05)
                self.assertTrue((root / "descendant.pid").exists())
                pids = [int((root / name).read_text()) for name in ("worker-0.pid", "descendant.pid")]
                coordinator.stdin.close()
                self.assertEqual(coordinator.wait(timeout=5), 2)
                for pid in pids:
                    self._assert_process_exited(pid)
            finally:
                if coordinator.poll() is None:
                    coordinator.kill()
                coordinator.wait(timeout=5)
                coordinator.stdin.close()

    def test_coordinator_death_terminates_workers_and_their_descendants(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            code = (
                f"import sys,json; sys.path.insert(0,{str(Path(__file__).parent)!r}); "
                "from test_benchmark_coordinator import synthetic_task; "
                "from musicmute_engine.benchmark_coordinator import run_cohort; "
                "run_cohort(synthetic_task,[json.loads(sys.argv[1])])"
            )
            coordinator = subprocess.Popen(
                [sys.executable, "-c", code, json.dumps({"root": directory, "index": 0, "descendant": True, "warmup": 60})],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            try:
                deadline = time.monotonic() + 20
                while not (root / "descendant.pid").exists() and time.monotonic() < deadline:
                    if coordinator.poll() is not None:
                        self.fail("Fixture coordinator exited before its child started")
                    time.sleep(0.05)
                self.assertTrue((root / "descendant.pid").exists())
                pids = [int((root / name).read_text()) for name in ("worker-0.pid", "descendant.pid")]
                coordinator.kill()
                coordinator.wait(timeout=5)
                for pid in pids:
                    self._assert_process_exited(pid)
            finally:
                if coordinator.poll() is None:
                    coordinator.kill()
                coordinator.wait(timeout=5)

    def test_both_processes_finish_warmup_before_the_measured_clock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cohort = run_cohort(synthetic_task, [
                {"root": directory, "index": 0, "warmup": 0.05, "finalize": 0.3},
                {"root": directory, "index": 1, "warmup": 0.6, "finalize": 0.3},
            ], timeout_seconds=20)
            readiness = [float((root / f"ready-{i}").read_text()) for i in range(2)]
            starts = [float((root / f"start-{i}").read_text()) for i in range(2)]
            self.assertGreaterEqual(min(starts), max(readiness))
            self.assertGreater(cohort["wallSeconds"], 0.09)
            self.assertLess(cohort["wallSeconds"], 0.4)
            self.assertEqual(len(set(cohort["workerPids"])), 2)
            self.assertNotIn(os.getpid(), cohort["workerPids"])
            self.assertTrue(all(0 < value <= cohort["wallSeconds"] for value in cohort["workerSeconds"]))

    def test_worker_failure_stops_its_descendant(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(CoordinationError):
                run_cohort(synthetic_task, [{"root": directory, "index": 0, "descendant": True, "fail": True}], timeout_seconds=20)
            pid = int((Path(directory) / "descendant.pid").read_text())
            self._assert_process_exited(pid)

    def _assert_process_exited(self, pid: int) -> None:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel.OpenProcess(0x00100000, False, pid)
            if handle:
                try:
                    self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0)
                finally:
                    kernel.CloseHandle(handle)
        else:
            deadline = time.monotonic() + 5
            while True:
                result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
                if result.returncode != 0 or result.stdout.strip().startswith("Z") or time.monotonic() > deadline:
                    break
                time.sleep(0.05)
            self.assertTrue(result.returncode != 0 or result.stdout.strip().startswith("Z"))

    def test_deadline_releases_a_worker_still_in_warmup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(CoordinationError, "deadline"):
                run_cohort(synthetic_task, [{"root": directory, "index": 0, "warmup": 30}], timeout_seconds=1)

    def test_decoded_comparison_rejects_shape_changes_and_detects_quality_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            left, right = root / "left.wav", root / "right.wav"
            audio = np.full((4410, 2), 0.1)
            sf.write(left, audio, 44100, subtype="PCM_16")
            sf.write(right, audio, 44100, subtype="PCM_16")
            self.assertTrue(compare_audio(left, right)["passed"])
            sf.write(right, audio + 0.05, 44100, subtype="PCM_16")
            self.assertFalse(compare_audio(left, right)["passed"])
            sf.write(right, audio[:100], 44100, subtype="PCM_16")
            with self.assertRaisesRegex(RuntimeError, "shape"):
                compare_audio(left, right)

    def test_resident_memory_measurement_is_available(self) -> None:
        self.assertGreater(peak_resident_bytes(), 0)


if __name__ == "__main__":
    unittest.main()
