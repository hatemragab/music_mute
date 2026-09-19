"""Qualified CoreML/DirectML adapter around python-audio-separator."""

from __future__ import annotations

import importlib.metadata
import logging
import platform
import shutil
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Literal

from .artifacts import verify_model
from .media import MediaProcessingError, inspect_lossless_audio
from .recipes import MODEL_FILENAME

Provider = Literal["coreml", "directml"]
COREML_PROVIDER = "CoreMLExecutionProvider"
DIRECTML_PROVIDER = "DmlExecutionProvider"
CPU_PROVIDER = "CPUExecutionProvider"


class SeparatorError(RuntimeError):
    """Raised when the qualified separation adapter cannot safely run."""


class KimSeparator:
    def __init__(
        self,
        provider: Provider,
        model_path: Path,
        *,
        directml_device_id: int = 0,
    ) -> None:
        self.provider = provider
        self.model_path = verify_model(model_path)
        self.directml_device_id = directml_device_id
        _validate_environment(provider, directml_device_id)
        self._separator = self._load()

    def _load(self) -> Any:
        try:
            from audio_separator.separator import Separator

            with _provider_session(self.provider, self.directml_device_id):
                separator = Separator(
                    log_level=logging.WARNING,
                    model_file_dir=str(self.model_path.parent),
                    output_dir=str(self.model_path.parent),
                    output_format="FLAC",
                    output_single_stem="Vocals",
                    use_soundfile=True,
                    use_directml=self.provider == "directml",
                )
                separator.load_model(model_filename=MODEL_FILENAME)
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


def _validate_environment(provider: Provider, directml_device_id: int) -> None:
    if provider not in ("coreml", "directml"):
        raise SeparatorError("Worker provider is unsupported")
    if isinstance(directml_device_id, bool) or not 0 <= directml_device_id <= 15:
        raise SeparatorError("DirectML device ID is invalid")
    installed = {
        name
        for name in (
            "onnxruntime",
            "onnxruntime-directml",
            "onnxruntime-gpu",
            "onnxruntime-silicon",
        )
        if _package_version(name) is not None
    }
    if len(installed) != 1:
        raise SeparatorError("Exactly one ONNX Runtime distribution is required")
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise SeparatorError("ONNX Runtime is unavailable") from error

    system, machine = platform.system(), platform.machine().lower()
    if provider == "coreml":
        valid_host = system == "Darwin" and machine == "arm64"
        valid_distribution = installed == {"onnxruntime"}
        required = COREML_PROVIDER
    else:
        valid_host = system == "Windows" and machine in {"amd64", "x86_64"}
        valid_distribution = installed == {"onnxruntime-directml"}
        required = DIRECTML_PROVIDER
    if not valid_host or not valid_distribution:
        raise SeparatorError("Worker platform does not match the provider lock")
    if required not in ort.get_available_providers():
        raise SeparatorError("Required ONNX provider is unavailable")


def _package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


@contextmanager
def _provider_session(provider: Provider, device_id: int) -> Iterator[None]:
    import onnxruntime as ort

    original = ort.InferenceSession

    def configured_session(
        path_or_bytes: object,
        sess_options: Any = None,
        providers: object = None,
        provider_options: object = None,
        **kwargs: object,
    ) -> Any:
        del providers, provider_options
        options = sess_options or ort.SessionOptions()
        if provider == "coreml":
            selected: list[object] = [
                (
                    COREML_PROVIDER,
                    {
                        "MLComputeUnits": "CPUAndGPU",
                        "ModelFormat": "MLProgram",
                        "RequireStaticInputShapes": "0",
                        "EnableOnSubgraphs": "0",
                    },
                ),
                CPU_PROVIDER,
            ]
        else:
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            options.enable_mem_pattern = False
            selected = [
                (DIRECTML_PROVIDER, {"device_id": str(device_id)}),
                CPU_PROVIDER,
            ]
        return original(
            path_or_bytes, sess_options=options, providers=selected, **kwargs
        )

    ort.InferenceSession = configured_session
    try:
        yield
    finally:
        ort.InferenceSession = original
