"""Real media-tool execution with PATH unavailable; no GPU admission claim."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from musicmute_worker.media_limits import effective_media_limits
from musicmute_worker.processes import ProcessRunner
from musicmute_worker.worker import MediaError, inspect_audio
from musicmute_worker.worker import Worker
from musicmute_worker.profiles import ProfileError
from test_media_limits import version_two_limits


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "native media test tools unavailable",
)
class PinnedMediaTests(unittest.TestCase):
    def test_worker_without_prepared_tools_has_no_path_fallback(self):
        worker = object.__new__(Worker)
        worker.runtime = None
        with self.assertRaises(ProfileError):
            worker._media_tools()

    def test_explicit_tools_prepare_and_validate_without_path(self):
        tools = {
            name: Path(shutil.which(name)).resolve() for name in ("ffmpeg", "ffprobe")
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, prepared, output = (
                root / "input.wav",
                root / "prepared.wav",
                root / "voice.mp3",
            )
            with patch.dict(os.environ, {"PATH": "/nonexistent"}):
                subprocess.run(
                    [
                        str(tools["ffmpeg"]),
                        "-v",
                        "error",
                        "-f",
                        "lavfi",
                        "-i",
                        "sine=frequency=440:duration=0.25",
                        "-ac",
                        "2",
                        str(source),
                    ],
                    check=True,
                    timeout=15,
                )
                duration = inspect_audio(
                    source, ProcessRunner(), lambda: None, prepared=prepared, **tools
                )
                self.assertGreater(duration, 0)
                self.assertTrue(prepared.is_file())
                subprocess.run(
                    [
                        str(tools["ffmpeg"]),
                        "-v",
                        "error",
                        "-i",
                        str(prepared),
                        str(output),
                    ],
                    check=True,
                    timeout=15,
                )
                self.assertGreater(
                    inspect_audio(
                        output, ProcessRunner(), lambda: None, output=True, **tools
                    ),
                    0,
                )
                with self.assertRaises(MediaError):
                    inspect_audio(
                        prepared, ProcessRunner(), lambda: None, output=True, **tools
                    )
                source.write_bytes(b"malformed audio")
                with self.assertRaises(MediaError):
                    inspect_audio(source, ProcessRunner(), lambda: None, **tools)

    def test_multistream_and_surround_inputs_remain_rejected(self):
        tools = {
            name: Path(shutil.which(name)).resolve() for name in ("ffmpeg", "ffprobe")
        }
        limits = effective_media_limits(
            {"processingLimits": version_two_limits()}, 100_000_000, 120
        )
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {"PATH": "/nonexistent"}),
        ):
            root = Path(directory)
            for name, extra in (
                ("surround.wav", ["-ac", "6"]),
                ("multiple.mka", ["-map", "0:a", "-map", "0:a", "-c:a", "pcm_s16le"]),
            ):
                source = root / name
                subprocess.run(
                    [
                        str(tools["ffmpeg"]),
                        "-v",
                        "error",
                        "-f",
                        "lavfi",
                        "-i",
                        "sine=duration=0.1",
                        *extra,
                        str(source),
                    ],
                    check=True,
                    timeout=15,
                )
                with self.subTest(name=name), self.assertRaises(MediaError):
                    inspect_audio(
                        source, ProcessRunner(), lambda: None, limits=limits, **tools
                    )
