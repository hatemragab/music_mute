import base64
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

from musicmute_worker.progress import Progress
from worker_test_support import config as Config
from musicmute_worker.worker import Journal
from worker_test_support import SyntheticQualifiedWorker as Worker


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.separator = self.root / "separate.py"
        self.separator.write_text("# processor\n")
        self.assignment = {
            "jobId": "a" * 24,
            "input": {
                "extension": "mp3",
                "bytes": 3,
                "sha256": base64.b64encode(hashlib.sha256(b"abc").digest()).decode(),
                "download": {"url": "https://private-signed-url"},
            },
        }
        self.progress = Progress(self.root / "state", self.separator)
        self.progress.bind(self.assignment)

    def record_result(self):
        result = self.progress.work / "voice.mp3"
        result.write_bytes(b"result")
        self.progress.data["inputDurationSeconds"] = 3.0
        self.progress.record("output", result, 2.0)
        return result

    def test_only_matching_job_input_and_processor_can_reuse_output(self):
        result = self.record_result()
        fresh = Progress(self.root / "state", self.separator)
        fresh.bind(self.assignment)
        self.assertEqual(fresh.artifact("output"), result)
        self.separator.write_text("# upgraded processor\n")
        fresh.bind(self.assignment)
        self.assertIsNone(fresh.artifact("output"))

    def test_input_identity_change_invalidates_output(self):
        self.record_result()
        self.assignment["input"]["sha256"] = base64.b64encode(
            hashlib.sha256(b"xyz").digest()
        ).decode()
        self.progress.bind(self.assignment)
        self.assertIsNone(self.progress.artifact("output"))

    def test_corrupt_output_is_not_reused(self):
        result = self.record_result()
        result.write_bytes(b"broken")
        self.assertIsNone(self.progress.artifact("output"))

    def test_checkpoint_contains_no_signed_grants(self):
        self.record_result()
        text = self.progress.path.read_text()
        self.assertNotIn("https://", text)
        self.assertNotIn("download", text.replace("downloadAttempts", ""))

    def test_untrusted_paths_are_rejected_before_reading_artifacts(self):
        self.record_result()
        data = json.loads(self.progress.path.read_text())
        data["output"]["file"] = "../../../../outside.mp3"
        self.progress.path.write_text(json.dumps(data))
        with self.assertRaisesRegex(
            RuntimeError, "Invalid local processing checkpoint"
        ):
            Progress(self.root / "state", self.separator)

    def test_symlinked_output_is_rejected(self):
        result = self.record_result()
        external = self.root / "outside.mp3"
        external.write_bytes(result.read_bytes())
        result.unlink()
        try:
            result.symlink_to(external)
        except OSError:
            self.skipTest("Symlink creation requires platform privileges")
        with self.assertRaisesRegex(ValueError, "symbolic"):
            self.progress.artifact("output")

    def test_purge_job_removes_all_processor_versions_and_preserves_foreign_job(self):
        self.record_result()
        first = self.progress.work
        self.separator.write_text("# changed processor")
        self.progress.bind(self.assignment)
        second = self.progress.work
        foreign = self.progress.root / "jobs" / ("b" * 24)
        foreign.mkdir(parents=True)
        (foreign / "keep.mp3").write_bytes(b"keep")
        self.progress.purge_job(self.assignment["jobId"])
        self.assertFalse(first.exists())
        self.assertFalse(second.exists())
        self.assertTrue((foreign / "keep.mp3").exists())
        self.assertIsNone(self.progress.data)

    def test_purge_job_rejects_untrusted_identity(self):
        with self.assertRaises(ValueError):
            self.progress.purge_job("../outside")

    def test_invalid_retry_counters_fail_closed(self):
        data = json.loads(self.progress.path.read_text())
        data["uploadAttempts"] = -1
        self.progress.path.write_text(json.dumps(data))
        with self.assertRaisesRegex(
            RuntimeError, "Invalid local processing checkpoint"
        ):
            Progress(self.root / "state", self.separator)
