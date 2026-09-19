from __future__ import annotations

import io
import struct
import unittest
import uuid
from datetime import datetime, timezone

from musicmute_engine.ipc import (
    MAX_FRAME_BYTES,
    ProtocolFailure,
    encode_frame,
    read_frame,
    validate_message,
)


def request(**overrides):
    value = {
        "protocolVersion": 1,
        "type": "request",
        "command": "ping",
        "requestId": str(uuid.uuid4()),
        "incarnation": str(uuid.uuid4()),
        "sentAt": datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "payload": {},
    }
    value.update(overrides)
    return value


class IpcTests(unittest.TestCase):
    def test_frame_round_trip(self):
        message = request()
        self.assertEqual(read_frame(io.BytesIO(encode_frame(message))), message)

    def test_rejects_oversized_length_before_body(self):
        stream = io.BytesIO(struct.pack(">I", MAX_FRAME_BYTES + 1))
        with self.assertRaisesRegex(ProtocolFailure, "length is invalid"):
            read_frame(stream)

    def test_rejects_unknown_or_unbounded_payload(self):
        with self.assertRaisesRegex(ProtocolFailure, "unknown fields"):
            validate_message({**request(), "credential": "must-not-cross"})
        nested = 1
        for key in reversed("abcdefghi"):
            nested = {key: nested}
        with self.assertRaisesRegex(ProtocolFailure, "too deeply nested"):
            validate_message(request(payload=nested))

    def test_rejects_wrong_incarnation(self):
        message = request()
        with self.assertRaisesRegex(ProtocolFailure, "does not match"):
            validate_message(message, expected_incarnation=str(uuid.uuid4()))


if __name__ == "__main__":
    unittest.main()
