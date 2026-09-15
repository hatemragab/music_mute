"""Concrete shared runtime wiring, with native operations explicitly mocked."""

import json
import tempfile
import unittest
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

from musicmute_worker.profiles import (
    PreparedRuntime,
    Profile,
    ProfileError,
    digest_file,
    runtime_inventory,
)
from musicmute_worker.setup_runtime import SharedActivationRuntime
from musicmute_worker.update.journal import ClaimHold, DurableRecords
from musicmute_worker.worker import Worker
from test_update_activation import target
from worker_test_support import config


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name).resolve()
        self.paths = SimpleNamespace(
            state=root / "state", releases=root / "releases", models=root / "models"
        )
        self.records = DurableRecords(self.paths.state / "updates")
        self.verifier = Mock()
        self.native = Mock()
        self.runtime = SharedActivationRuntime(
            self.paths,
            self.records,
            self.verifier,
            Mock(),
            self.native,
            str(uuid4()),
            1,
        )

    def test_unqualified_profile_cannot_reach_dependency_or_native_service(self):
        with self.assertRaises(ProfileError):
            self.runtime.prepare(
                {"approvedProfile": None},
                Path("unused"),
                self.paths.releases / "candidate",
            )
        self.verifier.extract_artifact.assert_not_called()
        self.native.check_service_context.assert_not_called()

    def test_boundary_delegates_actual_native_evidence_without_truthy_coercion(self):
        self.native.read_worker_boundary.return_value = {"ownership_resolved": True}
        with self.assertRaises(TypeError):
            self.runtime.boundary()

    def fixture(self):
        manifest = (
            Path(__file__).resolve().parents[1]
            / "profiles/macos-arm64-coreml.candidate.json"
        )
        profile = Profile.load(manifest, digest_file(manifest))
        profile = replace(
            profile,
            status="qualified",
            evidence_sha256="a" * 64,
            reference=profile.fixture,
        )
        descriptor = target(2)
        descriptor.update(
            profileId=profile.profile_id,
            runtimeLockSha256=profile.lock_sha256,
            modelSha256=profile.model.sha256,
        )
        descriptor["artifactPath"] = (
            f"/releases/{descriptor['releaseId']}/{profile.profile_id}/{descriptor['artifactSha256']}/worker.zip"
        )
        descriptor["approvedProfile"] = {
            "evidenceSha256": profile.evidence_sha256,
            "fixtureSha256": profile.fixture.sha256,
            "fixtureDurationSeconds": profile.max_duration_seconds,
            "provider": profile.provider,
            "serviceBindingSha256": "b" * 64,
            "expiresAt": "2099-01-01T00:00:00.000Z",
            "maxDurationSeconds": profile.max_duration_seconds,
            "maxPreparedAudioBytes": 1024,
            "maxWallMilliseconds": profile.max_wall_seconds * 1000,
        }
        final = (
            self.paths.releases
            / descriptor["releaseId"]
            / descriptor["runtimeLockSha256"]
        )

        def extract(target, archive, source):
            source.mkdir()
            (source / "profile.json").write_text(json.dumps(asdict(profile)))
            (source / "runtime-lock.json").write_text("synthetic lock, never executed")
            (source / "musicmute_worker").mkdir()
            (source / "musicmute_worker/separation.py").write_text(
                "synthetic code, never executed"
            )

        def prepare(profile, lock, root, cache):
            (root / "venv/bin").mkdir(parents=True)
            (root / "work").mkdir()
            for name in ("venv/bin/python", "ffmpeg", "ffprobe"):
                (root / name).write_bytes(b"synthetic binary, never executed")
                (root / name).chmod(0o700)
            cache.mkdir(parents=True, exist_ok=True)
            model = cache / "synthetic-model"
            model.write_bytes(b"synthetic model, not qualified")
            return PreparedRuntime(
                root / "venv/bin/python",
                profile,
                model,
                root / "ffmpeg",
                root,
                {},
                ffprobe=root / "ffprobe",
                runtime_inventory=runtime_inventory(root),
            )

        self.verifier.extract_artifact.side_effect = extract
        return descriptor, final, prepare

    def test_preparation_consumes_extractor_and_w02_at_permanent_path_then_resumes(
        self,
    ):
        descriptor, final, prepare = self.fixture()
        with (
            patch(
                "musicmute_worker.setup_runtime.compatible_profiles",
                return_value=(object(),),
            ),
            patch(
                "musicmute_worker.setup_runtime.prepare_runtime", side_effect=prepare
            ) as preparation,
        ):
            candidate = self.runtime.prepare(descriptor, Path("fixture.zip"), final)
            resumed = self.runtime.prepare(descriptor, Path("fixture.zip"), final)
        self.assertEqual(candidate, resumed)
        self.verifier.extract_artifact.assert_called_once()
        preparation.assert_called_once()
        runtime_root = preparation.call_args.args[2]
        self.assertTrue(runtime_root.is_relative_to(final))
        self.assertTrue(runtime_root.is_dir())

    def test_tampered_code_is_refused_on_resume(self):
        descriptor, final, prepare = self.fixture()
        with (
            patch(
                "musicmute_worker.setup_runtime.compatible_profiles",
                return_value=(object(),),
            ),
            patch(
                "musicmute_worker.setup_runtime.prepare_runtime", side_effect=prepare
            ),
        ):
            self.runtime.prepare(descriptor, Path("fixture.zip"), final)
        source = next(final.glob("source-*"))
        (source / "musicmute_worker/separation.py").write_text("changed")
        with self.assertRaises(ProfileError):
            self.runtime.prepare(descriptor, Path("fixture.zip"), final)

    def test_qualification_uses_exact_existing_routes_and_assembles_readiness_from_receipt(
        self,
    ):
        descriptor, final, prepare = self.fixture()
        with (
            patch(
                "musicmute_worker.setup_runtime.compatible_profiles",
                return_value=(object(),),
            ),
            patch(
                "musicmute_worker.setup_runtime.prepare_runtime", side_effect=prepare
            ),
        ):
            candidate = self.runtime.prepare(descriptor, Path("fixture.zip"), final)
        _record, prepared, _ = self.runtime._load(candidate)
        profile = prepared.profile
        self.native.check_service_context.return_value = {
            "serviceBindingSha256": "b" * 64,
            "profileId": profile.profile_id,
            "installed": True,
            "serviceContextPassed": True,
            "unattendedRebootPassed": False,
            "observedBootId": None,
            "observedAt": "2026-09-15T00:00:00.000Z",
            "reasonCodes": [],
        }
        report = {
            "profileId": profile.profile_id,
            "modelSha256": profile.model.sha256,
            "fixtureSha256": profile.fixture.sha256,
            "acceleratorUsed": True,
            "provider": profile.provider,
            "deviceLabel": "synthetic fixture",
            "wallMilliseconds": 1,
            "peakRamBytes": 1,
            "peakGpuMemoryBytes": None,
            "outputValid": True,
            "referenceCheckPassed": True,
            "serviceContextPassed": True,
            "reasonCodes": [],
        }
        for setup in (True, False):
            client = Mock()
            client.setup = setup
            method = client.setup_qualification if setup else client.post_qualification
            method.return_value = {
                "reportId": "a" * 24,
                "decision": "reported",
                "reasonCodes": [],
            }
            self.runtime.client = client
            with (
                patch("musicmute_worker.setup_runtime.QualificationRunner") as runner,
                patch(
                    "musicmute_worker.setup_runtime.fetch_asset",
                    return_value=Path("synthetic-fixture"),
                ),
                patch("musicmute_worker.profiles.verified_asset"),
            ):
                runner.return_value.qualify.return_value = report
                self.assertIs(self.runtime.validate(candidate), True)
                ready = self.runtime.readiness_body(candidate)
            body = method.call_args.args[0]
            self.assertEqual(
                set(body), {"runtime", "qualificationReport", "serviceBindingSha256"}
            )
            self.assertEqual(body["qualificationReport"], report)
            self.assertEqual(ready["qualificationReportId"], "a" * 24)
            self.assertFalse(ready["bootReport"]["unattendedRebootPassed"])
            self.assertFalse(ready["runtime"]["bootVerified"])

    def test_dependency_failure_retains_failed_root_and_retry_uses_new_permanent_root(
        self,
    ):
        descriptor, final, prepare = self.fixture()

        def failed(profile, lock, root, cache):
            root.mkdir()
            raise ProfileError("DEPENDENCY_RECIPE_UNAVAILABLE")

        with (
            patch(
                "musicmute_worker.setup_runtime.compatible_profiles",
                return_value=(object(),),
            ),
            patch("musicmute_worker.setup_runtime.prepare_runtime", side_effect=failed),
            self.assertRaises(ProfileError),
        ):
            self.runtime.prepare(descriptor, Path("fixture.zip"), final)
        failed_root = next(final.glob("runtime-*"))
        with (
            patch(
                "musicmute_worker.setup_runtime.compatible_profiles",
                return_value=(object(),),
            ),
            patch(
                "musicmute_worker.setup_runtime.prepare_runtime", side_effect=prepare
            ) as preparation,
        ):
            self.runtime.prepare(descriptor, Path("fixture.zip"), final)
        self.assertTrue(failed_root.is_dir())
        self.assertNotEqual(failed_root, preparation.call_args.args[2])


