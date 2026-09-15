"""Durable installation-scoped, redacted event reporting; standard library only."""

import copy
import json
import random
import re
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .runtime_types import uuid4_string
from .update.download import private_directory

EVENT_CATEGORIES = frozenset(
    ("installation", "pairing", "startup", "processing", "update", "cleanup")
)
EVENT_STATUSES = frozenset(
    ("started", "progress", "succeeded", "failed", "interrupted")
)
EVENT_STAGES = frozenset(
    (
        "bootstrap",
        "preflight",
        "prerequisites",
        "download",
        "verify",
        "extract",
        "install",
        "qualification",
        "pairing",
        "approval",
        "service",
        "pending_boot_verification",
        "boot_verification",
        "ready",
        "startup",
        "claim",
        "processing",
        "upload",
        "cleanup",
        "update",
        "downloading",
        "staged",
        "activating",
        "running",
        "verified",
        "rollback",
        "rolled_back",
        "complete",
        "shutdown",
    )
)
EVENT_CODES = frozenset(
    (
        "CPU_ONLY_UNSUPPORTED",
        "GPU_PROVIDER_UNAVAILABLE",
        "GPU_UNAVAILABLE_IN_SERVICE",
        "GPU_QUALIFICATION_FAILED",
        "DRIVER_ACTION_REQUIRED",
        "UNSUPPORTED_OS_ARCH",
        "DEPENDENCY_RECIPE_UNAVAILABLE",
        "INSUFFICIENT_DISK",
        "INSUFFICIENT_MEMORY",
        "MODEL_INTEGRITY_FAILED",
        "PREBOOT_UNLOCK_REQUIRED",
        "STARTUP_INSTALL_FAILED",
        "REPORTING_UNAVAILABLE",
        "UPDATE_SIGNATURE_INVALID",
        "DOWNLOAD_FAILED",
        "CHECKSUM_MISMATCH",
        "SIGNATURE_INVALID",
        "UNSUPPORTED_PLATFORM",
        "UNSUPPORTED_DRIVER",
        "MISSING_WHEEL",
        "RESOURCE_EXHAUSTED",
        "OUTPUT_INVALID",
        "CPU_FALLBACK",
        "QUALIFICATION_FAILED",
        "SERVICE_FAILED",
        "BOOT_VERIFICATION_REQUIRED",
        "PAIRING_EXPIRED",
        "PAIRING_REJECTED",
        "AUTHENTICATION_FAILED",
        "NETWORK_UNAVAILABLE",
        "INSTALLATION_FAILED",
        "STARTUP_FAILED",
        "SEPARATOR_FAILED",
        "OUTPUT_UPLOAD_FAILED",
        "CLEANUP_FAILED",
        "UPDATE_FAILED",
        "ROLLBACK_FAILED",
        "REPORTING_INTERRUPTED",
        "EVENTS_DROPPED",
        "CANCELLED",
    )
)
COMPONENTS = frozenset(
    (
        "bootstrap",
        "installer",
        "runtime",
        "python",
        "ffmpeg",
        "model",
        "driver",
        "provider",
        "service",
        "worker",
        "storage",
        "network",
        "cuda",
        "coreml",
        "onnxruntime",
    )
)

RETENTION_SECONDS = 30 * 24 * 60 * 60
MAX_SPOOL_BYTES = 20 * 1024**2
# Pre-Python bootstrap events share the spool root and count against the same cap.
NATIVE_EVENTS_DIR = "bootstrap"


def utc_seconds(value: str) -> float:
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value
    ):
        raise ValueError("Invalid UTC event time")
    result = datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    if utc_string(result) != value:
        raise ValueError("Invalid UTC event time")
    return result


