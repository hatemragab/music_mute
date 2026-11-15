"""Pure receiving fixtures, without package/GPU/runtime admission."""
import hashlib
from pathlib import Path
import unittest
import io
import json
from contextlib import redirect_stdout
from unittest.mock import patch

from musicmute_engine.store_code_reader import (StoreCodeReader, StoreReadError,
    QUALIFICATION_CORE_PATH, QUALIFICATION_ENTRY_PATH, RELEASE_MANIFEST_PATH)
from musicmute_engine.store_qualification import (StoreQualificationError,
    QUALIFICATION_CORE_SHA256, main, validate_store_arguments,
    qualification_failure_code, run_main)

ROOT = r"C:\Program Files\WindowsApps\27120VCHATSDK.MusicMuteWorker_0.1.3.0_x64__5q1esjnkz8cve\worker"
PRIVATE = r"C:\Users\qa\AppData\Local\MusicMuteLocal"
SID = "S-1-5-21-100-200-300-1001"
REQUEST = "12345678-1234-4234-8234-123456789012"


def arguments():
    return ["--provider", "directml", "--fixture", PRIVATE + r"\fixtures\prepare-fixture.wav",
        "--fixture-sha256", "a" * 64, "--work-root", PRIVATE + "\\prepare\\work\\" + REQUEST,
        "--release-root", ROOT, "--model-cache", PRIVATE + r"\models", "--ffmpeg", ROOT + r"\runtime\bin\ffmpeg.exe",
        "--ffprobe", ROOT + r"\runtime\bin\ffprobe.exe", "--runtime-profile", "windows-user", "--expected-user-sid", SID,
        "--directml-device-id", "0", "--report", PRIVATE + "\\prepare\\results\\" + REQUEST + ".raw.json"]


class StoreQualificationTests(unittest.TestCase):
    def test_native_fixed_values_and_approved_fixture_keep_original_arguments(self):
        source = arguments()
        validate_store_arguments(source, ROOT, PRIVATE, SID)
        self.assertEqual(source, arguments())
        source[3] = PRIVATE + "\\prepare\\approved\\" + "a" * 64 + ".wav"
        validate_store_arguments(source, ROOT, PRIVATE, SID)

    def test_no_tuning_fallback_or_caller_code_root(self):
        source = arguments()
        for key, value in (("--provider", "cpu"), ("--release-root", PRIVATE), ("--ffmpeg", r"C:\untrusted.exe"),
                ("--model-cache", PRIVATE + r"\other-model"), ("--runtime-profile", "legacy-service"),
                ("--expected-user-sid", "S-1-5-18"), ("--directml-device-id", "16"), ("--directml-device-id", "00"),
                ("--work-root", PRIVATE + "\\prepare\\work\\..\\" + REQUEST), ("--report", PRIVATE + r"\report.json"),
                ("--fixture", PRIVATE + r"\any.wav"), ("--fixture-sha256", "A" * 64)):
            changed = source.copy()
            changed[changed.index(key) + 1] = value
            with self.subTest(key=key, value=value), self.assertRaises(StoreQualificationError):
                validate_store_arguments(changed, ROOT, PRIVATE, SID)
        for extra in (["--recipe-id", "kim-vocal"], ["--auto-select"], ["--iterations", "2"], ["--ffmpeg", ROOT + r"\runtime\bin\ffmpeg.exe"]):
            with self.assertRaises(StoreQualificationError):
                validate_store_arguments(source + extra, ROOT, PRIVATE, SID)

    def test_closed_fields_bounds_and_duplicates(self):
        source = arguments()
        for changed in (source[:-2], ["--provider", "directml"] + source[2:-2] + ["--provider", "directml"],
                tuple(source), [None, *source[1:]], [source[0], "x" * 4097, *source[2:]], [source[0], "directml\0", *source[2:]]):
            with self.assertRaises(StoreQualificationError):
                validate_store_arguments(changed, ROOT, PRIVATE, SID)

    def test_reader_adds_only_exact_required_code_leaves(self):
        reader = object.__new__(StoreCodeReader)
        reader.inventory = {key: (1, "a" * 64) for key in (QUALIFICATION_ENTRY_PATH, QUALIFICATION_CORE_PATH, RELEASE_MANIFEST_PATH)}
        for key in reader.inventory:
            reader.allowed(key)
        for key in ("worker/app/engine/musicmute_engine/pipeline.py", "worker/app/agent/prepare.cjs", "worker/other-manifest.json"):
            reader.inventory[key] = (1, "a" * 64)
            with self.assertRaises(StoreReadError):
                reader.allowed(key)

    def test_original_qualification_is_unchanged_and_unsupported_host_denied(self):
        core = Path(__file__).parents[1] / "musicmute_engine" / "qualification.py"
        self.assertEqual(hashlib.sha256(core.read_bytes()).hexdigest(), QUALIFICATION_CORE_SHA256)
        self.assertEqual(main(), 2)

    def test_gpu_retry_requires_known_typed_cause_and_integrity_takes_precedence(self):
        from musicmute_engine.windows_gpu import GpuSelectionError
        from musicmute_engine.provider_adapter import ProviderAdapterError
        from musicmute_engine.qualification import QualificationError
        wrapper = RuntimeError("private user path must not be emitted")
        wrapper.__cause__ = GpuSelectionError("private adapter text")
        self.assertEqual(qualification_failure_code(wrapper), "GPU_UNSUPPORTED")
        for error in (StoreQualificationError(), StoreReadError(), QualificationError("bad evidence"),
                ProviderAdapterError("CPU model fallback prevention changed"),
                ProviderAdapterError("Exactly the qualified ONNX Runtime distribution is required")):
            error.__cause__ = wrapper
            self.assertEqual(qualification_failure_code(error), "INTEGRITY_INVALID")
        self.assertEqual(qualification_failure_code(ProviderAdapterError("Required ONNX provider is unavailable")), "GPU_UNSUPPORTED")
        self.assertEqual(qualification_failure_code(RuntimeError("GPU_UNSUPPORTED")), "OPERATION_FAILED")
        cyclic = RuntimeError("private details")
        cyclic.__cause__ = cyclic
        self.assertEqual(qualification_failure_code(cyclic), "OPERATION_FAILED")

    def test_terminal_frame_is_bounded_and_contains_no_exception_details_or_ready(self):
        for failure in (StoreQualificationError(), RuntimeError("C:\\private\\song.wav secret text")):
            output = io.StringIO()
            with patch("musicmute_engine.store_qualification.main", side_effect=failure), redirect_stdout(output):
                self.assertEqual(run_main(), 2)
            text = output.getvalue()
            self.assertLess(len(text.encode("utf8")), 192)
            self.assertEqual(text.count("\n"), 1)
            value = json.loads(text)
            self.assertEqual(set(value), {"version", "kind", "errorCode"})
            self.assertEqual(value["kind"], "store-qualification-failure")
            self.assertNotIn("private", text)
            self.assertNotIn("ready", text)
        output = io.StringIO()
        with patch("musicmute_engine.store_qualification.main", return_value=0), redirect_stdout(output):
            self.assertEqual(run_main(), 0)
        self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
