"""Private repeated MPS file benchmark for a stopped local worker."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any

from .media import CHANNELS, SAMPLE_RATE
from .qualification import QualificationError, run_qualification, write_private_report
from .recipes import RECIPE_DEFINITIONS, recipe_snapshot
from .separator import (
    KIM_VOCAL_2_HOP_LENGTH,
    KIM_VOCAL_2_N_FFT,
    KIM_VOCAL_2_OVERLAP,
    KIM_VOCAL_2_SEGMENT_SIZE,
)


def code_digest(root: Path) -> str:
    if not root.is_dir() or root.is_symlink():
        raise QualificationError("Benchmark engine root is unsafe")
    package = root / "musicmute_engine"
    files = sorted(package.rglob("*.py"))
    if not files or len(files) > 200:
        raise QualificationError("Benchmark engine source is invalid")
    digest = hashlib.sha256()
    total = 0
    for path in files:
        if path.is_symlink() or not path.is_file():
            raise QualificationError("Benchmark engine source is unsafe")
        data = path.read_bytes()
        total += len(data)
        if total > 10 * 1024 * 1024:
            raise QualificationError("Benchmark engine source is too large")
        digest.update(str(path.relative_to(root)).encode("utf-8"))
        digest.update(b"\0")
        digest.update(data)
        digest.update(b"\0")
    return digest.hexdigest()


def gpu_model() -> str | None:
    try:
        completed = subprocess.run(
            ["/usr/sbin/system_profiler", "SPDisplaysDataType", "-json"],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
        if completed.returncode != 0 or len(completed.stdout) > 1024 * 1024:
            return None
        displays = json.loads(completed.stdout).get("SPDisplaysDataType", [])
        if not isinstance(displays, list):
            return None
        for display in displays:
            model = display.get("sppci_model") if isinstance(display, dict) else None
            if isinstance(model, str) and 1 <= len(model) <= 100 and all(
                character.isalnum() or character in " ._-" for character in model
            ):
                return model
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, AttributeError):
        pass
    return None


def build_report(raw: dict[str, object], arguments: argparse.Namespace, engine_digest: str) -> dict[str, object]:
    recipes = raw["recipes"]
    if not isinstance(recipes, list) or len(recipes) != 1 + arguments.warmup_runs + arguments.measured_runs:
        raise QualificationError("Benchmark run count is invalid")
    first = recipes[0]
    if not isinstance(first, dict):
        raise QualificationError("Benchmark first run is invalid")
    runtime = raw["runtimeDiagnostics"]
    if not isinstance(runtime, dict):
        raise QualificationError("Benchmark runtime evidence is invalid")
    snapshot = recipe_snapshot(arguments.recipe_id)
    detected_gpu_model = gpu_model()
    return {
        "schemaVersion": 2,
        "status": "PASS",
        "scope": "local-engine-only",
        "sourceMode": "candidate-engine" if arguments.candidate_engine_root else "installed-engine",
        "engineDigest": engine_digest,
        "releaseManifestDigest": raw["releaseManifestDigest"],
        "fixtureDigest": raw["fixtureDigest"],
        "modelDigest": raw["modelDigest"],
        "recipeId": arguments.recipe_id,
        "recipeDigest": first["recipeDigest"],
        "provider": "mps",
        "fallbackDisabled": os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK", "0") == "0",
        "providerDispatch": raw["providerDispatch"],
        "gpuModel": detected_gpu_model,
        "gpuModelSource": "system_profiler SPDisplaysDataType" if detected_gpu_model else "unavailable",
        "osVersion": platform.mac_ver()[0],
        "machineArchitecture": platform.machine(),
        "runtime": {key: value for key, value in runtime.items() if key != "modelPath"},
        "source": {
            "sha256": raw["fixtureDigest"],
            "bytes": arguments.fixture.stat().st_size,
            "decodedDurationSeconds": first["measuredInputDurationSeconds"],
            "decodedSamples": first["measuredInputSamples"],
            "sampleRate": SAMPLE_RATE,
            "channels": CHANNELS,
        },
        "audioSettings": {
            "format": snapshot["outputFormat"],
            "bitrateKbps": first["outputBitrateKbps"],
            "groupSize": arguments.group_size,
            "hopLength": KIM_VOCAL_2_HOP_LENGTH,
            "segmentSize": KIM_VOCAL_2_SEGMENT_SIZE,
            "fftSize": KIM_VOCAL_2_N_FFT,
            "overlap": KIM_VOCAL_2_OVERLAP,
        },
        "preloadSeconds": raw["preloadSeconds"],
        "warmupRuns": arguments.warmup_runs,
        "measuredRuns": arguments.measured_runs,
        "runs": recipes,
        "savedAudio": arguments.save_audio_dir is not None,
        "savedAudioArtifacts": raw["savedAudioArtifacts"],
        "memoryScope": "MPS process allocation sampled at run boundaries; not peak occupancy",
        "timingScope": "MPS synchronized at full-run boundaries; no per-window synchronization",
        "networkUsed": False,
        "backendUsed": False,
        "cpuInferenceBenchmark": False,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=("mps",), required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--fixture-sha256", required=True)
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--release-root", type=Path, required=True)
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--ffprobe", type=Path, required=True)
    parser.add_argument("--recipe-id", choices=tuple(RECIPE_DEFINITIONS), required=True)
    parser.add_argument("--warmup-runs", type=int, default=1)
    parser.add_argument("--measured-runs", type=int, default=3)
    parser.add_argument("--group-size", type=int, default=1)
    parser.add_argument("--candidate-engine-root", type=Path)
    parser.add_argument("--save-audio-dir", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    arguments = parser.parse_args()
    paths = [arguments.fixture, arguments.work_root, arguments.release_root,
             arguments.model_cache, arguments.ffmpeg, arguments.ffprobe, arguments.report]
    paths += [path for path in (arguments.candidate_engine_root, arguments.save_audio_dir) if path is not None]
    if not all(path.is_absolute() for path in paths):
        parser.error("all benchmark paths must be absolute")
    if arguments.group_size not in (1, 2, 4):
        parser.error("window group must be 1, 2, or 4")
    if os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK", "0") != "0":
        parser.error("MPS CPU fallback must be disabled for GPU-only benchmarks")
    if not 0 <= arguments.warmup_runs <= 2 or not 3 <= arguments.measured_runs <= 10:
        parser.error("warm-up runs must be 0-2 and measured runs must be 3-10")
    if not isinstance(arguments.fixture_sha256, str) or len(arguments.fixture_sha256) != 64 or any(
        character not in "0123456789abcdef" for character in arguments.fixture_sha256
    ):
        parser.error("fixture SHA-256 must be lowercase hexadecimal")
    return arguments


def main() -> int:
    arguments = parse_args()
    package_root = Path(__file__).resolve().parent.parent
    if arguments.candidate_engine_root is not None and arguments.candidate_engine_root.resolve(strict=True) != package_root:
        raise QualificationError("Benchmark candidate engine does not match imported code")
    engine_digest = code_digest(package_root)
    progress: list[dict[str, Any]] = []

    def emit(event: dict[str, Any]) -> None:
        if len(progress) < 1_000:
            progress.append(event)
        print(json.dumps(event, sort_keys=True, separators=(",", ":")), flush=True)

    arguments.benchmark_mode = True
    arguments.progress = emit
    arguments.iterations = 1 + arguments.warmup_runs + arguments.measured_runs
    arguments.directml_device_id = 0
    try:
        raw = run_qualification(arguments)
        report = build_report(raw, arguments, engine_digest)
        write_private_report(arguments.report, report)
        emit({"type": "report-ready", "status": "PASS"})
        return 0
    except Exception as error:
        failure = {
            "schemaVersion": 2, "status": "FAIL", "scope": "local-engine-only",
            "engineDigest": engine_digest, "fixtureDigest": arguments.fixture_sha256,
            "provider": "mps", "recipeId": arguments.recipe_id,
            "code": type(error).__name__[:64],
            "reason": str(error) if isinstance(error, QualificationError) else "Benchmark runtime failed",
            "progress": progress[-100:],
        }
        write_private_report(arguments.report, failure)
        emit({"type": "report-ready", "status": "FAIL", "code": failure["code"]})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
