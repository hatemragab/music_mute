"""Durable single-assignment supervisor for the existing MusicMute worker API."""

import json
import logging
import math
import random
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

from .config import Config
from .engine import EngineError, SeparatorEngine
from .processes import ProcessRunner
from .progress import (
    Progress,
    atomic_json,
    bind_installation,
    installation_session,
    matches_file,
)
from .transport import Api, ApiError, TransferError, Transfers

LOG = logging.getLogger("musicmute.worker")
SELECTORS = ("jobId", "attemptId", "sessionId", "generation")
TERMINAL = {"ready", "failed", "cancelled"}


class LeaseLost(Exception):
    pass


class Cancelled(Exception):
    pass


class Stopping(Exception):
    pass


class MediaError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def selectors(assignment: dict) -> dict:
    result = {key: assignment[key] for key in SELECTORS}
    if not isinstance(result["jobId"], str) or not re.fullmatch(
        r"[a-f0-9]{24}", result["jobId"]
    ):
        raise ValueError("Invalid job assignment")
    for key in ("attemptId", "sessionId"):
        value = UUID(result[key])
        if value.version != 4 or str(value) != result[key]:
            raise ValueError("Invalid assignment identifier")
    if type(result["generation"]) is not int or result["generation"] < 1:
        raise ValueError("Invalid assignment generation")
    return result


class Journal:
    def __init__(self, root: Path):
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / "active.json"
        self.active = None
        if self.path.exists():
            if self.path.is_symlink() or self.path.stat().st_size > 8192:
                raise RuntimeError("Invalid local assignment journal")
            data = json.loads(self.path.read_text(encoding="utf-8"))
            self.active = selectors(data) if data else None

    def save(self, assignment: dict | None) -> None:
        value = selectors(assignment) if assignment else None
        atomic_json(self.path, value)
        self.active = value


class Lease:
    """Heartbeat independently of media I/O; fail closed before the lease expires."""

    def __init__(
        self, api: Api | None, assignment: dict, stop: threading.Event | None = None
    ):
        self.api = api
        self.assignment = assignment
        self.stop = stop or threading.Event()
        self.finished = threading.Event()
        self.cancelled = bool(assignment.get("cancelRequested"))
        self.lost = False
        self.lock = threading.Lock()
        self._renew(assignment["leaseExpiresAt"])
        self.thread = threading.Thread(
            target=self._heartbeat, daemon=True, name="worker-heartbeat"
        )

    def _renew(self, expires: str) -> None:
        remaining = (
            datetime.fromisoformat(expires.replace("Z", "+00:00"))
            - datetime.now(timezone.utc)
        ).total_seconds()
        if not math.isfinite(remaining):
            raise ValueError("Invalid lease expiry")
        self.deadline = time.monotonic() + remaining - 10

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.finished.set()
        self.thread.join(timeout=17)

    def check(self, *, ignore_cancel: bool = False) -> None:
        if self.stop.is_set():
            raise Stopping()
        with self.lock:
            if self.lost or time.monotonic() >= self.deadline:
                raise LeaseLost(
                    "Assignment lease lost; processing stopped for recovery"
                )
            if self.cancelled and not ignore_cancel:
                raise Cancelled()

    def _heartbeat(self):
        while not self.finished.is_set():
            delay = 20
            try:
                reply = self.api.post("heartbeat", selectors(self.assignment))
                with self.lock:
                    self._renew(reply["leaseExpiresAt"])
                    self.cancelled = self.cancelled or bool(
                        reply.get("cancelRequested")
                    )
            except ApiError as error:
                with self.lock:
                    if not error.retryable:
                        self.lost = True
                delay = 2
            except (ValueError, KeyError, TypeError):
                with self.lock:
                    self.lost = True
            if self.finished.wait(delay):
                return


def wait_checked(seconds: float, check) -> None:
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        check()
        time.sleep(min(0.2, max(0, until - time.monotonic())))


