import hashlib
from pathlib import Path
import tempfile
import unittest
from dataclasses import replace
import io
import tarfile

from musicmute_worker.profiles import (
    Asset,
    ProfileError,
    Profile,
    PreparedRuntime,
    provider_options,
    verified_asset,
    extract_python,
    smoke_fixture,
    SMOKE_SHA256,
    digest_file,
    runtime_inventory,
)
from musicmute_worker.hardware import Hardware, Device, compatible_profiles


class ProfileTests(unittest.TestCase):
    def _runtime_fixture(self, root):
        root = root.resolve()
        manifest = (
            Path(__file__).resolve().parents[1]
            / "profiles/macos-arm64-coreml.candidate.json"
        )
        profile = Profile.load(manifest, digest_file(manifest))
        model = root.parent / "model.fixture"
        model.write_bytes(b"model")
        model_asset = Asset(
            "model.fixture", "https://example.com/model", digest_file(model), 5
        )
        profile = replace(
            profile,
            status="qualified",
            evidence_sha256="a" * 64,
            model=model_asset,
            reference=profile.fixture,
        )
        executable = root / "python/bin/python3.12"
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"synthetic interpreter; never executed")
        executable.chmod(0o700)
        (root / "venv/bin").mkdir(parents=True)
        python = root / "venv/bin/python"
        python.symlink_to("../../python/bin/python3.12")
        ffmpeg, ffprobe = root / "ffmpeg", root / "ffprobe"
        ffmpeg.write_bytes(b"synthetic ffmpeg")
        ffprobe.write_bytes(b"synthetic ffprobe")
        ffmpeg.chmod(0o700)
        ffprobe.chmod(0o700)
        (root / "work").mkdir()
        report = {
            "profileId": profile.profile_id,
            "modelSha256": model_asset.sha256,
            "fixtureSha256": profile.fixture.sha256,
            "provider": profile.provider,
            "deviceLabel": "synthetic",
            "wallMilliseconds": 1,
            "peakRamBytes": 1,
            "peakGpuMemoryBytes": None,
            "acceleratorUsed": True,
            "outputValid": True,
            "referenceCheckPassed": True,
            "serviceContextPassed": True,
            "reasonCodes": [],
        }
        return PreparedRuntime(
            python,
            profile,
            model,
            ffmpeg,
            root,
            {},
            qualification_report=report,
            ffprobe=ffprobe,
            runtime_inventory=runtime_inventory(root),
        )

    def test_complete_runtime_inventory_accepts_unchanged_runtime_and_work_data(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime_fixture(Path(directory) / "runtime")
            runtime.assert_claim_ready()
            (runtime.root / "work" / "observation.json").write_text("{}")
            runtime.assert_claim_ready()

    def test_runtime_inventory_rejects_retargeted_interpreter(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime_fixture(Path(directory) / "runtime")
            runtime.python.unlink()
            runtime.python.symlink_to("/usr/bin/false")
            with self.assertRaises(ProfileError):
                runtime.assert_claim_ready()

    def test_runtime_inventory_rejects_unexpected_importable_and_bytecode_files(self):
        for name in (
            "venv/sitecustomize.py",
            "venv/extra.pth",
            "python/__pycache__/injected.pyc",
            "venv/injected.pyc",
            "injected.py",
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                runtime = self._runtime_fixture(Path(directory) / "runtime")
                path = runtime.root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"unexpected")
                with self.assertRaises(ProfileError):
                    runtime.assert_claim_ready()

    def test_runtime_inventory_rejects_links_into_mutable_work(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime_fixture(Path(directory) / "runtime")
            target = runtime.root / "work" / "injected.py"
            target.write_text("pass")
            runtime.python.unlink()
            runtime.python.symlink_to(target)
            with self.assertRaises(ProfileError):
                runtime.assert_claim_ready()

    def test_candidate_runtime_cannot_claim_or_emit_product_descriptor(self):
        manifest = (
            Path(__file__).resolve().parents[1]
            / "profiles/macos-arm64-coreml.candidate.json"
        )
        profile = Profile.load(manifest, digest_file(manifest))
        runtime = PreparedRuntime(
            Path("/unused/python"),
            profile,
            Path("/unused/model"),
            Path("/unused/ffmpeg"),
            Path("/unused"),
            {},
        )
        with self.assertRaises(ProfileError):
            runtime.assert_claim_ready()
        with self.assertRaises(ProfileError):
            runtime.descriptor()

    def test_gpu_only_provider_options(self):
        self.assertEqual(
            provider_options("OpenVINOExecutionProvider", {"device_type": "GPU"}),
            {"device_type": "GPU"},
        )
        for provider, options in (
            ("CPUExecutionProvider", {}),
            ("OpenVINOExecutionProvider", {"device_type": "AUTO"}),
            ("ArmNNExecutionProvider", {"backend_type": "CpuAcc"}),
            ("ArmNNExecutionProvider", {"backend_type": "GpuAcc"}),
            ("CoreMLExecutionProvider", {"MLComputeUnits": "ALL"}),
        ):
            with self.subTest(provider=provider), self.assertRaises(ProfileError):
                provider_options(provider, options)

    def test_cache_is_rehashed_and_exact_length_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "asset"
            path.write_bytes(b"good")
            asset = Asset(
                "asset",
                "https://example.com/asset",
                hashlib.sha256(b"good").hexdigest(),
                4,
            )
            self.assertEqual(verified_asset(path, asset), path)
            path.write_bytes(b"evil")
            with self.assertRaises(ProfileError):
                verified_asset(path, asset)
            path.write_bytes(b"goodextra")
            with self.assertRaises(ProfileError):
                verified_asset(path, asset)

    def test_symlink_cache_is_never_trusted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "target").write_bytes(b"good")
            (root / "asset").symlink_to(root / "target")
            with self.assertRaises(ProfileError):
                verified_asset(
                    root / "asset",
                    Asset(
                        "asset",
                        "https://example.com/asset",
                        hashlib.sha256(b"good").hexdigest(),
                        4,
                    ),
                )

    def test_unknown_memory_is_not_zero(self):
        host = Hardware(
            "macos",
            "arm64",
            "26.6.2",
            None,
            1000000000,
            (Device("apple", "Apple GPU", None, None, True),),
        )
        self.assertIsNone(host.ram_bytes)
        self.assertIsNone(host.devices[0].vram_bytes)
        self.assertEqual(compatible_profiles([], host), ())

    def test_deterministic_fixture_matches_reviewed_digest(self):
        self.assertEqual(hashlib.sha256(smoke_fixture()).hexdigest(), SMOKE_SHA256)

    def test_archive_aliases_become_regular_files_and_escape_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for target, valid in (("python3.12", True), ("../../../outside", False)):
                archive = root / ("valid.tar.gz" if valid else "invalid.tar.gz")
                with tarfile.open(archive, "w:gz") as bundle:
                    member = tarfile.TarInfo("python/bin/python3.12")
                    member.size = 4
                    bundle.addfile(member, io.BytesIO(b"test"))
                    link = tarfile.TarInfo("python/bin/python")
                    link.type = tarfile.SYMTYPE
                    link.linkname = target
                    bundle.addfile(link)
                if valid:
                    extracted = extract_python(archive, root / "valid")
                    self.assertEqual(extracted.read_bytes(), b"test")
                    self.assertFalse(extracted.with_name("python").is_symlink())
                else:
                    with self.assertRaises(ProfileError):
                        extract_python(archive, root / "invalid")
                    self.assertFalse((root / "invalid").exists())

    def test_archive_rejects_cycles_dangling_and_file_directory_conflicts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, target in enumerate(("python", "missing", "/absolute")):
                archive = root / f"{index}.tar.gz"
                with tarfile.open(archive, "w:gz") as bundle:
                    link = tarfile.TarInfo("python/bin/python")
                    link.type = tarfile.SYMTYPE
                    link.linkname = target
                    bundle.addfile(link)
                with self.assertRaises(ProfileError):
                    extract_python(archive, root / f"out{index}")
                self.assertFalse((root / f"out{index}").exists())


if __name__ == "__main__":
    unittest.main()
