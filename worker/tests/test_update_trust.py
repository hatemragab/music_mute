import hashlib
import io
import tempfile
import unittest
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from uuid import uuid4

from musicmute_worker.update.download import DistributionOrigin
from musicmute_worker.update.trust import ReleaseVerifier
from securesystemslib.signer import CryptoSigner
from tuf.api.exceptions import DownloadError, RepositoryError
from tuf.api.metadata import (
    Metadata,
    MetaFile,
    Root,
    Snapshot,
    TargetFile,
    Targets,
    Timestamp,
)


class Repository:
    def __init__(self):
        self.key = CryptoSigner.generate_ed25519()
        self.expires = datetime.now(timezone.utc) + timedelta(days=1)
        root = Root(expires=self.expires, consistent_snapshot=False)
        for role in ("root", "timestamp", "snapshot", "targets"):
            root.add_key(self.key.public_key, role)
        self.root = Metadata(root)
        self.root.sign(self.key)
        self.bootstrap = self.root.to_bytes()
        self.files = {}
        self.data = b"signed bundle"
        digest = hashlib.sha256(self.data).hexdigest()
        release = str(uuid4())
        self.target = {
            "approvedProfile": None,
            "os": "macos",
            "arch": "arm64",
            "compatibleSources": [],
            "releaseId": release,
            "buildNumber": 7,
            "profileId": "test-profile",
            "artifactPath": f"/releases/{release}/test-profile/{digest}/worker.zip",
            "artifactBytes": len(self.data),
            "artifactSha256": digest,
            "runtimeLockSha256": "1" * 64,
            "modelSha256": "2" * 64,
            "minimumLauncherBuild": 1,
            "protocolMin": 3,
            "protocolMax": 3,
            "stateReadMin": 3,
            "stateReadMax": 3,
        }
        self.publish()

    def publish(self, version=1, expires=None):
        exp = expires or self.expires
        target = TargetFile(
            self.target["artifactBytes"],
            {"sha256": self.target["artifactSha256"]},
            self.target["artifactPath"][1:],
            unrecognized_fields={"custom": {"musicmuteRelease": self.target.copy()}},
        )
        self.targets = Metadata(
            Targets(version=version, expires=exp, targets={target.path: target})
        )
        self.targets.sign(self.key)
        raw = self.targets.to_bytes()
        self.files["targets.json"] = raw
        snapshot = Metadata(
            Snapshot(
                version=version,
                expires=exp,
                meta={
                    "targets.json": MetaFile(
                        version, len(raw), {"sha256": hashlib.sha256(raw).hexdigest()}
                    )
                },
            )
        )
        snapshot.sign(self.key)
        raw = snapshot.to_bytes()
        self.files["snapshot.json"] = raw
        timestamp = Metadata(
            Timestamp(
                version=version,
                expires=exp,
                snapshot_meta=MetaFile(
                    version, len(raw), {"sha256": hashlib.sha256(raw).hexdigest()}
                ),
            )
        )
        timestamp.sign(self.key)
        self.files["timestamp.json"] = timestamp.to_bytes()

    def transport(self, url, headers):
        name = url.split("/")[-1]
        if name not in self.files:
            raise HTTPError(url, 404, "missing", {}, None)
        response = io.BytesIO(self.files[name])
        response.status = 200
        response.headers = {}
        return response

    def verifier(self, root):
        return ReleaseVerifier(
            Path(root).resolve(),
            DistributionOrigin("https://updates.example.test"),
            self.bootstrap,
            nullcontext,
            transport=self.transport,
        )

    @property
    def decision(self):
        return {
            "action": "prepare",
            "target": self.target.copy(),
            "serverTime": datetime.now(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "policyRevision": 1,
            "minimumClaimBuild": 1,
            "allowedFallbackReleaseIds": [],
            "reasonCodes": [],
        }


class TrustTests(unittest.TestCase):
    def test_resolve_and_verify(self):
        repo = Repository()
        with tempfile.TemporaryDirectory() as root:
            verifier = repo.verifier(root)
            target = verifier.resolve(repo.decision)
            path = Path(root).resolve() / "bundle"
            path.write_bytes(repo.data)
            verifier.verify_artifact(target, str(path))
            path.write_bytes(b"corrupted")
            with self.assertRaises(ValueError):
                verifier.verify_artifact(target, str(path))

    def test_reject_corruption_expiry_and_descriptor_mismatch(self):
        for fault in ("corrupt", "expire", "descriptor", "length", "hash", "mix"):
            repo = Repository()
            if fault == "corrupt":
                repo.files["timestamp.json"] = b"garbage"
            if fault == "expire":
                repo.publish(expires=datetime.now(timezone.utc) - timedelta(seconds=1))
            if fault == "descriptor":
                repo.target["buildNumber"] = 8
            if fault == "length":
                repo.target["artifactBytes"] += 1
            if fault == "hash":
                repo.target["artifactSha256"] = "0" * 64
            if fault == "mix":
                repo.files["targets.json"] += b" "
            with (
                self.subTest(fault=fault),
                tempfile.TemporaryDirectory() as root,
                self.assertRaises((RepositoryError, DownloadError, ValueError)),
            ):
                repo.verifier(root).resolve(repo.decision)

    def test_cached_timestamp_rollback_rejected(self):
        repo = Repository()
        old = repo.files.copy()
        repo.publish(version=2)
        with tempfile.TemporaryDirectory() as root:
            repo.verifier(root).resolve(repo.decision)
            repo.files = old
            with self.assertRaises((RepositoryError, DownloadError, ValueError)):
                repo.verifier(root).resolve(repo.decision)

    def test_root_rotation_requires_old_and_new_signatures(self):
        for valid in (True, False):
            repo = Repository()
            new_key = CryptoSigner.generate_ed25519()
            new_root = Root(version=2, expires=repo.expires, consistent_snapshot=False)
            for role in ("root", "timestamp", "snapshot", "targets"):
                new_root.add_key(new_key.public_key, role)
            rotation = Metadata(new_root)
            if valid:
                rotation.sign(repo.key)
            rotation.sign(new_key, append=True)
            repo.files["2.root.json"] = rotation.to_bytes()
            repo.key = new_key
            repo.publish(version=2)
            with self.subTest(valid=valid), tempfile.TemporaryDirectory() as root:
                if valid:
                    repo.verifier(root).resolve(repo.decision)
                else:
                    with self.assertRaises(
                        (RepositoryError, DownloadError, ValueError)
                    ):
                        repo.verifier(root).resolve(repo.decision)

    def test_unresolved_artifact_never_accepted(self):
        with tempfile.TemporaryDirectory() as root:
            repo = Repository()
            with self.assertRaises(ValueError):
                repo.verifier(root).verify_artifact(
                    repo.target, str(Path(root).resolve() / "none")
                )


class AuthenticatedBundleTests(unittest.TestCase):
    def make_bundle(self, directory, *, wrong_hash=False):
        import json
        import zipfile

        path = directory / "bundle.zip"
        member = b'print("synthetic worker")'
        manifest = {
            "schemaVersion": 1,
            "unpackedBytes": 0,
            "files": [
                {
                    "path": "worker.py",
                    "bytes": len(member),
                    "sha256": "0" * 64
                    if wrong_hash
                    else hashlib.sha256(member).hexdigest(),
                    "executable": False,
                }
            ],
        }
        # The manifest's own bytes count toward the unpacked ceiling.
        for _ in range(10):
            raw = json.dumps(manifest, separators=(",", ":")).encode()
            if manifest["unpackedBytes"] == len(raw) + len(member):
                break
            manifest["unpackedBytes"] = len(raw) + len(member)
        with zipfile.ZipFile(path, "w") as bundle:
            bundle.writestr("bundle.json", raw)
            bundle.writestr("worker.py", member)
        return path

    def test_authenticated_inventory_extracts_and_rejects_malformed_members(self):
        for wrong_hash in (False, True):
            with (
                self.subTest(wrong_hash=wrong_hash),
                tempfile.TemporaryDirectory() as root,
            ):
                root = Path(root).resolve()
                repo = Repository()
                path = self.make_bundle(root, wrong_hash=wrong_hash)
                repo.data = path.read_bytes()
                digest = hashlib.sha256(repo.data).hexdigest()
                repo.target.update(artifactBytes=len(repo.data), artifactSha256=digest)
                repo.target["artifactPath"] = (
                    f"/releases/{repo.target['releaseId']}/test-profile/{digest}/worker.zip"
                )
                repo.publish()
                verifier = repo.verifier(root / "metadata")
                verifier.resolve(repo.decision)
                if wrong_hash:
                    with self.assertRaises(ValueError):
                        verifier.extract_artifact(
                            repo.target, str(path), root / "stage", reserve_bytes=0
                        )
                else:
                    verifier.extract_artifact(
                        repo.target, str(path), root / "stage", reserve_bytes=0
                    )
                    self.assertTrue((root / "stage/worker.py").is_file())

    def test_failed_refresh_revokes_previous_resolution(self):
        repo = Repository()
        with tempfile.TemporaryDirectory() as root:
            verifier = repo.verifier(root)
            verifier.resolve(repo.decision)
            repo.files["timestamp.json"] = b"corrupt"
            with self.assertRaises((RepositoryError, DownloadError, ValueError)):
                verifier.resolve(repo.decision)
            with self.assertRaises(ValueError):
                verifier.verify_artifact(repo.target, str(Path(root) / "unused"))


class MetadataBoundaryTests(unittest.TestCase):
    def test_oversized_metadata_rejected(self):
        repo = Repository()
        repo.files["timestamp.json"] = b"x" * 16385
        with (
            tempfile.TemporaryDirectory() as root,
            self.assertRaises((DownloadError, ValueError)),
        ):
            repo.verifier(root).resolve(repo.decision)

    def test_root_expiry_rejected(self):
        repo = Repository()
        repo.root.signed.expires = datetime.now(timezone.utc) - timedelta(seconds=1)
        repo.root.sign(repo.key)
        repo.bootstrap = repo.root.to_bytes()
        with tempfile.TemporaryDirectory() as root, self.assertRaises(RepositoryError):
            repo.verifier(root).resolve(repo.decision)

    def test_forged_cached_root_does_not_replace_embedded_anchor(self):
        trusted = Repository()
        attacker = Repository()
        with tempfile.TemporaryDirectory() as root:
            root = Path(root).resolve()
            (root / "root.json").write_bytes(attacker.bootstrap)
            verifier = ReleaseVerifier(
                root,
                DistributionOrigin("https://updates.example.test"),
                trusted.bootstrap,
                nullcontext,
                transport=attacker.transport,
            )
            with self.assertRaises(RepositoryError):
                verifier.resolve(attacker.decision)
