"""Current native bootstrap event handoff, independent of numerical libraries."""

import json
import os
from pathlib import Path

from .events import EventSpool
from .runtime_types import uuid4_string
from .update.download import private_directory


def import_bootstrap_events(directory: Path, spool: EventSpool) -> int:
    """Caller holds the machine lock; delete only after the SQLite commit succeeds.

    Native writers stop before transferring ownership to this importer. A process
    interruption leaves an idempotent event file or its committed SQLite record.
    Historical monotonic age is unavailable across the native/Python boundary;
    authoritative occurrence-time retention still applies when uploading.
    """
    private_directory(directory)
    files = sorted(directory.iterdir())
    if len(files) > 256:
        raise ValueError("Native event file limit exceeded")
    imported = 0
    for path in files:
        if path.name.startswith("."):
            continue  # Native atomic-write scratch is not a committed event.
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 8192:
            raise ValueError("Invalid native event file")
        value = json.loads(path.read_text(encoding="utf-8"))
        if (
            not isinstance(value, dict)
            or set(value) != {"schemaVersion", "installationId", "event", "delivery"}
            or type(value["schemaVersion"]) is not int
            or value["schemaVersion"] != 3
            or value["installationId"] != spool.installation_id
            or value["delivery"] not in ("queued", "uncertain")
            or not isinstance(value["event"], dict)
        ):
            raise ValueError("Invalid native event envelope")
        event_id = uuid4_string(value["event"].get("eventId"))
        if path.name != event_id + ".json":
            raise ValueError("Native event filename mismatch")
        if not spool.import_bootstrap(
            value["event"], uncertain=value["delivery"] == "uncertain"
        ):
            break  # Capacity or disk pressure must not silently erase native history.
        path.unlink()
        if os.name == "posix":
            descriptor = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        imported += 1
    return imported