def utc_string(value: float) -> str:
    return (
        datetime.fromtimestamp(value, timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def encoded(value) -> str:
    return json.dumps(
        value,
        separators=(",", ":"),
        sort_keys=True,
        ensure_ascii=False,
        allow_nan=False,
    )


def safe_event(event: dict) -> dict:
    required = {
        "eventId",
        "operationId",
        "sequence",
        "category",
        "stage",
        "status",
        "occurredAt",
    }
    if (
        not isinstance(event, dict)
        or not required <= event.keys()
        or event.keys() - required - {"durationMs", "code", "details"}
    ):
        raise ValueError("Invalid event fields")
    value = copy.deepcopy(event)
    for key in ("eventId", "operationId"):
        uuid4_string(value[key])

    def integer(number, minimum=0):
        if type(number) is not int or not minimum <= number <= 2**53 - 1:
            raise ValueError("Invalid event integer")

    integer(value["sequence"], 1)
    for key, allowed in [
        ("category", EVENT_CATEGORIES),
        ("stage", EVENT_STAGES),
        ("status", EVENT_STATUSES),
        ("code", EVENT_CODES),
    ]:
        if key in value and (
            not isinstance(value[key], str) or value[key] not in allowed
        ):
            raise ValueError("Invalid event vocabulary")
    utc_seconds(value["occurredAt"])
    if "durationMs" in value:
        integer(value["durationMs"])
    if "details" in value:
        details = value["details"]
        if not isinstance(details, dict) or details.keys() - {
            "component",
            "componentVersion",
            "attempt",
            "exitCode",
            "downloadedBytes",
            "totalBytes",
            "droppedEvents",
            "diagnostic",
        }:
            raise ValueError("Invalid event details")
        if "component" in details and (
            not isinstance(details["component"], str)
            or details["component"] not in COMPONENTS
        ):
            raise ValueError("Invalid component")
        if "componentVersion" in details and (
            not isinstance(details["componentVersion"], str)
            or not re.fullmatch(
                r"\d{1,5}(?:\.\d{1,5}){0,3}", details["componentVersion"]
            )
        ):
            raise ValueError("Invalid component version")
        for key in (
            "attempt",
            "exitCode",
            "downloadedBytes",
            "totalBytes",
            "droppedEvents",
        ):
            if key in details:
                integer(
                    details[key],
                    1 if key == "attempt" else -2147483648 if key == "exitCode" else 0,
                )
        if "diagnostic" in details:
            if not isinstance(details["diagnostic"], str):
                raise ValueError("Invalid diagnostic")
            # Redact before SQLite persistence, including arbitrarily long private exceptions.
            if details["diagnostic"] not in EVENT_CODES:
                details["diagnostic"] = "[redacted]"
    if len(encoded(value).encode()) > 4096:
        raise ValueError("Event exceeds byte limit")
    return value


def progress_key(event: dict) -> str | None:
    if event["status"] != "progress":
        return None
    return encoded(
        {
            key: event.get(key)
            for key in ("operationId", "category", "stage", "details", "code")
        }
    )


class EventRequestError(Exception):
    """Only known atomic backend rejections permit rebatching; never raw prose."""

    def __init__(
        self,
        code: str,
        status: int,
        *,
        server_time: str | None = None,
        retry_after: float = 0,
    ):
        safe_codes = {
            "EVENT_CLOCK_AHEAD",
            "EVENT_TOO_OLD",
            "RATE_LIMITED",
            "EVENT_ID_CONFLICT",
            "INVALID_EVENT",
            "EVENT_BODY_TOO_LARGE",
            "AUTHENTICATION_FAILED",
        }
        self.code = (
            code
            if isinstance(code, str) and code in safe_codes
            else "REPORTING_UNAVAILABLE"
        )
        self.status = status
        self.server_time = server_time
        self.retry_after = max(0, min(float(retry_after), 86400))
        self.atomic = (
            (
                status == 400
                and self.code in {"EVENT_CLOCK_AHEAD", "EVENT_TOO_OLD", "INVALID_EVENT"}
            )
            or (status == 409 and self.code == "EVENT_ID_CONFLICT")
            or (status == 429 and self.code == "RATE_LIMITED")
            or (status == 413 and self.code == "EVENT_BODY_TOO_LARGE")
        )
        super().__init__(self.code)


class EventSpool:
    """SQLite transactions fsync before network I/O, separately from job journals.

    One launcher owns upload scheduling through the native machine lock. append
    can run concurrently in local components; SQLite serializes writers. No
    credentials or raw exception strings enter this database.
    """

    def __init__(
        self,
        root: Path,
        installation_id: str,
        *,
        clock=time.time,
        monotonic=time.monotonic,
        max_bytes=MAX_SPOOL_BYTES,
        terminal_reserve=2 * 1024**2,
    ):
        private_directory(root)
        self.path = root / "events.sqlite3"
        if any(
            (root / name).is_symlink()
            for name in (
                "events.sqlite3",
                "events.sqlite3-journal",
                "events.sqlite3-wal",
                "events.sqlite3-shm",
            )
        ):
            raise ValueError("Event database symlink")
        self.installation_id = uuid4_string(installation_id)
        self.clock = clock
        self.monotonic = monotonic
        if type(max_bytes) is not int or not 8192 <= max_bytes <= MAX_SPOOL_BYTES:
            raise ValueError("Invalid spool cap")
        self.max_bytes = max_bytes
        self.terminal_reserve = terminal_reserve
        self.root = root
        with self._db() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, bytes INTEGER NOT NULL,
                occurred REAL NOT NULL, priority INTEGER NOT NULL, progress TEXT, state TEXT NOT NULL DEFAULT 'queued');
            CREATE TABLE IF NOT EXISTS event_clock (id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
                observed REAL NOT NULL, age REAL NOT NULL, server_occurrence REAL);
            CREATE TABLE IF NOT EXISTS dropped (reason TEXT PRIMARY KEY, count INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS progress_receipts (key TEXT PRIMARY KEY, received REAL NOT NULL);""")
            identity = self._get(db, "installationId")
            if identity is not None and identity != installation_id:
                raise ValueError("Spool installation mismatch")
            if (
                self._get(db, "spoolSchemaVersion") != 2
                and db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            ):
                raise ValueError(
                    "Incompatible event spool schema; preserve existing diagnostics for explicit recovery"
                )
            self._set(db, "spoolSchemaVersion", 2)
            self._set(db, "installationId", installation_id)
        self.path.chmod(0o600)

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA synchronous=FULL")
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute("PRAGMA max_page_count=5120")
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _get(db, key, default=None):
        row = db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    @staticmethod
    def _set(db, key, value):
        db.execute(
            "INSERT OR REPLACE INTO metadata VALUES (?,?)", (key, encoded(value))
        )

    @staticmethod
    def _drop(db, ids, reason):
        if not ids:
            return
        db.executemany("DELETE FROM events WHERE id=?", [(i,) for i in ids])
        db.execute(
            "INSERT INTO dropped VALUES (?,?) ON CONFLICT(reason) DO UPDATE SET count=count+excluded.count",
            (reason, len(ids)),
        )

    def append(self, event: dict) -> None:
        self._append(event)

    def import_bootstrap(self, event: dict, *, uncertain: bool) -> bool:
        """Commit native handoff before its file is removed; never rewrite retries."""
        if type(uncertain) is not bool:
            raise ValueError("Invalid native event delivery state")
        return self._append(event, uncertain=uncertain, imported=True)

    def _append(self, event: dict, *, uncertain=False, imported=False) -> bool:
        value = safe_event(event)
        payload = encoded(value)
        if uncertain and payload != encoded(event):
            raise ValueError("Uncertain native event would change during validation")
        size = len(payload.encode())
        priority = int(value["status"] in ("failed", "succeeded", "interrupted"))
        key = progress_key(value)
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            prior = db.execute(
                "SELECT payload FROM events WHERE id=?", (value["eventId"],)
            ).fetchone()
            if prior:
                if prior[0] != payload:
                    raise ValueError("EVENT_ID_CONFLICT")
                if uncertain:
                    db.execute(
                        "UPDATE events SET state='uncertain' WHERE id=? AND state='queued'",
                        (value["eventId"],),
                    )
                return True
            # Keep first and latest unsent identical progress observations. Never
            # replace a payload whose previous delivery may have succeeded.
            if key and not uncertain:
                rows = db.execute(
                    "SELECT id FROM events WHERE progress=? AND state='queued' ORDER BY rowid",
                    (key,),
                ).fetchall()
                if len(rows) >= 2:
                    self._drop(db, [r[0] for r in rows[1:]], "PROGRESS_COALESCED")
            used = db.execute("SELECT COALESCE(SUM(bytes),0) FROM events").fetchone()[0]
            budget = self.budget()
            reserve = min(self.terminal_reserve, budget // 2)
            ceiling = budget if priority else budget - reserve
            if used + size > ceiling:
                victims = db.execute(
                    "SELECT id,bytes FROM events WHERE priority=0 AND state='queued' ORDER BY rowid"
                ).fetchall()
                evicted = []
                for victim in victims:
                    if used + size <= ceiling:
                        break
                    evicted.append(victim["id"])
                    used -= victim["bytes"]
                self._drop(db, evicted, "SPOOL_CAPACITY")
            if used + size > ceiling:
                db.execute(
                    "INSERT INTO dropped VALUES ('SPOOL_CAPACITY',1) ON CONFLICT(reason) DO UPDATE SET count=count+1"
                )
                return False
            db.execute(
                "INSERT INTO events (id,payload,bytes,occurred,priority,progress,state) VALUES (?,?,?,?,?,?,?)",
                (
                    value["eventId"],
                    payload,
                    size,
                    utc_seconds(value["occurredAt"]),
                    priority,
                    key,
                    "uncertain" if uncertain else "queued",
                ),
            )

            db.execute(
                "INSERT INTO event_clock VALUES (?,?,?,NULL)",
                (
                    value["eventId"],
                    self.monotonic(),
                    0
                    if imported
                    else max(0, self.clock() - utc_seconds(value["occurredAt"])),
                ),
            )
            return True

    def native_bytes(self, *, strict=False) -> int:
        """Bytes retained by the pre-Python bootstrap directory.

        Those files are imported and unlinked by the handoff; until then they are
        part of the same local spool and must be counted against the same cap.
        Capacity deferral deliberately preserves them, so without this the SQL
        budget alone would understate what the machine actually retains.

        Diagnostics count regular files only: a linked entry is a rejection case
        the importer already preserves and refuses, and a status read must not
        fail because of it. Capacity accounting is strict, because a link would
        otherwise hide retained bytes from the cap.
        """
        directory = self.root / NATIVE_EVENTS_DIR
        if not directory.exists() and not directory.is_symlink():
            return 0
        if directory.is_symlink() or not directory.is_dir():
            if strict:
                raise ValueError("Unsafe native event directory")
            return 0
        total = 0
        for path in directory.rglob("*"):
            if path.is_symlink():
                if strict:
                    raise ValueError("Unsafe native event directory")
                continue
            if path.is_file():
                total += path.stat().st_size
        return total

    def budget(self) -> int:
        """Aggregate cap shared by the database and the native directory."""
        return max(8192, self.max_bytes - self.native_bytes(strict=True))

    def inspect(self) -> dict:
        # Purely diagnostic: it reports what is counted without enforcing, so a
        # rejected linked entry never turns a status read into an exception.
        native = self.native_bytes()
        with self._db() as db:
            return {
                "installationId": self.installation_id,
                "pending": db.execute("SELECT COUNT(*) FROM events").fetchone()[0],
                "dropped": dict(
                    db.execute("SELECT reason,count FROM dropped").fetchall()
                ),
                "lastError": self._get(db, "lastError"),
                "retryAt": self._get(db, "retryAt", 0),
                "nativeBytes": native,
                "budgetBytes": max(8192, self.max_bytes - native),
                "maxBytes": self.max_bytes,
            }

    def _retry(self, db, now, error, retry_after=0):
        attempt = min(self._get(db, "retryAttempt", 0) + 1, 10)
        self._set(db, "retryAttempt", attempt)
        delay = max(retry_after, random.uniform(1, min(300, 2**attempt)))
        self._set(db, "retryAt", now + delay)
        self._set(db, "retryClock", {"started": self.monotonic(), "delay": delay})
        self._set(db, "lastError", error)

    def _retry_due(self, db) -> bool:
        schedule = self._get(db, "retryClock")
        if not schedule:
            return True
        now = self.monotonic()
        if now < schedule["started"]:
            # A backward monotonic reading may indicate reboot. Re-arm the full
            # delay; wall-clock corrections never authorize an early request.
            self._set(db, "retryClock", {"started": now, "delay": schedule["delay"]})
            return False
        return now >= schedule["started"] + schedule["delay"]

    def upload_pending(self, client) -> dict:
        if client.installation_id != self.installation_id:
            raise ValueError("Event client installation mismatch")
        empty = {"acceptedEventIds": [], "duplicateEventIds": []}
        with self._db() as db:
            if not self._retry_due(db):
                return empty
        # Clock acquisition is itself a reporting request and obeys the same
        # durable monotonic schedule as event delivery.
        try:
            server_now = utc_seconds(client.server_time())
        except EventRequestError as error:
            with self._db() as db:
                now = (
                    utc_seconds(error.server_time)
                    if error.server_time
                    else self.clock() + self._get(db, "offset", 0)
                )
                self._retry(db, now, error.code, error.retry_after)
            return empty
        except (OSError, ValueError, KeyError, TypeError):
            with self._db() as db:
                self._retry(
                    db,
                    self.clock() + self._get(db, "offset", 0),
                    "REPORTING_UNAVAILABLE",
                )
            return empty
        local_now = self.clock()
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            offset = server_now - local_now
            self._set(db, "offset", offset)
            rows = db.execute(
                "SELECT rowid,* FROM events ORDER BY priority DESC,rowid"
            ).fetchall()
            selected = []
            keys = set()
            body_size = 14
            for row in rows:
                observation = db.execute(
                    "SELECT observed,age,server_occurrence FROM event_clock WHERE id=?",
                    (row["id"],),
                ).fetchone()
                monotonic_now = self.monotonic()
                known_age = observation["age"] + max(
                    0, monotonic_now - observation["observed"]
                )
                db.execute(
                    "UPDATE event_clock SET observed=?,age=? WHERE id=?",
                    (monotonic_now, known_age, row["id"]),
                )
                if known_age >= RETENTION_SECONDS:
                    self._drop(db, [row["id"]], "EVENT_TOO_OLD")
                    continue
                if row["state"] == "rejected":
                    if row["occurred"] + offset <= server_now - RETENTION_SECONDS:
                        self._drop(db, [row["id"]], "EVENT_TOO_OLD")
                    continue
                value = json.loads(row["payload"])
                if row["state"] == "queued":
                    candidate = min(
                        observation["server_occurrence"]
                        if observation["server_occurrence"] is not None
                        else row["occurred"] + offset,
                        server_now - known_age,
                    )
                    # Only move timestamps backward. Durable elapsed-age evidence
                    # prevents a future wall-clock timestamp rejuvenating old logs.
                    db.execute(
                        "UPDATE event_clock SET server_occurrence=? WHERE id=?",
                        (candidate, row["id"]),
                    )
                    value["occurredAt"] = utc_string(candidate)
                occurrence = utc_seconds(value["occurredAt"])
                if occurrence <= server_now - RETENTION_SECONDS:
                    self._drop(db, [row["id"]], "EVENT_TOO_OLD")
                    continue
                if self._get(db, "terminalOnly", False) and not row["priority"]:
                    continue
                key = row["progress"]
                if key:
                    receipt = db.execute(
                        "SELECT received FROM progress_receipts WHERE key=?", (key,)
                    ).fetchone()
                    if key in keys or (
                        receipt
                        and receipt[0] + 5 > server_now
                        and row["state"] == "queued"
                    ):
                        continue
                    keys.add(key)
                payload = encoded(value)
                if len(selected) >= 50 or body_size + len(payload.encode()) + 1 > 65536:
                    continue
                body_size += len(payload.encode()) + 1
                selected.append((row, value))
                # Persist exact request before sending; crashes and ambiguous
                # responses leave immutable retry bytes in the spool.
                db.execute(
                    "UPDATE events SET payload=?,bytes=?,state='uncertain' WHERE id=?",
                    (payload, len(payload.encode()), row["id"]),
                )
            db.execute(
                "DELETE FROM progress_receipts WHERE received<=?",
                (server_now - RETENTION_SECONDS,),
            )
        if not selected:
            with self._db() as db:
                self._set(db, "terminalOnly", False)
            return empty
        try:
            receipt = client.post_events([value for _, value in selected])
            accepted = receipt["acceptedEventIds"]
            duplicate = receipt["duplicateEventIds"]
            ids = [row["id"] for row, _ in selected]
            if (
                not isinstance(accepted, list)
                or not isinstance(duplicate, list)
                or len(accepted + duplicate) != len(ids)
                or set(accepted + duplicate) != set(ids)
            ):
                raise ValueError("Invalid event receipt")
            received = utc_seconds(receipt["serverTime"])
            with self._db() as db:
                for row, value in selected:
                    db.execute("DELETE FROM events WHERE id=?", (row["id"],))
                    if row["progress"] and row["id"] in accepted:
                        db.execute(
                            "INSERT OR REPLACE INTO progress_receipts VALUES (?,?)",
                            (row["progress"], received),
                        )
                self._set(db, "terminalOnly", False)
                db.execute(
                    "DELETE FROM progress_receipts WHERE received<?", (received - 5,)
                )
                self._set(db, "retryAt", 0)
                self._set(db, "retryClock", None)
                self._set(db, "retryAttempt", 0)
                self._set(db, "lastError", None)
            return receipt
        except EventRequestError as error:
            with self._db() as db:
                now = (
                    utc_seconds(error.server_time) if error.server_time else server_now
                )
                self._retry(db, now, error.code, error.retry_after)
                if error.atomic:
                    if (
                        error.code == "RATE_LIMITED"
                        and any(row["priority"] for row, _ in selected)
                        and any(not row["priority"] for row, _ in selected)
                    ):
                        self._set(db, "terminalOnly", True)
                    for row, value in selected:
                        if row["state"] == "queued":
                            # The previous payload was never uncertain and this
                            # batch was explicitly not persisted. Restore its
                            # local occurrence for a fresh server correction.
                            if error.code == "EVENT_CLOCK_AHEAD":
                                backward = max(
                                    0, utc_seconds(value["occurredAt"]) - now
                                )
                                db.execute(
                                    "UPDATE event_clock SET server_occurrence=server_occurrence-? WHERE id=?",
                                    (backward, row["id"]),
                                )
                            db.execute(
                                "UPDATE events SET state='queued' WHERE id=?",
                                (row["id"],),
                            )
                    if error.code == "EVENT_TOO_OLD":
                        self._drop(
                            db,
                            [
                                row["id"]
                                for row, value in selected
                                if utc_seconds(value["occurredAt"])
                                <= now - RETENTION_SECONDS
                            ],
                            "EVENT_TOO_OLD",
                        )
                    if error.code in (
                        "EVENT_ID_CONFLICT",
                        "INVALID_EVENT",
                        "EVENT_BODY_TOO_LARGE",
                    ):
                        # Quarantine the rejected batch for local inspection;
                        # bounded retention still applies, never silently discard.
                        for row, _ in selected:
                            db.execute(
                                "UPDATE events SET state='rejected' WHERE id=?",
                                (row["id"],),
                            )
            return empty
        except (OSError, ValueError, KeyError, TypeError):
            with self._db() as db:
                self._retry(db, server_now, "REPORTING_UNAVAILABLE")
            return empty
