"""Concrete W02/W03/W04 bridge; native adapters provide only OS evidence.

Every method runs inside the caller's existing machine lock. Versioned Python
environments are prepared at their final paths; failed attempts are retained.
"""

import copy
import hashlib
import json
import re
import shutil
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

from .hardware import compatible_profiles, detect_hardware
from .profiles import (
    PreparedRuntime,
    Profile,
    ProfileError,
    digest_file,
    fetch_asset,
    prepare_runtime,
    runtime_inventory,
)
from .qualification import QualificationRunner
from .runtime_types import BootReport, sha256_string
from .update.activation import ActivePointer, SafeBoundary, environment, safe_boundary


def _digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _copy_tree(source, destination):
    """Copy a verified stage subtree; regular files only, modes preserved."""
    if source.is_symlink() or not source.is_dir():
        raise ProfileError("DEPENDENCY_RECIPE_UNAVAILABLE")
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if path.is_symlink():
            raise ProfileError("UPDATE_SIGNATURE_INVALID")
        target = destination / relative
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True, mode=0o700)
        elif path.is_file():
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copy2(path, target)
        else:
            raise ProfileError("UPDATE_SIGNATURE_INVALID")
    return destination


def _source_inventory(root):
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ProfileError("UPDATE_SIGNATURE_INVALID")
        if path.is_file():
            result[str(path.relative_to(root))] = [
                digest_file(path),
                path.stat().st_mode & 0o777,
            ]
    return _digest(result)


