import tempfile
import unittest
from pathlib import Path

from musicmute_worker.execution import ExecutionClock


class ExecutionClockTests(unittest.TestCase):
    def telemetry(self, phase="separated", **updates):
        return dict(
            version=1,
            runId="run",
            phase=phase,
            startedAt="2026-09-13T12:00:00+00:00",
            startedMonotonic=12.0,
            **({"seconds": 3.25, "completed": True} if phase == "separated" else {}),
            **updates
        )

    def test_only_completed_separator_phase_excludes_model_load_and_encoding(self):
        with tempfile.TemporaryDirectory() as directory:
            now = [10.0]
            clock = ExecutionClock(Path(directory), monotonic=lambda: now[0])
            clock.bind("attempt")
            clock.start()
            now[0] = 99.0
            clock.stop(self.telemetry(), stopped_confirmed=True, run_id="run")
            evidence = clock.evidence("event", 30)
            self.assertEqual(evidence["separatorExecutionSeconds"], 3.25)
            self.assertTrue(evidence["stoppedConfirmed"])
            self.assertTrue(evidence["separationCompleted"])
            restored = ExecutionClock(Path(directory))
            restored.bind("attempt")
            self.assertEqual(restored.evidence("event", 30), evidence)

    def test_mid_separator_cancellation_uses_current_process_monotonic_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            now = [10.0]
            clock = ExecutionClock(Path(directory), monotonic=lambda: now[0])
            clock.bind("attempt")
            clock.start()
            now[0] = 16.0
            clock.stop(
                self.telemetry("separating"), stopped_confirmed=True, run_id="run"
            )
            self.assertEqual(
                clock.evidence("event", 30)["separatorExecutionSeconds"], 4.0
            )

    def test_failed_containment_stop_never_persists_stopped_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            clock = ExecutionClock(Path(directory), monotonic=lambda: 10.0)
            clock.bind("attempt")
            clock.start()
            clock.stop(self.telemetry(), stopped_confirmed=False, run_id="run")
            self.assertIsNone(clock.evidence("event", 30))
            restored = ExecutionClock(Path(directory))
            self.assertFalse(restored.data["stopped"])
            self.assertIsNone(restored.evidence("event", 30))

    def test_crash_does_not_use_an_old_monotonic_phase_or_invent_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            clock = ExecutionClock(Path(directory), monotonic=lambda: 10.0)
            clock.bind("attempt")
            clock.start()
            restored = ExecutionClock(Path(directory), monotonic=lambda: 999.0)
            restored.bind("attempt")
            restored.stop(
                self.telemetry("separating"), stopped_confirmed=True, run_id="run"
            )
            self.assertIsNone(restored.evidence("event", 30))

    def test_known_prior_evidence_replays_same_event_until_acknowledged(self):
        with tempfile.TemporaryDirectory() as directory:
            now = [10.0]
            clock = ExecutionClock(Path(directory), monotonic=lambda: now[0])
            clock.bind("attempt")
            clock.start()
            now[0] = 99
            clock.stop(self.telemetry(), stopped_confirmed=True, run_id="run")
            first = clock.reconciliation("attempt", 30)
            restored = ExecutionClock(Path(directory))
            self.assertEqual(first, restored.reconciliation("attempt", 30))
            with self.assertRaises(RuntimeError):
                restored.bind("next")
            restored.acknowledge("attempt")
            restored.bind("next")
            self.assertIsNone(restored.evidence("event", 30))

    def test_foreign_phase_is_not_accounting_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            clock = ExecutionClock(Path(directory), monotonic=lambda: 10.0)
            clock.bind("attempt")
            clock.start()
            clock.stop(self.telemetry(), stopped_confirmed=True, run_id="different")
            self.assertIsNone(clock.evidence("event", 30))

    def test_completed_child_phase_survives_supervisor_crash_before_clock_stop(self):
        import json

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "jobs" / "run"
            output.mkdir(parents=True)
            clock = ExecutionClock(root, monotonic=lambda: 10.0)
            clock.bind("attempt")
            clock.start(output)
            (output / ".execution.json").write_text(json.dumps(self.telemetry()))
            restored = ExecutionClock(root, monotonic=lambda: 1.0)
            restored.recover_completed_phase(stopped_confirmed=False)
            self.assertIsNone(restored.evidence("event", 30))
            restored.recover_completed_phase(stopped_confirmed=True)
            self.assertEqual(
                restored.evidence("event", 30)["separatorExecutionSeconds"], 3.25
            )
            self.assertTrue(restored.evidence("event", 30)["separationCompleted"])
            again = ExecutionClock(root)
            again.recover_completed_phase(stopped_confirmed=True)
            self.assertEqual(
                again.evidence("event", 30)["separatorExecutionSeconds"], 3.25
            )

    def test_running_child_phase_is_not_reconstructed_after_restart(self):
        import json

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "jobs" / "run"
            output.mkdir(parents=True)
            clock = ExecutionClock(root, monotonic=lambda: 10.0)
            clock.bind("attempt")
            clock.start(output)
            (output / ".execution.json").write_text(
                json.dumps(self.telemetry("separating"))
            )
            restored = ExecutionClock(root, monotonic=lambda: 9999.0)
            restored.recover_completed_phase(stopped_confirmed=True)
            self.assertIsNone(restored.evidence("event", 30))
