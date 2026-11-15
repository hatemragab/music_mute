"""Run the packaged Kim pipeline and emit service-context qualification evidence."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import platform
import shutil
import subprocess
import time
import uuid
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from .media import sha256_base64
from .pipeline import ProcessRequest, RuntimePipeline
from .provider_adapter import (
    CPU_PROVIDER,
    DIRECTML_PROVIDER,
    Provider,
    discover_provider,
)
from .recipes import (
    DEFAULT_RECIPE_ID,
    MODEL_SHA256,
    RECIPE_DEFINITIONS,
    recipe_snapshot,
)
from .separator import KimSeparator
from .service_doctor import collect_diagnostics

try:
    import pwd
except ImportError:  # Windows does not provide the POSIX account database.
    pwd = None  # type: ignore[assignment]

PROFILE_LIMIT_BYTES = 64 * 1024 * 1024
RELEASE_MANIFEST_LIMIT_BYTES = 16 * 1024 * 1024
REPORT_SCHEMA_VERSION = 1
QUALIFIED_IDENTITIES = {"Windows": "S-1-5-19"}


class QualificationError(RuntimeError):
    """Raised when service-context GPU qualification cannot be proven."""


def sha256_hex(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def service_identity() -> str:
    if platform.system() == "Windows":
        system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
        whoami = system_root / "System32" / "whoami.exe"
        try:
            completed = subprocess.run(
                [str(whoami), "/user", "/fo", "csv", "/nh"],
                check=True,
                capture_output=True,
                text=True,
                timeout=10,
            )
            row = next(csv.reader([completed.stdout.strip()]))
        except (
            OSError,
            subprocess.SubprocessError,
            StopIteration,
            csv.Error,
        ) as error:
            raise QualificationError(
                "Windows service identity is unavailable"
            ) from error
        if len(row) != 2 or not row[1].startswith("S-1-"):
            raise QualificationError("Windows service identity is unavailable")
        return row[1]
    if pwd is None:
        raise QualificationError("POSIX service identity is unavailable")
    return pwd.getpwuid(os.geteuid()).pw_name


def summarize_profiles(
    paths: Iterable[Path], expected_provider: str
) -> dict[str, object]:
    counts: Counter[str] = Counter()
    profile_count = 0
    for path in paths:
        info = path.stat()
        if (
            not path.is_file()
            or path.is_symlink()
            or info.st_size < 2
            or info.st_size > PROFILE_LIMIT_BYTES
        ):
            raise QualificationError("ONNX provider profile is unsafe")
        try:
            events = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise QualificationError("ONNX provider profile is invalid") from error
        if not isinstance(events, list):
            raise QualificationError("ONNX provider profile is invalid")
        profile_count += 1
        for event in events:
            if not isinstance(event, dict):
                raise QualificationError("ONNX provider profile is invalid")
            arguments = event.get("args")
            if not isinstance(arguments, dict):
                continue
            provider = arguments.get("provider")
            if isinstance(provider, str):
                counts[provider] += 1

    accelerated = counts[expected_provider]
    cpu = counts[CPU_PROVIDER]
    proven = profile_count > 0 and accelerated > 0 and cpu == 0
    return {
        "expectedProvider": expected_provider,
        "profileCount": profile_count,
        "acceleratedNodeEvents": accelerated,
        "cpuNodeEvents": cpu,
        "proven": proven,
    }


def selected_recipe_ids(arguments: argparse.Namespace) -> list[str]:
    selected_recipe = getattr(arguments, "recipe_id", None)
    if selected_recipe is not None:
        return [selected_recipe] * getattr(arguments, "iterations", 1)
    return list(RECIPE_DEFINITIONS)


def mps_memory_snapshot() -> dict[str, int] | None:
    """Boundary allocation, not peak GPU occupancy or total system memory."""
    try:
        import torch

        return {
            "tensorAllocatedBytes": int(torch.mps.current_allocated_memory()),
            "driverAllocatedBytes": int(torch.mps.driver_allocated_memory()),
        }
    except (AttributeError, RuntimeError, TypeError, ValueError):
        return None


def run_qualification(arguments: argparse.Namespace) -> dict[str, object]:
    progress = getattr(arguments, "progress", None)

    def emit(kind: str, **fields: object) -> None:
        if callable(progress):
            progress({"type": kind, **fields})

    benchmark_mode = getattr(arguments, "benchmark_mode", False) is True
    save_audio_dir: Path | None = getattr(arguments, "save_audio_dir", None)
    if save_audio_dir is not None:
        if not save_audio_dir.is_absolute() or save_audio_dir.exists():
            raise QualificationError("Benchmark audio directory must be a new absolute path")
        save_audio_dir.mkdir(mode=0o700)
    system = platform.system()
    identity = service_identity()
    expected_identity = QUALIFIED_IDENTITIES.get(system)
    if system == "Darwin":
        identity_is_valid = identity.casefold() != "root"
    else:
        identity_is_valid = (
            expected_identity is not None
            and identity.casefold() == expected_identity.casefold()
        )
    if not identity_is_valid:
        raise QualificationError(
            "Qualification must run as the worker service identity"
        )

    fixture = arguments.fixture.resolve(strict=True)
    work_root = arguments.work_root.resolve(strict=True)
    release_root = arguments.release_root.resolve(strict=True)
    if fixture.is_symlink() or not fixture.is_file():
        raise QualificationError("Qualification fixture is unsafe")
    if work_root.is_symlink() or not work_root.is_dir():
        raise QualificationError("Qualification work root is unsafe")
    if release_root.is_symlink() or not release_root.is_dir():
        raise QualificationError("Qualification release root is unsafe")
    release_manifest = release_root / "release-manifest.json"
    manifest_info = release_manifest.stat()
    if (
        not release_manifest.is_file()
        or release_manifest.is_symlink()
        or manifest_info.st_size < 2
        or manifest_info.st_size > RELEASE_MANIFEST_LIMIT_BYTES
    ):
        raise QualificationError("Qualification release manifest is unsafe")
    release_manifest_digest = sha256_hex(release_manifest)
    runtime_diagnostics = collect_diagnostics(
        model_cache=arguments.model_cache,
        ffmpeg=arguments.ffmpeg,
        ffprobe=arguments.ffprobe,
        provider=arguments.provider,
    )
    qualification_root = work_root / f"qualification-{uuid.uuid4()}"
    qualification_root.mkdir(mode=0o700)
    qualified_fixture = qualification_root / f"fixture{fixture.suffix.lower()}"
    shutil.copyfile(fixture, qualified_fixture)
    fixture_digest = sha256_hex(qualified_fixture)
    if fixture_digest != arguments.fixture_sha256:
        raise QualificationError("Qualification fixture digest does not match")
    profile_root = qualification_root / "profiles"
    profile_root.mkdir(mode=0o700)
    captured: list[KimSeparator] = []

    def separator_factory(
        provider: Provider, model: Path, device_id: int
    ) -> KimSeparator:
        separator = KimSeparator(
            provider,
            model,
            directml_device_id=device_id,
            profile_directory=profile_root,
            group_size=getattr(arguments, "group_size", 1) if benchmark_mode else None,
        )
        captured.append(separator)
        return separator

    pipeline = RuntimePipeline(separator_factory)
    results: list[dict[str, object]] = []
    saved_audio_artifacts: list[dict[str, object]] = []
    upload_candidate: dict[str, object] | None = None
    started = time.monotonic()
    preload_started = time.monotonic()
    emit("preload-start")
    pipeline.preload(
        arguments.model_cache.resolve(strict=True),
        arguments.provider,
        arguments.directml_device_id,
        progress=lambda stage: emit("startup-stage", stage=stage),
    )
    if benchmark_mode and arguments.provider == "mps":
        import torch

        torch.mps.synchronize()
    preload_seconds = time.monotonic() - preload_started
    emit("preload-complete", seconds=preload_seconds)
    if not math.isfinite(preload_seconds) or preload_seconds <= 0:
        raise QualificationError("Qualification preload timing is invalid")
    profile_paths: tuple[Path, ...] = ()
    try:
        selected_recipe = getattr(arguments, "recipe_id", None)
        for index, recipe_id in enumerate(selected_recipe_ids(arguments)):
            role = (
                "cold"
                if index == 0
                else "warmup"
                if index <= getattr(arguments, "warmup_runs", 0)
                else "measured"
            )
            emit("run-start", index=index + 1, role=role, recipeId=recipe_id)
            attempt_id = str(uuid.uuid4())
            attempt = qualification_root / attempt_id
            attempt.mkdir(mode=0o700)
            local_input = attempt / f"input{qualified_fixture.suffix.lower()}"
            shutil.copyfile(qualified_fixture, local_input)
            recipe_started = time.monotonic()
            request = ProcessRequest.from_payload(
                {
                    "attemptId": attempt_id,
                    "attemptDirectory": str(attempt),
                    "input": {
                        "path": str(local_input),
                        "bytes": local_input.stat().st_size,
                        "sha256": sha256_base64(local_input),
                    },
                    "modelCacheRoot": str(arguments.model_cache.resolve(strict=True)),
                    "provider": arguments.provider,
                    "directmlDeviceId": arguments.directml_device_id,
                    "ffmpegPath": str(arguments.ffmpeg.resolve(strict=True)),
                    "ffprobePath": str(arguments.ffprobe.resolve(strict=True)),
                    "recipe": recipe_snapshot(recipe_id),
                }
            )
            memory_before = mps_memory_snapshot() if benchmark_mode else None
            result = pipeline.process(request, lambda stage: emit("run-stage", index=index + 1, stage=stage))
            grouping = None
            if benchmark_mode:
                selected_group = getattr(arguments, "group_size", 1)
                grouping = captured[0].grouping_evidence()
                if (
                    grouping["selectedSize"] != selected_group
                    or grouping["processedWindows"] < 1
                    or grouping["modelCalls"] < 1
                    or grouping["largestBatch"] < 1
                    or grouping["largestBatch"] > selected_group
                    or grouping["modelCalls"] != math.ceil(grouping["processedWindows"] / selected_group)
                ):
                    raise QualificationError("Benchmark window grouping evidence is invalid")
            if benchmark_mode and arguments.provider == "mps":
                torch.mps.synchronize()
            memory_after = mps_memory_snapshot() if benchmark_mode else None
            output = Path(result["outputPath"]).resolve(strict=True)
            if not output.is_relative_to(qualification_root):
                raise QualificationError("Qualification result path is unsafe")
            if system != "Windows":
                output.chmod(0o600)
            elapsed = time.monotonic() - recipe_started
            if not math.isfinite(elapsed) or elapsed <= 0:
                raise QualificationError("Qualification benchmark is invalid")
            results.append(
                {
                    "recipeId": result["recipeId"],
                    "recipeDigest": result["recipeDigest"],
                    "resultDigest": sha256_hex(output),
                    "resultBytes": result["bytes"],
                    "sourceDurationSeconds": result["sourceDurationSeconds"],
                    "outputDurationSeconds": result["measuredOutputDurationSeconds"],
                    "endToEndSeconds": elapsed,
                    "outputBitrateKbps": result["outputBitrateKbps"],
                    "stageTimings": result["stageTimings"],
                    **({
                        "role": role,
                        "iteration": index + 1,
                        "measuredInputDurationSeconds": result["measuredInputDurationSeconds"],
                        "measuredInputSamples": result["measuredInputSamples"],
                        "gpuMemoryBefore": memory_before,
                        "gpuMemoryAfter": memory_after,
                        "grouping": grouping,
                    } if benchmark_mode else {}),
                }
            )
            if save_audio_dir is not None:
                mp3 = save_audio_dir / f"{index + 1:02d}-{role}-vocals.mp3"
                shutil.copyfile(output, mp3)
                if system != "Windows":
                    mp3.chmod(0o600)
                for artifact in (mp3,):
                    saved_audio_artifacts.append({
                        "iteration": index + 1,
                        "role": role,
                        "format": artifact.suffix.removeprefix("."),
                        "fileName": artifact.name,
                        "sha256": sha256_hex(artifact),
                        "bytes": artifact.stat().st_size,
                    })
            emit("run-complete", index=index + 1, role=role, seconds=elapsed)
            if upload_candidate is None and (
                selected_recipe is not None or recipe_id == DEFAULT_RECIPE_ID
            ):
                upload_candidate = {
                    "path": str(output),
                    "resultDigest": sha256_hex(output),
                    "resultBytes": result["bytes"],
                    "contentType": "audio/mpeg",
                }
        if len(captured) != 1:
            raise QualificationError("Qualification did not use one stable Kim runtime")
        if arguments.provider == "mps":
            discover_provider("mps", arguments.directml_device_id)
            dispatch = captured[0].mps_dispatch_evidence()
        else:
            profile_paths = captured[0].finish_profiles()
            dispatch = summarize_profiles(profile_paths, DIRECTML_PROVIDER)
        if not dispatch["proven"]:
            raise QualificationError("Accelerated provider dispatch was not proven")
    finally:
        for path in profile_paths:
            path.unlink(missing_ok=True)

    total_seconds = time.monotonic() - started
    if not math.isfinite(total_seconds) or total_seconds <= 0:
        raise QualificationError("Qualification benchmark is invalid")
    if upload_candidate is None:
        raise QualificationError("Qualification upload candidate is unavailable")
    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "status": "PASS",
        "platform": "darwin-arm64" if system == "Darwin" else "windows-amd64",
        "provider": arguments.provider,
        "gpuId": "gpu0",
        "directmlDeviceId": arguments.directml_device_id,
        "serviceIdentity": identity,
        "releaseManifestDigest": release_manifest_digest,
        "modelDigest": MODEL_SHA256,
        "fixtureDigest": fixture_digest,
        "runtimeDiagnostics": runtime_diagnostics,
        "providerDispatch": dispatch,
        "recipes": results,
        "uploadCandidate": upload_candidate,
        "preloadSeconds": preload_seconds,
        "totalSeconds": total_seconds,
        **({"savedAudioArtifacts": saved_audio_artifacts} if benchmark_mode else {}),
    }


def write_private_report(path: Path, report: dict[str, object]) -> None:
    if not path.is_absolute() or path.exists():
        raise QualificationError("Qualification report must be a new absolute path")
    path.parent.resolve(strict=True)
    payload = json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n"
    temporary = path.with_name(f".{path.name}.{uuid.uuid4()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as target:
            target.write(payload)
            target.flush()
            os.fsync(target.fileno())
        if platform.system() != "Windows":
            temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=("mps", "directml"), required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--fixture-sha256", required=True)
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--release-root", type=Path, required=True)
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--ffprobe", type=Path, required=True)
    parser.add_argument("--directml-device-id", type=int, default=0)
    parser.add_argument("--recipe-id", choices=tuple(RECIPE_DEFINITIONS))
    parser.add_argument("--iterations", type=int, default=1)
    parser.add_argument("--report", type=Path, required=True)
    arguments = parser.parse_args()
    if not all(
        path.is_absolute()
        for path in (
            arguments.fixture,
            arguments.work_root,
            arguments.release_root,
            arguments.model_cache,
            arguments.ffmpeg,
            arguments.ffprobe,
            arguments.report,
        )
    ):
        parser.error("all qualification paths must be absolute")
    if not isinstance(arguments.fixture_sha256, str) or (
        len(arguments.fixture_sha256) != 64
        or any(
            character not in "0123456789abcdef"
            for character in arguments.fixture_sha256
        )
    ):
        parser.error("--fixture-sha256 must be lowercase hexadecimal SHA-256")
    if not 0 <= arguments.directml_device_id <= 15:
        parser.error("--directml-device-id must be between 0 and 15")
    if arguments.iterations not in (1, 2):
        parser.error("--iterations must be 1 or 2")
    if arguments.iterations == 2 and arguments.recipe_id is None:
        parser.error("--iterations 2 requires --recipe-id")
    return arguments


def main() -> int:
    arguments = parse_args()
    report = run_qualification(arguments)
    write_private_report(arguments.report, report)
    print(json.dumps({"status": "ok", "report": str(arguments.report)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
