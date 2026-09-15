"""Strict offline recipe promotion and bounded runtime-report matching."""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_WALL_MILLISECONDS = 86_400_000
MAX_MEMORY_BYTES = 1_099_511_627_776
MAX_MEDIA_SECONDS = 86_400
MAX_NODE_COUNT = 10_000_000
MAX_REFERENCE_ERROR = 1_000_000.0

SHA256 = re.compile(r"^[0-9a-f]{64}$")
PROFILE_ID = re.compile(r"^[a-z0-9][a-z0-9.-]{2,127}$")
EXACT_PIN = re.compile(r"^\d+(?:\.\d+){1,3}$")

ROOT_KEYS = {"schemaVersion", "generatedAt", "qualificationPolicy", "candidates"}
CANDIDATE_KEYS = {
    "profileId", "os", "arch", "gpuVendor", "provider", "dependencies",
    "driverConstraint", "modelSha256", "fixtureSha256", "runtimeLockSha256",
    "evidenceChecks", "status", "statusReason",
}
POLICY_KEYS = {
    "maxWallMilliseconds", "maxPeakRamBytes", "maxPeakGpuMemoryBytes",
    "gpuMemoryRequired", "referenceMaxAbs", "referenceRms", "maxMediaSeconds",
    "executionEvidenceMethod", "serviceContextRequired",
}
OFFLINE_KEYS = {
    "profileId", "modelSha256", "fixtureSha256", "runtimeLockSha256",
    "acceleratorUsed", "provider", "deviceLabel", "coldWallMilliseconds",
    "warmWallMilliseconds", "peakRamBytes", "peakGpuMemoryBytes", "outputValid",
    "outputFinite", "referenceCheckPassed", "referenceMetrics",
    "executionEvidence", "cancellationPassed", "longClipPassed",
    "serviceContextPassed", "reasonCodes",
}
WIRE_KEYS = {
    "profileId", "modelSha256", "fixtureSha256", "acceleratorUsed", "provider",
    "deviceLabel", "wallMilliseconds", "peakRamBytes", "peakGpuMemoryBytes",
    "outputValid", "referenceCheckPassed", "serviceContextPassed", "reasonCodes",
}
PROVIDER_PACKAGES = {
    "DmlExecutionProvider": "onnxruntime-directml",
    "CUDAExecutionProvider": "onnxruntime-gpu",
    "CoreMLExecutionProvider": "onnxruntime",
    "MIGraphXExecutionProvider": "onnxruntime-migraphx",
    "OpenVINOExecutionProvider": "onnxruntime-openvino",
    "ArmNNExecutionProvider": "onnxruntime",
}
PROVIDER_VENDORS = {
    "DmlExecutionProvider": {"amd", "intel", "nvidia", "qualcomm"},
    "CUDAExecutionProvider": {"nvidia"},
    "CoreMLExecutionProvider": {"apple", "intel"},
    "MIGraphXExecutionProvider": {"amd"},
    "OpenVINOExecutionProvider": {"intel"},
    "ArmNNExecutionProvider": {"arm"},
}


@dataclass(frozen=True)
class AdmissionDecision:
    admitted: bool
    reason_codes: tuple[str, ...]


@dataclass(frozen=True)
class ApprovedEvidenceRecord:
    """Evidence identity already authenticated by the H01/V01/B05 authority."""

    profile_id: str
    evidence_sha256: str
    approval_id: str


