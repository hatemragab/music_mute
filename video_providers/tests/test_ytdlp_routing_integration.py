"""Synthetic yt-dlp adapter -> private router -> actual NestJS qualification.

Native Opus is generated locally. Acquisition is replaced by a deterministic
fixture, so these tests spend no proxy traffic and make no YouTube/token call.
Extractor selection and ten simultaneous downloads have separate unit tests.
"""
import base64
from contextlib import ExitStack, redirect_stdout
from datetime import datetime, timedelta, timezone
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import unquote, urlsplit

import test_routing_integration as routing_fixture

ytdlp = routing_fixture.load('qualified_ytdlp', 'ytdlp')
URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
ROUTER_KEY = 'r' * 48
ADAPTER_KEY = 'y' * 48


def context(attempt, started_at=None):
    started_at = started_at or datetime.now(timezone.utc)
    return {
        'X-Import-Attempt': str(attempt),
        'X-Import-Max-Attempts': '4',
        'X-Import-Acquisition-Started-At':
            started_at.isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
    }


class YtdlpRoutingIntegration(routing_fixture.RoutingFixture, unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.logs = io.StringIO()
        self.stack.enter_context(redirect_stdout(self.logs))
        self.directory = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.calls, self.other_calls, self.adapter_headers = [], [], []
        self.failures_remaining = 0
        owner = self

        class RecordingHandler(ytdlp.Handler):
            def do_POST(self):
                owner.adapter_headers.append(dict(self.headers))
                super().do_POST()

        def acquire(**values):
            self.calls.append(values)
            if self.failures_remaining:
                self.failures_remaining -= 1
                raise RuntimeError('synthetic-residential-password upstream text')
            path = values['scratch'] / 'audio.webm'
            path.write_bytes(self.audio)
            return SimpleNamespace(
                path=path, content_type='audio/webm',
                metadata={'schema_version': 1, 'site': 'youtube', 'format_id': '250',
                          'audio_codec': 'opus', 'extension': 'webm', 'bitrate_kbps': 70,
                          'title': 'Synthetic native audio',
                          'channel': 'synthetic-residential-password',
                          'delivery_url': 'https://never-forward.invalid/signed'},
                timings_ms={'extraction_ms': 1, 'token_generation_ms': 2, 'transfer_ms': 3},
            )

        sessions = ytdlp.StickySessions.from_environment({
            'DATAIMPULSE_RESIDENTIAL_LOGIN': 'synthetic-residential',
            'DATAIMPULSE_RESIDENTIAL_PASSWORD': 'synthetic-residential-password',
            'DATAIMPULSE_MOBILE_LOGIN': 'synthetic-mobile',
            'DATAIMPULSE_MOBILE_PASSWORD': 'synthetic-mobile-password',
        })
        with patch.object(ytdlp, 'Handler', RecordingHandler):
            self.adapter = ytdlp.Server(('127.0.0.1', 0), ADAPTER_KEY, sessions,
                                        self.directory, acquire)
        adapter_port = self.start_server(self.adapter)

        class Other(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.other_calls.append((body, self.headers.get('Authorization')))
                self.send_response(200)
                self.send_header('Content-Type', 'audio/webm')
                self.send_header('Content-Length', str(len(owner.audio)))
                self.end_headers()
                self.wfile.write(owner.audio)

        other_port = self.start_server(ThreadingHTTPServer(('127.0.0.1', 0), Other))
        destinations = {
            'youtube': routing_fixture.router.Destination('music-mute-ytdlp', 8080, ADAPTER_KEY),
            'other': routing_fixture.router.Destination('music-mute-videoscale', 8080, 'v' * 48),
        }
        ports = {'music-mute-ytdlp': adapter_port, 'music-mute-videoscale': other_port}
        self.route_port = self.start_server(routing_fixture.router.Server(
            ('127.0.0.1', 0), ROUTER_KEY, destinations,
            connection_factory=lambda host, _port, **_kw:
                http.client.HTTPConnection('127.0.0.1', ports[host], timeout=3),
            operation_timeout=5, log=lambda _fields: None))

    def request(self, url=URL, extra=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.route_port, timeout=5)
        try:
            connection.request('POST', '/audio-imports', json.dumps({
                'url': url, 'max_bytes': 100_000, 'max_duration_seconds': 30,
            }), {'Authorization': 'Bearer ' + ROUTER_KEY, 'Content-Type': 'application/json',
                 **(extra or {})})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def assert_cleaned(self):
        deadline = time.monotonic() + 1
        while (list(Path(self.directory).iterdir())
               or self.adapter.scratch_budget.remaining
               or len(self.logs.getvalue().splitlines()) < len(self.adapter_headers)):
            if time.monotonic() >= deadline:
                break
            time.sleep(0.005)
        self.assertEqual(list(Path(self.directory).iterdir()), [])
        self.assertEqual(self.adapter.scratch_budget.remaining, 0)

    def test_native_audio_survives_router_and_actual_backend_probe(self):
        supplied = context(1)
        status, headers, audio = self.request('https://youtu.be/aqz-KE-bpKQ', supplied)
        self.assertEqual(status, 200)
        self.assertEqual(audio, self.audio)
        self.assertEqual(int(headers['Content-Length']), len(audio))
        self.assertEqual(headers['Content-Type'], 'audio/webm')
        metadata = json.loads(base64.b64decode(headers['X-Import-Extra-Data-Base64']))
        self.assertEqual(metadata['provider'], 'yt-dlp')
        self.assertEqual(metadata['site'], 'youtube')
        self.assertEqual(metadata['format_id'], '250')
        self.assertEqual(metadata['audio_codec'], 'opus')
        self.assertEqual(metadata['title'], 'Synthetic native audio')
        self.assertNotIn('channel', metadata)
        self.assertNotIn('delivery_url', metadata)
        self.assertEqual(len(self.calls), 1)
        call = self.calls[0]
        self.assertEqual(call['url'], URL)
        self.assertEqual(call['max_bytes'], 100_000)
        self.assertEqual(call['max_duration_seconds'], 30)
        self.assertEqual(call['token_provider_url'], 'http://127.0.0.1:4416')
        self.assertEqual(call['deno_path'], 'deno')
        self.assertGreater(call['deadline'] - time.monotonic(), 0)
        self.assertLessEqual(call['deadline'] - time.monotonic(), 30)
        self.assertEqual(self.adapter_headers[0]['Authorization'], 'Bearer ' + ADAPTER_KEY)
        for name, value in supplied.items():
            self.assertEqual(self.adapter_headers[0][name], value)
        self.assertEqual(self.other_calls, [])
        self.assert_cleaned()
        for secret in self.adapter.sessions.secrets:
            self.assertNotIn(secret, self.logs.getvalue())
        self.assertNotIn('never-forward.invalid', self.logs.getvalue())
        self.assertEqual(json.loads(self.logs.getvalue().strip())['token_generation_ms'], 2)

        path = Path(self.directory) / 'received.webm'
        path.write_bytes(audio)
        script = ('import {probeImport} from ' + json.dumps(self.probe_module.as_uri()) + ';'
                  'const result=await probeImport(process.argv[1],30,new AbortController().signal,process.argv[2]);'
                  'console.log(JSON.stringify(result));')
        result = subprocess.run(['node', '--input-type=module', '-e', script, str(path), self.ffprobe],
                                check=True, capture_output=True, text=True, timeout=10)
        measured = json.loads(result.stdout)
        self.assertEqual(measured['extension'], 'webm')
        self.assertEqual(measured['contentType'], 'audio/webm')
        self.assertGreater(measured['durationSeconds'], 0)

    def test_four_contextual_executions_use_three_residential_then_one_mobile(self):
        self.failures_remaining = 3
        started_at = datetime.now(timezone.utc)
        for attempt in (1, 2, 3, 4):
            status, headers, body = self.request(extra=context(attempt, started_at))
            if attempt < 4:
                self.assertEqual(status, 503)
                self.assertEqual(headers['X-Import-Error'], 'IMPORT_DEPENDENCY_FAILED')
                self.assertEqual(headers['Retry-After'], '1')
                self.assertEqual(json.loads(body)['code'], 'IMPORT_DEPENDENCY_FAILED')
                self.assertNotIn(b'synthetic-residential-password', body)
            else:
                self.assertEqual(status, 200)
                self.assertEqual(body, self.audio)
            self.assertEqual(len(self.calls), attempt, 'An HTTP execution must not hide a retry loop')
            for name, value in context(attempt, started_at).items():
                self.assertEqual(self.adapter_headers[-1][name], value)
            self.assert_cleaned()
        proxies = [urlsplit(call['proxy']) for call in self.calls]
        self.assertEqual([unquote(proxy.username).split('__', 1)[0] for proxy in proxies],
                         ['synthetic-residential'] * 3 + ['synthetic-mobile'])
        self.assertEqual([proxy.port for proxy in proxies[:3]], [10000, 10001, 10002])
        self.assertEqual(len({call['proxy'] for call in self.calls}), 4)
        self.assertEqual(self.other_calls, [])

    def test_expired_budget_is_terminal_in_actual_backend_client_without_acquisition(self):
        started_at = datetime.now(timezone.utc) - timedelta(seconds=121)
        modules = routing_fixture.ROOT.parent / 'backend/dist/url-imports'
        script = ('import {ImportFiles} from ' + json.dumps((modules / 'import-files.js').as_uri()) + ';'
                  'import {AudioAcquisitionClient} from ' + json.dumps((modules / 'audio-acquisition-client.js').as_uri()) + ';'
                  'import {safeImportError} from ' + json.dumps((modules / 'import-errors.js').as_uri()) + ';'
                  'import {acquisitionRetryDelay} from ' + json.dumps((modules / 'import-retry.js').as_uri()) + ';'
                  'import {ConfigService} from "@nestjs/config";'
                  'import {readdir} from "node:fs/promises";'
                  'const files=new ImportFiles(process.argv[1],0);'
                  'const client=new AudioAcquisitionClient(new ConfigService({'
                  'AUDIO_ACQUISITION_API_URL:process.argv[2],AUDIO_ACQUISITION_API_KEY:' + json.dumps(ROUTER_KEY) + '}));'
                  'let failure;'
                  'try {await files.withFile((path,signal)=>client.download('
                  + json.dumps(URL) + ',files,path,{maxBytes:100000,maxDuration:30},signal,undefined,'
                  '{attempt:4,maxAttempts:4,startedAt:new Date(process.argv[3])}));} catch(error) {failure=error;}'
                  'if(!failure) throw new Error("Expired acquisition unexpectedly accepted");'
                  'const safe=safeImportError(failure);'
                  'console.log(JSON.stringify({code:safe.code,status:failure.getStatus?.(),'
                  'retry:acquisitionRetryDelay({status:"downloading",acquisitionAttempt:1,'
                  'maxAcquisitionAttempts:4,jobId:null,input:null},safe.code),entries:await readdir(files.root)}));')
        with tempfile.TemporaryDirectory() as scratch:
            result = subprocess.run(
                ['node', '--input-type=module', '-e', script, scratch,
                 'http://127.0.0.1:' + str(self.route_port) + '/',
                 context(4, started_at)['X-Import-Acquisition-Started-At']],
                cwd=routing_fixture.ROOT.parent / 'backend',
                check=True, capture_output=True, text=True, timeout=10)
        self.assertEqual(json.loads(result.stdout),
                         {'code': 'IMPORT_ACQUISITION_EXHAUSTED', 'status': 503,
                          'retry': None, 'entries': []})
        self.assertEqual(self.calls, [])
        self.assertEqual(len(self.adapter_headers), 1)
        self.assert_cleaned()

    def test_partial_context_is_rejected_before_contacting_adapter(self):
        status, headers, body = self.request(extra={'X-Import-Attempt': '4'})
        self.assertEqual(status, 400)
        self.assertEqual(headers['X-Import-Error'], 'IMPORT_INVALID_REQUEST')
        self.assertEqual(json.loads(body)['code'], 'IMPORT_INVALID_REQUEST')
        self.assertEqual(self.calls, [])
        self.assertEqual(self.adapter_headers, [])
        self.assert_cleaned()

    def test_other_site_keeps_the_existing_adapter_and_separate_service_key(self):
        status, _headers, audio = self.request('https://vimeo.com/123456789', context(1))
        self.assertEqual(status, 200)
        self.assertEqual(audio, self.audio)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.adapter_headers, [])
        self.assertEqual(len(self.other_calls), 1)
        self.assertEqual(self.other_calls[0][1], 'Bearer ' + 'v' * 48)


if __name__ == '__main__':
    unittest.main()
