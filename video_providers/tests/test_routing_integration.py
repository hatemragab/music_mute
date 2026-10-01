"""Local HTTP qualification: router -> adapters -> vendor fixture -> NestJS probe.

No real provider calls, credentials, accounts or external network access. FFmpeg
creates test audio only; the deployed acquisition services do not include it.
"""
import base64
from concurrent.futures import Future
from contextlib import ExitStack, redirect_stdout
import functools
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]


def load(name, folder):
    sys.path.insert(0, str(ROOT / folder))
    try:
        spec = importlib.util.spec_from_file_location(name, ROOT / folder / 'service.py')
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.pop(0)


tunelio = load('qualified_tunelio', 'tunelio')
router = load('qualified_router', 'router')


class RoutingFixture:
    @classmethod
    def setUpClass(cls):
        cls.ffmpeg = shutil.which('ffmpeg')
        cls.ffprobe = shutil.which('ffprobe')
        if not cls.ffmpeg or not cls.ffprobe or not shutil.which('node'):
            raise RuntimeError('FFmpeg, ffprobe and Node are required for local qualification')
        cls.probe_module = ROOT.parent / 'backend/dist/url-imports/import-probe.js'
        if not cls.probe_module.is_file():
            raise RuntimeError('Build the backend before local qualification')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'native.webm'
            subprocess.run([cls.ffmpeg, '-hide_banner', '-loglevel', 'error',
                            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25',
                            '-c:a', 'libopus', '-b:a', '128k', str(path)], check=True)
            cls.audio = path.read_bytes()

    def start_server(self, server):
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.stack.callback(thread.join, 2)
        self.stack.callback(server.server_close)
        self.stack.callback(server.shutdown)
        return server.server_address[1]

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.logs = io.StringIO()
        self.stack.enter_context(redirect_stdout(self.logs))
        self.directory = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.calls, self.other_calls = [], []
        self.vendor_failure = False
        self.delivery_release = None
        self.delivery_started = threading.Event()
        self.truncate_delivery = False
        owner = self

        class Vendor(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                path = urlsplit(self.path)
                owner.calls.append((path.path, parse_qs(path.query), self.headers.get('Authorization')))
                if path.path == '/create':
                    status = 503 if owner.vendor_failure else 200
                    body = json.dumps({'status': 'ok', 'mode': 'audio', 'quality': 'opus',
                                       'url': 'https://tunelio.dev/tunnel?fixture=opaque',
                                       'file_size': len(owner.audio)}).encode()
                    content_type = 'application/json'
                elif path.path == '/tunnel':
                    status, body, content_type = 200, owner.audio, 'audio/webm'
                else:
                    status, body, content_type = 404, b'', 'application/json'
                self.send_response(status)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                try:
                    if path.path == '/tunnel' and owner.delivery_release is not None:
                        self.wfile.write(body[:1])
                        self.wfile.flush()
                        owner.delivery_started.set()
                        owner.delivery_release.wait(3)
                        self.wfile.write(body[1:])
                    elif path.path == '/tunnel' and owner.truncate_delivery:
                        self.wfile.write(body[:1])
                    else:
                        self.wfile.write(body)
                except OSError:
                    pass

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
        provider = functools.partial(tunelio.Provider, connection=lambda *_a, **_kw:
                                     http.client.HTTPConnection('127.0.0.1', vendor_port, timeout=3))
        self.stack.enter_context(patch.object(tunelio, 'Provider', provider))
        self.adapter = tunelio.Server(('127.0.0.1', 0), tunelio.Handler)
        self.adapter.api_key = 't' * 48
        self.adapter.provider_key = 'tnl_fixture_never_real'
        self.adapter.scratch = self.directory
        self.adapter.scratch_budget = tunelio.ScratchBudget(self.directory)
        self.adapter.slots = threading.BoundedSemaphore(1)
        self.adapter.admission = tunelio.Admission()
        title = Future()
        title.set_result({'title': 'Synthetic native audio'})
        self.adapter.metadata = type('Metadata', (), {'start': lambda _self, _url: title})()
        adapter_port = self.start_server(self.adapter)
        destinations = {
            'youtube': router.Destination('music-mute-tunelio', 8080, self.adapter.api_key),
            'other': router.Destination('music-mute-videoscale', 8080, 'v' * 48),
        }
        ports = {'music-mute-tunelio': adapter_port, 'music-mute-videoscale': other_port}
        self.route_port = self.start_server(router.Server(
            ('127.0.0.1', 0), 'r' * 48, destinations,
            connection_factory=lambda host, _port, **_kw:
                http.client.HTTPConnection('127.0.0.1', ports[host], timeout=3),
            operation_timeout=5, log=lambda fields: None))

    def request(self, url):
        connection = http.client.HTTPConnection('127.0.0.1', self.route_port, timeout=5)
        try:
            connection.request('POST', '/audio-imports', json.dumps({
                'url': url, 'max_bytes': 100_000, 'max_duration_seconds': 30,
            }), {'Authorization': 'Bearer ' + 'r' * 48, 'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

class RoutingIntegration(RoutingFixture, unittest.TestCase):
    def test_youtube_native_bytes_survive_router_and_real_backend_probe(self):
        status, headers, audio = self.request('https://youtu.be/aqz-KE-bpKQ')
        self.assertEqual(status, 200)
        self.assertEqual(audio, self.audio)
        self.assertEqual(int(headers['Content-Length']), len(audio))
        metadata = json.loads(base64.b64decode(headers['X-Import-Extra-Data-Base64']))
        self.assertEqual(metadata['provider'], 'tunelio')
        self.assertEqual(metadata['site'], 'youtube')
        self.assertEqual([call[0] for call in self.calls], ['/create', '/tunnel'])
        self.assertEqual(self.calls[0][1]['quality'], ['opus'])
        self.assertEqual(self.calls[0][1]['audioBitrate'], ['128'])
        self.assertEqual(self.calls[0][2], 'Bearer tnl_fixture_never_real')
        self.assertIsNone(self.calls[1][2])
        self.assertEqual(self.other_calls, [])
        self.assertEqual(list(Path(self.directory).iterdir()), [])
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

    def test_other_site_uses_existing_adapter_contract_only(self):
        status, headers, audio = self.request('https://vimeo.com/123456789')
        self.assertEqual(status, 200)
        self.assertEqual(audio, self.audio)
        self.assertEqual(self.calls, [])
        self.assertEqual(len(self.other_calls), 1)
        self.assertEqual(self.other_calls[0][2], 'Bearer ' + 'v' * 48)
        metadata = json.loads(base64.b64decode(headers['X-Import-Extra-Data-Base64']))
        self.assertEqual(metadata['provider'], 'videoscale')

    def test_failed_paid_creation_is_not_retried_or_sent_to_other_provider(self):
        self.vendor_failure = True
        status, headers, body = self.request('https://youtu.be/aqz-KE-bpKQ')
        self.assertEqual(status, 503)
        self.assertEqual(headers['X-Import-Error'], 'IMPORT_DEPENDENCY_FAILED')
        self.assertEqual(json.loads(body)['code'], 'IMPORT_DEPENDENCY_FAILED')
        self.assertEqual([call[0] for call in self.calls], ['/create'])
        self.assertEqual(self.other_calls, [])
        self.assertEqual(list(Path(self.directory).iterdir()), [])


class TunelioStreamingIntegration(RoutingFixture, unittest.TestCase):
    def test_framed_audio_passes_both_hops_before_vendor_finishes(self):
        self.delivery_release = threading.Event()
        connection = http.client.HTTPConnection('127.0.0.1', self.route_port, timeout=2)
        try:
            connection.request('POST', '/audio-imports', json.dumps({
                'url': 'https://youtu.be/aqz-KE-bpKQ', 'max_bytes': 100_000, 'max_duration_seconds': 30,
            }), {'Authorization': 'Bearer ' + 'r' * 48, 'Content-Type': 'application/json'})
            response = connection.getresponse()
            self.assertTrue(self.delivery_started.wait(1))
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(1), self.audio[:1])
            self.assertFalse(self.delivery_release.is_set())
            self.delivery_release.set()
            self.assertEqual(response.read(), self.audio[1:])
            self.assertEqual([call[0] for call in self.calls], ['/create', '/tunnel'])
            self.assertEqual(self.other_calls, [])
        finally:
            self.delivery_release.set()
            connection.close()

    def test_truncated_vendor_stream_is_incomplete_at_backend_without_replay(self):
        self.truncate_delivery = True
        with self.assertRaises(http.client.IncompleteRead):
            self.request('https://youtu.be/aqz-KE-bpKQ')
        self.assertEqual([call[0] for call in self.calls], ['/create', '/tunnel'])
        self.assertEqual(self.other_calls, [])
        self.assertEqual(list(Path(self.directory).iterdir()), [])

    def test_truncated_vendor_stream_is_permanent_invalid_audio_in_real_nestjs_client(self):
        self.truncate_delivery = True
        modules = ROOT.parent / 'backend/dist/url-imports'
        body = {'url': 'https://youtu.be/aqz-KE-bpKQ', 'max_bytes': 100_000, 'max_duration_seconds': 30}
        script = ('import {ImportFiles} from ' + json.dumps((modules / 'import-files.js').as_uri()) + ';'
                  'import {safeImportError} from ' + json.dumps((modules / 'import-errors.js').as_uri()) + ';'
                  'import {acquisitionRetryDelay} from ' + json.dumps((modules / 'import-retry.js').as_uri()) + ';'
                  'import {readdir} from "node:fs/promises";'
                  'const files=new ImportFiles(process.argv[1]);'
                  'let failure;'
                  'try {await files.withFile((path,signal)=>files.download(process.argv[2],path,100000,signal,{'
                  'method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer ' + 'r' * 48 + '"},'
                  'body:' + json.dumps(json.dumps(body)) + '}));} catch(error) {failure=error;}'
                  'if(!failure) throw new Error("Truncated fixture unexpectedly accepted");'
                  'const safe=safeImportError(failure);'
                  'console.log(JSON.stringify({code:safe.code,status:failure.getStatus?.(),'
                  'retry:acquisitionRetryDelay({status:"downloading",acquisitionAttempt:1,'
                  'maxAcquisitionAttempts:4,jobId:null,input:null},safe.code),entries:await readdir(files.root)}));')
        with tempfile.TemporaryDirectory(dir=self.directory) as scratch:
            result = subprocess.run(['node', '--input-type=module', '-e', script, scratch,
                                     'http://127.0.0.1:' + str(self.route_port) + '/audio-imports'],
                                    check=True, capture_output=True, text=True, timeout=10)
        self.assertEqual(json.loads(result.stdout),
                         {'code': 'IMPORT_INVALID_AUDIO', 'status': 422, 'retry': None, 'entries': []})
        self.assertEqual([call[0] for call in self.calls], ['/create', '/tunnel'])
        self.assertEqual(self.other_calls, [])
        self.assertEqual(list(Path(self.directory).iterdir()), [])

if __name__ == '__main__':
    unittest.main()
