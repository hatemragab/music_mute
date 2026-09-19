"""Sanitized service-context validation for the accepted Mac runtime."""

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

EXPECTED_PYTHON = (3, 13)
EXPECTED_ONNXRUNTIME = "1.30.0"
EXPECTED_AUDIO_SEPARATOR = "0.47.0"
OUTPUT_LIMIT = 16 * 1024


class ServiceDoctorError(RuntimeError):
    """Raised when the installed service runtime is not the accepted build."""


def collect_diagnostics(
    *, model_cache: Path, ffmpeg: Path, ffprobe: Path
) -> dict[str, Any]:
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ServiceDoctorError("Service host is not Darwin ARM64")
    if sys.version_info[:2] != EXPECTED_PYTHON:
        raise ServiceDoctorError("Service Python version is not accepted")
    try:
        onnx_version = importlib.metadata.version("onnxruntime")
        separator_version = importlib.metadata.version("audio-separator")
    except importlib.metadata.PackageNotFoundError as error:
        raise ServiceDoctorError("Service Python lock is incomplete") from error
    if onnx_version != EXPECTED_ONNXRUNTIME:
        raise ServiceDoctorError("ONNX Runtime version is not accepted")
    if separator_version != EXPECTED_AUDIO_SEPARATOR:
        raise ServiceDoctorError("Audio Separator version is not accepted")
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise ServiceDoctorError("ONNX Runtime is unavailable") from error
    providers = ort.get_available_providers()
    if "CoreMLExecutionProvider" not in providers:
        raise ServiceDoctorError("CoreML execution provider is unavailable")
    try:
        importlib.metadata.version("onnxruntime-directml")
    except importlib.metadata.PackageNotFoundError:
        pass
    else:
        raise ServiceDoctorError("DirectML runtime must not be installed on Mac")
    model = verified_cached_model(model_cache)
    return {
        "status": "ok",
        "platform": "darwin",
        "architecture": "arm64",
        "python": platform.python_version(),
        "onnxRuntime": onnx_version,
        "audioSeparator": separator_version,
        "provider": "CoreMLExecutionProvider",
        "modelSha256": MODEL_SHA256,
        "modelBytes": MODEL_BYTES,
        "ffmpeg": executable_version(ffmpeg),
        "ffprobe": executable_version(ffprobe),
        "modelPath": str(model),
    }


def executable_version(path: Path) -> str:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ServiceDoctorError("Service media executable is unsafe")
    if not os.access(path, os.X_OK):
        raise ServiceDoctorError("Service media executable is not executable")
    try:
        completed = subprocess.run(
            [str(path), "-version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ServiceDoctorError("Service media executable could not run") from error
    if completed.returncode != 0 or len(completed.stdout) > OUTPUT_LIMIT:
        raise ServiceDoctorError("Service media executable failed")
    first_line = completed.stdout.decode("utf-8", errors="replace").splitlines()
    if not first_line or len(first_line[0]) > 512:
        raise ServiceDoctorError("Service media executable version is invalid")
    return first_line[0]


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--ffprobe", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        diagnostics = collect_diagnostics(
            model_cache=arguments.model_cache,
            ffmpeg=arguments.ffmpeg,
            ffprobe=arguments.ffprobe,
        )
    except (ServiceDoctorError, OSError, RuntimeError):
        print("MusicMute service runtime: FAILED", file=sys.stderr)
        return 1
    print(json.dumps(diagnostics, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
