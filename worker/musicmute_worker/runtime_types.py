"""Dependency-free wire types shared by native adapters and the supervisor."""

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, NotRequired, TypedDict
from uuid import UUID

PROTOCOL_VERSION = 3
STATE_VERSION = 3
OS = Literal["windows", "macos", "linux"]
Arch = Literal["x64", "arm64"]
SETUP_REASON_CODES = frozenset(
    {
        "CPU_ONLY_UNSUPPORTED",
        "GPU_PROVIDER_UNAVAILABLE",
        "GPU_UNAVAILABLE_IN_SERVICE",
        "GPU_QUALIFICATION_FAILED",
        "DRIVER_ACTION_REQUIRED",
        "UNSUPPORTED_OS_ARCH",
        "DEPENDENCY_RECIPE_UNAVAILABLE",
        "INSUFFICIENT_DISK",
        "INSUFFICIENT_MEMORY",
        "MODEL_INTEGRITY_FAILED",
        "PREBOOT_UNLOCK_REQUIRED",
        "STARTUP_INSTALL_FAILED",
        "REPORTING_UNAVAILABLE",
        "UPDATE_SIGNATURE_INVALID",
    }
)


class RuntimeReport(TypedDict):
    installationId: str
    workerBuild: int
    launcherBuild: int
    protocolVersion: int
    profileId: str
    modelSha256: str
    runtimeLockSha256: str
    os: OS
    arch: Arch
    activity: Literal[
        "starting", "ready", "busy", "updating", "paused", "recovery_required"
    ]
    bootVerified: bool


class QualificationReport(TypedDict):
    profileId: str
    modelSha256: str
    fixtureSha256: str
    acceleratorUsed: bool
    provider: str
    deviceLabel: str
    wallMilliseconds: int
    peakRamBytes: int | None
    peakGpuMemoryBytes: int | None
    outputValid: bool
    referenceCheckPassed: bool
    serviceContextPassed: bool
    reasonCodes: list[str]


class BootReport(TypedDict):
    serviceBindingSha256: str
    profileId: str
    installed: bool
    serviceContextPassed: bool
    unattendedRebootPassed: bool
    observedBootId: str | None
    observedAt: str
    reasonCodes: list[str]


class ApprovedProfile(TypedDict):
    evidenceSha256: str
    fixtureSha256: str
    fixtureDurationSeconds: int
    provider: Literal[
        "CUDAExecutionProvider",
        "DmlExecutionProvider",
        "CoreMLExecutionProvider",
        "MIGraphXExecutionProvider",
        "OpenVINOExecutionProvider",
        "ArmNNExecutionProvider",
    ]
    serviceBindingSha256: str
    expiresAt: str
    maxDurationSeconds: int
    maxPreparedAudioBytes: int
    maxWallMilliseconds: int


class CompatibleSource(TypedDict):
    profileId: str
    modelSha256: str
    runtimeLockSha256: str
    rollbackAllowed: bool


class ReleaseTarget(TypedDict):
    approvedProfile: ApprovedProfile | None
    os: OS
    arch: Arch
    compatibleSources: list[CompatibleSource]
    releaseId: str
    buildNumber: int
    profileId: str
    artifactPath: str
    artifactBytes: int
    artifactSha256: str
    runtimeLockSha256: str
    modelSha256: str
    minimumLauncherBuild: int
    protocolMin: int
    protocolMax: int
    stateReadMin: int
    stateReadMax: int


class UpdateDecision(TypedDict):
    serverTime: str
    policyRevision: int
    action: Literal["none", "prepare", "hold"]
    target: ReleaseTarget | None
    minimumClaimBuild: int
    allowedFallbackReleaseIds: list[str]
    reasonCodes: list[str]


class EventDetails(TypedDict, total=False):
    component: str
    componentVersion: str
    attempt: int
    exitCode: int
    downloadedBytes: int
    totalBytes: int
    droppedEvents: int
    diagnostic: str


class WorkerEvent(TypedDict):
    eventId: str
    operationId: str
    sequence: int
    category: Literal[
        "installation", "pairing", "startup", "processing", "update", "cleanup"
    ]
    stage: str
    status: Literal["started", "progress", "succeeded", "failed", "interrupted"]
    occurredAt: str
    durationMs: NotRequired[int]
    code: NotRequired[str]
    details: NotRequired[EventDetails]


class UploadReceipt(TypedDict):
    # No-delivery local spool results have no server timestamp.
    serverTime: NotRequired[str]
    acceptedEventIds: list[str]
    duplicateEventIds: list[str]


class UpdateResult(TypedDict):
    stage: str
    reasonCodes: list[str]
    releaseId: str | None


def uuid4_string(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("Expected lowercase UUIDv4")
    parsed = UUID(value)
    if parsed.version != 4 or str(parsed) != value:
        raise ValueError("Expected lowercase UUIDv4")
    return value


def sha256_string(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError("Expected lowercase SHA-256")
    return value


def validate_runtime(value: object) -> RuntimeReport:
    if not isinstance(value, dict) or set(value) != set(RuntimeReport.__annotations__):
        raise ValueError("Invalid runtime fields")
    uuid4_string(value["installationId"])
    for key in ("workerBuild", "launcherBuild", "protocolVersion"):
        if type(value[key]) is not int or not 1 <= value[key] <= 2**53 - 1:
            raise ValueError("Invalid runtime integer")
    if value["protocolVersion"] != PROTOCOL_VERSION:
        raise ValueError(
            "Incompatible protocol; reinstall and re-enroll without erasing journals"
        )
    for key in ("modelSha256", "runtimeLockSha256"):
        sha256_string(value[key])
    if not isinstance(value["profileId"], str) or not re.fullmatch(
        r"[a-z0-9][a-z0-9-]{0,95}", value["profileId"]
    ):
        raise ValueError("Invalid profile")
    if value["os"] not in ("windows", "macos", "linux") or value["arch"] not in (
        "x64",
        "arm64",
    ):
        raise ValueError("Unsupported platform")
    if (
        value["activity"]
        not in ("starting", "ready", "busy", "updating", "paused", "recovery_required")
        or type(value["bootVerified"]) is not bool
    ):
        raise ValueError("Invalid runtime status")
    return value.copy()


@dataclass(frozen=True)
class StatePaths:
    """Absolute, non-overlapping roots; the adapter must protect identity/config."""

    identity: Path
    config: Path
    state: Path
    releases: Path
    models: Path
    journals: Path
    events: Path

    def __post_init__(self):
        paths = list(vars(self).values())
        if any(not p.is_absolute() or p != p.resolve() for p in paths):
            raise ValueError("State paths must be explicit absolute canonical paths")
        for index, path in enumerate(paths):
            for other in paths[index + 1 :]:
                if path == other or path in other.parents or other in path.parents:
                    raise ValueError("State paths must not overlap")
