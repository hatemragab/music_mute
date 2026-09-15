"""TUF trust continuity, using the maintained client in the launcher environment."""

import copy
import time
from pathlib import Path
from urllib.error import HTTPError

from ..runtime_types import ReleaseTarget
from .download import (
    MAX_ARTIFACT_BYTES,
    DistributionOrigin,
    open_https,
    private_directory,
    relative_path,
    verify_bytes,
)


class ReleaseVerifier:
    """Serialize every TUF cache access through the native machine lock.

    bootstrap_root is embedded by H01/I01 through the trusted bootstrap channel.
    It is always passed to TUF: cached root.json is never a new trust anchor.
    """

    def __init__(
        self,
        metadata_dir: Path,
        origin: DistributionOrigin,
        bootstrap_root: bytes,
        lock_factory,
        *,
        transport=open_https,
    ):
        if (
            not isinstance(bootstrap_root, bytes)
            or not 1 <= len(bootstrap_root) <= 512_000
        ):
            raise ValueError("A bounded embedded TUF root is required")
        self.metadata_dir = metadata_dir
        self.origin = origin
        self.bootstrap_root = bootstrap_root
        self.lock_factory = lock_factory
        self.transport = transport
        self._verified = {}

    def resolve(self, decision: dict) -> dict:
        from tuf.api.exceptions import DownloadHTTPError

        self._verified.clear()
        from tuf.ngclient import Updater, UpdaterConfig
        from tuf.ngclient.fetcher import FetcherInterface

        from .policy import parse_decision

        decision = parse_decision(decision)
        if decision.get("action") != "prepare" or not isinstance(
            decision.get("target"), dict
        ):
            raise ValueError("Policy does not authorize preparation")
        target = copy.deepcopy(decision["target"])
        if set(target) != set(ReleaseTarget.__annotations__):
            raise ValueError("Invalid release descriptor")
        path = target["artifactPath"]
        if not isinstance(path, str) or not path.startswith("/releases/"):
            raise ValueError("Invalid release artifact path")
        path = relative_path(path[1:])
        if (
            type(target["artifactBytes"]) is not int
            or not 0 < target["artifactBytes"] <= MAX_ARTIFACT_BYTES
        ):
            raise ValueError("Invalid release artifact length")
        origin, transport = self.origin, self.transport

        class Fetcher(FetcherInterface):
            def _fetch(self, url):
                origin.check(url)
                name = url.rsplit("/", 1)[-1]
                ceiling = (
                    512_000
                    if name.endswith("root.json")
                    else 16_384
                    if name == "timestamp.json"
                    else 2_000_000
                    if name.endswith("snapshot.json")
                    else 5_000_000
                )
                count = 0
                deadline = time.monotonic() + 300
                try:
                    with transport(url, {"Accept-Encoding": "identity"}) as response:
                        if response.status != 200:
                            raise DownloadHTTPError(
                                "Metadata request rejected", response.status
                            )
                        if (
                            response.headers.get("Content-Encoding", "identity")
                            != "identity"
                        ):
                            raise ValueError("Encoded metadata refused")
                        while block := response.read(64 * 1024):
                            count += len(block)
                            if count > ceiling or time.monotonic() > deadline:
                                raise ValueError(
                                    "Metadata exceeds transfer policy ceiling"
                                )
                            yield block
                except HTTPError as exc:
                    raise DownloadHTTPError(
                        "Metadata request rejected", exc.code
                    ) from None

        with self.lock_factory():
            private_directory(self.metadata_dir)
            # Root history is part of TUF's continuity chain; symlinked cache
            # entries are refused before the library reads or replaces them.
            if any(
                p.is_symlink() or (p.is_file() and p.stat().st_size > 5_000_000)
                for p in self.metadata_dir.rglob("*")
            ):
                raise ValueError("TUF cache symlink")
            updater = Updater(
                str(self.metadata_dir),
                self.origin.url("metadata") + "/",
                fetcher=Fetcher(),
                bootstrap=self.bootstrap_root,
                config=UpdaterConfig(
                    max_root_rotations=64,
                    max_delegations=8,
                    root_max_length=512_000,
                    timestamp_max_length=16_384,
                    snapshot_max_length=2_000_000,
                    targets_max_length=5_000_000,
                ),
            )
            updater.refresh()
            info = updater.get_targetinfo(path)
            if (
                info is None
                or info.length != target["artifactBytes"]
                or info.hashes.get("sha256") != target["artifactSha256"]
            ):
                raise ValueError("Signed artifact identity mismatch")
            if info.custom.get("musicmuteRelease") != target:
                raise ValueError("Signed release descriptor mismatch")
            self._verified[path] = copy.deepcopy(target)
        return target

    def verify_artifact(self, target: dict, path: str) -> None:
        key = target.get("artifactPath", "").removeprefix("/")
        if self._verified.get(key) != target:
            raise ValueError("Release must first resolve through current TUF metadata")
        verify_bytes(Path(path), target["artifactBytes"], target["artifactSha256"])

    def extract_artifact(
        self, target: dict, path: str, destination: Path, *, reserve_bytes=256 * 1024**2
    ) -> None:
        """Consume the inventory inside the TUF-authenticated ZIP before staging."""
        import hashlib
        import json

        from ..runtime_types import sha256_string
        from .download import extract_bundle, open_bundle

        self.verify_artifact(target, path)
        with open_bundle(Path(path)) as bundle:
            manifest_info = bundle.getinfo("bundle.json")
            if manifest_info.file_size > 1_000_000:
                raise ValueError("Bundle inventory exceeds limit")
            manifest = json.loads(bundle.read(manifest_info))
            if (
                not isinstance(manifest, dict)
                or set(manifest) != {"schemaVersion", "unpackedBytes", "files"}
                or type(manifest["schemaVersion"]) is not int
                or manifest["schemaVersion"] != 1
                or type(manifest["unpackedBytes"]) is not int
                or not 1 <= manifest["unpackedBytes"] <= 32 * 1024**3
                or not isinstance(manifest["files"], list)
                or not 1 <= len(manifest["files"]) <= 100_000
            ):
                raise ValueError("Invalid authenticated bundle inventory")
            names = {"bundle.json"}
            total = manifest_info.file_size
            for entry in manifest["files"]:
                if not isinstance(entry, dict) or set(entry) != {
                    "path",
                    "bytes",
                    "sha256",
                    "executable",
                }:
                    raise ValueError("Invalid authenticated bundle member")
                name = relative_path(entry["path"])
                if (
                    name in names
                    or type(entry["bytes"]) is not int
                    or not 0 <= entry["bytes"] <= manifest["unpackedBytes"]
                    or type(entry["executable"]) is not bool
                ):
                    raise ValueError("Invalid authenticated bundle member")
                names.add(name)
                sha256_string(entry["sha256"])
                info = bundle.getinfo(name)
                if (
                    info.file_size != entry["bytes"]
                    or bool((info.external_attr >> 16) & 0o111) != entry["executable"]
                ):
                    raise ValueError("Authenticated bundle member identity mismatch")
                total += info.file_size
                if total > manifest["unpackedBytes"]:
                    raise ValueError("Bundle inventory exceeds signed ceiling")
                digest = hashlib.sha256()
                size = 0
                with bundle.open(info) as source:
                    while block := source.read(1024 * 1024):
                        size += len(block)
                        if size > entry["bytes"]:
                            raise ValueError("Bundle decompression overflow")
                        digest.update(block)
                if size != entry["bytes"] or digest.hexdigest() != entry["sha256"]:
                    raise ValueError("Authenticated bundle member digest mismatch")
            if total != manifest["unpackedBytes"]:
                raise ValueError("Bundle inventory size mismatch")
        extract_bundle(
            Path(path),
            destination,
            names,
            max_unpacked_bytes=total,
            reserve_bytes=reserve_bytes,
        )
