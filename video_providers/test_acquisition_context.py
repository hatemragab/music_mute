from datetime import datetime, timezone
from email.message import Message
import unittest

from acquisition_context import AcquisitionContext, HEADER_NAMES, parse_context


class ContextTests(unittest.TestCase):
    def headers(self, values=('1', '4', '2026-10-03T12:00:00.000Z')):
        output = Message()
        for name, value in zip(HEADER_NAMES, values):
            if value is not None:
                output[name] = value
        return output

    def test_absent_remains_legacy(self):
        self.assertIsNone(parse_context(Message()))

    def test_round_trip_and_shared_deadline(self):
        now = datetime(2026, 10, 3, 12, tzinfo=timezone.utc).timestamp()
        parsed = parse_context(self.headers(), now)
        self.assertEqual(parsed.headers(), dict(self.headers().items()))
        self.assertEqual(parsed.remaining_seconds(now=now + 91), 29)
        self.assertEqual(parsed.remaining_seconds(now=now + 121), 0)
        self.assertEqual(parsed.remaining_seconds(now=now - 1), 120)

    def test_invalid_context_is_rejected_without_echoing_values(self):
        now = datetime(2026, 10, 3, 12, tzinfo=timezone.utc).timestamp()
        for values in [('1', None, None), ('0', '4', '2026-10-03T12:00:00.000Z'),
                       ('2', '1', '2026-10-03T12:00:00.000Z'),
                       ('1', '4', '2026-10-03T12:00:06.000Z'),
                       ('1', '4', '2026-02-30T12:00:00.000Z'),
                       ('1', '4', '2026-10-03T12:00:00+00:00')]:
            with self.subTest(values=values), self.assertRaisesRegex(ValueError, '^Invalid acquisition context$'):
                parse_context(self.headers(values), now)
        duplicate = self.headers()
        duplicate['X-Import-Attempt'] = '1'
        with self.assertRaises(ValueError):
            parse_context(duplicate, now)


if __name__ == '__main__':
    unittest.main()
