"""Synthetic native callbacks exercise real journals; no profile qualification."""

import copy
import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from musicmute_worker.update.activation import ActivePointer, SafeBoundary
from musicmute_worker.update.coordinator import UpdateCoordinator
from musicmute_worker.update.journal import DurableRecords
from musicmute_worker.update.policy import ArtifactCache

SAFE = SafeBoundary(True, True, True, True)
STAGES = [
    "available",
    "downloading",
    "prepared",
    "waiting_for_idle",
    "validating",
    "activating",
    "running",
    "verified",
]


def target(build):
    release = str(uuid4())
    digest = hashlib.sha256(str(build).encode()).hexdigest()
    return {
        "approvedProfile": None,
        "os": "macos",
        "arch": "arm64",
        "compatibleSources": [],
        "releaseId": release,
        "buildNumber": build,
        "profileId": "synthetic-only",
        "artifactPath": f"/releases/{release}/synthetic-only/{digest}/worker.zip",
        "artifactBytes": len(str(build)),
        "artifactSha256": digest,
        "runtimeLockSha256": str(build) * 64,
        "modelSha256": "3" * 64,
        "minimumLauncherBuild": 1,
        "protocolMin": 3,
        "protocolMax": 3,
        "stateReadMin": 3,
        "stateReadMax": 3,
    }


class Control:
    def __init__(self, decision):
        self.decision = decision
        self.stage = "available"
        self.observed = 1
        self.events = {}
        self.calls = []
        self.lose_stage = None
        self.offline = False
        self.can_claim = True
        self.successful_attempts = set()

    def fetch_policy(self):
        if self.offline:
            raise OSError("offline")
        policy = copy.deepcopy(self.decision)
        if self.stage == "verified":
            policy["action"] = "none"
        if self.stage == "rolled_back":
            policy["action"] = "hold"
        return policy

    def post_update_status(self, body):
        self.calls.append(copy.deepcopy(body))
        event = body["eventId"]
        if event in self.events:
            assert self.events[event] == body
            return {"accepted": True}
        assert body["policyRevision"] == self.decision["policyRevision"]
        assert body["observedBuild"] == self.observed
        stage = body["stage"]
        if stage not in ("rolled_back", "failed", "blocked"):
            assert STAGES.index(stage) == STAGES.index(self.stage) + 1, (
                self.stage,
                stage,
            )
        if (
            stage == "verified"
            and body["processingAttemptId"] not in self.successful_attempts
        ):
            raise ValueError("No independent processing evidence")
        self.events[event] = copy.deepcopy(body)
        self.stage = stage
        if stage == self.lose_stage:
            self.lose_stage = None
            raise OSError("lost acknowledgement")
        return {"accepted": True}

    def post_runtime(self, report):
        self.observed = report["workerBuild"]
        return {"accepted": True}

    def installation_ready(self, body):
        assert body["runtime"]["workerBuild"] == self.observed
        return {"accepted": True, "canClaim": self.can_claim, "reasonCodes": []}


class Runtime:
    def __init__(self):
        self.evidence = SAFE
        self.reconciled = SAFE
        self.invalid = set()
        self.validations = []
        self.stops = []
        self.on_validate = lambda env: None

    def prepare(self, descriptor, archive, final):
        final.mkdir(parents=True, exist_ok=True)
        marker = final / "installed-build"
        if not marker.exists():
            marker.write_bytes(archive.read_bytes())
        return {
            "target": copy.deepcopy(descriptor),
            "path": str(final),
            "assets": [descriptor["artifactSha256"]],
        }

    def boundary(self):
        return self.evidence

    def validate(self, env):
        self.validations.append(env["target"]["buildNumber"])
        self.on_validate(env)
        return env["target"]["buildNumber"] not in self.invalid and (
            Path(env["path"]) / "installed-build"
        ).read_text() == str(env["target"]["buildNumber"])

    def stop_and_reconcile(self, env):
        self.stops.append(env["target"]["buildNumber"])
        return self.reconciled

    def runtime_report(self, env):
        descriptor = env["target"]
        return {
            **{
                k: descriptor[k]
                for k in ("profileId", "modelSha256", "runtimeLockSha256", "os", "arch")
            },
            "workerBuild": descriptor["buildNumber"],
        }

    def readiness_body(self, env):
        return {"runtime": self.runtime_report(env)}


