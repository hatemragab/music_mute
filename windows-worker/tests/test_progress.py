import base64
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

from musicmute_worker.progress import Progress
from musicmute_worker.config import Config
from musicmute_worker.worker import Journal, Worker


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


class InstallationBindingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state = self.root / "state"
        self.separator = self.root / "separate.py"
        self.separator.write_text("# processor\n")
        self.config = Config(
            "https://api.example.com/api/v1", self.state, self.separator
        )

    def test_legacy_session_and_journal_are_bound_without_being_rewritten(self):
        self.state.mkdir()
        session = str(uuid4())
        (self.state / "session.json").write_text(json.dumps(session))
        journal = Journal(self.state)
        journal.save(
            {
                "jobId": "a" * 24,
                "attemptId": str(uuid4()),
                "sessionId": session,
                "generation": 1,
            }
        )
        session_before = (self.state / "session.json").read_bytes()
        journal_before = (self.state / "active.json").read_bytes()

        Worker(self.config, object(), object())

        self.assertEqual((self.state / "session.json").read_bytes(), session_before)
        self.assertEqual((self.state / "active.json").read_bytes(), journal_before)
        self.assertTrue(
            (self.state / "installation.json").exists(),
            "legacy state was not bound to an installation identity",
        )
        self.assertEqual(
            json.loads((self.state / "installation.json").read_text()),
            {
                "version": 1,
                "apiBaseUrl": "https://api.example.com/api/v1",
                "workerId": "z440",
            },
        )

    def test_active_journal_identity_change_fails_without_mutating_state(self):
        self.state.mkdir()
        session = str(uuid4())
        (self.state / "session.json").write_text(json.dumps(session))
        (self.state / "installation.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "apiBaseUrl": "https://api.example.com/api/v1",
                    "workerId": "z440",
                }
            )
        )
        journal = Journal(self.state)
        journal.save(
            {
                "jobId": "a" * 24,
                "attemptId": str(uuid4()),
                "sessionId": session,
                "generation": 1,
            }
        )
        before = {
            path.name: path.read_bytes()
            for path in self.state.iterdir()
            if path.is_file()
        }
        try:
            changed = Config(
                self.config.api_base_url,
                self.config.state_dir,
                self.config.separator,
                worker_id="gpu-02",
            )
        except TypeError as error:
            self.fail(f"Config does not support installation identity: {error}")

        with self.assertRaisesRegex(RuntimeError, "identity"):
            Worker(changed, object(), object())

        self.assertEqual(
            {
                path.name: path.read_bytes()
                for path in self.state.iterdir()
                if path.is_file()
            },
            before,
        )

    def test_legacy_active_journal_without_binding_rejects_non_z440_transition(self):
        self.state.mkdir()
        session = str(uuid4())
        (self.state / "session.json").write_text(json.dumps(session))
        journal = Journal(self.state)
        journal.save(
            {
                "jobId": "a" * 24,
                "attemptId": str(uuid4()),
                "sessionId": session,
                "generation": 1,
            }
        )
        before = {
            path.name: path.read_bytes()
            for path in self.state.iterdir()
            if path.is_file()
        }
        changed = Config(
            self.config.api_base_url,
            self.config.state_dir,
            self.config.separator,
            worker_id="gpu-02",
        )

        with self.assertRaisesRegex(RuntimeError, "identity"):
            Worker(changed, object(), object())

        self.assertFalse((self.state / "installation.json").exists())
        self.assertEqual(
            {
                path.name: path.read_bytes()
                for path in self.state.iterdir()
                if path.is_file()
            },
            before,
        )


if __name__ == "__main__":
    unittest.main()
