from __future__ import annotations

import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np
import soundfile as sf

from musicmute_engine.separator import (
    KIM_VOCAL_2_OVERLAP,
    KimSeparator,
    _grouped_demix,
    _uvr_mps_model,
    _write_vocal_wav,
    _separate_primary_vocals,
    SeparatorError,
)


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
        callback = getattr(self.model_instance, "on_window_progress", None)
        if callback is not None:
            callback(1, 2)
            callback(2, 2)
        output = Path(self.output_dir) / f"{custom_output_names['Vocals']}.wav"
        audio = np.zeros((441, 2), dtype=np.float32)
        sf.write(output, audio, 44_100, format="WAV", subtype="PCM_16")
        return [output.name]


class FakeLoadedAudioSeparator:
    keyword_arguments: dict[str, object] = {}

    def __init__(self, **keyword_arguments: object) -> None:
        type(self).keyword_arguments = keyword_arguments
        self.model_instance = FakeWarmupModel()

    def load_model(self, *, model_filename: str) -> None:
        self.model_filename = model_filename


class FakeWarmupModel:
    def __init__(self) -> None:
        self.chunk_size = 0
        self.torch_device = "cpu"
        self.run_calls = 0

    def initialize_model_settings(self) -> None:
        self.chunk_size = 1024 * 255

    def run_model(self, window: object) -> np.ndarray:
        self.run_calls += 1
        shape = tuple(getattr(window, "shape", ()))
        return np.zeros(shape, dtype=np.float32)


