import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from musicmute_worker.bootstrap_events import import_bootstrap_events
from musicmute_worker.events import EventSpool, encoded, utc_string

NOW = 1_800_000_000.0


class BootstrapEventsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.native = self.root / "bootstrap"
        self.native.mkdir(mode=0o700)
        self.identity = str(uuid4())
        self.event = {
            "eventId": str(uuid4()),
            "operationId": str(uuid4()),
            "sequence": 1,
            "category": "installation",
            "stage": "download",
            "status": "failed",
            "code": "DOWNLOAD_FAILED",
            "occurredAt": utc_string(NOW),
        }
        self.spool = EventSpool(self.root, self.identity, clock=lambda: NOW + 86400)

    def write(self, delivery="uncertain", **changes):
        envelope = {
            "schemaVersion": 3,
            "installationId": self.identity,
            "event": self.event,
            "delivery": delivery,
            **changes,
        }
        path = self.native / (self.event["eventId"] + ".json")
        path.write_text(encoded(envelope))
        path.chmod(0o600)
        return path

    def test_uncertain_native_payload_is_not_clock_corrected_again(self):
        path = self.write()
        self.assertEqual(import_bootstrap_events(self.native, self.spool), 1)
        self.assertFalse(path.exists())
        sent = []
        identity = self.identity

        class Client:
            installation_id = identity

            def server_time(self):
                return utc_string(NOW)

            def post_events(self, values):
                sent.extend(values)
                return {
                    "acceptedEventIds": [],
                    "duplicateEventIds": [values[0]["eventId"]],
                    "serverTime": utc_string(NOW),
                }

        self.spool.upload_pending(Client())
        self.assertEqual(encoded(sent[0]), encoded(self.event))

    def test_crash_after_sql_commit_reimports_idempotently(self):
        path = self.write()
        with (
            patch.object(Path, "unlink", side_effect=OSError("interrupted")),
            self.assertRaises(OSError),
        ):
            import_bootstrap_events(self.native, self.spool)
        self.assertTrue(path.exists())
        self.assertEqual(self.spool.inspect()["pending"], 1)
        self.assertEqual(import_bootstrap_events(self.native, self.spool), 1)
        self.assertEqual(self.spool.inspect()["pending"], 1)

    def test_scope_mismatch_and_symbolic_links_are_preserved_and_rejected(self):
        path = self.write(installationId=str(uuid4()))
        with self.assertRaises(ValueError):
            import_bootstrap_events(self.native, self.spool)
        self.assertTrue(path.exists())
        path.unlink()
        outside = self.root / "outside.json"
        outside.write_text("{}")
        path.symlink_to(outside)
        with self.assertRaises(ValueError):
            import_bootstrap_events(self.native, self.spool)
        self.assertTrue(outside.exists())
        self.assertEqual(self.spool.inspect()["pending"], 0)

    def test_uncertain_redaction_changes_refused_instead_of_rewriting(self):
        self.event["details"] = {"diagnostic": "Bearer private"}
        path = self.write()
        with self.assertRaises(ValueError):
            import_bootstrap_events(self.native, self.spool)
        self.assertTrue(path.exists())
        self.assertEqual(self.spool.inspect()["pending"], 0)

    def test_capacity_defers_native_file_without_erasing_it(self):
        self.spool = EventSpool(self.root, self.identity, max_bytes=8192)
        for _ in range(40):
            self.spool.append({**self.event, "eventId": str(uuid4())})
        path = self.write()
        pending = self.spool.inspect()["pending"]
        self.assertGreater(pending, 0)
        self.assertEqual(import_bootstrap_events(self.native, self.spool), 0)
        self.assertTrue(path.exists())
        self.assertEqual(self.spool.inspect()["pending"], pending)

    def test_queued_native_event_is_redacted_before_persistence(self):
        self.event["details"] = {"diagnostic": "Bearer private"}
        self.write(delivery="queued")
        self.assertEqual(import_bootstrap_events(self.native, self.spool), 1)
        with self.spool._db() as db:
            payload = json.loads(db.execute("SELECT payload FROM events").fetchone()[0])
        self.assertEqual(payload["details"]["diagnostic"], "[redacted]")


if __name__ == "__main__":
    unittest.main()
