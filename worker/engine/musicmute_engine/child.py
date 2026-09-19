"""D1 protocol child; audio processing is introduced by checkpoint D2."""

from __future__ import annotations

import argparse
import sys
import uuid
from datetime import datetime, timezone
from typing import Any

from .ipc import ProtocolFailure, UUID_V4, read_frame, write_frame


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def response(
    response_type: str,
    request_id: str,
    incarnation: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "protocolVersion": 1,
        "type": response_type,
        "requestId": request_id,
        "incarnation": incarnation,
        "sentAt": now(),
        "payload": payload,
    }


def run(incarnation: str) -> int:
    write_frame(
        sys.stdout.buffer,
        response("ready", str(uuid.uuid4()), incarnation, {"processCapacity": 1}),
    )
    while True:
        message = read_frame(sys.stdin.buffer, expected_incarnation=incarnation)
        if message is None:
            return 0
        request_id = message["requestId"]
        command = message["command"]
        if command == "ping":
            write_frame(
                sys.stdout.buffer,
                response("result", request_id, incarnation, {"status": "ok"}),
            )
        elif command == "process":
            write_frame(
                sys.stdout.buffer,
                response(
                    "error",
                    request_id,
                    incarnation,
                    {"code": "PROCESSING_NOT_IMPLEMENTED"},
                ),
            )
        elif command == "cancel":
            write_frame(
                sys.stdout.buffer,
                response(
                    "cancelled",
                    request_id,
                    incarnation,
                    {
                        "targetRequestId": message["payload"]["targetRequestId"],
                        "cancelled": False,
                    },
                ),
            )
        elif command == "shutdown":
            write_frame(
                sys.stdout.buffer,
                response("result", request_id, incarnation, {"stopped": True}),
            )
            return 0


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--incarnation", required=True)
    arguments = parser.parse_args()
    try:
        if not UUID_V4.fullmatch(arguments.incarnation):
            raise ValueError("invalid incarnation")
        return run(arguments.incarnation)
    except (ValueError, ProtocolFailure):
        print("MusicMute child protocol failure", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
