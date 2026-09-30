import base64
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from email.message import Message
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import socket
import ssl
import tarfile
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from package_caprover import FILES, package, source_path
from service import (Admission, Failure, Handler, Provider, PublicTLS, Server,
                     included_metadata, public_addresses, response_length,
                     retry_seconds, source_url, tunnel_url, wait_for_slot)
from acquisition_scratch import ScratchBudget

URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
AUDIO = b'\x1a\x45\xdf\xa3fixture-opus-audio'
PAYLOAD = {'status': 'ok', 'mode': 'audio', 'quality': 'opus',
           'url': 'https://tunelio.dev/tunnel?opaque=synthetic-private-signature',
           'file_size': len(AUDIO)}


class PolicyTests(unittest.TestCase):
    def test_canonical_youtube_items(self):
        for source in ['https://youtu.be/aqz-KE-bpKQ?si=tracker',
                       'https://youtube.com/watch?v=aqz-KE-bpKQ&t=60',
                       'https://www.youtube.com/shorts/aqz-KE-bpKQ',
                       'https://m.youtube.com/embed/aqz-KE-bpKQ/',
                       'https://music.youtube.com/live/aqz-KE-bpKQ']:
            self.assertEqual(source_url(source), URL)

    def test_rejects_other_sites_profiles_collections_credentials_and_unsafe_urls(self):
        for source in ['http://youtube.com/watch?v=aqz-KE-bpKQ',
                       'https://youtube.com/watch?v=aqz-KE-bpKQ&list=123',
                       'https://youtube.com/watch?v=aqz-KE-bpKQ&v=abcdefghijk',
                       'https://youtube.com/watch?v=aqz-KE-bpKQ#index',
                       'https://youtube.com:443/watch?v=aqz-KE-bpKQ',
                       'https://user@youtube.com/watch?v=aqz-KE-bpKQ',
                       'https://youtube.com/@user', 'https://youtube.com/playlist?list=123',
                       'https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ',
                       'https://youtu.be/aqz-KE-bpKQ/extra',
                       'https://youtube.com/watch?v=bad', 'https://vimeo.com/123',
                       'https://youtu.be/aqz-KE-bpKQ\n', 'https://127.0.0.1/watch?v=aqz-KE-bpKQ',
                       None, 'x' * 2049]:
            with self.subTest(source=source), self.assertRaises(Failure):
                source_url(source)

    def test_tunnel_is_exact_vendor_host_path_and_no_repackaging(self):
        self.assertEqual(tunnel_url(PAYLOAD['url']).hostname, 'tunelio.dev')
        for value in ['https://googlevideo.com/tunnel?sig=x', 'https://tunelio.dev.evil.test/tunnel?sig=x',
                      'http://tunelio.dev/tunnel?sig=x', 'https://tunelio.dev:443/tunnel?sig=x',
                      'https://user@tunelio.dev/tunnel?sig=x', 'https://tunelio.dev/create?sig=x',
                      'https://tunelio.dev/tunnel', 'https://tunelio.dev/tunnel?sig=x#private',
                      'https://tunelio.dev/tunnel?sig=x&progressive=1',
                      'https://tunelio.dev/tunnel?sig=x&hls=1', None]:
            with self.subTest(value=value), self.assertRaises(Failure):
                tunnel_url(value)

    def test_metadata_does_not_invent_measured_bitrate_or_codec(self):
        payload = {**PAYLOAD, 'bitrate': 128, 'filename': 'Bearer hidden',
                   'audio_codec': 'opus', 'private': 'must not persist'}
        data = included_metadata(payload, 'audio/webm')
        self.assertEqual(data, {'schema_version': 1, 'provider': 'tunelio', 'site': 'youtube',
                                'extension': 'webm', 'container': 'webm',
                                'provider_file_bytes': len(AUDIO)})
        self.assertNotIn('bitrate_kbps', data)
        self.assertNotIn('audio_codec', data)
        self.assertNotIn('container', included_metadata(PAYLOAD, 'application/octet-stream'))

    def test_rate_admission_rolling_window_and_cooldown(self):
        now = [0]
        waits = []
        def sleep(seconds):
            waits.append(seconds)
            now[0] += seconds
        admission = Admission(clock=lambda: now[0], sleep=sleep)
        for _ in range(5):
            admission.reserve()
        admission.reserve()
        self.assertAlmostEqual(now[0], 1)
        self.assertTrue(waits)
        self.assertEqual(len(admission.started), 1)
        admission.cooldown(2)
        admission.reserve()
        self.assertAlmostEqual(now[0], 3)

    def test_retry_after_supports_numeric_http_date_and_bounds(self):
        self.assertEqual(retry_seconds('120'), 120)
        self.assertEqual(retry_seconds('999999999'), 86400)
        self.assertEqual(retry_seconds('0'), 1)
        self.assertEqual(retry_seconds('Wed, 30 Sep 2026 12:01:00 GMT',
                                       wall_clock=lambda: 1790769600), 60)
        self.assertEqual(retry_seconds('garbage'), 60)

    def test_dns_rejects_any_nonpublic_answer_before_connecting(self):
        for ip in ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1',
                   '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:0808:0808::1']:
            answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443)),
                       (socket.AF_INET6, socket.SOCK_STREAM, 6, '', (ip, 443))]
            with self.subTest(ip=ip), patch('service.socket.getaddrinfo', return_value=answers), \
                    self.assertRaises(Failure):
                public_addresses('tunelio.dev', 443, 1)

    def test_dns_timeout_does_not_accumulate_resolver_threads(self):
        release, entered = threading.Event(), threading.Event()
        def resolve(*args, **kwargs):
            entered.set()
            release.wait(2)
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))]
        with patch('service.DNS_SLOT', threading.BoundedSemaphore(2)), \
                patch('service.socket.getaddrinfo', side_effect=resolve) as call:
            try:
                with self.assertRaises(Failure):
                    public_addresses('tunelio.dev', 443, .02)
                self.assertTrue(entered.is_set())
                with self.assertRaises(Failure):
                    public_addresses('tunelio.dev', 443, .02)
                with self.assertRaises(Failure):
                    public_addresses('tunelio.dev', 443, .02)
                self.assertEqual(call.call_count, 2)
            finally:
                release.set()
                for _ in range(100):
                    from service import DNS_SLOT
                    if DNS_SLOT.acquire(blocking=False):
                        if DNS_SLOT.acquire(blocking=False):
                            DNS_SLOT.release()
                            DNS_SLOT.release()
                            break
                        DNS_SLOT.release()
                    time.sleep(.01)

    def test_tls_uses_pinned_address_sni_and_does_not_retry_bad_certificate(self):
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))]
        sock = Mock()
        context = Mock()
        conn = PublicTLS('tunelio.dev', 443, timeout=2)
        with patch('service.public_addresses', return_value=answers), \
                patch('service.socket.socket', return_value=sock), \
                patch('service.ssl.create_default_context', return_value=context):
            conn.connect()
        sock.connect.assert_called_once_with(('8.8.8.8', 443))
        context.wrap_socket.assert_called_once_with(sock, server_hostname='tunelio.dev')
        context.wrap_socket.side_effect = ssl.SSLCertVerificationError()
        with patch('service.public_addresses', return_value=answers * 2), \
                patch('service.socket.socket', return_value=sock), \
                patch('service.ssl.create_default_context', return_value=context), \
                self.assertRaises(ssl.SSLCertVerificationError):
            conn.connect()
        self.assertEqual(context.wrap_socket.call_count, 2)

    def test_optional_metadata_dns_does_not_block_acquisition_dns(self):
        release, entered = threading.Event(), threading.Event()
        results = []
        def resolve(host, *args, **kwargs):
            if host == 'www.youtube.com':
                entered.set()
                release.wait(2)
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))]
        with patch('service.socket.getaddrinfo', side_effect=resolve):
            metadata = threading.Thread(target=lambda: results.append(
                public_addresses('www.youtube.com', 443, 2)))
            metadata.start()
            try:
                self.assertTrue(entered.wait(1))
                self.assertEqual(len(public_addresses('tunelio.dev', 443, 1)), 1)
            finally:
                release.set()
                metadata.join(2)
        self.assertEqual(len(results), 1)

    def test_response_framing_and_caps(self):
        for pairs in [[('Content-Length', '1'), ('Content-Length', '1')],
                      [('Content-Length', '1'), ('Transfer-Encoding', 'chunked')],
                      [('Transfer-Encoding', 'gzip')], [('Content-Length', 'bad')],
                      [('Content-Length', '101')]]:
            headers = Message()
            for key, value in pairs:
                headers[key] = value
            response = Mock(headers=headers)
            response.getheader.side_effect = headers.get
            with self.subTest(pairs=pairs), self.assertRaises(Failure):
                response_length(response, 100)


