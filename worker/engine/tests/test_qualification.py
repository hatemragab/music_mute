from __future__ import annotations

import json
import os
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

from musicmute_engine.qualification import (
    QualificationError,
    summarize_profiles,
    selected_recipe_ids,
    run_qualification,
    main,
    write_private_report,
)


class QualificationTests(unittest.TestCase):
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
