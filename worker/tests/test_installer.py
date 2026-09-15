"""Shared setup tests use isolated native/control fixtures, never GPU or boot proof."""

import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

from musicmute_worker.events import EventSpool
from musicmute_worker.installation_state import InstallationState
from musicmute_worker.installer import Installer
from musicmute_worker.profiles import ProfileError
from musicmute_worker.update.journal import DurableRecords
from musicmute_worker.update.policy import ControlClient


class StateFixture:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.adapter = Mock()
        self.secrets = {}
        self.adapter.load_secret.side_effect = self.secrets.__getitem__
        self.adapter.protect_secret.side_effect = self.secrets.__setitem__
        self.adapter.detect.return_value = {"machineBindingSha256": "a" * 64}
        self.records = DurableRecords(Path(self.tmp.name).resolve() / "setup")

    def state(self):
        return InstallationState(self.records, self.adapter, "https://api.test/api/v1")


class StateTests(StateFixture, unittest.TestCase):
    def test_identity_is_protected_before_registration_and_reused(self):
        first = self.state()
        second = self.state()
        self.assertEqual(first.identity, second.identity)
        self.assertEqual(self.adapter.protect_secret.call_count, 1)
        self.assertEqual(len(first.identity["installationToken"]), 64)

    def test_clone_does_not_overwrite_identity(self):
        self.state()
        original = dict(self.secrets)
        self.adapter.detect.return_value = {"machineBindingSha256": "b" * 64}
        with self.assertRaises(ValueError):
            self.state()
        self.assertEqual(original, self.secrets)

    def test_pairing_token_and_operation_survive_lost_response(self):
        state = self.state()
        body = state.pairing_body("a" * 24)
        resumed = self.state()
        self.assertEqual(resumed.pairing_body(body["reportId"]), body)
        self.assertNotIn(self.secrets["worker-token"].decode(), json.dumps(body))

    def test_expired_pairing_needs_explicit_retry(self):
        state = self.state()
        body = state.pairing_body("a" * 24)
        state.update(pairingState="expired")
        with self.assertRaisesRegex(RuntimeError, "PAIRING_EXPIRED"):
            state.pairing_body(body["reportId"])
        retried = state.pairing_body(body["reportId"], retry=True)
        self.assertNotEqual(body["operationId"], retried["operationId"])
        self.assertEqual(body["workerKeySha256"], retried["workerKeySha256"])

    def test_failure_history_preserves_safe_reason_and_stage(self):
        state = self.state()
        state.failure("install", "DEPENDENCY_RECIPE_UNAVAILABLE")
        state.failure("install", "DEPENDENCY_RECIPE_UNAVAILABLE")
        self.assertEqual(self.state().value["failures"][-1]["attempt"], 2)
        self.assertEqual(self.state().value["stage"], "install")


