"""Fixed Store downloader reads, never a launch/account authority constructor.

The native creator retains the compiled signature origin, complete code census and
the owned Job. This supplementary reader derives its paths from the current OS
package and checks held immutable files. No caller root or approval flag exists.
Private TEMP/media continue using the unchanged downloader WindowsFiles policy.
"""
from __future__ import annotations

from contextlib import contextmanager
import ctypes
import hashlib
import json
import ntpath
import os
import re
import sys
from types import MappingProxyType

# The package assembler may replace this one fixed source literal before sealing
# a separate local-test package. No environment, argument or mutable file selects it.
PACKAGE_BUILD_PROFILE = "store-v1"
LEGACY_BOOTSTRAP_SHA256 = "2f510f42390050de123e257a8ae85a00266409e02a8142490c3a1b04a9dda6a2"
READER_PATH = "worker/app/engine/musicmute_engine/store_code_reader.py"
ENTRY_PATH = "worker/tools/downloader/store_downloader_bootstrap.py"
PERSONAL_ENTRY_PATH = "worker/app/engine/musicmute_engine/store_consumer_personal.py"
PERSONAL_CORE_PATH = "worker/app/engine/musicmute_engine/consumer_personal.py"
QUALIFICATION_ENTRY_PATH = "worker/app/engine/musicmute_engine/store_qualification.py"
QUALIFICATION_CORE_PATH = "worker/app/engine/musicmute_engine/qualification.py"
BENCHMARK_FILE_ENTRY_PATH = "worker/app/engine/musicmute_engine/store_benchmark_file.py"
BENCHMARK_FILE_CORE_PATH = "worker/app/engine/musicmute_engine/benchmark_file.py"
BENCHMARK_CAPACITY_ENTRY_PATH = "worker/app/engine/musicmute_engine/store_benchmark_capacity.py"
BENCHMARK_CAPACITY_CORE_PATH = "worker/app/engine/musicmute_engine/capacity_benchmark.py"
BENCHMARK_CONTEXT_PATH = "worker/app/engine/musicmute_engine/store_benchmark_context.py"
BENCHMARK_CODE_PATHS = frozenset((BENCHMARK_FILE_ENTRY_PATH, BENCHMARK_FILE_CORE_PATH,
    BENCHMARK_CAPACITY_ENTRY_PATH, BENCHMARK_CAPACITY_CORE_PATH, BENCHMARK_CONTEXT_PATH))
