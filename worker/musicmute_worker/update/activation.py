"""Versioned runtime pointer and independently retained launcher handoff."""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from ..runtime_types import PROTOCOL_VERSION, STATE_VERSION, sha256_string, uuid4_string


def environment(value):
    required = {"target", "path", "assets"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("Invalid complete environment")
    target = value["target"]
    from .policy import parse_decision

    parse_decision(
        {
            "serverTime": "2026-01-01T00:00:00.000Z",
            "policyRevision": 1,
            "action": "prepare",
            "target": target,
            "minimumClaimBuild": 1,
            "allowedFallbackReleaseIds": [],
            "reasonCodes": [],
        }
    )
    uuid4_string(target["releaseId"])
    for key in ("modelSha256", "runtimeLockSha256", "artifactSha256"):
        sha256_string(target[key])
    path = Path(value["path"])
    if not path.is_absolute() or path != path.resolve():
        raise ValueError("Environment path must be permanent and canonical")
    if not (
        target["stateReadMin"] <= STATE_VERSION <= target["stateReadMax"]
        and target["protocolMin"] <= PROTOCOL_VERSION <= target["protocolMax"]
    ):
        raise ValueError("Incompatible environment; no state conversion")
    if (
        not isinstance(value["assets"], list)
        or not value["assets"]
        or any(sha256_string(x) != x for x in value["assets"])
    ):
        raise ValueError("Invalid environment assets")
    if target["artifactSha256"] not in value["assets"]:
        raise ValueError("Missing signed artifact cache reference")
    return value


@dataclass(frozen=True)
class SafeBoundary:
    ownership_resolved: bool
    terminal: bool
    cleanup_acknowledged: bool
    descendants_stopped: bool

    @property
    def safe(self):
        return all(value is True for value in vars(self).values())


def safe_boundary(value):
    if not isinstance(value, SafeBoundary):
        raise TypeError("Native safe-boundary evidence required")
    return value.safe


class ActivationRuntime(Protocol):
    """Native host operations are idempotent and run with the machine lock held.

    prepare builds at the supplied final path without GPU use. validate checks the
    entire environment and performs native model/service/auth checks without jobs.
    stop_and_reconcile must query real ownership, await terminal+cleanup receipts,
    and verify native containment; unknown/offline answers return an unsafe boundary.
    readiness_body contains actual qualification and boot evidence, never defaults.
    """

    def prepare(self, target: dict, archive: Path, final_path: Path) -> dict: ...
    def boundary(self) -> SafeBoundary: ...
    def validate(self, candidate: dict) -> bool: ...
    def stop_and_reconcile(self, candidate: dict) -> SafeBoundary: ...
    def runtime_report(self, candidate: dict) -> dict: ...
    def readiness_body(self, candidate: dict) -> dict: ...


class ActivePointer:
    def __init__(self, records):
        self.records = records

    def read(self):
        value = self.records.read("active-release.json")
        if not value or set(value) != {"schemaVersion", "environment"}:
            raise ValueError("Missing active environment")
        return environment(value["environment"])

    def switch(self, value):
        self.records.write(
            "active-release.json",
            {"schemaVersion": 3, "environment": environment(value)},
        )


class LauncherHandoff:
    """Stable service entrypoint reads this pointer; never deletes either executable.

    Caller holds the native machine lock and supplies digest verified executables.
    Recovery returns the retained old executable until new self-test is committed.
    """

    def __init__(self, records):
        self.records = records

    @staticmethod
    def _executable(value):
        import hashlib

        path = Path(value["path"])
        if (
            set(value) != {"path", "sha256"}
            or not path.is_absolute()
            or path != path.resolve()
            or not path.is_file()
        ):
            raise ValueError("Invalid retained launcher")
        if hashlib.sha256(path.read_bytes()).hexdigest() != sha256_string(
            value["sha256"]
        ):
            raise ValueError("Launcher digest mismatch")
        return value

    def activate(self, old, candidate, boundary, check):
        if not safe_boundary(boundary):
            return False
        self._executable(old)
        self._executable(candidate)
        if old["path"] == candidate["path"]:
            raise ValueError("Launcher recovery path must be retained separately")
        record = {
            "schemaVersion": 3,
            "phase": "checking",
            "old": old,
            "candidate": candidate,
        }
        self.records.write("launcher-handoff.json", record)
        if check(candidate) is not True:
            raise RuntimeError("Launcher self-test was not acknowledged")
        record["phase"] = "switching"
        self.records.write("launcher-handoff.json", record)
        self.records.write(
            "active-launcher.json", {"schemaVersion": 3, "executable": candidate}
        )
        record["phase"] = "committed"
        self.records.write("launcher-handoff.json", record)
        return True

    def recover(self):
        record = self.records.read("launcher-handoff.json")
        if record is None:
            return None
        if set(record) != {"schemaVersion", "phase", "old", "candidate"} or record[
            "phase"
        ] not in ("checking", "switching", "committed"):
            raise ValueError("Invalid launcher handoff journal")
        chosen = (
            record["candidate"] if record["phase"] == "committed" else record["old"]
        )
        self._executable(chosen)
        self.records.write(
            "active-launcher.json", {"schemaVersion": 3, "executable": chosen}
        )
        return chosen
