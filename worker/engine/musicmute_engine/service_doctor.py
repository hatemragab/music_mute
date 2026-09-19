"""Sanitized service-context validation for accepted platform runtimes."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any

from .artifacts import verified_cached_model
from .recipes import MODEL_BYTES, MODEL_SHA256

EXPECTED_PYTHON = {"coreml": (3, 13), "directml": (3, 12)}
EXPECTED_ONNXRUNTIME = {"coreml": "1.30.0", "directml": "1.24.4"}
EXPECTED_AUDIO_SEPARATOR = "0.47.0"
EXPECTED_FFMPEG = "8.0.3"
OUTPUT_LIMIT = 16 * 1024
CAPABILITY_OUTPUT_LIMIT = 2 * 1024 * 1024
REQUIRED_ENCODERS = frozenset(("libmp3lame",))
REQUIRED_FILTERS = frozenset(("afftdn", "aresample", "silenceremove"))
NETWORK_PROTOCOLS = frozenset(
    ("http", "https", "rtmp", "rtmps", "rtsp", "srt", "tcp", "tls", "udp")
)


class ServiceDoctorError(RuntimeError):
    """Raised when the installed service runtime is not the accepted build."""


def collect_diagnostics(
    *, model_cache: Path, ffmpeg: Path, ffprobe: Path, provider: str = "coreml"
) -> dict[str, Any]:
    system, architecture, distribution, provider_name = accepted_runtime(provider)
    if sys.version_info[:2] != EXPECTED_PYTHON[provider]:
        raise ServiceDoctorError("Service Python version is not accepted")
    try:
        onnx_version = importlib.metadata.version(distribution)
        separator_version = importlib.metadata.version("audio-separator")
    except importlib.metadata.PackageNotFoundError as error:
        raise ServiceDoctorError("Service Python lock is incomplete") from error
    if onnx_version != EXPECTED_ONNXRUNTIME[provider]:
        raise ServiceDoctorError("ONNX Runtime version is not accepted")
    if separator_version != EXPECTED_AUDIO_SEPARATOR:
        raise ServiceDoctorError("Audio Separator version is not accepted")
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise ServiceDoctorError("ONNX Runtime is unavailable") from error
    providers = ort.get_available_providers()
    if provider_name not in providers:
        raise ServiceDoctorError("Accepted execution provider is unavailable")
    conflicting = (
        ("onnxruntime-directml",)
        if provider == "coreml"
        else ("onnxruntime", "onnxruntime-gpu")
    )
    for package in conflicting:
        try:
            importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            continue
        raise ServiceDoctorError("Conflicting ONNX Runtime distribution is installed")
    model = verified_cached_model(model_cache)
    ffmpeg_version, ffprobe_version = validate_media_runtime(ffmpeg, ffprobe)
    return {
        "status": "ok",
        "platform": system,
        "architecture": architecture,
        "python": platform.python_version(),
        "onnxRuntime": onnx_version,
        "audioSeparator": separator_version,
        "provider": provider_name,
        "modelSha256": MODEL_SHA256,
        "modelBytes": MODEL_BYTES,
        "ffmpeg": ffmpeg_version,
        "ffprobe": ffprobe_version,
        "modelPath": str(model),
    }


def accepted_runtime(provider: str) -> tuple[str, str, str, str]:
    if provider == "coreml":
        if platform.system() != "Darwin" or platform.machine() != "arm64":
            raise ServiceDoctorError("Service host is not Darwin ARM64")
        return "darwin", "arm64", "onnxruntime", "CoreMLExecutionProvider"
    if provider == "directml":
        if platform.system() != "Windows" or platform.machine().lower() not in {
            "amd64",
            "x86_64",
        }:
            raise ServiceDoctorError("Service host is not Windows x86_64")
        return "win32", "x64", "onnxruntime-directml", "DmlExecutionProvider"
    raise ServiceDoctorError("Service provider is unsupported")


def executable_version(path: Path) -> str:
    output = _media_command(path, ("-version",), OUTPUT_LIMIT)
    first_line = output.decode("utf-8", errors="replace").splitlines()
    if not first_line or len(first_line[0]) > 512:
        raise ServiceDoctorError("Service media executable version is invalid")
    return first_line[0]


def validate_media_runtime(ffmpeg: Path, ffprobe: Path) -> tuple[str, str]:
    ffmpeg_version = executable_version(ffmpeg)
    ffprobe_version = executable_version(ffprobe)
    if not ffmpeg_version.startswith(f"ffmpeg version {EXPECTED_FFMPEG} "):
        raise ServiceDoctorError("Service FFmpeg version is not accepted")
    if not ffprobe_version.startswith(f"ffprobe version {EXPECTED_FFMPEG} "):
        raise ServiceDoctorError("Service FFprobe version is not accepted")

    encoders = _listed_features(
        _media_command(ffmpeg, ("-hide_banner", "-encoders"), CAPABILITY_OUTPUT_LIMIT)
    )
    filters = _listed_features(
        _media_command(ffmpeg, ("-hide_banner", "-filters"), CAPABILITY_OUTPUT_LIMIT)
    )
    protocols = {
        line.strip()
        for line in _media_command(
            ffmpeg, ("-hide_banner", "-protocols"), CAPABILITY_OUTPUT_LIMIT
        )
        .decode("utf-8", errors="replace")
        .splitlines()
        if line.strip()
    }
    if not REQUIRED_ENCODERS.issubset(encoders):
        raise ServiceDoctorError("Service FFmpeg encoder set is incomplete")
    if not REQUIRED_FILTERS.issubset(filters):
        raise ServiceDoctorError("Service FFmpeg filter set is incomplete")
    if "file" not in protocols or NETWORK_PROTOCOLS.intersection(protocols):
        raise ServiceDoctorError("Service FFmpeg protocol set is unsafe")
    return ffmpeg_version, ffprobe_version


def _listed_features(output: bytes) -> set[str]:
    features: set[str] = set()
    for line in output.decode("utf-8", errors="replace").splitlines():
        fields = line.split()
        if len(fields) >= 2:
            features.add(fields[1])
    return features


def _media_command(path: Path, arguments: tuple[str, ...], limit: int) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ServiceDoctorError("Service media executable is unsafe")
    if not os.access(path, os.X_OK):
        raise ServiceDoctorError("Service media executable is not executable")
    try:
        completed = subprocess.run(
            [str(path), *arguments],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ServiceDoctorError("Service media executable could not run") from error
    if completed.returncode != 0 or len(completed.stdout) > limit:
        raise ServiceDoctorError("Service media executable failed")
    return completed.stdout


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument(
        "--provider", choices=("coreml", "directml"), default="coreml"
    )
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--ffprobe", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        diagnostics = collect_diagnostics(
            model_cache=arguments.model_cache,
            ffmpeg=arguments.ffmpeg,
            ffprobe=arguments.ffprobe,
            provider=arguments.provider,
        )
    except (ServiceDoctorError, OSError, RuntimeError):
        print("MusicMute service runtime: FAILED", file=sys.stderr)
        return 1
    print(json.dumps(diagnostics, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
