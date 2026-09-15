"""Power-loss durable update records; native Windows requires a directory flush hook."""

import json
import os
import tempfile
from pathlib import Path


class DurableRecords:
    def __init__(
        self, root: Path, *, sync_directory=None, fault=lambda point: None, create=True
    ):
        if not root.is_absolute() or root != root.resolve():
            raise ValueError("Update state must be canonical")
        self.root = root
        self.sync_directory = sync_directory or self._sync_directory
        self.fault = fault
        if create:
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.sync_directory(root.parent)

    @staticmethod
    def _sync_directory(path):
        if os.name == "nt":
            raise RuntimeError("Native durable directory flush adapter required")
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def read(self, name):
        if Path(name).name != name or name in (".", ".."):
            raise ValueError("Invalid update record name")
        path = self.root / name
        if path.is_symlink():
            raise ValueError("Update record symlink")
        if not path.exists():
            return None
        if not path.is_file() or path.stat().st_size > 262144:
            raise ValueError("Invalid update record")
        value = json.loads(path.read_text())
        if not isinstance(value, dict) or value.get("schemaVersion") != 3:
            raise ValueError("Incompatible update state; no migration is supported")
        return value

    def write(self, name, value):
        if (
            Path(name).name != name
            or name in (".", "..")
            or value.get("schemaVersion") != 3
        ):
            raise ValueError("Invalid update record")
        path = self.root / name
        if path.is_symlink():
            raise ValueError("Update record symlink")
        self.fault(name + ":before_write")
        fd, temporary = tempfile.mkstemp(dir=self.root, prefix=".update-")
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(
                    value,
                    stream,
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=False,
                )
                stream.flush()
                os.fsync(stream.fileno())
            self.fault(name + ":before_replace")
            os.replace(temporary, path)
            self.fault(name + ":after_replace")
            self.sync_directory(self.root)
            self.fault(name + ":after_sync")
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


class ClaimHold:
    """Persistent operational fence, separate from administrator desired state."""

    def __init__(self, records):
        self.records = records

    @property
    def held(self):
        value = self.records.read("claim-hold.json")
        if value is None:
            return False
        if set(value) != {"schemaVersion", "held"} or type(value["held"]) is not bool:
            raise ValueError("Invalid claim hold")
        return value["held"]

    def set(self, held):
        if type(held) is not bool:
            raise ValueError("Invalid claim hold")
        self.records.write("claim-hold.json", {"schemaVersion": 3, "held": held})
