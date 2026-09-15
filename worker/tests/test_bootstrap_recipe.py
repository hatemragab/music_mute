import copy
import unittest
from uuid import uuid4

from musicmute_worker.bootstrap_recipe import render_entrypoint


class BootstrapRecipeTests(unittest.TestCase):
    def setUp(self):
        digest = "a" * 64
        self.recipe = {
            "schemaVersion": 3,
            "installerBuild": 1,
            "launcherBuild": 1,
            "apiBaseUrl": "https://api.example.test/api/v1",
            "distributionOrigin": "https://updates.music-mute.com",
            "bundles": [
                {
                    "os": "linux",
                    "arch": "x64",
                    "url": f"https://updates.music-mute.com/releases/{uuid4()}/launcher-linux-x64/{digest}/bootstrap.tar.gz",
                    "sha256": digest,
                    "bytes": 1024,
                    "expandedBytes": 4096,
                    "pythonPath": "python/bin/python3",
                    "rootPath": "trust/root.json",
                    "rootSha256": "b" * 64,
                }
            ],
        }

    def test_pins_are_embedded_and_source_is_not_self_configuring(self):
        text = render_entrypoint(self.recipe, "posix")
        self.assertIn("a" * 64, text)
        self.assertIn("b" * 64, text)
        self.assertIn("musicmute_worker.setup_host", text)
        self.assertNotIn("@@RECIPE@@", text)

    def test_rejects_untrusted_urls_and_shell_injection(self):
        for field, value in (
            ("url", "https://evil.example/file"),
            ("url", self.recipe["bundles"][0]["url"] + "?token=x"),
            ("pythonPath", "../python"),
            ("pythonPath", "python/$(touch unsafe)"),
            ("sha256", "A" * 64),
            ("bytes", True),
            ("expandedBytes", 0),
        ):
            with self.subTest(field=field, value=value):
                recipe = copy.deepcopy(self.recipe)
                recipe["bundles"][0][field] = value
                with self.assertRaises(ValueError):
                    render_entrypoint(recipe, "posix")

    def test_rejects_duplicate_profiles_and_unknown_configuration(self):
        self.recipe["bundles"] *= 2
        with self.assertRaises(ValueError):
            render_entrypoint(self.recipe, "posix")
        self.recipe["bundles"].pop()
        self.recipe["unchecked"] = "value"
        with self.assertRaises(ValueError):
            render_entrypoint(self.recipe, "posix")

    def test_windows_selects_only_windows_bundle(self):
        with self.assertRaises(ValueError):
            render_entrypoint(self.recipe, "windows")
        bundle = self.recipe["bundles"][0]
        bundle.update(os="windows", pythonPath="python/python.exe")
        bundle["url"] = bundle["url"].replace(".tar.gz", ".zip")
        text = render_entrypoint(self.recipe, "windows")
        self.assertIn("musicmute_worker.setup_host", text)
        self.assertIn("Get-FileHash", text)


if __name__ == "__main__":
    unittest.main()
