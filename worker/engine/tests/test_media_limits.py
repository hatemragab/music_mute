from __future__ import annotations

import sys
import tempfile
import time
import unittest

import numpy as np
import soundfile as sf
from pathlib import Path
from subprocess import CompletedProcess
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
    encode_mp3,
    output_bitrate_kbps,
    inspect_lossless_audio,
    probe_audio,
    verify_input_identity,
    validate_mp3,
    validate_mp3_metadata,
    AudioInfo,
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
    def test_noisy_tool_is_killed_before_its_timeout(self) -> None:
        for stream in ("stdout", "stderr"):
            with self.subTest(stream=stream):
                started = time.monotonic()
                with self.assertRaisesRegex(MediaProcessingError, "noisy tool"):
                    _run([
                        sys.executable, "-B", "-c",
                        f"import sys,time; sys.{stream}.write('x'*131072); "
                        f"sys.{stream}.flush(); time.sleep(30)",
                    ], 10, "noisy tool")
                self.assertLess(time.monotonic() - started, 5)

    def test_tool_timeout_and_normal_output_are_preserved(self) -> None:
        result = _run([sys.executable, "-B", "-c", "print('ok')"], 5, "failed")
        self.assertEqual(result.stdout, "ok\n")
        with self.assertRaisesRegex(MediaProcessingError, "timed out"):
            _run([sys.executable, "-B", "-c", "import time; time.sleep(30)"], 0.1, "timed out")

    def test_pcm16_validation_skips_sample_scan_but_rejects_truncation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "prepared.wav"
            sf.write(source, np.zeros((4410, 2)), 44100, subtype="PCM_16")
            with patch.object(sf.SoundFile, "blocks", side_effect=AssertionError("scan")):
                info = inspect_lossless_audio(source, require_pcm16=True)
                self.assertEqual(info.samples, 4410)
                source.write_bytes(source.read_bytes()[:-16])
                with self.assertRaises(MediaProcessingError):
                    inspect_lossless_audio(source, require_pcm16=True)

    def test_float_audio_still_rejects_non_finite_samples(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "float.wav"
            sf.write(source, np.full((100, 2), np.nan), 44100, subtype="FLOAT")
            with self.assertRaisesRegex(MediaProcessingError, "non-finite"):
                inspect_lossless_audio(source)
            with self.assertRaisesRegex(MediaProcessingError, "format"):
                inspect_lossless_audio(source, require_pcm16=True)

    def test_intermediate_metadata_skips_hash_but_final_output_keeps_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "output.mp3"
            source.write_bytes(b"fixture")
            info = AudioInfo(1, 44100, 2)
            with patch("musicmute_engine.media.probe_audio", return_value=info), patch(
                "musicmute_engine.media.sha256_base64", return_value="digest"
            ) as digest:
                self.assertEqual(validate_mp3_metadata(source, Path("/ffprobe")), info)
                digest.assert_not_called()
                _, identity = validate_mp3(source, Path("/ffprobe"))
                self.assertEqual(identity.sha256, "digest")
                digest.assert_called_once_with(source)

    def test_final_mp3_encoding_uses_the_catalog_bitrate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "vocals.wav"
            source.write_bytes(b"fixture")
            ffmpeg = root / "ffmpeg"
            ffmpeg.write_bytes(b"tool")
            ffmpeg.chmod(0o700)
            destination = root / "output" / "vocals.mp3"
            with patch("musicmute_engine.media._run_ffmpeg") as execute:
                self.assertEqual(encode_mp3(source, destination, ffmpeg), destination)
            arguments = execute.call_args.args[2]
            self.assertEqual(arguments[arguments.index("-b:a") + 1], "160k")
            self.assertEqual(arguments[arguments.index("-compression_level") + 1], "7")
            self.assertEqual(arguments[arguments.index("-ar") + 1], "44100")
            self.assertEqual(arguments[arguments.index("-ac") + 1], "2")

    def test_output_bitrate_never_raises_a_known_lower_input_rate(self) -> None:
        self.assertEqual(output_bitrate_kbps(64_000), 64)
        self.assertEqual(output_bitrate_kbps(138_347), 128)
        self.assertEqual(output_bitrate_kbps(160_000), 160)
        self.assertEqual(output_bitrate_kbps(256_000), 160)
        self.assertEqual(output_bitrate_kbps(None), 160)
        with self.assertRaisesRegex(MediaProcessingError, "below supported"):
            output_bitrate_kbps(24_000)

    def test_existing_audio_probe_reads_stream_bitrate_without_another_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.mp3"
            source.write_bytes(b"fixture")
            ffprobe = root / "ffprobe"
            ffprobe.write_bytes(b"tool")
            ffprobe.chmod(0o700)
            response = CompletedProcess(
                args=[],
                returncode=0,
                stdout=(
                    '{"streams":[{"sample_rate":"44100","channels":2,'
                    '"bit_rate":"128000"}],"format":{"duration":"180.0"}}'
                ),
                stderr="",
            )
            with patch("musicmute_engine.media._run", return_value=response) as execute:
                info = probe_audio(source, ffprobe)
            self.assertEqual(execute.call_count, 1)
            self.assertIn("stream=sample_rate,channels,bit_rate:format=duration", execute.call_args.args[0])
            self.assertEqual(info.bit_rate, 128_000)
            self.assertEqual(output_bitrate_kbps(info.bit_rate), 128)

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
            "-B",
            "-c",
            f"import sys; sys.stdout.write('x' * {MAX_TOOL_OUTPUT_BYTES + 1})",
        ]
        with self.assertRaisesRegex(MediaProcessingError, "bounded output"):
            _run(command, 5, "bounded output")


if __name__ == "__main__":
    unittest.main()
