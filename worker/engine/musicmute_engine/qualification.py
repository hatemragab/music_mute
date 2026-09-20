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
    COREML_PROVIDER,
    DIRECTML_PROVIDER,
    Provider,
)
from .recipes import MODEL_SHA256, RECIPE_DEFINITIONS, recipe_snapshot
from .separator import KimSeparator
from .service_doctor import collect_diagnostics

try:
    import pwd
except ImportError:  # Windows does not provide the POSIX account database.
    pwd = None  # type: ignore[assignment]

PROFILE_LIMIT_BYTES = 64 * 1024 * 1024
RELEASE_MANIFEST_LIMIT_BYTES = 16 * 1024 * 1024
REPORT_SCHEMA_VERSION = 1
QUALIFIED_IDENTITIES = {"Darwin": "_musicmute", "Windows": "S-1-5-19"}


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


def run_qualification(arguments: argparse.Namespace) -> dict[str, object]:
    system = platform.system()
    expected_identity = QUALIFIED_IDENTITIES.get(system)
    identity = service_identity()
    if (
        expected_identity is None
        or identity.casefold() != expected_identity.casefold()
    ):
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
        )
        captured.append(separator)
        return separator

    pipeline = RuntimePipeline(separator_factory)
    results: list[dict[str, object]] = []
    upload_candidate: dict[str, object] | None = None
    started = time.monotonic()
    profile_paths: tuple[Path, ...] = ()
    try:
        for recipe_id in RECIPE_DEFINITIONS:
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
            result = pipeline.process(request)
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
                }
            )
            if recipe_id == "kim-vocals-v1":
                upload_candidate = {
                    "path": str(output),
                    "resultDigest": sha256_hex(output),
                    "resultBytes": result["bytes"],
                    "contentType": "audio/mpeg",
                }
        if len(captured) != 1:
            raise QualificationError("Qualification did not use one stable Kim runtime")
        profile_paths = captured[0].finish_profiles()
        expected_provider = (
            COREML_PROVIDER if arguments.provider == "coreml" else DIRECTML_PROVIDER
        )
        dispatch = summarize_profiles(profile_paths, expected_provider)
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
        "totalSeconds": total_seconds,
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
    parser.add_argument("--provider", choices=("coreml", "directml"), required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--fixture-sha256", required=True)
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--release-root", type=Path, required=True)
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--ffprobe", type=Path, required=True)
    parser.add_argument("--directml-device-id", type=int, default=0)
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
    return arguments


def main() -> int:
    arguments = parse_args()
    report = run_qualification(arguments)
    write_private_report(arguments.report, report)
    print(json.dumps({"status": "ok", "report": str(arguments.report)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
