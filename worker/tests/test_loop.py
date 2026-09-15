import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from musicmute_worker.supervisor import run_loop
from musicmute_worker.transport import ApiError


class LoopTests(unittest.TestCase):
    def test_once_does_not_long_poll(self):
        worker = Mock(config=SimpleNamespace(claim_wait_seconds=25))
        worker.run_once.return_value = "idle"
        self.assertEqual(run_loop(worker, threading.Event(), once=True), 0)
        worker.run_once.assert_called_once_with(wait_seconds=0)

    def test_supported_empty_poll_reconnects_without_fifteen_second_sleep(self):
        stop = Mock()
        stop.is_set.side_effect = [False, False, True]
        worker = Mock(config=SimpleNamespace(claim_wait_seconds=25))
        worker.run_once.side_effect = ["idle", "ready"]
        self.assertEqual(run_loop(worker, stop), 0)
        stop.wait.assert_not_called()
        self.assertEqual(worker.run_once.call_count, 2)

    def test_explicit_immediate_poll_is_bounded_at_one_second(self):
        stop = Mock()
        stop.is_set.side_effect = [False, True]
        worker = Mock(config=SimpleNamespace(claim_wait_seconds=0))
        worker.run_once.return_value = "idle"
        run_loop(worker, stop)
        stop.wait.assert_called_once_with(1)

    def test_api_backoff_honors_server_delay_and_stops_engine(self):
        stop = Mock()
        stop.is_set.side_effect = [False, True]
        worker = Mock(config=SimpleNamespace(claim_wait_seconds=25))
        worker.run_once.side_effect = ApiError(429, retry_after=12)
        run_loop(worker, stop)
        stop.wait.assert_called_once_with(12)
        worker.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
