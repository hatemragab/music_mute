import importlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from musicmute_worker.worker import MediaError, inspect_audio


def version_two_limits(**updates):
    return {
        "policyVersion": 2,
        "maxDurationSeconds": 1800,
        "durationInclusive": True,
        "maxInputBytes": 100_000_000,
        "inputBytesInclusive": True,
        "maxOutputBytes": 100_000_000,
        "outputBytesInclusive": True,
        "probeTimeoutSeconds": 45,
        "processingTimeoutSeconds": 3600,
        "costModelRevision": "synthetic-test-model",
        **updates,
    }


class MediaLimitsTests(unittest.TestCase):
    def setUp(self):
        try:
            self.module = importlib.import_module("musicmute_worker.media_limits")
        except ModuleNotFoundError:
            self.fail("Versioned media limits are not implemented")

    def test_version_two_boundaries_are_inclusive(self):
        limits = self.module.effective_media_limits(
            {"processingLimits": version_two_limits()}, 100_000_000, 7200
        )
        self.assertTrue(limits.accepts_duration(1800))
        self.assertFalse(limits.accepts_duration(1800.001))
        self.assertTrue(limits.accepts_input_bytes(100_000_000))
        self.assertFalse(limits.accepts_input_bytes(100_000_001))
        self.assertFalse(limits.accepts_output_bytes(100_000_000))
        self.assertFalse(limits.accepts_duration(float("nan")))
        self.assertFalse(limits.accepts_input_bytes(True))

    def test_legacy_remains_exclusive_and_local_safety_is_stricter(self):
        limits = self.module.effective_media_limits({}, 30_000_000, 7200)
        self.assertTrue(limits.accepts_duration(599.999))
        self.assertFalse(limits.accepts_duration(600))
        self.assertFalse(limits.accepts_input_bytes(30_000_000))
        newer = self.module.effective_media_limits(
            {"processingLimits": version_two_limits()}, 30_000_000, 120
        )
        self.assertEqual(newer.processing_timeout_seconds, 120)
        self.assertFalse(newer.accepts_output_bytes(30_000_001))
        self.assertFalse(newer.accepts_output_bytes(30_000_000))

    def test_server_output_boundary_is_inclusive_only_below_local_ceiling(self):
        limits = self.module.effective_media_limits(
            {"processingLimits": version_two_limits(maxOutputBytes=99_000_000)},
            100_000_000,
            7200,
        )
        self.assertTrue(limits.accepts_output_bytes(99_000_000))

    def test_malformed_or_unsupported_caps_are_rejected(self):
        for updates in (
            {"policyVersion": 3},
            {"maxDurationSeconds": 1801},
            {"maxInputBytes": True},
            {"maxOutputBytes": 100_000_001},
            {"probeTimeoutSeconds": 0},
            {"durationInclusive": "true"},
        ):
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                self.module.effective_media_limits(
                    {"processingLimits": version_two_limits(**updates)},
                    100_000_000,
                    7200,
                )


class PreparedAudioInspectionTests(unittest.TestCase):
    def test_v2_rejects_unknown_or_multichannel_before_decode(self):
        from musicmute_worker.media_limits import effective_media_limits

        limits = effective_media_limits({"processingLimits": version_two_limits()})
        for channels in (None, 0, 6):
            calls = []

            class Runner:
                def run(self, command, **options):
                    calls.append(command)
                    return subprocess.CompletedProcess(
                        command,
                        0,
                        json.dumps(
                            {
                                "streams": [
                                    {
                                        "codec_type": "audio",
                                        "codec_name": "aac",
                                        "channels": channels,
                                        "sample_rate": "48000",
                                    }
                                ]
                            }
                        ),
                        "",
                    )

            with tempfile.TemporaryDirectory() as folder:
                source = Path(folder) / "input.m4a"
                source.write_bytes(b"synthetic")
                with self.subTest(channels=channels), self.assertRaises(MediaError):
                    inspect_audio(
                        source,
                        Runner(),
                        lambda: None,
                        limits=limits,
                        ffmpeg=source,
                        ffprobe=source,
                    )
            self.assertEqual(len(calls), 1)

    def test_video_bearing_prepared_input_is_rejected_before_decode(self):
        calls = []

        class Runner:
            def run(self, command, **options):
                calls.append(command)
                if "-show_entries" in command:
                    return subprocess.CompletedProcess(
                        command,
                        0,
                        json.dumps(
                            {
                                "streams": [
                                    {"codec_type": "audio", "codec_name": "aac"},
                                    {"codec_type": "video", "codec_name": "h264"},
                                ]
                            }
                        ),
                        "",
                    )
                return subprocess.CompletedProcess(
                    command, 0, "out_time_us=1000000\n", ""
                )

        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "input.mp4"
            source.write_bytes(b"synthetic")
            with self.assertRaises(MediaError):
                inspect_audio(
                    source, Runner(), lambda: None, ffmpeg=source, ffprobe=source
                )
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
