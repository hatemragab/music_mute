import base64
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from worker_test_support import config as Config
from musicmute_worker.processes import ProcessRunner
from musicmute_worker.transport import ApiError, TransferError
from musicmute_worker.worker import Cancelled, Journal, Lease, LeaseLost
from worker_test_support import SyntheticQualifiedWorker as Worker
from process_test_support import ProcessTestIsolation


def expires():
    return (datetime.now(timezone.utc) + timedelta(seconds=90)).isoformat()


class FakeApi:
    def __init__(self, source):
        self.calls = []
        self.cancel = False
        self.identity_worker_id = "fixture-worker"
        self.assignment = {
            "jobId": "a" * 24,
            "attemptId": str(uuid4()),
            "sessionId": str(uuid4()),
            "generation": 1,
            "status": "validating",
            "cancelRequested": False,
            "leaseExpiresAt": expires(),
            "input": {
                "extension": "mp3",
                "bytes": source.stat().st_size,
                "sha256": base64.b64encode(
                    hashlib.sha256(source.read_bytes()).digest()
                ).decode(),
                "durationSeconds": 1,
                "download": {"url": "https://storage.example/input"},
            },
        }

    def post(self, route, body):
        self.calls.append((route, body.copy()))
        if route == "identity":
            return {
                "workerId": self.identity_worker_id,
                "installationId": "11111111-1111-4111-8111-111111111111",
                "state": "enabled",
                "protocolVersion": 3,
            }
        if route in ("claim", "reconcile"):
            self.assignment["sessionId"] = body["sessionId"]
            return self.assignment.copy()
        if route == "heartbeat":
            return {
                "leaseExpiresAt": expires(),
                "cancelRequested": self.cancel,
                "status": "processing",
            }
        if route == "output-url":
            return {
                "upload": {
                    "method": "PUT",
                    "url": "https://storage.example/output",
                    "headers": {
                        "Content-Type": "audio/mpeg",
                        "x-amz-checksum-sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                        "If-None-Match": "*",
                    },
                }
            }
        return {
            "status": {
                "complete": "ready",
                "local-cleanup": "cleaned",
                "cancelled": "cancelled",
                "fail": "failed",
            }.get(route, "processing")
        }