def inspect_audio(
    path: Path,
    runner: ProcessRunner,
    check,
    *,
    output: bool = False,
    prepared: Path | None = None,
) -> float:
    """Probe stream type then decode up to the strict duration ceiling."""
    try:
        if prepared is not None and prepared.is_symlink():
            raise MediaError("INVALID_AUDIO")
        probe = runner.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "json",
                str(path),
            ],
            cwd=path.parent,
            timeout=30,
            check=check,
            capture=True,
        )
        streams = json.loads(probe.stdout)["streams"]
        if not streams or (output and streams[0].get("codec_name") != "mp3"):
            raise MediaError("OUTPUT_INVALID" if output else "INVALID_AUDIO")
        decoded = runner.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-v",
                "error",
                "-xerror",
                "-nostdin",
                "-nostats",
                "-i",
                str(path),
                "-map",
                "0:a:0",
                "-vn",
                "-t",
                "600",
                "-ar",
                "44100",
                "-ac",
                "2",
                "-progress",
                "pipe:1",
                *(
                    ["-y", "-c:a", "pcm_s16le", "-f", "wav", str(prepared)]
                    if prepared is not None
                    else ["-f", "null", "-"]
                ),
            ],
            cwd=path.parent,
            timeout=300,
            check=check,
            capture=True,
        )
        values = re.findall(r"^out_time_us=(\d+)$", decoded.stdout, re.MULTILINE)
        duration = max((int(value) / 1_000_000 for value in values), default=0)
        if duration >= 600:
            raise MediaError("OUTPUT_INVALID" if output else "INPUT_TOO_LONG")
        if duration <= 0:
            raise MediaError("OUTPUT_INVALID" if output else "INVALID_AUDIO")
        return duration
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        ValueError,
        KeyError,
        OSError,
    ):
        raise MediaError("OUTPUT_INVALID" if output else "INVALID_AUDIO") from None