class MaintenanceRecoveryTests(unittest.TestCase):
    def test_successful_processing_hint_waits_for_cleanup_ack_and_binds_active_release(
        self,
    ):
        from musicmute_worker.update.activation import ActivePointer

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            cfg = config(
                "https://api.test/api/v1", root / "journals", root / "separator.py"
            )
            records = DurableRecords(cfg.paths.state / "updates")
            descriptor = target(1)
            ActivePointer(records).switch(
                {
                    "target": descriptor,
                    "path": str(root / "releases" / "candidate"),
                    "assets": [descriptor["artifactSha256"]],
                }
            )
            api = Mock()
            api.post.side_effect = OSError("lost cleanup acknowledgement")
            activation = {
                "schemaVersion": 3,
                "phase": "committed",
                "stage": "running",
                "policy": {"policyRevision": 1},
                "candidate": ActivePointer(records).read(),
            }
            records.write("activation.json", activation)
            with Worker(cfg, api, Mock()) as worker:
                assignment = {
                    "jobId": "a" * 24,
                    "attemptId": str(uuid4()),
                    "sessionId": worker.session,
                    "generation": 1,
                }
                worker._capture_processing_activation(assignment)
                activation["policy"]["policyRevision"] = 2
                records.write("activation.json", activation)
                worker._capture_processing_activation(assignment)
                with self.assertRaises(OSError):
                    worker._finish_cleanup(assignment, "ready")
                self.assertIsNone(records.read("completed-processing.json"))
                api.post.side_effect = None
                api.post.return_value = {"status": "cleaned"}
                worker._resume_cleanup()
            self.assertEqual(
                records.read("completed-processing.json"),
                {
                    "schemaVersion": 3,
                    "releaseId": descriptor["releaseId"],
                    "policyRevision": 1,
                    "attemptId": assignment["attemptId"],
                },
            )

    def test_fresh_claim_invalidates_previous_recovery_before_network_request(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            cfg = config(
                "https://api.test/api/v1", root / "journals", root / "separator.py"
            )
            api = Mock()
            with Worker(cfg, api, Mock(), runtime=Mock(spec=PreparedRuntime)) as worker:
                worker._update_ownership_resolved = True

                def request(route, body):
                    self.assertFalse(worker.update_boundary().ownership_resolved)
                    self.assertEqual(route, "claim")

                api.post.side_effect = request
                worker._claim()

    def test_stopped_recovery_uses_existing_worker_and_never_claims_or_runs_inference(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            cfg = config(
                "https://api.test/api/v1", root / "journals", root / "separator.py"
            )
            ClaimHold(DurableRecords(cfg.paths.state / "updates")).set(True)
            api, transfers = Mock(), Mock()
            api.post.side_effect = [
                {
                    "installationId": cfg.installation_id,
                    "workerId": cfg.worker_id,
                    "protocolVersion": 3,
                    "mediaPolicyVersion": 2,
                    "state": "enabled",
                },
                None,
            ]
            with Worker(cfg, api, transfers) as worker:
                boundary = worker.reconcile_for_maintenance(stopped_confirmed=True)
            self.assertTrue(boundary.ownership_resolved)
            self.assertTrue(boundary.terminal)
            self.assertTrue(boundary.cleanup_acknowledged)
            self.assertFalse(boundary.descendants_stopped)
            self.assertEqual(
                [call.args[0] for call in api.post.call_args_list],
                ["identity", "claim/recovery"],
            )
            self.assertEqual(transfers.mock_calls, [])

    def test_missing_native_stop_proof_prevents_any_recovery_request(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            cfg = config(
                "https://api.test/api/v1", root / "journals", root / "separator.py"
            )
            api = Mock()
            with Worker(cfg, api, Mock()) as worker, self.assertRaises(RuntimeError):
                worker.reconcile_for_maintenance(stopped_confirmed=False)
            api.post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
