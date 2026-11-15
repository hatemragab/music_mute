"""Supplementary Store checks around the unchanged GPU benchmark cores.

The native Creator retains the actual code census, private model/fixture,
Prepare owner, physical GPU and whole Job. These bounded path/data checks do
not construct that authority, run a substitute engine or grant Ready.
"""
from __future__ import annotations

import ctypes
import hashlib
import importlib
import ntpath
import os
import platform
import re
import sys
import uuid
from typing import Callable, Literal

BENCHMARK_FILE_CORE_SHA256 = "7392783976b4dc5f05e004aecb402e9db689ecdff6b2ed73c1408793c49d0e70"
BENCHMARK_CAPACITY_CORE_SHA256 = "82601f1e8c564b9e636deeb6c90cdc5b174748babe955c16cd45a1e37d4e500a"
QUALIFICATION_CORE_SHA256 = "3a2418711307eae30d2d21a2dd23eaafde52011315dfa0fab8dfd9baa5b7c889"
Operation = Literal["benchmark_file", "benchmark_capacity"]
UUID_V4 = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
SHA256 = re.compile(r"[a-f0-9]{64}")
COMMON_ARGUMENTS = frozenset((
    "--provider", "--fixture", "--fixture-sha256", "--work-root",
    "--release-root", "--model-cache", "--ffmpeg", "--ffprobe",
    "--runtime-profile", "--expected-user-sid", "--directml-device-id",
    "--warmup-runs", "--measured-runs", "--group-size", "--report",
))
FILE_OPTIONS = frozenset(("--candidate-engine-root", "--save-audio-dir"))
FILE_RECIPES = frozenset(("kim-vocals-v2", "kim-vocals-v2-trim"))


class StoreBenchmarkError(Exception):
    def __init__(self):
        super().__init__("STORE_BENCHMARK_CONTEXT_INVALID")


def _require(value: object) -> None:
    if not value:
        raise StoreBenchmarkError()


def _same_path(first: object, second: object) -> bool:
    return type(first) is str and type(second) is str and ntpath.normcase(first) == ntpath.normcase(second)


def _user_sid(value: object) -> bool:
    return (type(value) is str
        and re.fullmatch(r"S-1-(?:5-21|12-1)-(?:[0-9]{1,10}-){3}[0-9]{1,10}", value) is not None
        and all(int(part) <= 0xffffffff for part in value.split("-")[4:]))


def validate_store_arguments(arguments: list[str], operation: Operation,
                             worker_root: str, private_root: str, sid: str) -> None:
    """Validate fixed native data argv, without selecting a launch/code root."""
    _require(type(operation) is str and operation in ("benchmark_file", "benchmark_capacity")
        and type(worker_root) is str and type(private_root) is str)
    file = operation == "benchmark_file"
    required = COMMON_ARGUMENTS | ({"--recipe-id"} if file else set())
    allowed = required | (FILE_OPTIONS if file else set())
    _require(type(arguments) is list and len(arguments) % 2 == 0
        and 2 * len(required) <= len(arguments) <= 2 * len(allowed)
        and all(type(value) is str and 0 < len(value) <= 4096 and "\0" not in value
                for value in arguments))
    try:
        _require(sum(len(value.encode("utf-8", "strict")) for value in arguments) <= 32768)
    except UnicodeError:
        raise StoreBenchmarkError() from None
    values = {}
    for index in range(0, len(arguments), 2):
        key = arguments[index]
        _require(key in allowed and key not in values)
        values[key] = arguments[index + 1]
    _require(required <= values.keys() and _user_sid(sid)
        and values["--provider"] == "directml"
        and values["--runtime-profile"] == "windows-user"
        and values["--expected-user-sid"] == sid
        and re.fullmatch(r"(?:[0-9]|1[0-5])", values["--directml-device-id"])
        and re.fullmatch(r"[0-2]" if file else r"[1-2]", values["--warmup-runs"])
        and re.fullmatch(r"(?:[3-9]|10)", values["--measured-runs"])
        and values["--group-size"] == "1"
        and SHA256.fullmatch(values["--fixture-sha256"]))
    fixed = {
        "--release-root": worker_root,
        "--model-cache": ntpath.join(private_root, "models"),
        "--ffmpeg": ntpath.join(worker_root, "runtime", "bin", "ffmpeg.exe"),
        "--ffprobe": ntpath.join(worker_root, "runtime", "bin", "ffprobe.exe"),
    }
    _require(all(_same_path(values[key], path) for key, path in fixed.items()))
    work = values["--work-root"]
    request = ntpath.basename(ntpath.dirname(work))
    _require(UUID_V4.fullmatch(request)
        and _same_path(work, ntpath.join(private_root, "prepare", "work", request, "engine"))
        and _same_path(values["--report"], ntpath.join(private_root, "prepare", "results",
            request + ".benchmark.raw.json")))
    fixture = (ntpath.join(private_root, "prepare", "work", request, "source.wav") if file
        else ntpath.join(private_root, "prepare", "approved", values["--fixture-sha256"] + ".wav"))
    _require(_same_path(values["--fixture"], fixture))
    if file:
        _require(values["--recipe-id"] in FILE_RECIPES)
        if "--candidate-engine-root" in values:
            _require(_same_path(values["--candidate-engine-root"], ntpath.join(worker_root, "app", "engine")))
        if "--save-audio-dir" in values:
            _require(_same_path(values["--save-audio-dir"], ntpath.join(private_root,
                "prepare", "work", request, "saved-audio")))


