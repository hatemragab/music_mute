import unittest

from musicmute_engine.sentry_monitoring import sanitize_event


class SentryMonitoringTests(unittest.TestCase):
    def test_exception_without_traceback_omits_empty_stacktrace(self) -> None:
        sanitized = sanitize_event(
            {"exception": {"values": [{"type": "RuntimeError", "value": "private"}]}},
            None,
        )
        self.assertEqual(
            sanitized["exception"]["values"],
            [{"type": "RuntimeError", "value": "Unexpected engine failure"}],
        )

    def test_event_excludes_private_data_and_keeps_engine_frames(self) -> None:
        event = {
            "event_id": "abc",
            "request": {"url": "https://private.example/media?token=secret"},
            "user": {"email": "private@example.com"},
            "breadcrumbs": [{"message": "secret"}],
            "exception": {
                "values": [
                    {
                        "type": "ValueError",
                        "value": "private filename and token",
                        "stacktrace": {
                            "frames": [
                                {
                                    "filename": "/Users/person/app/musicmute_engine/child.py",
                                    "function": "run",
                                    "lineno": 41,
                                    "vars": {"token": "secret"},
                                },
                                {"filename": "/musicmute_engine/../secret.py"},
                            ]
                        },
                    },
                ]
            },
        }

        sanitized = sanitize_event(event, None)

        self.assertEqual(sanitized["event_id"], "abc")
        self.assertEqual(
            sanitized["exception"]["values"][0]["stacktrace"]["frames"],
            [
                {"filename": "musicmute_engine/child.py", "function": "run", "lineno": 41},
                {"filename": "[external]"},
            ],
        )
        serialized = str(sanitized)
        self.assertNotIn("private", serialized)
        self.assertNotIn("secret", serialized)
        self.assertNotIn("/Users/", serialized)
