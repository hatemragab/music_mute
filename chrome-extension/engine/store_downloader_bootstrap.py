"""Store-only fixed downloader entry; native retained code/Job grants the launch.

The ordinary bootstrap and all extractor/model/recipe bytes stay unchanged.
Neither environment variables nor argv can approve a package or a code root.
"""
import sys

if not (sys.flags.isolated and sys.flags.ignore_environment and sys.flags.no_user_site
        and sys.flags.no_site and sys.dont_write_bytecode):
    sys.stderr.write("DOWNLOADER_ISOLATION_REQUIRED\n")
    raise SystemExit(1)

import ctypes
from contextlib import contextmanager
import hashlib
import ntpath
import os
import types


def _fixed_package_path():
    """Derive only the import prefix; the reader checks identity/held code."""
    if sys.platform != "win32" or ctypes.sizeof(ctypes.c_void_p) != 8:
        raise RuntimeError("STORE_DOWNLOADER_CODE_INVALID")
    from ctypes import wintypes as w
    kernel = ctypes.WinDLL("kernel32.dll", winmode=0x00000800, use_last_error=True)
    query = kernel.GetCurrentPackagePath
    query.argtypes, query.restype = [ctypes.POINTER(w.DWORD), w.LPWSTR], w.LONG
    length = w.DWORD()
    if query(ctypes.byref(length), None) != 122 or not 1 < length.value <= 32768:
        raise RuntimeError("STORE_DOWNLOADER_CODE_INVALID")
    buffer = ctypes.create_unicode_buffer(length.value)
    if query(ctypes.byref(length), buffer) or length.value != len(buffer.value) + 1:
        raise RuntimeError("STORE_DOWNLOADER_CODE_INVALID")
    root = buffer.value
    expected = ntpath.join(root, "worker", "tools", "downloader", "store_downloader_bootstrap.py")
    if ntpath.normcase(os.path.abspath(__file__)) != ntpath.normcase(expected):
        raise RuntimeError("STORE_DOWNLOADER_CODE_INVALID")
    return root


class AcquisitionFiles:
    """Code reads use the Store reader; every private operation keeps its policy."""
    def __init__(self, reader, private):
        self.reader, self.private = reader, private

    def _code(self, path):
        return isinstance(path, str) and ntpath.normcase(path).startswith(
            ntpath.normcase(self.reader.root + "\\"))

    def open(self, path, directory=False):
        if self._code(path):
            return self.reader.open(path, directory)
        return self.private.open(path, directory)

    def close(self, handle):
        if handle in self.reader.parents:
            return self.reader.close(handle)
        return self.private.close(handle)

    def read_descriptor(self, path):
        if self._code(path):
            return self.reader.read_descriptor(path)
        return self.private.read_descriptor(path)

    def release_descriptor_parents(self, descriptor):
        if descriptor in self.reader.descriptor_states:
            return self.reader.release_descriptor_parents(descriptor)
        return self.private.release_descriptor_parents(descriptor)

    def make_private_directory(self, path):
        if self._code(path):
            raise RuntimeError("STORE_DOWNLOADER_CODE_INVALID")
        return self.private.make_private_directory(path)

    def system_root(self):
        return self.private.system_root()


def validate_store_arguments(arguments, legacy):
    checking = arguments == ["--musicmute-check-ejs"]
    if not checking:
        legacy.validate_arguments(arguments)
        if any(option in arguments for option in (
                "--js-runtimes", "--ffmpeg-location", "--no-js-runtimes")):
            raise legacy.BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
    return checking


