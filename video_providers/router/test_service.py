"""Local HTTP fixtures; no vendor requests, signed links, secrets or real media."""
import base64
import http.client
import json
import pathlib
import subprocess
import tarfile
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from package_caprover import FILES, package
from service import Destination, Server, clean_metadata, destination
from source_policy import Failure, route_for, source_url

INGRESS = 'synthetic-ingress-service-key-000000000'
YOUTUBE_KEY = 'synthetic-youtube-service-key-00000000'
OTHER_KEY = 'synthetic-other-service-key-0000000000'
VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
OTHER = 'https://www.instagram.com/reel/synthetic123/'
BODY = {'url': VIDEO, 'max_bytes': 100000000, 'max_duration_seconds': 1800}
EXECUTION_ID = '00000000-0000-4000-8000-000000000001'


class UpstreamHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.calls.append((self.path, body, dict(self.headers)))
        self.server.started.set()
        self.close_connection = True
        mode = self.server.mode
        if mode == 'wait':
            self.server.release.wait(3)
        if mode in ('cancel-headers', 'cancel-body'):
            if mode == 'cancel-body':
                self.send_response(200)
                self.send_header('Content-Length', '100')
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.write(b'a')
                self.wfile.flush()
            self.connection.settimeout(3)
            try:
                if not self.connection.recv(1):
                    self.server.closed.set()
            except OSError:
                self.server.closed.set()
            return
        if mode == 'drop':
            return
        if mode == 'error':
            self.send_response(self.server.status)
            for key, value in self.server.headers.items():
                self.send_header(key, value)
            self.send_header('Content-Length', '10')
            self.send_header('Connection', 'close')
            self.end_headers()
            # Router must ignore even a secret-shaped raw body.
            self.wfile.write(b'raw-secret')
            return
        payload = b'synthetic audio bytes'
        self.send_response(200)
        for key, value in self.server.headers.items():
            self.send_header(key, value)
        if mode != 'missing-length':
            self.send_header('Content-Length', str(len(payload) + 10 if mode == 'truncate' else len(payload)))
        if mode != 'missing-type':
            self.send_header('Content-Type', 'text/html' if mode == 'html' else self.server.content_type)
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(payload)


class Upstream(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), UpstreamHandler)
        self.calls = []
        self.mode = 'success'
        self.headers = {}
        self.status = 503
        self.content_type = 'application/octet-stream'
        self.started = threading.Event()
        self.closed = threading.Event()
        self.release = threading.Event()
        self.worker = threading.Thread(target=self.serve_forever, daemon=True)
        self.worker.start()

    def finish(self):
        self.release.set()
        self.shutdown()
        self.server_close()
        self.worker.join()

    def handle_error(self, *_args):
        pass


