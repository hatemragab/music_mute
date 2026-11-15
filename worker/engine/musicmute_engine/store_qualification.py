"""Fixed Store adapter around the unchanged production GPU qualification.

The native Creator retains the actual Prepare Node, immutable code, private
fixture/model and physical GPU lease through whole-Job retirement. These
supplementary path/code checks cannot construct that authority or mark Ready.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import ntpath
import os
import re
import sys
import uuid

QUALIFICATION_CORE_SHA256 = "3a2418711307eae30d2d21a2dd23eaafde52011315dfa0fab8dfd9baa5b7c889"
UUID_V4 = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
ARGUMENTS = frozenset(("--provider", "--fixture", "--fixture-sha256", "--work-root",
    "--release-root", "--model-cache", "--ffmpeg", "--ffprobe", "--runtime-profile",
    "--expected-user-sid", "--directml-device-id", "--report"))


class StoreQualificationError(Exception):
    def __init__(self):
        super().__init__("STORE_QUALIFICATION_CONTEXT_INVALID")


def _require(value):
    if not value:
        raise StoreQualificationError()


def _same_path(first, second):
    return isinstance(first, str) and isinstance(second, str) and ntpath.normcase(first) == ntpath.normcase(second)


def validate_store_arguments(arguments, worker_root, private_root, sid):
    """Closed receiving data checks; native holds/derives these actual paths."""
    _require(type(arguments) is list and len(arguments) == 2 * len(ARGUMENTS)
        and all(isinstance(value, str) and 0 < len(value) <= 4096 and "\0" not in value for value in arguments))
    values = {}
    for index in range(0, len(arguments), 2):
        key = arguments[index]
        _require(key in ARGUMENTS and key not in values)
        values[key] = arguments[index + 1]
    _require(set(values) == ARGUMENTS and values["--provider"] == "directml"
        and values["--runtime-profile"] == "windows-user" and values["--expected-user-sid"] == sid
        and re.fullmatch(r"(?:[0-9]|1[0-5])", values["--directml-device-id"])
        and re.fullmatch(r"[a-f0-9]{64}", values["--fixture-sha256"]))
    fixed_paths = {
        "--release-root": worker_root,
        "--model-cache": ntpath.join(private_root, "models"),
        "--ffmpeg": ntpath.join(worker_root, "runtime", "bin", "ffmpeg.exe"),
        "--ffprobe": ntpath.join(worker_root, "runtime", "bin", "ffprobe.exe"),
    }
    _require(all(_same_path(values[key], path) for key, path in fixed_paths.items()))
    request = ntpath.basename(values["--work-root"])
    _require(UUID_V4.fullmatch(request)
        and _same_path(values["--work-root"], ntpath.join(private_root, "prepare", "work", request))
        and _same_path(values["--report"], ntpath.join(private_root, "prepare", "results", request + ".raw.json")))
    _require(_same_path(values["--fixture"], ntpath.join(private_root, "fixtures", "prepare-fixture.wav"))
        or _same_path(values["--fixture"], ntpath.join(private_root, "prepare", "approved", values["--fixture-sha256"] + ".wav")))


def _private_root():
    """Resolve the current user's actual Known Folder, never an environment root."""
    from ctypes import wintypes as w
    from .store_code_reader import PERSONAL_ROOT_NAME
    shell = ctypes.WinDLL("shell32.dll", winmode=0x00000800)
    ole = ctypes.WinDLL("ole32.dll", winmode=0x00000800)
    resolve = shell.SHGetKnownFolderPath
    resolve.argtypes, resolve.restype = [ctypes.c_void_p, w.DWORD, w.HANDLE, ctypes.POINTER(w.LPWSTR)], ctypes.c_long
    release = ole.CoTaskMemFree
    release.argtypes, release.restype = [ctypes.c_void_p], None
    local_app_data = ctypes.create_string_buffer(uuid.UUID("f1b32785-6fba-4fcf-9d55-7b8e7f157091").bytes_le, 16)
    path = w.LPWSTR()
    status = resolve(local_app_data, 0, None, ctypes.byref(path))
    try:
        _require(status == 0 and path)
        value = path.value
        _require(isinstance(value, str) and ntpath.isabs(value) and not value.startswith("\\\\"))
        return ntpath.join(value, PERSONAL_ROOT_NAME)
    finally:
        if path:
            release(ctypes.cast(path, ctypes.c_void_p))


def main():
    if not (sys.platform == "win32" and sys.flags.isolated and sys.flags.ignore_environment and sys.flags.no_user_site):
        return 2
    from .store_code_reader import (StoreCodeReader, QUALIFICATION_ENTRY_PATH,
        QUALIFICATION_CORE_PATH, RELEASE_MANIFEST_PATH)
    reader = StoreCodeReader()
    worker_root = ntpath.join(reader.root, "worker")
    _require(_same_path(os.path.abspath(__file__), reader.path(QUALIFICATION_ENTRY_PATH))
        and _same_path(sys.executable, ntpath.join(worker_root, "runtime", "python", "python.exe")))
    reader.read(QUALIFICATION_ENTRY_PATH, 1024 * 1024)
    _require(hashlib.sha256(reader.read(QUALIFICATION_CORE_PATH, 1024 * 1024)).hexdigest() == QUALIFICATION_CORE_SHA256)
    reader.read(RELEASE_MANIFEST_PATH, 16 * 1024 * 1024)
    sys.dont_write_bytecode = True
    from . import qualification as legacy
    validate_store_arguments(sys.argv[1:], worker_root, _private_root(), legacy.service_identity())
    return legacy.main()


def qualification_failure_code(error):
    """Closed advisory only; never expose exception text, paths or GPU proof."""
    from .store_code_reader import StoreReadError
    from .windows_gpu import GpuSelectionError
    from .provider_adapter import ProviderAdapterError
    from .qualification import QualificationError
    chain, seen = [], set()
    current = error
    for _ in range(8):
        if not isinstance(current, BaseException) or id(current) in seen:
            break
        seen.add(id(current))
        chain.append(current)
        current = current.__cause__
    if any(isinstance(item, (StoreQualificationError, StoreReadError, QualificationError)) for item in chain):
        return "INTEGRITY_INVALID"
    retryable_provider = (("Required ONNX provider is unavailable",),
        ("Selected GPU changed during model session creation",))
    if any(isinstance(item, ProviderAdapterError) and item.args not in retryable_provider for item in chain):
        return "INTEGRITY_INVALID"
    if any(isinstance(item, GpuSelectionError) for item in chain):
        return "GPU_UNSUPPORTED"
    if any(isinstance(item, ProviderAdapterError) and item.args in retryable_provider for item in chain):
        return "GPU_UNSUPPORTED"
    if any(isinstance(item, ProviderAdapterError) for item in chain):
        return "INTEGRITY_INVALID"
    return "OPERATION_FAILED"


def run_main():
    try:
        status = main()
        if status == 0:
            return 0
        code = "INTEGRITY_INVALID"
    except Exception as error:
        try:
            code = qualification_failure_code(error)
        except Exception:
            code = "OPERATION_FAILED"
    sys.stdout.write(json.dumps({"version": 1, "kind": "store-qualification-failure", "errorCode": code},
        separators=(",", ":")) + "\n")
    sys.stdout.flush()
    return 2


if __name__ == "__main__":
    raise SystemExit(run_main())
