import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from uuid import uuid4

from musicmute_worker.profiles import PreparedRuntime, ProfileError
from musicmute_worker.transport import ApiError
from musicmute_worker.worker import Worker
from worker_test_support import config


class RuntimeClaimTests(unittest.TestCase):
    def test_rejected_long_poll_does_not_retry_an_older_request_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            api = Mock()
            error = ApiError(400, "INVALID_INPUT")
            api.post.side_effect = [error, None]
            worker = Worker(
                config(
                    "https://api.example.com/api/v1",
                    root / "state",
                    root / "separator.py",
                ),
                api,
                Mock(),
                runtime=Mock(spec=PreparedRuntime),
            )
            with self.assertRaises(ApiError) as raised:
                worker._claim(wait_seconds=25)
            self.assertIs(raised.exception, error)
            api.post.assert_called_once_with(
                "claim", {"sessionId": worker.session, "waitSeconds": 25}
            )

    def test_recovered_attempt_is_journaled_without_lease_or_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owned = {
                "jobId": "a" * 24,
                "attemptId": str(uuid4()),
                "generation": 1,
                "status": "validating",
            }
            api = Mock()
            api.post.return_value = owned
            transfers = Mock()
            worker = Worker(
                config(
                    "https://api.example.com/api/v1",
                    root / "state",
                    root / "separator.py",
                ),
                api,
                transfers,
            )
            owned["sessionId"] = worker.session
            worker._verify_identity = Mock()
            worker._recovered = True
            with (
                patch("musicmute_worker.worker.ProcessRunner"),
                patch("musicmute_worker.worker.Lease") as lease,
            ):
                with self.assertRaises(ProfileError):
                    worker.run_once()
                lease.assert_not_called()
            self.assertEqual(worker.journal.active["attemptId"], owned["attemptId"])
            self.assertEqual(transfers.mock_calls, [])
            api.post.assert_called_once_with(
                "claim/recovery", {"sessionId": worker.session}
            )

    def test_missing_runtime_never_sends_fresh_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            api = Mock()
            api.post.return_value = None
            worker = Worker(
                config(
                    "https://api.example.com/api/v1",
                    root / "state",
                    root / "separator.py",
                ),
                api,
                Mock(),
            )
            with self.assertRaises(ProfileError):
                worker._claim()
            api.post.assert_called_once_with(
                "claim/recovery", {"sessionId": worker.session}
            )

    def test_failed_qualification_never_sends_fresh_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            api = Mock()
            api.post.return_value = None
            runtime = Mock(spec=PreparedRuntime)
            runtime.assert_claim_ready.side_effect = ProfileError(
                "GPU_QUALIFICATION_FAILED"
            )
            worker = Worker(
                config(
                    "https://api.example.com/api/v1",
                    root / "state",
                    root / "separator.py",
                ),
                api,
                Mock(),
                runtime=runtime,
            )
            with self.assertRaises(ProfileError):
                worker._claim()
            api.post.assert_called_once_with(
                "claim/recovery", {"sessionId": worker.session}
            )

    def test_unqualified_runtime_can_discover_owned_attempt_without_new_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owned = {"attemptId": "owned-fixture"}
            api = Mock()
            api.post.return_value = owned
            worker = Worker(
                config(
                    "https://api.example.com/api/v1",
                    root / "state",
                    root / "separator.py",
                ),
                api,
                Mock(),
            )
            self.assertEqual(worker._claim(wait_seconds=25), owned)
            api.post.assert_called_once_with(
                "claim/recovery", {"sessionId": worker.session}
            )

    def test_persistent_update_hold_discovers_only_owned_work(self):
        from musicmute_worker.update.journal import ClaimHold, DurableRecords

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            cfg = config(
                "https://api.example.com/api/v1",
                root / "journals",
                root / "separator.py",
            )
            records = DurableRecords(cfg.paths.state / "updates")
            ClaimHold(records).set(True)
            api = Mock()
            api.post.return_value = None
            worker = Worker(cfg, api, Mock(), runtime=Mock(spec=PreparedRuntime))
            self.assertIsNone(worker._claim(wait_seconds=25))
            api.post.assert_called_once_with(
                "claim/recovery", {"sessionId": worker.session}
            )
            boundary = worker.update_boundary()
            self.assertTrue(boundary.ownership_resolved)
            self.assertTrue(boundary.terminal)
            self.assertTrue(boundary.cleanup_acknowledged)
            self.assertFalse(boundary.descendants_stopped)
            api.post.side_effect = OSError("offline")
            with self.assertRaises(OSError):
                worker._claim()
            self.assertFalse(worker.update_boundary().ownership_resolved)

    def test_update_hold_does_not_bypass_terminal_cleanup(self):
        from musicmute_worker.update.journal import ClaimHold, DurableRecords

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            cfg = config(
                "https://api.example.com/api/v1",
                root / "journals",
                root / "separator.py",
            )
            records = DurableRecords(cfg.paths.state / "updates")
            ClaimHold(records).set(True)
            worker = Worker(cfg, Mock(), Mock())
            worker._resume_cleanup = Mock(return_value={"status": "ready"})
            worker._claim = Mock(side_effect=AssertionError("claim before cleanup"))
            self.assertEqual(worker._assignment(), {"status": "ready"})
            worker._resume_cleanup.assert_called_once()
            worker._claim.assert_not_called()
