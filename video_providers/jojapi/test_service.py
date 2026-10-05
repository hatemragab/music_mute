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
import uuid
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from package_caprover import FILES, package, source_path
from service import (Admission, Failure, Handler, Provider, PublicTLS, Server,
                     included_metadata, public_addresses, range_length, response_length,
                     retry_seconds, source_url, delivery_url, delivery_headers, validate_format, wait_for_slot)
from acquisition_scratch import ScratchBudget

URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
AUDIO = b'\x1a\x45\xdf\xa3fixture-opus-audio'
PAYLOAD = {'vcodec': 'none', 'has_drm': False, 'ext': 'webm', 'acodec': 'opus',
           'protocol': 'https', 'format_id': '251-drc', 'container': 'webm_dash',
           'abr': 146.684, 'asr': 48000, 'audio_channels': 2, 'language': 'ar',
           'url': 'https://rr-fixture.googlevideo.com/videoplayback?opaque=synthetic-private-signature',
           'filesize': len(AUDIO),
           'http_headers': {'User-Agent': 'Synthetic-browser', 'Accept': '*/*',
                            'Accept-Language': 'en-us', 'Sec-Fetch-Mode': 'navigate'}}


class PolicyTests(unittest.TestCase):
    def test_canonical_youtube_items(self):
        for source in ['https://youtu.be/aqz-KE-bpKQ?si=tracker',
                       'https://youtube.com/watch?v=aqz-KE-bpKQ&t=60',
                       'https://www.youtube.com/shorts/aqz-KE-bpKQ',
                       'https://m.youtube.com/embed/aqz-KE-bpKQ/',
                       'https://music.youtube.com/live/aqz-KE-bpKQ',
                       URL + '&list=PL123&index=2&start_radio=1',
                       'https://youtube.com/watch/?v=aqz-KE-bpKQ&list=PL123',
                       'https://www.youtu.be/aqz-KE-bpKQ/?list=PL123',
                       URL + '&%6cist=PL123',
                       'https://youtu.be/aqz-KE-bpKQ?list=PL123&index=2',
                       'https://youtube.com/shorts/aqz-KE-bpKQ?list=PL123&v=aqz-KE-bpKQ']:
            self.assertEqual(source_url(source), URL)
        self.assertEqual(
            source_url('https://www.youtube.com/watch?v=e6WT8RwRwt4&list=RDe6WT8RwRwt4&start_radio=1'),
            'https://www.youtube.com/watch?v=e6WT8RwRwt4')

    def test_rejects_other_sites_profiles_collections_credentials_and_unsafe_urls(self):
        for source in ['http://youtube.com/watch?v=aqz-KE-bpKQ',
                       'https://youtube.com/playlist?list=123&v=aqz-KE-bpKQ',
                       'https://youtube.com/watch?list=123',
                       'https://youtube.com/watch?v=short&list=123',
                       'https://youtu.be/aqz-KE-bpKQ?v=abcdefghijk&list=123',
                       'https://youtube.com/shorts/aqz-KE-bpKQ?v=aqz-KE-bpKQ&v=aqz-KE-bpKQ',
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

    def test_delivery_is_googlevideo_host_exact_path_https_and_no_redirect(self):
        self.assertEqual(delivery_url(PAYLOAD['url']).hostname, 'rr-fixture.googlevideo.com')
        for value in ['https://googlevideo.com/videoplayback?sig=x',
                      'https://rr-fixture.googlevideo.com.evil.test/videoplayback?sig=x',
                      'https://tunelio.dev/tunnel?sig=x',
                      'http://rr-fixture.googlevideo.com/videoplayback?sig=x',
                      'https://rr-fixture.googlevideo.com:443/videoplayback?sig=x',
                      'https://user@rr-fixture.googlevideo.com/videoplayback?sig=x',
                      'https://rr-fixture.googlevideo.com/download?sig=x',
                      'https://rr-fixture.googlevideo.com/videoplayback',
                      'https://rr-fixture.googlevideo.com/videoplayback?sig=x#private',
                      'https://127.0.0.1/videoplayback?sig=x',
                      'https://rr-fixture.googlevideo.com/videoplayback?sig=x\n', None]:
            with self.subTest(value=value), self.assertRaises(Failure):
                delivery_url(value)

    def test_metadata_is_actual_format_fields_only(self):
        payload = {**PAYLOAD, 'filename': 'Bearer hidden', 'private': 'must not persist'}
        data = included_metadata(payload, 'audio/webm')
        self.assertEqual(data, {'schema_version': 1, 'provider': 'jojapi', 'site': 'youtube',
                                'format_id': '251-drc', 'extension': 'webm', 'container': 'webm_dash',
                                'audio_codec': 'opus', 'language': 'ar', 'bitrate_kbps': 146.684,
                                'sample_rate_hz': 48000, 'audio_channels': 2,
                                'provider_file_bytes': len(AUDIO)})
        self.assertNotIn('url', data)
        self.assertNotIn('http_headers', data)
        self.assertNotIn('downloader_options', data)
        self.assertNotIn('bitrate_kbps', included_metadata({'ext': 'webm'}))

    def test_headers_allowlist_blocks_credentials_host_and_control_injection(self):
        headers = delivery_headers({**PAYLOAD, 'http_headers': {
            **PAYLOAD['http_headers'], 'Authorization': 'Bearer synthetic',
            'X-JoJAPI-Key': 'jk_synthetic', 'Host': '169.254.169.254', 'Range': 'bytes=0-1',
            'Accept-Encoding': 'gzip'}})
        self.assertEqual(headers, {**PAYLOAD['http_headers'], 'Accept-Encoding': 'identity'})
        for supplied in [None, [], {'User-Agent': 'bad\r\nHost: private'}, {'User-Agent': 'x' * 513},
                         {'User-Agent': 123}, {'User-Agent': 'non-ascii \u00e9'},
                         {'User-Agent': 'safe', 'user-agent': 'duplicate'},
                         {'Accept': 'bad\x7f'}]:
            with self.subTest(headers=supplied), self.assertRaises(Failure):
                delivery_headers({'http_headers': supplied})

    def test_vendor_cookie_preserves_only_bounded_rfc_request_pairs(self):
        accepted = ['session=synthetic', 'session=; preference=""',
                    'session=synthetic; preference="quoted-value"; other=a=b',
                    '!#$%&\'*+-.^_`|~token=value', 'a=' + 'x' * 4094]
        for value in accepted:
            with self.subTest(cookie=value[:32]):
                headers = delivery_headers({'http_headers': {'cookie': value}})
                self.assertEqual(headers, {'Accept-Encoding': 'identity', 'Cookie': value})
        for value in ['', 'private', '=missing-name', 'bad name=value', 'a=value,b=other',
                      'a=space value', 'a="quoted space"', 'a=back\\slash', 'a="unterminated',
                      'a=b;c=d', 'a=b; ', 'a=b; Secure', 'a=b;\tother=c', 'a=b\r\nHost: other',
                      'a=b\x7f', 'a=\u00e9', 'a=' + 'x' * 4095, None, 123]:
            with self.subTest(cookie=value), self.assertRaises(Failure):
                delivery_headers({'http_headers': {'Cookie': value}})
        with self.assertRaises(Failure):
            delivery_headers({'http_headers': {'Cookie': 'a=synthetic', 'cookie': 'b=synthetic'}})

    def test_vendor_cookie_rejects_raw_and_encoded_runtime_credentials(self):
        private_key = 'synthetic-internal-service-key-32bytes'
        for secret in [private_key, 'jk_synthetic-private-key', 'Bearer synthetic-secret']:
            for value in [secret, ''.join('%' + format(ord(c), '02X') for c in secret)]:
                with self.subTest(secret=secret, encoded=value != secret), self.assertRaises(Failure):
                    delivery_headers({'http_headers': {'Cookie': 'session=' + value}}, secrets=(private_key,))

    def test_reflected_keys_are_rejected_in_headers_and_pruned_from_metadata(self):
        private_key = 'synthetic-internal-service-key-32bytes'
        for value in ['jk_synthetic-secret', private_key, 'prefix ' + private_key + ' suffix', 'Bearer secret']:
            with self.subTest(value=value), self.assertRaises(Failure):
                delivery_headers({'http_headers': {'User-Agent': value}}, secrets=(private_key,))
        payload = {**PAYLOAD, 'container': private_key, 'language': 'jk_synthetic-secret',
                   'format_id': 'jk_synthetic-secret'}
        extra = included_metadata(payload, secrets=(private_key,))
        self.assertNotIn('container', extra)
        self.assertNotIn('language', extra)
        self.assertNotIn('format_id', extra)
        self.assertEqual(extra['audio_codec'], 'opus')

    def test_delivery_url_rejects_only_known_runtime_keys_raw_or_percent_encoded(self):
        key = 'synthetic-internal-service-key-32bytes'
        vendor = 'jk_synthetic-private-key'
        for value in [key, vendor, ''.join('%' + format(ord(c), '02X') for c in key),
                      ''.join('%' + format(ord(c), '02x') for c in vendor)]:
            with self.subTest(value=value), self.assertRaises(Failure):
                delivery_url('https://rr-fixture.googlevideo.com/videoplayback?reflected=' + value,
                             secrets=(key, vendor))
        # Legitimate signed URLs and unrelated random-token prefixes are not credentials.
        accepted = 'https://rr-fixture.googlevideo.com/videoplayback?Signature=synthetic-jk_nonce'
        self.assertEqual(delivery_url(accepted, secrets=(key, vendor)).geturl(), accepted)

    def test_native_format_validation_rejects_video_drm_and_unbounded_metadata(self):
        validate_format(PAYLOAD)
        validate_format({**PAYLOAD, 'ext': 'm4a', 'acodec': 'mp4a.40.2'})
        for field, value in [('vcodec', 'h264'), ('has_drm', True), ('has_drm', None),
                             ('ext', 'mp3'), ('acodec', 'aac'), ('protocol', 'http'),
                             ('format_id', 'url/private'), ('audio_channels', True),
                             ('abr', float('nan')), ('asr', 384001), ('width', 1920),
                             ('height', 1080), ('fps', 30), ('vbr', 128), ('video_ext', 'mp4')]:
            with self.subTest(field=field, value=value), self.assertRaises(Failure):
                validate_format({**PAYLOAD, field: value})

    def test_shared_five_requests_configuration_cannot_exceed_provider_one(self):
        admission = Admission(5)
        self.assertEqual(admission.requests_per_second, 1)

    def test_rate_admission_rolling_window_and_cooldown(self):
        now = [0]
        waits = []
        def sleep(seconds):
            waits.append(seconds)
            now[0] += seconds
        admission = Admission(clock=lambda: now[0], sleep=sleep)
        admission.reserve()
        admission.reserve()
        self.assertAlmostEqual(now[0], 1.1)
        self.assertTrue(waits)
        self.assertEqual(len(admission.started), 1)
        admission.cooldown(2)
        admission.reserve()
        self.assertAlmostEqual(now[0], 3.1)

    def test_vendor_spacing_margin_remains_after_the_one_second_window_expires(self):
        now, waits = [0.0], []
        def sleep(seconds):
            waits.append(seconds)
            now[0] += seconds
        admission = Admission(5, clock=lambda: now[0], sleep=sleep)
        admission.reserve()
        now[0] = 1.01
        admission.reserve()
        self.assertAlmostEqual(now[0], 1.1)
        self.assertEqual(len(admission.started), 1)
        self.assertTrue(waits)
        admission.reserve()
        self.assertAlmostEqual(now[0], 2.2)

    def test_native_chunk_size_and_count_fit_the_hard_byte_cap(self):
        from service import MAX_BYTES, MEDIA_CHUNK_BYTES
        self.assertEqual(MEDIA_CHUNK_BYTES, 10485760)
        self.assertEqual((MAX_BYTES + MEDIA_CHUNK_BYTES - 1) // MEDIA_CHUNK_BYTES, 10)

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
                public_addresses('wgvkv.jojapi.net', 443, 1)

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
                    public_addresses('wgvkv.jojapi.net', 443, .02)
                self.assertTrue(entered.is_set())
                with self.assertRaises(Failure):
                    public_addresses('wgvkv.jojapi.net', 443, .02)
                with self.assertRaises(Failure):
                    public_addresses('wgvkv.jojapi.net', 443, .02)
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
        conn = PublicTLS('wgvkv.jojapi.net', 443, timeout=2)
        with patch('service.public_addresses', return_value=answers), \
                patch('service.socket.socket', return_value=sock), \
                patch('service.ssl.create_default_context', return_value=context):
            conn.connect()
        sock.connect.assert_called_once_with(('8.8.8.8', 443))
        context.wrap_socket.assert_called_once_with(sock, server_hostname='wgvkv.jojapi.net')
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
                self.assertEqual(len(public_addresses('wgvkv.jojapi.net', 443, 1)), 1)
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
        self.reply_by_request = None
        replies, calls, fixture = self.replies, self.calls, self
        class Fixture(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def log_message(self, *args):
                pass
            def do_GET(self):
                calls.append((self.path, dict(self.headers)))
                status, body, headers = (fixture.reply_by_request(self.path, dict(self.headers))
                                         if fixture.reply_by_request else replies.popleft())
                self.send_response(status)
                for key, value in headers:
                    self.send_header(key, value)
                if not any(key.lower() in ('content-length', 'transfer-encoding') for key, _ in headers):
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
        self.connections, self.upstream_hosts = [], []
        def connection(host, port, timeout):
            self.assertTrue(host == 'wgvkv.jojapi.net' or host.endswith('.googlevideo.com'))
            self.upstream_hosts.append(host)
            self.assertEqual(port, 443)
            conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=timeout)
            self.connections.append(conn)
            return conn
        self.events = []
        self.admission = Admission()
        self.provider = Provider('jk_synthetic-private-key', lambda: None, self.admission,
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

    def test_complete_native_audio_single_paid_download_no_info_or_delivery_auth(self):
        self.create_reply()
        self.audio_reply()
        output = io.BytesIO()
        size, extra = self.provider.acquire(URL, 2048, output)
        self.assertEqual((size, output.getvalue()), (len(AUDIO), AUDIO))
        self.assertEqual(extra['provider'], 'jojapi')
        self.assertEqual(len(self.calls), 2)
        path, headers = self.calls[0]
        self.assertEqual(urlsplit(path).path, '/download')
        self.assertEqual(parse_qs(urlsplit(path).query),
                         {'id': ['aqz-KE-bpKQ'], 'filter': ['audioonly'], 'quality': ['highestaudio']})
        self.assertEqual(headers['X-JoJAPI-Key'], 'jk_synthetic-private-key')
        self.assertNotIn('Authorization', headers)
        self.assertEqual(headers['User-Agent'], 'MusicMute/1.0')
        self.assertEqual(urlsplit(self.calls[1][0]).path, '/videoplayback')
        self.assertEqual(self.calls[1][1]['User-Agent'], 'Synthetic-browser')
        self.assertNotIn('X-JoJAPI-Key', self.calls[1][1])
        self.assertNotIn('Authorization', self.calls[1][1])
        self.assertNotIn('Cookie', self.calls[1][1])
        self.assertTrue(all(conn.sock is None for conn in self.connections))
        for forbidden in ['jk_', 'signature', 'youtube.com', 'aqz-', 'Authorization', 'opaque=']:
            self.assertNotIn(forbidden, json.dumps(self.events))
        self.assertTrue(all('request_duration_ms' in event and 'response_headers_ms' in event
                            for event in self.events if 'request_duration_ms' in event))

    def test_concurrent_distinct_sources_keep_gateway_payload_media_and_events_isolated(self):
        ids = ('aqz-KE-bpKQ', 'YE7VzlLtp-4', 'jNQXAC9IVRw')
        audio = {item: bytes([index + 1]) * (1000 + index * 997) for index, item in enumerate(ids)}
        durations = {item: 13.125 + index * 17 for index, item in enumerate(ids)}
        gateway_order, media_order, selected = [], [], {}
        events = {item: [] for item in ids}
        ready = {item: threading.Event() for item in ids}
        barrier, lock = threading.Barrier(3), threading.Lock()
        def reply(path, headers):
            parsed = urlsplit(path)
            query = parse_qs(parsed.query)
            if parsed.path == '/download':
                item = query['id'][0]
                self.assertEqual(query['filter'], ['audioonly'])
                self.assertEqual(query['quality'], ['highestaudio'])
                with lock:
                    gateway_order.append(item)
                barrier.wait(timeout=5)
                # Complete gateway responses in the opposite order to their
                # requests, keeping three different sources in flight together.
                rank = gateway_order.index(item)
                if rank < 2:
                    self.assertTrue(ready[gateway_order[rank + 1]].wait(5))
                payload = {**PAYLOAD, 'filesize': len(audio[item]), 'duration': durations[item],
                    'url': 'https://rr-fixture.googlevideo.com/videoplayback?source=' + item +
                           '&dur=' + str(durations[item]), 'http_headers': {
                               **PAYLOAD['http_headers'], 'User-Agent': 'Synthetic-browser-' + item,
                               'Cookie': 'fixture_source=' + item}}
                return 200, json.dumps(payload).encode(), [('Content-Type', 'application/json')]
            item = query['source'][0]
            self.assertEqual(float(query['dur'][0]), durations[item])
            self.assertEqual(headers['Range'], 'bytes=0-' + str(len(audio[item]) - 1))
            self.assertEqual(headers['User-Agent'], 'Synthetic-browser-' + item)
            self.assertEqual(headers['Cookie'], 'fixture_source=' + item)
            self.assertNotIn('X-JoJAPI-Key', headers)
            self.assertNotIn('Authorization', headers)
            with lock:
                media_order.append(item)
            ready[item].set()
            return 206, audio[item], [('Content-Type', 'audio/webm'),
                ('Content-Range', f'bytes 0-{len(audio[item]) - 1}/{len(audio[item])}')]
        self.reply_by_request = reply
        def acquire(item):
            provider = Provider('jk_synthetic-private-key', lambda: None, self.admission,
                self.provider.connection, log=lambda **fields: events[item].append(fields))
            create = provider.create
            def capture(url):
                payload = create(url)
                selected[item] = (payload['filesize'], payload['duration'])
                return payload
            provider.create = capture
            output = io.BytesIO()
            try:
                size, extra = provider.acquire('https://www.youtube.com/watch?v=' + item, 10000, output)
                return item, size, output.getvalue(), extra
            finally:
                provider.close()
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(acquire, ids))
        self.assertCountEqual(gateway_order, ids)
        self.assertEqual(media_order, list(reversed(gateway_order)))
        self.assertEqual(len(self.calls), 6)  # One paid request and one exact media span each.
        for item, size, received, extra in results:
            self.assertEqual((size, received), (len(audio[item]), audio[item]))
            self.assertEqual(selected[item], (len(audio[item]), durations[item]))
            self.assertEqual(extra['provider_file_bytes'], len(audio[item]))
            self.assertTrue(events[item])
            for event in events[item]:
                if 'file_bytes' in event:
                    self.assertEqual(event['file_bytes'], len(audio[item]))
            self.assertNotIn('fixture_source', json.dumps(events[item]))
            self.assertNotIn('Cookie', json.dumps(extra))
        self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_highest_audio_m4a_aac_with_six_channels_is_delivered_without_conversion(self):
        audio = b'\x00\x00\x00\x18ftypM4A synthetic-native-aac'
        payload = {**PAYLOAD, 'ext': 'm4a', 'acodec': 'mp4a.40.2', 'container': 'm4a_dash',
                   'audio_channels': 6, 'abr': 387.853, 'filesize': len(audio)}
        self.create_reply(payload)
        self.audio_reply(audio, headers=[('Content-Type', 'audio/mp4')])
        output = io.BytesIO()
        size, extra = self.provider.acquire(URL, 2048, output)
        self.assertEqual((size, output.getvalue()), (len(audio), audio))
        self.assertEqual(extra['extension'], 'm4a')
        self.assertEqual(extra['audio_codec'], 'mp4a.40.2')
        self.assertEqual(extra['audio_channels'], 6)
        self.assertEqual(extra['bitrate_kbps'], 387.853)
        self.assertEqual(len(self.calls), 2)

    def test_selected_m4a_cannot_be_replaced_by_a_webm_response(self):
        self.create_reply({**PAYLOAD, 'ext': 'm4a', 'acodec': 'mp4a.40.2'})
        self.audio_reply()
        with self.assertRaises(Failure) as error:
            self.provider.acquire(URL, 2048, io.BytesIO())
        self.assertEqual(error.exception.code, 'IMPORT_UNSUPPORTED_AUDIO_SOURCE')
        self.assertEqual(len(self.calls), 2)

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

    def test_create_invalid_json_shapes_quality_and_sizes_stop_before_media(self):
        for payload in [[], {}, {**PAYLOAD, 'acodec': 'mp3'}, {**PAYLOAD, 'vcodec': 'h264'},
                        {**PAYLOAD, 'has_drm': True}, {**PAYLOAD, 'filesize': 2049},
                        {**PAYLOAD, 'filesize': -1}, {**PAYLOAD, 'filesize': True},
                        {**PAYLOAD, 'url': 'https://127.0.0.1/videoplayback?sig=x'},
                        {'formats': [PAYLOAD]}, [PAYLOAD]]:
            with self.subTest(payload=payload):
                self.calls.clear()
                self.create_reply(payload)
                with self.assertRaises(Failure):
                    self.provider.acquire(URL, 2048, io.BytesIO())
                self.assertEqual(len(self.calls), 1)

    def test_vendor_mislabelled_html_type_is_accepted_only_after_strict_json_format_validation(self):
        payload = {**PAYLOAD, 'ext': 'm4a', 'acodec': 'mp4a.40.2'}
        self.create_reply(payload, headers=[('Content-Type', 'text/html; charset=utf-8')])
        self.audio_reply(headers=[('Content-Type', 'audio/mp4')])
        output = io.BytesIO()
        size, extra = self.provider.acquire(URL, 2048, output)
        self.assertEqual((size, output.getvalue()), (len(AUDIO), AUDIO))
        self.assertEqual(extra['audio_codec'], 'mp4a.40.2')
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(len(self.provider.admission.started), 1)

    def test_actual_html_challenge_and_unknown_vendor_mime_never_start_media_or_replay(self):
        for body, content_type in [(b'<html><script>challenge()</script></html>', 'text/html'),
                                   (json.dumps(PAYLOAD).encode(), 'text/plain'),
                                   (json.dumps(PAYLOAD).encode(), 'application/octet-stream'),
                                   (json.dumps({'challenge': True}).encode(), 'text/html')]:
            with self.subTest(content_type=content_type):
                self.calls.clear()
                self.provider.admission = Admission()
                self.create_reply(raw=body, headers=[('Content-Type', content_type)])
                with self.assertRaises(Failure):
                    self.provider.acquire(URL, 2048, io.BytesIO())
                self.assertEqual(len(self.calls), 1)
                self.assertEqual(len(self.provider.admission.started), 1)
                self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_create_malformed_truncated_or_oversized_json_is_not_retried(self):
        for body, headers in [(b'not json', [('Content-Type', 'application/json')]),
                              (b'{}', [('Content-Type', 'application/json'), ('Content-Length', '10')]),
                              (b'x' * 65537, [('Content-Type', 'application/json')]),
                              (json.dumps(PAYLOAD).encode(), [('Content-Type', 'text/plain')])]:
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

    def test_each_documented_google_redirect_status_delivers_audio_with_no_paid_replay(self):
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                self.calls.clear()
                self.upstream_hosts.clear()
                self.provider.admission = Admission()
                self.create_reply()
                self.audio_reply(b'relocation ignored', status, [
                    ('Location', 'https://rr-relocated.googlevideo.com/videoplayback?opaque=synthetic-relocation'),
                    ('Set-Cookie', 'private=never-forwarded')])
                self.audio_reply()
                output = io.BytesIO()
                size, extra = self.provider.acquire(URL, 2048, output)
                self.assertEqual((size, output.getvalue()), (len(AUDIO), AUDIO))
                self.assertEqual(len(self.calls), 3)
                self.assertEqual(self.upstream_hosts, ['wgvkv.jojapi.net', 'rr-fixture.googlevideo.com',
                                                       'rr-relocated.googlevideo.com'])
                self.assertEqual(self.provider.media_redirects, 1)
                self.assertEqual(len(self.provider.admission.started), 1)
                for _, headers in self.calls[1:]:
                    self.assertEqual(headers['User-Agent'], 'Synthetic-browser')
                    self.assertNotIn('Authorization', headers)
                    self.assertNotIn('Cookie', headers)
                    self.assertNotIn('X-JoJAPI-Key', headers)
                self.assertTrue(all(conn.sock is None for conn in self.connections))
                self.assertNotIn('synthetic-relocation', json.dumps(self.events))

    def test_vendor_cookie_and_exact_browser_headers_survive_same_host_relocation_and_all_ranges(self):
        audio = b'0123456789abcdefghijklmnopqr'
        supplied = {**PAYLOAD['http_headers'], 'User-Agent': 'Synthetic browser/1.0 (Fixture)',
                    'Cookie': 'session=synthetic-private; preference="unchanged"'}
        self.create_reply({**PAYLOAD, 'filesize': len(audio), 'http_headers': supplied}, headers=[
            ('Content-Type', 'application/json'), ('Set-Cookie', 'gateway=never-imported')])
        self.audio_reply(b'', 302, [('Location',
            'https://rr-fixture.googlevideo.com/videoplayback?same-host=synthetic'),
            ('Set-Cookie', 'cdn=never-imported')])
        for start in range(0, len(audio), 10):
            end = min(start + 9, len(audio) - 1)
            self.audio_reply(audio[start:end + 1], 206, [
                ('Content-Type', 'audio/webm'), ('Content-Range', f'bytes {start}-{end}/{len(audio)}'),
                ('Set-Cookie', 'later=never-imported')])
        output = io.BytesIO()
        with patch('service.MEDIA_CHUNK_BYTES', 10):
            size, extra = self.provider.acquire(URL, 2048, output)
        self.assertEqual((size, output.getvalue()), (len(audio), audio))
        self.assertEqual(len(self.calls), 5)
        self.assertNotIn('Cookie', self.calls[0][1])
        for _, headers in self.calls[1:]:
            for name, value in supplied.items():
                self.assertEqual(headers[name], value)
            self.assertEqual(headers['Accept-Encoding'], 'identity')
            self.assertNotIn('X-JoJAPI-Key', headers)
            self.assertNotIn('Authorization', headers)
        self.assertEqual([headers['Range'] for _, headers in self.calls[1:]],
                         ['bytes=0-9', 'bytes=0-9', 'bytes=10-19', 'bytes=20-27'])
        self.assertNotIn('session=', json.dumps(self.events))
        self.assertNotIn('Cookie', json.dumps(extra))
        self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_vendor_cookie_is_permanently_stripped_after_cross_host_relocation_across_ranges(self):
        audio = b'0123456789abcdefghijklmnopqr'
        self.create_reply({**PAYLOAD, 'filesize': len(audio), 'http_headers': {
            **PAYLOAD['http_headers'], 'Cookie': 'session=synthetic-private'}})
        self.audio_reply(b'', 302, [('Location',
            'https://rr-relocated.googlevideo.com/videoplayback?new-host=synthetic')])
        self.audio_reply(audio[:10], 206, [('Content-Type', 'audio/webm'),
            ('Content-Range', f'bytes 0-9/{len(audio)}')])
        # Returning to the initial hostname with a different URL must not restore
        # cookies that were removed at the first cross-host relocation.
        self.audio_reply(b'', 307, [('Location',
            'https://rr-fixture.googlevideo.com/videoplayback?return-host=synthetic'),
            ('Set-Cookie', 'session=must-not-replace')])
        for start in (10, 20):
            end = min(start + 9, len(audio) - 1)
            self.audio_reply(audio[start:end + 1], 206, [
                ('Content-Type', 'audio/webm'), ('Content-Range', f'bytes {start}-{end}/{len(audio)}')])
        output = io.BytesIO()
        with patch('service.MEDIA_CHUNK_BYTES', 10):
            size, _ = self.provider.acquire(URL, 2048, output)
        self.assertEqual((size, output.getvalue()), (len(audio), audio))
        self.assertEqual(self.upstream_hosts, ['wgvkv.jojapi.net', 'rr-fixture.googlevideo.com',
            'rr-relocated.googlevideo.com', 'rr-relocated.googlevideo.com',
            'rr-fixture.googlevideo.com', 'rr-fixture.googlevideo.com'])
        self.assertEqual(self.calls[1][1]['Cookie'], 'session=synthetic-private')
        for _, headers in self.calls[2:]:
            self.assertNotIn('Cookie', headers)
            self.assertEqual(headers['User-Agent'], PAYLOAD['http_headers']['User-Agent'])
            self.assertNotIn('Authorization', headers)
            self.assertNotIn('X-JoJAPI-Key', headers)
        self.assertEqual([headers['Range'] for _, headers in self.calls[1:]],
                         ['bytes=0-9', 'bytes=0-9', 'bytes=10-19', 'bytes=10-19', 'bytes=20-27'])
        self.assertEqual(len(self.provider.admission.started), 1)
        self.assertNotIn('session=', json.dumps(self.events))
        self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_incoming_client_cookie_and_gateway_set_cookie_never_become_media_cookies(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = Server(('127.0.0.1', 0), Handler)
            adapter.api_key, adapter.provider_key = 's' * 32, self.provider.key
            adapter.scratch, adapter.slots = directory, threading.BoundedSemaphore(1)
            adapter.admission, adapter.scratch_budget = self.admission, ScratchBudget(directory)
            title = Future()
            title.set_result({})
            adapter.metadata = Mock()
            adapter.metadata.start.return_value = title
            thread = threading.Thread(target=adapter.serve_forever, daemon=True)
            thread.start()
            def provider(key, check, admission, **kwargs):
                return Provider(key, check, admission, connection=self.provider.connection, **kwargs)
            try:
                for supplied in (None, 'vendor=synthetic-only'):
                    payload = {**PAYLOAD, 'http_headers': dict(PAYLOAD['http_headers'])}
                    if supplied is not None:
                        payload['http_headers']['Cookie'] = supplied
                    self.create_reply(payload, headers=[('Content-Type', 'application/json'),
                        ('Set-Cookie', 'gateway=never-imported')])
                    self.audio_reply()
                    request = urllib.request.Request(
                        f'http://127.0.0.1:{adapter.server_port}/audio-imports',
                        data=json.dumps({'url': URL, 'max_bytes': 2048,
                                         'max_duration_seconds': 1200}).encode(), headers={
                            'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adapter.api_key,
                            'Cookie': 'client=must-not-forward; service=' + adapter.api_key})
                    completed = threading.Event()
                    def log_print(content, **_kwargs):
                        if json.loads(content).get('event') == 'audio-acquisition':
                            completed.set()
                    with self.subTest(vendor_cookie=supplied is not None), patch('service.Provider', provider), \
                            patch('builtins.print', side_effect=log_print) as logs, \
                            urllib.request.urlopen(request, timeout=5) as response:
                        self.assertEqual(response.read(), AUDIO)
                        self.assertTrue(completed.wait(5))
                        extra = json.loads(base64.b64decode(response.headers['X-Import-Extra-Data-Base64']))
                        self.assertNotIn('Cookie', json.dumps(extra))
                    gateway, media = self.calls[-2:]
                    self.assertNotIn('Cookie', gateway[1])
                    if supplied is None:
                        self.assertNotIn('Cookie', media[1])
                    else:
                        self.assertEqual(media[1]['Cookie'], supplied)
                    self.assertNotIn('must-not-forward', str(self.calls[-2:]))
                    self.assertNotIn('gateway=never-imported', str(self.calls[-2:]))
                    self.assertNotIn('Cookie', str(logs.call_args_list))
                    self.assertNotIn('synthetic-only', str(logs.call_args_list))
                self.assertEqual(os.listdir(directory), [])
            finally:
                adapter.shutdown()
                adapter.server_close()
                thread.join()

    def test_three_google_redirects_succeed_but_fourth_is_blocked(self):
        for count in (3, 4):
            with self.subTest(count=count):
                self.calls.clear()
                self.provider.admission = Admission()
                self.create_reply()
                for index in range(count):
                    self.audio_reply(b'', 302, [('Location',
                        'https://rr-relocated.googlevideo.com/videoplayback?node=' + str(index))])
                if count == 3:
                    self.audio_reply()
                    self.provider.acquire(URL, 2048, io.BytesIO())
                else:
                    with self.assertRaises(Failure):
                        self.provider.acquire(URL, 2048, io.BytesIO())
                self.assertEqual(self.provider.media_redirects, 3)
                self.assertEqual(len(self.calls), 5)
                self.assertEqual(len(self.provider.admission.started), 1)
                self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_reflected_vendor_key_in_initial_or_redirect_url_never_reaches_google(self):
        key = self.provider.key
        for encoded in [key, ''.join('%' + format(ord(c), '02X') for c in key)]:
            for redirect in (False, True):
                with self.subTest(encoded=encoded, redirect=redirect):
                    self.calls.clear()
                    self.provider.admission = Admission()
                    target = 'https://rr-relocated.googlevideo.com/videoplayback?reflected=' + encoded
                    self.create_reply(PAYLOAD if redirect else {**PAYLOAD, 'url': target})
                    if redirect:
                        self.audio_reply(b'', 302, [('Location', target)])
                    with self.assertRaises(Failure):
                        self.provider.acquire(URL, 2048, io.BytesIO())
                    self.assertEqual(len(self.calls), 2 if redirect else 1)
                    self.assertTrue(all('reflected=' not in path for path, _ in self.calls))
                    self.assertEqual(len(self.provider.admission.started), 1)
                    self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_google_redirect_missing_duplicate_loop_and_unsafe_locations_fail_before_next_hop(self):
        locations = [[], [('Location', PAYLOAD['url'])],
                     [('Location', 'https://rr-fixture.googlevideo.com/videoplayback?new=x'),
                      ('Location', 'https://rr-fixture.googlevideo.com/videoplayback?new=y')]]
        for value in ['https://evil.test/videoplayback?x=y', 'http://rr-fixture.googlevideo.com/videoplayback?x=y',
                      'https://rr-fixture.googlevideo.com:443/videoplayback?x=y',
                      'https://user@rr-fixture.googlevideo.com/videoplayback?x=y',
                      'https://rr-fixture.googlevideo.com/other?x=y', '/videoplayback?relative=x',
                      'https://127.0.0.1/videoplayback?x=y', 'x' * 8193]:
            locations.append([('Location', value)])
        for headers in locations:
            with self.subTest(headers=headers):
                self.calls.clear()
                self.provider.admission = Admission()
                self.create_reply()
                self.audio_reply(b'ignored', 302, headers)
                with self.assertRaises(Failure):
                    self.provider.acquire(URL, 2048, io.BytesIO())
                self.assertEqual(len(self.calls), 2)
                self.assertEqual(self.provider.media_redirects, 0)
                self.assertEqual(len(self.provider.admission.started), 1)
                self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_cancellation_between_google_redirect_hops_retains_original_deadline_and_closes(self):
        self.create_reply()
        self.audio_reply(b'', 302, [('Location',
            'https://rr-relocated.googlevideo.com/videoplayback?synthetic=cancel')])
        deadline = self.provider.deadline
        original = self.provider.close
        def close():
            original()
            if self.provider.media_redirects:
                self.provider.check = Mock(side_effect=ConnectionAbortedError())
        self.provider.close = close
        with self.assertRaises(ConnectionAbortedError):
            self.provider.acquire(URL, 2048, io.BytesIO())
        self.assertEqual(self.provider.deadline, deadline)
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_native_range_chunks_are_contiguous_exact_and_created_by_adapter(self):
        audio = b'0123456789abcdefghijklmnopqr'
        self.create_reply({**PAYLOAD, 'filesize': len(audio), 'http_headers': {
            **PAYLOAD['http_headers'], 'Range': 'bytes=999-1000'}})
        for start in range(0, len(audio), 10):
            end = min(start + 9, len(audio) - 1)
            self.audio_reply(audio[start:end + 1], 206, [
                ('Content-Type', 'audio/webm'), ('Content-Range', f'bytes {start}-{end}/{len(audio)}')])
        output = io.BytesIO()
        with patch('service.MEDIA_CHUNK_BYTES', 10):
            size, extra = self.provider.acquire(URL, 2048, output)
        self.assertEqual((size, output.getvalue()), (len(audio), audio))
        self.assertEqual(len(self.calls), 4)
        self.assertEqual([headers['Range'] for _, headers in self.calls[1:]],
                         ['bytes=0-9', 'bytes=10-19', 'bytes=20-27'])
        self.assertEqual(extra['provider_file_bytes'], len(audio))
        self.assertEqual(len(self.provider.admission.started), 1)
        self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_ignored_first_range_streams_full_response_once_without_duplicate_bytes(self):
        audio = AUDIO * 3
        self.create_reply({**PAYLOAD, 'filesize': len(audio)})
        self.audio_reply(audio)
        output = io.BytesIO()
        with patch('service.MEDIA_CHUNK_BYTES', 10):
            size, _ = self.provider.acquire(URL, 2048, output)
        self.assertEqual((size, output.getvalue()), (len(audio), audio))
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[1][1]['Range'], 'bytes=0-9')
        self.assertEqual(len(self.provider.admission.started), 1)

    def test_later_ignored_range_rejects_before_duplicate_bytes_are_appended(self):
        audio = b'0123456789abcdefghijklmnopqr'
        self.create_reply({**PAYLOAD, 'filesize': len(audio)})
        self.audio_reply(audio[:10], 206, [('Content-Type', 'audio/webm'),
                                         ('Content-Range', f'bytes 0-9/{len(audio)}')])
        self.audio_reply(audio)
        output = io.BytesIO()
        with patch('service.MEDIA_CHUNK_BYTES', 10), self.assertRaises(Failure):
            self.provider.acquire(URL, 2048, output)
        self.assertEqual(output.getvalue(), audio[:10])
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(len(self.provider.admission.started), 1)

    def test_invalid_partial_range_framing_and_total_stop_before_another_span(self):
        audio = b'0123456789abcdefghijklmnopqr'
        total = len(audio)
        range_headers = [[], [('Content-Range', f'bytes 0-9/{total}'),
                              ('Content-Range', f'bytes 0-9/{total}')]]
        for value in [f'bytes 1-9/{total}', f'bytes 0-8/{total}', f'bytes 0-10/{total}',
                      f'bytes 10-19/{total}', f'bytes 0-9/{total + 1}', 'bytes 0-9/*',
                      f'bytes 0-9/{total}, bytes 0-9/{total}', 'bytes 0-9/9999999999999999999',
                      'bytes ' + '0' * 130 + '-9/28', 'garbage']:
            range_headers.append([('Content-Range', value)])
        for supplied in range_headers:
            with self.subTest(headers=supplied):
                self.calls.clear()
                self.provider.admission = Admission()
                self.create_reply({**PAYLOAD, 'filesize': total})
                self.audio_reply(audio[:10], 206, [('Content-Type', 'audio/webm'), *supplied])
                output = io.BytesIO()
                with patch('service.MEDIA_CHUNK_BYTES', 10), self.assertRaises(Failure):
                    self.provider.acquire(URL, 2048, output)
                self.assertEqual(output.getvalue(), b'')
                self.assertEqual(len(self.calls), 2)
                self.assertEqual(len(self.provider.admission.started), 1)

    def test_partial_span_oversized_truncated_and_length_mismatch_are_never_retried(self):
        audio = b'0123456789abcdefghijklmnopqr'
        cases = [(audio[:11], []), (audio[:5], [('Content-Length', '10')]),
                 (audio[:10], [('Content-Length', '11')]),
                 (audio[:10], [('Content-Length', '10'), ('Content-Length', '10')])]
        for body, framing in cases:
            with self.subTest(size=len(body), framing=framing):
                self.calls.clear()
                self.provider.admission = Admission()
                self.create_reply({**PAYLOAD, 'filesize': len(audio)})
                self.audio_reply(body, 206, [('Content-Type', 'audio/webm'),
                    ('Content-Range', f'bytes 0-9/{len(audio)}'), *framing])
                with patch('service.MEDIA_CHUNK_BYTES', 10), self.assertRaises(Failure):
                    self.provider.acquire(URL, 2048, io.BytesIO())
                self.assertEqual(len(self.calls), 2)
                self.assertEqual(len(self.provider.admission.started), 1)
                self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_final_short_range_wrong_end_or_truncation_never_completes_audio(self):
        audio = b'0123456789abcdefghijklmnopqr'
        cases = [(audio[20:], f'bytes 20-29/{len(audio)}', None),
                 (audio[20:25], f'bytes 20-27/{len(audio)}', '8')]
        for final_body, content_range, length in cases:
            with self.subTest(content_range=content_range, length=length):
                self.calls.clear()
                self.provider.admission = Admission()
                self.create_reply({**PAYLOAD, 'filesize': len(audio)})
                for start in (0, 10):
                    self.audio_reply(audio[start:start + 10], 206, [('Content-Type', 'audio/webm'),
                        ('Content-Range', f'bytes {start}-{start + 9}/{len(audio)}')])
                headers = [('Content-Type', 'audio/webm'), ('Content-Range', content_range)]
                if length is not None:
                    headers.append(('Content-Length', length))
                self.audio_reply(final_body, 206, headers)
                output = io.BytesIO()
                with patch('service.MEDIA_CHUNK_BYTES', 10), self.assertRaises(Failure):
                    self.provider.acquire(URL, 2048, output)
                self.assertEqual(len(self.calls), 4)
                self.assertEqual(self.calls[-1][1]['Range'], 'bytes=20-27')
                self.assertTrue(output.getvalue().startswith(audio[:20]))
                self.assertLess(len(output.getvalue()), len(audio))
                self.assertEqual(len(self.provider.admission.started), 1)
                self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_chunked_partial_bodies_without_content_length_have_exact_span_counts(self):
        audio = b'0123456789abcdefghijklmnopqr'
        self.create_reply({**PAYLOAD, 'filesize': len(audio)})
        for start in range(0, len(audio), 10):
            end = min(start + 9, len(audio) - 1)
            body = audio[start:end + 1]
            wire = format(len(body), 'x').encode() + b'\r\n' + body + b'\r\n0\r\n\r\n'
            self.audio_reply(wire, 206, [('Content-Type', 'audio/webm'),
                ('Content-Range', f'bytes {start}-{end}/{len(audio)}'), ('Transfer-Encoding', 'chunked')])
        output = io.BytesIO()
        with patch('service.MEDIA_CHUNK_BYTES', 10):
            size, _ = self.provider.acquire(URL, 2048, output)
        self.assertEqual((size, output.getvalue()), (len(audio), audio))
        self.assertEqual(len(self.calls), 4)

    def test_unknown_size_success_is_one_bounded_full_get_without_invented_provider_bytes(self):
        self.create_reply({key: value for key, value in PAYLOAD.items() if key != 'filesize'})
        self.audio_reply()
        output = io.BytesIO()
        size, extra = self.provider.acquire(URL, 2048, output)
        self.assertEqual((size, output.getvalue()), (len(AUDIO), AUDIO))
        self.assertEqual(len(self.calls), 2)
        self.assertNotIn('Range', self.calls[1][1])
        self.assertNotIn('provider_file_bytes', extra)
        self.assertEqual(len(self.provider.admission.started), 1)
        self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_unknown_size_retains_one_full_get_and_rejects_unrequested_partial_response(self):
        self.create_reply({key: value for key, value in PAYLOAD.items() if key != 'filesize'})
        self.audio_reply(AUDIO, 206, [('Content-Type', 'audio/webm'),
                                    ('Content-Range', f'bytes 0-{len(AUDIO) - 1}/{len(AUDIO)}')])
        with self.assertRaises(Failure):
            self.provider.acquire(URL, 2048, io.BytesIO())
        self.assertEqual(len(self.calls), 2)
        self.assertNotIn('Range', self.calls[1][1])

    def test_full_response_with_partial_range_header_is_rejected(self):
        self.create_reply()
        self.audio_reply(AUDIO, 200, [('Content-Type', 'audio/webm'),
                                     ('Content-Range', f'bytes 0-{len(AUDIO) - 1}/{len(AUDIO)}')])
        with self.assertRaises(Failure):
            self.provider.acquire(URL, 2048, io.BytesIO())
        self.assertEqual(len(self.calls), 2)

    def test_all_native_chunks_reuse_last_validated_cdn_url_and_global_redirect_budget(self):
        audio = b'0123456789abcdefghijklmnopqr'
        self.create_reply({**PAYLOAD, 'filesize': len(audio)})
        for index in range(3):
            self.audio_reply(b'', 302, [('Location',
                f'https://rr-node{index}.googlevideo.com/videoplayback?synthetic=node{index}')])
        for start in range(0, len(audio), 10):
            end = min(start + 9, len(audio) - 1)
            self.audio_reply(audio[start:end + 1], 206, [('Content-Type', 'audio/webm'),
                ('Content-Range', f'bytes {start}-{end}/{len(audio)}')])
        output = io.BytesIO()
        with patch('service.MEDIA_CHUNK_BYTES', 10):
            size, _ = self.provider.acquire(URL, 2048, output)
        self.assertEqual((size, output.getvalue()), (len(audio), audio))
        self.assertEqual(self.provider.media_redirects, 3)
        self.assertEqual(self.upstream_hosts[-3:], ['rr-node2.googlevideo.com'] * 3)
        self.assertEqual(len(self.calls), 7)
        self.assertEqual(len(self.provider.admission.started), 1)

    def test_a_fourth_redirect_across_distinct_chunks_is_still_blocked(self):
        audio = b'0123456789abcdefghijklmnopqr'
        self.create_reply({**PAYLOAD, 'filesize': len(audio)})
        for index, start in enumerate((0, 10)):
            self.audio_reply(b'', 302, [('Location',
                f'https://rr-node{index}.googlevideo.com/videoplayback?synthetic=node{index}')])
            self.audio_reply(audio[start:start + 10], 206, [('Content-Type', 'audio/webm'),
                ('Content-Range', f'bytes {start}-{start + 9}/{len(audio)}')])
        self.audio_reply(b'', 302, [('Location', 'https://rr-node2.googlevideo.com/videoplayback?synthetic=node2')])
        self.audio_reply(b'', 302, [('Location', 'https://rr-node3.googlevideo.com/videoplayback?synthetic=node3')])
        output = io.BytesIO()
        with patch('service.MEDIA_CHUNK_BYTES', 10), self.assertRaises(Failure):
            self.provider.acquire(URL, 2048, output)
        self.assertEqual(output.getvalue(), audio[:20])
        self.assertEqual(self.provider.media_redirects, 3)
        self.assertEqual(len(self.calls), 7)
        self.assertNotIn('rr-node3.googlevideo.com', self.upstream_hosts)

    def test_cancellation_between_native_chunks_stops_before_next_request(self):
        audio = b'0123456789abcdefghijklmnopqr'
        self.create_reply({**PAYLOAD, 'filesize': len(audio)})
        self.audio_reply(audio[:10], 206, [('Content-Type', 'audio/webm'),
                                         ('Content-Range', f'bytes 0-9/{len(audio)}')])
        deadline = self.provider.deadline
        original = self.provider.close
        def close():
            original()
            if len(self.calls) == 2:
                self.provider.check = Mock(side_effect=ConnectionAbortedError())
        self.provider.close = close
        output = io.BytesIO()
        with patch('service.MEDIA_CHUNK_BYTES', 10), self.assertRaises(ConnectionAbortedError):
            self.provider.acquire(URL, 2048, output)
        self.assertEqual(output.getvalue(), audio[:10])
        self.assertEqual(self.provider.deadline, deadline)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(len(self.provider.admission.started), 1)
        self.assertTrue(all(conn.sock is None for conn in self.connections))

    def test_unknown_provider_size_is_bounded_by_actual_bytes(self):
        self.create_reply({k: v for k, v in PAYLOAD.items() if k != 'filesize'})
        self.audio_reply(AUDIO * 100)
        with self.assertRaises(Failure) as error:
            self.provider.acquire(URL, len(AUDIO), io.BytesIO())
        self.assertEqual(error.exception.code, 'IMPORT_TOO_LARGE')
        self.assertEqual(len(self.calls), 2)

    def test_cancellation_after_paid_create_prevents_media_and_closes_connection(self):
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
        provider = Provider('jk_synthetic', lambda: None, self.admission, deadline=deadline)
        self.assertEqual(provider.deadline, deadline)

    def test_connection_delays_do_not_bunch_paid_requests_above_one_per_second(self):
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
            provider = Provider('jk_synthetic', lambda: None, admission, connection=Mock(return_value=connection))
            provider.create(URL)
        for index, start in enumerate(paid_starts):
            self.assertAlmostEqual(start, 5 + index * 1.1)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.server = Server(('127.0.0.1', 0), Handler)
        self.server.api_key, self.server.provider_key = 's' * 32, 'jk_synthetic-private-key'
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
                self.assertEqual(data['provider'], 'jojapi')
                self.assertEqual(data['title'], 'Official title')
                self.assertEqual(data['bitrate_kbps'], 146.684)
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
        with patch('service.Provider.acquire', side_effect=RuntimeError('jk_secret https://private.test')), \
                patch('builtins.print') as logs:
            with self.request(request_id='secret-url-not-a-uuid') as response:
                self.assertEqual(response.status, 503)
                self.assertNotIn(b'jk_', response.read())
            for _ in range(100):
                if logs.called:
                    break
                time.sleep(.01)
            events = ' '.join(call.args[0] for call in logs.call_args_list)
            self.assertNotIn('jk_secret', events)
            self.assertNotIn('private.test', events)
            self.assertNotIn('secret-url', events)

    def test_malformed_36_character_execution_uuid_is_replaced_in_safe_logs(self):
        def acquire(_self, url, limit, out):
            out.write(AUDIO)
            return len(AUDIO), included_metadata(PAYLOAD)
        for malformed in ['-' * 36, 'f' * 36]:
            with self.subTest(malformed=malformed), patch('service.Provider.acquire', acquire), \
                    patch('builtins.print') as logs:
                with self.request(request_id=malformed) as response:
                    self.assertEqual(response.read(), AUDIO)
                for _ in range(100):
                    events = [json.loads(call.args[0]) for call in logs.call_args_list]
                    if any(event.get('event') == 'audio-acquisition' for event in events):
                        break
                    time.sleep(.01)
                self.assertTrue(events)
                for event in events:
                    correlation = event['acquisition_id']
                    self.assertNotEqual(correlation, malformed)
                    self.assertEqual(str(uuid.UUID(correlation)), correlation)

    def test_exact_internal_key_is_pruned_from_optional_title_metadata(self):
        lookup = Future()
        lookup.set_result({'title': self.server.api_key, 'channel': 'Safe channel'})
        self.server.metadata.start.return_value = lookup
        def acquire(_self, url, limit, out):
            out.write(AUDIO)
            return len(AUDIO), included_metadata(PAYLOAD)
        with patch('service.Provider.acquire', acquire):
            with self.request() as response:
                self.assertEqual(response.read(), AUDIO)
                extra = json.loads(base64.b64decode(response.headers['X-Import-Extra-Data-Base64']))
                self.assertNotIn('title', extra)
                self.assertEqual(extra['channel'], 'Safe channel')

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
            path = package(Path(directory) / 'jojapi.tar')
            with tarfile.open(path) as archive:
                self.assertEqual(tuple(archive.getnames()), FILES)
                for entry in archive.getmembers():
                    self.assertTrue(entry.isfile())
                    self.assertEqual(archive.extractfile(entry).read(),
                                     source_path(entry.name).read_bytes())
                    self.assertEqual((entry.uid, entry.gid, entry.mtime), (0, 0, 0))

    def test_official_metadata_only_extends_qualified_module_secret_filter(self):
        root = Path(__file__).resolve().parent
        self.assertEqual((root / 'official_metadata.py').read_bytes(),
                         (root.parent / 'videoscale' / 'official_metadata.py').read_bytes().replace(
                             b'Signature=|<[^>]*>', b'Signature=|jk_[A-Za-z0-9_-]+|<[^>]*>'))


if __name__ == '__main__':
    unittest.main()
