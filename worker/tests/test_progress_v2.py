import base64
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from musicmute_worker.progress import Progress
from test_media_limits import version_two_limits


class VersionedCheckpointTests(unittest.TestCase):
    def test_changed_runtime_identity_invalidates_reused_artifacts(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            separator = root / "separate.py"
            separator.write_text("# synthetic separator")
            assignment = {
                "jobId": "a" * 24,
                "input": {
                    "extension": "mp3",
                    "bytes": 3,
                    "sha256": base64.b64encode(
                        hashlib.sha256(b"abc").digest()
                    ).decode(),
                },
            }
            runtime = Mock()
            identity = {
                "model": "a" * 64,
                "fixture": "b" * 64,
                "runtimeLock": "c" * 64,
                "provider": "CoreMLExecutionProvider",
                "versions": {"numpy": "2.5.3"},
            }
            runtime.fingerprint.return_value = identity
            progress = Progress(root / "state", separator, runtime)
            progress.bind(assignment)
            original = progress.data["fingerprint"]
            for key in identity:
                runtime.fingerprint.return_value = {**identity, key: "changed"}
                progress.bind(assignment)
                self.assertNotEqual(progress.data["fingerprint"], original, key)

    def test_thirty_minute_checkpoint_restores_only_for_same_accepted_limits(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            separator = root / "separate.py"
            separator.write_text("# synthetic separator")
            assignment = {
                "jobId": "a" * 24,
                "input": {
                    "extension": "mp3",
                    "bytes": 3,
                    "sha256": base64.b64encode(
                        hashlib.sha256(b"abc").digest()
                    ).decode(),
                },
                "processingLimits": version_two_limits(),
            }
            progress = Progress(root / "state", separator)
            progress.bind(assignment)
            artifact = progress.work / "prepared.wav"
            artifact.write_bytes(b"synthetic prepared artifact")
            try:
                progress.record("prepared", artifact, 1800)
            except ValueError:
                self.fail("Version 2 checkpoint incorrectly rejects 30-minute duration")
            restored = Progress(root / "state", separator)
            restored.bind(assignment)
            self.assertEqual(restored.artifact("prepared"), artifact)
            restored.bind(
                {
                    **assignment,
                    "processingLimits": version_two_limits(maxDurationSeconds=900),
                }
            )
            self.assertIsNone(restored.artifact("prepared"))


if __name__ == "__main__":
    unittest.main()
