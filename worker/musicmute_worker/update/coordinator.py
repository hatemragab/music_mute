"""Serialized, restartable update transaction independent of the GPU imports.

Every public operation runs under the launcher's existing lifecycle lock. Supply a
verifier constructed with the caller-owned lock context (Launcher.update_services),
never call the external lock-taking maintenance factory from a running child.
"""

import copy
from pathlib import Path
from uuid import uuid4

from ..events import EventRequestError
from .activation import ActivePointer, environment, safe_boundary
from .journal import ClaimHold
from .policy import parse_decision


class UpdateCoordinator:
    def __init__(self, records, releases: Path, services, runtime):
        self.records = records
        self.releases = releases
        self.client = services["client"]
        self.verifier = services["verifier"]
        self.downloader = services["downloader"]
        self.cache = services["cache"]
        self.runtime = runtime
        self.pointer = ActivePointer(records)
        self.hold = ClaimHold(records)

    def _read(self):
        record = self.records.read("activation.json")
        if record:
            required = {
                "schemaVersion",
                "phase",
                "old",
                "candidate",
                "target",
                "policy",
                "pendingStatus",
                "stage",
                "readyAck",
                "claimsEnabled",
                "quarantined",
                "finalPath",
            }
            if (
                set(record) != required
                or record["phase"]
                not in (
                    "preparing",
                    "prepared",
                    "waiting",
                    "validating",
                    "switching",
                    "readiness",
                    "committed",
                    "rollback",
                    "restoring",
                    "repair_required",
                    "rolled_back",
                )
                or type(record["claimsEnabled"]) is not bool
                or type(record["quarantined"]) is not bool
            ):
                raise ValueError("Invalid activation journal")
            parse_decision(record["policy"])
            parse_decision(
                {**record["policy"], "target": record["target"], "action": "prepare"}
            )
            environment(record["old"])
            if record["candidate"]:
                environment(record["candidate"])
                if (
                    record["candidate"]["target"] != record["target"]
                    or record["candidate"]["path"] != record["finalPath"]
                ):
                    raise ValueError("Activation candidate identity mismatch")
            elif record["phase"] != "preparing":
                raise ValueError("Missing activation candidate")
            final = (
                self.releases
                / record["target"]["releaseId"]
                / record["target"]["runtimeLockSha256"]
            )
            if record["finalPath"] != str(final) or final != final.resolve():
                raise ValueError("Invalid activation releases path")
        return record

    def _write(self, record, phase=None):
        if phase is not None:
            record["phase"] = phase
        self.records.write("activation.json", record)

    def _status(self, record, stage, build, attempt=None):
        self._flush_status(record)
        body = {
            "policyRevision": record["policy"]["policyRevision"],
            "stage": stage,
            "observedBuild": build,
            "eventId": str(uuid4()),
        }
        if attempt is not None:
            body["processingAttemptId"] = attempt
        record["pendingStatus"] = body
        self._write(record)
        return self._flush_status(record)

    def _flush_status(self, record):
        if record["pendingStatus"] is None:
            return True
        payload = record["pendingStatus"]
        try:
            receipt = self.client.post_update_status(copy.deepcopy(payload))
        except EventRequestError as error:
            if payload["stage"] != "verified" or error.status not in (400, 409, 422):
                raise  # Uncertain/transient/auth failures retain exact retry bytes.
            self.records.write(
                "verification-rejection.json",
                {
                    "schemaVersion": 3,
                    "policyRevision": payload["policyRevision"],
                    "attemptId": payload["processingAttemptId"],
                    "eventId": payload["eventId"],
                    "status": error.status,
                },
            )
            record["pendingStatus"] = None
            self._write(record)
            return False
        if receipt != {"accepted": True} or receipt["accepted"] is not True:
            raise RuntimeError("Invalid update acknowledgement")
        record["stage"] = record["pendingStatus"]["stage"]
        record["pendingStatus"] = None
        self._write(record)
        return True

    def _current(self, record):
        policy = self.client.fetch_policy()
        action = "none" if record["stage"] == "verified" else "prepare"
        if (
            policy["policyRevision"] != record["policy"]["policyRevision"]
            or policy["target"] != record["target"]
            or policy["action"] != action
            or policy["minimumClaimBuild"] > record["target"]["buildNumber"]
        ):
            raise RuntimeError("UPDATE_POLICY_CHANGED")
        record["policy"] = policy
        self._write(record)
        return policy

    @staticmethod
    def _reference(env):
        return {"releaseId": env["target"]["releaseId"], "assets": env["assets"]}

    def _retain(self, record):
        old = record["old"]
        permitted = record["policy"]["allowedFallbackReleaseIds"]
        self.cache.retain(
            active=self._reference(self.pointer.read()),
            prepared=self._reference(record["candidate"])
            if record["candidate"]
            else None,
            rollback=[self._reference(old)]
            if old["target"]["releaseId"] in permitted
            else [],
            allowed_fallback_ids=permitted,
        )

    def prepare(self):
        existing = self._read()
        if existing:
            policy = self.client.fetch_policy()
            if (
                policy["action"] != "prepare"
                or policy["policyRevision"] <= existing["policy"]["policyRevision"]
                or existing["phase"]
                not in ("committed", "rolled_back", "repair_required")
            ):
                return existing["phase"]
            self.hold.set(True)
            if not safe_boundary(self.runtime.stop_and_reconcile(self.pointer.read())):
                return existing["phase"]
            # Keep the previous transaction intact for diagnosis; a backend retry
            # advances revision, so repeated local starts cannot clear quarantine.
            self.records.write(
                f"activation-history-{existing['policy']['policyRevision']}.json",
                existing,
            )
        policy = self.client.fetch_policy()
        target = self.verifier.resolve(policy)
        if target != policy["target"]:
            raise ValueError("Verified target mismatch")
        old = self.pointer.read()
        final = self.releases / target["releaseId"] / target["runtimeLockSha256"]
        if not self.releases.is_absolute() or self.releases != self.releases.resolve():
            raise ValueError("Invalid permanent releases root")
        record = {
            "schemaVersion": 3,
            "phase": "preparing",
            "old": old,
            "candidate": None,
            "target": target,
            "policy": policy,
            "pendingStatus": None,
            "stage": "available",
            "readyAck": None,
            "claimsEnabled": False,
            "quarantined": False,
            "finalPath": str(final),
        }
        self._write(record)
        return self._prepare(record)

    def _prepare(self, record):
        self._current(record)
        if self.verifier.resolve(record["policy"]) != record["target"]:
            raise ValueError("Verified target mismatch")
        self._flush_status(record)
        if record["stage"] == "available":
            self._status(record, "downloading", record["old"]["target"]["buildNumber"])
        # Retain the candidate artifact before download/GC even before runtime exists.
        candidate_ref = {
            "releaseId": record["target"]["releaseId"],
            "assets": [record["target"]["artifactSha256"]],
        }
        self.cache.retain(
            active=self._reference(record["old"]),
            prepared=candidate_ref,
            rollback=[],
            allowed_fallback_ids=[],
        )
        archive = self.downloader.download(record["target"], self.cache.root)
        self.verifier.verify_artifact(record["target"], str(archive))
        candidate = environment(
            copy.deepcopy(
                self.runtime.prepare(
                    copy.deepcopy(record["target"]), archive, Path(record["finalPath"])
                )
            )
        )
        if (
            candidate["target"] != record["target"]
            or candidate["path"] != record["finalPath"]
        ):
            raise ValueError("Prepared environment identity mismatch")
        record["candidate"] = candidate
        self._write(record, "prepared")
        self._retain(record)
        if record["stage"] == "downloading":
            self._status(record, "prepared", record["old"]["target"]["buildNumber"])
        return "prepared"

    def activate_when_idle(self):
        record = self._read()
        if not record:
            raise RuntimeError("No prepared update")
        if record["phase"] == "committed":
            return "committed"
        if record["phase"] not in ("prepared", "waiting"):
            return self.recover_interrupted_activation()
        self._write(record, "waiting")
        self.hold.set(True)
        self._flush_status(record)
        if record["stage"] == "downloading":
            self._status(record, "prepared", record["old"]["target"]["buildNumber"])
        if record["stage"] == "prepared":
            self._status(
                record, "waiting_for_idle", record["old"]["target"]["buildNumber"]
            )
        if not safe_boundary(self.runtime.boundary()):
            return "waiting"
        self._current(record)
        self._write(record, "validating")
        if record["stage"] == "waiting_for_idle":
            self._status(record, "validating", record["old"]["target"]["buildNumber"])
        try:
            self._validate(record["candidate"])
        except (OSError, EventRequestError):
            raise
        except (RuntimeError, ValueError, TypeError):
            return self._rollback(record)
        self._current(record)  # Recheck after possibly lengthy model/service checks.
        if not safe_boundary(self.runtime.boundary()):
            self._write(record, "waiting")
            return "waiting"
        self._write(record, "switching")
        self._status(record, "activating", record["old"]["target"]["buildNumber"])
        self._retain(record)
        self.pointer.switch(record["candidate"])
        self._write(record, "readiness")
        return self._ready(record)

    def _ready(self, record):
        candidate = record["candidate"]
        self._flush_status(record)
        self._report_runtime(candidate)
        if record["stage"] == "activating":
            self._status(record, "running", candidate["target"]["buildNumber"])
        self._current(record)
        self._write(record, "readiness")
        receipt = self._ready_receipt(candidate)
        if receipt["canClaim"] is not True:
            raise RuntimeError("CANDIDATE_NOT_READY")
        record["readyAck"] = receipt
        # Mark potential ownership BEFORE allowing any claim; lost power never
        # makes absence of a locally observed claim evidence of no ownership.
        record["claimsEnabled"] = True
        self._write(record, "committed")
        self.hold.set(False)
        return "committed"

    def _validate(self, candidate):
        if self.runtime.validate(copy.deepcopy(candidate)) is not True:
            raise RuntimeError(
                "Native model/service/authentication checks not acknowledged"
            )

    def _report_runtime(self, candidate):
        report = self.runtime.runtime_report(copy.deepcopy(candidate))
        target = candidate["target"]
        bindings = {
            "workerBuild": "buildNumber",
            "profileId": "profileId",
            "modelSha256": "modelSha256",
            "runtimeLockSha256": "runtimeLockSha256",
            "os": "os",
            "arch": "arch",
        }
        if not isinstance(report, dict) or any(
            report.get(k) != target[v] for k, v in bindings.items()
        ):
            raise ValueError("Native runtime report identity mismatch")
        receipt = self.client.post_runtime(report)
        if receipt != {"accepted": True} or receipt["accepted"] is not True:
            raise RuntimeError("Runtime report not acknowledged")

    def _ready_receipt(self, candidate):
        body = self.runtime.readiness_body(copy.deepcopy(candidate))
        report = self.runtime.runtime_report(copy.deepcopy(candidate))
        if not isinstance(body, dict) or body.get("runtime") != report:
            raise ValueError("Readiness runtime identity mismatch")
        receipt = self.client.installation_ready(body)
        if (
            not isinstance(receipt, dict)
            or set(receipt) != {"accepted", "canClaim", "reasonCodes"}
            or receipt["accepted"] is not True
            or type(receipt["canClaim"]) is not bool
            or not isinstance(receipt["reasonCodes"], list)
        ):
            raise RuntimeError("Invalid readiness acknowledgement")
        return receipt

    def _rollback(self, record):
        self._write(record, "rollback")
        self.hold.set(True)
        self._flush_status(record)
        if not safe_boundary(
            self.runtime.stop_and_reconcile(copy.deepcopy(record["candidate"]))
        ):
            return "rollback"
        policy = self.client.fetch_policy()  # Offline never grants fallback.
        old = record["old"]["target"]
        sources = record["target"]["compatibleSources"]
        compatible = all(
            record["target"][k] == old[k]
            for k in ("profileId", "modelSha256", "runtimeLockSha256")
        ) or any(
            s["rollbackAllowed"] is True
            and all(
                s[k] == old[k]
                for k in ("profileId", "modelSha256", "runtimeLockSha256")
            )
            for s in sources
        )
        if (
            policy["policyRevision"] != record["policy"]["policyRevision"]
            or old["releaseId"] not in policy["allowedFallbackReleaseIds"]
            or old["buildNumber"] < policy["minimumClaimBuild"]
            or not compatible
        ):
            record["quarantined"] = True
            self._write(record, "repair_required")
            return "repair_required"
        record["policy"] = policy
        self._write(record, "restoring")
        self._validate(record["old"])
        # Validation may take minutes; permission and containment are refreshed
        # again immediately before restoring the pointer.
        fresh = self.client.fetch_policy()
        if (
            fresh["policyRevision"] != policy["policyRevision"]
            or old["releaseId"] not in fresh["allowedFallbackReleaseIds"]
            or old["buildNumber"] < fresh["minimumClaimBuild"]
        ):
            record["quarantined"] = True
            self._write(record, "repair_required")
            return "repair_required"
        if not safe_boundary(self.runtime.boundary()):
            return "rollback"
        self.pointer.switch(record["old"])
        self._report_runtime(record["old"])
        if record["stage"] != "rolled_back":
            self._status(record, "rolled_back", old["buildNumber"])
        receipt = self._ready_receipt(record["old"])
        record["readyAck"] = receipt
        record["quarantined"] = True
        self._write(record, "rolled_back")
        self._retain(record)
        if receipt.get("accepted") is True and receipt.get("canClaim") is True:
            self.hold.set(False)
        return "rolled_back"

    def recover_interrupted_activation(self):
        record = self._read()
        if record is None:
            return "none"
        # Journal alone never resumes claims after reboot, even after old readyAck.
        self.hold.set(True)
        self._flush_status(record)
        phase = record["phase"]
        if phase == "preparing":
            return self._prepare(record)
        if phase in ("prepared", "waiting"):
            return self.activate_when_idle()
        if phase == "repair_required":
            return phase
        if phase in ("committed", "readiness", "switching"):
            if not safe_boundary(
                self.runtime.stop_and_reconcile(copy.deepcopy(record["candidate"]))
            ):
                return "waiting"
            try:
                self._current(record)
                self._validate(record["candidate"])
                self._current(record)
                if not safe_boundary(self.runtime.boundary()):
                    return "waiting"
                if record["stage"] == "validating":
                    self._status(
                        record, "activating", record["old"]["target"]["buildNumber"]
                    )
                if self.pointer.read() != record["candidate"]:
                    self.pointer.switch(record["candidate"])
                return self._ready(record)
            except (OSError, EventRequestError):
                raise  # Preserve consistent pointer and hold during network outage.
            except (RuntimeError, ValueError, TypeError):
                return self._rollback(record)
        return self._rollback(record)

    def verify_processing(self, attempt_id):
        """Backend independently verifies successful processing after runningAt."""
        record = self._read()
        if not record or record["phase"] != "committed":
            raise RuntimeError("Activation is not committed")
        return self._status(
            record, "verified", record["candidate"]["target"]["buildNumber"], attempt_id
        )

    def running_target(self, policy):
        """A backend running target stays selected until successful work verifies it."""
        record = self._read()
        return bool(
            record
            and record["phase"] == "committed"
            and record["stage"] in ("running", "verified")
            and record["policy"]["policyRevision"] == policy["policyRevision"]
            and record["candidate"]["target"] == policy["target"]
            and self.pointer.read() == record["candidate"]
        )

    def verify_available_processing(self):
        """Only backend acceptance can promote the durable completed-attempt hint."""
        record = self._read()
        if not record or record["phase"] != "committed":
            return False
        self._flush_status(record)
        if record["stage"] == "verified":
            return True
        completed = self.records.read("completed-processing.json")
        if (
            not completed
            or completed.get("releaseId") != record["candidate"]["target"]["releaseId"]
            or type(completed.get("policyRevision")) is not int
            or completed.get("policyRevision") != record["policy"]["policyRevision"]
        ):
            return False
        if set(completed) != {
            "schemaVersion",
            "releaseId",
            "policyRevision",
            "attemptId",
        }:
            raise ValueError("Invalid completed processing hint")
        from ..runtime_types import uuid4_string

        uuid4_string(completed["attemptId"])
        rejection = self.records.read("verification-rejection.json")
        if (
            rejection
            and rejection["policyRevision"] == completed["policyRevision"]
            and rejection["attemptId"] == completed["attemptId"]
        ):
            return False
        return self.verify_processing(completed["attemptId"])
