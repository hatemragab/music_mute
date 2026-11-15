"""Supplementary Store adapter fixtures; no OS package, model or GPU proof."""
from contextlib import ExitStack, contextmanager, redirect_stderr
import ast
import hashlib
import io
import json
import ntpath
from pathlib import Path
import runpy
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import warnings

from musicmute_engine import store_benchmark_context as context
from musicmute_engine import store_benchmark_file as file_entry
from musicmute_engine import store_benchmark_capacity as capacity_entry
from musicmute_engine.store_code_reader import (
    BENCHMARK_CONTEXT_PATH, BENCHMARK_FILE_ENTRY_PATH, BENCHMARK_FILE_CORE_PATH,
    BENCHMARK_CAPACITY_ENTRY_PATH, BENCHMARK_CAPACITY_CORE_PATH,
    QUALIFICATION_CORE_PATH, RELEASE_MANIFEST_PATH, StoreReadError,
)

PACKAGE = r"C:\Program Files\WindowsApps\27120VCHATSDK.MusicMuteWorker_0.1.3.0_x64__5q1esjnkz8cve"
WORKER = PACKAGE + r"\worker"
PRIVATE = r"C:\Users\qa\AppData\Local\MusicMuteLocal"
SID = "S-1-5-21-100-200-300-1001"
REQUEST = "12345678-1234-4234-8234-123456789012"
ENGINE = Path(__file__).resolve().parents[1] / "musicmute_engine"


def arguments(operation="benchmark_file"):
    fixture = (PRIVATE + "\\prepare\\work\\" + REQUEST + r"\source.wav"
        if operation == "benchmark_file"
        else PRIVATE + "\\prepare\\approved\\" + "a" * 64 + ".wav")
    values = [
        "--provider", "directml", "--fixture", fixture,
        "--fixture-sha256", "a" * 64,
        "--work-root", PRIVATE + "\\prepare\\work\\" + REQUEST + r"\engine",
        "--release-root", WORKER, "--model-cache", PRIVATE + r"\models",
        "--ffmpeg", WORKER + r"\runtime\bin\ffmpeg.exe",
        "--ffprobe", WORKER + r"\runtime\bin\ffprobe.exe",
        "--runtime-profile", "windows-user", "--expected-user-sid", SID,
        "--directml-device-id", "0", "--warmup-runs", "1",
        "--measured-runs", "3", "--group-size", "1",
        "--report", PRIVATE + "\\prepare\\results\\" + REQUEST + ".benchmark.raw.json",
    ]
    if operation == "benchmark_file":
        values += ["--recipe-id", "kim-vocals-v2"]
    return values


def changed(source, key, value):
    result = list(source)
    result[result.index(key) + 1] = value
    return result


def package_path(key):
    return ntpath.join(PACKAGE, *key.split("/"))