def evidence_sha256(evidence: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        evidence,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def load_candidates(path: str | Path) -> dict[str, Any]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or set(payload) != ROOT_KEYS:
        raise ValueError("manifest root fields do not match schema")
    if type(payload["schemaVersion"]) is not int or payload["schemaVersion"] != 1:
        raise ValueError("unsupported schemaVersion")
    candidates = payload["candidates"]
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("candidates must be a non-empty list")

    seen: set[str] = set()
    for candidate in candidates:
        qualified = isinstance(candidate, Mapping) and candidate.get("status") == "qualified"
        _validate_candidate(candidate, require_qualified=qualified)
        profile_id = candidate["profileId"]
        if profile_id in seen:
            raise ValueError(f"duplicate profileId: {profile_id}")
        seen.add(profile_id)
    return payload


def validate_qualification(
    profile: Mapping[str, Any],
    evidence: Mapping[str, Any],
    approval: ApprovedEvidenceRecord | None,
) -> AdmissionDecision:
    """Validate internal offline evidence; this does not decode a wire report."""
    if not _is_qualified_profile(profile):
        return AdmissionDecision(False, ("RECIPE_NOT_QUALIFIED",))
    if not _approval_matches(profile, approval):
        return AdmissionDecision(False, ("EVIDENCE_NOT_APPROVED",))
    try:
        digest = evidence_sha256(evidence)
    except (TypeError, ValueError):
        return AdmissionDecision(False, ("GPU_QUALIFICATION_FAILED",))
    if digest != approval.evidence_sha256:
        return AdmissionDecision(False, ("EVIDENCE_NOT_APPROVED",))
    return _validate_offline_measurements(profile, evidence)


def validate_runtime_report(
    profile: Mapping[str, Any],
    report: Mapping[str, Any],
    *,
    approval: ApprovedEvidenceRecord | None,
) -> AdmissionDecision:
    """Match a contract-shaped report after authority-loaded evidence approval."""
    if not _is_qualified_profile(profile):
        return AdmissionDecision(False, ("RECIPE_NOT_QUALIFIED",))
    if not _approval_matches(profile, approval):
        return AdmissionDecision(False, ("EVIDENCE_NOT_APPROVED",))
    if not isinstance(report, Mapping) or set(report) != WIRE_KEYS:
        return AdmissionDecision(False, ("INVALID_QUALIFICATION_REPORT",))
    if report["profileId"] != profile["profileId"]:
        return AdmissionDecision(False, ("INVALID_QUALIFICATION_REPORT",))
    if report["provider"] != profile["provider"]:
        return AdmissionDecision(False, ("GPU_PROVIDER_UNAVAILABLE",))
    if (
        report["modelSha256"] != profile["modelSha256"]
        or report["fixtureSha256"] != profile["fixtureSha256"]
    ):
        return AdmissionDecision(False, ("MODEL_INTEGRITY_FAILED",))
    if not _bounded_string(report["deviceLabel"], 128) or report["reasonCodes"] != []:
        return AdmissionDecision(False, ("INVALID_QUALIFICATION_REPORT",))
    required_true = (
        "acceleratorUsed", "outputValid", "referenceCheckPassed", "serviceContextPassed"
    )
    if not all(report[key] is True for key in required_true):
        return AdmissionDecision(False, ("GPU_QUALIFICATION_FAILED",))
    if not _bounded_positive_number(report["wallMilliseconds"], MAX_WALL_MILLISECONDS):
        return AdmissionDecision(False, ("INVALID_QUALIFICATION_REPORT",))
    for key in ("peakRamBytes", "peakGpuMemoryBytes"):
        value = report[key]
        if value is not None and not _bounded_positive_integer(value, MAX_MEMORY_BYTES):
            return AdmissionDecision(False, ("INVALID_QUALIFICATION_REPORT",))
    return AdmissionDecision(True, ())


def _is_qualified_profile(profile: Mapping[str, Any]) -> bool:
    try:
        _validate_candidate(profile, require_qualified=True)
    except (KeyError, TypeError, ValueError):
        return False
    return True


def _approval_matches(
    profile: Mapping[str, Any], approval: ApprovedEvidenceRecord | None
) -> bool:
    return (
        isinstance(approval, ApprovedEvidenceRecord)
        and isinstance(approval.profile_id, str)
        and approval.profile_id == profile["profileId"]
        and _is_digest(approval.evidence_sha256)
        and _bounded_string(approval.approval_id, 128)
    )


def _validate_candidate(candidate: Mapping[str, Any], *, require_qualified: bool) -> None:
    allowed = CANDIDATE_KEYS | ({"qualificationPolicy"} if require_qualified else set())
    if not isinstance(candidate, Mapping) or set(candidate) != allowed:
        raise ValueError("candidate fields do not match schema")
    if not isinstance(candidate["profileId"], str) or not PROFILE_ID.fullmatch(candidate["profileId"]):
        raise ValueError("invalid profileId")
    if not isinstance(candidate["os"], str) or candidate["os"] not in {"windows", "macos", "linux"}:
        raise ValueError("unsupported OS")
    if not isinstance(candidate["arch"], str) or candidate["arch"] not in {"x64", "arm64"}:
        raise ValueError("unsupported architecture")
    if not isinstance(candidate["status"], str) or candidate["status"] not in {"candidate", "qualified", "rejected", "unavailable"}:
        raise ValueError("invalid status")
    provider = candidate["provider"]
    if not isinstance(provider, str) or provider not in PROVIDER_PACKAGES:
        raise ValueError("invalid provider")
    vendor = candidate["gpuVendor"]
    if (
        not isinstance(vendor, str)
        or vendor not in PROVIDER_VENDORS[provider]
    ):
        raise ValueError("GPU vendor is incompatible with provider")
    dependencies = candidate["dependencies"]
    if not isinstance(dependencies, dict):
        raise ValueError("invalid dependencies")
    if not _bounded_string(candidate["driverConstraint"], 512):
        raise ValueError("invalid driver constraint")
    if not _bounded_string(candidate["statusReason"], 1024):
        raise ValueError("invalid status reason")
    checks = candidate["evidenceChecks"]
    if not isinstance(checks, list) or not checks:
        raise ValueError("invalid evidence checks")
    if any(not _bounded_string(check, 128) for check in checks):
        raise ValueError("invalid evidence check")
    if not require_qualified:
        return
    if candidate["status"] != "qualified":
        raise ValueError("recipe is not qualified")
    if PROVIDER_PACKAGES[provider] not in dependencies:
        raise ValueError("provider package mismatch")
    if any(not isinstance(pin, str) or not EXACT_PIN.fullmatch(pin) for pin in dependencies.values()):
        raise ValueError("qualified dependencies must use exact pins")
    identity_keys = ("modelSha256", "fixtureSha256", "runtimeLockSha256")
    if any(not _is_digest(candidate[key]) for key in identity_keys):
        raise ValueError("qualified recipe identities must be immutable")
    _validate_policy(candidate["qualificationPolicy"])


def _validate_policy(policy: Any) -> None:
    if not isinstance(policy, Mapping) or set(policy) != POLICY_KEYS:
        raise ValueError("qualification policy fields do not match schema")
    integer_bounds = {
        "maxWallMilliseconds": MAX_WALL_MILLISECONDS,
        "maxPeakRamBytes": MAX_MEMORY_BYTES,
        "maxPeakGpuMemoryBytes": MAX_MEMORY_BYTES,
        "maxMediaSeconds": MAX_MEDIA_SECONDS,
    }
    for key, maximum in integer_bounds.items():
        if not _bounded_positive_integer(policy[key], maximum):
            raise ValueError(f"invalid policy bound: {key}")
    for key in ("gpuMemoryRequired", "serviceContextRequired"):
        if type(policy[key]) is not bool:
            raise ValueError(f"invalid policy Boolean: {key}")
    for key in ("referenceMaxAbs", "referenceRms"):
        if not _bounded_nonnegative_number(policy[key], MAX_REFERENCE_ERROR):
            raise ValueError(f"invalid reference bound: {key}")
    if not _bounded_string(policy["executionEvidenceMethod"], 64):
        raise ValueError("invalid execution evidence method")


def _validate_offline_measurements(
    profile: Mapping[str, Any], evidence: Mapping[str, Any]
) -> AdmissionDecision:
    if not isinstance(evidence, Mapping) or set(evidence) != OFFLINE_KEYS:
        return AdmissionDecision(False, ("GPU_QUALIFICATION_FAILED",))
    policy = profile["qualificationPolicy"]
    reasons: list[str] = []
    boolean_fields = (
        "acceleratorUsed", "outputValid", "outputFinite",
        "referenceCheckPassed", "cancellationPassed", "longClipPassed",
        "serviceContextPassed",
    )
    if any(type(evidence[key]) is not bool for key in boolean_fields):
        return AdmissionDecision(False, ("GPU_QUALIFICATION_FAILED",))
    if evidence["profileId"] != profile["profileId"] or evidence["provider"] != profile["provider"]:
        reasons.append("GPU_PROVIDER_UNAVAILABLE")
    if evidence["modelSha256"] != profile["modelSha256"] or evidence["fixtureSha256"] != profile["fixtureSha256"]:
        reasons.append("MODEL_INTEGRITY_FAILED")
    if evidence["runtimeLockSha256"] != profile["runtimeLockSha256"]:
        reasons.append("DEPENDENCY_RECIPE_UNAVAILABLE")
    if not _bounded_string(evidence["deviceLabel"], 128) or evidence["reasonCodes"] != []:
        reasons.append("GPU_QUALIFICATION_FAILED")

    execution = evidence["executionEvidence"]
    execution_valid = (
        isinstance(execution, Mapping)
        and set(execution) == {"method", "acceleratedNodeCount", "neuralNodeCount"}
        and execution.get("method") == policy["executionEvidenceMethod"]
        and _bounded_positive_integer(execution.get("acceleratedNodeCount"), MAX_NODE_COUNT)
        and _bounded_positive_integer(execution.get("neuralNodeCount"), MAX_NODE_COUNT)
    )
    accelerated_count = execution.get("acceleratedNodeCount") if isinstance(execution, Mapping) else None
    if not evidence["acceleratorUsed"] or accelerated_count == 0:
        reasons.append("CPU_ONLY_UNSUPPORTED")
    elif not execution_valid or execution["acceleratedNodeCount"] != execution["neuralNodeCount"]:
        reasons.append("GPU_QUALIFICATION_FAILED")
    if policy["serviceContextRequired"] and evidence["serviceContextPassed"] is not True:
        reasons.append("GPU_UNAVAILABLE_IN_SERVICE")
    required_true = (
        "outputValid", "outputFinite", "referenceCheckPassed",
        "cancellationPassed", "longClipPassed",
    )
    if not all(evidence[key] is True for key in required_true):
        reasons.append("GPU_QUALIFICATION_FAILED")
    for key in ("coldWallMilliseconds", "warmWallMilliseconds"):
        if not _bounded_positive_number(evidence[key], policy["maxWallMilliseconds"]):
            reasons.append("GPU_QUALIFICATION_FAILED")
    if not _bounded_positive_integer(evidence["peakRamBytes"], policy["maxPeakRamBytes"]):
        reasons.append("INSUFFICIENT_MEMORY")
    gpu_memory = evidence["peakGpuMemoryBytes"]
    if policy["gpuMemoryRequired"] and not _bounded_positive_integer(gpu_memory, policy["maxPeakGpuMemoryBytes"]):
        reasons.append("INSUFFICIENT_MEMORY")
    elif gpu_memory is not None and not _bounded_positive_integer(gpu_memory, policy["maxPeakGpuMemoryBytes"]):
        reasons.append("INSUFFICIENT_MEMORY")

    metrics = evidence["referenceMetrics"]
    metrics_valid = (
        isinstance(metrics, Mapping)
        and set(metrics) == {"maxAbs", "rms"}
        and _bounded_nonnegative_number(metrics.get("maxAbs"), policy["referenceMaxAbs"])
        and _bounded_nonnegative_number(metrics.get("rms"), policy["referenceRms"])
    )
    if not metrics_valid:
        reasons.append("GPU_QUALIFICATION_FAILED")
    return AdmissionDecision(not reasons, tuple(dict.fromkeys(reasons)))


def _bounded_string(value: Any, maximum: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= maximum


def _is_digest(value: Any) -> bool:
    return isinstance(value, str) and SHA256.fullmatch(value) is not None


def _bounded_positive_integer(value: Any, maximum: int) -> bool:
    return type(value) is int and 0 < value <= min(maximum, MAX_SAFE_INTEGER)


def _bounded_positive_number(value: Any, maximum: int | float) -> bool:
    return (
        type(value) in (int, float)
        and math.isfinite(value)
        and 0 < value <= min(maximum, MAX_SAFE_INTEGER)
    )


def _bounded_nonnegative_number(value: Any, maximum: int | float) -> bool:
    return (
        type(value) in (int, float)
        and math.isfinite(value)
        and 0 <= value <= min(maximum, MAX_SAFE_INTEGER)
    )
