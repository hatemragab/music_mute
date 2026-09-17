from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import soundfile as sf


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixture_module = load_module("generate_fixture", ROOT / "generate_fixture.py")
probe = load_module("probe", ROOT / "probe.py")


class FixtureTests(unittest.TestCase):
    def test_fixture_is_deterministic_and_valid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.wav"
            second = Path(directory) / "second.wav"
            first_identity = fixture_module.generate_fixture(first, 0.1)
            second_identity = fixture_module.generate_fixture(second, 0.1)

            self.assertEqual(first_identity["sha256"], second_identity["sha256"])
            self.assertEqual(first.read_bytes(), second.read_bytes())
            inspected = probe.inspect_output(first)
            self.assertTrue(inspected["valid"])
            self.assertEqual(inspected["sample_rate_hz"], 44_100)
            self.assertEqual(inspected["channels"], 2)


class ProfileTests(unittest.TestCase):
    def test_profile_summary_groups_provider_dispatch(self) -> None:
        events = [
            {"dur": 30, "args": {"provider": "CoreMLExecutionProvider", "op_name": "CoreML"}},
            {"dur": 7, "args": {"provider": "CPUExecutionProvider", "op_name": "Shape"}},
            {"dur": 1, "args": {}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "profile.json"
            path.write_text(json.dumps(events), encoding="utf-8")
            summary = probe.summarize_profile(path)

            self.assertEqual(
                summary["provider_node_events"],
                {"CPUExecutionProvider": 1, "CoreMLExecutionProvider": 1},
            )
            self.assertEqual(summary["provider_duration_microseconds"]["CoreMLExecutionProvider"], 30)
            self.assertEqual(summary["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())


class OutputTests(unittest.TestCase):
    def test_non_finite_audio_is_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid.wav"
            sf.write(path, np.array([[np.nan, 0.1]], dtype=np.float32), 44_100, format="WAV", subtype="FLOAT")
            self.assertFalse(probe.inspect_output(path)["valid"])

    def test_empty_or_wrong_duration_outputs_cannot_pass(self) -> None:
        self.assertFalse(probe.outputs_are_valid([], 8.0, 2))
        separations = [
            {"outputs": [{"valid": True, "duration_seconds": 8.0}]},
            {"outputs": [{"valid": True, "duration_seconds": 7.5}]},
        ]
        self.assertFalse(probe.outputs_are_valid(separations, 8.0, 2))


class MemoryTests(unittest.TestCase):
    def test_windows_max_rss_uses_peak_working_set(self) -> None:
        with (
            mock.patch.object(probe.platform, "system", return_value="Windows"),
            mock.patch.object(probe, "windows_peak_working_set_bytes", return_value=123_456),
        ):
            self.assertEqual(probe.max_rss_bytes(), 123_456)


if __name__ == "__main__":
    unittest.main()
