"""Receiving/reading policy fixtures; no OS Store or launch authority proof."""
from __future__ import annotations

import copy
import hashlib
import json
import ctypes
import ntpath
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock

from musicmute_engine.store_code_reader import (
    CACHE_ROOT, DOWNLOADER_ROOT, ENTRY_PATH, LEGACY_BOOTSTRAP_SHA256, READER_PATH,
    StoreCodeReader, StoreReadError, current_package_path, package_identity,
    parse_inventory, relative_path, same_file, validate_code_acl,
    BENCHMARK_FILE_ENTRY_PATH, BENCHMARK_FILE_CORE_PATH,
    BENCHMARK_CAPACITY_ENTRY_PATH, BENCHMARK_CAPACITY_CORE_PATH,
    BENCHMARK_CONTEXT_PATH,
)

ROOT = Path(__file__).resolve().parents[3]
ENTRY = ROOT / "chrome-extension/engine/store_downloader_bootstrap.py"
LEGACY = ROOT / "chrome-extension/engine/downloader_bootstrap.py"


def inventory():
    paths = [READER_PATH, ENTRY_PATH, DOWNLOADER_ROOT + "/downloader_bootstrap.py",
        "worker/tools/youtube/bin/deno.exe", "worker/tools/youtube/provider/src/generate_once.ts",
        "worker/tools/youtube/provider/deno.json", "worker/tools/youtube/provider/deno.lock",
        CACHE_ROOT + "/gen/source.js", "worker/runtime/bin/ffmpeg.exe"]
    return {"version": 1, "role": "worker", "packageVersion": "0.1.3.0", "protocolAbi": 1,
        "appVersion": "0.1.3", "buildNumber": 1, "entries": [
            {"path": key, "bytes": 1, "sha256": LEGACY_BOOTSTRAP_SHA256
                if key.endswith("/downloader_bootstrap.py") else "a" * 64}
            for key in sorted(paths)]}


