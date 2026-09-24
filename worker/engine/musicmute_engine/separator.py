"""Qualified UVR-compatible MPS and DirectML Kim Vocal 2 adapters."""

from __future__ import annotations

import logging
import shutil
import time
from contextlib import contextmanager, nullcontext
from pathlib import Path
from types import MethodType
from typing import Any, Callable, Iterator


from .artifacts import verify_model
from .provider_adapter import (
    Provider,
    provider_session,
)
from .recipes import MODEL_FILENAME

KIM_VOCAL_2_HOP_LENGTH = 1024
KIM_VOCAL_2_SEGMENT_SIZE = 256
KIM_VOCAL_2_N_FFT = 7680
KIM_VOCAL_2_OVERLAP = KIM_VOCAL_2_N_FFT / (
    KIM_VOCAL_2_HOP_LENGTH * (KIM_VOCAL_2_SEGMENT_SIZE - 1)
)


class SeparatorError(RuntimeError):
    """Raised when the qualified separation adapter cannot safely run."""


def _write_vocal_wav(model: Any, stem_path: str, audio: Any) -> None:
    import soundfile as sf
    from audio_separator.separator.uvr_lib_v5 import spec_utils
    from .limits import CHANNELS, MAX_LOSSLESS_SAMPLES, SAMPLE_RATE

    target = Path(model.output_dir) / stem_path
    if (
        target.parent.resolve() != Path(model.output_dir).resolve()
        or target.suffix != ".wav"
    ):
        raise SeparatorError("Vocal WAV path is invalid")
    if (
        audio.ndim != 2
        or audio.shape[1] != CHANNELS
        or not 0 < len(audio) <= MAX_LOSSLESS_SAMPLES
    ):
        raise SeparatorError("Vocal WAV shape is invalid")
    if model.sample_rate != SAMPLE_RATE:
        raise SeparatorError("Vocal WAV sample rate is invalid")
    # Preserve upstream output normalization before quantizing to PCM16.
    # This also rejects non-finite predictions before any file is written.
    audio = spec_utils.normalize(
        wave=audio,
        max_peak=model.normalization_threshold,
        min_peak=model.amplification_threshold,
    )
    with sf.SoundFile(
        target, "w", samplerate=SAMPLE_RATE, channels=CHANNELS,
        format="WAV", subtype="PCM_16",
    ) as output:
        for start in range(0, len(audio), 65536):
            block = audio[start : start + 65536]
            output.write(block)


def _separate_primary_vocals(model: Any, audio_file_path: str, custom_output_names: Any = None) -> list[str]:
    """Primary-only MDX path; retain upstream normalization and vocal math."""
    import numpy as np
    from audio_separator.separator.uvr_lib_v5 import spec_utils

    if model.primary_stem_name != "Vocals" or model.output_single_stem != "Vocals":
        raise SeparatorError("Primary-only separation requires the vocal target")
    model.audio_file_path = audio_file_path
    model.audio_file_base = Path(audio_file_path).stem
    started = time.perf_counter()
    mix = model.prepare_mix(audio_file_path)
    peak = np.abs(mix).max()
    mix = spec_utils.normalize(
        wave=mix, max_peak=model.normalization_threshold,
        min_peak=model.amplification_threshold,
    )
    model.separation_timings["separationMixPreparation"] = time.perf_counter() - started
    started = time.perf_counter()
    model.primary_source = (model.demix(mix) * peak).T
    model.separation_timings["separationPrimaryDemix"] = time.perf_counter() - started
    model.separation_timings["separationMatchMix"] = 0.0
    model.primary_stem_output_path = model.get_stem_output_path("Vocals", custom_output_names)
    started = time.perf_counter()
    model.final_process(model.primary_stem_output_path, model.primary_source, "Vocals")
    model.separation_timings["separationWavWrite"] = time.perf_counter() - started
    return [model.primary_stem_output_path]