def _private_root() -> str:
    """Current Known Folder only; no environment or caller-provided data root."""
    from ctypes import wintypes as w
    from .store_code_reader import PERSONAL_ROOT_NAME

    shell = ctypes.WinDLL("shell32.dll", winmode=0x00000800)
    ole = ctypes.WinDLL("ole32.dll", winmode=0x00000800)
    resolve = shell.SHGetKnownFolderPath
    resolve.argtypes, resolve.restype = [ctypes.c_void_p, w.DWORD, w.HANDLE, ctypes.POINTER(w.LPWSTR)], ctypes.c_long
    release = ole.CoTaskMemFree
    release.argtypes, release.restype = [ctypes.c_void_p], None
    local = ctypes.create_string_buffer(uuid.UUID("f1b32785-6fba-4fcf-9d55-7b8e7f157091").bytes_le, 16)
    path = w.LPWSTR()
    status = resolve(local, 0, None, ctypes.byref(path))
    try:
        _require(status == 0 and path)
        value = path.value
        _require(type(value) is str and ntpath.isabs(value) and not value.startswith("\\\\"))
        return ntpath.join(value, PERSONAL_ROOT_NAME)
    finally:
        if path:
            release(ctypes.cast(path, ctypes.c_void_p))


def _current_sid() -> str:
    # The unchanged engine observes this same Windows identity. Native supplies
    # its fixed SystemRoot environment and separately validates the actual SID.
    from .qualification import service_identity
    return service_identity()


def _validated_benchmark(operation: Operation, entry_file: str) -> Callable[[], int] | None:
    """Obtain the unchanged entry only after all supplementary context checks."""
    if not (sys.platform == "win32" and ctypes.sizeof(ctypes.c_void_p) == 8
            and platform.machine().lower() in ("amd64", "x86_64")
            and sys.flags.isolated and sys.flags.ignore_environment and sys.flags.no_user_site):
        return None
    _require(type(operation) is str and operation in ("benchmark_file", "benchmark_capacity"))
    from .store_code_reader import (
        StoreCodeReader, BENCHMARK_FILE_ENTRY_PATH, BENCHMARK_FILE_CORE_PATH,
        BENCHMARK_CAPACITY_ENTRY_PATH, BENCHMARK_CAPACITY_CORE_PATH,
        BENCHMARK_CONTEXT_PATH, QUALIFICATION_CORE_PATH, RELEASE_MANIFEST_PATH,
    )

    reader = StoreCodeReader()
    worker = ntpath.join(reader.root, "worker")
    entry = BENCHMARK_FILE_ENTRY_PATH if operation == "benchmark_file" else BENCHMARK_CAPACITY_ENTRY_PATH
    core = BENCHMARK_FILE_CORE_PATH if operation == "benchmark_file" else BENCHMARK_CAPACITY_CORE_PATH
    _require(_same_path(os.path.abspath(entry_file), reader.path(entry))
        and _same_path(os.path.abspath(__file__), reader.path(BENCHMARK_CONTEXT_PATH))
        and _same_path(sys.executable, ntpath.join(worker, "runtime", "python", "python.exe")))
    reader.read(entry, 1024 * 1024)
    reader.read(BENCHMARK_CONTEXT_PATH, 1024 * 1024)
    _require(hashlib.sha256(reader.read(BENCHMARK_FILE_CORE_PATH, 1024 * 1024)).hexdigest()
        == BENCHMARK_FILE_CORE_SHA256)
    if operation == "benchmark_capacity":
        _require(hashlib.sha256(reader.read(BENCHMARK_CAPACITY_CORE_PATH, 1024 * 1024)).hexdigest()
            == BENCHMARK_CAPACITY_CORE_SHA256)
    _require(hashlib.sha256(reader.read(QUALIFICATION_CORE_PATH, 1024 * 1024)).hexdigest()
        == QUALIFICATION_CORE_SHA256)
    reader.read(RELEASE_MANIFEST_PATH, 16 * 1024 * 1024)
    validate_store_arguments(sys.argv[1:], operation, worker, _private_root(), _current_sid())
    sys.dont_write_bytecode = True
    legacy = importlib.import_module("." + ("benchmark_file" if operation == "benchmark_file"
        else "capacity_benchmark"), __package__)
    _require(_same_path(os.path.abspath(legacy.__file__), reader.path(core)))
    return legacy.main


def run_store_benchmark(operation: Operation, entry_file: str) -> int:
    """Delegate unchanged core/report behavior and preserve direct exceptions."""
    benchmark = _validated_benchmark(operation, entry_file)
    return 2 if benchmark is None else benchmark()


def store_benchmark_cli(operation: Operation, entry_file: str) -> int:
    """Keep validation and benchmark-operation CLI failures distinct and safe."""
    try:
        benchmark = _validated_benchmark(operation, entry_file)
        if benchmark is None:
            raise StoreBenchmarkError()
    except Exception:
        sys.stderr.write("STORE_BENCHMARK_CONTEXT_INVALID\n")
        return 2
    try:
        return benchmark()
    except Exception:
        # The original core may fail before its own report catch (for example,
        # during initial validation). Do not leak its path/message/traceback.
        sys.stderr.write("STORE_BENCHMARK_OPERATION_FAILED\n")
        return 1