class Fixture:
    def __init__(self, root):
        self.root = root
        self.records = DurableRecords(root / "updates")
        self.old_target, self.new_target = target(1), target(2)
        self.new_target["compatibleSources"] = [
            {
                **{
                    k: self.old_target[k]
                    for k in ("profileId", "runtimeLockSha256", "modelSha256")
                },
                "rollbackAllowed": True,
            }
        ]
        self.runtime = Runtime()
        archive = root / "old-archive"
        archive.write_text("1")
        old_path = (
            root
            / "releases"
            / self.old_target["releaseId"]
            / self.old_target["runtimeLockSha256"]
        )
        self.old = self.runtime.prepare(self.old_target, archive, old_path)
        ActivePointer(self.records).switch(self.old)
        decision = {
            "serverTime": "2026-01-01T00:00:00.000Z",
            "policyRevision": 1,
            "action": "prepare",
            "target": self.new_target,
            "minimumClaimBuild": 1,
            "allowedFallbackReleaseIds": [self.old_target["releaseId"]],
            "reasonCodes": [],
        }
        self.client = Control(decision)
        self.verifications = []

        def verify(descriptor, path):
            self.verifications.append(path)
            assert (
                hashlib.sha256(Path(path).read_bytes()).hexdigest()
                == descriptor["artifactSha256"]
            )

        def download(descriptor, cache):
            artifact = cache / descriptor["artifactSha256"]
            artifact.write_text(str(descriptor["buildNumber"]))
            return artifact

        self.services = {
            "client": self.client,
            "verifier": SimpleNamespace(
                resolve=lambda policy: copy.deepcopy(policy["target"]),
                verify_artifact=verify,
            ),
            "downloader": SimpleNamespace(download=download),
            "cache": ArtifactCache(root / "cache"),
        }
        self.restart()

    def restart(self):
        self.coordinator = UpdateCoordinator(
            self.records, self.root / "releases", self.services, self.runtime
        )
        return self.coordinator


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture(
            Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        )
        self.f = self.fixture
        self.c = self.f.coordinator

    def test_complete_environment_and_ready_ack_before_claims(self):
        self.assertEqual(self.c.prepare(), "prepared")
        self.assertTrue(self.f.verifications)
        self.assertEqual(self.f.runtime.validations, [])
        self.assertEqual(self.c.activate_when_idle(), "committed")
        self.assertEqual(self.c.pointer.read()["target"], self.f.new_target)
        self.assertFalse(self.c.hold.held)
        self.assertEqual(self.f.client.stage, "running")
        self.assertTrue(Path(self.f.old["path"]).is_dir())
        self.assertEqual(self.c.activate_when_idle(), "committed")

    def test_all_four_boundary_fields_must_be_true(self):
        self.c.prepare()
        for field in SAFE.__dataclass_fields__:
            for bad in (False, None, 1):
                values = {key: True for key in SAFE.__dataclass_fields__}
                values[field] = bad
                self.f.runtime.evidence = SafeBoundary(**values)
                self.assertEqual(self.c.activate_when_idle(), "waiting")
                self.assertEqual(self.c.pointer.read(), self.f.old)
                self.assertTrue(self.c.hold.held)
        self.assertEqual(self.f.runtime.validations, [])

    def test_duck_typed_boundary_is_not_stop_evidence(self):
        self.c.prepare()
        self.f.runtime.evidence = SimpleNamespace(safe=True)
        with self.assertRaises(TypeError):
            self.c.activate_when_idle()
        self.assertEqual(self.c.pointer.read(), self.f.old)

    def test_paused_superseded_floor_and_offline_policy_hold(self):
        self.c.prepare()
        original = copy.deepcopy(self.f.client.decision)
        for changes in (
            {"action": "hold"},
            {"policyRevision": 2},
            {"minimumClaimBuild": 3},
            {"target": None},
        ):
            self.f.client.decision = {**original, **changes}
            with self.assertRaises(RuntimeError):
                self.c.activate_when_idle()
            self.assertEqual(self.c.pointer.read(), self.f.old)
            self.assertTrue(self.c.hold.held)
        self.f.client.decision = original
        self.f.client.offline = True
        with self.assertRaises(OSError):
            self.c.activate_when_idle()
        self.assertEqual(self.c.pointer.read(), self.f.old)

    def test_policy_rechecked_after_candidate_checks(self):
        self.c.prepare()
        self.f.runtime.on_validate = lambda env: self.f.client.decision.update(
            action="hold"
        )
        with self.assertRaises(RuntimeError):
            self.c.activate_when_idle()
        self.assertEqual(self.c.pointer.read(), self.f.old)

    def test_false_validation_rolls_back_full_environment(self):
        self.c.prepare()
        self.f.runtime.invalid.add(2)
        self.assertEqual(self.c.activate_when_idle(), "rolled_back")
        self.assertEqual(self.c.pointer.read(), self.f.old)
        self.assertFalse(self.c.hold.held)
        self.assertTrue(self.c._read()["quarantined"])
        self.assertEqual(self.c.prepare(), "rolled_back")

    def test_no_fallback_or_signed_permission_requires_repair(self):
        self.c.prepare()
        self.f.runtime.invalid.add(2)
        self.f.client.decision["allowedFallbackReleaseIds"] = []
        self.assertEqual(self.c.activate_when_idle(), "repair_required")
        self.assertTrue(self.c.hold.held)
        self.assertEqual(self.c.pointer.read(), self.f.old)

    def test_candidate_ready_rejection_keeps_claims_held(self):
        self.c.prepare()
        self.f.client.can_claim = False
        with self.assertRaisesRegex(RuntimeError, "NOT_READY"):
            self.c.activate_when_idle()
        self.assertTrue(self.c.hold.held)
        self.assertIsNone(self.c._read()["readyAck"])

    def test_startup_does_not_manufacture_processing_verification(self):
        self.c.prepare()
        self.c.activate_when_idle()
        self.assertEqual(self.f.client.stage, "running")
        attempt = str(uuid4())
        self.f.client.successful_attempts.add(attempt)
        self.c.verify_processing(attempt)
        self.assertEqual(self.f.client.stage, "verified")
        self.assertEqual(self.f.restart().recover_interrupted_activation(), "committed")

    def test_running_target_matches_only_committed_current_revision_and_pointer(self):
        self.c.prepare()
        self.assertFalse(self.c.running_target(self.f.client.fetch_policy()))
        self.c.activate_when_idle()
        policy = self.f.client.fetch_policy()
        self.assertTrue(self.c.running_target(policy))
        self.assertFalse(self.c.running_target({**policy, "policyRevision": 99}))
        self.c.pointer.switch(self.f.old)
        self.assertFalse(self.c.running_target(policy))

    def test_completed_attempt_hint_is_release_bound_and_backend_verified_once(self):
        self.c.prepare()
        self.c.activate_when_idle()
        attempt = str(uuid4())
        self.c.records.write(
            "completed-processing.json",
            {
                "schemaVersion": 3,
                "releaseId": self.f.old["target"]["releaseId"],
                "policyRevision": 1,
                "attemptId": attempt,
            },
        )
        self.assertFalse(self.c.verify_available_processing())
        self.assertEqual(self.f.client.stage, "running")
        self.c.records.write(
            "completed-processing.json",
            {
                "schemaVersion": 3,
                "releaseId": self.f.new_target["releaseId"],
                "attemptId": attempt,
                "policyRevision": 1,
            },
        )
        self.f.client.successful_attempts.add(attempt)
        self.assertTrue(self.c.verify_available_processing())
        count = len(self.f.client.calls)
        self.assertTrue(self.c.verify_available_processing())
        self.assertEqual(len(self.f.client.calls), count)
        self.assertEqual(self.f.client.stage, "verified")

    def test_lost_processing_verification_ack_replays_identical_pending_status(self):
        self.c.prepare()
        self.c.activate_when_idle()
        attempt = str(uuid4())
        self.f.client.successful_attempts.add(attempt)
        self.c.records.write(
            "completed-processing.json",
            {
                "schemaVersion": 3,
                "releaseId": self.f.new_target["releaseId"],
                "attemptId": attempt,
                "policyRevision": 1,
            },
        )
        self.f.client.lose_stage = "verified"
        with self.assertRaises(OSError):
            self.c.verify_available_processing()
        payload = self.c._read()["pendingStatus"]
        self.assertTrue(self.c.verify_available_processing())
        self.assertEqual(self.f.client.calls[-1], payload)
        self.assertIsNone(self.c._read()["pendingStatus"])

    def test_rejected_processing_hint_does_not_poison_next_completed_attempt(self):
        from musicmute_worker.events import EventRequestError

        self.c.prepare()
        self.c.activate_when_idle()
        stale, fresh = str(uuid4()), str(uuid4())
        original = self.f.client.post_update_status

        def reject_stale(body):
            if body.get("processingAttemptId") == stale:
                raise EventRequestError("NOT_ELIGIBLE", 409)
            return original(body)

        self.f.client.post_update_status = reject_stale

        def hint(attempt):
            self.c.records.write(
                "completed-processing.json",
                {
                    "schemaVersion": 3,
                    "releaseId": self.f.new_target["releaseId"],
                    "policyRevision": 1,
                    "attemptId": attempt,
                },
            )

        hint(stale)
        try:
            self.c.verify_available_processing()
        except (EventRequestError, ValueError):
            pass
        hint(fresh)
        self.f.client.successful_attempts.add(fresh)
        self.assertTrue(self.c.verify_available_processing())
        self.assertEqual(self.f.client.stage, "verified")
        self.assertFalse(self.c.hold.held)

    def test_same_release_old_revision_hint_is_not_submitted(self):
        self.c.prepare()
        self.c.activate_when_idle()
        self.c.records.write(
            "completed-processing.json",
            {
                "schemaVersion": 3,
                "releaseId": self.f.new_target["releaseId"],
                "policyRevision": 0,
                "attemptId": str(uuid4()),
            },
        )
        count = len(self.f.client.calls)
        self.assertFalse(self.c.verify_available_processing())
        self.assertEqual(len(self.f.client.calls), count)

    def test_rate_limit_server_error_and_auth_failure_keep_exact_verification_retry(
        self,
    ):
        from musicmute_worker.events import EventRequestError

        self.c.prepare()
        self.c.activate_when_idle()
        attempt = str(uuid4())
        self.c.records.write(
            "completed-processing.json",
            {
                "schemaVersion": 3,
                "releaseId": self.f.new_target["releaseId"],
                "policyRevision": 1,
                "attemptId": attempt,
            },
        )
        original = self.f.client.post_update_status
        pending = None
        for status in (429, 503, 401):

            def unavailable(body, status=status):
                raise EventRequestError("RATE_LIMITED", status)

            self.f.client.post_update_status = unavailable
            with self.assertRaises(EventRequestError):
                self.c.verify_available_processing()
            if pending is None:
                pending = self.c._read()["pendingStatus"]
            self.assertEqual(self.c._read()["pendingStatus"], pending)
        self.f.client.post_update_status = original
        self.f.client.successful_attempts.add(attempt)
        self.assertTrue(self.c.verify_available_processing())
        self.assertEqual(self.f.client.calls[-1], pending)

    def test_new_policy_retry_preserves_previous_quarantine_journal(self):
        self.c.prepare()
        self.f.runtime.invalid.add(2)
        self.c.activate_when_idle()
        self.f.runtime.invalid.clear()
        self.f.client.decision["policyRevision"] = 2
        self.f.client.stage = "available"
        self.assertEqual(self.c.prepare(), "prepared")
        old = self.f.records.read("activation-history-1.json")
        self.assertTrue(old["quarantined"])
        self.assertEqual(old["phase"], "rolled_back")
        self.assertEqual(self.c.activate_when_idle(), "committed")

    def test_unacknowledged_runtime_report_cannot_enable_claims(self):
        self.c.prepare()
        self.f.client.post_runtime = lambda report: {"accepted": 1}
        with self.assertRaises(RuntimeError):
            self.c.activate_when_idle()
        self.assertTrue(self.c.hold.held)

    def test_code_only_rollback_needs_no_recipe_transition_entry(self):
        self.f.new_target["runtimeLockSha256"] = self.f.old_target["runtimeLockSha256"]
        self.f.new_target["compatibleSources"] = []
        self.c.prepare()
        self.f.runtime.invalid.add(2)
        self.assertEqual(self.c.activate_when_idle(), "rolled_back")

    def test_native_prepare_cannot_mutate_verified_rollback_permission(self):
        self.f.new_target["compatibleSources"] = []
        verified = copy.deepcopy(self.f.new_target)
        original_prepare = self.f.runtime.prepare

        def mutate_prepare(descriptor, archive, final):
            descriptor["compatibleSources"].append(
                {
                    **{
                        key: self.f.old_target[key]
                        for key in ("profileId", "runtimeLockSha256", "modelSha256")
                    },
                    "rollbackAllowed": True,
                }
            )
            return original_prepare(descriptor, archive, final)

        self.f.runtime.prepare = mutate_prepare
        with self.assertRaisesRegex(
            ValueError, "Prepared environment identity mismatch"
        ):
            self.c.prepare()
        journal = self.f.records.read("activation.json")
        self.assertEqual(journal["target"], verified)
        self.assertEqual(journal["policy"]["target"], verified)
        self.assertIsNone(journal["candidate"])
        self.assertEqual(journal["phase"], "preparing")
        self.assertEqual(self.f.client.decision["target"], verified)
        self.assertEqual(self.c.pointer.read(), self.f.old)

    def test_native_reconcile_cannot_mutate_candidate_journal(self):
        self.c.prepare()
        verified = copy.deepcopy(self.f.new_target)
        self.f.runtime.invalid.add(2)
        original_stop = self.f.runtime.stop_and_reconcile

        def mutate_stop(candidate):
            candidate["target"]["compatibleSources"] = []
            return original_stop(candidate)

        self.f.runtime.stop_and_reconcile = mutate_stop
        self.assertEqual(self.c.activate_when_idle(), "rolled_back")
        self.assertEqual(self.c._read()["candidate"]["target"], verified)
        self.assertEqual(self.c._read()["target"], verified)