class PairingTests(StateFixture, unittest.TestCase):
    def installer(self):
        state = self.state()
        setup = Mock()
        permanent = Mock()
        runtime = Mock()
        root = Path(self.tmp.name).resolve()
        runtime.records = DurableRecords(root / "updates")
        services = {
            "events": EventSpool(root / "events", state.identity["installationId"])
        }
        installer = Installer(state, setup, permanent, runtime, services, Mock())
        return installer, setup, permanent

    def test_polling_is_bounded_and_never_renews_code(self):
        installer, setup, _ = self.installer()
        setup.installation_status.return_value = {
            "pairingState": "pending",
            "assignedWorkerId": None,
        }
        sleeps = []
        result = installer.poll_pairing(max_polls=3, sleep=sleeps.append)
        self.assertEqual(result, "pending")
        self.assertEqual(setup.installation_status.call_count, 3)
        self.assertEqual(sleeps, [5, 5])
        setup.request_pairing.assert_not_called()

    def test_expiry_is_durable_and_does_not_request_new_code(self):
        installer, setup, _ = self.installer()
        setup.installation_status.return_value = {
            "pairingState": "expired",
            "assignedWorkerId": None,
        }
        self.assertEqual(installer.poll_pairing(max_polls=1), "expired")
        self.assertEqual(self.state().value["pairingState"], "expired")
        setup.request_pairing.assert_not_called()

    def test_unresolved_ownership_blocks_uninstall(self):
        from musicmute_worker.update.activation import SafeBoundary

        installer, _, _ = self.installer()
        installer.runtime.boundary.return_value = SafeBoundary(False, True, True, True)
        with self.assertRaisesRegex(RuntimeError, "OWNERSHIP_UNRESOLVED"):
            installer.uninstall()
        installer.native.remove_boot_service.assert_not_called()

    def test_dependency_failure_is_retained_without_pairing_and_rerun_reuses_identity(
        self,
    ):
        from test_bootstrap_release import build_stage

        installer, setup, _ = self.installer()
        installation_id = installer.state.identity["installationId"]
        root = Path(self.tmp.name).resolve()
        installer.runtime.paths = SimpleNamespace(releases=root / "releases")
        # v1 installs from the entrypoint-verified stage. An unqualified profile
        # in that stage is a recipe failure, not a reason to reach the network.
        stage = build_stage(root)
        installer.stage = stage
        setup.register_installation.return_value = {"installationId": installation_id}
        setup.installation_status.return_value = {"pairingState": "unpaired"}
        installer.state.adapter.detect.return_value.update(os="macos", arch="arm64")
        for _ in range(2):
            with self.assertRaises(ProfileError):
                installer.install(launcher_path=root / "launcher", installer_build=1)
        self.assertEqual(
            installer.state.value["failures"][-1],
            {"stage": "install", "code": "DEPENDENCY_RECIPE_UNAVAILABLE", "attempt": 2},
        )
        self.assertEqual(self.state().identity["installationId"], installation_id)
        # An intact but unqualified stage is still reported: registration happens
        # once, is reused on rerun, and never requests a pairing code.
        setup.register_installation.assert_called_once()
        setup.request_pairing.assert_not_called()
        installer.native.install_boot_service.assert_not_called()

    def test_a_tampered_stage_stops_install_before_any_network_step(self):
        from test_bootstrap_release import build_stage

        installer, setup, _ = self.installer()
        root = Path(self.tmp.name).resolve()
        installer.runtime.paths = SimpleNamespace(releases=root / "releases")
        stage = build_stage(root)
        (stage / "musicmute_worker" / "__init__.py").write_text("tampered")
        installer.stage = stage
        setup.register_installation.return_value = {
            "installationId": installer.state.identity["installationId"]
        }
        setup.installation_status.return_value = {"pairingState": "unpaired"}
        installer.state.adapter.detect.return_value.update(os="macos", arch="arm64")
        with self.assertRaises(ProfileError):
            installer.install(launcher_path=root / "launcher", installer_build=1)
        self.assertEqual(
            installer.state.value["failures"][-1]["code"], "UPDATE_SIGNATURE_INVALID"
        )
        installer.runtime.prepare_from_stage.assert_not_called()
        setup.request_pairing.assert_not_called()

    def test_install_without_a_registered_stage_never_reaches_the_network(self):
        installer, setup, _ = self.installer()
        root = Path(self.tmp.name).resolve()
        installer.runtime.paths = SimpleNamespace(releases=root / "releases")
        with self.assertRaises(ProfileError):
            installer.install(launcher_path=root / "launcher", installer_build=1)
        setup.register_installation.assert_not_called()
        setup.installation_status.assert_not_called()
        self.assertEqual(
            installer.state.value["failures"][-1]["code"],
            "DEPENDENCY_RECIPE_UNAVAILABLE",
        )

    def test_paired_repair_uses_permanent_auth_and_respects_readiness_hold(self):
        from musicmute_worker.update.activation import SafeBoundary
        from musicmute_worker.update.journal import ClaimHold

        installer, setup, permanent_factory = self.installer()
        installer.state.update(workerId="fixture-worker", pairingState="approved")
        client = permanent_factory.return_value
        client.identity.return_value = {
            "installationId": installer.state.identity["installationId"],
            "workerId": "fixture-worker",
        }
        client.installation_ready.return_value = {
            "accepted": True,
            "canClaim": False,
            "reasonCodes": ["WORKER_DRAINING"],
        }
        installer.runtime.boundary.return_value = SafeBoundary(True, True, True, True)
        installer.runtime.validate.return_value = True
        installer.services = {"events": Mock()}
        self.assertEqual(installer.repair(), "held")
        self.assertTrue(ClaimHold(installer.runtime.records).held)
        self.assertIs(installer.runtime.client, client)
        self.assertEqual(setup.mock_calls, [])
        client.installation_ready.assert_called_once()

    def test_raw_dependency_error_never_enters_event_or_failure(self):
        installer, _, _ = self.installer()
        installer.services = {"events": Mock()}
        installer._failure(
            RuntimeError("token=secret-private-value /Users/private/audio.wav")
        )
        payload = installer.services["events"].append.call_args.args[0]
        self.assertEqual(payload["code"], "INSTALLATION_FAILED")
        self.assertNotIn(
            "secret-private-value",
            json.dumps(installer.state.value) + json.dumps(payload),
        )


class ControlWireTests(unittest.TestCase):
    def test_registration_sends_digest_only_and_pairing_and_repair_use_correct_scopes(
        self,
    ):
        installation_id = str(uuid4())
        requests = []

        def http(request, timeout):
            requests.append(request)
            response = io.BytesIO(b"{}")
            response.status = 200
            return response

        client = ControlClient(
            "https://api.test/api/v1",
            installation_id,
            "fixture-setup-secret",
            setup=True,
            http_open=http,
        )
        body = {
            "installationId": installation_id,
            "tokenSha256": "a" * 64,
            "installerBuild": 1,
            "os": "linux",
            "arch": "x64",
        }
        client.register_installation(body)
        self.assertNotIn("Authorization", requests[-1].headers)
        self.assertEqual(json.loads(requests[-1].data), body)
        self.assertNotIn(b"fixture-setup-secret", requests[-1].data)
        client.request_pairing(
            {
                "operationId": str(uuid4()),
                "workerKeySha256": "b" * 64,
                "reportId": "a" * 24,
            }
        )
        self.assertTrue(
            requests[-1].full_url.endswith(
                f"/worker-installations/{installation_id}/pairing"
            )
        )
        self.assertEqual(
            requests[-1].headers["Authorization"], "Bearer fixture-setup-secret"
        )
        with self.assertRaises(ValueError):
            client.identity()
        permanent = ControlClient(
            "https://api.test/api/v1",
            installation_id,
            "fixture-permanent-secret",
            http_open=http,
        )
        permanent.identity()
        self.assertTrue(requests[-1].full_url.endswith("/worker/identity"))
        self.assertEqual(requests[-1].data, b"{}")
        with self.assertRaises(ValueError):
            permanent.request_pairing({})


if __name__ == "__main__":
    unittest.main()
