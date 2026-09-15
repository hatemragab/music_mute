"""Static native-host registry. Nothing here is selected by configuration.

I02-I04 each ship one module next to this file (`windows.py`, `macos.py`,
`linux.py`) that calls `register` at import time. The registration is a source
constant: no config file, environment variable, downloaded metadata or command
line may add, replace or redirect an implementation, a protected-storage path or
a trust root. Missing modules mean "this build has no adapter for that OS yet"
and must fail closed, never fall back to a generic or guessed host.
"""

import importlib

from ..runtime_types import SETUP_REASON_CODES

# Import order is fixed so a partially implemented build cannot depend on which
# module happened to be imported first.
_ORDER = ("windows", "macos", "linux")

_HOSTS = {}


def register(os_name, factory):
    """Bind one OS to its adapter factory. Called from the platform module."""
    if os_name not in _ORDER:
        raise ValueError("Unsupported native host platform")
    if not callable(factory):
        raise TypeError("Native host factory must be callable")
    if os_name in _HOSTS:
        raise ValueError("Native host is already registered")
    _HOSTS[os_name] = factory


def load_hosts():
    """Import the three static platform modules, tolerating only self-absence.

    Idempotent and self-healing: an importable module that is not currently
    registered is re-executed, so the registry always reflects what actually
    ships rather than what happened to be imported first. A module that exists
    but cannot import its own native dependency still propagates, because
    treating that as "not built" would hide a broken install behind an
    unimplemented-platform message.
    """
    package = __package__
    for name in _ORDER:
        if name in _HOSTS:
            continue
        module = package + "." + name
        try:
            loaded = importlib.import_module(module)
        except ModuleNotFoundError as error:
            if error.name != module:
                raise
            continue
        if name not in _HOSTS:
            importlib.reload(loaded)
    return dict(_HOSTS)


def resolve_host(os_name):
    """Return the registered factory for a detected OS, or None when absent."""
    if os_name not in _ORDER:
        raise RuntimeError("UNSUPPORTED_OS_ARCH")
    return load_hosts().get(os_name)


def open_host(config):
    """Build the adapter for the machine we are actually running on.

    The OS is detected locally and must match the config's own detection later;
    a config never states which host to load.
    """
    from ..hardware import detected_os

    os_name = detected_os()
    factory = resolve_host(os_name)
    if factory is None:
        raise RuntimeError("STARTUP_INSTALL_FAILED")
    host = factory(config)
    if host is None:
        raise RuntimeError("STARTUP_INSTALL_FAILED")
    missing = [
        name
        for name in (
            "detect",
            "install_boot_service",
            "check_service_context",
            "acquire_machine_lock",
            "stop_and_verify_descendants",
            "protect_secret",
            "load_secret",
            "sync_directory",
            "service_running",
            "acquire_bootstrap_lock",
            "read_worker_boundary",
            "descendants_stopped",
            "stop_worker",
            "remove_boot_service",
            "create_child",
        )
        if not callable(getattr(host, name, None))
    ]
    if missing:
        raise RuntimeError("STARTUP_INSTALL_FAILED")
    detection = host.detect()
    if (
        not isinstance(detection, dict)
        or set(detection) != {"os", "arch", "machineBindingSha256"}
        or detection["os"] != os_name
    ):
        raise RuntimeError("UNSUPPORTED_OS_ARCH")
    return host


def safe_reason(code):
    """Public reason code only; raw native exception text never reaches events."""
    return code if code in SETUP_REASON_CODES else "STARTUP_INSTALL_FAILED"
