from __future__ import annotations

import shutil
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf

from musicmute_engine.media import sha256_base64
from musicmute_engine.pipeline import ProcessRequest, ProcessingFailure, RuntimePipeline
from musicmute_engine.recipes import RECIPE_DEFINITIONS, recipe_snapshot

RATE = 44_100


class FakeSeparator:
    def __init__(self) -> None:
        self.calls = 0

    def separate(self, source: Path, output_directory: Path) -> Path:
        self.calls += 1
        output_directory.mkdir(parents=True, exist_ok=True)
        audio, rate = sf.read(source, dtype="float32", always_2d=True)
        output = output_directory / "vocals.flac"
        sf.write(output, audio, rate, format="FLAC", subtype="PCM_16")
        return output


class PipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if not ffmpeg or not ffprobe:
            self.fail("D2 tests require ffmpeg and ffprobe")
        self.ffmpeg = str(Path(ffmpeg).resolve(strict=True))
        self.ffprobe = str(Path(ffprobe).resolve(strict=True))

    def test_each_recipe_runs_one_kim_vocal_2_pass_and_reuses_model(self) -> None:
        frames = np.arange(RATE, dtype=np.float32)
        wave = 0.25 * np.sin(2 * np.pi * 440 * frames / RATE)
        tone = np.column_stack((wave, wave))
        audio = np.concatenate((tone, np.zeros_like(tone), tone))
        fake = FakeSeparator()
        pipeline = RuntimePipeline(lambda _provider, _model, _device: fake)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "models"
            cache.mkdir()
            model = root / "qualified.onnx"
            model.write_bytes(b"test-only-model-sentinel")
            for recipe_id, definition in RECIPE_DEFINITIONS.items():
                attempt_id = str(uuid.uuid4())
                attempt = root / attempt_id
                attempt.mkdir()
                source = attempt / "input.wav"
                sf.write(source, audio, RATE, subtype="PCM_16")
                request = ProcessRequest.from_payload(
                    self.payload(attempt_id, attempt, source, cache, recipe_id)
                )
                with patch(
                    "musicmute_engine.pipeline.verified_cached_model",
                    return_value=model,
                ):
                    result = pipeline.process(request)
                timings = result["stageTimings"]
                self.assertEqual("denoise" in timings, definition.denoise_enabled)
                self.assertEqual("trim" in timings, definition.trim_enabled)
                self.assertEqual(result["trimEnabled"], definition.trim_enabled)
                self.assertEqual(result["denoiseEnabled"], definition.denoise_enabled)
                self.assertEqual(result["contentType"], "audio/mpeg")
                self.assertTrue(Path(result["outputPath"]).is_file())
                if definition.trim_enabled:
                    self.assertGreater(result["removedSamples"], 0)
                else:
                    self.assertEqual(result["removedSamples"], 0)
                    self.assertEqual(result["editMap"]["rangeCount"], 1)
            self.assertEqual(fake.calls, len(RECIPE_DEFINITIONS))

    def test_request_rejects_recipe_tampering_and_untrusted_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            attempt_id = str(uuid.uuid4())
            attempt = root / attempt_id
            attempt.mkdir()
            source = attempt / "input.wav"
            source.write_bytes(b"input")
            cache = root / "models"
            cache.mkdir()
            payload = self.payload(
                attempt_id, attempt, source, cache, "kim-vocals-v2"
            )
            payload["recipe"] = {**payload["recipe"], "outputBitrateKbps": 192}
            with self.assertRaises(ProcessingFailure):
                ProcessRequest.from_payload(payload)
            payload = self.payload(
                attempt_id, attempt, source, cache, "kim-vocals-v2"
            )
            payload["attemptDirectory"] = str(root / "wrong-name")
            with self.assertRaises(ProcessingFailure):
                ProcessRequest.from_payload(payload)

    def test_preload_reuses_the_same_separator_for_processing(self) -> None:
        fake = FakeSeparator()
        factory_calls: list[tuple[str, Path, int]] = []

        def factory(provider: str, model: Path, device: int) -> FakeSeparator:
            factory_calls.append((provider, model, device))
            return fake

        pipeline = RuntimePipeline(factory)  # type: ignore[arg-type]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "models"
            cache.mkdir()
            model = root / "qualified.onnx"
            model.write_bytes(b"test-only-model-sentinel")
            with patch(
                "musicmute_engine.pipeline.verified_cached_model",
                return_value=model,
            ):
                pipeline.preload(cache, "mps")
                pipeline.preload(cache, "mps")

        self.assertEqual(factory_calls, [("mps", model, 0)])

    def payload(
        self,
        attempt_id: str,
        attempt: Path,
        source: Path,
        cache: Path,
        recipe_id: str,
    ) -> dict[str, object]:
        return {
            "attemptId": attempt_id,
            "attemptDirectory": str(attempt),
            "input": {
                "path": str(source),
                "bytes": source.stat().st_size,
                "sha256": sha256_base64(source),
            },
            "modelCacheRoot": str(cache),
            "provider": "mps",
            "directmlDeviceId": 0,
            "ffmpegPath": self.ffmpeg,
            "ffprobePath": self.ffprobe,
            "recipe": recipe_snapshot(recipe_id),
        }


if __name__ == "__main__":
    unittest.main()
