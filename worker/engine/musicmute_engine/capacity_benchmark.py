"""Compare one warmed GPU worker with two independent warmed GPU workers."""
from __future__ import annotations

import argparse
import ctypes
import json
import math
import os
import platform
import sys
import threading
import time
from pathlib import Path
from typing import Callable

from .benchmark_coordinator import run_cohort
from .benchmark_file import build_report, code_digest
from .limits import CHANNELS, MAX_LOSSLESS_SAMPLES, SAMPLE_RATE
from .qualification import QualificationError, run_qualification, write_private_report
from .recipes import RECIPE_DEFINITIONS

MINIMUM_SPEEDUP = 1.1
MAX_RMS_DIFFERENCE = 0.0001
MAX_ABSOLUTE_DIFFERENCE = 0.01


def peak_resident_bytes() -> int:
    if os.name == "nt":
        from ctypes import wintypes

        class MemoryCounters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in (
                    "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                    "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage",
                    "PagefileUsage", "PeakPagefileUsage",
                )
            ]

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(MemoryCounters), wintypes.DWORD]
        kernel.K32GetProcessMemoryInfo.restype = wintypes.BOOL
        counters = MemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        if not kernel.K32GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        return int(counters.PeakWorkingSetSize)
    import resource

    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(peak if platform.system() == "Darwin" else peak * 1024)


def _measure_worker(arguments: argparse.Namespace, ready: Callable[[], None], measured: Callable[[float], None]) -> None:
    started = time.perf_counter()
    arguments.before_measurement = ready
    arguments.after_measurement = measured
    raw = run_qualification(arguments)
    report = build_report(raw, arguments, code_digest(Path(__file__).resolve().parent.parent))
    report["measuredWallSeconds"] = raw["measuredWallSeconds"]
    report["peakResidentBytes"] = peak_resident_bytes()
    report["taskWallSeconds"] = time.perf_counter() - started
    write_private_report(arguments.report, report)


def compare_audio(reference: Path, candidate: Path) -> dict[str, object]:
    """Decode in bounded blocks; compare final outputs including silence trimming."""
    import numpy as np
    import soundfile as sf

    for path in (reference, candidate):
        if not path.is_file() or path.is_symlink():
            raise QualificationError("Capacity audio is not a regular file")
    maximum = 0.0
    squared = 0.0
    samples = 0
    with sf.SoundFile(reference) as left, sf.SoundFile(candidate) as right:
        if (
            left.samplerate != SAMPLE_RATE or right.samplerate != SAMPLE_RATE
            or left.channels != CHANNELS or right.channels != CHANNELS
            or not 0 < len(left) <= MAX_LOSSLESS_SAMPLES or len(left) != len(right)
        ):
            raise QualificationError("Capacity output shape changed")
        while True:
            expected = left.read(65536, dtype="float64", always_2d=True)
            actual = right.read(65536, dtype="float64", always_2d=True)
            if expected.shape != actual.shape:
                raise QualificationError("Capacity decoded audio was truncated")
            if not len(expected):
                break
            if not np.isfinite(expected).all() or not np.isfinite(actual).all():
                raise QualificationError("Capacity output contains non-finite samples")
            difference = expected - actual
            maximum = max(maximum, float(np.abs(difference).max()))
            squared += float(np.square(difference).sum())
            samples += difference.size
    if not samples:
        raise QualificationError("Capacity output is empty")
    rms = math.sqrt(squared / samples)
    return {
        "passed": maximum <= MAX_ABSOLUTE_DIFFERENCE and rms <= MAX_RMS_DIFFERENCE,
        "maxAbsoluteDifference": maximum, "rmsDifference": rms,
        "frames": samples // CHANNELS, "sampleRate": SAMPLE_RATE, "channels": CHANNELS,
    }


def _read_report(path: Path) -> dict[str, object]:
    if path.is_symlink() or not path.is_file() or not 2 <= path.stat().st_size <= 4 * 1024 * 1024:
        raise QualificationError("Capacity worker report is unsafe")
    report = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(report, dict) or report.get("status") != "PASS":
        raise QualificationError("Capacity worker report failed")
    dispatch = report.get("providerDispatch", {})
    if not dispatch.get("proven") or dispatch.get("cpuNodeEvents") != 0 or dispatch.get("acceleratedNodeEvents", 0) <= 0:
        raise QualificationError("Capacity GPU dispatch was not proven")
    return report


