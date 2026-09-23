from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import MagicMock, patch

from musicmute_engine.benchmark_file import code_digest, main
from musicmute_engine.qualification import QualificationError, run_qualification


class FakeSeparator:
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
            "outputBitrateKbps": 128,
            "stageTimings": {"separation": 90.0},
        }


class BenchmarkFileTests(unittest.TestCase):
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
                provider="mps",
                directml_device_id=0,
                recipe_id="kim-vocals-v2",
                iterations=5,
                warmup_runs=1,
                benchmark_mode=True,
                save_audio_dir=root / "saved",
                progress=events.append,
            )
            with (
                patch("musicmute_engine.qualification.platform.system", return_value="Darwin"),
                patch("musicmute_engine.qualification.service_identity", return_value="tester"),
                patch("musicmute_engine.qualification.collect_diagnostics", return_value={"status": "ok"}),
                patch("musicmute_engine.qualification.RuntimePipeline", FakePipeline),
                patch("musicmute_engine.qualification.KimSeparator", return_value=FakeSeparator()),
                patch("musicmute_engine.qualification.discover_provider"),
                patch.dict("sys.modules", {"torch": torch}),
            ):
                result = run_qualification(arguments)
            pipeline = FakePipeline.instances[0]
            self.assertEqual(len(FakePipeline.instances), 1)
            self.assertEqual(pipeline.preload_count, 1)
            self.assertEqual(pipeline.process_count, 5)
            recipes = result["recipes"]
            self.assertEqual([run["role"] for run in recipes],
                             ["cold", "warmup", "measured", "measured", "measured"])
            self.assertEqual(len(list(arguments.save_audio_dir.glob("*.mp3"))), 5)
            self.assertEqual(len(list(arguments.save_audio_dir.glob("*.flac"))), 5)
            artifacts = result["savedAudioArtifacts"]
            self.assertEqual(len(artifacts), 10)
            self.assertEqual([item["format"] for item in artifacts[:2]], ["mp3", "flac"])
            for artifact in artifacts:
                saved = arguments.save_audio_dir / artifact["fileName"]
                self.assertEqual(artifact["bytes"], saved.stat().st_size)
                self.assertEqual(artifact["sha256"], hashlib.sha256(saved.read_bytes()).hexdigest())
            self.assertEqual(arguments.save_audio_dir.stat().st_mode & 0o777, 0o700)
            self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600
                                for path in arguments.save_audio_dir.iterdir()))
            self.assertEqual(len([event for event in events if event["type"] == "run-complete"]), 5)
            self.assertEqual(recipes[0]["gpuMemoryBefore"], {
                "tensorAllocatedBytes": 100, "driverAllocatedBytes": 200,
            })

    def test_failed_run_writes_private_partial_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / "fixture.wav"
            fixture.write_bytes(b"synthetic")
            report = root / "report.json"
            arguments = Namespace(
                candidate_engine_root=None,
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