class RouterHTTPTests(unittest.TestCase):
    def setUp(self):
        self.youtube = Upstream()
        self.other = Upstream()
        self.logs = []
        targets = {
            'youtube': Destination('127.0.0.1', self.youtube.server_port, YOUTUBE_KEY),
            'other': Destination('127.0.0.1', self.other.server_port, OTHER_KEY),
        }
        self.router = Server(('127.0.0.1', 0), INGRESS, targets, log=self.logs.append)
        self.worker = threading.Thread(target=self.router.serve_forever, daemon=True)
        self.worker.start()

    def tearDown(self):
        self.youtube.release.set()
        self.other.release.set()
        self.router.shutdown()
        self.router.server_close()
        self.worker.join()
        self.youtube.finish()
        self.other.finish()

    def start_request(self, body=None, headers=None, path='/audio-imports'):
        connection = http.client.HTTPConnection('127.0.0.1', self.router.server_port, timeout=4)
        content = json.dumps(BODY if body is None else body).encode()
        request_headers = {'Authorization': 'Bearer ' + INGRESS, 'Content-Type': 'application/json',
                           'X-Import-Request-ID': EXECUTION_ID}
        request_headers.update(headers or {})
        connection.request('POST', path, content, request_headers)
        return connection

    def request(self, *args, **kwargs):
        connection = self.start_request(*args, **kwargs)
        try:
            response = connection.getresponse()
            return response.status, dict(response.headers), response.read()
        finally:
            connection.close()

    def assert_problem(self, response, status, code):
        actual, headers, content = response
        self.assertEqual(actual, status)
        self.assertEqual(headers['X-Import-Error'], code)
        self.assertEqual(headers['Content-Type'], 'application/problem+json')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(json.loads(content), {'type': 'about:blank', 'title': code, 'status': status, 'code': code})

    def test_youtube_canonical_route_and_key_isolation(self):
        status, headers, content = self.request({**BODY, 'url': 'https://youtu.be/aqz-KE-bpKQ?si=tracker'},
                                               {'Cookie': 'private', 'X-Vendor-Key': 'not-forwarded'})
        self.assertEqual(status, 200)
        self.assertEqual(content, b'synthetic audio bytes')
        self.assertEqual(int(headers['Content-Length']), len(content))
        self.assertEqual(headers['Cache-Control'], 'no-store')
        path, body, supplied = self.youtube.calls[0]
        self.assertEqual(path, '/audio-imports')
        self.assertEqual(body, BODY)
        self.assertEqual(supplied['Authorization'], 'Bearer ' + YOUTUBE_KEY)
        self.assertEqual(supplied['X-Import-Request-ID'], EXECUTION_ID)
        self.assertNotIn('Cookie', supplied)
        self.assertNotIn('X-Vendor-Key', supplied)
        self.assertEqual(self.other.calls, [])
        self.assertEqual(self.logs[-1]['result'], 'SUCCEEDED')

    def test_other_sites_route_to_other_once(self):
        status, _, _ = self.request({**BODY, 'url': OTHER + '?tracking=removed'})
        self.assertEqual(status, 200)
        self.assertEqual(self.other.calls[0][1]['url'], 'https://instagram.com/reel/synthetic123/')
        self.assertEqual(self.other.calls[0][2]['Authorization'], 'Bearer ' + OTHER_KEY)
        self.assertEqual(len(self.other.calls), 1)
        self.assertEqual(self.youtube.calls, [])

    def test_allowlisted_audio_content_types_preserved(self):
        for content_type in ('application/octet-stream', 'audio/webm', 'audio/mpeg',
                             'audio/mp4', 'audio/ogg', 'audio/opus', 'application/ogg'):
            with self.subTest(content_type=content_type):
                self.youtube.content_type = content_type
                status, headers, content = self.request()
                self.assertEqual(status, 200)
                self.assertEqual(headers['Content-Type'], content_type)
                self.assertEqual(content, b'synthetic audio bytes')

    def test_metadata_sanitized_and_url_headers_never_forwarded(self):
        encoded = base64.b64encode(json.dumps({
            'schema_version': 1, 'provider': 'tunelio', 'audio_codec': 'opus',
            'title': 'allowed title', 'channel': YOUTUBE_KEY,
            'description': 'https://delivery.example/private', 'raw': 'private',
            'bitrate_kbps': 128, 'file_bytes': 200000000,
        }).encode()).decode()
        self.youtube.headers = {'X-Import-Extra-Data-Base64': encoded,
                                'Location': 'https://delivery.example/private',
                                'X-Signed-URL': 'https://delivery.example/private', 'Set-Cookie': 'private'}
        status, headers, _ = self.request()
        self.assertEqual(status, 200)
        metadata = json.loads(base64.b64decode(headers['X-Import-Extra-Data-Base64']))
        self.assertEqual(metadata, {'schema_version': 1, 'provider': 'tunelio', 'audio_codec': 'opus',
                                    'title': 'allowed title', 'bitrate_kbps': 128})
        for header in ('Location', 'X-Signed-URL', 'Set-Cookie'):
            self.assertNotIn(header, headers)

    def test_invalid_metadata_is_nonfatal(self):
        for encoded in ('not-base64', 'A' * 4097, base64.b64encode(b'{bad').decode()):
            with self.subTest(encoded_length=len(encoded)):
                self.youtube.headers = {'X-Import-Extra-Data-Base64': encoded}
                status, headers, _ = self.request()
                self.assertEqual(status, 200)
                self.assertNotIn('X-Import-Extra-Data-Base64', headers)

    def test_upstream_allowed_errors_preserved_without_body_or_retry(self):
        self.youtube.mode = 'error'
        self.youtube.status = 422
        self.youtube.headers = {'X-Import-Error': 'IMPORT_SOURCE_UNAVAILABLE'}
        self.assert_problem(self.request(), 422, 'IMPORT_SOURCE_UNAVAILABLE')
        self.assertEqual(len(self.youtube.calls), 1)
        self.assertEqual(self.other.calls, [])

    def test_upstream_queue_full_and_bounded_retry_after(self):
        self.youtube.mode = 'error'
        self.youtube.headers = {'X-Import-Error': 'IMPORT_QUEUE_FULL', 'Retry-After': '999999'}
        result = self.request()
        self.assert_problem(result, 503, 'IMPORT_QUEUE_FULL')
        self.assertEqual(result[1]['Retry-After'], '86400')
        self.assertEqual(len(self.youtube.calls), 1)

    def test_unknown_status_code_mismatch_redirect_and_auth_failure_are_sanitized(self):
        self.youtube.mode = 'error'
        for status, code in ((502, 'IMPORT_SOURCE_UNAVAILABLE'), (503, 'raw-secret'),
                             (302, 'IMPORT_SOURCE_UNAVAILABLE'), (401, 'IMPORT_UNAUTHORIZED')):
            with self.subTest(status=status, code=code):
                self.youtube.status = status
                self.youtube.headers = {'X-Import-Error': code, 'Location': 'https://private.example'}
                result = self.request()
                self.assert_problem(result, 503, 'IMPORT_DEPENDENCY_FAILED')
                self.assertNotIn('Location', result[1])
        self.assertEqual(len(self.youtube.calls), 4)
        self.assertEqual(self.other.calls, [])

    def test_ambiguous_transport_failure_does_not_retry_or_fallback(self):
        self.youtube.mode = 'drop'
        self.assert_problem(self.request(), 503, 'IMPORT_DEPENDENCY_FAILED')
        self.assertEqual(len(self.youtube.calls), 1)
        self.assertEqual(self.other.calls, [])

    def test_response_size_limit_rejects_before_streaming(self):
        self.assert_problem(self.request({**BODY, 'max_bytes': 4}), 422, 'IMPORT_TOO_LARGE')

    def test_invalid_response_framing_and_type(self):
        for mode in ('missing-length', 'missing-type', 'html'):
            with self.subTest(mode=mode):
                self.youtube.mode = mode
                self.assert_problem(self.request(), 503, 'IMPORT_DEPENDENCY_FAILED')
        for headers in ({'Transfer-Encoding': 'chunked'}, {'Content-Encoding': 'gzip'},
                        {'Content-Length': '21'}):
            with self.subTest(headers=headers):
                self.youtube.mode = 'success'
                self.youtube.headers = headers
                self.assert_problem(self.request(), 503, 'IMPORT_DEPENDENCY_FAILED')

    def test_truncation_closes_binary_response_without_success(self):
        self.youtube.mode = 'truncate'
        connection = self.start_request()
        try:
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            with self.assertRaises(http.client.IncompleteRead):
                response.read()
        finally:
            connection.close()
        self.assertEqual(self.logs[-1]['result'], 'IMPORT_DEPENDENCY_FAILED')
        self.assertEqual(len(self.youtube.calls), 1)

    def test_client_cancellation_interrupts_upstream_before_headers(self):
        self.youtube.mode = 'cancel-headers'
        connection = self.start_request()
        self.assertTrue(self.youtube.started.wait(1))
        connection.close()
        self.assertTrue(self.youtube.closed.wait(1))
        self.assertEqual(len(self.youtube.calls), 1)

    def test_client_cancellation_interrupts_detached_connection_close_body(self):
        self.youtube.mode = 'cancel-body'
        connection = self.start_request()
        response = connection.getresponse()
        self.assertEqual(response.read(1), b'a')
        response.close()
        connection.close()
        self.assertTrue(self.youtube.closed.wait(1))
        self.assertEqual(len(self.youtube.calls), 1)

    def test_deadline_interrupts_waiting_for_headers(self):
        self.router.operation_timeout = 0.25
        self.youtube.mode = 'cancel-headers'
        started = time.monotonic()
        self.assert_problem(self.request(), 503, 'IMPORT_DEPENDENCY_FAILED')
        self.assertLess(time.monotonic() - started, 1)
        self.assertTrue(self.youtube.closed.wait(1))
        self.assertEqual(len(self.youtube.calls), 1)

    def test_deadline_interrupts_stalled_body_without_success(self):
        self.router.operation_timeout = 0.25
        self.youtube.mode = 'cancel-body'
        connection = self.start_request()
        started = time.monotonic()
        try:
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            with self.assertRaises(http.client.IncompleteRead):
                response.read()
        finally:
            connection.close()
        self.assertLess(time.monotonic() - started, 1)
        self.assertTrue(self.youtube.closed.wait(1))
        self.assertEqual(len(self.youtube.calls), 1)

    def test_two_handlers_same_destination_serialize_before_submission_and_health_responds(self):
        self.youtube.mode = 'wait'
        first = self.start_request()
        self.assertTrue(self.youtube.started.wait(1))
        second = self.start_request()
        health = http.client.HTTPConnection('127.0.0.1', self.router.server_port, timeout=1)
        health.request('GET', '/health')
        response = health.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), b'{"status":"ok"}')
        health.close()
        time.sleep(0.15)
        self.assertEqual(len(self.youtube.calls), 1)
        self.assert_problem(self.request({**BODY, 'url': OTHER}), 503, 'IMPORT_QUEUE_FULL')
        self.assertEqual(self.other.calls, [])
        self.youtube.release.set()
        for connection in (first, second):
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            response.read()
            connection.close()
        self.assertEqual(len(self.youtube.calls), 2)

    def test_waiting_same_route_cancellation_never_submits(self):
        self.youtube.mode = 'wait'
        first = self.start_request()
        self.assertTrue(self.youtube.started.wait(1))
        second = self.start_request()
        time.sleep(0.15)
        second.close()
        time.sleep(0.2)
        self.youtube.release.set()
        first.getresponse().read()
        first.close()
        self.assertEqual(len(self.youtube.calls), 1)

    def test_invalid_admission_does_not_contact_upstream(self):
        cases = [
            ({**BODY, 'url': VIDEO + '&list=playlist'}, {}, 422, 'IMPORT_SINGLE_ITEM_REQUIRED'),
            ({**BODY, 'url': 'https://youtube.com.attacker.example/watch?v=aqz-KE-bpKQ'}, {}, 422, 'IMPORT_UNSUPPORTED_PROVIDER'),
            ({**BODY, 'max_bytes': True}, {}, 400, 'IMPORT_INVALID_REQUEST'),
            ({**BODY, 'max_bytes': 100000001}, {}, 400, 'IMPORT_INVALID_REQUEST'),
            ({**BODY, 'max_duration_seconds': 1801}, {}, 400, 'IMPORT_INVALID_REQUEST'),
            ({**BODY, 'max_duration_seconds': float('nan')}, {}, 400, 'IMPORT_INVALID_REQUEST'),
            ({**BODY, 'extra': 'unwanted'}, {}, 400, 'IMPORT_INVALID_REQUEST'),
            (BODY, {'Authorization': 'Bearer wrong'}, 401, 'IMPORT_UNAUTHORIZED'),
            (BODY, {'Content-Type': 'text/plain'}, 415, 'IMPORT_INVALID_REQUEST'),
            (BODY, {'Content-Encoding': 'gzip'}, 400, 'IMPORT_INVALID_REQUEST'),
        ]
        for body, headers, status, code in cases:
            with self.subTest(status=status, code=code):
                self.assert_problem(self.request(body, headers), status, code)
        self.assertEqual(self.youtube.calls, [])
        self.assertEqual(self.other.calls, [])

    def test_invalid_execution_id_replaced_and_logs_have_no_secrets(self):
        self.request(headers={'X-Import-Request-ID': 'private-invalid-id'})
        request_id = self.youtube.calls[0][2]['X-Import-Request-ID']
        self.assertNotEqual(request_id, 'private-invalid-id')
        serialized = json.dumps(self.logs)
        for forbidden in (INGRESS, YOUTUBE_KEY, OTHER_KEY, VIDEO, 'private-invalid-id'):
            self.assertNotIn(forbidden, serialized)


