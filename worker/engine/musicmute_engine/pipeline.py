"""Versioned Kim processing pipeline for one isolated worker child."""

from __future__ import annotations

import math
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

from .artifacts import ModelArtifactError, verified_cached_model
from .media import (
    CHANNELS,
    SAMPLE_RATE,
    MediaProcessingError,
    encode_mp3,
    prepare_audio,
    probe_audio,
    validate_mp3,
    verify_input_identity,
)
from .recipes import OUTPUT_BITRATE_KBPS, RecipeValidationError, validate_recipe_snapshot
from .separator import KimSeparator, Provider, SeparatorError
from .trimmer import EditRange, TrimResult, trim_vocal_gaps

UUID_V4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
SHA256_BASE64 = re.compile(r"^[A-Za-z0-9+/]{43}=$")
MAX_EDIT_RANGES = 256
EDIT_CHUNK_SIZE = 64
DIRECT_INPUT_SUFFIXES = frozenset({".mp3", ".wav"})
REQUEST_KEYS = frozenset(
    {
        "attemptId",
        "attemptDirectory",
        "input",
        "modelCacheRoot",
        "provider",
        "directmlDeviceId",
        "ffmpegPath",
        "ffprobePath",
        "recipe",
    }
)
INPUT_KEYS = frozenset({"path", "bytes", "sha256"})


class VocalSeparator(Protocol):
    def separate(
        self,
        source: Path,
        output_directory: Path,
        on_window_progress: Callable[[int, int], None] | None = None,
    ) -> Path: ...


class ProcessingFailure(RuntimeError):
    def __init__(self, code: str, summary: str) -> None:
        super().__init__(summary)
        self.code = code
        self.summary = summary


def is_positive_gpu_oom(error: BaseException) -> bool:
    """Classify only provider OOM evidence; a timeout alone is never OOM."""
    current: BaseException | None = error
    for _ in range(5):
        if current is None:
            break
        message = str(current).lower()
        if (
            "mps backend out of memory" in message
            or "mps out of memory" in message
            or "dml out of memory" in message
            or "directml out of memory" in message
            or (
                type(current).__name__ == "OutOfMemoryError"
                and type(current).__module__.startswith("torch")
            )
        ):
            return True
        current = current.__cause__
    return False


@dataclass(frozen=True)
class ProcessRequest:
    attempt_id: str
    attempt_directory: Path
    input_path: Path
    input_bytes: int
    input_sha256: str
    model_cache_root: Path
    provider: Provider
    directml_device_id: int
    ffmpeg: Path
    ffprobe: Path
    recipe: dict[str, Any]

    @classmethod
    def from_payload(cls, payload: object) -> "ProcessRequest":
        if not isinstance(payload, dict) or set(payload) != REQUEST_KEYS:
            raise ProcessingFailure("INVALID_REQUEST", "Process fields are invalid")
        input_value = payload.get("input")
        if not isinstance(input_value, dict) or set(input_value) != INPUT_KEYS:
            raise ProcessingFailure("INVALID_REQUEST", "Input fields are invalid")
        attempt_id = payload.get("attemptId")
        provider = payload.get("provider")
        directml_device_id = payload.get("directmlDeviceId")
        input_bytes = input_value.get("bytes")
        input_sha256 = input_value.get("sha256")
        if not isinstance(attempt_id, str) or not UUID_V4.fullmatch(attempt_id):
            raise ProcessingFailure("INVALID_REQUEST", "Attempt ID is invalid")
        if provider not in ("mps", "directml"):
            raise ProcessingFailure("INVALID_REQUEST", "Provider is invalid")
        if (
            isinstance(directml_device_id, bool)
            or not isinstance(directml_device_id, int)
            or not 0 <= directml_device_id <= 15
        ):
            raise ProcessingFailure("INVALID_REQUEST", "GPU device ID is invalid")
        if (
            isinstance(input_bytes, bool)
            or not isinstance(input_bytes, int)
            or input_bytes <= 0
            or not isinstance(input_sha256, str)
            or not SHA256_BASE64.fullmatch(input_sha256)
        ):
            raise ProcessingFailure("INVALID_REQUEST", "Input identity is invalid")
        paths = {
            key: payload.get(key)
            for key in (
                "attemptDirectory",
                "modelCacheRoot",
                "ffmpegPath",
                "ffprobePath",
            )
        }
        paths["inputPath"] = input_value.get("path")
        if any(not isinstance(value, str) for value in paths.values()):
            raise ProcessingFailure("INVALID_REQUEST", "Process paths are invalid")
        converted = {key: Path(value) for key, value in paths.items()}
        if any(not value.is_absolute() for value in converted.values()):
            raise ProcessingFailure("INVALID_REQUEST", "Process paths must be absolute")
        attempt_directory = converted["attemptDirectory"]
        if attempt_directory.name.lower() != attempt_id.lower():
            raise ProcessingFailure(
                "INVALID_REQUEST", "Attempt directory must use the attempt ID"
            )
        try:
            recipe = validate_recipe_snapshot(payload.get("recipe"))
        except RecipeValidationError as error:
            raise ProcessingFailure(
                "RECIPE_INVALID", "Recipe snapshot is invalid"
            ) from error
        return cls(
            attempt_id=attempt_id.lower(),
            attempt_directory=attempt_directory,
            input_path=converted["inputPath"],
            input_bytes=input_bytes,
            input_sha256=input_sha256,
            model_cache_root=converted["modelCacheRoot"],
            provider=provider,
            directml_device_id=directml_device_id,
            ffmpeg=converted["ffmpegPath"],
            ffprobe=converted["ffprobePath"],
            recipe=recipe,
        )


