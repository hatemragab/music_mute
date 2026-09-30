"""Deterministic capacity/pacing tests without provider requests or sleeps."""
import sys
from pathlib import Path
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from acquisition_limits import AcquisitionLimits, Admission, wait_for_slot


class AcquisitionLimitTests(unittest.TestCase):
    def test_shared_defaults_and_bounded_configuration(self):
        self.assertEqual(AcquisitionLimits.from_env({}), AcquisitionLimits(20, 5))
        self.assertEqual(AcquisitionLimits.from_env({
            'ACQUISITION_CONCURRENCY': '3', 'ACQUISITION_REQUESTS_PER_SECOND': '2',
        }), AcquisitionLimits(3, 2))
        for key, values in (
            ('ACQUISITION_CONCURRENCY', ['0', '21', '1.5', 'private-invalid-value']),
            ('ACQUISITION_REQUESTS_PER_SECOND', ['0', '6', '1.5', 'private-invalid-value']),
        ):
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(ValueError) as error:
                    AcquisitionLimits.from_env({key: value})
                self.assertNotIn(value, str(error.exception))

    def test_twenty_starts_follow_five_per_rolling_second(self):
        now, starts = [0.0], []
        admission = Admission(clock=lambda: now[0], sleep=lambda delay: now.__setitem__(0, now[0] + delay))
        for _ in range(20):
            admission.reserve()
            starts.append(now[0])
        self.assertGreaterEqual(starts[-1], 3)
        for index, start in enumerate(starts):
            self.assertLessEqual(sum(start - 1 < previous <= start for previous in starts[:index + 1]), 5)

    def test_cancelled_rate_wait_never_reserves_or_replays(self):
        now = [0.0]
        admission = Admission(clock=lambda: now[0], sleep=lambda delay: now.__setitem__(0, now[0] + delay))
        for _ in range(5):
            admission.reserve()

        def guard():
            if now[0] >= 0.2:
                raise ConnectionAbortedError()

        with self.assertRaises(ConnectionAbortedError):
            admission.reserve(guard)
        self.assertEqual(len(admission.started), 5)

    def test_cooldown_wait_is_cancellable_and_preserves_other_starts(self):
        now = [0.0]
        admission = Admission(clock=lambda: now[0], sleep=lambda delay: now.__setitem__(0, now[0] + delay))
        admission.reserve()
        admission.cooldown(2)
        admission.reserve()
        self.assertGreaterEqual(now[0], 2)
        self.assertEqual(len(admission.started), 1)

    def test_slot_wait_admits_after_completion_and_releases_cancelled_acquisition(self):
        slot = threading.BoundedSemaphore(1)
        slot.acquire()
        checks = [0]

        def finish():
            checks[0] += 1
            if checks[0] == 2:
                slot.release()

        wait_for_slot(slot, finish)
        self.assertFalse(slot.acquire(blocking=False))
        slot.release()
        checks[0] = 0

        def cancel():
            checks[0] += 1
            if checks[0] == 2:
                raise ConnectionAbortedError()

        with self.assertRaises(ConnectionAbortedError):
            wait_for_slot(slot, cancel)
        self.assertTrue(slot.acquire(blocking=False))
        slot.release()


if __name__ == '__main__':
    unittest.main()
