import dataclasses
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from musicmute_worker.execution import ExecutionClock
from musicmute_worker.transport import ApiError
from musicmute_worker.worker import Cancelled, Worker
import test_worker as fixtures


class ExecutionRecoveryTests(unittest.TestCase):
    def test_lost_reconcile_response_replays_prior_attempt_evidence_before_rebind(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            now = [10.0]
            clock = ExecutionClock(root, monotonic=lambda: now[0])
            clock.bind("old")
            clock.start()
            now[0] = 20.0
            clock.stop(
                dict(
                    version=1,
                    runId="run",
                    phase="separated",
                    startedMonotonic=12.0,
                    startedAt="2026-09-13T12:00:00Z",
                    seconds=3.0,
                ),
                stopped_confirmed=True,
                run_id="run",
            )
            calls = []

            class Api:
                def post(self, route, body):
                    calls.append((route, body.copy()))
                    if len(calls) == 1:
                        raise ApiError(503, "SERVICE_UNAVAILABLE")
                    return {"attemptId": "new", "status": "validating"}

            worker = object.__new__(Worker)
            worker.session = "session"
            worker.execution = clock
            worker.progress = SimpleNamespace(data={"inputDurationSeconds": 30})
            worker.api = Api()
            worker._media_policy_supported = True
            with self.assertRaises(ApiError):
                worker._reconcile("old")
            worker.execution = ExecutionClock(root)
            worker._reconcile("old")
            self.assertEqual(calls[0], calls[1])
            self.assertEqual(calls[0][1]["previousAttemptId"], "old")
            self.assertEqual(
                calls[0][1]["executionEvidence"]["separatorExecutionSeconds"], 3.0
            )
            worker.execution.bind("new")
            self.assertIsNone(worker.execution.evidence("event", 30))


class ContainmentExecutionTests(unittest.TestCase):
    def setUp(self):
        fixtures.WorkerTests.setUp(self)
        self.config = dataclasses.replace(self.config, reuse_separator=True)

    def result_with_cancellation(self, *, close_fails):
        worker = Worker(self.config, self.api, self.transfers)
        assignment = self.api.assignment
        worker.progress.bind(assignment)
        prepared = worker.progress.work / "prepared.wav"
        prepared.write_bytes(b"synthetic checkpoint")
        worker.progress.data["inputDurationSeconds"] = 1.0
        worker.progress.record("prepared", prepared, 1.0)
        now = [10.0]
        worker.execution = ExecutionClock(
            self.config.state_dir, monotonic=lambda: now[0]
        )
        worker.execution.bind(assignment["attemptId"])
        recovered = []

        class Engine:
            def __init__(self, *_args):
                pass

            def run(self, _prepared, output, **_kwargs):
                output.mkdir(parents=True)
                (output / ".execution.json").write_text(
                    json.dumps(
                        dict(
                            version=1,
                            runId=output.name,
                            phase="separating",
                            startedMonotonic=12.0,
                            startedAt="2026-09-13T12:00:00Z",
                        )
                    )
                )
                now[0] = 16.0
                raise Cancelled()

            def close(self):
                if close_fails:
                    raise RuntimeError("Stop not verified")

        class Runner:
            def recover(self):
                recovered.append(True)

        with patch("musicmute_worker.worker.SeparatorEngine", Engine):
            with self.assertRaises(RuntimeError if close_fails else Cancelled):
                worker._result(
                    assignment, SimpleNamespace(check=lambda **_kwargs: None), Runner()
                )
        return worker, recovered

    def test_unverified_engine_stop_does_not_write_stopped_or_zero_evidence(self):
        worker, recovered = self.result_with_cancellation(close_fails=True)
        self.assertFalse(worker.execution.data["stopped"])
        self.assertIsNone(worker.execution.evidence(str(uuid4()), 1.0))
        self.assertEqual(recovered, [])
        self.assertFalse(ExecutionClock(self.config.state_dir).data["stopped"])

    def test_confirmed_cancellation_counts_only_child_separation_phase(self):
        worker, recovered = self.result_with_cancellation(close_fails=False)
        self.assertEqual(recovered, [True])
        evidence = worker.execution.evidence(str(uuid4()), 1.0)
        self.assertEqual(evidence["separatorExecutionSeconds"], 4.0)
        self.assertTrue(evidence["stoppedConfirmed"])
        self.assertFalse(evidence["separationCompleted"])
