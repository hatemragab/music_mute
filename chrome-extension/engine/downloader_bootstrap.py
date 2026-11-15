"""Verified, immutable wheel launcher; no extraction, pip, site or user imports."""

import sys

if not (
    sys.flags.isolated
    and sys.flags.ignore_environment
    and sys.flags.no_user_site
    and sys.flags.no_site
    and sys.dont_write_bytecode
):
    sys.stderr.write("DOWNLOADER_ISOLATION_REQUIRED\n")
    raise SystemExit(1)

import hashlib
from contextlib import contextmanager
import os
import re
import stat
import tempfile
from urllib.parse import parse_qsl, urlsplit


WHEELS = (
    ("bgutil_ytdlp_pot_provider-2.0.1-py3-none-any.whl", 12777, "ff6c2e85443e0777e2483e4a5ef2084ca745a1dd3cc07cf355ddd3a77bd882e8"),
    (
        "yt_dlp-2026.8.19-py3-none-any.whl",
        3_185_533,
        "1d57897e94c6665a0a6f9bc54b34e584284e32c034ffab3a7df25d8f7b24eedf",
    ),
    (
        "yt_dlp_ejs-0.8.0-py3-none-any.whl",
        53_443,
        "79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4",
    ),
)
EJS_HASHES = {
    "yt.solver.core.min.js": "ee5b307d07f55e91e4723edf5ac205cc877a474187849d757dc1322e38427b157a9d706d510c1723d3670f98e5a3f8cbcde77874a80406bd7204bc9fea30f283",
    "yt.solver.lib.min.js": "8420c259ad16e99ce004e4651ac1bcabb53b4457bf5668a97a9359be9a998a789fee8ab124ee17f91a2ea8fd84e0f2b2fc8eabcaf0b16a186ba734cf422ad053",
}


class BootstrapError(Exception):
    """Only fixed codes cross this boundary; no exception paths or text."""

def validate_windows_path(path):
    """Only ordinary absolute managed paths; device/UNC/ADS aliases are refused."""
    import ntpath
    if not isinstance(path, str) or not 3 < len(path) < 32760:
        raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
    drive, tail = ntpath.splitdrive(path)
    if not re.fullmatch(r"[A-Za-z]:", drive) or not tail.startswith("\\"):
        raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
    parts = tail[1:].split("\\")
    if any(not part or part in (".", "..") or re.search(r'[<>:"|?*\x00-\x1f]', part)
           or part.endswith((".", " ")) or re.match(r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part)
           for part in parts):
        raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
    return path


def validate_windows_security(owner, current, entries):
    """A real handle's DACL, never POSIX mode/UID, establishes Windows access."""
    if (owner != current or current in {"S-1-5-18", "S-1-5-19", "S-1-5-20"}
            or not re.fullmatch(r"S-1-(?:\d+-){1,14}\d+", current) or not entries or len(entries) > 16):
        raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
    own_access = False
    for kind, sid in entries:
        if kind not in (0, 1) or (kind == 0 and sid not in {current, "S-1-5-18"}):
            raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
        own_access = own_access or (kind == 0 and sid == current)
    if not own_access:
        raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")