class StoreCodeReaderTests(unittest.TestCase):
    def encoded(self, value):
        return json.dumps(value).encode()

    def test_current_os_root_is_the_first_immutable_held_directory_without_opening_os_ancestors(self):
        reader = object.__new__(StoreCodeReader)
        reader.root = r"C:\Program Files\WindowsApps\MusicMute.WorkerDevelopment_0.1.3.0_x64__kthggmwhkdz4t"
        reader.parents = {}
        reader._revalidate_package = Mock()
        reader._open = Mock(side_effect=range(100, 106))
        reader.close_handle = Mock()
        handle = reader._open_held_path(READER_PATH, False)
        expected = [(reader.root, True)]
        cursor = reader.root
        for part in READER_PATH.split("/")[:-1]:
            cursor = ntpath.join(cursor, part)
            expected.append((cursor, True))
        expected.append((reader.path(READER_PATH), False))
        self.assertEqual([call.args for call in reader._open.call_args_list], expected)
        self.assertEqual(handle, 105)
        self.assertEqual(reader.parents[handle], [100, 101, 102, 103, 104])
        reader._revalidate_package.assert_called_once_with()
        reader.close(handle)
        self.assertEqual([call.args[0] for call in reader.close_handle.call_args_list], [105, 100, 101, 102, 103, 104])
        self.assertEqual(reader.parents, {})

    def test_root_or_descendant_failure_never_uses_an_ancestor_or_weaker_access_fallback(self):
        for failing_index in (0, 1, 4, 5):
            reader = object.__new__(StoreCodeReader)
            reader.root = r"C:\Program Files\WindowsApps\fixed"
            reader.parents = {}
            reader._revalidate_package = Mock()
            reader._open = Mock(side_effect=[*range(100, 100 + failing_index), StoreReadError()])
            reader.close_handle = Mock()
            with self.subTest(failing_index=failing_index), self.assertRaises(StoreReadError):
                reader._open_held_path(READER_PATH, False)
            self.assertEqual(reader._open.call_count, failing_index + 1)
            self.assertEqual(reader._open.call_args_list[0].args, (reader.root, True))
            self.assertTrue(all(len(call.args) == 2 and call.args[0].startswith(reader.root)
                for call in reader._open.call_args_list))
            self.assertEqual([call.args[0] for call in reader.close_handle.call_args_list],
                list(range(100, 100 + failing_index)))
            self.assertEqual(reader.parents, {})

    def test_root_open_keeps_attribute_control_rights_and_rejects_reparse_canonical_or_acl_failure(self):
        root = r"C:\Program Files\WindowsApps\fixed"
        for failure in (None, "reparse", "canonical", "acl"):
            reader = object.__new__(StoreCodeReader)
            reader.create = Mock(return_value=100)
            reader.close_handle = Mock()
            reader._acl = Mock(side_effect=StoreReadError() if failure == "acl" else None)
            def information(_handle, output):
                fields = [0] * 13
                fields[0], fields[10], fields[12] = 0x10 | (0x400 if failure == "reparse" else 0), 1, 100
                raw = b"".join(field.to_bytes(4, "little") for field in fields)
                ctypes.memmove(output, raw, len(raw))
                return True
            reader.info = information
            def canonical(_handle, output, _capacity, _flags):
                output.value = "\\\\?\\" + (root + "-foreign" if failure == "canonical" else root)
                return len(output.value)
            reader.canonical = canonical
            if failure:
                with self.subTest(failure=failure), self.assertRaises(StoreReadError):
                    reader._open(root, True)
                reader.close_handle.assert_called_once_with(100)
            else:
                self.assertEqual(reader._open(root, True), 100)
                reader._acl.assert_called_once_with(100, True)
                reader.close_handle.assert_not_called()
            self.assertEqual(reader.create.call_args.args,
                (root, 0x20080, 3, None, 3, 0x02200000, None))

    def test_exact_store_revision_identity_without_foreign_semantic_or_architecture(self):
        prefix = "27120VCHATSDK.MusicMuteWorker_0.1.3."
        for revision in ("0", "1", "65535"):
            name = prefix + revision + "_x64__5q1esjnkz8cve"
            self.assertEqual(package_identity(name), name)
        for name in (prefix + "65536_x64__5q1esjnkz8cve",
                prefix + "01_x64__5q1esjnkz8cve", prefix + "0_arm64__5q1esjnkz8cve",
                prefix + "0_x64_resource_5q1esjnkz8cve", prefix + "0_x64__foreign",
                "27120VCHATSDK.MusicMuteWorker_0.1.4.0_x64__5q1esjnkz8cve", None):
            with self.assertRaises(StoreReadError):
                package_identity(name)

    def test_windows_relative_aliases_are_not_code_paths(self):
        self.assertEqual(relative_path("worker/tools/youtube/provider/node_modules/cairo+.dll"),
            "worker/tools/youtube/provider/node_modules/cairo+.dll")
        for value in ("../worker", "/worker", "worker//code", "worker/code:stream",
                "worker\\code", "worker/CON.exe", "worker/trailing.", "worker/file ",
                "worker/\x00code", "worker/ümlaut", 42):
            with self.assertRaises(StoreReadError):
                relative_path(value)

    def test_protected_inventory_is_bounded_strict_and_immutable(self):
        value = inventory()
        parsed = parse_inventory(self.encoded(value))
        self.assertEqual(parsed[DOWNLOADER_ROOT + "/downloader_bootstrap.py"][1], LEGACY_BOOTSTRAP_SHA256)
        with self.assertRaises(TypeError):
            parsed["worker/foreign"] = (1, "a" * 64)
        for data in (b"", b"\xff", b" " * (8 * 1024 * 1024 + 1),
                self.encoded(value).replace(b'"role":', b'"role":"gui","role":', 1),
                self.encoded(value).replace(b'"buildNumber": 1', b'"buildNumber":1e1000')):
            with self.assertRaises(StoreReadError):
                parse_inventory(data)

    def test_missing_modified_foreign_or_duplicate_inventory_never_admitted(self):
        value = inventory()
        for field, bad in (("role", "gui"), ("version", True), ("packageVersion", "0.1.3.1"),
                ("protocolAbi", 2), ("appVersion", "0.1.4"), ("buildNumber", 0),
                ("buildNumber", True), ("buildNumber", 2147483648)):
            changed = {**value, field: bad}
            with self.assertRaises(StoreReadError):
                parse_inventory(self.encoded(changed))
        for key in (READER_PATH, ENTRY_PATH, CACHE_ROOT + "/gen/source.js"):
            changed = copy.deepcopy(value)
            changed["entries"] = [row for row in changed["entries"] if row["path"] != key]
            with self.assertRaises(StoreReadError):
                parse_inventory(self.encoded(changed))
        mutations = []
        changed = copy.deepcopy(value); changed["entries"].reverse(); mutations.append(changed)
        changed = copy.deepcopy(value); changed["entries"].append(changed["entries"][-1]); mutations.append(changed)
        changed = copy.deepcopy(value); changed["entries"][0]["extra"] = True; mutations.append(changed)
        changed = copy.deepcopy(value); changed["entries"][0]["path"] = "gui/foreign"; mutations.append(changed)
        changed = copy.deepcopy(value); changed["extra"] = True; mutations.append(changed)
        changed = copy.deepcopy(value)
        next(row for row in changed["entries"] if row["path"].endswith("/downloader_bootstrap.py"))["sha256"] = "b" * 64
        mutations.append(changed)
        for changed in mutations:
            with self.assertRaises(StoreReadError):
                parse_inventory(self.encoded(changed))

    def test_empty_bookkeeping_keeps_exact_digest_but_empty_native_code_is_denied(self):
        value = inventory()
        row = {"path": CACHE_ROOT + "/.lock", "bytes": 0,
            "sha256": hashlib.sha256(b"").hexdigest()}
        value["entries"].append(row); value["entries"].sort(key=lambda item: item["path"])
        self.assertEqual(parse_inventory(self.encoded(value))[row["path"]][0], 0)
        row["sha256"] = "0" * 64
        with self.assertRaises(StoreReadError):
            parse_inventory(self.encoded(value))
        row["sha256"] = hashlib.sha256(b"").hexdigest()
        for suffix in ("exe", "dll", "pyd", "node"):
            row["path"] = CACHE_ROOT + "/empty." + suffix
            value["entries"].sort(key=lambda item: item["path"])
            with self.assertRaises(StoreReadError):
                parse_inventory(self.encoded(value))

    def test_code_acl_requires_os_ownership_and_real_effective_no_write_access(self):
        trusted = "S-1-5-18"
        user = "S-1-5-21-111-222-333-1000"
        validate_code_acl(trusted, [(0, 0, 0x1f01ff, trusted), (0, 0, 0x120089, user)], 0x120089, False)
        validate_code_acl(trusted, [(1, 0, 0x1f01ff, user), (0, 8, 0x1f01ff, user)], 0x120089, True)
        for owner, entries, granted, directory in (
                (user, [(0, 0, 0x120089, user)], 0x120089, False),
                (trusted, [(0, 0, 2, user)], 0x120089, False),
                (trusted, [(5, 0, 2, trusted)], 0x120089, False),
                (trusted, [(0, 0, 0x120089, user)], 0x12008b, False),
                (trusted, [(0, 0, 0x40, user)], 0x120089, True),
                (trusted, [], 0x120089, False),
                (trusted, [(3, 0, 0, user)], 0x120089, False)):
            with self.assertRaises(StoreReadError):
                validate_code_acl(owner, entries, granted, directory)

    def test_held_observation_changes_size_identity_links_or_times_fail(self):
        before = (1, 2, 3, 32, 100, 5, 6, 7, 8, False)
        same_file(before, before)
        for index in range(9):
            changed = list(before); changed[index] += 1
            with self.assertRaises(StoreReadError):
                same_file(before, tuple(changed))
        with self.assertRaises(StoreReadError):
            same_file((1, 2, 0, 32, 100, 5, 6, 7, 8, False), (1, 2, 0, 32, 100, 5, 6, 7, 8, False))

    def test_reader_whitelist_cannot_admit_runtime_private_media_or_foreign_code(self):
        reader = object.__new__(StoreCodeReader)
        reader.inventory = parse_inventory(self.encoded(inventory()))
        reader.allowed(ENTRY_PATH)
        reader.allowed(CACHE_ROOT, True)
        for key, directory in (("worker/runtime/python/python.exe", False),
                ("worker/private/account.json", False), ("worker/app/engine/musicmute_engine/recipes.py", False),
                ("worker/tools/youtube/foreign.ts", False), ("worker/tools/youtube/empty", True)):
            with self.assertRaises(StoreReadError):
                reader.allowed(key, directory)
        if sys.platform != "win32":
            with self.assertRaises(StoreReadError):
                current_package_path()
            with self.assertRaises(StoreReadError):
                StoreCodeReader()

    def test_legacy_source_hash_remains_unchanged_and_entry_rejects_unisolated_launch(self):
        self.assertEqual(hashlib.sha256(LEGACY.read_bytes()).hexdigest(), LEGACY_BOOTSTRAP_SHA256)
        result = subprocess.run([sys.executable, "-B", str(ENTRY)], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b"DOWNLOADER_ISOLATION_REQUIRED\n")
        if sys.platform != "win32":
            result = subprocess.run([sys.executable, "-I", "-B", "-S", str(ENTRY)], capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, b"STORE_DOWNLOADER_CODE_INVALID\n")

    def test_benchmark_reader_admits_only_fixed_nonempty_inventory_leaves(self):
        paths = (BENCHMARK_FILE_ENTRY_PATH, BENCHMARK_FILE_CORE_PATH,
            BENCHMARK_CAPACITY_ENTRY_PATH, BENCHMARK_CAPACITY_CORE_PATH,
            BENCHMARK_CONTEXT_PATH)
        value = inventory()
        value["entries"].extend({"path": key, "bytes": 1, "sha256": "a" * 64} for key in paths)
        value["entries"].sort(key=lambda row: row["path"])
        reader = object.__new__(StoreCodeReader)
        reader.inventory = parse_inventory(self.encoded(value))
        for key in paths:
            reader.allowed(key)
            with self.assertRaises(StoreReadError):
                reader.allowed(key, True)
        for key in ("worker/app/engine", "worker/app/engine/musicmute_engine/foreign_benchmark.py",
                "worker/app/engine/musicmute_engine/recipes.py", "worker/private/benchmark.json"):
            with self.assertRaises(StoreReadError):
                reader.allowed(key)
        missing = object.__new__(StoreCodeReader)
        missing.inventory = parse_inventory(self.encoded(inventory()))
        for key in paths:
            with self.assertRaises(StoreReadError):
                missing.allowed(key)
        value["entries"] = [{**row, "bytes": 0, "sha256": hashlib.sha256(b"").hexdigest()}
            if row["path"] in paths else row for row in value["entries"]]
        reader.inventory = parse_inventory(self.encoded(value))
        for key in paths:
            with self.assertRaises(StoreReadError):
                reader.allowed(key)

    def test_bridge_routes_private_reads_and_creation_through_unchanged_private_adapter(self):
        code = r'''
import importlib.util, sys, types
spec=importlib.util.spec_from_file_location('store_entry_fixture',sys.argv[1])
entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)
calls=[]
class Reader:
    root=r'C:\WindowsApps\fixed';parents={11:[]};descriptor_states={12:(11,None)}
    def open(self,path,directory=False):calls.append(('code',path,directory));return 11
    def close(self,handle):calls.append(('code-close',handle))
    def read_descriptor(self,path):calls.append(('code-read',path));return 12
    def release_descriptor_parents(self,fd):calls.append(('code-release',fd))
class Private:
    def open(self,path,directory=False):calls.append(('private',path,directory));return 21
    def close(self,handle):calls.append(('private-close',handle))
    def read_descriptor(self,path):calls.append(('private-read',path));return 22
    def release_descriptor_parents(self,fd):calls.append(('private-release',fd))
    def make_private_directory(self,path):calls.append(('private-create',path))
bridge=entry.AcquisitionFiles(Reader(),Private())
assert bridge.open(r'C:\WindowsApps\fixed\worker\tools\downloader\code.whl')==11
assert bridge.open(r'C:\Users\User\private\input.bin')==21
assert bridge.read_descriptor(r'C:\Users\User\private\input.bin')==22
bridge.close(11);bridge.close(21);bridge.release_descriptor_parents(12);bridge.release_descriptor_parents(22)
bridge.make_private_directory(r'C:\Users\User\private\guest')
try:bridge.make_private_directory(r'C:\WindowsApps\fixed\worker\tools\youtube\cache');raise AssertionError()
except RuntimeError:pass
assert len(calls)==8 and calls[-1][0]=='private-create'
print('bridge-fixture-ready')
'''
        result = subprocess.run([sys.executable, "-I", "-B", "-S", "-c", code, str(ENTRY)], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"bridge-fixture-ready\n")

    def test_store_arguments_reject_code_and_runtime_overrides_before_data_launch(self):
        code = r'''
import importlib.util, sys
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
entry=load('store_entry_fixture',sys.argv[1]);legacy=load('legacy_fixture',sys.argv[2])
assert entry.validate_store_arguments(['--musicmute-check-ejs'],legacy)
base=['--ignore-config','--no-plugin-dirs','--retries','0','--skip-download']
assert not entry.validate_store_arguments(base,legacy)
for extra in [['--musicmute-downloader-root',r'C:\foreign'],['--musicmute-youtube-runtime',r'C:\foreign'],
              ['--js-runtimes','deno:'+r'C:\foreign.exe'],['--ffmpeg-location',r'C:\foreign'],
              ['--no-js-runtimes'],['--musicmute-check-ejs','extra'],['--load-info-json',r'C:\private\account.json']]:
    try:entry.validate_store_arguments(base+extra,legacy);raise AssertionError('override admitted')
    except legacy.BootstrapError:pass
print('argument-fixture-ready')
'''
        result = subprocess.run([sys.executable, "-I", "-B", "-S", "-c", code, str(ENTRY), str(LEGACY)],
            capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"argument-fixture-ready\n")

    def test_store_environment_keeps_fixed_protected_cache_and_restores_private_scope(self):
        code = r'''
import importlib.util, sys, os, types
from contextlib import contextmanager
sys.path.insert(0,sys.argv[2])
from musicmute_engine.store_code_reader import DOWNLOADER_ROOT,YOUTUBE_ROOT,CACHE_ROOT,ENTRY_PATH
spec=importlib.util.spec_from_file_location('store_entry_fixture',sys.argv[1])
entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)
calls=[]
class Reader:
    root=r'C:\WindowsApps\fixed'
    def path(self,key):return self.root+'\\'+key.replace('/','\\')
    def directory(self,key):
        assert key in (DOWNLOADER_ROOT,YOUTUBE_ROOT,CACHE_ROOT)
        calls.append(('directory',key));return self.path(key)
    def read(self,key,maximum):assert key==ENTRY_PATH;calls.append(('entry-read',key));return b'fixture'
class Private:pass
@contextmanager
def original():
    saved=dict(os.environ)
    os.environ.clear();os.environ.update({'HOME':r'C:\private\guest','XDG_CACHE_HOME':r'C:\private\guest\cache',
        'DENO_DIR':r'C:\private\guest\deno'})
    try:yield
    finally:os.environ.clear();os.environ.update(saved)
legacy=types.SimpleNamespace(WindowsFiles=lambda:Private(),isolated_downloader_environment=original,
    install_token_provider=lambda *a,**kw:None)
reader=Reader();before=dict(os.environ);entry.bind_store_bootstrap(reader,legacy)
with legacy.isolated_downloader_environment():
    assert os.environ['DENO_DIR']==reader.path(CACHE_ROOT)
    assert os.environ['XDG_CACHE_HOME']==r'C:\private\guest\cache'
    assert os.environ['DENO_NO_PROMPT']=='1' and os.environ['DENO_NO_UPDATE_CHECK']=='1'
    assert os.environ['DENO_DISABLE_NODE_SHIM']=='1'
assert dict(os.environ)==before and calls[-1]==('directory',CACHE_ROOT)
assert isinstance(legacy.windows_files().private,Private)
print('environment-fixture-ready')
'''
        result = subprocess.run([sys.executable, "-I", "-B", "-S", "-c", code, str(ENTRY), str(ROOT / "worker/engine")],
            capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"environment-fixture-ready\n")


if __name__ == "__main__":
    unittest.main()