class Worker:
    def __init__(
        self,
        config: Config,
        api: Api,
        transfers: Transfers,
        stop: threading.Event | None = None,
    ):
        self.config = config
        self.api = api
        self.transfers = transfers
        self.stop = stop or threading.Event()
        self.session = installation_session(config.state_dir)
        self.journal = Journal(config.state_dir)
        bind_installation(
            config.state_dir,
            config.api_base_url,
            config.worker_id,
            active=self.journal.active is not None,
        )
        self.progress = Progress(config.state_dir, config.separator)
        self.cleanup_path = config.state_dir / "pending-cleanup.json"
        self.long_poll_supported = True
        self.stage = "validating"
        self._recovered = False
        self._engine = None
        self._engine_fingerprint = None
        self._identity_verified = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self):
        self._close_engine()
        self._recovered = False

    def _close_engine(self):
        if self._engine is not None:
            self._engine.close()
            self._engine = None
        self._engine_fingerprint = None

    def _claim(self, wait_seconds: int = 0):
        body = {"sessionId": self.session}
        if wait_seconds and self.long_poll_supported:
            body["waitSeconds"] = wait_seconds
        try:
            return self.api.post("claim", body)
        except ApiError as error:
            if error.status != 400 or "waitSeconds" not in body:
                raise
            # Rolling upgrades: older servers reject the optional field. A
            # successful legacy request enables bounded one-second polling.
            reply = self.api.post("claim", {"sessionId": self.session})
            self.long_poll_supported = False
            return reply

    def _verify_identity(self) -> None:
        if self._identity_verified:
            return
        reply = self.api.post("identity", {})
        if (
            not isinstance(reply, dict)
            or reply.get("workerId") != self.config.worker_id
            or type(reply.get("protocolVersion")) is not int
            or reply.get("protocolVersion") != 2
            or reply.get("state") not in ("enabled", "draining", "revoked")
        ):
            raise RuntimeError(
                "Backend worker identity does not match this installation or protocol"
            )
        self._identity_verified = True

    def _finish_cleanup(self, assignment: dict, status: str):
        # Persist before erasing files so restart retries the attestation, even
        # if the backend accepted it and the response was lost.
        value = {**selectors(assignment), "status": status}
        atomic_json(self.cleanup_path, value)
        self._resume_cleanup()

    def _resume_cleanup(self):
        if not self.cleanup_path.exists():
            return None
        if self.cleanup_path.is_symlink() or self.cleanup_path.stat().st_size > 2048:
            raise RuntimeError("Invalid pending cleanup journal")
        value = json.loads(self.cleanup_path.read_text(encoding="utf-8"))
        if value is None:
            return None
        assignment = selectors(value)
        if value.get("status") not in TERMINAL:
            raise RuntimeError("Invalid cleanup terminal status")
        self._close_engine()
        self.progress.purge_job(assignment["jobId"])
        reply = self.api.post("local-cleanup", {
            **assignment, "eventId": str(uuid4()), "localDataDeleted": True,
        })
        if not reply or reply.get("status") != "cleaned":
            raise ApiError(0, "INVALID_RESPONSE")
        self.journal.save(None)
        atomic_json(self.cleanup_path, None)
        return {"status": value["status"]}

    def _assignment(self, wait_seconds: int = 0):
        pending = self._resume_cleanup()
        if pending:
            return pending
        reconciled_attempt_id = None
        if self.journal.active:
            self._close_engine()
            # An earlier reconcile can have committed a replacement even if its
            # response was lost. Discover and follow that replacement only when
            # this installation already owns a saved assignment and all of its
            # contained processes have stopped.
            for _ in range(4):
                try:
                    reconciled_attempt_id = self.journal.active["attemptId"]
                    reply = self.api.post(
                        "reconcile",
                        {
                            "sessionId": self.session,
                            "previousAttemptId": reconciled_attempt_id,
                            "stopped": True,
                        },
                    )
                    break
                except ApiError as error:
                    if error.code == "STALE_ATTEMPT":
                        try:
                            reply = self._claim()
                            break
                        except ApiError as claimed:
                            error = claimed
                    if (
                        error.code != "WORKER_RECOVERY_REQUIRED"
                        or not error.previous_attempt_id
                    ):
                        raise error  # noqa: TRY201 -- may be the newer claim exception
                    self.journal.save(
                        {**self.journal.active, "attemptId": error.previous_attempt_id}
                    )
            else:
                raise LeaseLost("Recovery changed repeatedly; retry after reconnecting")
        else:
            try:
                reply = self._claim(wait_seconds)
            except ApiError as error:
                if error.code == "WORKER_RECOVERY_REQUIRED":
                    if not error.can_recover or not error.previous_attempt_id:
                        raise RuntimeError(
                            "Backend requires recovery but this folder has no saved assignment. Use the original worker folder; do not claim that another machine has stopped."
                        ) from None
                    # The backend confirms the durable claim session belongs to
                    # this installation. Recovery has already stopped its old
                    # contained processes before making this attestation.
                    self._close_engine()
                    reconciled_attempt_id = error.previous_attempt_id
                    reply = self.api.post(
                        "reconcile",
                        {
                            "sessionId": self.session,
                            "previousAttemptId": reconciled_attempt_id,
                            "stopped": True,
                        },
                    )
                else:
                    raise
        if reply and reply.get("status") in TERMINAL:
            if not self.journal.active:
                raise RuntimeError("Terminal recovery lacks an owned assignment")
            self._finish_cleanup(self.journal.active, reply["status"])
            return reply
        if reply and reply.get("status") == "released":
            if (
                reconciled_attempt_id is None
                or reply.get("previousAttemptId") != reconciled_attempt_id
            ):
                raise RuntimeError("Released recovery lacks the owned assignment")
            if self.journal.active:
                self.journal.save(None)
            return None
        if reply:
            self.journal.save(reply)
        elif self.journal.active:
            self.journal.save(None)
        return reply

    def _event(
        self,
        route: str,
        assignment: dict,
        lease: Lease,
        fields: dict | None = None,
        *,
        acknowledgement: bool = False,
    ):
        body = {**selectors(assignment), "eventId": str(uuid4()), **(fields or {})}
        for attempt in range(5):
            lease.check(ignore_cancel=acknowledgement)
            try:
                return self.api.post(route, body)
            except ApiError as error:
                if not error.retryable or attempt == 4:
                    raise
                wait_checked(
                    max(min(2**attempt, 8), error.retry_after or 0),
                    lambda: lease.check(ignore_cancel=acknowledgement),
                )

    def _transfer_wait(
        self, error: TransferError, attempt: int, deadline: float, lease: Lease
    ):
        delay = max(
            min(2 ** max(0, attempt - 1), 8) * random.uniform(1, 1.2),
            error.retry_after or 0,
        )
        if time.monotonic() + delay >= deadline:
            raise TransferError(error.code)
        LOG.warning(
            "Transfer retry %s/%s (%s)",
            attempt,
            self.config.transfer_attempts,
            error.code,
        )
        wait_checked(delay, lease.check)

    def _transfer_check(
        self, deadline: float, lease: Lease, code: str, *, uncertain=False
    ):
        lease.check()
        if time.monotonic() >= deadline:
            raise TransferError(code, uncertain=uncertain)

    def _refresh_input(self, assignment: dict, lease: Lease) -> dict:
        lease.check()
        current = self.api.post("claim", {"sessionId": assignment["sessionId"]})
        if not current or selectors(current) != selectors(assignment):
            raise LeaseLost("Input grant refresh changed the assignment")
        if current.get("cancelRequested"):
            raise Cancelled()
        media = current["input"]
        if any(
            media[k] != assignment["input"][k] for k in ("bytes", "sha256", "extension")
        ):
            raise LeaseLost("Input identity changed during grant refresh")
        return media["download"]

    def _download(self, assignment: dict, path: Path, lease: Lease):
        media = assignment["input"]
        if path.is_symlink():
            raise MediaError("INVALID_AUDIO")
        if matches_file(path, media["bytes"], media["sha256"], lease.check):
            return
        deadline = time.monotonic() + self.config.transfer_retry_budget_seconds
        grant = media["download"]
        while self.progress.data["downloadAttempts"] < self.config.transfer_attempts:
            lease.check()
            self.progress.data["downloadAttempts"] += 1
            self.progress.save()
            try:
                self.transfers.download(
                    grant,
                    path,
                    media["bytes"],
                    media["sha256"],
                    lambda: self._transfer_check(deadline, lease, "DOWNLOAD_FAILED"),
                )
                return
            except TransferError as error:
                if (
                    not error.retryable
                    or self.progress.data["downloadAttempts"]
                    >= self.config.transfer_attempts
                ):
                    raise TransferError(error.code) from None
                self._transfer_wait(
                    error, self.progress.data["downloadAttempts"], deadline, lease
                )
                grant = self._refresh_input(assignment, lease)
        raise TransferError("DOWNLOAD_FAILED")

    def _result(self, assignment: dict, lease: Lease, runner: ProcessRunner) -> Path:
        result = self.progress.artifact("output", lease.check)
        if result is None:
            prepared = self.progress.artifact("prepared", lease.check)
            if prepared is None:
                media = assignment["input"]
                source = self.progress.work / ("input." + media["extension"])
                self._download(assignment, source, lease)
                prepared = self.progress.work / "prepared.wav"
                duration = inspect_audio(source, runner, lease.check, prepared=prepared)
                self.progress.data["inputDurationSeconds"] = duration
                self.progress.record("prepared", prepared, duration, lease.check)
            else:
                self.progress.data["inputDurationSeconds"] = self.progress.data[
                    "prepared"
                ]["durationSeconds"]
        if assignment.get("status") != "uploading_result":
            self._event(
                "stage",
                assignment,
                lease,
                {
                    "stage": "processing",
                    "durationSeconds": self.progress.data["inputDurationSeconds"],
                    "decodable": True,
                    "hasAudio": True,
                },
            )
        self.stage = "processing"
        if result is not None:
            LOG.info("Job %s: reusing verified local result", assignment["jobId"])
            return result
        LOG.info("Job %s: processing with DirectML / Kim Vocal 2", assignment["jobId"])
        # A crash can leave an uncheckpointed output. A new directory avoids
        # confusing it with a new successful result or overwriting it.
        output = self.progress.local_path(Path("outputs") / uuid4().hex)
        try:
            if self.config.reuse_separator:
                if self._engine_fingerprint != self.progress.processor_fingerprint:
                    self._close_engine()
                if self._engine is None:
                    self._engine = SeparatorEngine(
                        self.config.separator, self.config.state_dir / "engines"
                    )
                    self._engine_fingerprint = self.progress.processor_fingerprint
                self._engine.run(
                    prepared,
                    output,
                    timeout=self.config.processing_timeout_seconds,
                    check=lease.check,
                )
            else:
                runner.run(
                    [
                        sys.executable,
                        str(self.config.separator),
                        str(prepared),
                        "--prepared",
                        "--output_dir",
                        str(output),
                    ],
                    cwd=self.config.separator.parent,
                    timeout=self.config.processing_timeout_seconds,
                    check=lease.check,
                )
        except (EngineError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            self.close()
            raise MediaError("SEPARATOR_FAILED") from None
        results = list(output.glob("*.mp3"))
        if len(results) != 1 or results[0].is_symlink():
            raise MediaError("OUTPUT_INVALID")
        result = results[0]
        if not 0 < result.stat().st_size < self.config.output_max_bytes:
            raise MediaError("OUTPUT_INVALID")
        duration = inspect_audio(result, runner, lease.check, output=True)
        self.progress.record("output", result, duration, lease.check)
        return result

    def _upload(self, assignment: dict, result: Path, lease: Lease):
        value = self.progress.data["output"]
        if not 0 < value["bytes"] < self.config.output_max_bytes:
            raise MediaError("OUTPUT_INVALID")
        fields = {k: value[k] for k in ("bytes", "durationSeconds", "sha256")}
        fields.update(contentType="audio/mpeg", playable=True, voiceOnly=True)
        deadline = time.monotonic() + self.config.transfer_retry_budget_seconds
        while self.progress.data["uploadAttempts"] < self.config.transfer_attempts:
            reservation = self._event("output-url", assignment, lease, fields)
            lease.check()
            self.progress.data["uploadAttempts"] += 1
            self.progress.save()
            try:
                self.transfers.upload(
                    reservation["upload"],
                    result,
                    lambda: self._transfer_check(
                        deadline, lease, "OUTPUT_UPLOAD_FAILED", uncertain=True
                    ),
                )
                return self._event("complete", assignment, lease)
            except TransferError as error:
                if error.uncertain:
                    # If S3 accepted the bytes but its reply was lost, complete
                    # verifies the pinned object instead of uploading it twice.
                    try:
                        return self._event("complete", assignment, lease)
                    except ApiError as verification:
                        if verification.code != "UPLOAD_NOT_READY":
                            raise
                if (
                    not error.retryable
                    or self.progress.data["uploadAttempts"]
                    >= self.config.transfer_attempts
                ):
                    raise TransferError(error.code) from None
                self._transfer_wait(
                    error, self.progress.data["uploadAttempts"], deadline, lease
                )
        raise TransferError("OUTPUT_UPLOAD_FAILED")

    def run_once(self, *, wait_seconds: int = 0) -> str:
        with ProcessRunner() as runner:
            # The caller holds the machine-wide instance lock. Terminate/query old
            # contained descendants before sending any stopped attestation.
            if not self._recovered:
                runner.recover()
                self._recovered = True
            self._verify_identity()
            assignment = self._assignment(wait_seconds)
            if not assignment:
                return "idle"
            if assignment.get("status") in TERMINAL:
                return assignment["status"]
            LOG.info("Job %s: validating", assignment["jobId"])
            with Lease(self.api, assignment, self.stop) as lease:
                self.stage = "validating"
                try:
                    lease.check()
                    media = assignment["input"]
                    extension = media["extension"]
                    if extension not in (
                        "m4a",
                        "mp4",
                        "webm",
                        "opus",
                        "ogg",
                        "aac",
                        "mp3",
                    ):
                        raise MediaError("INVALID_AUDIO")
                    self.progress.bind(assignment)
                    result = self._result(assignment, lease, runner)
                    self.stage = "uploading_result"
                    LOG.info("Job %s: uploading result", assignment["jobId"])
                    reply = self._upload(assignment, result, lease)
                except Cancelled:
                    # ProcessRunner.run unwinds only after descendants stop.
                    self.close()
                    reply = self._event(
                        "cancelled",
                        assignment,
                        lease,
                        {"stopped": True},
                        acknowledgement=True,
                    )
                except (MediaError, TransferError) as error:
                    self.close()
                    if isinstance(error, TransferError) and error.uncertain:
                        raise LeaseLost(
                            "Upload outcome unknown; reconcile before retrying"
                        ) from None
                    codes = {
                        "INVALID_AUDIO",
                        "INPUT_TOO_LONG",
                        "INPUT_CHECKSUM_MISMATCH",
                        "SEPARATOR_FAILED",
                        "OUTPUT_INVALID",
                        "DOWNLOAD_FAILED",
                        "OUTPUT_UPLOAD_FAILED",
                    }
                    code = (
                        error.code
                        if error.code in codes
                        else (
                            "OUTPUT_UPLOAD_FAILED"
                            if self.stage == "uploading_result"
                            else "DOWNLOAD_FAILED"
                        )
                    )
                    reply = self._event(
                        "fail",
                        assignment,
                        lease,
                        {"code": code, "stage": self.stage, "stopped": True},
                        acknowledgement=True,
                    )
                if not reply or reply.get("status") not in TERMINAL:
                    raise ApiError(0, "INVALID_RESPONSE")
                self._finish_cleanup(assignment, reply["status"])
                LOG.info("Job %s: %s", assignment["jobId"], reply["status"])
                return reply["status"]