class SharedActivationRuntime:
    def __init__(
        self, paths, records, verifier, client, native, installation_id, launcher_build
    ):
        self.paths = paths
        self.records = records
        self.pointer = ActivePointer(records)
        self.verifier = verifier
        self.client = client
        self.native = native
        self.installation_id = installation_id
        self.launcher_build = launcher_build

    @staticmethod
    def _name(target):
        return (
            "environment-"
            + target["releaseId"]
            + "-"
            + target["runtimeLockSha256"]
            + ".json"
        )

    def prepare(self, target, archive, final_path):
        if target["approvedProfile"] is None:
            raise ProfileError("DEPENDENCY_RECIPE_UNAVAILABLE")
        if target["minimumLauncherBuild"] > self.launcher_build:
            raise ProfileError("DEPENDENCY_RECIPE_UNAVAILABLE")
        expected = (
            self.paths.releases / target["releaseId"] / target["runtimeLockSha256"]
        )
        if final_path != expected or final_path != final_path.resolve():
            raise ValueError("Invalid permanent environment path")
        self.verifier.verify_artifact(target, str(archive))
        existing = self.records.read(self._name(target))
        if existing:
            candidate = existing["environment"]
            if candidate["target"] != target or candidate["path"] != str(final_path):
                raise ValueError("Prepared target mismatch")
            self._load(candidate)
            return copy.deepcopy(candidate)
        final_path.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Each attempt has a permanent distinct root; never move or delete a venv.
        attempt = str(uuid4())
        source = final_path / ("source-" + attempt)
        self.verifier.extract_artifact(target, str(archive), source)
        profile_path = source / "profile.json"
        profile_hash = digest_file(profile_path)
        profile = Profile.load(profile_path, profile_hash)
        self._profile_binding(profile, target)
        if not compatible_profiles([profile], detect_hardware(final_path)):
            raise ProfileError("GPU_PROVIDER_UNAVAILABLE")
        runtime = prepare_runtime(
            profile,
            source / "runtime-lock.json",
            final_path / ("runtime-" + attempt),
            self.paths.models,
        )
        candidate = environment(
            {
                "target": copy.deepcopy(target),
                "path": str(final_path),
                "assets": [
                    target["artifactSha256"],
                    profile.model.sha256,
                    profile.lock_sha256,
                ],
            }
        )
        self.records.write(
            self._name(target),
            {
                "schemaVersion": 3,
                "environment": candidate,
                "source": str(source),
                "sourceInventory": _source_inventory(source),
                "profileSha256": profile_hash,
                "root": str(runtime.root),
                "model": str(runtime.model),
                "versions": runtime.versions,
                "inventorySha256": _digest(runtime.runtime_inventory),
                "report": None,
                "reportId": None,
            },
        )
        return copy.deepcopy(candidate)

    def prepare_from_stage(self, target, stage, final_path):
        """v1 install source: the entrypoint-verified bootstrap stage is the release.

        Integrity comes from re-authenticating the stage inventory by hash before
        any descriptor, profile or source file inside it is read. This is the
        light distribution model; it is not a backend attestation, and the
        backend still decides admission from the real qualification report.
        """
        from .bootstrap_release import load_descriptor

        if target["approvedProfile"] is None:
            raise ProfileError("DEPENDENCY_RECIPE_UNAVAILABLE")
        if target["minimumLauncherBuild"] > self.launcher_build:
            raise ProfileError("DEPENDENCY_RECIPE_UNAVAILABLE")
        local, payload = load_descriptor(Path(stage))
        if local != target or payload != target["artifactSha256"]:
            raise ProfileError("UPDATE_SIGNATURE_INVALID")
        expected = (
            self.paths.releases / target["releaseId"] / target["runtimeLockSha256"]
        )
        if final_path != expected or final_path != final_path.resolve():
            raise ValueError("Invalid permanent environment path")
        existing = self.records.read(self._name(target))
        if existing:
            candidate = existing["environment"]
            if candidate["target"] != target or candidate["path"] != str(final_path):
                raise ValueError("Prepared target mismatch")
            self._load(candidate)
            return copy.deepcopy(candidate)
        stage = Path(stage)
        profile_path = stage / "profiles" / (target["profileId"] + ".candidate.json")
        lock_path = stage / "profiles" / (target["profileId"] + ".lock.json")
        if (
            profile_path.is_symlink()
            or lock_path.is_symlink()
            or not profile_path.is_file()
            or not lock_path.is_file()
        ):
            raise ProfileError("DEPENDENCY_RECIPE_UNAVAILABLE")
        profile = Profile.load(profile_path, digest_file(profile_path))
        self._profile_binding(profile, target)
        if profile.lock_sha256 != target["runtimeLockSha256"]:
            raise ProfileError("UPDATE_SIGNATURE_INVALID")
        final_path.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Each attempt has a permanent distinct root; never move or delete a venv.
        attempt = str(uuid4())
        source = final_path / ("source-" + attempt)
        _copy_tree(stage / "musicmute_worker", source / "musicmute_worker")
        shutil.copy2(profile_path, source / "profile.json")
        if compatible_profiles([profile], detect_hardware(final_path)) != (profile,):
            raise ProfileError("GPU_PROVIDER_UNAVAILABLE")
        runtime = prepare_runtime(
            profile,
            lock_path,
            final_path / ("runtime-" + attempt),
            self.paths.models,
        )
        candidate = environment(
            {
                "target": copy.deepcopy(target),
                "path": str(final_path),
                "assets": [
                    target["artifactSha256"],
                    profile.model.sha256,
                    profile.lock_sha256,
                ],
            }
        )
        self.records.write(
            self._name(target),
            {
                "schemaVersion": 3,
                "environment": candidate,
                "source": str(source),
                "sourceInventory": _source_inventory(source),
                "profileSha256": digest_file(profile_path),
                "root": str(runtime.root),
                "model": str(runtime.model),
                "versions": runtime.versions,
                "inventorySha256": _digest(runtime.runtime_inventory),
                "report": None,
                "reportId": None,
            },
        )
        return copy.deepcopy(candidate)

    @staticmethod
    def _profile_binding(profile, target):
        approval = target["approvedProfile"]
        if approval is None or (
            profile.status != "qualified"
            or profile.profile_id != target["profileId"]
            or profile.os != target["os"]
            or profile.arch != target["arch"]
            or profile.lock_sha256 != target["runtimeLockSha256"]
            or profile.model.sha256 != target["modelSha256"]
            or profile.evidence_sha256 != approval["evidenceSha256"]
            or profile.fixture.sha256 != approval["fixtureSha256"]
            or profile.provider != approval["provider"]
            or profile.max_duration_seconds > approval["maxDurationSeconds"]
        ):
            raise ProfileError("UPDATE_SIGNATURE_INVALID")

    def _load(self, candidate):
        environment(candidate)
        record = self.records.read(self._name(candidate["target"]))
        if not record or record["environment"] != candidate:
            raise ValueError("Missing prepared environment")
        final = Path(candidate["path"])
        source, root = Path(record["source"]), Path(record["root"])
        for path in (source, root):
            if (
                not path.is_relative_to(final)
                or path != path.resolve()
                or not path.is_dir()
            ):
                raise ValueError("Invalid installed environment root")
        profile = Profile.load(source / "profile.json", record["profileSha256"])
        self._profile_binding(profile, candidate["target"])
        inventory = runtime_inventory(root)
        if (
            _digest(inventory) != record["inventorySha256"]
            or _source_inventory(source) != record["sourceInventory"]
        ):
            raise ProfileError("UPDATE_SIGNATURE_INVALID")
        model = Path(record["model"])
        if not model.is_relative_to(self.paths.models) or model != model.resolve():
            raise ValueError("Invalid model cache path")
        runtime = PreparedRuntime(
            root
            / "venv"
            / ("Scripts/python.exe" if profile.os == "windows" else "bin/python"),
            profile,
            model,
            root / ("ffmpeg.exe" if profile.os == "windows" else "ffmpeg"),
            root,
            record["versions"],
            qualification_report=record["report"],
            ffprobe=root / ("ffprobe.exe" if profile.os == "windows" else "ffprobe"),
            runtime_inventory=inventory,
            files_sha256={
                name: value[3]
                for name, value in inventory.items()
                if value[0] == "file"
            },
        )
        return record, runtime, source

    def _boot(self, target):
        boot = self.native.check_service_context()
        if (
            not isinstance(boot, dict)
            or set(boot) != set(BootReport.__annotations__)
            or boot["profileId"] != target["profileId"]
            or boot["serviceBindingSha256"]
            != target["approvedProfile"]["serviceBindingSha256"]
            or boot["installed"] is not True
            or boot["serviceContextPassed"] is not True
            or type(boot["unattendedRebootPassed"]) is not bool
        ):
            raise ProfileError("GPU_UNAVAILABLE_IN_SERVICE")
        sha256_string(boot["serviceBindingSha256"])
        return copy.deepcopy(boot)

    def validate(self, candidate):
        record, runtime, source = self._load(candidate)
        boot = self._boot(candidate["target"])
        separator = source / "musicmute_worker" / "separation.py"
        report = QualificationRunner(
            runtime,
            separator,
            self.paths.models,
            service_context_check=lambda: self._boot(candidate["target"]),
        ).qualify(
            runtime.profile, fetch_asset(runtime.profile.fixture, self.paths.models)
        )
        qualified = replace(runtime, qualification_report=report)
        qualified.assert_claim_ready()
        body = {
            "runtime": self.runtime_report(candidate),
            "qualificationReport": report,
            "serviceBindingSha256": boot["serviceBindingSha256"],
        }
        receipt = (
            self.client.setup_qualification(body)
            if self.client.setup
            else self.client.post_qualification(body)
        )
        if (
            receipt.get("decision") != "reported"
            or not isinstance(receipt.get("reportId"), str)
            or not re.fullmatch(r"[a-f0-9]{24}", receipt["reportId"])
        ):
            raise ValueError("Invalid qualification receipt")
        record.update(report=report, reportId=receipt["reportId"])
        self.records.write(self._name(candidate["target"]), record)
        return True

    def runtime_report(self, candidate):
        target = candidate["target"]
        boot = self._boot(target)
        return {
            "installationId": self.installation_id,
            "workerBuild": target["buildNumber"],
            "launcherBuild": self.launcher_build,
            "protocolVersion": 3,
            "profileId": target["profileId"],
            "modelSha256": target["modelSha256"],
            "runtimeLockSha256": target["runtimeLockSha256"],
            "os": target["os"],
            "arch": target["arch"],
            "activity": "starting",
            "bootVerified": boot["unattendedRebootPassed"],
        }

    def readiness_body(self, candidate):
        record, runtime, _ = self._load(candidate)
        runtime.assert_claim_ready()
        if not record["reportId"]:
            raise ValueError("Missing reported qualification")
        return {
            "installationId": self.installation_id,
            "runtime": self.runtime_report(candidate),
            "qualificationReportId": record["reportId"],
            "bootReport": self._boot(candidate["target"]),
        }

    def boundary(self):
        # The live child's authenticated IPC reports Worker.update_boundary();
        # only native descendant verification can supply its fourth component.
        value = self.native.read_worker_boundary()
        stopped = self.native.descendants_stopped() is True
        if value is not None:
            safe_boundary(value)
            return replace(value, descendants_stopped=stopped)
        if not stopped:
            return SafeBoundary(False, False, False, False)
        from .transport import Api, Transfers
        from .update.journal import ClaimHold
        from .worker import Worker

        ClaimHold(self.records).set(True)
        config = self.worker_config(self.pointer.read())
        with Worker(
            config,
            Api(config.api_base_url, self.native.load_secret("worker-token").decode()),
            Transfers(),
        ) as worker:
            value = worker.reconcile_for_maintenance(stopped_confirmed=True)
        return replace(value, descendants_stopped=True)

    def stop_and_reconcile(self, candidate):
        from .update.journal import ClaimHold

        ClaimHold(self.records).set(True)
        value = self.boundary()
        if not (
            value.ownership_resolved is True
            and value.terminal is True
            and value.cleanup_acknowledged is True
        ):
            return value
        if self.native.stop_worker() is not True:
            return replace(value, descendants_stopped=False)
        return self.boundary()

    def worker_config(self, candidate):
        from .config import Config
        from .launcher import InstallationBinding

        _, _, source = self._load(candidate)
        binding = InstallationBinding.load(self.paths.identity / "installation.json")
        if (
            binding.installation_id != self.installation_id
            or binding.api_base_url != self.client.base
        ):
            raise ValueError("Worker runtime installation mismatch")
        return Config(
            binding.api_base_url,
            self.paths.journals,
            source / "musicmute_worker" / "separation.py",
            worker_id=binding.worker_id,
            installation_id=binding.installation_id,
            paths=self.paths,
        )

    def child(self):
        candidate = self.pointer.read()
        _, runtime, source = self._load(candidate)
        runtime.assert_claim_ready()
        return self.native.create_child(
            self.worker_config(candidate),
            runtime,
            source / "musicmute_worker",
            candidate,
        )
