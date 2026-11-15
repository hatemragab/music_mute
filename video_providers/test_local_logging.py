"""No provider calls, media, credentials or application state."""
import json
import os
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler
from local_logging import LocalLoggingHandlerMixin, emit_http, enabled, status
import local_logging


class LocalLoggingTests(unittest.TestCase):
    def test_release_and_disabled_environments_cannot_enable(self):
        with patch.dict(os.environ, {'NODE_ENV': 'production', 'APP_ENV': 'production',
                                    'MUSICMUTE_LOG_ENABLED': '1', 'MUSICMUTE_LOG_KEY': 'a' * 64}):
            self.assertFalse(enabled())
        with patch.dict(os.environ, {'NODE_ENV': 'development', 'APP_ENV': 'local',
                                    'MUSICMUTE_LOG_ENABLED': '1', 'MUSICMUTE_LOG_KEY': 'a' * 64}), patch.object(local_logging, '_SOURCE_TREE', False):
            self.assertFalse(enabled())

    def test_closed_envelope_omits_credentials_urls_and_arbitrary_text(self):
        with patch.dict(os.environ, {'NODE_ENV': 'development', 'APP_ENV': 'local',
                                    'MUSICMUTE_LOG_ENABLED': '1', 'MUSICMUTE_LOG_KEY': 'a' * 64}), patch.object(local_logging, '_STARTED', True), patch.object(local_logging._QUEUE, 'put_nowait') as put:
            emit_http('router', 'POST', '/audio-imports?token=SYNTHETIC_SECRET', 503, 10,
                      '12345678-1234-1234-1234-123456789abc', 'failed', 'audio/webm', '1200')
            captured = json.loads(put.call_args.args[0])
            self.assertEqual(captured['route'], '[unmatched]')
            self.assertEqual(captured['status'], 503)
            self.assertEqual(captured['requestId'], '12345678-1234-1234-1234-123456789abc')
            self.assertNotIn('SYNTHETIC_SECRET', str(captured))
            self.assertEqual(captured['contentLength'], 1200)

    def test_mixin_preserves_parent_behavior(self):
        class Original:
            def handle_one_request(self):
                self.command, self.path, self.headers = 'POST', '/audio-imports', {}
                self.send_response(200)
                self.send_header('Content-Type', 'audio/webm')
                return 'unchanged'
            def send_response(self, *args):
                pass
            def send_header(self, *args):
                pass
        class Handler(LocalLoggingHandlerMixin, Original):
            local_log_service = 'router'
        with patch.object(local_logging, 'emit_http') as emitted:
            self.assertEqual(Handler().handle_one_request(), 'unchanged')
            self.assertEqual(emitted.call_args.args[3], 200)
            self.assertEqual(emitted.call_args.args[6], 'completed')

    def test_pressure_is_bounded_and_observable(self):
        import queue
        with patch.dict(os.environ, {'NODE_ENV': 'development', 'APP_ENV': 'local',
                                    'MUSICMUTE_LOG_ENABLED': '1', 'MUSICMUTE_LOG_KEY': 'a' * 64}), patch.object(local_logging, '_STARTED', True), patch.object(local_logging._QUEUE, 'put_nowait', side_effect=queue.Full):
            before = status()['dropped']
            emit_http('router', 'GET', '/health', 200, 1)
            self.assertEqual(status()['dropped'], before + 1)


if __name__ == '__main__':
    unittest.main()
