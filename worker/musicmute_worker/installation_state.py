"""Protected provisional identity and bounded resumable setup journal.

Call only while holding the native machine lock. Missing credentials after a
durable setup record exists are an error, never a reason to replace identity.
"""

import hashlib
import json
import re
import secrets
from uuid import uuid4

from .config import https_url
from .events import EVENT_CODES, EVENT_STAGES
from .runtime_types import sha256_string, uuid4_string


class InstallationState:
    def __init__(self, records, adapter, api_base_url):
        self.records = records
        self.adapter = adapter
        self.value = records.read("setup.json")
        base = https_url(api_base_url).rstrip("/")
        if not base.endswith("/api/v1"):
            raise ValueError("Invalid setup API")
        try:
            raw = adapter.load_secret("setup-identity")
        except (KeyError, FileNotFoundError):
            if self.value is not None:
                raise ValueError("Missing protected setup identity") from None
            identity = {
                "schemaVersion": 3,
                "installationId": str(uuid4()),
                "installationToken": secrets.token_hex(32),
                "machineBindingSha256": adapter.detect()["machineBindingSha256"],
                "apiBaseUrl": base,
            }
            raw = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
            adapter.protect_secret("setup-identity", raw)
            if adapter.load_secret("setup-identity") != raw:
                raise ValueError("Protected identity persistence failed")
        if not isinstance(raw, bytes) or len(raw) > 8192:
            raise ValueError("Invalid protected setup identity")
        identity = json.loads(raw)
        if (
            not isinstance(identity, dict)
            or set(identity)
            != {
                "schemaVersion",
                "installationId",
                "installationToken",
                "machineBindingSha256",
                "apiBaseUrl",
            }
            or type(identity["schemaVersion"]) is not int
            or identity["schemaVersion"] != 3
            or not re.fullmatch(r"[a-f0-9]{64}", identity["installationToken"])
            or identity["apiBaseUrl"] != base
            or identity["machineBindingSha256"]
            != adapter.detect()["machineBindingSha256"]
        ):
            raise ValueError("Invalid protected setup identity")
        uuid4_string(identity["installationId"])
        sha256_string(identity["machineBindingSha256"])
        self.identity = identity
        if self.value is None:
            self.value = {
                "schemaVersion": 3,
                "installationId": identity["installationId"],
                "stage": "bootstrap",
                "registered": False,
                "pairingState": "unpaired",
                "pairingBody": None,
                "workerId": None,
                "environment": None,
                "reportId": None,
                "failures": [],
                "sequence": 0,
                "operationId": str(uuid4()),
            }
            self.update()
        if self.value["installationId"] != identity["installationId"]:
            raise ValueError("Setup identity mismatch")
        if (
            set(self.value)
            != {
                "schemaVersion",
                "installationId",
                "stage",
                "registered",
                "pairingState",
                "pairingBody",
                "workerId",
                "environment",
                "reportId",
                "failures",
                "sequence",
                "operationId",
            }
            or type(self.value["registered"]) is not bool
            or self.value["stage"] not in EVENT_STAGES
            or self.value["pairingState"]
            not in (
                "unpaired",
                "requesting",
                "pending",
                "approved",
                "expired",
                "rejected",
            )
            or type(self.value["sequence"]) is not int
            or not 0 <= self.value["sequence"] < 2**53
            or not isinstance(self.value["failures"], list)
            or len(self.value["failures"]) > 100
        ):
            raise ValueError("Invalid setup journal")
        uuid4_string(self.value["operationId"])

    def update(self, **changes):
        self.value.update(changes)
        self.records.write("setup.json", self.value)

    def failure(self, stage, code):
        if stage not in EVENT_STAGES or code not in EVENT_CODES:
            raise ValueError("Unsafe setup failure")
        previous = self.value["failures"]
        attempt = previous[-1]["attempt"] + 1 if previous else 1
        self.update(
            stage=stage,
            failures=(
                previous
                + [
                    {
                        "stage": stage,
                        "code": code,
                        "attempt": attempt,
                    }
                ]
            )[-100:],
        )

    def pairing_body(self, report_id, *, retry=False):
        if not isinstance(report_id, str) or not re.fullmatch(
            r"[a-f0-9]{24}", report_id
        ):
            raise ValueError("Invalid qualification report identity")
        if self.value["pairingState"] == "expired" and not retry:
            raise RuntimeError("PAIRING_EXPIRED")
        existing = self.value["pairingBody"]
        if existing and not retry:
            return dict(existing)
        try:
            token = self.adapter.load_secret("worker-token")
        except (KeyError, FileNotFoundError):
            if existing or self.value["workerId"]:
                raise ValueError("Missing permanent credential") from None
            token = secrets.token_hex(32).encode()
            self.adapter.protect_secret("worker-token", token)
            if self.adapter.load_secret("worker-token") != token:
                raise ValueError("Permanent credential persistence failed")
        if not isinstance(token, bytes) or not re.fullmatch(rb"[a-f0-9]{64}", token):
            raise ValueError("Invalid permanent credential")
        body = {
            "operationId": str(uuid4()),
            "workerKeySha256": hashlib.sha256(token).hexdigest(),
            "reportId": report_id,
        }
        self.update(pairingBody=body, pairingState="requesting")
        return dict(body)
