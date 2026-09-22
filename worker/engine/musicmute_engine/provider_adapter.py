"""Explicit GPU provider discovery and ONNX session-creation adapters."""

from __future__ import annotations

import importlib.metadata
import platform
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Literal

Provider = Literal["mps", "directml"]
DIRECTML_PROVIDER = "DmlExecutionProvider"
CPU_PROVIDER = "CPUExecutionProvider"
RUNTIME_DISTRIBUTIONS = (
    "onnxruntime",
    "onnxruntime-directml",
    "onnxruntime-gpu",
    "onnxruntime-silicon",
)


class ProviderAdapterError(RuntimeError):
    """Raised when a requested provider adapter is not safely available."""


@dataclass(frozen=True)
class ProviderDiscovery:
    provider: Provider
    adapter_id: str
    distribution: str
    execution_provider: str
    system: str
    machine: str
    device_id: int


@dataclass(frozen=True)
class ProviderAdapter:
    provider: Provider
    adapter_id: str
    systems: tuple[str, ...]
    machines: tuple[str, ...]
    distribution: str
    execution_provider: str

    def discover(self, device_id: int) -> ProviderDiscovery:
        _validate_device_id(device_id)
        system = platform.system()
        machine = platform.machine().lower()
        if system not in self.systems or machine not in self.machines:
            raise ProviderAdapterError("Worker platform does not match the provider lock")
        if self.provider == "mps":
            return _discover_mps(self, system, machine, device_id)
        installed = {
            name for name in RUNTIME_DISTRIBUTIONS if _package_version(name) is not None
        }
        if installed != {self.distribution}:
            raise ProviderAdapterError(
                "Exactly the qualified ONNX Runtime distribution is required"
            )
        ort = _onnxruntime()
        if self.execution_provider not in ort.get_available_providers():
            raise ProviderAdapterError("Required ONNX provider is unavailable")
        return ProviderDiscovery(
            provider=self.provider,
            adapter_id=self.adapter_id,
            distribution=self.distribution,
            execution_provider=self.execution_provider,
            system=system,
            machine=machine,
            device_id=device_id,
        )

    def session_arguments(
        self, ort: Any, device_id: int
    ) -> tuple[Any, list[object]]:
        options = ort.SessionOptions()
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.enable_mem_pattern = False
        selected: list[object] = [
            (DIRECTML_PROVIDER, {"device_id": str(device_id)}),
            CPU_PROVIDER,
        ]
        return options, selected


ADAPTERS: dict[Provider, ProviderAdapter] = {
    "mps": ProviderAdapter(
        provider="mps",
        adapter_id="macos-arm64-mps-v1",
        systems=("Darwin",),
        machines=("arm64",),
        distribution="torch",
        execution_provider="MPS",
    ),
    "directml": ProviderAdapter(
        provider="directml",
        adapter_id="windows-x64-directml-v1",
        systems=("Windows",),
        machines=("amd64", "x86_64"),
        distribution="onnxruntime-directml",
        execution_provider=DIRECTML_PROVIDER,
    ),
}


def provider_adapter(provider: Provider) -> ProviderAdapter:
    adapter = ADAPTERS.get(provider)
    if adapter is None:
        raise ProviderAdapterError("Worker provider is unsupported")
    return adapter


def discover_provider(provider: Provider, device_id: int) -> ProviderDiscovery:
    return provider_adapter(provider).discover(device_id)


@contextmanager
def provider_session(
    provider: Provider,
    device_id: int,
    *,
    profile_directory: Path | None = None,
) -> Iterator[list[Any]]:
    adapter = provider_adapter(provider)
    adapter.discover(device_id)
    if provider == "mps":
        if profile_directory is not None and (
            not profile_directory.is_absolute() or not profile_directory.is_dir()
        ):
            raise ProviderAdapterError(
                "Profile directory must be an existing absolute directory"
            )
        yield []
        return
    ort = _onnxruntime()
    original = ort.InferenceSession
    sessions: list[Any] = []

    if profile_directory is not None:
        if not profile_directory.is_absolute() or not profile_directory.is_dir():
            raise ProviderAdapterError(
                "Profile directory must be an existing absolute directory"
            )

    def configured_session(
        path_or_bytes: object,
        sess_options: Any = None,
        providers: object = None,
        provider_options: object = None,
        **kwargs: object,
    ) -> Any:
        del providers, provider_options
        default_options, selected = adapter.session_arguments(ort, device_id)
        options = sess_options or default_options
        if profile_directory is not None:
            options.enable_profiling = True
            options.profile_file_prefix = str(
                profile_directory / f"onnx-{provider}"
            )
        if provider == "directml":
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            options.enable_mem_pattern = False
        session = original(
            path_or_bytes, sess_options=options, providers=selected, **kwargs
        )
        if profile_directory is not None:
            sessions.append(session)
        return session

    ort.InferenceSession = configured_session
    try:
        yield sessions
    finally:
        ort.InferenceSession = original


def _validate_device_id(device_id: int) -> None:
    if isinstance(device_id, bool) or not isinstance(device_id, int):
        raise ProviderAdapterError("Provider device ID is invalid")
    if not 0 <= device_id <= 15:
        raise ProviderAdapterError("Provider device ID is invalid")


def _package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def _discover_mps(
    adapter: ProviderAdapter, system: str, machine: str, device_id: int
) -> ProviderDiscovery:
    if any(
        _package_version(name) is None
        for name in ("torch", "onnx2pytorch")
    ):
        raise ProviderAdapterError("Qualified MPS runtime packages are unavailable")
    try:
        import torch
    except ImportError as error:
        raise ProviderAdapterError("PyTorch is unavailable") from error
    if not torch.backends.mps.is_built() or not torch.backends.mps.is_available():
        raise ProviderAdapterError("Apple MPS provider is unavailable")
    return ProviderDiscovery(
        provider="mps",
        adapter_id=adapter.adapter_id,
        distribution=adapter.distribution,
        execution_provider=adapter.execution_provider,
        system=system,
        machine=machine,
        device_id=device_id,
    )


def _onnxruntime() -> Any:
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise ProviderAdapterError("ONNX Runtime is unavailable") from error
    return ort
