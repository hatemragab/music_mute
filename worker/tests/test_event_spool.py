import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from musicmute_worker.events import EventRequestError, EventSpool


def make_spool(*args, **kwargs):
    # Existing fixtures advance their synthetic wall and elapsed clocks together;
    # jump regressions supply independent monotonic readings explicitly.
    kwargs.setdefault("monotonic", lambda: instance.clock())
    instance = EventSpool(*args, **kwargs)
    return instance


NOW = 1_800_000_000.0


def stamp(t):
    return (
        datetime.fromtimestamp(t, timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def event(now=NOW, status="failed", **kw):
    return dict(
        eventId=str(uuid4()),
        operationId=str(uuid4()),
        sequence=1,
        category="startup",
        stage="service",
        status=status,
        occurredAt=stamp(now),
        details={"diagnostic": "secret local path"},
        **kw,
    )


class Client:
    def __init__(self, identity):
        self.installation_id = identity
        self.sent = []
        self.error = None
        self.now = NOW

    def server_time(self):
        return stamp(self.now)

    def post_events(self, events):
        self.sent.append(json.loads(json.dumps(events)))
        if self.error:
            raise self.error
        return {
            "acceptedEventIds": [e["eventId"] for e in events],
            "duplicateEventIds": [],
            "serverTime": stamp(NOW),
        }


class SpoolTests(unittest.TestCase):
    def test_persistence_redaction_and_fast_slow_clock(self):
        for skew in (-86400, 86400):
            with self.subTest(skew=skew), tempfile.TemporaryDirectory() as root:
                identity = str(uuid4())
                path = Path(root).resolve()
                spool = make_spool(path, identity, clock=lambda skew=skew: NOW + skew)
                spool.append(event(NOW + skew))
                spool = make_spool(path, identity, clock=lambda skew=skew: NOW + skew)
                client = Client(identity)
                spool.upload_pending(client)
                self.assertEqual(client.sent[0][0]["occurredAt"], stamp(NOW))
                self.assertEqual(
                    client.sent[0][0]["details"]["diagnostic"], "[redacted]"
                )
                self.assertEqual(spool.inspect()["pending"], 0)

    def test_uncertain_restart_payload_immutable(self):
        with tempfile.TemporaryDirectory() as root:
            identity = str(uuid4())
            path = Path(root).resolve()
            client = Client(identity)
            spool = make_spool(path, identity, clock=lambda: NOW)
            spool.append(event())
            client.error = OSError("secret")
            spool.upload_pending(client)
            spool = make_spool(path, identity, clock=lambda: NOW + 100)
            client.error = None
            client.now = NOW + 100
            spool.upload_pending(client)
            self.assertEqual(client.sent[0], client.sent[1])

    def test_scope_change_refused(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root).resolve()
            make_spool(path, str(uuid4()))
            with self.assertRaises(ValueError):
                make_spool(path, str(uuid4()))

    def test_exact_thirty_day_boundary_counted(self):
        with tempfile.TemporaryDirectory() as root:
            identity = str(uuid4())
            spool = make_spool(Path(root).resolve(), identity, clock=lambda: NOW)
            spool.append(event(NOW - 30 * 86400))
            spool.append(event(NOW - 30 * 86400 + 0.001))
            client = Client(identity)
            spool.upload_pending(client)
            self.assertEqual(len(client.sent[0]), 1)
            self.assertEqual(spool.inspect()["dropped"]["EVENT_TOO_OLD"], 1)


class SpoolFaultTests(unittest.TestCase):
    def test_progress_coalesces_and_obeys_server_receipt_spacing(self):
        with tempfile.TemporaryDirectory() as root:
            identity = str(uuid4())
            clock = [NOW]
            client = Client(identity)
            spool = make_spool(Path(root).resolve(), identity, clock=lambda: clock[0])
            original = event(status="progress")
            for sequence in range(1, 10):
                spool.append(dict(original, eventId=str(uuid4()), sequence=sequence))
            spool.upload_pending(client)
            self.assertEqual(len(client.sent[0]), 1)
            spool.upload_pending(client)
            self.assertEqual(len(client.sent), 1)
            client.now = clock[0] = NOW + 5
            spool.upload_pending(client)
            self.assertEqual(len(client.sent), 2)
            self.assertEqual([b[0]["sequence"] for b in client.sent], [1, 9])
            self.assertEqual(spool.inspect()["dropped"]["PROGRESS_COALESCED"], 7)

    def test_atomic_mixed_rate_limit_preserves_terminal_and_retry_after_restart(self):
        with tempfile.TemporaryDirectory() as root:
            identity = str(uuid4())
            path = Path(root).resolve()
            client = Client(identity)
            spool = make_spool(path, identity, clock=lambda: NOW)
            spool.append(event(status="progress"))
            terminal = event()
            spool.append(terminal)
            client.error = EventRequestError(
                "RATE_LIMITED", 429, server_time=stamp(NOW), retry_after=20
            )
            spool.upload_pending(client)
            self.assertEqual(spool.inspect()["pending"], 2)
            client.error = None
            client.now = NOW + 19
            spool = make_spool(path, identity, clock=lambda: NOW + 19)
            spool.upload_pending(client)
            self.assertEqual(len(client.sent), 1)
            client.now = NOW + 20
            spool.clock = lambda: NOW + 20
            spool.upload_pending(client)
            self.assertEqual(
                [e["eventId"] for e in client.sent[1]], [terminal["eventId"]]
            )
            spool.upload_pending(client)
            self.assertEqual(spool.inspect()["pending"], 0)

    def test_future_rejection_can_correct_only_proven_unpersisted_event(self):
        with tempfile.TemporaryDirectory() as root:
            identity = str(uuid4())
            client = Client(identity)
            path = Path(root).resolve()
            spool = make_spool(path, identity, clock=lambda: NOW)
            spool.append(event())
            client.error = EventRequestError(
                "EVENT_CLOCK_AHEAD", 400, server_time=stamp(NOW - 10)
            )
            spool.upload_pending(client)
            client.error = None
            client.now = NOW + 10
            spool.clock = lambda: NOW + 20
            spool.upload_pending(client)
            self.assertEqual(client.sent[1][0]["occurredAt"], stamp(NOW - 10))

    def test_uncertain_then_clock_rejection_never_rewrites(self):
        with tempfile.TemporaryDirectory() as root:
            identity = str(uuid4())
            client = Client(identity)
            path = Path(root).resolve()
            spool = make_spool(path, identity, clock=lambda: NOW)
            spool.append(event())
            client.error = OSError()
            spool.upload_pending(client)
            client.now = NOW + 10
            spool.clock = lambda: NOW + 20
            client.error = EventRequestError(
                "EVENT_CLOCK_AHEAD", 400, server_time=stamp(NOW + 10)
            )
            spool.upload_pending(client)
            client.now = NOW + 30
            spool.clock = lambda: NOW + 30
            client.error = None
            spool.upload_pending(client)
            self.assertEqual(client.sent[0], client.sent[1])
            self.assertEqual(client.sent[0], client.sent[2])

    def test_capacity_prefers_terminal_and_does_not_touch_journal(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root).resolve()
            journal = path / "assignment.json"
            journal.write_text("owned")
            spool = make_spool(
                path / "events", str(uuid4()), clock=lambda: NOW, max_bytes=8192
            )
            for _ in range(60):
                spool.append(event(status="started"))
            terminal = event()
            spool.append(terminal)
            self.assertTrue(spool.inspect()["dropped"]["SPOOL_CAPACITY"] > 0)
            self.assertEqual(journal.read_text(), "owned")
            client = Client(spool.installation_id)
            spool.upload_pending(client)
            self.assertIn(terminal["eventId"], [e["eventId"] for e in client.sent[0]])

    def test_shared_backend_allowlist_matches(self):
        import re

        from musicmute_worker import events

        backend = (
            Path(__file__).resolve().parents[2]
            / "backend/src/worker-events/worker-event-policy.ts"
        )
        source = backend.read_text()
        for name in (
            "EVENT_CATEGORIES",
            "EVENT_STATUSES",
            "EVENT_STAGES",
            "EVENT_CODES",
            "COMPONENTS",
        ):
            values = re.findall(
                "'([^']+)'",
                re.search(r"const " + name + r" = \[(.*?)\]", source, re.DOTALL).group(
                    1
                ),
            )
            self.assertEqual(getattr(events, name), frozenset(values))


class SpoolStorageTests(unittest.TestCase):
    def test_disk_full_rolls_back_without_erasing_assignment_journal(self):
        import sqlite3

        with tempfile.TemporaryDirectory() as root:
            root = Path(root).resolve()
            journal = root / "journal"
            journal.write_bytes(b"owned assignment")
            spool = make_spool(root / "events", str(uuid4()), clock=lambda: NOW)
            spool.append(event())
            original = spool._db
            with original() as db:
                ceiling = db.execute("PRAGMA page_count").fetchone()[0]
            from contextlib import contextmanager

            @contextmanager
            def full():
                with original() as db:
                    db.execute(f"PRAGMA max_page_count={ceiling}")
                    yield db

            spool._db = full
            with self.assertRaises(sqlite3.OperationalError) as failure:
                for _ in range(100):
                    spool.append(event())
            self.assertEqual(failure.exception.sqlite_errorcode, sqlite3.SQLITE_FULL)
            spool._db = original
            self.assertGreaterEqual(spool.inspect()["pending"], 1)
            self.assertEqual(journal.read_bytes(), b"owned assignment")

    def test_invalid_receipt_keeps_payload_uncertain(self):
        with tempfile.TemporaryDirectory() as root:
            identity = str(uuid4())
            spool = make_spool(Path(root).resolve(), identity, clock=lambda: NOW)
            spool.append(event())
            client = Client(identity)
            client.post_events = lambda events: {
                "acceptedEventIds": [],
                "duplicateEventIds": [],
                "serverTime": stamp(NOW),
            }
            spool.upload_pending(client)
            self.assertEqual(spool.inspect()["pending"], 1)
            self.assertEqual(spool.inspect()["lastError"], "REPORTING_UNAVAILABLE")


class ClockCorrectionRegressionTests(unittest.TestCase):
    def test_os_clock_sync_before_first_send_and_atomic_future_rejection(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root).resolve()
            identity = str(uuid4())
            spool = make_spool(path, identity, clock=lambda: NOW + 86400)
            spool.append(event(NOW + 86400))
            spool = make_spool(path, identity, clock=lambda: NOW)
            client = Client(identity)
            client.error = EventRequestError(
                "EVENT_CLOCK_AHEAD", 400, server_time=stamp(NOW - 1)
            )
            spool.upload_pending(client)
            self.assertEqual(client.sent[0][0]["occurredAt"], stamp(NOW))
            client.error = None
            client.now = NOW + 20
            spool.clock = lambda: NOW + 20
            spool.upload_pending(client)
            self.assertEqual(client.sent[1][0]["occurredAt"], stamp(NOW - 1))

    def test_clock_endpoint_failure_backoff_before_any_request(self):
        for error in (
            EventRequestError(
                "RATE_LIMITED", 429, server_time=stamp(NOW), retry_after=60
            ),
            OSError("offline"),
        ):
            with (
                self.subTest(error=type(error).__name__),
                tempfile.TemporaryDirectory() as root,
            ):
                identity = str(uuid4())
                spool = make_spool(Path(root).resolve(), identity, clock=lambda: NOW)
                client = Client(identity)
                calls = []

                def unavailable(calls=calls, error=error):
                    calls.append(1)
                    raise error

                client.server_time = unavailable
                for _ in range(3):
                    spool.upload_pending(client)
                self.assertEqual(len(calls), 1)
                expected = (
                    "RATE_LIMITED"
                    if isinstance(error, EventRequestError)
                    else "REPORTING_UNAVAILABLE"
                )
                self.assertEqual(spool.inspect()["lastError"], expected)
                self.assertGreater(spool.inspect()["retryAt"], NOW)


class PersistedClockEvidenceTests(unittest.TestCase):
    def test_retry_after_survives_restart_and_wall_clock_jumps(self):
        with tempfile.TemporaryDirectory() as root:
            identity = str(uuid4())
            path = Path(root).resolve()
            wall, elapsed = [NOW], [1000.0]
            client = Client(identity)
            calls = []

            def rate_limited():
                calls.append(1)
                raise EventRequestError(
                    "RATE_LIMITED", 429, server_time=stamp(NOW), retry_after=60
                )

            client.server_time = rate_limited
            spool = make_spool(
                path, identity, clock=lambda: wall[0], monotonic=lambda: elapsed[0]
            )
            spool.upload_pending(client)
            wall[0] += 86400
            elapsed[0] = 1010
            spool = make_spool(
                path, identity, clock=lambda: wall[0], monotonic=lambda: elapsed[0]
            )
            spool.upload_pending(client)
            wall[0] -= 2 * 86400
            elapsed[0] = 1059
            spool.upload_pending(client)
            self.assertEqual(len(calls), 1)
            elapsed[0] = 1060
            spool.upload_pending(client)
            self.assertEqual(len(calls), 2)
            # A detectable monotonic reset re-arms the full persisted delay.
            elapsed[0] = 5
            spool = make_spool(
                path, identity, clock=lambda: wall[0], monotonic=lambda: elapsed[0]
            )
            spool.upload_pending(client)
            elapsed[0] = 64
            spool.upload_pending(client)
            self.assertEqual(len(calls), 2)
            elapsed[0] = 65
            spool.upload_pending(client)
            self.assertEqual(len(calls), 3)

    def test_network_clock_failure_uses_persisted_jitter_deadline(self):
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as root:
            identity = str(uuid4())
            path = Path(root).resolve()
            elapsed = [100.0]
            client = Client(identity)
            calls = []

            def unavailable():
                calls.append(1)
                raise OSError("offline")

            client.server_time = unavailable
            spool = make_spool(
                path, identity, clock=lambda: NOW, monotonic=lambda: elapsed[0]
            )
            with patch("musicmute_worker.events.random.uniform", return_value=2):
                spool.upload_pending(client)
            elapsed[0] = 101.999
            spool = make_spool(
                path, identity, clock=lambda: NOW + 86400, monotonic=lambda: elapsed[0]
            )
            spool.upload_pending(client)
            self.assertEqual(len(calls), 1)
            elapsed[0] = 102
            spool.upload_pending(client)
            self.assertEqual(len(calls), 2)

    def test_future_wall_timestamp_never_rejuvenates_known_thirty_day_age(self):
        for age in (30 * 86400, 31 * 86400):
            with self.subTest(age=age), tempfile.TemporaryDirectory() as root:
                identity = str(uuid4())
                path = Path(root).resolve()
                spool = make_spool(
                    path,
                    identity,
                    clock=lambda: NOW + 90 * 86400,
                    monotonic=lambda: 100,
                )
                spool.append(event(NOW + 90 * 86400))
                spool = make_spool(
                    path,
                    identity,
                    clock=lambda age=age: NOW + age,
                    monotonic=lambda age=age: 100 + age,
                )
                client = Client(identity)
                client.now = NOW + age
                spool.upload_pending(client)
                self.assertEqual(client.sent, [])
                self.assertEqual(spool.inspect()["dropped"]["EVENT_TOO_OLD"], 1)

    def test_uncertain_event_backoff_blocks_clock_fetch_even_after_wall_jump(self):
        with tempfile.TemporaryDirectory() as root:
            identity = str(uuid4())
            path = Path(root).resolve()
            elapsed = [100.0]
            spool = make_spool(
                path, identity, clock=lambda: NOW, monotonic=lambda: elapsed[0]
            )
            spool.append(event())
            client = Client(identity)
            client.error = OSError("lost response")
            spool.upload_pending(client)
            requests = []
            client.server_time = lambda: requests.append(1) or stamp(NOW)
            spool = make_spool(
                path, identity, clock=lambda: NOW + 86400, monotonic=lambda: elapsed[0]
            )
            spool.upload_pending(client)
            self.assertEqual(requests, [])
            self.assertEqual(spool.inspect()["pending"], 1)


class AggregateCapacityTests(unittest.TestCase):
    """The database and the pre-Python directory share one local cap."""

    def spool(self, root, **kw):
        return make_spool(Path(root).resolve(), str(uuid4()), clock=lambda: NOW, **kw)

    @staticmethod
    def big(status="failed", size=4096):
        value = event(status=status)
        value["details"] = {"diagnostic": "y" * size}
        return value

    def native(self, root, count=1, size=4096):
        directory = Path(root).resolve() / "bootstrap"
        directory.mkdir(parents=True, exist_ok=True)
        for index in range(count):
            (directory / f"e{index}.json").write_bytes(b"x" * size)
        return directory

    def test_native_bytes_reduce_the_available_budget(self):
        with tempfile.TemporaryDirectory() as root:
            spool = self.spool(root)
            self.assertEqual(spool.native_bytes(), 0)
            self.assertEqual(spool.budget(), spool.max_bytes)
            self.native(root, count=3, size=1024)
            self.assertEqual(spool.native_bytes(), 3072)
            self.assertEqual(spool.budget(), spool.max_bytes - 3072)
            reported = spool.inspect()
            self.assertEqual(reported["nativeBytes"], 3072)
            self.assertEqual(reported["budgetBytes"], spool.max_bytes - 3072)
            self.assertEqual(reported["maxBytes"], spool.max_bytes)

    def test_database_budget_never_goes_below_the_floor(self):
        with tempfile.TemporaryDirectory() as root:
            spool = self.spool(root)
            self.native(root, count=1, size=spool.max_bytes)
            self.assertEqual(spool.budget(), 8192)

    def admitted(self, root, native_size):
        """Append identical terminal events and count how many the cap admits."""
        spool = self.spool(root, max_bytes=16384, terminal_reserve=2048)
        if native_size:
            self.native(root, count=1, size=native_size)
        admitted = 0
        for _ in range(40):
            before = spool.inspect()["pending"]
            spool.append(self.big("failed", size=900))
            if spool.inspect()["pending"] > before:
                admitted += 1
        return admitted

    def test_native_bytes_reduce_what_the_database_may_retain(self):
        with (
            tempfile.TemporaryDirectory() as plain,
            tempfile.TemporaryDirectory() as shared,
        ):
            # Half the cap is spent on bootstrap evidence, so the same appends
            # must admit strictly fewer events than they do when it is absent.
            unshared = self.admitted(plain, 0)
            aggregate = self.admitted(shared, 8192)
            self.assertGreater(unshared, aggregate)
            self.assertGreater(aggregate, 0)

    def test_the_shared_cap_never_goes_below_its_floor(self):
        with tempfile.TemporaryDirectory() as root:
            spool = self.spool(root, max_bytes=16384, terminal_reserve=2048)
            self.native(root, count=1, size=16384)
            # Bootstrap evidence larger than the whole cap cannot drive the
            # database budget to zero; the floor keeps the spool usable.
            self.assertEqual(spool.budget(), 8192)
            spool.append(self.big("failed", size=900))
            self.assertEqual(spool.inspect()["pending"], 1)

    def test_an_unsafe_native_directory_fails_closed(self):
        with tempfile.TemporaryDirectory() as root:
            spool = self.spool(root)
            target = Path(root).resolve() / "elsewhere"
            target.mkdir()
            (Path(root).resolve() / "bootstrap").symlink_to(target)
            # A status read still works and reports no retained native bytes.
            self.assertEqual(spool.native_bytes(), 0)
            self.assertEqual(spool.inspect()["nativeBytes"], 0)
            # Capacity accounting refuses it rather than understating the cap.
            with self.assertRaises(ValueError):
                spool.budget()
            with self.assertRaises(ValueError):
                spool.append(event())

    def test_a_linked_member_is_not_counted_but_a_plain_file_is(self):
        with tempfile.TemporaryDirectory() as root:
            directory = self.native(root, count=1, size=2048)
            (directory / "link.json").symlink_to(directory / "e0.json")
            spool = self.spool(root)
            self.assertEqual(spool.native_bytes(), 2048)
            with self.assertRaises(ValueError):
                spool.budget()
