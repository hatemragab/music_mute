"""Bounded protocol child for the versioned Kim processing pipeline."""

from __future__ import annotations

import argparse
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Any, BinaryIO

from .ipc import ProtocolFailure, UUID_V4, read_frame, write_frame
from .pipeline import ProcessRequest, ProcessingFailure, RuntimePipeline
from .recipes import RECIPE_DEFINITIONS


def now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
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


def isolate_protocol_output() -> BinaryIO:
    """Reserve the original stdout pipe and divert library/native noise to stderr."""
    protocol_output = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    return protocol_output


def run(incarnation: str) -> int:
    pipeline = RuntimePipeline()
    protocol_input = sys.stdin.buffer
    protocol_output = isolate_protocol_output()
    try:
        write_frame(
            protocol_output,
            response(
                "ready",
                str(uuid.uuid4()),
                incarnation,
                {
                    "processCapacity": 1,
                    "recipeIds": sorted(RECIPE_DEFINITIONS),
                },
            ),
        )
        while True:
            message = read_frame(protocol_input, expected_incarnation=incarnation)
            if message is None:
                return 0
            request_id = message["requestId"]
            command = message["command"]
            if command == "ping":
                write_frame(
                    protocol_output,
                    response("result", request_id, incarnation, {"status": "ok"}),
                )
            elif command == "process":
                write_frame(
                    protocol_output,
                    response("accepted", request_id, incarnation, {"accepted": True}),
                )
                try:
                    process_request = ProcessRequest.from_payload(message["payload"])

                    def progress(stage: str, fraction: float) -> None:
                        write_frame(
                            protocol_output,
                            response(
                                "progress",
                                request_id,
                                incarnation,
                                {"stage": stage, "fraction": fraction},
                            ),
                        )

                    result = pipeline.process(process_request, progress)
                    write_frame(
                        protocol_output,
                        response("result", request_id, incarnation, result),
                    )
                except ProcessingFailure as error:
                    write_frame(
                        protocol_output,
                        response(
                            "error",
                            request_id,
                            incarnation,
                            {"code": error.code, "summary": error.summary},
                        ),
                    )
            elif command == "cancel":
                write_frame(
                    protocol_output,
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
                    protocol_output,
                    response("result", request_id, incarnation, {"stopped": True}),
                )
                return 0
    finally:
        protocol_output.close()


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
