"""Long-lived launcher control tests; fixture child never executes inference."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import test_launcher as support
from musicmute_worker.setup_control import CommandMailbox
from musicmute_worker.setup_host import import_native_events, run_action, run_worker
from musicmute_worker.update.activation import SafeBoundary
from musicmute_worker.update.journal import ClaimHold, DurableRecords


class MonitoredLauncherTests(unittest.TestCase):
    def setUp(self):
        self.fixture = support.LauncherTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_monitor_runs_under_lifetime_lock_and_child_never_calls_blocking_wait(self):
        fixture = self.fixture
        calls = []
        fixture.child.poll_exit = lambda timeout: None
        fixture.child.wait = lambda: self.fail("Blocking wait is not allowed")

        def monitor(services, child):
            self.assertTrue(fixture.adapter.locked)
            self.assertIs(child, fixture.child)
            calls.append(services)
            return 75 if len(calls) == 3 else None

        self.assertEqual(fixture.launcher.run(fixture.child, monitor=monitor), 75)
        self.assertEqual(len(calls), 3)
        with self.assertRaises(RuntimeError):
            calls[0](
                None, bootstrap_root=b"", distribution_origin="https://test.invalid"
            )

    def test_missing_native_polling_fails_before_processing_authorization(self):
        fixture = self.fixture
        with self.assertRaisesRegex(RuntimeError, "polling"):
            fixture.launcher.run(fixture.child, monitor=lambda *_: None)
        self.assertFalse(fixture.child.authorized)

    def host_fixture(self):
        fixture = self.fixture
        runtime = Mock()
        runtime.records = DurableRecords(fixture.paths.state / "updates")
        runtime.boundary.return_value = SafeBoundary(True, True, True, True)
        runtime.validate.return_value = True
        runtime.child.return_value = fixture.child
        client = Mock()
        client.installation_id = fixture.binding.installation_id
        client.installation_ready.return_value = {"accepted": True, "canClaim": True}
        coordinator = Mock()
        coordinator.recover_interrupted_activation.return_value = "none"
        native = Mock()
        native.sync_directory = DurableRecords._sync_directory
        return runtime, client, coordinator, native

    def exercise_host(self, runtime, client, coordinator, native):
        services = {"verifier": Mock(), "events": Mock()}
        with (
            patch(
                "musicmute_worker.setup_host.SharedActivationRuntime",
                return_value=runtime,
            ),
            patch(
                "musicmute_worker.setup_host.UpdateCoordinator",
                return_value=coordinator,
            ),
            patch(
                "musicmute_worker.launcher.Launcher._update_services_locked",
                return_value=services,
            ),
            patch(
                "musicmute_worker.setup_host.time.monotonic",
                side_effect=range(0, 3000, 31),
            ),
        ):
            return run_worker(
                self.fixture.paths,
                self.fixture.adapter,
                native,
                client,
                bootstrap_root=b"synthetic",
                distribution_origin="https://test.invalid",
                launcher_build=1,
            )

    def test_transient_policy_error_recovers_readiness_after_healthy_none(self):
        runtime, client, coordinator, native = self.host_fixture()
        client.fetch_policy.side_effect = [
            {"action": "none"},
            OSError("offline"),
            {"action": "none"},
            {"action": "none"},
        ]
        runtime.stop_and_reconcile.return_value = SafeBoundary(True, True, True, True)
        self.fixture.child.poll_exit = Mock(side_effect=[None, None, 0])
        self.assertEqual(self.exercise_host(runtime, client, coordinator, native), 0)
        self.assertFalse(ClaimHold(runtime.records).held)
        self.assertGreaterEqual(client.installation_ready.call_count, 2)

    def test_startup_recovers_existing_operational_hold_under_healthy_none(self):
        runtime, client, coordinator, native = self.host_fixture()
        ClaimHold(runtime.records).set(True)
        client.fetch_policy.return_value = {"action": "none"}
        self.fixture.child.poll_exit = Mock(return_value=0)
        self.assertEqual(self.exercise_host(runtime, client, coordinator, native), 0)
        self.assertFalse(ClaimHold(runtime.records).held)
        client.installation_ready.assert_called_once()

    def test_already_committed_policy_does_not_stop_or_restart_child(self):
        runtime, client, coordinator, native = self.host_fixture()
        client.fetch_policy.side_effect = [{"action": "none"}, {"action": "prepare"}]
        coordinator.prepare.return_value = "committed"
        coordinator.running_target.return_value = True
        coordinator.activate_when_idle.return_value = "committed"
        self.fixture.child.poll_exit = Mock(side_effect=[None, 0])
        self.assertEqual(self.exercise_host(runtime, client, coordinator, native), 0)
        runtime.stop_and_reconcile.assert_not_called()
        coordinator.activate_when_idle.assert_not_called()
        self.assertFalse(ClaimHold(runtime.records).held)

    def test_dead_service_owner_record_enters_repair_instead_of_dead_mailbox(self):
        from contextlib import contextmanager

        from musicmute_worker.progress import atomic_json

        paths = self.fixture.paths
        paths.journals.mkdir(parents=True, exist_ok=True)
        atomic_json(
            paths.journals / "launcher-owner.json",
            {
                "schemaVersion": 3,
                "installationId": self.fixture.binding.installation_id,
                "containmentId": "dead-fixture",
            },
        )
        installer = Mock()
        installer.repair.return_value = "ready"

        @contextmanager
        def assembled(*args, **kwargs):
            self.assertTrue(self.fixture.adapter.locked)
            yield installer

        native = Mock()
        native.service_running.return_value = False
        native.sync_directory = DurableRecords._sync_directory
        with patch("musicmute_worker.setup_host.assemble", side_effect=assembled):
            self.assertEqual(
                run_action(paths, self.fixture.adapter, native, "repair"), "ready"
            )
        installer.repair.assert_called_once()
        self.assertIn("dead-fixture", self.fixture.adapter.stops)

    def test_live_service_routes_to_mailbox_without_entering_machine_lock(self):
        native = Mock()
        native.service_running.return_value = True
        native.sync_directory = DurableRecords._sync_directory
        with patch.object(
            self.fixture.adapter,
            "acquire_machine_lock",
            side_effect=AssertionError("lifetime lock must not be entered"),
        ):
            result = run_action(
                self.fixture.paths, self.fixture.adapter, native, "uninstall"
            )
        self.assertEqual(result["result"], "queued")

    def test_stale_owner_failed_stop_is_retained_and_does_not_run_uninstall(self):
        from musicmute_worker.progress import atomic_json

        paths = self.fixture.paths
        paths.journals.mkdir(parents=True, exist_ok=True)
        ownership = paths.journals / "launcher-owner.json"
        atomic_json(
            ownership,
            {
                "schemaVersion": 3,
                "installationId": self.fixture.binding.installation_id,
                "containmentId": "dead-fixture",
            },
        )
        self.fixture.adapter.fail_stop = True
        native = Mock()
        native.service_running.return_value = False
        with (
            patch("musicmute_worker.setup_host.assemble") as assemble,
            self.assertRaises(RuntimeError),
        ):
            run_action(paths, self.fixture.adapter, native, "uninstall")
        self.assertTrue(ownership.exists())
        assemble.assert_not_called()

    def test_running_child_observes_new_policy_without_service_restart(self):
        fixture = self.fixture
        runtime, client, coordinator, native = self.host_fixture()
        client.fetch_policy.side_effect = [{"action": "none"}, {"action": "hold"}]
        polls = []

        def poll(timeout):
            polls.append(timeout)
            if len(polls) == 2:
                self.assertTrue(ClaimHold(runtime.records).held)
                return 0
            return None

        fixture.child.poll_exit = poll
        services = {"verifier": Mock(), "events": Mock()}
        with (
            patch(
                "musicmute_worker.setup_host.SharedActivationRuntime",
                return_value=runtime,
            ),
            patch(
                "musicmute_worker.setup_host.UpdateCoordinator",
                return_value=coordinator,
            ),
            patch(
                "musicmute_worker.launcher.Launcher._update_services_locked",
                return_value=services,
            ),
        ):
            self.assertEqual(
                run_worker(
                    fixture.paths,
                    fixture.adapter,
                    native,
                    client,
                    bootstrap_root=b"synthetic",
                    distribution_origin="https://test.invalid",
                    launcher_build=1,
                ),
                0,
            )
        self.assertEqual(client.fetch_policy.call_count, 2)
        self.assertEqual(polls, [5, 5])

    def test_running_child_consumes_pause_mailbox_and_retains_claim_hold(self):
        fixture = self.fixture
        runtime, client, coordinator, native = self.host_fixture()
        client.fetch_policy.return_value = {"action": "none"}
        mailbox = CommandMailbox(DurableRecords(fixture.paths.state / "commands"))
        operations = []

        def poll(timeout):
            if not operations:
                operations.append(mailbox.submit("pause"))
                return None
            self.assertTrue(ClaimHold(runtime.records).held)
            self.assertEqual(mailbox.receipt(operations[0])["result"], "paused")
            return 0

        fixture.child.poll_exit = poll
        services = {"verifier": Mock(), "events": Mock()}
        with (
            patch(
                "musicmute_worker.setup_host.SharedActivationRuntime",
                return_value=runtime,
            ),
            patch(
                "musicmute_worker.setup_host.UpdateCoordinator",
                return_value=coordinator,
            ),
            patch(
                "musicmute_worker.launcher.Launcher._update_services_locked",
                return_value=services,
            ),
        ):
            self.assertEqual(
                run_worker(
                    fixture.paths,
                    fixture.adapter,
                    native,
                    client,
                    bootstrap_root=b"synthetic",
                    distribution_origin="https://test.invalid",
                    launcher_build=1,
                ),
                0,
            )
        self.assertTrue(runtime.records.read("local-pause.json")["paused"])
        self.assertEqual(client.fetch_policy.call_count, 1)


class MailboxTests(unittest.TestCase):
    def test_native_import_requires_bootstrap_serialization_without_fallback(self):
        with patch(
            "musicmute_worker.bootstrap_events.import_bootstrap_events"
        ) as importer:
            with self.assertRaisesRegex(TypeError, "handoff lock"):
                import_native_events(Mock(), object(), Mock())
            importer.assert_not_called()

    def test_native_import_runs_inside_exact_bootstrap_lock(self):
        from contextlib import contextmanager
        from types import SimpleNamespace

        locked = []

        @contextmanager
        def guard():
            locked.append(True)
            try:
                yield
            finally:
                locked.clear()

        paths = SimpleNamespace(events=Path("/synthetic/events"))
        native = SimpleNamespace(acquire_bootstrap_lock=guard)

        def imported(path, spool):
            self.assertEqual(locked, [True])
            self.assertEqual(path, paths.events / "bootstrap")
            return 1

        with patch(
            "musicmute_worker.bootstrap_events.import_bootstrap_events",
            side_effect=imported,
        ):
            self.assertEqual(import_native_events(paths, native, Mock()), 1)
        self.assertEqual(locked, [])

    def test_commands_are_durable_and_receipts_stop_reexecution(self):
        with tempfile.TemporaryDirectory() as directory:
            records = DurableRecords(Path(directory).resolve() / "commands")
            mailbox = CommandMailbox(records)
            operation = mailbox.submit("pause")
            self.assertEqual(
                CommandMailbox(records).pending()[0]["operationId"], operation
            )
            mailbox.finish(operation, "paused")
            self.assertEqual(mailbox.pending(), [])
            self.assertEqual(mailbox.receipt(operation)["result"], "paused")

    def test_mailbox_rejects_unknown_action_and_caps_outstanding_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            mailbox = CommandMailbox(
                DurableRecords(Path(directory).resolve() / "commands")
            )
            with self.assertRaises(ValueError):
                mailbox.submit("execute")
            for _ in range(32):
                mailbox.submit("pause")
            with self.assertRaises(RuntimeError):
                mailbox.submit("repair")


if __name__ == "__main__":
    unittest.main()