class KimSeparator:
    def __init__(
        self,
        provider: Provider,
        model_path: Path,
        *,
        directml_device_id: int = 0,
        profile_directory: Path | None = None,
        on_startup_stage: Callable[[str], None] | None = None,
        group_size: int | None = None,
    ) -> None:
        if group_size is None:
            group_size = 2 if provider == "mps" else 1
        if group_size not in (1, 2, 4) or (group_size > 1 and provider != "mps"):
            raise SeparatorError("Kim window group is unsupported")
        self.provider = provider
        self.group_size = group_size
        self.model_path = verify_model(model_path)
        self.directml_device_id = directml_device_id
        self.profile_directory = profile_directory
        self._profile_sessions: list[Any] = []
        self._profiles_finished = False
        self._warmed_up = False
        self._separator = self._load()
        if on_startup_stage is not None:
            on_startup_stage("warming")
        self._warm_up()

    def _load(self) -> Any:
        try:
            from audio_separator.separator import Separator

            model_context = (
                _uvr_mps_model(self.group_size) if self.provider == "mps" else nullcontext()
            )
            with model_context, provider_session(
                self.provider,
                self.directml_device_id,
                profile_directory=self.profile_directory,
            ) as sessions:
                separator = Separator(
                    log_level=logging.WARNING,
                    model_file_dir=str(self.model_path.parent),
                    output_dir=str(self.model_path.parent),
                    output_format="WAV",
                    output_bitrate="160k",
                    output_single_stem="Vocals",
                    use_soundfile=True,
                    use_directml=self.provider == "directml",
                    mdx_params={
                        "hop_length": KIM_VOCAL_2_HOP_LENGTH,
                        "segment_size": KIM_VOCAL_2_SEGMENT_SIZE,
                        "overlap": KIM_VOCAL_2_OVERLAP,
                        "batch_size": self.group_size,
                        "enable_denoise": False,
                    },
                )
                separator.load_model(model_filename=MODEL_FILENAME)
                # Pin PCM WAV output: upstream otherwise inherits MPEG subtypes
                # from MP3 input, which soundfile cannot use for WAV output.
                separator.model_instance.write_audio = MethodType(
                    _write_vocal_wav, separator.model_instance
                )
                model = separator.model_instance
                if getattr(model, "primary_stem_name", None) == "Vocals" and getattr(model, "output_single_stem", None) == "Vocals":
                    model.separate = MethodType(_separate_primary_vocals, model)
                self._profile_sessions.extend(sessions)
            return separator
        except Exception as error:  # third-party errors are sanitized at this boundary
            raise SeparatorError("Kim model could not be loaded") from error

    def separate(
        self,
        source: Path,
        output_directory: Path,
        on_window_progress: Callable[[int, int], None] | None = None,
    ) -> Path:
        if output_directory.exists():
            shutil.rmtree(output_directory)
        output_directory.mkdir(parents=True)
        try:
            self._separator.output_dir = str(output_directory)
            model = getattr(self._separator, "model_instance", None)
            if model is None:
                raise SeparatorError("Kim model is unavailable")
            model.output_dir = str(output_directory)
            reset = getattr(model, "clear_file_specific_paths", None)
            if reset is not None:
                reset()
            model.separation_timings = {}
            self.last_separation_timings = {}
            original_cleanup = getattr(model, "clear_gpu_cache", None)
            if original_cleanup is not None:
                def timed_cleanup() -> None:
                    started = time.perf_counter()
                    try:
                        original_cleanup()
                    finally:
                        model.separation_timings["separationCleanup"] = time.perf_counter() - started
                model.clear_gpu_cache = timed_cleanup
            model.on_window_progress = on_window_progress
            try:
                filenames = self._separator.separate(
                    str(source), custom_output_names={"Vocals": "vocals"}
                )
            finally:
                model.on_window_progress = None
                if original_cleanup is not None:
                    model.clear_gpu_cache = original_cleanup
                self.last_separation_timings = dict(model.separation_timings)
            if not isinstance(filenames, list) or len(filenames) != 1:
                raise SeparatorError("Kim separator did not return one vocal stem")
            vocal = (output_directory / filenames[0]).resolve(strict=True)
            if (
                not vocal.is_relative_to(output_directory.resolve(strict=True))
                or vocal.is_symlink()
                or vocal.suffix.lower() != ".wav"
                or not vocal.is_file()
                or vocal.stat().st_size <= 0
            ):
                raise SeparatorError("Kim separator output path is invalid")
            return vocal
        except (OSError, RuntimeError) as error:
            if isinstance(error, SeparatorError):
                raise
            raise SeparatorError("Kim separation failed") from error

    def _warm_up(self) -> None:
        """Initialize the pinned STFT and accelerated graph with one window."""
        try:
            import torch

            model = getattr(self._separator, "model_instance", None)
            if model is None:
                raise SeparatorError("Kim model is unavailable")
            model.initialize_model_settings()
            if model.chunk_size != KIM_VOCAL_2_HOP_LENGTH * (
                KIM_VOCAL_2_SEGMENT_SIZE - 1
            ):
                raise SeparatorError("Kim model window is invalid")
            window = torch.zeros(
                (self.group_size, 2, model.chunk_size),
                dtype=torch.float32,
                device=model.torch_device,
            )
            with torch.no_grad():
                output = model.run_model(window)
            if tuple(getattr(output, "shape", ())) != (self.group_size, 2, model.chunk_size):
                raise SeparatorError("Kim model warm-up output is invalid")
            self._warmed_up = True
        except Exception as error:  # third-party errors are sanitized at this boundary
            if isinstance(error, SeparatorError):
                raise
            raise SeparatorError("Kim model could not be warmed up") from error

    def mps_dispatch_evidence(self) -> dict[str, object]:
        if self.provider != "mps" or not self._warmed_up:
            raise SeparatorError("Kim MPS dispatch is unavailable")
        model = getattr(self._separator, "model_instance", None)
        runtime = getattr(model, "model_run", None)
        try:
            parameter = next(runtime.parameters())
        except (AttributeError, StopIteration, TypeError) as error:
            raise SeparatorError("Kim MPS model parameters are unavailable") from error
        if str(getattr(model, "torch_device", "")) != "mps" or str(
            parameter.device
        ) != "mps:0":
            raise SeparatorError("Kim model is not resident on MPS")
        return {
            "expectedProvider": "MPS",
            "profileCount": 0,
            "acceleratedNodeEvents": 1,
            "cpuNodeEvents": 0,
            "proven": True,
        }

    def grouping_evidence(self) -> dict[str, int]:
        model = getattr(self._separator, "model_instance", None)
        return {
            "selectedSize": self.group_size,
            "processedWindows": getattr(model, "grouped_windows", 0),
            "modelCalls": getattr(model, "grouped_model_calls", 0),
            "largestBatch": getattr(model, "grouped_max_batch", 0),
        }

    def finish_profiles(self) -> tuple[Path, ...]:
        if self.profile_directory is None or not self._profile_sessions:
            raise SeparatorError("Kim provider profiling is unavailable")
        if self._profiles_finished:
            raise SeparatorError("Kim provider profiling already finished")
        self._profiles_finished = True
        try:
            return tuple(
                Path(session.end_profiling()).resolve(strict=True)
                for session in self._profile_sessions
            )
        except (OSError, RuntimeError, ValueError) as error:
            raise SeparatorError(
                "Kim provider profile could not be finalized"
            ) from error


