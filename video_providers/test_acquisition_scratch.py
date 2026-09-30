import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from acquisition_scratch import ScratchBudget, ScratchUnavailable


class ScratchTests(unittest.TestCase):
    def space(self, free):
        return SimpleNamespace(f_bavail=free, f_frsize=1)

    def test_twenty_full_reservations_fit_and_the_next_cannot_start(self):
        budget = ScratchBudget('/synthetic')
        with patch('acquisition_scratch.os.statvfs', return_value=self.space(2_147_483_648)):
            reservations = [budget.reserve(100_000_000) for _ in range(20)]
            with self.assertRaises(ScratchUnavailable):
                budget.reserve(100_000_000)
            reservations[0].__exit__()
            with budget.reserve(100_000_000):
                self.assertEqual(budget.remaining, 2_000_000_000)
            for reservation in reservations[1:]:
                reservation.__exit__()
        self.assertEqual(budget.remaining, 0)

    def test_allocated_bytes_are_not_double_counted_in_following_reservations(self):
        budget = ScratchBudget('/synthetic', min_free_bytes=10)
        with patch('acquisition_scratch.os.statvfs', return_value=self.space(210)):
            with budget.reserve(100) as reservation:
                output = io.BytesIO()
                self.assertEqual(reservation.wrap(output).write(b'a' * 100), 100)
                self.assertEqual(budget.remaining, 0)
                with patch('acquisition_scratch.os.statvfs', return_value=self.space(110)):
                    with budget.reserve(100):
                        self.assertEqual(budget.remaining, 100)
        self.assertEqual(budget.remaining, 0)

    def test_failure_cleanup_releases_remaining_bytes_once(self):
        budget = ScratchBudget('/synthetic', min_free_bytes=10)
        with patch('acquisition_scratch.os.statvfs', return_value=self.space(1000)):
            with self.assertRaises(RuntimeError):
                with budget.reserve(100) as reservation:
                    reservation.wrap(io.BytesIO()).write(b'partial')
                    raise RuntimeError('synthetic')
            reservation.__exit__()
        self.assertEqual(budget.remaining, 0)

    def test_overflow_fails_before_write_and_preserves_reservation(self):
        budget = ScratchBudget('/synthetic', min_free_bytes=10)
        with patch('acquisition_scratch.os.statvfs', return_value=self.space(1000)):
            with budget.reserve(2) as reservation:
                output = io.BytesIO()
                with self.assertRaises(ValueError):
                    reservation.wrap(output).write(b'123')
                self.assertEqual(output.getvalue(), b'')
                self.assertEqual(budget.remaining, 2)


if __name__ == '__main__':
    unittest.main()
