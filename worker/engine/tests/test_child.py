from __future__ import annotations

import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from musicmute_engine.child import parse_args, run


class ChildArgumentsTests(unittest.TestCase):
    def test_preloads_before_announcing_ready(self) -> None:
        events: list[str] = []

        class FakePipeline:
            def preload(self, *_arguments: object) -> None:
                events.append("preload")

        def record_frame(_output: object, frame: dict[str, object]) -> None:
            events.append(str(frame["type"]))

        with (
            patch(
                "musicmute_engine.child.RuntimePipeline",
                return_value=FakePipeline(),
            ),
            patch(
                "musicmute_engine.child.sys.stdin",
                SimpleNamespace(buffer=BytesIO()),
            ),
            patch(
                "musicmute_engine.child.isolate_protocol_output",
                return_value=BytesIO(),
            ),
            patch("musicmute_engine.child.write_frame", side_effect=record_frame),
            patch("musicmute_engine.child.read_frame", return_value=None),
        ):
            result = run(
                "00000000-0000-4000-8000-000000000001",
                model_cache_root=Path("/var/lib/musicmute/models"),
                provider="mps",
            )

        self.assertEqual(result, 0)
        self.assertEqual(events, ["preload", "ready"])

    def test_accepts_complete_preload_configuration(self) -> None:
        arguments = parse_args(
            [
                "--incarnation",
                "00000000-0000-4000-8000-000000000001",
                "--model-cache-root",
                "/var/lib/musicmute/models",
                "--provider",
                "mps",
            ]
        )

        self.assertEqual(
            str(arguments.model_cache_root), "/var/lib/musicmute/models"
        )
        self.assertEqual(arguments.provider, "mps")
        self.assertEqual(arguments.directml_device_id, 0)

    def test_rejects_partial_preload_configuration(self) -> None:
        with self.assertRaises(SystemExit):
            parse_args(
                [
                    "--incarnation",
                    "00000000-0000-4000-8000-000000000001",
                    "--provider",
                    "mps",
                ]
            )


if __name__ == "__main__":
    unittest.main()
