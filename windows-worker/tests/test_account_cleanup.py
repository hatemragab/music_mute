import tempfile
import unittest
from pathlib import Path
from uuid import uuid4
from unittest.mock import Mock

from musicmute_worker.config import Config
from musicmute_worker.transport import ApiError
from musicmute_worker.worker import Worker


class AccountCleanupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        separator = self.root / "separator.py"
        separator.write_text("# fixture")
        self.config = Config("https://fixture.invalid/api/v1", self.root / "state", separator)
        self.assignment = {"jobId": "a" * 24, "attemptId": str(uuid4()), "sessionId": str(uuid4()), "generation": 1}

    def test_each_terminal_status_purges_files_before_acknowledging(self):
        for status in ("ready", "failed", "cancelled"):
            with self.subTest(status=status):
                directory = self.config.state_dir / "jobs" / self.assignment["jobId"] / "revision"
                directory.mkdir(parents=True, exist_ok=True)
                (directory / "vocals.mp3").write_bytes(b"owned")
                api = Mock()
                def acknowledge(route, body):
                    self.assertEqual(route, "local-cleanup")
                    self.assertFalse(directory.exists())
                    self.assertTrue(body["localDataDeleted"])
                    return {"status": "cleaned"}
                api.post.side_effect = acknowledge
                worker = Worker(self.config, api, Mock())
                worker.journal.save(self.assignment)
                worker._finish_cleanup(self.assignment, status)
                self.assertIsNone(worker.journal.active)

    def test_lost_ack_response_retries_after_restart_before_claim(self):
        api = Mock()
        api.post.side_effect = ApiError(503, "UNAVAILABLE")
        worker = Worker(self.config, api, Mock())
        worker.journal.save(self.assignment)
        with self.assertRaises(ApiError):
            worker._finish_cleanup(self.assignment, "cancelled")
        self.assertIsNotNone(worker.journal.active)
        restarted_api = Mock()
        restarted_api.post.return_value = {"status": "cleaned"}
        restarted = Worker(self.config, restarted_api, Mock())
        self.assertEqual(restarted._assignment(), {"status": "cancelled"})
        self.assertEqual(restarted_api.post.call_args.args[0], "local-cleanup")
        self.assertIsNone(restarted.journal.active)

    def test_filesystem_failure_never_acknowledges_or_clears_intent(self):
        api = Mock()
        worker = Worker(self.config, api, Mock())
        worker.journal.save(self.assignment)
        worker.progress.purge_job = Mock(side_effect=OSError("fixture denied"))
        with self.assertRaises(OSError):
            worker._finish_cleanup(self.assignment, "failed")
        api.post.assert_not_called()
        self.assertIsNotNone(worker.journal.active)