class SeparatorIsolationTests(unittest.TestCase):
    def test_default_group_is_provider_specific(self) -> None:
        with patch("musicmute_engine.separator.verify_model", return_value=Path("model.onnx")), patch.object(KimSeparator, "_load"), patch.object(KimSeparator, "_warm_up"):
            self.assertEqual(KimSeparator("mps", Path("model.onnx")).group_size, 2)
            self.assertEqual(KimSeparator("directml", Path("model.onnx")).group_size, 1)
            self.assertEqual(KimSeparator("mps", Path("model.onnx"), group_size=1).group_size, 1)
            with self.assertRaises(SeparatorError):
                KimSeparator("directml", Path("model.onnx"), group_size=2)

    def test_primary_only_preserves_vocal_math_without_secondary_pass(self) -> None:
        mix = np.array([[0.1, -0.5, 0.2], [0.3, -0.2, 0.4]], dtype=np.float32)
        normalized = mix * 2
        module = ModuleType("audio_separator.separator.uvr_lib_v5")
        module.spec_utils = SimpleNamespace(normalize=Mock(return_value=normalized))
        model = SimpleNamespace(
            primary_stem_name="Vocals", output_single_stem="Vocals",
            normalization_threshold=0.9, amplification_threshold=0.0,
            prepare_mix=Mock(return_value=mix), demix=Mock(return_value=normalized * 0.25),
            get_stem_output_path=Mock(return_value="vocals.wav"), final_process=Mock(),
            separation_timings={}, secondary_source=None,
        )
        with patch.dict("sys.modules", {"audio_separator.separator.uvr_lib_v5": module}):
            result = _separate_primary_vocals(model, "/input/song.wav", {"Vocals": "vocals"})
        self.assertEqual(result, ["vocals.wav"])
        model.demix.assert_called_once_with(normalized)
        np.testing.assert_array_equal(model.primary_source, (normalized * 0.25 * 0.5).T)
        self.assertIsNone(model.secondary_source)
        self.assertEqual(model.separation_timings["separationMatchMix"], 0)
        self.assertTrue(all(value >= 0 for value in model.separation_timings.values()))
        model.output_single_stem = "Instrumental"
        with self.assertRaises(SeparatorError):
            _separate_primary_vocals(model, "/input/song.wav")

    def test_grouped_demix_preserves_order_overlap_and_partial_batch(self) -> None:
        class FakeTensor:
            def __init__(self, data: np.ndarray) -> None:
                self.data = data

            def to(self, _device: str) -> "FakeTensor":
                return self

        fake_torch = ModuleType("torch")
        fake_torch.float32 = np.float32  # type: ignore[attr-defined]
        fake_torch.tensor = lambda data, **_kwargs: FakeTensor(data)  # type: ignore[attr-defined]
        fake_torch.no_grad = nullcontext  # type: ignore[attr-defined]

        class FakeGroupedModel:
            overlap = 0.25
            torch_device = "mps"

            def __init__(self) -> None:
                self.batch_shapes: list[tuple[int, ...]] = []

            def initialize_model_settings(self) -> None:
                self.chunk_size = 16
                self.trim = 2

            def run_model(self, batch: FakeTensor) -> np.ndarray:
                self.batch_shapes.append(batch.data.shape)
                return batch.data.copy()

        song = np.stack(
            (np.arange(53, dtype=np.float32) / 100,
             np.arange(53, dtype=np.float32)[::-1] / 100)
        )
        with patch.dict("sys.modules", {"torch": fake_torch}):
            reference = FakeGroupedModel()
            expected = _grouped_demix(reference, song, 1)
            self.assertEqual(expected.shape, (2, 53))
            for size, calls in ((2, 3), (4, 2)):
                candidate = FakeGroupedModel()
                actual = _grouped_demix(candidate, song, size)
                np.testing.assert_array_equal(actual, expected)
                self.assertEqual(candidate.grouped_windows, 6)
                self.assertEqual(candidate.grouped_model_calls, calls)
                self.assertEqual(candidate.grouped_max_batch, size)
                self.assertEqual(candidate.batch_shapes[-1][0], 6 % size or size)
                self.assertTrue(np.isfinite(actual).all())

    def test_uvr_mps_model_converts_once_and_restores_upstream_class(self) -> None:
        architecture = ModuleType("audio_separator.separator.architectures")
        mdx_module = ModuleType(
            "audio_separator.separator.architectures.mdx_separator"
        )

        class UpstreamModel:
            def __init__(self) -> None:
                self.model_path = "model.onnx"
                self.torch_device = "mps"

        class Converted:
            def __init__(self) -> None:
                self.moves: list[str] = []

            def to(self, device: str) -> "Converted":
                self.moves.append(device)
                return self

            def eval(self) -> "Converted":
                return self

        converted = Converted()
        mdx_module.MDXSeparator = UpstreamModel  # type: ignore[attr-defined]
        architecture.mdx_separator = mdx_module  # type: ignore[attr-defined]
        converter = ModuleType("onnx2torch")
        converter.convert = lambda path: converted  # type: ignore[attr-defined]
        with patch.dict(
            "sys.modules",
            {
                "audio_separator.separator.architectures": architecture,
                "audio_separator.separator.architectures.mdx_separator": mdx_module,
                "onnx2torch": converter,
            },
        ):
            with _uvr_mps_model():
                model = mdx_module.MDXSeparator()  # type: ignore[attr-defined]
                model.load_model()
                self.assertIs(model.model_run, converted)
                self.assertTrue(model.uses_pytorch_inference)

        self.assertIs(mdx_module.MDXSeparator, UpstreamModel)  # type: ignore[attr-defined]
        self.assertEqual(converted.moves, ["mps"])

    def test_load_pins_uvr_default_mdx_windowing(self) -> None:
        audio_separator = ModuleType("audio_separator")
        separator_module = ModuleType("audio_separator.separator")
        separator_module.Separator = FakeLoadedAudioSeparator  # type: ignore[attr-defined]
        torch = ModuleType("torch")
        torch.float32 = np.float32  # type: ignore[attr-defined]
        torch.zeros = lambda shape, **_kwargs: np.zeros(shape, dtype=np.float32)  # type: ignore[attr-defined]
        torch.no_grad = nullcontext  # type: ignore[attr-defined]
        stages: list[str] = []
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(
                "sys.modules",
                {
                    "audio_separator": audio_separator,
                    "audio_separator.separator": separator_module,
                    "torch": torch,
                },
            ),
            patch(
                "musicmute_engine.separator.verify_model",
                return_value=Path(directory) / "Kim_Vocal_2.onnx",
            ),
            patch(
                "musicmute_engine.separator.provider_session",
                return_value=nullcontext([]),
            ),
            patch(
                "musicmute_engine.separator._uvr_mps_model",
                return_value=nullcontext(),
            ),
        ):
            separator = KimSeparator(
                "mps", Path(directory) / "Kim_Vocal_2.onnx", on_startup_stage=stages.append
            )

        self.assertEqual(
            FakeLoadedAudioSeparator.keyword_arguments["mdx_params"],
            {
                "hop_length": 1024,
                "segment_size": 256,
                "overlap": KIM_VOCAL_2_OVERLAP,
                "batch_size": 2,
                "enable_denoise": False,
            },
        )
        self.assertEqual(FakeLoadedAudioSeparator.keyword_arguments["output_format"], "WAV")
        self.assertTrue(FakeLoadedAudioSeparator.keyword_arguments["use_soundfile"])
        self.assertAlmostEqual(KIM_VOCAL_2_OVERLAP, 0.029411764705882353)
        self.assertEqual(separator._separator.model_instance.run_calls, 1)
        self.assertEqual(stages, ["warming"])

    def test_vocal_writer_pins_pcm16_even_for_mp3_input(self) -> None:
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory:
            model = SimpleNamespace(output_dir=directory, sample_rate=44100,
                                    input_subtype="MPEG_LAYER_III",
                                    normalization_threshold=0.9, amplification_threshold=0.0)
            normalize = Mock(return_value=np.full((4410, 2), 0.5, dtype=np.float32))
            module = ModuleType("audio_separator.separator.uvr_lib_v5")
            module.spec_utils = SimpleNamespace(normalize=normalize)
            with patch.dict("sys.modules", {"audio_separator.separator.uvr_lib_v5": module}):
                _write_vocal_wav(model, "vocals.wav", np.zeros((4410, 2), dtype=np.float32))
            normalize.assert_called_once()
            self.assertEqual(normalize.call_args.kwargs["max_peak"], 0.9)
            self.assertEqual(normalize.call_args.kwargs["min_peak"], 0.0)
            pcm, _ = sf.read(Path(directory) / "vocals.wav")
            np.testing.assert_allclose(pcm, 0.5)
            info = sf.info(Path(directory) / "vocals.wav")
            self.assertEqual(info.subtype, "PCM_16")
            self.assertEqual(info.frames, 4410)

    def test_warm_model_resets_file_state_and_keeps_outputs_attempt_local(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "prepared.wav"
            source.write_bytes(b"source-placeholder")
            first = root / "first"
            second = root / "second"
            second.mkdir()
            (second / "stale.wav").write_bytes(b"stale")

            backend = FakeAudioSeparator()
            separator = KimSeparator.__new__(KimSeparator)
            separator._separator = backend
            progress: list[tuple[int, int]] = []
            first_output = separator.separate(
                source, first, lambda completed, total: progress.append((completed, total))
            )
            second_output = separator.separate(source, second)

            self.assertEqual(backend.model_instance.reset_calls, 2)
            self.assertEqual(progress, [(1, 2), (2, 2)])
            self.assertIsNone(backend.model_instance.on_window_progress)
            self.assertEqual(first_output, (first / "vocals.wav").resolve())
            self.assertEqual(second_output, (second / "vocals.wav").resolve())
            self.assertTrue(first_output.is_file())
            self.assertTrue(second_output.is_file())
            self.assertFalse((second / "stale.wav").exists())
            self.assertEqual(backend.model_instance.output_dir, str(second))


if __name__ == "__main__":
    unittest.main()
