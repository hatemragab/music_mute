"""Private native-audio adapter; proxy credentials never cross its boundary."""
import base64
from datetime import datetime, timezone
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import select
import socket
import sys
import tempfile
import threading
import time
import uuid
from urllib.parse import urlsplit

from diagnostics import clean_context, clean_timings, exception_context

# Deployment bundles common modules; local execution reads their single source.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'router'))
from acquisition_context import AcquisitionContext, parse_context
from acquisition_limits import AcquisitionLimits, Admission, wait_for_slot
from acquisition_metadata import clean_metadata
from acquisition_scratch import ScratchBudget, ScratchUnavailable
from source_policy import Failure as SourceFailure, source_url, route_for
from proxy_sessions import StickySessions, ProxyUnavailable

MAX_BYTES = 100_000_000
MAX_DURATION = 1800
ATTEMPT_SECONDS = 30
TOTAL_SECONDS = 120
REQUEST_ID = re.compile(r'^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')
MEDIA_TYPES = {'audio/webm', 'audio/mp4', 'audio/x-m4a'}
LOG_LOCK = threading.Lock()


class Failure(Exception):
    def __init__(self, code='IMPORT_DEPENDENCY_FAILED', status=503, diagnostics=None, timings_ms=None):
        self.code, self.status = code, status
        self.diagnostics = clean_context(diagnostics)
        self.timings_ms = clean_timings(timings_ms)
        super().__init__(code)


def unique_object(pairs):
    output = {}
    for key, value in pairs:
        if key in output:
            raise Failure('IMPORT_INVALID_REQUEST', 400)
        output[key] = value
    return output


