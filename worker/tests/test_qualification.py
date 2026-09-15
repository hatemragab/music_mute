import unittest
from pathlib import Path
import tempfile
import sys
import time
from dataclasses import replace

from musicmute_worker.qualification import (
    execution_evidence,
    QualificationError,
    QualificationRunner,
)
from musicmute_worker.profiles import Profile, PreparedRuntime, digest_file, fetch_asset


def event(provider):
    return {"cat": "Node", "name": "fused_kernel_time", "args": {"provider": provider}}


class QualificationTests(unittest.TestCase):
    def test_hung_runtime_is_bounded_and_cannot_report_acceleration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "work").mkdir()
            path = (
                Path(__file__).resolve().parents[1]
                / "profiles/macos-arm64-coreml.candidate.json"
            )
            profile = replace(Profile.load(path, digest_file(path)), max_wall_seconds=1)
            script = root / "hung.py"
            script.write_text("import time; time.sleep(60)")
            runtime = PreparedRuntime(
                Path(sys.executable),
                profile,
                root / "unused",
                root / "unused",
                root,
                {},
            )
            fixture = fetch_asset(profile.fixture, root / "cache")
            started = time.monotonic()
            result = QualificationRunner(runtime, script, root / "cache").qualify(
                profile, fixture
            )
            self.assertLess(time.monotonic() - started, 10)
            self.assertFalse(result["acceleratorUsed"])
            self.assertFalse(result["outputValid"])
            self.assertEqual(result["reasonCodes"], ["GPU_QUALIFICATION_FAILED"])

    def test_cpu_execution_is_rejected_even_with_gpu_registered(self):
        with self.assertRaises(QualificationError) as error:
            execution_evidence(
                [event("CPUExecutionProvider")], "CUDAExecutionProvider", ""
            )
        self.assertEqual(error.exception.code, "CPU_ONLY_UNSUPPORTED")

    def test_partial_execution_is_rejected(self):
        with self.assertRaises(QualificationError):
            execution_evidence(
                [event("CUDAExecutionProvider"), event("CPUExecutionProvider")],
                "CUDAExecutionProvider",
                "",
            )

    def test_no_execution_evidence_is_not_acceleration(self):
        with self.assertRaises(QualificationError):
            execution_evidence([], "CUDAExecutionProvider", "")

    def test_coreml_requires_compute_plan_gpu_placement(self):
        events = [event("CoreMLExecutionProvider")]
        with self.assertRaises(QualificationError):
            execution_evidence(events, "CoreMLExecutionProvider", "")
        with self.assertRaises(QualificationError):
            execution_evidence(
                events,
                "CoreMLExecutionProvider",
                "Operation: ios18.conv, Device Usage: <MLCPUComputeDevice: 0x1>, Estimated Cost: 1",
            )
        evidence = execution_evidence(
            events,
            "CoreMLExecutionProvider",
            "Operation: ios18.conv, Device Usage: <MLGPUComputeDevice: 0x1>, Estimated Cost: 1",
        )
        self.assertEqual(evidence["acceleratedNodes"], 1)
        self.assertEqual(evidence["cpuNodes"], 0)

    def test_different_gpu_is_not_requested_recipe(self):
        with self.assertRaises(QualificationError):
            execution_evidence(
                [event("CUDAExecutionProvider")], "DmlExecutionProvider", ""
            )


if __name__ == "__main__":
    unittest.main()
