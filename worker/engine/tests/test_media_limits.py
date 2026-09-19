from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from musicmute_engine.limits import (
    MAX_INPUT_BYTES,
    MAX_LOSSLESS_SAMPLES,
    MAX_PCM16_BYTES,
    MAX_TOOL_OUTPUT_BYTES,
)
from musicmute_engine.media import (
    LOCAL_MEDIA_FORMATS,
    MediaProcessingError,
    _run,
    _run_ffmpeg,
    inspect_lossless_audio,
    verify_input_identity,
)


class OversizedSoundFile:
    samplerate = 44_100
    channels = 2
    format = "WAV"
    subtype = "PCM_16"

    def __enter__(self) -> "OversizedSoundFile":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def __len__(self) -> int:
        return MAX_LOSSLESS_SAMPLES + 1


class MediaLimitTests(unittest.TestCase):
    def test_input_declaration_cannot_exceed_the_shared_gigabyte_limit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.wav"
            source.write_bytes(b"input")
            with self.assertRaisesRegex(MediaProcessingError, "size declaration"):
                verify_input_identity(source, MAX_INPUT_BYTES + 1, "invalid")

    def test_ffmpeg_output_uses_an_explicit_file_size_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ffmpeg = root / "ffmpeg"
            source = root / "input.wav"
            destination = root / "prepared.wav"
            ffmpeg.write_bytes(b"tool")
            ffmpeg.chmod(0o700)
            source.write_bytes(b"input")
            with patch("musicmute_engine.media._run") as execute:
                _run_ffmpeg(
                    ffmpeg,
                    source,
                    ["-c:a", "pcm_s16le"],
                    destination,
                    MAX_PCM16_BYTES,
                    "failed",
                )
            arguments = execute.call_args.args[0]
            self.assertIn("-format_whitelist", arguments)
            self.assertIn(LOCAL_MEDIA_FORMATS, arguments)
            self.assertEqual(arguments[arguments.index("-protocol_whitelist") + 1], "file")
            self.assertEqual(arguments[-3:], ["-fs", str(MAX_PCM16_BYTES), str(destination)])

    def test_lossless_sample_count_and_tool_output_are_memory_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "audio.wav"
            source.write_bytes(b"small")
            with patch("soundfile.SoundFile", return_value=OversizedSoundFile()):
                with self.assertRaisesRegex(MediaProcessingError, "worker limits"):
                    inspect_lossless_audio(source)

        command = [
            sys.executable,
            "-c",
            f"import sys; sys.stdout.write('x' * {MAX_TOOL_OUTPUT_BYTES + 1})",
        ]
        with self.assertRaisesRegex(MediaProcessingError, "bounded output"):
            _run(command, 5, "bounded output")


if __name__ == "__main__":
    unittest.main()
