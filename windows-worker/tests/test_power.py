import importlib
import threading
import unittest
from unittest.mock import Mock, patch


class KeepAwakeTests(unittest.TestCase):
    def setUp(self):
        try:
            self.power = importlib.import_module("musicmute_worker.power")
        except ModuleNotFoundError:
            self.fail("Windows power management is not implemented")

    def test_keeps_system_awake_without_requesting_display_and_restores_flags(self):
        previous = 0x80000042  # Preserve an existing display/away requirement.
        api = Mock(side_effect=[previous, 0x80000001])
        with patch.object(self.power, "_set_thread_execution_state", api):
            with self.power.KeepAwake():
                api.assert_called_once_with(0x80000001)
            self.assertEqual(
                [call.args[0] for call in api.call_args_list],
                [
                    0x80000001,
                    previous,
                ],
            )

    def test_exception_in_body_still_restores_and_propagates(self):
        api = Mock(return_value=0x80000000)
        with (
            patch.object(self.power, "_set_thread_execution_state", api),
            self.assertRaisesRegex(ValueError, "worker failed"),
            self.power.KeepAwake(),
        ):
            raise ValueError("worker failed")
        self.assertEqual(api.call_args.args, (0x80000000,))

    def test_failed_acquisition_prevents_worker_from_starting(self):
        api = Mock(return_value=0)
        with (
            patch.object(self.power, "_set_thread_execution_state", api),
            self.assertRaisesRegex(OSError, "prevent system sleep"),
            self.power.KeepAwake(),
        ):
            self.fail("Worker started without the requested power state")
        api.assert_called_once_with(0x80000001)

    def test_failed_restore_is_reported_and_can_be_retried_on_owner_thread(self):
        api = Mock(side_effect=[0x80000000, 0, 0x80000001])
        with patch.object(self.power, "_set_thread_execution_state", api):
            awake = self.power.KeepAwake()
            awake.__enter__()
            with self.assertRaisesRegex(OSError, "restore.*execution state"):
                awake.__exit__(None, None, None)
            awake.__exit__(None, None, None)
            awake.__exit__(None, None, None)
        self.assertEqual(api.call_count, 3)

    def test_cannot_restore_from_different_thread(self):
        api = Mock(return_value=0x80000000)
        errors = []
        with (
            patch.object(self.power, "_set_thread_execution_state", api),
            self.power.KeepAwake() as awake,
        ):

            def release():
                try:
                    awake.__exit__(None, None, None)
                except RuntimeError as exc:
                    errors.append(str(exc))

            thread = threading.Thread(target=release)
            thread.start()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(errors), 1)
            self.assertIn("same thread", errors[0])
            api.assert_called_once_with(0x80000001)
        self.assertEqual(api.call_count, 2)

    def test_reentering_instance_does_not_lose_original_flags(self):
        api = Mock(return_value=0x80000000)
        with patch.object(self.power, "_set_thread_execution_state", api):
            with (
                self.power.KeepAwake() as awake,
                self.assertRaisesRegex(RuntimeError, "already active"),
            ):
                awake.__enter__()
            self.assertEqual(api.call_count, 2)
            self.assertEqual(api.call_args.args, (0x80000000,))

    def test_non_windows_context_is_safe_and_preserves_body_errors(self):
        with patch.object(self.power, "_set_thread_execution_state", None):
            with self.power.KeepAwake():
                pass
            with (
                self.assertRaisesRegex(ValueError, "body error"),
                self.power.KeepAwake(),
            ):
                raise ValueError("body error")


if __name__ == "__main__":
    unittest.main()
