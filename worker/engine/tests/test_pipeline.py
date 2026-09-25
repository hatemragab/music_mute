from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf

from musicmute_engine.media import sha256_base64
from musicmute_engine.pipeline import (
    ProcessRequest,
    ProcessingFailure,
    RuntimePipeline,
    is_positive_gpu_oom,
)
from musicmute_engine.recipes import RECIPE_DEFINITIONS, recipe_snapshot
from musicmute_engine.separator import SeparatorError

RATE = 44_100


class FakeSeparator:
    def __init__(self) -> None:
        self.calls = 0
        self.sources: list[Path] = []

    def separate(self, source: Path, output_directory: Path, on_window_progress=None) -> Path:
        self.calls += 1
        self.sources.append(source)
        output_directory.mkdir(parents=True, exist_ok=True)
        output = output_directory / "vocals.wav"
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            raise RuntimeError("ffmpeg is required to write the test vocal")
        completed = subprocess.run(
            [
                ffmpeg,
                "-y",
                "-i",
                str(source),
                "-vn",
                "-c:a",
                "pcm_s16le",
                "-ar",
                "44100",
                "-ac",
                "2",
                str(output),
            ],
            check=False,
            capture_output=True,
        )
        if completed.returncode != 0 or not output.is_file():
            raise RuntimeError("test vocal mp3 was not written")
        return output


