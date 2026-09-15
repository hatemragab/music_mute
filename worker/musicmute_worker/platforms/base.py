"""Typed contracts. Native implementations must supply real evidence or fail."""

from contextlib import AbstractContextManager
from pathlib import Path
from typing import TYPE_CHECKING, Protocol, TypedDict

if TYPE_CHECKING:
    from ..config import Config
    from ..launcher import ServiceChild
    from ..profiles import PreparedRuntime
    from ..update.activation import SafeBoundary

from ..runtime_types import (
    OS,
    Arch,
    BootReport,
    QualificationReport,
    ReleaseTarget,
    UpdateDecision,
    UpdateResult,
    UploadReceipt,
    WorkerEvent,
)


class PlatformDetection(TypedDict):
    os: OS
    arch: Arch
    machineBindingSha256: str


class PlatformAdapter(Protocol):
    """Machine acquisition is exclusive and fail-fast when already owned.

    Never wait indefinitely: a service may acquire between a liveness probe and
    repair's acquisition. The caller must see busy and retry, not block forever.
    """

    def detect(self) -> PlatformDetection: ...
    def install_boot_service(self, launcher_path: str) -> BootReport: ...
    def check_service_context(self) -> BootReport: ...
    def acquire_machine_lock(self) -> AbstractContextManager[object]: ...
    def stop_and_verify_descendants(self, containment_id: str) -> None: ...
    def protect_secret(self, name: str, value: bytes) -> None: ...
    def load_secret(self, name: str) -> bytes: ...


class SetupAdapter(PlatformAdapter, Protocol):
    """I02-I04 OS operations consumed by shared setup and monitored service host.

    read_worker_boundary authenticates IPC with the existing contained child and
    returns its Worker.update_boundary value, or None when no live child exists.
    It never reads/mutates assignment journals or fabricates backend observations.
    stop_worker verifies the complete containment and only runs after shared idle
    checks. poll_exit waits at most the requested timeout; boot services must use
    ServiceChild, never the one-shot blocking diagnostic wait path.
    service_running queries the actual service/host process, never an ownership
    filename; unavailable liveness raises or returns no boolean and fails closed.
    """

    def sync_directory(self, path: Path) -> None: ...
    def service_running(self) -> bool: ...
    def acquire_bootstrap_lock(self) -> AbstractContextManager[object]: ...
    def read_worker_boundary(self) -> "SafeBoundary | None": ...
    def descendants_stopped(self) -> bool: ...
    def stop_worker(self) -> bool: ...
    def remove_boot_service(self) -> bool: ...
    def create_child(
        self,
        config: "Config",
        runtime: "PreparedRuntime",
        source: Path,
        candidate: dict,
    ) -> "ServiceChild": ...


class EventClient(Protocol):
    installation_id: str

    def server_time(self) -> str: ...
    def post_events(self, events: list[WorkerEvent]) -> UploadReceipt: ...


class EventSpool(Protocol):
    def append(self, event: WorkerEvent) -> None: ...
    def upload_pending(self, client: EventClient) -> UploadReceipt: ...


class QualificationRunner(Protocol):
    def qualify(
        self, profile: ReleaseTarget, fixture_path: str
    ) -> QualificationReport: ...


class ReleaseVerifier(Protocol):
    def resolve(self, decision: UpdateDecision) -> ReleaseTarget: ...
    def verify_artifact(self, target: ReleaseTarget, path: str) -> None: ...


class UpdateCoordinator(Protocol):
    def prepare(self, decision: UpdateDecision) -> UpdateResult: ...
    def activate_when_idle(self, decision: UpdateDecision) -> UpdateResult: ...
    def recover_interrupted_activation(self) -> UpdateResult: ...
