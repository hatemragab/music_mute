"""Bootstrap stage re-authentication: the v1 install source and its integrity."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from musicmute_worker.bootstrap_release import (
    digest_file,
    load_descriptor,
    parse_inventory,
    stage_artifact_digest,
    verify_stage,
)
from musicmute_worker.profiles import ProfileError
from test_update_activation import target

STAGE_NAME = "bootstrap-" + "a" * 64


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def build_stage(root, *, descriptor=None, files=None, name=STAGE_NAME):
    """Create a stage with a genuine inventory; callers then tamper as needed."""
    stage = Path(root) / name
    payload = {
        "profiles/synthetic-only.candidate.json": "{}",
        "profiles/synthetic-only.lock.json": "{}",
        "musicmute_worker/__init__.py": "",
    }
    payload.update(files or {})
    for relative, text in payload.items():
        path = stage / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    inventory = {
        path.relative_to(stage).as_posix(): digest_file(path)
        for path in sorted(stage.rglob("*"))
        if path.is_file()
    }
    value = dict(target(2) if descriptor is None else descriptor)
    value["artifactSha256"] = stage_artifact_digest(inventory)
    descriptor_path = stage / "release.json"
    descriptor_path.write_text(canonical(value))
    inventory["release.json"] = digest_file(descriptor_path)
    lines = "".join(
        f"{digest}  ./{name}\n" for name, digest in sorted(inventory.items())
    )
    (stage / ".bootstrap-sha256").write_text(lines)
    return stage


def rewrite_inventory(stage):
    inventory = {
        path.relative_to(stage).as_posix(): digest_file(path)
        for path in sorted(stage.rglob("*"))
        if path.is_file() and path.name != ".bootstrap-sha256"
    }
    (stage / ".bootstrap-sha256").write_text(
        "".join(f"{value}  ./{name}\n" for name, value in sorted(inventory.items()))
    )


class InventoryTests(unittest.TestCase):
    def test_both_hash_tool_formats_are_accepted(self):
        text = (
            "SHA256 (./python/bin/python3) = "
            + "1" * 64
            + "\n"
            + "2" * 64
            + "  ./musicmute_worker/worker.py\n"
        )
        self.assertEqual(
            parse_inventory(text),
            {
                "python/bin/python3": "1" * 64,
                "musicmute_worker/worker.py": "2" * 64,
            },
        )

    def test_unsafe_or_ambiguous_lines_are_rejected(self):
        for text in (
            "",
            "not an inventory line\n",
            "3" * 64 + "  ../escape.py\n",
            "3" * 64 + "  /absolute.py\n",
            "3" * 64 + "  ./a.py\n" + "4" * 64 + "  ./a.py\n",
            "3" * 64 + "  ./" + ".bootstrap-sha256\n",
        ):
            with self.assertRaises(ProfileError):
                parse_inventory(text)


class StageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()

    def test_verified_stage_yields_a_bound_descriptor(self):
        stage = build_stage(self.root)
        descriptor, digest = load_descriptor(stage)
        self.assertEqual(descriptor["buildNumber"], 2)
        self.assertRegex(digest, r"^[a-f0-9]{64}$")
        self.assertEqual(descriptor["artifactSha256"], digest)
        self.assertEqual(digest, stage_artifact_digest(verify_stage(stage)))

    def test_modified_member_fails_before_any_descriptor_is_read(self):
        stage = build_stage(self.root)
        (stage / "musicmute_worker" / "__init__.py").write_text("tampered")
        with self.assertRaises(ProfileError):
            load_descriptor(stage)

    def test_extra_and_missing_members_fail(self):
        stage = build_stage(self.root)
        (stage / "musicmute_worker" / "extra.py").write_text("x")
        with self.assertRaises(ProfileError):
            load_descriptor(stage)
        (stage / "musicmute_worker" / "extra.py").unlink()
        load_descriptor(stage)
        (stage / "musicmute_worker" / "__init__.py").unlink()
        with self.assertRaises(ProfileError):
            load_descriptor(stage)

    def test_descriptor_cannot_restate_its_own_release_identity(self):
        stage = build_stage(self.root)
        load_descriptor(stage)
        path = stage / "release.json"
        value = json.loads(path.read_text())
        value["buildNumber"] = 9
        value["artifactSha256"] = "0" * 64
        path.write_text(canonical(value))
        rewrite_inventory(stage)
        # A descriptor that contradicts the payload is rejected outright.
        with self.assertRaises(ProfileError):
            load_descriptor(stage)

    def test_rewriting_the_descriptor_cannot_change_the_payload_identity(self):
        stage = build_stage(self.root)
        _, digest = load_descriptor(stage)
        path = stage / "release.json"
        value = json.loads(path.read_text())
        value["buildNumber"] = 9
        value.pop("artifactSha256")
        path.write_text(canonical(value))
        rewrite_inventory(stage)
        # Parameters may change; the release identity still comes from the bytes.
        # This is corruption detection, not a signature: a writer inside the
        # protected root can rewrite the inventory as well, so authenticity
        # rests on the recipe digest checked at download time.
        after, digest_after = load_descriptor(stage)
        self.assertEqual(after["buildNumber"], 9)
        self.assertEqual(digest, digest_after)

    def test_symlinked_member_and_wrong_stage_name_are_rejected(self):
        stage = build_stage(self.root)
        (stage / "musicmute_worker" / "link.py").symlink_to(
            stage / "musicmute_worker" / "__init__.py"
        )
        with self.assertRaises(ProfileError):
            verify_stage(stage)
        (stage / "musicmute_worker" / "link.py").unlink()
        renamed = self.root / ("bootstrap-" + "b" * 63)
        (self.root / STAGE_NAME).rename(renamed)
        with self.assertRaises(ProfileError):
            verify_stage(renamed)

    def test_missing_inventory_is_not_a_trusted_stage(self):
        stage = build_stage(self.root)
        (stage / ".bootstrap-sha256").unlink()
        with self.assertRaises(ProfileError):
            load_descriptor(stage)

    def test_missing_descriptor_is_a_recipe_failure(self):
        stage = build_stage(self.root)
        (stage / "release.json").unlink()
        rewrite_inventory(stage)
        with self.assertRaises(ProfileError):
            load_descriptor(stage)

    def test_artifact_digest_ignores_only_the_descriptor(self):
        one = {"release.json": "x", "a.py": "1"}
        two = {"release.json": "y", "a.py": "1"}
        self.assertEqual(stage_artifact_digest(one), stage_artifact_digest(two))
        self.assertNotEqual(
            stage_artifact_digest(one), stage_artifact_digest({"a.py": "2"})
        )
        self.assertEqual(
            stage_artifact_digest(one),
            hashlib.sha256(canonical({"a.py": "1"}).encode()).hexdigest(),
        )


if __name__ == "__main__":
    unittest.main()
