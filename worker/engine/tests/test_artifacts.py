from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from musicmute_engine import artifacts


class ModelArtifactTests(unittest.TestCase):
    def test_file_install_is_content_addressed_and_reverified(self) -> None:
        payload = b"qualified-model-fixture"
        digest = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.onnx"
            source.write_bytes(payload)
            cache = root / "cache"
            with (
                patch.object(artifacts, "MODEL_BYTES", len(payload)),
                patch.object(artifacts, "MODEL_SHA256", digest),
            ):
                installed = artifacts.install_model_from_file(source, cache)
                self.assertEqual(
                    installed,
                    (cache / digest / artifacts.MODEL_FILENAME).resolve(strict=True),
                )
                self.assertEqual(artifacts.verified_cached_model(cache), installed)
                installed.write_bytes(b"tampered")
                with self.assertRaises(artifacts.ModelArtifactError):
                    artifacts.verified_cached_model(cache)

    def test_noncanonical_download_url_is_rejected_before_network_access(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(artifacts.ModelArtifactError):
                artifacts.download_model(
                    Path(directory), source_url="https://example.invalid/model.onnx"
                )


if __name__ == "__main__":
    unittest.main()