class PolicyAndPackageTests(unittest.TestCase):
    def test_all_enabled_sites_and_exact_youtube_aliases(self):
        youtube = [VIDEO, 'https://m.youtube.com/shorts/aqz-KE-bpKQ',
                   'https://music.youtube.com/watch?v=aqz-KE-bpKQ',
                   'https://youtu.be/aqz-KE-bpKQ', 'https://www.youtu.be/aqz-KE-bpKQ',
                   'https://youtube.com/embed/aqz-KE-bpKQ']
        other = [OTHER, 'https://tiktok.com/@user/video/123', 'https://vm.tiktok.com/synthetic/',
                 'https://vimeo.com/123', 'https://player.vimeo.com/video/123',
                 'https://soundcloud.com/artist/song', 'https://on.soundcloud.com/synthetic',
                 'https://facebook.com/watch?v=123', 'https://www.facebook.com/reel/123',
                 'https://artist.bandcamp.com/track/song', 'https://mixcloud.com/artist/song',
                 'https://hearthis.at/artist/song', 'https://clyp.it/abc',
                 'https://vocaroo.com/synthetic', 'https://whyp.it/tracks/12345/song']
        for url in youtube:
            with self.subTest(url=url):
                self.assertEqual(source_url(url), VIDEO)
                self.assertEqual(route_for(source_url(url)), 'youtube')
        for url in other:
            with self.subTest(url=url):
                self.assertEqual(route_for(source_url(url)), 'other')

    def test_unsafe_urls_collections_and_unqualified_hosts_rejected(self):
        urls = ['http://youtube.com/watch?v=aqz-KE-bpKQ', 'https://127.0.0.1/watch?v=aqz-KE-bpKQ',
                'https://localhost/audio', 'https://user:pass@youtube.com/watch?v=aqz-KE-bpKQ',
                VIDEO + '#fragment', VIDEO + '&v=aqz-KE-bpKQ', VIDEO + '&index=2',
                'https://youtube.com/playlist?list=123', 'https://instagram.com/user/',
                'https://soundcloud.com/user/sets', 'https://mixcloud.com/user/playlists',
                'https://evil.youtube.com/watch?v=aqz-KE-bpKQ',
                'https://youtube.com:8080/watch?v=aqz-KE-bpKQ', VIDEO + '\\suffix',
                VIDEO + ' ']
        for url in urls:
            with self.subTest(url=url), self.assertRaises(Failure):
                source_url(url)

    def test_private_configuration_cannot_target_arbitrary_destinations(self):
        for host in ('music-mute-tunelio', 'srv-captain--music-mute-tunelio'):
            parsed = destination('http://' + host + ':8080/', YOUTUBE_KEY, 'music-mute-tunelio')
            self.assertEqual(parsed.host, host)
        urls = ['https://srv-captain--music-mute-tunelio:8080/',
                'http://srv-captain--music-mute-tunelio:80/',
                'http://srv-captain--music-mute-tunelio:8080/override',
                'http://srv-captain--music-mute-tunelio:8080/?url=private',
                'http://user:pass@srv-captain--music-mute-tunelio:8080/',
                'http://127.0.0.1:8080/', 'http://attacker.example:8080/',
                'http://srv-captain--music-mute-videoscale:8080/']
        for url in urls:
            with self.subTest(url=url), self.assertRaises(ValueError):
                destination(url, YOUTUBE_KEY, 'music-mute-tunelio')

    def test_package_allowlist_and_exact_source_bytes(self):
        with tempfile.TemporaryDirectory() as scratch:
            output = pathlib.Path(scratch) / 'router.tar'
            package(output)
            with tarfile.open(output) as archive:
                self.assertEqual(tuple(archive.getnames()), FILES)
                for name in FILES:
                    self.assertTrue(archive.getmember(name).isfile())
                    self.assertEqual(archive.extractfile(name).read(),
                                     pathlib.Path(__file__).with_name(name).read_bytes())

    def test_captain_hook_injects_only_protected_service_keys(self):
        script = r'''
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const hook = fs.readFileSync('caprover-adapter-hook.js', 'utf8');
const common = 'synthetic-common-private-service-key-0000';
const youtube = 'synthetic-youtube-private-service-key-000';
let paths = [];
const context = {
  require(name) {
    assert.equal(name, 'fs');
    return { readFileSync(path, encoding) {
      assert.equal(encoding, 'utf8');
      paths.push(path);
      if (path.endsWith('/api-key')) return common;
      if (path.endsWith('/tunelio-api-key')) return youtube;
      throw new Error('Unknown protected runtime key path');
    }};
  }
};
vm.runInNewContext(hook, context);
(async () => {
  const update = {TaskTemplate: {ContainerSpec: {Env: [
    'AUDIO_ACQUISITION_API_KEY=old', 'OTHER_AUDIO_ACQUISITION_API_KEY=old',
    'YOUTUBE_AUDIO_ACQUISITION_API_KEY=old', 'UNRELATED=preserved'
  ]}}};
  const returned = await context.preDeployFunction({}, update);
  assert.equal(returned, update);
  assert.deepEqual([...returned.TaskTemplate.ContainerSpec.Env], [
    'UNRELATED=preserved', 'AUDIO_ACQUISITION_API_KEY=' + common,
    'OTHER_AUDIO_ACQUISITION_API_KEY=' + common,
    'YOUTUBE_AUDIO_ACQUISITION_API_KEY=' + youtube
  ]);
  assert.deepEqual(paths, ['/captain/data/musicmute-acquisition/api-key',
                           '/captain/data/musicmute-acquisition/tunelio-api-key']);
})().catch(error => { process.stderr.write(error.name); process.exitCode = 1; });
'''
        result = subprocess.run(['node', '-e', script], cwd=pathlib.Path(__file__).parent,
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