class FakeTransfers:
    def __init__(self, source):
        self.source = source
        self.uploaded = None

    def download(self, grant, path, size, checksum, check):
        check()
        shutil.copyfile(self.source, path)

    def upload(self, grant, path, check):
        check()
        self.uploaded = path.read_bytes()


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required"
)
class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.process_isolation = self.enterContext(ProcessTestIsolation())
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.source = root / "source.mp3"
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                str(self.source),
            ],
            check=True,
        )
        self.separator = root / "separate.py"
        self.separator.write_text(
            "import argparse, pathlib, subprocess\n"
            "p=argparse.ArgumentParser(); p.add_argument('input'); p.add_argument('--prepared', action='store_true'); p.add_argument('--output_dir'); p.add_argument('--model-dir'); a=p.parse_args()\n"
            "o=pathlib.Path(a.output_dir); o.mkdir(parents=True,exist_ok=True)\n"
            "subprocess.run(['ffmpeg','-v','error','-i',a.input,'-t','0.5',str(o/'vocals.mp3')],check=True)\n"
        )
        self.config = Config(
            "https://api.example.com/api/v1",
            root / "state",
            self.separator,
            reuse_separator=False,
        )
        self.api = FakeApi(self.source)
        self.transfers = FakeTransfers(self.source)

    def test_job_runs_real_ffmpeg_and_reserves_actual_trimmed_duration(self):
        worker = Worker(self.config, self.api, self.transfers)
        self.assertEqual(worker.run_once(), "ready")
        routes = [r for r, _ in self.api.calls if r != "heartbeat"]
        self.assertEqual(
            routes,
            ["identity", "claim", "stage", "output-url", "complete", "local-cleanup"],
        )
        reserved = next(body for route, body in self.api.calls if route == "output-url")
        self.assertLess(reserved["durationSeconds"], 0.8)
        self.assertEqual(
            reserved["sha256"],
            base64.b64encode(hashlib.sha256(self.transfers.uploaded).digest()).decode(),
        )
        self.assertIsNone(Journal(self.config.state_dir).active)

    def test_cancelled_assignment_never_starts_separator(self):
        self.api.assignment["cancelRequested"] = True
        worker = Worker(self.config, self.api, self.transfers)
        self.assertEqual(worker.run_once(), "cancelled")
        self.assertNotIn("stage", [r for r, _ in self.api.calls])
        self.assertIsNone(self.transfers.uploaded)

    def test_media_policy_negotiation_reports_actual_execution_per_event(self):
        # The synthetic separator emits the same phase protocol as separate.py;
        # FFmpeg encoding below remains outside this measured fake AI phase.
        self.separator.write_text(
            self.separator.read_text().replace(
                "subprocess.run([",
                "import time, json\nfrom datetime import datetime, timezone\n"
                "started=time.monotonic(); started_at=datetime.now(timezone.utc).isoformat(); time.sleep(.01)\n"
                "(o/'.execution.json').write_text(json.dumps(dict(version=1,runId=o.name,phase='separated',completed=True,startedAt=started_at,startedMonotonic=started,seconds=time.monotonic()-started)))\n"
                "subprocess.run([",
                1,
            )
        )
        original = self.api.post

        def post(route, body):
            reply = original(route, body)
            if route == "identity":
                reply["mediaPolicyVersion"] = 2
            return reply

        self.api.post = post
        self.assertEqual(
            Worker(self.config, self.api, self.transfers).run_once(), "ready"
        )
        claim = next(body for route, body in self.api.calls if route == "claim")
        self.assertEqual(claim["mediaPolicyVersion"], 2)
        reports = [
            body
            for route, body in self.api.calls
            if route in ("output-url", "complete")
        ]
        self.assertEqual(len(reports), 2)
        for report in reports:
            evidence = report["executionEvidence"]
            self.assertEqual(evidence["eventId"], report["eventId"])
            self.assertGreater(evidence["separatorExecutionSeconds"], 0)
            self.assertTrue(evidence["stoppedConfirmed"])
            self.assertTrue(evidence["separationCompleted"])
            self.assertGreater(
                evidence["measuredAudioSeconds"], reports[0]["durationSeconds"]
            )
        self.assertEqual(
            reports[0]["executionEvidence"]["separatorExecutionSeconds"],
            reports[1]["executionEvidence"]["separatorExecutionSeconds"],
        )

    def test_protocol_v3_identity_is_verified_before_the_first_claim(self):
        worker = Worker(self.config, self.api, self.transfers)
        self.assertEqual(worker.run_once(), "ready")
        self.api.assignment["jobId"] = "b" * 24
        self.assertEqual(worker.run_once(), "ready")
        routes = [route for route, _ in self.api.calls if route != "heartbeat"]
        self.assertEqual(routes[0:2], ["identity", "claim"])
        self.assertEqual(routes.count("identity"), 1)

    def test_mismatched_identity_stops_before_claim_and_preserves_session(self):
        worker = Worker(self.config, self.api, self.transfers)
        session_file = self.config.state_dir / "session.json"
        saved_session_before = session_file.read_bytes()
        self.api.identity_worker_id = "gpu-02"
        with self.assertRaisesRegex(RuntimeError, "identity"):
            worker.run_once()
        routes = [route for route, _ in self.api.calls]
        self.assertNotIn("claim", routes)
        self.assertNotIn("fail", routes)
        self.assertEqual(saved_session_before, session_file.read_bytes())

    def test_separator_failure_is_reported_without_process_output(self):
        self.separator.write_text(
            "raise RuntimeError('private detail must not be sent')\n"
        )
        self.assertEqual(
            Worker(self.config, self.api, self.transfers).run_once(), "failed"
        )
        failure = next(body for route, body in self.api.calls if route == "fail")
        self.assertEqual(failure["code"], "SEPARATOR_FAILED")
        self.assertTrue(failure["stopped"])
        self.assertNotIn("private detail", json.dumps(self.api.calls))

    def test_restart_reconciles_before_claiming(self):
        journal = Journal(self.config.state_dir)
        journal.save(self.api.assignment)
        self.assertEqual(
            Worker(self.config, self.api, self.transfers).run_once(), "ready"
        )
        self.assertEqual(self.api.calls[0][0], "identity")
        self.assertEqual(self.api.calls[1][0], "reconcile")
        self.assertTrue(self.api.calls[1][1]["stopped"])

    def test_completion_timeout_reuses_event_and_does_not_repeat_separation(self):
        original = self.api.post
        completions = []

        def post(route, body):
            if route == "complete":
                completions.append(body.copy())
                if len(completions) == 1:
                    raise ApiError(0)
            return original(route, body)

        self.api.post = post
        self.assertEqual(
            Worker(self.config, self.api, self.transfers).run_once(), "ready"
        )
        self.assertEqual(completions[0], completions[1])
        self.assertEqual([r for r, _ in self.api.calls].count("stage"), 1)

    def test_uncertain_upload_keeps_assignment_for_reconciliation(self):
        original = self.api.post

        def post(route, body):
            if route == "complete":
                raise ApiError(0)
            return original(route, body)

        def upload(*args):
            raise TransferError("OUTPUT_UPLOAD_FAILED", uncertain=True)

        self.api.post = post
        self.transfers.upload = upload
        with patch("musicmute_worker.worker.wait_checked"), self.assertRaises(ApiError):
            Worker(self.config, self.api, self.transfers).run_once()
        self.assertIsNotNone(Journal(self.config.state_dir).active)
        self.assertNotIn("fail", [r for r, _ in self.api.calls])

    def test_expired_replacement_after_lost_reconcile_response_is_followed(self):
        journal = Journal(self.config.state_dir)
        journal.save(self.api.assignment)
        replacement = str(uuid4())
        original = self.api.post
        reconciled = []

        def post(route, body):
            if route == "reconcile":
                reconciled.append(body["previousAttemptId"])
                if len(reconciled) == 1:
                    raise ApiError(409, "WORKER_RECOVERY_REQUIRED", replacement)
            return original(route, body)

        self.api.post = post
        self.assertEqual(
            Worker(self.config, self.api, self.transfers).run_once(), "ready"
        )
        self.assertEqual(reconciled[-1], replacement)

    def test_restart_discovers_replacement_after_stale_journal(self):
        journal = Journal(self.config.state_dir)
        journal.save(self.api.assignment)
        replacement = str(uuid4())
        original = self.api.post
        reconciled = []

        def post(route, body):
            if route == "reconcile":
                reconciled.append(body["previousAttemptId"])
                if len(reconciled) == 1:
                    raise ApiError(409, "STALE_ATTEMPT")
            if route == "claim":
                raise ApiError(409, "WORKER_RECOVERY_REQUIRED", replacement)
            return original(route, body)

        self.api.post = post
        self.assertEqual(
            Worker(self.config, self.api, self.transfers).run_once(), "ready"
        )
        self.assertEqual(reconciled[-1], replacement)


class StateTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(ProcessTestIsolation())

    def lease_assignment(self):
        return {
            "jobId": "a" * 24,
            "attemptId": str(uuid4()),
            "sessionId": str(uuid4()),
            "generation": 1,
            "leaseExpiresAt": expires(),
            "cancelRequested": False,
        }

    def test_heartbeat_cancellation_stops_a_running_command(self):
        class ApiCancels:
            def post(self, route, body):
                return {"leaseExpiresAt": expires(), "cancelRequested": True}

        started = time.monotonic()
        with (
            Lease(ApiCancels(), self.lease_assignment()) as lease,
            ProcessRunner() as runner,
            self.assertRaises(Cancelled),
        ):
            runner.run(
                [sys.executable, "-c", "import time; time.sleep(20)"],
                cwd=Path.cwd(),
                timeout=30,
                check=lease.check,
            )
        self.assertLess(time.monotonic() - started, 3)

    def test_network_outage_stops_command_before_lease_deadline(self):
        class ApiOffline:
            def post(self, route, body):
                raise ApiError(0)

        assignment = self.lease_assignment()
        assignment["leaseExpiresAt"] = (
            datetime.now(timezone.utc) + timedelta(seconds=10.4)
        ).isoformat()
        started = time.monotonic()
        with (
            Lease(ApiOffline(), assignment) as lease,
            ProcessRunner() as runner,
            self.assertRaises(LeaseLost),
        ):
            runner.run(
                [sys.executable, "-c", "import time; time.sleep(20)"],
                cwd=Path.cwd(),
                timeout=30,
                check=lease.check,
            )
        self.assertLess(time.monotonic() - started, 3)

    def test_journal_does_not_persist_grants_or_input(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = Journal(Path(folder))
            journal.save(
                {
                    "jobId": "a" * 24,
                    "attemptId": str(uuid4()),
                    "sessionId": str(uuid4()),
                    "generation": 1,
                    "input": {"download": {"url": "secret-signed-url"}},
                }
            )
            data = (Path(folder) / "active.json").read_text()
            self.assertNotIn("secret-signed-url", data)
            self.assertNotIn("input", data)

    def test_lease_rejects_expired_assignment(self):
        lease = Lease(
            None, {"leaseExpiresAt": "2000-01-01T00:00:00Z", "cancelRequested": False}
        )
        with self.assertRaises(LeaseLost):
            lease.check()

    def test_cancellation_can_be_ignored_only_for_acknowledgement(self):
        lease = Lease(None, {"leaseExpiresAt": expires(), "cancelRequested": True})
        with self.assertRaises(Cancelled):
            lease.check()
        lease.check(ignore_cancel=True)


if __name__ == "__main__":
    unittest.main()
