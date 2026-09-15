"""One sequential DirectML session in a contained child; supervisor is stdlib-only."""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path
from uuid import uuid4

from .processes import ContainedProcess, _job_name

_LIMIT = 16 * 1024
_SHARING_TIMEOUT = 2.0
_ERROR_CODES = {"MODEL_LOAD_FAILED", "INVALID_REQUEST", "SEPARATION_FAILED"}


class EngineError(RuntimeError):
    """Sanitized engine failure; never includes child stdout, paths or tracebacks."""


def _read_message(path: Path) -> dict | None:
    try:
        with path.open("rb") as stream:
            raw = stream.read(_LIMIT + 1)
    except FileNotFoundError:
        return None
    if len(raw) > _LIMIT:
        raise EngineError("ENGINE_PROTOCOL_ERROR")
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise EngineError("ENGINE_PROTOCOL_ERROR") from None
    if not isinstance(value, dict) or value.get("version") != 1:
        raise EngineError("ENGINE_PROTOCOL_ERROR")
    return value


def _timings(value: object, expected: set[str]) -> dict[str, float]:
    if not isinstance(value, dict) or set(value) != expected:
        raise EngineError("ENGINE_PROTOCOL_ERROR")
    result = {}
    for key, item in value.items():
        if type(item) not in (int, float):
            raise EngineError("ENGINE_PROTOCOL_ERROR")
        try:
            number = float(item)
        except OverflowError:
            raise EngineError("ENGINE_PROTOCOL_ERROR") from None
        if not math.isfinite(number) or number < 0:
            raise EngineError("ENGINE_PROTOCOL_ERROR")
        result[key] = number
    return result


class SeparatorEngine:
    """Lazy model startup. Every failed run stops the whole containment boundary."""

    def __init__(
        self,
        separator: Path,
        state_dir: Path,
        *,
        slot: str = "engine",
        model_dir: Path | None = None,
        runtime=None,
    ):
        if slot == "transient":
            raise ValueError("An engine requires a persistent containment slot")
        _job_name(slot)
        self.separator = separator.resolve()
        self.state_dir = state_dir.resolve()
        self.slot = slot
        if model_dir is not None and not model_dir.is_absolute():
            raise ValueError("Explicit absolute model cache path required")
        self.model_dir = model_dir
        self.runtime = runtime
        self._process: ContainedProcess | None = None
        self._directory: Path | None = None
        self._lock = threading.Lock()

    def run(
        self,
        input: Path,
        output_dir: Path,
        *,
        timeout: float,
        check: Callable[[], None],
    ) -> dict[str, float]:
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("A finite positive timeout is required")
        if not self._lock.acquire(blocking=False):
            raise EngineError("ENGINE_BUSY")
        started = time.monotonic()
        deadline = started + timeout
        try:
            check()
            timings = {"model_load": 0.0, "engine_startup": 0.0}
            if self._process is None:
                self.state_dir.mkdir(parents=True, exist_ok=True)
                self._directory = Path(
                    tempfile.mkdtemp(prefix=self.slot + "-", dir=self.state_dir)
                )
                session = uuid4().hex
                args = [
                    str(self.runtime.python) if self.runtime else sys.executable,
                    *(["-I", "-B"] if self.runtime else []),
                    str(self.separator),
                    "--serve",
                    str(self._directory),
                    "--session-id",
                    session,
                ]
                if self.model_dir is not None:
                    args.extend(["--model-dir", str(self.model_dir)])
                if self.runtime is not None:
                    args.extend(
                        [
                            "--runtime",
                            str(self.runtime.descriptor()),
                            "--ffmpeg",
                            str(self.runtime.ffmpeg),
                        ]
                    )
                self._process = ContainedProcess(
                    args, cwd=self.separator.parent, slot=self.slot
                )
                ready = self._wait("ready.json", deadline, timeout, check)
                if ready.get("session") != session:
                    raise EngineError("ENGINE_PROTOCOL_ERROR")
                self._require_status(ready, "ready")
                timings.update(_timings(ready.get("timings"), {"model_load"}))
                timings["engine_startup"] = time.monotonic() - started
            check()
            identifier = uuid4().hex
            request = {
                "version": 1,
                "id": identifier,
                "input": str(input.resolve()),
                "output_dir": str(output_dir.resolve()),
            }
            encoded = json.dumps(request).encode("utf-8")
            if len(encoded) > _LIMIT:
                raise EngineError("ENGINE_PROTOCOL_ERROR")
            temporary = self._directory / "request.tmp"
            temporary.write_bytes(encoded)
            temporary.replace(self._directory / "request.json")
            response = self._wait("response.json", deadline, timeout, check)
            if response.get("id") != identifier:
                raise EngineError("ENGINE_PROTOCOL_ERROR")
            self._require_status(response, "ok")
            timings.update(
                _timings(response.get("timings"), {"separation", "trim", "encode"})
            )
            (self._directory / "response.json").unlink()
            check()
            return timings
        except BaseException:
            self.close()
            raise
        finally:
            self._lock.release()

    @staticmethod
    def _require_status(message: dict, expected: str) -> None:
        if message.get("status") == expected:
            return
        code = message.get("error")
        raise EngineError(
            code
            if isinstance(code, str) and code in _ERROR_CODES
            else "ENGINE_PROTOCOL_ERROR"
        )

    def _wait(
        self, name: str, deadline: float, timeout: float, check: Callable[[], None]
    ) -> dict:
        sharing_deadline = None
        while True:
            check()
            now = time.monotonic()
            if now >= deadline:
                raise subprocess.TimeoutExpired("separator engine", timeout)
            try:
                value = _read_message(self._directory / name)
            except PermissionError:
                if os.name != "nt":
                    raise
                # Windows can briefly deny opening a just-renamed file. Keep
                # lease checks responsive and bound even a permanent denial.
                if sharing_deadline is None:
                    sharing_deadline = now + _SHARING_TIMEOUT
                if now >= sharing_deadline:
                    raise EngineError("ENGINE_IPC_UNAVAILABLE") from None
                value = None
            else:
                sharing_deadline = None
            if value is not None:
                return value
            if self._process.poll() is not None:
                raise EngineError("ENGINE_EXITED")
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))

    def close(self) -> None:
        # Keep the handle on failure: callers must not attest stopped prematurely.
        if self._process is not None:
            self._process.close()
            self._process = None
        if self._directory is not None:
            shutil.rmtree(self._directory)
            self._directory = None