@contextmanager
def synthetic_main(operation, *, corrupt=None, absent=None, core_file=None):
    """Mock only the OS/reader/import boundaries; this grants no real authority.

    Core pin bytes are the unchanged actual source. Its main is observed but
    never executes inference or a media tool in these receiving tests.
    """
    entry = file_entry if operation == "benchmark_file" else capacity_entry
    entry_key = BENCHMARK_FILE_ENTRY_PATH if operation == "benchmark_file" else BENCHMARK_CAPACITY_ENTRY_PATH
    core_key = BENCHMARK_FILE_CORE_PATH if operation == "benchmark_file" else BENCHMARK_CAPACITY_CORE_PATH
    pins = {
        BENCHMARK_FILE_ENTRY_PATH: (ENGINE / "store_benchmark_file.py").read_bytes(),
        BENCHMARK_CAPACITY_ENTRY_PATH: (ENGINE / "store_benchmark_capacity.py").read_bytes(),
        BENCHMARK_CONTEXT_PATH: (ENGINE / "store_benchmark_context.py").read_bytes(),
        BENCHMARK_FILE_CORE_PATH: (ENGINE / "benchmark_file.py").read_bytes(),
        BENCHMARK_CAPACITY_CORE_PATH: (ENGINE / "capacity_benchmark.py").read_bytes(),
        QUALIFICATION_CORE_PATH: (ENGINE / "qualification.py").read_bytes(),
        RELEASE_MANIFEST_PATH: b'{"source-test-only":true}',
    }
    if corrupt:
        pins[corrupt] += b"# changed core bytes\n"
    calls = []

    def read(key, maximum):
        calls.append((key, maximum))
        if key == absent:
            raise StoreReadError()
        return pins[key]

    reader = SimpleNamespace(root=PACKAGE, path=package_path, read=read)
    constructor = Mock(return_value=reader)
    main = Mock(return_value=1)
    core = SimpleNamespace(__file__=core_file or package_path(core_key), main=main)
    importer = Mock(return_value=core)
    flags = SimpleNamespace(**{name: getattr(sys.flags, name) for name in dir(sys.flags)
        if not name.startswith("_") and not callable(getattr(sys.flags, name))})
    flags.isolated = flags.ignore_environment = flags.no_user_site = 1
    with ExitStack() as stack:
        for owner, name, value in (
            (context.sys, "platform", "win32"), (context.sys, "flags", flags),
            (context.sys, "executable", WORKER + r"\runtime\python\python.exe"),
            (context.sys, "argv", [package_path(entry_key), *arguments(operation)]),
            (context, "__file__", package_path(BENCHMARK_CONTEXT_PATH)),
            (entry, "__file__", package_path(entry_key)),
        ):
            stack.enter_context(patch.object(owner, name, value))
        stack.enter_context(patch.object(context.platform, "machine", return_value="AMD64"))
        stack.enter_context(patch.object(context.os.path, "abspath", side_effect=lambda value: value))
        stack.enter_context(patch("musicmute_engine.store_code_reader.StoreCodeReader", constructor))
        stack.enter_context(patch.object(context, "_private_root", return_value=PRIVATE))
        stack.enter_context(patch.object(context, "_current_sid", return_value=SID))
        stack.enter_context(patch.object(context.importlib, "import_module", importer))
        stack.enter_context(patch.object(context.sys, "dont_write_bytecode", True))
        yield SimpleNamespace(entry=entry, reader=reader, constructor=constructor,
            importer=importer, main=main, calls=calls, entry_key=entry_key, core_key=core_key)


