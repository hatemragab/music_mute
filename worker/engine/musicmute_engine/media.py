"""Bounded local-media operations for the worker pipeline."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .limits import (
    CHANNELS,
    MAX_DURATION_SECONDS,
    MAX_FFMPEG_ALLOCATION_BYTES,
    MAX_FLOAT_BYTES,
    MAX_INPUT_BYTES,
    MAX_LOSSLESS_SAMPLES,
    MAX_OUTPUT_BYTES,
    MAX_PCM16_BYTES,
    MAX_TOOL_OUTPUT_BYTES,
    SAMPLE_RATE,
)

FFMPEG_TIMEOUT_SECONDS = 7_200
PROBE_TIMEOUT_SECONDS = 60
DENOISE_FILTER = "afftdn=nr=6:nf=-50:tn=0:gs=3"
LOCAL_MEDIA_FORMATS = "aac,flac,matroska,webm,mov,mp3,ogg,wav"


class MediaProcessingError(RuntimeError):
    """Raised for invalid media or a bounded FFmpeg/ffprobe failure."""


@dataclass(frozen=True)
class AudioInfo:
    duration_seconds: float
    sample_rate: int
    channels: int


@dataclass(frozen=True)
class LosslessAudioInfo(AudioInfo):
    samples: int


@dataclass(frozen=True)
class MediaIdentity:
    bytes: int
    sha256: str


def sha256_base64(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return base64.b64encode(digest.digest()).decode("ascii")


def verify_input_identity(
    path: Path, expected_bytes: int, expected_sha256: str
) -> None:
    _assert_local_file(path)
    if expected_bytes <= 0 or expected_bytes > MAX_INPUT_BYTES:
        raise MediaProcessingError("Input size declaration is invalid")
    if path.stat().st_size != expected_bytes:
        raise MediaProcessingError("Input byte count does not match")
    if sha256_base64(path) != expected_sha256:
        raise MediaProcessingError("Input checksum does not match")


def probe_audio(path: Path, ffprobe: Path) -> AudioInfo:
    _assert_local_file(path)
    completed = _run(
        [
            str(_assert_executable(ffprobe)),
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            LOCAL_MEDIA_FORMATS,
            "-max_alloc",
            str(MAX_FFMPEG_ALLOCATION_BYTES),
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=sample_rate,channels:format=duration",
            "-of",
            "json",
            str(path),
        ],
        PROBE_TIMEOUT_SECONDS,
        "Audio probe failed",
    )
    try:
        document = json.loads(completed.stdout)
        streams = document["streams"]
        stream = streams[0]
        duration = float(document["format"]["duration"])
        sample_rate = int(stream["sample_rate"])
        channels = int(stream["channels"])
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise MediaProcessingError("Audio probe returned invalid metadata") from error
    if (
        not math.isfinite(duration)
        or duration <= 0
        or duration > MAX_DURATION_SECONDS
        or sample_rate <= 0
        or channels <= 0
    ):
        raise MediaProcessingError("Audio metadata is outside worker limits")
    return AudioInfo(duration, sample_rate, channels)


def prepare_audio(source: Path, destination: Path, ffmpeg: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    _run_ffmpeg(
        ffmpeg,
        source,
        [
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            "pcm_s16le",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            str(CHANNELS),
        ],
        destination,
        MAX_PCM16_BYTES,
        "Audio preparation failed",
    )
    info = inspect_lossless_audio(destination, require_pcm16=True)
    if info.duration_seconds > MAX_DURATION_SECONDS:
        raise MediaProcessingError("Decoded audio exceeds the duration limit")
    return destination


def denoise_audio(source: Path, destination: Path, ffmpeg: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    _run_ffmpeg(
        ffmpeg,
        source,
        [
            "-map",
            "0:a:0",
            "-vn",
            "-af",
            DENOISE_FILTER,
            "-c:a",
            "pcm_f32le",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            str(CHANNELS),
        ],
        destination,
        MAX_FLOAT_BYTES,
        "Audio denoise failed",
    )
    inspect_lossless_audio(destination)
    return destination


def encode_mp3(source: Path, destination: Path, ffmpeg: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    _run_ffmpeg(
        ffmpeg,
        source,
        [
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "192k",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            str(CHANNELS),
        ],
        destination,
        MAX_OUTPUT_BYTES,
        "MP3 encoding failed",
    )
    return destination


def validate_mp3(path: Path, ffprobe: Path) -> tuple[AudioInfo, MediaIdentity]:
    info = probe_audio(path, ffprobe)
    if info.sample_rate != SAMPLE_RATE or info.channels != CHANNELS:
        raise MediaProcessingError("Output audio format is invalid")
    size = path.stat().st_size
    if size <= 0 or size > MAX_OUTPUT_BYTES:
        raise MediaProcessingError("Output size is outside worker limits")
    return info, MediaIdentity(size, sha256_base64(path))


def inspect_lossless_audio(
    path: Path, *, require_pcm16: bool = False
) -> LosslessAudioInfo:
    import numpy as np
    import soundfile as sf

    _assert_local_file(path)
    try:
        with sf.SoundFile(path) as stream:
            size = path.stat().st_size
            if (
                stream.samplerate != SAMPLE_RATE
                or stream.channels != CHANNELS
                or len(stream) <= 0
                or (
                    require_pcm16
                    and (stream.format != "WAV" or stream.subtype != "PCM_16")
                )
            ):
                raise MediaProcessingError("Lossless audio format is invalid")
            if len(stream) > MAX_LOSSLESS_SAMPLES or size > MAX_FLOAT_BYTES:
                raise MediaProcessingError("Lossless audio exceeds worker limits")
            for block in stream.blocks(
                blocksize=65_536, dtype="float32", always_2d=True
            ):
                if not np.isfinite(block).all():
                    raise MediaProcessingError("Audio contains non-finite samples")
            return LosslessAudioInfo(
                len(stream) / stream.samplerate,
                stream.samplerate,
                stream.channels,
                len(stream),
            )
    except MediaProcessingError:
        raise
    except (OSError, RuntimeError) as error:
        raise MediaProcessingError("Lossless audio could not be decoded") from error


def _run_ffmpeg(
    ffmpeg: Path,
    source: Path,
    output_arguments: list[str],
    destination: Path,
    maximum_output_bytes: int,
    summary: str,
) -> None:
    _assert_local_file(source)
    _run(
        [
            str(_assert_executable(ffmpeg)),
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            LOCAL_MEDIA_FORMATS,
            "-max_alloc",
            str(MAX_FFMPEG_ALLOCATION_BYTES),
            "-i",
            str(source),
            *output_arguments,
            "-fs",
            str(maximum_output_bytes),
            str(destination),
        ],
        FFMPEG_TIMEOUT_SECONDS,
        summary,
        capture_output=False,
    )


def _run(
    arguments: list[str],
    timeout: int,
    summary: str,
    *,
    capture_output: bool = True,
) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(
            arguments,
            check=False,
            stdout=subprocess.PIPE if capture_output else subprocess.DEVNULL,
            stderr=subprocess.PIPE if capture_output else subprocess.DEVNULL,
            timeout=timeout,
            shell=False,
            env=_subprocess_environment(),
        )
        captured_stdout = completed.stdout or b""
        captured_stderr = completed.stderr or b""
        if (
            completed.returncode != 0
            or len(captured_stdout) > MAX_TOOL_OUTPUT_BYTES
            or len(captured_stderr) > MAX_TOOL_OUTPUT_BYTES
        ):
            raise MediaProcessingError(summary)
        return subprocess.CompletedProcess(
            arguments,
            completed.returncode,
            captured_stdout.decode("utf-8", errors="replace"),
            captured_stderr.decode("utf-8", errors="replace"),
        )
    except MediaProcessingError:
        raise
    except (OSError, subprocess.SubprocessError) as error:
        raise MediaProcessingError(summary) from error


def _assert_local_file(path: Path) -> Path:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise MediaProcessingError("Media path must be an absolute regular local file")
    return path.resolve(strict=True)


def _assert_executable(path: Path) -> Path:
    if (
        not path.is_absolute()
        or path.is_symlink()
        or not path.is_file()
        or not os.access(path, os.X_OK)
    ):
        raise MediaProcessingError("Media tool must be an absolute executable file")
    return path.resolve(strict=True)


def _subprocess_environment() -> dict[str, str]:
    allow = ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR")
    return {key: os.environ[key] for key in allow if key in os.environ}
