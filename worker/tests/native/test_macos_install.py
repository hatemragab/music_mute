"""Real-machine macOS checks. Skipped unless explicitly enabled on a real host.

Nothing in this file runs by accident. It requires an actual privileged
installation, so it is gated behind `MUSICMUTE_NATIVE_MACOS=1` and root, and it
must be run on the machine under test — never in CI and never on a laptop that
was not deliberately enrolled.

What it can prove: the LaunchDaemon exists with the expected principal, the job
is loaded, secrets live in protected storage, and the containment stop path
reports honestly. What it cannot prove by itself: that a job actually completed
on the GPU. That is F02's report, not this file.
"""

import os
import sys
import unittest
from pathlib import Path

import musicmute_worker.platforms.macos as macos_module

ENABLED = os.environ.get("MUSICMUTE_NATIVE_MACOS") == "1"


@unittest.skipUnless(
    ENABLED and sys.platform == "darwin" and os.geteuid() == 0,
    "requires MUSICMUTE_NATIVE_MACOS=1 as root on the enrolled macOS machine",
)
class NativeMacosInstallTests(unittest.TestCase):
    """Run only on a real, deliberately enrolled Mac."""

    def setUp(self):
        from musicmute_worker.setup_config import SetupHostConfig

        self.config = SetupHostConfig.load(
            Path("/Library/Application Support/MusicMute/config/setup-host.json")
        )
        self.host = macos_module.MacosHost(self.config)

    def test_the_service_account_is_not_root(self):
        """Least privilege is a real property, not a label in a plist."""
        self.assertNotEqual(macos_module.SERVICE_USER, "root")

    def test_the_launch_daemon_is_installed_for_the_expected_principal(self):
        self.assertTrue(macos_module.PLIST.is_file())
        self.assertFalse(macos_module.PLIST.is_symlink())
        import plistlib

        value = plistlib.loads(macos_module.PLIST.read_bytes())
        self.assertEqual(value["Label"], macos_module.LABEL)
        self.assertEqual(value["UserName"], macos_module.SERVICE_USER)
        self.assertNotIn("_musicmute", value["ProgramArguments"])
        # A LaunchAgent would depend on a login session and could not start at boot.
        self.assertTrue(str(macos_module.PLIST).startswith("/Library/LaunchDaemons/"))

    def test_the_service_process_is_actually_running(self):
        running = self.host.service_running()
        self.assertIs(type(running), bool)
        self.assertTrue(running, "the enrolled service is not running")

    def test_no_secret_is_readable_beyond_its_owner(self):
        directory = self.config.paths.identity / "secrets"
        for record in directory.glob("*"):
            self.assertFalse(record.is_symlink(), record)
            self.assertEqual(record.stat().st_mode & 0o077, 0, record)

    def test_the_reported_binding_matches_the_installed_definition(self):
        report = self.host.check_service_context()
        self.assertEqual(
            report["serviceBindingSha256"], self.host._binding(self.host.profile_id())
        )
        self.assertEqual(report["profileId"], self.host.profile_id())

    def test_containment_refuses_rather_than_guessing_without_a_child(self):
        """With no live child the answer must be a refusal, never a confident True."""
        from musicmute_worker.platforms.macos import MacosHostError

        self.host._child = None
        with self.assertRaisesRegex(MacosHostError, "OWNERSHIP_UNRESOLVED"):
            self.host.stop_and_verify_descendants("no-such-containment")

    def test_filevault_state_is_observed_not_assumed(self):
        state = self.host.filevault_enabled()
        self.assertIn(state, (True, False, None))
        report = self.host.check_service_context()
        if state is not True:
            self.assertNotIn("PREBOOT_UNLOCK_REQUIRED", report["reasonCodes"])
        else:
            # An encrypted volume can never authorise unattended boot.
            self.assertIn("PREBOOT_UNLOCK_REQUIRED", report["reasonCodes"])
            self.assertFalse(report["unattendedRebootPassed"])

    def test_unattended_boot_is_reported_per_boot_not_assumed(self):
        """Record the real answer after a genuine restart; never assert it."""
        report = self.host.check_service_context()
        print(
            "unattendedRebootPassed=",
            report["unattendedRebootPassed"],
            "observedBootId=",
            report["observedBootId"],
            "reasons=",
            report["reasonCodes"],
        )


if __name__ == "__main__":
    unittest.main()