SeparatorFactory = Callable[[Provider, Path, int], VocalSeparator]
Progress = Callable[[str], None]
WindowProgress = Callable[[int, int], None]


class RuntimePipeline:
    def __init__(self, separator_factory: SeparatorFactory | None = None) -> None:
        self._startup_progress: Progress | None = None
        self._separator_factory = separator_factory or (
            lambda provider, model, device: KimSeparator(
                provider,
                model,
                directml_device_id=device,
                on_startup_stage=self._startup_progress,
            )
        )
        self._separator: VocalSeparator | None = None
        self._separator_key: tuple[Provider, Path, int] | None = None
        self._model_cache_root: Path | None = None

    def preload(
        self,
        model_cache_root: Path,
        provider: Provider,
        directml_device_id: int = 0,
        progress: Progress | None = None,
    ) -> None:
        """Validate and load the stable model before this child accepts work."""
        if progress is not None:
            progress("loading")
        try:
            model = self._verified_model(model_cache_root)
        except ModelArtifactError as error:
            raise ProcessingFailure(
                "MODEL_INVALID", "Qualified model is unavailable"
            ) from error
        try:
            self._startup_progress = progress
            self._get_separator(provider, model, directml_device_id)
        except SeparatorError as error:
            raise ProcessingFailure(
                "SEPARATOR_FAILED", "Vocal separator could not be preloaded"
            ) from error
        finally:
            self._startup_progress = None

    def process(
        self,
        request: ProcessRequest,
        progress: Progress | None = None,
        window_progress: WindowProgress | None = None,
    ) -> dict[str, Any]:
        progress = progress or (lambda _stage: None)
        timings: dict[str, float] = {}
        try:
            model = self._timed(
                timings,
                "modelValidation",
                lambda: self._verified_model(request.model_cache_root),
            )
        except ModelArtifactError as error:
            raise ProcessingFailure(
                "MODEL_INVALID", "Qualified model is unavailable"
            ) from error

        attempt = self._prepare_attempt_directory(
            request.attempt_directory, request.input_path
        )
        try:
            progress("input-validation")
            try:
                self._timed(
                    timings,
                    "inputIdentity",
                    lambda: verify_input_identity(
                        request.input_path,
                        request.input_bytes,
                        request.input_sha256,
                    ),
                )
            except MediaProcessingError as error:
                raise ProcessingFailure(
                    "INPUT_CHECKSUM_MISMATCH", "Input identity does not match"
                ) from error
            try:
                source_info = self._timed(
                    timings,
                    "mediaValidation",
                    lambda: probe_audio(request.input_path, request.ffprobe),
                )
            except MediaProcessingError as error:
                raise ProcessingFailure(
                    "INVALID_AUDIO", "Input audio is invalid"
                ) from error
            separation_input = request.input_path
            prepared_path = (
                attempt / "prepared.wav"
                if separation_input.suffix.lower() not in DIRECT_INPUT_SUFFIXES
                else None
            )
            try:
                if prepared_path is not None:
                    progress("preparation")
                    try:
                        separation_input = self._timed(
                            timings,
                            "preparation",
                            lambda: prepare_audio(
                                request.input_path, prepared_path, request.ffmpeg
                            ),
                        )
                    except MediaProcessingError as error:
                        raise ProcessingFailure(
                            "SEPARATOR_FAILED", "Audio preparation failed"
                        ) from error
                progress("model-load")
                try:
                    separator = self._timed(
                        timings,
                        "modelLoad",
                        lambda: self._get_separator(
                            request.provider, model, request.directml_device_id
                        ),
                    )
                    progress("separation")
                    produced = self._timed(
                        timings,
                        "separation",
                        lambda: separator.separate(
                            separation_input,
                            attempt / "separated",
                            on_window_progress=window_progress,
                        ) if window_progress is not None else separator.separate(
                            separation_input, attempt / "separated"
                        ),
                    )
                except (SeparatorError, MediaProcessingError) as error:
                    if is_positive_gpu_oom(error):
                        raise ProcessingFailure(
                            "GPU_OOM", "GPU provider reported out of memory"
                        ) from error
                    raise ProcessingFailure(
                        "SEPARATOR_FAILED", "Vocal separation failed"
                    ) from error
            finally:
                if prepared_path is not None:
                    prepared_path.unlink(missing_ok=True)

            output = attempt / "output" / "vocals.mp3"
            output.parent.mkdir(parents=True, exist_ok=True)
            if request.recipe["trimEnabled"]:
                progress("trim")
                try:
                    trimmed = self._timed(
                        timings,
                        "trim",
                        lambda: trim_vocal_gaps(
                            produced,
                            attempt / "trimmed.wav",
                            threshold_db=-32 if request.recipe["recipeRevision"] == 5 else -40,
                            reuse_unchanged=True
                        ),
                    )
                except (OSError, RuntimeError, ValueError) as error:
                    raise ProcessingFailure("TRIM_FAILED", "Vocal trim failed") from error
            else:
                import soundfile as sf

                info = sf.info(produced)
                if info.samplerate != SAMPLE_RATE or info.channels != CHANNELS or info.frames <= 0:
                    raise ProcessingFailure("OUTPUT_INVALID", "Separated audio shape is invalid")
                trimmed = TrimResult(
                    produced, info.frames, info.frames, info.samplerate,
                    info.channels, (EditRange(0, info.frames, 0, info.frames),),
                )
            source_samples = trimmed.source_samples
            output_samples = trimmed.output_samples
            removed_samples = trimmed.removed_samples
            retained = trimmed.retained_ranges
            if len(retained) > MAX_EDIT_RANGES:
                raise ProcessingFailure(
                    "EDIT_MAP_TOO_LARGE", "Vocal edit map exceeds the bounded limit"
                )
            progress("encoding")
            try:
                self._timed(
                    timings,
                    "encode",
                    lambda: encode_mp3(trimmed.audio_path, output, request.ffmpeg),
                )
            except MediaProcessingError as error:
                raise ProcessingFailure(
                    "OUTPUT_INVALID", "Trimmed MP3 encoding failed"
                ) from error
            progress("output-validation")
            try:
                output_info, identity = self._timed(
                    timings,
                    "outputValidation",
                    lambda: validate_mp3(output, request.ffprobe),
                )
            except MediaProcessingError as error:
                raise ProcessingFailure(
                    "OUTPUT_INVALID", "Output audio is invalid"
                ) from error
            input_samples = max(1, round(source_info.duration_seconds * SAMPLE_RATE))

            progress("output-ready")
            return {
                "attemptId": request.attempt_id,
                "outputPath": str(output.resolve(strict=True)),
                "bytes": identity.bytes,
                "sha256": identity.sha256,
                "contentType": "audio/mpeg",
                "sourceDurationSeconds": source_info.duration_seconds,
                "measuredInputDurationSeconds": source_info.duration_seconds,
                "measuredInputSamples": input_samples,
                "measuredOutputDurationSeconds": output_info.duration_seconds,
                "sourceSamples": source_samples,
                "outputSamples": output_samples,
                "removedSamples": removed_samples,
                "sampleRate": SAMPLE_RATE,
                "channels": CHANNELS,
                "recipeId": request.recipe["recipeId"],
                "recipeRevision": request.recipe["recipeRevision"],
                "recipeDigest": request.recipe["recipeDigest"],
                "modelDigest": request.recipe["modelDigest"],
                "trimEnabled": request.recipe["trimEnabled"],
                "denoiseEnabled": request.recipe["denoiseEnabled"],
                "outputFormat": request.recipe["outputFormat"],
                "outputBitrateKbps": OUTPUT_BITRATE_KBPS,
                "codecPaddingSeconds": max(
                    0.0,
                    output_info.duration_seconds - output_samples / SAMPLE_RATE,
                ),
                "stageTimings": timings,
                "separationTimings": getattr(separator, "last_separation_timings", {}),
                "editMap": _chunk_edit_map(retained),
            }
        except ProcessingFailure:
            raise
        except Exception as error:
            raise ProcessingFailure("PROCESSING_FAILED", "Processing failed") from error
        finally:
            # These paths are owned exclusively by this validated attempt.
            # Keep the final MP3 for upload; never retain temporary PCM on failure.
            (attempt / "prepared.wav").unlink(missing_ok=True)
            (attempt / "trimmed.wav").unlink(missing_ok=True)
            separated = attempt / "separated"
            if separated.is_dir():
                shutil.rmtree(separated)

    def _verified_model(self, cache_root: Path) -> Path:
        # A warm child uses the verified in-memory graph, not the on-disk file.
        # New children and failed loads must still verify the artifact in full.
        if self._separator is not None and self._separator_key is not None:
            if cache_root != self._model_cache_root:
                raise ProcessingFailure(
                    "RUNTIME_CONFIG_CHANGED", "A warm child cannot change model cache"
                )
            return self._separator_key[1]
        model = verified_cached_model(cache_root)
        self._model_cache_root = cache_root
        return model

    def _get_separator(
        self, provider: Provider, model: Path, directml_device_id: int
    ) -> VocalSeparator:
        key = (provider, model, directml_device_id)
        if self._separator is None:
            self._separator = self._separator_factory(
                provider, model, directml_device_id
            )
            self._separator_key = key
        elif self._separator_key != key:
            raise ProcessingFailure(
                "RUNTIME_CONFIG_CHANGED",
                "A warm child cannot change provider or model identity",
            )
        return self._separator

    @staticmethod
    def _prepare_attempt_directory(path: Path, input_path: Path) -> Path:
        if (
            not path.is_absolute()
            or path.is_symlink()
            or input_path.is_symlink()
            or input_path.name in {"prepared.wav", "trimmed.wav"}
        ):
            raise ProcessingFailure(
                "INVALID_REQUEST", "Attempt directory is not a safe absolute path"
            )
        if path.exists():
            if (
                not path.is_dir()
                or not input_path.is_file()
                or input_path.parent.resolve(strict=True) != path.resolve(strict=True)
                or {item.name for item in path.iterdir()} != {input_path.name}
            ):
                raise ProcessingFailure(
                    "INVALID_REQUEST", "Attempt directory must contain only its input"
                )
        else:
            raise ProcessingFailure(
                "INVALID_REQUEST", "Attempt directory and input must exist"
            )
        return path.resolve(strict=True)

    @staticmethod
    def _timed(
        timings: dict[str, float], name: str, operation: Callable[[], Any]
    ) -> Any:
        started = time.monotonic()
        try:
            return operation()
        finally:
            elapsed = time.monotonic() - started
            timings[name] = elapsed if math.isfinite(elapsed) else 0.0


def _chunk_edit_map(ranges: tuple[EditRange, ...]) -> dict[str, Any]:
    items = [
        {
            "sourceStart": item.source_start,
            "sourceEnd": item.source_end,
            "outputStart": item.output_start,
            "outputEnd": item.output_end,
        }
        for item in ranges
    ]
    return {
        "version": 1,
        "rangeCount": len(items),
        "chunks": [
            items[index : index + EDIT_CHUNK_SIZE]
            for index in range(0, len(items), EDIT_CHUNK_SIZE)
        ],
    }