class WindowsFiles:
    """Narrow Win32 file/ACL adapter, sealed into the verified bootstrap hash."""
    def __init__(self):
        import ctypes
        from ctypes import wintypes as w
        self.c, self.w = ctypes, w
        self.kernel = ctypes.WinDLL("kernel32.dll", winmode=0x00000800, use_last_error=True)
        self.advapi = ctypes.WinDLL("advapi32.dll", winmode=0x00000800, use_last_error=True)
        def typed(library, name, result, arguments):
            function = getattr(library, name)
            function.restype, function.argtypes = result, arguments
            return function
        pointer = ctypes.c_void_p
        self._close = typed(self.kernel, "CloseHandle", w.BOOL, [w.HANDLE])
        self.local_free = typed(self.kernel, "LocalFree", pointer, [pointer])
        self.create_file = typed(self.kernel, "CreateFileW", w.HANDLE, [w.LPCWSTR, w.DWORD, w.DWORD, pointer, w.DWORD, w.DWORD, w.HANDLE])
        self.file_info = typed(self.kernel, "GetFileInformationByHandle", w.BOOL, [w.HANDLE, pointer])
        self.windows_directory = typed(self.kernel, "GetWindowsDirectoryW", w.UINT, [w.LPWSTR, w.UINT])
        self.create_directory = typed(self.kernel, "CreateDirectoryW", w.BOOL, [w.LPCWSTR, pointer])
        self.process = typed(self.kernel, "GetCurrentProcess", w.HANDLE, [])
        self.open_token = typed(self.advapi, "OpenProcessToken", w.BOOL, [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)])
        self.token_info = typed(self.advapi, "GetTokenInformation", w.BOOL, [w.HANDLE, ctypes.c_int, pointer, w.DWORD, ctypes.POINTER(w.DWORD)])
        self.sid_string = typed(self.advapi, "ConvertSidToStringSidW", w.BOOL, [pointer, ctypes.POINTER(w.LPWSTR)])
        self.valid_sid = typed(self.advapi, "IsValidSid", w.BOOL, [pointer])
        self.sid_length = typed(self.advapi, "GetLengthSid", w.DWORD, [pointer])
        self.security = typed(self.advapi, "GetSecurityInfo", w.DWORD, [w.HANDLE, ctypes.c_int, w.DWORD, ctypes.POINTER(pointer), pointer, ctypes.POINTER(pointer), pointer, ctypes.POINTER(pointer)])
        self.get_ace = typed(self.advapi, "GetAce", w.BOOL, [pointer, w.DWORD, ctypes.POINTER(pointer)])
        self.sddl = typed(self.advapi, "ConvertStringSecurityDescriptorToSecurityDescriptorW", w.BOOL, [w.LPCWSTR, w.DWORD, ctypes.POINTER(pointer), pointer])
        self.parents, self.descriptor_parents = {}, {}
        self.current_sid = self._current_sid()

    def close(self, handle):
        self._close(handle)
        for parent in self.parents.pop(handle, []):
            self._close(parent)

    def _parent_handles(self, path):
        import ntpath
        handles, parent = [], ntpath.dirname(path)
        try:
            while parent:
                native = "\\\\?\\" + parent if len(parent) > 248 else parent
                handle = self.create_file(native, 0x80, 1, None, 3, 0x02200000, None)
                if handle == self.c.c_void_p(-1).value or handle is None:
                    raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
                handles.append(handle)
                info = self.c.create_string_buffer(52)
                if not self.file_info(handle, info):
                    raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
                attributes = self.c.c_uint32.from_buffer(info).value
                if attributes & 0x400 or not attributes & 0x10:
                    raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
                next_parent = ntpath.dirname(parent)
                if next_parent == parent:
                    break
                parent = next_parent
            return handles
        except Exception:
            for handle in handles:
                self._close(handle)
            raise

    def _sid(self, pointer):
        if not pointer or not self.valid_sid(pointer):
            raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
        result = self.w.LPWSTR()
        if not self.sid_string(pointer, self.c.byref(result)):
            raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
        try:
            return result.value
        finally:
            self.local_free(self.c.cast(result, self.c.c_void_p))

    def _current_sid(self):
        token, size = self.w.HANDLE(), self.w.DWORD()
        if not self.open_token(self.process(), 8, self.c.byref(token)):
            raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
        try:
            self.token_info(token, 1, None, 0, self.c.byref(size))
            if not 8 <= size.value <= 65536:
                raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
            buffer = self.c.create_string_buffer(size.value)
            if not self.token_info(token, 1, buffer, size, self.c.byref(size)):
                raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
            return self._sid(self.c.cast(buffer, self.c.POINTER(self.c.c_void_p)).contents.value)
        finally:
            self.close(token)

    def _check(self, handle, directory):
        c, w = self.c, self.w
        class FileInfo(c.Structure):
            _fields_ = [("attributes", w.DWORD), ("times", w.DWORD * 6), ("volume", w.DWORD),
                        ("size_high", w.DWORD), ("size_low", w.DWORD), ("links", w.DWORD),
                        ("index_high", w.DWORD), ("index_low", w.DWORD)]
        information = FileInfo()
        if (not self.file_info(handle, c.byref(information)) or information.attributes & 0x400
                or bool(information.attributes & 0x10) != directory or (not directory and information.links != 1)):
            raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
        owner, dacl, descriptor = c.c_void_p(), c.c_void_p(), c.c_void_p()
        if self.security(handle, 1, 5, c.byref(owner), None, c.byref(dacl), None, c.byref(descriptor)) != 0:
            raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
        try:
            if not dacl:
                raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
            count = c.c_ushort.from_address(dacl.value + 4).value
            if not 1 <= count <= 16:
                raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
            entries = []
            for index in range(count):
                ace = c.c_void_p()
                if not self.get_ace(dacl, index, c.byref(ace)) or not ace:
                    raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
                kind = c.c_ubyte.from_address(ace.value).value
                length = c.c_ushort.from_address(ace.value + 2).value
                if kind not in (0, 1) or length < 16 or not self.valid_sid(ace.value + 8) or self.sid_length(ace.value + 8) > length - 8:
                    raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
                entries.append((kind, self._sid(ace.value + 8)))
            validate_windows_security(self._sid(owner), self.current_sid, entries)
        finally:
            self.local_free(descriptor)

    def open(self, path, directory=False):
        c = self.c
        validate_windows_path(path)
        # No write/delete sharing: the checked object cannot be replaced while
        # this handle is converted to the descriptor used for byte verification.
        parents = self._parent_handles(path)
        native = "\\\\?\\" + path if len(path) > 248 else path
        handle = self.create_file(native, 0x80000000, 1, None, 3, 0x00200000 | (0x02000000 if directory else 0), None)
        if handle == c.c_void_p(-1).value or handle is None:
            for parent in parents:
                self._close(parent)
            raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
        self.parents[handle] = parents
        try:
            self._check(handle, directory)
            return handle
        except Exception:
            self.close(handle)
            raise

    def read_descriptor(self, path):
        import msvcrt
        handle = self.open(path)
        try:
            descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
            self.descriptor_parents[descriptor] = self.parents.pop(handle, [])
            return descriptor
        except Exception:
            self.close(handle)
            raise

    def release_descriptor_parents(self, descriptor):
        for parent in self.descriptor_parents.pop(descriptor, []):
            self._close(parent)

    def make_private_directory(self, path):
        c, w = self.c, self.w
        validate_windows_path(path)
        descriptor = c.c_void_p()
        text = "O:" + self.current_sid + "D:P(A;OICI;FA;;;" + self.current_sid + ")(A;OICI;FA;;;SY)"
        if not self.sddl(text, 1, c.byref(descriptor), None):
            raise BootstrapError("DOWNLOADER_ISOLATION_REQUIRED")
        class Attributes(c.Structure):
            _fields_ = [("length", w.DWORD), ("descriptor", c.c_void_p), ("inherit", w.BOOL)]
        attributes = Attributes(c.sizeof(Attributes), descriptor, False)
        try:
            native = "\\\\?\\" + path if len(path) > 248 else path
            if not self.create_directory(native, c.byref(attributes)):
                raise BootstrapError("DOWNLOADER_ISOLATION_REQUIRED")
        finally:
            self.local_free(descriptor)
        handle = self.open(path, directory=True)
        self.close(handle)

    def system_root(self):
        buffer = self.c.create_unicode_buffer(32768)
        length = self.windows_directory(buffer, len(buffer))
        if not 0 < length < len(buffer):
            raise BootstrapError("DOWNLOADER_ISOLATION_REQUIRED")
        return buffer.value


