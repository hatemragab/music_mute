"""Fixed source projections only; no Windows origin, GPU or install proof."""
import ctypes
from ctypes import wintypes as w
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from musicmute_engine import store_code_reader, store_qualification, store_benchmark_context

SOURCE = Path(store_code_reader.__file__).read_text()
MARKER = 'PACKAGE_BUILD_PROFILE = "store-v1"\n'
PROFILES = {
    "store-v1": ("27120VCHATSDK.MusicMuteWorker", "5q1esjnkz8cve", "MusicMuteLocal"),
    "local-test-v1": ("MusicMute.WorkerDevelopment", "kthggmwhkdz4t", "MusicMuteLocalDevelopment"),
}


def compiled_reader(profile):
    module = ModuleType("musicmute_engine.store_code_reader")
    module.__file__ = store_code_reader.__file__
    projected = SOURCE.replace(MARKER, "PACKAGE_BUILD_PROFILE = " + repr(profile) + "\n")
    exec(compile(projected, "fixed-source-profile.py", "exec"), module.__dict__)
    return module


class StorePackageProfileTests(unittest.TestCase):
    def test_source_default_is_exactly_one_store_literal(self):
        self.assertEqual(SOURCE.count(MARKER), 1)
        self.assertEqual(store_code_reader.PACKAGE_BUILD_PROFILE, "store-v1")

    def test_both_fixed_profiles_mutually_reject_foreign_identity_semantic_and_architecture(self):
        for profile, (worker, publisher, personal) in PROFILES.items():
            reader = compiled_reader(profile)
            self.assertEqual((reader.WORKER_NAME, reader.PUBLISHER_ID, reader.PERSONAL_ROOT_NAME),
                (worker, publisher, personal))
            for revision in ("0", "1", "65535"):
                identity = worker + "_0.1.3." + revision + "_x64__" + publisher
                self.assertEqual(reader.package_identity(identity), identity)
            foreign = [other_worker + "_0.1.3.0_x64__" + other_publisher
                for other, (other_worker, other_publisher, _) in PROFILES.items() if other != profile]
            for identity in [*foreign, worker + "_0.1.3.0_arm64__" + publisher,
                    worker + "_0.1.4.0_x64__" + publisher, worker + "_0.1.3.0_x64__foreign",
                    worker + "_0.1.3.65536_x64__" + publisher, None]:
                with self.subTest(profile=profile, identity=identity), self.assertRaises(reader.StoreReadError):
                    reader.package_identity(identity)

    def test_unknown_fixed_literals_fail_closed_and_environment_cannot_select_profile(self):
        for invalid in ("development", "", None, False, 1):
            with self.assertRaisesRegex(Exception, "^STORE_DOWNLOADER_CODE_INVALID$"):
                compiled_reader(invalid)
        with patch.dict("os.environ", {"PACKAGE_BUILD_PROFILE": "local-test-v1",
                "MUSICMUTE_PACKAGE_AUTHORITY_PROFILE": "local-test-v1"}):
            self.assertEqual(compiled_reader("store-v1").WORKER_NAME, PROFILES["store-v1"][0])

    def test_qualification_and_benchmark_known_folder_use_the_same_verified_reader_root(self):
        folder = ctypes.create_unicode_buffer(r"C:\Users\qa\AppData\Local")
        def resolve(_identifier, _flags, _token, output):
            ctypes.cast(output, ctypes.POINTER(w.LPWSTR))[0] = ctypes.cast(folder, w.LPWSTR)
            return 0
        shell = SimpleNamespace(SHGetKnownFolderPath=Mock(side_effect=resolve))
        ole = SimpleNamespace(CoTaskMemFree=Mock())
        for profile, (_, _, leaf) in PROFILES.items():
            for adapter in (store_qualification, store_benchmark_context):
                with patch.dict(sys.modules, {"musicmute_engine.store_code_reader": compiled_reader(profile)}), \
                        patch.object(ctypes, "WinDLL", create=True, side_effect=(shell, ole)):
                    self.assertEqual(adapter._private_root(), folder.value + "\\" + leaf)
        self.assertEqual(ole.CoTaskMemFree.call_count, 4)


if __name__ == "__main__":
    unittest.main()
