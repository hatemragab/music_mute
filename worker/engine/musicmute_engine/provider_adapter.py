"""Explicit GPU provider discovery and ONNX session-creation adapters."""

from __future__ import annotations

import importlib.metadata
import platform
import math
import time
from functools import wraps
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any, Callable, Iterator, Literal

Provider = Literal["mps", "directml"]
DIRECTML_PROVIDER = "DmlExecutionProvider"
CPU_PROVIDER = "CPUExecutionProvider"
DISABLE_CPU_FALLBACK = "session.disable_cpu_ep_fallback"
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
        from .windows_gpu import adapter_identity, require_native_x64
        try:
            require_native_x64()
            adapter_identity(device_id)  # DirectML can otherwise select WARP.
        except (OSError, RuntimeError) as error:
            raise ProviderAdapterError("DirectML requires native Windows x64 hardware") from error
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
        _prevent_cpu_graph_fallback(options)
        selected: list[object] = [
            (DIRECTML_PROVIDER, {"device_id": str(device_id)}),
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
    on_session: Callable[[Any], None] | None = None,
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
            _prevent_cpu_graph_fallback(options)
            # ORT 1.24.4 accepts this constructor keyword. Disabling fallback
            # before construction also closes its constructor retry path.
            kwargs["enable_fallback"] = False
            from .windows_gpu import adapter_identity
            selected_identity = adapter_identity(device_id)
        session = original(
            path_or_bytes, sess_options=options, providers=selected, **kwargs
        )
        if adapter_identity(device_id) != selected_identity:
            raise ProviderAdapterError("Selected GPU changed during model session creation")
        _protect_directml_session(session, device_id)
        if on_session is not None:
            on_session(session)
        if profile_directory is not None:
            sessions.append(session)
        return session

    ort.InferenceSession = configured_session
    try:
        yield sessions
    finally:
        ort.InferenceSession = original


def _prevent_cpu_graph_fallback(options: Any) -> None:
    """Reject unsupported model nodes instead of assigning them to CPU.

    Pinned ORT config contract:
    include/onnxruntime/core/session/onnxruntime_session_options_config_keys.h.
    CPU audio/DSP outside the ONNX model is unaffected.
    """
    try:
        options.add_session_config_entry(DISABLE_CPU_FALLBACK, "1")
        if options.get_session_config_entry(DISABLE_CPU_FALLBACK) != "1":
            raise ProviderAdapterError("CPU model fallback prevention was not retained")
    except (AttributeError, RuntimeError) as error:
        raise ProviderAdapterError("Runtime cannot prevent CPU model fallback") from error


def _protect_directml_session(session: Any, device_id: int) -> None:
    """Fence session recreation and exception fallback during normal runs."""
    def validate() -> None:
        try:
            # ORT implicitly registers its CPU EP even with fallback disabled;
            # the config above rejects any graph assignment to that EP.
            if session.get_providers() not in ([DIRECTML_PROVIDER], [DIRECTML_PROVIDER, CPU_PROVIDER]):
                raise ProviderAdapterError("Model session lost its DirectML provider")
            options = session.get_session_options()
            if options.get_session_config_entry(DISABLE_CPU_FALLBACK) != "1":
                raise ProviderAdapterError("CPU model fallback prevention changed")
            session.disable_fallback()
        except AttributeError as error:
            raise ProviderAdapterError("Runtime cannot verify strict DirectML sessions") from error

    validate()
    def reject_change(*_arguments: Any, **_keywords: Any) -> None:
        raise ProviderAdapterError("A qualified DirectML session cannot change providers or enable fallback")

    # DirectML's provider options do not expose device_id in pinned ORT. Keep
    # the constructed selection immutable instead of inventing identity proof.
    session.set_providers = reject_change
    session.enable_fallback = reject_change
    # DirectML permits parallel work on distinct sessions, never overlapping
    # Run calls on one session. Keep this lock attached after the loader exits.
    run_lock = Lock()
    first_measured = False

    def measured(started: float) -> None:
        nonlocal first_measured
        if first_measured:
            return
        elapsed = time.perf_counter() - started
        if math.isfinite(elapsed) and 0 <= elapsed <= 3600:
            session.musicmute_first_inference_seconds = elapsed
            first_measured = True
    # The upstream loader retains this session after provider_session exits.
    # Keep the fence attached to every supported execution entry point.
    def protect(method: Any) -> Any:
        @wraps(method)
        def guarded(*arguments: Any, **keywords: Any) -> Any:
            with run_lock:
                validate()
                started = time.perf_counter()
                result = method(*arguments, **keywords)
                measured(started)
                return result
        return guarded

    for name in ("run", "run_with_ort_values", "run_with_iobinding", "run_with_ortvaluevector"):
        method = getattr(session, name, None)
        if callable(method):
            setattr(session, name, protect(method))

    asynchronous = getattr(session, "run_async", None)
    if callable(asynchronous):
        @wraps(asynchronous)
        def guarded_async(output_names: Any, input_feed: Any, callback: Any,
                          user_data: Any, run_options: Any = None) -> Any:
            if not callable(callback):
                raise ProviderAdapterError("DirectML async inference requires a completion callback")
            run_lock.acquire()
            completion_lock = Lock()
            completed = False
            started: float | None = None

            def release_once(success: bool = False) -> bool:
                nonlocal completed
                with completion_lock:
                    if completed:
                        return False
                    completed = True
                    if success and started is not None:
                        measured(started)
                run_lock.release()
                return True

            def finished(*arguments: Any, **keywords: Any) -> Any:
                # Native inference is complete before user code receives the
                # callback. A callback may legitimately start the next Run.
                success = len(arguments) == 3 and arguments[2] == "" and not keywords
                if release_once(success):
                    return callback(*arguments, **keywords)
                return None

            try:
                validate()
            except BaseException:
                release_once()
                raise
            # Once native submission has been attempted, an exception is not
            # completion proof. Retain exclusion until its actual callback or
            # owned process teardown; a lost callback must fail closed.
            started = time.perf_counter()
            return asynchronous(output_names, input_feed, finished,
                                user_data, run_options)

        session.run_async = guarded_async


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
    if _package_version("torch") is None or all(
        _package_version(name) is None
        for name in ("onnx2torch", "onnx2torch-py313")
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