class ProviderHTTPTests(unittest.TestCase):
    """Real HTTP response parsing/EOF; upstream TLS is separately qualified."""
    def setUp(self):
        self.replies, self.calls = deque(), []
        replies, calls = self.replies, self.calls
        class Fixture(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def log_message(self, *args):
                pass
            def do_GET(self):
                calls.append((self.path, dict(self.headers)))
                status, body, headers = replies.popleft()
                self.send_response(status)
                for key, value in headers:
                    self.send_header(key, value)
                if not any(key.lower() == 'content-length' for key, _ in headers):
                    self.send_header('Content-Length', str(len(body)))
                self.send_header('Connection', 'close')
                self.end_headers()
                try:
                    self.wfile.write(body)
                except OSError:
                    pass
                self.close_connection = True
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.connections = []
        def connection(host, port, timeout):
            self.assertEqual((host, port), ('tunelio.dev', 443))
            conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=timeout)
            self.connections.append(conn)
            return conn
        self.events = []
        self.admission = Admission()
        self.provider = Provider('tnl_synthetic-private-key', lambda: None, self.admission,
                                 connection, log=lambda **fields: self.events.append(fields))

    def tearDown(self):
        self.provider.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def create_reply(self, payload=PAYLOAD, status=200, raw=None, headers=None):
        body = json.dumps(payload).encode() if raw is None else raw
        self.replies.append((status, body, headers or [('Content-Type', 'application/json')]))

    def audio_reply(self, body=AUDIO, status=200, headers=None):
        self.replies.append((status, body, headers or [('Content-Type', 'audio/webm')]))

    def test_complete_native_audio_single_create_no_info_no_auth_on_tunnel(self):
        self.create_reply()
        self.audio_reply()
        output = io.BytesIO()
        size, extra = self.provider.acquire(URL, 2048, output)
        self.assertEqual((size, output.getvalue()), (len(AUDIO), AUDIO))
        self.assertEqual(extra['provider'], 'tunelio')
        self.assertEqual(len(self.calls), 2)
        path, headers = self.calls[0]
        self.assertEqual(urlsplit(path).path, '/create')
        self.assertEqual(parse_qs(urlsplit(path).query),
                         {'url': [URL], 'quality': ['opus'], 'audioBitrate': ['128']})
        self.assertEqual(headers['Authorization'], 'Bearer tnl_synthetic-private-key')
        self.assertEqual(urlsplit(self.calls[1][0]).path, '/tunnel')
        self.assertNotIn('Authorization', self.calls[1][1])
        self.assertNotIn('Cookie', self.calls[1][1])
        self.assertTrue(all(conn.sock is None for conn in self.connections))
        for forbidden in ['tnl_', 'signature', 'youtube.com', 'aqz-', 'Authorization', 'opaque=']:
            self.assertNotIn(forbidden, json.dumps(self.events))
        self.assertTrue(all('request_duration_ms' in event and 'response_headers_ms' in event
                            for event in self.events if 'request_duration_ms' in event))

    def test_create_failures_never_replay_paid_get(self):
        for status in [301, 302, 307, 400, 401, 402, 404, 429, 500, 502, 503]:
            with self.subTest(status=status):
                self.calls.clear()
                self.admission = Admission()
                self.provider.admission = self.admission
                self.create_reply(status=status, headers=[('Retry-After', '120'),
                                                          ('Location', 'https://private.test/')])
                with self.assertRaises(Failure):
                    self.provider.acquire(URL, 2048, io.BytesIO())
                self.assertEqual(len(self.calls), 1)
                if status == 429:
                    self.assertGreaterEqual(self.admission.cooldown_until - time.monotonic(), 119)
                self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_create_transport_failure_never_replays(self):
        conn = Mock(sock=None)
        conn.getresponse.side_effect = TimeoutError('secret')
        self.provider.connection = Mock(return_value=conn)
        with self.assertRaises(TimeoutError):
            self.provider.acquire(URL, 2048, io.BytesIO())
        self.provider.connection.assert_called_once()
        conn.request.assert_called_once()
        conn.close.assert_called_once()
        self.assertNotIn('secret', json.dumps(self.events))

    def test_failed_connection_cleanup_cannot_mask_the_original_result(self):
        response = Mock()
        response.close.side_effect = OSError('secret')
        conn = Mock()
        conn.close.side_effect = OSError('secret')
        self.provider.active_response, self.provider.active_connection = response, conn
        self.provider.close()
        self.assertIsNone(self.provider.active_response)
        self.assertIsNone(self.provider.active_connection)
        response.close.assert_called_once()
        conn.close.assert_called_once()

    def test_create_invalid_json_shapes_quality_and_sizes_stop_before_tunnel(self):
        for payload in [[], {}, {**PAYLOAD, 'quality': 'mp3'}, {**PAYLOAD, 'mode': 'video'},
                        {**PAYLOAD, 'status': 'error'}, {**PAYLOAD, 'file_size': 2049},
                        {**PAYLOAD, 'file_size': -1}, {**PAYLOAD, 'file_size': True},
                        {**PAYLOAD, 'url': 'https://127.0.0.1/tunnel?sig=x'}]:
            with self.subTest(payload=payload):
                self.calls.clear()
                self.create_reply(payload)
                with self.assertRaises(Failure):
                    self.provider.acquire(URL, 2048, io.BytesIO())
                self.assertEqual(len(self.calls), 1)

    def test_create_malformed_truncated_or_oversized_json_is_not_retried(self):
        for body, headers in [(b'not json', [('Content-Type', 'application/json')]),
                              (b'{}', [('Content-Type', 'application/json'), ('Content-Length', '10')]),
                              (b'x' * 65537, [('Content-Type', 'application/json')]),
                              (json.dumps(PAYLOAD).encode(), [('Content-Type', 'text/html')])]:
            with self.subTest(size=len(body)):
                self.calls.clear()
                self.create_reply(raw=body, headers=headers)
                with self.assertRaises(Failure):
                    self.provider.acquire(URL, 2048, io.BytesIO())
                self.assertEqual(len(self.calls), 1)

    def test_audio_status_type_empty_truncation_size_caps_no_retry(self):
        cases = [(302, AUDIO, [('Content-Type', 'audio/webm'), ('Location', 'https://googlevideo.com')]),
                 (410, AUDIO, [('Content-Type', 'audio/webm')]),
                 (429, AUDIO, [('Content-Type', 'audio/webm'), ('Retry-After', '90')]),
                 (200, AUDIO, [('Content-Type', 'text/html')]),
                 (200, AUDIO, [('Content-Type', 'audio/mpeg')]),
                 (200, b'', [('Content-Type', 'audio/webm')]),
                 (200, AUDIO[:2], [('Content-Type', 'audio/webm'), ('Content-Length', str(len(AUDIO)))]),
                 (200, AUDIO, [('Content-Type', 'audio/webm'), ('Content-Encoding', 'gzip')]),
                 (200, AUDIO + b'extra', [('Content-Type', 'audio/webm')])]
        for status, body, headers in cases:
            with self.subTest(status=status, size=len(body)):
                self.calls.clear()
                self.provider.admission = Admission()
                self.create_reply()
                self.audio_reply(body, status, headers)
                with self.assertRaises(Failure):
                    self.provider.acquire(URL, 2048, io.BytesIO())
                self.assertEqual(len(self.calls), 2)
                self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_unknown_provider_size_is_bounded_by_actual_bytes(self):
        self.create_reply({k: v for k, v in PAYLOAD.items() if k != 'file_size'})
        self.audio_reply(AUDIO * 100)
        with self.assertRaises(Failure) as error:
            self.provider.acquire(URL, len(AUDIO), io.BytesIO())
        self.assertEqual(error.exception.code, 'IMPORT_TOO_LARGE')
        self.assertEqual(len(self.calls), 2)

    def test_cancellation_after_paid_create_prevents_tunnel_and_closes_connection(self):
        self.create_reply()
        original = self.provider.create
        def create(url):
            value = original(url)
            self.provider.check = Mock(side_effect=ConnectionAbortedError())
            return value
        self.provider.create = create
        with self.assertRaises(ConnectionAbortedError):
            self.provider.acquire(URL, 2048, io.BytesIO())
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_expired_deadline_stops_before_any_paid_start(self):
        self.provider.deadline = time.monotonic() - 1
        with self.assertRaises(Failure):
            self.provider.acquire(URL, 2048, io.BytesIO())
        self.assertEqual(self.calls, [])
        self.assertEqual(len(self.admission.started), 0)

    def test_cancellation_during_rate_wait_stops_before_paid_creation(self):
        cancelled = threading.Event()
        self.admission.cooldown(60)
        self.admission.sleep = lambda _seconds: cancelled.set()
        def check():
            if cancelled.is_set():
                raise ConnectionAbortedError()
        self.provider.check = check
        with self.assertRaises(ConnectionAbortedError):
            self.provider.acquire(URL, 2048, io.BytesIO())
        self.assertEqual(self.calls, [])
        self.assertEqual(len(self.admission.started), 0)
        self.assertEqual(len(self.connections), 1)
        self.assertIsNone(self.connections[0].sock)

    def test_deadline_during_rate_wait_stops_before_paid_creation(self):
        self.admission.cooldown(60)
        self.provider.deadline = time.monotonic() + .01
        with self.assertRaises(Failure):
            self.provider.acquire(URL, 2048, io.BytesIO())
        self.assertEqual(self.calls, [])
        self.assertEqual(len(self.admission.started), 0)

    def test_explicit_request_deadline_is_preserved(self):
        deadline = time.monotonic() + .01
        provider = Provider('tnl_synthetic', lambda: None, self.admission, deadline=deadline)
        self.assertEqual(provider.deadline, deadline)

    def test_connection_delays_do_not_bunch_paid_requests_above_five_per_second(self):
        now, paid_starts = [0], []
        admission = Admission(clock=lambda: now[0], sleep=lambda seconds: now.__setitem__(0, now[0] + seconds))
        for index in range(6):
            response = Mock(status=200)
            response.headers = Message()
            response.getheader.side_effect = lambda name, default=None: 'application/json' if name == 'Content-Type' else default
            response.read1 = io.BytesIO(json.dumps(PAYLOAD).encode()).read
            connection = Mock(sock=None)
            connection.connect.side_effect = lambda: now.__setitem__(0, 5)
            if index:
                connection.connect.side_effect = None
            connection.request.side_effect = lambda *_args, **_kwargs: paid_starts.append(now[0])
            connection.getresponse.return_value = response
            provider = Provider('tnl_synthetic', lambda: None, admission, connection=Mock(return_value=connection))
            provider.create(URL)
        self.assertEqual(paid_starts[:5], [5] * 5)
        self.assertGreaterEqual(paid_starts[5] - paid_starts[0], 1)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.server = Server(('127.0.0.1', 0), Handler)
        self.server.api_key, self.server.provider_key = 's' * 32, 'tnl_synthetic-private-key'
        self.server.scratch = self.directory.name
        self.server.slots = threading.BoundedSemaphore(1)
        self.server.admission = Admission()
        self.server.scratch_budget = ScratchBudget(self.directory.name)
        title = Future()
        title.set_result({'title': 'Official title', 'channel': 'Fixture creator'})
        self.server.metadata = Mock()
        self.server.metadata.start.return_value = title
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = 'http://127.0.0.1:' + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, body=None, auth=True, request_id=''):
        data = json.dumps(body if body is not None else {
            'url': URL, 'max_bytes': 2048, 'max_duration_seconds': 1200}).encode()
        request = urllib.request.Request(self.origin + '/audio-imports', data=data,
                                         headers={'Content-Type': 'application/json',
                                                  'Authorization': 'Bearer ' + ('s' * 32 if auth else 'bad'),
                                                  'X-Import-Request-ID': request_id})
        try:
            return urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            return error

    def test_auth_url_schema_caps_and_health(self):
        with urllib.request.urlopen(self.origin + '/health') as response:
            self.assertEqual(json.load(response), {'status': 'ok'})
        body = {'url': URL, 'max_bytes': 100_000_000, 'max_duration_seconds': 1800}
        cases = [(None, False, 401), ({'url': URL}, True, 400),
                 ({**body, 'url': 'https://vimeo.com/123'}, True, 422),
                 ({**body, 'max_bytes': 100_000_001}, True, 400),
                 ({**body, 'max_duration_seconds': 1800.1}, True, 400),
                 ({**body, 'max_bytes': True}, True, 400),
                 ({**body, 'max_duration_seconds': float('nan')}, True, 400),
                 ({**body, 'extra': True}, True, 400)]
        with patch('service.Provider.acquire') as acquire:
            for value, auth, expected in cases:
                with self.subTest(expected=expected), self.request(value, auth) as response:
                    self.assertEqual(response.status, expected)
                    self.assertEqual(response.headers['Content-Type'], 'application/problem+json')
            acquire.assert_not_called()

    def test_binary_measured_length_metadata_and_cleanup_at_maximum_caps(self):
        body = {'url': URL, 'max_bytes': 100_000_000, 'max_duration_seconds': 1800}
        def acquire(_self, url, limit, out):
            self.assertEqual((url, limit), (URL, 100_000_000))
            out.write(AUDIO)
            return len(AUDIO), included_metadata(PAYLOAD, 'audio/webm')
        with patch('service.Provider.acquire', acquire):
            with self.request(body) as response:
                self.assertEqual(response.read(), AUDIO)
                self.assertEqual(int(response.headers['Content-Length']), len(AUDIO))
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
                data = json.loads(base64.b64decode(response.headers['X-Import-Extra-Data-Base64']))
                self.assertEqual(data['provider'], 'tunelio')
                self.assertEqual(data['title'], 'Official title')
                self.assertNotIn('bitrate_kbps', data)
        self.assertTrue(self.server.slots.acquire(timeout=2))
        self.assertEqual(os.listdir(self.directory.name), [])

    def test_failure_and_cooldown_problem_are_sanitized_scratch_reclaimed(self):
        def acquire(_self, url, limit, out):
            out.write(b'partial')
            raise Failure(reason='Safe provider limit', retry_after=120)
        with patch('service.Provider.acquire', acquire):
            with self.request() as response:
                self.assertEqual(response.status, 503)
                self.assertEqual(response.headers['Retry-After'], '120')
                self.assertEqual(response.headers['X-Import-Error'], 'IMPORT_DEPENDENCY_FAILED')
                self.assertNotIn(b'Safe provider limit', response.read())
        self.assertTrue(self.server.slots.acquire(timeout=2))
        self.assertEqual(os.listdir(self.directory.name), [])

    def test_capacity_waits_and_starts_after_a_slot_is_released(self):
        self.server.slots.acquire()
        def acquire(_self, url, limit, out):
            out.write(AUDIO)
            return len(AUDIO), included_metadata(PAYLOAD, 'audio/webm')
        with ThreadPoolExecutor(max_workers=1) as pool, patch('service.Provider.acquire', acquire) as _:
            pending = pool.submit(self.request)
            try:
                time.sleep(.15)
                self.assertFalse(pending.done())
            finally:
                self.server.slots.release()
            with pending.result(timeout=2) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), AUDIO)

    def test_twenty_acquisitions_run_and_twenty_first_waits_for_one_to_finish(self):
        self.server.slots = threading.BoundedSemaphore(20)
        lock = threading.Lock()
        first_twenty, twenty_first = threading.Event(), threading.Event()
        finish_one, finish_all = threading.Event(), threading.Event()
        starts, active, maximum = 0, 0, 0
        def acquire(_self, url, limit, out):
            nonlocal starts, active, maximum
            with lock:
                index = starts
                starts += 1
                active += 1
                maximum = max(maximum, active)
                if starts == 20:
                    first_twenty.set()
                if starts == 21:
                    twenty_first.set()
            try:
                (finish_one if index == 0 else finish_all).wait(3)
                out.write(AUDIO)
                return len(AUDIO), included_metadata(PAYLOAD, 'audio/webm')
            finally:
                with lock:
                    active -= 1
        with ThreadPoolExecutor(max_workers=21) as pool, patch('service.Provider.acquire', acquire), \
                patch('builtins.print'):
            requests = [pool.submit(self.request) for _ in range(20)]
            try:
                self.assertTrue(first_twenty.wait(2))
                requests.append(pool.submit(self.request))
                self.assertFalse(twenty_first.wait(.15))
                finish_one.set()
                self.assertTrue(twenty_first.wait(2))
            finally:
                finish_one.set()
                finish_all.set()
            for pending in requests:
                with pending.result(timeout=2) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.read(), AUDIO)
        self.assertEqual(maximum, 20)
        self.assertEqual(self.server.scratch_budget.remaining, 0)

    def test_insufficient_reserved_scratch_stops_before_provider_work(self):
        with patch('acquisition_scratch.os.statvfs') as space, patch('service.Provider.acquire') as acquire:
            space.return_value.f_bavail = 128_000_000
            space.return_value.f_frsize = 1
            with self.request() as response:
                self.assertEqual(response.status, 503)
                self.assertEqual(json.load(response)['code'], 'IMPORT_DISK_FULL')
            acquire.assert_not_called()
        self.assertTrue(self.server.slots.acquire(timeout=2))
        self.assertEqual(self.server.scratch_budget.remaining, 0)

    def test_disconnect_during_capacity_wait_never_starts_provider(self):
        entered, finished = threading.Event(), threading.Event()
        def wait(slots, check):
            entered.set()
            try:
                return wait_for_slot(slots, check)
            finally:
                finished.set()
        self.server.slots.acquire()
        data = json.dumps({'url': URL, 'max_bytes': 2048, 'max_duration_seconds': 1200}).encode()
        with patch('service.wait_for_slot', wait), patch('service.Provider.acquire') as acquire:
            client = socket.create_connection(('127.0.0.1', self.server.server_port))
            try:
                client.sendall(('POST /audio-imports HTTP/1.1\r\nHost: localhost\r\n'
                                'Content-Type: application/json\r\nAuthorization: Bearer ' + 's' * 32 +
                                '\r\nContent-Length: ' + str(len(data)) + '\r\n\r\n').encode() + data)
                self.assertTrue(entered.wait(2))
                client.shutdown(socket.SHUT_RDWR)
                client.close()
                self.assertTrue(finished.wait(2))
                acquire.assert_not_called()
                self.assertEqual(self.server.scratch_budget.remaining, 0)
            finally:
                client.close()
                self.server.slots.release()

    def test_unexpected_exception_and_request_id_do_not_leak_secrets(self):
        with patch('service.Provider.acquire', side_effect=RuntimeError('tnl_secret https://private.test')), \
                patch('builtins.print') as logs:
            with self.request(request_id='secret-url-not-a-uuid') as response:
                self.assertEqual(response.status, 503)
                self.assertNotIn(b'tnl_', response.read())
            for _ in range(100):
                if logs.called:
                    break
                time.sleep(.01)
            events = ' '.join(call.args[0] for call in logs.call_args_list)
            self.assertNotIn('tnl_secret', events)
            self.assertNotIn('private.test', events)
            self.assertNotIn('secret-url', events)

    def test_pending_metadata_does_not_delay_delivery(self):
        self.server.metadata.start.return_value = Future()
        def acquire(_self, url, limit, out):
            out.write(AUDIO)
            return len(AUDIO), included_metadata(PAYLOAD, 'audio/webm')
        with patch('service.Provider.acquire', acquire):
            with self.request() as response:
                self.assertEqual(response.read(), AUDIO)
                extra = json.loads(base64.b64decode(response.headers['X-Import-Extra-Data-Base64']))
                self.assertNotIn('title', extra)

    def test_disconnect_stops_local_work_and_releases_slot_and_scratch(self):
        entered, proceed, finished = threading.Event(), threading.Event(), threading.Event()
        disconnected = threading.Event()
        def acquire(provider, url, limit, out):
            out.write(b'partial')
            entered.set()
            proceed.wait(2)
            try:
                # Allow the locally closed TCP connection to become readable;
                # the handler's next bounded guard must then observe its EOF.
                for _ in range(100):
                    provider.check()
                    time.sleep(.01)
                raise AssertionError('Disconnected client was not detected')
            except ConnectionAbortedError:
                disconnected.set()
                raise
            finally:
                finished.set()
        data = json.dumps({'url': URL, 'max_bytes': 2048, 'max_duration_seconds': 1200}).encode()
        with patch('service.Provider.acquire', acquire):
            client = socket.create_connection(('127.0.0.1', self.server.server_port))
            client.sendall(('POST /audio-imports HTTP/1.1\r\nHost: localhost\r\n'
                            'Content-Type: application/json\r\nAuthorization: Bearer ' + 's' * 32 +
                            '\r\nContent-Length: ' + str(len(data)) + '\r\n\r\n').encode() + data)
            self.assertTrue(entered.wait(2))
            client.shutdown(socket.SHUT_RDWR)
            client.close()
            proceed.set()
            self.assertTrue(finished.wait(2))
            self.assertTrue(disconnected.is_set())
            self.assertTrue(self.server.slots.acquire(timeout=2))
        self.assertEqual(os.listdir(self.directory.name), [])


class PackageTests(unittest.TestCase):
    def test_allowlist_exact_bytes_no_secrets_configuration_or_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            path = package(Path(directory) / 'tunelio.tar')
            with tarfile.open(path) as archive:
                self.assertEqual(tuple(archive.getnames()), FILES)
                for entry in archive.getmembers():
                    self.assertTrue(entry.isfile())
                    self.assertEqual(archive.extractfile(entry).read(),
                                     source_path(entry.name).read_bytes())
                    self.assertEqual((entry.uid, entry.gid, entry.mtime), (0, 0, 0))

    def test_official_metadata_source_stays_identical_to_qualified_videoscale_module(self):
        root = Path(__file__).resolve().parent
        self.assertEqual((root / 'official_metadata.py').read_bytes(),
                         (root.parent / 'videoscale' / 'official_metadata.py').read_bytes())


if __name__ == '__main__':
    unittest.main()
