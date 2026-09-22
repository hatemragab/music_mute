"""Qualified UVR-compatible MPS and DirectML Kim Vocal 2 adapters."""

from __future__ import annotations

import logging
import shutil
from contextlib import contextmanager, nullcontext
from pathlib import Path
from typing import Any, Iterator

from .artifacts import verify_model
from .media import MediaProcessingError, inspect_lossless_audio
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


class KimSeparator:
    def __init__(
        self,
        provider: Provider,
        model_path: Path,
        *,
        directml_device_id: int = 0,
        profile_directory: Path | None = None,
    ) -> None:
        self.provider = provider
        self.model_path = verify_model(model_path)
        self.directml_device_id = directml_device_id
        self.profile_directory = profile_directory
        self._profile_sessions: list[Any] = []
        self._profiles_finished = False
        self._warmed_up = False
        self._separator = self._load()
        self._warm_up()

    def _load(self) -> Any:
        try:
            from audio_separator.separator import Separator

            model_context = (
                _uvr_mps_model() if self.provider == "mps" else nullcontext()
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
                    output_format="FLAC",
                    output_single_stem="Vocals",
                    use_soundfile=True,
                    use_directml=self.provider == "directml",
                    mdx_params={
                        "hop_length": KIM_VOCAL_2_HOP_LENGTH,
                        "segment_size": KIM_VOCAL_2_SEGMENT_SIZE,
                        "overlap": KIM_VOCAL_2_OVERLAP,
                        "batch_size": 1,
                        "enable_denoise": False,
                    },
                )
                separator.load_model(model_filename=MODEL_FILENAME)
                self._profile_sessions.extend(sessions)
            return separator
        except Exception as error:  # third-party errors are sanitized at this boundary
            raise SeparatorError("Kim model could not be loaded") from error

    def separate(self, source: Path, output_directory: Path) -> Path:
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
            filenames = self._separator.separate(
                str(source), custom_output_names={"Vocals": "vocals"}
            )
            if not isinstance(filenames, list) or len(filenames) != 1:
                raise SeparatorError("Kim separator did not return one vocal stem")
            vocal = (output_directory / filenames[0]).resolve(strict=True)
            if (
                not vocal.is_relative_to(output_directory.resolve(strict=True))
                or vocal.is_symlink()
                or not vocal.is_file()
            ):
                raise SeparatorError("Kim separator output path is invalid")
            inspect_lossless_audio(vocal)
            return vocal
        except (MediaProcessingError, OSError, RuntimeError) as error:
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
                (1, 2, model.chunk_size),
                dtype=torch.float32,
                device=model.torch_device,
            )
            with torch.no_grad():
                output = model.run_model(window)
            if tuple(getattr(output, "shape", ())) != (1, 2, model.chunk_size):
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


@contextmanager
def _uvr_mps_model() -> Iterator[None]:
    """Use UVR5's ONNX-to-PyTorch MPS path for one model construction."""
    try:
        import onnx
        from audio_separator.separator.architectures import mdx_separator
        from onnx2pytorch import ConvertModel
    except ImportError as error:
        raise SeparatorError("UVR MPS runtime is unavailable") from error

    original = mdx_separator.MDXSeparator

    class UVRMpsMDXSeparator(original):  # type: ignore[misc, valid-type]
        def load_model(self) -> None:
            model = ConvertModel(onnx.load(self.model_path))
            self.model_run = model.to(self.torch_device).eval()
            self.uses_pytorch_inference = True

    mdx_separator.MDXSeparator = UVRMpsMDXSeparator
    try:
        yield
    finally:
        mdx_separator.MDXSeparator = original
