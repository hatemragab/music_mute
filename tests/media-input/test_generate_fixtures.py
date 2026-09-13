"""Contract tests for synthetic, reproducible media fixtures."""

import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


class FixtureGeneratorTests(unittest.TestCase):
    def setUp(self):
        location = Path(__file__).with_name("generate-fixtures.py")
        if not location.is_file():
            self.fail("Synthetic media fixture generator is not implemented")
        spec = importlib.util.spec_from_file_location(
            "media_fixture_generator", location
        )
        self.generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.generator)

    def test_catalog_covers_duration_size_and_track_selection_boundaries(self):
        catalog = {item["id"]: item for item in self.generator.catalog()}
        for identifier in (
            "audio-300s",
            "audio-900s",
            "audio-1800s",
            "duration-below",
            "duration-exact",
            "duration-above",
            "bytes-below",
            "bytes-exact",
            "bytes-above",
            "video-default-second",
            "video-no-audio",
            "corrupt-audio",
        ):
            self.assertIn(identifier, catalog)
        self.assertEqual(catalog["duration-exact"]["durationSeconds"], 1800)
        self.assertGreater(catalog["duration-above"]["durationSeconds"], 1800)
        self.assertEqual(catalog["bytes-exact"]["bytes"], 100_000_000)
        self.assertEqual(catalog["bytes-exact"]["kind"], "transport")
        self.assertEqual(catalog["video-default-second"]["defaultAudioTrack"], 1)

    def test_transport_fixture_is_not_reported_as_valid_media(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "fixtures"
            report = self.generator.generate(output, ["bytes-exact", "corrupt-audio"])
            self.assertEqual(report["schemaVersion"], 1)
            transport, invalid = report["fixtures"]
            self.assertEqual(transport["actualBytes"], 100_000_000)
            self.assertIsNone(transport["measuredDurationSeconds"])
            self.assertEqual(transport["kind"], "transport")
            self.assertEqual(invalid["expected"], "reject")
            self.assertEqual(len(transport["sha256"]), 64)
            self.assertEqual(json.loads((output / "manifest.json").read_text()), report)

    def test_existing_output_or_unknown_fixture_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "existing"
            output.mkdir()
            sentinel = output / "keep.txt"
            sentinel.write_text("preserve")
            with self.assertRaises(FileExistsError):
                self.generator.generate(output, ["corrupt-audio"])
            self.assertEqual(sentinel.read_text(), "preserve")
            unknown = Path(temp) / "unknown"
            with self.assertRaises(ValueError):
                self.generator.generate(unknown, ["not-a-fixture"])
            self.assertFalse(unknown.exists())

    @unittest.skipUnless(
        shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg tools unavailable"
    )
    def test_smoke_media_has_audio_only_and_video_default_second(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "fixtures"
            report = self.generator.generate(
                output, ["audio-smoke", "video-default-second"]
            )
            self.assertEqual(len(report["fixtures"]), 2)
            for item in report["fixtures"]:
                self.assertGreater(item["measuredDurationSeconds"], 0)
                self.assertGreater(item["actualBytes"], 0)
            audio = report["fixtures"][0]
            self.assertEqual(audio["streamTypes"], ["audio"])
            video = report["fixtures"][1]
            self.assertEqual(video["streamTypes"].count("audio"), 2)
            data = json.loads(
                subprocess.check_output(
                    [
                        "ffprobe",
                        "-v",
                        "error",
                        "-show_streams",
                        "-of",
                        "json",
                        str(output / video["file"]),
                    ]
                )
            )
            tracks = [s for s in data["streams"] if s["codec_type"] == "audio"]
            self.assertEqual([t["disposition"]["default"] for t in tracks], [0, 1])


if __name__ == "__main__":
    unittest.main()
