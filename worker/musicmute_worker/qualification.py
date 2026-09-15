"""Actual execution observations, separate from signed/native approval authority."""

from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import tempfile
import time

from .profiles import ProfileError, PreparedRuntime, digest_file, fetch_asset
from .processes import ProcessRunner
from .hardware import detect_hardware


class QualificationError(ProfileError):
    def __init__(self, code="GPU_QUALIFICATION_FAILED"):
        super().__init__(code)


def execution_evidence(events: object, provider: str, native_log: str) -> dict:
    if not isinstance(events, list) or len(events) > 1_000_000:
        raise QualificationError()
    assignments = []
    for event in events:
        if not isinstance(event, dict):
            raise QualificationError()
        args = event.get("args", {})
        if (
            event.get("cat") == "Node"
            and isinstance(args, dict)
            and args.get("provider")
        ):
            assignments.append(args["provider"])
    if "CPUExecutionProvider" in assignments:
        raise QualificationError("CPU_ONLY_UNSUPPORTED")
    if not assignments or any(item != provider for item in assignments):
        raise QualificationError()
    nodes = len(assignments)
    if provider == "CoreMLExecutionProvider":
        # ORT sees a fused subgraph. Its provider label cannot prove CoreML's
        # internal CPU/GPU/ANE allocation; require every compute-plan operation.
        operations = re.findall(r"Operation: [^\n]+", native_log)
        if not operations or any(
            "Device Usage: <MLGPUComputeDevice:" not in line for line in operations
        ):
            raise QualificationError(
                "CPU_ONLY_UNSUPPORTED"
                if any("MLCPUComputeDevice" in line for line in operations)
                else "GPU_QUALIFICATION_FAILED"
            )
        nodes = len(operations)
    return {
        "method": "ort-profile+coreml-compute-plan"
        if provider == "CoreMLExecutionProvider"
        else "ort-profile",
        "neuralNodes": nodes,
        "acceleratedNodes": nodes,
        "cpuNodes": 0,
    }


class QualificationRunner:
    """Runs the sole separator in an isolated bounded child, never a service.

    A successful audio smoke is still reported with serviceContextPassed=false.
    Only the native adapter/V01 can supply service/boot evidence and H01 can sign
    admission. There is no local shortcut from a subprocess success to readiness.
    """

    def __init__(
        self,
        runtime: PreparedRuntime,
        separator: Path,
        cache: Path,
        *,
        service_context_check=None,
    ):
        self.runtime = runtime
        self.separator = separator
        self.cache = cache
        self.service_context_check = service_context_check

    def qualify(self, profile, fixture_path: Path):
        runtime = self.runtime
        if (
            profile != runtime.profile
            or digest_file(fixture_path) != profile.fixture.sha256
        ):
            raise QualificationError("MODEL_INTEGRITY_FAILED")
        started = time.monotonic()
        hardware = detect_hardware(runtime.root)
        device = next(
            (item for item in hardware.devices if item.vendor == profile.vendor), None
        )
        report = {
            "profileId": profile.profile_id,
            "modelSha256": profile.model.sha256,
            "fixtureSha256": profile.fixture.sha256,
            "acceleratorUsed": False,
            "provider": profile.provider,
            "deviceLabel": device.label if device else "unverified GPU",
            "wallMilliseconds": 1,
            "peakRamBytes": None,
            "peakGpuMemoryBytes": None,
            "outputValid": False,
            "referenceCheckPassed": False,
            "serviceContextPassed": False,
            "reasonCodes": [],
        }
        with tempfile.TemporaryDirectory(
            prefix="qualification-", dir=runtime.root / "work"
        ) as directory:
            work = Path(directory)
            request = work / "request.json"
            reference = (
                fetch_asset(profile.reference, self.cache)
                if profile.reference
                else None
            )
            request.write_text(
                json.dumps(
                    {
                        "model": str(runtime.model),
                        "modelSha256": profile.model.sha256,
                        "provider": profile.provider,
                        "options": profile.options,
                        "input": str(fixture_path),
                        "ffmpeg": str(runtime.ffmpeg),
                        "output": str(work / "vocals.wav"),
                        "reference": str(reference) if reference else None,
                        "maxDurationSeconds": profile.max_duration_seconds,
                        "maxRamBytes": profile.max_ram_bytes,
                        "referenceMaxAbs": profile.reference_max_abs,
                        "referenceRms": profile.reference_rms,
                    }
                )
            )
            try:
                # The child owns no worker identity, journals or claim transport.
                def check():
                    if (
                        sum(
                            item.stat().st_size
                            for item in work.iterdir()
                            if item.is_file()
                        )
                        > 64 * 1024**2
                    ):
                        raise QualificationError("INSUFFICIENT_DISK")

                ProcessRunner().run(
                    [
                        str(runtime.python),
                        "-I",
                        "-B",
                        str(self.separator),
                        "--qualify",
                        str(request),
                    ],
                    cwd=work,
                    timeout=profile.max_wall_seconds,
                    check=check,
                    capture=True,
                )
                result = json.loads((work / "result.json").read_text())
                events = json.loads((work / "profile.json").read_text())
                execution_evidence(
                    events,
                    profile.provider,
                    (work / "placement.log").read_text(errors="replace"),
                )
                report.update(
                    {
                        key: result[key]
                        for key in (
                            "outputValid",
                            "referenceCheckPassed",
                            "peakRamBytes",
                        )
                    }
                )
                report["acceleratorUsed"] = True
                if not report["outputValid"] or not report["referenceCheckPassed"]:
                    raise QualificationError()
                if self.service_context_check is not None:
                    service = self.service_context_check()
                    report["serviceContextPassed"] = (
                        isinstance(service, dict)
                        and service.get("profileId") == profile.profile_id
                        and service.get("installed") is True
                        and service.get("serviceContextPassed") is True
                        and service.get("reasonCodes") == []
                    )
            except (
                OSError,
                ValueError,
                KeyError,
                subprocess.SubprocessError,
                QualificationError,
            ) as error:
                report["reasonCodes"] = [
                    error.code
                    if isinstance(error, QualificationError)
                    else "GPU_QUALIFICATION_FAILED"
                ]
        report["wallMilliseconds"] = max(1, round((time.monotonic() - started) * 1000))
        if not report["reasonCodes"] and not report["serviceContextPassed"]:
            report["reasonCodes"] = ["GPU_UNAVAILABLE_IN_SERVICE"]
        return report


def qualify_candidates(
    profiles, prepare, fixture, *, event=lambda code, attempt: None, max_attempts=3
):
    """Bounded GPU recipe attempts. The caller's qualified list is never widened."""
    if type(max_attempts) is not int or not 1 <= max_attempts <= 3:
        raise ValueError("At most three GPU recipes per setup")
    reports = []
    for attempt, profile in enumerate(profiles[:max_attempts], 1):
        if profile.status != "qualified":
            continue
        try:
            runner = prepare(profile)
            report = runner.qualify(profile, fixture(profile))
            reports.append(report)
            if not report["reasonCodes"] and report["acceleratorUsed"]:
                return profile, reports
            for code in report["reasonCodes"]:
                event(code, attempt)
        except ProfileError as error:
            event(error.code, attempt)
    return None, reports
