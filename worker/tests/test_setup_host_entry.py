"""Native host registration and protected bootstrap configuration.

These tests exercise the fail-closed surface only. A registered host here is a
fixture, never boot, service or GPU proof.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from musicmute_worker.platforms import registry
from musicmute_worker.setup_config import SetupHostConfig
from musicmute_worker.setup_host import main

STAGE = "bootstrap-" + "c" * 64


class ConfigFixture:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        names = (
            "identity",
            "config",
            "state",
            "releases",
            "models",
            "journals",
            "events",
        )
        for name in names:
            (self.base / name).mkdir(mode=0o700)
        self.stage = self.base / "releases" / STAGE
        (self.stage / "trust").mkdir(parents=True)
        (self.stage / "trust" / "root.json").write_text("{}")
        self.launcher = self.stage / "python"
        self.launcher.mkdir()
        self.python = self.launcher / "python3"
        self.python.write_text("#!/bin/sh\n")
        self.python.chmod(0o700)

    def document(self, **changes):
        value = {
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
        value.update(changes)
        return value

    def write(self, document=None):
        path = self.base / "config" / "setup-host.json"
        path.write_text(
            json.dumps(document if document is not None else self.document())
        )
        return path

    def load(self, **changes):
        return SetupHostConfig.load(self.write(self.document(**changes)))


class ConfigTests(ConfigFixture, unittest.TestCase):
    def test_valid_configuration_binds_stage_builds_and_trust_root(self):
        config = self.load()
        self.assertEqual(config.installer_build, 4)
        self.assertEqual(config.launcher_build, 7)
        self.assertEqual(config.stage, self.stage)
        self.assertEqual(config.bootstrap_root, self.stage / "trust" / "root.json")
        self.assertEqual(config.distribution_origin, "https://updates.music-mute.com")

    def test_unknown_or_missing_fields_are_rejected(self):
        document = self.document()
        document["workerId"] = "sneaky"
        with self.assertRaises(ValueError):
            SetupHostConfig.load(self.write(document))
        document = self.document()
        del document["installerBuild"]
        with self.assertRaises(ValueError):
            SetupHostConfig.load(self.write(document))

    def test_schema_and_url_shape_are_enforced(self):
        for changes in (
            {"schemaVersion": 2},
            {"apiBaseUrl": "http://api.music-mute.com/api/v1"},
            {"apiBaseUrl": "https://api.music-mute.com/other"},
            {"distributionOrigin": "https://updates.music-mute.com/path"},
            {"distributionOrigin": "https://user:pw@updates.music-mute.com"},
            {"launcherBuild": 0},
            {"installerBuild": "4"},
        ):
            with self.assertRaises(ValueError):
                self.load(**changes)

    def test_stage_paths_cannot_escape_the_protected_releases_root(self):
        outside = self.base / "state" / "python3"
        outside.write_text("#!/bin/sh\n")
        outside.chmod(0o700)
        with self.assertRaises(ValueError):
            self.load(launcherPath=str(outside))
        with self.assertRaises(ValueError):
            self.load(bootstrapRootPath=str(self.base / "state" / "setup.json"))
        with self.assertRaises(ValueError):
            self.load(
                bootstrapRootPath=str(self.launcher / ".." / "trust" / "root.json")
            )

    def test_wrong_stage_name_and_non_executable_launcher_are_rejected(self):
        renamed = self.base / "releases" / "bootstrap-not-a-digest"
        self.stage.rename(renamed)
        self.stage = renamed
        self.launcher = renamed / "python"
        self.python = self.launcher / "python3"
        with self.assertRaises(ValueError):
            self.load()
        back = self.base / "releases" / STAGE
        renamed.rename(back)
        self.stage, self.launcher = back, back / "python"
        self.python = self.launcher / "python3"
        self.python.chmod(0o600)
        with self.assertRaises(ValueError):
            self.load()

    def test_symlinked_launcher_and_foreign_config_root_are_rejected(self):
        link = self.launcher / "python3-link"
        link.symlink_to(self.python)
        with self.assertRaises(ValueError):
            self.load(launcherPath=str(link))
        stray = self.base / "state" / "setup-host.json"
        stray.write_text(json.dumps(self.document()))
        with self.assertRaises(ValueError):
            SetupHostConfig.load(stray)


class RegistryTests(unittest.TestCase):
    """The registry is the only place an OS is bound to an implementation."""

    def setUp(self):
        self.saved = dict(registry._HOSTS)
        registry._HOSTS.clear()

    def tearDown(self):
        registry._HOSTS.clear()
        registry._HOSTS.update(self.saved)

    def test_registration_rejects_unknown_platforms_duplicates_and_non_callables(self):
        with self.assertRaises(ValueError):
            registry.register("plan9", lambda config: None)
        with self.assertRaises(TypeError):
            registry.register("macos", "not-callable")
        registry.register("macos", lambda config: None)
        with self.assertRaises(ValueError):
            registry.register("macos", lambda config: None)

    def test_unimplemented_platforms_resolve_to_nothing(self):
        with patch("musicmute_worker.platforms.registry.load_hosts", return_value={}):
            for name in ("windows", "macos", "linux"):
                self.assertIsNone(registry.resolve_host(name))
        with self.assertRaisesRegex(RuntimeError, "UNSUPPORTED_OS_ARCH"):
            registry.resolve_host("plan9")

    def test_only_this_platform_binds_a_host(self):
        hosts = registry.load_hosts()
        if sys.platform == "darwin":
            self.assertTrue(callable(hosts.get("macos")))
        else:
            # A host binds only to the OS it can actually run on.
            self.assertNotIn("macos", hosts)

    def test_open_host_fails_closed_without_a_registered_adapter(self):
        with (
            patch("musicmute_worker.platforms.registry.load_hosts", return_value={}),
            self.assertRaisesRegex(RuntimeError, "STARTUP_INSTALL_FAILED"),
        ):
            registry.open_host(object())

    def test_an_incomplete_adapter_is_rejected_rather_than_used(self):
        registry.register("macos", lambda config: object())
        with (
            patch("musicmute_worker.hardware.detected_os", return_value="macos"),
            self.assertRaisesRegex(RuntimeError, "STARTUP_INSTALL_FAILED"),
        ):
            registry.open_host(object())

    def test_safe_reason_never_leaks_raw_native_text(self):
        self.assertEqual(registry.safe_reason("INSUFFICIENT_DISK"), "INSUFFICIENT_DISK")
        self.assertEqual(
            registry.safe_reason("Traceback (most recent call last)"),
            "STARTUP_INSTALL_FAILED",
        )
        self.assertEqual(registry.safe_reason(""), "STARTUP_INSTALL_FAILED")


class EntrypointTests(ConfigFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.saved = dict(registry._HOSTS)
        registry._HOSTS.clear()

    def tearDown(self):
        registry._HOSTS.clear()
        registry._HOSTS.update(self.saved)

    def test_entrypoint_refuses_with_a_safe_code_when_no_host_is_registered(self):
        with patch("musicmute_worker.platforms.registry.load_hosts", return_value={}):
            self.assertEqual(
                main(["--action", "status", "--config", str(self.write())]), 2
            )

    def test_exactly_one_mode_is_required(self):
        config = str(self.write())
        self.assertEqual(main(["--config", config]), 2)
        self.assertEqual(
            main(["--service", "--action", "status", "--config", config]), 2
        )

    def test_unreadable_configuration_is_refused_not_guessed(self):
        self.assertEqual(main(["--action", "status", "--config", "/nope.json"]), 2)
        bad = self.base / "config" / "setup-host.json"
        bad.write_text("{")
        self.assertEqual(main(["--action", "status", "--config", str(bad)]), 2)


if __name__ == "__main__":
    unittest.main()
