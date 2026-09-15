import copy
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from musicmute_worker.update.activation import (
    LauncherHandoff,
    SafeBoundary,
    environment,
)
from musicmute_worker.update.journal import DurableRecords
from test_update_activation import SAFE, Fixture


class PowerLoss(BaseException):
    pass


class RecoveryTests(unittest.TestCase):
    def fixture(self):
        return Fixture(Path(self.enterContext(tempfile.TemporaryDirectory())).resolve())

    def test_every_activation_durable_write_boundary_restarts_consistently(self):
        baseline = self.fixture()
        points = []
        baseline.records.fault = points.append
        baseline.coordinator.prepare()
        baseline.coordinator.activate_when_idle()
        self.assertGreater(len(points), 60)
        for index, point in enumerate(points):
            with self.subTest(index=index, point=point):
                f = self.fixture()
                count = 0

                def crash(current, at=index):
                    nonlocal count
                    count += 1
                    if count == at + 1:
                        raise PowerLoss(current)

                f.records.fault = crash
                with self.assertRaises(PowerLoss):
                    f.coordinator.prepare()
                    f.coordinator.activate_when_idle()
                f.records.fault = lambda point: None
                c = f.restart()
                result = c.recover_interrupted_activation()
                if result == "none":
                    c.prepare()
                    result = c.activate_when_idle()
                if result == "prepared":
                    result = c.activate_when_idle()
                self.assertIn(result, ("committed", "rolled_back"))
                active = c.pointer.read()
                self.assertTrue(f.runtime.validate(active))
                self.assertEqual(f.client.observed, active["target"]["buildNumber"])
                self.assertFalse(c.hold.held)
                before = len(f.client.events)
                self.assertEqual(f.restart().recover_interrupted_activation(), result)
                self.assertEqual(len(f.client.events), before)

    def test_lost_status_ack_replays_original_journal_payload(self):
        for stage in (
            "downloading",
            "prepared",
            "waiting_for_idle",
            "validating",
            "activating",
            "running",
        ):
            with self.subTest(stage=stage):
                f = self.fixture()
                f.client.lose_stage = stage
                with self.assertRaises(OSError):
                    f.coordinator.prepare()
                    f.coordinator.activate_when_idle()
                payload = f.records.read("activation.json")["pendingStatus"]
                self.assertIsNotNone(payload)
                self.assertEqual(payload, f.client.events[payload["eventId"]])
                f.restart().recover_interrupted_activation()
                self.assertGreaterEqual(f.client.calls.count(payload), 2)
                self.assertEqual(f.client.events[payload["eventId"]], payload)

    def test_candidate_ownership_must_stop_and_reconcile_before_rollback(self):
        f = self.fixture()
        c = f.coordinator
        c.prepare()
        c.activate_when_idle()
        f.runtime.invalid.add(2)
        for field in SAFE.__dataclass_fields__:
            values = {key: True for key in SAFE.__dataclass_fields__}
            values[field] = False
            f.runtime.reconciled = SafeBoundary(**values)
            self.assertEqual(f.restart().recover_interrupted_activation(), "waiting")
            self.assertEqual(c.pointer.read()["target"], f.new_target)
            self.assertTrue(c.hold.held)
        f.runtime.reconciled = SAFE
        self.assertEqual(f.restart().recover_interrupted_activation(), "rolled_back")
        self.assertEqual(c.pointer.read(), f.old)

    def test_offline_recovery_never_releases_claim_hold(self):
        f = self.fixture()
        f.coordinator.prepare()
        f.coordinator.activate_when_idle()
        f.client.offline = True
        with self.assertRaises(OSError):
            f.restart().recover_interrupted_activation()
        self.assertTrue(f.coordinator.hold.held)
        self.assertEqual(f.coordinator.pointer.read()["target"], f.new_target)

    def test_native_failure_and_forbidden_rollback_remain_quarantined(self):
        f = self.fixture()
        f.coordinator.prepare()
        f.coordinator.activate_when_idle()
        f.runtime.invalid.add(2)
        f.client.decision["allowedFallbackReleaseIds"] = []
        self.assertEqual(
            f.restart().recover_interrupted_activation(), "repair_required"
        )
        self.assertEqual(
            f.restart().recover_interrupted_activation(), "repair_required"
        )
        self.assertTrue(f.coordinator.hold.held)
        self.assertEqual(f.coordinator.pointer.read()["target"], f.new_target)

    def test_state_schema_and_noncanonical_path_fail_without_conversion(self):
        f = self.fixture()
        value = copy.deepcopy(f.old)
        value["target"]["stateReadMax"] = 2
        with self.assertRaises(ValueError):
            environment(value)
        link = f.root / "alias"
        link.symlink_to(f.old["path"], target_is_directory=True)
        value = copy.deepcopy(f.old)
        value["path"] = str(link)
        with self.assertRaises(ValueError):
            environment(value)
        record = f.records.root / "activation.json"
        record.write_text('{"schemaVersion":2}')
        with self.assertRaises(ValueError):
            f.restart().recover_interrupted_activation()
        self.assertEqual(record.read_text(), '{"schemaVersion":2}')

    def test_durable_records_flush_parent_and_reject_traversal(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        sync = Mock()
        records = DurableRecords(root / "records", sync_directory=sync)
        records.write("test.json", {"schemaVersion": 3})
        self.assertEqual(
            [call.args[0] for call in sync.call_args_list], [root, root / "records"]
        )
        for name in ("../outside.json", "..", "."):
            with self.assertRaises(ValueError):
                records.read(name)
            with self.assertRaises(ValueError):
                records.write(name, {"schemaVersion": 3})

    def test_launcher_handoff_crashes_retain_recovery_executable(self):
        for fault_index in range(16):
            with self.subTest(fault_index=fault_index):
                root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
                records = DurableRecords(root / "updates")
                entries = []
                for label in ("old", "candidate"):
                    path = root / label
                    path.write_text(label)
                    entries.append(
                        {
                            "path": str(path),
                            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                        }
                    )
                old, candidate = entries
                records.write(
                    "active-launcher.json", {"schemaVersion": 3, "executable": old}
                )
                count = 0

                def crash(point, at=fault_index):
                    nonlocal count
                    count += 1
                    if count == at + 1:
                        raise PowerLoss(point)

                records.fault = crash
                with self.assertRaises(PowerLoss):
                    LauncherHandoff(records).activate(
                        old, candidate, SAFE, lambda env: True
                    )
                records.fault = lambda point: None
                chosen = LauncherHandoff(records).recover()
                self.assertIn(chosen, (None, old, candidate))
                self.assertTrue(Path(old["path"]).is_file())
                self.assertTrue(Path(candidate["path"]).is_file())
                if chosen:
                    self.assertEqual(
                        records.read("active-launcher.json")["executable"], chosen
                    )

    def test_unacknowledged_launcher_check_never_switches(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        records = DurableRecords(root / "updates")
        entries = []
        for label in ("old", "candidate"):
            path = root / label
            path.write_text(label)
            entries.append(
                {
                    "path": str(path),
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                }
            )
        handoff = LauncherHandoff(records)
        for result in (False, None, 1):
            with self.assertRaises(RuntimeError):
                handoff.activate(*entries, SAFE, lambda env, reply=result: reply)
            self.assertEqual(handoff.recover(), entries[0])

    def test_every_rollback_write_boundary_restarts_with_allowed_old_environment(self):
        baseline = self.fixture()
        baseline.coordinator.prepare()
        baseline.runtime.invalid.add(2)
        points = []
        baseline.records.fault = points.append
        baseline.coordinator.activate_when_idle()
        for index, point in enumerate(points):
            with self.subTest(index=index, point=point):
                f = self.fixture()
                f.coordinator.prepare()
                f.runtime.invalid.add(2)
                count = 0

                def crash(current, at=index):
                    nonlocal count
                    count += 1
                    if count == at + 1:
                        raise PowerLoss(current)

                f.records.fault = crash
                with self.assertRaises(PowerLoss):
                    f.coordinator.activate_when_idle()
                f.records.fault = lambda point: None
                self.assertEqual(
                    f.restart().recover_interrupted_activation(), "rolled_back"
                )
                self.assertEqual(f.coordinator.pointer.read(), f.old)
                self.assertFalse(f.coordinator.hold.held)
                self.assertEqual(
                    f.restart().recover_interrupted_activation(), "rolled_back"
                )
