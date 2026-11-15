from __future__ import annotations

import json
import os
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

from musicmute_engine.qualification import (
    QualificationError,
    summarize_profiles,
    selected_recipe_ids,
    write_private_report,
)


class QualificationTests(unittest.TestCase):
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
