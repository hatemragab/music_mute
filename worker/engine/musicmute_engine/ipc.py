"""Bounded length-prefixed IPC shared by the Python processing child."""

from __future__ import annotations

import json
import re
import struct
from dataclasses import dataclass
from datetime import datetime
from typing import Any, BinaryIO

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 64 * 1024
MAX_DEPTH = 8
MAX_ITEMS = 100
MAX_STRING_LENGTH = 4096
REQUEST_COMMANDS = {"ping", "process", "cancel", "shutdown"}
RESPONSE_TYPES = {"startup-progress", "ready", "accepted", "progress", "result", "cancelled", "error"}
UUID_V4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
REQUEST_KEYS = {
    "protocolVersion",
    "type",
    "command",
    "requestId",
    "incarnation",
    "sentAt",
    "payload",
}
RESPONSE_KEYS = REQUEST_KEYS - {"command"}


@dataclass(frozen=True)
class ProtocolFailure(Exception):
    code: str
    message: str

    def __str__(self) -> str:
        return self.message


def _record(value: Any) -> bool:
    return isinstance(value, dict) and all(isinstance(key, str) for key in value)


def _bounded(value: Any, depth: int = 0) -> None:
    if depth > MAX_DEPTH:
        raise ProtocolFailure("MESSAGE_INVALID", "Child payload is too deeply nested")
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and (
            value != value or value in (float("inf"), -float("inf"))
        ):
            raise ProtocolFailure("MESSAGE_INVALID", "Child payload number is invalid")
        return
    if isinstance(value, str):
        if len(value) > MAX_STRING_LENGTH:
            raise ProtocolFailure("MESSAGE_INVALID", "Child payload string is too long")
        return
    if isinstance(value, list):
        if len(value) > MAX_ITEMS:
            raise ProtocolFailure("MESSAGE_INVALID", "Child payload array is too large")
        for item in value:
            _bounded(item, depth + 1)
        return
    if _record(value):
        if len(value) > MAX_ITEMS:
            raise ProtocolFailure(
                "MESSAGE_INVALID", "Child payload object is too large"
            )
        for item in value.values():
            _bounded(item, depth + 1)
        return
    raise ProtocolFailure("MESSAGE_INVALID", "Child payload value is unsupported")


def _timestamp(value: Any) -> bool:
    if not isinstance(value, str) or len(value) > 40 or not value.endswith("Z"):
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return True


def validate_message(
    value: Any, *, expected_incarnation: str | None = None
) -> dict[str, Any]:
    if not _record(value):
        raise ProtocolFailure("MESSAGE_INVALID", "Child message must be an object")
    request = value.get("type") == "request"
    allowed = REQUEST_KEYS if request else RESPONSE_KEYS
    if set(value) - allowed:
        raise ProtocolFailure("MESSAGE_INVALID", "Child message has unknown fields")
    if value.get("protocolVersion") != PROTOCOL_VERSION:
        raise ProtocolFailure(
            "VERSION_UNSUPPORTED", "Unsupported child protocol version"
        )
    request_id = value.get("requestId")
    incarnation = value.get("incarnation")
    if not isinstance(request_id, str) or not UUID_V4.fullmatch(request_id):
        raise ProtocolFailure("MESSAGE_INVALID", "Child request ID must be UUID v4")
    if not isinstance(incarnation, str) or not UUID_V4.fullmatch(incarnation):
        raise ProtocolFailure("MESSAGE_INVALID", "Child incarnation must be UUID v4")
    if expected_incarnation is not None and incarnation != expected_incarnation:
        raise ProtocolFailure("MESSAGE_INVALID", "Child incarnation does not match")
    if not _timestamp(value.get("sentAt")):
        raise ProtocolFailure("MESSAGE_INVALID", "Child timestamp is invalid")
    payload = value.get("payload")
    if not _record(payload):
        raise ProtocolFailure("MESSAGE_INVALID", "Child payload must be an object")
    _bounded(payload)
    if request:
        command = value.get("command")
        if command not in REQUEST_COMMANDS:
            raise ProtocolFailure("MESSAGE_INVALID", "Child command is invalid")
        if command == "cancel":
            target = payload.get("targetRequestId")
            if not isinstance(target, str) or not UUID_V4.fullmatch(target):
                raise ProtocolFailure(
                    "MESSAGE_INVALID", "Cancellation target is invalid"
                )
    elif value.get("type") not in RESPONSE_TYPES:
        raise ProtocolFailure("MESSAGE_INVALID", "Child response type is invalid")
    return value


def encode_frame(message: dict[str, Any]) -> bytes:
    validated = validate_message(message)
    body = json.dumps(validated, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )
    if not body or len(body) > MAX_FRAME_BYTES:
        raise ProtocolFailure("FRAME_TOO_LARGE", "Child frame exceeds byte limit")
    return struct.pack(">I", len(body)) + body


def _read_exact(stream: BinaryIO, size: int) -> bytes | None:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            if remaining == size:
                return None
            raise ProtocolFailure("FRAME_INVALID", "Child stream ended mid-frame")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(
    stream: BinaryIO, *, expected_incarnation: str | None = None
) -> dict[str, Any] | None:
    header = _read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack(">I", header)[0]
    if size == 0 or size > MAX_FRAME_BYTES:
        raise ProtocolFailure("FRAME_TOO_LARGE", "Child frame length is invalid")
    body = _read_exact(stream, size)
    if body is None:
        raise ProtocolFailure("FRAME_INVALID", "Child stream ended mid-frame")
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolFailure("FRAME_INVALID", "Child frame is invalid JSON") from error
    return validate_message(value, expected_incarnation=expected_incarnation)


def write_frame(stream: BinaryIO, message: dict[str, Any]) -> None:
    stream.write(encode_frame(message))
    stream.flush()
