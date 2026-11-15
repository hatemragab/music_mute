from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from musicmute_engine.qualification import (
    QualificationError,
    summarize_profiles,
    selected_recipe_ids,
    run_qualification,
    main,
    write_private_report,
    assert_context_identity,
    service_identity,
)


class QualificationTests(unittest.TestCase):
    def test_windows_identity_console_tool_detaches_without_changing_command_or_capture(self) -> None:
        for native_system in ("win32", "darwin"):
            with self.subTest(native_system=native_system):
                completed = SimpleNamespace(stdout='"fixture-user","S-1-5-21-111-222-333-1001"\n')
                with patch("musicmute_engine.qualification.platform.system", return_value="Windows"), patch("musicmute_engine.qualification.sys.platform", native_system), patch("musicmute_engine.qualification.subprocess.run", return_value=completed) as run:
                    self.assertEqual(service_identity(), "S-1-5-21-111-222-333-1001")
                self.assertEqual(run.call_args.args[0][-3:], ["/fo", "csv", "/nh"])
                self.assertEqual(Path(run.call_args.args[0][0]).name, "whoami.exe")
                options = run.call_args.kwargs
                self.assertEqual(options, {"check": True, "capture_output": True, "text": True, "timeout": 10,
                                           "creationflags": 0x8 if native_system == "win32" else 0})
                self.assertEqual(options["creationflags"] & 0x01000000, 0)

    def test_detached_windows_identity_tool_failure_is_still_fail_closed(self) -> None:
        for error in (OSError("fixture launch denied"), subprocess.TimeoutExpired("fixture", 10)):
            with self.subTest(error=type(error).__name__), patch("musicmute_engine.qualification.platform.system", return_value="Windows"), patch("musicmute_engine.qualification.sys.platform", "win32"), patch("musicmute_engine.qualification.subprocess.run", side_effect=error), self.assertRaises(QualificationError):
                service_identity()

    def test_per_user_qualification_requires_exact_current_user_and_explicit_profile(self) -> None:
        user = "S-1-5-21-111-222-333-1001"
        arguments = Namespace(runtime_profile="windows-user", expected_user_sid=user, provider="directml")
        self.assertEqual(assert_context_identity(arguments, "Windows", user), "windows-user")
        for identity in ("S-1-5-19", "S-1-5-18", "S-1-5-20", "S-1-5-21-111-222-333-1002"):
            with self.assertRaises(QualificationError):
                assert_context_identity(arguments, "Windows", identity)
        with self.assertRaises(QualificationError):
            assert_context_identity(arguments, "Darwin", user)
        with self.assertRaises(QualificationError):
            assert_context_identity(Namespace(provider="directml"), "Windows", user)
        self.assertEqual(assert_context_identity(Namespace(provider="directml"), "Windows", "S-1-5-19"), "legacy-service")

    def test_other_provider_or_absent_profile_is_not_placement_proof(self) -> None:
        self.assertFalse(summarize_profiles([], "DmlExecutionProvider")["proven"])
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / "profile.json"
            profile.write_text(json.dumps([{"args": {"provider": "DmlExecutionProvider"}}, {"args": {"provider": "CUDAExecutionProvider"}}]))
            self.assertFalse(summarize_profiles([profile], "DmlExecutionProvider")["proven"])

    def test_success_retains_only_the_mp3_needed_for_enrollment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)

            def qualify(_arguments: Namespace, root: Path) -> dict[str, object]:
                attempt = root / "attempt" / "output"
                attempt.mkdir(parents=True)
                (root / "fixture.wav").write_bytes(b"copied fixture")
                (attempt.parent / "input.wav").write_bytes(b"copied input")
                output = attempt / "vocals.mp3"
                output.write_bytes(b"qualified output")
                return {"uploadCandidate": {"path": str(output), "resultBytes": 16}}

            with patch("musicmute_engine.qualification._run_qualification", side_effect=qualify):
                report = run_qualification(Namespace(work_root=work))
            candidate = Path(report["uploadCandidate"]["path"])
            self.assertEqual(candidate.read_bytes(), b"qualified output")
            self.assertEqual(list(candidate.parent.iterdir()), [candidate])
            self.assertEqual([path.resolve() for path in work.iterdir()], [candidate.parent])

    def test_failed_qualification_removes_media_created_before_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)

            def fail(_arguments: Namespace, root: Path) -> dict[str, object]:
                (root / "fixture.wav").write_bytes(b"temporary fixture")
                raise QualificationError("preload failed")

            with patch("musicmute_engine.qualification._run_qualification", side_effect=fail):
                with self.assertRaisesRegex(QualificationError, "preload failed"):
                    run_qualification(Namespace(work_root=work))
            self.assertEqual(list(work.iterdir()), [])

    def test_benchmark_removes_workspace_and_preserves_requested_audio(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work = root / "work"
            work.mkdir()
            saved = root / "saved.mp3"

            def qualify(_arguments: Namespace, scratch: Path) -> dict[str, object]:
                (scratch / "input.wav").write_bytes(b"temporary input")
                output = scratch / "vocals.mp3"
                output.write_bytes(b"qualified output")
                saved.write_bytes(output.read_bytes())
                return {"uploadCandidate": {"path": str(output)}}

            with patch("musicmute_engine.qualification._run_qualification", side_effect=qualify):
                run_qualification(Namespace(work_root=work, benchmark_mode=True))
            self.assertEqual(list(work.iterdir()), [])
            self.assertEqual(saved.read_bytes(), b"qualified output")

    def test_report_write_failure_removes_the_unusable_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work = root / "work"
            work.mkdir()
            report = root / "qualification.json"
            report.write_text("existing evidence")

            def qualify(_arguments: Namespace, scratch: Path) -> dict[str, object]:
                output = scratch / "result.mp3"
                output.write_bytes(b"qualified output")
                return {"uploadCandidate": {"path": str(output)}}

            with (
                patch("musicmute_engine.qualification.parse_args", return_value=Namespace(work_root=work, report=report)),
                patch("musicmute_engine.qualification._run_qualification", side_effect=qualify),
            ):
                with self.assertRaisesRegex(QualificationError, "new absolute path"):
                    main()
            self.assertEqual(list(work.iterdir()), [])
            self.assertEqual(report.read_text(), "existing evidence")

    def test_explicit_qualification_selects_the_requested_iterations(self) -> None:
        self.assertEqual(
            selected_recipe_ids(Namespace(recipe_id="kim-vocals-v2", iterations=1)),
            ["kim-vocals-v2"],
        )
        self.assertEqual(
            selected_recipe_ids(
                Namespace(recipe_id="kim-vocals-v2-trim", iterations=2)
            ),
            ["kim-vocals-v2-trim", "kim-vocals-v2-trim"],
        )

    def test_installation_qualification_covers_every_advertised_recipe(self) -> None:
        self.assertEqual(
            selected_recipe_ids(Namespace()),
            ["kim-vocals-v2", "kim-vocals-v2-trim"],
        )

    def test_profile_summary_requires_accelerated_nodes_without_cpu_nodes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / "profile.json"
            profile.write_text(
                json.dumps(
                    [
                        {"args": {"provider": "DmlExecutionProvider"}},
                        {"args": {"provider": "DmlExecutionProvider"}},
                        {"args": {"op_name": "metadata-only"}},
                    ]
                ),
                encoding="utf-8",
            )
            summary = summarize_profiles([profile], "DmlExecutionProvider")
            self.assertEqual(summary["profileCount"], 1)
            self.assertEqual(summary["acceleratedNodeEvents"], 2)
            self.assertEqual(summary["cpuNodeEvents"], 0)
            self.assertTrue(summary["proven"])

            profile.write_text(
                json.dumps(
                    [
                        {"args": {"provider": "DmlExecutionProvider"}},
                        {"args": {"provider": "CPUExecutionProvider"}},
                    ]
                ),
                encoding="utf-8",
            )
            fallback = summarize_profiles([profile], "DmlExecutionProvider")
            self.assertFalse(fallback["proven"])

    def test_profile_summary_rejects_unbounded_or_invalid_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / "profile.json"
            profile.write_text("{}", encoding="utf-8")
            with self.assertRaises(QualificationError):
                summarize_profiles([profile], "DmlExecutionProvider")

    def test_private_report_is_exclusive_and_owner_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "qualification.json"
            write_private_report(report, {"status": "PASS"})
            self.assertEqual(
                json.loads(report.read_text(encoding="utf-8")),
                {"status": "PASS"},
            )
            if os.name != "nt":
                self.assertEqual(report.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(QualificationError):
                write_private_report(report, {"status": "PASS"})


if __name__ == "__main__":
    unittest.main()