_WINDOWS_FILES = None

def windows_files():
    global _WINDOWS_FILES
    if _WINDOWS_FILES is None:
        _WINDOWS_FILES = WindowsFiles()
    return _WINDOWS_FILES


@contextmanager
def private_guest_directory(temporary_root):
    if sys.platform == "win32":
        import uuid
        import shutil
        home = os.path.join(temporary_root, "musicmute-guest-" + uuid.uuid4().hex)
        windows_files().make_private_directory(home)
        try:
            yield home
        finally:
            # Only the newly owned guest tree is cleaned, never its parent.
            shutil.rmtree(home)
    else:
        with tempfile.TemporaryDirectory(prefix="musicmute-guest-", dir=temporary_root) as home:
            yield home


def deno_path(runtime_root):
    return os.path.join(runtime_root, "bin", "deno.exe" if sys.platform == "win32" else "deno")


TRACK_ID = re.compile(r"[A-Za-z0-9_.-]{1,128}\Z")
SIGNATURE_KEY = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
MAX_TRACK_STREAMS = 4096
CLI_FLAGS = {
    "--ignore-config", "--no-plugin-dirs", "--no-playlist", "--no-warnings",
    "--no-cache-dir", "--no-remote-components", "--no-js-runtimes",
    "--no-cookies", "--no-cookies-from-browser",
    "--skip-download", "--dump-single-json", "--no-progress", "--quiet",
    "--version", "--help", "--list-extractors",
}
CLI_VALUES = {
    "--socket-timeout", "--retries", "--fragment-retries", "--extractor-retries",
    "--sleep-requests", "--sleep-interval", "--js-runtimes", "--ffmpeg-location",
    "--max-filesize", "--concurrent-fragments", "-f", "-o", "--print",
    "--load-info-json",
}


