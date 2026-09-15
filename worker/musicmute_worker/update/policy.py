"""Independent authenticated policy/event client and release-cache references."""

import copy
import http.client
import json
import re
import urllib.error
import urllib.request
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit

from ..config import https_url
from ..events import EventRequestError, encoded, utc_seconds
from ..runtime_types import ReleaseTarget, UpdateDecision, sha256_string, uuid4_string
from ..transport import opener
from .download import atomic_record, private_directory, relative_path


def parse_decision(value: dict) -> dict:
    if not isinstance(value, dict) or set(value) != set(UpdateDecision.__annotations__):
        raise ValueError("Invalid update policy fields")
    result = copy.deepcopy(value)
    utc_seconds(result["serverTime"])
    for key in ("policyRevision", "minimumClaimBuild"):
        if type(result[key]) is not int or not 0 <= result[key] <= 2**53 - 1:
            raise ValueError("Invalid update policy integer")
    if result["action"] not in ("none", "prepare", "hold"):
        raise ValueError("Invalid update policy action")
    if (
        not isinstance(result["allowedFallbackReleaseIds"], list)
        or len(result["allowedFallbackReleaseIds"]) > 100
    ):
        raise ValueError("Invalid fallback releases")
    for identity in result["allowedFallbackReleaseIds"]:
        uuid4_string(identity)
    if (
        not isinstance(result["reasonCodes"], list)
        or len(result["reasonCodes"]) > 50
        or any(
            not isinstance(c, str) or not re.fullmatch(r"[A-Z_]{1,64}", c)
            for c in result["reasonCodes"]
        )
    ):
        raise ValueError("Invalid policy reasons")
    target = result["target"]
    if target is None:
        if result["action"] == "prepare":
            raise ValueError("Missing prepare target")
        return result
    if not isinstance(target, dict) or set(target) != set(
        ReleaseTarget.__annotations__
    ):
        raise ValueError("Invalid release fields")
    uuid4_string(target["releaseId"])
    for key in ("artifactSha256", "modelSha256", "runtimeLockSha256"):
        sha256_string(target[key])
    for key in (
        "buildNumber",
        "artifactBytes",
        "minimumLauncherBuild",
        "protocolMin",
        "protocolMax",
        "stateReadMin",
        "stateReadMax",
    ):
        if type(target[key]) is not int or not 1 <= target[key] <= 2**53 - 1:
            raise ValueError("Invalid release integer")
    if (
        target["protocolMin"] > target["protocolMax"]
        or target["stateReadMin"] > target["stateReadMax"]
    ):
        raise ValueError("Invalid compatibility range")
    if target["os"] not in ("macos", "windows", "linux") or target["arch"] not in (
        "arm64",
        "x64",
    ):
        raise ValueError("Invalid release platform")
    if not isinstance(target["profileId"], str) or not re.fullmatch(
        r"[a-z0-9][a-z0-9-]{0,79}", target["profileId"]
    ):
        raise ValueError("Invalid profile identity")
    prefix = f"/releases/{target['releaseId']}/{target['profileId']}/{target['artifactSha256']}/"
    path = target["artifactPath"]
    if (
        not isinstance(path, str)
        or not path.startswith(prefix)
        or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}", path[len(prefix) :])
        or ".." in path
    ):
        raise ValueError("Invalid release artifact path")
    relative_path(path[1:])
    sources = target["compatibleSources"]
    if not isinstance(sources, list) or len(sources) > 100:
        raise ValueError("Invalid compatible sources")
    seen = set()
    for source in sources:
        if not isinstance(source, dict) or set(source) != {
            "profileId",
            "modelSha256",
            "runtimeLockSha256",
            "rollbackAllowed",
        }:
            raise ValueError("Invalid compatible source")
        if (
            not isinstance(source["profileId"], str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", source["profileId"])
            or type(source["rollbackAllowed"]) is not bool
        ):
            raise ValueError("Invalid compatible source")
        for key in ("modelSha256", "runtimeLockSha256"):
            sha256_string(source[key])
        identity = (
            source["profileId"],
            source["modelSha256"],
            source["runtimeLockSha256"],
        )
        if identity in seen:
            raise ValueError("Repeated compatible source")
        seen.add(identity)
    approval = target["approvedProfile"]
    if approval is not None:
        from ..runtime_types import ApprovedProfile

        if not isinstance(approval, dict) or set(approval) != set(
            ApprovedProfile.__annotations__
        ):
            raise ValueError("Invalid approved profile")
        for key in ("evidenceSha256", "fixtureSha256", "serviceBindingSha256"):
            sha256_string(approval[key])
        utc_seconds(approval["expiresAt"])
        if approval["provider"] not in (
            "CUDAExecutionProvider",
            "DmlExecutionProvider",
            "CoreMLExecutionProvider",
            "MIGraphXExecutionProvider",
            "OpenVINOExecutionProvider",
            "ArmNNExecutionProvider",
        ):
            raise ValueError("Invalid approved provider")
        for key in (
            "fixtureDurationSeconds",
            "maxDurationSeconds",
            "maxPreparedAudioBytes",
            "maxWallMilliseconds",
        ):
            if type(approval[key]) is not int or not 1 <= approval[key] <= 2**53 - 1:
                raise ValueError("Invalid approved profile limit")
        if approval["maxDurationSeconds"] > approval["fixtureDurationSeconds"]:
            raise ValueError("Invalid approved fixture ceiling")
    return result


def bootstrap_stable(api_base_url, profile_id, *, http_open=None):
    """Anonymous stable-release selection for an installation that has no credential.

    This is the only unauthenticated decision source; it returns public release
    selection and never fleet data, so it cannot name another machine's work.
    """
    base = https_url(api_base_url).rstrip("/")
    if not base.endswith("/api/v1") or urlsplit(base).query:
        raise ValueError("Invalid API base")
    if not isinstance(profile_id, str) or not re.fullmatch(
        r"[a-z0-9][a-z0-9-]{0,95}", profile_id
    ):
        raise ValueError("Invalid profile")
    request = urllib.request.Request(
        base + "/worker-bootstrap/stable?profileId=" + profile_id,
        headers={"Accept-Encoding": "identity"},
        method="GET",
    )
    open_url = http_open or opener().open
    try:
        with open_url(request, timeout=30) as response:
            if response.status not in (200, 201):
                raise TypeError("Invalid control response")
            raw = response.read(65537)
            if len(raw) > 65536:
                raise ValueError("Oversized control response")
            value = json.loads(raw)
    except urllib.error.HTTPError as error:
        with error:
            header = error.headers.get("Retry-After", "")
            delay = float(header) if header.isdigit() else 0.0
        raise EventRequestError(
            "DEPENDENCY_RECIPE_UNAVAILABLE",
            error.code,
            retry_after=delay,
        ) from None
    except (urllib.error.URLError, http.client.HTTPException, OSError):
        raise OSError("REPORTING_UNAVAILABLE") from None
    return parse_decision(value)


class ControlClient:
    """Existing setup/permanent bearer scopes; no raw-key enrollment flow.

    Native credential storage supplies bearer at construction. A newly paired
    client keeps the same installation_id and EventSpool; it changes only scope.
    """

    def __init__(
        self,
        api_base_url: str,
        installation_id: str,
        bearer: str,
        *,
        setup=False,
        http_open=None,
    ):
        self.base = https_url(api_base_url).rstrip("/")
        if not self.base.endswith("/api/v1") or urlsplit(self.base).query:
            raise ValueError("Invalid API base")
        self.installation_id = uuid4_string(installation_id)
        if (
            not isinstance(bearer, str)
            or not bearer
            or any(ord(c) < 33 or ord(c) > 126 for c in bearer)
        ):
            raise ValueError("Invalid bearer")
        self._bearer = bearer
        self.setup = setup
        self._open = http_open or opener().open

    def _request(self, path: str, body=None, *, authenticate=True):
        request = urllib.request.Request(
            self.base + path,
            data=encoded(body).encode() if body is not None else None,
            headers={
                **({"Authorization": "Bearer " + self._bearer} if authenticate else {}),
                "Content-Type": "application/json",
                "Accept-Encoding": "identity",
            },
            method="POST" if body is not None else "GET",
        )
        try:
            with self._open(request, timeout=30) as response:
                if response.status not in (200, 201):
                    raise TypeError("Invalid control response")
                raw = response.read(65537)
                if len(raw) > 65536:
                    raise ValueError("Oversized control response")
                value = json.loads(raw)
                if not isinstance(value, dict):
                    raise TypeError("Invalid control response")
                return value
        except urllib.error.HTTPError as error:
            with error:
                raw = error.read(65537)
                try:
                    value = json.loads(raw) if len(raw) <= 65536 else {}
                    if not isinstance(value, dict):
                        value = {}
                    server = value.get("serverTime")
                    if server is not None:
                        utc_seconds(server)
                except (ValueError, TypeError):
                    value = {}
                    server = None
                delay = 0
                header = error.headers.get("Retry-After", "")
                try:
                    if header.isdigit():
                        delay = float(header)
                    elif header and server:
                        delay = max(
                            0,
                            parsedate_to_datetime(header).timestamp()
                            - utc_seconds(server),
                        )
                except (ValueError, TypeError, OverflowError):
                    pass
            raise EventRequestError(
                value.get("code", "REPORTING_UNAVAILABLE"),
                error.code,
                server_time=server,
                retry_after=delay,
            ) from None
        except (urllib.error.URLError, http.client.HTTPException, OSError):
            raise OSError("REPORTING_UNAVAILABLE") from None

    def fetch_policy(self) -> dict:
        if self.setup:
            raise ValueError("Permanent authentication required for update policy")
        return parse_decision(self._request("/worker/update-policy"))

    def post_update_status(self, payload: dict) -> dict:
        if self.setup:
            raise ValueError("Permanent authentication required")
        required = {"policyRevision", "stage", "observedBuild", "eventId"}
        if not required <= set(payload) <= required | {"processingAttemptId"}:
            raise ValueError("Invalid update status fields")
        uuid4_string(payload["eventId"])
        for key in ("policyRevision", "observedBuild"):
            if type(payload[key]) is not int or not 1 <= payload[key] <= 2**53 - 1:
                raise ValueError("Invalid update status integer")
        if payload["stage"] not in (
            "available",
            "downloading",
            "prepared",
            "waiting_for_idle",
            "validating",
            "activating",
            "running",
            "verified",
            "failed",
            "rolled_back",
            "blocked",
        ):
            raise ValueError("Invalid update stage")
        if "processingAttemptId" in payload:
            uuid4_string(payload["processingAttemptId"])
        if payload["stage"] == "verified" and "processingAttemptId" not in payload:
            raise ValueError("Processing evidence required")
        receipt = self._request("/worker/update-status", payload)
        if receipt != {"accepted": True}:
            raise ValueError("Invalid update receipt")
        return receipt

    def post_runtime(self, payload: dict) -> dict:
        if self.setup:
            raise ValueError("Permanent authentication required")
        return self._request("/worker/runtime", payload)

    def post_qualification(self, payload: dict) -> dict:
        if self.setup:
            raise ValueError("Permanent authentication required")
        return self._request("/worker/qualification", payload)

    def register_installation(self, payload: dict) -> dict:
        if not self.setup or payload.get("installationId") != self.installation_id:
            raise ValueError("Setup authentication required")
        return self._request("/worker-installations", payload, authenticate=False)

    def installation_status(self) -> dict:
        if not self.setup:
            raise ValueError("Setup authentication required")
        return self._request("/worker-installations/" + self.installation_id)

    def setup_qualification(self, payload: dict) -> dict:
        if not self.setup:
            raise ValueError("Setup authentication required")
        return self._request(
            "/worker-installations/" + self.installation_id + "/qualification", payload
        )

    def request_pairing(self, payload: dict) -> dict:
        if not self.setup:
            raise ValueError("Setup authentication required")
        return self._request(
            "/worker-installations/" + self.installation_id + "/pairing", payload
        )

    def identity(self) -> dict:
        if self.setup:
            raise ValueError("Permanent authentication required")
        return self._request("/worker/identity", {})

    def installation_ready(self, payload: dict) -> dict:
        if self.setup:
            raise ValueError("Permanent authentication required")
        return self._request("/worker/installation-ready", payload)

    def server_time(self) -> str:
        value = (
            self._request("/worker-installations/" + self.installation_id)
            if self.setup
            else self.fetch_policy()
        )
        utc_seconds(value["serverTime"])
        return value["serverTime"]

    def post_events(self, events: list[dict]) -> dict:
        path = (
            ("/worker-installations/" + self.installation_id + "/events")
            if self.setup
            else "/worker/events"
        )
        return self._request(path, {"events": events})


class ArtifactCache:
    """Content-addressed cache with explicit W04 references independent of log TTL.

    Call under the installation machine lock. W04 persists references before
    exposing prepared/active changes; missing reference state disables pruning.
    """

    def __init__(self, root: Path):
        private_directory(root)
        self.root = root
        self.references = root / "references.json"

    def retain(
        self,
        *,
        active: dict,
        prepared: dict | None,
        rollback: list[dict],
        allowed_fallback_ids: list[str],
    ) -> None:
        records = [active] + ([prepared] if prepared else []) + rollback
        for record in records:
            if set(record) != {"releaseId", "assets"}:
                raise ValueError("Invalid cache reference")
            uuid4_string(record["releaseId"])
            if not isinstance(record["assets"], list) or not record["assets"]:
                raise ValueError("Missing cache assets")
            for asset in record["assets"]:
                sha256_string(asset)
        if any(record["releaseId"] not in allowed_fallback_ids for record in rollback):
            raise ValueError("Rollback cache reference is not permitted")
        atomic_record(self.references, {"version": 1, "records": records})

    def prune(self) -> list[str]:
        if not self.references.exists():
            return []
        if self.references.is_symlink() or self.references.stat().st_size > 1_000_000:
            raise ValueError("Invalid cache references")
        value = json.loads(self.references.read_text())
        if (
            set(value) != {"version", "records"}
            or value["version"] != 1
            or not value["records"]
        ):
            raise ValueError("Invalid cache references")
        protected = set()
        for record in value["records"]:
            uuid4_string(record["releaseId"])
            protected.update(sha256_string(asset) for asset in record["assets"])
        removed = []
        for path in self.root.iterdir():
            if re.fullmatch(r"[a-f0-9]{64}", path.name) and path.name not in protected:
                if path.is_symlink() or not path.is_file():
                    raise ValueError("Invalid cached artifact")
                path.unlink()
                removed.append(path.name)
        return removed
