"""Stable stdlib-only boundary; native launchers inject lifecycle implementations.

The lock spans startup, handshake, execution and verified descendant shutdown.
An interrupted ownership record is recovered before another child can start.
POSIX process groups alone never satisfy the native containment contract.
"""

import argparse
import hmac
import json
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .platforms.base import PlatformAdapter
from .runtime_types import STATE_VERSION, StatePaths, sha256_string, uuid4_string

INCOMPATIBLE = "Incompatible local identity/schema; reinstall and re-enroll without erasing journals"


@dataclass(frozen=True)
class InstallationBinding:
    installation_id: str
    worker_id: str
    machine_binding_sha256: str
    service_binding_sha256: str
    api_base_url: str

    def as_dict(self) -> dict:
        return {
            "schemaVersion": STATE_VERSION,
            "installationId": self.installation_id,
            "workerId": self.worker_id,
            "machineBindingSha256": self.machine_binding_sha256,
            "serviceBindingSha256": self.service_binding_sha256,
            "apiBaseUrl": self.api_base_url,
        }

    @classmethod
    def load(cls, path: Path) -> "InstallationBinding":
        from .config import https_url, validated_worker_id

        try:
            value = read_record(path)
            if (
                set(value)
                != {
                    "schemaVersion",
                    "installationId",
                    "workerId",
                    "machineBindingSha256",
                    "serviceBindingSha256",
                    "apiBaseUrl",
                }
                or type(value["schemaVersion"]) is not int
                or value["schemaVersion"] != STATE_VERSION
            ):
                raise ValueError(INCOMPATIBLE)
            return cls(
                uuid4_string(value["installationId"]),
                validated_worker_id(value["workerId"]),
                sha256_string(value["machineBindingSha256"]),
                sha256_string(value["serviceBindingSha256"]),
                https_url(value["apiBaseUrl"]),
            )
        except (OSError, ValueError, TypeError, KeyError):
            raise RuntimeError(INCOMPATIBLE) from None


def read_record(path: Path) -> dict:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 32768:
        raise ValueError(INCOMPATIBLE)
    result = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(result, dict):
        raise ValueError(INCOMPATIBLE)
    return result


def canonical_binding(binding: InstallationBinding) -> bytes:
    return json.dumps(binding.as_dict(), sort_keys=True, separators=(",", ":")).encode()


def verify_binding(paths: StatePaths, adapter: PlatformAdapter) -> InstallationBinding:
    binding = InstallationBinding.load(paths.identity / "installation.json")
    detection = adapter.detect()
    if detection["machineBindingSha256"] != binding.machine_binding_sha256:
        raise RuntimeError(
            "Installation identity belongs to another machine; re-enroll"
        )
    protected = adapter.load_secret("installation-binding")
    if not hmac.compare_digest(protected, canonical_binding(binding)):
        raise RuntimeError("Protected installation identity mismatch; re-enroll")
    return binding


@dataclass(frozen=True)
class ChildHandshake:
    installation_id: str
    nonce: str
    pid: int
    containment_id: str


class WorkerChild(Protocol):
    """Native child startup must block processing until its handshake is accepted."""

    containment_id: str
    pid: int

    def start(self, installation_id: str, nonce: str) -> None: ...
    def wait_ready(self, timeout_seconds: int) -> ChildHandshake: ...
    def authorize_processing(self, nonce: str) -> None: ...
    def wait(self) -> int: ...


class ServiceChild(WorkerChild, Protocol):
    """Native bounded wait; None means live, integer means actual process exit."""

    def poll_exit(self, timeout_seconds: int) -> int | None: ...


