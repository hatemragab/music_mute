import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import http.client
import json
from pathlib import Path
import socket
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import service
from acquirer import AcquisitionError
from proxy_sessions import ProxyCredentials, StickySessions

KEY = 'fixture-private-service-key-12345678'
URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.calls = []

        def acquire(**values):
            self.calls.append(values)
            path = values['scratch'] / 'native.webm'
            path.write_bytes(b'native-audio-fixture')
            return SimpleNamespace(path=path, content_type='audio/webm',
                                   metadata={'title': 'Fixture', 'channel': 'secret-res-password',
                                             'delivery_url': 'https://never-forward.invalid'},
                                   timings_ms={'extraction_ms': 1, 'transfer_ms': 2, 'token_generation_ms': 0})
        self.server = service.Server(('127.0.0.1', 0), KEY,
                                     StickySessions(ProxyCredentials('res-fixture', 'secret-res-password'),
                                                    ProxyCredentials('mobile-fixture', 'secret-mobile-password')),
                                     self.directory.name, acquire)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def post(self, changes=None, extra=None):
        body = {'url': URL, 'max_bytes': 1000, 'max_duration_seconds': 300}
        body.update(changes or {})
        headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY}
        headers.update(extra or {})
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=10)
        try:
            connection.request('POST', '/audio-imports', json.dumps(body), headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def context(self, attempt=1, age=0):
        stamp = datetime.now(timezone.utc) - timedelta(seconds=age)
        return {'X-Import-Attempt': str(attempt), 'X-Import-Max-Attempts': '4',
                'X-Import-Acquisition-Started-At': stamp.isoformat(timespec='milliseconds').replace('+00:00', 'Z')}

    def assert_cleaned(self):
        deadline = time.monotonic() + 1
        while list(Path(self.directory.name).iterdir()) and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_native_bytes_headers_metadata_and_cleanup(self):
        status, headers, body = self.post(extra={'Cookie': 'never-forward-secret', **self.context()})
        self.assertEqual(status, 200)
        self.assertEqual(body, b'native-audio-fixture')
        self.assertEqual(headers['Content-Length'], str(len(body)))
        self.assertEqual(headers['Cache-Control'], 'no-store')
        metadata = json.loads(base64.b64decode(headers['X-Import-Extra-Data-Base64']))
        self.assertEqual(metadata['title'], 'Fixture')
        self.assertNotIn('channel', metadata)
        self.assertNotIn('delivery_url', metadata)
        self.assertNotIn('Cookie', self.calls[0])
        self.assertLessEqual(self.calls[0]['deadline'] - time.monotonic(), 30)
        self.assert_cleaned()

    def test_playlist_radio_context_downloads_only_the_selected_video(self):
        shared = 'https://www.youtube.com/watch?v=e6WT8RwRwt4&list=RDe6WT8RwRwt4&start_radio=1'
        status, _, body = self.post({'url': shared})
        self.assertEqual(status, 200)
        self.assertEqual(body, b'native-audio-fixture')
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]['url'], 'https://www.youtube.com/watch?v=e6WT8RwRwt4')
        self.assert_cleaned()

    def test_attempts_one_to_three_residential_and_four_mobile(self):
        for attempt in range(1, 5):
            self.assertEqual(self.post(extra=self.context(attempt))[0], 200)
        self.assertTrue(all('res-fixture' in item['proxy'] for item in self.calls[:3]))
        self.assertIn('mobile-fixture', self.calls[3]['proxy'])
        self.assertEqual(len(self.calls), 4)

    def test_expired_budget_and_partial_context_do_not_start_download(self):
        status, headers, _ = self.post(extra=self.context(age=121))
        self.assertEqual(status, 503)
        self.assertEqual(headers['X-Import-Error'], 'IMPORT_ACQUISITION_EXHAUSTED')
        self.assertNotIn('Retry-After', headers)
        self.assertEqual(self.post(extra={'X-Import-Attempt': '1'})[0], 400)
        self.assertEqual(self.calls, [])

    def test_rejects_playlists_non_youtube_invalid_limits_before_download(self):
        cases = [({'url': 'https://www.youtube.com/playlist?list=fixture'}, 422),
                 ({'url': 'https://www.youtube.com/playlist?list=fixture&v=aqz-KE-bpKQ'}, 422),
                 ({'url': URL + '&v=abcdefghijk&list=fixture'}, 400),
                 ({'url': 'https://youtu.be/aqz-KE-bpKQ?v=abcdefghijk&list=fixture'}, 400),
                 ({'url': 'https://soundcloud.com/fixture/track'}, 422),
                 ({'max_bytes': True}, 400), ({'max_duration_seconds': 1801}, 400)]
        for changes, expected in cases:
            with self.subTest(changes=changes):
                self.assertEqual(self.post(changes)[0], expected)
        self.assertEqual(self.post(extra={'Authorization': 'Bearer wrong'})[0], 401)
        self.assertEqual(self.calls, [])

    def test_transient_errors_are_sanitized_and_request_short_retry(self):
        def fail(**_values):
            raise RuntimeError('http://private-login:private-password@private-host/signed-url')
        self.server.acquire = fail
        status, headers, body = self.post()
        self.assertEqual(status, 503)
        self.assertEqual(headers['Retry-After'], '1')
        self.assertNotIn(b'private-password', body)
        self.assert_cleaned()

    def test_logs_correlated_safe_cause_while_preserving_generic_response(self):
        logs, recorded = [], threading.Event()
        request_id = 'bfb0b065-b21b-45c7-9528-340765a56b56'

        def log(value, **_options):
            logs.append(json.loads(value))
            recorded.set()

        def fail(**values):
            values['progress']({'phase': 'extraction'}, {'extraction_ms': 7})
            raise AcquisitionError('IMPORT_UPSTREAM_REFUSED', diagnostics={
                'phase': 'transfer', 'reason': 'http_forbidden', 'http_status': 403,
                'exception_type': 'HTTPError', 'format_id': '250', 'format_count': 3,
                'url': URL, 'proxy': values['proxy'], 'message': KEY,
            }, timings_ms={'transfer_ms': 8, KEY: 1})

        self.server.acquire = fail
        with patch.object(service, 'print', side_effect=log, create=True):
            status, headers, body = self.post(extra={**self.context(2), 'X-Import-Request-ID': request_id})
            self.assertTrue(recorded.wait(2))
        self.assertEqual(status, 503)
        self.assertEqual(headers['X-Import-Error'], 'IMPORT_DEPENDENCY_FAILED')
        self.assertNotIn(b'http_forbidden', body)
        event = logs[0]
        self.assertEqual(event['request_id'], request_id)
        self.assertEqual(event['attempt'], 2)
        self.assertEqual(event['pool'], 'residential')
        self.assertEqual(event['phase'], 'transfer')
        self.assertEqual(event['http_status'], 403)
        self.assertEqual(event['reason'], 'http_forbidden')
        self.assertEqual(event['upstream_error_code'], 'IMPORT_UPSTREAM_REFUSED')
        self.assertEqual(event['proxy_port'], 10000)
        self.assertEqual(event['extraction_ms'], 7)
        self.assertEqual(event['transfer_ms'], 8)
        self.assertNotIn(KEY, json.dumps(event))
        self.assertNotIn('secret-res-password', json.dumps(event))
        self.assertNotIn(URL, json.dumps(event))

    def test_attempt_deadline_keeps_progress_phase_and_timeout_flag(self):
        logs, recorded = [], threading.Event()

        def log(value, **_options):
            logs.append(json.loads(value))
            recorded.set()

        def block(**values):
            values['progress']({'phase': 'transfer', 'format_id': '250'}, {'extraction_ms': 1})
            while True:
                values['check']()
                time.sleep(.005)

        self.server.acquire = block
        with patch.object(service, 'ATTEMPT_SECONDS', .1), \
                patch.object(service, 'print', side_effect=log, create=True):
            self.assertEqual(self.post(extra=self.context())[0], 503)
            self.assertTrue(recorded.wait(2))
        self.assertEqual(logs[0]['phase'], 'transfer')
        self.assertEqual(logs[0]['reason'], 'attempt_deadline')
        self.assertTrue(logs[0]['timeout'])
        self.assertEqual(logs[0]['extraction_ms'], 1)

    def test_ten_downloads_overlap_with_separate_sessions(self):
        release = threading.Event()
        all_started = threading.Event()
        lock = threading.Lock()
        active = [0]
        original = self.server.acquire

        def block(**values):
            with lock:
                active[0] += 1
                if active[0] == 10:
                    all_started.set()
            while not release.wait(0.01):
                values['check']()
            return original(**values)
        self.server.acquire = block
        try:
            with ThreadPoolExecutor(max_workers=10) as pool:
                futures = [pool.submit(self.post) for _ in range(10)]
                self.assertTrue(all_started.wait(8), 'Downloads unexpectedly serialized')
                release.set()
                self.assertTrue(all(item.result()[0] == 200 for item in futures))
        finally:
            release.set()
        self.assertEqual(len({item['proxy'] for item in self.calls}), 10)

    def test_disconnect_interrupts_active_acquisition(self):
        started, cancelled = threading.Event(), threading.Event()

        def block(**values):
            started.set()
            try:
                while True:
                    values['check']()
                    time.sleep(0.01)
            finally:
                cancelled.set()
        self.server.acquire = block
        client = socket.create_connection(self.server.server_address)
        body = json.dumps({'url': URL, 'max_bytes': 1000, 'max_duration_seconds': 300}).encode()
        client.sendall((f'POST /audio-imports HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {KEY}\r\n'
                        f'Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n').encode() + body)
        self.assertTrue(started.wait(2))
        client.close()
        self.assertTrue(cancelled.wait(2))


if __name__ == '__main__':
    unittest.main()