class PipelineTests(unittest.TestCase):
    def test_gpu_oom_requires_provider_evidence(self) -> None:
        try:
            raise RuntimeError("MPS backend out of memory")
        except RuntimeError as cause:
            wrapper = RuntimeError("Kim separation failed")
            wrapper.__cause__ = cause
        self.assertTrue(is_positive_gpu_oom(wrapper))
        self.assertFalse(is_positive_gpu_oom(TimeoutError("request timed out")))
        self.assertFalse(is_positive_gpu_oom(RuntimeError("out of memory")))

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
        fake.last_separation_timings = {"separationMatchMix": 0.0}
        pipeline = RuntimePipeline(lambda _provider, _model, _device: fake)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "models"
            cache.mkdir()
            model = root / "qualified.onnx"
            model.write_bytes(b"test-only-model-sentinel")
            uncompressed = root / "source.wav"
            sf.write(uncompressed, audio, RATE, subtype="PCM_16")
            for recipe_id, trim_enabled in [(name, enabled) for name in RECIPE_DEFINITIONS for enabled in (True, False)]:
                attempt_id = str(uuid.uuid4())
                attempt = root / attempt_id
                attempt.mkdir()
                source = attempt / "input.mp3"
                subprocess.run(
                    [self.ffmpeg, "-y", "-loglevel", "error", "-i", str(uncompressed),
                     "-c:a", "libmp3lame", "-b:a", "160k", str(source)],
                    check=True,
                )
                request = ProcessRequest.from_payload(
                    {**self.payload(attempt_id, attempt, source, cache, recipe_id),
                     "recipe": recipe_snapshot(recipe_id, trim_enabled)}
                )
                with patch(
                    "musicmute_engine.pipeline.verified_cached_model",
                    return_value=model,
                ) as verify:
                    stages: list[str] = []
                    result = pipeline.process(request, stages.append)
                    self.assertEqual(verify.call_count, 1 if fake.calls == 1 else 0)
                expected_stages = ["input-validation", "model-load", "separation"]
                if trim_enabled:
                    expected_stages.append("trim")
                expected_stages.append("encoding")
                expected_stages.extend(("output-validation", "output-ready"))
                self.assertEqual(stages, expected_stages)
                self.assertNotIn("preparation", stages)
                self.assertNotIn("denoise", stages)
                self.assertEqual(result["separationTimings"], {"separationMatchMix": 0.0})
                timings = result["stageTimings"]
                self.assertNotIn("denoise", timings)
                self.assertNotIn("preparation", timings)
                self.assertEqual("trim" in timings, trim_enabled)
                self.assertIn("encode", timings)
                self.assertIn("separation", timings)
                self.assertEqual(result["trimEnabled"], trim_enabled)
                self.assertEqual(result["denoiseEnabled"], False)
                self.assertEqual(result["contentType"], "audio/mpeg")
                self.assertEqual(result["outputBitrateKbps"], 160)
                if trim_enabled:
                    self.assertGreater(result["removedSamples"], 0)
                    self.assertGreater(result["editMap"]["rangeCount"], 1)
                else:
                    self.assertEqual(result["removedSamples"], 0)
                    self.assertEqual(result["sourceSamples"], result["outputSamples"])
                    self.assertEqual(result["editMap"]["rangeCount"], 1)
                self.assertTrue(Path(result["outputPath"]).is_file())
                self.assertEqual(list(attempt.rglob("*.wav")), [])
                self.assertEqual(Path(result["outputPath"]).suffix, ".mp3")
            self.assertEqual(fake.calls, 2 * len(RECIPE_DEFINITIONS))
            self.assertTrue(all(source.suffix == ".mp3" for source in fake.sources))

    def test_non_mp3_inputs_are_decoded_before_separation(self) -> None:
        audio = np.zeros((RATE, 2), dtype=np.float32)
        fake = FakeSeparator()
        pipeline = RuntimePipeline(lambda _provider, _model, _device: fake)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "models"
            cache.mkdir()
            model = root / "qualified.onnx"
            model.write_bytes(b"test-only-model-sentinel")
            source_wav = root / "source.wav"
            sf.write(source_wav, audio, RATE, subtype="PCM_16")
            for extension, format_args in (
                ("m4a", []),
                ("bin", ["-f", "adts"]),
            ):
                with self.subTest(extension=extension):
                    attempt_id = str(uuid.uuid4())
                    attempt = root / attempt_id
                    attempt.mkdir()
                    source = attempt / f"input.{extension}"
                    subprocess.run(
                        [
                            self.ffmpeg, "-y", "-loglevel", "error", "-i",
                            str(source_wav), "-c:a", "aac", *format_args,
                            str(source),
                        ],
                        check=True,
                    )
                    request = ProcessRequest.from_payload(
                        self.payload(attempt_id, attempt, source, cache, "kim-vocals-v2")
                    )
                    stages: list[str] = []
                    with patch(
                        "musicmute_engine.pipeline.verified_cached_model",
                        return_value=model,
                    ):
                        result = pipeline.process(request, stages.append)
                    self.assertEqual(
                        stages,
                        ["input-validation", "preparation", "model-load",
                         "separation", "trim", "encoding", "output-validation", "output-ready"],
                    )
                    self.assertEqual(
                        fake.sources[-1], (attempt / "prepared.wav").resolve()
                    )
                    self.assertIn("preparation", result["stageTimings"])
                    self.assertTrue(Path(result["outputPath"]).is_file())
                    self.assertFalse((attempt / "prepared.wav").exists())

    def test_prepared_wav_is_removed_when_separation_fails(self) -> None:
        fake = FakeSeparator()
        pipeline = RuntimePipeline(lambda _provider, _model, _device: fake)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "models"
            cache.mkdir()
            model = root / "qualified.onnx"
            model.write_bytes(b"test-only-model-sentinel")
            attempt_id = str(uuid.uuid4())
            attempt = root / attempt_id
            attempt.mkdir()
            source = attempt / "input.m4a"
            subprocess.run(
                [
                    self.ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi",
                    "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:a", "aac",
                    str(source),
                ],
                check=True,
            )
            request = ProcessRequest.from_payload(
                self.payload(attempt_id, attempt, source, cache, "kim-vocals-v2")
            )

            def fail_separation(prepared: Path, _output: Path) -> Path:
                self.assertTrue(prepared.is_file())
                raise SeparatorError("test failure")

            with (
                patch("musicmute_engine.pipeline.verified_cached_model", return_value=model),
                patch.object(fake, "separate", side_effect=fail_separation),
            ):
                with self.assertRaises(ProcessingFailure) as failure:
                    pipeline.process(request)
            self.assertEqual(failure.exception.code, "SEPARATOR_FAILED")
            self.assertTrue(source.is_file())
            self.assertFalse((attempt / "prepared.wav").exists())

    def test_temporary_wavs_are_cleaned_after_trim_or_encode_failure(self) -> None:
        from musicmute_engine.media import MediaProcessingError
        for operation, error in (("trim_vocal_gaps", ValueError("trim")),
                                 ("encode_mp3", MediaProcessingError("encode"))):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                attempt_id = str(uuid.uuid4())
                attempt = root / attempt_id
                attempt.mkdir()
                source = attempt / "input.wav"
                sf.write(source, np.zeros((RATE, 2)), RATE, subtype="PCM_16")
                pipeline = RuntimePipeline(lambda *_args: FakeSeparator())
                request = ProcessRequest.from_payload(self.payload(attempt_id, attempt, source, root / "models", "kim-vocals-v2"))
                def fail(*_args, **_kwargs):
                    (attempt / "trimmed.wav").write_bytes(b"partial")
                    raise error
                with patch("musicmute_engine.pipeline.verified_cached_model", return_value=root / "model"), patch(
                    "musicmute_engine.pipeline." + operation, side_effect=fail
                ), self.assertRaises(ProcessingFailure):
                    pipeline.process(request)
                self.assertTrue(source.is_file())
                self.assertFalse((attempt / "separated").exists())
                self.assertFalse((attempt / "trimmed.wav").exists())

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
            payload["recipe"] = {**payload["recipe"], "outputBitrateKbps": 320}
            with self.assertRaises(ProcessingFailure):
                ProcessRequest.from_payload(payload)
            payload = self.payload(
                attempt_id, attempt, source, cache, "kim-vocals-v2"
            )
            payload["attemptDirectory"] = str(root / "wrong-name")
            with self.assertRaises(ProcessingFailure):
                ProcessRequest.from_payload(payload)

    def test_failed_input_reports_only_the_observed_stage(self) -> None:
        pipeline = RuntimePipeline(lambda _provider, _model, _device: FakeSeparator())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            attempt_id = str(uuid.uuid4())
            attempt = root / attempt_id
            attempt.mkdir()
            source = attempt / "input.wav"
            source.write_bytes(b"invalid-audio")
            cache = root / "models"
            cache.mkdir()
            model = root / "qualified.onnx"
            model.write_bytes(b"test-only-model-sentinel")
            payload = self.payload(attempt_id, attempt, source, cache, "kim-vocals-v2")
            payload["input"] = {
                **payload["input"],  # type: ignore[dict-item]
                "sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            }
            request = ProcessRequest.from_payload(payload)
            stages: list[str] = []
            with patch(
                "musicmute_engine.pipeline.verified_cached_model",
                return_value=model,
            ), self.assertRaises(ProcessingFailure) as failure:
                pipeline.process(request, stages.append)
            self.assertEqual(failure.exception.code, "INPUT_CHECKSUM_MISMATCH")
            self.assertEqual(stages, ["input-validation"])

    def test_preload_reuses_the_same_separator_for_processing(self) -> None:
        fake = FakeSeparator()
        factory_calls: list[tuple[str, Path, int]] = []

        def factory(provider: str, model: Path, device: int) -> FakeSeparator:
            factory_calls.append((provider, model, device))
            return fake

        pipeline = RuntimePipeline(factory)  # type: ignore[arg-type]
        stages: list[str] = []
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
                pipeline.preload(cache, "mps", progress=stages.append)
                pipeline.preload(cache, "mps")

        self.assertEqual(factory_calls, [("mps", model, 0)])
        self.assertEqual(stages, ["loading"])

    def test_warm_model_verification_is_bound_to_child_and_cache(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "models"
            model = cache / "model.onnx"
            pipeline = RuntimePipeline(lambda *_args: FakeSeparator())
            with patch(
                "musicmute_engine.pipeline.verified_cached_model", return_value=model
            ) as verify:
                pipeline.preload(cache, "mps")
                pipeline.preload(cache, "mps")
                self.assertEqual(pipeline._verified_model(cache), model)
                verify.assert_called_once_with(cache)
                with self.assertRaises(ProcessingFailure) as changed:
                    pipeline.preload(Path(directory) / "other", "mps")
                self.assertEqual(changed.exception.code, "RUNTIME_CONFIG_CHANGED")
                with self.assertRaises(ProcessingFailure):
                    pipeline.preload(cache, "directml")
                fresh = RuntimePipeline(lambda *_args: FakeSeparator())
                fresh.preload(cache, "mps")
                self.assertEqual(verify.call_count, 2)

    def test_failed_model_load_does_not_cache_verification(self) -> None:
        pipeline = RuntimePipeline(lambda *_args: None)
        with patch(
            "musicmute_engine.pipeline.verified_cached_model", return_value=Path("/model")
        ) as verify, patch.object(
            pipeline, "_separator_factory", side_effect=SeparatorError("failed load")
        ):
            for _ in range(2):
                with self.assertRaises(ProcessingFailure):
                    pipeline.preload(Path("/cache"), "mps")
            self.assertEqual(verify.call_count, 2)

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
