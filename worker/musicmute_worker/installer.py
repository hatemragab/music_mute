"""One setup lifecycle, consumed by native hosts under their machine lock.

Native hosts own secret storage, boot installation and real containment. This
module never claims jobs, enables an administrator-disabled worker, or reboots.
"""

import hashlib
import re
import time
from datetime import datetime, timezone
from uuid import uuid4

from .events import EVENT_CODES, EventRequestError
from .launcher import InstallationBinding, canonical_binding
from .progress import atomic_json
from .update.activation import safe_boundary
from .update.journal import ClaimHold


class Installer:
    def __init__(
        self,
        state,
        setup_client,
        permanent_factory,
        runtime,
        services,
        native,
        stage=None,
    ):
        self.state = state
        self.setup = setup_client
        self.permanent_factory = permanent_factory
        self.runtime = runtime
        self.services = services
        self.native = native
        self.stage = stage

    def event(self, stage, status, code=None):
        sequence = self.state.value["sequence"] + 1
        self.state.update(sequence=sequence, stage=stage)
        event = {
            "eventId": str(uuid4()),
            "operationId": self.state.value["operationId"],
            "sequence": sequence,
            "category": "installation",
            "stage": stage,
            "status": status,
            "occurredAt": datetime.now(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
        }
        if code is not None:
            if code not in EVENT_CODES:
                raise ValueError("Unsafe setup event")
            event["code"] = code
        self.services["events"].append(event)

    def _failure(self, error):
        code = getattr(error, "code", "INSTALLATION_FAILED")
        if type(error) is RuntimeError and error.args and error.args[0] in EVENT_CODES:
            code = error.args[0]
        if code not in EVENT_CODES:
            code = "INSTALLATION_FAILED"
        stage = self.state.value["stage"]
        self.state.failure(stage, code)
        self.event(stage, "failed", code)

    def _verified_stage(self):
        """Integrity only, before any network step or code execution.

        A tampered or truncated stage must never be registered, downloaded,
        installed as a service or executed. An intact stage that merely lacks a
        qualified profile is a different case: that failure is reportable, so it
        is evaluated after registration instead of here.
        """
        from .bootstrap_release import verify_stage
        from .profiles import ProfileError

        if self.stage is None:
            raise ProfileError("DEPENDENCY_RECIPE_UNAVAILABLE")
        verify_stage(self.stage)
        return self.stage

    def _qualified_target(self):
        """Release descriptor plus the approved-profile gate, for reporting."""
        from .bootstrap_release import load_descriptor
        from .profiles import ProfileError

        target, _ = load_descriptor(self.stage)
        if target["approvedProfile"] is None:
            raise ProfileError("DEPENDENCY_RECIPE_UNAVAILABLE")
        return target

    def install(
        self,
        *,
        launcher_path,
        installer_build,
        retry_pairing=False,
        display=print,
    ):
        """Install from the entrypoint-verified bootstrap stage.

        The light distribution model replaces the signed remote release with the
        stage the native entrypoint already authenticated against its recipe
        digest. Nothing here is a backend attestation: admission still comes from
        the real qualification report through the normal claim gates.
        """
        if self.state.value["workerId"]:
            return self.repair()
        try:
            target = None
            if not self.state.value["environment"]:
                self.event("verify", "started")
                self._verified_stage()
            if not self.state.value["registered"]:
                detection = self.state.adapter.detect()
                receipt = self.setup.register_installation(
                    {
                        "installationId": self.state.identity["installationId"],
                        "tokenSha256": hashlib.sha256(
                            self.state.identity["installationToken"].encode()
                        ).hexdigest(),
                        "installerBuild": installer_build,
                        "os": detection["os"],
                        "arch": detection["arch"],
                    }
                )
                if (
                    receipt.get("installationId")
                    != self.state.identity["installationId"]
                ):
                    raise ValueError("Registration identity mismatch")
                self.state.update(registered=True)
            # Recover approval before touching setup qualification or requesting a code.
            status = self.setup.installation_status()
            if status.get("pairingState") == "approved":
                return self._approved(status)
            if status.get("pairingState") in ("expired", "rejected"):
                self.state.update(pairingState=status["pairingState"])
                if status["pairingState"] == "rejected":
                    raise RuntimeError("PAIRING_REJECTED")
                if not retry_pairing:
                    raise RuntimeError("PAIRING_EXPIRED")
            if not self.state.value["environment"]:
                self.event("install", "started")
                target = self._qualified_target()
                final = (
                    self.runtime.paths.releases
                    / target["releaseId"]
                    / target["runtimeLockSha256"]
                )
                candidate = self.runtime.prepare_from_stage(target, self.stage, final)
                self.state.update(environment=candidate)
            candidate = self.state.value["environment"]
            # An uncertain pairing request replays its original report/digest/operation.
            if not self.state.value["pairingBody"] or retry_pairing:
                self.event("service", "started")
                boot = self.native.install_boot_service(str(launcher_path))
                if boot.get("installed") is not True:
                    raise RuntimeError("STARTUP_INSTALL_FAILED")
                self.runtime.client = self.setup
                self.event("qualification", "started")
                if self.runtime.validate(candidate) is not True:
                    raise RuntimeError("GPU_QUALIFICATION_FAILED")
                report_id = self.runtime.readiness_body(candidate)[
                    "qualificationReportId"
                ]
                self.state.update(reportId=report_id)
            body = self.state.pairing_body(
                self.state.value["reportId"], retry=retry_pairing
            )
            self.event("pairing", "started")
            receipt = self.setup.request_pairing(body)
            code = receipt.get("userCode")
            if not isinstance(code, str) or not re.fullmatch(
                r"[A-Z2-9]{5}-[A-Z2-9]{5}", code
            ):
                raise ValueError("Invalid pairing response")
            from .events import utc_seconds

            utc_seconds(receipt["expiresAt"])
            self.state.update(pairingState="pending")
            display(f"Pairing code: {code}; expires {receipt['expiresAt']}")
            return "pending"
        except (OSError, RuntimeError, ValueError, EventRequestError) as error:
            self._failure(error)
            raise

    def poll_pairing(self, *, max_polls=12, sleep=time.sleep):
        if type(max_polls) is not int or not 1 <= max_polls <= 180:
            raise ValueError("Invalid bounded pairing poll count")
        for index in range(max_polls):
            status = self.setup.installation_status()
            state = status.get("pairingState")
            if state == "approved":
                return self._approved(status)
            if state in ("expired", "rejected"):
                self.state.update(pairingState=state)
                return state
            if state != "pending":
                raise ValueError("Unexpected pairing status")
            if index + 1 < max_polls:
                sleep(5)
        return "pending"

    def _approved(self, status):
        from .config import validated_worker_id

        worker_id = validated_worker_id(status["assignedWorkerId"])
        client = self.permanent_factory()
        identity = client.identity()
        if (
            identity.get("workerId") != worker_id
            or identity.get("installationId") != self.state.identity["installationId"]
        ):
            raise ValueError("Permanent identity mismatch")
        candidate = self.state.value["environment"]
        boot = self.native.check_service_context()
        binding = InstallationBinding(
            self.state.identity["installationId"],
            worker_id,
            self.state.identity["machineBindingSha256"],
            boot["serviceBindingSha256"],
            self.state.identity["apiBaseUrl"],
        )
        self.state.adapter.protect_secret(
            "installation-binding", canonical_binding(binding)
        )
        atomic_json(
            self.runtime.paths.identity / "installation.json", binding.as_dict()
        )
        self.runtime.pointer.switch(candidate)
        self.state.update(workerId=worker_id, pairingState="approved")
        return self.repair()

    def repair(self):
        """Paired repair never depends on a setup token or creates another binding."""
        client = self.permanent_factory()
        identity = client.identity()
        if (
            identity.get("installationId") != self.state.identity["installationId"]
            or identity.get("workerId") != self.state.value["workerId"]
        ):
            raise ValueError("Permanent identity mismatch")
        self.runtime.client = client
        candidate = self.runtime.pointer.read()
        ClaimHold(self.runtime.records).set(True)
        if not safe_boundary(self.runtime.boundary()):
            raise RuntimeError("OWNERSHIP_UNRESOLVED")
        if self.runtime.validate(candidate) is not True:
            raise RuntimeError("GPU_QUALIFICATION_FAILED")
        client.post_runtime(self.runtime.runtime_report(candidate))
        receipt = client.installation_ready(self.runtime.readiness_body(candidate))
        if receipt.get("accepted") is True and receipt.get("canClaim") is True:
            self.runtime.records.write(
                "local-pause.json", {"schemaVersion": 3, "paused": False}
            )
            ClaimHold(self.runtime.records).set(False)
            self.event("ready", "succeeded")
            return "ready"
        self.event(
            "pending_boot_verification", "interrupted", "BOOT_VERIFICATION_REQUIRED"
        )
        return "held"

    def pause(self):
        self.runtime.records.write(
            "local-pause.json", {"schemaVersion": 3, "paused": True}
        )
        ClaimHold(self.runtime.records).set(True)
        return "paused"

    def status(self):
        return {
            "installationId": self.state.identity["installationId"],
            "workerId": self.state.value["workerId"],
            "stage": self.state.value["stage"],
            "pairingState": self.state.value["pairingState"],
            "failures": list(self.state.value["failures"]),
        }

    def uninstall(self):
        self.pause()
        if not safe_boundary(self.runtime.boundary()):
            raise RuntimeError("OWNERSHIP_UNRESOLVED")
        candidate = self.state.value["environment"]
        if not safe_boundary(self.runtime.stop_and_reconcile(candidate)):
            raise RuntimeError("OWNERSHIP_UNRESOLVED")
        if self.native.remove_boot_service() is not True:
            raise RuntimeError("SERVICE_FAILED")
        # Retain identity, unresolved journals, runtimes and logs for deliberate cleanup.
        return "service_removed_state_retained"
