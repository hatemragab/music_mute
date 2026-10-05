from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import soundfile as sf

from musicmute_engine.benchmark_file import build_report, code_digest, main
from musicmute_engine.qualification import QualificationError, run_qualification


class FakeSeparator:
    def finish_profiles(self) -> tuple[Path, ...]:
        return ()

    def mps_dispatch_evidence(self) -> dict[str, object]:
        return {"proven": True, "acceleratedNodeEvents": 1, "cpuNodeEvents": 0}

    def grouping_evidence(self) -> dict[str, int]:
        return {"selectedSize": 1, "processedWindows": 4, "modelCalls": 4, "largestBatch": 1}


class FakePipeline:
    instances: list[FakePipeline] = []

    def __init__(self, factory) -> None:
        self.factory = factory
        self.preload_count = 0
        self.process_count = 0
        self.separator = None
        self.instances.append(self)

    def preload(self, model_cache, provider, directml_device_id, progress=None) -> None:
        self.preload_count += 1
        self.separator = self.factory(provider, model_cache / "model.onnx", directml_device_id)
        if progress:
            progress("loading")

    def process(self, request, progress=None) -> dict[str, object]:
        self.process_count += 1
        if progress:
            progress("separation")
        output = request.attempt_directory / "vocals.mp3"
        output.write_bytes(b"fake-mp3-result")
        separated = request.attempt_directory / "separated"
        separated.mkdir()
        (separated / "vocals.flac").write_bytes(b"fake-flac-result")
        return {
            "outputPath": str(output),
            "bytes": output.stat().st_size,
            "recipeId": request.recipe["recipeId"],
            "recipeDigest": request.recipe["recipeDigest"],
            "sourceDurationSeconds": 180.0,
            "measuredInputDurationSeconds": 180.0,
            "measuredInputSamples": 7_938_000,
            "measuredOutputDurationSeconds": 180.0,
            "outputBitrateKbps": 160,
            "stageTimings": {"separation": 90.0},
        }