def _grouped_demix(model: Any, mix: np.ndarray, group_size: int) -> np.ndarray:
    """Batch adjacent MDX windows while retaining the pinned overlap-add path."""
    import numpy as np
    import torch

    model.initialize_model_settings()
    chunk_size = model.chunk_size
    trim = model.trim
    gen_size = chunk_size - 2 * trim
    if gen_size <= 0 or mix.ndim != 2 or mix.shape[0] != 2:
        raise SeparatorError("Kim grouped input shape is invalid")
    pad = gen_size + trim - (mix.shape[-1] % gen_size)
    mixture = np.concatenate(
        (np.zeros((2, trim), dtype="float32"), mix, np.zeros((2, pad), dtype="float32")),
        axis=1,
    )
    step = int((1 - model.overlap) * chunk_size)
    if step <= 0:
        raise SeparatorError("Kim grouped step is invalid")
    result = np.zeros((1, 2, mixture.shape[-1]), dtype=np.float32)
    divider = np.zeros_like(result)
    windows: list[np.ndarray] = []
    positions: list[tuple[int, int, np.ndarray | None]] = []
    model_calls = 0
    processed = 0
    max_batch = 0

    def flush() -> None:
        nonlocal model_calls, processed, max_batch
        if not windows:
            return
        batch = torch.tensor(np.stack(windows), dtype=torch.float32).to(model.torch_device)
        with torch.no_grad():
            output = model.run_model(batch)
        if tuple(output.shape) != (len(windows), 2, chunk_size):
            raise SeparatorError("Kim grouped output shape is invalid")
        for index, (start, end, window) in enumerate(positions):
            wave = output[index : index + 1]
            if window is not None:
                wave[..., : end - start] *= window
                divider[..., start:end] += window
            else:
                divider[..., start:end] += 1
            result[..., start:end] += wave[..., : end - start]
        model_calls += 1
        processed += len(windows)
        max_batch = max(max_batch, len(windows))
        windows.clear()
        positions.clear()

    for start in range(0, mixture.shape[-1], step):
        end = min(start + chunk_size, mixture.shape[-1])
        actual = end - start
        window = None
        if model.overlap != 0:
            window = np.tile(np.hanning(actual)[None, None, :], (1, 2, 1))
        part = mixture[:, start:end]
        if actual != chunk_size:
            part = np.concatenate(
                (part, np.zeros((2, chunk_size - actual), dtype="float32")), axis=-1
            )
        windows.append(part)
        positions.append((start, end, window))
        if len(windows) == group_size:
            flush()
    flush()
    model.grouped_windows = processed
    model.grouped_model_calls = model_calls
    model.grouped_max_batch = max_batch
    valid = slice(trim, trim + mix.shape[-1])
    if np.any(divider[:, :, valid] == 0):
        raise SeparatorError("Kim grouped overlap coverage is invalid")
    return (result[:, :, valid] / divider[:, :, valid])[0]


