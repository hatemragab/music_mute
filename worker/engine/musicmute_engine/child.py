"""Bounded protocol child for the versioned Kim processing pipeline."""

from __future__ import annotations

import argparse
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO

from .ipc import ProtocolFailure, UUID_V4, read_frame, write_frame
from .pipeline import ProcessRequest, ProcessingFailure, RuntimePipeline
from .provider_adapter import Provider
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


def run(
    incarnation: str,
    *,
    model_cache_root: Path | None = None,
    provider: Provider | None = None,
    directml_device_id: int = 0,
) -> int:
    pipeline = RuntimePipeline()
    protocol_input = sys.stdin.buffer
    protocol_output = isolate_protocol_output()
    try:
        if model_cache_root is not None and provider is not None:
            def startup_progress(stage: str) -> None:
                write_frame(
                    protocol_output,
                    response(
                        "startup-progress",
                        str(uuid.uuid4()),
                        incarnation,
                        {"stage": stage},
                    ),
                )

            pipeline.preload(
                model_cache_root,
                provider,
                directml_device_id,
                startup_progress,
            )
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

                    def progress(stage: str) -> None:
                        write_frame(
                            protocol_output,
                            response(
                                "progress",
                                request_id,
                                incarnation,
                                {"stage": stage},
                            ),
                        )

                    def window_progress(completed: int, total: int) -> None:
                        write_frame(
                            protocol_output,
                            response(
                                "progress",
                                request_id,
                                incarnation,
                                {
                                    "stage": "separation",
                                    "unit": "windows",
                                    "completed": completed,
                                    "total": total,
                                },
                            ),
                        )

                    result = pipeline.process(
                        process_request, progress, window_progress
                    )
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


def parse_args(arguments: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--incarnation", required=True)
    parser.add_argument("--model-cache-root", type=Path)
    parser.add_argument("--provider", choices=("mps", "directml"))
    parser.add_argument("--directml-device-id", type=int, default=0)
    parsed = parser.parse_args(arguments)
    if (parsed.model_cache_root is None) != (parsed.provider is None):
        parser.error("--model-cache-root and --provider must be used together")
    if parsed.model_cache_root is not None and not parsed.model_cache_root.is_absolute():
        parser.error("--model-cache-root must be absolute")
    if not 0 <= parsed.directml_device_id <= 15:
        parser.error("--directml-device-id must be between 0 and 15")
    return parsed


def main() -> int:
    arguments = parse_args()
    try:
        if not UUID_V4.fullmatch(arguments.incarnation):
            raise ValueError("invalid incarnation")
        return run(
            arguments.incarnation,
            model_cache_root=arguments.model_cache_root,
            provider=arguments.provider,
            directml_device_id=arguments.directml_device_id,
        )
    except (OSError, ProcessingFailure, ProtocolFailure, ValueError):
        print("MusicMute child protocol failure", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
