"""Pure Store adapter fixtures. No package, model, GPU or network authority."""
import hashlib
from pathlib import Path
import unittest

from musicmute_engine.store_consumer_personal import (
    PERSONAL_CORE_SHA256, StorePersonalError, main, store_downloader_arguments,
)
from musicmute_engine.store_code_reader import (
    PERSONAL_CORE_PATH, PERSONAL_ENTRY_PATH, StoreCodeReader, StoreReadError,
)

ROOT = r"C:\Program Files\WindowsApps\27120VCHATSDK.MusicMuteWorker_0.1.3.0_x64__5q1esjnkz8cve\worker"
PYTHON = ROOT + r"\runtime\python\python.exe"


def arguments():
    return [PYTHON, "-I", "-B", "-S", ROOT + r"\tools\downloader\downloader_bootstrap.py",
        "--musicmute-downloader-root", ROOT + r"\tools\downloader",
        "--musicmute-youtube-runtime", ROOT + r"\tools\youtube",
        "--ignore-config", "--no-js-runtimes", "--js-runtimes",
        "deno:" + ROOT + r"\tools\youtube\bin\deno.exe", "--ffmpeg-location",
        ROOT + r"\runtime\bin\ffmpeg.exe", "--no-cookies", "--no-cache-dir",
        "--no-remote-components", "--print", "id", "https://www.youtube.com/watch?v=abcdefghijk"]


class StorePersonalAdapterTests(unittest.TestCase):
    def test_fixed_store_entry_keeps_original_data_arguments_and_has_no_caller_code_roots(self):
        source = arguments()
        converted = store_downloader_arguments(source, PYTHON, ROOT)
        self.assertEqual(converted[:5], [PYTHON, "-I", "-B", "-S",
            ROOT + r"\tools\downloader\store_downloader_bootstrap.py"])
        self.assertEqual(converted[5:], ["--ignore-config", "--no-cookies", "--no-cache-dir",
            "--no-remote-components", "--print", "id", "https://www.youtube.com/watch?v=abcdefghijk"])
        self.assertEqual(source, arguments())

    def test_each_external_or_alternate_code_path_is_denied(self):
        for index in (0, 4, 6, 8, 12, 14):
            changed = arguments()
            changed[index] = r"C:\user-writable\code.exe"
            with self.subTest(index=index), self.assertRaises(StorePersonalError):
                store_downloader_arguments(changed, PYTHON, ROOT)
        with self.assertRaises(StorePersonalError):
            store_downloader_arguments(arguments(), r"C:\private\python.exe", ROOT)

    def test_missing_duplicate_or_changed_reset_switches_and_bootstrap_modes_are_denied(self):
        mutations = []
        for index in (1, 2, 3, 5, 7, 10, 11, 13):
            changed = arguments()
            changed[index] = "--foreign-mode"
            mutations.append(changed)
        mutations.extend((arguments() + ["--no-js-runtimes"],
            arguments() + ["--js-runtimes", "deno:" + ROOT + r"\tools\youtube\bin\deno.exe"],
            arguments() + ["--musicmute-downloader-root", ROOT + r"\tools\downloader"]))
        for changed in mutations:
            with self.subTest(changed=changed), self.assertRaises(StorePersonalError):
                store_downloader_arguments(changed, PYTHON, ROOT)

    def test_exact_ejs_check_remains_bound_to_protected_entry(self):
        source = arguments()[:9] + ["--musicmute-check-ejs"]
        self.assertEqual(store_downloader_arguments(source, PYTHON, ROOT)[5:], ["--musicmute-check-ejs"])

    def test_malformed_or_unbounded_receiving_values_are_denied(self):
        for changed in (None, tuple(arguments()), [], arguments() + ["x"] * 121,
                arguments() + ["x\0y"], arguments() + ["x" * 4097], arguments() + [None]):
            with self.subTest(changed=type(changed)), self.assertRaises(StorePersonalError):
                store_downloader_arguments(changed, PYTHON, ROOT)

    def test_only_two_specific_personal_leaves_extend_supplementary_reader(self):
        reader = object.__new__(StoreCodeReader)
        reader.inventory = {PERSONAL_CORE_PATH: (1, "a" * 64), PERSONAL_ENTRY_PATH: (1, "b" * 64),
            "worker/app/engine/musicmute_engine/arbitrary.py": (1, "c" * 64)}
        reader.allowed(PERSONAL_CORE_PATH)
        reader.allowed(PERSONAL_ENTRY_PATH)
        for path in ("worker/app/engine/musicmute_engine/arbitrary.py", "worker/app/engine"):
            with self.subTest(path=path), self.assertRaises(StoreReadError):
                reader.allowed(path)
        with self.assertRaises(StoreReadError):
            reader.allowed(PERSONAL_ENTRY_PATH, True)

    def test_original_retained_engine_bytes_are_unchanged_and_unsupported_host_cannot_start(self):
        core = Path(__file__).resolve().parents[1] / "musicmute_engine" / "consumer_personal.py"
        self.assertEqual(hashlib.sha256(core.read_bytes()).hexdigest(), PERSONAL_CORE_SHA256)
        import sys
        if sys.platform != "win32":
            self.assertEqual(main(), 2)


if __name__ == "__main__":
    unittest.main()