class Launcher:
    def __init__(self, paths: StatePaths, adapter: PlatformAdapter):
        self.paths = paths
        self.adapter = adapter

    def maintenance(self, client, *, bootstrap_root: bytes, distribution_origin: str):
        """Build repair/reporting services without importing the GPU environment.

        Native bootstrap embeds the initial root and provides its existing scoped
        credential client. W04 owns staging/activation and acquires the same lock
        for downloads, cache changes and spool upload scheduling.
        """
        from .events import EventSpool
        from .update.download import ArtifactDownloader, DistributionOrigin
        from .update.policy import ArtifactCache
        from .update.trust import ReleaseVerifier

        with self.adapter.acquire_machine_lock():
            binding = verify_binding(self.paths, self.adapter)
            if (
                client.installation_id != binding.installation_id
                or client.base != binding.api_base_url
            ):
                raise ValueError("Maintenance client installation mismatch")
            origin = DistributionOrigin(distribution_origin)
            cache = ArtifactCache(self.paths.state / "update-artifacts")
            spool = EventSpool(self.paths.events, binding.installation_id)
        return {
            "client": client,
            "events": spool,
            "verifier": ReleaseVerifier(
                self.paths.state / "update-metadata",
                origin,
                bootstrap_root,
                self.adapter.acquire_machine_lock,
            ),
            "downloader": ArtifactDownloader(origin),
            "cache": cache,
        }

    def _update_services_locked(
        self, client, *, bootstrap_root, distribution_origin, lock_context
    ):
        """Only supplied to run's lifecycle callback while its machine lock is held."""
        from .events import EventSpool
        from .update.download import ArtifactDownloader, DistributionOrigin
        from .update.policy import ArtifactCache
        from .update.trust import ReleaseVerifier

        binding = verify_binding(self.paths, self.adapter)
        if (
            client.installation_id != binding.installation_id
            or client.base != binding.api_base_url
        ):
            raise ValueError("Maintenance client installation mismatch")
        origin = DistributionOrigin(distribution_origin)
        return {
            "client": client,
            "events": EventSpool(self.paths.events, binding.installation_id),
            "verifier": ReleaseVerifier(
                self.paths.state / "update-metadata",
                origin,
                bootstrap_root,
                lock_context,
            ),
            "downloader": ArtifactDownloader(origin),
            "cache": ArtifactCache(self.paths.state / "update-artifacts"),
        }

    def _callback_locked(self, callback, *arguments):
        """Each callback gets scoped verifier access without reacquiring exclusion."""
        from contextlib import contextmanager

        active = True

        @contextmanager
        def owned_lock():
            if not active:
                raise RuntimeError("Update verifier escaped lifecycle lock")
            yield

        def services(*args, **kwargs):
            if not active:
                raise RuntimeError("Update service factory escaped lifecycle lock")
            return self._update_services_locked(
                *args, **kwargs, lock_context=owned_lock
            )

        try:
            return callback(services, *arguments)
        finally:
            active = False

    def recover_ownership_locked(self):
        """Common startup/repair recovery; caller owns native machine exclusion."""
        binding = verify_binding(self.paths, self.adapter)
        self.paths.journals.mkdir(parents=True, exist_ok=True)
        ownership = self.paths.journals / "launcher-owner.json"
        if ownership.exists():
            old = read_record(ownership)
            if (
                set(old) != {"schemaVersion", "installationId", "containmentId"}
                or type(old["schemaVersion"]) is not int
                or old["schemaVersion"] != STATE_VERSION
                or old["installationId"] != binding.installation_id
            ):
                raise RuntimeError(INCOMPATIBLE)
            self._validate_containment(old["containmentId"])
            self.adapter.stop_and_verify_descendants(old["containmentId"])
            ownership.unlink()
        return binding

    def run(self, child: WorkerChild, *, lifecycle=None, monitor=None) -> int:
        from .progress import atomic_json

        with self.adapter.acquire_machine_lock():
            binding = self.recover_ownership_locked()
            ownership = self.paths.journals / "launcher-owner.json"
            if lifecycle is not None and self._callback_locked(lifecycle) is not True:
                raise RuntimeError("Update lifecycle did not authorize startup")
            # Native hosts may resolve the active version only after recovery and
            # activation, rather than retaining a child from the previous pointer.
            if callable(child):
                child = child()
            if monitor is not None and not callable(getattr(child, "poll_exit", None)):
                raise RuntimeError(
                    "Native child polling is required for service operation"
                )
            self._validate_containment(child.containment_id)
            nonce = secrets.token_hex(32)
            atomic_json(
                ownership,
                {
                    "schemaVersion": STATE_VERSION,
                    "installationId": binding.installation_id,
                    "containmentId": child.containment_id,
                },
            )
            try:
                child.start(binding.installation_id, nonce)
                hello = child.wait_ready(30)
                if (
                    hello.installation_id != binding.installation_id
                    or not hmac.compare_digest(hello.nonce, nonce)
                    or type(hello.pid) is not int
                    or hello.pid <= 0
                    or hello.pid != child.pid
                    or hello.containment_id != child.containment_id
                ):
                    raise RuntimeError("Worker child handshake rejected")
                child.authorize_processing(nonce)
                if monitor is not None:
                    while True:
                        result = child.poll_exit(5)
                        if result is not None:
                            if type(result) is not int:
                                raise TypeError("Invalid native child exit status")
                            return result
                        result = self._callback_locked(monitor, child)
                        if result is not None:
                            if type(result) is not int:
                                raise TypeError("Invalid maintenance result")
                            return result
                return child.wait()
            finally:
                # A failure leaves the ownership record intact for mandatory recovery.
                self.adapter.stop_and_verify_descendants(child.containment_id)
                ownership.unlink()

    @staticmethod
    def _validate_containment(value: object) -> None:
        if (
            not isinstance(value, str)
            or not value
            or len(value) > 128
            or any(ord(c) < 33 or ord(c) > 126 for c in value)
        ):
            raise RuntimeError("Invalid native containment identity")


def main() -> int:
    parser = argparse.ArgumentParser(description="MusicMute shared worker launcher")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--check-config", action="store_true")
    args = parser.parse_args()
    from .config import Config

    try:
        Config.load(args.config)
        if args.check_config:
            print(
                "Configuration schema valid; native binding, GPU and boot checks are still required."
            )
            return 0
        raise RuntimeError(
            "Native launcher adapter required; installers and qualified runtime recipes are under development"
        )
    except (OSError, RuntimeError, ValueError, KeyError):
        print(
            "Worker startup refused: validate protocol-3 configuration and use a qualified native launcher."
        )
        return 2
