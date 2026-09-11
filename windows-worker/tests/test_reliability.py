"""Behavioral network recovery tests using real FFmpeg and isolated local files."""

import json
import shutil
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import test_worker as fixtures
from musicmute_worker import config as worker_config
from musicmute_worker.processes import ContainmentError, SingleInstance
from musicmute_worker.transport import ApiError, TransferError
from musicmute_worker.worker import Cancelled, Journal, LeaseLost, Stopping, Worker


class ConfigurationLockTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(fixtures.ProcessTestIsolation())
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "worker.config.example.json").write_text(
            json.dumps(
                {
                    "api_base_url": "https://YOUR-API-HOST/api/v1",
                    "state_dir": "state",
                    "separator": "separate.py",
                }
            )
        )

    def configure(self, api_base_url, worker_id):
        configure = getattr(worker_config, "configure_installation", None)
        self.assertIsNotNone(
            configure,
            "setup has no persistence entry point protected by the worker lock",
        )
        return configure(self.root, api_base_url, worker_id)

    def test_setup_refuses_configuration_write_while_worker_lock_is_held(self):
        config_path = self.root / "worker.config.json"
        config_path.write_text(
            json.dumps(
                {
                    "api_base_url": "https://old.example/api/v1",
                    "worker_id": "z440",
                    "state_dir": "state",
                    "separator": "separate.py",
                }
            )
        )
        before = config_path.read_bytes()

        with SingleInstance(self.root / "state"), self.assertRaisesRegex(
            RuntimeError, "running"
        ):
            self.configure("https://new.example/api/v1", "gpu-02")

        self.assertEqual(config_path.read_bytes(), before)
        self.assertFalse((self.root / "state" / "installation.json").exists())

    def test_setup_persists_a_normal_first_machine_configuration(self):
        self.configure("https://api.example/api/v1", "gpu-02")

        self.assertEqual(
            json.loads((self.root / "worker.config.json").read_text())["worker_id"],
            "gpu-02",
        )
        self.assertEqual(
            json.loads(
                (self.root / "state" / "installation.json").read_text()
            ),
            {
                "version": 1,
                "apiBaseUrl": "https://api.example/api/v1",
                "workerId": "gpu-02",
            },
        )

    def test_setup_creates_state_directory_with_a_mutex_only_windows_lock(self):
        lock_entered = []

        class MutexOnlyLock:
            def __init__(self, _state_dir):
                pass

            def __enter__(self):
                lock_entered.append(True)
                return self

            def __exit__(self, *_args):
                return False

        with patch("musicmute_worker.processes.SingleInstance", MutexOnlyLock):
            try:
                self.configure("https://api.example/api/v1", "gpu-02")
            except FileNotFoundError as error:
                self.fail(f"fresh Windows setup did not create its state directory: {error}")

        self.assertEqual(lock_entered, [True])
        self.assertTrue((self.root / "state").is_dir())
        self.assertEqual(
            json.loads(
                (self.root / "state" / "installation.json").read_text()
            )["workerId"],
            "gpu-02",
        )


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required"
)
class ReliabilityTests(unittest.TestCase):
    setUp = fixtures.WorkerTests.setUp

    def test_unverified_process_stop_preserves_lease_for_recovery(self):
        worker = Worker(self.config, self.api, self.transfers)
        with (
            patch(
                "musicmute_worker.worker.ProcessRunner.run",
                side_effect=ContainmentError(
                    "Child process termination could not be verified"
                ),
            ),
            self.assertRaises(ContainmentError),
        ):
            worker.run_once()
        self.assertFalse(
            {"fail", "cancel", "complete"}.intersection(r for r, _ in self.api.calls)
        )
        self.assertIsNotNone(Journal(self.config.state_dir).active)

    def test_transient_download_retries_before_processing(self):
        original = self.transfers.download
        attempts = []

        def download(*args):
            attempts.append(1)
            if len(attempts) < 3:
                raise TransferError("DOWNLOAD_FAILED", retryable=True)
            return original(*args)

        self.transfers.download = download
        with patch("musicmute_worker.worker.wait_checked"):
            self.assertEqual(
                Worker(self.config, self.api, self.transfers).run_once(), "ready"
            )
        self.assertEqual(len(attempts), 3)
        self.assertNotIn("fail", [r for r, _ in self.api.calls])

    def test_ambiguous_upload_already_in_storage_completes_without_reupload(self):
        attempts = []

        def upload(*args):
            attempts.append(1)
            raise TransferError("OUTPUT_UPLOAD_FAILED", uncertain=True, retryable=True)

        self.transfers.upload = upload
        self.assertEqual(
            Worker(self.config, self.api, self.transfers).run_once(), "ready"
        )
        self.assertEqual(len(attempts), 1)

    def test_missing_upload_retries_same_finished_file(self):
        original_post = self.api.post
        original_upload = self.transfers.upload
        paths = []

        def post(route, body):
            if route == "complete" and len(paths) == 1:
                raise ApiError(409, "UPLOAD_NOT_READY")
            return original_post(route, body)

        def upload(grant, path, check):
            paths.append(path)
            if len(paths) == 1:
                raise TransferError(
                    "OUTPUT_UPLOAD_FAILED", uncertain=True, retryable=True
                )
            return original_upload(grant, path, check)

        self.api.post = post
        self.transfers.upload = upload
        with patch("musicmute_worker.worker.wait_checked"):
            self.assertEqual(
                Worker(self.config, self.api, self.transfers).run_once(), "ready"
            )
        self.assertEqual(paths[0], paths[1])
        self.assertEqual([r for r, _ in self.api.calls].count("stage"), 1)

    def test_restart_reuses_finished_result_after_backend_reassignment(self):
        original_post = self.api.post
        original_upload = self.transfers.upload

        def post(route, body):
            if route == "complete":
                raise ApiError(0)
            return original_post(route, body)

        def upload(*args):
            raise TransferError("OUTPUT_UPLOAD_FAILED", uncertain=True, retryable=True)

        self.api.post = post
        self.transfers.upload = upload
        with (
            patch("musicmute_worker.worker.wait_checked"),
            self.assertRaises((ApiError, LeaseLost)),
        ):
            Worker(self.config, self.api, self.transfers).run_once()
        self.assertIsNotNone(Journal(self.config.state_dir).active)
        self.api.assignment["attemptId"] = str(uuid4())
        self.api.assignment["generation"] += 1
        self.api.post = original_post
        self.transfers.upload = original_upload
        with patch.object(
            self.transfers, "download", side_effect=AssertionError("must reuse output")
        ):
            self.assertEqual(
                Worker(self.config, self.api, self.transfers).run_once(), "ready"
            )
        checkpoint_text = (self.config.state_dir / "progress.json").read_text()
        self.assertNotIn("https://", checkpoint_text)

    def test_retry_budget_survives_restarts(self):
        self.config = replace(self.config, transfer_attempts=2)
        attempts = []

        def download(*args):
            attempts.append(1)
            if len(attempts) == 1:
                raise Stopping()
            raise TransferError("DOWNLOAD_FAILED", retryable=True)

        self.transfers.download = download
        with self.assertRaises(Stopping):
            Worker(self.config, self.api, self.transfers).run_once()
        with patch("musicmute_worker.worker.wait_checked"):
            self.assertEqual(
                Worker(self.config, self.api, self.transfers).run_once(), "failed"
            )
        self.assertEqual(len(attempts), 2)
        self.assertEqual(
            next(b for r, b in self.api.calls if r == "fail")["code"], "DOWNLOAD_FAILED"
        )

    def test_cancel_during_backoff_acknowledges_without_another_transfer(self):
        attempts = []

        def download(*args):
            attempts.append(1)
            raise TransferError("DOWNLOAD_FAILED", retryable=True)

        self.transfers.download = download
        with patch("musicmute_worker.worker.wait_checked", side_effect=Cancelled):
            self.assertEqual(
                Worker(self.config, self.api, self.transfers).run_once(), "cancelled"
            )
        self.assertEqual(len(attempts), 1)

    def test_linked_output_parent_is_rejected_before_separator_writes(self):
        worker = Worker(self.config, self.api, self.transfers)
        worker.progress.bind(self.api.assignment)
        outside = self.config.state_dir.parent / "outside"
        outside.mkdir()
        try:
            (worker.progress.work / "outputs").symlink_to(
                outside, target_is_directory=True
            )
        except OSError:
            self.skipTest("Symlink creation requires platform privileges")
        with self.assertRaisesRegex(ValueError, "symbolic|escaped"):
            worker.run_once()
        self.assertEqual(list(outside.iterdir()), [])

    def test_installation_session_survives_process_restart(self):
        first = Worker(self.config, self.api, self.transfers)
        second = Worker(self.config, self.api, self.transfers)
        self.assertEqual(first.session, second.session)

    def test_lost_claim_response_can_recover_only_backend_confirmed_session(self):
        original = self.api.post
        previous = self.api.assignment["attemptId"]

        def post(route, body):
            if route == "claim":
                raise ApiError(
                    409, "WORKER_RECOVERY_REQUIRED", previous, can_recover=True
                )
            return original(route, body)

        self.api.post = post
        self.assertEqual(
            Worker(self.config, self.api, self.transfers).run_once(), "ready"
        )
        reconcile = next(b for r, b in self.api.calls if r == "reconcile")
        self.assertEqual(reconcile["previousAttemptId"], previous)
        self.assertTrue(reconcile["stopped"])

    def test_foreign_assignment_cannot_be_recovered_without_a_journal(self):
        original = self.api.post

        def post(route, body):
            if route == "identity":
                return original(route, body)
            raise ApiError(
                409, "WORKER_RECOVERY_REQUIRED", str(uuid4()), can_recover=False
            )

        self.api.post = post
        with self.assertRaisesRegex(RuntimeError, "no saved assignment"):
            Worker(self.config, self.api, self.transfers).run_once()

    def test_non_cancelled_release_clears_only_assignment_and_retains_media(self):
        worker = Worker(self.config, self.api, self.transfers)
        worker.journal.save(self.api.assignment)
        worker.progress.bind(self.api.assignment)
        retained = worker.progress.work / "retained.mp3"
        retained.write_bytes(b"retained media")
        previous = self.api.assignment["attemptId"]
        original = self.api.post

        def post(route, body):
            if route == "reconcile":
                self.api.calls.append((route, body.copy()))
                return {"status": "released", "previousAttemptId": previous}
            return original(route, body)

        self.api.post = post
        try:
            outcome = worker.run_once()
        except Exception as error:  # expected RED must report a behavior failure
            outcome = type(error).__name__

        self.assertEqual(outcome, "idle")
        self.assertIsNone(Journal(self.config.state_dir).active)
        self.assertTrue(retained.exists())
        self.assertIsNotNone(worker.progress.data)
        self.assertNotIn("local-cleanup", [route for route, _ in self.api.calls])

    def test_lost_claim_release_returns_idle_without_inventing_a_journal(self):
        previous = self.api.assignment["attemptId"]
        original = self.api.post

        def post(route, body):
            if route == "claim":
                self.api.calls.append((route, body.copy()))
                raise ApiError(
                    409, "WORKER_RECOVERY_REQUIRED", previous, can_recover=True
                )
            if route == "reconcile":
                self.api.calls.append((route, body.copy()))
                return {"status": "released", "previousAttemptId": previous}
            return original(route, body)

        self.api.post = post
        worker = Worker(self.config, self.api, self.transfers)

        try:
            outcome = worker.run_once()
        except RuntimeError as error:
            outcome = str(error)
        self.assertEqual(outcome, "idle")
        self.assertIsNone(Journal(self.config.state_dir).active)
        self.assertNotIn("local-cleanup", [route for route, _ in self.api.calls])

    def test_cancelled_recovery_keeps_terminal_cleanup_semantics(self):
        worker = Worker(self.config, self.api, self.transfers)
        worker.journal.save(self.api.assignment)
        worker.progress.bind(self.api.assignment)
        retained = worker.progress.work / "cancelled.mp3"
        retained.write_bytes(b"cancelled media")
        original = self.api.post

        def post(route, body):
            if route == "reconcile":
                self.api.calls.append((route, body.copy()))
                return {"status": "cancelled"}
            return original(route, body)

        self.api.post = post
        self.assertEqual(worker.run_once(), "cancelled")
        self.assertIsNone(Journal(self.config.state_dir).active)
        self.assertFalse(retained.exists())
        self.assertIsNone(worker.progress.data)
        self.assertIn("local-cleanup", [route for route, _ in self.api.calls])


if __name__ == "__main__":
    unittest.main()