class StoreBenchmarkArgumentsTests(unittest.TestCase):
    def test_fixed_values_and_original_quality_controls_are_preserved(self):
        for operation in ("benchmark_file", "benchmark_capacity"):
            source = arguments(operation)
            context.validate_store_arguments(source, operation, WORKER, PRIVATE, SID)
            self.assertEqual(source, arguments(operation))
            pairs = [source[index:index + 2] for index in range(0, len(source), 2)]
            reordered = [value for pair in reversed(pairs) for value in pair]
            context.validate_store_arguments(reordered, operation, WORKER, PRIVATE, SID)
            for device in ("0", "15"):
                for warm in (("0", "2") if operation == "benchmark_file" else ("1", "2")):
                    for measured in ("3", "10"):
                        values = changed(changed(changed(source, "--directml-device-id", device),
                            "--warmup-runs", warm), "--measured-runs", measured)
                        context.validate_store_arguments(values, operation, WORKER, PRIVATE, SID)

    def test_file_recipe_and_same_protected_candidate_and_saved_audio_paths(self):
        for recipe in context.FILE_RECIPES:
            source = changed(arguments(), "--recipe-id", recipe)
            context.validate_store_arguments(source, "benchmark_file", WORKER, PRIVATE, SID)
            for extras in (
                ["--candidate-engine-root", WORKER + r"\app\engine"],
                ["--save-audio-dir", PRIVATE + "\\prepare\\work\\" + REQUEST + r"\saved-audio"],
                ["--candidate-engine-root", WORKER + r"\app\engine", "--save-audio-dir",
                    PRIVATE + "\\prepare\\work\\" + REQUEST + r"\saved-audio"],
            ):
                values = source + extras
                context.validate_store_arguments(values, "benchmark_file", WORKER, PRIVATE, SID)
                self.assertEqual(values, source + extras)

    def test_candidate_and_saved_audio_cannot_select_foreign_or_other_request_paths(self):
        for option, value in (
            ("--candidate-engine-root", PRIVATE + r"\candidate\engine"),
            ("--candidate-engine-root", WORKER + r"\app\engine\..\engine"),
            ("--save-audio-dir", PRIVATE + r"\anywhere"),
            ("--save-audio-dir", PRIVATE + "\\prepare\\work\\" + "87654321-4321-4321-8321-210987654321" + r"\saved-audio"),
        ):
            with self.subTest(option=option, value=value), self.assertRaises(context.StoreBenchmarkError):
                context.validate_store_arguments(arguments() + [option, value], "benchmark_file", WORKER, PRIVATE, SID)

    def test_current_paths_sid_no_cpu_fallback_or_tuning_override(self):
        for operation in ("benchmark_file", "benchmark_capacity"):
            for key, value in (
                ("--provider", "cpu"), ("--provider", "mps"),
                ("--runtime-profile", "legacy-service"), ("--expected-user-sid", "S-1-5-18"),
                ("--release-root", PRIVATE), ("--model-cache", PRIVATE + r"\other-models"),
                ("--ffmpeg", r"C:\user\ffmpeg.exe"), ("--ffprobe", r"C:\user\ffprobe.exe"),
                ("--work-root", PRIVATE + "\\prepare\\work\\" + REQUEST),
                ("--work-root", PRIVATE + "\\prepare\\work\\..\\" + REQUEST + r"\engine"),
                ("--report", PRIVATE + r"\report.json"), ("--fixture", PRIVATE + r"\any.wav"),
                ("--fixture-sha256", "A" * 64), ("--fixture-sha256", "a" * 63),
                ("--directml-device-id", "16"), ("--directml-device-id", "00"),
                ("--warmup-runs", "3"), ("--warmup-runs", "1.0"),
                ("--measured-runs", "2"), ("--measured-runs", "11"),
                ("--measured-runs", "03"), ("--group-size", "2"), ("--group-size", "4"),
            ):
                with self.subTest(operation=operation, key=key, value=value), self.assertRaises(context.StoreBenchmarkError):
                    context.validate_store_arguments(changed(arguments(operation), key, value), operation, WORKER, PRIVATE, SID)
        with self.assertRaises(context.StoreBenchmarkError):
            context.validate_store_arguments(changed(arguments(), "--recipe-id", "unreviewed-recipe"), "benchmark_file", WORKER, PRIVATE, SID)

    def test_capacity_has_only_approved_fixture_and_no_candidate_save_recipe_or_watch(self):
        source = arguments("benchmark_capacity")
        for extra in (
            ["--recipe-id", "kim-vocals-v2"], ["--candidate-engine-root", WORKER + r"\app\engine"],
            ["--save-audio-dir", PRIVATE + "\\prepare\\work\\" + REQUEST + r"\saved-audio"],
            ["--watch-parent"], ["--watch-parent", "true"],
        ):
            with self.subTest(extra=extra), self.assertRaises(context.StoreBenchmarkError):
                context.validate_store_arguments(source + extra, "benchmark_capacity", WORKER, PRIVATE, SID)
        for key, value in (
            ("--warmup-runs", "0"), ("--fixture", arguments()[3]),
            ("--fixture", PRIVATE + "\\prepare\\approved\\" + "b" * 64 + ".wav"),
        ):
            with self.subTest(key=key), self.assertRaises(context.StoreBenchmarkError):
                context.validate_store_arguments(changed(source, key, value), "benchmark_capacity", WORKER, PRIVATE, SID)

    def test_closed_argv_bounds_missing_duplicate_unknown_and_unsafe_values(self):
        for operation in ("benchmark_file", "benchmark_capacity"):
            source = arguments(operation)
            duplicate = source.copy()
            duplicate[duplicate.index("--report")] = "--provider"
            for values in (
                source[:-2], source + ["--provider", "directml"], duplicate,
                source + ["--iterations", "20"], source + ["--watch-parent"],
                source + ["--env", "PATH=C:\\caller"], tuple(source), None,
                [None, *source[1:]], [source[0], "x" * 4097, *source[2:]],
                [source[0], "directml\0", *source[2:]], [source[0], "\ud800", *source[2:]],
            ):
                with self.subTest(operation=operation, values=type(values)), self.assertRaises(context.StoreBenchmarkError):
                    context.validate_store_arguments(values, operation, WORKER, PRIVATE, SID)

    def test_receiving_values_do_not_run_caller_coercion_or_path_hooks(self):
        calls = []

        class PathShim:
            def __fspath__(self):
                calls.append("path")
                return PRIVATE

        class StringShim(str):
            def __contains__(self, value):
                calls.append("contains")
                return False

        for operation, worker, private in ((PathShim(), WORKER, PRIVATE),
                ("benchmark_file", PathShim(), PRIVATE), ("benchmark_file", WORKER, PathShim())):
            with self.assertRaises(context.StoreBenchmarkError):
                context.validate_store_arguments(arguments(), operation, worker, private, SID)
        with self.assertRaises(context.StoreBenchmarkError):
            context.validate_store_arguments(changed(arguments(), "--provider", StringShim("directml")),
                "benchmark_file", WORKER, PRIVATE, SID)
        self.assertEqual(calls, [])

    def test_missing_native_sid_or_unsupported_sid_does_not_accept_matching_text(self):
        for sid in ("S-1-5-18", "S-1-5-5-1-2", "S-1-5-21-4294967296-2-3-1001", "user-name", None):
            with self.subTest(sid=sid), self.assertRaises(context.StoreBenchmarkError):
                context.validate_store_arguments(changed(arguments(), "--expected-user-sid", sid),
                    "benchmark_file", WORKER, PRIVATE, sid)
        azure = "S-1-12-1-100-200-300-1001"
        context.validate_store_arguments(changed(arguments(), "--expected-user-sid", azure),
            "benchmark_file", WORKER, PRIVATE, azure)

    def test_each_request_scoped_path_binds_same_original_request(self):
        other = "87654321-4321-4321-8321-210987654321"
        source = arguments()
        for option in ("--fixture", "--work-root", "--report"):
            changed_value = source[source.index(option) + 1].replace(REQUEST, other)
            with self.subTest(option=option), self.assertRaises(context.StoreBenchmarkError):
                context.validate_store_arguments(changed(source, option, changed_value), "benchmark_file", WORKER, PRIVATE, SID)


