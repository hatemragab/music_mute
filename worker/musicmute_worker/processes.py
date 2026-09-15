"""Contained child processes and an OS-owned single worker lock.

Windows 10+ creates children *inside* a kill-on-close Job Object using
PROC_THREAD_ATTRIBUTE_JOB_LIST. This removes the crash window between suspended
creation and assignment. The job handle is never inherited. POSIX process groups
are a local development fallback; they do not provide Windows crash guarantees.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import tempfile
import time
from collections.abc import Callable
from contextlib import ExitStack
from pathlib import Path
from typing import BinaryIO, Self

_CAPTURE_LIMIT = 1024 * 1024
_MUTEX_NAME = r"Global\MusicMute.WindowsWorker.v1"
_JOB_NAME = r"Global\MusicMute.WindowsWorker.Processes.v1"
_SLOTS = ("transient", "engine", "benchmark-1", "benchmark-2")
_RECOVERY_JOBS: dict[str, int] = {}
_STOP_HANDLES: dict[int, dict[int, int]] = {}
_INCOMPLETE_STOPS: set[int] = set()
_FAILED_PROCESSES: list[object] = []


class ContainmentError(RuntimeError):
    """Fatal stop-verification failure; must never be treated as a media error."""


def _close_contained(process) -> None:
    try:
        process.close()
    except ContainmentError:
        raise
    except (OSError, RuntimeError):
        raise ContainmentError(
            "Child process termination could not be verified"
        ) from None


def _job_name(slot: str) -> str:
    if slot not in _SLOTS:
        raise ValueError("Unknown process containment slot")
    return _JOB_NAME if slot == "transient" else _JOB_NAME + "." + slot


class ContainedProcess:
    """A long-lived child with the same containment guarantee as ProcessRunner."""

    def __init__(self, args: list[str], *, cwd: Path, slot: str):
        _job_name(slot)
        self._stack = ExitStack()
        self._process = None
        with ExitStack() as stack:
            stdin = stack.enter_context(open(os.devnull, "rb"))
            stdout = stack.enter_context(open(os.devnull, "wb"))
            self._process = (
                _WindowsProcess(args, cwd, stdin, stdout, stdout, slot=slot)
                if os.name == "nt"
                else _PosixProcess(args, cwd, stdin, stdout, stdout)
            )
            self._stack = stack.pop_all()

    def poll(self) -> int | None:
        if self._process is None:
            raise RuntimeError("Contained process is closed")
        return self._process.poll()

    def close(self) -> None:
        if self._process is not None:
            _close_contained(self._process)
            self._process = None
        self._stack.close()


class ProcessRunner:
    """Run one command at a time, checking lease/cancellation every 200 ms."""

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        # Each run owns its containment boundary and cleans up in its finally.
        pass

    def recover(self) -> None:
        """After acquiring SingleInstance, stop any job left during OS cleanup."""
        while _FAILED_PROCESSES:
            _close_contained(_FAILED_PROCESSES[0])
            del _FAILED_PROCESSES[0]
        if os.name != "nt":
            return
        for slot in _SLOTS:
            name = _job_name(slot)
            job = _RECOVERY_JOBS.get(name)
            if job is None:
                job = _kernel32.OpenJobObjectW(0x0002 | 0x0004 | 0x0008, False, name)
            if not job:
                error = ctypes.get_last_error()
                if error == 2:  # ERROR_FILE_NOT_FOUND: prior job was destroyed.
                    continue
                raise ctypes.WinError(error)
            # Retain both the job and member handles if stop verification fails.
            _RECOVERY_JOBS[name] = job
            _terminate_job(job)
            _kernel32.CloseHandle(job)
            del _RECOVERY_JOBS[name]

    def run(
        self,
        args: list[str],
        *,
        cwd: Path,
        timeout: float,
        check: Callable[[], None],
        capture: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        if not args or timeout <= 0:
            raise ValueError("A command and positive timeout are required")
        check()
        with ExitStack() as stack:
            stdin = stack.enter_context(open(os.devnull, "rb"))
            if capture:
                stdout = stack.enter_context(tempfile.TemporaryFile())
                stderr = stack.enter_context(tempfile.TemporaryFile())
            else:
                stdout = stack.enter_context(open(os.devnull, "wb"))
                stderr = stdout
            started = time.monotonic()
            process = (
                _WindowsProcess(args, cwd, stdin, stdout, stderr)
                if os.name == "nt"
                else _PosixProcess(args, cwd, stdin, stdout, stderr)
            )
            try:
                while True:
                    check()
                    if capture:
                        _check_capture(stdout, stderr)
                    returncode = process.poll()
                    if returncode is not None:
                        break
                    remaining = timeout - (time.monotonic() - started)
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(args, timeout)
                    time.sleep(min(0.2, remaining))
            finally:
                # Kill descendants even when the direct child has exited.
                try:
                    _close_contained(process)
                except BaseException:
                    # A new ProcessRunner after a network/recovery turn must be
                    # able to finish verification on this exact owned boundary.
                    _FAILED_PROCESSES.append(process)
                    raise
            check()
            if capture:
                _check_capture(stdout, stderr)
                out = _read_capture(stdout)
                err = _read_capture(stderr)
            else:
                out = err = None
            result = subprocess.CompletedProcess(args, returncode, out, err)
            result.check_returncode()
            return result


def _check_capture(*streams: BinaryIO) -> None:
    # Regular files avoid deadlock when ffprobe fills either pipe. Enforce the
    # disk limit each poll and after termination; reads always remain bounded.
    if any(os.fstat(stream.fileno()).st_size > _CAPTURE_LIMIT for stream in streams):
        raise ValueError("Command output exceeded the capture limit")


def _read_capture(stream: BinaryIO) -> str:
    stream.seek(0)
    text = stream.read(_CAPTURE_LIMIT).decode("utf-8", errors="replace")
    return text.replace("\r\n", "\n").replace("\r", "\n")


class _PosixProcess:
    def __init__(self, args, cwd, stdin, stdout, stderr):
        self.process = subprocess.Popen(
            args,
            cwd=cwd,
            stdin=stdin,
            stdout=stdout,
            stderr=stderr,
            start_new_session=True,
        )

    def poll(self) -> int | None:
        return self.process.poll()

    def close(self) -> None:
        # Reap an already exited leader before signaling its remaining group.
        self.process.poll()
        for attempt in range(2):
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
                break
            except ProcessLookupError:
                break
            except PermissionError:
                # Reap a leader that exited between poll and killpg, then retry.
                # A live group or persistent permission error is never proof of stop.
                if attempt or self.process.poll() is None:
                    raise
        self.process.wait(timeout=10)


class SingleInstance:
    """Windows machine-wide mutex; POSIX state-directory advisory lock."""

    def __init__(self, state_dir: Path):
        self.state_dir = state_dir
        self._handle = None
        self._file = None

    def __enter__(self) -> Self:
        if self._handle is not None or self._file is not None:
            raise RuntimeError("This worker lock is already held")
        if os.name == "nt":
            handle = _kernel32.CreateMutexW(None, False, _MUTEX_NAME)
            error = ctypes.get_last_error()
            if not handle:
                raise ctypes.WinError(error)
            if error == 183:  # ERROR_ALREADY_EXISTS, including other folders.
                _kernel32.CloseHandle(handle)
                raise RuntimeError("Another MusicMute worker is already running")
            self._handle = handle
        else:
            import fcntl

            self.state_dir.mkdir(parents=True, exist_ok=True)
            lock = (self.state_dir / "worker.lock").open("a+b")
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                lock.close()
                raise RuntimeError(
                    "Another MusicMute worker is already running"
                ) from exc
            except BaseException:
                lock.close()
                raise
            self._file = lock
        return self

    def __exit__(self, *exc: object) -> None:
        if self._handle is not None:
            _kernel32.CloseHandle(self._handle)
            self._handle = None
        if self._file is not None:
            self._file.close()
            self._file = None


if os.name == "nt":
    import ctypes
    import msvcrt
    from ctypes import wintypes as w

    class _BasicLimit(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", w.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", w.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", w.DWORD),
            ("SchedulingClass", w.DWORD),
        ]

    class _IOCounters(ctypes.Structure):
        _fields_ = [
            (name, ctypes.c_ulonglong)
            for name in (
                "ReadOperationCount",
                "WriteOperationCount",
                "OtherOperationCount",
                "ReadTransferCount",
                "WriteTransferCount",
                "OtherTransferCount",
            )
        ]

    class _ExtendedLimit(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", _BasicLimit), ("IoInfo", _IOCounters)] + [
            (name, ctypes.c_size_t)
            for name in (
                "ProcessMemoryLimit",
                "JobMemoryLimit",
                "PeakProcessMemoryUsed",
                "PeakJobMemoryUsed",
            )
        ]

    class _Accounting(ctypes.Structure):
        _fields_ = [
            (name, ctypes.c_longlong)
            for name in (
                "TotalUserTime",
                "TotalKernelTime",
                "ThisPeriodTotalUserTime",
                "ThisPeriodTotalKernelTime",
            )
        ] + [
            (name, w.DWORD)
            for name in (
                "TotalPageFaultCount",
                "TotalProcesses",
                "ActiveProcesses",
                "TotalTerminatedProcesses",
            )
        ]

    class _StartupInfo(ctypes.Structure):
        _fields_ = [
            ("cb", w.DWORD),
            ("lpReserved", w.LPWSTR),
            ("lpDesktop", w.LPWSTR),
            ("lpTitle", w.LPWSTR),
            ("dwX", w.DWORD),
            ("dwY", w.DWORD),
            ("dwXSize", w.DWORD),
            ("dwYSize", w.DWORD),
            ("dwXCountChars", w.DWORD),
            ("dwYCountChars", w.DWORD),
            ("dwFillAttribute", w.DWORD),
            ("dwFlags", w.DWORD),
            ("wShowWindow", w.WORD),
            ("cbReserved2", w.WORD),
            ("lpReserved2", ctypes.POINTER(w.BYTE)),
            ("hStdInput", w.HANDLE),
            ("hStdOutput", w.HANDLE),
            ("hStdError", w.HANDLE),
        ]

    class _StartupInfoEx(ctypes.Structure):
        _fields_ = [("StartupInfo", _StartupInfo), ("lpAttributeList", w.LPVOID)]

    class _ProcessInfo(ctypes.Structure):
        _fields_ = [
            ("hProcess", w.HANDLE),
            ("hThread", w.HANDLE),
            ("dwProcessId", w.DWORD),
            ("dwThreadId", w.DWORD),
        ]

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _signatures = {
        "CreateMutexW": ([w.LPVOID, w.BOOL, w.LPCWSTR], w.HANDLE),
        "CreateJobObjectW": ([w.LPVOID, w.LPCWSTR], w.HANDLE),
        "OpenJobObjectW": ([w.DWORD, w.BOOL, w.LPCWSTR], w.HANDLE),
        "CloseHandle": ([w.HANDLE], w.BOOL),
        "OpenProcess": ([w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
        "SetInformationJobObject": (
            [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD],
            w.BOOL,
        ),
        "QueryInformationJobObject": (
            [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD, w.LPVOID],
            w.BOOL,
        ),
        "TerminateJobObject": ([w.HANDLE, w.UINT], w.BOOL),
        "InitializeProcThreadAttributeList": (
            [w.LPVOID, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)],
            w.BOOL,
        ),
        "UpdateProcThreadAttribute": (
            [
                w.LPVOID,
                w.DWORD,
                ctypes.c_size_t,
                w.LPVOID,
                ctypes.c_size_t,
                w.LPVOID,
                w.LPVOID,
            ],
            w.BOOL,
        ),
        "DeleteProcThreadAttributeList": ([w.LPVOID], None),
        "CreateProcessW": (
            [
                w.LPCWSTR,
                w.LPWSTR,
                w.LPVOID,
                w.LPVOID,
                w.BOOL,
                w.DWORD,
                w.LPVOID,
                w.LPCWSTR,
                ctypes.POINTER(_StartupInfoEx),
                ctypes.POINTER(_ProcessInfo),
            ],
            w.BOOL,
        ),
        "WaitForSingleObject": ([w.HANDLE, w.DWORD], w.DWORD),
        "GetExitCodeProcess": ([w.HANDLE, ctypes.POINTER(w.DWORD)], w.BOOL),
    }
    for _name, (_arguments, _result) in _signatures.items():
        _function = getattr(_kernel32, _name)
        _function.argtypes = _arguments
        _function.restype = _result

    def _checked(result):
        if not result:
            raise ctypes.WinError(ctypes.get_last_error())
        return result

    class _WindowsProcess:
        def __init__(self, args, cwd, stdin, stdout, stderr, *, slot="transient"):
            self.job = _checked(_kernel32.CreateJobObjectW(None, _job_name(slot)))
            if ctypes.get_last_error() == 183:
                _kernel32.CloseHandle(self.job)
                self.job = None
                raise RuntimeError("Process containment slot is already occupied")
            self.process = None
            try:
                limits = _ExtendedLimit()
                limits.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
                _checked(
                    _kernel32.SetInformationJobObject(
                        self.job,
                        9,
                        ctypes.byref(limits),
                        ctypes.sizeof(limits),
                    )
                )
                self._spawn(args, cwd, stdin, stdout, stderr)
            except BaseException:
                self.close()
                raise

        def _spawn(self, args, cwd, stdin, stdout, stderr):
            executable = shutil.which(args[0])
            if not executable:
                raise FileNotFoundError(args[0])
            size = ctypes.c_size_t()
            _kernel32.InitializeProcThreadAttributeList(None, 2, 0, ctypes.byref(size))
            attributes = ctypes.create_string_buffer(size.value)
            _checked(
                _kernel32.InitializeProcThreadAttributeList(
                    attributes, 2, 0, ctypes.byref(size)
                )
            )
            descriptors = []
            try:
                for stream in (stdin, stdout, stderr):
                    descriptor = os.dup(stream.fileno())
                    descriptors.append(descriptor)
                    os.set_inheritable(descriptor, True)
                handles = (w.HANDLE * 3)(
                    *[msvcrt.get_osfhandle(fd) for fd in descriptors]
                )
                jobs = (w.HANDLE * 1)(self.job)
                # Only stdio is inherited. Job assignment does not inherit its handle.
                for attribute, value in ((0x20002, handles), (0x2000D, jobs)):
                    _checked(
                        _kernel32.UpdateProcThreadAttribute(
                            attributes,
                            0,
                            attribute,
                            value,
                            ctypes.sizeof(value),
                            None,
                            None,
                        )
                    )
                startup = _StartupInfoEx()
                startup.StartupInfo.cb = ctypes.sizeof(startup)
                startup.StartupInfo.dwFlags = 0x100  # STARTF_USESTDHANDLES
                startup.StartupInfo.hStdInput = handles[0]
                startup.StartupInfo.hStdOutput = handles[1]
                startup.StartupInfo.hStdError = handles[2]
                startup.lpAttributeList = ctypes.cast(attributes, w.LPVOID)
                info = _ProcessInfo()
                command = ctypes.create_unicode_buffer(subprocess.list2cmdline(args))
                # EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, no shell.
                _checked(
                    _kernel32.CreateProcessW(
                        str(Path(executable).resolve()),
                        command,
                        None,
                        None,
                        True,
                        0x80000 | 0x8000000,
                        None,
                        str(cwd),
                        ctypes.byref(startup),
                        ctypes.byref(info),
                    )
                )
                self.process = info.hProcess
                _kernel32.CloseHandle(info.hThread)
            finally:
                _kernel32.DeleteProcThreadAttributeList(attributes)
                for descriptor in descriptors:
                    os.close(descriptor)

        def poll(self) -> int | None:
            status = _kernel32.WaitForSingleObject(self.process, 0)
            if status == 258:  # WAIT_TIMEOUT (exit code 259 is valid).
                return None
            if status != 0:
                raise ctypes.WinError(ctypes.get_last_error())
            result = w.DWORD()
            _checked(_kernel32.GetExitCodeProcess(self.process, ctypes.byref(result)))
            return result.value

        def close(self) -> None:
            # Retain the boundary if stop verification fails. A later cleanup
            # must retry termination, never mistake cleared handles for proof.
            if self.job:
                _terminate_job(self.job)
                _kernel32.CloseHandle(self.job)
                self.job = None
            if self.process:
                _kernel32.CloseHandle(self.process)
                self.process = None

    def _job_process_ids(job) -> list[int]:
        capacity = 32
        while capacity <= 4096:

            class _ProcessIds(ctypes.Structure):
                _fields_ = [
                    ("assigned", w.DWORD),
                    ("count", w.DWORD),
                    ("ids", ctypes.c_size_t * capacity),
                ]

            members = _ProcessIds()
            if _kernel32.QueryInformationJobObject(
                job, 3, ctypes.byref(members), ctypes.sizeof(members), None
            ):
                return list(members.ids[: members.count])
            error = ctypes.get_last_error()
            if error != 234:  # ERROR_MORE_DATA
                raise ctypes.WinError(error)
            capacity = max(capacity * 2, members.assigned)
        raise RuntimeError("Process containment exceeded its inspection limit")

    def _terminate_job(job) -> None:
        try:
            _terminate_job_checked(job)
        except ContainmentError:
            raise
        except (OSError, RuntimeError):
            raise ContainmentError(
                "Child process termination could not be verified"
            ) from None

    def _terminate_job_checked(job) -> None:
        if job in _INCOMPLETE_STOPS:
            _checked(_kernel32.TerminateJobObject(job, 1))
            raise ContainmentError("Child process membership could not be verified")
        pending = _STOP_HANDLES.setdefault(job, {})
        snapshot_complete = False
        # ActiveProcesses reaches zero before Windows signals process handles
        # and releases their resources. Prevent new members before taking the
        # snapshot, then wait every member (including venv launchers/children).
        try:
            limits = _ExtendedLimit()
            _checked(
                _kernel32.QueryInformationJobObject(
                    job, 9, ctypes.byref(limits), ctypes.sizeof(limits), None
                )
            )
            limits.BasicLimitInformation.LimitFlags |= 0x0008  # ACTIVE_PROCESS
            limits.BasicLimitInformation.ActiveProcessLimit = 0
            _checked(
                _kernel32.SetInformationJobObject(
                    job, 9, ctypes.byref(limits), ctypes.sizeof(limits)
                )
            )
            for pid in _job_process_ids(job):
                if pid in pending:
                    continue
                handle = _kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
                if not handle:
                    error = ctypes.get_last_error()
                    if error == 87:  # ERROR_INVALID_PARAMETER: PID already gone.
                        continue
                    raise ctypes.WinError(error)
                pending[pid] = handle
            snapshot_complete = True
        finally:
            if not snapshot_complete:
                # Once termination starts, an incomplete PID snapshot cannot be
                # reconstructed from accounting/PIDs that may already be empty.
                # Require supervisor restart; never turn partial proof into success.
                _INCOMPLETE_STOPS.add(job)
            # Even a snapshot failure must request termination; it still cannot
            # authorize a stopped attestation. Retain handles for a later retry.
            _checked(_kernel32.TerminateJobObject(job, 1))
        deadline = time.monotonic() + 10
        for handle in pending.values():
            while True:
                status = _kernel32.WaitForSingleObject(handle, 100)
                if status == 0:
                    break
                if status != 258:
                    raise ctypes.WinError(ctypes.get_last_error())
                if time.monotonic() >= deadline:
                    raise RuntimeError("Child processes did not terminate")
        while True:
            accounting = _Accounting()
            _checked(
                _kernel32.QueryInformationJobObject(
                    job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None
                )
            )
            if accounting.ActiveProcesses == 0:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("Child processes did not terminate")
            time.sleep(0.02)
        for handle in pending.values():
            _kernel32.CloseHandle(handle)
        del _STOP_HANDLES[job]
