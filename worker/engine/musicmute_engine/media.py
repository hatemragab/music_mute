"""Bounded local-media operations for the worker pipeline."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import subprocess
import threading
import wave
from dataclasses import dataclass, field
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
from .recipes import OUTPUT_BITRATE_KBPS

FFMPEG_TIMEOUT_SECONDS = 7_200
PROBE_TIMEOUT_SECONDS = 60
LOCAL_MEDIA_FORMATS = "aac,flac,matroska,webm,mov,mp3,ogg,wav"


class MediaProcessingError(RuntimeError):
    """Raised for invalid media or a bounded FFmpeg/ffprobe failure."""


@dataclass(frozen=True)
class AudioInfo:
    duration_seconds: float
    sample_rate: int
    channels: int
    bit_rate: int | None = field(default=None, kw_only=True)


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
            "stream=sample_rate,channels,bit_rate:format=duration",
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
    raw_bit_rate = stream.get("bit_rate")
    try:
        bit_rate = int(raw_bit_rate) if raw_bit_rate is not None else None
    except (TypeError, ValueError):
        bit_rate = None
    if bit_rate is not None and bit_rate <= 0:
        bit_rate = None
    return AudioInfo(duration, sample_rate, channels, bit_rate=bit_rate)


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


MP3_BITRATES_KBPS = (32, 40, 48, 56, 64, 80, 96, 112, 128, 160)


def output_bitrate_kbps(input_bit_rate: int | None) -> int:
    """Select a supported MP3 rate without raising a known compressed input rate."""
    if input_bit_rate is None:
        return OUTPUT_BITRATE_KBPS
    allowed = [rate for rate in MP3_BITRATES_KBPS if rate <= OUTPUT_BITRATE_KBPS and rate * 1000 <= input_bit_rate]
    if not allowed:
        raise MediaProcessingError("Input bitrate is below supported MP3 output rates")
    return allowed[-1]


def encode_mp3(source: Path, destination: Path, ffmpeg: Path, bitrate_kbps: int = OUTPUT_BITRATE_KBPS) -> Path:
    if bitrate_kbps not in MP3_BITRATES_KBPS or bitrate_kbps > OUTPUT_BITRATE_KBPS:
        raise MediaProcessingError("Unsupported MP3 output bitrate")
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
            # Faster LAME analysis; retain the recipe's CBR bitrate and stereo.
            "-compression_level",
            "7",
            "-b:a",
            f"{bitrate_kbps}k",
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


def validate_mp3_metadata(path: Path, ffprobe: Path) -> AudioInfo:
    info = probe_audio(path, ffprobe)
    if info.sample_rate != SAMPLE_RATE or info.channels != CHANNELS:
        raise MediaProcessingError("Output audio format is invalid")
    size = path.stat().st_size
    if size <= 0 or size > MAX_OUTPUT_BYTES:
        raise MediaProcessingError("Output size is outside worker limits")
    return info


def validate_mp3(path: Path, ffprobe: Path) -> tuple[AudioInfo, MediaIdentity]:
    info = validate_mp3_metadata(path, ffprobe)
    return info, MediaIdentity(path.stat().st_size, sha256_base64(path))


def decoded_audio_samples(path: Path) -> int:
    """Read an MP3's decoded frame count without loading its PCM into memory."""
    import soundfile as sf

    _assert_local_file(path)
    try:
        with sf.SoundFile(path) as stream:
            samples = len(stream)
            if (
                stream.samplerate != SAMPLE_RATE
                or stream.channels != CHANNELS
                or samples <= 0
                or samples > MAX_LOSSLESS_SAMPLES
            ):
                raise MediaProcessingError("Decoded audio is outside worker limits")
            return samples
    except MediaProcessingError:
        raise
    except (OSError, RuntimeError) as error:
        raise MediaProcessingError("Output audio could not be decoded") from error


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
            if require_pcm16:
                # Integer PCM cannot contain NaN/Inf. Check the declared data
                # extent and last frame instead of decoding the entire WAV.
                with wave.open(str(path), "rb") as pcm:
                    if pcm.getnframes() != len(stream):
                        raise MediaProcessingError("PCM audio is truncated")
                    pcm.setpos(pcm.getnframes() - 1)
                    if len(pcm.readframes(1)) != CHANNELS * 2:
                        raise MediaProcessingError("PCM audio is truncated")
            else:
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
    except (OSError, RuntimeError, EOFError, wave.Error) as error:
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
        process = subprocess.Popen(
            arguments,
            stdout=subprocess.PIPE if capture_output else subprocess.DEVNULL,
            stderr=subprocess.PIPE if capture_output else subprocess.DEVNULL,
            shell=False,
            env=_subprocess_environment(),
        )
        captured = [bytearray(), bytearray()]
        overflow = threading.Event()

        def collect(stream, destination: bytearray) -> None:
            try:
                while chunk := stream.read(8192):
                    if len(destination) + len(chunk) > MAX_TOOL_OUTPUT_BYTES:
                        overflow.set()
                        process.kill()
                        return
                    destination.extend(chunk)
            finally:
                stream.close()

        readers = []
        if capture_output:
            for stream, destination in zip((process.stdout, process.stderr), captured):
                reader = threading.Thread(target=collect, args=(stream, destination))
                reader.start()
                readers.append(reader)
        try:
            process.wait(timeout=timeout)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            for reader in readers:
                reader.join()
        captured_stdout, captured_stderr = captured
        if (
            process.returncode != 0
            or overflow.is_set()
        ):
            raise MediaProcessingError(summary)
        return subprocess.CompletedProcess(
            arguments,
            process.returncode,
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
