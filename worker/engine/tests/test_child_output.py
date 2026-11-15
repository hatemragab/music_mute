from __future__ import annotations

import json
import subprocess
import sys
import unittest


class ChildOutputIsolationTests(unittest.TestCase):
    def test_native_stdout_noise_cannot_corrupt_the_protocol_pipe(self) -> None:
        script = """
import os
from musicmute_engine.child import isolate_protocol_output
from musicmute_engine.ipc import encode_frame

output = isolate_protocol_output()
os.write(1, b"third-party-noise")
output.write(encode_frame({
    "protocolVersion": 1,
    "type": "result",
    "requestId": "8dbe6c44-45ee-4dd1-9a9f-f4cc87fd9cb0",
    "incarnation": "0c347b75-afb5-4d01-aeab-00af9c927ceb",
    "sentAt": "2026-09-19T12:00:00.000Z",
    "payload": {"status": "ok"},
}))
output.close()
"""
        completed = subprocess.run(
            [sys.executable, "-c", script],
            check=True,
            capture_output=True,
        )
        size = int.from_bytes(completed.stdout[:4], "big")
        self.assertEqual(len(completed.stdout), size + 4)
        message = json.loads(completed.stdout[4:].decode("utf-8"))
        self.assertEqual(message["payload"], {"status": "ok"})
        self.assertIn(b"third-party-noise", completed.stderr)


if __name__ == "__main__":
    unittest.main()