def validate_arguments(arguments):
    """No credential, config, alias, header or plugin override can reach yt-dlp."""
    if len(arguments) > 128 or any(
        not isinstance(value, str) or len(value) > 16 * 1024
        for value in arguments
    ):
        raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
    if not all(
        required in arguments for required in ("--ignore-config", "--no-plugin-dirs")
    ):
        raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
    index = 0
    while index < len(arguments):
        option = arguments[index]
        if option == "--":
            if len(arguments) != index + 2 or not re.fullmatch(
                r"https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}", arguments[index + 1]
            ):
                raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
            return
        if option in CLI_FLAGS:
            index += 1
            continue
        if option not in CLI_VALUES or index + 1 >= len(arguments):
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        value = arguments[index + 1]
        if not value or (
            value.startswith("-")
            and not (option == "--load-info-json" and value == "-")
        ):
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        # Metadata is projected by the native provider and passed through stdin;
        # the downloader must never load a user-supplied JSON/credential file.
        if option == "--load-info-json" and value != "-":
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        if option in {"--retries", "--fragment-retries", "--extractor-retries"} and value != "0":
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        if option == "--sleep-requests" and value != "1":
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        if option == "--sleep-interval" and value != "5":
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        if option == "--concurrent-fragments" and value != "1":
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        index += 2


@contextmanager
def isolated_downloader_environment():
    """A disposable guest HOME, with no inherited account/browser configuration."""
    previous = dict(os.environ)
    temporary_root = previous.get("TMPDIR")
    if not temporary_root or not os.path.isabs(temporary_root):
        raise BootstrapError("DOWNLOADER_ISOLATION_REQUIRED")
    if sys.platform == "win32":
        handle = windows_files().open(temporary_root, directory=True)
        windows_files().close(handle)
    else:
        information = os.lstat(temporary_root)
        if (not stat.S_ISDIR(information.st_mode) or information.st_uid != os.getuid()
                or information.st_mode & 0o077):
            raise BootstrapError("DOWNLOADER_ISOLATION_REQUIRED")
    with private_guest_directory(temporary_root) as home:
        environment = {
            name: previous[name]
            for name in ("PATH", "LANG", "LC_ALL", "MUSICMUTE_LOCAL_PARENT_PID", "DENO_DIR", "MUSICMUTE_UPDATE_LEASE_FD", "MUSICMUTE_LOCAL_ROOT", "MUSICMUTE_LOCAL_APP_RESOURCES")
            if name in previous
        }
        environment.update({
            "HOME": home,
            "TMPDIR": home,
            "XDG_CONFIG_HOME": os.path.join(home, "config"),
            "XDG_CACHE_HOME": os.path.join(home, "cache"),
            "XDG_DATA_HOME": os.path.join(home, "data"),
            "DENO_DIR": os.path.join(home, "deno"),
            "DENO_NO_PROMPT": "1",
            "DENO_NO_UPDATE_CHECK": "1",
            "TOKEN_TTL": "1",
        })
        if sys.platform == "win32":
            system_root = windows_files().system_root()
            environment.update({"SystemRoot": system_root, "WINDIR": system_root,
                                "TEMP": home, "TMP": home, "USERPROFILE": home,
                                "APPDATA": os.path.join(home, "config"),
                                "LOCALAPPDATA": os.path.join(home, "data")})
            for directory in (environment["XDG_CACHE_HOME"], environment["APPDATA"], environment["LOCALAPPDATA"]):
                windows_files().make_private_directory(directory)
        else:
            os.mkdir(environment["XDG_CACHE_HOME"], 0o700)
        os.environ.clear()
        os.environ.update(environment)
        try:
            yield
        finally:
            os.environ.clear()
            os.environ.update(previous)


def transfer_key(value, signature_key=None):
    """Ignore only the n/pot/signature changes made by this exact upstream pin."""
    if not isinstance(value, str) or not 0 < len(value) <= 16 * 1024:
        return None
    try:
        url = urlsplit(value)
        if (
            url.scheme != "https"
            or url.username or url.password or url.port or url.fragment
            or not url.hostname
            or not (url.hostname == "googlevideo.com" or url.hostname.endswith(".googlevideo.com"))
        ):
            return None
        ignored = {"n", "pot"}
        if signature_key:
            ignored.add(signature_key)
        query = tuple(sorted(
            (key, item) for key, item in parse_qsl(url.query, keep_blank_values=True)
            if key not in ignored
        ))
        return url.netloc, url.path, query
    except (TypeError, ValueError):
        return None