class BenchmarkFileTests(unittest.TestCase):
    def test_cli_benchmark_uses_mp3_wav_directly_and_cleans_other_formats(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if ffmpeg is None or ffprobe is None:
            self.fail("File benchmark test requires ffmpeg and ffprobe")

        class RecordingSeparator(FakeSeparator):
            def __init__(self) -> None:
                self.sources: list[Path] = []

            def separate(self, source: Path, output_directory: Path) -> Path:
                self.sources.append(source)
                output_directory.mkdir()
                output = output_directory / "vocals.mp3"
                subprocess.run(
                    [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(source),
                     "-c:a", "libmp3lame", "-b:a", "160k", "-ar", "44100",
                     "-ac", "2", str(output)],
                    check=True,
                )
                return output

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wave = root / "source.wav"
            frames = np.arange(44_100, dtype=np.float32)
            tone = 0.25 * np.sin(2 * np.pi * 440 * frames / 44_100)
            sf.write(wave, np.column_stack((tone, tone)), 44_100, subtype="PCM_16")
            release = root / "release"
            release.mkdir()
            (release / "release-manifest.json").write_text("{}")
            models = root / "models"
            models.mkdir()
            model = models / "qualified.onnx"
            model.write_bytes(b"test-only-model-sentinel")
            for extension, codec in (
                ("wav", None),
                ("mp3", "libmp3lame"),
                ("flac", "flac"),
                ("ogg", "opus"),
                ("webm", "opus"),
            ):
                with self.subTest(extension=extension):
                    fixture = root / f"song.{extension}"
                    if codec is None:
                        shutil.copyfile(wave, fixture)
                    else:
                        subprocess.run(
                            [ffmpeg, "-hide_banner", "-loglevel", "error", "-i",
                             str(wave), "-c:a", codec,
                             # Fixture generation uses FFmpeg's native encoder;
                             # production only needs Opus decoding, not libopus.
                             *(["-strict", "-2"] if codec == "opus" else []),
                             str(fixture)],
                            check=True,
                        )
                    work = root / f"work-{extension}"
                    work.mkdir()
                    separator = RecordingSeparator()
                    arguments = Namespace(
                        fixture=fixture,
                        fixture_sha256=hashlib.sha256(fixture.read_bytes()).hexdigest(),
                        work_root=work,
                        release_root=release,
                        model_cache=models,
                        ffmpeg=Path(ffmpeg),
                        ffprobe=Path(ffprobe),
                        provider="mps",
                        directml_device_id=0,
                        recipe_id="kim-vocals-v2",
                        iterations=1,
                        warmup_runs=0,
                        benchmark_mode=True,
                        group_size=1,
                        save_audio_dir=None,
                    )
                    torch = MagicMock()
                    with (
                        patch("musicmute_engine.qualification.platform.system", return_value="Darwin"),
                        patch("musicmute_engine.qualification.service_identity", return_value="tester"),
                        patch("musicmute_engine.qualification.collect_diagnostics", return_value={"status": "ok"}),
                        patch("musicmute_engine.qualification.KimSeparator", return_value=separator),
                        patch("musicmute_engine.qualification.discover_provider"),
                        patch("musicmute_engine.pipeline.verified_cached_model", return_value=model),
                        patch.dict("sys.modules", {"torch": torch}),
                    ):
                        result = run_qualification(arguments)
                    prepared = separator.sources[0]
                    direct = extension in ("mp3", "wav")
                    attempt = Path(result["uploadCandidate"]["path"]).parent.parent
                    self.assertEqual(
                        prepared,
                        attempt / (f"input.{extension}" if direct else "prepared.wav"),
                    )
                    self.assertEqual(
                        "preparation" in result["recipes"][0]["stageTimings"],
                        not direct,
                    )
                    self.assertFalse((attempt / "prepared.wav").exists())
                    self.assertFalse((attempt / f"input.{extension}").exists())
                    self.assertEqual(list(work.iterdir()), [])
                    self.assertTrue(fixture.is_file())

    def test_code_digest_changes_with_candidate_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "musicmute_engine"
            package.mkdir()
            source = package / "separator.py"
            source.write_text("GROUP_SIZE = 1\n")
            before = code_digest(root)
            source.write_text("GROUP_SIZE = 2\n")
            self.assertNotEqual(before, code_digest(root))

    def test_repeated_runs_share_one_preloaded_model_and_save_audio(self) -> None:
        self._assert_repeated_runs("mps")

    def test_directml_repeated_runs_use_service_identity_without_mps_calls(self) -> None:
        self._assert_repeated_runs("directml")

    def _assert_repeated_runs(self, provider: str) -> None:
        FakePipeline.instances.clear()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / "song.wav"
            fixture.write_bytes(b"synthetic-song")
            work = root / "work"
            work.mkdir()
            release = root / "release"
            release.mkdir()
            (release / "release-manifest.json").write_text("{}")
            models = root / "models"
            models.mkdir()
            executable = root / "ffmpeg"
            executable.write_text("fixture")
            events: list[dict[str, object]] = []
            torch = MagicMock()
            torch.mps.current_allocated_memory.return_value = 100
            torch.mps.driver_allocated_memory.return_value = 200
            arguments = Namespace(
                fixture=fixture,
                fixture_sha256=hashlib.sha256(fixture.read_bytes()).hexdigest(),
                work_root=work,
                release_root=release,
                model_cache=models,
                ffmpeg=executable,
                ffprobe=executable,
                provider=provider,
                directml_device_id=0,
                recipe_id="kim-vocals-v2",
                iterations=5,
                warmup_runs=1,
                benchmark_mode=True,
                save_audio_dir=root / "saved",
                progress=events.append,
            )
            boundaries = []
            arguments.before_measurement = lambda: boundaries.append(("ready", FakePipeline.instances[0].process_count))
            arguments.after_measurement = lambda seconds: boundaries.append(("measured", FakePipeline.instances[0].process_count, seconds))
            with (
                patch("musicmute_engine.qualification.platform.system", return_value="Windows" if provider == "directml" else "Darwin"),
                patch("musicmute_engine.qualification.service_identity", return_value="S-1-5-19" if provider == "directml" else "tester"),
                patch("musicmute_engine.qualification.collect_diagnostics", return_value={"status": "ok"}),
                patch("musicmute_engine.qualification.RuntimePipeline", FakePipeline),
                patch("musicmute_engine.qualification.KimSeparator", return_value=FakeSeparator()),
                patch("musicmute_engine.qualification.discover_provider"),
                patch("musicmute_engine.qualification.summarize_profiles", return_value={"proven": True, "acceleratedNodeEvents": 10, "cpuNodeEvents": 0}),
                patch.dict("sys.modules", {"torch": torch}),
            ):
                result = run_qualification(arguments)
            pipeline = FakePipeline.instances[0]
            self.assertEqual(len(FakePipeline.instances), 1)
            self.assertEqual(pipeline.preload_count, 1)
            self.assertEqual(pipeline.process_count, 5)
            self.assertEqual(boundaries[0], ("ready", 2))
            self.assertEqual(boundaries[1][:2], ("measured", 5))
            self.assertGreater(boundaries[1][2], 0)
            self.assertEqual(result["measuredWallSeconds"], boundaries[1][2])
            recipes = result["recipes"]
            self.assertEqual([run["role"] for run in recipes],
                             ["cold", "warmup", "measured", "measured", "measured"])
            self.assertEqual(len(list(arguments.save_audio_dir.glob("*.mp3"))), 5)
            self.assertEqual(len(list(arguments.save_audio_dir.glob("*.flac"))), 0)
            artifacts = result["savedAudioArtifacts"]
            self.assertEqual(len(artifacts), 5)
            self.assertEqual([item["format"] for item in artifacts[:1]], ["mp3"])
            for artifact in artifacts:
                saved = arguments.save_audio_dir / artifact["fileName"]
                self.assertEqual(artifact["bytes"], saved.stat().st_size)
                self.assertEqual(artifact["sha256"], hashlib.sha256(saved.read_bytes()).hexdigest())
            # Windows access is governed by ACLs; st_mode does not report them.
            # Native installation/benchmark acceptance verifies those ACLs.
            if os.name != "nt" and provider == "mps":
                self.assertEqual(arguments.save_audio_dir.stat().st_mode & 0o777, 0o700)
                self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600
                                    for path in arguments.save_audio_dir.iterdir()))
            self.assertEqual(len([event for event in events if event["type"] == "run-complete"]), 5)
            if provider == "mps":
                self.assertEqual(recipes[0]["gpuMemoryBefore"], {
                    "tensorAllocatedBytes": 100, "driverAllocatedBytes": 200,
                })
            else:
                self.assertTrue(all(run["gpuMemoryBefore"] is None and run["gpuMemoryAfter"] is None for run in recipes))
                self.assertEqual(torch.mps.mock_calls, [])

    def test_directml_report_distinguishes_capacity_dispatch_and_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "input.wav"
            fixture.write_bytes(b"fixture")
            arguments = Namespace(
                provider="directml", directml_device_id=0, fixture=fixture,
                recipe_id="kim-vocals-v2", warmup_runs=1, measured_runs=3,
                candidate_engine_root=None, group_size=1, save_audio_dir=None,
            )
            raw = {
                "recipes": [{"recipeDigest": "a" * 64, "measuredInputDurationSeconds": 12,
                             "measuredInputSamples": 529200, "outputBitrateKbps": 160}] * 5,
                "runtimeDiagnostics": {"python": "3.12.10"},
                "releaseManifestDigest": "b" * 64, "fixtureDigest": "c" * 64,
                "modelDigest": "d" * 64, "preloadSeconds": 1,
                "serviceIdentity": "S-1-5-19", "totalSeconds": 5,
                "providerDispatch": {"proven": True, "acceleratedNodeEvents": 10, "cpuNodeEvents": 0},
                "savedAudioArtifacts": [],
            }
            identity = {"name": "Radeon RX 580", "source": "DXGI EnumAdapters1/GetDesc1", "dedicatedVideoMemoryBytes": 8 * 1024 ** 3}
            with (
                patch("musicmute_engine.windows_gpu.adapter_identity", return_value=identity),
                patch("musicmute_engine.benchmark_file.gpu_model", side_effect=AssertionError("macOS probe on Windows")),
            ):
                report = build_report(raw, arguments, "e" * 64)
            self.assertEqual(report["provider"], "directml")
            self.assertFalse(report["fallbackDisabled"])
            self.assertTrue(report["providerDispatch"]["proven"])
            self.assertEqual(report["gpuIdentity"], identity)
            self.assertIn("unavailable", report["memoryScope"])

    def test_failed_run_writes_private_partial_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / "fixture.wav"
            fixture.write_bytes(b"synthetic")
            report = root / "report.json"
            arguments = Namespace(
                candidate_engine_root=None,
                provider="mps",
                fixture=fixture,
                fixture_sha256=hashlib.sha256(fixture.read_bytes()).hexdigest(),
                recipe_id="kim-vocals-v2",
                warmup_runs=1,
                measured_runs=3,
                save_audio_dir=None,
                report=report,
            )
            with (
                patch("musicmute_engine.benchmark_file.parse_args", return_value=arguments),
                patch("musicmute_engine.benchmark_file.run_qualification",
                      side_effect=QualificationError("Model cache unavailable")),
            ):
                self.assertEqual(main(), 1)
            value = json.loads(report.read_text())
            self.assertEqual(value["status"], "FAIL")
            self.assertEqual(value["code"], "QualificationError")
            if os.name != "nt":
                self.assertEqual(report.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
