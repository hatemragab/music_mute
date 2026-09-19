from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from musicmute_engine.trimmer import trim_vocal_gaps

RATE = 44_100


def tone(samples: int, *, left: float = 0.25, right: float = 0.25) -> np.ndarray:
    frames = np.arange(samples, dtype=np.float32)
    wave = np.sin(2 * np.pi * 440 * frames / RATE).astype(np.float32)
    return np.column_stack((wave * left, wave * right))


def silence(samples: int) -> np.ndarray:
    return np.zeros((samples, 2), dtype=np.float32)


class TrimmerParityTests(unittest.TestCase):
    def run_case(self, name: str, audio: np.ndarray, expected: int) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "source.wav", root / "output.wav"
            sf.write(source, audio, RATE, subtype="PCM_16")
            result = trim_vocal_gaps(source, output)
            self.assertEqual(result.source_samples, len(audio), name)
            self.assertEqual(result.output_samples, expected, name)
            self.assertEqual(len(sf.read(output, dtype="int16")[0]), expected, name)

    def test_reference_vectors(self) -> None:
        self.run_case(
            "internal_gap",
            np.concatenate((tone(RATE), silence(RATE), tone(RATE))),
            105_840,
        )
        self.run_case(
            "leading_and_trailing",
            np.concatenate((silence(RATE), tone(RATE), silence(RATE))),
            61_740,
        )
        self.run_case("all_silent", silence(RATE), 44_100)
        self.run_case(
            "below_minimum",
            np.concatenate((tone(RATE), silence(34_839), tone(RATE))),
            123_039,
        )
        self.run_case(
            "exact_minimum",
            np.concatenate((tone(RATE), silence(35_280), tone(RATE))),
            105_840,
        )
        self.run_case("one_loud_channel", tone(88_200, right=0.0), 88_200)
        self.run_case(
            "partial_final_window",
            np.concatenate((tone(RATE), silence(35_500))),
            52_920,
        )
        self.run_case("sub_frame_loud", tone(176), 176)

    def test_pcm_output_matches_the_preserved_reference(self) -> None:
        reference_path = (
            Path(__file__).resolve().parents[3]
            / "docs"
            / "worker-rebuild"
            / "reference"
            / "separate.py"
        )
        spec = importlib.util.spec_from_file_location(
            "preserved_separator", reference_path
        )
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        audio = np.concatenate((tone(RATE), silence(RATE), tone(RATE)))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.wav"
            expected, actual = root / "expected.wav", root / "actual.wav"
            sf.write(source, audio, RATE, subtype="PCM_16")
            module.trim_vocal_gaps(source, expected)
            trim_vocal_gaps(source, actual)
            expected_pcm, _ = sf.read(expected, dtype="int16", always_2d=True)
            actual_pcm, _ = sf.read(actual, dtype="int16", always_2d=True)
            np.testing.assert_array_equal(actual_pcm, expected_pcm)


if __name__ == "__main__":
    unittest.main()