def request(headers, raw):
    if headers.get('Content-Type', '').split(';', 1)[0].strip() != 'application/json':
        raise Failure('IMPORT_INVALID_REQUEST', 415)
    if headers.get('Content-Encoding', 'identity') != 'identity':
        raise Failure('IMPORT_INVALID_REQUEST', 415)
    try:
        body = json.loads(raw, object_pairs_hook=unique_object)
    except (ValueError, UnicodeError, RecursionError):
        raise Failure('IMPORT_INVALID_REQUEST', 400) from None
    if not isinstance(body, dict) or set(body) != {'url', 'max_bytes', 'max_duration_seconds'}:
        raise Failure('IMPORT_INVALID_REQUEST', 400)
    maximum, duration = body['max_bytes'], body['max_duration_seconds']
    if (type(maximum) is not int or not 1 <= maximum <= MAX_BYTES
            or type(duration) not in (int, float) or not math.isfinite(duration)
            or not 0 < duration <= MAX_DURATION):
        raise Failure('IMPORT_INVALID_REQUEST', 400)
    try:
        url = source_url(body['url'])
        if route_for(url) != 'youtube':
            raise Failure('IMPORT_UNSUPPORTED_PROVIDER', 422)
    except SourceFailure as error:
        raise Failure(error.code, error.status) from None
    return url, maximum, duration


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'AudioAcquisition/1'

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *_args):
        pass

    def reply(self, status, content, media_type='application/problem+json', headers=None):
        self.response_status = status
        self.send_response(status)
        self.send_header('Content-Type', media_type)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        if status == 401:
            self.send_header('WWW-Authenticate', 'Bearer')
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(content)
        self.close_connection = True

    def problem(self, error):
        headers = {'X-Import-Error': error.code}
        if error.status == 503 and error.code != 'IMPORT_ACQUISITION_EXHAUSTED':
            headers['Retry-After'] = '1'
        self.reply(error.status, json.dumps({'type': 'about:blank', 'title': error.code,
                                            'code': error.code, 'status': error.status}).encode(),
                   headers=headers)

    def do_GET(self):
        if self.path == '/health':
            self.reply(200, b'{"status":"ok"}', 'application/json')
        else:
            self.problem(Failure('IMPORT_NOT_FOUND', 404))

    def do_POST(self):
        acquired, streaming = False, False
        result, pool, context = 'IMPORT_DEPENDENCY_FAILED', None, None
        request_id = str(uuid.uuid4())
        started = time.monotonic()
        timings = {}
        diagnostics = {'phase': 'request_validation'}

        def progress(context, partial_timings):
            diagnostics.update(clean_context(context))
            timings.update(clean_timings(partial_timings))

        try:
            if self.path != '/audio-imports':
                raise Failure('IMPORT_NOT_FOUND', 404)
            keys = self.headers.get_all('Authorization', [])
            if len(keys) != 1 or not hmac.compare_digest(keys[0].encode(), ('Bearer ' + self.server.api_key).encode()):
                raise Failure('IMPORT_UNAUTHORIZED', 401)
            ids = self.headers.get_all('X-Import-Request-ID', [])
            if len(ids) == 1 and REQUEST_ID.fullmatch(ids[0]):
                request_id = ids[0]
            lengths = self.headers.get_all('Content-Length', [])
            if (self.headers.get_all('Transfer-Encoding', []) or len(lengths) != 1
                    or not re.fullmatch('[0-9]{1,4}', lengths[0])):
                raise Failure('IMPORT_INVALID_REQUEST', 400)
            length = int(lengths[0])
            if not 1 <= length <= 4096:
                raise Failure('IMPORT_INVALID_REQUEST', 413)
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise Failure('IMPORT_INVALID_REQUEST', 400)
            url, maximum, duration = request(self.headers, raw)
            try:
                context = parse_context(self.headers)
            except ValueError:
                raise Failure('IMPORT_INVALID_REQUEST', 400) from None
            # Legacy private callers retain a single acquisition, never a hidden
            # four-attempt loop. New NestJS executions carry durable context.
            context = context or AcquisitionContext(1, 1, datetime.now(timezone.utc))
            total_deadline = time.monotonic() + context.remaining_seconds(TOTAL_SECONDS)
            attempt_deadline = None

            def check():
                now = time.monotonic()
                if now >= total_deadline:
                    raise Failure('IMPORT_ACQUISITION_EXHAUSTED', 503,
                                  {'reason': 'acquisition_deadline', 'timeout': True})
                if attempt_deadline is not None and now >= attempt_deadline:
                    raise Failure(diagnostics={'reason': 'attempt_deadline', 'timeout': True,
                                               'child_killed': diagnostics['phase'] not in ('response_validation', 'response_stream')})
                socket_deadline = min(total_deadline, attempt_deadline or total_deadline)
                self.connection.settimeout(min(5, max(0.001, socket_deadline - now)))
                if select.select([self.connection], [], [], 0)[0]:
                    if not self.connection.recv(1, socket.MSG_PEEK):
                        raise ConnectionAbortedError()

            diagnostics['phase'] = 'admission'
            wait_for_slot(self.server.slots, check)
            acquired = True
            diagnostics['phase'] = 'scratch'
            try:
                reservation = self.server.scratch_budget.reserve(maximum)
            except ScratchUnavailable:
                raise Failure('IMPORT_DISK_FULL', 503, {'reason': 'disk_full'}) from None
            with reservation, tempfile.TemporaryDirectory(prefix='acquisition-', dir=self.server.scratch) as directory:
                # No paid traffic starts before capacity, scratch and cancellation checks.
                self.server.admission.reserve(check)
                attempt_deadline = min(total_deadline, time.monotonic() + ATTEMPT_SECONDS)
                diagnostics['phase'] = 'proxy_session'
                try:
                    pool, proxy = self.server.sessions.allocate(context.attempt)
                except ProxyUnavailable:
                    raise Failure(diagnostics={'reason': 'proxy_pool_exhausted'}) from None
                diagnostics.update(clean_context({'proxy_port': urlsplit(proxy).port}))
                check()
                diagnostics['phase'] = 'startup'
                try:
                    audio = self.server.acquire(url=url, max_bytes=maximum, max_duration_seconds=duration,
                                                proxy=proxy, deadline=attempt_deadline, check=check,
                                                scratch=Path(directory), token_provider_url=self.server.token_provider_url,
                                                deno_path=self.server.deno_path, progress=progress)
                except Exception as error:
                    if isinstance(error, (Failure, ConnectionAbortedError)):
                        raise
                    # The child interface exposes only stable codes; unknown exceptions
                    # and raw extractor text never leave this service.
                    code, status = getattr(error, 'code', None), getattr(error, 'status', None)
                    details = clean_context(getattr(error, 'diagnostics', {}))
                    if not details:
                        details = exception_context(error, diagnostics['phase'])
                    progress({**details, 'upstream_error_code': code}, getattr(error, 'timings_ms', {}))
                    if code in {'IMPORT_SOURCE_UNAVAILABLE', 'IMPORT_UNSUPPORTED_AUDIO_SOURCE',
                                'IMPORT_TOO_LARGE', 'IMPORT_TOO_LONG', 'IMPORT_INVALID_AUDIO'} and status == 422:
                        raise Failure(code, 422) from None
                    raise Failure() from None
                progress(getattr(audio, 'diagnostics', {}), audio.timings_ms)
                diagnostics['phase'] = 'response_validation'
                check()
                path = Path(audio.path).resolve()
                if path.parent != Path(directory).resolve() or not path.is_file():
                    raise Failure('IMPORT_INVALID_AUDIO', 422)
                size = path.stat().st_size
                if not 0 < size <= maximum or audio.content_type not in MEDIA_TYPES:
                    raise Failure('IMPORT_INVALID_AUDIO', 422)
                timings.update(clean_timings(audio.timings_ms))
                encoded = base64.b64encode(json.dumps({**audio.metadata, 'schema_version': 1,
                                                       'provider': 'yt-dlp'}).encode()).decode()
                metadata = clean_metadata(encoded, (self.server.api_key, proxy, *self.server.sessions.secrets))
                self.send_response(200)
                self.response_status = 200
                self.send_header('Content-Type', audio.content_type)
                self.send_header('Content-Length', str(size))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Connection', 'close')
                if metadata:
                    self.send_header('X-Import-Extra-Data-Base64', metadata)
                self.end_headers()
                streaming = True
                diagnostics['phase'] = 'response_stream'
                with path.open('rb') as content:
                    while chunk := content.read(65536):
                        check()
                        self.wfile.write(chunk)
                result = 'completed'
                self.close_connection = True
        except Failure as error:
            result = error.code
            progress(error.diagnostics, error.timings_ms)
            if not streaming:
                try:
                    self.problem(error)
                except (OSError, ConnectionError):
                    pass
        except Exception as error:
            diagnostics.update(exception_context(error, diagnostics['phase']))
            if isinstance(error, ConnectionAbortedError):
                diagnostics['reason'] = 'caller_disconnected'
            if not streaming:
                try:
                    self.problem(Failure())
                except (ConnectionError, OSError):
                    pass
        finally:
            if acquired:
                self.server.slots.release()
            self.close_connection = True
            with LOG_LOCK:
                print(json.dumps({'event': 'audio-acquisition', 'request_id': request_id,
                                  'attempt': context.attempt if context else None, 'pool': pool,
                                  'result': result, 'elapsed_ms': round((time.monotonic() - started) * 1000),
                                  'response_status': getattr(self, 'response_status', None),
                                  'streaming_started': streaming,
                                  **clean_context(diagnostics),
                                  **timings}), flush=True)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def __init__(self, address, api_key, sessions, scratch, acquire, token_provider_url='http://127.0.0.1:4416',
                 deno_path='deno', limits=None):
        if not isinstance(api_key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', api_key):
            raise ValueError('Invalid private acquisition key')
        if token_provider_url != 'http://127.0.0.1:4416':
            raise ValueError('Token provider must be local')
        limits = limits or AcquisitionLimits(concurrency=10, requests_per_second=2)
        self.api_key, self.sessions, self.scratch, self.acquire = api_key, sessions, Path(scratch), acquire
        self.token_provider_url, self.deno_path = token_provider_url, deno_path
        self.scratch_budget = ScratchBudget(scratch)
        self.slots = threading.BoundedSemaphore(limits.concurrency)
        self.handlers = threading.BoundedSemaphore(64)
        self.admission = Admission(limits.requests_per_second)
        super().__init__(address, Handler)

    def process_request(self, request_socket, address):
        if not self.handlers.acquire(blocking=False):
            self.shutdown_request(request_socket)
            return
        try:
            super().process_request(request_socket, address)
        except BaseException:
            self.handlers.release()
            raise

    def process_request_thread(self, request_socket, address):
        try:
            super().process_request_thread(request_socket, address)
        finally:
            self.handlers.release()

    def handle_error(self, *_args):
        # Standard HTTPServer tracebacks can reflect extractor/configuration data.
        print('{"event":"audio-acquisition-handler-failed"}', flush=True)


def main():
    from bootstrap import validate_runtime
    from acquirer import acquire
    validate_runtime()
    scratch = os.environ.get('ACQUISITION_TEMP_ROOT', '/work')
    if not Path(scratch).is_dir():
        raise ValueError('Dedicated acquisition scratch is unavailable')
    limits = AcquisitionLimits.from_env({**os.environ,
                                        'ACQUISITION_CONCURRENCY': os.environ.get('ACQUISITION_CONCURRENCY', '10'),
                                        'ACQUISITION_REQUESTS_PER_SECOND': os.environ.get('ACQUISITION_REQUESTS_PER_SECOND', '2')})
    Server(('0.0.0.0', 8080), os.environ.get('AUDIO_ACQUISITION_API_KEY'),
           StickySessions.from_environment(), scratch, acquire, limits=limits).serve_forever()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Private audio adapter startup failed', file=sys.stderr)
        sys.exit(1)
