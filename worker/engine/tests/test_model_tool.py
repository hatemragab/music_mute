from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from musicmute_engine import model_tool


class ModelToolTests(unittest.TestCase):
    def test_success_output_contains_only_verified_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.onnx"
            cache = Path(directory) / "cache"
            installed = cache / "digest" / "Kim_Vocal_2.onnx"
            output = io.StringIO()
            with (
                mock.patch(
                    "sys.argv",
                    [
                        "model_tool",
                        "--source",
                        str(source),
                        "--model-cache",
                        str(cache),
                    ],
                ),
                mock.patch(
                    "musicmute_engine.model_tool.install_model_from_file",
                    return_value=installed,
                ),
                redirect_stdout(output),
            ):
                self.assertEqual(model_tool.main(), 0)
            result = json.loads(output.getvalue())
            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["modelPath"], str(installed))
            self.assertEqual(set(result), {"status", "modelSha256", "modelBytes", "modelPath"})


if __name__ == "__main__":
    unittest.main()