class StoreBenchmarkDelegationTests(unittest.TestCase):
    def test_actual_unchanged_core_pins_and_python_source_syntax(self):
        for name, digest in (
            ("benchmark_file.py", context.BENCHMARK_FILE_CORE_SHA256),
            ("capacity_benchmark.py", context.BENCHMARK_CAPACITY_CORE_SHA256),
            ("qualification.py", context.QUALIFICATION_CORE_SHA256),
        ):
            self.assertEqual(hashlib.sha256((ENGINE / name).read_bytes()).hexdigest(), digest)
        for name in ("store_benchmark_file.py", "store_benchmark_capacity.py", "store_benchmark_context.py"):
            ast.parse((ENGINE / name).read_text(encoding="utf-8"))

    def test_unsupported_host_architecture_and_flags_never_construct_store_reader(self):
        for operation in ("benchmark_file", "benchmark_capacity"):
            with synthetic_main(operation) as env:
                for component, field, value in (
                    (context.sys, "platform", "darwin"), (context.platform, "machine", lambda: "ARM64"),
                    (context.sys.flags, "isolated", 0), (context.sys.flags, "ignore_environment", 0),
                    (context.sys.flags, "no_user_site", 0),
                ):
                    with patch.object(component, field, value), self.subTest(operation=operation, field=field):
                        self.assertEqual(env.entry.main(), 2)
                env.constructor.assert_not_called()
                env.main.assert_not_called()

    def test_selected_core_receives_original_arguments_and_its_failure_status_is_preserved(self):
        for operation in ("benchmark_file", "benchmark_capacity"):
            with synthetic_main(operation) as env:
                original = list(sys.argv)
                self.assertEqual(env.entry.main(), 1)
                self.assertEqual(sys.argv, original)
                env.main.assert_called_once_with()
                env.importer.assert_called_once_with(
                    ".benchmark_file" if operation == "benchmark_file" else ".capacity_benchmark", "musicmute_engine")
                expected = [env.entry_key, BENCHMARK_CONTEXT_PATH, BENCHMARK_FILE_CORE_PATH]
                if operation == "benchmark_capacity":
                    expected.append(BENCHMARK_CAPACITY_CORE_PATH)
                expected += [QUALIFICATION_CORE_PATH, RELEASE_MANIFEST_PATH]
                self.assertEqual([key for key, _ in env.calls], expected)
                self.assertEqual(env.calls[-1], (RELEASE_MANIFEST_PATH, 16 * 1024 * 1024))

    def test_missing_entry_context_or_manifest_and_changed_core_never_delegate(self):
        for operation in ("benchmark_file", "benchmark_capacity"):
            entry = BENCHMARK_FILE_ENTRY_PATH if operation == "benchmark_file" else BENCHMARK_CAPACITY_ENTRY_PATH
            for absent in (entry, BENCHMARK_CONTEXT_PATH, RELEASE_MANIFEST_PATH):
                with synthetic_main(operation, absent=absent) as env:
                    with self.subTest(operation=operation, absent=absent), self.assertRaises(StoreReadError):
                        env.entry.main()
                    env.main.assert_not_called()
                    env.importer.assert_not_called()
            cores = [BENCHMARK_FILE_CORE_PATH, QUALIFICATION_CORE_PATH]
            if operation == "benchmark_capacity":
                cores.append(BENCHMARK_CAPACITY_CORE_PATH)
            for core in cores:
                with synthetic_main(operation, corrupt=core) as env:
                    with self.subTest(operation=operation, core=core), self.assertRaises(context.StoreBenchmarkError):
                        env.entry.main()
                    env.main.assert_not_called()
                    env.importer.assert_not_called()

    def test_current_entry_helper_python_and_imported_core_paths_are_mandatory(self):
        for operation in ("benchmark_file", "benchmark_capacity"):
            for owner, field in ((context.sys, "executable"), (context, "__file__")):
                with synthetic_main(operation) as env, patch.object(owner, field, r"C:\caller\code.py"):
                    with self.subTest(operation=operation, field=field), self.assertRaises(context.StoreBenchmarkError):
                        env.entry.main()
                    env.main.assert_not_called()
            with synthetic_main(operation) as env, patch.object(env.entry, "__file__", r"C:\caller\entry.py"):
                with self.assertRaises(context.StoreBenchmarkError):
                    env.entry.main()
                env.main.assert_not_called()
            with synthetic_main(operation, core_file=r"C:\caller\core.py") as env:
                with self.assertRaises(context.StoreBenchmarkError):
                    env.entry.main()
                env.main.assert_not_called()

    def test_actual_known_folder_and_sid_results_fence_data_before_core_import(self):
        for operation in ("benchmark_file", "benchmark_capacity"):
            with synthetic_main(operation) as env, patch.object(context, "_private_root", return_value=r"D:\different\MusicMuteLocal"):
                with self.assertRaises(context.StoreBenchmarkError):
                    env.entry.main()
                env.main.assert_not_called()
                env.importer.assert_not_called()
            with synthetic_main(operation) as env, patch.object(context, "_current_sid", return_value="S-1-5-21-100-200-300-1002"):
                with self.assertRaises(context.StoreBenchmarkError):
                    env.entry.main()
                env.main.assert_not_called()
                env.importer.assert_not_called()

    def test_original_core_exception_and_written_raw_failure_are_not_replaced(self):
        for operation in ("benchmark_file", "benchmark_capacity"):
            with synthetic_main(operation) as env:
                original = RuntimeError("original core failure sentinel")
                env.main.side_effect = original
                with self.assertRaises(RuntimeError) as received:
                    env.entry.main()
                self.assertIs(received.exception, original)
            with synthetic_main(operation) as env, tempfile.TemporaryDirectory() as directory:
                report = Path(directory) / "synthetic-raw-failure.json"
                raw = b'{"status":"FAIL","code":"OriginalCoreFailure","scope":"local-engine-only"}'

                def failure():
                    report.write_bytes(raw)
                    return 1

                env.main.side_effect = failure
                self.assertEqual(env.entry.main(), 1)
                self.assertEqual(report.read_bytes(), raw)
                self.assertEqual(json.loads(raw)["status"], "FAIL")

    def test_closed_module_cli_error_exits_with_sanitized_code_and_no_report_or_gpu_claim(self):
        for module in ("musicmute_engine.store_benchmark_file", "musicmute_engine.store_benchmark_capacity"):
            output = io.StringIO()
            with patch.object(context, "_validated_benchmark", side_effect=RuntimeError("C:\\private\\song.wav secret")), redirect_stderr(output), warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                with self.assertRaises(SystemExit) as stopped:
                    runpy.run_module(module, run_name="__main__")
            self.assertEqual(stopped.exception.code, 2)
            self.assertEqual(output.getvalue(), "STORE_BENCHMARK_CONTEXT_INVALID\n")
            self.assertNotIn("secret", output.getvalue())
            self.assertNotIn("ready", output.getvalue().lower())

    def test_actual_cli_core_failure_after_context_validation_exits_one_and_keeps_raw_report(self):
        for operation in ("benchmark_file", "benchmark_capacity"):
            with synthetic_main(operation) as env, tempfile.TemporaryDirectory() as directory:
                output = io.StringIO()
                report = Path(directory) / "synthetic-raw-failure.json"
                raw = b'{"status":"FAIL","code":"OriginalCoreFailure","scope":"local-engine-only"}'

                def failed_core():
                    report.write_bytes(raw)
                    raise RuntimeError("C:\\private\\song.wav secret")

                env.main.side_effect = failed_core
                source_name = "store_benchmark_file.py" if operation == "benchmark_file" else "store_benchmark_capacity.py"
                # Execute the actual wrapper entry with the same synthetic OS /
                # held-reader boundaries as the direct tests, never a fake GPU.
                with redirect_stderr(output), self.assertRaises(SystemExit) as stopped:
                    exec(compile((ENGINE / source_name).read_bytes(), source_name, "exec"), {
                        "__name__": "__main__", "__package__": "musicmute_engine",
                        "__file__": package_path(env.entry_key),
                    })
                self.assertEqual(stopped.exception.code, 1)
                self.assertEqual(output.getvalue(), "STORE_BENCHMARK_OPERATION_FAILED\n")
                self.assertEqual(report.read_bytes(), raw)
                self.assertNotIn("secret", output.getvalue())
                env.main.assert_called_once_with()
                self.assertIn((RELEASE_MANIFEST_PATH, 16 * 1024 * 1024), env.calls)

    def test_actual_cli_context_denial_does_not_call_the_original_benchmark(self):
        for operation in ("benchmark_file", "benchmark_capacity"):
            with synthetic_main(operation, corrupt=QUALIFICATION_CORE_PATH) as env:
                output = io.StringIO()
                source_name = "store_benchmark_file.py" if operation == "benchmark_file" else "store_benchmark_capacity.py"
                with redirect_stderr(output), self.assertRaises(SystemExit) as stopped:
                    exec(compile((ENGINE / source_name).read_bytes(), source_name, "exec"), {
                        "__name__": "__main__", "__package__": "musicmute_engine",
                        "__file__": package_path(env.entry_key),
                    })
                self.assertEqual(stopped.exception.code, 2)
                self.assertEqual(output.getvalue(), "STORE_BENCHMARK_CONTEXT_INVALID\n")
                env.main.assert_not_called()
                env.importer.assert_not_called()

    def test_cli_preserves_original_core_return_status_without_rewriting_reports(self):
        for operation in ("benchmark_file", "benchmark_capacity"):
            for status in (0, 1):
                with synthetic_main(operation) as env:
                    env.main.return_value = status
                    output = io.StringIO()
                    with redirect_stderr(output):
                        self.assertEqual(context.store_benchmark_cli(operation, package_path(env.entry_key)), status)
                    self.assertEqual(output.getvalue(), "")
                    env.main.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