def run_capacity(arguments: argparse.Namespace) -> dict[str, object]:
    if arguments.work_root.is_symlink() or not arguments.work_root.is_dir():
        raise QualificationError("Capacity workspace is unsafe")
    deadline = time.perf_counter() + 7000
    results = []
    identity: dict[str, object] | None = None
    for recipe_id in RECIPE_DEFINITIONS:
        cohorts = []
        reports = []
        workspaces = []
        for count in (1, 2):
            workers = []
            for index in range(count):
                root = arguments.work_root / f"{recipe_id}-{count}-{index}"
                root.mkdir(mode=0o700)
                worker = argparse.Namespace(**vars(arguments))
                worker.work_root = root
                worker.report = root / "report.json"
                worker.save_audio_dir = root / "audio"
                worker.recipe_id = recipe_id
                worker.benchmark_mode = True
                worker.iterations = 1 + arguments.warmup_runs + arguments.measured_runs
                worker.directml_device_id = 0
                worker.candidate_engine_root = None
                workers.append(worker)
            remaining = deadline - time.perf_counter()
            cohort = run_cohort(_measure_worker, workers, timeout_seconds=max(0.001, remaining))
            cohorts.append(cohort)
            current_reports = [_read_report(worker.report) for worker in workers]
            reports.append(current_reports)
            workspaces.append([worker.save_audio_dir for worker in workers])
            for report, measured_seconds in zip(current_reports, cohort["workerSeconds"]):
                current_identity = {key: report[key] for key in (
                    "engineDigest", "releaseManifestDigest", "modelDigest", "fixtureDigest",
                    "provider", "serviceIdentity", "gpuIdentity", "osVersion",
                )}
                if identity is None:
                    identity = current_identity
                if identity != current_identity or report["measuredWallSeconds"] != measured_seconds:
                    raise QualificationError("Capacity worker identity or timing changed")
        baseline, concurrent = cohorts
        speedup = 2 * baseline["wallSeconds"] / concurrent["wallSeconds"]
        comparisons = []
        first_measured = 2 + arguments.warmup_runs
        # Compare every measured output, including baseline repeatability, with
        # the same baseline. All comparisons happen after the measured cohort.
        reference = workspaces[0][0] / f"{first_measured:02d}-measured-vocals.mp3"
        for cohort_index, roots in enumerate(workspaces):
            for index, root in enumerate(roots):
                for iteration in range(first_measured, first_measured + arguments.measured_runs):
                    comparisons.append({
                        "cohortWorkers": cohort_index + 1, "worker": index, "iteration": iteration,
                        **compare_audio(reference, root / f"{iteration:02d}-measured-vocals.mp3"),
                    })
        results.append({
            "recipeId": recipe_id, "baseline": baseline, "concurrent": concurrent,
            "throughputSpeedup": speedup, "quality": comparisons,
            "passed": speedup >= MINIMUM_SPEEDUP and all(item["passed"] for item in comparisons),
            "workerReports": reports,
        })
    if identity is None:
        raise QualificationError("Capacity recipes are unavailable")
    return {
        "schemaVersion": 1, "kind": "two-worker-capacity",
        "status": "PASS" if all(result["passed"] for result in results) else "FAIL",
        "scope": "local-engine-only", **identity,
        "warmupRuns": arguments.warmup_runs, "measuredRuns": arguments.measured_runs,
        "minimumSpeedup": MINIMUM_SPEEDUP,
        "qualityLimits": {"maxAbsoluteDifference": MAX_ABSOLUTE_DIFFERENCE, "rmsDifference": MAX_RMS_DIFFERENCE},
        "measurementScope": "All workers finish cold and warmup runs before the parent releases a common measured-run barrier; report finalization and output comparison are excluded",
        "memoryScope": "Per-worker lifetime peak resident bytes; peaks are not simultaneous and exclude GPU allocations and media subprocesses",
        "recipes": results,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=("mps", "directml"), required=True)
    for field in ("fixture", "work-root", "release-root", "model-cache", "ffmpeg", "ffprobe", "report"):
        parser.add_argument(f"--{field}", type=Path, required=True)
    parser.add_argument("--fixture-sha256", required=True)
    parser.add_argument("--warmup-runs", type=int, default=1)
    parser.add_argument("--measured-runs", type=int, default=3)
    parser.add_argument("--group-size", type=int, default=1)
    parser.add_argument("--watch-parent", action="store_true")
    arguments = parser.parse_args()
    if any(not value.is_absolute() for value in vars(arguments).values() if isinstance(value, Path)):
        parser.error("Capacity paths must be absolute")
    if arguments.warmup_runs not in (1, 2) or not 3 <= arguments.measured_runs <= 10:
        parser.error("Capacity requires 1-2 warmup runs and 3-10 measured runs")
    if arguments.group_size not in (1, 2, 4) or (arguments.provider == "directml" and arguments.group_size != 1):
        parser.error("Capacity window group is unsupported")
    if len(arguments.fixture_sha256) != 64 or any(c not in "0123456789abcdef" for c in arguments.fixture_sha256):
        parser.error("Capacity fixture digest is invalid")
    return arguments


def main() -> int:
    arguments = parse_args()
    if arguments.watch_parent:
        descriptor = sys.stdin.fileno()
        # A blocking buffered read can interfere with inherited stdin closure
        # during Windows spawn. Python 3.12 supports nonblocking Windows pipes.
        os.set_blocking(descriptor, False)
        def parent_lifetime() -> None:
            try:
                while True:
                    try:
                        os.read(descriptor, 1)
                        break  # EOF or unexpected input both end the lease.
                    except BlockingIOError:
                        time.sleep(0.1)
            finally:
                # The CLI owns stdin. Its death closes all cohort lifetime pipes.
                os._exit(2)
        threading.Thread(target=parent_lifetime, daemon=True).start()
    try:
        report = run_capacity(arguments)
    except Exception as error:
        report = {"schemaVersion": 1, "kind": "two-worker-capacity", "status": "FAIL", "code": type(error).__name__[:64]}
    write_private_report(arguments.report, report)
    print(json.dumps({"type": "report-ready", "status": report["status"]}), flush=True)
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