def enrich_audio_tracks(formats, player_responses):
    """Bind optional raw track scalars to emitted transfers; no requests or guesses."""
    if not isinstance(player_responses, list) or len(player_responses) > 64:
        return
    groups = {}
    streams = 0
    for response in player_responses:
        data = response.get("streamingData") if isinstance(response, dict) else None
        if not isinstance(data, dict):
            continue
        for name in ("formats", "adaptiveFormats"):
            raw_formats = data.get(name) or []
            if not isinstance(raw_formats, list):
                return
            streams += len(raw_formats)
            if streams > MAX_TRACK_STREAMS:
                return
            for raw in raw_formats:
                if not isinstance(raw, dict):
                    continue
                url = raw.get("url")
                signature_key = None
                if not url:
                    cipher = raw.get("signatureCipher")
                    if not isinstance(cipher, str) or len(cipher) > 32 * 1024:
                        continue
                    cipher_fields = {}
                    for key, item in parse_qsl(cipher, keep_blank_values=True):
                        cipher_fields.setdefault(key, []).append(item)
                    urls = cipher_fields.get("url", [])
                    if not urls:
                        continue
                    url = urls[0]
                    signature_key = (cipher_fields.get("sp") or ["signature"])[-1] or "signature"
                    if not SIGNATURE_KEY.fullmatch(signature_key):
                        continue
                    # A cipher only appends this key; an existing value is not safe to discard.
                    try:
                        existing_signature = any(key == signature_key for key, _ in parse_qsl(urlsplit(url).query))
                    except ValueError:
                        continue
                    if existing_signature:
                        continue
                key = transfer_key(url, signature_key)
                if key is None:
                    continue
                track = raw.get("audioTrack")
                track = track if isinstance(track, dict) else {}
                identifier = track.get("id")
                identifier = identifier if isinstance(identifier, str) and TRACK_ID.fullmatch(identifier) else None
                default = track.get("audioIsDefault")
                default = default if isinstance(default, bool) else None
                groups.setdefault(signature_key, {}).setdefault(key, set()).add((identifier, default))
    # Bound comparison work even if malformed responses specify many signature keys.
    if len(groups) > 32 or not isinstance(formats, list) or len(formats) > 2048:
        return
    for fmt in formats:
        if not isinstance(fmt, dict) or fmt.get("vcodec") != "none" or fmt.get("acodec") in (None, "none"):
            continue
        if fmt.get("protocol") not in (None, "https", "http_dash_segments"):
            continue
        matches = set()
        for signature_key, candidates in groups.items():
            key = transfer_key(fmt.get("url"), signature_key)
            if key is not None:
                matches.update(candidates.get(key, ()))
        identifiers = {identifier for identifier, _ in matches}
        if len(identifiers) != 1:
            continue
        identifier = identifiers.pop()
        if identifier is not None:
            fmt["musicmute_audio_track_id"] = identifier
        defaults = {default for _, default in matches}
        if len(defaults) == 1:
            default = defaults.pop()
            if default is not None:
                fmt["musicmute_audio_is_default"] = default


def install_audio_track_identity():
    """Small owned wrapper around the verified extractor, never a second extraction."""
    from yt_dlp.extractor.youtube import YoutubeIE

    if getattr(YoutubeIE, "_musicmute_track_identity_installed", False):
        return
    upstream = YoutubeIE._list_formats

    def list_formats(self, video_id, microformats, video_details, player_responses, player_url, duration=None):
        result = upstream(self, video_id, microformats, video_details, player_responses, player_url, duration)
        enrich_audio_tracks(result[2], player_responses)
        return result

    YoutubeIE._list_formats = list_formats
    YoutubeIE._musicmute_track_identity_installed = True


def protected_packaged_resource(path):
    """A protected app can be installed by a different local Mac account."""
    resources = os.environ.get("MUSICMUTE_LOCAL_APP_RESOURCES", "")
    absolute = os.path.abspath(path)
    if (
        not resources or not os.path.isabs(resources)
        or resources != os.path.realpath(resources)
        or absolute != os.path.realpath(absolute)
        or not absolute.startswith(resources.rstrip(os.sep) + os.sep)
    ):
        return False
    current = os.path.dirname(absolute)
    while True:
        information = os.lstat(current)
        if not stat.S_ISDIR(information.st_mode) or information.st_mode & 0o022:
            return False
        if current == resources:
            return True
        parent = os.path.dirname(current)
        if parent == current:
            return False
        current = parent