RELEASE_MANIFEST_PATH = "worker/release-manifest.json"
DOWNLOADER_ROOT = "worker/tools/downloader"
YOUTUBE_ROOT = "worker/tools/youtube"
CACHE_ROOT = YOUTUBE_ROOT + "/deno-cache"
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
TRUSTED_WRITERS = frozenset(("S-1-5-18", "S-1-5-32-544",
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"))


class StoreReadError(Exception):
    """Only this fixed code crosses the reader boundary."""
    def __init__(self):
        super().__init__("STORE_DOWNLOADER_CODE_INVALID")


def _require(value):
    if not value:
        raise StoreReadError()


if PACKAGE_BUILD_PROFILE == "store-v1":
    WORKER_NAME = "27120VCHATSDK.MusicMuteWorker"
    PUBLISHER_ID = "5q1esjnkz8cve"
    PERSONAL_ROOT_NAME = "MusicMuteLocal"
elif PACKAGE_BUILD_PROFILE == "local-test-v1":
    WORKER_NAME = "MusicMute.WorkerDevelopment"
    PUBLISHER_ID = "kthggmwhkdz4t"
    PERSONAL_ROOT_NAME = "MusicMuteLocalDevelopment"
else:
    raise StoreReadError()


def relative_path(value):
    _require(isinstance(value, str) and 0 < len(value) <= 1024
        and re.fullmatch(r"[\x20-\x7e]+", value)
        and not re.search(r'[\\<>:"|?*]', value))
    _require(all(part and len(part) <= 255 and part not in (".", "..") and not part.endswith((".", " "))
        and not re.match(r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part)
        for part in value.split("/")))
    return value


def package_identity(full_name):
    match = re.fullmatch(re.escape(WORKER_NAME) + r"_0\.1\.3\.(0|[1-9][0-9]{0,4})_x64__" + PUBLISHER_ID,
        full_name if isinstance(full_name, str) else "")
    _require(match and int(match[1]) <= 65535)
    return full_name


def _pairs(rows):
    result = {}
    for key, value in rows:
        _require(key not in result)
        result[key] = value
    return result


def _no_number(_value):
    raise StoreReadError()


def parse_inventory(data):
    _require(isinstance(data, bytes) and 0 < len(data) <= 8 * 1024 * 1024)
    try:
        value = json.loads(data.decode("utf-8", "strict"), object_pairs_hook=_pairs,
            parse_float=_no_number, parse_constant=_no_number)
        pending, count = [(value, 0)], 0
        while pending:
            node, depth = pending.pop()
            count += 1
            _require(depth <= 32 and count <= 400000)
            if isinstance(node, dict):
                pending.extend((child, depth + 1) for child in node.values())
            elif isinstance(node, list):
                pending.extend((child, depth + 1) for child in node)
        _require(type(value) is dict and set(value) == {
            "version", "role", "packageVersion", "protocolAbi", "appVersion", "buildNumber", "entries"})
        _require(type(value["version"]) is int and value["version"] == 1
            and value["role"] == "worker" and value["packageVersion"] == "0.1.3.0"
            and type(value["protocolAbi"]) is int and value["protocolAbi"] == 1
            and value["appVersion"] == "0.1.3" and type(value["buildNumber"]) is int
            and 0 < value["buildNumber"] <= 2147483647
            and type(value["entries"]) is list and 0 < len(value["entries"]) <= 65536)
        result, aliases, previous, total = {}, set(), "", 0
        for row in value["entries"]:
            _require(type(row) is dict and set(row) == {"path", "bytes", "sha256"})
            key = relative_path(row["path"])
            _require(key.startswith("worker/") and key > previous and key.lower() not in aliases
                and type(row["bytes"]) is int and 0 <= row["bytes"] <= 512 * 1024 * 1024
                and isinstance(row["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", row["sha256"])
                and (row["bytes"] > 0 or (row["sha256"] == EMPTY_SHA256
                    and not re.search(r"(?i)\.(exe|dll|pyd|node)$", key))))
            total += row["bytes"]
            _require(total <= 64 * 1024 ** 3)
            aliases.add(key.lower())
            previous = key
            result[key] = (row["bytes"], row["sha256"])
        for key in (READER_PATH, ENTRY_PATH, DOWNLOADER_ROOT + "/downloader_bootstrap.py",
                YOUTUBE_ROOT + "/bin/deno.exe", YOUTUBE_ROOT + "/provider/src/generate_once.ts",
                YOUTUBE_ROOT + "/provider/deno.json", YOUTUBE_ROOT + "/provider/deno.lock",
                "worker/runtime/bin/ffmpeg.exe"):
            _require(key in result and result[key][0] > 0)
        _require(any(key.startswith(CACHE_ROOT + "/") for key in result))
        _require(result[DOWNLOADER_ROOT + "/downloader_bootstrap.py"][1] == LEGACY_BOOTSTRAP_SHA256)
        return MappingProxyType(result)
    except (ValueError, TypeError, UnicodeError, RecursionError, KeyError, OverflowError):
        raise StoreReadError() from None


def validate_code_acl(owner, entries, granted, directory):
    """Matches native immutable ACL policy; effective access is real AccessCheck."""
    writes = 0x2 | 0x4 | 0x10 | 0x100 | 0x10000 | 0x40000 | 0x80000 | (0x40 if directory else 0)
    _require(owner in TRUSTED_WRITERS and 0 < len(entries) <= 256
        and type(granted) is int and granted >= 0 and granted & writes == 0)
    for kind, flags, mask, sid in entries:
        if flags & 8 or kind in (1, 6, 10, 12):
            continue
        _require(kind in (0, 5, 9, 11))
        if mask & writes:
            _require(kind == 0 and sid in TRUSTED_WRITERS)


def same_file(before, after):
    """Volume/index/link count/attributes/size/creation/write times stay exact."""
    _require(type(before) is tuple and type(after) is tuple and len(before) == len(after) == 10
        and before == after and before[2] > 0 and before[4] >= 0)


def _api_string(library, name):
    from ctypes import wintypes as w
    function = getattr(library, name)
    function.argtypes, function.restype = [ctypes.POINTER(w.DWORD), w.LPWSTR], w.LONG
    length = w.DWORD()
    _require(function(ctypes.byref(length), None) == 122 and 1 < length.value <= 32768)
    buffer = ctypes.create_unicode_buffer(length.value)
    _require(function(ctypes.byref(length), buffer) == 0 and length.value == len(buffer.value) + 1)
    return buffer.value


def current_package_path():
    _require(sys.platform == "win32" and ctypes.sizeof(ctypes.c_void_p) == 8)
    kernel = ctypes.WinDLL("kernel32.dll", winmode=0x00000800, use_last_error=True)
    package_identity(_api_string(kernel, "GetCurrentPackageFullName"))
    path = _api_string(kernel, "GetCurrentPackagePath")
    drive, tail = ntpath.splitdrive(path)
    _require(re.fullmatch(r"[A-Za-z]:", drive) and tail.startswith("\\")
        and not tail.endswith("\\") and not re.search(r'[<>:"|?*\x00-\x1f]', tail)
        and all(part and part not in (".", "..") and not part.endswith((".", " "))
            for part in tail[1:].split("\\")))
    return path


class StoreCodeReader:
    """Read only the fixed acquisition subtrees in the current OS package."""
    def __init__(self):
        from ctypes import wintypes as w
        self.w = w
        self.root = current_package_path()
        self.kernel = ctypes.WinDLL("kernel32.dll", winmode=0x00000800, use_last_error=True)
        self.advapi = ctypes.WinDLL("advapi32.dll", winmode=0x00000800, use_last_error=True)
        self.full_name = package_identity(_api_string(self.kernel, "GetCurrentPackageFullName"))
        self.parents, self.descriptor_parents, self.descriptor_states = {}, {}, {}
        pointer = ctypes.c_void_p
        def typed(library, name, result, arguments):
            function = getattr(library, name)
            function.restype, function.argtypes = result, arguments
            return function
        self.close_handle = typed(self.kernel, "CloseHandle", w.BOOL, [w.HANDLE])
        self.create = typed(self.kernel, "CreateFileW", w.HANDLE,
            [w.LPCWSTR, w.DWORD, w.DWORD, pointer, w.DWORD, w.DWORD, w.HANDLE])
        self.info = typed(self.kernel, "GetFileInformationByHandle", w.BOOL, [w.HANDLE, pointer])
        self.canonical = typed(self.kernel, "GetFinalPathNameByHandleW", w.DWORD, [w.HANDLE, w.LPWSTR, w.DWORD, w.DWORD])
        self.free = typed(self.kernel, "LocalFree", pointer, [pointer])
        self.security = typed(self.advapi, "GetSecurityInfo", w.DWORD,
            [w.HANDLE, ctypes.c_int, w.DWORD, ctypes.POINTER(pointer), ctypes.POINTER(pointer),
             ctypes.POINTER(pointer), pointer, ctypes.POINTER(pointer)])
        self.get_ace = typed(self.advapi, "GetAce", w.BOOL, [pointer, w.DWORD, ctypes.POINTER(pointer)])
        self.sid_string = typed(self.advapi, "ConvertSidToStringSidW", w.BOOL, [pointer, ctypes.POINTER(w.LPWSTR)])
        self.valid_sid = typed(self.advapi, "IsValidSid", w.BOOL, [pointer])
        self.sid_length = typed(self.advapi, "GetLengthSid", w.DWORD, [pointer])
        self.process = typed(self.kernel, "GetCurrentProcess", w.HANDLE, [])
        self.duplicate_handle = typed(self.kernel, "DuplicateHandle", w.BOOL,
            [w.HANDLE, w.HANDLE, w.HANDLE, ctypes.POINTER(w.HANDLE), w.DWORD, w.BOOL, w.DWORD])
        self.open_token = typed(self.advapi, "OpenProcessToken", w.BOOL, [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)])
        self.duplicate = typed(self.advapi, "DuplicateTokenEx", w.BOOL,
            [w.HANDLE, w.DWORD, pointer, ctypes.c_int, ctypes.c_int, ctypes.POINTER(w.HANDLE)])
        self.access = typed(self.advapi, "AccessCheck", w.BOOL,
            [pointer, w.HANDLE, w.DWORD, pointer, pointer, ctypes.POINTER(w.DWORD),
             ctypes.POINTER(w.DWORD), ctypes.POINTER(w.BOOL)])
        self.map_mask = typed(self.advapi, "MapGenericMask", None, [ctypes.POINTER(w.DWORD), pointer])
        self.inventory = None
        with self._raw_reader("store-code-inventory.json", 8 * 1024 * 1024) as file:
            self.inventory = parse_inventory(file.read())
        _require(ntpath.normcase(os.path.abspath(__file__)) == ntpath.normcase(self.path(READER_PATH)))
        _require(ntpath.normcase(sys.executable) == ntpath.normcase(self.path("worker/runtime/python/python.exe")))
        self.read(READER_PATH, 1024 * 1024)

    def _revalidate_package(self):
        _require(_api_string(self.kernel, "GetCurrentPackageFullName") == self.full_name
            and ntpath.normcase(current_package_path()) == ntpath.normcase(self.root))

    def path(self, key):
        relative_path(key)
        return ntpath.join(self.root, *key.split("/"))

    def key(self, path):
        _require(isinstance(path, str))
        key = ntpath.relpath(path, self.root).replace("\\", "/")
        relative_path(key)
        _require(ntpath.normcase(path) == ntpath.normcase(self.path(key)))
        return key

    def allowed(self, key, directory=False):
        relative_path(key)
        if directory:
            _require(key in (DOWNLOADER_ROOT, YOUTUBE_ROOT)
                or key.startswith(DOWNLOADER_ROOT + "/") or key.startswith(YOUTUBE_ROOT + "/"))
            _require(any(entry.startswith(key + "/") for entry in self.inventory))
        else:
            _require(key in (READER_PATH, ENTRY_PATH, PERSONAL_ENTRY_PATH, PERSONAL_CORE_PATH,
                QUALIFICATION_ENTRY_PATH, QUALIFICATION_CORE_PATH, RELEASE_MANIFEST_PATH)
                or key in BENCHMARK_CODE_PATHS or key.startswith(DOWNLOADER_ROOT + "/")
                or key.startswith(YOUTUBE_ROOT + "/"))
            _require(key in self.inventory)
            if key in BENCHMARK_CODE_PATHS:
                _require(self.inventory[key][0] > 0)

    def _sid(self, pointer):
        _require(pointer and self.valid_sid(pointer))
        text = self.w.LPWSTR()
        _require(self.sid_string(pointer, ctypes.byref(text)))
        try:
            return text.value
        finally:
            self.free(ctypes.cast(text, ctypes.c_void_p))

    def _observation(self, handle, directory):
        buffer = ctypes.create_string_buffer(52)
        _require(self.info(handle, buffer))
        raw = bytes(buffer)
        values = tuple(int.from_bytes(raw[n:n + 4], "little") for n in range(0, 52, 4))
        _require(not values[0] & 0x400 and bool(values[0] & 0x10) == directory and values[10] > 0)
        return (values[7], (values[11] << 32) | values[12], values[10], values[0],
            (values[8] << 32) | values[9], values[1], values[2], values[5], values[6], directory)

    def _acl(self, handle, directory):
        c, w = ctypes, self.w
        pointer = c.c_void_p
        owner, group, dacl, descriptor = pointer(), pointer(), pointer(), pointer()
        # AccessCheck requires both owner and primary group in its descriptor.
        # READ_CONTROL already permits this complete query; no rights are added.
        _require(self.security(handle, 1, 7, c.byref(owner), c.byref(group),
            c.byref(dacl), None, c.byref(descriptor)) == 0)
        class Mapping(c.Structure):
            _fields_ = [("read", w.DWORD), ("write", w.DWORD), ("execute", w.DWORD), ("all", w.DWORD)]
        mapping = Mapping(0x120089, 0x120116, 0x1200a0, 0x1f01ff)
        token, impersonation = w.HANDLE(), w.HANDLE()
        try:
            _require(owner and group and self.valid_sid(group) and dacl)
            count = c.c_ushort.from_address(dacl.value + 4).value
            _require(0 < count <= 256)
            entries = []
            for index in range(count):
                ace = pointer()
                _require(self.get_ace(dacl, index, c.byref(ace)) and ace)
                kind = c.c_ubyte.from_address(ace.value).value
                flags = c.c_ubyte.from_address(ace.value + 1).value
                size = c.c_ushort.from_address(ace.value + 2).value
                _require(size >= 8)
                mask = w.DWORD.from_address(ace.value + 4)
                mapped = w.DWORD(mask.value)
                self.map_mask(c.byref(mapped), c.byref(mapping))
                sid = None
                if kind == 0 and not flags & 8:
                    _require(size >= 16 and self.valid_sid(ace.value + 8)
                        and self.sid_length(ace.value + 8) <= size - 8)
                    sid = self._sid(ace.value + 8)
                entries.append((kind, flags, mapped.value, sid))
            _require(self.open_token(self.process(), 0xa, c.byref(token))
                and self.duplicate(token, 8, None, 2, 2, c.byref(impersonation)))
            privileges, length = c.create_string_buffer(4096), w.DWORD(4096)
            granted, access = w.DWORD(), w.BOOL()
            _require(self.access(descriptor, impersonation, 0x02000000, c.byref(mapping),
                privileges, c.byref(length), c.byref(granted), c.byref(access)) and access.value)
            validate_code_acl(self._sid(owner), entries, granted.value, directory)
        finally:
            if impersonation:
                self.close_handle(impersonation)
            if token:
                self.close_handle(token)
            self.free(descriptor)

    def _open(self, path, directory, immutable=True):
        handle = self.create(path, 0x20080 | (0 if directory else 0x80000000),
            3 if directory else 1, None, 3, 0x00200000 | (0x02000000 if directory else 0), None)
        _require(handle and handle != ctypes.c_void_p(-1).value)
        try:
            self._observation(handle, directory)
            buffer = ctypes.create_unicode_buffer(32768)
            length = self.canonical(handle, buffer, len(buffer), 0)
            _require(0 < length < len(buffer))
            final = buffer.value[4:] if buffer.value.startswith("\\\\?\\") else buffer.value
            _require(ntpath.normcase(final) == ntpath.normcase(path))
            if immutable:
                self._acl(handle, directory)
            return handle
        except BaseException:
            self.close_handle(handle)
            raise

    def open(self, path, directory=False):
        key = self.key(path)
        self.allowed(key, directory)
        return self._open_held_path(key, directory)

    def _open_held_path(self, key, directory):
        path = self.path(key)
        self._revalidate_package()
        parents = []
        try:
            # The current OS package supplies the exact root. Standard users
            # may open that protected root while Windows denies opening its
            # WindowsApps ancestor. Anchor to the immutable, canonical,
            # nonreparse root and retain it with every protected descendant.
            cursor = self.root
            parents.append(self._open(cursor, True))
            for part in key.split("/")[:-1]:
                cursor = ntpath.join(cursor, part)
                parents.append(self._open(cursor, True))
            handle = self._open(path, directory)
            self.parents[handle] = parents
            return handle
        except BaseException:
            for parent in parents:
                self.close_handle(parent)
            raise

    def close(self, handle):
        self.close_handle(handle)
        for parent in self.parents.pop(handle, []):
            self.close_handle(parent)

    @contextmanager
    def _raw_reader(self, key, maximum):
        # Only the protected fixed inventory is read before parsing its pins.
        _require(key == "store-code-inventory.json")
        handle = self._open_held_path(key, False)
        import msvcrt
        descriptor = None
        try:
            before = self._observation(handle, False)
            _require(0 < before[4] <= maximum)
            descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
            with os.fdopen(descriptor, "rb") as file:
                yield file
                same_file(before, self._observation(handle, False))
                self._acl(handle, False)
                self._revalidate_package()
        finally:
            if descriptor is None:
                self.close(handle)
            else:
                for parent in self.parents.pop(handle, []):
                    self.close_handle(parent)

    def read_descriptor(self, path):
        import msvcrt
        key = self.key(path)
        handle = self.open(path)
        try:
            expected = self.inventory[key]
            before = self._observation(handle, False)
            _require(before[4] == expected[0])
            duplicate = self.w.HANDLE()
            _require(self.duplicate_handle(self.process(), handle, self.process(),
                ctypes.byref(duplicate), 0, False, 2))
            try:
                descriptor = msvcrt.open_osfhandle(duplicate.value, os.O_RDONLY | os.O_BINARY)
            except BaseException:
                self.close_handle(duplicate)
                raise
            self.descriptor_parents[descriptor] = self.parents.pop(handle, [])
            self.descriptor_states[descriptor] = (handle, before)
            # Verify through this exact descriptor; consumers receive it reset.
            digest = hashlib.sha256()
            total = 0
            while chunk := os.read(descriptor, 128 * 1024):
                total += len(chunk)
                _require(total <= expected[0])
                digest.update(chunk)
            _require(total == expected[0] and digest.hexdigest() == expected[1])
            same_file(before, self._observation(handle, False))
            self._acl(handle, False)
            self._revalidate_package()
            os.lseek(descriptor, 0, 0)
            return descriptor
        except BaseException:
            if "descriptor" in locals():
                os.close(descriptor)
                self.release_descriptor_parents(descriptor)
            else:
                self.close(handle)
            raise

    def release_descriptor_parents(self, descriptor):
        state = self.descriptor_states.pop(descriptor, None)
        try:
            if state:
                handle, before = state
                same_file(before, self._observation(handle, False))
                self._acl(handle, False)
                self._revalidate_package()
        finally:
            if state:
                self.close_handle(state[0])
            for parent in self.descriptor_parents.pop(descriptor, []):
                self.close_handle(parent)

    def read(self, key, maximum=512 * 1024 * 1024):
        self.allowed(key)
        _require(0 <= self.inventory[key][0] <= maximum)
        descriptor = self.read_descriptor(self.path(key))
        try:
            with os.fdopen(descriptor, "rb") as file:
                return file.read(maximum + 1)
        finally:
            self.release_descriptor_parents(descriptor)

    def directory(self, key):
        self.allowed(key, True)
        path = self.path(key)
        handle = self.open(path, True)
        self.close(handle)
        return path
