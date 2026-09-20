from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from musicmute_engine.separator import KimSeparator


class FakeModel:
    def __init__(self) -> None:
        self.output_dir = ""
        self.reset_calls = 0

    def clear_file_specific_paths(self) -> None:
        self.reset_calls += 1


class FakeAudioSeparator:
    def __init__(self) -> None:
        self.output_dir = ""
        self.model_instance = FakeModel()

    def separate(
        self, _source: str, *, custom_output_names: dict[str, str]
    ) -> list[str]:
        output = Path(self.output_dir) / f"{custom_output_names['Vocals']}.flac"
        audio = np.zeros((441, 2), dtype=np.float32)
        sf.write(output, audio, 44_100, format="FLAC", subtype="PCM_16")
        return [output.name]


class SeparatorIsolationTests(unittest.TestCase):
    def test_warm_model_resets_file_state_and_keeps_outputs_attempt_local(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "prepared.wav"
            source.write_bytes(b"source-placeholder")
            first = root / "first"
            second = root / "second"
            second.mkdir()
            (second / "stale.flac").write_bytes(b"stale")

            backend = FakeAudioSeparator()
            separator = KimSeparator.__new__(KimSeparator)
            separator._separator = backend
            first_output = separator.separate(source, first)
            second_output = separator.separate(source, second)

            self.assertEqual(backend.model_instance.reset_calls, 2)
            self.assertEqual(first_output, (first / "vocals.flac").resolve())
            self.assertEqual(second_output, (second / "vocals.flac").resolve())
            self.assertTrue(first_output.is_file())
            self.assertTrue(second_output.is_file())
            self.assertFalse((second / "stale.flac").exists())
            self.assertEqual(backend.model_instance.output_dir, str(second))


if __name__ == "__main__":
    unittest.main()
