"""Independent Windows lifetime owner; never loads model/provider libraries."""
from __future__ import annotations

import ctypes
import os
import subprocess
import sys
import threading
from ctypes import wintypes


class BasicLimits(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
    )]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", BasicLimits),
        ("IoInfo", IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def own_job() -> int:
    """Join before spawning: descendants inherit ownership without a spawn race."""
    if sys.platform != "win32":
        raise OSError("Windows guardian requires Windows")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    # NULL security attributes create a non-inheritable, unnamed job handle.
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = 0x00002000  # KILL_ON_JOB_CLOSE
    if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        error = ctypes.get_last_error()
        kernel.CloseHandle(handle)
        raise ctypes.WinError(error)
    if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        error = ctypes.get_last_error()
        kernel.CloseHandle(handle)
        raise ctypes.WinError(error)
    return handle


def watch_parent(pid: int) -> None:
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    parent = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE only
    if not parent:
        raise ctypes.WinError(ctypes.get_last_error())

    def wait() -> None:
        kernel.WaitForSingleObject(parent, 0xFFFFFFFF)
        # Parent exit or wait failure: fail closed, including a blocked stdin relay.
        os._exit(2)

    threading.Thread(target=wait, daemon=True).start()


def relay_input(child: subprocess.Popen[bytes]) -> None:
    try:
        assert child.stdin is not None
        while True:
            chunk = os.read(0, 4096)
            if not chunk:
                break
            offset = 0
            while offset < len(chunk):
                written = os.write(child.stdin.fileno(), chunk[offset:])
                if written <= 0:
                    raise OSError("Engine input made no progress")
                offset += written
    except OSError:
        pass
    # Exiting closes the guardian's sole job handle, including during busy inference.
    os._exit(2)


def main() -> int:
    arguments = sys.argv[1:]
    if len(arguments) < 4 or arguments[0] != "--parent-pid" or arguments[2] != "--":
        return 2
    try:
        parent_pid = int(arguments[1])
        if parent_pid <= 0:
            return 2
        arguments = arguments[3:]
        job = own_job()
        watch_parent(parent_pid)
        import msvcrt
        msvcrt.setmode(0, os.O_BINARY)
        child = subprocess.Popen(
            [sys.executable, "-B", *arguments], stdin=subprocess.PIPE,
            stdout=None, stderr=None, bufsize=0, close_fds=True,
        )
        threading.Thread(target=relay_input, args=(child,), daemon=True).start()
        code = child.wait()
        # Keep the handle alive until process exit; do not inherit it into children.
        assert job
        os._exit(code if 0 <= code <= 255 else 2)
    except (OSError, ValueError):
        print("Windows engine ownership could not be established", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