@contextmanager
def _uvr_mps_model(group_size: int = 1) -> Iterator[None]:
    """Use UVR5's ONNX-to-PyTorch MPS path for one model construction."""
    try:
        import onnx2torch
        from audio_separator.separator.architectures import mdx_separator
    except ImportError as error:
        raise SeparatorError("UVR MPS runtime is unavailable") from error

    original = mdx_separator.MDXSeparator

    class UVRMpsMDXSeparator(original):  # type: ignore[misc, valid-type]
        def load_model(self) -> None:
            self.model_run = (
                onnx2torch.convert(self.model_path).to(self.torch_device).eval()
            )
            self.uses_pytorch_inference = True

        def demix(self, mix: np.ndarray, is_match_mix: bool = False) -> np.ndarray:
            if not is_match_mix:
                gen_size = self.chunk_size - 2 * self.trim
                pad = gen_size + self.trim - (mix.shape[-1] % gen_size)
                length = self.trim + mix.shape[-1] + pad
                step = int((1 - self.overlap) * self.chunk_size)
                self._window_total = (length + step - 1) // step
                self._window_completed = 0
            if group_size == 1 or is_match_mix:
                output = super().demix(mix, is_match_mix=is_match_mix)
                if not is_match_mix:
                    count = self._window_total
                    self.grouped_windows = count
                    self.grouped_model_calls = count
                    self.grouped_max_batch = 1
                return output
            return _grouped_demix(self, mix, group_size)

        def run_model(self, mix: Any, is_match_mix: bool = False) -> np.ndarray:
            import torch

            spek = self.stft(mix.to(self.torch_device))
            spek[:, :, :3, :] *= 0
            if is_match_mix:
                spec_pred = spek
            elif self.enable_denoise:
                spec_pred = (self.model_run(-spek) * -0.5) + (
                    self.model_run(spek) * 0.5
                )
            else:
                spec_pred = self.model_run(spek)
            if not isinstance(spec_pred, torch.Tensor):
                spec_pred = torch.as_tensor(spec_pred, device=self.torch_device)
            output = self.stft.inverse(spec_pred).cpu().detach().numpy()
            if not is_match_mix and getattr(self, "on_window_progress", None) is not None:
                self._window_completed += mix.shape[0]
                self.on_window_progress(self._window_completed, self._window_total)
            return output

    mdx_separator.MDXSeparator = UVRMpsMDXSeparator
    try:
        yield
    finally:
        mdx_separator.MDXSeparator = original
