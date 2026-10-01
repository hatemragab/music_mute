"""Synthetic JoJAPI -> private router -> actual NestJS media-probe qualification.

The fixture uses generated Opus, fake keys and fake signed URLs. No external
request, real user media, provider quota or Google availability is exercised.
"""
import base64
from concurrent.futures import Future
from contextlib import ExitStack, redirect_stdout
import functools
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import test_routing_integration as routing_fixture

# Adapter folders each own their optional metadata implementation. Avoid the
# Python module cache sharing that dependency between independently loaded apps.
previous_metadata = sys.modules.pop('official_metadata', None)
try:
    jojapi = routing_fixture.load('qualified_jojapi', 'jojapi')
finally:
    sys.modules.pop('official_metadata', None)
    if previous_metadata is not None:
        sys.modules['official_metadata'] = previous_metadata


class JoJAPIRoutingIntegration(routing_fixture.RoutingIntegration):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.logs = io.StringIO()
        self.stack.enter_context(redirect_stdout(self.logs))
        self.directory = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.calls, self.other_calls, self.hosts = [], [], []
        self.vendor_failure = False
        self.delivery_status = 200
        owner = self

        class Vendor(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                path = urlsplit(self.path)
                owner.calls.append((path.path, parse_qs(path.query), dict(self.headers)))
                if path.path == '/download':
                    status = 503 if owner.vendor_failure else 200
                    body = json.dumps({
                        'vcodec': 'none', 'has_drm': False, 'ext': 'webm', 'acodec': 'opus',
                        'protocol': 'https', 'format_id': '251', 'filesize': len(owner.audio),
                        'asr': 48000, 'audio_channels': 1, 'abr': 128,
                        'url': 'https://rr-fixture.googlevideo.com/videoplayback?synthetic=1',
                        'http_headers': {'User-Agent': 'Synthetic fixture',
                                         'Authorization': 'never-forwarded'},
                    }).encode()
                    content_type = 'application/json'
                elif path.path == '/videoplayback':
                    status, body, content_type = owner.delivery_status, owner.audio, 'audio/webm'
                else:
                    status, body, content_type = 404, b'', 'application/json'
                self.send_response(status)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        class Other(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.other_calls.append((self.path, body, self.headers.get('Authorization')))
                metadata = base64.b64encode(json.dumps({
                    'schema_version': 1, 'provider': 'videoscale', 'site': 'vimeo',
                }).encode()).decode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(len(owner.audio)))
                self.send_header('X-Import-Extra-Data-Base64', metadata)
                self.end_headers()
                self.wfile.write(owner.audio)

        vendor_port = self.start_server(ThreadingHTTPServer(('127.0.0.1', 0), Vendor))
        other_port = self.start_server(ThreadingHTTPServer(('127.0.0.1', 0), Other))

        def fixture_connection(host, *_args, **_kwargs):
            self.hosts.append(host)
            self.assertIn(host, ('wgvkv.jojapi.net', 'rr-fixture.googlevideo.com'))
            return http.client.HTTPConnection('127.0.0.1', vendor_port, timeout=3)

        self.stack.enter_context(patch.object(jojapi, 'Provider', functools.partial(
            jojapi.Provider, connection=fixture_connection)))
        self.adapter = jojapi.Server(('127.0.0.1', 0), jojapi.Handler)
        self.adapter.api_key = 'j' * 48
        self.adapter.provider_key = 'jk_fixture_never_real'
        self.adapter.scratch = self.directory
        self.adapter.scratch_budget = jojapi.ScratchBudget(self.directory)
        self.adapter.slots = threading.BoundedSemaphore(1)
        self.adapter.admission = jojapi.Admission()
        title = Future()
        title.set_result({'title': 'Synthetic JoJAPI native audio'})
        self.adapter.metadata = type('Metadata', (), {'start': lambda _self, _url: title})()
        adapter_port = self.start_server(self.adapter)
        destinations = {
            'youtube': routing_fixture.router.Destination('music-mute-jojapi', 8080, self.adapter.api_key),
            'other': routing_fixture.router.Destination('music-mute-videoscale', 8080, 'v' * 48),
        }
        ports = {'music-mute-jojapi': adapter_port, 'music-mute-videoscale': other_port}
        self.route_port = self.start_server(routing_fixture.router.Server(
            ('127.0.0.1', 0), 'r' * 48, destinations,
            connection_factory=lambda host, _port, **_kw:
                http.client.HTTPConnection('127.0.0.1', ports[host], timeout=3),
            operation_timeout=5, log=lambda fields: None))

    def test_youtube_native_bytes_survive_router_and_real_backend_probe(self):
        status, headers, audio = self.request('https://youtu.be/aqz-KE-bpKQ')
        self.assertEqual(status, 200)
        self.assertEqual(audio, self.audio)
        self.assertEqual(int(headers['Content-Length']), len(audio))
        metadata = json.loads(base64.b64decode(headers['X-Import-Extra-Data-Base64']))
        self.assertEqual(metadata['provider'], 'jojapi')
        self.assertEqual(metadata['site'], 'youtube')
        self.assertEqual(metadata['title'], 'Synthetic JoJAPI native audio')
        self.assertEqual(metadata['audio_codec'], 'opus')
        self.assertEqual([call[0] for call in self.calls], ['/download', '/videoplayback'])
        self.assertEqual(self.calls[0][1], {
            'id': ['aqz-KE-bpKQ'], 'filter': ['audioonly'], 'quality': ['highestaudio'],
        })
        self.assertEqual(self.calls[0][2]['X-JoJAPI-Key'], 'jk_fixture_never_real')
        self.assertNotIn('Authorization', self.calls[1][2])
        self.assertNotIn('X-JoJAPI-Key', self.calls[1][2])
        self.assertEqual(self.calls[1][2]['User-Agent'], 'Synthetic fixture')
        self.assertEqual(self.hosts, ['wgvkv.jojapi.net', 'rr-fixture.googlevideo.com'])
        self.assertEqual(self.other_calls, [])
        self.assertEqual(list(Path(self.directory).iterdir()), [])
        self.assertNotIn('jk_fixture_never_real', self.logs.getvalue())
        self.assertNotIn('googlevideo.com', self.logs.getvalue())
        path = Path(self.directory) / 'received.webm'
        path.write_bytes(audio)
        script = ('import {probeImport} from ' + json.dumps(self.probe_module.as_uri()) + ';'
                  'const result=await probeImport(process.argv[1],30,new AbortController().signal,process.argv[2]);'
                  'console.log(JSON.stringify(result));')
        result = subprocess.run(['node', '--input-type=module', '-e', script, str(path), self.ffprobe],
                                check=True, capture_output=True, text=True)
        probe = json.loads(result.stdout)
        self.assertEqual(probe['extension'], 'webm')
        self.assertGreater(probe['durationSeconds'], 0)

    def test_failed_paid_creation_is_not_retried_or_sent_to_other_provider(self):
        self.vendor_failure = True
        status, headers, body = self.request('https://youtu.be/aqz-KE-bpKQ')
        self.assertEqual(status, 503)
        self.assertEqual(headers['X-Import-Error'], 'IMPORT_DEPENDENCY_FAILED')
        self.assertEqual(json.loads(body)['code'], 'IMPORT_DEPENDENCY_FAILED')
        self.assertEqual([call[0] for call in self.calls], ['/download'])
        self.assertEqual(self.other_calls, [])
        self.assertEqual(list(Path(self.directory).iterdir()), [])

    def test_google_refusal_does_not_repeat_paid_request_or_use_other_adapter(self):
        self.delivery_status = 403
        status, headers, body = self.request('https://youtu.be/aqz-KE-bpKQ')
        self.assertEqual(status, 503)
        self.assertEqual(headers['X-Import-Error'], 'IMPORT_DEPENDENCY_FAILED')
        self.assertEqual(json.loads(body)['code'], 'IMPORT_DEPENDENCY_FAILED')
        self.assertEqual([call[0] for call in self.calls], ['/download', '/videoplayback'])
        self.assertEqual(self.other_calls, [])
        self.assertEqual(list(Path(self.directory).iterdir()), [])

    def test_expired_google_delivery_is_source_unavailable_without_retry(self):
        self.delivery_status = 410
        status, headers, body = self.request('https://youtu.be/aqz-KE-bpKQ')
        self.assertEqual(status, 422)
        self.assertEqual(headers['X-Import-Error'], 'IMPORT_SOURCE_UNAVAILABLE')
        self.assertEqual(json.loads(body)['code'], 'IMPORT_SOURCE_UNAVAILABLE')
        self.assertEqual([call[0] for call in self.calls], ['/download', '/videoplayback'])
        self.assertEqual(self.other_calls, [])
        self.assertEqual(list(Path(self.directory).iterdir()), [])
