from contextlib import contextmanager
import base64
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from server import Server, request_body

KEY = b'synthetic-test-key-with-at-least-32-bytes'
BODY = {'url': 'https://www.facebook.com/share/v/19duj8sfLg/',
        'max_bytes': 1000, 'max_duration_seconds': 60}


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.server = Server(('127.0.0.1', 0), KEY)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, body=BODY, key=KEY):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            connection.request('POST', '/audio-imports', json.dumps(body), {
                'Authorization': 'Bearer ' + key.decode(), 'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            connection.close()

    def test_authentication_precedes_acquisition(self):
        with patch('runner.prepared') as acquire:
            status, _, _ = self.request(key=b'wrong')
            self.assertEqual(status, 401)
            acquire.assert_not_called()

    def test_complete_transfer_and_cleanup(self):
        cleaned = []
        finished = threading.Event()
        @contextmanager
        def fixture(*args, **kwargs):
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'audio.m4a'
                path.write_bytes(b'audio')
                try:
                    yield path, {'bytes': 5, 'duration_seconds': 1, 'source': {'title': 'عنوان 🎵\r\nTest'}}
                finally:
                    cleaned.append(tmp)
            finished.set()
        with patch('runner.prepared', fixture):
            status, body, headers = self.request()
        self.assertEqual((status, body), (200, b'audio'))
        self.assertEqual(headers['Content-Length'], '5')
        self.assertEqual(base64.b64decode(headers['X-Import-Title-Base64']).decode(), 'عنوان 🎵Test')
        self.assertTrue(finished.wait(2))
        self.assertTrue(cleaned)
        self.assertFalse(Path(cleaned[0]).exists())

    def test_safe_upstream_errors(self):
        with patch('runner.prepared', side_effect=ValueError('UPSTREAM_ACCESS_REFUSED')):
            status, body, _ = self.request()
            self.assertEqual(status, 502)
            self.assertEqual(json.loads(body)['code'], 'IMPORT_UPSTREAM_REFUSED')
        with patch('runner.prepared', side_effect=RuntimeError('secret signed URL')):
            status, body, _ = self.request()
            self.assertEqual(status, 503)
            self.assertNotIn(b'secret', body)

    def test_invalid_limits(self):
        for change in [{'max_bytes': True}, {'max_bytes': 50_000_001},
                       {'max_duration_seconds': float('nan')}, {'other': 1}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                request_body({**BODY, **change})

    def test_disconnect_kills_child_and_cleans_partial_media(self):
        import os
        import socket
        import sys
        import time
        import runner
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pid_file = root / 'child.pid'
            code = ('import os,time,pathlib,sys; '
                    'pathlib.Path(sys.argv[1]).write_bytes(b"partial"); '
                    'pathlib.Path(sys.argv[2]).write_text(str(os.getpid())); time.sleep(30)')
            def command(url, directory, limits=None):
                return [sys.executable, '-c', code, str(directory / 'source.m4a.part'), str(pid_file)]
            with patch.object(runner, 'ROOT', root), patch.object(runner, 'command', command):
                connection = socket.create_connection(self.server.server_address)
                data = json.dumps(BODY).encode()
                connection.sendall(b'POST /audio-imports HTTP/1.0\r\nContent-Type: application/json\r\nAuthorization: Bearer '
                                   + KEY + b'\r\nContent-Length: ' + str(len(data)).encode()
                                   + b'\r\n\r\n' + data)
                deadline = time.monotonic() + 3
                while not pid_file.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(pid_file.exists(), 'Downloader did not start')
                child_pid = int(pid_file.read_text())
                connection.close()
                deadline = time.monotonic() + 3
                while list(root.glob('attempt-*')) and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertEqual(list(root.glob('attempt-*')), [])
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
