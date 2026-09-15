"""macOS host logic: identity, protected storage, exclusion, evidence, refusal.

Everything here either reads this machine directly or replaces the native
boundary with a fixture. None of it is boot, service, containment or GPU proof:
raising the processing child is not implemented, so no test in this file can
claim that a worker was ever supervised.
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from musicmute_worker.platforms import macos as macos_module
from musicmute_worker.platforms.macos import MacosHost, MacosHostError
from musicmute_worker.runtime_types import BootReport
from musicmute_worker.setup_config import SetupHostConfig
from test_bootstrap_release import build_stage

requires_darwin = unittest.skipUnless(
    sys.platform == "darwin", "macOS host logic requires a macOS interpreter"
)


class HostFixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        for name in (
            "identity",
            "config",
            "state",
            "releases",
            "models",
            "journals",
            "events",
        ):
            (self.base / name).mkdir(mode=0o700)
        self.stage = build_stage(
            self.base / "releases",
            files={"python/python3": "#!/bin/sh\n", "trust/root.json": "{}"},
        )
        self.python = self.stage / "python" / "python3"
        self.python.chmod(0o700)
        document = {
            "schemaVersion": 3,
            "apiBaseUrl": "https://api.music-mute.com/api/v1",
            "paths": {
                name: str(self.base / name)
                for name in (
                    "identity",
                    "config",
                    "state",
                    "releases",
                    "models",
                    "journals",
                    "events",
                )
            },
            "distributionOrigin": "https://updates.music-mute.com",
            "bootstrapRootPath": str(self.stage / "trust" / "root.json"),
            "launcherPath": str(self.python),
            "launcherBuild": 7,
            "installerBuild": 4,
        }
        import json

        path = self.base / "config" / "setup-host.json"
        path.write_text(json.dumps(document))
        self.config = SetupHostConfig.load(path)
        self.host = MacosHost(self.config)

    def context(
        self,
        *,
        filevault=False,
        running=True,
        accelerator=True,
        boot_id="1",
        installed=True,
    ):
        """A BootReport produced with the native boundary replaced."""
        return patch.multiple(
            self.host,
            _installed=lambda: installed,
            filevault_enabled=lambda: filevault,
            service_running=lambda: running,
            accelerator_available=lambda: accelerator,
            boot_identity=lambda: boot_id,
        )


@requires_darwin
class IdentityTests(HostFixture):
    def test_detection_reports_this_machine_with_the_entrypoint_binding(self):
        import hashlib

        detection = self.host.detect()
        self.assertEqual(detection["os"], "macos")
        self.assertIn(detection["arch"], ("arm64", "x64"))
        self.assertRegex(detection["machineBindingSha256"], r"^[a-f0-9]{64}$")
        # The entrypoint computes the same value in shell; a mismatch here would
        # make a correctly installed machine look like a clone.
        self.assertEqual(
            detection["machineBindingSha256"],
            hashlib.sha256(
                (
                    "musicmute-worker-machine-v1\nmacos\n"
                    + MacosHost._platform_uuid()
                    + "\n"
                ).encode()
            ).hexdigest(),
        )

    def test_a_translated_process_refuses_rather_than_building_an_x64_runtime(self):
        with (
            patch.object(
                macos_module,
                "_sysctl",
                side_effect=lambda name: (
                    "1" if name == "sysctl.proc_translated" else None
                ),
            ),
            self.assertRaisesRegex(MacosHostError, "UNSUPPORTED_OS_ARCH"),
        ):
            self.host.detect()

    def test_an_unreadable_machine_identifier_is_not_guessed(self):
        with (
            patch.object(macos_module, "_sysctl", return_value=None),
            self.assertRaises(MacosHostError),
        ):
            self.host.detect()


@requires_darwin
class SecretTests(HostFixture):
    def test_round_trip_is_owner_only_and_replaces_atomically(self):
        self.host.protect_secret("worker-token", b"a" * 64)
        self.assertEqual(self.host.load_secret("worker-token"), b"a" * 64)
        path = self.base / "identity" / "secrets" / "worker-token"
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.host.protect_secret("worker-token", b"b" * 64)
        self.assertEqual(self.host.load_secret("worker-token"), b"b" * 64)
        self.assertEqual(
            [item.name for item in path.parent.iterdir()], ["worker-token"]
        )

    def test_names_are_allowlisted_and_missing_records_are_not_invented(self):
        for name in ("../escape", "Worker-Token", "", "a" * 65, "a/b"):
            with self.assertRaises(ValueError):
                self.host.protect_secret(name, b"x")
        with self.assertRaises(FileNotFoundError):
            self.host.load_secret("absent")

    def test_a_linked_or_group_readable_record_is_refused(self):
        self.host.protect_secret("worker-token", b"a" * 64)
        path = self.base / "identity" / "secrets" / "worker-token"
        link = path.parent / "link"
        link.symlink_to(path)
        with self.assertRaises(ValueError):
            self.host.load_secret("link")
        path.chmod(0o640)
        with self.assertRaises(ValueError):
            self.host.load_secret("worker-token")


@requires_darwin
class LockTests(HostFixture):
    def test_machine_lock_is_exclusive_and_released_on_exit(self):
        first = self.host.acquire_machine_lock()
        first.__enter__()
        try:
            with (
                self.assertRaisesRegex(MacosHostError, "BOOTSTRAP_BUSY"),
                self.host.acquire_machine_lock(),
            ):
                pass
        finally:
            first.__exit__(None, None, None)
        with self.host.acquire_machine_lock():
            pass

    def test_bootstrap_lock_is_the_entrypoint_handoff_inode(self):
        import fcntl

        with self.host.acquire_bootstrap_lock():
            descriptor = os.open(
                self.base / "state" / "bootstrap.lock", os.O_RDWR | os.O_CREAT, 0o600
            )
            try:
                # The importer must exclude the shell entrypoint on this exact
                # retained inode, not merely a file of the same name.
                with self.assertRaises(OSError):
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(descriptor)

    def test_a_symlinked_lock_path_is_refused(self):
        target = self.base / "state" / "elsewhere"
        target.write_text("")
        (self.base / "state" / "machine.lock").symlink_to(target)
        with self.assertRaises(ValueError), self.host.acquire_machine_lock():
            pass

    def test_directory_sync_is_available(self):
        self.host.sync_directory(self.base / "state")


@requires_darwin
class ServiceDefinitionTests(HostFixture):
    def test_definition_is_deterministic_and_never_a_login_agent(self):
        first = self.host.service_definition("synthetic-only")
        second = self.host.service_definition("synthetic-only")
        self.assertEqual(first, second)
        self.assertTrue(str(macos_module.PLIST).startswith("/Library/LaunchDaemons/"))
        self.assertEqual(first["userName"], "_musicmute")
        self.assertNotIn("_musicmute", first["program"])
        self.assertIn("--service", first["program"])
        self.assertEqual(first["processType"], "Background")
        # KeepAlive on failure only: a deliberate pause must not be restarted.
        self.assertEqual(first["keepAlive"], {"SuccessfulExit": False})

    def test_binding_tracks_the_profile_not_just_the_label(self):
        self.assertNotEqual(
            self.host._binding("a-profile"), self.host._binding("another-profile")
        )

    def test_profile_identity_comes_from_the_verified_stage(self):
        self.assertEqual(self.host.profile_id(), "synthetic-only")

    def test_install_refuses_a_launcher_other_than_the_configured_one(self):
        with self.assertRaisesRegex(MacosHostError, "STARTUP_INSTALL_FAILED"):
            self.host.install_boot_service("/tmp/elsewhere/python3")
        self.assertFalse(self.host._installed())

    def test_absence_of_the_service_definition_is_reported_not_assumed(self):
        with self.context(installed=False):
            report = self.host.check_service_context()
        self.assertFalse(report["installed"])
        self.assertFalse(report["serviceContextPassed"])
        self.assertIn("STARTUP_INSTALL_FAILED", report["reasonCodes"])


@requires_darwin
class BootEvidenceTests(HostFixture):
    def test_report_matches_the_contract_and_claims_nothing_unproven(self):
        with self.context(
            filevault=False, running=True, accelerator=True, boot_id="100"
        ):
            report = self.host.check_service_context()
        self.assertEqual(set(report), set(BootReport.__annotations__))
        self.assertTrue(report["installed"])
        self.assertFalse(report["unattendedRebootPassed"])
        self.assertEqual(report["observedBootId"], "100")
        self.assertTrue(report["serviceContextPassed"])

    def test_filevault_blocks_unattended_boot_without_weakening_the_host(self):
        (self.base / "state" / "boot-identity.json").write_text(
            '{"schemaVersion": 3, "observedBootId": "1", "provenBootId": null}'
        )
        with self.context(filevault=True, running=True, accelerator=True, boot_id="2"):
            report = self.host.check_service_context()
        # Encrypted volume: the daemon cannot start before a person unlocks it.
        self.assertIn("PREBOOT_UNLOCK_REQUIRED", report["reasonCodes"])
        self.assertFalse(report["unattendedRebootPassed"])

    def test_unattended_boot_needs_a_prior_boot_a_change_and_a_live_service(self):
        record = self.base / "state" / "boot-identity.json"
        record.write_text(
            '{"schemaVersion": 3, "observedBootId": "1", "provenBootId": null}'
        )
        with self.context(filevault=False, running=True, accelerator=True, boot_id="2"):
            self.assertTrue(self.host.check_service_context()["unattendedRebootPassed"])
        # A live service, a changed boot id, but no prior record: not proof.
        record.unlink()
        with self.context(filevault=False, running=True, accelerator=True, boot_id="3"):
            self.assertFalse(
                self.host.check_service_context()["unattendedRebootPassed"]
            )
        # Same boot id: nothing restarted, so nothing was proven.
        record.write_text(
            '{"schemaVersion": 3, "observedBootId": "4", "provenBootId": null}'
        )
        with self.context(filevault=False, running=True, accelerator=True, boot_id="4"):
            self.assertFalse(
                self.host.check_service_context()["unattendedRebootPassed"]
            )

    def test_boot_proof_is_sticky_within_a_boot_and_cleared_by_the_next_one(self):
        record = self.base / "state" / "boot-identity.json"
        record.write_text(
            '{"schemaVersion": 3, "observedBootId": "1", "provenBootId": null}'
        )
        with self.context(filevault=False, running=True, accelerator=True, boot_id="2"):
            self.assertTrue(self.host.check_service_context()["unattendedRebootPassed"])
            # Repeated observation during the same boot must not withdraw proof.
            # Recomputing it from the last observed identity alone would report
            # true exactly once and then drop readiness for a machine that did
            # in fact reboot unattended.
            self.assertTrue(self.host.check_service_context()["unattendedRebootPassed"])
            self.assertTrue(self.host.check_service_context()["unattendedRebootPassed"])
        # The next boot boundary is observed with the service already live, which
        # is the only evidence launchd exposes; it is not proof that nobody
        # logged in, only that the service was up across a boot we witnessed.
        with self.context(filevault=False, running=True, accelerator=True, boot_id="3"):
            self.assertTrue(self.host.check_service_context()["unattendedRebootPassed"])
            self.assertTrue(self.host.check_service_context()["unattendedRebootPassed"])

    def test_unknown_native_state_is_reported_not_substituted(self):
        (self.base / "state" / "boot-identity.json").write_text(
            '{"schemaVersion": 3, "observedBootId": "1", "provenBootId": null}'
        )
        with self.context(filevault=None, running=True, accelerator=True, boot_id="2"):
            report = self.host.check_service_context()
        # An unreadable encryption state is never reported as "no encryption",
        # and it can never authorise unattended boot.
        self.assertIn("PREBOOT_UNLOCK_REQUIRED", report["reasonCodes"])
        self.assertFalse(report["unattendedRebootPassed"])
        self.assertEqual(report["observedBootId"], "2")

    def test_an_unknown_accelerator_is_unavailable_rather_than_absent(self):
        with self.context(filevault=False, running=True, accelerator=None, boot_id="1"):
            report = self.host.check_service_context()
        self.assertFalse(report["serviceContextPassed"])
        self.assertIn("GPU_UNAVAILABLE_IN_SERVICE", report["reasonCodes"])

    def test_a_stopped_service_or_absent_accelerator_never_passes_context(self):
        with self.context(
            filevault=False, running=False, accelerator=True, boot_id="1"
        ):
            report = self.host.check_service_context()
        self.assertFalse(report["serviceContextPassed"])
        with self.context(
            filevault=False, running=True, accelerator=False, boot_id="1"
        ):
            report = self.host.check_service_context()
        self.assertFalse(report["serviceContextPassed"])
        self.assertIn("GPU_UNAVAILABLE_IN_SERVICE", report["reasonCodes"])


@requires_darwin
class ContainmentTests(HostFixture):
    def test_containment_is_refused_rather_than_answered_without_a_child(self):
        with self.assertRaisesRegex(MacosHostError, "OWNERSHIP_UNRESOLVED"):
            self.host.descendants_stopped()
        with self.assertRaisesRegex(MacosHostError, "OWNERSHIP_UNRESOLVED"):
            self.host.stop_worker()
        self.assertIsNone(self.host.read_worker_boundary())

    def test_a_mismatched_or_malformed_containment_identity_is_rejected(self):
        for value in ("", "x" * 129, 7):
            with self.assertRaises(ValueError):
                self.host.stop_and_verify_descendants(value)
        with self.assertRaisesRegex(MacosHostError, "OWNERSHIP_UNRESOLVED"):
            self.host.stop_and_verify_descendants("never-created")

    def test_raising_the_child_refuses_instead_of_faking_containment(self):
        # The authenticated launch channel and its child entry point do not exist
        # yet. Refusing keeps `descendants_stopped` from answering on behalf of a
        # process this adapter never supervised.
        with self.assertRaisesRegex(MacosHostError, "STARTUP_INSTALL_FAILED"):
            self.host.create_child(None, None, None, None)

    def test_a_live_process_is_enumerated_by_ancestry(self):
        child = os.fork()
        if child == 0:  # pragma: no cover - child exits immediately
            os._exit(0)
        try:
            self.assertIn(child, self.host._descendants(os.getpid()))
        finally:
            os.waitpid(child, 0)
        self.assertNotIn(child, self.host._descendants(os.getpid()))


if __name__ == "__main__":
    unittest.main()