def safe_stat(path, *, directory=False):
    information = os.lstat(path)
    if sys.platform == "win32":
        handle = windows_files().open(path, directory=directory)
        windows_files().close(handle)
        return information
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if (
        not expected(information.st_mode)
        or (information.st_uid != os.getuid() and not protected_packaged_resource(path))
        or information.st_mode & 0o022
        or (not directory and information.st_nlink != 1)
    ):
        raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
    return information


@contextmanager
def verified_reader(descriptor):
    try:
        with os.fdopen(descriptor, "rb") as archive:
            yield archive
    finally:
        if sys.platform == "win32":
            windows_files().release_descriptor_parents(descriptor)


def verified_archives(check_contents=True, bundle_root=None):
    root = bundle_root or os.path.dirname(os.path.abspath(__file__))
    safe_stat(root, directory=True)
    safe_stat(os.path.abspath(__file__))
    archives = []
    for filename, expected_bytes, expected_sha in WHEELS:
        path = os.path.join(root, filename)
        before = safe_stat(path)
        if before.st_size != expected_bytes:
            raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
        if not check_contents:
            # Normal acquisition trusts the installed tools. Explicit EJS/setup
            # diagnostics retain the complete byte verification below.
            archives.append(path)
            continue
        descriptor = (windows_files().read_descriptor(path) if sys.platform == "win32"
                      else os.open(path, os.O_RDONLY | os.O_NOFOLLOW))
        with verified_reader(descriptor) as archive:
            opened = os.fstat(archive.fileno())
            if (
                (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
                or opened.st_nlink != 1
                or not stat.S_ISREG(opened.st_mode)
            ):
                raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
            digest = hashlib.sha256()
            for chunk in iter(lambda: archive.read(128 * 1024), b""):
                digest.update(chunk)
            after = os.fstat(archive.fileno())
            if (
                digest.hexdigest() != expected_sha
                or after.st_size != expected_bytes
                or (after.st_mtime_ns, after.st_ctime_ns)
                != (opened.st_mtime_ns, opened.st_ctime_ns)
            ):
                raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
        archives.append(path)
    return archives


def check_ejs():
    # Both packages are verified before import. Traversable reads work directly
    # from ZIP archives; Node later receives this JavaScript on stdin.
    import yt_dlp_ejs
    from yt_dlp.extractor.youtube.jsc._builtin import vendor
    from yt_dlp_ejs.yt import solver

    if yt_dlp_ejs.version != "0.8.0" or vendor.VERSION != "0.8.0":
        raise BootstrapError("YT_DLP_EJS_MISSING")
    for name, code in (
        ("yt.solver.core.min.js", solver.core()),
        ("yt.solver.lib.min.js", solver.lib()),
    ):
        expected = EJS_HASHES[name]
        if (
            vendor.HASHES.get(name) != expected
            or hashlib.sha3_512(code.encode("utf-8")).hexdigest() != expected
        ):
            raise BootstrapError("YT_DLP_EJS_MISSING")


def check_challenge_runtime(runtime_root):
    """Execute the pinned solver/parser graph with a synthetic offline challenge."""
    import json
    import subprocess
    from yt_dlp_ejs.yt import solver
    check_ejs()
    challenge = {
        "type": "preprocessed",
        "preprocessed_player": "_result.sig = input => input.split('').reverse().join(''); _result.n = input => input.slice(1);",
        "requests": [{"type": "sig", "challenges": ["musicmute"]}, {"type": "n", "challenges": ["abc"]}],
    }
    code = solver.lib() + "\nObject.assign(globalThis, lib);\n" + solver.core() + "\n"
    code += "const ast = meriyah.parse('let answer = 6 * 7;'); if (!astring.generate(ast).includes('answer')) throw new Error();\n"
    code += "const output = jsc(" + json.dumps(challenge) + ");\n"
    code += "if (output.type !== 'result' || output.responses[0].data.musicmute !== 'etumcisum' || output.responses[1].data.abc !== 'bc') throw new Error(); console.log('ready');\n"
    completed = subprocess.run([
        deno_path(runtime_root), "run", "--ext=js", "--no-code-cache",
        "--no-prompt", "--no-remote", "--no-lock", "--node-modules-dir=none", "--no-config", "--no-npm", "--cached-only", "-",
    ], input=code, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
    if completed.returncode or completed.stdout.strip() != "ready":
        raise BootstrapError("YT_DLP_EJS_MISSING")


def require_gvs_token():
    """Fail closed at the pinned extractor's GVS boundary, not its player API.

    mweb obtains its GVS token during format extraction, after the player
    response. Preserve that content binding and do not send a GVS token as a
    player token. Earlier YouTube refusals retain their original classification.
    """
    from yt_dlp.extractor.youtube import YoutubeIE
    from yt_dlp.extractor.youtube.pot.provider import PoTokenContext

    upstream = YoutubeIE.fetch_po_token

    def fetch(self, client='web', context=PoTokenContext.GVS, **kwargs):
        required = client == 'mweb' and context == PoTokenContext.GVS
        if required:
            kwargs['required'] = True
        token = upstream(self, client=client, context=context, **kwargs)
        if required and not token:
            raise BootstrapError("SOURCE_TOKEN_REQUIRED")
        return token

    YoutubeIE.fetch_po_token = fetch


def install_token_provider(runtime_root, check_contents=True, bundle_root=None):
    """Load only the verified pinned plugin, never search any plugin directory."""
    import types
    import zipfile
    import functools
    import dataclasses
    from yt_dlp.cookies import YoutubeDLCookieJar
    from yt_dlp.extractor.youtube.pot._registry import _pot_providers
    from yt_dlp.extractor.youtube.pot._director import validate_response
    from yt_dlp.extractor.youtube.pot.provider import PoTokenProviderError

    provider_root = os.path.join(runtime_root, "provider")
    for path in (runtime_root, provider_root, os.path.join(provider_root, "src")):
        safe_stat(path, directory=True)
    script_path = os.path.join(provider_root, "src", "generate_once.ts")
    safe_stat(script_path)
    # The owned wrapper source is pinned independently of its manifest.
    if check_contents:
        descriptor = (windows_files().read_descriptor(script_path) if sys.platform == "win32"
                      else os.open(script_path, os.O_RDONLY | os.O_NOFOLLOW))
        with verified_reader(descriptor) as script:
            if hashlib.sha256(script.read()).hexdigest() != PROVIDER_SCRIPT_SHA256:
                raise BootstrapError("PO_TOKEN_PROVIDER_INVALID")
    for name in ("yt_dlp_plugins", "yt_dlp_plugins.extractor"):
        module = types.ModuleType(name)
        module.__path__ = []
        sys.modules[name] = module
    archive_path = os.path.join(bundle_root or os.path.dirname(os.path.abspath(__file__)), WHEELS[0][0])
    descriptor = (windows_files().read_descriptor(archive_path) if sys.platform == "win32"
                  else os.open(archive_path, os.O_RDONLY | os.O_NOFOLLOW))
    with verified_reader(descriptor) as source, zipfile.ZipFile(source) as archive:
        for suffix in ("getpot_bgutil", "getpot_bgutil_script"):
            name = "yt_dlp_plugins.extractor." + suffix
            module = types.ModuleType(name)
            sys.modules[name] = module
            exec(compile(archive.read("yt_dlp_plugins/extractor/" + suffix + ".py"), name, "exec"), module.__dict__)
    module = sys.modules["yt_dlp_plugins.extractor.getpot_bgutil_script"]
    _pot_providers.value.pop(module.BgUtilScriptNodePTP.PROVIDER_KEY, None)
    provider = module.BgUtilScriptDenoPTP
    provider._server_home = functools.cached_property(lambda self: provider_root)
    provider._server_home.__set_name__(provider, "_server_home")
    provider._script_cache_dir = functools.cached_property(lambda self: os.environ["XDG_CACHE_HOME"])
    provider._script_cache_dir.__set_name__(provider, "_script_cache_dir")
    provider._jsrt_path_impl = lambda self: deno_path(runtime_root)
    def arguments(self):
        def escaped(value):
            return value.replace(",", ",,")
        cache = os.environ["XDG_CACHE_HOME"]
        return (
            "run", "--cached-only", "--frozen", "--no-check", "--allow-env", "--allow-net",
            "--allow-ffi=" + escaped(os.path.join(provider_root, "node_modules")),
            "--allow-read=" + escaped(runtime_root) + "," + escaped(cache),
            "--allow-write=" + escaped(cache),
            "--config", os.path.join(provider_root, "deno.json"),
        )
    provider._jsrt_args = arguments
    # The pinned extractor creates anonymous PREF/SOCS cookies even with
    # --no-cookies. Reject account/imported jars, not its own guest context.
    # The reviewed script uses only content binding and Innertube context;
    # no cookies are forwarded to it.
    original_request = provider._real_request_pot
    def request(self, item):
        downloader = self.ie._downloader
        account_cookies = {"SID", "HSID", "SSID", "APISID", "SAPISID", "SIDCC", "LOGIN_INFO", "LSID", "OSID"}
        if (
            item.is_authenticated or item.data_sync_id
            or item.session_index not in (None, 0, "0")
            or item.request_proxy or item.request_source_address or not item.request_verify_tls
            or downloader.params.get("cookiefile") or downloader.params.get("cookiesfrombrowser")
            or item.request_cookiejar is not downloader.cookiejar
            or any(
                cookie.name.upper() in account_cookies
                or cookie.name.upper().startswith(("__SECURE-1P", "__SECURE-3P", "__HOST-1P", "__HOST-3P"))
                or cookie.domain.lstrip(".").lower() not in {"youtube.com", "www.youtube.com", "m.youtube.com"}
                for cookie in item.request_cookiejar
            )
            or any(name.lower() in {"cookie", "authorization", "x-goog-pageid"} for name in item.request_headers)
            or item.request_headers.get("X-Goog-AuthUser", "0") != "0"
        ):
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        try:
            response = original_request(self, dataclasses.replace(item, request_cookiejar=YoutubeDLCookieJar()))
            if not validate_response(response):
                raise ValueError("invalid response")
            return response
        except Exception:
            # Upstream errors can include script output or token values. Only a
            # fixed code may reach its director/logger; no raw provider text.
            raise PoTokenProviderError("SOURCE_TOKEN_REQUIRED", expected=True) from None
    provider._real_request_pot = request
    require_gvs_token()


PROVIDER_SCRIPT_SHA256 = "718ba412feecbc67d423c30048fb9a5066c195a610773208abfe1912f6f10b7c"

def install_process_lease():
    if "MUSICMUTE_UPDATE_LEASE_FD" not in os.environ:
        return
    if sys.platform == "win32":
        # Windows uses owned Job Objects/broker leases, never POSIX pass_fds.
        raise BootstrapError("LOCAL_UPDATE_LEASE_INVALID")
    import importlib.util
    resources = os.environ.get("MUSICMUTE_LOCAL_APP_RESOURCES")
    if not resources or not os.path.isabs(resources):
        raise BootstrapError("LOCAL_UPDATE_LEASE_INVALID")
    spec = importlib.util.spec_from_file_location("musicmute_process_lease", os.path.join(resources, "engine", "process_lease.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.propagate_update_lease()


def main():
    install_process_lease()
    arguments = sys.argv[1:]
    bundle_root = None
    if arguments[:1] == ["--musicmute-downloader-root"]:
        if len(arguments) < 3 or not os.path.isabs(arguments[1]):
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        bundle_root = arguments[1]
        arguments = arguments[2:]
    runtime_root = None
    if arguments[:1] == ["--musicmute-youtube-runtime"]:
        if len(arguments) < 3 or not os.path.isabs(arguments[1]):
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        runtime_root = arguments[1]
        arguments = arguments[2:]
    checking = arguments == ["--musicmute-check-ejs"]
    if "--musicmute-check-ejs" in arguments and not checking:
        raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
    if not checking:
        validate_arguments(arguments)
    sys.path[:0] = verified_archives(check_contents=checking, bundle_root=bundle_root)
    with isolated_downloader_environment():
        if checking:
            check_ejs()
            if runtime_root:
                check_challenge_runtime(runtime_root)
            sys.stdout.write("ready\n")
            return 0
        import yt_dlp

        install_audio_track_identity()
        if runtime_root:
            install_token_provider(runtime_root, check_contents=False, bundle_root=bundle_root)
        yt_dlp.main([
            *(["--extractor-args", "youtube:player_client=mweb"] if runtime_root else []),
            "--no-cookies", "--no-cookies-from-browser",
            "--retries", "0", "--fragment-retries", "0", "--extractor-retries", "0",
            "--sleep-requests", "1", "--sleep-interval", "5",
            *arguments,
        ])
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BootstrapError as error:
        sys.stderr.write(str(error) + "\n")
        raise SystemExit(1)
    except Exception:
        sys.stderr.write("DOWNLOADER_IDENTITY_INVALID\n")
        raise SystemExit(1)
