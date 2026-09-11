"""Keep the worker's thread awake while allowing the display to turn off."""

from __future__ import annotations

import os
import threading
from typing import Self

_ES_CONTINUOUS = 0x80000000
_ES_SYSTEM_REQUIRED = 0x00000001
_set_thread_execution_state = None

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _set_thread_execution_state = _kernel32.SetThreadExecutionState
    _set_thread_execution_state.argtypes = [wintypes.DWORD]
    _set_thread_execution_state.restype = wintypes.DWORD


class KeepAwake:
    """Own and restore a Windows thread execution requirement on the same thread.

    This prevents idle sleep, not an explicit user sleep/shutdown request. It is a
    no-op outside Windows so local supervisor tests need no platform emulation.
    """

    def __init__(self) -> None:
        self._previous: int | None = None
        self._thread: int | None = None

    def __enter__(self) -> Self:
        if self._thread is not None:
            raise RuntimeError("This power requirement is already active")
        if _set_thread_execution_state is not None:
            previous = _set_thread_execution_state(_ES_CONTINUOUS | _ES_SYSTEM_REQUIRED)
            if not previous:
                raise OSError("Could not prevent system sleep for the worker")
            self._previous = previous
        self._thread = threading.get_ident()
        return self

    def __exit__(self, *exc: object) -> None:
        if self._thread is None:
            return
        if self._thread != threading.get_ident():
            raise RuntimeError("Power requirements must be restored on the same thread")
        if self._previous is not None and not _set_thread_execution_state(
            self._previous | _ES_CONTINUOUS
        ):
            raise OSError("Could not restore the previous thread execution state")
        self._previous = None
        self._thread = None
