"""Store adapter around the unchanged retained personal processing engine.

The actual native Creator admits the fixed Python entry/Job and holds the private
configuration against replacement. This supplementary adapter never grants that
authority. It changes only the fixed downloader entry so acquisition reads the
Store-protected cache. Model, pipeline, recipes, IPC and bounded tool cleanup are
the original consumer_personal implementation.
"""
from __future__ import annotations

import hashlib
import json
import ntpath
import os
from pathlib import Path
import stat
import sys

PERSONAL_CORE_SHA256 = "cfb0c5cd1fbea4b2883577b16060b4a36448663ca83b4298df6e401f08eba66c"


class StorePersonalError(Exception):
    def __init__(self):
        super().__init__("STORE_PERSONAL_CONTEXT_INVALID")


def _require(value):
    if not value:
        raise StorePersonalError()


def _same_path(first, second):
    return isinstance(first, str) and isinstance(second, str) and ntpath.normcase(first) == ntpath.normcase(second)


def store_downloader_arguments(arguments, python, worker_root):
    """Receiving/path conversion only; its result cannot authorize a launch."""
    _require(type(arguments) is list and 9 <= len(arguments) <= 120
        and all(isinstance(value, str) and 0 < len(value) <= 4096 and "\0" not in value for value in arguments))
    bundle = ntpath.join(worker_root, "tools", "downloader")
    youtube = ntpath.join(worker_root, "tools", "youtube")
    _require(_same_path(python, ntpath.join(worker_root, "runtime", "python", "python.exe"))
        and _same_path(arguments[0], python) and arguments[1:4] == ["-I", "-B", "-S"]
        and _same_path(arguments[4], ntpath.join(bundle, "downloader_bootstrap.py"))
        and arguments[5] == "--musicmute-downloader-root" and _same_path(arguments[6], bundle)
        and arguments[7] == "--musicmute-youtube-runtime" and _same_path(arguments[8], youtube))
    values, counts, index = [], {}, 9
    expected = {
        "--js-runtimes": "deno:" + ntpath.join(youtube, "bin", "deno.exe"),
        "--ffmpeg-location": ntpath.join(worker_root, "runtime", "bin", "ffmpeg.exe"),
    }
    while index < len(arguments):
        value = arguments[index]
        if value == "--no-js-runtimes" or value in expected:
            counts[value] = counts.get(value, 0) + 1
            _require(counts[value] == 1)
            if value in expected:
                _require(index + 1 < len(arguments) and _same_path(arguments[index + 1], expected[value]))
                index += 1
        else:
            # Store bootstrap derives these internal paths itself. Data argv
            # cannot select another bundle, runtime or bootstrap mode.
            _require(not value.startswith("--musicmute-") or value == "--musicmute-check-ejs")
            values.append(value)
        index += 1
    _require(len(values) <= 100)
    if values != ["--musicmute-check-ejs"]:
        _require(set(counts) == {"--no-js-runtimes", "--js-runtimes", "--ffmpeg-location"})
    return [python, "-I", "-B", "-S", ntpath.join(bundle, "store_downloader_bootstrap.py"), *values]


def _pairs(items):
    result = {}
    for key, value in items:
        _require(key not in result)
        result[key] = value
    return result


def validate_store_configuration(arguments, worker_root, legacy):
    """Supplementary checks on the native-held private v2 configuration.

    Native owns its actual ACL/file/Creator/Job admission. These bounded data
    checks do not substitute for that retained native ownership.
    """
    _require(len(arguments) == 4 and arguments[0] == "--consumer-config"
        and arguments[2] == "--incarnation" and isinstance(arguments[3], str)
        and legacy.UUID_V4.fullmatch(arguments[3]))
    path = Path(arguments[1])
    _require(path.is_absolute() and path.name == "engine-config.json")
    before = path.lstat()
    _require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= 16384
        and not getattr(before, "st_file_attributes", 0) & 0x400)
    data = path.read_bytes()
    after = path.lstat()
    _require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
        == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        and len(data) == before.st_size and not data.startswith(b"\xef\xbb\xbf"))
    value = json.loads(data.decode("utf-8", "strict"), object_pairs_hook=_pairs,
        parse_constant=lambda _: (_ for _ in ()).throw(StorePersonalError()))
    _require(type(value) is dict and set(value) == legacy.SESSION_CONFIG_KEYS
        and type(value["version"]) is int and value["version"] == 2
        and _same_path(value["releaseRoot"], worker_root)
        and value["sid"] == legacy.service_identity()
        and value["sessionId"] == path.parent.name
        and _same_path(value["sessionRoot"], str(path.parent)))
    # The unchanged engine additionally validates canonical session/jobs/model
    # roots, GPU identity and the same production model before announcing ready.


def main():
    if not (sys.platform == "win32" and sys.flags.isolated and sys.flags.ignore_environment and sys.flags.no_user_site):
        return 2
    from .store_code_reader import StoreCodeReader, PERSONAL_CORE_PATH, PERSONAL_ENTRY_PATH, ENTRY_PATH
    reader = StoreCodeReader()
    worker_root = ntpath.join(reader.root, "worker")
    _require(_same_path(os.path.abspath(__file__), reader.path(PERSONAL_ENTRY_PATH))
        and _same_path(sys.executable, ntpath.join(worker_root, "runtime", "python", "python.exe")))
    reader.read(PERSONAL_ENTRY_PATH, 1024 * 1024)
    _require(hashlib.sha256(reader.read(PERSONAL_CORE_PATH, 1024 * 1024)).hexdigest() == PERSONAL_CORE_SHA256)
    sys.dont_write_bytecode = True
    from . import consumer_personal as legacy
    validate_store_configuration(sys.argv[1:], worker_root, legacy)
    original = legacy.bounded_tool

    def store_tool(arguments, cwd, output, maximum, timeout):
        try:
            reader.read(ENTRY_PATH, 1024 * 1024)
            converted = store_downloader_arguments(arguments, sys.executable, worker_root)
        except Exception:
            raise legacy.ProcessingFailure("INVALID_REQUEST", "Store downloader context is invalid") from None
        return original(converted, cwd, output, maximum, timeout)

    legacy.bounded_tool = store_tool
    try:
        return legacy.main()
    finally:
        # Own only this fixed module binding; preserve every original cleanup
        # failure rather than replacing the bounded tool or engine protocol.
        if legacy.bounded_tool is store_tool:
            legacy.bounded_tool = original


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        sys.stderr.write("STORE_PERSONAL_CONTEXT_INVALID\n")
        raise SystemExit(2)