def bind_store_bootstrap(reader, legacy):
    """Configure the sealed legacy module, never replace its private ACL class."""
    from musicmute_engine.store_code_reader import (
        DOWNLOADER_ROOT, YOUTUBE_ROOT, CACHE_ROOT, LEGACY_BOOTSTRAP_SHA256,
        ENTRY_PATH,
    )
    bundle = reader.directory(DOWNLOADER_ROOT)
    youtube = reader.directory(YOUTUBE_ROOT)
    deno_cache = reader.directory(CACHE_ROOT)
    reader.read(ENTRY_PATH, 1024 * 1024)
    private = legacy.WindowsFiles()
    bridge = AcquisitionFiles(reader, private)
    legacy.windows_files = lambda: bridge
    original_environment = legacy.isolated_downloader_environment

    @contextmanager
    def environment():
        with original_environment():
            # No module/cache code is copied to a writable guest directory.
            reader.directory(CACHE_ROOT)
            os.environ["DENO_DIR"] = deno_cache
            os.environ["DENO_NO_PROMPT"] = "1"
            os.environ["DENO_NO_UPDATE_CHECK"] = "1"
            # Deno 2.9.7's optional child-PATH compatibility shim creates an
            # executable hardlink/copy in DENO_DIR. Native code roles and the
            # provider use protected binaries directly; never generate one.
            os.environ["DENO_DISABLE_NODE_SHIM"] = "1"
            yield
    legacy.isolated_downloader_environment = environment

    def archives(check_contents=True, bundle_root=None):
        if bundle_root != bundle:
            raise legacy.BootstrapError("DOWNLOADER_IDENTITY_INVALID")
        data = reader.read(DOWNLOADER_ROOT + "/downloader_bootstrap.py", 1024 * 1024)
        if hashlib.sha256(data).hexdigest() != LEGACY_BOOTSTRAP_SHA256:
            raise legacy.BootstrapError("DOWNLOADER_IDENTITY_INVALID")
        result = []
        for name, size, digest in legacy.WHEELS:
            key = DOWNLOADER_ROOT + "/" + name
            data = reader.read(key, size)
            if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
                raise legacy.BootstrapError("DOWNLOADER_IDENTITY_INVALID")
            result.append(reader.path(key))
        return result
    legacy.verified_archives = archives
    original_provider = legacy.install_token_provider

    def provider(runtime_root, check_contents=True, bundle_root=None):
        if runtime_root != youtube or bundle_root != bundle:
            raise legacy.BootstrapError("PO_TOKEN_PROVIDER_INVALID")
        original_provider(runtime_root, check_contents=True, bundle_root=bundle_root)
        cls = sys.modules["yt_dlp_plugins.extractor.getpot_bgutil_script"].BgUtilScriptDenoPTP
        arguments = cls._jsrt_args
        def fixed_arguments(self):
            values = arguments(self)
            if values[:4] != ("run", "--cached-only", "--frozen", "--no-check"):
                raise legacy.BootstrapError("PO_TOKEN_PROVIDER_INVALID")
            # Compile cache is a performance optimization, never writable code
            # authority. All imports still come from the protected manual tree.
            return (*values[:4], "--no-code-cache", "--node-modules-dir=manual",
                "--node-modules-linker=hoisted", *values[4:])
        cls._jsrt_args = fixed_arguments
    legacy.install_token_provider = provider
    return bundle, youtube


def main():
    root = _fixed_package_path()
    engine = ntpath.join(root, "worker", "app", "engine")
    # Native retains the entire protected import graph. This prefix is derived
    # from current OS package identity and the fixed entry, never caller/env data.
    sys.path.insert(0, engine)
    from musicmute_engine.store_code_reader import (
        StoreCodeReader, DOWNLOADER_ROOT, ENTRY_PATH, LEGACY_BOOTSTRAP_SHA256,
    )
    reader = StoreCodeReader()
    reader.read(ENTRY_PATH, 1024 * 1024)
    legacy_path = reader.path(DOWNLOADER_ROOT + "/downloader_bootstrap.py")
    source = reader.read(DOWNLOADER_ROOT + "/downloader_bootstrap.py", 1024 * 1024)
    if hashlib.sha256(source).hexdigest() != LEGACY_BOOTSTRAP_SHA256:
        raise RuntimeError("STORE_DOWNLOADER_CODE_INVALID")
    legacy = types.ModuleType("musicmute_store_downloader_legacy")
    legacy.__file__ = legacy_path
    exec(compile(source, legacy_path, "exec"), legacy.__dict__)
    arguments = sys.argv[1:]
    checking = validate_store_arguments(arguments, legacy)
    bundle, youtube = bind_store_bootstrap(reader, legacy)
    if not checking:
        # Native retains these fixed executable roles. Caller data arguments
        # cannot replace the JavaScript runtime or FFmpeg code location.
        arguments = ["--no-js-runtimes", "--js-runtimes",
            "deno:" + reader.path("worker/tools/youtube/bin/deno.exe"),
            "--ffmpeg-location", reader.path("worker/runtime/bin/ffmpeg.exe"),
            *arguments]
    # These roots are internal adapter values, not accepted command arguments.
    sys.argv = [legacy_path, "--musicmute-downloader-root", bundle,
        "--musicmute-youtube-runtime", youtube, *arguments]
    try:
        return legacy.main()
    except legacy.BootstrapError as error:
        # Preserve reviewed source/error classification without raw provider,
        # token, path or exception text crossing this launcher boundary.
        code = str(error)
        if code not in {"DOWNLOADER_ARGUMENTS_INVALID", "DOWNLOADER_IDENTITY_INVALID",
                "DOWNLOADER_ISOLATION_REQUIRED", "LOCAL_UPDATE_LEASE_INVALID",
                "PO_TOKEN_PROVIDER_INVALID", "SOURCE_TOKEN_REQUIRED", "YT_DLP_EJS_MISSING"}:
            raise RuntimeError("STORE_DOWNLOADER_CODE_INVALID") from None
        sys.stderr.write(code + "\n")
        return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        sys.stderr.write("STORE_DOWNLOADER_CODE_INVALID\n")
        raise SystemExit(1)
